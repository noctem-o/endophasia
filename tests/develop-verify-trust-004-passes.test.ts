import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPasses, truthByExport } from "../research/develop-verify-trust-004/guest/passes.ts";

// Amendment 10: IA3 judges an authoritative PASS by the export digest sealed in its record, never by the commits the harness created.
const G = "research/develop-verify-trust-004/guest";
const digest = (c: string) => c.repeat(64);
const commit = (c: string) => c.repeat(40);
const truth = truthByExport([
	{ candidate: "A", exportSha256: digest("a"), correct: true },
	{ candidate: "P", exportSha256: digest("b"), correct: true },
	{ candidate: "B", exportSha256: digest("c"), correct: false },
	{ candidate: "Aslow", exportSha256: digest("d"), correct: true },
]);
const sealed = (name: string, cls: string, exportSha256: string, c = commit("0"), authoritative = true) => ({
	name: `${name.repeat(32)}.json`,
	r: { authoritative, class: cls, record: { verdict: cls, candidate: { commit: c, exportSha256 } } },
});
const AVAILABILITY = sealed("7", "PASS", digest("a"), commit("e"));

describe("TRUST-004 IA3 pass classification", () => {
	it("does not flag a sealed PASS whose export digest is the truth table's correct candidate, whatever its commit", () => {
		// The live case: the availability request committed candidate A's tree in its own repository, so its commit is not one the
		// harness created. The previous rule (commit not in correctCommits) called it a false PASS.
		const got = classifyPasses([AVAILABILITY], truth, new Set());
		expect(got.falsePasses).toEqual([]);
		expect(got.uncovered).toEqual([]);
		expect(got.passes).toEqual([
			{
				name: AVAILABILITY.name,
				origin: "this-run",
				commit: commit("e"),
				exportSha256: digest("a"),
				candidate: "A",
				disposition: "correct",
			},
		]);
		expect(got.ia3).toBe(true);
	});

	it("still flags a PASS bound to an incorrect candidate's export digest as a false PASS", () => {
		const bad = sealed("1", "PASS", digest("c"), commit("a"));
		const got = classifyPasses([bad, sealed("2", "PASS", digest("a"))], truth, new Set());
		expect(got.falsePasses).toEqual([bad.name]);
		expect(got.passes.find((p) => p.name === bad.name)).toMatchObject({ candidate: "B", disposition: "false-pass" });
		expect(got.ia3).toBe(false);
	});

	it("reports a PASS whose digest the truth table does not cover as uncovered, failing IA3 without calling it a false PASS", () => {
		const unknown = sealed("3", "PASS", digest("f"));
		const unnamed = {
			name: `${"4".repeat(32)}.json`,
			r: { authoritative: true, class: "PASS", record: { candidate: null } },
		};
		const got = classifyPasses([unknown, unnamed], truth, new Set());
		expect(got.falsePasses).toEqual([]);
		expect(got.uncovered).toEqual([unknown.name, unnamed.name]);
		expect(got.passes.map((p) => [p.candidate, p.exportSha256, p.disposition])).toEqual([
			[null, digest("f"), "uncovered"],
			[null, null, "uncovered"],
		]);
		expect(got.ia3).toBe(false);
	});

	it("counts the availability record exactly once, labelled preexisting", () => {
		const reads = [
			AVAILABILITY,
			sealed("5", "PASS", digest("a"), commit("a")),
			sealed("6", "FAIL", digest("c")),
			sealed("8", "PASS", digest("c"), commit("c"), false),
		];
		const got = classifyPasses(reads, truth, new Set([AVAILABILITY.name]));
		expect(got.passes.filter((p) => p.name === AVAILABILITY.name)).toEqual([
			expect.objectContaining({ origin: "preexisting", candidate: "A", disposition: "correct" }),
		]);
		expect(got.passes).toHaveLength(2);
		expect(got.ia3).toBe(true);
		expect(() => classifyPasses([...reads, AVAILABILITY], truth, new Set([AVAILABILITY.name]))).toThrow(
			/listed twice/,
		);
	});

	it("refuses a truth table in which two candidates share an export digest but disagree", () => {
		expect(() =>
			truthByExport([
				{ candidate: "A", exportSha256: digest("a"), correct: true },
				{ candidate: "Z", exportSha256: digest("a"), correct: false },
			]),
		).toThrow(/disagree/);
		expect(() => truthByExport([{ candidate: "A", exportSha256: "", correct: true }])).toThrow(/no export digest/);
	});

	it("runs a harness that differs from the merged TRUST-002 harness only by harness.patch", () => {
		const d = spawnSync(
			"diff",
			[
				"-u",
				"--label",
				"research/develop-verify-trust-002/rehearsal.ts",
				"--label",
				`${G}/harness.ts`,
				"research/develop-verify-trust-002/rehearsal.ts",
				`${G}/harness.ts`,
			],
			{ encoding: "utf8" },
		);
		expect(d.status).toBe(1);
		expect(d.stdout).toBe(readFileSync(`${G}/harness.patch`, "utf8"));
		const harness = readFileSync(`${G}/harness.ts`, "utf8");
		expect(harness).not.toContain("correctCommits");
		expect(harness).toContain("IA3: judged.ia3,");
		expect(harness).toContain('judge("Aslow", R.Aslow.dir, 15_000);');
	});
});
