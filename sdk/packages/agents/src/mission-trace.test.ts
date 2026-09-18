// Mission Trace v0 — deterministic projection tests.
//
// These tests exercise the projection pipeline:
//   AgentRuntimeEvent  ->  MissionTraceProjectorV0  ->  MissionTraceEventV0
//                                                        ->  MissionTraceSinkV0
//
// They also verify behavioral neutrality: adding a trace attachment does not
// change the runtime result, and that multiple sequential runs are all traced.

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./index";
import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
	AgentRuntimeStateSnapshot,
	AgentRunResult,
	AgentUsage,
	AgentMessage,
	AgentModelFinishReason,
	ProviderErrorClass,
} from "@cline/shared";
import {
	MissionTraceProjectorV0,
	MissionTraceSinkV0,
	attachMissionTraceV0,
	isMissionTraceEventV0,
	missionTraceEventKind,
	type MissionTraceAttachment,
	type MissionTraceEventV0,
	type MissionTraceEventV0Started,
	type MissionTraceEventV0TurnStarted,
	type MissionTraceEventV0TurnFinished,
	type MissionTraceEventV0Completed,
	type MissionTraceEventV0ModelCompleted,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed an array of events into a projector and return the collected trace. */
function projectEvents(events: AgentRuntimeEvent[]): readonly MissionTraceEventV0[] {
	const projector = new MissionTraceProjectorV0();
	const sink = new MissionTraceSinkV0();
	for (const event of events) {
		const projected = projector.project(event);
		if (projected !== undefined) {
			sink.append(projected);
		}
	}
	return sink.snapshot().events;
}

/** Pretty-print an event's kind + sequence for diagnostics. */
function eventTag(e: MissionTraceEventV0): string {
	return `${e.kind.padEnd(27)}seq=${e.sequence}`;
}

/** Synthetic snapshot for hand-crafted test events. */
function snapshot(
	agentId = "a",
	runId = "r",
	conversationId?: string,
	iteration = 1,
): AgentRuntimeStateSnapshot {
	return {
		agentId,
		runId,
		conversationId,
		status: "running" as const,
		iteration,
		messages: [] as AgentMessage[],
		pendingToolCalls: [] as string[],
		usage: usage(),
	};
}

const SNAP = snapshot();

/** A valid `AgentUsage` (all of `AgentTokenUsage` is required). */
function usage(inputTokens = 0, outputTokens = 0): AgentUsage {
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}

/** Factory for assistant-message events with proper typing. */
function assistantMessage(
	snap: AgentRuntimeStateSnapshot,
	iteration: number,
	finishReason: AgentModelFinishReason,
	message: AgentMessage,
): AgentRuntimeEvent {
	return {
		type: "assistant-message",
		snapshot: snap,
		iteration,
		message,
		finishReason,
	};
}

/** Factory for run-finished events with proper AgentRunResult typing. */
function runFinished(
	snap: AgentRuntimeStateSnapshot,
	status: "completed" | "aborted" | "failed",
	iterations: number,
	outputText = "",
): AgentRuntimeEvent {
	return {
		type: "run-finished",
		snapshot: snap,
		result: {
			agentId: snap.agentId,
			runId: snap.runId ?? "r",
			status,
			iterations,
			outputText,
			messages: [],
			usage: usage(),
		} as AgentRunResult,
	};
}

// ---------------------------------------------------------------------------
// Scripted model — mirrors the pattern from agent-runtime.test.ts
// ---------------------------------------------------------------------------

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	public steps: Array<(request: AgentModelRequest) => AsyncIterable<AgentModelEvent>> = [];

	constructor(rawSteps: Array<(request: AgentModelRequest) => AsyncIterable<AgentModelEvent>>) {
		this.steps = rawSteps;
	}

	async stream(request: AgentModelRequest): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted model step available");
		}
		return step(request);
	}
}

// Sync-to-async iterable adapter (used in tests)
function syncToAsync<T>(items: T[]): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const item of items) {
				yield item as T;
			}
		},
	};
}

/** Delayed sync-to-async — yields each item with a pause, for testing abort timing. */
function delayedAsync<T>(items: T[], delayMs = 20): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const item of items) {
				await new Promise((r) => setTimeout(r, delayMs));
				yield item as T;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// A. Simple completion (focused projector unit test)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — A. Simple completion", () => {
	it("projects the expected semantic sequence for a clean completion", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			runFinished(SNAP, "completed", 1, "ok"),
		];

		const trace = projectEvents(events);

		expect(trace).toHaveLength(5);
		expect(trace.map(eventTag)).toEqual([
			"mission.started            seq=1",
			"turn.started               seq=2",
			"model.completed            seq=3",
			"turn.finished              seq=4",
			"mission.completed          seq=5",
		]);
	});
});

// ---------------------------------------------------------------------------
// A2. "Missing stays missing" — correlation IDs are never fabricated
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — A2. missing correlation IDs stay missing", () => {
	// The v0 contract (types.ts / projector.ts) says correlation IDs are
	// reused from the runtime snapshot only when they already exist —
	// "Missing stays missing." Every event in the runtime carries a snapshot,
	// so we build snapshots with runId / conversationId omitted and assert the
	// projected events carry them as `undefined` (not a fabricated default).
	const bareSnapshot: AgentRuntimeStateSnapshot = {
		...SNAP,
		runId: undefined,
		conversationId: undefined,
	};

	it("leaves runId and conversationId absent when the snapshot does not carry them", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: bareSnapshot },
			{ type: "turn-started", snapshot: bareSnapshot, iteration: 1 },
			assistantMessage(bareSnapshot, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: bareSnapshot, iteration: 1, toolCallCount: 0 },
			runFinished(bareSnapshot, "completed", 1),
		];

		const trace = projectEvents(events);
		const missionStarted = trace.find((e) => e.kind === "mission.started") as MissionTraceEventV0Started;
		const turnStarted = trace.find((e) => e.kind === "turn.started") as MissionTraceEventV0TurnStarted;
		const modelCompleted = trace.find((e) => e.kind === "model.completed") as MissionTraceEventV0ModelCompleted;
		const turnFinished = trace.find((e) => e.kind === "turn.finished") as MissionTraceEventV0TurnFinished;
		const missionCompleted = trace.find((e) => e.kind === "mission.completed") as MissionTraceEventV0Completed;

		// agentId is always present (required on the snapshot); runId /
		// conversationId are absent from the snapshot and must stay absent.
		[
			missionStarted,
			turnStarted,
			modelCompleted,
			turnFinished,
			missionCompleted,
		].forEach((event) => {
			expect(event.agentId).toBe("a");
			expect(event.runId).toBeUndefined();
			expect(event.conversationId).toBeUndefined();
		});
	});
});

describe("MissionTraceV0 — B. Local tool execution", () => {
	it("traces a real turn with a local tool call through the runtime", async () => {
		const echoTool = {
			name: "echo",
			description: "Echo input text",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
			async execute(input: { text: string }) {
				return { echoed: input.text };
			},
		};

		const model = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "use the echo tool" },
				{
					type: "tool-call-delta",
					toolCallId: "tc1",
					toolName: "echo",
					inputText: '{"text":"hello"}',
				},
				{ type: "finish", reason: "tool-calls" },
			]),
			// After tool execution, model continues
			() => syncToAsync([
				{ type: "text-delta", text: "the answer is done" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		const runtime = new AgentRuntime({ model, tools: [echoTool] });
		const attachment = attachMissionTraceV0(runtime);

		const result = await runtime.run("Hi");

		// Detach to stop tracing
		attachment.detach();

		const trace = attachment.sink.snapshot().events;

		// Must have traced both turn lifecycles
		const kinds = trace.map((e) => e.kind);

		// First turn: mission.started, turn.started, model.completed (tool-calls),
		// tool.started, tool.finished, turn.finished
		// Second turn: turn.started, model.completed (stop), turn.finished
		// Terminal: mission.completed
		expect(kinds).toContain("mission.started");
		expect(kinds).toContain("turn.started");
		expect(kinds).toContain("model.completed");
		expect(kinds).toContain("tool.started");
		expect(kinds).toContain("tool.finished");
		expect(kinds).toContain("turn.finished");
		expect(kinds).toContain("mission.completed");

		// Both turn.started events must be present (two turns)
		const turnStartedCount = trace.filter((e) => e.kind === "turn.started").length;
		expect(turnStartedCount).toBe(2);

		// Sequence must be contiguous
		for (let i = 0; i < trace.length; i++) {
			expect(trace[i].sequence).toBe(i + 1);
		}

		// Result must be correct
		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(2);
		expect(result.outputText).toContain("the answer is done");
	});
});

// ---------------------------------------------------------------------------
// C. Failure — real model failure via error thrown during stream
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — C. Failure", () => {
	it("traces a deterministic model failure", async () => {
		const failingModel = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "about to crash" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		// Make the model throw on its first call by wrapping the stream
		const runtime = new AgentRuntime({
			model: {
				...failingModel,
				async stream() {
					throw new Error("model crashed");
				},
			},
		});
		const attachment = attachMissionTraceV0(runtime);

		const result = await runtime.run("Hi");
		attachment.detach();

		const trace = attachment.sink.snapshot().events;
		const kinds = trace.map((e) => e.kind);

		// Must have mission.failed terminal, not mission.completed
		expect(kinds).toContain("mission.started");
		expect(kinds).toContain("mission.failed");
		expect(kinds).not.toContain("mission.completed");
		expect(kinds).not.toContain("mission.aborted");

		// Sequence contiguous
		for (let i = 0; i < trace.length; i++) {
			expect(trace[i].sequence).toBe(i + 1);
		}

		// Result status must be failed
		expect(result.status).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// D. Abort — controlled abort via runtime.abort()
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — D. Abort", () => {
	it("traces a controlled abort", async () => {
				const abortModel = new ScriptedModel([
					() => delayedAsync([
						{ type: "text-delta", text: "starting" },
						{ type: "finish", reason: "stop" },
					], 30), // delay so abort() can fire before model finishes
				]);

		const runtime = new AgentRuntime({ model: abortModel });
		const attachment = attachMissionTraceV0(runtime);

		const runPromise = runtime.run("Hi");

		// Abort while the model is streaming
		await new Promise((r) => setTimeout(r, 10));
		runtime.abort("user cancelled");

		const result = await runPromise;
		attachment.detach();

		const trace = attachment.sink.snapshot().events;
		const kinds = trace.map((e) => e.kind);

		// Must have mission.aborted terminal, not completed/failed
		expect(kinds).toContain("mission.started");
		expect(kinds).toContain("mission.aborted");
		expect(kinds).not.toContain("mission.completed");
		expect(kinds).not.toContain("mission.failed");

		// Sequence contiguous
		for (let i = 0; i < trace.length; i++) {
			expect(trace[i].sequence).toBe(i + 1);
		}

		// Result status must be aborted
		expect(result.status).toBe("aborted");
	});
});

// ---------------------------------------------------------------------------
// E. Reasoning privacy (focused projector unit test)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — E. Reasoning privacy", () => {
	it("ignores assistant-reasoning-delta and emits no reasoning text in the trace", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			{
				type: "assistant-reasoning-delta",
				snapshot: SNAP,
				iteration: 1,
				text: "secret reasoning content",
				accumulatedText: "secret reasoning content",
			},
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			runFinished(SNAP, "completed", 1, "ok"),
		];

		const trace = projectEvents(events);

		// Should have exactly 5 projected events (reasoning delta is ignored)
		expect(trace).toHaveLength(5);

		// No event should contain the reasoning text
		for (const ev of trace) {
			const json = JSON.stringify(ev);
			expect(json).not.toContain("secret reasoning content");
		}

		// The reasoning event consumed no sequence number
		expect(trace.map(eventTag)).toEqual([
			"mission.started            seq=1",
			"turn.started               seq=2",
			"model.completed            seq=3",
			"turn.finished              seq=4",
			"mission.completed          seq=5",
		]);
	});
});

// ---------------------------------------------------------------------------
// F. Determinism (focused projector unit test)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — F. Determinism", () => {
	it("gives deep-equal trace for the same ordered event sequence through two fresh projectors", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			runFinished(SNAP, "completed", 1, "ok"),
		];

		const traceA = projectEvents(events);
		const traceB = projectEvents(events);

		expect(traceA).toEqual(traceB);
	});
});

// ---------------------------------------------------------------------------
// G. Sequence semantics (focused projector unit test)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — G. Sequence semantics", () => {
	it("starts at 1, increments by exactly 1 per projected event, and ignored events create no gaps", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "message-added", snapshot: SNAP, message: { role: "user", id: "m1", content: [], createdAt: 0 } },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			{
				type: "assistant-text-delta",
				snapshot: SNAP,
				iteration: 1,
				text: "partial",
				accumulatedText: "partial",
			},
			{
				type: "tool-updated",
				snapshot: SNAP,
				iteration: 1,
				toolCall: { toolCallId: "tc1", toolName: "x", type: "tool-call", input: {} },
			},
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{
				type: "usage-updated",
				snapshot: SNAP,
				usage: usage(100, 0),
			},
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			{
				type: "status-notice",
				snapshot: SNAP,
				message: "something",
			},
			runFinished(SNAP, "completed", 1, "ok"),
		];

		const trace = projectEvents(events);

		// 5 projected events (started, turn, message, finished, completed)
		expect(trace).toHaveLength(5);
		for (let i = 0; i < trace.length; i++) {
			expect(trace[i].sequence).toBe(i + 1);
		}
		expect(trace.map(eventTag)).toEqual([
			"mission.started            seq=1",
			"turn.started               seq=2",
			"model.completed            seq=3",
			"turn.finished              seq=4",
			"mission.completed          seq=5",
		]);
	});
});

// ---------------------------------------------------------------------------
// H. Detach (real AgentRuntime execution)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — H. Detach", () => {
	it("stops projecting after detach is called", async () => {
		const model = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "hello" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		const runtime = new AgentRuntime({ model });

		const attachment: MissionTraceAttachment = attachMissionTraceV0(runtime);

		// Run once — events flow through and land in the sink.
		await runtime.run("Hi");

		// At this point the sink should contain the trace from the first run.
		const afterFirstRun = attachment.sink.snapshot();
		expect(afterFirstRun.events.length).toBeGreaterThan(0);

		// Detach — subsequent events should NOT reach the sink.
		attachment.detach();

		// Run a second time with a fresh scripted step.
		model.steps.push(
			() => syncToAsync([
				{ type: "text-delta", text: "second run" },
				{ type: "finish", reason: "stop" },
			]),
		);
		await runtime.run("Hi again");

		// The sink should be unchanged — detach prevented new events.
		const afterSecondRun = attachment.sink.snapshot();
		expect(afterSecondRun).toEqual(afterFirstRun);
	});
});

// ---------------------------------------------------------------------------
// I. Behavioral neutrality (real AgentRuntime execution)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — I. Behavioral neutrality", () => {
	it("does not alter the runtime result with or without a trace attachment", async () => {
		// Use separate models so each runtime has its own steps.
		const modelNoTrace = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "untraced answer" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		const modelWithTrace = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "untraced answer" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		// Runtime WITHOUT trace
		const runtimeNoTrace = new AgentRuntime({ model: modelNoTrace });

		// Runtime WITH trace
		const runtimeWithTrace = new AgentRuntime({ model: modelWithTrace });
		attachMissionTraceV0(runtimeWithTrace);

		const resultNoTrace = await runtimeNoTrace.run("Hi");
		const resultWithTrace = await runtimeWithTrace.run("Hi");

		// Both should complete successfully with the same status and iterations
		expect(resultNoTrace.status).toBe("completed");
		expect(resultWithTrace.status).toBe("completed");
		expect(resultNoTrace.iterations).toBe(1);
		expect(resultWithTrace.iterations).toBe(1);

		// The output text should be identical
		expect(resultNoTrace.outputText).toBe("untraced answer");
		expect(resultWithTrace.outputText).toBe("untraced answer");
	});
});

// ---------------------------------------------------------------------------
// J. Regression: multiple sequential runs with persistent attachment
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — J. Multiple sequential runs", () => {
	it("traces two separate runs without detaching, with contiguous sequence", async () => {
		const model = new ScriptedModel([
			() => syncToAsync([
				{ type: "text-delta", text: "first run answer" },
				{ type: "finish", reason: "stop" },
			]),
			() => syncToAsync([
				{ type: "text-delta", text: "second run answer" },
				{ type: "finish", reason: "stop" },
			]),
		]);

		const runtime = new AgentRuntime({ model });
		const attachment = attachMissionTraceV0(runtime);

		// First run
		await runtime.run("Hi");
		const afterFirst = attachment.sink.snapshot();
		const firstTerminal = afterFirst.events.filter(
			(e) => e.kind === "mission.completed",
		);
		expect(firstTerminal).toHaveLength(1);

		// Second run — same attachment, no detach
		await runtime.run("Hi again");
		const afterSecond = attachment.sink.snapshot();
		const secondTerminal = afterSecond.events.filter(
			(e) => e.kind === "mission.completed",
		);
		expect(secondTerminal).toHaveLength(2); // two terminals total now

		// Both lifecycles must be present
		const kinds = afterSecond.events.map((e) => e.kind);
		expect(kinds.filter((k) => k === "mission.started").length).toBe(2);
		expect(kinds.filter((k) => k === "mission.completed").length).toBe(2);
		expect(kinds.filter((k) => k === "turn.started").length).toBe(2);
		expect(kinds.filter((k) => k === "model.completed").length).toBe(2);
		expect(kinds.filter((k) => k === "turn.finished").length).toBe(2);

		// Sequence must be contiguous across both runs
		for (let i = 0; i < afterSecond.events.length; i++) {
			expect(afterSecond.events[i].sequence).toBe(i + 1);
		}

		// Second run is not silently discarded — its terminal is at the end
		const lastEvent = afterSecond.events[afterSecond.events.length - 1];
		expect(lastEvent.kind).toBe("mission.completed");
		expect(lastEvent.sequence).toBe(afterSecond.events.length);
	});
});

// ---------------------------------------------------------------------------
// K. run-finished "failed" status mapping
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — K. run-finished failed status", () => {
	it("projects mission.failed for run-finished with status failed", () => {
		const snapFailed: AgentRuntimeStateSnapshot = {
			...SNAP,
			status: "failed",
			lastErrorClass: "context_window_exceeded" as ProviderErrorClass,
		};

		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			{
				type: "run-finished",
				snapshot: snapFailed,
				result: {
					agentId: "a",
					runId: "r",
					status: "failed",
					iterations: 1,
					outputText: "",
					messages: [],
					usage: usage(),
					error: new Error("context window"),
				} as AgentRunResult,
			},
		];

		const trace = projectEvents(events);

		expect(trace).toHaveLength(5);
				expect(trace[trace.length - 1]).toMatchObject({
					kind: "mission.failed",
					errorClass: "context_window_exceeded", // projector uses snapshot.lastErrorClass
				});
		expect(trace.some((e) => e.kind === "mission.completed")).toBeFalsy();
	});

	it("projects mission.failed for run-failed event with errorClass", () => {
		const snap: AgentRuntimeStateSnapshot = {
			...SNAP,
			status: "failed",
			lastErrorClass: "context_window_exceeded" as ProviderErrorClass,
		};

		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			{
				type: "run-failed",
				snapshot: snap,
				error: new Error("context window"),
				errorClass: "context_window_exceeded",
			},
		];

		const trace = projectEvents(events);

		expect(trace).toHaveLength(5);
		expect(trace[trace.length - 1]).toMatchObject({
			kind: "mission.failed",
			iterations: 1,
			errorClass: "context_window_exceeded",
		});
	});
});

// ---------------------------------------------------------------------------
// L. modelId / providerId propagation
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — L. modelId / providerId propagation", () => {
	it("copies modelInfo.id and modelInfo.provider verbatim when the runtime tagged the message", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: { id: "anthropic/claude-sonnet-4", provider: "anthropic" },
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			runFinished(SNAP, "completed", 1),
		];

		const trace = projectEvents(events);
		const modelCompleted = trace.find((e) => e.kind === "model.completed") as MissionTraceEventV0ModelCompleted;
		expect(modelCompleted.modelId).toBe("anthropic/claude-sonnet-4");
		expect(modelCompleted.providerId).toBe("anthropic");
	});

	it("leaves modelId and providerId absent when the runtime did not tag the message", () => {
		const events: AgentRuntimeEvent[] = [
			{ type: "run-started", snapshot: SNAP },
			{ type: "turn-started", snapshot: SNAP, iteration: 1 },
			assistantMessage(SNAP, 1, "stop", {
				role: "assistant",
				id: "msg-1",
				content: [],
				createdAt: 0,
				modelInfo: undefined,
			}),
			{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
			runFinished(SNAP, "completed", 1),
		];

		const trace = projectEvents(events);
		const modelCompleted = trace.find((e) => e.kind === "model.completed") as MissionTraceEventV0ModelCompleted;
		expect(modelCompleted.modelId).toBeUndefined();
		expect(modelCompleted.providerId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// M. model.completed finishReason coverage
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — M. model.completed finishReason coverage", () => {
	// The v0 contract copies finishReason verbatim for every enum value, so
	// each of the five AgentModelFinishReason values must round-trip intact.
	const finishReasons: readonly AgentModelFinishReason[] = ["stop", "tool-calls", "max-tokens", "aborted", "error"];

	for (const finishReason of finishReasons) {
		it(`copies finishReason "${finishReason}" verbatim`, () => {
			const events: AgentRuntimeEvent[] = [
				{ type: "run-started", snapshot: SNAP },
				{ type: "turn-started", snapshot: SNAP, iteration: 1 },
				assistantMessage(SNAP, 1, finishReason, {
					role: "assistant",
					id: "msg-1",
					content: [],
					createdAt: 0,
				}),
				{ type: "turn-finished", snapshot: SNAP, iteration: 1, toolCallCount: 0 },
				runFinished(SNAP, "completed", 1),
			];

			const trace = projectEvents(events);
			const modelCompleted = trace.find((e) => e.kind === "model.completed") as MissionTraceEventV0ModelCompleted;
			expect(modelCompleted.finishReason).toBe(finishReason);
		});
	}
});

// ---------------------------------------------------------------------------
// N. type guards (isMissionTraceEventV0 / missionTraceEventKind)
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — N. type guards", () => {
	it("accepts a valid event and rejects malformed or out-of-vocabulary events", () => {
		const valid: MissionTraceEventV0 = {
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.started",
			agentId: "a",
			runId: "r",
		};
		expect(isMissionTraceEventV0(valid)).toBe(true);
		expect(missionTraceEventKind(valid)).toBe("mission.started");

		// A kind that is present but not one of the ten schema-valid literals
		// must be rejected, even though schemaVersion, sequence, and kind
		// presence are otherwise correct.
		const bogusKind: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.bogus",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(bogusKind)).toBe(false);
		expect(missionTraceEventKind(bogusKind)).toBeNull();

		// Wrong schema version.
		const wrongVersion: unknown = {
			schemaVersion: "mission-trace.v1",
			sequence: 1,
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(wrongVersion)).toBe(false);

		// Missing (non-numeric) sequence.
		const badSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: "1",
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(badSequence)).toBe(false);

		// Missing sequence entirely.
		const noSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(noSequence)).toBe(false);

		// Missing (required) correlation identity.
		const noAgentId: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.started",
		};
		expect(isMissionTraceEventV0(noAgentId)).toBe(false);

		// Out-of-range / non-integer sequence values are rejected.
		const zeroSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: 0,
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(zeroSequence)).toBe(false);
		const negativeSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: -1,
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(negativeSequence)).toBe(false);
		const fractionalSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: 1.5,
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(fractionalSequence)).toBe(false);
		const nanSequence: unknown = {
			schemaVersion: "mission-trace.v0",
			sequence: NaN,
			kind: "mission.started",
			agentId: "a",
		};
		expect(isMissionTraceEventV0(nanSequence)).toBe(false);

		// Non-object inputs.
		expect(isMissionTraceEventV0(null)).toBe(false);
		expect(isMissionTraceEventV0("mission-trace.v0")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// N2. type guards — incomplete kind-specific payloads are rejected
// ---------------------------------------------------------------------------

describe("MissionTraceV0 — N2. incomplete kind-specific events are rejected", () => {
	// The guard must validate the full per-kind shape, not just the common
	// envelope (schemaVersion, kind, agentId, sequence). A value carrying only
	// the envelope must be rejected for any kind whose member requires
	// additional fields, while kind-specific optional fields (modelId,
	// providerId, runId, conversationId, errorClass) must NOT be required.

	const envelope = {
		schemaVersion: "mission-trace.v0",
		sequence: 1,
		agentId: "a",
	};

	it("rejects an envelope-only value for kinds with required kind-specific fields", () => {
		// turn.started requires iteration.
		expect(isMissionTraceEventV0({ ...envelope, kind: "turn.started" })).toBe(false);
		// model.completed requires iteration + finishReason.
		expect(isMissionTraceEventV0({ ...envelope, kind: "model.completed" })).toBe(false);
		// tool.started requires iteration + toolCallId + toolName.
		expect(isMissionTraceEventV0({ ...envelope, kind: "tool.started" })).toBe(false);
		// tool.finished requires iteration + toolCallId + toolName.
		expect(isMissionTraceEventV0({ ...envelope, kind: "tool.finished" })).toBe(false);
		// turn.finished requires iteration + toolCallCount.
		expect(isMissionTraceEventV0({ ...envelope, kind: "turn.finished" })).toBe(false);
		// mission.completed requires iterations.
		expect(isMissionTraceEventV0({ ...envelope, kind: "mission.completed" })).toBe(false);
		// mission.aborted requires iterations.
		expect(isMissionTraceEventV0({ ...envelope, kind: "mission.aborted" })).toBe(false);
		// mission.failed requires iterations.
		expect(isMissionTraceEventV0({ ...envelope, kind: "mission.failed" })).toBe(false);
	});

	it("rejects model.completed with a valid iteration but missing/invalid finishReason", () => {
		// Missing finishReason entirely.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "model.completed", iteration: 1 }),
		).toBe(false);
		// finishReason present but not one of the valid literals.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "model.completed",
				iteration: 1,
				finishReason: "bogus-reason",
			}),
		).toBe(false);
		// finishReason present but wrong type.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "model.completed",
				iteration: 1,
				finishReason: 3,
			}),
		).toBe(false);
		// finishReason present but NaN (non-finite number).
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "model.completed",
				iteration: 1,
				finishReason: NaN,
			}),
		).toBe(false);
	});

	it("rejects numeric kind-specific fields that are non-finite", () => {
		// turn.started with NaN iteration.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "turn.started", iteration: NaN }),
		).toBe(false);
		// mission.completed with Infinity iterations.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "mission.completed",
				iterations: Infinity,
			}),
		).toBe(false);
		// tool.started with a non-string toolCallId.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "tool.started",
				iteration: 1,
				toolCallId: 42,
				toolName: "echo",
			}),
		).toBe(false);
	});

	it("accepts full kind-specific payloads (validating that the guard is not over-strict)", () => {
		// mission.started needs only the envelope.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "mission.started" }),
		).toBe(true);
		// turn.started with its required iteration.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "turn.started",
				iteration: 1,
			}),
		).toBe(true);
		// model.completed with iteration + finishReason (optional modelId/providerId
		// intentionally omitted).
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "model.completed",
				iteration: 1,
				finishReason: "stop",
			}),
		).toBe(true);
		// model.completed with optional metadata present.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "model.completed",
				iteration: 1,
				finishReason: "tool-calls",
				modelId: "claude-sonnet",
				providerId: "anthropic",
			}),
		).toBe(true);
		// tool.started with all required fields.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "tool.started",
				iteration: 1,
				toolCallId: "tc1",
				toolName: "echo",
			}),
		).toBe(true);
		// tool.finished.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "tool.finished",
				iteration: 1,
				toolCallId: "tc1",
				toolName: "echo",
			}),
		).toBe(true);
		// turn.finished.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "turn.finished",
				iteration: 1,
				toolCallCount: 2,
			}),
		).toBe(true);
		// mission.completed.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "mission.completed", iterations: 3 }),
		).toBe(true);
		// mission.aborted.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "mission.aborted", iterations: 2 }),
		).toBe(true);
		// mission.failed with optional errorClass omitted.
		expect(
			isMissionTraceEventV0({ ...envelope, kind: "mission.failed", iterations: 4 }),
		).toBe(true);
		// mission.failed with errorClass present.
		expect(
			isMissionTraceEventV0({
				...envelope,
				kind: "mission.failed",
				iterations: 4,
				errorClass: "context_window_exceeded",
			}),
		).toBe(true);
	});

	it("returns the correct kind for a complete event and null for an incomplete one", () => {
		const complete: MissionTraceEventV0 = {
			...envelope,
			kind: "model.completed",
			iteration: 1,
			finishReason: "stop",
		};
		expect(missionTraceEventKind(complete)).toBe("model.completed");
		// Incomplete model.completed (missing finishReason) → null.
		expect(missionTraceEventKind({ ...envelope, kind: "model.completed", iteration: 1 })).toBe(
			null,
		);
	});
});

describe("MissionTraceV0 — O. sink snapshot copy-isolation", () => {
	it("snapshot().events is a fresh copy — mutating it does not affect the sink", () => {
		const sink = new MissionTraceSinkV0();
		const first: MissionTraceEventV0 = {
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.started",
			agentId: "a",
			runId: "r",
		};
		sink.append(first);

		const snap = sink.snapshot();
		// Mutating the returned array must not grow the sink's internal state.
		snap.events.push({
			schemaVersion: "mission-trace.v0",
			sequence: 2,
			kind: "mission.completed",
			agentId: "a",
			runId: "r",
			iterations: 1,
		});

		expect(sink.snapshot().count).toBe(1);
	});

	it("reports isEmpty true before any append and false after", () => {
		const sink = new MissionTraceSinkV0();
		expect(sink.isEmpty).toBe(true);
		sink.append({
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.started",
			agentId: "a",
			runId: "r",
		});
		expect(sink.isEmpty).toBe(false);
	});

	it("snapshot() shares no object identity — mutating a snapshot event does not affect the sink", () => {
		const sink = new MissionTraceSinkV0();
		sink.append({
			schemaVersion: "mission-trace.v0",
			sequence: 1,
			kind: "mission.started",
			agentId: "a",
			runId: "r",
		});

		const snap = sink.snapshot();
		// Mutating a snapshot event must not rewrite the sink's internal event.
		snap.events[0].sequence = 999;
		snap.events[0].agentId = "hijacked";
		expect(sink.snapshot().events[0].sequence).toBe(1);
		expect(sink.snapshot().events[0].agentId).toBe("a");
	});
});
