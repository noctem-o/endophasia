/**
 * Phase 12 — the durable evidence ledger (README "## Phase 12 — Operational substrate &
 * integration", work item: "storage/ durable append store"). The in-memory evidence ledger
 * of `evolution/evidence.ts` — closed record kinds, namespaces, reference integrity,
 * duplicate detection, exact 1..n sequences — over the durable frame log at
 * `root/ledger/ledger.log`, with a lazy identity file and an optional compaction snapshot.
 *
 * Files, all under `root/ledger/`:
 * - `ledger.meta.json`: `{digest, id, experiment}`, digest over the canonical form of
 *   `{id, experiment}`; written on the first append. A reopen must present the same id and
 *   experiment — a ledger belongs to exactly one experiment.
 * - `ledger.log`: one frame per appended record; the frame payload is the canonical JSON
 *   of the record itself, so open re-derives every entry by re-appending the frames to a
 *   fresh in-memory ledger — the full validation (kinds, duplicates, references,
 *   sequences) runs again on every open.
 * - `ledger.snapshot.json`: `{digest, entriesCount, ledger}`, digest over the canonical
 *   form of the whole ledger; `snapshot()` writes it atomically and then truncates the log
 *   to `entriesCount` frames (a crash between the two steps is harmless: a full log plus a
 *   valid snapshot still opens).
 *
 * Open never repairs: a torn tail is truncated away (crash recovery), but only after every
 * remaining frame, the meta file and the snapshot have validated, and recovery() reports what
 * was cut and where its bytes were preserved; a complete frame whose digest fails seals the
 * ledger (append throws, the verified prefix still materialises); a frame or file that
 * decodes but violates the ledger rules (a corrupt meta or snapshot, a duplicate id, a broken
 * reference, a snapshot/log disagreement) is a TypeError — the ledger is unopenable, not
 * repairable, and is left byte-for-byte as found.
 *
 * Opened with `{ readOnly: true }`, the ledger creates no directory, cuts nothing, and
 * refuses append and snapshot.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/evidence.ts";
import type { EndoEvidenceLedgerEntryV0, EndoEvidenceLedgerV0, EndoExperimentRecordV0 } from "../protocol/evolution.ts";
import { validateEndoExperimentRecordV0 } from "../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import { isPlainJsonObjectV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	createEndoFrameLogV0,
	type EndoDurableStoreOptionsV0,
	type EndoFrameLogRecoveryV0,
	endoFrameLogRecoveryV0,
	writeExactSyncV0,
} from "./log.ts";

/** The replay report of one durable ledger open. */
export interface EndoDurableLedgerReplayV0 {
	/** How the entries were derived on open: the snapshot alone, the log alone, both, or nothing. */
	layer: "empty" | "log" | "snapshot" | "snapshot+log";
	/** The number of entries. */
	entryCount: number;
	/** True when a snapshot took part in the open. */
	fromSnapshot: boolean;
	/** The verified entries, append order, frozen. */
	verifiedEntries: EndoEvidenceLedgerEntryV0[];
}

/** The durable evidence ledger of one experiment under one root. */
export interface EndoDurableEvidenceLedgerV0 {
	/** The experiment record the ledger belongs to. */
	readonly record: EndoExperimentRecordV0;
	/** The number of entries. */
	readonly length: number;
	/**
	 * Append one produced record with the full in-memory ledger validation. Throws when the
	 * ledger is read-only, sealed (a frame failed verification on open), dead (a failed
	 * write), or closed.
	 */
	append(record: unknown): EndoEvidenceLedgerEntryV0;
	/** Materialise the ledger (entries copied, append order). */
	ledger(): EndoEvidenceLedgerV0;
	/**
	 * Compact: write the snapshot atomically, then truncate the log to the snapshot's
	 * entries. Returns the snapshot envelope's `{digest, entriesCount}`.
	 */
	snapshot(): { digest: string; entriesCount: number };
	/** The open's replay report. */
	replay(): EndoDurableLedgerReplayV0;
	/** How open classified the log, and what it discarded. */
	recovery(): EndoFrameLogRecoveryV0;
	/** Close the ledger; every later operation throws. */
	close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function writeFileSyncAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	const fd = openSync(tmp, "w");
	try {
		writeExactSyncV0(fd, Buffer.from(content, "utf8"), tmp);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, file);
	const dirFd = openSync(file.slice(0, file.lastIndexOf("/")), "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

function readJsonFile(file: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(readFileSync(file)));
	} catch {
		throw new TypeError(`${file} does not decode as JSON; the ledger cannot be opened`);
	}
	return parsed;
}

/**
 * Create (or reopen) the durable evidence ledger under `root` for `id` and `experiment`.
 */
export function createEndoDurableEvidenceLedgerV0(
	root: string,
	id: unknown,
	experiment: unknown,
	options: EndoDurableStoreOptionsV0 = {},
): EndoDurableEvidenceLedgerV0 {
	const readOnly = options.readOnly === true;
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("ledger id must be an endo.evidence.* identifier");
	}
	const storedExperiment = validateEndoExperimentRecordV0(experiment);
	if (storedExperiment === null) throw new TypeError("not a valid endo.experiment.v0 record");

	const dir = `${root}/ledger`;
	const metaFile = `${dir}/ledger.meta.json`;
	if (!readOnly) mkdirSync(dir, { recursive: true });
	const snapshotFile = `${dir}/ledger.snapshot.json`;
	const log = createEndoFrameLogV0(`${dir}/ledger.log`, { readOnly });

	const inner = createEndoEvidenceLedgerV0(id, storedExperiment);

	let sealed = false;
	let sealedAt: number | null = null;
	let dead = false;
	let closed = false;
	let metaSeen = false;
	let snapshotSeen = false;
	let snapshotCount = 0;
	let layer: EndoDurableLedgerReplayV0["layer"] = "empty";

	// --- open: meta ---------------------------------------------------------
	if (existsSync(metaFile)) {
		metaSeen = true;
		const parsed = readJsonFile(metaFile);
		if (!isPlainJsonObjectV0(parsed)) throw new TypeError("ledger.meta.json is not a plain JSON object");
		const envelope = parsed as Record<string, unknown>;
		const rest: Record<string, unknown> = {};
		for (const key of Object.keys(envelope)) {
			if (key !== "digest") rest[key] = envelope[key];
		}
		if (typeof envelope.digest !== "string" || envelope.digest !== sha256HexV0(canonicalEndoJsonV0(rest))) {
			throw new TypeError("ledger.meta.json does not verify: the digest does not match its {id, experiment}");
		}
		if (envelope.id !== id || canonicalEndoJsonV0(envelope.experiment) !== canonicalEndoJsonV0(storedExperiment)) {
			throw new TypeError("ledger identity mismatch: the root holds a ledger for a different id or experiment");
		}
	}

	// --- open: log ----------------------------------------------------------
	const read = log.read();
	const { frames, corruptAt } = read;
	if (corruptAt !== null) {
		sealed = true;
		sealedAt = corruptAt;
	}
	const entries: EndoEvidenceLedgerEntryV0[] = [];
	for (const frame of frames) {
		let record: unknown;
		try {
			record = JSON.parse(decoder.decode(frame));
		} catch {
			throw new TypeError("ledger log frame does not decode as UTF-8 JSON; the ledger cannot be opened");
		}
		entries.push(inner.append(record));
	}

	// --- open: snapshot -----------------------------------------------------
	if (existsSync(snapshotFile)) {
		const parsed = readJsonFile(snapshotFile);
		if (!isPlainJsonObjectV0(parsed)) throw new TypeError("ledger.snapshot.json is not a plain JSON object");
		const envelope = parsed as { digest: unknown; entriesCount: unknown; ledger: unknown };
		const ledger = replayEndoEvidenceLedgerV0(envelope.ledger);
		if (typeof envelope.digest !== "string" || envelope.digest !== sha256HexV0(canonicalEndoJsonV0(ledger))) {
			throw new TypeError("ledger.snapshot.json does not verify: the digest does not match its ledger");
		}
		if (typeof envelope.entriesCount !== "number" || envelope.entriesCount !== ledger.entries.length) {
			throw new TypeError("ledger.snapshot.json entriesCount disagrees with its ledger entries");
		}
		if (ledger.id !== id || ledger.experimentId !== storedExperiment.id) {
			throw new TypeError("ledger.snapshot.json belongs to a different ledger");
		}
		if (ledger.entries.length > frames.length) {
			throw new TypeError(
				"ledger.snapshot.json covers more entries than the log holds; the ledger cannot be opened",
			);
		}
		for (let i = 0; i < ledger.entries.length; i += 1) {
			if (canonicalEndoJsonV0(ledger.entries[i]) !== canonicalEndoJsonV0(entries[i])) {
				throw new TypeError(`ledger.snapshot.json entry ${i + 1} disagrees with the log`);
			}
		}
		snapshotSeen = true;
		snapshotCount = ledger.entries.length;
	}

	if (entries.length === 0 && !snapshotSeen) layer = "empty";
	else if (snapshotSeen && frames.length === snapshotCount) layer = "snapshot";
	else if (snapshotSeen) layer = "snapshot+log";
	else layer = "log";

	// --- open: final structural pass ---------------------------------------
	replayEndoEvidenceLedgerV0({
		schemaVersion: "endo.evidence-ledger.v0",
		id,
		experimentId: storedExperiment.id,
		entries: entries.map((entry) => ({ ...entry })),
	});

	// Only now, with every remaining frame, the meta and the snapshot validated, is a torn tail cut.
	const discarded = read.truncated && !readOnly ? log.truncateTo(frames.length) : null;
	const recovery = endoFrameLogRecoveryV0(read, readOnly, discarded);

	const guard = (write: boolean): void => {
		if (closed) throw new TypeError("the durable ledger is closed");
		if (dead)
			throw new TypeError("the durable ledger is dead: a log write failed and the in-memory state outruns the log");
		if (write && readOnly) throw new TypeError("the durable ledger is open read-only");
		if (write && sealed) {
			throw new TypeError(
				`the durable ledger is sealed: frame ${sealedAt} failed verification on open; append is disabled`,
			);
		}
	};

	return {
		record: inner.record,
		get length(): number {
			guard(false);
			return inner.length;
		},
		append(record: unknown): EndoEvidenceLedgerEntryV0 {
			guard(true);
			const entry = inner.append(record);
			if (!metaSeen) {
				metaSeen = true;
				const envelope = {
					digest: sha256HexV0(canonicalEndoJsonV0({ id, experiment: storedExperiment })),
					id,
					experiment: storedExperiment,
				};
				writeFileSyncAtomic(metaFile, canonicalEndoJsonV0(envelope));
			}
			try {
				log.append(encoder.encode(canonicalEndoJsonV0(record)));
			} catch {
				dead = true;
				throw new TypeError("the durable ledger log write failed; the ledger is dead");
			}
			return entry;
		},
		ledger(): EndoEvidenceLedgerV0 {
			guard(false);
			return inner.ledger();
		},
		snapshot(): { digest: string; entriesCount: number } {
			guard(false);
			if (readOnly) throw new TypeError("the durable ledger is open read-only");
			const value = inner.ledger();
			const envelope = {
				digest: sha256HexV0(canonicalEndoJsonV0(value)),
				entriesCount: value.entries.length,
				ledger: value,
			};
			writeFileSyncAtomic(snapshotFile, canonicalEndoJsonV0(envelope));
			log.truncateTo(value.entries.length);
			return { digest: envelope.digest, entriesCount: value.entries.length };
		},
		replay(): EndoDurableLedgerReplayV0 {
			guard(false);
			return {
				layer,
				entryCount: entries.length,
				fromSnapshot: snapshotSeen,
				verifiedEntries: [...entries],
			};
		},
		recovery(): EndoFrameLogRecoveryV0 {
			guard(false);
			return JSON.parse(JSON.stringify(recovery));
		},
		close(): void {
			closed = true;
		},
	};
}
