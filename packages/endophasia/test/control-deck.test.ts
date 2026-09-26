import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessType,
	type AgentLane,
	type HarnessEventType,
	type LaneSnapshot,
	type WatchHandle,
} from "../../agent/src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { HarnessClosed } from "../../agent/src/harness/result.ts";
import { MemorySessionRepo, MemoryStorage } from "../../agent/src/harness/session/memory.ts";
import { StorageBackedSession } from "../../agent/src/harness/session/session.ts";
import type { Session } from "../../agent/src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../agent/src/harness/types.ts";
import { deferred } from "../../agent/test/harness/runtime/test-utils.ts";
import {
	attachMissionTraceV0,
	captureContinuityV0,
	captureControlStateV0,
	captureRuntimeMetricsV0,
	captureSessionOverviewV0,
	captureSteeringStateV0,
	configureActiveToolsV0,
	configureModelV0,
	configureThinkingLevelV0,
	steerV0,
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

const schema = Type.Object({});
function tool(name: string): AgentHarnessTool<undefined, typeof schema> {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

function fauxModels() {
	return fauxProvider({
		models: [
			{ id: "model-a", reasoning: true },
			{ id: "model-b", reasoning: true },
		],
	});
}

async function fixture(session?: Session): Promise<{
	session: Session;
	harness: AgentHarnessType;
	lane: AgentLane;
	faux: ReturnType<typeof fauxProvider>;
}> {
	const owned =
		session ??
		new StorageBackedSession(
			{ id: `control-deck-${sessions.length}`, createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
	sessions.push(owned);
	const faux = fauxModels();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session: owned,
			models,
			model: faux.getModel("model-a")!,
			thinkingLevel: "low",
			activeToolNames: ["alpha"],
			tools: [tool("alpha"), tool("beta")],
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { session: owned, harness, lane, faux };
}

/** Tool names the provider request carried (Pi's transcript normalization puts them on system messages). */
function requestTools(context: { messages: Message[] }): string[] {
	return context.messages.flatMap((message) =>
		message.role === "system" ? (message.toolsAdded ?? []).map(({ name }) => name) : [],
	);
}

function modelIdentity(faux: ReturnType<typeof fauxProvider>, id: string) {
	const model = faux.getModel(id)!;
	return { provider: model.provider, modelId: model.id };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT).catch(() => {});
});

describe("Runtime Control Deck v0", () => {
	it("captures the configured controls from one lane snapshot, with no payload", async () => {
		const { lane, faux } = await fixture();
		expect(await captureControlStateV0(lane, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control-state.v0",
			lane: "main",
			configuration: {
				model: modelIdentity(faux, "model-a"),
				thinkingLevel: "low",
				activeToolNames: ["alpha"],
			},
			operation: null,
		});
	});

	it("keeps an in-flight request on its captured configuration; the next turn uses the new one", async () => {
		const { harness, lane, faux } = await fixture();
		const requests: Array<{ model: string; reasoning: string | undefined; tools: string[] }> = [];
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async (context, options, _state, model) => {
				requests.push({
					model: model.id,
					reasoning: options?.reasoning,
					tools: requestTools(context),
				});
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			(context, options, _state, model) => {
				requests.push({
					model: model.id,
					reasoning: options?.reasoning,
					tools: requestTools(context),
				});
				return fauxAssistantMessage("second");
			},
		]);
		const running = lane.prompt("go", undefined, BACKGROUND_CONTEXT);
		await started.promise;
		try {
			const modelB = modelIdentity(faux, "model-b");
			expect(await configureModelV0(lane, modelB, BACKGROUND_CONTEXT)).toMatchObject({ configured: modelB });
			expect(await configureThinkingLevelV0(lane, "high", BACKGROUND_CONTEXT)).toMatchObject({
				configured: "high",
			});
			expect(await configureActiveToolsV0(lane, ["beta"], BACKGROUND_CONTEXT)).toMatchObject({
				configured: ["beta"],
			});

			const state = await captureControlStateV0(lane, BACKGROUND_CONTEXT);
			expect(state.configuration).toEqual({ model: modelB, thinkingLevel: "high", activeToolNames: ["beta"] });
			expect(state.operation).toMatchObject({ kind: "run", status: "open" });
			expect((await captureContinuityV0(lane, BACKGROUND_CONTEXT)).configuration).toEqual(state.configuration);
			// Session Overview still reports the model the in-flight request captured.
			const overview = await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT);
			expect(overview.lanes[0]?.operation).toMatchObject({
				operationId: state.operation?.operationId,
				capturedModel: modelIdentity(faux, "model-a"),
			});
			// The in-flight request captured its configuration before the change.
			expect(requests).toEqual([{ model: "model-a", reasoning: "low", tools: ["alpha"] }]);
			expect((await steerV0(lane, "continue", BACKGROUND_CONTEXT)).ok).toBe(true);
		} finally {
			release.resolve();
		}
		expect(await running).toMatchObject({ ok: true, value: { status: "completed" } });
		expect(requests).toEqual([
			{ model: "model-a", reasoning: "low", tools: ["alpha"] },
			{ model: "model-b", reasoning: "high", tools: ["beta"] },
		]);
	});

	it("configures the model and returns the observed configured identity", async () => {
		const { session, lane, faux } = await fixture();
		const entriesBefore = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		const modelB = modelIdentity(faux, "model-b");
		expect(await configureModelV0(lane, modelB, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "model.configured",
			lane: "main",
			configured: modelB,
		});
		expect((await captureControlStateV0(lane, BACKGROUND_CONTEXT)).configuration.model).toEqual(modelB);
		expect((await captureContinuityV0(lane, BACKGROUND_CONTEXT)).configuration.model).toEqual(modelB);
		// Each setter returns its own receipt variant, so `configured` is typed without narrowing.
		const modelReceipt = await configureModelV0(lane, modelB, BACKGROUND_CONTEXT);
		const thinkingReceipt = await configureThinkingLevelV0(lane, "low", BACKGROUND_CONTEXT);
		const toolsReceipt = await configureActiveToolsV0(lane, ["alpha"], BACKGROUND_CONTEXT);
		expect([modelReceipt.configured.modelId, thinkingReceipt.configured, toolsReceipt.configured.join()]).toEqual([
			"model-b",
			"low",
			"alpha",
		]);
		expect(await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual(entriesBefore);

		faux.setResponses([(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`)]);
		expect(await lane.prompt("p", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "completed" },
		});
		const [assistant] = await lane.findEntries({ type: "message" }, BACKGROUND_CONTEXT);
		expect(assistant?.type === "message" && assistant.message.role === "assistant" && assistant.message.model).toBe(
			"model-b",
		);
	});

	it("configures the thinking level exactly, without clamping", async () => {
		const { lane } = await fixture();
		for (const level of ["off", "xhigh", "max", "minimal"] as const) {
			expect(await configureThinkingLevelV0(lane, level, BACKGROUND_CONTEXT)).toEqual({
				schemaVersion: "control.v0",
				kind: "thinking.configured",
				lane: "main",
				configured: level,
			});
			expect((await captureContinuityV0(lane, BACKGROUND_CONTEXT)).configuration.thinkingLevel).toBe(level);
		}
	});

	it("configures active tools in Pi's stored order without sorting or deduplicating", async () => {
		const { lane } = await fixture();
		expect(await configureActiveToolsV0(lane, ["beta"], BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "tools.configured",
			lane: "main",
			configured: ["beta"],
		});
		const receipt = await configureActiveToolsV0(lane, ["beta", "alpha", "beta"], BACKGROUND_CONTEXT);
		expect(receipt).toMatchObject({ configured: ["beta", "alpha", "beta"] });
		expect((await captureControlStateV0(lane, BACKGROUND_CONTEXT)).configuration.activeToolNames).toEqual([
			"beta",
			"alpha",
			"beta",
		]);
		expect((await captureContinuityV0(lane, BACKGROUND_CONTEXT)).configuration.activeToolNames).toEqual([
			"beta",
			"alpha",
			"beta",
		]);
		expect(await configureActiveToolsV0(lane, [], BACKGROUND_CONTEXT)).toMatchObject({ configured: [] });
	});

	it("adds no validation of its own: Pi's setter boundary decides", async () => {
		const { lane } = await fixture();
		const unknownModel = { provider: "unregistered-provider", modelId: "unregistered-model" };
		expect(await configureModelV0(lane, unknownModel, BACKGROUND_CONTEXT)).toMatchObject({
			configured: unknownModel,
		});
		expect(await configureActiveToolsV0(lane, ["unregistered-tool"], BACKGROUND_CONTEXT)).toMatchObject({
			configured: ["unregistered-tool"],
		});
		// Pi accepted these; whether future execution succeeds is decided at request time, not here.
		expect(await lane.getModel(BACKGROUND_CONTEXT)).toBeUndefined();
	});

	it("copies caller-owned inputs before awaiting", async () => {
		const { lane } = await fixture();
		const names = ["beta"];
		const configuringTools = configureActiveToolsV0(lane, names, BACKGROUND_CONTEXT);
		names[0] = "evil";
		names.push("other");
		expect(await configuringTools).toMatchObject({ configured: ["beta"] });

		const model = { provider: "p", modelId: "requested" };
		const configuringModel = configureModelV0(lane, model, BACKGROUND_CONTEXT);
		model.modelId = "evil";
		expect(await configuringModel).toMatchObject({ configured: { provider: "p", modelId: "requested" } });

		const state = await captureControlStateV0(lane, BACKGROUND_CONTEXT);
		expect(state.configuration).toMatchObject({
			model: { provider: "p", modelId: "requested" },
			activeToolNames: ["beta"],
		});
		// Returned state and receipts are copies too.
		state.configuration.activeToolNames.push("tampered");
		state.configuration.model.modelId = "tampered";
		expect((await captureControlStateV0(lane, BACKGROUND_CONTEXT)).configuration).toMatchObject({
			model: { modelId: "requested" },
			activeToolNames: ["beta"],
		});
	});

	it("builds receipts from the readback, not from the input", async () => {
		const setActiveTools = vi.fn(async () => {});
		const watch = vi.fn(async () => fakeWatch({ activeToolNames: ["normalized"] }));
		expect(await configureActiveToolsV0({ setActiveTools, watch }, ["requested"], BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "tools.configured",
			lane: "fake",
			configured: ["normalized"],
		});
		expect(setActiveTools).toHaveBeenCalledExactlyOnceWith(["requested"], BACKGROUND_CONTEXT);
	});

	it("depends only on the claimed capabilities, and unsubscribes every watch", async () => {
		const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
		const watch = vi.fn(async () => {
			const handle = fakeWatch({});
			unsubscribes.push(handle.unsubscribe as ReturnType<typeof vi.fn>);
			return handle;
		});
		expect(await captureControlStateV0({ watch }, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control-state.v0",
			lane: "fake",
			configuration: { model: { provider: "fp", modelId: "fm" }, thinkingLevel: "medium", activeToolNames: ["t"] },
			operation: { operationId: "op", kind: "compaction", status: "aborting" },
		});
		const handle = fakeWatch({});
		const copied = await captureControlStateV0({ watch: async () => handle }, BACKGROUND_CONTEXT);
		expect(copied.configuration.activeToolNames).not.toBe(handle.snapshot.configuration.activeToolNames);
		expect(copied.configuration.model).not.toBe(handle.snapshot.configuration.model);
		const setModel = vi.fn(async () => {});
		const setThinkingLevel = vi.fn(async () => {});
		const setActiveTools = vi.fn(async () => {});
		await configureModelV0({ setModel, watch }, { provider: "fp", modelId: "fm" }, BACKGROUND_CONTEXT);
		await configureThinkingLevelV0({ setThinkingLevel, watch }, "medium", BACKGROUND_CONTEXT);
		await configureActiveToolsV0({ setActiveTools, watch }, ["t"], BACKGROUND_CONTEXT);
		expect(unsubscribes).toHaveLength(4);
		for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("propagates setter failures unchanged and does not read back", async () => {
		const failure = new Error("setter failed");
		const watch = vi.fn(async () => fakeWatch({}));
		await expect(
			configureThinkingLevelV0(
				{ setThinkingLevel: async () => Promise.reject(failure), watch },
				"high",
				BACKGROUND_CONTEXT,
			),
		).rejects.toBe(failure);
		expect(watch).not.toHaveBeenCalled();
	});

	it("rejects when the readback fails even though the setter already committed", async () => {
		const setModel = vi.fn(async () => {});
		const failure = new Error("readback failed");
		await expect(
			configureModelV0(
				{ setModel, watch: async () => Promise.reject(failure) },
				{ provider: "p", modelId: "m" },
				BACKGROUND_CONTEXT,
			),
		).rejects.toBe(failure);
		expect(setModel).toHaveBeenCalledOnce();
	});

	it("persists through Pi: configuration survives closing and reopening the session", async () => {
		const repo = new MemorySessionRepo();
		const created = await repo.create({ id: "control-persist" }, BACKGROUND_CONTEXT);
		const first = await fixture(created);
		await configureModelV0(first.lane, modelIdentity(first.faux, "model-b"), BACKGROUND_CONTEXT);
		await configureThinkingLevelV0(first.lane, "high", BACKGROUND_CONTEXT);
		await configureActiveToolsV0(first.lane, ["beta"], BACKGROUND_CONTEXT);
		await first.harness.close(BACKGROUND_CONTEXT);

		const reopened = await repo.open(created.metadata, BACKGROUND_CONTEXT);
		const second = await fixture(reopened);
		expect((await captureControlStateV0(second.lane, BACKGROUND_CONTEXT)).configuration).toEqual({
			model: modelIdentity(second.faux, "model-b"),
			thinkingLevel: "high",
			activeToolNames: ["beta"],
		});
	});

	it("adds no Mission Trace events; only Pi's own config_update events occur", async () => {
		const { harness, lane, faux } = await fixture();
		const trace = attachMissionTraceV0(harness);
		const configUpdates = vi.fn();
		const unsubscribe = harness.events.on("config_update", configUpdates);
		await configureModelV0(lane, modelIdentity(faux, "model-b"), BACKGROUND_CONTEXT);
		await configureThinkingLevelV0(lane, "high", BACKGROUND_CONTEXT);
		await configureActiveToolsV0(lane, ["beta"], BACKGROUND_CONTEXT);
		expect(trace.sinceSequence(0)).toEqual([]);
		expect(configUpdates.mock.calls.map(([event]) => event.property)).toEqual([
			"model",
			"thinkingLevel",
			"activeTools",
		]);
		unsubscribe();
		trace.detach();
	});

	it("state capture is read-only", async () => {
		const { session, harness, lane, faux } = await fixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await lane.prompt("p", undefined, BACKGROUND_CONTEXT);
		const admitted = await lane.accept({ kind: "prompt", operationId: "open", prompt: "q" }, BACKGROUND_CONTEXT);
		if (!admitted.ok) throw admitted.error;
		const anyEvent = vi.fn();
		const unsubscribe = ALL_EVENT_TYPES.map((type) => harness.events.on(type, anyEvent));
		const observe = async () => ({
			entries: await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT),
			continuity: await captureContinuityV0(lane, BACKGROUND_CONTEXT),
			overview: await captureSessionOverviewV0(harness, BACKGROUND_CONTEXT),
			steering: await captureSteeringStateV0(lane, BACKGROUND_CONTEXT),
			metrics: await captureRuntimeMetricsV0(lane, BACKGROUND_CONTEXT),
			usage: await session.scanUsage({}, BACKGROUND_CONTEXT),
		});
		const before = await observe();
		await captureControlStateV0(lane, BACKGROUND_CONTEXT);
		await captureControlStateV0(lane, BACKGROUND_CONTEXT);
		expect(await observe()).toEqual(before);
		expect(anyEvent).not.toHaveBeenCalled();
		for (const remove of unsubscribe) remove();
	});

	it("propagates a closed harness instead of fabricating state or receipts", async () => {
		const { harness, lane } = await fixture();
		await harness.close(BACKGROUND_CONTEXT);
		await expect(captureControlStateV0(lane, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		await expect(configureThinkingLevelV0(lane, "high", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		await expect(configureActiveToolsV0(lane, ["beta"], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		await expect(configureModelV0(lane, { provider: "p", modelId: "m" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			HarnessClosed,
		);
	});
});

function fakeWatch(configuration: { activeToolNames?: string[] }): WatchHandle<LaneSnapshot> {
	return {
		snapshot: {
			lane: "fake",
			configuration: {
				model: { provider: "fp", modelId: "fm" },
				thinkingLevel: "medium",
				activeToolNames: configuration.activeToolNames ?? ["t"],
			},
			operation: { id: "op", kind: "compaction", status: "aborting" },
		} as LaneSnapshot,
		start: () => {},
		resnapshot: async () => {
			throw new Error("unused");
		},
		unsubscribe: vi.fn(),
	};
}
