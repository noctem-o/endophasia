import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acceptance, observedClass } from "../research/develop-acceptance-001/report.ts";

describe("fixture replay only: the acceptance reader", () => {
	const roots: string[] = [];
	it("does not classify a declared model as an observed exchange", () => {
		expect(observedClass(true, null, false)).toBe("unknown");
		expect(observedClass(true, null, true)).toBe("isolated-process observation");
		const recording = JSON.parse(
			readFileSync(new URL("../research/develop-acceptance-001/evidence/pi/record.json", import.meta.url), "utf8"),
		).recording;
		expect(observedClass(true, recording, true)).toBe("model-connected observation");
		expect(observedClass(false, recording, false)).toBe("unknown");
		expect(observedClass(true, { ...recording, exchanges: [] }, false)).toBe("unknown");
	});
	afterEach(() => {
		for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
	});
	function fixture(mode = "reference") {
		const dir = mkdtempSync(join(tmpdir(), "endo-acceptance-test-"));
		roots.push(dir);
		const source = fileURLToPath(new URL(`../research/develop-acceptance-001/evidence/${mode}/`, import.meta.url));
		const attempt = join(dir, "trials", "strict-positive", mode, "0", "attempt-1");
		mkdirSync(join(attempt, "submission"), { recursive: true });
		copyFileSync(join(source, "protected-run.json"), join(dir, "protected-run.json"));
		copyFileSync(join(source, "record.json"), join(attempt, "record.json"));
		writeFileSync(join(attempt, "submission/count.mjs"), readFileSync(join(source, "count.mjs")));
		writeFileSync(join(attempt, "agent.log"), mode === "unchanged" ? "PASS\n" : "");
		return {
			dir,
			attempt,
			pin: JSON.parse(readFileSync(join(dir, "protected-run.json"), "utf8")).specSha256 as string,
		};
	}
	it.each([
		["reference", "review candidate", 5],
		["unchanged", "reject candidate", 3],
	] as const)("links %s to exact bytes and case counts", (mode, recommendation, passed) => {
		const { dir, pin } = fixture(mode);
		const result = acceptance(dir, pin);
		expect(result.recommendation).toBe(recommendation);
		expect(result.evaluation.cases).toEqual({ total: 5, passed });
		expect(result.evaluatedCandidateSha256).toBe(result.submission.sha256);
		expect(result.authority).toBe("experimental, non-authoritative");
	});
	it("invalidates a staged edit after a successful read", () => {
		const { dir, attempt, pin } = fixture();
		expect(acceptance(dir, pin).recommendation).toBe("review candidate");
		writeFileSync(join(attempt, "submission/count.mjs"), "changed");
		expect(() => acceptance(dir, pin)).toThrow("staged bytes mismatch");
	});
	it("refuses another invocation's pin", () => {
		const { dir } = fixture();
		expect(() => acceptance(dir, fixture("unchanged").pin)).toThrow("operator spec pin mismatch");
	});
	it.each(["missing", "malformed"])("refuses %s finalization", (kind) => {
		const { dir, attempt, pin } = fixture();
		const path = join(attempt, "record.json");
		if (kind === "missing") rmSync(path);
		else writeFileSync(path, "{");
		expect(() => acceptance(dir, pin)).toThrow(kind === "missing" ? "not finalized" : "not readable JSON");
	});
	it("refuses a modified outcome", () => {
		const { dir, attempt, pin } = fixture();
		const path = join(attempt, "record.json");
		const record = JSON.parse(readFileSync(path, "utf8"));
		record.evaluation.cases = { passed: 1, total: 1 };
		writeFileSync(path, JSON.stringify(record));
		expect(() => acceptance(dir, pin)).toThrow("digest");
	});
	it("does not turn a projection into a substitute model recording", () => {
		const { dir, pin } = fixture("pi");
		expect(() => acceptance(dir, pin)).toThrow(/digest key/);
	});
});
