// Builders shared by the cockpit tests: synthetic events and registry records, a seeded real store root, and a hash of a
// whole directory tree (files, directories and bytes) to prove a read changed nothing.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoCockpitRegistryRecordsV0 } from "../cockpit/projections/common.ts";
import type { EndoCockpitEventLogSourceV0 } from "../protocol/cockpit.ts";
import type { EndoEventSourceV0, EndoEventV0 } from "../protocol/event.ts";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
} from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";

export const SPECIMEN = fileURLToPath(new URL("../research/pi-conformance/1.0.0/", import.meta.url));
export const LIFECYCLE_FIXTURES = fileURLToPath(new URL("./fixtures/pi-lifecycle/fake-pi-1.0.0/", import.meta.url));

export const ATTACHMENT = "pi.default";
export const CANARY = "CANARY-9f3a-leak";

const roots: string[] = [];
export function tempRoot(prefix = "endo-cockpit-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}
export function removeTempRoots(remove: (path: string) => void): void {
	for (const dir of roots.splice(0)) remove(dir);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Every file and directory under `root`, with each file's sha256: the tree a read must leave byte-identical. */
export function treeHash(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(dir, entry.name);
			const name = relative(root, path);
			if (entry.isDirectory()) {
				lines.push(`d ${name}`);
				walk(path);
			} else {
				lines.push(
					`f ${name} ${statSync(path).size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
				);
			}
		}
	};
	walk(root);
	return lines.join("\n");
}

export function lifecycleEvents(name: string): EndoEventV0[] {
	return readFileSync(join(LIFECYCLE_FIXTURES, `${name}.events.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as EndoEventV0);
}

export function ingestAll(root: string, events: readonly unknown[]): void {
	const store = createEndoDurableEventStoreV0(root);
	for (const event of events) store.ingest(event);
	store.close();
}

/** The recorded Pi 1.0.0 specimen (a real recording, committed): fingerprint, evidence and capability state. */
export function specimen(): {
	fingerprint: EndoHarnessFingerprintV0;
	evidence: EndoCapabilityEvidenceV0[];
	state: EndoCapabilityStateV0;
} {
	return {
		fingerprint: {
			schemaVersion: "endo.harness-fingerprint.v0",
			...readJson<object>(join(SPECIMEN, "fingerprint.json")),
		} as EndoHarnessFingerprintV0,
		evidence: readJson<EndoCapabilityEvidenceV0[]>(join(SPECIMEN, "evidence.json")),
		state: readJson<EndoCapabilityStateV0>(join(SPECIMEN, "capability-state.json")),
	};
}

export function seedRegistry(root: string, attachment = ATTACHMENT): void {
	const { fingerprint, evidence, state } = specimen();
	const registry = openEndoHarnessRegistryV0(root, attachment);
	registry.append("fingerprint", fingerprint);
	for (const record of evidence) registry.append("evidence", record);
	registry.append("state", state);
}

export function specimenRecords(): EndoCockpitRegistryRecordsV0 {
	const { fingerprint, evidence, state } = specimen();
	return { fingerprint: [fingerprint], change: [], evidence, state: [state], notification: [] };
}

let counter = 0;
/** A valid event with explicit producer sequence and time, so tests can make them disagree with storage order. */
export function event(
	kind: string,
	payload: Record<string, unknown> = {},
	options: {
		id?: string;
		sequence?: number;
		at?: string;
		source?: EndoEventSourceV0;
		session?: string | null;
		producer?: string;
	} = {},
): EndoEventV0 {
	counter += 1;
	const session = options.session === undefined ? "endo.session.test.one" : options.session;
	return {
		schemaVersion: "endo.event.v0",
		id: options.id ?? `endo.event.test.${counter}`,
		kind,
		source: options.source ?? "runtime-fact",
		sequence: options.sequence ?? counter,
		at: options.at ?? "2026-10-03T12:00:00Z",
		coordinates: session === null ? {} : { sessionId: session },
		producer: options.producer ?? "test-producer",
		derivedFrom: [],
		payload: payload as EndoEventV0["payload"],
	};
}

export function stored(events: readonly EndoEventV0[], from = 1): { storageSequence: number; event: EndoEventV0 }[] {
	return events.map((item, offset) => ({ storageSequence: from + offset, event: item }));
}

/**
 * The prefix digest a reader advertises for these events, restated independently of the production helper: one line per
 * event in storage order (the hex sha256 of its canonical JSON and a newline), the sha256 of the lines, and the keyed token
 * of `{ purpose, length, chain }`. Null for no events. A fixture that models a complete read uses it, never an arbitrary token.
 */
export function modelPrefixDigest(events: readonly unknown[], key: EndoDigestKeyV0): string | null {
	if (events.length === 0) return null;
	const chain = sha256HexV0(events.map((item) => `${sha256HexV0(canonicalEndoJsonV0(item))}\n`).join(""));
	return key.digest({ purpose: "endo.cockpit.event-prefix.v0", length: events.length, chain }).value;
}

/** The source a reader reports after reading the whole of a clean log holding exactly these events (their ids are public). */
export function completeLogSource(events: readonly EndoEventV0[], key: EndoDigestKeyV0): EndoCockpitEventLogSourceV0 {
	const last = events.at(-1);
	return {
		domain: "event-log",
		condition: { state: events.length === 0 ? "empty" : "readable", tornTail: null, sealedAt: null, error: null },
		watermark: {
			length: events.length,
			lastEventId: last === undefined ? null : last.id,
			prefixDigest: modelPrefixDigest(events, key),
			keyId: key.keyId,
		},
	};
}

const FINGERPRINT_ID = "endo.evidence.test-fingerprint.1";
export function changeRecord(overrides: Partial<EndoHarnessChangeV0> = {}): EndoHarnessChangeV0 {
	const { fingerprint } = specimen();
	return {
		schemaVersion: "endo.harness-change.v0",
		id: "endo.evidence.test-change.1",
		attachment: ATTACHMENT,
		runtime: "pi",
		at: "2026-10-03T10:34:38.100Z",
		kind: "first-observation",
		previous: null,
		current: {
			fingerprintId: fingerprint.id,
			identityDigest: fingerprint.identity.digest,
			confidence: fingerprint.identity.confidence,
			version: fingerprint.reported.version,
			realPath: `/home/${CANARY}/pi`,
		},
		differences: [],
		versionOrder: "unknown",
		...overrides,
	};
}

export function notificationRecord(overrides: Partial<EndoHarnessNotificationV0> = {}): EndoHarnessNotificationV0 {
	return {
		schemaVersion: "endo.harness-notification.v0",
		id: "endo.evidence.test-notification.1",
		attachment: ATTACHMENT,
		at: "2026-10-03T10:34:38.200Z",
		kind: "runtime-first-observed",
		changeId: "endo.evidence.test-change.1",
		title: "Pi runtime observed for the first time",
		lines: [`Detected: 1.0.0 at /home/${CANARY}/pi`, "Endophasia will not install, update, downgrade or replace Pi."],
		...overrides,
	};
}
export { FINGERPRINT_ID };
