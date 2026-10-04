/**
 * Real cassette replay, opt-in: ENDO_PI_EXECUTABLE=/path/to/an/installed/pi (the Pi the fixtures were recorded with:
 * research/pi-conformance/1.0.1/cassettes/, Pi 1.0.1).
 *
 * Replays each committed cassette fixture against that Pi, once per timing mode, and expects lifecycle, tools and
 * outcome EXACT with no cassette miss. No model is called: the cassette serves the recorded responses, and a request it
 * does not hold fails explicitly. A negative control alters the restored workspace before Pi starts and expects the
 * replay to see it. Each replay restores the recorded scratch root at its recorded path under the system temp
 * directory and binds the recorded port on 127.0.0.1, then removes the scratch root. The operator's Pi configuration
 * and sessions are never read or written.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { materializePiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import { type PiCassetteReplayOptionsV0, replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { endoFixtureDigestKeyPathV0 } from "../storage/digest-key.ts";

const executable = process.env.ENDO_PI_EXECUTABLE;
const CASSETTES = fileURLToPath(new URL("../research/pi-conformance/1.0.1/cassettes/", import.meta.url));
const SESSIONS = ["completes", "stop-mid-turn", "killed-and-resumed", "tool-use"];

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function replayFixture(
	name: string,
	timing: "as-recorded" | "immediate",
	extra: Partial<PiCassetteReplayOptionsV0> = {},
) {
	const scratch = mkdtempSync(join(tmpdir(), "endo-real-replay-"));
	dirs.push(scratch);
	const store = materializePiCassetteFixtureV0(join(CASSETTES, name), join(scratch, "recorded"));
	const out = join(scratch, "replayed");
	const report = await replayPiCassetteSessionV0({
		store,
		out,
		pi: executable!,
		timing,
		keySource: { kind: "fixture", path: endoFixtureDigestKeyPathV0() },
		timeoutMs: 300_000,
		...extra,
	});
	return { report, out };
}

describe.runIf(executable !== undefined && executable.length > 0)("real Pi cassette replay (opt-in)", () => {
	for (const name of SESSIONS) {
		for (const timing of ["as-recorded", "immediate"] as const) {
			it(`${name}, ${timing}: lifecycle, tools and outcome reproduce exactly, with no cassette miss`, async () => {
				const { report } = await replayFixture(name, timing);
				expect(report.misses).toBe(0);
				expect(report.unserved).toBe(0);
				for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
					expect(report.comparison.layers[layer], layer).toMatchObject({ status: "EXACT" });
				expect(report.comparison.flags).toEqual([]);
			}, 600_000);
		}
	}

	it("negative control: tool-use with notes.txt altered before Pi starts diverges at the read's result digest, then misses", async () => {
		const { report, out } = await replayFixture("tool-use", "immediate", {
			alterScratch: {
				describe: "work/notes.txt replaced with different synthetic content",
				apply: (root) => writeFileSync(join(root, "work", "notes.txt"), "status: altered\n"),
			},
			holdMs: 5_000,
		});
		// The model's first response (the read call) is served; Pi's read returns other content: the first result
		// diverges, the read call itself does not, and the calls stay identical up to that input.
		expect(report.comparison.layers.toolResults).toMatchObject({ status: "DIVERGED", index: 0 });
		expect(report.comparison.layers.toolCalls).toMatchObject({ status: "DIVERGED", index: 1 });
		expect(report.comparison.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput).toBe(true);
		expect(report.environmentDivergedAt).toBe(2);
		// The next request carries that content, so it is not the recorded one: an explicit miss, never improvised.
		const misses = readEndoCaptureEventsV0(out).filter((event) => event.kind === "capture.cassette-miss");
		expect(misses[0]!.payload).toMatchObject({ reason: "unexpected-request", exchange: 2 });
		expect(report.served).toBe(1);
	}, 600_000);
});
