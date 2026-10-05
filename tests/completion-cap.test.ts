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
