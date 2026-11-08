// REVIEW-PILOT-001 (research/review-pilot/README.md): the study's fixture, task and worksheet, through the same driver as WORK-CYCLE-001A.
// No agent and no approval here: the run itself is the operator's. The candidate edits below are the test's own.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	endo,
	json,
	launchRun,
	prepareJourney,
	REVIEW_PILOT_001,
	type RunLayout,
	reconstruct,
	runEnv,
	runGit,
	STUDIES,
	WORK_CYCLE_001A,
	writeReviewWorksheet,
} from "../research/work-cycle/driver.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0).reverse()) done();
});

function freshRun(): RunLayout {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "endo-rp-")));
	cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
	return launchRun(join(parent, "run"), REVIEW_PILOT_001);
}

const S = (l: RunLayout) => ["--root", l.store];

/** Add the d unit to the source only, as an agent might: the check passes, and the README is still untouched. */
function addDaysToSource(project: string): void {
	const file = join(project, "src", "duration.mjs");
	const before = readFileSync(file, "utf8");
	const after = before
		.replace('\t["h", 3600],', '\t["d", 86400],\n\t["h", 3600],')
		.replace("/^(?:(\\d+)h)?", "/^(?:(\\d+)d)?(?:(\\d+)h)?");
	expect(after).not.toBe(before);
	writeFileSync(file, after);
}

function commitAndCheck(layout: RunLayout, attemptId: string) {
	runGit(layout.project, "add", "-A");
	runGit(layout.project, "commit", "-q", "-m", "candidate");
	return endo(
		layout,
		runEnv(layout),
		"attempt",
		"check",
		...S(layout),
		"--attempt",
		attemptId,
		"--",
		...REVIEW_PILOT_001.task.check,
	);
}

describe("REVIEW-PILOT-001: a task the check does not settle", () => {
	it("the study is chosen by id, and the default study is still WORK-CYCLE-001A", () => {
		expect(STUDIES["review-pilot-001"]).toBe(REVIEW_PILOT_001);
		expect(STUDIES["work-cycle-001a"]).toBe(WORK_CYCLE_001A);
		expect(WORK_CYCLE_001A.worksheet).toBeNull();
	});

	it("launches the duration fixture, freezes all four criteria into the brief, and records a failing baseline", () => {
		const layout = freshRun();
		expect(runGit(layout.project, "log", "--format=%s").trim()).toBe("fixture: durations have no days");
		expect(runGit(layout.project, "ls-files").trim().split("\n")).toEqual([
			"README.md",
			"src/duration.mjs",
			"test/duration.test.mjs",
		]);
		const env = runEnv(layout);
		const prepared = prepareJourney(layout, env, REVIEW_PILOT_001);
		expect(prepared.baseline).toMatchObject({ exit: 3, outcome: "failed" });
		const task = json(
			endo(layout, env, "task", "show", ...S(layout), "--project", prepared.projectId, "--task", prepared.taskId),
		).task;
		expect(task.acceptance).toBe(REVIEW_PILOT_001.task.acceptance);
		const brief = endo(layout, env, "attempt", "brief", ...S(layout), "--attempt", prepared.attemptId).stdout;
		for (const line of REVIEW_PILOT_001.task.acceptance.split("\n")) expect(brief).toContain(line);
		expect(brief).toContain(REVIEW_PILOT_001.task.constraints);
	});

	it("the check passes with the README untouched: criterion 2 is the reviewer's, and the records show what changed", () => {
		const layout = freshRun();
		const prepared = prepareJourney(layout, runEnv(layout), REVIEW_PILOT_001);
		addDaysToSource(layout.project);
		const check = commitAndCheck(layout, prepared.attemptId);
		expect(check.status).toBe(0);
		expect(json(check).receipt.outcome).toBe("passed");
		const r = reconstruct(layout, prepared);
		expect(r.artifact).toMatchObject({ clean: true, changedFiles: ["src/duration.mjs"], testsChanged: false });
		// The task is not done because a check passed: only the operator moves it.
		expect(r.task.status).toBe("open");
	});

	it("writes the worksheet once, filled with this run's ids and commands, and with no answers", () => {
		const layout = freshRun();
		const prepared = prepareJourney(layout, runEnv(layout), REVIEW_PILOT_001);
		const out = writeReviewWorksheet(layout, prepared, REVIEW_PILOT_001);
		expect(out).toBe(join(layout.evidence, "review-worksheet.md"));
		const text = readFileSync(out as string, "utf8");
		expect(text).not.toMatch(/\{\{\w+\}\}/);
		expect(text).toContain(
			`attempt evidence --root ${layout.store} --attempt ${prepared.attemptId} --cwd ${layout.project}`,
		);
		expect(text).toContain(
			`task show --root ${layout.store} --project ${prepared.projectId} --task ${prepared.taskId}`,
		);
		expect(text).toContain(`git -C ${layout.project} diff ${prepared.baseCommit} HEAD`);
		expect(text).toContain(`ENDO_DIGEST_KEY_FILE=${layout.digestKeyFile}`);
		for (const line of REVIEW_PILOT_001.task.acceptance.split("\n")) expect(text).toContain(line);
		// Never over an earlier one: a second write is refused and the first is left as it was.
		expect(() => writeReviewWorksheet(layout, prepared, REVIEW_PILOT_001)).toThrow(/EEXIST/);
		expect(readFileSync(out as string, "utf8")).toBe(text);
		// The printed commands work as written (a new process, this run's key).
		const evidence = endo(
			layout,
			runEnv(layout),
			"attempt",
			"evidence",
			...S(layout),
			"--attempt",
			prepared.attemptId,
			"--cwd",
			layout.project,
		);
		expect(evidence.status).toBe(0);
		expect(writeReviewWorksheet(layout, prepared, WORK_CYCLE_001A)).toBeNull();
	});
});
