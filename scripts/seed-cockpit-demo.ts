// Seed a demo store for the cockpit from the repository's committed recordings: the Pi lifecycle fixture events (three recorded
// sessions) and the Pi 1.0.0 conformance specimen (fingerprint, evidence and capability state) as the `pi.default` registry.
//
//   node scripts/seed-cockpit-demo.ts <empty-directory>
//   npm run cockpit -- <empty-directory>        (from a checkout)
//   endo studio <empty-directory>               (from an installed package; the directory is just a store)
//
// Nothing here is invented: every record is read from a committed file. The directory must not exist or must be empty.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoCapabilityEvidenceV0, EndoCapabilityStateV0, EndoHarnessFingerprintV0 } from "../protocol/harness.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
if (target === undefined || process.argv.length !== 3)
	throw new TypeError("usage: node scripts/seed-cockpit-demo.ts <empty-directory>");
mkdirSync(target, { recursive: true });
if (readdirSync(target).length > 0)
	throw new TypeError(`${target} is not empty; the demo is seeded into a fresh directory`);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const fixtures = join(root, "tests/fixtures/pi-lifecycle/fake-pi-1.0.0");
const specimen = join(root, "research/pi-conformance/1.0.0");

const store = createEndoDurableEventStoreV0(target);
let events = 0;
for (const name of ["completes", "killed-and-resumed", "stop-mid-turn"]) {
	for (const line of readFileSync(join(fixtures, `${name}.events.jsonl`), "utf8")
		.trim()
		.split("\n")) {
		store.ingest(JSON.parse(line));
		events += 1;
	}
}
store.close();

const registry = openEndoHarnessRegistryV0(target, "pi.default");
registry.append("fingerprint", {
	schemaVersion: "endo.harness-fingerprint.v0",
	...(readJson(join(specimen, "fingerprint.json")) as object),
} as EndoHarnessFingerprintV0);
for (const record of readJson(join(specimen, "evidence.json")) as EndoCapabilityEvidenceV0[])
	registry.append("evidence", record);
registry.append("state", readJson(join(specimen, "capability-state.json")) as EndoCapabilityStateV0);
process.stdout.write(`seeded ${events} recorded events and the pi.default registry into ${target}\n`);
