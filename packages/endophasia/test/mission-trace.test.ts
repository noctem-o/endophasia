import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessEventBus } from "../../agent/src/harness/events.ts";
import { MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import { attachMissionTraceV0 } from "../src/index.ts";

const sessions: Session[] = [];

async function fixture(options: { deferred?: boolean } = {}): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const session = new StorageBackedSession(
		{ id: `mission-trace-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(options.deferred ? { streamOptions: { deferred: true } } : {}),
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Mission Trace v0", () => {
	it("projects a real completed run in deterministic order without assistant or thinking content", async () => {
		const { harness, lane, faux } = await fixture();
		faux.setResponses([
			fauxAssistantMessage([
				fauxThinking("private-reasoning-sentinel"),
				{ type: "text", text: "assistant-text-sentinel" },
			]),
		]);
		const trace = attachMissionTraceV0(harness);
		const result = await lane.prompt("hello", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: true, value: { kind: "run", status: "completed" } });
		const events = trace.sinceSequence(0);
		expect(events.map(({ kind }) => kind)).toEqual([
			"mission.started",
			"turn.started",
			"model.completed",
			"turn.finished",
			"mission.completed",
		]);
		expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(events.every((event) => event.schemaVersion === "mission-trace.v0" && event.lane === "main")).toBe(true);
		const runId = events[0]?.runId;
		expect(runId).toBe(result.ok ? result.value.operationId : undefined);
		expect(events.every((event) => event.runId === runId)).toBe(true);
		const turnStarted = events.find((event) => event.kind === "turn.started");
		const turnFinished = events.find((event) => event.kind === "turn.finished");
		expect(turnStarted?.turnId).toBe(turnFinished?.turnId);
		expect(events[2]).not.toHaveProperty("turnId");
		expect(JSON.stringify(events)).not.toMatch(/private-reasoning-sentinel|assistant-text-sentinel|hello/);
	});

	it("keeps exact Pi tool and turn IDs while discarding tool arguments and results", async () => {
		const { harness, lane, faux } = await fixture();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("missing_tool", { secret: "tool-args-sentinel" }, { id: "pi-call-7" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const trace = attachMissionTraceV0(harness);
		const result = await lane.prompt("use tool", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: true, value: { status: "completed" } });
		const events = trace.sinceSequence(0);
		const start = events.find((event) => event.kind === "tool.started");
		const finish = events.find((event) => event.kind === "tool.finished");
		expect(start).toMatchObject({ toolCallId: "pi-call-7", toolName: "missing_tool" });
		expect(finish).toMatchObject({ toolCallId: "pi-call-7", toolName: "missing_tool", isError: true });
		expect(events.map(({ kind }) => kind)).toEqual([
			"mission.started",
			"turn.started",
			"model.completed",
			"tool.started",
			"tool.finished",
			"turn.finished",
			"turn.started",
			"model.completed",
			"turn.finished",
			"mission.completed",
		]);
		expect(start?.turnId).toBe(events.find((event) => event.kind === "turn.started")?.turnId);
		expect(finish?.turnId).toBe(start?.turnId);
		expect(JSON.stringify(events)).not.toMatch(/tool-args-sentinel|Unknown tool|partialResult|result|args/);
	});

	it("distinguishes completed, aborted, and failed run_end states from real runs", async () => {
		const { harness, lane, faux } = await fixture();
		const trace = attachMissionTraceV0(harness);
		faux.setResponses([fauxAssistantMessage("ok")]);
		expect(await lane.prompt("complete", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const admitted = await lane.accept(
			{ kind: "prompt", operationId: "abort-id", prompt: "abort" },
			BACKGROUND_CONTEXT,
		);
		if (!admitted.ok) throw admitted.error;
		await lane.requestAbort("abort-id", BACKGROUND_CONTEXT);
		expect(await lane.drive({ operationId: "abort-id" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "aborted" } },
		});
		await lane.setModel({ provider: "missing", modelId: "missing-model" }, BACKGROUND_CONTEXT);
		expect(await lane.prompt("fail", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "failed" },
		});
		const terminals = trace
			.sinceSequence(0)
			.filter(
				(event) =>
					event.kind.startsWith("mission.") &&
					["mission.completed", "mission.aborted", "mission.failed"].includes(event.kind),
			);
		expect(terminals.map(({ kind, runId }) => ({ kind, runId }))).toEqual([
			{ kind: "mission.completed", runId: expect.any(String) },
			{ kind: "mission.aborted", runId: "abort-id" },
			{ kind: "mission.failed", runId: expect.any(String) },
		]);
		expect(JSON.stringify(terminals)).not.toMatch(/model_unavailable|missing-model/);
	});

	it("projects a real deferred suspension and resume under one run ID", async () => {
		const { harness, lane, faux } = await fixture({ deferred: true });
		faux.setResponses([fauxAssistantMessage("later")]);
		const trace = attachMissionTraceV0(harness);
		const suspended = await lane.prompt("defer", undefined, BACKGROUND_CONTEXT);
		if (!suspended.ok || suspended.value.status !== "suspended") throw new Error("Expected suspension");
		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({ ok: true, value: { status: "completed" } });
		const events = trace.sinceSequence(0);
		expect(events.map(({ kind }) => kind)).toContain("mission.suspended");
		expect(events.map(({ kind }) => kind)).toContain("mission.resumed");
		expect(
			events
				.filter((event) => event.kind.startsWith("mission."))
				.every((event) => event.runId === suspended.value.operationId),
		).toBe(true);
		expect(events.findIndex((event) => event.kind === "mission.suspended")).toBeLessThan(
			events.findIndex((event) => event.kind === "mission.resumed"),
		);
	});

	it("isolates attachments, detachment, cursors, and returned records", async () => {
		const { harness, lane, faux } = await fixture();
		const a = attachMissionTraceV0(harness);
		const b = attachMissionTraceV0(harness);
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		expect(await lane.prompt("first", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const aTerminal = a.sinceSequence(0).at(-1)?.sequence;
		expect(aTerminal).toBe(5);
		a.detach();
		a.detach();
		expect(await lane.prompt("second", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		expect(a.sinceSequence(0)).toHaveLength(5);
		expect(b.sinceSequence(0).map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const first = a.sinceSequence(0);
		first.pop();
		first[0]!.kind = "mission.failed";
		first[0]!.lane = "mutated";
		expect(a.sinceSequence(0)).toHaveLength(5);
		expect(a.sinceSequence(0)[0]).toMatchObject({ kind: "mission.started", lane: "main" });
		expect(b.sinceSequence(0)[0]).toMatchObject({ kind: "mission.started", lane: "main" });
		expect(a.sinceSequence(0)).not.toBe(a.sinceSequence(0));
		expect(a.sinceSequence(5)).toEqual([]);
		expect(a.sinceSequence(100)).toEqual([]);
		expect(b.sinceSequence(5)).toHaveLength(5);
		for (const cursor of [-1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => a.sinceSequence(cursor)).toThrow(RangeError);
		}
	});

	it("ignores non-assistant message ends and tool output updates", async () => {
		const bus = new HarnessEventBus();
		const trace = attachMissionTraceV0({ events: bus });
		await bus.emit(
			{
				type: "message_end",
				lane: "main",
				message: { role: "user", content: [{ type: "text", text: "user-sentinel" }], timestamp: 1 },
			},
			BACKGROUND_CONTEXT,
		);
		await bus.emit(
			{
				type: "tool_update",
				lane: "main",
				runId: "run",
				turnId: "turn",
				toolCallId: "call",
				toolName: "tool",
				partialResult: { content: [{ type: "text", text: "partial-output-sentinel" }], details: {} },
			},
			BACKGROUND_CONTEXT,
		);
		expect(trace.sinceSequence(0)).toEqual([]);
		await bus.emit(
			{ type: "message_end", lane: "main", message: fauxAssistantMessage("answer") },
			BACKGROUND_CONTEXT,
		);
		expect(trace.sinceSequence(0)).toEqual([
			{
				schemaVersion: "mission-trace.v0",
				sequence: 1,
				kind: "model.completed",
				lane: "main",
			},
		]);
		expect(trace.sinceSequence(0)[0]).not.toHaveProperty("runId");
		const queued = bus.emit({ type: "run_start", lane: "main", runId: "queued", startedAt: 1 }, BACKGROUND_CONTEXT);
		trace.detach();
		await queued;
		expect(trace.sinceSequence(0)).toHaveLength(1);
	});
});
