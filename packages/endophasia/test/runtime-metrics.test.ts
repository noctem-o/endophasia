import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Provider,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
	type HarnessEventType,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessClosed } from "../../agent/src/harness/result.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session, SessionStats } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import {
	attachMissionTraceV0,
	captureContinuityV0,
	captureRuntimeMetricsV0,
	captureSessionOverviewV0,
	captureSteeringStateV0,
	queueFollowUpV0,
	stopV0,
} from "../src/index.ts";

const sessions: Session[] = [];

const ALL_EVENT_TYPES: HarnessEventType[] = [
	"compaction_end",
	"compaction_start",
	"config_update",
	"entry_added",
	"fault",
	"handler_error",
	"lane_created",
	"message_end",
	"message_start",
	"message_update",
	"navigation_end",
	"navigation_start",
	"operation_abort",
	"queue_update",
	"retry_end",
	"retry_scheduled",
	"retry_start",
	"run_end",
	"run_resume",
	"run_start",
	"run_suspend",
	"tool_end",
	"tool_start",
	"tool_update",
	"turn_end",
	"turn_start",
	"usage",
	"value_update",
];

/** Costs are exact binary fractions so expected sums compare exactly. */
function usage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	totalTokens: number,
	cost: [number, number, number, number, number],
	extra: { cacheWrite1h?: number; reasoning?: number } = {},
): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...extra,
		totalTokens,
		cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: cost[3], total: cost[4] },
	};
}

function sum(...rows: Usage[]): RuntimeUsage {
	return rows.reduce<RuntimeUsage>(
		(total, row) => ({
			input: total.input + row.input,
			output: total.output + row.output,
			cacheRead: total.cacheRead + row.cacheRead,
			cacheWrite: total.cacheWrite + row.cacheWrite,
			totalTokens: total.totalTokens + row.totalTokens,
			cost: {
				input: total.cost.input + row.cost.input,
				output: total.cost.output + row.cost.output,
				cacheRead: total.cost.cacheRead + row.cost.cacheRead,
				cacheWrite: total.cost.cacheWrite + row.cost.cacheWrite,
				total: total.cost.total + row.cost.total,
			},
		}),
		usage(0, 0, 0, 0, 0, [0, 0, 0, 0, 0]),
	);
}

type RuntimeUsage = Awaited<ReturnType<typeof captureRuntimeMetricsV0>>["usage"];

/** Faux provider whose settled responses report exact queued usage instead of its token estimate. */
function exactUsageProvider(faux: ReturnType<typeof fauxProvider>, queue: Usage[]): Provider {
	const patch = (inner: AssistantMessageEventStream): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					const reported = queue.shift();
					if (reported === undefined) throw new Error("Unexpected provider request without queued usage");
					if (event.type === "done") outer.push({ ...event, message: { ...event.message, usage: reported } });
					else outer.push({ ...event, error: { ...event.error, usage: reported } });
				} else {
					outer.push(event);
				}
			}
			outer.end();
		})();
		return outer;
	};
	return createProvider({
		id: faux.provider.id,
		auth: faux.provider.auth,
		models: faux.models,
		api: {
			stream: (model, context, options) => patch(faux.provider.stream(model, context, options)),
			streamSimple: (model, context, options) => patch(faux.provider.streamSimple(model, context, options)),
		},
	});
}

async function fixture(options: { tools?: AgentHarnessTool<undefined>[]; retries?: number } = {}): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	reported: Usage[];
}> {
	const session = new StorageBackedSession(
		{ id: `runtime-metrics-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const reported: Usage[] = [];
	const models = createModels();
	models.setProvider(exactUsageProvider(faux, reported));
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			tools: options.tools ?? [],
			retry: { enabled: options.retries !== undefined, maxRetries: options.retries ?? 0, baseDelayMs: 0 },
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux, reported };
}

async function rawStats(lane: AgentLane): Promise<SessionStats> {
	const watch = await lane.watch(BACKGROUND_CONTEXT);
	try {
		return structuredClone(watch.snapshot.stats);
	} finally {
		watch.unsubscribe();
	}
}

const A = usage(11, 7, 13, 5, 41, [0.5, 0.25, 0.125, 0.0625, 0.9375]);
const B = usage(17, 3, 2, 19, 43, [1.5, 0.75, 0.375, 0.1875, 2.8125]);
const C = usage(29, 23, 31, 37, 120, [2, 4, 8, 16, 30]);

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Runtime Metrics v0", () => {
	it("reports Pi's zero baseline for a fresh session", async () => {
		const { lane } = await fixture();
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics).toEqual({
			schemaVersion: "runtime-metrics.v0",
			scope: "session",
			messageCount: (await rawStats(lane)).messageCount,
			usage: usage(0, 0, 0, 0, 0, [0, 0, 0, 0, 0]),
		});
		expect(metrics.messageCount).toBe(0);
	});

	it("projects every usage and cost field exactly from Pi's maintained stats", async () => {
		const { lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("answer-sentinel")]);
		reported.push(A);
		expect(await lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const raw = await rawStats(lane);
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics).toEqual({ schemaVersion: "runtime-metrics.v0", scope: "session", ...raw });
		expect(metrics.usage).toEqual(A);
		expect(Object.keys(metrics).sort()).toEqual(["messageCount", "schemaVersion", "scope", "usage"]);
		expect(JSON.stringify(metrics)).not.toMatch(/answer-sentinel|prompt-sentinel|faux/);
	});

	it("copies Pi's reported totalTokens instead of recomputing it from components", async () => {
		const { lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(A.input + A.output + A.cacheRead + A.cacheWrite).not.toBe(A.totalTokens);
		expect(metrics.usage.totalTokens).toBe(A.totalTokens);
		expect(metrics.usage.totalTokens).toBe((await rawStats(lane)).usage.totalTokens);
	});

	it("preserves optional cacheWrite1h and reasoning only once Pi has accounted them", async () => {
		const { lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		reported.push(A);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const without = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(without.usage).not.toHaveProperty("cacheWrite1h");
		expect(without.usage).not.toHaveProperty("reasoning");
		reported.push(usage(1, 2, 3, 4, 10, [0, 0, 0, 0, 0], { cacheWrite1h: 3, reasoning: 1 }));
		await lane.prompt("q", undefined, BACKGROUND_CONTEXT);
		const withExtras = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(withExtras.usage.cacheWrite1h).toBe(3);
		expect(withExtras.usage.reasoning).toBe(1);
		expect(withExtras.usage).toEqual((await rawStats(lane)).usage);
	});

	it("is copy-isolated at every nesting level", async () => {
		const { harness, lane, faux, reported } = await fixture();
		const other = await harness.lane("other", BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const first = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		const expected = structuredClone(first);
		first.messageCount = 999;
		first.usage.input = 999;
		first.usage.totalTokens = 999;
		first.usage.cost.total = 999;
		first.usage.cost.input = 999;
		expect(await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT)).toEqual(expected);
		expect(await captureRuntimeMetricsV0(other, BACKGROUND_CONTEXT)).toEqual(expected);
		expect(await rawStats(lane)).toEqual({ messageCount: expected.messageCount, usage: expected.usage });
	});

	it("reports the same session totals through every lane: access route is not attribution", async () => {
		const { harness, lane: laneA, faux, reported } = await fixture();
		const laneB = await harness.lane("b", BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("on a"), fauxAssistantMessage("on b")]);
		reported.push(A, B);
		await laneA.prompt("work on a", undefined, BACKGROUND_CONTEXT);
		const viaB = await captureRuntimeMetricsV0(laneB, BACKGROUND_CONTEXT);
		expect(viaB.usage).toEqual(A);
		expect(viaB.messageCount).toBe((await rawStats(laneA)).messageCount);

		await laneB.prompt("work on b", undefined, BACKGROUND_CONTEXT);
		const a = await captureRuntimeMetricsV0(laneA, BACKGROUND_CONTEXT);
		const b = await captureRuntimeMetricsV0(laneB, BACKGROUND_CONTEXT);
		expect(a).toEqual(b);
		expect(a.usage).toEqual(sum(A, B));
		expect(a.scope).toBe("session");
		expect(a).not.toHaveProperty("lane");
	});

	it("reports Pi's count of persisted message entries, including tool results", async () => {
		const schema = Type.Object({ value: Type.String() });
		const echo: AgentHarnessTool<undefined, typeof schema> = {
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "tool-output-sentinel" }], details: {} }),
		};
		const { lane, faux, reported } = await fixture({ tools: [echo] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "tool-input-sentinel" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		reported.push(A, B);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const entries = await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		const messages = entries.filter((entry) => entry.type === "message");
		expect(messages.map((entry) => entry.message.role)).toContain("toolResult");
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.messageCount).toBe((await rawStats(lane)).messageCount);
		expect(metrics.messageCount).toBe(messages.length);
		expect(JSON.stringify(metrics)).not.toMatch(/tool-input-sentinel|tool-output-sentinel|echo/);
	});

	it("keeps usage from a terminally failed provider attempt", async () => {
		const { lane, faux, reported } = await fixture();
		faux.setResponses([
			fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "error-message-sentinel" }),
		]);
		reported.push(A);
		const result = await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: true, value: { status: "failed" } });
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.usage).toEqual(A);
		expect(metrics.usage).toEqual((await rawStats(lane)).usage);
		expect(JSON.stringify(metrics)).not.toContain("error-message-sentinel");
	});

	it("accounts both attempts of a retried request, the failed one included", async () => {
		const { lane, faux, reported } = await fixture({ retries: 1 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable: overloaded" }),
			fauxAssistantMessage("final"),
		]);
		reported.push(A, B);
		const result = await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: true, value: { status: "completed" } });
		expect(faux.state.callCount).toBe(2);
		const assistants = (await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		// Pi persists the failed attempt as an error-stopped assistant entry before retrying.
		expect(
			assistants.map((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.stopReason : undefined,
			),
		).toEqual(["error", "stop"]);
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.usage).toEqual((await rawStats(lane)).usage);
		expect(metrics.usage).toEqual(sum(A, B));
	});

	it("keeps already-accounted usage after the operation is aborted", async () => {
		const started = deferred();
		const release = deferred();
		const schema = Type.Object({ value: Type.String() });
		const slow: AgentHarnessTool<undefined, typeof schema> = {
			name: "slow",
			label: "slow",
			description: "slow",
			parameters: schema,
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "late" }], details: {} };
			},
		};
		const { lane, faux, reported } = await fixture({ tools: [slow] });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", { value: "v" }), { stopReason: "toolUse" })]);
		reported.push(A);
		const running = lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			expect(await stopV0(lane, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "aborted" } });
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.usage).toEqual(A);
		expect(metrics.usage).toEqual((await rawStats(lane)).usage);
	});

	it("reflects recordUsage adjustments exactly, without exposing details", async () => {
		const { lane } = await fixture();
		const before = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		const recorded = await lane.recordUsage(C, { details: { note: "details-sentinel" } }, BACKGROUND_CONTEXT);
		expect(recorded.ok).toBe(true);
		const after = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(after.usage).toEqual(sum(before.usage as Usage, C));
		expect(after.usage).toEqual((await rawStats(lane)).usage);
		expect(after.messageCount).toBe(before.messageCount);
		expect(JSON.stringify(after)).not.toMatch(/details-sentinel|note/);
	});

	it("allows negative corrections: totals are not guaranteed monotonic", async () => {
		const { lane } = await fixture();
		await lane.recordUsage(C, undefined, BACKGROUND_CONTEXT);
		const before = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		const correction = usage(-9, -3, -1, -7, -20, [-1, -2, -4, -8, -15]);
		expect(await lane.recordUsage(correction, undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		const after = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(after.usage).toEqual(sum(C, correction));
		expect(after.usage.totalTokens).toBeLessThan(before.usage.totalTokens);
		expect(after.usage.cost.total).toBeLessThan(before.usage.cost.total);
	});

	it("shows an adjustment recorded through one lane when read through another", async () => {
		const { harness, lane } = await fixture();
		const other = await harness.lane("other", BACKGROUND_CONTEXT);
		await lane.recordUsage(C, undefined, BACKGROUND_CONTEXT);
		expect((await captureRuntimeMetricsV0(other, BACKGROUND_CONTEXT)).usage).toEqual(C);
	});

	it("includes tool-reported usage alongside provider usage", async () => {
		const toolUsage = usage(3, 5, 0, 0, 8, [0.25, 0.5, 0, 0, 0.75]);
		const schema = Type.Object({ value: Type.String() });
		const nested: AgentHarnessTool<undefined, typeof schema> = {
			name: "nested",
			label: "nested",
			description: "nested",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "r" }], details: {}, usage: toolUsage }),
		};
		const { lane, faux, reported } = await fixture({ tools: [nested] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("nested", { value: "v" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		reported.push(A, B);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.usage).toEqual(sum(A, B, toolUsage));
		expect(metrics.usage).toEqual((await rawStats(lane)).usage);
	});

	it("includes compaction summary usage and stays cumulative across compaction", async () => {
		const { lane, faux, reported } = await fixture();
		faux.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("summary-sentinel"),
			fauxAssistantMessage("three"),
		]);
		reported.push(A, B, C, A);
		await lane.prompt("first", undefined, BACKGROUND_CONTEXT);
		await lane.prompt("second", undefined, BACKGROUND_CONTEXT);
		const beforeCompaction = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
		if (!compaction.ok) throw compaction.error;
		expect(compaction.value.compaction.status).toBe("completed");
		const afterCompaction = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(afterCompaction.usage).toEqual(sum(A, B, C));
		expect(afterCompaction.usage.totalTokens).toBeGreaterThan(beforeCompaction.usage.totalTokens);
		await lane.prompt("third", undefined, BACKGROUND_CONTEXT);
		const metrics = await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(metrics.usage).toEqual(sum(A, B, C, A));
		expect(metrics.usage).toEqual((await rawStats(lane)).usage);
		expect(Object.keys(metrics).sort()).toEqual(["messageCount", "schemaVersion", "scope", "usage"]);
		expect(Object.keys(metrics.usage).sort()).toEqual([
			"cacheRead",
			"cacheWrite",
			"cost",
			"input",
			"output",
			"totalTokens",
		]);
		expect(JSON.stringify(metrics)).not.toMatch(/context|summary-sentinel/i);
	});

	it("is read-only: no events, entries, tips, operations, queues, configuration, or usage change", async () => {
		const { harness, lane, faux, reported } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		reported.push(A);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const admitted = await lane.accept({ kind: "prompt", operationId: "open", prompt: "q" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		await queueFollowUpV0(lane, "queued", BACKGROUND_CONTEXT);
		const trace = attachMissionTraceV0(harness);
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const observe = async () => ({
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
			stats: await rawStats(lane),
		});
		const before = await observe();
		await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT);
		expect(await observe()).toEqual(before);
		expect(trace.sinceSequence(0)).toEqual([]);
		expect(anyEvent).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
		trace.detach();
	});

	it("depends only on the public watch capability and always unsubscribes", async () => {
		const unsubscribe = vi.fn();
		const stats: SessionStats = { messageCount: 4, usage: B };
		const watch = vi.fn(async () => ({
			snapshot: { stats } as Awaited<ReturnType<AgentLane["watch"]>>["snapshot"],
			start: () => {},
			resnapshot: async () => {
				throw new Error("unused");
			},
			unsubscribe,
		}));
		const metrics = await captureRuntimeMetricsV0({ watch }, BACKGROUND_CONTEXT);
		expect(metrics).toEqual({ schemaVersion: "runtime-metrics.v0", scope: "session", messageCount: 4, usage: B });
		expect(metrics.usage).not.toBe(B);
		expect(metrics.usage.cost).not.toBe(B.cost);
		expect(watch).toHaveBeenCalledExactlyOnceWith(BACKGROUND_CONTEXT);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("propagates Pi's closed-harness failure instead of reporting zero", async () => {
		const { harness, lane } = await fixture();
		await harness.close(BACKGROUND_CONTEXT);
		await expect(captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
	});
});
