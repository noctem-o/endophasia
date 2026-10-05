// The discriminating-task pool (research/discriminating-tasks/1.0.1/tasks/, DESIGN.md §4), validated mechanically before any
// trial: for each task the reference solution passes the success check, the starting workspace fails it, a plausible wrong
// solution fails it, the check is not in the workspace and does not depend on the time zone, and every behaviour the hidden
// check asserts is a rule the prompt (or the workspace README) states, and every stated rule is tested.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import {
	type DiscriminatingTaskV0,
	experimentTaskV0,
	hiddenCheckArgv,
	loadTaskV0,
	statedRules,
	TASK_IDS,
	TASK_KINDS,
	testedRules,
} from "../research/discriminating-tasks/1.0.1/tasks.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory holding the task's workspace with `overlay` applied. */
function materialize(task: DiscriminatingTaskV0, overlay: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-task-validate-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries({ ...task.workspace, ...overlay })) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

/** Run a task's success check in a fresh directory holding the workspace with `overlay` applied. */
function runCheck(task: DiscriminatingTaskV0, overlay: Record<string, string>, env: Record<string, string> = {}) {
	const dir = materialize(task, overlay);
	const [, ...args] = hiddenCheckArgv(task.hidden);
	return spawnSync(process.execPath, args, {
		cwd: dir,
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 120_000,
	});
}

/** Run the visible tests (`node --test`) in a fresh directory holding the workspace with `overlay` applied. */
function runVisibleTests(task: DiscriminatingTaskV0, overlay: Record<string, string>) {
	return spawnSync(process.execPath, ["--test"], {
		cwd: materialize(task, overlay),
		env: process.env,
		encoding: "utf8",
		timeout: 120_000,
	});
}

const ROOT = fileURLToPath(new URL("../research/discriminating-tasks/1.0.1/tasks/", import.meta.url));
// A task that does not exist yet is skipped here, and the test of the pool's size fails until all 12 do.
const pool = TASK_IDS.filter((id) => existsSync(join(ROOT, id, "prompt.md"))).map((id) => loadTaskV0(id));

describe("the pool", () => {
	it("has the 12 tasks of the design, in a fixed order, with the kinds the design states", () => {
		expect(pool.map((task) => task.id)).toEqual([...TASK_IDS]);
		expect(TASK_IDS).toHaveLength(12);
		const kinds = Object.values(TASK_KINDS);
		expect(kinds.filter((kind) => kind === "implement")).toHaveLength(8);
		expect(kinds.filter((kind) => kind === "debug")).toHaveLength(2);
		expect(kinds.filter((kind) => kind === "edit")).toHaveLength(2);
	});

	it("builds experiment tasks the spec validator accepts, with the check outside the workspace", () => {
		for (const task of pool) {
			const spec = {
				schemaVersion: "endo.experiment-spec.v0",
				id: "endo.experiment.task-pool-validation",
				description: "validation",
				trials: 1,
				seed: 1,
				pi: "/usr/bin/pi",
				upstream: "http://127.0.0.1:8080",
				provider: "endolocal",
				model: "qwen3.8-27b",
				digestDomain: "fixture",
				timeoutMs: 600_000,
				tasks: [experimentTaskV0(task)],
				conditions: [{ id: "default", description: "Pi defaults" }],
			};
			expect(endoExperimentSpecProblemV0(spec), task.id).toBeNull();
		}
	});
});

describe.each(TASK_IDS)("task %s", (id) => {
	const task = pool.find((entry) => entry.id === id) as DiscriminatingTaskV0;

	it.skipIf(task === undefined)(
		"keeps its hidden check out of the workspace, with a marker only the check carries",
		() => {
			expect(task.hidden).toContain(`ENDO-HIDDEN-MARKER-${id}`);
			for (const [path, content] of Object.entries(task.workspace)) {
				expect(content, path).not.toContain("ENDO-HIDDEN-MARKER");
				expect(path).not.toMatch(/hidden/i);
			}
			expect(task.prompt).not.toContain("ENDO-HIDDEN-MARKER");
			expect(task.prompt).toMatch(/reply with the single word: done\s*$/);
		},
	);

	it.skipIf(task === undefined)(
		"states every rule the hidden check asserts, and tests every rule it states (fairness)",
		() => {
			const stated = [
				...new Set([...statedRules(task.prompt), ...statedRules(task.workspace["README.md"] ?? "")]),
			].sort((a, b) => a - b);
			const tested = [...new Set(testedRules(task.hidden))].sort((a, b) => a - b);
			expect(stated.length).toBeGreaterThanOrEqual(5);
			expect(
				tested.filter((rule) => !stated.includes(rule)),
				"tested but not stated",
			).toEqual([]);
			expect(
				stated.filter((rule) => !tested.includes(rule)),
				"stated but not tested",
			).toEqual([]);
		},
	);

	it.skipIf(task === undefined)(
		"fails on the starting workspace, passes on the reference, fails on a plausible wrong solution",
		() => {
			expect(runCheck(task, {}).status, "the starting workspace").not.toBe(0);
			const reference = runCheck(task, task.reference);
			expect(reference.status, `the reference:\n${reference.stdout}\n${reference.stderr}`).toBe(0);
			expect(runCheck(task, task.naive).status, "the wrong solution").not.toBe(0);
		},
	);

	it.skipIf(task === undefined)(
		"has visible tests that agree with the reference (the agent cannot edit test/, so they must not contradict the check)",
		() => {
			const reference = runVisibleTests(task, task.reference);
			expect(reference.status, `the visible tests on the reference:\n${reference.stdout}\n${reference.stderr}`).toBe(
				0,
			);
			if (TASK_KINDS[id] !== "implement") {
				const start = runVisibleTests(task, {});
				expect(start.status, `the visible tests on the starting workspace:\n${start.stdout}\n${start.stderr}`).toBe(
					0,
				);
			}
		},
	);

	it.skipIf(task === undefined)("does not depend on the time zone", () => {
		expect(runCheck(task, task.reference, { TZ: "Pacific/Auckland" }).status).toBe(0);
		expect(runCheck(task, task.reference, { TZ: "America/Los_Angeles" }).status).toBe(0);
	});
});
