/**
 * The durable harness registry: per configured attachment, the append-only history of runtime fingerprints, the
 * changes between them, capability evidence, capability states and operator notifications (protocol/harness.ts).
 *
 * One frame log per attachment at `root/harness/<attachment>/records.log`; each frame is the canonical JSON of
 * `{ kind, record }` with the record validated by its protocol validator on the way in and again on open. Open
 * behaviour matches the durable event store: a torn tail is truncated away and reported; a frame that fails its
 * digest seals the registry read-only; a frame that decodes but fails validation makes the registry unopenable (it is
 * never repaired, and nothing is truncated before every frame has validated). recovery() reports what a truncation cut
 * and where its bytes were preserved. Opened with `{ readOnly: true }`, the registry creates no directory, cuts
 * nothing, and refuses append. Nothing here interprets a runtime: the registry stores what the attachment service
 * decided.
 *
 * Host infrastructure: node:fs and protocol only. It imports no adapter and no runtime.
 */

import { mkdirSync } from "node:fs";
import {
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateV0,
	type EndoHarnessChangeV0,
	type EndoHarnessFingerprintV0,
	type EndoHarnessNotificationV0,
	validateEndoCapabilityEvidenceV0,
	validateEndoCapabilityStateV0,
	validateEndoHarnessChangeV0,
	validateEndoHarnessFingerprintV0,
	validateEndoHarnessNotificationV0,
} from "../protocol/harness.ts";
import { isWellFormedKindV0 } from "../protocol/identity.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	createEndoFrameLogV0,
	type EndoDurableStoreOptionsV0,
	type EndoFrameLogRecoveryV0,
	endoFrameLogRecoveryV0,
} from "./log.ts";

/** The record kinds the registry holds, each with its protocol validator. */
const VALIDATORS = {
	fingerprint: validateEndoHarnessFingerprintV0,
	change: validateEndoHarnessChangeV0,
	evidence: validateEndoCapabilityEvidenceV0,
	state: validateEndoCapabilityStateV0,
	notification: validateEndoHarnessNotificationV0,
} as const;

export type EndoHarnessRegistryKindV0 = keyof typeof VALIDATORS;

export interface EndoHarnessRegistryRecordsV0 {
	fingerprint: EndoHarnessFingerprintV0;
	change: EndoHarnessChangeV0;
	evidence: EndoCapabilityEvidenceV0;
	state: EndoCapabilityStateV0;
	notification: EndoHarnessNotificationV0;
}

export type EndoHarnessRegistryRecoveryV0 = EndoFrameLogRecoveryV0;

export interface EndoHarnessRegistryV0 {
	readonly attachment: string;
	/**
	 * Append one validated record. Throws TypeError when invalid, when it names another attachment, when sealed, or when
	 * the registry is open read-only.
	 */
	append<K extends EndoHarnessRegistryKindV0>(kind: K, record: EndoHarnessRegistryRecordsV0[K]): void;
	/** Every record of one kind, in append order. */
	list<K extends EndoHarnessRegistryKindV0>(kind: K): EndoHarnessRegistryRecordsV0[K][];
	/** The last record of one kind, or null. */
	last<K extends EndoHarnessRegistryKindV0>(kind: K): EndoHarnessRegistryRecordsV0[K] | null;
	/** Whether a record with this id is already stored (any kind). */
	has(id: string): boolean;
	recovery(): EndoHarnessRegistryRecoveryV0;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The attachment name is a dotted kind, so it is also a safe single path segment. */
export function endoHarnessRegistryDirectoryV0(root: string, attachment: string): string {
	if (!isWellFormedKindV0(attachment)) throw new TypeError("attachment must be a well-formed dotted kind");
	return `${root}/harness/${attachment}`;
}

/** Open (or create) the registry of one attachment under `root`. */
export function openEndoHarnessRegistryV0(
	root: string,
	attachment: string,
	options: EndoDurableStoreOptionsV0 = {},
): EndoHarnessRegistryV0 {
	const readOnly = options.readOnly === true;
	const directory = endoHarnessRegistryDirectoryV0(root, attachment);
	if (!readOnly) mkdirSync(directory, { recursive: true });
	const log = createEndoFrameLogV0(`${directory}/records.log`, { readOnly });
	const read = log.read();
	const { frames } = read;

	const records: { kind: EndoHarnessRegistryKindV0; record: { id?: string } }[] = [];
	const ids = new Set<string>();

	const admit = (kind: unknown, record: unknown): { kind: EndoHarnessRegistryKindV0; record: { id?: string } } => {
		if (typeof kind !== "string" || !Object.hasOwn(VALIDATORS, kind)) {
			throw new TypeError("unknown harness registry record kind");
		}
		const validated = VALIDATORS[kind as EndoHarnessRegistryKindV0](record) as { attachment?: string; id?: string };
		if (validated === null) throw new TypeError(`not a valid ${kind} record`);
		if (validated.attachment !== attachment) throw new TypeError(`the ${kind} record names another attachment`);
		if (validated.id !== undefined && ids.has(validated.id))
			throw new TypeError(`duplicate record id ${validated.id}`);
		return { kind: kind as EndoHarnessRegistryKindV0, record: validated };
	};

	for (const frame of frames) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(decoder.decode(frame));
		} catch {
			throw new TypeError("a harness registry frame does not decode as UTF-8 JSON; the registry cannot be opened");
		}
		const { kind, record } = (parsed ?? {}) as { kind?: unknown; record?: unknown };
		const entry = admit(kind, record);
		records.push(entry);
		if (entry.record.id !== undefined) ids.add(entry.record.id);
	}

	// Only now, with every remaining frame validated, is a torn tail cut.
	const discarded = read.truncated && !readOnly ? log.truncateTo(frames.length) : null;
	const recovery = endoFrameLogRecoveryV0(read, readOnly, discarded);

	return {
		attachment,
		append(kind, record) {
			if (readOnly) throw new TypeError("the harness registry is open read-only");
			if (recovery.sealed) {
				throw new TypeError(`the harness registry is sealed: frame ${recovery.corruptAt} failed verification`);
			}
			const entry = admit(kind, record);
			// Stored as a plain JSON copy: later changes to the caller's object never reach the registry.
			const copy = JSON.parse(canonicalEndoJsonV0(entry.record)) as { id?: string };
			log.append(new TextEncoder().encode(canonicalEndoJsonV0({ kind, record: copy })));
			records.push({ kind, record: copy });
			if (copy.id !== undefined) ids.add(copy.id);
		},
		list(kind) {
			return records.filter((entry) => entry.kind === kind).map((entry) => JSON.parse(JSON.stringify(entry.record)));
		},
		last(kind) {
			for (let index = records.length - 1; index >= 0; index -= 1) {
				const entry = records[index]!;
				if (entry.kind === kind) return JSON.parse(JSON.stringify(entry.record));
			}
			return null;
		},
		has(id) {
			return ids.has(id);
		},
		recovery() {
			return JSON.parse(JSON.stringify(recovery));
		},
	};
}
