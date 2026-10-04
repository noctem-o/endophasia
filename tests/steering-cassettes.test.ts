// The committed steering study cassettes (research/steering/1.0.1/cassettes/): the secret scan, the hard gate for
// committed captures, passes over the directory exactly as committed; every cassette materializes into a store and loads
// as a cassette in the fixture domain; a steered cassette carries its intervention chain, driver steps and capability
// evidence. With ENDO_PI_EXECUTABLE set to an installed Pi 1.0.1, each steered cassette is replayed 5 times and each
// baseline once, expecting EXACT with no cassette miss and the intervention re-issued at its recorded point.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { materializePiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import { piCassetteScriptV0, replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";

const DIR = fileURLToPath(new URL("../research/steering/1.0.1/cassettes/", import.meta.url));
const SCRATCH = "/tmp/endo-experiment-372c52355fe7";
const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const executable = process.env.ENDO_PI_EXECUTABLE;
const cassettes = readdirSync(DIR)
	.filter((name) => statSync(join(DIR, name)).isDirectory())
	.sort();
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const materialize = (name: string) => {
	const scratch = mkdtempSync(join(tmpdir(), "endo-steering-cassette-"));
	dirs.push(scratch);
	return { scratch, store: materializePiCassetteFixtureV0(join(DIR, name), join(scratch, "store")) };
};

describe("the committed steering study cassettes", () => {
	it("are one per task per arm, as selection.json records", () => {
		const expected = ["implement-function", "tool-use"].flatMap((task) =>
			["base", "queue", "steer"].map((arm) => `${task}--${arm}`),
		);
		expect(cassettes).toEqual(expected);
		const selection = JSON.parse(readFileSync(join(DIR, "selection.json"), "utf8")) as { picks: object };
		expect(Object.keys(selection.picks).sort()).toEqual(expected);
	});

	it("pass the secret scan exactly as committed (absolute paths: only the scratch root and Pi's install path)", () => {
		const scan = endoSecretScanDirectoryV0(DIR, [SCRATCH, PI]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
		expect(scan.allowedPaths[SCRATCH]).toBeGreaterThan(0);
	});

	it.each(cassettes)("%s materializes and loads in the fixture domain; its steps match its arm", (name) => {
		const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
		const { store } = materialize(name);
		const cassette = loadEndoCassetteV0(store, key);
		expect(cassette.keyId).toBe("fixture-public");
		expect(cassette.exchanges.length).toBeGreaterThan(0);
		expect(
			cassette.exchanges.every(
				(exchange) => exchange.truncated === null && exchange.response?.outcome === "complete",
			),
		).toBe(true);
		const script = piCassetteScriptV0(cassette.events);
		const steered = !name.endsWith("--base");
		expect(script.driverVersion).toBe(steered ? "pi-cassette-driver.2" : "pi-cassette-driver.1");
		const intervene = script.steps.find((step) => step.op === "intervene");
		if (steered)
			expect(intervene).toMatchObject({
				operation: name.endsWith("--steer") ? "steer" : "queue",
				at: { exchange: 2 },
				result: "accepted",
			});
		else expect(intervene).toBeUndefined();
		expect(script.environment).toMatchObject({
			variables: { TZ: "UTC", LC_ALL: "C" },
			fileTime: "2026-01-01T00:00:00Z",
		});
		// A steered trial carries the capability evidence that admitted its controls; a baseline trial needs none.
		const evidence = readFileSync(join(DIR, name, "evidence.jsonl"), "utf8");
		if (steered) expect(evidence).toContain('"capability":"steering.');
		else expect(evidence).toBe("");
	});

	it.each(cassettes.filter((name) => !name.endsWith("--base")))(
		"%s records the full intervention chain, with consumption observed",
		(name) => {
			const kinds = readFileSync(join(DIR, name, "session.events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> })
				.filter((event) => event.kind.startsWith("intervention."));
			expect(kinds.map((event) => event.kind)).toEqual([
				"intervention.proposal",
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.consumed",
				"intervention.consequence",
			]);
			expect(kinds[5]!.payload).toMatchObject({ consumption: { status: "observed" } });
		},
	);
});

describe.skipIf(executable === undefined)(
	"replaying the steering cassettes against a real Pi (ENDO_PI_EXECUTABLE)",
	() => {
		const plan = cassettes.flatMap((name) =>
			name.endsWith("--base")
				? [[name, "immediate"] as const]
				: (["immediate", "immediate", "immediate", "as-recorded", "as-recorded"] as const).map(
						(timing) => [name, timing] as const,
					),
		);
		it.each(plan)(
			"a replay of %s (%s) is EXACT, with no miss, and re-issues the intervention",
			async (name, timing) => {
				const { scratch, store } = materialize(name);
				const report = await replayPiCassetteSessionV0({
					store,
					out: join(scratch, "replay"),
					pi: executable!,
					timing,
					keySource: { kind: "fixture", path: endoFixtureDigestKeyPathV0() },
					timeoutMs: 120_000,
				});
				expect(report.misses).toBe(0);
				expect(report.unserved).toBe(0);
				for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
					expect(report.comparison.layers[layer].status, layer).toBe("EXACT");
				expect(report.interventions).toEqual(
					name.endsWith("--base")
						? []
						: [
								{
									operation: name.endsWith("--steer") ? "steer" : "queue",
									recordedAt: { exchange: 2, chunks: 1 },
									reissuedAt: { exchange: 2, chunks: 1 },
									proposalDigestMatches: true,
									result: "accepted",
								},
							],
				);
			},
			180_000,
		);
	},
);
