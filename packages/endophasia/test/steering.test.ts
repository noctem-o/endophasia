import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import {
	attachMissionTraceV0,
	captureContinuityV0,
	captureSteeringStateV0,
	queueFollowUpV0,
	steerV0,
	stopV0,
} from "../src/index.ts";

const sessions: Session[] = [];

async function fixture(): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const session = new StorageBackedSession(
		{ id: `steering-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Steering controls v0", () => {
	it("keeps STEER and QUEUE distinct while Pi consumes each at its own boundary", async () => {
		const { lane, faux } = await fixture();
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("first-answer-sentinel");
			},
			fauxAssistantMessage("steered-answer-sentinel"),
			fauxAssistantMessage("follow-up-answer-sentinel"),
		]);
		const running = lane.prompt("initial", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		const steer = await steerV0(lane, "steer-text-sentinel", BACKGROUND_CONTEXT);
		const queued = await queueFollowUpV0(lane, "follow-up-text-sentinel", BACKGROUND_CONTEXT);
		if (!steer.ok || !queued.ok) throw new Error("Expected queue acceptance");
		expect(steer.receipt).toMatchObject({ schemaVersion: "steering.v0", kind: "steer.accepted", lane: "main" });
		expect(queued.receipt).toMatchObject({ schemaVersion: "steering.v0", kind: "queue.accepted", lane: "main" });
		expect(steer.receipt.entryId).not.toBe(queued.receipt.entryId);
		const pending = await captureSteeringStateV0(lane, BACKGROUND_CONTEXT);
		expect(pending.operation).toMatchObject({ kind: "run", status: "open" });
		expect(pending.queues).toEqual({ steer: [steer.receipt.entryId], followUp: [queued.receipt.entryId] });
		expect(JSON.stringify({ steer, queued, pending })).not.toMatch(/steer-text-sentinel|follow-up-text-sentinel/);
		release.resolve();
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
		const entries = await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		const ids = entries.map(({ id }) => id);
		expect(ids).toContain(steer.receipt.entryId);
		expect(ids).toContain(queued.receipt.entryId);
		expect(ids.indexOf(steer.receipt.entryId)).toBeLessThan(ids.indexOf(queued.receipt.entryId));
		expect(faux.state.callCount).toBe(3);
		expect((await captureSteeringStateV0(lane, BACKGROUND_CONTEXT)).queues).toEqual({ steer: [], followUp: [] });
	});

	it("STOP counts cleared intent without exposing payloads, then Pi emits the terminal trace", async () => {
		const { harness, lane } = await fixture();
		const trace = attachMissionTraceV0(harness);
		const admitted = await lane.accept(
			{ kind: "prompt", operationId: "run-a", prompt: "initial" },
			BACKGROUND_CONTEXT,
		);
		if (!admitted.ok) throw admitted.error;
		const steer = await steerV0(lane, "clear-steer-sentinel", BACKGROUND_CONTEXT);
		const queued = await queueFollowUpV0(lane, "clear-follow-up-sentinel", BACKGROUND_CONTEXT);
		if (!steer.ok || !queued.ok) throw new Error("Expected queue acceptance");
		const stop = await stopV0(lane, BACKGROUND_CONTEXT);
		expect(stop).toEqual({
			ok: true,
			receipt: {
				schemaVersion: "steering.v0",
				kind: "stop.requested",
				lane: "main",
				operationId: admitted.value.operationId,
				newlyRequested: true,
				clearedSteerCount: 1,
				clearedFollowUpCount: 1,
			},
		});
		expect(JSON.stringify(stop)).not.toMatch(/clear-steer-sentinel|clear-follow-up-sentinel/);
		expect((await captureSteeringStateV0(lane, BACKGROUND_CONTEXT)).queues).toEqual({ steer: [], followUp: [] });
		expect(trace.sinceSequence(0).some((event) => event.kind === "mission.aborted")).toBe(false);
		expect(await lane.drive({ operationId: admitted.value.operationId }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "aborted" } },
		});
		expect(trace.sinceSequence(0)).toContainEqual(
			expect.objectContaining({ kind: "mission.aborted", runId: admitted.value.operationId }),
		);
		trace.detach();
	});

	it("requests STOP against a real run with an in-flight provider effect", async () => {
		const { harness, lane, faux } = await fixture();
		const trace = attachMissionTraceV0(harness);
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late-answer-sentinel");
			},
		]);
		const running = lane.prompt("long-running", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		const operationId = (await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id;
		try {
			expect(await stopV0(lane, BACKGROUND_CONTEXT)).toMatchObject({
				ok: true,
				receipt: { kind: "stop.requested", operationId, newlyRequested: true },
			});
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "aborted" } });
		expect(trace.sinceSequence(0)).toContainEqual(
			expect.objectContaining({ kind: "mission.aborted", runId: operationId }),
		);
		trace.detach();
	});

	it("rejects idle STOP without changing Continuity or Mission Trace", async () => {
		const { harness, lane } = await fixture();
		const trace = attachMissionTraceV0(harness);
		const before = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(await stopV0(lane, BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			action: "stop",
			reason: "no-active-operation",
		});
		expect(await captureContinuityV0(lane, BACKGROUND_CONTEXT)).toEqual(before);
		expect(trace.sinceSequence(0)).toEqual([]);
		trace.detach();
	});

	it("rejects a structural operation before calling requestAbort", async () => {
		const { lane } = await fixture();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const admitted = await lane.accept({ kind: "compaction" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		const requestAbort = vi.spyOn(lane, "requestAbort");
		expect(await stopV0(lane, BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			action: "stop",
			reason: "active-operation-is-not-run",
		});
		expect(requestAbort).not.toHaveBeenCalled();
		expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(admitted.value.operationId);
	});

	it("never retargets a new run after the observed run settles", async () => {
		const { lane } = await fixture();
		const first = await lane.accept({ kind: "prompt", operationId: "run-a", prompt: "A" }, BACKGROUND_CONTEXT);
		if (!first.ok) throw first.error;
		const requestAbort = vi.fn((operationId: string) => lane.requestAbort(operationId, BACKGROUND_CONTEXT));
		const result = await stopV0(
			{
				inspectExecution: async () => {
					const observed = await lane.inspectExecution(BACKGROUND_CONTEXT);
					await lane.requestAbort("run-a", BACKGROUND_CONTEXT);
					await lane.drive({ operationId: "run-a" }, BACKGROUND_CONTEXT);
					const second = await lane.accept(
						{ kind: "prompt", operationId: "run-b", prompt: "B" },
						BACKGROUND_CONTEXT,
					);
					if (!second.ok) throw second.error;
					return observed;
				},
				requestAbort,
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ ok: false, action: "stop", reason: "operation-changed" });
		expect(requestAbort).toHaveBeenCalledExactlyOnceWith("run-a", BACKGROUND_CONTEXT);
		expect((await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe("run-b");
	});

	it("exposes Pi's repeated STOP newlyRequested value", async () => {
		const { lane } = await fixture();
		const admitted = await lane.accept({ kind: "prompt", operationId: "run", prompt: "input" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		const first = await stopV0(lane, BACKGROUND_CONTEXT);
		const second = await stopV0(lane, BACKGROUND_CONTEXT);
		expect(first).toMatchObject({ ok: true, receipt: { operationId: "run", newlyRequested: true } });
		expect(second).toMatchObject({ ok: true, receipt: { operationId: "run", newlyRequested: false } });
	});

	it("reports bounded queue rejections and preserves Pi's idle queue acceptance", async () => {
		const { harness, lane } = await fixture();
		expect(await steerV0(lane, "", BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			action: "steer",
			reason: "invalid-message",
		});
		const idle = await queueFollowUpV0(lane, "idle-follow-up-sentinel", BACKGROUND_CONTEXT);
		expect(idle).toMatchObject({ ok: true, receipt: { kind: "queue.accepted" } });
		expect(JSON.stringify(idle)).not.toContain("idle-follow-up-sentinel");
		await harness.close(BACKGROUND_CONTEXT);
		expect(await queueFollowUpV0(lane, "later", BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			action: "queue",
			reason: "closed",
		});
		expect(await stopV0(lane, BACKGROUND_CONTEXT)).toEqual({ ok: false, action: "stop", reason: "closed" });
	});

	it("steering-state reads are secret, copy-isolated, and leave Continuity unchanged", async () => {
		const { harness, lane } = await fixture();
		const trace = attachMissionTraceV0(harness);
		const admitted = await lane.accept({ kind: "prompt", operationId: "run", prompt: "input" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		const steer = await steerV0(lane, "steer-state-sentinel", BACKGROUND_CONTEXT);
		const followUp = await queueFollowUpV0(lane, "follow-up-state-sentinel", BACKGROUND_CONTEXT);
		if (!steer.ok || !followUp.ok) throw new Error("Expected queue acceptance");
		const steerId = steer.receipt.entryId;
		const followUpId = followUp.receipt.entryId;
		await lane.nextRun("next-run-sentinel", undefined, BACKGROUND_CONTEXT);
		const before = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		const eventsBefore = trace.sinceSequence(0);
		const state = await captureSteeringStateV0(lane, BACKGROUND_CONTEXT);
		expect(state).toEqual({
			schemaVersion: "steering-state.v0",
			lane: "main",
			operation: { operationId: "run", kind: "run", status: "open" },
			queues: { steer: [steerId], followUp: [followUpId] },
		});
		expect(JSON.stringify(state)).not.toMatch(/steer-state-sentinel|follow-up-state-sentinel|next-run-sentinel/);
		state.queues.steer[0] = "tampered";
		state.queues.followUp.push("tampered");
		if (state.operation !== null) state.operation.operationId = "tampered";
		steer.receipt.entryId = "tampered";
		followUp.receipt.entryId = "tampered";
		expect(await captureSteeringStateV0(lane, BACKGROUND_CONTEXT)).toMatchObject({
			operation: { operationId: "run" },
			queues: { steer: [steerId], followUp: [followUpId] },
		});
		expect(await captureContinuityV0(lane, BACKGROUND_CONTEXT)).toEqual(before);
		expect(trace.sinceSequence(0)).toEqual(eventsBefore);
		trace.detach();
	});
});
