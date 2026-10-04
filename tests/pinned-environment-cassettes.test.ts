// The committed pinned-environment study cassettes (research/pinned-environment/1.0.1/cassettes/): the secret scan,
// the hard gate for committed captures, passes over the directory exactly as committed; every cassette materializes
// into a store and loads as a cassette in the fixture domain, with a v1 snapshot; a pinned cassette records its
// environment, and its snapshot holds the reporter and only the fixed time; an unpinned one records none.
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

const DIR = fileURLToPath(new URL("../research/pinned-environment/1.0.1/cassettes/", import.meta.url));
const SCRATCH = "/tmp/endo-experiment-93a1cbaf3653";
const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const FILE_TIME = Date.parse("2026-01-01T00:00:00Z");
const cassettes = readdirSync(DIR)
	.filter((name) => statSync(join(DIR, name)).isDirectory())
	.sort();
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the committed pinned-environment study cassettes", () => {
	it("are one per task per arm, as selection.json records", () => {
		const expected = ["fix-failing-test", "implement-function", "tool-use"].flatMap((task) =>
			["a-p", "b-c-p", "b-c-u", "b-p"].map((arm) => `${task}--${arm}`),
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

	it.each(cassettes)("%s materializes and loads in the fixture domain; its environment matches its arm", (name) => {
		const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
		const store = materializePiCassetteFixtureV0(
			join(DIR, name),
			join(mkdtempSync(join(tmpdir(), "endo-pinned-cassette-")), "store"),
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
		const paths = archive.entries.map((entry) => entry.path);
		if (name.endsWith("-p")) {
			expect(script.environment).toMatchObject({
				variables: {
					TZ: "UTC",
					LC_ALL: "C",
					NODE_OPTIONS: `--test-reporter=${SCRATCH}/scratch/env/test-reporter.mjs`,
				},
				fileTime: "2026-01-01T00:00:00Z",
			});
			expect(paths).toContain("env/test-reporter.mjs");
			expect(archive.rootMtimeMs).toBe(FILE_TIME);
			expect(new Set(archive.entries.map((entry) => entry.mtimeMs))).toEqual(new Set([FILE_TIME]));
		} else {
			expect(script.environment).toBeNull();
			expect(paths.some((path) => path === "env" || path.startsWith("env/"))).toBe(false);
		}
		expect(JSON.parse(readFileSync(join(DIR, name, "normalization.json"), "utf8"))).toEqual({
			storeRoot: { placeholder: "<store>", appliesTo: "session.events.jsonl", stringsReplaced: 1 },
		});
	});
});
