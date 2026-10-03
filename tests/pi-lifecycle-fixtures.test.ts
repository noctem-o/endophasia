// Replay of the committed lifecycle fixtures. For every recorded session:
// - the lifecycle events re-derived from its recorded facts equal the stored lifecycle events, byte for byte;
// - the overview reduced from it is identical across replays (from the parsed file, from a re-parse, and from a
//   durable store the events are loaded into) and equals the committed overview;
// - the events file is the one the provenance names (sha256).
//
// The FAKE fixtures (tests/fixtures/pi-lifecycle/fake-pi-1.0.0/, provenance kind "fake-pi") always run. They come
// from the deterministic suite's fake Pi and show only that the recorder, the fold and the reducer agree.
//
// The REAL fixture (research/pi-conformance/1.0.0/lifecycle/) is recorded by a maintainer with
// scripts/record-lifecycle-fixture.ts against their own Pi and a model they serve. Until it exists that block is
// skipped, and it is never stood in for: the block also refuses a recording made with the fake Pi.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { piLifecycleFoldV0 } from "../adapters/pi/lifecycle.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoSessionOverviewV0 } from "../protocol/session-overview.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import { PI_LIFECYCLE_SESSIONS } from "../scripts/record-lifecycle-fixture.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";

const FAKE = fileURLToPath(new URL("./fixtures/pi-lifecycle/fake-pi-1.0.0/", import.meta.url));
const REAL = fileURLToPath(new URL("../research/pi-conformance/1.0.0/lifecycle/", import.meta.url));
const FAKE_PI_DIGEST = createHash("sha256")
	.update(readFileSync(new URL("./fixtures/fake-pi/cli.mjs", import.meta.url)))
	.digest("hex");

interface ProvenanceV0 {
	kind: string;
	pi: { entrypointSha256: string | null; isDeterministicSuiteFake: boolean; version: string | null };
	model: { modelId: string; reportedByPi: string[] };
	sessions: { name: string; status: string; reason: string | null; eventsSha256: string | null }[];
}

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(directory: string, name: string) {
	const text = readFileSync(join(directory, `${name}.events.jsonl`), "utf8");
	const events = text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EndoEventV0);
	const overview = readFileSync(join(directory, `${name}.overview.json`), "utf8");
	return { text, events, overview };
}

/** The replay checks every fixture, fake or real, must pass. */
function replays(directory: string, name: string, provenance: ProvenanceV0): EndoSessionOverviewV0 {
	const { text, events, overview } = load(directory, name);
	const session = provenance.sessions.find((entry) => entry.name === name)!;
	expect(createHash("sha256").update(text).digest("hex")).toBe(session.eventsSha256);

	const stored = events.filter((event) => event.kind.startsWith("lifecycle."));
	const facts = events.filter((event) => !event.kind.startsWith("lifecycle."));
	expect(stored.length).toBeGreaterThan(0);
	expect(canonicalEndoJsonV0(piLifecycleFoldV0(facts, "pi.default").events)).toBe(canonicalEndoJsonV0(stored));

	const first = canonicalEndoJsonV0(reduceEndoSessionOverviewV0(events));
	expect(canonicalEndoJsonV0(reduceEndoSessionOverviewV0(events))).toBe(first);
	expect(canonicalEndoJsonV0(reduceEndoSessionOverviewV0(JSON.parse(JSON.stringify(events))))).toBe(first);
	const root = mkdtempSync(join(tmpdir(), "endo-lifecycle-replay-"));
	dirs.push(root);
	const store = createEndoDurableEventStoreV0(root);
	for (const event of events) store.ingest(event);
	store.close();
	const reopened = createEndoDurableEventStoreV0(root, { readOnly: true });
	const replayed = reopened.page({ limit: 10_000 }).events;
	reopened.close();
	expect(canonicalEndoJsonV0(reduceEndoSessionOverviewV0(replayed))).toBe(first);
	expect(`${first}`).toBe(overview);
	return JSON.parse(first) as EndoSessionOverviewV0;
}

describe("committed FAKE lifecycle fixtures (fake Pi: proves agreement, not Pi behaviour)", () => {
	const provenance = JSON.parse(readFileSync(join(FAKE, "provenance.json"), "utf8")) as ProvenanceV0;

	it("are labelled as the fake Pi's", () => {
		expect(provenance.kind).toBe("fake-pi");
		expect(provenance.pi.isDeterministicSuiteFake).toBe(true);
	});

	it.each(PI_LIFECYCLE_SESSIONS)("%s replays identically", (name) => {
		const overview = replays(FAKE, name, provenance);
		if (name === "completes") expect(overview.lastRun?.outcome).toBe("completed");
		if (name === "stop-mid-turn") expect(overview.lastRun).toMatchObject({ outcome: "aborted", stopRequested: true });
		if (name === "killed-and-resumed") {
			expect(overview.counts).toMatchObject({ interrupted: 1, completed: 1 });
			expect(overview.attachments.resumes).toBe(1);
		}
		expect(overview.anomalies).toEqual([]);
	});
});

const realRecorded = existsSync(join(REAL, "provenance.json"));

describe.skipIf(!realRecorded)(
	"REAL Pi lifecycle fixture (skipped until recorded: run scripts/record-lifecycle-fixture.ts against your Pi and a local model)",
	() => {
		const provenance = (
			realRecorded ? JSON.parse(readFileSync(join(REAL, "provenance.json"), "utf8")) : {}
		) as ProvenanceV0;

		it("is a real recording: a real Pi, never the deterministic suite's fake", () => {
			expect(provenance.kind).toBe("real");
			expect(provenance.pi.isDeterministicSuiteFake).toBe(false);
			expect(provenance.pi.entrypointSha256).not.toBe(FAKE_PI_DIGEST);
			// The model Pi reported answering is recorded, and it is the one asked for.
			expect(provenance.model.reportedByPi.some((model) => model.endsWith(`/${provenance.model.modelId}`))).toBe(
				true,
			);
		});

		it.each(PI_LIFECYCLE_SESSIONS)("%s replays identically, or is skipped with a stated reason", (name) => {
			const session = provenance.sessions.find((entry) => entry.name === name)!;
			if (session.status === "skipped") {
				expect(session.reason).toMatch(/\S/);
				expect(existsSync(join(REAL, `${name}.events.jsonl`))).toBe(false);
				return;
			}
			const overview = replays(REAL, name, provenance);
			if (name === "completes") expect(overview.lastRun?.outcome).toBe("completed");
			if (name === "stop-mid-turn") expect(overview.counts.stopsRequested).toBe(1);
			if (name === "killed-and-resumed") {
				expect(overview.counts.interrupted).toBeGreaterThanOrEqual(1);
				expect(overview.attachments.resumes).toBe(1);
			}
		});
	},
);
