import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type HarnessEventType,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessClosed } from "../../agent/src/harness/result.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import { attachMissionTraceV0, captureSessionOverviewV0, steerV0 } from "../src/index.ts";

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

async function fixture(tools: AgentHarnessTool<undefined>[] = []): Promise<{
	harness: AgentHarnessType;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const session = new StorageBackedSession(
		{ id: `session-overview-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{ session, models, model: faux.getModel(), tools },
		BACKGROUND_CONTEXT,
	);
	return { harness, faux };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Session Overview v0", () => {
	it("reports an empty inventory for a fresh harness without fabricating a lane", async () => {
		const { harness } = await fixture();
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual([]);
		expect(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [],
			counts: { lanes: 0, activeOperations: 0, abortingOperations: 0 },
		});
	});

	it("projects one idle lane at its real tip", async () => {
		const { harness, faux } = await fixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("done")]);
		expect(await lane.prompt("hello", undefined, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		const tipId = (await lane.inspectExecution(BACKGROUND_CONTEXT)).tipId;
		expect(tipId).not.toBeNull();
		expect(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [{ name: "main", tipId, operation: null }],
			counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
		});
	});

	it("lists every lane once, sorted by name regardless of creation order", async () => {
		const { harness } = await fixture();
		const research = await harness.lane("research", BACKGROUND_CONTEXT);
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		await research.appendMessage({ role: "user", content: "research-sentinel", timestamp: 1 }, BACKGROUND_CONTEXT);
		const review = await harness.lane("review", BACKGROUND_CONTEXT);
		await main.appendMessage({ role: "user", content: "main-sentinel", timestamp: 2 }, BACKGROUND_CONTEXT);
		const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
		const tips = await Promise.all(
			[main, research, review].map(async (lane) => (await lane.inspectExecution(BACKGROUND_CONTEXT)).tipId),
		);
		expect(overview.lanes).toEqual([
			{ name: "main", tipId: tips[0], operation: null },
			{ name: "research", tipId: tips[1], operation: null },
			{ name: "review", tipId: tips[2], operation: null },
		]);
		expect(tips[0]).not.toBeNull();
		expect(tips[1]).not.toBeNull();
		expect(tips[2]).toBeNull();
		expect(overview.counts).toEqual({ lanes: 3, activeOperations: 0, abortingOperations: 0 });
		expect(JSON.stringify(overview)).not.toMatch(/research-sentinel|main-sentinel/);
	});

	it("shows one real open run beside an idle lane, with its captured model", async () => {
		const { harness, faux } = await fixture();
		const busy = await harness.lane("busy", BACKGROUND_CONTEXT);
		await harness.lane("idle", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const running = busy.prompt("work", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			const current = (await busy.inspectExecution(BACKGROUND_CONTEXT)).current;
			if (current === null) throw new Error("Expected an open run");
			const model = faux.getModel();
			const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			expect(overview.lanes).toEqual([
				{
					name: "busy",
					tipId: expect.any(String),
					operation: {
						operationId: current.id,
						kind: "run",
						status: "open",
						startedAt: current.startedAt,
						capturedModel: { provider: model.provider, modelId: model.id },
					},
				},
				{ name: "idle", tipId: null, operation: null },
			]);
			expect(overview.counts).toEqual({ lanes: 2, activeOperations: 1, abortingOperations: 0 });
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
		expect((await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).counts.activeOperations).toBe(0);
	});

	it("shows independent runs open on two lanes of one harness", async () => {
		const { harness, faux } = await fixture();
		const alpha = await harness.lane("alpha", BACKGROUND_CONTEXT);
		const beta = await harness.lane("beta", BACKGROUND_CONTEXT);
		const started = [deferred(), deferred()];
		const release = deferred();
		faux.setResponses(
			started.map((gate) => async () => {
				gate.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			}),
		);
		const runs = [alpha.prompt("a", undefined, BACKGROUND_CONTEXT), beta.prompt("b", undefined, BACKGROUND_CONTEXT)];
		await Promise.all(started.map((gate) => gate.promise));
		try {
			const alphaId = (await alpha.inspectExecution(BACKGROUND_CONTEXT)).current?.id;
			const betaId = (await beta.inspectExecution(BACKGROUND_CONTEXT)).current?.id;
			const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			expect(overview.lanes.map(({ name, operation }) => [name, operation?.operationId, operation?.kind])).toEqual([
				["alpha", alphaId, "run"],
				["beta", betaId, "run"],
			]);
			expect(alphaId).not.toBe(betaId);
			expect(overview.counts).toEqual({ lanes: 2, activeOperations: 2, abortingOperations: 0 });
		} finally {
			release.resolve();
		}
		for (const run of runs) expect(await run).toMatchObject({ ok: true, value: { status: "completed" } });
	});

	it("reports aborting before terminal settlement, then idle after it", async () => {
		const { harness } = await fixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const admitted = await lane.accept({ kind: "prompt", operationId: "run-x", prompt: "x" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		expect((await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).lanes[0]?.operation).toEqual({
			operationId: "run-x",
			kind: "run",
			status: "open",
			startedAt: admitted.value.startedAt,
		});
		await lane.requestAbort("run-x", BACKGROUND_CONTEXT);
		const aborting = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
		expect(aborting.lanes[0]?.operation).toMatchObject({ operationId: "run-x", status: "aborting" });
		expect(aborting.counts).toEqual({ lanes: 1, activeOperations: 1, abortingOperations: 1 });
		expect(await lane.drive({ operationId: "run-x" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "aborted" } },
		});
		expect((await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).lanes[0]?.operation).toBeNull();
	});

	it("preserves structural operation kinds instead of flattening them to busy", async () => {
		const { harness } = await fixture();
		const compacting = await harness.lane("compacting", BACKGROUND_CONTEXT);
		const navigating = await harness.lane("navigating", BACKGROUND_CONTEXT);
		await compacting.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		await navigating.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const compaction = await compacting.accept({ kind: "compaction", operationId: "c" }, BACKGROUND_CONTEXT);
		const navigation = await navigating.accept(
			{ kind: "navigation", operationId: "n", targetId: null },
			BACKGROUND_CONTEXT,
		);
		if (!compaction.ok) throw compaction.error;
		if (!navigation.ok) throw navigation.error;
		const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
		expect(overview.lanes.map(({ name, operation }) => [name, operation?.operationId, operation?.kind])).toEqual([
			["compacting", "c", "compaction"],
			["navigating", "n", "navigation"],
		]);
	});

	it("is read-only: no events, lanes, tips, or operations change, and watchSession is never called", async () => {
		const { harness } = await fixture();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		await harness.lane("side", BACKGROUND_CONTEXT);
		const admitted = await main.accept({ kind: "prompt", operationId: "run", prompt: "p" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		const trace = attachMissionTraceV0(harness);
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const watchSession = vi.spyOn(harness, "watchSession");
		const before = await harness.lanes(BACKGROUND_CONTEXT);
		const first = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
		const second = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
		expect(second).toEqual(first);
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual(before);
		expect(trace.sinceSequence(0)).toEqual([]);
		expect(anyEvent).not.toHaveBeenCalled();
		expect(watchSession).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
		trace.detach();
	});

	it("uses only the public lanes() seam", async () => {
		const lanes = vi.fn(async () => [
			{ name: "b", tipId: "t2", operation: null },
			{
				name: "a",
				tipId: "t1",
				operation: { id: "op", kind: "run" as const, startedAt: 5, status: "open" as const },
			},
		]);
		expect(await captureSessionOverviewV0({ lanes }, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [
				{ name: "a", tipId: "t1", operation: { operationId: "op", kind: "run", status: "open", startedAt: 5 } },
				{ name: "b", tipId: "t2", operation: null },
			],
			counts: { lanes: 2, activeOperations: 1, abortingOperations: 0 },
		});
		expect(lanes).toHaveBeenCalledExactlyOnceWith(BACKGROUND_CONTEXT);
	});

	it("contains no prompt, assistant, thinking, tool, or steering payloads", async () => {
		const schema = Type.Object({ value: Type.String() });
		const echo: AgentHarnessTool<undefined, typeof schema> = {
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "tool-output-sentinel" }], details: {} }),
		};
		const { harness, faux } = await fixture([echo]);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("thinking-sentinel"),
					{ type: "text", text: "assistant-sentinel" },
					fauxToolCall("echo", { value: "tool-input-sentinel" }),
				],
				{ stopReason: "toolUse" },
			),
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("final-sentinel");
			},
			fauxAssistantMessage("after steer"),
		]);
		const running = lane.prompt("prompt-sentinel", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			const steer = await steerV0(lane, "steer-sentinel", BACKGROUND_CONTEXT);
			expect(steer.ok).toBe(true);
			const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			expect(overview.lanes[0]?.operation?.kind).toBe("run");
			expect(JSON.stringify(overview)).not.toMatch(
				/prompt-sentinel|assistant-sentinel|thinking-sentinel|tool-input-sentinel|tool-output-sentinel|steer-sentinel|echo/,
			);
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true });
	});

	it("returns copies: mutating one overview does not affect the next", async () => {
		const { harness, faux } = await fixture();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const running = lane.prompt("work", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			const first = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			const expected = structuredClone(first);
			const operation = first.lanes[0]?.operation;
			if (!operation?.capturedModel) throw new Error("Expected a captured model");
			operation.capturedModel.modelId = "tampered";
			operation.operationId = "tampered";
			operation.status = "aborting";
			first.lanes.push({ name: "ghost", tipId: null, operation: null });
			first.counts.lanes = 99;
			expect(await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).toEqual(expected);
			expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.capturedModel?.modelId).toBe(
				faux.getModel().id,
			);
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true });
	});

	it("propagates Pi's closed-harness failure instead of reporting an empty session", async () => {
		const { harness } = await fixture();
		await harness.lane("main", BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		await expect(captureSessionOverviewV0(harness, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
	});
});
