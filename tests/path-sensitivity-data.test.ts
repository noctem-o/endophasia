// The committed data of the path-sensitivity study (research/path-sensitivity/1.0.1/): the secret scan, the hard gate for
// committed captures, passes over the data directories exactly as committed; the layout is what RESULTS.md says (30 paths,
// 12 completed trials each, a report per path); and the committed analysis holds the numbers RESULTS.md reports.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readEndoExperimentRunRecordFileV0 } from "../cli/experiment-artifacts.ts";
import { endoSecretScanDirectoryV0 } from "../cli/secret-scan.ts";

const R = fileURLToPath(new URL("../research/path-sensitivity/1.0.1/", import.meta.url));
const json = <T>(...parts: string[]) => JSON.parse(readFileSync(join(R, ...parts), "utf8")) as T;
const dirs = (parent: string) =>
	readdirSync(join(R, parent), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

describe("the committed path-sensitivity data", () => {
	it("passes the secret scan exactly as committed (absolute paths: only the runs' scratch roots and Pi's install)", () => {
		const roots = [
			...dirs("main").map((label) => readEndoExperimentRunRecordFileV0(join(R, "main", label)).scratchRoot),
			...dirs("pilot").map((label) => readEndoExperimentRunRecordFileV0(join(R, "pilot", label)).scratchRoot),
		].map((root) => root.replace(/\/scratch$/, ""));
		expect(new Set(roots).size).toBe(32);
		for (const directory of ["main", "pilot", "analysis", "logs"]) {
			const scan = endoSecretScanDirectoryV0(join(R, directory), [
				...roots,
				"/usr/bin/pi",
				"/usr/lib/node_modules/@earendil-works/pi-coding-agent",
			]);
			expect(scan.findings, directory).toEqual([]);
		}
	}, 120_000);

	it("holds 30 paths of 12 completed trials each, with a report, and none of the two known paths", () => {
		const paths = json<{ order: string[]; missing: string[]; hashes: Record<string, string>; excluded: string[] }>(
			"main",
			"paths.json",
		);
		expect(paths.order).toHaveLength(30);
		expect(paths.missing).toEqual([]);
		expect(dirs("main")).toEqual([...paths.order].sort());
		for (const label of paths.order) {
			expect(
				existsSync(join(R, "main", label, "report", "bundle.json")) ||
					existsSync(join(R, "main", label, "bundle.json")),
			).toBe(true);
			const plan = json<{ order: { task: string; condition: string; trial: number }[] }>(
				"main",
				label,
				"plan.json",
			).order;
			expect(plan, label).toHaveLength(12);
			for (const entry of plan) {
				const result = json<{ status: string }>(
					"main",
					label,
					"trials",
					entry.task,
					entry.condition,
					String(entry.trial),
					"result.json",
				);
				expect(result.status).toBe("completed");
			}
			expect(paths.excluded).not.toContain(paths.hashes[label]);
		}
		expect(new Set(Object.values(paths.hashes)).size).toBe(30);
	});

	it("the committed analysis holds the numbers RESULTS.md reports", () => {
		const a = json<{
			paths: { analysed: number; missing: string[] };
			primary: Record<string, { followed: number; ignored: number; mixed: string[]; reading: string }>;
			secondary: {
				baselinePathInvariance: Record<string, { distinctSignatures: number }>;
				withinPathDeterminism: { cellsNotIdentical: string[] };
				delivery: { violations: number };
				success: { successes: number; n: number };
			};
			manipulation: { status: string; MPath: { distinctFirstRequestsByTask: Record<string, number> } };
			transportErrors: number;
		}>("analysis", "main-analysis.json");
		expect(a.paths).toMatchObject({ analysed: 30, missing: [] });
		const cell = (key: string) => [
			a.primary[key]!.followed,
			a.primary[key]!.ignored,
			a.primary[key]!.mixed.length,
			a.primary[key]!.reading,
		];
		expect(cell("tool-use/steer")).toEqual([27, 3, 0, "robustly followed"]);
		expect(cell("tool-use/queue")).toEqual([30, 0, 0, "robustly followed"]);
		expect(cell("implement-function/steer")).toEqual([6, 24, 0, "path-dependent at this N"]);
		expect(cell("implement-function/queue")).toEqual([30, 0, 0, "robustly followed"]);
		expect(a.secondary.baselinePathInvariance["tool-use"]!.distinctSignatures).toBe(1);
		expect(a.secondary.baselinePathInvariance["implement-function"]!.distinctSignatures).toBe(20);
		expect(a.secondary.withinPathDeterminism.cellsNotIdentical).toEqual([]);
		expect(a.secondary.delivery.violations).toBe(0);
		expect(a.secondary.success).toMatchObject({ successes: 360, n: 360 });
		expect(a.manipulation.status).toBe("PASS");
		expect(a.manipulation.MPath.distinctFirstRequestsByTask).toEqual({ "implement-function": 1, "tool-use": 1 });
		expect(a.transportErrors).toBe(0);
	});
});
