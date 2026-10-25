// Qualification runs only after a real cassette session replay has closed. It re-reads both stores and never writes
// to the source. A keyed commitment binds the source generation seen before execution to the one used at emission.
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { type EndoCheckpointCandidateV0, readEndoCheckpointCandidateV0 } from "../protocol/checkpoint-candidate.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0 } from "../runtime/contracts/trajectory.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { readEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";
import { type PiCassetteReplayReportV0, piCassetteScriptV0, storeTrajectory } from "./cassette-session.ts";

export const ENDO_CHECKPOINT_CANDIDATE_FILE_V0 = "replay-artifacts/checkpoint-candidate.json";
export type EndoCheckpointQualificationV0 =
	| { status: "qualified"; candidate: EndoCheckpointCandidateV0 }
	| { status: "refused"; reason: string };

export const captureGenerationV0 = (events: readonly EndoEventV0[], key: EndoDigestKeyV0): EndoKeyedDigestV0 =>
	key.digest(events);

function refusal(reason: string): EndoCheckpointQualificationV0 {
	return { status: "refused", reason };
}

/** A readable prefix is not a complete evidence log. Inspect it without recovering or changing the store. */
function completeEvidenceStore(root: string): boolean {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		const recovery = store.recovery();
		return (
			!recovery.truncated &&
			!recovery.sealed &&
			!recovery.recovered &&
			recovery.corruptAt === null &&
			recovery.tail === null &&
			recovery.discarded === null
		);
	} finally {
		store.close();
	}
}

/** Rebuild the candidate from verified stores. The optional report is checked, never accepted as proof by itself. */
export function qualifyInitialCheckpointV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	sourceGeneration: EndoKeyedDigestV0,
	report?: PiCassetteReplayReportV0,
	expectedSourceTrajectory?: string,
): EndoCheckpointQualificationV0 {
	try {
		const evidenceRoots = [endoCaptureRootV0(source), source, endoCaptureRootV0(replay), replay];
		if (!evidenceRoots.every(completeEvidenceStore)) return refusal("evidence-log-damaged");
		const cassette = loadEndoCassetteV0(source, key);
		const currentGeneration = captureGenerationV0(cassette.events, key);
		if (canonicalEndoJsonV0(sourceGeneration) !== canonicalEndoJsonV0(currentGeneration))
			return refusal("source-mutated");
		if (
			cassette.exchanges.length === 0 ||
			cassette.exchanges.some((entry) => entry.response === null || entry.truncated !== null)
		)
			return refusal("recording-incomplete");
		if (cassette.events.some((event) => event.kind === "capture.unparsed")) return refusal("unparsed-source-stream");
		const script = piCassetteScriptV0(cassette.events);
		const snapshots = cassette.events.filter(
			(event) => event.producer === "capture:driver" && event.kind === "capture.workspace-snapshot",
		);
		if (
			snapshots.length !== 1 ||
			!isAbsolute(script.snapshot.scratchRoot) ||
			(snapshots[0]!.payload as { workspace?: unknown }).workspace !== "work"
		)
			return refusal("snapshot-ambiguous");
		const environments = cassette.events.filter(
			(event) => event.producer === "capture:driver" && event.kind === "capture.environment",
		);
		const sourceStarted = cassette.events.filter(
			(event) => event.producer === "capture:record" && event.kind === "capture.started",
		);
		const firstRequest = cassette.events.find(
			(event) => event.producer === "capture:record" && event.kind === "capture.request",
		);
		if (
			environments.length > 1 ||
			sourceStarted.length !== 1 ||
			(environments.length === 1 && environments[0]!.sequence >= snapshots[0]!.sequence) ||
			!firstRequest ||
			snapshots[0]!.sequence >= firstRequest.sequence ||
			snapshots[0]!.sequence >= sourceStarted[0]!.sequence
		)
			return refusal("source-boundary-order");
		const ref = script.snapshot.archive;
		if (ref.digest.keyId !== key.keyId || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0)
			return refusal("archive-domain-or-reference");
		const bytes = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true }).get(ref.digest);
		const blobs = createEndoBlobStoreV0(endoCaptureRootV0(source), key, { readOnly: true });
		for (const step of script.steps)
			for (const field of [step.text, step.message]) {
				if (field === undefined || field === null) continue;
				if (typeof field !== "object" || !field || !("digest" in field) || !("bytes" in field))
					return refusal("driver-blob-reference");
				const blob = blobs.get(field.digest as EndoKeyedDigestV0);
				if (blob.length !== field.bytes) return refusal("driver-blob-reference");
			}
		if (bytes.length !== ref.bytes) return refusal("archive-length");
		const archiveRead = readEndoWorkspaceArchiveV0(bytes);
		if (!archiveRead.ok || archiveRead.schemaVersion !== "endo.workspace-archive.v1")
			return refusal("archive-schema");
		const summary = (snapshots[0]!.payload as { summary?: Record<string, unknown> }).summary;
		const entries = archiveRead.value.entries;
		if (
			!summary ||
			summary.entries !== entries.length ||
			summary.files !== entries.filter((entry) => entry.type === "file").length ||
			summary.directories !== entries.filter((entry) => entry.type === "directory").length ||
			summary.symlinks !== entries.filter((entry) => entry.type === "symlink").length ||
			summary.fileBytes !== entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.bytes : 0), 0)
		)
			return refusal("archive-summary");
		const declared = script.environment;
		if ((declared === null) !== (environments.length === 0)) return refusal("environment-evidence");
		if (declared !== null) {
			if (
				typeof declared.variables !== "object" ||
				declared.variables === null ||
				typeof declared.files !== "object" ||
				declared.files === null ||
				(declared.fileTime !== null &&
					(typeof declared.fileTime !== "string" || !Number.isFinite(Date.parse(declared.fileTime))))
			)
				return refusal("environment-evidence");
			const archivedFiles = archiveRead.value.entries.filter(
				(entry) => entry.type === "file" && entry.path.startsWith("env/"),
			);
			if (archivedFiles.length !== Object.keys(declared.files).length) return refusal("environment-evidence");
			for (const [path, evidence] of Object.entries(declared.files)) {
				const entry = archivedFiles.find((item) => item.path === `env/${path}`);
				const fact = evidence as { sha256?: unknown; bytes?: unknown };
				if (
					!entry ||
					entry.type !== "file" ||
					!fact ||
					typeof fact.sha256 !== "string" ||
					!Number.isSafeInteger(fact.bytes) ||
					Buffer.from(entry.base64, "base64").length !== fact.bytes ||
					createHash("sha256").update(Buffer.from(entry.base64, "base64")).digest("hex") !== fact.sha256
				)
					return refusal("environment-evidence");
			}
			const fileTime = declared.fileTime;
			if (fileTime !== null && archiveRead.value.entries.some((entry) => entry.mtimeMs !== Date.parse(fileTime)))
				return refusal("environment-evidence");
			if (fileTime !== null && archiveRead.value.rootMtimeMs !== Date.parse(fileTime))
				return refusal("environment-evidence");
		}
		// An outward link can make a tool depend on state outside the archived tree.
		if (
			archiveRead.value.entries.some(
				(entry) =>
					entry.type === "symlink" && (entry.target.startsWith("/") || entry.target.split("/").includes("..")),
			)
		)
			return refusal("external-symlink");
		const replayEvents = readEndoCaptureEventsV0(replay);
		const started = replayEvents.filter(
			(event) => event.producer === "capture:replay" && event.kind === "capture.started",
		);
		if (
			started.length !== 1 ||
			replayEvents.some((event) => event.kind === "capture.control" || event.kind === "capture.unparsed")
		)
			return refusal("replay-context");
		const start = started[0]!.payload as {
			digestKey?: { keyId?: string };
			cassette?: { exchanges?: number; listen?: string };
		};
		if (
			start.digestKey?.keyId !== key.keyId ||
			start.cassette?.exchanges !== cassette.exchanges.length ||
			start.cassette?.listen !== cassette.listen
		)
			return refusal("replay-context");
		const served = replayEvents.filter(
			(event) => event.producer === "capture:replay" && event.kind === "capture.served",
		);
		const misses = replayEvents.filter(
			(event) => event.producer === "capture:replay" && event.kind === "capture.cassette-miss",
		);
		if (
			misses.length !== 0 ||
			served.length !== cassette.exchanges.length ||
			served.some((event, index) => {
				const fact = event.payload as {
					cassetteExchange?: number;
					requestDigest?: EndoKeyedDigestV0;
					recordedOutcome?: string;
					outcome?: string;
					chunksDelivered?: number;
				};
				const exchange = cassette.exchanges[index]!;
				return (
					fact.cassetteExchange !== index + 1 ||
					canonicalEndoJsonV0(fact.requestDigest) !== canonicalEndoJsonV0(exchange.requestDigest) ||
					fact.recordedOutcome !== exchange.response!.outcome ||
					fact.outcome !== exchange.response!.outcome ||
					fact.chunksDelivered !== exchange.response!.chunks.length
				);
			})
		)
			return refusal("cassette-not-exhaustively-served");
		const recordedSteps = script.steps.map((step) => step.op);
		const replayDriver = replayEvents
			.filter((event) => event.producer === "capture:driver" && event.kind === "capture.driver-step")
			.map((event) => event.payload as Record<string, unknown>);
		const replaySteps = replayDriver.map((step) => step.op);
		if (canonicalEndoJsonV0(recordedSteps) !== canonicalEndoJsonV0(replaySteps)) return refusal("driver-steps");
		for (const [index, sourceStep] of script.steps.entries()) {
			if (sourceStep.op !== "stop" && sourceStep.op !== "kill" && sourceStep.op !== "intervene") continue;
			const replayStep = replayDriver[index]!;
			const at = sourceStep.at as { exchange?: unknown; chunks?: unknown } | null;
			if (
				!at ||
				!Number.isSafeInteger(at.exchange) ||
				!Number.isSafeInteger(at.chunks) ||
				(at.exchange as number) < 1 ||
				(at.exchange as number) > served.length ||
				(at.chunks as number) < 1 ||
				canonicalEndoJsonV0(replayStep.at) !== canonicalEndoJsonV0(at) ||
				((served[(at.exchange as number) - 1]!.payload as { chunksDelivered?: number }).chunksDelivered ?? -1) <
					(at.chunks as number) ||
				cassette.exchanges[(at.exchange as number) - 1]!.response!.chunks.length < (at.chunks as number)
			)
				return refusal("driver-point-unverified");
		}
		if (
			[...script.steps, ...replayDriver].some((step) => step.op === "settled" && step.observed !== true) ||
			replayDriver.some(
				(step) =>
					(step.op === "stop" || step.op === "kill" || step.op === "intervene") && step.pointReached !== true,
			)
		)
			return refusal("driver-point-or-settlement");
		const sessionId = script.steps.find((step) => step.op === "open" || step.op === "reopen")?.piSessionId;
		if (typeof sessionId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(sessionId)) return refusal("session-identity");
		const session = `endo.session.pi.${sessionId}`;
		const sourceTrajectory = storeTrajectory(source, session);
		if (expectedSourceTrajectory !== undefined && sourceTrajectory.digest !== expectedSourceTrajectory)
			return refusal("source-mutated");
		const replayTrajectory = storeTrajectory(replay, session);
		const comparison = compareEndoTrajectoriesV0(sourceTrajectory, replayTrajectory);
		if (
			comparison.flags.length !== 0 ||
			[
				comparison.layers.lifecycle,
				comparison.layers.toolCalls,
				comparison.layers.toolResults,
				comparison.layers.outcome,
			].some((layer) => layer.status !== "EXACT")
		)
			return refusal("trajectory-not-exact");
		const interventions = script.steps.filter((step) => step.op === "intervene");
		const replayInterventions = replayDriver.filter((step) => step.op === "intervene");
		if (
			interventions.length !== replayInterventions.length ||
			replayInterventions.some(
				(step, index) =>
					step.proposalDigestMatches !== true ||
					step.result !== interventions[index]!.result ||
					step.operation !== interventions[index]!.operation ||
					canonicalEndoJsonV0(step.at) !== canonicalEndoJsonV0(interventions[index]!.at),
			)
		)
			return refusal("intervention-unverified");
		if (
			report !== undefined &&
			(report.interventions.length !== interventions.length ||
				report.interventions.some(
					(item, index) =>
						!item.proposalDigestMatches ||
						item.result === "refused" ||
						item.result.startsWith("refused:") ||
						item.operation !== interventions[index]!.operation ||
						canonicalEndoJsonV0(item.recordedAt) !== canonicalEndoJsonV0(item.reissuedAt),
				))
		)
			return refusal("intervention-unverified");
		if (
			report !== undefined &&
			(report.session !== session ||
				report.served !== served.length ||
				report.misses !== 0 ||
				report.unserved !== 0 ||
				report.missDetails.length !== 0 ||
				report.comparison.digest !== comparison.digest)
		)
			return refusal("report-inconsistent");
		const candidate: EndoCheckpointCandidateV0 = {
			schemaVersion: "endo.checkpoint-candidate.v0",
			checkpointClass: "pi-cassette-session",
			boundary: "pre-execution-scratch",
			session,
			archive: { digest: ref.digest, bytes: ref.bytes, schemaVersion: "endo.workspace-archive.v1" },
			evidence: {
				sourceCapture: currentGeneration,
				replayCapture: captureGenerationV0(replayEvents, key),
				sourceTrajectory: sourceTrajectory.digest,
				replayTrajectory: replayTrajectory.digest,
				comparison: comparison.digest,
			},
			environment: {
				source: key.digest(sourceTrajectory.environment),
				replay: key.digest(replayTrajectory.environment),
			},
			qualification: "completed-cassette-zero-misses-four-exact-layers",
			scope: "recorded-scratch-and-observed-cassette-equivalence",
			limitations: "no-live-state-mid-run-or-external-environment-restoration",
		};
		if (!readEndoCheckpointCandidateV0(candidate).ok) return refusal("candidate-invalid");
		if (!evidenceRoots.every(completeEvidenceStore)) return refusal("evidence-log-damaged");
		return { status: "qualified", candidate };
	} catch {
		return refusal("evidence-unverifiable");
	}
}

/** Write only a qualified candidate, atomically, into the replay store's artifact area. */
export function writeQualifiedCheckpointCandidateV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	sourceGeneration: EndoKeyedDigestV0,
	report: PiCassetteReplayReportV0,
	expectedSourceTrajectory: string,
): EndoCheckpointQualificationV0 {
	const result = qualifyInitialCheckpointV0(source, replay, key, sourceGeneration, report, expectedSourceTrajectory);
	if (result.status !== "qualified") return result;
	const file = join(replay, ENDO_CHECKPOINT_CANDIDATE_FILE_V0);
	const directory = join(replay, "replay-artifacts");
	const temporary = `${file}.tmp`;
	let temporaryCreated = false;
	let renamed = false;
	try {
		mkdirSync(directory);
		if (existsSync(file)) return refusal("candidate-already-exists");
		const fd = openSync(temporary, "wx", 0o600);
		temporaryCreated = true;
		try {
			writeFileSync(fd, `${canonicalEndoJsonV0(result.candidate)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, file);
		renamed = true;
		const dirFd = openSync(directory, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return result;
	} catch {
		if (temporaryCreated && !renamed) rmSync(temporary, { force: true });
		if (renamed) rmSync(file, { force: true });
		return refusal("candidate-write-failed");
	}
}

/** Validate the durable contract and rebind every reference to the current source and replay stores. */
export function readVerifiedCheckpointCandidateV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
): EndoCheckpointQualificationV0 {
	try {
		const file = join(replay, ENDO_CHECKPOINT_CANDIDATE_FILE_V0);
		if (!lstatSync(join(replay, "replay-artifacts")).isDirectory()) return refusal("candidate-schema");
		const info = lstatSync(file);
		if (!info.isFile() || info.size > 64 * 1024) return refusal("candidate-schema");
		const bytes = readFileSync(file, "utf8");
		const stored = JSON.parse(bytes) as unknown;
		const parsed = readEndoCheckpointCandidateV0(stored);
		if (!parsed.ok) return refusal("candidate-schema");
		if (bytes !== `${canonicalEndoJsonV0(parsed.value)}\n`) return refusal("candidate-schema");
		const generation = captureGenerationV0(readEndoCaptureEventsV0(source), key);
		const current = qualifyInitialCheckpointV0(source, replay, key, generation);
		if (
			current.status !== "qualified" ||
			canonicalEndoJsonV0(current.candidate) !== canonicalEndoJsonV0(parsed.value)
		)
			return refusal("candidate-evidence-mismatch");
		return current;
	} catch {
		return refusal("candidate-unverifiable");
	}
}
