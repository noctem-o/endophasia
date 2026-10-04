// The committed raw run data of the steering study (research/steering/1.0.1/raw/): the secret scan, the hard gate for
// committed captures, passes over the directory exactly as committed, with the operator's explicit, documented
// exception for the stores' own location and the capability study's temporary directories (raw/README.md). Any other
// absolute path, or any other kind of finding, fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";

const RAW = fileURLToPath(new URL("../research/steering/1.0.1/raw/", import.meta.url));
const RUNS = ["pilot", "main", "posthoc-pilot-path", "posthoc-main-path"];
const scratchRoots = RUNS.map((run) =>
	(JSON.parse(readFileSync(join(RAW, run, "experiment.json"), "utf8")) as { scratchRoot: string }).scratchRoot.replace(
		/\/scratch$/,
		"",
	),
);

describe("the committed raw run data of the steering study", () => {
	it("passes the secret scan exactly as committed, with only the operator's documented path exception", () => {
		const scan = endoSecretScanDirectoryV0(RAW, [
			...new Set(scratchRoots),
			"/usr/bin/pi",
			"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
			// The operator's explicit exception (raw/README.md): the stores' location, and the capability studies' directories.
			"/home/noctem/projects/endophasia/.artifacts/steering-1.0.1",
			"/tmp/endo-pi-study-ExgR0h",
			"/tmp/endo-pi-study-qRaeRX",
			"/tmp/endo-pi-study-KgMwCy",
			"/tmp/endo-pi-study-hbemp8",
		]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
	}, 180_000);

	it("holds every run's trials, and a trial store opens and projects", () => {
		const count = (run: string) =>
			(JSON.parse(readFileSync(join(RAW, run, "plan.json"), "utf8")) as { order: unknown[] }).order.length;
		expect(RUNS.map(count)).toEqual([18, 120, 18, 120]);
		// The post-hoc block run is a partial run by design (--max-trials 6).
		const events = readEndoStoreEventsV0(join(RAW, "main", "trials", "tool-use", "steer", "0", "store"));
		expect(events.some((event) => event.kind === "intervention.consumed")).toBe(true);
	});
});
