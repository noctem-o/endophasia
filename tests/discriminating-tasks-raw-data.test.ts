// The raw run data of the discriminating-task study (research-data directory, research/DATA.md): the secret scan,
// the hard gate for committed captures, passes over the directory exactly as stored, with the operator's explicit,
// documented exception (raw/README.md, raw/allowed-paths.json). Any other absolute path, or any other kind of finding, fails.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";
import { rawDataAvailable, rawDirectory } from "../research/data.ts";

const RAW = rawDirectory("discriminating-tasks");
const runDirectories = [join(RAW, "pilot"), ...["c1", "c2", "c3", "c4"].map((label) => join(RAW, "confirm", label))];

describe.skipIf(!rawDataAvailable("discriminating-tasks"))("the raw run data of the discriminating-task study", () => {
	it("passes the secret scan exactly as stored, with only the operator's documented path exception", () => {
		const scratch = runDirectories.map((dir) =>
			(
				JSON.parse(readFileSync(join(dir, "experiment.json"), "utf8")) as { scratchRoot: string }
			).scratchRoot.replace(/\/scratch$/, ""),
		);
		const exception = JSON.parse(readFileSync(join(RAW, "allowed-paths.json"), "utf8")) as {
			storesLocation: string;
			taskExamplePaths: string[];
			agentWrittenPaths: string[];
		};
		const scan = endoSecretScanDirectoryV0(RAW, [
			...new Set(scratch),
			"/usr/bin/pi",
			"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
			exception.storesLocation,
			...exception.taskExamplePaths,
			...exception.agentWrittenPaths,
		]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
	}, 600_000);

	it("holds the screen and the four confirmation paths, and a trial store opens", () => {
		expect(
			readdirSync(join(RAW, "confirm"))
				.filter((name) => /^c\d$/.test(name))
				.sort(),
		).toEqual(["c1", "c2", "c3", "c4"]);
		const events = readEndoStoreEventsV0(join(RAW, "pilot", "trials", "slot-pack", "default", "0", "store"));
		expect(events.length).toBeGreaterThan(0);
	});
});
