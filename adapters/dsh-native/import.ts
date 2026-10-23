// The DSH native cold importer: a persisted DeepSeek Harness Session (format 4) in, endo.event.v0 events in the Endophasia store out.
//
// READ-ONLY toward DSH, by construction. The file layer uses `readdirSync` and `readFileSync` and nothing else: no write handle, no
// lock (`session.lock` is never opened), no repair (a torn tail is reported and left), no resume and no process. Every session is
// treated as possibly open: DSH has no reliable "closed" signal (its lock file outlives the lock, and an end marker is documented as
// not a liveness signal), so a log is read once, as a snapshot, up to its last complete frame.
//
// IDEMPOTENT and APPEND-ONLY toward the store. Event ids are deterministic functions of (session id, seq). A re-import finds each
// event by id and VERIFIES it before anything is appended: the keyed digest of every previously imported source row must match the
// row now in the log. A changed historical row, a log that is shorter than what was imported, or a different digest key are reported
// and NOTHING is appended; nothing is ever replaced. An extended log appends only the rows beyond what is stored. An import that
// stopped part-way resumes: each missing event is appended by its id.
//
// A forked child is imported from its fork cut on (the last TAGGED `session/end-seed`, which must agree with the header); the
// inherited prefix is not copied, and the parent is a reference (`parentSession`, a coordinate).

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { EndoEventRecordPageQueryV0, EndoEventRecordPageV0 } from "../../protocol/event-record.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { foldDshLifecycleV0, INITIAL_DSH_LIFECYCLE_STATE_V0 } from "./lifecycle.ts";
import { checkDshLog, type DshFinding, type DshSessionHeader, type DshTail, readDshLog } from "./log.ts";
import {
	DSH_NATIVE_CHECKPOINT_PRODUCER_V0,
	DSH_NATIVE_LIFECYCLE_PRODUCER_V0,
	DSH_NATIVE_MAPPING_VERSION_V0,
	DSH_NATIVE_RECORDING_PRODUCER_V0,
	dshCheckpointEventIdV0,
	dshEndoSessionIdV0,
	dshEvent,
	dshHeaderEventIdV0,
	dshLifecycleEventIdV0,
	dshRecordedEventIdV0,
	isRecord,
	recordDshHeader,
	recordDshRow,
} from "./mapping.ts";
import { DSH_NATIVE_FORMAT_VERSION_V0, DSH_NATIVE_KNOWN_EVENT_TYPES_V0 } from "./vocabulary.ts";

/** The part of the durable event store the importer needs. */
export interface DshImportStoreV0 {
	ingest(value: unknown): EndoEventV0;
	page(query?: EndoEventRecordPageQueryV0): EndoEventRecordPageV0;
}

export interface DshImportOptionsV0 {
	/** The comparison-domain key every digest is made under. Never created or loaded here. */
	digestKey: EndoDigestKeyV0;
	/** The import clock, ISO-8601 UTC. Injected so imports are deterministic in tests. */
	now(): string;
	/**
	 * A PUBLIC digest key (a committed fixture key) gives its digests no secrecy: anyone can confirm a guessed prompt or argument against
	 * them. It is refused unless this is set, which only fixtures and tests do.
	 */
	allowPublicKey?: boolean;
}

export type DshRefusalCodeV0 =
	| "unreadable"
	| "no-header"
	| "no-events"
	| "unsupported-format"
	| "invalid-log"
	| "history-changed"
	| "source-shorter"
	| "digest-domain-differs"
	| "mapping-changed";

export interface DshRefusalV0 {
	code: DshRefusalCodeV0;
	detail: string;
	/** For history-changed: the DSH seq values whose recorded digest no longer matches. */
	dshSeqs?: number[];
}

export interface DshImportReportV0 {
	/** `imported`: new events were appended; `unchanged`: everything was already stored and verified; `refused`: nothing was appended. */
	status: "imported" | "unchanged" | "refused";
	session: string | null;
	/** Source rows this import considered (from the fork cut, to the last complete row). */
	sourceRows: number;
	appended: { header: number; recorded: number; lifecycle: number; checkpoint: number };
	alreadyStored: number;
	/** What the end of the bytes looked like. A torn tail is reported, never repaired. */
	tail: DshTail;
	/** The reader's structural findings that did not refuse the import (open turns, DSH-written closers...). */
	findings: DshFinding[];
	refusals: DshRefusalV0[];
}

const refused = (refusals: DshRefusalV0[], partial: Partial<DshImportReportV0> = {}): DshImportReportV0 => ({
	status: "refused",
	session: null,
	sourceRows: 0,
	appended: { header: 0, recorded: 0, lifecycle: 0, checkpoint: 0 },
	alreadyStored: 0,
	tail: { kind: "clean" },
	findings: [],
	refusals,
	...partial,
});

/** Every stored event of one session by this adapter, in store order. */
function storedEvents(store: DshImportStoreV0, session: string): EndoEventV0[] {
	const out: EndoEventV0[] = [];
	let after = 0;
	for (;;) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		for (const event of page.events) {
			if (
				event.coordinates.sessionId === session &&
				(event.producer === DSH_NATIVE_RECORDING_PRODUCER_V0 ||
					event.producer === DSH_NATIVE_LIFECYCLE_PRODUCER_V0 ||
					event.producer === DSH_NATIVE_CHECKPOINT_PRODUCER_V0)
			)
				out.push(event);
		}
		if (page.events.length === 0 || page.nextAfterSequence === after) break;
		after = page.nextAfterSequence;
	}
	return out;
}

const digestOf = (payload: JsonValueV0, field: string): { keyId: string; value: string } | null => {
	if (!isRecord(payload)) return null;
	const found = payload[field];
	return isRecord(found) && typeof found.keyId === "string" && typeof found.value === "string"
		? { keyId: found.keyId, value: found.value }
		: null;
};

const HEADER_REQUIRED = ["type", "version", "id", "createdAt", "isSeeded", "delegationDepth"] as const;
const HEADER_KEYS = new Set<string>([...HEADER_REQUIRED, "cwd", "parentSession", "origin", "agentPreset"]);
const headerCount = (value: unknown): boolean =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

/** The pinned physical format.ts header guard, plus the importer's nonempty identity requirement. */
function validHeader(value: unknown): value is DshSessionHeader {
	if (!isRecord(value)) return false;
	return (
		HEADER_REQUIRED.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => HEADER_KEYS.has(key)) &&
		value.type === "session" &&
		value.version === DSH_NATIVE_FORMAT_VERSION_V0 &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		headerCount(value.createdAt) &&
		headerCount(value.delegationDepth) &&
		typeof value.isSeeded === "boolean" &&
		(value.cwd === undefined || (typeof value.cwd === "string" && isAbsolute(value.cwd))) &&
		(value.parentSession === undefined || typeof value.parentSession === "string") &&
		(value.origin === undefined || value.origin === "subagent") &&
		(value.agentPreset === undefined || typeof value.agentPreset === "string")
	);
}

/** Import the bytes of one persisted DSH Session log. See the module comment for the guarantees. */
export function importDshSessionBytesV0(
	bytes: Uint8Array,
	store: DshImportStoreV0,
	options: DshImportOptionsV0,
): DshImportReportV0 {
	if ((options.digestKey as { public?: boolean }).public === true && options.allowPublicKey !== true)
		throw new TypeError(
			"a public digest key gives its digests no secrecy; refusing to import a real session under it",
		);
	const read = readDshLog(bytes);
	if (read.header === null) {
		const code: DshRefusalCodeV0 = read.tail.kind === "unreadable" ? "unreadable" : "no-header";
		return refused(
			[
				{
					code,
					detail:
						read.problems[0] ??
						(read.tail.kind === "unreadable" ? read.tail.reason : "the log has no readable session header"),
				},
			],
			{ tail: read.tail },
		);
	}
	if (read.header.version !== DSH_NATIVE_FORMAT_VERSION_V0)
		return refused(
			[
				{
					code: "unsupported-format",
					detail: `header version ${String(read.header.version)}; this importer reads format ${DSH_NATIVE_FORMAT_VERSION_V0}`,
				},
			],
			{ tail: read.tail },
		);
	// Validate before the structural checker or mapping can interpret truthy/ill-shaped metadata.
	if (!validHeader(read.header))
		return refused([{ code: "invalid-log", detail: "the session header does not match the pinned format-4 shape" }], {
			tail: read.tail,
		});
	const check = checkDshLog(read, { knownEventTypes: DSH_NATIVE_KNOWN_EVENT_TYPES_V0 });
	const errors = check.findings.filter((finding) => finding.severity === "error");
	if (read.tail.kind === "unreadable" || errors.length > 0)
		return refused(
			(errors.length > 0 ? errors : [{ code: "unreadable", detail: "the log could not be read" }]).map(
				(finding) => ({ code: "invalid-log" as const, detail: `${finding.code}: ${finding.detail}` }),
			),
			{ tail: read.tail, findings: check.findings },
		);
	const header = read.header;
	const dshSessionId = header.id;
	const session = dshEndoSessionIdV0(dshSessionId);
	const cut = header.isSeeded === true ? (check.summary.inheritedCut ?? 0) : 0;
	const rows = read.events.slice(cut);
	if (rows.length === 0)
		return refused([{ code: "no-events", detail: "the log holds no events of its own to import" }], {
			session,
			tail: read.tail,
			findings: check.findings,
		});

	const key = options.digestKey;
	const stored = storedEvents(store, session);
	const ids = new Set(stored.map((event) => event.id));
	const bySeq = new Map<number, EndoEventV0>();
	for (const event of stored) {
		if (event.producer !== DSH_NATIVE_RECORDING_PRODUCER_V0 || !isRecord(event.payload)) continue;
		const source = event.payload.source;
		if (isRecord(source) && typeof source.dshSeq === "number") bySeq.set(source.dshSeq, event);
	}

	// Verify what was imported before, row by row, against the log as it is now. Nothing is appended unless all of it matches.
	const headerPayload = recordDshHeader(header, cut, key);
	const refusals: DshRefusalV0[] = [];
	const changed: number[] = [];
	const lastSeq = rows[rows.length - 1]!.seq;
	let foreignDomain = false;
	let headerChanged = false;
	const differs = (
		storedPayload: JsonValueV0,
		fresh: JsonValueV0,
		field: string,
	): "same" | "changed" | "foreign-key" => {
		const was = digestOf(storedPayload, field);
		const now = digestOf(fresh, field);
		if (was === null || now === null) return "changed";
		if (was.keyId !== now.keyId) return "foreign-key";
		return was.value === now.value ? "same" : "changed";
	};
	const headerEvent = stored.find((event) => event.id === dshHeaderEventIdV0(dshSessionId));
	if (headerEvent !== undefined) {
		const was = isRecord(headerEvent.payload) ? headerEvent.payload.mapping : undefined;
		if (was !== DSH_NATIVE_MAPPING_VERSION_V0)
			refusals.push({
				code: "mapping-changed",
				detail: `this session was imported under mapping ${String(was)}; this build maps with ${DSH_NATIVE_MAPPING_VERSION_V0}`,
			});
		const verdict = differs(headerEvent.payload, headerPayload, "headerDigest");
		if (verdict === "foreign-key") foreignDomain = true;
		else if (verdict === "changed") headerChanged = true;
		// The cut is derived from the rows, not the header digest. Verify it even after a header-only interrupted import.
		if (!isRecord(headerEvent.payload) || headerEvent.payload.inheritedCut !== headerPayload.inheritedCut)
			headerChanged = true;
	}
	const freshRecords = new Map(rows.map((row) => [row.seq, recordDshRow(row, key)] as const));
	for (const [seq, event] of bySeq) {
		const fresh = freshRecords.get(seq);
		if (fresh === undefined) {
			refusals.push({
				code: "source-shorter",
				detail: `row ${seq} was imported before but the log now ends at ${lastSeq}`,
			});
			continue;
		}
		const verdict = differs(event.payload, fresh.payload, "rowDigest");
		if (verdict === "foreign-key") foreignDomain = true;
		else if (verdict === "changed") changed.push(seq);
	}
	if (foreignDomain)
		refusals.push({
			code: "digest-domain-differs",
			detail: "previously imported rows were digested under another key; they cannot be verified under this one",
		});
	if (changed.length > 0 || headerChanged)
		refusals.push({
			code: "history-changed",
			detail: headerChanged
				? "the session header or inherited cut no longer matches what was imported"
				: "rows imported before no longer match the log",
			dshSeqs: changed.sort((x, y) => x - y),
		});
	if (refusals.length > 0)
		return refused(refusals, {
			session,
			sourceRows: rows.length,
			tail: read.tail,
			findings: check.findings,
			alreadyStored: stored.length,
		});

	// Append what is missing: the header event, then each row's recorded event and the lifecycle events derived from it.
	const appended = { header: 0, recorded: 0, lifecycle: 0, checkpoint: 0 };
	let alreadyStored = 0;
	const put = (event: EndoEventV0): void => {
		if (ids.has(event.id)) {
			alreadyStored += 1;
			return;
		}
		store.ingest(event);
		ids.add(event.id);
	};
	const at = options.now();
	const before = ids.size;
	if (!ids.has(dshHeaderEventIdV0(dshSessionId))) {
		put(
			dshEvent({
				id: dshHeaderEventIdV0(dshSessionId),
				kind: "dsh.session-imported",
				source: "runtime-fact",
				sequence: 0,
				at,
				session,
				producer: DSH_NATIVE_RECORDING_PRODUCER_V0,
				derivedFrom: [],
				payload: headerPayload,
			}),
		);
		appended.header += 1;
	} else alreadyStored += 1;
	let lifecycle = INITIAL_DSH_LIFECYCLE_STATE_V0;
	for (const [position, row] of rows.entries()) {
		const recorded = freshRecords.get(row.seq)!;
		const recordedId = dshRecordedEventIdV0(dshSessionId, row.seq);
		const had = ids.has(recordedId);
		put(
			dshEvent({
				id: recordedId,
				kind: recorded.kind,
				source: "runtime-fact",
				sequence: row.seq + 1,
				at,
				session,
				producer: DSH_NATIVE_RECORDING_PRODUCER_V0,
				derivedFrom: [],
				payload: recorded.payload,
			}),
		);
		if (!had) appended.recorded += 1;
		const folded = foldDshLifecycleV0(lifecycle, row, recorded, dshSessionId, rows[position + 1]);
		const firstSequence = lifecycle.emitted + 1;
		for (const [index, out] of folded.events.entries()) {
			const lifecycleId = dshLifecycleEventIdV0(recordedId, out.kind, index);
			const lifecycleHad = ids.has(lifecycleId);
			put(
				dshEvent({
					id: lifecycleId,
					kind: out.kind,
					source: "interpretation",
					sequence: firstSequence + index,
					at,
					session,
					producer: DSH_NATIVE_LIFECYCLE_PRODUCER_V0,
					derivedFrom: [recordedId],
					payload: out.payload,
				}),
			);
			if (!lifecycleHad) appended.lifecycle += 1;
		}
		lifecycle = folded.state;
	}
	// A checkpoint says how far this import's evidence reaches and in what state the end of the log was: "evidence up to DSH seq N,
	// tail torn". Its id covers everything that defines the import, so an unchanged re-import appends none and an extension one.
	const checkpointId = dshCheckpointEventIdV0(
		dshSessionId,
		lastSeq,
		read.tail.kind,
		key.keyId,
		DSH_NATIVE_MAPPING_VERSION_V0,
	);
	if (!ids.has(checkpointId)) {
		const existing = stored.filter((event) => event.producer === DSH_NATIVE_CHECKPOINT_PRODUCER_V0).length;
		put(
			dshEvent({
				id: checkpointId,
				kind: "dsh.import-checkpoint",
				source: "interpretation",
				sequence: existing + 1,
				at,
				session,
				producer: DSH_NATIVE_CHECKPOINT_PRODUCER_V0,
				derivedFrom: [dshRecordedEventIdV0(dshSessionId, lastSeq)],
				payload: {
					highWaterDshSeq: lastSeq,
					firstDshSeq: rows[0]!.seq,
					rows: rows.length,
					tail: read.tail.kind,
					mapping: DSH_NATIVE_MAPPING_VERSION_V0,
					keyId: key.keyId,
					formatVersion: header.version,
				},
			}),
		);
		appended.checkpoint += 1;
	} else alreadyStored += 1;
	return {
		status: ids.size > before ? "imported" : "unchanged",
		session,
		sourceRows: rows.length,
		appended,
		alreadyStored,
		tail: read.tail,
		findings: check.findings.filter((finding) => finding.severity !== "error"),
		refusals: [],
	};
}

/** The Session format generations a DSH session directory may hold, by file name. */
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

export interface DshSessionFileV0 {
	path: string;
	generation: number;
	compressed: boolean;
}

/**
 * Find the log of one DSH session directory (`<root>/--<cwd>--/<encoded-id>/`): the numerically highest generation present.
 * Read-only: it lists the directory and never opens the lock file. Throws when there is no log, or when two files share the highest
 * generation (which DSH does not write).
 */
export function findDshSessionFileV0(sessionDirectory: string): DshSessionFileV0 {
	const found: DshSessionFileV0[] = [];
	for (const name of readdirSync(sessionDirectory)) {
		const match = SESSION_FILE.exec(name);
		if (match !== null)
			found.push({
				path: join(sessionDirectory, name),
				generation: match[1] === undefined ? 0 : Number(match[1]),
				compressed: match[2] !== undefined,
			});
	}
	if (found.length === 0) throw new TypeError("the directory holds no DSH session log");
	const top = Math.max(...found.map((file) => file.generation));
	const best = found.filter((file) => file.generation === top);
	if (best.length !== 1)
		throw new TypeError(`the directory holds ${best.length} logs of the highest generation ${top}`);
	return best[0]!;
}

/** Read one session directory's newest log and import it. A generation other than the supported one is refused, not guessed. */
export function importDshSessionDirectoryV0(
	sessionDirectory: string,
	store: DshImportStoreV0,
	options: DshImportOptionsV0,
): DshImportReportV0 {
	const file = findDshSessionFileV0(sessionDirectory);
	if (file.generation !== DSH_NATIVE_FORMAT_VERSION_V0)
		return refused([
			{
				code: "unsupported-format",
				detail: `the newest log is generation ${file.generation}; this importer reads ${DSH_NATIVE_FORMAT_VERSION_V0}`,
			},
		]);
	return importDshSessionBytesV0(readFileSync(file.path), store, options);
}
