// The cockpit's read-only store adapter. Host infrastructure: node:fs, storage and protocol only. It imports no harness
// adapter and no runtime, holds no connection, and starts no watcher.
//
// It opens the durable event store and the harness registries ONLY through their `{ readOnly: true }` mode, which
// creates no directory, cuts no torn tail, and refuses every write. It never repairs, rewrites or deletes anything,
// and it reports what it found in the source's `condition`:
//
//   absent      nothing at the source's location (a missing registry is normal; it is never created by reading)
//   empty       the log exists and holds no frames
//   readable    every frame verified and validated
//   degraded    a prefix is readable and the log ends in a torn tail or at a frame that failed verification
//   unopenable  the source exists but cannot be opened: an invalid record, an unknown version, an unreadable path
//
// The stores' read-only open cannot tell an absent log from an empty one, so the adapter probes the path first. A file that
// exists but cannot be read fails the store's open (EndoLogUnreadableErrorV0) and is `unopenable`; file size is never
// taken as evidence that a read happened.
//
// A writer in another process makes a read-only reader see a torn tail while an append is in flight. That is reported as
// `degraded` with the tail's length and digest, exactly as a crash would look: the adapter cannot tell them apart and
// does not guess. A later read may find the append complete.
//
// Every read reopens the source. The durable stores validate the whole log on open, so a read costs time proportional to
// the log, whatever the page size; the page bounds what is returned, not what is checked.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
	EndoCockpitEventLogSourceV0,
	EndoCockpitRegistryKindV0,
	EndoCockpitRegistrySourceV0,
	EndoCockpitSourceConditionV0,
	EndoCockpitSourceErrorKindV0,
} from "../protocol/cockpit.ts";
import { ENDO_COCKPIT_REGISTRY_KINDS_V0, ENDO_COCKPIT_SOURCE_ERRORS_V0 } from "../protocol/cockpit.ts";
import { endoCockpitTextUnsafeV0 } from "../protocol/cockpit-fields.ts";
import { isWellFormedKindV0 } from "../protocol/identity.ts";
import { EndoSchemaVersionErrorV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0 } from "../runtime/contracts/event-store.ts";
import { createEndoDurableEventStoreV0, type EndoDurableEventStoreV0 } from "../storage/event-store.ts";
import {
	type EndoHarnessRegistryV0,
	endoHarnessRegistryDirectoryV0,
	openEndoHarnessRegistryV0,
} from "../storage/harness-registry.ts";
import { EndoLogUnreadableErrorV0 } from "../storage/log.ts";
import type { EndoCockpitRegistryInputV0, EndoCockpitRegistryRecordsV0 } from "./projections/common.ts";
import { compareCodeUnitsV0, publicIdV0 } from "./projections/common.ts";
import type { EndoCockpitStoredEventV0 } from "./projections/session-timeline.ts";

/** The default and maximum timeline page of the cockpit; the maximum is the event store's own. */
export const ENDO_COCKPIT_PAGE_DEFAULT_LIMIT_V0 = 200;
export const ENDO_COCKPIT_PAGE_MAX_LIMIT_V0 = ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0;

export interface EndoCockpitEventLogReadOptionsV0 {
	/** Return events with a storage sequence greater than this. Default 0. */
	afterSequence?: number;
	/** Maximum events returned. Default 200, maximum 10000. */
	limit?: number;
}

/** One bounded read of the event log: the source's condition and position, and the page of events. */
export interface EndoCockpitEventLogReadV0 {
	source: EndoCockpitEventLogSourceV0;
	afterSequence: number;
	events: EndoCockpitStoredEventV0[];
}

type Probe = { kind: "absent" } | { kind: "present" } | { kind: "unreadable"; error: EndoCockpitSourceErrorKindV0 };

const NO_DAMAGE = { tornTail: null, sealedAt: null, error: null } as const;

/** What is at `path`, without creating or touching it. A dangling symlink anywhere on the way is not "absent". */
function probe(path: string): Probe {
	try {
		const stats = statSync(path);
		return stats.isFile() ? { kind: "present" } : { kind: "unreadable", error: "path-not-a-file" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") return { kind: "unreadable", error: "path-unreadable" };
	}
	// Walk up to the first level that exists. A level that is there to lstat but does not resolve is a dangling symlink; the
	// path is then not absent, it is unusable, and a writer that "created" it would fail.
	for (let at = path, parent = dirname(at); ; at = parent, parent = dirname(at)) {
		try {
			lstatSync(at);
		} catch {
			if (parent === at) break;
			continue;
		}
		try {
			statSync(at);
		} catch {
			return { kind: "unreadable", error: "path-dangling-symlink" };
		}
		break;
	}
	return { kind: "absent" };
}

/**
 * The public category of an open failure. NOTHING of the failure's message is public: a store's Error message can quote an
 * identifier, a path or a record's own text (an identifier may be credential-shaped), so a condition carries one of a
 * closed set of categories and the fixed sentence that category always has (ENDO_COCKPIT_SOURCE_ERRORS_V0). The category
 * is chosen from the typed error where there is one, and otherwise from the fixed phrase the store's own code uses; a
 * failure that matches none is `invalid-store`.
 */
function categoryOf(error: unknown): EndoCockpitSourceErrorKindV0 {
	if (error instanceof EndoSchemaVersionErrorV0) return `schema-${error.kind}` as EndoCockpitSourceErrorKindV0;
	if (error instanceof EndoLogUnreadableErrorV0) return "unreadable";
	const message = error instanceof Error ? error.message : "";
	if (/^duplicate (event|record) id/.test(message)) return "duplicate-id";
	if (/sealed/.test(message)) return "sealed";
	if (/^unknown harness registry record kind/.test(message)) return "unknown-record-kind";
	if (/names another attachment|is not a \w+ record/.test(message)) return "record-misplaced";
	if (/does not decode as UTF-8 JSON|is not exactly \{ kind, record \}/.test(message)) return "malformed-frame";
	if (/^record (id|coordinates|resources) /.test(message)) return "invalid-record";
	return "invalid-store";
}

function conditionFor(kind: EndoCockpitSourceErrorKindV0): EndoCockpitSourceConditionV0 {
	return {
		state: "unopenable",
		tornTail: null,
		sealedAt: null,
		error: { kind, message: ENDO_COCKPIT_SOURCE_ERRORS_V0[kind] },
	};
}

const unopenable = (error: unknown): EndoCockpitSourceConditionV0 => conditionFor(categoryOf(error));
const unreadable = conditionFor;

function conditionOf(
	recovery: {
		truncated: boolean;
		tail: { bytes: number; sha256: string } | null;
		sealed: boolean;
		corruptAt: number | null;
	},
	records: number,
): EndoCockpitSourceConditionV0 {
	if (recovery.truncated || recovery.sealed) {
		return {
			state: "degraded",
			tornTail: recovery.tail === null ? null : { bytes: recovery.tail.bytes, sha256: recovery.tail.sha256 },
			sealedAt: recovery.corruptAt,
			error: null,
		};
	}
	return { state: records === 0 ? "empty" : "readable", ...NO_DAMAGE };
}

function checkWindow(options: EndoCockpitEventLogReadOptionsV0): { afterSequence: number; limit: number } {
	const afterSequence = options.afterSequence ?? 0;
	const limit = options.limit ?? ENDO_COCKPIT_PAGE_DEFAULT_LIMIT_V0;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
		throw new TypeError("afterSequence must be a non-negative integer");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENDO_COCKPIT_PAGE_MAX_LIMIT_V0)
		throw new TypeError(`limit must be an integer between 1 and ${ENDO_COCKPIT_PAGE_MAX_LIMIT_V0}`);
	return { afterSequence, limit };
}

/** Run `use` over the store opened read-only, closing it on every path. Null when there is no store to open. */
function withEventStore<T>(
	root: string,
	use: (store: EndoDurableEventStoreV0) => T,
):
	| { source: "absent" }
	| { source: "unopenable"; condition: EndoCockpitSourceConditionV0 }
	| { source: "open"; value: T } {
	const found = probe(`${root}/events/events.log`);
	if (found.kind === "absent") return { source: "absent" };
	if (found.kind === "unreadable") return { source: "unopenable", condition: unreadable(found.error) };
	let store: EndoDurableEventStoreV0;
	try {
		store = createEndoDurableEventStoreV0(root, { readOnly: true });
	} catch (error) {
		return { source: "unopenable", condition: unopenable(error) };
	}
	try {
		return { source: "open", value: use(store) };
	} finally {
		store.close();
	}
}

/**
 * The one digest of an event log prefix: the sha256 over one line per event, in storage order, each line the lowercase hex
 * sha256 of the event's canonical JSON (runtime/contracts/canonical-json.ts) and a newline. Every line has the same width
 * and alphabet, so the framing is unambiguous; a replaced event with the same id but another kind, coordinates, payload
 * or time changes its line. Null for no events.
 */
function frameOf(event: unknown): string {
	return `${sha256HexV0(canonicalEndoJsonV0(event))}\n`;
}

/**
 * The digest of the first `count` events and, in the same pass over the store, of the first `held` events (`held <=
 * count`; null when not asked). The hash is copied at `held`, so nothing is traversed twice.
 */
function prefixDigestsOf(
	store: EndoDurableEventStoreV0,
	count: number,
	held: number | null,
): { full: string | null; held: string | null } {
	const hash = createHash("sha256");
	let heldDigest: string | null = null;
	let seen = 0;
	while (seen < count) {
		const want = held !== null && seen < held ? held - seen : count - seen;
		const page = store.page({ afterSequence: seen, limit: Math.min(ENDO_COCKPIT_PAGE_MAX_LIMIT_V0, want) });
		if (page.events.length === 0) break;
		for (const item of page.events) hash.update(frameOf(item));
		seen += page.events.length;
		if (held !== null && held > 0 && seen === held) heldDigest = hash.copy().digest("hex");
	}
	return { full: count === 0 ? null : hash.digest("hex"), held: heldDigest };
}

function lastEventIdOf(store: EndoDurableEventStoreV0): string | null {
	const length = store.length;
	const id = length === 0 ? null : (store.page({ afterSequence: length - 1, limit: 1 }).events[0]?.id ?? null);
	return id === null ? null : publicIdV0(id);
}

/** What one open of the event log found: the public read and, when asked, the digest of the first `held` events. */
interface EventLogObservation {
	read: EndoCockpitEventLogReadV0;
	heldDigest: string | null;
}

function observeEventLog(
	root: string,
	options: EndoCockpitEventLogReadOptionsV0,
	held: number | null,
): EventLogObservation {
	const { afterSequence, limit } = checkWindow(options);
	const opened = withEventStore(root, (store) => {
		const recovery = store.recovery();
		const length = store.length;
		const page = store.page({ afterSequence, limit });
		const events = page.events.map((event, offset) => ({ storageSequence: afterSequence + offset + 1, event }));
		const digests = prefixDigestsOf(store, length, held === null ? null : Math.min(held, length));
		return {
			recovery,
			length,
			events,
			lastEventId: lastEventIdOf(store),
			prefixDigest: digests.full,
			heldDigest: digests.held,
		};
	});
	const result = (
		source: EndoCockpitEventLogSourceV0,
		events: EndoCockpitStoredEventV0[] = [],
		heldDigest: string | null = null,
	): EventLogObservation => ({ read: { source, afterSequence, events }, heldDigest });
	if (opened.source === "absent")
		return result({
			domain: "event-log",
			condition: { state: "absent", ...NO_DAMAGE },
			watermark: { length: 0, lastEventId: null, prefixDigest: null },
		});
	if (opened.source === "unopenable")
		return result({ domain: "event-log", condition: opened.condition, watermark: null });
	const { recovery, length, events, lastEventId, prefixDigest, heldDigest } = opened.value;
	return result(
		{
			domain: "event-log",
			condition: conditionOf(recovery, length),
			watermark: { length, lastEventId, prefixDigest },
		},
		events,
		heldDigest,
	);
}

/**
 * One bounded read of the event log under `root`, read-only. Throws TypeError for an invalid window; every condition of
 * the source itself is reported in the result, never thrown and never turned into an empty log.
 */
export function readEndoCockpitEventLogV0(
	root: string,
	options: EndoCockpitEventLogReadOptionsV0 = {},
): EndoCockpitEventLogReadV0 {
	return observeEventLog(root, options, null).read;
}

/** The attachments with a registry directory under `root`, in code-unit order. Reading creates nothing. */
export function listEndoCockpitAttachmentsV0(root: string): string[] {
	let names: string[];
	try {
		names = readdirSync(`${root}/harness`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => {
			// A name the text policy flags cannot be presented, so it is not listed (reading it by name is refused).
			if (!isWellFormedKindV0(name) || endoCockpitTextUnsafeV0(name)) return false;
			try {
				return statSync(`${root}/harness/${name}`).isDirectory();
			} catch {
				return false;
			}
		})
		.sort(compareCodeUnitsV0);
}

function recordsOf(registry: EndoHarnessRegistryV0): EndoCockpitRegistryRecordsV0 {
	return {
		fingerprint: registry.list("fingerprint"),
		change: registry.list("change"),
		evidence: registry.list("evidence"),
		state: registry.list("state"),
		notification: registry.list("notification"),
	};
}

function emptyCounts(): Record<EndoCockpitRegistryKindV0, number> {
	return { fingerprint: 0, change: 0, evidence: 0, state: 0, notification: 0 };
}

function registrySource(
	attachment: string,
	condition: EndoCockpitSourceConditionV0,
	records: EndoCockpitRegistryRecordsV0 | null,
): EndoCockpitRegistrySourceV0 {
	if (records === null) {
		if (condition.state === "unopenable")
			return { domain: "harness-registry", attachment, condition, watermark: null };
		const lastIds = { fingerprint: null, change: null, evidence: null, state: null, notification: null };
		return {
			domain: "harness-registry",
			attachment,
			condition,
			watermark: { counts: emptyCounts(), lastIds, contentDigest: sha256HexV0(canonicalEndoJsonV0({})) },
		};
	}
	const counts = emptyCounts();
	const lastIds: Record<EndoCockpitRegistryKindV0, string | null> = {
		fingerprint: null,
		change: null,
		evidence: null,
		state: null,
		notification: null,
	};
	const content: Record<string, unknown[]> = {};
	for (const kind of ENDO_COCKPIT_REGISTRY_KINDS_V0) {
		const list = records[kind] as readonly { id?: string }[];
		counts[kind] = list.length;
		const last = list.at(-1)?.id;
		lastIds[kind] = last === undefined ? null : publicIdV0(last);
		content[kind] = [...list];
	}
	return {
		domain: "harness-registry",
		attachment,
		condition,
		watermark: { counts, lastIds, contentDigest: sha256HexV0(canonicalEndoJsonV0(content)) },
	};
}

/**
 * Read one attachment's registry, read-only: its source (condition and watermark) and, when it could be opened, its
 * validated records. An absent registry is `absent` with no records; an existing but invalid one is `unopenable`, with
 * the reason, and is never presented as empty. The registry has no close; nothing is held after the call.
 */
export function readEndoCockpitRegistryV0(root: string, attachment: string): EndoCockpitRegistryInputV0 {
	if (!isWellFormedKindV0(attachment) || endoCockpitTextUnsafeV0(attachment))
		throw new TypeError("attachment must be a well-formed dotted kind that can be presented");
	const found = probe(`${endoHarnessRegistryDirectoryV0(root, attachment)}/records.log`);
	if (found.kind === "absent")
		return { source: registrySource(attachment, { state: "absent", ...NO_DAMAGE }, null), records: null };
	if (found.kind === "unreadable")
		return { source: registrySource(attachment, unreadable(found.error), null), records: null };
	let registry: EndoHarnessRegistryV0;
	try {
		registry = openEndoHarnessRegistryV0(root, attachment, { readOnly: true });
	} catch (error) {
		return { source: registrySource(attachment, unopenable(error), null), records: null };
	}
	const records = recordsOf(registry);
	const recovery = registry.recovery();
	const total = ENDO_COCKPIT_REGISTRY_KINDS_V0.reduce((sum, kind) => sum + records[kind].length, 0);
	return { source: registrySource(attachment, conditionOf(recovery, total), records), records };
}

/**
 * How a source compares with the position a consumer last saw.
 * - unchanged: the same condition and the same position.
 * - advanced: (event log) more events, and the first events (as many as the consumer held) are the same events, byte for
 *   byte of their canonical JSON, in the same order, so paging from `afterSequence = its old length` continues its view.
 * - changed: (registry, or an event log whose condition changed at the same length) re-read the source.
 * - diverged: (event log) the events the consumer held are no longer the first events of the log (one was replaced, even
 *   under the same id); discard its view.
 * - shrunk: (event log) fewer events than the consumer saw; discard its view.
 * - unavailable: the source cannot be opened now, or the consumer has no position to compare.
 */
export type EndoCockpitFreshnessV0 = "unchanged" | "advanced" | "changed" | "diverged" | "shrunk" | "unavailable";

/**
 * Compare a source the consumer holds with the store now, read-only. This is the supported way to learn that a fresh
 * snapshot is needed: the event log offers a prefix check over the events' complete contents (it is append-only), the
 * registry only equality (it has no cursor). The event log is opened once, so the length, the held prefix and the
 * condition are one observation. The sources are independent: this says nothing about any other.
 */
export function checkEndoCockpitSourceFreshnessV0(
	root: string,
	previous: EndoCockpitEventLogSourceV0 | EndoCockpitRegistrySourceV0,
): EndoCockpitFreshnessV0 {
	if (previous.domain === "harness-registry") {
		const now = readEndoCockpitRegistryV0(root, previous.attachment).source;
		if (now.condition.state === "unopenable") return "unavailable";
		// A consumer that holds no position (its source could not be opened) has nothing to compare: start from a fresh read.
		if (previous.watermark === null) return "unavailable";
		return canonicalEndoJsonV0({ c: now.condition, w: now.watermark }) ===
			canonicalEndoJsonV0({ c: previous.condition, w: previous.watermark })
			? "unchanged"
			: "changed";
	}
	const mark = previous.watermark;
	const { read, heldDigest } = observeEventLog(
		root,
		{ limit: 1, afterSequence: mark?.length ?? 0 },
		mark?.length ?? null,
	);
	const now = read.source;
	if (now.condition.state === "unopenable" || now.watermark === null) return "unavailable";
	if (mark === null) return "unavailable";
	if (now.watermark.length < mark.length) return "shrunk";
	// The first `mark.length` events must still be the ones the consumer saw, by their complete contents and order.
	if (mark.length > 0 && heldDigest !== mark.prefixDigest) return "diverged";
	if (now.watermark.length > mark.length) return "advanced";
	return canonicalEndoJsonV0(now.condition) === canonicalEndoJsonV0(previous.condition) ? "unchanged" : "changed";
}
