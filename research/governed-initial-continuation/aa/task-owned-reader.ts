// Offline, fresh-process reader for task-owned provenance and per-turn admission sidecars. It never reads procfs:
// the server is normally gone, and a live probe here would be a new unverified observation, not a check of the old ones.
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEndoCassetteV0 } from "../../../adapters/openai-proxy/cassette.ts";
import { initialExecutionPrivateFileV0 } from "../../../cli/initial-child-execution.ts";
import { readInitialContinuationReceiptV0 } from "../../../protocol/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { type EndoDigestKeyV0, isEndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { readSlot, readStudy, type SlotEnd, type SlotStart, slotPath } from "./reader.ts";
import { readStudyPlan } from "./study-plan.ts";
import {
	sealTaskOwnedAdmission,
	TASK_OWNED_ADMISSION_VERSION_V0,
	TASK_OWNED_MAX_OBSERVATION_AGE_MS_V0,
	type TaskOwnedAdmissionRecordV0,
	taskOwnedAdmissionPath,
} from "./task-owned-admission.ts";
import {
	provenanceEndPathV0,
	provenancePathV0,
	readTaskOwnedProvenanceEndV0,
	readTaskOwnedProvenanceV0,
	type TaskOwnedProvenanceV0,
} from "./task-owned-provenance.ts";

const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
export interface TaskOwnedStudyReportV0 {
	/** Receipts, captures and request parity, from the unchanged study reader. */
	studyStatus: "partial" | "four-receipts";
	/** Provenance, its optional end record and every sidecar are well-formed, keyed, bound and ordered. Otherwise the reader throws. */
	records: "valid";
	admissionSidecars: number;
	/** Whether every sidecar's observed process facts equal the provenance record. Reported apart from record validity. */
	observedProcessIdentity: "consistent" | "inconsistent" | "unavailable";
	identityDifferences: string[];
	declaredTrustAssumptions: string[];
	/** Host facts as recorded at launch. Ownership is never upgraded: lifecycle ownership is a declaration. */
	hostFacts: {
		ownership: "OWNERSHIP_UNVERIFIED";
		checks: TaskOwnedProvenanceV0["checks"];
		supportedBinary: TaskOwnedProvenanceV0["supportedBinary"];
		unavailable: string[];
		blockingReasons: string[];
	};
	lifecycle: "open" | "cleaned" | "cleanup-unconfirmed";
	studyAdmission: "complete" | "partial" | "refused" | "unavailable";
	observationIds: string[];
}

const RECORD_KEYS = [
	"version",
	"studyCommitment",
	"startCommitment",
	"provenanceCommitment",
	"position",
	"attemptId",
	"turn",
	"upstream",
	"requestDigest",
	"dispatchCommitment",
	"approvalCommitment",
	"observation",
	"result",
	"refusalReason",
	"preparedAt",
	"admittedAt",
	"commitment",
].sort();
const OBSERVATION_KEYS = [
	"argvDigest",
	"environmentDigest",
	"observationId",
	"observedAt",
	"pid",
	"socketFd",
	"socketInode",
	"startTicks",
];
const isoMs = (value: unknown): number => {
	if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error("invalid timestamp");
	return Date.parse(value);
};

export async function readTaskOwnedStudyV0(path: string, key: EndoDigestKeyV0): Promise<TaskOwnedStudyReportV0> {
	const plan = await readStudyPlan(path, key);
	if (!plan.taskOwnedProvenance) throw new Error("study has no task-owned provenance");
	const provenance = readTaskOwnedProvenanceV0(provenancePathV0(path), key);
	if (
		!same(plan.taskOwnedProvenance.commitment, provenance.commitment) ||
		plan.options.upstream !== provenance.listener.endpoint ||
		Date.parse(provenance.observedAt) > Date.parse(plan.createdAt)
	)
		throw new Error("study does not commit to this provenance");
	const endFile = provenanceEndPathV0(path);
	const stopped = existsSync(endFile) ? readTaskOwnedProvenanceEndV0(endFile, key, provenance) : undefined;
	const study = await readStudy(path, key);
	const ids = new Set<string>();
	const differences = new Set<string>();
	let sidecars = 0;
	let previousAdmittedAt = 0; // Ordering holds across slots as well as within one.
	for (const trial of study.trials) {
		const start = readSlot<SlotStart>(slotPath(path, trial.position, "start"), key, "start");
		const end = readSlot<SlotEnd>(slotPath(path, trial.position, "end"), key, "end");
		if (!end.receipt) throw new Error("slot has no receipt");
		const area = dirname(end.receipt);
		const receipt = readInitialContinuationReceiptV0(
			JSON.parse(initialExecutionPrivateFileV0(end.receipt, 64 * 1024)),
		);
		if (!receipt?.runtime || !receipt.dispatch1 || !receipt.dispatch2) throw new Error("slot receipt incomplete");
		const cassette = loadEndoCassetteV0(receipt.runtime.store, key);
		for (const name of readdirSync(area))
			if (
				name.startsWith("task-owned-admission-") &&
				!["task-owned-admission-1.json", "task-owned-admission-2.json"].includes(name)
			)
				throw new Error("unplanned task-owned admission artifact");
		for (const turn of [1, 2] as const) {
			const file = taskOwnedAdmissionPath(area, turn);
			if (!existsSync(file)) throw new Error("task-owned admission missing");
			const text = initialExecutionPrivateFileV0(file, 16384);
			const record = JSON.parse(text) as TaskOwnedAdmissionRecordV0;
			if (!record || typeof record !== "object" || text !== canonicalEndoJsonV0(record))
				throw new Error("invalid task-owned admission encoding");
			const { commitment, ...body } = record;
			const dispatch = turn === 1 ? receipt.dispatch1 : receipt.dispatch2;
			const response = cassette.events.find(
				(event) => event.kind === "capture.response" && (event.payload as { exchange?: number }).exchange === turn,
			);
			const o = record.observation;
			if (
				!same(Object.keys(record).sort(), RECORD_KEYS) ||
				!o ||
				typeof o !== "object" ||
				!same(Object.keys(o).sort(), OBSERVATION_KEYS) ||
				!isEndoKeyedDigestV0(commitment) ||
				!same(commitment, sealTaskOwnedAdmission(key, body).commitment) ||
				record.version !== TASK_OWNED_ADMISSION_VERSION_V0 ||
				!same(record.studyCommitment, plan.commitment) ||
				!same(record.startCommitment, start.commitment) ||
				!same(record.provenanceCommitment, provenance.commitment) ||
				record.position !== trial.position ||
				record.attemptId !== start.plan.initial.attemptId ||
				record.turn !== turn ||
				record.upstream !== plan.options.upstream ||
				!same(record.requestDigest, trial.turns[turn - 1]!.requestBodyDigest) ||
				!same(record.dispatchCommitment, dispatch.commitment) ||
				!same(record.approvalCommitment, dispatch.approvalCommitment) ||
				record.result !== "admitted" ||
				record.refusalReason !== null ||
				typeof o.observationId !== "string" ||
				!/^[a-f0-9]{32}$/.test(o.observationId) ||
				ids.has(o.observationId) ||
				!response
			)
				throw new Error("task-owned admission invalid");
			const observedAt = isoMs(o.observedAt),
				preparedAt = isoMs(record.preparedAt),
				admittedAt = isoMs(record.admittedAt);
			// Observation precedes admission, admission precedes the response, and the observation may not be stale.
			if (
				observedAt < Date.parse(provenance.observedAt) ||
				observedAt > preparedAt ||
				preparedAt < Date.parse(dispatch.at) ||
				preparedAt > admittedAt ||
				admittedAt - observedAt > TASK_OWNED_MAX_OBSERVATION_AGE_MS_V0 ||
				admittedAt > Date.parse(response.at) ||
				admittedAt > Date.parse(end.endedAt) ||
				admittedAt < previousAdmittedAt ||
				(stopped && admittedAt > Date.parse(stopped.stoppedAt))
			)
				throw new Error("task-owned admission out of order or stale");
			previousAdmittedAt = admittedAt;
			ids.add(o.observationId);
			sidecars++;
			// Not a structural failure: report which committed process fact disagrees, and refuse admission.
			if (o.pid !== provenance.process.pid) differences.add("pid");
			if (o.startTicks !== provenance.process.startTicks) differences.add("startTicks");
			if (o.socketInode !== provenance.listener.socketInode) differences.add("socketInode");
			if (o.socketFd !== provenance.listener.socketFd) differences.add("socketFd");
			if (!same(o.argvDigest, provenance.launch.argvDigest)) differences.add("argvDigest");
			if (!same(o.environmentDigest, provenance.launch.environmentDigest)) differences.add("environmentDigest");
		}
	}
	const identity = sidecars === 0 ? "unavailable" : differences.size === 0 ? "consistent" : "inconsistent";
	return {
		studyStatus: study.status,
		records: "valid",
		admissionSidecars: sidecars,
		observedProcessIdentity: identity,
		identityDifferences: [...differences].sort(),
		declaredTrustAssumptions: [...provenance.trustAssumptions],
		hostFacts: {
			ownership: "OWNERSHIP_UNVERIFIED",
			checks: provenance.checks,
			supportedBinary: provenance.supportedBinary,
			unavailable: [...provenance.unavailable],
			blockingReasons: [...provenance.blockingReasons],
		},
		lifecycle: !stopped ? "open" : stopped.processGone && stopped.listenerGone ? "cleaned" : "cleanup-unconfirmed",
		studyAdmission:
			identity === "unavailable"
				? "unavailable"
				: identity === "inconsistent"
					? "refused"
					: study.status === "four-receipts" && sidecars === 8
						? "complete"
						: "partial",
		observationIds: [...ids],
	};
}
