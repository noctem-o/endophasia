import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking } from "@earendil-works/pi-ai";
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
import type { OperationResultRecord, Session } from "../../agent/src/harness/session/types.ts";
import {
	attachMissionTraceV0,
	captureContinuityV0,
	captureOperationOutcomeV0,
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

async function fixture(): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const session = new StorageBackedSession(
		{ id: `durable-outcomes-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{ session, models, model: faux.getModel(), retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } },
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux };
}

async function completedRun(lane: AgentLane, faux: ReturnType<typeof fauxProvider>, prompt: string) {
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("thinking-sentinel"), { type: "text", text: "answer-sentinel" }]),
	]);
	const result = await lane.prompt(prompt, undefined, BACKGROUND_CONTEXT);
	if (!result.ok || result.value.status !== "completed") throw new Error("Expected a completed run");
	return result.value as OperationResultRecord;
}

async function raw(lane: AgentLane, operationId: string): Promise<OperationResultRecord> {
	const record = await lane.getResult(operationId, BACKGROUND_CONTEXT);
	if (record === undefined) throw new Error("Expected a durable result");
	return record;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Durable Outcomes v0", () => {
	it("returns null for an operation ID Pi has no result for", async () => {
		const { lane } = await fixture();
		expect(await captureOperationOutcomeV0(lane, "definitely-not-an-operation", BACKGROUND_CONTEXT)).toBeNull();
	});

	it("returns the same null for an admitted, non-terminal operation", async () => {
		const { lane } = await fixture();
		const admitted = await lane.accept({ kind: "prompt", operationId: "open-run", prompt: "p" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe("open-run");
		expect(await captureOperationOutcomeV0(lane, "open-run", BACKGROUND_CONTEXT)).toBeNull();
		expect(await captureOperationOutcomeV0(lane, "never-admitted", BACKGROUND_CONTEXT)).toBeNull();
	});

	it("projects a completed run exactly from Pi's durable record without payloads", async () => {
		const { lane, faux } = await fixture();
		const run = await completedRun(lane, faux, "prompt-sentinel");
		const record = await raw(lane, run.operationId);
		const outcome = await captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT);
		expect(outcome).toEqual({
			schemaVersion: "operation-outcome.v0",
			operationId: record.operationId,
			kind: "run",
			status: "completed",
			fromTipId: record.fromTipId,
			tipId: record.tipId,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
		});
		expect(record.error).toBeUndefined();
		expect(outcome).not.toHaveProperty("errorCode");
		expect(outcome).not.toHaveProperty("lane");
		expect(JSON.stringify(outcome)).not.toMatch(/prompt-sentinel|answer-sentinel|thinking-sentinel/);
	});

	it("keeps Pi's tip anchors, not the lane's current tip, and they stay stable as the lane moves", async () => {
		const { lane, faux } = await fixture();
		const first = await completedRun(lane, faux, "first");
		const before = await captureOperationOutcomeV0(lane, first.operationId, BACKGROUND_CONTEXT);
		const record = await raw(lane, first.operationId);
		expect(before?.fromTipId).toBe(record.fromTipId);
		expect(before?.tipId).toBe(record.tipId);
		expect(before?.fromTipId).toBeNull();
		expect(before?.tipId).not.toBeNull();

		await completedRun(lane, faux, "second");
		const currentTip = (await lane.inspectExecution(BACKGROUND_CONTEXT)).tipId;
		expect(currentTip).not.toBe(record.tipId);
		const after = await captureOperationOutcomeV0(lane, first.operationId, BACKGROUND_CONTEXT);
		expect(after).toEqual(before);
		expect(after?.tipId).not.toBe(currentTip);
	});

	it("does not report aborted for an abort request until Pi's terminal transaction records it", async () => {
		const { lane } = await fixture();
		const admitted = await lane.accept({ kind: "prompt", operationId: "run-x", prompt: "x" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		expect(await lane.requestAbort("run-x", BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
		expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.status).toBe("aborting");
		expect(await captureOperationOutcomeV0(lane, "run-x", BACKGROUND_CONTEXT)).toBeNull();
		expect(await lane.drive({ operationId: "run-x" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled" },
		});
		const record = await raw(lane, "run-x");
		expect(await captureOperationOutcomeV0(lane, "run-x", BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "operation-outcome.v0",
			operationId: "run-x",
			kind: "run",
			status: "aborted",
			fromTipId: record.fromTipId,
			tipId: record.tipId,
			startedAt: admitted.value.startedAt,
			endedAt: record.endedAt,
			...(record.error === undefined ? {} : { errorCode: record.error.code }),
		});
	});

	it("Steering STOP receipt is not a durable aborted outcome", async () => {
		const { lane } = await fixture();
		const admitted = await lane.accept(
			{ kind: "prompt", operationId: "stop-run", prompt: "stop-prompt-sentinel" },
			BACKGROUND_CONTEXT,
		);
		if (!admitted.ok) throw admitted.error;
		const queued = await queueFollowUpV0(lane, "follow-up-sentinel", BACKGROUND_CONTEXT);
		expect(queued.ok).toBe(true);
		const stop = await stopV0(lane, BACKGROUND_CONTEXT);
		expect(stop).toMatchObject({
			ok: true,
			receipt: { kind: "stop.requested", operationId: "stop-run", newlyRequested: true },
		});
		expect(await captureOperationOutcomeV0(lane, "stop-run", BACKGROUND_CONTEXT)).toBeNull();
		await lane.drive({ operationId: "stop-run" }, BACKGROUND_CONTEXT);
		const outcome = await captureOperationOutcomeV0(lane, "stop-run", BACKGROUND_CONTEXT);
		expect(outcome).toMatchObject({ operationId: "stop-run", kind: "run", status: "aborted" });
		expect(JSON.stringify(outcome)).not.toMatch(/stop-prompt-sentinel|follow-up-sentinel/);
	});

	it("exposes only the error code of a failed run, never its message or details", async () => {
		const { lane, faux } = await fixture();
		faux.setResponses([
			fauxAssistantMessage("provider-body-sentinel", {
				stopReason: "error",
				errorMessage: "error-message-sentinel",
			}),
		]);
		const result = await lane.prompt("fail", undefined, BACKGROUND_CONTEXT);
		if (!result.ok || result.value.status !== "failed") throw new Error("Expected a failed run");
		const record = await raw(lane, result.value.operationId);
		expect(record.error?.message).toContain("error-message-sentinel");
		const outcome = await captureOperationOutcomeV0(lane, result.value.operationId, BACKGROUND_CONTEXT);
		expect(outcome).toMatchObject({ kind: "run", status: "failed" });
		expect(outcome?.errorCode).toBe(record.error?.code);
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toMatch(/error-message-sentinel|provider-body-sentinel|message|details|stack/);
	});

	it("exposes the error code of a failed run whose record carries message and details", async () => {
		const { lane } = await fixture();
		await lane.setModel(
			{ provider: "missing-provider-sentinel", modelId: "missing-model-sentinel" },
			BACKGROUND_CONTEXT,
		);
		const result = await lane.prompt("fail", undefined, BACKGROUND_CONTEXT);
		if (!result.ok || result.value.status !== "failed") throw new Error("Expected a failed run");
		const record = await raw(lane, result.value.operationId);
		expect(record.error?.code).toEqual(expect.any(String));
		expect(record.error?.message).toEqual(expect.any(String));
		expect(JSON.stringify(record.error?.details)).toMatch(/missing-model-sentinel/);
		const outcome = await captureOperationOutcomeV0(lane, result.value.operationId, BACKGROUND_CONTEXT);
		expect(outcome).toEqual({
			schemaVersion: "operation-outcome.v0",
			operationId: record.operationId,
			kind: "run",
			status: "failed",
			fromTipId: record.fromTipId,
			tipId: record.tipId,
			startedAt: record.startedAt,
			endedAt: record.endedAt,
			errorCode: record.error?.code,
		});
		expect(JSON.stringify(outcome)).not.toMatch(/missing-model-sentinel|missing-provider-sentinel/);
		expect(JSON.stringify(outcome)).not.toContain(JSON.stringify(record.error?.message));
	});

	it("preserves structural kinds for completed compaction and navigation", async () => {
		const { lane, faux } = await fixture();
		const first = await completedRun(lane, faux, "history one");
		await completedRun(lane, faux, "history two");
		faux.setResponses([fauxAssistantMessage("compaction-summary-sentinel")]);
		const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
		if (!compaction.ok) throw compaction.error;
		const compactionOutcome = await captureOperationOutcomeV0(
			lane,
			compaction.value.compaction.operationId,
			BACKGROUND_CONTEXT,
		);
		expect(compactionOutcome).toMatchObject({ kind: "compaction", status: "completed" });

		const navigation = await lane.navigateTree(first.tipId, { summarize: false }, BACKGROUND_CONTEXT);
		if (!navigation.ok) throw navigation.error;
		const navigationRecord = await raw(lane, navigation.value.navigation.operationId);
		const navigationOutcome = await captureOperationOutcomeV0(
			lane,
			navigation.value.navigation.operationId,
			BACKGROUND_CONTEXT,
		);
		expect(navigationOutcome).toMatchObject({
			kind: "navigation",
			status: "completed",
			fromTipId: navigationRecord.fromTipId,
			tipId: navigationRecord.tipId,
		});
		expect(JSON.stringify([compactionOutcome, navigationOutcome])).not.toContain("compaction-summary-sentinel");
	});

	it("reports a hook-declined compaction as declined", async () => {
		const { harness, lane, faux } = await fixture();
		await completedRun(lane, faux, "history");
		harness.hooks.on("before_compaction", () => ({ decline: true }));
		const compaction = await lane.compact(undefined, BACKGROUND_CONTEXT);
		if (!compaction.ok) throw compaction.error;
		const record = await raw(lane, compaction.value.compaction.operationId);
		const outcome = await captureOperationOutcomeV0(
			lane,
			compaction.value.compaction.operationId,
			BACKGROUND_CONTEXT,
		);
		expect(outcome).toMatchObject({ kind: "compaction", status: "declined" });
		expect(outcome?.errorCode).toBe(record.error?.code);
	});

	it("lookup through another lane's handle returns the same result, so no lane is claimed", async () => {
		const { harness, lane, faux } = await fixture();
		const other = await harness.lane("other", BACKGROUND_CONTEXT);
		const run = await completedRun(lane, faux, "on main");
		const viaMain = await captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT);
		const viaOther = await captureOperationOutcomeV0(other, run.operationId, BACKGROUND_CONTEXT);
		expect(viaOther).toEqual(viaMain);
		expect(viaOther).not.toBeNull();
		expect(viaOther).not.toHaveProperty("lane");
	});

	it("returns copies: mutating one outcome does not affect Pi or the next read", async () => {
		const { lane, faux } = await fixture();
		const run = await completedRun(lane, faux, "p");
		const first = await captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT);
		if (first === null) throw new Error("Expected an outcome");
		const expected = structuredClone(first);
		first.status = "failed";
		first.tipId = "tampered";
		first.errorCode = "tampered";
		expect(await captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT)).toEqual(expected);
		expect((await raw(lane, run.operationId)).status).toBe("completed");
	});

	it("is read-only: no events, entries, tips, operations, configuration, or queues change", async () => {
		const { harness, lane, faux } = await fixture();
		const run = await completedRun(lane, faux, "p");
		const admitted = await lane.accept(
			{ kind: "prompt", operationId: "still-open", prompt: "q" },
			BACKGROUND_CONTEXT,
		);
		if (!admitted.ok) throw admitted.error;
		await queueFollowUpV0(lane, "queued", BACKGROUND_CONTEXT);
		const trace = attachMissionTraceV0(harness);
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const before = {
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		};
		await captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT);
		await captureOperationOutcomeV0(lane, "still-open", BACKGROUND_CONTEXT);
		expect({
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
			entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT),
		}).toEqual(before);
		expect(trace.sinceSequence(0)).toEqual([]);
		expect(anyEvent).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
		trace.detach();
	});

	it("depends only on the public getResult capability", async () => {
		const record: OperationResultRecord = {
			operationId: "op-1",
			kind: "navigation",
			status: "failed",
			error: { code: "some_code", message: "fake-message-sentinel", details: { secret: "fake-details-sentinel" } },
			fromTipId: "a",
			tipId: "b",
			startedAt: 1,
			endedAt: 2,
		};
		const getResult = vi.fn(async (operationId: string) => (operationId === "op-1" ? record : undefined));
		const outcome = await captureOperationOutcomeV0({ getResult }, "op-1", BACKGROUND_CONTEXT);
		expect(outcome).toEqual({
			schemaVersion: "operation-outcome.v0",
			operationId: "op-1",
			kind: "navigation",
			status: "failed",
			fromTipId: "a",
			tipId: "b",
			startedAt: 1,
			endedAt: 2,
			errorCode: "some_code",
		});
		expect(JSON.stringify(outcome)).not.toMatch(/fake-message-sentinel|fake-details-sentinel/);
		expect(await captureOperationOutcomeV0({ getResult }, "op-2", BACKGROUND_CONTEXT)).toBeNull();
		expect(getResult).toHaveBeenNthCalledWith(1, "op-1", BACKGROUND_CONTEXT);
	});

	it("propagates Pi's closed-harness failure instead of returning null", async () => {
		const { harness, lane, faux } = await fixture();
		const run = await completedRun(lane, faux, "p");
		await harness.close(BACKGROUND_CONTEXT);
		await expect(captureOperationOutcomeV0(lane, run.operationId, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			HarnessClosed,
		);
	});
});
