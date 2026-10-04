// The committed supplementary variance cassettes (research/variance/1.0.1/cassettes/): the secret scan, the hard gate
// for committed captures, passes over the directory exactly as committed; every cassette materializes into a store and
// loads as a cassette in the fixture domain, with its workspace snapshot keeping file times.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { materializePiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import { piCassetteScriptV0 } from "../cli/cassette-session.ts";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { parseEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";

const DIR = fileURLToPath(new URL("../research/variance/1.0.1/cassettes/", import.meta.url));
const SCRATCH = "/tmp/endo-experiment-d270240da4d6";
const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const cassettes = readdirSync(DIR)
	.filter((name) => statSync(join(DIR, name)).isDirectory())
	.sort();
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the committed supplementary variance cassettes", () => {
	it("are one per task per arm", () => {
		expect(cassettes).toEqual(
			["fix-failing-test", "implement-function", "tool-use"].flatMap((task) =>
				["a", "b", "b-c"].map((arm) => `${task}--${arm}`),
			),
		);
	});

	it("pass the secret scan exactly as committed (absolute paths: only the scratch root, Pi's install path and executable)", () => {
		const scan = endoSecretScanDirectoryV0(DIR, [SCRATCH, PI, "/usr/bin/pi"]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
		expect(scan.allowedPaths[SCRATCH]).toBeGreaterThan(0);
	});

	it.each(cassettes)("%s materializes and loads as a cassette in the fixture domain, with a v1 snapshot", (name) => {
		const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
		const store = materializePiCassetteFixtureV0(
			join(DIR, name),
			join(mkdtempSync(join(tmpdir(), "endo-variance-cassette-")), "store"),
		);
		dirs.push(join(store, ".."));
		const cassette = loadEndoCassetteV0(store, key);
		expect(cassette.keyId).toBe("fixture-public");
		expect(cassette.exchanges.length).toBeGreaterThan(0);
		expect(
			cassette.exchanges.every(
				(exchange) => exchange.truncated === null && exchange.response?.outcome === "complete",
			),
		).toBe(true);
		const script = piCassetteScriptV0(cassette.events);
		const archive = parseEndoWorkspaceArchiveV0(
			createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true }).get(script.snapshot.archive.digest),
		);
		expect(archive.schemaVersion).toBe("endo.workspace-archive.v1");
		expect(JSON.parse(readFileSync(join(DIR, name, "normalization.json"), "utf8"))).toEqual({
			storeRoot: { placeholder: "<store>", appliesTo: "session.events.jsonl", stringsReplaced: 1 },
		});
	});
});
