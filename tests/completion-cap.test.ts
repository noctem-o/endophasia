// The pure parts of the completion-cap study (research/completion-cap/1.0.1/): the response reader and the specs.
import { describe, expect, it } from "vitest";
import { endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import {
	ARM_IDS,
	ARMS,
	BRIEF_SENTENCE,
	mainSpec,
	pilotSpec,
	TIMEOUT_MS,
} from "../research/completion-cap/1.0.1/make-spec.ts";
import { parseWireV0 } from "../research/completion-cap/1.0.1/wire.ts";
import { scratchHashOf } from "../research/path-sensitivity/1.0.1/make-spec.ts";

const chunk = (text: string) => {
	const payload = `data: ${text}\n\n`;
	return `${payload.length.toString(16)}\r\n${payload}\r\n`;
};
const wireOf = (
	events: object[],
	head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked",
) => `${head}\r\n\r\n${events.map((event) => chunk(JSON.stringify(event))).join("")}e\r\ndata: [DONE]\n\n\r\n0\r\n\r\n`;

describe("the response reader", () => {
	it("reads the finish reason, usage, timings and the streamed characters of a chunked event stream", () => {
		const wire = wireOf([
			{ choices: [{ finish_reason: null, delta: { role: "assistant", content: null } }] },
			{ choices: [{ finish_reason: null, delta: { reasoning_content: "think" } }] },
			{ choices: [{ finish_reason: null, delta: { reasoning_content: "ing" } }] },
			{ choices: [{ finish_reason: null, delta: { content: "done" } }] },
			{ choices: [{ finish_reason: "length", delta: {} }] },
			{
				choices: [],
				usage: { prompt_tokens: 100, completion_tokens: 16384 },
				timings: { predicted_n: 16384, predicted_ms: 220017.6, prompt_ms: 215.3 },
			},
		]);
		expect(parseWireV0(wire)).toEqual({
			httpStatus: 200,
			finishReason: "length",
			promptTokens: 100,
			completionTokens: 16384,
			predictedTokens: 16384,
			predictedMs: 220017.6,
			promptMs: 215.3,
			reasoningChars: 8,
			contentChars: 4,
		});
	});

	it("reports a tool-call stop, and an error response with no events", () => {
		expect(parseWireV0(wireOf([{ choices: [{ finish_reason: "tool_calls", delta: {} }] }])).finishReason).toBe(
			"tool_calls",
		);
		const error = parseWireV0(
			'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":{"message":"too large"}}',
		);
		expect(error).toMatchObject({ httpStatus: 400, finishReason: null, completionTokens: null, reasoningChars: 0 });
	});

	it("ignores a malformed event and handles an empty wire", () => {
		const wire = `HTTP/1.1 200 OK\r\n\r\ndata: {broken\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: {} }] })}\n\n`;
		expect(parseWireV0(wire).finishReason).toBe("stop");
		expect(parseWireV0("")).toMatchObject({ httpStatus: null, finishReason: null });
	});
});

describe("the specs", () => {
	it("makes a valid pilot with every arm as a condition, a one-hour timeout, and the pinned environment", () => {
		const spec = pilotSpec();
		expect(endoExperimentSpecProblemV0(spec)).toBeNull();
		expect(spec.timeoutMs).toBe(TIMEOUT_MS);
		expect(spec.timeoutMs).toBe(3_600_000);
		expect(spec.conditions.map((condition) => condition.id)).toEqual(ARM_IDS.map((arm) => `arm-${arm}`));
		expect(spec.tasks.map((task) => task.id)).toEqual([
			"booking-conflicts",
			"config-extends",
			"fetch-cache",
			"markup-lite",
		]);
		for (const condition of spec.conditions) expect(condition.environment).toBeDefined();
		expect(spec.manipulation).toBeUndefined();
	});

	it("gives each arm one handler that does what the design says and nothing else", () => {
		expect(ARMS.a.source).toContain("=> undefined");
		expect(ARMS.b.source).toContain("max_completion_tokens: 32768");
		expect(ARMS.c.source).toContain("max_completion_tokens: 49152");
		expect(ARMS.c.cap + 39_779).toBeLessThan(98_304);
		expect(ARMS.d.source).toContain(BRIEF_SENTENCE);
		expect(ARMS.d.source).not.toContain("max_completion_tokens");
		expect(ARMS.e.source).toContain("enable_thinking: false");
		for (const arm of ARM_IDS) expect(ARMS[arm].source).toContain('pi.on("before_provider_request"');
	});

	it("makes main paths that differ only in id and description, with the chosen arms and N", () => {
		const specs = ["c1", "c2", "c3", "c4"].map((label) => mainSpec(label, 4, ["a", "b", "c", "d"]));
		for (const spec of specs) expect(endoExperimentSpecProblemV0(spec)).toBeNull();
		const strip = (spec: ReturnType<typeof mainSpec>) => ({ ...spec, id: "", description: "" });
		for (const spec of specs) expect(strip(spec)).toEqual(strip(specs[0]!));
		expect(new Set([...specs.map(scratchHashOf), scratchHashOf(pilotSpec())]).size).toBe(5);
		expect(specs[0]!.trials).toBe(4);
		expect(specs[0]!.conditions).toHaveLength(4);
		expect(() => mainSpec("Bad Label", 3, ["a"])).toThrow(TypeError);
		expect(() => mainSpec("c1", 0, ["a"])).toThrow(TypeError);
	});
});

import {
	chooseNV0,
	harmFlagV0,
	primaryContrastV0,
	shareV0,
	tIntervalV0,
} from "../research/completion-cap/1.0.1/stats.ts";

const pair = (control: [number, number], arm: [number, number]) => ({
	control: { successes: control[0], counted: control[1] },
	arm: { successes: arm[0], counted: arm[1] },
});

describe("the primary contrast", () => {
	it("is a t interval over the per-path differences", () => {
		// differences .2 .4 .6 .8 -> mean .5, se 0.1290994, t(3) = 3.1824
		const interval = tIntervalV0([0.2, 0.4, 0.6, 0.8]);
		expect(interval?.mean).toBe(0.5);
		expect(interval?.low).toBeCloseTo(0.5 - 3.1824 * 0.1290994, 4);
		expect(tIntervalV0([0.3])).toBeNull();
	});

	it("reads a large, consistent gain as the cap being binding", () => {
		// control 6/10 per path pooled over two tasks, arm 10/10 each path: +0.4 everywhere
		const result = primaryContrastV0([0, 1, 2, 3].map(() => pair([4, 10], [9, 10])));
		expect(result.difference).toBe(0.5);
		expect(result.control).toEqual({ successes: 16, counted: 40 });
		expect(result.arm).toEqual({ successes: 36, counted: 40 });
		expect(result.reading).toBe("cap-binding");
	});

	it("reads no gain as the cap not being the main limit", () => {
		const result = primaryContrastV0([
			pair([5, 10], [6, 10]),
			pair([5, 10], [4, 10]),
			pair([6, 10], [6, 10]),
			pair([4, 10], [5, 10]),
		]);
		expect(result.difference).toBe(0.025);
		expect(result.reading).toBe("cap-not-the-main-limit");
	});

	it("is inconclusive between the two, and when the gain is large but the paths disagree", () => {
		expect(primaryContrastV0([0, 1, 2, 3].map(() => pair([5, 10], [7, 10]))).reading).toBe("inconclusive");
		const noisy = primaryContrastV0([
			pair([2, 10], [10, 10]),
			pair([5, 10], [5, 10]),
			pair([2, 10], [9, 10]),
			pair([6, 10], [6, 10]),
		]);
		expect(noisy.difference).toBeGreaterThanOrEqual(0.25);
		expect(noisy.cluster?.low).toBeLessThanOrEqual(0);
		expect(noisy.reading).toBe("inconclusive");
	});

	it("handles missing counts", () => {
		expect(primaryContrastV0([pair([0, 0], [0, 0])])).toMatchObject({ difference: null, reading: "inconclusive" });
	});
});

describe("the harm flag", () => {
	it("flags a rate 0.20 or more below the control's, exactly", () => {
		expect(harmFlagV0({ successes: 4, counted: 5 }, { successes: 5, counted: 5 })).toBe(true);
		expect(harmFlagV0({ successes: 9, counted: 10 }, { successes: 10, counted: 10 })).toBe(false);
		expect(harmFlagV0({ successes: 8, counted: 10 }, { successes: 10, counted: 10 })).toBe(true);
		expect(harmFlagV0({ successes: 0, counted: 0 }, { successes: 5, counted: 5 })).toBe(false);
	});
});

describe("the choice of N", () => {
	it("takes the largest of 5, 4, 3 within the limit, and null when none fits", () => {
		// 20 cells of 10 minutes each: one round is 200 min; 4 paths x N x 200 min x 1.1 = N x 14.67 h
		const cells = Array.from({ length: 20 }, () => 600_000);
		expect(chooseNV0(cells).n).toBeNull();
		// 20 cells of 2 minutes: 40 min a round; N=5: 4 x 5 x 40 x 1.1 = 880 min = 14.67 h > 14; N=4: 11.7 h
		const small = Array.from({ length: 20 }, () => 120_000);
		expect(chooseNV0(small)).toMatchObject({ n: 4 });
		expect(chooseNV0(small).hours[4]).toBeCloseTo(11.733333, 4);
		expect(chooseNV0(Array.from({ length: 20 }, () => 60_000)).n).toBe(5);
	});

	it("computes a share, and null for an empty whole", () => {
		expect(shareV0(1, 4)).toBe(0.25);
		expect(shareV0(0, 0)).toBeNull();
	});
});

import { cell, classOf, failureModeOf, type TrialV0 } from "../research/completion-cap/1.0.1/analyze.ts";

const passed = {
	ran: true,
	exitCode: 0,
	passed: true,
	timedOut: false,
	output: { keyId: "k", value: "v", bytes: 0 },
} as const;
const failedCheck = { ...passed, exitCode: 1, passed: false } as const;
const record = (patch: Record<string, unknown> = {}) =>
	({ status: "completed", error: null, check: passed, notes: [], ...patch }) as unknown as Parameters<
		typeof classOf
	>[0];

describe("how a trial is classified", () => {
	const none = { cutOffResponses: 0, httpErrors: 0 };
	it("orders the failure modes as the design lists them", () => {
		expect(failureModeOf({ cutOffResponses: 1, didNotFinish: true, httpErrors: 1 })).toBe("cut-off");
		expect(failureModeOf({ cutOffResponses: 0, didNotFinish: true, httpErrors: 1 })).toBe("session-did-not-finish");
		expect(failureModeOf({ cutOffResponses: 0, didNotFinish: false, httpErrors: 1 })).toBe("server-error");
		expect(failureModeOf({ cutOffResponses: 0, didNotFinish: false, httpErrors: 0 })).toBe("wrong-result");
	});

	it("is a success when the check passed, even after a cut-off response", () => {
		expect(classOf(record(), [], { cutOffResponses: 2, httpErrors: 0 })).toEqual({ kind: "success" });
	});

	it("is a cut-off failure, a did-not-finish failure, an error or an invalid trial", () => {
		expect(classOf(record({ check: failedCheck }), [], { cutOffResponses: 1, httpErrors: 0 })).toEqual({
			kind: "failure",
			mode: "cut-off",
		});
		expect(
			classOf(record({ check: failedCheck, notes: ["agent_settled was not observed after step 1"] }), [], none),
		).toEqual({
			kind: "failure",
			mode: "session-did-not-finish",
		});
		expect(classOf(record({ status: "error", error: "boom" }), [], none)).toEqual({ kind: "error", error: "boom" });
		expect(classOf(record(), ["marker"], none)).toEqual({ kind: "invalid", reasons: ["marker"] });
	});
});

describe("the cell of an arm and a task", () => {
	const trial = (arm: TrialV0["arm"], n: number, kind: TrialV0["class"], patch: Partial<TrialV0> = {}): TrialV0 => ({
		task: "t",
		arm,
		trial: n,
		class: kind,
		wallMs: 1000,
		toolCalls: 3,
		responses: 2,
		cutOffResponses: 0,
		httpErrors: 0,
		outputTokens: 100,
		peakPromptTokens: 500,
		generationMs: 900,
		reasoningChars: 30,
		contentChars: 10,
		outsideMentions: 0,
		injectedProblems: [],
		samplingFields: [],
		workspaceProblems: [],
		systemText: null,
		toolsDigest: null,
		...patch,
	});

	it("counts, shares and per-success costs", () => {
		const trials = [
			trial("b", 0, { kind: "success" }),
			trial("b", 1, { kind: "failure", mode: "cut-off" }, { cutOffResponses: 1, outputTokens: 300 }),
			trial("b", 2, { kind: "failure", mode: "wrong-result" }),
			trial("b", 3, { kind: "invalid", reasons: ["x"] }),
			trial("a", 0, { kind: "success" }),
		];
		const result = cell("b", "t", trials, 5);
		expect(result).toMatchObject({
			counted: 3,
			successes: 1,
			invalid: 1,
			errors: 1,
			unmeasured: true,
			failureModes: { "cut-off": 1, "wrong-result": 1 },
			cutOffTrialShare: 0.25,
			reasoningShare: 0.75,
			outputTokensPerSuccess: 600,
			wallMsPerSuccess: 4000,
		});
	});
});
