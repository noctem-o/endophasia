// Lane ports v0 boundary: each neutral source is a closure over lane or harness capabilities, expressed only in
// Endophasia's own v0 semantics. Consumers receive capabilities only, never a lane or harness. Proved at compile
// time (exact method signatures and factory outputs equal to the neutral interfaces), at runtime (neutral fakes
// served over the real strict JSON transport, and the Pi factories bound to structural fake-lane objects rather
// than real lane types), and in the import graph (the neutral modules reach no Pi package and no adapter file).
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	type Facet,
	type FacetHost,
	type RemoteServiceBinding,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	AgentHarness,
	AgentLane,
	CurrentOperationInfo,
	LaneSnapshot,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPiContinuityCaptureV0,
	createPiControlDeckSourceV0,
	createPiSessionOverviewCaptureV0,
	createPiSteeringSourceV0,
} from "../adapters/pi/ports.ts";
import { CONTINUITY_REMOTE_BYTE_LIMIT, type ContinuitySnapshotV0 } from "../protocol/continuity.ts";
import type { ModelIdentityV0, ThinkingLevelV0 } from "../protocol/primitives.ts";
import type { SessionOverviewV0 } from "../protocol/session-overview.ts";
import { EndophasiaContinuityV0 } from "../runtime/contracts/continuity.ts";
import { createEndophasiaContinuityFacetV0 } from "../runtime/contracts/continuity-facet.ts";
import { createEndophasiaInspectorFacetV0, EndophasiaInspectorV0 } from "../runtime/contracts/inspector.ts";
import type {
	ContinuityCaptureSourceV0,
	ControlDeckSourceV0,
	SessionOverviewCaptureSourceV0,
	SteeringSourceV0,
} from "../runtime/ports.ts";
import { connectStrictJson } from "./strict-json-transport.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const minimalSnapshot: ContinuitySnapshotV0 = {
	schemaVersion: "continuity.v0",
	lane: "fake",
	tipId: null,
	configuration: { model: { provider: "fp", modelId: "fm" }, thinkingLevel: "medium", activeToolNames: ["t"] },
	activePath: [],
	contextWindow: [],
	compaction: null,
	counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
};
const overLimitSnapshot: ContinuitySnapshotV0 = {
	...minimalSnapshot,
	tipId: "x".repeat(CONTINUITY_REMOTE_BYTE_LIMIT + 1),
};
const minimalOverview: SessionOverviewV0 = {
	schemaVersion: "session-overview.v0",
	consistency: "per-lane",
	lanes: [],
	counts: { lanes: 0, activeOperations: 0, abortingOperations: 0 },
};

type ServiceRef = typeof EndophasiaContinuityV0 | typeof EndophasiaInspectorV0;

async function connect(facets: Facet[], services: readonly ServiceRef[]): Promise<RemoteServiceBinding> {
	const host: FacetHost = await createFacetHost({ facets });
	const connection = connectStrictJson(host.services);
	const errors: Error[] = [];
	const binding = createRemoteServiceBinding({
		services,
		transport: connection.transport,
		onError: (error) => errors.push(error),
	});
	cleanups.push(async () => {
		await binding.dispose(BACKGROUND_CONTEXT);
		connection.dispose();
		await host.dispose();
		expect(errors).toEqual([]);
	});
	await binding.ready(BACKGROUND_CONTEXT);
	return binding;
}

// A plain object, not an AgentLane instance: if the factories accepted only real lanes this would not typecheck.
function fakeLane() {
	const calls = {
		steer: [] as string[],
		followUp: [] as string[],
		aborted: [] as string[],
		models: [] as ModelIdentityV0[],
		levels: [] as ThinkingLevel[],
		tools: [] as string[][],
		watches: 0,
		unsubscribes: 0,
	};
	const execution: { current: CurrentOperationInfo | null } = { current: null };
	const lane: Pick<
		AgentLane,
		| "name"
		| "steer"
		| "followUp"
		| "inspectExecution"
		| "requestAbort"
		| "watch"
		| "findEntries"
		| "setModel"
		| "setThinkingLevel"
		| "setActiveTools"
	> = {
		name: "fake",
		steer: async (message) => {
			calls.steer.push(typeof message === "string" ? message : "structured");
			return { ok: true, value: { entryId: "steer-entry" } };
		},
		followUp: async (message) => {
			calls.followUp.push(typeof message === "string" ? message : "structured");
			return { ok: true, value: { entryId: "queue-entry" } };
		},
		inspectExecution: async () => ({
			lane: "fake",
			tipId: null,
			configuredModel: { provider: "fp", modelId: "fm" },
			current: execution.current,
			lastOperationId: null,
		}),
		requestAbort: async (operationId) => {
			calls.aborted.push(operationId);
			return { ok: true, value: { operationId, newlyRequested: true, steer: [], followUp: [] } };
		},
		watch: async () => {
			calls.watches += 1;
			return {
				snapshot: {
					lane: "fake",
					tipId: null,
					transcript: [],
					configuration: {
						model: { provider: "fp", modelId: "fm" },
						thinkingLevel: "medium",
						activeToolNames: ["t"],
					},
					operation: null,
					queues: [
						{ entryId: "steer-q", kind: "steer" },
						{ entryId: "follow-q", kind: "followUp" },
					],
				} as unknown as LaneSnapshot,
				start: () => {},
				resnapshot: async () => {
					throw new Error("unused");
				},
				unsubscribe: () => {
					calls.unsubscribes += 1;
				},
			};
		},
		findEntries: async () => [],
		setModel: async (model) => {
			calls.models.push({ provider: model.provider, modelId: model.modelId });
		},
		setThinkingLevel: async (level) => {
			calls.levels.push(level);
		},
		setActiveTools: async (names) => {
			calls.tools.push([...names]);
		},
	};
	return { lane, calls, execution };
}

const fakeHarness: Pick<AgentHarness, "lanes"> = {
	lanes: async () => [
		{
			name: "busy",
			tipId: "tip-busy",
			operation: {
				id: "op",
				kind: "run",
				startedAt: 1,
				status: "running",
				capturedModel: { provider: "fp", modelId: "fm" },
			},
		},
		{ name: "idle", tipId: null, operation: null },
	],
};

describe("lane ports over the strict JSON transport", () => {
	it("serves Continuity and Session Overview from neutral fake ports", async () => {
		const binding = await connect(
			[
				createEndophasiaContinuityFacetV0({ capture: async () => minimalSnapshot }),
				createEndophasiaInspectorFacetV0({ capture: async () => minimalOverview }),
			],
			[EndophasiaContinuityV0, EndophasiaInspectorV0],
		);
		const continuity = binding.use(EndophasiaContinuityV0);
		const inspector = binding.use(EndophasiaInspectorV0);
		const snapshot = await continuity.snapshot(BACKGROUND_CONTEXT);
		expect(snapshot).toEqual(minimalSnapshot);
		// A fresh object from the wire: the host's reference never crosses the boundary.
		expect(snapshot).not.toBe(minimalSnapshot);
		expect(await inspector.sessionOverview(BACKGROUND_CONTEXT)).toEqual(minimalOverview);
	});

	it("fails an over-limit Continuity capture across the wire instead of truncating", async () => {
		const binding = await connect(
			[createEndophasiaContinuityFacetV0({ capture: async () => overLimitSnapshot })],
			[EndophasiaContinuityV0],
		);
		const continuity = binding.use(EndophasiaContinuityV0);
		await expect(continuity.snapshot(BACKGROUND_CONTEXT)).rejects.toThrow(
			new RegExp(`over the ${CONTINUITY_REMOTE_BYTE_LIMIT}-byte remote limit; it is not truncated`),
		);
	});

	it("rejects a missing Continuity capture source when the facet is built", () => {
		expect(() => createEndophasiaContinuityFacetV0(null as unknown as ContinuityCaptureSourceV0)).toThrow(TypeError);
		expect(() => createEndophasiaContinuityFacetV0(undefined as unknown as ContinuityCaptureSourceV0)).toThrow(
			TypeError,
		);
	});

	it("binds the Pi factories to structural fake lanes and harnesses", async () => {
		const { lane, calls, execution } = fakeLane();
		const steering = createPiSteeringSourceV0(lane);
		expect(await steering.steer("take me somewhere", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			receipt: { schemaVersion: "steering.v0", kind: "steer.accepted", lane: "fake", entryId: "steer-entry" },
		});
		expect(await steering.queueFollowUp("after that", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			receipt: { schemaVersion: "steering.v0", kind: "queue.accepted", lane: "fake", entryId: "queue-entry" },
		});
		expect(await steering.state(BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "steering-state.v0",
			lane: "fake",
			operation: null,
			queues: { steer: ["steer-q"], followUp: ["follow-q"] },
		});
		expect(await steering.stop(BACKGROUND_CONTEXT)).toEqual({
			ok: false,
			action: "stop",
			reason: "no-active-operation",
		});
		execution.current = { id: "op-1", kind: "run", startedAt: 1, status: "running" };
		expect(await steering.stop(BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			receipt: {
				schemaVersion: "steering.v0",
				kind: "stop.requested",
				lane: "fake",
				operationId: "op-1",
				newlyRequested: true,
				clearedSteerCount: 0,
				clearedFollowUpCount: 0,
			},
		});
		expect(calls.steer).toEqual(["take me somewhere"]);
		expect(calls.followUp).toEqual(["after that"]);
		expect(calls.aborted).toEqual(["op-1"]);

		const deck = createPiControlDeckSourceV0(lane);
		expect(await deck.state(BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control-state.v0",
			lane: "fake",
			configuration: { model: { provider: "fp", modelId: "fm" }, thinkingLevel: "medium", activeToolNames: ["t"] },
			operation: null,
		});
		// Receipts are readbacks from a fresh snapshot, not the requested values.
		expect(await deck.configureModel({ provider: "fp", modelId: "new" }, BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "model.configured",
			lane: "fake",
			configured: { provider: "fp", modelId: "fm" },
		});
		expect(await deck.configureThinkingLevel("high", BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "thinking.configured",
			lane: "fake",
			configured: "medium",
		});
		expect(await deck.configureActiveTools(["a", "b"], BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "control.v0",
			kind: "tools.configured",
			lane: "fake",
			configured: ["t"],
		});
		expect(calls.models).toEqual([{ provider: "fp", modelId: "new" }]);
		expect(calls.levels).toEqual(["high"]);
		expect(calls.tools).toEqual([["a", "b"]]);

		expect(await createPiContinuityCaptureV0(lane).capture(BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "continuity.v0",
			lane: "fake",
			tipId: null,
			configuration: { model: { provider: "fp", modelId: "fm" }, thinkingLevel: "medium", activeToolNames: ["t"] },
			activePath: [],
			contextWindow: [],
			compaction: null,
			counts: { activePathEntries: 0, contextWindowEntries: 0, beforeContextWindow: 0 },
		});

		expect(await createPiSessionOverviewCaptureV0(fakeHarness).capture(BACKGROUND_CONTEXT)).toEqual({
			schemaVersion: "session-overview.v0",
			consistency: "per-lane",
			lanes: [
				{
					name: "busy",
					tipId: "tip-busy",
					operation: {
						operationId: "op",
						kind: "run",
						status: "running",
						startedAt: 1,
						capturedModel: { provider: "fp", modelId: "fm" },
					},
				},
				{ name: "idle", tipId: null, operation: null },
			],
			counts: { lanes: 2, activeOperations: 1, abortingOperations: 0 },
		});

		// Every snapshot-reading port call watches and unsubscribes exactly once.
		expect(calls.watches).toBe(6);
		expect(calls.unsubscribes).toBe(6);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Compile-time boundary guards: the neutral interfaces name no Pi type, and the Pi factories take exactly the
// capabilities they need and return exactly the neutral interfaces.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_value: T): void {}

describe("lane port compile-time guards", () => {
	it("declares every port method against the neutral vocabulary, with factory outputs exactly the neutral ports", () => {
		// No lane or harness object appears anywhere: every call takes only its neutral request and a context.
		assertType<Equal<Parameters<ContinuityCaptureSourceV0["capture"]>, [Context]>>(true);
		assertType<Equal<Parameters<SessionOverviewCaptureSourceV0["capture"]>, [Context]>>(true);
		assertType<Equal<Parameters<SteeringSourceV0["steer"]>, [string, Context]>>(true);
		assertType<Equal<Parameters<SteeringSourceV0["queueFollowUp"]>, [string, Context]>>(true);
		assertType<Equal<Parameters<SteeringSourceV0["stop"]>, [Context]>>(true);
		assertType<Equal<Parameters<SteeringSourceV0["state"]>, [Context]>>(true);
		assertType<Equal<Parameters<ControlDeckSourceV0["state"]>, [Context]>>(true);
		assertType<Equal<Parameters<ControlDeckSourceV0["configureModel"]>, [ModelIdentityV0, Context]>>(true);
		assertType<Equal<Parameters<ControlDeckSourceV0["configureThinkingLevel"]>, [ThinkingLevelV0, Context]>>(true);
		assertType<Equal<Parameters<ControlDeckSourceV0["configureActiveTools"]>, [string[], Context]>>(true);
		// Each factory takes exactly the lane or harness capabilities its projection reads.
		assertType<Equal<Parameters<typeof createPiContinuityCaptureV0>, [Pick<AgentLane, "watch" | "findEntries">]>>(
			true,
		);
		assertType<Equal<Parameters<typeof createPiSessionOverviewCaptureV0>, [Pick<AgentHarness, "lanes">]>>(true);
		assertType<
			Equal<
				Parameters<typeof createPiSteeringSourceV0>,
				[Pick<AgentLane, "name" | "steer" | "followUp" | "inspectExecution" | "requestAbort" | "watch">]
			>
		>(true);
		assertType<
			Equal<
				Parameters<typeof createPiControlDeckSourceV0>,
				[Pick<AgentLane, "watch" | "setModel" | "setThinkingLevel" | "setActiveTools">]
			>
		>(true);
		// The factory outputs are exactly the neutral interfaces.
		assertType<Equal<ReturnType<typeof createPiContinuityCaptureV0>, ContinuityCaptureSourceV0>>(true);
		assertType<Equal<ReturnType<typeof createPiSessionOverviewCaptureV0>, SessionOverviewCaptureSourceV0>>(true);
		assertType<Equal<ReturnType<typeof createPiSteeringSourceV0>, SteeringSourceV0>>(true);
		assertType<Equal<ReturnType<typeof createPiControlDeckSourceV0>, ControlDeckSourceV0>>(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Import graph: the neutral port and its two host facets reach no Pi package and no Pi projection module,
// including through type imports; the Pi knowledge lives in the Pi port adapter and the composition root.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;

async function importGraph(entry: string): Promise<{ files: Set<string>; packages: Set<string> }> {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		files.add(file);
		for (const match of (await readFile(file, "utf8")).matchAll(SPECIFIER)) {
			const specifier = match[1]!;
			if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
			else packages.add(specifier);
		}
	}
	return { files, packages };
}

const LANE_PORT_MODULES = [
	"runtime/ports.ts",
	"runtime/contracts/continuity-facet.ts",
	"runtime/contracts/inspector.ts",
];
const CAPTURE_PROJECTION_MODULES = [
	"adapters/pi/continuity.ts",
	"adapters/pi/session-overview.ts",
	"adapters/pi/steering.ts",
	"adapters/pi/control-deck.ts",
];

describe("lane port import graph", () => {
	it.each(LANE_PORT_MODULES)("%s reaches no Pi package and no Pi projection module, even by type", async (module) => {
		const { files, packages } = await importGraph(resolve(ROOT, module));
		const reached = [...files].map((file) => file.slice(ROOT.length + 1));
		for (const specific of CAPTURE_PROJECTION_MODULES) expect(reached, module).not.toContain(specific);
		expect(
			[...packages].filter((name) => /^@earendil-works\/pi-(agent-core|coding-agent)(\/|$)/.test(name)),
			module,
		).toEqual([]);
		expect(
			[...packages].every((name) => name.startsWith("@earendil-works/chord")),
			module,
		).toBe(true);
	});

	it("keeps the Pi knowledge in the Pi port adapter and the session worker composition root", async () => {
		const adapter = await importGraph(resolve(ROOT, "adapters/pi/ports.ts"));
		expect(adapter.packages).toContain("@earendil-works/pi-agent-core");
		const worker = await readFile(resolve(ROOT, "runtime/session-worker.ts"), "utf8");
		const workerImports = [...worker.matchAll(SPECIFIER)].map((match) => match[1]!);
		expect(workerImports).toContain("../adapters/pi/ports.ts");
		// The worker never bypasses the port adapter to reach a capture projection directly.
		for (const specific of CAPTURE_PROJECTION_MODULES) {
			expect(workerImports, specific).not.toContain(`../${specific}`);
		}
	});
});
