import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEndoExperimentPlanFileV0, readEndoExperimentRunRecordFileV0 } from "../cli/experiment-artifacts.ts";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import { rawDataAvailable, rawDirectory } from "../research/data.ts";

const RAW = rawDirectory("steering");
const RUNS = ["pilot", "main", "posthoc-pilot-path", "posthoc-main-path"];
const scratchRoots = () =>
	RUNS.map((run) => readEndoExperimentRunRecordFileV0(join(RAW, run)).scratchRoot.replace(/\/scratch$/, ""));

describe.skipIf(!rawDataAvailable("steering"))("the raw run data of the steering study", () => {
	it("passes the secret scan exactly as stored, with only the operator's documented path exception", () => {
		const scan = endoSecretScanDirectoryV0(RAW, [
			...new Set(scratchRoots()),
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
		const count = (run: string) => readEndoExperimentPlanFileV0(join(RAW, run)).plan.order.length;
		expect(RUNS.map(count)).toEqual([18, 120, 18, 120]);
		// The post-hoc block run is a partial run by design (--max-trials 6).
		const events = readEndoStoreEventsV0(join(RAW, "main", "trials", "tool-use", "steer", "0", "store"));
		expect(events.some((event) => event.kind === "intervention.consumed")).toBe(true);
	});
});
