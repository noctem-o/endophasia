// DSH native importer: identities and the recording of one source row as one `endo.event.v0`.
//
// A persisted DeepSeek Harness (DSH) Session log is read cold (log.ts) and each of its rows becomes exactly one recorded event here,
// by a deterministic function of (session id, row). What is recorded is STRUCTURE: types, counts, lengths, enumerated reasons,
// opaque identifiers, usage numbers and keyed digests (HMAC under the caller's comparison-domain key). Prompts, system and injected
// text, reasoning, tool arguments and results, titles and failure messages never enter an event: they are digested (the keyed
// digest of a value cannot be confirmed against a guess without the key) or reduced to a byte length.
//
// Three clocks are kept apart. `at` is the IMPORT time (an injected clock): when Endophasia read the log, not when anything
// happened. `payload.source.reportedTimeMs` is DSH's own time for the row, as reported, never an observation. DSH's `seq` is a source
// reference in `payload.source.dshSeq`; it is not Endophasia's storage sequence and not its producer `sequence`.
//
// A DSH `tool/call` is a REQUEST (the model asked); the event is `dsh.tool-requested`, never `tool.started`, because the log says
// nothing about when, or whether, execution began.

import { type EndoEventV0, validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import type { DshSessionEvent, DshSessionHeader } from "./log.ts";
import { dshFamilyOfEventTypeV0 } from "./loss.ts";

import { DSH_NATIVE_MAPPING_VERSION_V0 } from "./mapping-version.ts";

export { DSH_NATIVE_MAPPING_VERSION_V0 };
export const DSH_NATIVE_RECORDING_PRODUCER_V0 = "dsh-native-import.1";
export const DSH_NATIVE_LIFECYCLE_PRODUCER_V0 = "dsh-native-lifecycle.1";
export const DSH_NATIVE_CHECKPOINT_PRODUCER_V0 = "dsh-native-checkpoint.1";

const LOCAL = /^[A-Za-z0-9._-]{1,200}$/;

/** `endo.session.dsh.<id>`, or a digest of the id when it is not in the identifier grammar (the rule of `piEndoSessionIdV0`). */
export function dshEndoSessionIdV0(dshSessionId: string): string {
	// An id that itself starts with `sha256-` is hashed too, so a raw id can never equal the hashed form of another id.
	return LOCAL.test(dshSessionId) && !dshSessionId.startsWith("sha256-")
		? `endo.session.dsh.${dshSessionId}`
		: `endo.session.dsh.sha256-${sha256HexV0(dshSessionId).slice(0, 48)}`;
}

/** The id of the recorded event of one row: stable across processes, so a re-import deduplicates by id. */
export function dshRecordedEventIdV0(dshSessionId: string, dshSeq: number): string {
	return `endo.event.dsh-native.${sha256HexV0(`${dshSessionId}\u0000${dshSeq}`).slice(0, 48)}`;
}

/** The id of the one header event of a session. */
export function dshHeaderEventIdV0(dshSessionId: string): string {
	return `endo.event.dsh-native.${sha256HexV0(`${dshSessionId}\u0000header`).slice(0, 48)}`;
}

/** The id of an import checkpoint: everything that defines the import (how far, in what tail state, under which key and mapping). */
export function dshCheckpointEventIdV0(
	dshSessionId: string,
	highWaterSeq: number,
	tail: string,
	keyId: string,
	mapping: string,
): string {
	return `endo.event.dsh-checkpoint.${sha256HexV0(`${dshSessionId}\u0000${highWaterSeq}\u0000${tail}\u0000${keyId}\u0000${mapping}`).slice(0, 48)}`;
}

/** The id of a lifecycle event derived from a recorded event: `index` orders several from one source. */
export function dshLifecycleEventIdV0(recordedId: string, kind: string, index: number): string {
	return `endo.event.dsh-lifecycle.${sha256HexV0(`${recordedId}\u0000${kind}\u0000${index}`).slice(0, 48)}`;
}

type Fields = Record<string, JsonValueV0 | undefined>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A short token that is safe to keep as a classification: no path separators, no secrets-shaped length. Else undefined. */
export function dshToken(value: unknown, max = 128): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9._:@+ -]+$/.test(value)
		? value
		: undefined;
}

const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function compact(fields: Fields): Record<string, JsonValueV0> {
	const out: Record<string, JsonValueV0> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
	return out;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The codes DSH recovery writes on a tool result it synthesised (packages/core/session/src/repair.ts). */
export const RECOVERY_CODES: ReadonlySet<string> = new Set(["TOOL_NOT_STARTED", "TOOL_OUTCOME_UNKNOWN"]);

/** What recording needs besides the row. */
export interface DshRecordingContextV0 {
	dshSessionId: string;
	session: string;
	digestKey: EndoDigestKeyV0;
	/** The import clock, ISO-8601 UTC. */
	at: string;
}

export interface DshRecordedRowV0 {
	kind: string;
	payload: Record<string, JsonValueV0>;
}

/** Keyed digest of a value (canonical JSON), as a plain JSON record. */
export function dshKeyedV0(key: EndoDigestKeyV0, value: unknown): JsonValueV0 {
	return key.digest(value) as unknown as JsonValueV0;
}

/** A failure as DSH structures it (`LlmFailure`): its code and status are kept; its message only by keyed digest and length. */
function failureOf(key: EndoDigestKeyV0, value: unknown): JsonValueV0 | undefined {
	if (!isRecord(value)) return undefined;
	const message = typeof value.message === "string" ? value.message : undefined;
	return compact({
		code: dshToken(value.code, 64),
		status: count(value.status),
		messageDigest: message === undefined ? undefined : dshKeyedV0(key, message),
		messageBytes: message === undefined ? undefined : bytes(message),
	});
}

function contentStats(content: unknown): { parts: number; textBytes: number; kinds: Record<string, number> } {
	const kinds: Record<string, number> = Object.create(null);
	let textBytes = 0;
	const list = Array.isArray(content) ? content : [];
	for (const part of list) {
		const type = isRecord(part) ? (dshToken(part.type, 32) ?? "other") : "other";
		kinds[type] = (kinds[type] ?? 0) + 1;
		if (isRecord(part) && typeof part.text === "string") textBytes += bytes(part.text);
	}
	return { parts: list.length, textBytes, kinds };
}

const USAGE_FIELDS = [
	["inputTokens", "input"],
	["outputTokens", "output"],
	["totalTokens", "totalTokens"],
	["cacheReadTokens", "cacheRead"],
	["cacheWriteTokens", "cacheWrite"],
	["reasoningTokens", "reasoning"],
] as const;

/** The usage categories DSH reported, under Endophasia's names; a category DSH did not report is ABSENT, never 0. */
export function dshUsageV0(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, number> = {};
	for (const [dsh, endo] of USAGE_FIELDS) {
		const item = value[dsh];
		if (typeof item === "number" && Number.isFinite(item) && item >= 0) out[endo] = item;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/** The finish failure of an attempt's embedded stream, if the attempt ended in an error. */
function attemptFailure(key: EndoDigestKeyV0, stream: unknown): JsonValueV0 | undefined {
	for (const record of Array.isArray(stream) ? stream : []) {
		if (!isRecord(record) || record.type !== "chunk" || !isRecord(record.chunk)) continue;
		const chunk = record.chunk;
		if (chunk.type === "finish" && isRecord(chunk.reason) && chunk.reason.kind === "error")
			return failureOf(key, chunk.reason.failure);
	}
	return undefined;
}

/** Parse a tool call's raw argument string; `undefined` when it is not JSON (the digest is then not recorded). */
export function dshParseArguments(raw: unknown): { ok: true; value: unknown } | { ok: false } {
	if (typeof raw !== "string") return { ok: false };
	if (raw === "") return { ok: true, value: {} }; // DSH itself runs an empty argument string as {}
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false };
	}
}

/** The stop reason a DSH assistant message carries inside its provider-shaped replay state, if it is a plain token. */
export function dshStopReason(data: Record<string, unknown>): string | undefined {
	const message = isRecord(data.message) ? data.message : {};
	const source = isRecord(message.source) ? message.source : {};
	const state = isRecord(source.replayState) ? source.replayState : {};
	const response = isRecord(state.response) ? state.response : {};
	return dshToken(response.stopReason, 32);
}

/** Record one row's structure. `kind` is the Endophasia event kind; the payload holds no transcript content. */
export function recordDshRow(row: DshSessionEvent, key: EndoDigestKeyV0): DshRecordedRowV0 {
	const data = isRecord(row.data) ? row.data : {};
	const source = compact({
		dshSeq: row.seq,
		type: dshToken(row.type, 96) ?? "unrecognised",
		reportedTimeMs: typeof row.time === "number" && Number.isFinite(row.time) ? row.time : undefined,
		ignorable: row.ignorable === true ? true : undefined,
	});
	const rowDigest = dshKeyedV0(key, row);
	const make = (kind: string, fields: Fields): DshRecordedRowV0 => ({
		kind,
		payload: { source, rowDigest, ...compact(fields) },
	});
	const where = { turn: count(data.turn), step: count(data.step) };
	switch (row.type) {
		case "turn/start":
			return make("dsh.turn-started", { turn: where.turn });
		case "turn/end": {
			const reason = isRecord(data.reason) ? data.reason : {};
			const cause = isRecord(reason.reason) ? reason.reason : {};
			return make("dsh.turn-ended", {
				turn: where.turn,
				reason: dshToken(reason.kind, 32),
				abortCause: reason.kind === "aborted" ? dshToken(cause.kind, 32) : undefined,
				failure: reason.kind === "error" ? failureOf(key, reason.error) : undefined,
			});
		}
		case "step/start":
			return make("dsh.step-started", where);
		case "step/end":
			return make("dsh.step-ended", where);
		case "user/message":
		case "developer/message":
		case "system/message": {
			const message = row.type === "user/message" ? data : isRecord(data.message) ? data.message : {};
			const stats = contentStats(message.content);
			const origin = isRecord(message.source) ? message.source : {};
			return make("dsh.message-recorded", {
				role: row.type.slice(0, row.type.indexOf("/")),
				...where,
				sourceKind: dshToken(origin.kind, 48),
				parts: stats.parts,
				textBytes: stats.textBytes,
			});
		}
		case "assistant/message": {
			const message = isRecord(data.message) ? data.message : {};
			const origin = isRecord(message.source) ? message.source : {};
			const stats = contentStats(message.content);
			return make("dsh.assistant-recorded", {
				...where,
				provider: dshToken(origin.provider),
				model: dshToken(origin.model),
				stopReason: dshStopReason(data),
				blocks: stats.kinds,
				usage: dshUsageV0(data.usage),
				interrupted: data.interrupted === true ? true : undefined,
				streamRecords: Array.isArray(data.stream) ? data.stream.length : undefined,
			});
		}
		case "assistant/attempt":
			return make("dsh.attempt-recorded", {
				...where,
				streamRecords: Array.isArray(data.stream) ? data.stream.length : undefined,
				failure: attemptFailure(key, data.stream),
			});
		case "llm/retry":
			return make("dsh.retry-recorded", {
				retryId: dshToken(data.retryId, 96),
				...where,
				provider: dshToken(data.provider),
				mode: dshToken(data.mode, 32),
				retry: count(data.retry),
				maxRetries: count(data.maxRetries),
				delayMs: count(data.delayMs),
				failure: failureOf(key, data.failure),
			});
		case "llm/retry-started":
			return make("dsh.retry-started", { retryId: dshToken(data.retryId, 96), ...where, retry: count(data.retry) });
		case "tool/call": {
			const parsed = dshParseArguments(data.arguments);
			return make("dsh.tool-requested", {
				...where,
				callId: dshToken(data.callId, 128),
				name: dshToken(data.name, 128),
				argumentsBytes: typeof data.arguments === "string" ? bytes(data.arguments) : undefined,
				// The digest is over the parsed arguments (canonical JSON), the scheme the Pi adapter uses; raw text that is not JSON has none.
				argsDigest: parsed.ok ? dshKeyedV0(key, parsed.value) : undefined,
				argumentsParsable: parsed.ok,
			});
		}
		case "tool/result": {
			const message = isRecord(data.message) ? data.message : {};
			const stats = contentStats(message.content);
			const error = isRecord(data.error) ? data.error : undefined;
			// DSH's own recovery writes an error result for a call whose outcome it never saw (TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN).
			// That is DSH speaking after the fact, not a tool outcome anyone observed: it is flagged, and not offered as a result.
			const recovery = RECOVERY_CODES.has(String(error?.code)) ? String(error?.code) : undefined;
			return make("dsh.tool-result-recorded", {
				...where,
				dshRecovery: recovery,
				callId: dshToken(message.toolCallId, 128),
				isError: typeof message.isError === "boolean" ? message.isError : undefined,
				// The digest is over the model-facing content, as `piToolResultDigestV0` does; `meta` (tool-private) is never read.
				resultDigest:
					recovery === undefined && Array.isArray(message.content) ? dshKeyedV0(key, message.content) : undefined,
				resultParts: stats.parts,
				errorName: error === undefined ? undefined : dshToken(error.name, 64),
				errorCode: error === undefined ? undefined : dshToken(error.code, 64),
				errorReasonBytes: error !== undefined && typeof error.reason === "string" ? bytes(error.reason) : undefined,
				metaPresent: data.meta !== undefined ? true : undefined,
			});
		}
		case "request/header": {
			const header = isRecord(data.header) ? data.header : {};
			const config = isRecord(header.config) ? header.config : {};
			const tools = Array.isArray(header.tools) ? header.tools : [];
			const names = tools
				.map((tool) => (isRecord(tool) ? dshToken(tool.name, 64) : undefined))
				.filter((name): name is string => name !== undefined);
			return make("dsh.request-config-recorded", {
				reason: dshToken(data.reason, 16),
				startsSeries: data.startsSeries === true ? true : undefined,
				provider: dshToken(config.provider),
				model: dshToken(config.model),
				toolCount: tools.length,
				toolNames: names.slice(0, 128),
				configDigest: dshKeyedV0(key, header),
			});
		}
		case "request/context":
			return make("dsh.request-route-recorded", {
				provider: dshToken(data.provider),
				model: dshToken(data.model),
				contextWindow: count(data.contextWindow),
			});
		case "permission/preset":
		case "sandbox/mode":
		case "approval/policy":
			return make("dsh.authority-recorded", {
				record: row.type,
				value: dshToken(data.preset ?? data.mode ?? data.policy, 48),
			});
		case "approval/asked":
			return make("dsh.authority-recorded", {
				record: row.type,
				approvalId: dshToken(data.id, 128),
				toolName: dshToken(data.toolName, 128),
				callId: dshToken(data.callId, 128),
				reasonBytes: typeof data.reason === "string" ? bytes(data.reason) : undefined,
			});
		case "approval/decided":
			return make("dsh.authority-recorded", {
				record: row.type,
				approvalId: dshToken(data.id, 128),
				outcome:
					typeof data.outcome === "string"
						? dshToken(data.outcome, 48)
						: dshToken(isRecord(data.outcome) ? data.outcome.kind : undefined, 48),
			});
		case "session/end-seed":
			return make("dsh.seed-boundary", { inherited: data.inherited === true });
		default:
			// Any other event of the pinned vocabulary (compaction, orchestration, hooks, workflow, feedback, titles...): its type, its
			// family and its keyed digest. Nothing of its payload is interpreted, so nothing of it can leak.
			return make("dsh.record", {
				family: dshFamilyOfEventTypeV0(row.type) ?? "unknown-ignorable",
				dataDigest: dshKeyedV0(key, data),
			});
	}
}

/** The header as committed to by its keyed digest: all fields except the format generation. */
function headerWithoutCwd(header: DshSessionHeader): Record<string, unknown> {
	// The format version is left out (a generation is metadata, not identity). The working directory is NOT: it is committed to by the
	// keyed digest, so a changed cwd is a changed header, while its plaintext is never stored (the payload below has no cwd).
	const { version: _version, ...rest } = header;
	return rest;
}

/** The header event's payload: lineage and format, with the header's keyed digest. No cwd, no path. */
export function recordDshHeader(
	header: DshSessionHeader,
	cut: number,
	key: EndoDigestKeyV0,
): Record<string, JsonValueV0> {
	return compact({
		basis: "imported-from-persisted-log",
		mapping: DSH_NATIVE_MAPPING_VERSION_V0,
		formatVersion: header.version,
		isSeeded: header.isSeeded === true,
		origin: header.origin === "subagent" ? "subagent" : undefined,
		delegationDepth: count(header.delegationDepth),
		parentSession: typeof header.parentSession === "string" ? dshEndoSessionIdV0(header.parentSession) : undefined,
		inheritedCut: header.isSeeded === true ? cut : undefined,
		// A preset id is a user-chosen string: digest only.
		agentPresetDigest: typeof header.agentPreset === "string" ? dshKeyedV0(key, header.agentPreset) : undefined,
		keyId: key.keyId,
		keyDomain: dshToken(key.domain, 64),
		reportedCreatedAtMs: typeof header.createdAt === "number" ? header.createdAt : undefined,
		headerDigest: dshKeyedV0(key, headerWithoutCwd(header)),
	});
}

/** Build and validate one event of this adapter. */
export function dshEvent(fields: {
	id: string;
	kind: string;
	source: "runtime-fact" | "interpretation";
	sequence: number;
	at: string;
	session: string;
	producer: string;
	derivedFrom: string[];
	payload: Record<string, JsonValueV0>;
}): EndoEventV0 {
	const candidate = {
		schemaVersion: "endo.event.v0" as const,
		id: fields.id,
		kind: fields.kind,
		source: fields.source,
		sequence: fields.sequence,
		at: fields.at,
		coordinates: { sessionId: fields.session },
		producer: fields.producer,
		derivedFrom: fields.derivedFrom,
		payload: JSON.parse(canonicalEndoJsonV0(fields.payload)) as JsonValueV0,
	};
	const valid = validateEndoEventV0(candidate);
	if (valid === null) throw new TypeError(`the ${fields.kind} event failed endo.event.v0 validation`);
	return valid;
}
