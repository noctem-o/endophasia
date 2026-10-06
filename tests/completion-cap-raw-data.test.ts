// The raw run data of the completion-cap study (research-data directory, research/DATA.md): the secret scan, the hard gate
// for captured run data, passes over the directory exactly as stored, with the categories of absolute paths outside the
// scratch roots that the operator reviewed (completion-cap/1.0.1/allowed-paths.json). Any other path, or any other kind of
// finding, fails. Skipped when the data directory is absent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";
import { rawDataAvailable, rawDirectory, researchDataRoot } from "../research/data.ts";

const RAW = rawDirectory("completion-cap");
const runDirectories = () => [
	join(RAW, "pilot"),
	...readdirSync(join(RAW, "main"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(RAW, "main", entry.name)),
];

describe.skipIf(!rawDataAvailable("completion-cap"))("the raw run data of the completion-cap study", () => {
	it("passes the secret scan exactly as stored, with only the reviewed path categories", () => {
		const scratch = runDirectories().map((dir) =>
			(
				JSON.parse(readFileSync(join(dir, "experiment.json"), "utf8")) as { scratchRoot: string }
			).scratchRoot.replace(/\/scratch$/, ""),
		);
		const allowed = JSON.parse(
			readFileSync(join(researchDataRoot(), "completion-cap", "1.0.1", "allowed-paths.json"), "utf8"),
		) as Record<string, string[] | string>;
		const exception = Object.values(allowed).flatMap((value) => (Array.isArray(value) ? value : []));
		const scan = endoSecretScanDirectoryV0(RAW, [
			...new Set(scratch),
			"/usr/bin/pi",
			"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
			...exception,
		]);
		expect(scan.findings).toEqual([]);
		expect(scan.passed).toBe(true);
	}, 900_000);

	it("holds the pilot and the four paths of the main run", () => {
		expect(
			readdirSync(join(RAW, "main"))
				.filter((name) => /^c\d$/.test(name))
				.sort(),
		).toEqual(["c1", "c2", "c3", "c4"]);
		expect(readdirSync(join(RAW, "pilot", "trials")).sort()).toEqual([
			"booking-conflicts",
			"config-extends",
			"fetch-cache",
			"markup-lite",
		]);
	});
});
