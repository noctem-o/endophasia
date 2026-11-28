import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import type { EndoEventV0 } from "../protocol/event.ts";
import { isWellFormedKindV0 } from "../protocol/identity.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoSessionLogReadV0 } from "../runtime/contracts/develop-attempt-execution.ts";
import { createEndoEventStoreV0, ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0 } from "../runtime/contracts/event-store.ts";
import {
	type EndoEventStreamIdV0,
	type EndoEventStreamKeyV0,
	endoEventStreamKeyV0,
	endoEventStreamPathV0,
} from "./event-stream-path.ts";
import {
	decodeEndoFrameLogV0,
	type EndoFrameLogRecoveryV0,
	EndoLogUnreadableErrorV0,
	endoFrameLogRecoveryV0,
	readEndoLogBytesV0,
} from "./log.ts";
import {
	classifyEndoLegacySnapshotV0,
	type EndoStoreFormatV0,
	endoLegacySealPresenceV0,
	endoStoreFormatPathsV0,
	hasEndoStoreSentinelV0,
	inspectEndoStoreBarrierV0,
} from "./store-format.ts";
import type { EndoEventStoreWriterV0 } from "./store-format-write.ts";

export type EndoEventStreamCompletenessV0 =
	| "absent"
	| "complete"
	| "torn-tail"
	| "sealed"
	| "incomplete-uncertain"
	| "budget-exhausted"
	| "unopenable";

export type EndoEventStreamIntegrityFindingV0 =
	| {
			readonly code: "duplicate-event-id-across-streams";
			readonly stream: EndoEventStreamKeyV0;
			readonly other: EndoEventStreamKeyV0;
			readonly eventId: string;
			readonly conflict: boolean;
	  }
	| {
			readonly code: "cross-stream-derivation";
			readonly stream: EndoEventStreamKeyV0;
			readonly parentStream: EndoEventStreamKeyV0;
			readonly eventId: string;
			readonly parentId: string;
	  }
	| {
			readonly code: "foreign-producer-in-stream";
			readonly stream: EndoEventStreamKeyV0;
			readonly eventId: string;
			readonly producer: string;
	  }
	| { readonly code: "attachment-directory-rejected"; readonly name: string }
	| { readonly code: "attachments-unavailable" | "attachments-truncated" }
	| {
			readonly code: "legacy-seal-drift";
			readonly stream: "legacy";
			readonly detail: Extract<EndoStoreFormatV0, { state: "legacy-seal-drift" }>["findings"][number];
	  };

export interface EndoEventStreamWatermarkV0 {
	readonly length: number;
	readonly lastEventId: string | null;
	readonly prefixSha256: string | null;
	readonly bytesObserved: number;
}

export interface EndoEventStreamStandingV0 {
	readonly stream: EndoEventStreamIdV0;
	readonly key: EndoEventStreamKeyV0;
	readonly completeness: EndoEventStreamCompletenessV0;
	readonly recovery: EndoFrameLogRecoveryV0 | null;
	readonly watermark: EndoEventStreamWatermarkV0 | null;
	readonly freshness: {
		readonly readAtMs: number;
		readonly newestEventAtMs: number | null;
		readonly eventsDatedAfterRead: number;
	};
	readonly reason: string | null;
	readonly findings: readonly EndoEventStreamIntegrityFindingV0[];
}

export interface EndoEventStreamReadV0 {
	readonly standing: EndoEventStreamStandingV0;
	readonly events: readonly EndoEventV0[];
	readonly evidenceLength: number;
	readonly whole: boolean;
}

export interface EndoEventStoreReadV0 {
	readonly format: EndoStoreFormatV0["state"];
	readonly barrierFinding: Extract<EndoStoreFormatV0, { state: "format-barrier-broken" }>["finding"] | null;
	readonly legacySealVerified: boolean | null;
	readonly streams: readonly EndoEventStreamReadV0[];
	readonly discoveryComplete: boolean;
	readonly attachmentsTruncated: boolean;
	readonly budget: { readonly maxBytes: number | null; readonly consumedBytes: number };
	readonly findings: readonly EndoEventStreamIntegrityFindingV0[];
	readonly aggregate: EndoEventStreamCompletenessV0;
}

export interface EndoEventStoreReadOptionsV0 {
	readonly maxBytes?: number;
	readonly maxAttachments?: number;
	readonly only?: readonly EndoEventStreamIdV0[];
	readonly priority?: readonly EndoEventStreamKeyV0[];
	readonly now?: () => number;
}

function prefixHash(events: readonly EndoEventV0[], count = events.length): string | null {
	if (count === 0) return null;
	const hash = createHash("sha256");
	for (let index = 0; index < count; index += 1) hash.update(`${sha256HexV0(canonicalEndoJsonV0(events[index]))}\n`);
	return hash.digest("hex");
}

const ORDER: readonly EndoEventStreamCompletenessV0[] = [
	"absent",
	"complete",
	"torn-tail",
	"sealed",
	"incomplete-uncertain",
	"budget-exhausted",
	"unopenable",
];
export function endoWeakestStandingV0(states: readonly EndoEventStreamCompletenessV0[]): EndoEventStreamCompletenessV0 {
	return states.reduce(
		(weakest, state) => (ORDER.indexOf(state) > ORDER.indexOf(weakest) ? state : weakest),
		"absent",
	);
}

const DECODER = new TextDecoder("utf-8", { fatal: true });
const LEGACY = { kind: "legacy" } as const;
const OWNED_PRODUCER = /^(?:pi-rpc-adapter|pi-lifecycle|codex-app-server|codex-lifecycle):(.+)$/;

function requireLimit(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
		throw new TypeError(`${field} must be a non-negative safe integer`);
}

function attachmentIds(root: string, cap: number, findings: EndoEventStreamIntegrityFindingV0[]) {
	const path = endoStoreFormatPathsV0(root).streams;
	const ids: EndoEventStreamIdV0[] = [];
	try {
		const parent = lstatSync(join(root, "events"), { throwIfNoEntry: false });
		if (parent === undefined) return ids;
		if (!parent.isDirectory()) throw new TypeError("not an events directory");
		const info = lstatSync(path, { throwIfNoEntry: false });
		if (info === undefined) return ids;
		if (!info.isDirectory()) throw new TypeError("not an attachments directory");
		const entries = opendirSync(path);
		let examined = 0;
		try {
			for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
				if (entry.name === "FORMAT") continue;
				if (examined++ >= cap) {
					findings.push({ code: "attachments-truncated" });
					break;
				}
				if (/^FORMAT\.tmp-[0-9a-f-]{36}$/.test(entry.name)) continue;
				if (isWellFormedKindV0(entry.name) && entry.isDirectory())
					ids.push({ kind: "attachment", attachmentId: entry.name });
				else findings.push({ code: "attachment-directory-rejected", name: entry.name });
			}
		} finally {
			entries.closeSync();
		}
	} catch {
		findings.push({ code: "attachments-unavailable" });
	}
	return ids;
}

export function readEndoEventStoreV0(root: string, options: EndoEventStoreReadOptionsV0 = {}): EndoEventStoreReadV0 {
	requireLimit(options.maxBytes, "maxBytes");
	requireLimit(options.maxAttachments, "maxAttachments");
	const readAtMs = (options.now ?? Date.now)();
	const initial = inspectEndoStoreBarrierV0(root);
	const paths = endoStoreFormatPathsV0(root);
	const findings: EndoEventStreamIntegrityFindingV0[] = [];
	let legacyPresent = false;
	try {
		legacyPresent = lstatSync(paths.legacy, { throwIfNoEntry: false }) !== undefined;
	} catch {
		legacyPresent = true;
	}
	const includeLegacy =
		legacyPresent ||
		initial.state === "legacy-only" ||
		initial.state === "format-barrier-broken" ||
		(hasEndoStoreSentinelV0(initial) &&
			(endoLegacySealPresenceV0(initial.sentinel.legacy) !== null || initial.witness === "seal-mismatch"));
	const ids = new Map<EndoEventStreamKeyV0, EndoEventStreamIdV0>();
	for (const id of options.only ?? [
		...(includeLegacy ? [LEGACY] : []),
		...attachmentIds(root, options.maxAttachments ?? 64, findings),
	])
		ids.set(endoEventStreamKeyV0(id), id);
	const priority = new Map((options.priority ?? []).map((key, index) => [key, index]));
	const ordered = [...ids.keys()].sort(
		(a, b) =>
			(priority.get(a) ?? Infinity) - (priority.get(b) ?? Infinity) ||
			(a === b ? 0 : a === "legacy" ? -1 : b === "legacy" ? 1 : a < b ? -1 : 1),
	);
	const streams: EndoEventStreamReadV0[] = [];
	let consumedBytes = 0;
	let format: EndoStoreFormatV0 = initial;
	const attachmentTruncated = findings.some((item) => item.code === "attachments-truncated");
	let discoveryComplete =
		options.only === undefined &&
		findings.length === 0 &&
		initial.state !== "format-barrier-broken" &&
		initial.state !== "initialising";
	let legacySealVerified: boolean | null = hasEndoStoreSentinelV0(initial) && !includeLegacy ? true : null;

	for (const key of ordered) {
		const id = ids.get(key)!;
		let events: EndoEventV0[] = [];
		let recovery: EndoFrameLogRecoveryV0 | null = null;
		let watermark: EndoEventStreamWatermarkV0 | null = null;
		let completeness: EndoEventStreamCompletenessV0 = "absent";
		let reason: string | null = null;
		let evidenceLength = 0;
		const localFindings: EndoEventStreamIntegrityFindingV0[] = [];
		const seal =
			key === "legacy" && hasEndoStoreSentinelV0(initial) ? endoLegacySealPresenceV0(initial.sentinel.legacy) : null;
		let measured: Parameters<typeof classifyEndoLegacySnapshotV0>[2] = null;
		let observedSize: number | null = null;
		try {
			const path = endoEventStreamPathV0(root, id);
			const info = lstatSync(path, { throwIfNoEntry: false });
			if (info === undefined) {
				if (key !== "legacy" && options.only === undefined) {
					completeness = "unopenable";
					reason = "discovered attachment has no readable log";
				}
			} else {
				observedSize = info.size;
				if (!info.isFile()) throw new TypeError("event log is not a regular file");
				const remaining = options.maxBytes === undefined ? undefined : options.maxBytes - consumedBytes;
				if (remaining !== undefined && info.size > remaining) throw new EndoLogUnreadableErrorV0("EFBIG");
				consumedBytes += info.size;
				const bytes = readEndoLogBytesV0(path, info.size, true);
				if (bytes.length !== info.size) throw new EndoLogUnreadableErrorV0("EAGAIN");
				if (key === "legacy" && hasEndoStoreSentinelV0(initial)) {
					measured = {
						bytes: bytes.length,
						sha256: sha256HexV0(bytes),
						prefix:
							seal !== null && bytes.length > seal.bytes
								? sha256HexV0(bytes.subarray(0, seal.bytes))
								: undefined,
					};
				}
				const decoded = decodeEndoFrameLogV0(bytes);
				const validator = createEndoEventStoreV0();
				for (const frame of decoded.frames) events.push(validator.ingest(JSON.parse(DECODER.decode(frame))));
				recovery = endoFrameLogRecoveryV0(decoded, true, null);
				watermark = {
					length: events.length,
					lastEventId: events.at(-1)?.id ?? null,
					prefixSha256: prefixHash(events),
					bytesObserved: bytes.length,
				};
				completeness = recovery.sealed ? "sealed" : recovery.truncated ? "torn-tail" : "complete";
				reason = recovery.sealed
					? "frame checksum did not verify"
					: recovery.truncated
						? "partial frame at the end of the log"
						: null;
				evidenceLength = events.length;
			}
		} catch (error) {
			const code = error instanceof EndoLogUnreadableErrorV0 ? error.code : null;
			completeness = code === "EFBIG" && options.maxBytes !== undefined ? "budget-exhausted" : "unopenable";
			reason = code === null ? "log could not be opened and validated" : `log read: ${code}`;
			events = [];
			if (measured === null) measured = "unreadable";
		}
		if (key === "legacy" && hasEndoStoreSentinelV0(initial) && completeness !== "budget-exhausted") {
			format = classifyEndoLegacySnapshotV0(initial, paths.legacy, measured, observedSize);
			legacySealVerified = format.state !== "legacy-seal-drift";
			if (format.state === "legacy-seal-drift") {
				for (const detail of format.findings)
					localFindings.push({ code: "legacy-seal-drift", stream: "legacy", detail });
				if (completeness !== "unopenable") completeness = "incomplete-uncertain";
				reason = "legacy history does not match the seal";
				evidenceLength =
					format.findings.length === 1 &&
					format.findings[0]?.kind === "grown-append" &&
					seal !== null &&
					seal.frames <= events.length &&
					prefixHash(events, seal.frames) === seal.prefixDigest
						? seal.frames
						: 0;
			}
		}
		if (initial.state === "format-barrier-broken" || initial.state === "initialising") {
			completeness = endoWeakestStandingV0([completeness, "incomplete-uncertain"]);
			reason = initial.state;
			evidenceLength = 0;
		}
		let newestEventAtMs: number | null = null;
		let eventsDatedAfterRead = 0;
		for (const [index, event] of events.entries()) {
			const time = Date.parse(event.at);
			if (time > readAtMs) eventsDatedAfterRead += 1;
			else if (index < evidenceLength) newestEventAtMs = Math.max(newestEventAtMs ?? -Infinity, time);
		}
		streams.push({
			standing: {
				stream: id,
				key,
				completeness,
				recovery,
				watermark,
				reason,
				findings: localFindings,
				freshness: { readAtMs, newestEventAtMs, eventsDatedAfterRead },
			},
			events,
			evidenceLength,
			whole: watermark !== null,
		});
	}
	const final = inspectEndoStoreBarrierV0(root);
	const barrierChanged =
		(hasEndoStoreSentinelV0(initial) ? initial.raw : null) !== (hasEndoStoreSentinelV0(final) ? final.raw : null) ||
		initial.state === "initialising" ||
		final.state === "initialising" ||
		final.state === "format-barrier-broken" ||
		(hasEndoStoreSentinelV0(initial) &&
			hasEndoStoreSentinelV0(final) &&
			(initial.witness === "seal-mismatch") !== (final.witness === "seal-mismatch"));
	const validated = checkIntegrity(streams).map((stream) =>
		barrierChanged
			? {
					...stream,
					evidenceLength: 0,
					standing: {
						...stream.standing,
						completeness: endoWeakestStandingV0([stream.standing.completeness, "incomplete-uncertain"]),
						reason: "store format barrier changed or was unavailable during the read",
						freshness: { ...stream.standing.freshness, newestEventAtMs: null },
					},
				}
			: stream,
	);
	if (barrierChanged) {
		discoveryComplete = false;
		legacySealVerified = null;
		if (final.state === "format-barrier-broken" || initial.state !== "format-barrier-broken") format = final;
	}
	for (const stream of validated) findings.push(...stream.standing.findings);
	return {
		format: format.state,
		barrierFinding: format.state === "format-barrier-broken" ? format.finding : null,
		legacySealVerified,
		streams: validated,
		discoveryComplete,
		attachmentsTruncated: attachmentTruncated,
		budget: { maxBytes: options.maxBytes ?? null, consumedBytes },
		findings,
		aggregate: endoWeakestStandingV0([
			...validated.map(({ standing }) => standing.completeness),
			...(attachmentTruncated ? ["budget-exhausted" as const] : []),
			...(barrierChanged ||
			initial.state === "format-barrier-broken" ||
			findings.some(
				(item) => item.code === "attachment-directory-rejected" || item.code === "attachments-unavailable",
			)
				? ["unopenable" as const]
				: []),
		]),
	};
}

function checkIntegrity(streams: readonly EndoEventStreamReadV0[]): EndoEventStreamReadV0[] {
	const index = new Map<string, { stream: EndoEventStreamKeyV0; event: EndoEventV0; diagnostic: boolean }[]>();
	const legacyUnsealed = (stream: EndoEventStreamReadV0) =>
		stream.standing.key === "legacy" &&
		stream.standing.findings.some((finding) => finding.code === "legacy-seal-drift");
	const ordered = [...streams].sort((a, b) =>
		a.standing.key === b.standing.key
			? 0
			: a.standing.key === "legacy"
				? -1
				: b.standing.key === "legacy"
					? 1
					: a.standing.key < b.standing.key
						? -1
						: 1,
	);
	const rank = new Map(ordered.map(({ standing }, index) => [standing.key, index]));
	for (const stream of ordered) {
		for (const [seq, event] of stream.events.entries()) {
			const copies = index.get(event.id) ?? [];
			copies.push({
				stream: stream.standing.key,
				event,
				diagnostic: legacyUnsealed(stream) && seq >= stream.evidenceLength,
			});
			index.set(event.id, copies);
		}
	}
	return streams.map((read) => {
		const { standing, events } = read;
		const findings = [...standing.findings];
		const ids = new Set(events.map((event) => event.id));
		let unsafe = false;
		for (const [seq, event] of events.entries()) {
			const isLegacyDrift = legacyUnsealed(read) && seq >= read.evidenceLength;
			const copies = index.get(event.id) ?? [];
			for (const prior of copies) {
				if (prior.stream === standing.key) continue;
				if (!isLegacyDrift && (prior.diagnostic || rank.get(prior.stream)! > rank.get(standing.key)!)) continue;
				const conflict = canonicalEndoJsonV0(event) !== canonicalEndoJsonV0(prior.event);
				findings.push({
					code: "duplicate-event-id-across-streams",
					stream: standing.key,
					other: prior.stream,
					eventId: event.id,
					conflict,
				});
				unsafe ||= conflict && !isLegacyDrift;
			}
			for (const parentId of event.derivedFrom) {
				if (ids.has(parentId)) continue;
				for (const parent of index.get(parentId) ?? []) {
					if (parent.diagnostic) continue;
					findings.push({
						code: "cross-stream-derivation",
						stream: standing.key,
						parentStream: parent.stream,
						eventId: event.id,
						parentId,
					});
					unsafe = true;
				}
			}
			const producer = OWNED_PRODUCER.exec(event.producer)?.[1];
			if (
				standing.stream.kind === "attachment" &&
				producer !== undefined &&
				producer !== standing.stream.attachmentId
			) {
				findings.push({
					code: "foreign-producer-in-stream",
					stream: standing.key,
					eventId: event.id,
					producer: event.producer,
				});
				unsafe = true;
			}
		}
		return {
			...read,
			evidenceLength: unsafe ? 0 : read.evidenceLength,
			standing: {
				...standing,
				findings,
				completeness: unsafe
					? endoWeakestStandingV0([standing.completeness, "incomplete-uncertain"])
					: standing.completeness,
				reason: unsafe ? "integrity finding in event identity or provenance" : standing.reason,
				freshness: unsafe ? { ...standing.freshness, newestEventAtMs: null } : standing.freshness,
			},
		};
	});
}

export interface EndoEventStreamCursorV0 {
	readonly stream: EndoEventStreamKeyV0;
	readonly afterSequence: number;
	readonly prefixSha256: string | null;
}

export function pageEndoEventStreamV0(stream: EndoEventStreamReadV0, cursor?: EndoEventStreamCursorV0, limit = 1_000) {
	const { key } = stream.standing;
	const pos = cursor?.afterSequence ?? 0;
	const end = stream.evidenceLength;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0)
		throw new TypeError("invalid stream page limit");
	if (
		!Number.isSafeInteger(pos) ||
		pos < 0 ||
		pos > end ||
		(cursor !== undefined && (cursor.stream !== key || cursor.prefixSha256 !== prefixHash(stream.events, pos)))
	)
		throw new TypeError("stream cursor does not match the verified prefix");
	const afterSequence = Math.min(pos + limit, end);
	const next: EndoEventStreamCursorV0 = {
		stream: key,
		afterSequence,
		prefixSha256: prefixHash(stream.events, afterSequence),
	};
	return {
		standing: stream.standing,
		events: stream.events.slice(pos, afterSequence),
		next,
		atEnd: afterSequence === end,
	};
}

export function endoSessionLogOfStreamV0(stream: EndoEventStreamReadV0 | undefined): EndoSessionLogReadV0 {
	if (stream === undefined) return { state: "unavailable" };
	const { completeness } = stream.standing;
	if (completeness === "absent" || completeness === "unopenable" || completeness === "budget-exhausted")
		return { state: "unavailable" };
	return {
		state: completeness === "complete" ? "complete" : "partial",
		events: stream.events.slice(0, stream.evidenceLength),
	};
}

export function readEndoLegacySessionLogV0(root: string, maxBytes?: number): EndoSessionLogReadV0 {
	if (inspectEndoStoreBarrierV0(root).state !== "legacy-only") return { state: "unavailable" };
	const read = readEndoEventStoreV0(root, { only: [LEGACY], maxBytes });
	return read.format === "legacy-only" ? endoSessionLogOfStreamV0(read.streams[0]) : { state: "unavailable" };
}

export function readEndoAttachmentResumeV0(
	root: string,
	writer: EndoEventStoreWriterV0,
	belongsToAttachment: (event: EndoEventV0) => boolean,
) {
	const own: EndoEventV0[] = [];
	for (let afterSequence = 0; afterSequence < writer.store.length; ) {
		const page = writer.store.page({ afterSequence });
		own.push(...page.events.filter(belongsToAttachment));
		afterSequence = page.nextAfterSequence;
	}
	const legacy = writer.mode === "legacy" ? undefined : readEndoEventStoreV0(root, { only: [LEGACY] }).streams[0];
	return {
		legacyStanding: legacy?.standing ?? null,
		legacy: (legacy?.events.slice(0, legacy.evidenceLength) ?? []).filter(belongsToAttachment),
		legacySeenIds: (legacy?.events ?? []).filter(belongsToAttachment).map(({ id }) => id),
		own,
	};
}

export function endoRouteAttemptEvidenceV0(read: EndoEventStoreReadV0, attachment: string) {
	if (!isWellFormedKindV0(attachment)) return { ok: false, reason: "attachment-not-a-kind" } as const;
	if (read.format === "format-barrier-broken" || read.format === "initialising" || read.format === "absent")
		return { ok: false, reason: "stream-not-read" } as const;
	const key: EndoEventStreamKeyV0 = `attachment:${attachment}`;
	const streams = read.streams.filter(({ standing }) => standing.key === key || standing.key === "legacy");
	const needsLegacy = read.format === "legacy-only" || read.format === "mixed" || read.format === "legacy-seal-drift";
	if (
		(needsLegacy && !streams.some(({ standing }) => standing.key === "legacy")) ||
		(!read.discoveryComplete &&
			!streams.some(({ standing }) => standing.key === key) &&
			read.format !== "legacy-only")
	)
		return { ok: false, reason: "stream-not-read" } as const;
	return { ok: true, streams } as const;
}

export function endoSessionStreamsV0(read: EndoEventStoreReadV0, sessionId: string) {
	const found: EndoEventStreamKeyV0[] = [];
	const uncertain: EndoEventStreamKeyV0[] = [];
	for (const { standing, events, evidenceLength } of read.streams) {
		if (events.slice(0, evidenceLength).some(({ coordinates }) => coordinates.sessionId === sessionId))
			found.push(standing.key);
		if (standing.completeness !== "complete" && standing.completeness !== "absent") uncertain.push(standing.key);
	}
	return {
		sessionId,
		found,
		uncertain,
		discoveryIncomplete: !read.discoveryComplete,
		inLog:
			found.length > 0
				? "yes"
				: uncertain.length > 0 || !read.discoveryComplete || read.format === "absent"
					? "unknown"
					: "no",
	} as const;
}
