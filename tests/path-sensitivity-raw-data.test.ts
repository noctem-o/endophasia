// The committed raw run data of the path-sensitivity study (research/path-sensitivity/1.0.1/raw/): the secret scan, the
// hard gate for committed captures, passes over the directory exactly as committed, with the operator's explicit,
// documented exception (raw/README.md, raw/allowed-paths.json). Any other absolute path, or any other kind of finding,
// fails.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { readEndoStoreEventsV0 } from "../cli/trajectory.ts";

const RAW = fileURLToPath(new URL("../research/path-sensitivity/1.0.1/raw/", import.meta.url));
const runs = (run: string) =>
	readdirSync(join(RAW, run), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^(p\d+|pilot-\d)$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();

describe("the committed raw run data of the path-sensitivity study", () => {
	it("passes the secret scan exactly as committed, with only the operator's documented path exception", () => {
		const scratch = ["pilot", "main"].flatMap((run) =>
			runs(run).map((label) =>
				(
					JSON.parse(readFileSync(join(RAW, run, label, "experiment.json"), "utf8")) as { scratchRoot: string }
				).scratchRoot.replace(/\/scratch$/, ""),
			),
		);
		const exception = JSON.parse(readFileSync(join(RAW, "allowed-paths.json"), "utf8")) as {
			storesLocation: string;
			capabilityStudyDirectories: string[];
		};
		expect(exception.capabilityStudyDirectories).toHaveLength(32);
		const scan = endoSecretScanDirectoryV0(RAW, [
			...new Set(scratch),
			"/usr/bin/pi",
			"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
			exception.storesLocation,
			...exception.capabilityStudyDirectories,
		]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
	}, 300_000);

	it("holds every path, and a trial store opens and projects", () => {
		expect(runs("pilot")).toEqual(["pilot-1", "pilot-2"]);
		expect(runs("main")).toHaveLength(30);
		const events = readEndoStoreEventsV0(join(RAW, "main", "p01", "trials", "tool-use", "steer", "0", "store"));
		expect(events.some((event) => event.kind === "intervention.consumed")).toBe(true);
	});
});
