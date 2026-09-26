import {
	type Context,
	createServiceCatalogueCall,
	defineFacet,
	defineService,
	type FacetLoader,
	parseServiceCatalogue,
} from "@earendil-works/chord";
import { type AgentLane, BACKGROUND_CONTEXT, type LaneSnapshot } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { Models } from "../src/experimental/services/models.ts";
import { SessionPlugins } from "../src/experimental/services/plugins.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { createSessionWorkerServices } from "../src/experimental/services/worker.ts";

const HostProbe = defineService<{ read(context: Context): Promise<string> }>("test.host-probe");
const scope = { serverConnectionId: "server-1", attachmentId: "attachment-1" };

function fakeLane(): AgentLane {
	const snapshot: LaneSnapshot = {
		lane: "main",
		transcript: [],
		tipId: null,
		configuration: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			activeToolNames: [],
		},
		stats: {
			messageCount: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		operation: null,
		queues: [],
		faulted: false,
	};
	return {
		async watch() {
			return {
				snapshot,
				start() {},
				async resnapshot() {
					return snapshot;
				},
				unsubscribe() {},
			};
		},
		async getModel() {
			return undefined;
		},
		async getThinkingLevel() {
			return "off" as const;
		},
	} as unknown as AgentLane;
}

describe("experimental plugin reload", () => {
	test("loads and cuts over a fresh Session facet generation", async () => {
		const activations: number[] = [];
		const disposals: number[] = [];
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				const current = ++generation;
				return {
					facets: [
						defineFacet({
							id: "reloadable-session-plugin",
							setup(env) {
								env.onActivate(() => {
									activations.push(current);
								});
							},
						}),
					],
					async dispose() {
						disposals.push(current);
					},
				};
			},
		};
		const lane = fakeLane();
		const services = await createSessionWorkerServices({
			lane,
			modelRuntime: undefined,
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			expect(activations).toEqual([1]);
			await services.invoke(
				{ serviceId: SessionPlugins.id, member: "reload", args: [] },
				{ serverConnectionId: "server-1", attachmentId: "attachment-1" },
				BACKGROUND_CONTEXT,
			);
			expect(activations).toEqual([1, 2]);
			expect(disposals).toEqual([1]);
		} finally {
			await services.dispose();
		}
		expect(disposals).toEqual([1, 2]);
	});

	test("keeps application host facets outside the reloadable plugin generation", async () => {
		const events: string[] = [];
		const hostFacet = defineFacet({
			id: "@test/host-probe",
			setup(env) {
				env.provide(HostProbe, { read: async () => "host" });
				env.onActivate(() => {
					events.push("host activated");
				});
				env.onDeactivate(() => {
					events.push("host deactivated");
				});
			},
		});
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				const current = ++generation;
				return {
					facets: [defineFacet({ id: "reloadable-session-plugin", setup() {} })],
					async dispose() {
						events.push(`plugins ${current} disposed`);
					},
				};
			},
		};
		const services = await createSessionWorkerServices({
			lane: fakeLane(),
			modelRuntime: undefined,
			hostFacets: [hostFacet],
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			const catalogue = parseServiceCatalogue(
				await services.invoke(createServiceCatalogueCall(), scope, BACKGROUND_CONTEXT),
			);
			expect(catalogue.filter((entry) => entry.serviceId === HostProbe.id)).toEqual([
				{ serviceId: HostProbe.id, mode: "singleton" },
			]);
			expect(catalogue.map((entry) => entry.serviceId)).toEqual(
				expect.arrayContaining([AgentController.id, Models.id, Transcript.id, SessionPlugins.id]),
			);

			await services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT);
			expect(events).toEqual(["host activated", "plugins 1 disposed"]);
			expect(
				await services.invoke({ serviceId: HostProbe.id, member: "read", args: [] }, scope, BACKGROUND_CONTEXT),
			).toBe("host");
		} finally {
			await services.dispose();
		}
		expect(events).toEqual(["host activated", "plugins 1 disposed", "host deactivated", "plugins 2 disposed"]);
	});

	test("rejects a plugin reload that would replace a host facet", async () => {
		const hostFacet = defineFacet({
			id: "@test/host-probe",
			setup(env) {
				env.provide(HostProbe, { read: async () => "host" });
			},
		});
		const disposals: number[] = [];
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				const current = ++generation;
				const plugin = defineFacet({ id: "reloadable-session-plugin", setup() {} });
				// The second generation ships a same-shaped facet under the host facet's ID.
				const impostor = defineFacet({
					id: hostFacet.id,
					setup(env) {
						env.provide(HostProbe, { read: async () => "plugin" });
					},
				});
				return {
					facets: current === 1 ? [plugin] : [plugin, impostor],
					async dispose() {
						disposals.push(current);
					},
				};
			},
		};
		const services = await createSessionWorkerServices({
			lane: fakeLane(),
			modelRuntime: undefined,
			hostFacets: [hostFacet],
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			await expect(
				services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT),
			).rejects.toThrow("Session plugin reload cannot replace facet @test/host-probe");
			expect(disposals).toEqual([2]);
			expect(
				await services.invoke({ serviceId: HostProbe.id, member: "read", args: [] }, scope, BACKGROUND_CONTEXT),
			).toBe("host");
		} finally {
			await services.dispose();
		}
		expect(disposals).toEqual([2, 1]);
	});

	test("ignores plugin mutation of a retained facet ID when checking a reload", async () => {
		const hostFacet = hostProbeFacet("host");
		const retained = defineFacet({ id: "reloadable-session-plugin", setup() {} });
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				generation++;
				return {
					facets: generation === 1 ? [retained] : [hostProbeFacet("plugin")],
					async dispose() {},
				};
			},
		};
		const services = await createSessionWorkerServices({
			lane: fakeLane(),
			modelRuntime: undefined,
			hostFacets: [hostFacet],
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			// Plugin code keeps its first-generation facet object and renames it after startup.
			(retained as { id: string }).id = hostFacet.id;
			await expect(
				services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT),
			).rejects.toThrow("Session plugin reload cannot replace facet @test/host-probe");
			expect(
				await services.invoke({ serviceId: HostProbe.id, member: "read", args: [] }, scope, BACKGROUND_CONTEXT),
			).toBe("host");
		} finally {
			await services.dispose();
		}
	});

	test("ignores plugin setup renaming another candidate facet during a reload", async () => {
		const hostFacet = hostProbeFacet("host");
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				generation++;
				if (generation === 1) {
					return {
						facets: [defineFacet({ id: "plugin-a", setup() {} }), defineFacet({ id: "plugin-b", setup() {} })],
						async dispose() {},
					};
				}
				// Passes an ID check made before setup, then becomes a host impostor once plugin-a's setup runs.
				const impostor = { ...hostProbeFacet("plugin"), id: "plugin-b" };
				const renamer = defineFacet({
					id: "plugin-a",
					setup() {
						impostor.id = hostFacet.id;
					},
				});
				return { facets: [renamer, impostor], async dispose() {} };
			},
		};
		const services = await createSessionWorkerServices({
			lane: fakeLane(),
			modelRuntime: undefined,
			hostFacets: [hostFacet],
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			await expect(
				services.invoke({ serviceId: SessionPlugins.id, member: "reload", args: [] }, scope, BACKGROUND_CONTEXT),
			).rejects.toThrow("Reloaded facet plugin-b must preserve its service requirements and provisions");
			expect(
				await services.invoke({ serviceId: HostProbe.id, member: "read", args: [] }, scope, BACKGROUND_CONTEXT),
			).toBe("host");
		} finally {
			await services.dispose();
		}
	});
});

describe("experimental plugin startup", () => {
	test("ignores plugin setup renaming another plugin facet to a host facet ID", async () => {
		const events: string[] = [];
		const hostFacet = defineFacet({
			id: "@test/host-probe",
			setup(env) {
				env.provide(HostProbe, { read: async () => "host" });
				env.onActivate(() => {
					events.push("host activated");
				});
				env.onDeactivate(() => {
					events.push("host deactivated");
				});
			},
		});
		const renamed = defineFacet({
			id: "plugin-b",
			setup(env) {
				env.onActivate(() => {
					events.push("plugin-b activated");
				});
			},
		});
		const renamer = defineFacet({
			id: "plugin-a",
			setup() {
				(renamed as { id: string }).id = hostFacet.id;
			},
		});
		const services = await createSessionWorkerServices({
			lane: fakeLane(),
			modelRuntime: undefined,
			hostFacets: [hostFacet],
			facetLoader: { load: async () => ({ facets: [renamer, renamed], async dispose() {} }) },
			publish: vi.fn(async () => {}),
		});
		try {
			expect(events.sort()).toEqual(["host activated", "plugin-b activated"]);
		} finally {
			await services.dispose();
		}
		expect(events).toContain("host deactivated");
	});
});

function hostProbeFacet(value: string) {
	return defineFacet({
		id: "@test/host-probe",
		setup(env) {
			env.provide(HostProbe, { read: async () => value });
		},
	});
}
