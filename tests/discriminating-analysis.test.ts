// The pure parts of the discriminating-task study's analysis (research/discriminating-tasks/1.0.1/): the leakage check.
import { describe, expect, it } from "vitest";
import { leakageOfTrialV0 } from "../research/discriminating-tasks/1.0.1/leakage.ts";

const SCRATCH = "/tmp/endo-experiment-0123456789ab/scratch";
const PROTECTED = ["/home/operator/projects/repo", "/home/operator"];
const check = (toolCallArguments: string[], toolResults: string[] = []) =>
	leakageOfTrialV0({ toolCallArguments, toolResults, ownScratchRoot: SCRATCH, protectedRoots: PROTECTED });

describe("the leakage check", () => {
	it("does not invalidate what a careful agent ordinarily types", () => {
		const fine = [
			'cat > src/config.js <<"EOF"\nloadConfig("/etc/a.json")\nEOF',
			"cat > /tmp/t.mjs <<'EOF'\nimport { render } from '/tmp/x.js'\nEOF\nnode /tmp/t.mjs",
			`ls ${SCRATCH}/work/src && cat ${SCRATCH}/work/package.json`,
			"node --test",
			"write /opt/abs.json",
			"cd .. && ls",
			"cat ~/notes.txt",
		];
		for (const call of fine) expect(check([call]), call).toMatchObject({ invalid: false, reasons: [] });
	});

	it("counts the other mentions outside the scratch root, and not the ones inside it", () => {
		const result = check([
			'loadConfig("/etc/a.json")',
			"cat > /tmp/t.mjs",
			`cat ${SCRATCH}/work/src/a.js`,
			"echo done",
			"node /var/tmp/x.js; node /srv/y.js",
		]);
		expect(result).toEqual({ invalid: false, reasons: [], outsideMentions: 3 });
	});

	it("invalidates a tool call that names the repository or the operator's home", () => {
		for (const call of [
			"cat /home/operator/projects/repo/research/discriminating-tasks/1.0.1/tasks/slot-pack/hidden.test.mjs",
			"ls /home/operator",
			'find "/home/operator/projects/repo" -name "*.mjs"',
			"cd /home/operator; ls",
		]) {
			const result = check([call]);
			expect(result.invalid, call).toBe(true);
			expect(result.reasons.join(" "), call).toMatch(/repository checkout or the operator's home/);
		}
		expect(check(["cat /home/operator2/x"]).invalid, "a different directory with the same prefix").toBe(false);
	});

	it("invalidates a tool call that names the study's own directories outside its scratch root", () => {
		for (const call of [
			"ls /tmp/endo-experiment-0123456789ab",
			"ls /tmp/endo-experiment-ffffffffffff/scratch/work",
			"cat /tmp/endo-hidden-AbC123/hidden.test.mjs",
			"ls /tmp/endo-task-validate-xyz",
		]) {
			const result = check([call]);
			expect(result.invalid, call).toBe(true);
			expect(result.reasons.join(" "), call).toMatch(/study's own directories/);
		}
	});

	it("invalidates the hidden check's marker in a tool result or in a tool call", () => {
		expect(check(["node --test"], ["ok", "ENDO-HIDDEN-MARKER-slot-pack"]).invalid).toBe(true);
		expect(check(["grep ENDO-HIDDEN-MARKER- -r ."]).invalid).toBe(true);
		expect(check(["node --test"], ["ok: 3 passed"]).invalid).toBe(false);
	});

	it("reports every reason once, and never the paths", () => {
		const result = check(
			["cat /home/operator/projects/repo/x", "ls /tmp/endo-hidden-q", "cat /home/operator/y"],
			["ENDO-HIDDEN-MARKER-a", "ENDO-HIDDEN-MARKER-b"],
		);
		expect(result.invalid).toBe(true);
		expect(result.reasons).toHaveLength(3);
		expect(JSON.stringify(result)).not.toContain("/home/operator");
	});
});

import {
	advancesV0,
	bandV0,
	clusterIntervalV0,
	heterogeneousV0,
	SPLIT_SEED_V0,
	selectV0,
	splitV0,
} from "../research/discriminating-tasks/1.0.1/stats.ts";

describe("the screen and the selection", () => {
	it("advances a task with 1 to 5 successes of 6, and not 0 or 6", () => {
		expect([0, 1, 2, 3, 4, 5, 6].map((s) => advancesV0(s, 6))).toEqual([false, true, true, true, true, true, false]);
		expect(advancesV0(1, 1)).toBe(false);
		expect(advancesV0(2, 5)).toBe(true);
	});

	it("keeps at most 8, the closest to 0.5, ties by id", () => {
		const rows = [
			{ task: "t01", successes: 3, counted: 6 },
			{ task: "t02", successes: 2, counted: 6 },
			{ task: "t03", successes: 4, counted: 6 },
			{ task: "t04", successes: 1, counted: 6 },
			{ task: "t05", successes: 5, counted: 6 },
			{ task: "t06", successes: 0, counted: 6 },
			{ task: "t07", successes: 6, counted: 6 },
			{ task: "t08", successes: 3, counted: 6 },
			{ task: "t09", successes: 2, counted: 6 },
			{ task: "t10", successes: 4, counted: 6 },
			{ task: "t11", successes: 1, counted: 6 },
		];
		const result = selectV0(rows);
		// 3/6 (t01, t08), then the four at distance 1/6 (t02, t03, t09, t10), then two of the four at 1/3: t04 and t05 by id.
		expect(result.advancing).toEqual(["t01", "t02", "t03", "t04", "t05", "t08", "t09", "t10"]);
		expect(result.dropped).toEqual(["t06", "t07", "t11"]);
	});

	it("advances everything eligible when fewer than 8 are", () => {
		const result = selectV0([
			{ task: "a", successes: 0, counted: 6 },
			{ task: "b", successes: 3, counted: 6 },
		]);
		expect(result).toEqual({ advancing: ["b"], dropped: ["a"] });
	});
});

describe("the band", () => {
	it("is exact at the edges of 20 trials", () => {
		const bands = Object.fromEntries([0, 1, 2, 3, 4, 16, 17, 18, 19, 20].map((s) => [s, bandV0(s, 20)]));
		expect(bands).toEqual({
			0: "saturated",
			1: "saturated",
			2: "marginal",
			3: "marginal",
			4: "discriminating",
			16: "discriminating",
			17: "marginal",
			18: "marginal",
			19: "saturated",
			20: "saturated",
		});
	});

	it("works for another count, and refuses none", () => {
		expect(bandV0(5, 10)).toBe("discriminating");
		expect(bandV0(1, 10)).toBe("marginal");
		expect(bandV0(9, 10)).toBe("marginal");
		expect(() => bandV0(0, 0)).toThrow(TypeError);
	});
});

describe("the cluster interval and the heterogeneity flag", () => {
	it("is a t interval over the per-path rates", () => {
		// rates .2 .4 .6 .8: mean .5, sd = sqrt(((.3)^2+(.1)^2+(.1)^2+(.3)^2)/3) = 0.258199, se = 0.1290994, t(3) = 3.1824
		const interval = clusterIntervalV0([1, 2, 3, 4].map((successes) => ({ successes, counted: 5 })));
		expect(interval?.mean).toBe(0.5);
		expect(interval?.df).toBe(3);
		expect(interval?.low).toBeCloseTo(0.5 - 3.1824 * 0.1290994, 4);
		expect(interval?.high).toBeCloseTo(0.5 + 3.1824 * 0.1290994, 4);
	});

	it("collapses to a point when all paths agree, clips to [0, 1], and needs two paths", () => {
		expect(clusterIntervalV0([2, 2, 2, 2].map((successes) => ({ successes, counted: 5 })))).toMatchObject({
			mean: 0.4,
			low: 0.4,
			high: 0.4,
		});
		const edge = clusterIntervalV0([0, 0, 0, 5].map((successes) => ({ successes, counted: 5 })));
		expect(edge?.low).toBe(0);
		expect(edge?.high).toBe(1);
		expect(clusterIntervalV0([{ successes: 1, counted: 5 }])).toBeNull();
	});

	it("flags paths whose counts differ by 3 or more", () => {
		expect(heterogeneousV0([2, 3, 4, 3])).toBe(false);
		expect(heterogeneousV0([1, 4, 2, 3])).toBe(true);
		expect(heterogeneousV0([0, 3])).toBe(true);
		expect(heterogeneousV0([2])).toBe(false);
	});
});

describe("the split", () => {
	it("is deterministic, ignores input order, and takes the first ceil(m/2) as validation", () => {
		const ids = ["delta", "alpha", "echo", "charlie", "bravo"];
		const split = splitV0(ids);
		expect(splitV0([...ids].reverse())).toEqual(split);
		expect(split.validation).toHaveLength(3);
		expect(split.holdout).toHaveLength(2);
		expect([...split.validation, ...split.holdout].sort()).toEqual([...ids].sort());
		expect(SPLIT_SEED_V0).toBe(20261004);
		expect(splitV0(ids, 1)).not.toEqual(split);
	});

	it("handles 1 and 0 discriminating tasks", () => {
		expect(splitV0(["only"])).toEqual({ validation: ["only"], holdout: [] });
		expect(splitV0([])).toEqual({ validation: [], holdout: [] });
	});
});

import {
	type AnalysedTrialV0,
	classOf,
	failureModeOf,
	splitFromConfirmation,
	tally,
	toolActivityOf,
} from "../research/discriminating-tasks/1.0.1/analyze.ts";

const result = (patch: Record<string, unknown> = {}) =>
	({
		status: "completed",
		error: null,
		check: { ran: true, exitCode: 0, passed: true, timedOut: false, output: { keyId: "k", value: "v", bytes: 0 } },
		notes: [],
		...patch,
	}) as unknown as Parameters<typeof classOf>[0];
const failed = { ran: true, exitCode: 1, passed: false, timedOut: false, output: { keyId: "k", value: "v", bytes: 0 } };

describe("how a trial is classified", () => {
	it("is a success when the hidden check passed", () => {
		expect(classOf(result(), [])).toEqual({ kind: "success" });
	});

	it("is a failure with its mode when the check did not pass", () => {
		expect(classOf(result({ check: failed }), [])).toEqual({ kind: "failure", mode: "wrong-result" });
		expect(classOf(result({ check: failed, notes: ["agent_settled was not observed after step 1"] }), [])).toEqual({
			kind: "failure",
			mode: "session-did-not-finish",
		});
		expect(classOf(result({ check: { ...failed, timedOut: true } }), [])).toEqual({
			kind: "failure",
			mode: "check-timeout",
		});
		expect(failureModeOf(result({ check: { ran: false, reason: "x" } }))).toBe("check-could-not-run");
	});

	it("counts a session that did not finish but passed the check as a success", () => {
		expect(classOf(result({ notes: ["agent_settled was not observed after step 1"] }), [])).toEqual({
			kind: "success",
		});
	});

	it("excludes a runner error, and an invalid trial even when its check passed", () => {
		expect(classOf(result({ status: "error", error: "boom" }), [])).toEqual({ kind: "error", error: "boom" });
		expect(classOf(result(), ["a tool result contains the hidden check's marker"])).toEqual({
			kind: "invalid",
			reasons: ["a tool result contains the hidden check's marker"],
		});
	});
});

describe("the tally of a task", () => {
	const trial = (kind: AnalysedTrialV0["class"], n: number, task = "t"): AnalysedTrialV0 => ({
		task,
		trial: n,
		class: kind,
		wallMs: 1000 * (n + 1),
		toolCalls: n,
		outsideMentions: n % 2,
		workspaceProblems: [],
		samplingFields: [],
	});

	it("counts successes and failures, excludes errors and invalid trials, and counts missing trials as errors", () => {
		const trials = [
			trial({ kind: "success" }, 0),
			trial({ kind: "failure", mode: "wrong-result" }, 1),
			trial({ kind: "failure", mode: "session-did-not-finish" }, 2),
			trial({ kind: "invalid", reasons: ["x"] }, 3),
			trial({ kind: "error", error: "e" }, 4),
			trial({ kind: "success" }, 0, "other"),
		];
		const tallied = tally("t", trials, 7);
		expect(tallied).toMatchObject({
			planned: 7,
			counted: 3,
			successes: 1,
			errors: 3,
			invalid: 1,
			failureModes: { "wrong-result": 1, "session-did-not-finish": 1 },
			unmeasured: true,
			outsideMentions: 2,
		});
	});

	it("is measured when errors are at most 10% of the planned trials", () => {
		const trials = Array.from({ length: 19 }, (_, n) => trial({ kind: "success" }, n));
		trials.push(trial({ kind: "error", error: "e" }, 19));
		expect(tally("t", trials, 20)).toMatchObject({ errors: 1, unmeasured: false, counted: 19 });
		expect(tally("t", trials.slice(0, 17), 20)).toMatchObject({ errors: 3, unmeasured: true });
	});
});

describe("the tool activity of a request", () => {
	it("reads every tool call's name and arguments and every tool result", () => {
		const activity = toolActivityOf({
			messages: [
				{ role: "user", content: "do it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "a", function: { name: "bash", arguments: '{"command":"ls"}' } }],
				},
				{ role: "tool", tool_call_id: "a", content: [{ type: "text", text: "src test" }] },
				{ role: "tool", tool_call_id: "b", content: "plain" },
			],
		});
		expect(activity).toEqual({ calls: ['bash {"command":"ls"}'], results: ["src test", "plain"] });
		expect(toolActivityOf({})).toEqual({ calls: [], results: [] });
	});
});

describe("the split file", () => {
	it("lists the validation and holdout tasks, and the rest by band", () => {
		const file = splitFromConfirmation({
			discriminating: ["slot-pack", "ticket-code", "route-normalize"],
			tasks: [
				{ task: "slot-pack", band: "discriminating" },
				{ task: "ticket-code", band: "discriminating" },
				{ task: "route-normalize", band: "discriminating" },
				{ task: "markup-lite", band: "marginal" },
				{ task: "tax-brackets", band: "saturated" },
				{ task: "retry-schedule", band: "unmeasured" },
			],
		});
		expect(file.validation).toHaveLength(2);
		expect(file.holdout).toHaveLength(1);
		expect(file.marginal).toEqual(["markup-lite"]);
		expect(file.saturated).toEqual(["tax-brackets"]);
		expect(file.unmeasured).toEqual(["retry-schedule"]);
		expect(file.notInConfirmation).toContain("rolling-median");
		expect(file.notInConfirmation).not.toContain("slot-pack");
		expect(file.seed).toBe(20261004);
	});
});

import { readFileSync } from "node:fs";
import { endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import { CONFIRM_LABELS, confirmationSpec, pilotSpec } from "../research/discriminating-tasks/1.0.1/make-spec.ts";
import { scratchHashOf } from "../research/path-sensitivity/1.0.1/make-spec.ts";

describe("the specs", () => {
	it("commits the pilot spec exactly as make-spec.ts generates it, and it is valid", () => {
		const committed = JSON.parse(
			readFileSync(new URL("../research/discriminating-tasks/1.0.1/spec-pilot.json", import.meta.url), "utf8"),
		);
		expect(committed).toEqual(JSON.parse(JSON.stringify(pilotSpec())));
		expect(endoExperimentSpecProblemV0(committed)).toBeNull();
		expect(committed.trials).toBe(6);
		expect(committed.tasks).toHaveLength(12);
		expect(committed.conditions).toHaveLength(1);
		expect(committed.conditions[0].extensions).toBeUndefined();
		expect(committed.conditions[0].settings).toBeUndefined();
		expect(committed.manipulation).toBeUndefined();
	});

	it("makes confirmation paths that differ only in id and description, so only the scratch hash varies", () => {
		const ids = ["slot-pack", "ticket-code"];
		const specs = CONFIRM_LABELS.map((label) => confirmationSpec(label, ids));
		for (const spec of specs) expect(endoExperimentSpecProblemV0(spec)).toBeNull();
		const strip = (spec: ReturnType<typeof confirmationSpec>) => ({ ...spec, id: "", description: "" });
		for (const spec of specs) expect(strip(spec)).toEqual(strip(specs[0]!));
		const hashes = [...specs.map(scratchHashOf), scratchHashOf(pilotSpec())];
		expect(new Set(hashes).size).toBe(5);
		expect(specs[0]!.trials).toBe(5);
		expect(specs[0]!.tasks.map((task) => task.id)).toEqual(["slot-pack", "ticket-code"]);
		expect(() => confirmationSpec("c1", ["nope"])).toThrow(/not in the pool/);
		expect(() => confirmationSpec("c1", [])).toThrow(TypeError);
	});
});
