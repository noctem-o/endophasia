// MEM-000 over the real corpus (research/evidence-eligibility/corpus.v0.json). The committed files must parse everywhere; the projection of
// the private archives runs only where they are present (research/DATA.md), and must then reproduce the committed manifest byte for byte.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rawDataAvailable, researchDataRoot } from "../research/data.ts";
import { readCorpus } from "../research/evidence-eligibility/corpus.ts";
import { readLessonFile } from "../research/evidence-eligibility/lessons.ts";
import { type ApplicabilityCase, buildEligibility, REPOSITORY } from "../research/evidence-eligibility/report.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

const HERE = fileURLToPath(new URL("../research/evidence-eligibility/", import.meta.url));
const json = (name: string) => JSON.parse(readFileSync(join(HERE, name), "utf8"));
const corpus = readCorpus(json("corpus.v0.json"));
const lessons = readLessonFile(json("lessons.v0.json"));
const cases = json("applicability-cases.v0.json").cases as ApplicabilityCase[];
const available = ["steering", "path-sensitivity", "discriminating-tasks", "completion-cap"].every((s) =>
	rawDataAvailable(s),
);

describe("the committed corpus, lesson candidates and applicability cases", () => {
	it("parse under their own versions, and every cited document and analysis is in the repository", () => {
		expect(corpus.sources.length).toBeGreaterThan(0);
		for (const v of corpus.validity) expect(existsSync(join(REPOSITORY, v.file)), v.file).toBe(true);
		for (const d of corpus.declarations) expect(existsSync(join(REPOSITORY, d.document)), d.document).toBe(true);
		for (const c of lessons.cards)
			for (const a of c.evidence.analysis) expect(existsSync(join(REPOSITORY, a.file)), a.file).toBe(true);
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
	});

	it("without the archives, says so: evidence is INDETERMINATE and nothing claims the archives were qualified", () => {
		const built = buildEligibility(
			corpus,
			{ repository: REPOSITORY, researchData: null, store: null },
			lessons,
			cases,
		);
		const r = built.manifest as {
			roots: { researchData: string };
			readiness: { evidence: { status: string; conditions: string[] } };
		};
		expect(r.roots.researchData).toBe("absent");
		expect(r.readiness.evidence.status).toBe("INDETERMINATE");
		expect(r.readiness.evidence.conditions.join(" ")).toContain("not a qualification of the archives");
	});
});

describe.runIf(available)("the projection of the local archives", () => {
	it("reproduces the committed manifest and summary, and the cases behave as specified", () => {
		const roots = { repository: REPOSITORY, researchData: researchDataRoot(), store: null };
		const a = buildEligibility(corpus, roots, lessons, cases);
		const b = buildEligibility(corpus, roots, lessons, cases);
		expect(canonicalEndoJsonV0(a.report)).toBe(canonicalEndoJsonV0(b.report));
		expect(canonicalEndoJsonV0(a.manifest)).toBe(readFileSync(join(HERE, "report", "manifest.json"), "utf8"));
		expect(a.summary).toBe(readFileSync(join(HERE, "report", "summary.md"), "utf8"));
		const checks = (a.report.lessonFeasibility as { applicability: { id: string; passed: boolean }[] }).applicability;
		for (const c of checks) expect(c.passed, c.id).toBe(true);
	});
});
