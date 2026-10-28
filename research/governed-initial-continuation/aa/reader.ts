// Private, read-only comparison; every accepted slot is verified from its source evidence.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { endoCaptureRootV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../../../adapters/openai-proxy/cassette.ts";
import { Http1ParserV0 } from "../../../adapters/openai-proxy/http1.ts";
import { initialExecutionPrivateFileV0 } from "../../../cli/initial-child-execution.ts";
import {
	decodeInitialContinuationResponseV0,
	verifyInitialContinuationEvidenceV0,
} from "../../../cli/initial-continuation.ts";
import {
	type InitialContinuationPlanV0,
	readInitialContinuationReceiptV0,
} from "../../../protocol/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { type Arm, commonTemplate, readStudyPlan } from "./study-plan.ts";
import { admissionPath, type SyntheticAdmissionRecord, sealAdmission } from "./synthetic-admission.ts";

export interface SlotStart {
	position: number;
	arm: Arm;
	studyCommitment: EndoKeyedDigestV0;
	plan: InitialContinuationPlanV0;
	startedAt: string;
	commitment: EndoKeyedDigestV0;
}
export interface SlotEnd {
	position: number;
	startCommitment: EndoKeyedDigestV0;
	status: string;
	receipt: string | null;
	endedAt: string;
	commitment: EndoKeyedDigestV0;
}
export const slotPath = (path: string, position: number, kind: "start" | "end") =>
	`${path}.slot-${position}.${kind}.json`;
export const sealSlot = <T extends object>(key: EndoDigestKeyV0, kind: "start" | "end", body: T) => ({
	...body,
	commitment: key.digest({ purpose: `endo.research.two-turn-aa.slot.${kind}.0`, body }),
});
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
export function cwdAdjustedContext(messages: unknown[], cwd: string): { context: unknown[]; adjusted: boolean } {
	const copy = structuredClone(messages);
	const needle = `<cwd>\n${cwd}\n</cwd>`;
	const marker = "<cwd>\n[verified-runtime-working-directory]\n</cwd>";
	const strings = (value: unknown): string[] =>
		typeof value === "string"
			? [value]
			: Array.isArray(value)
				? value.flatMap(strings)
				: value && typeof value === "object"
					? Object.values(value).flatMap(strings)
					: [];
	const fields = strings(copy);
	if (fields.some((value) => value.includes(marker))) throw new Error("cwd normalization marker collision");
	const matches = copy.filter(
		(m): m is { role: string; content: string } =>
			!!m &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === "system" &&
			typeof (m as { content?: unknown }).content === "string" &&
			(m as { content: string }).content.includes(needle),
	);
	if (matches.length === 0) return { context: copy, adjusted: false };
	if (
		matches.length !== 1 ||
		matches[0]!.content.split(needle).length !== 2 ||
		fields.reduce((count, value) => count + value.split(cwd).length - 1, 0) !== 1
	)
		throw new Error("cwd is not uniquely identified");
	matches[0]!.content = matches[0]!.content.replace(needle, marker);
	return { context: copy, adjusted: true };
}
export function readSlot<T extends { commitment: EndoKeyedDigestV0 }>(
	path: string,
	key: EndoDigestKeyV0,
	kind: "start" | "end",
): T {
	const text = initialExecutionPrivateFileV0(path, 128 * 1024);
	const value = JSON.parse(text) as T;
	if (!value || text !== canonicalEndoJsonV0(value)) throw new Error("invalid slot encoding");
	const { commitment, ...body } = value;
	if (!same(commitment, sealSlot(key, kind, body).commitment)) throw new Error("invalid slot commitment");
	return value;
}
/** Diagnose a stopped slot without admitting it to a completed comparison. */
export async function inspectStoppedSlot(path: string, key: EndoDigestKeyV0, position: number): Promise<string> {
	if (!Number.isInteger(position) || position < 1 || position > 4) throw new Error("invalid slot");
	const study = await readStudyPlan(path, key);
	const start = readSlot<SlotStart>(slotPath(path, position, "start"), key, "start");
	const arm = study.order[position - 1]!;
	const expected = study.templates[arm];
	if (
		start.position !== position ||
		start.arm !== arm ||
		!same(start.studyCommitment, study.commitment) ||
		start.plan.initial.childId !== expected.initial.childId ||
		start.plan.initial.childRole !== arm ||
		!same(start.plan.initial.conditionCommitment, expected.initial.conditionCommitment) ||
		!same(commonTemplate(start.plan), commonTemplate(expected))
	)
		throw new Error("stopped slot mismatch");
	const endPath = slotPath(path, position, "end");
	if (!existsSync(endPath)) return "interrupted-outcome-unknown";
	const end = readSlot<SlotEnd>(endPath, key, "end");
	if (end.position !== position || !same(end.startCommitment, start.commitment))
		throw new Error("stopped slot commitment mismatch");
	if (end.receipt) {
		const verified = await verifyInitialContinuationEvidenceV0(
			study.options.source,
			study.options.replay,
			key,
			end.receipt,
		);
		if (verified.status === "first-turn-verified" && verified.attemptId === start.plan.initial.attemptId) {
			const receipt = readInitialContinuationReceiptV0(
				JSON.parse(initialExecutionPrivateFileV0(end.receipt, 64 * 1024)),
			);
			if (receipt && same(receipt.plan, start.plan)) return "first-turn-verified";
		}
		return "outcome-unknown-or-unverified";
	}
	if (readdirSync(study.options.outputParent).includes(start.plan.initial.attemptId))
		return "outcome-unknown-or-unverified";
	if (end.status === "no-request-cancelled" || end.status === "no-request-refused") return end.status;
	return "outcome-unknown-or-unverified";
}
function observationsFromWire(wire: Uint8Array): {
	usage: { prompt: number | null; completion: number | null; cached: number | null };
	reasoningFieldPresent: boolean;
	reasoningBytes: number;
} {
	const parts: Buffer[] = [];
	const parser = new Http1ParserV0(
		"response",
		{
			head() {},
			body(b) {
				parts.push(Buffer.from(b));
			},
			end() {},
		},
		{ strictChunks: true },
	);
	parser.pendingMethods.push("POST");
	parser.push(Buffer.from(wire));
	if (!parser.close()) throw new Error("incomplete response");
	let usage: unknown = null;
	let reasoningFieldPresent = false;
	let reasoning = "";
	for (const line of new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)).split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (data === "[DONE]") continue;
		const event = JSON.parse(data) as { usage?: unknown; choices?: Array<{ delta?: Record<string, unknown> }> };
		if (
			Array.isArray(event.choices) &&
			event.choices.some((c) => c.delta && Object.hasOwn(c.delta, "reasoning_content"))
		)
			reasoningFieldPresent = true;
		if (Array.isArray(event.choices))
			for (const c of event.choices)
				if (typeof c.delta?.reasoning_content === "string") reasoning += c.delta.reasoning_content;
		if (event.usage !== undefined && event.usage !== null) {
			if (usage !== null) throw new Error("duplicate usage");
			usage = event.usage;
		}
	}
	if (usage === null)
		return {
			usage: { prompt: null, completion: null, cached: null },
			reasoningFieldPresent,
			reasoningBytes: Buffer.byteLength(reasoning),
		};
	if (typeof usage !== "object" || Array.isArray(usage)) throw new Error("unsupported usage");
	const u = usage as Record<string, unknown>;
	const count = (v: unknown): number | null => {
		if (v === undefined || v === null) return null;
		if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("invalid usage count");
		return v as number;
	};
	const details = u.prompt_tokens_details;
	if (details !== undefined && details !== null && (typeof details !== "object" || Array.isArray(details)))
		throw new Error("unsupported usage details");
	return {
		usage: {
			prompt: count(u.prompt_tokens),
			completion: count(u.completion_tokens),
			cached: count((details as Record<string, unknown> | null | undefined)?.cached_tokens),
		},
		reasoningFieldPresent,
		reasoningBytes: Buffer.byteLength(reasoning),
	};
}
export interface TrialMeasurement {
	position: number;
	arm: Arm;
	attemptId: string;
	sessionId: string;
	receiptStatus: "verified";
	requestCount: 2;
	firstCorrect: boolean;
	referenceCorrect: boolean;
	retention: "verified";
	turns: Array<{
		requestBodyDigest: EndoKeyedDigestV0;
		requestBodyBytes: number;
		retainedResponseWireBytes: number;
		retainedResponseWireDigest: EndoKeyedDigestV0;
		answerDigest: EndoKeyedDigestV0;
		parametersDigest: EndoKeyedDigestV0;
		reasoningFieldPresent: boolean;
		reasoningBytes: number;
		contextDigest: EndoKeyedDigestV0;
		rawContextDigest: EndoKeyedDigestV0;
		cwdAdjusted: boolean;
		usage: { prompt: number | null; completion: number | null; cached: number | null };
		lastResponseChunkOffsetMs: number | null;
	}>;
}
export async function readStudy(
	path: string,
	key: EndoDigestKeyV0,
): Promise<{
	status: "partial" | "four-receipts";
	serverIdentity: "unverified";
	syntheticAdmission: "verified" | "unavailable";
	syntheticObservationIds: string[];
	trials: TrialMeasurement[];
	effectiveParametersEqual: boolean;
	comparisons: Array<{
		positions: [number, number];
		sameArm: boolean;
		samePair: boolean;
		answerAgreement: boolean[];
		rawRequestBodyEquality: boolean[];
		retainedResponseWireEquality: boolean[];
	}>;
}> {
	const plan = await readStudyPlan(path, key);
	const prefix = `${basename(path)}.slot-`;
	const names = new Set(readdirSync(dirname(path)));
	for (const name of names) {
		if (
			name.startsWith(prefix) &&
			![1, 2, 3, 4].some((i) => name === `${prefix}${i}.start.json` || name === `${prefix}${i}.end.json`)
		)
			throw new Error("unplanned slot artifact");
	}
	const trials: TrialMeasurement[] = [];
	const attempts = new Set<string>(),
		sessions = new Set<string>();
	let missing = false;
	let allSynthetic = true;
	let syntheticIdentity: string | undefined;
	const observations = new Set<string>();
	let previousEnd = Date.parse(plan.createdAt);
	for (let position = 1; position <= 4; position++) {
		const startFile = slotPath(path, position, "start"),
			endFile = slotPath(path, position, "end");
		const hasStart = names.has(basename(startFile)),
			hasEnd = names.has(basename(endFile));
		if (!hasStart && !hasEnd) {
			missing = true;
			continue;
		}
		if (missing || !hasStart || !hasEnd) throw new Error("missing, interrupted or reordered slot");
		const start = readSlot<SlotStart>(startFile, key, "start");
		const end = readSlot<SlotEnd>(endFile, key, "end");
		const arm = plan.order[position - 1]!;
		const expected = plan.templates[arm];
		if (
			start.position !== position ||
			start.arm !== arm ||
			!same(start.studyCommitment, plan.commitment) ||
			end.position !== position ||
			!same(end.startCommitment, start.commitment) ||
			end.status !== "completed" ||
			!end.receipt ||
			start.plan.initial.childRole !== arm ||
			start.plan.initial.childId !== expected.initial.childId ||
			!same(start.plan.initial.conditionCommitment, expected.initial.conditionCommitment) ||
			!same(commonTemplate(start.plan), commonTemplate(expected))
		)
			throw new Error("slot does not match study");
		const verified = await verifyInitialContinuationEvidenceV0(
			plan.options.source,
			plan.options.replay,
			key,
			end.receipt,
		);
		if (verified.status !== "verified" || verified.attemptId !== start.plan.initial.attemptId)
			throw new Error("continuation receipt unverified");
		const receipt = readInitialContinuationReceiptV0(
			JSON.parse(initialExecutionPrivateFileV0(end.receipt, 64 * 1024)),
		);
		if (
			!receipt ||
			!receipt.runtime ||
			!receipt.dispatch1 ||
			!receipt.dispatch2 ||
			!receipt.secondApproval ||
			!Number.isFinite(Date.parse(start.startedAt)) ||
			!Number.isFinite(Date.parse(end.endedAt)) ||
			Date.parse(start.startedAt) < previousEnd ||
			Date.parse(start.startedAt) > Date.parse(receipt.firstApproval.confirmedAt) ||
			Date.parse(receipt.firstApproval.confirmedAt) > Date.parse(receipt.dispatch1.at) ||
			Date.parse(receipt.dispatch1.at) > Date.parse(receipt.secondApproval.confirmedAt) ||
			Date.parse(receipt.secondApproval.confirmedAt) > Date.parse(receipt.dispatch2.at) ||
			Date.parse(receipt.dispatch2.at) > Date.parse(end.endedAt) ||
			!same(receipt.plan, start.plan) ||
			attempts.has(receipt.plan.initial.attemptId) ||
			sessions.has(receipt.runtime.sessionId)
		)
			throw new Error("duplicate or mismatched attempt/session");
		previousEnd = Date.parse(end.endedAt);
		attempts.add(receipt.plan.initial.attemptId);
		sessions.add(receipt.runtime.sessionId);
		const cassette = loadEndoCassetteV0(receipt.runtime.store, key);
		if (cassette.exchanges.length !== 2) throw new Error("unexpected request count");
		const files = [admissionPath(dirname(end.receipt), 1), admissionPath(dirname(end.receipt), 2)];
		if (
			readdirSync(dirname(end.receipt)).some(
				(name) =>
					name.startsWith("synthetic-admission-") &&
					!["synthetic-admission-1.json", "synthetic-admission-2.json"].includes(name),
			)
		)
			throw new Error("unplanned admission artifact");
		if (
			readdirSync(dirname(end.receipt)).some(
				(name) =>
					name.startsWith("task-owned-admission-") &&
					(plan.taskOwnedProvenance === undefined ||
						!["task-owned-admission-1.json", "task-owned-admission-2.json"].includes(name)),
			)
		)
			throw new Error("unplanned task-owned admission artifact");
		if (!files.some(existsSync)) {
			if (plan.syntheticAdmission !== undefined) throw new Error("synthetic admission missing");
			allSynthetic = false;
		} else {
			if (plan.syntheticAdmission === undefined) throw new Error("unexpected synthetic admission");
			for (const turn of [1, 2] as const) {
				const text = initialExecutionPrivateFileV0(files[turn - 1]!, 8192);
				const record = JSON.parse(text) as SyntheticAdmissionRecord;
				if (!record || text !== canonicalEndoJsonV0(record)) throw new Error("invalid admission encoding");
				const { commitment, ...body } = record;
				const dispatch = turn === 1 ? receipt.dispatch1 : receipt.dispatch2;
				const response = cassette.events.find(
					(event) =>
						event.kind === "capture.response" && (event.payload as { exchange?: number }).exchange === turn,
				);
				if (
					!same(
						Object.keys(record).sort(),
						[
							"version",
							"studyCommitment",
							"startCommitment",
							"position",
							"attemptId",
							"turn",
							"upstream",
							"requestDigest",
							"dispatchCommitment",
							"approvalCommitment",
							"identity",
							"observationId",
							"result",
							"refusalReason",
							"preparedAt",
							"admittedAt",
							"commitment",
						].sort(),
					) ||
					!same(commitment, sealAdmission(key, body).commitment) ||
					record.version !== "endo.research.aa.synthetic-admission.0" ||
					!same(record.studyCommitment, plan.commitment) ||
					!same(record.startCommitment, start.commitment) ||
					record.position !== position ||
					record.attemptId !== start.plan.initial.attemptId ||
					record.turn !== turn ||
					record.upstream !== plan.options.upstream ||
					!same(record.requestDigest, cassette.exchanges[turn - 1]!.requestBody.digest) ||
					!same(record.dispatchCommitment, dispatch.commitment) ||
					!same(record.approvalCommitment, dispatch.approvalCommitment) ||
					typeof record.identity !== "string" ||
					record.identity.length < 1 ||
					record.identity.length > 256 ||
					record.identity !== plan.syntheticAdmission.identity ||
					record.result !== "admitted" ||
					record.refusalReason !== null ||
					typeof record.observationId !== "string" ||
					!/^[a-f0-9]{32}$/.test(record.observationId) ||
					observations.has(record.observationId) ||
					!Number.isFinite(Date.parse(record.preparedAt)) ||
					!Number.isFinite(Date.parse(record.admittedAt)) ||
					Date.parse(record.preparedAt) < Date.parse(dispatch.at) ||
					Date.parse(record.preparedAt) > Date.parse(record.admittedAt) ||
					!response ||
					Date.parse(record.admittedAt) > Date.parse(response.at) ||
					Date.parse(record.admittedAt) > Date.parse(end.endedAt) ||
					(syntheticIdentity !== undefined && syntheticIdentity !== record.identity)
				)
					throw new Error("synthetic admission invalid");
				syntheticIdentity = record.identity;
				observations.add(record.observationId);
			}
		}
		const blobs = createEndoBlobStoreV0(endoCaptureRootV0(receipt.runtime.store), key, { readOnly: true });
		const answers: string[] = [];
		const turns = cassette.exchanges.map((exchange, index) => {
			if (!exchange.response || exchange.truncated) throw new Error("incomplete exchange");
			const request = blobs.get(exchange.requestBody.digest),
				wire = blobs.get(exchange.response.wire.digest);
			const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request)) as Record<string, unknown>;
			const { messages, ...parameters } = body;
			if (!Array.isArray(messages) || (index === 1 && messages.length < 3))
				throw new Error("unsupported conversation");
			const context = index === 0 ? messages : messages.slice(0, -2);
			const normalized = cwdAdjustedContext(context, receipt.runtime!.workingDirectory);
			const decoded = decodeInitialContinuationResponseV0(wire, plan.options.model);
			const observations = observationsFromWire(wire);
			answers.push(decoded.text);
			return {
				requestBodyDigest: exchange.requestBody.digest,
				requestBodyBytes: request.length,
				retainedResponseWireBytes: wire.length,
				retainedResponseWireDigest: exchange.response.wire.digest,
				answerDigest: key.digest({ purpose: "endo.research.two-turn-aa.answer.0", answer: decoded.text }),
				parametersDigest: key.digest({ purpose: "endo.research.two-turn-aa.request-parameters.0", parameters }),
				rawContextDigest: key.digest({ purpose: "endo.research.two-turn-aa.request-context.0", context }),
				contextDigest: key.digest({
					purpose: "endo.research.two-turn-aa.request-context.0",
					context: normalized.context,
				}),
				cwdAdjusted: normalized.adjusted,
				reasoningFieldPresent: observations.reasoningFieldPresent,
				reasoningBytes: observations.reasoningBytes,
				usage: observations.usage,
				lastResponseChunkOffsetMs: exchange.response.chunks.at(-1)?.offsetMs ?? null,
			};
		});
		trials.push({
			position,
			arm,
			attemptId: receipt.plan.initial.attemptId,
			sessionId: receipt.runtime.sessionId,
			receiptStatus: "verified",
			requestCount: 2,
			firstCorrect: answers[0] === plan.expectedAnswer,
			referenceCorrect: /^\S+$/.test(answers[0] ?? "") && answers[1] === answers[0],
			retention: "verified",
			turns,
		});
	}
	const params = trials.flatMap((t) => t.turns.map((turn) => turn.parametersDigest));
	const contexts = trials.flatMap((t) => t.turns.map((turn) => turn.contextDigest));
	const refreshed = await readStudyPlan(path, key); // Recheck current lineage after reading all captures.
	if (!same(refreshed.commitment, plan.commitment)) throw new Error("study plan changed during reading");
	if (params.some((p) => !same(p, params[0]))) throw new Error("effective request parameters differ");
	if (contexts.some((c) => !same(c, contexts[0]))) throw new Error("common request context differs");
	const comparisons = trials.flatMap((left, i) =>
		trials.slice(i + 1).map((right) => ({
			positions: [left.position, right.position] as [number, number],
			sameArm: left.arm === right.arm,
			samePair: Math.floor((left.position - 1) / 2) === Math.floor((right.position - 1) / 2),
			answerAgreement: left.turns.map((turn, n) => same(turn.answerDigest, right.turns[n]!.answerDigest)),
			rawRequestBodyEquality: left.turns.map((turn, n) =>
				same(turn.requestBodyDigest, right.turns[n]!.requestBodyDigest),
			),
			retainedResponseWireEquality: left.turns.map((turn, n) =>
				same(turn.retainedResponseWireDigest, right.turns[n]!.retainedResponseWireDigest),
			),
		})),
	);
	return {
		status: trials.length === 4 ? "four-receipts" : "partial",
		serverIdentity: "unverified",
		syntheticAdmission: trials.length > 0 && allSynthetic ? "verified" : "unavailable",
		syntheticObservationIds: [...observations],
		trials,
		effectiveParametersEqual: params.length > 0 && params.every((p) => same(p, params[0])),
		comparisons,
	};
}
