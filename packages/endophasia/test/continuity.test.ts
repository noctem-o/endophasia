import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
import { attachMissionTraceV0, captureContinuityV0 } from "../src/index.ts";

const sessions: Session[] = [];

async function fixture(options: { tools?: boolean } = {}): Promise<{
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
	session: Session;
}> {
	const session = new StorageBackedSession(
		{ id: `continuity-${sessions.length}`, createdAt: 1, storageVersion: 1 },
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
			...(options.tools
				? {
						tools: [
							{
								name: "echo",
								label: "echo",
								description: "echo",
								parameters: Type.Object({ value: Type.String() }),
								execute: async (
									_id: string,
									_args: { value: string },
									onUpdate: (result: {
										content: Array<{ type: "text"; text: string }>;
										details: { phase: string };
									}) => void,
								) => {
									onUpdate({
										content: [{ type: "text", text: "partial-output-sentinel" }],
										details: { phase: "partial" },
									});
									return {
										content: [{ type: "text" as const, text: "tool-result-sentinel" }],
										details: { phase: "final" },
									};
								},
							},
						],
						activeToolNames: ["echo"],
					}
				: {}),
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux, session };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("Continuity v0", () => {
	it("captures an empty lane with its current configuration", async () => {
		const { lane, faux } = await fixture();
		const snapshot = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(snapshot).toMatchObject({
			schemaVersion: "continuity.v0",
			lane: "main",
			tipId: null,
			activePath: [],
			contextWindow: [],
			compaction: null,
			counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
			configuration: {
				model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
				thinkingLevel: "off",
				activeToolNames: [],
			},
		});
	});

	it("projects a completed run without prompt, answer, or reasoning payloads", async () => {
		const { lane, faux } = await fixture();
		faux.setResponses([
			fauxAssistantMessage([fauxThinking("thinking-sentinel"), { type: "text", text: "assistant-sentinel" }]),
		]);
		expect(await lane.prompt("user-prompt-sentinel", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const snapshot = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(snapshot.tipId).toBe(await lane.getTipId(BACKGROUND_CONTEXT));
		expect(snapshot.activePath.map(({ id }) => id)).toEqual(snapshot.contextWindow.map(({ id }) => id));
		expect(snapshot.activePath.at(-1)?.id).toBe(snapshot.tipId);
		expect(snapshot.activePath.filter((entry) => entry.type === "message").map((entry) => entry.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(snapshot.counts.beforeContextWindow).toBe(0);
		expect(JSON.stringify(snapshot)).not.toMatch(/user-prompt-sentinel|assistant-sentinel|thinking-sentinel/);
	});

	it("discards tool arguments, partial updates, and final tool output", async () => {
		const { lane, faux } = await fixture({ tools: true });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "tool-args-sentinel" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		expect(await lane.prompt("use echo", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const snapshot = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(snapshot.activePath.some((entry) => entry.type === "message" && entry.role === "toolResult")).toBe(true);
		expect(JSON.stringify(snapshot)).not.toMatch(/tool-args-sentinel|partial-output-sentinel|tool-result-sentinel/);
	});

	it("preserves durable ancestry across real compaction and identifies the source boundary", async () => {
		const { lane, faux } = await fixture();
		const oldId = await lane.appendMessage(
			{ role: "user", content: "old-history-sentinel", timestamp: 1 },
			BACKGROUND_CONTEXT,
		);
		const before = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("compaction-summary-sentinel")]);
		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { status: "completed" } },
		});
		const after = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		if (after.tipId === null) throw new Error("Expected compaction tip");
		const rawCompaction = (
			await lane.findEntries({ start: after.tipId, order: "oldestFirst" }, BACKGROUND_CONTEXT)
		).find((entry) => entry.type === "compaction");
		if (rawCompaction?.type !== "compaction") throw new Error("Expected durable compaction");
		expect(before.compaction).toBeNull();
		expect(after.activePath.map(({ id }) => id)).toContain(oldId);
		expect(after.contextWindow[0]?.type).toBe("compaction");
		expect(after.contextWindow.map(({ id }) => id)).not.toContain(oldId);
		expect(after.compaction).toMatchObject({
			entryId: rawCompaction.id,
			tokensBefore: rawCompaction.tokensBefore,
			retainedTailCount: rawCompaction.retainedTail.length,
			fromHook: rawCompaction.fromHook,
		});
		expect(after.counts.beforeContextWindow).toBeGreaterThan(0);
		expect(after.counts.activePathEntries).toBe(after.activePath.length);
		expect(after.counts.contextWindowEntries).toBe(after.contextWindow.length);
		expect(JSON.stringify(after)).not.toMatch(/old-history-sentinel|compaction-summary-sentinel/);
	});

	it("follows a navigated lane tip and sanitizes branch summaries", async () => {
		const { lane, session, faux } = await fixture();
		const rootId = await lane.appendMessage({ role: "user", content: "root", timestamp: 1 }, BACKGROUND_CONTEXT);
		const sourceId = await lane.appendMessage({ role: "user", content: "source", timestamp: 2 }, BACKGROUND_CONTEXT);
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						{
							kind: "entry",
							entry: {
								id: "target",
								parentId: rootId,
								type: "message",
								message: { role: "user", content: "target", timestamp: 3 },
							},
						},
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const before = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("branch-summary-sentinel")]);
		expect(await lane.navigateTree("target", { summarize: true, label: "chosen" }, BACKGROUND_CONTEXT)).toMatchObject(
			{
				ok: true,
				value: { navigation: { status: "completed" } },
			},
		);
		const after = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(before.tipId).toBe(sourceId);
		expect(after.tipId).toBe(await lane.getTipId(BACKGROUND_CONTEXT));
		expect(after.tipId).not.toBe(before.tipId);
		expect(after.activePath.map(({ id }) => id)).toContain("target");
		expect(after.activePath.map(({ id }) => id)).not.toContain(sourceId);
		expect(after.activePath.some((entry) => entry.type === "branch_summary")).toBe(true);
		expect(JSON.stringify(after)).not.toContain("branch-summary-sentinel");
	});

	it("copies public model, thinking, and active tool configuration", async () => {
		const { lane } = await fixture({ tools: true });
		await lane.setModel({ provider: "other", modelId: "selected" }, BACKGROUND_CONTEXT);
		await lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
		await lane.setActiveTools(["echo"], BACKGROUND_CONTEXT);
		expect((await captureContinuityV0(lane, BACKGROUND_CONTEXT)).configuration).toEqual({
			model: { provider: "other", modelId: "selected" },
			thinkingLevel: "high",
			activeToolNames: ["echo"],
		});
	});

	it("shows custom entry membership without projecting application data", async () => {
		const { lane } = await fixture();
		const id = await lane.appendCustomEntry("app-note", { secret: "custom-data-sentinel" }, BACKGROUND_CONTEXT);
		const snapshot = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(snapshot.activePath).toContainEqual(
			expect.objectContaining({ id, type: "custom", customType: "app-note", hasData: true }),
		);
		expect(snapshot.contextWindow).toContainEqual(expect.objectContaining({ id, type: "custom" }));
		expect(JSON.stringify(snapshot)).not.toContain("custom-data-sentinel");
	});

	it("anchors ancestry to the captured tip when the live lane advances", async () => {
		const { lane } = await fixture();
		const firstId = await lane.appendMessage({ role: "user", content: "first", timestamp: 1 }, BACKGROUND_CONTEXT);
		const frozenWatch = await lane.watch(BACKGROUND_CONTEXT);
		frozenWatch.unsubscribe();
		const secondId = await lane.appendMessage({ role: "user", content: "second", timestamp: 2 }, BACKGROUND_CONTEXT);
		const findEntries = vi.fn(
			(query: Parameters<AgentLane["findEntries"]>[0], context: Parameters<AgentLane["findEntries"]>[1]) =>
				lane.findEntries(query, context),
		);
		const unsubscribe = vi.fn();
		const snapshot = await captureContinuityV0(
			{ watch: async () => ({ ...frozenWatch, unsubscribe }), findEntries },
			BACKGROUND_CONTEXT,
		);
		expect(snapshot.tipId).toBe(firstId);
		expect(snapshot.activePath.map(({ id }) => id)).toEqual([firstId]);
		expect(snapshot.activePath.map(({ id }) => id)).not.toContain(secondId);
		expect(findEntries).toHaveBeenCalledWith({ start: firstId, order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("releases the temporary watcher if the anchored history read fails", async () => {
		const { lane } = await fixture();
		await lane.appendMessage({ role: "user", content: "entry", timestamp: 1 }, BACKGROUND_CONTEXT);
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		watch.unsubscribe();
		const unsubscribe = vi.fn();
		await expect(
			captureContinuityV0(
				{
					watch: async () => ({ ...watch, unsubscribe }),
					findEntries: async () => {
						throw new Error("history unavailable");
					},
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("history unavailable");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("returns independent data and changes neither Pi state nor Mission Trace", async () => {
		const { harness, lane } = await fixture({ tools: true });
		await lane.appendMessage({ role: "user", content: "message", timestamp: 1 }, BACKGROUND_CONTEXT);
		const trace = attachMissionTraceV0(harness);
		const tip = await lane.getTipId(BACKGROUND_CONTEXT);
		const beforeEntries = await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const beforeConfig = structuredClone(watch.snapshot.configuration);
		watch.unsubscribe();
		const first = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		first.activePath[0]!.id = "tampered";
		first.activePath.pop();
		first.contextWindow[0]!.id = "tampered";
		first.contextWindow.pop();
		first.configuration.activeToolNames.push("tampered");
		first.configuration.model.provider = "tampered";
		const second = await captureContinuityV0(lane, BACKGROUND_CONTEXT);
		expect(second.tipId).toBe(tip);
		expect(second.activePath.map(({ id }) => id)).toEqual(beforeEntries.map(({ id }) => id));
		expect(second.contextWindow.map(({ id }) => id)).toEqual(beforeEntries.map(({ id }) => id));
		expect(second.configuration).toEqual(beforeConfig);
		expect(second.activePath[0]).not.toBe(second.contextWindow[0]);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe(tip);
		expect(await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).toEqual(beforeEntries);
		expect(trace.sinceSequence(0)).toEqual([]);
		trace.detach();
	});
});
