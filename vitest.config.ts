import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const piSource = (p: string) => fileURLToPath(new URL(`./pi/${p}`, import.meta.url));

export default defineConfig({
	// The Endophasia suites consume every Pi package from source, exactly as
	// the donor monorepo did: "source" exports conditions for node_modules
	// resolution, explicit aliases for the subpaths, and the coding-agent
	// experimental subpaths (source-only, never published).
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: piSource("packages/chord/src/index.ts") },
			{ find: /^@earendil-works\/chord\/context$/, replacement: piSource("packages/chord/src/context/index.ts") },
			{ find: /^@earendil-works\/chord\/delta$/, replacement: piSource("packages/chord/src/delta/index.ts") },
			{ find: /^@earendil-works\/chord\/bundler$/, replacement: piSource("packages/chord/src/bundler.ts") },
			{ find: /^@earendil-works\/chord\/node$/, replacement: piSource("packages/chord/src/node.ts") },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: piSource("packages/telemetry/src/index.ts") },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: piSource("packages/telemetry/src/testing/index.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: piSource("packages/ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: piSource("packages/ai/src/compat.ts") },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: piSource("packages/ai/src/oauth.ts") },
			{
				find: /^@earendil-works\/pi-ai\/utils\/(.+)$/,
				replacement: `${piSource("packages/ai/src/utils")}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/api\/(.+)$/,
				replacement: `${piSource("packages/ai/src/api")}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${piSource("packages/ai/src/providers")}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: piSource("packages/agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core\/node$/, replacement: piSource("packages/agent/src/node.ts") },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: piSource("packages/protocol/src/index.ts") },
			{ find: /^@earendil-works\/pi-client$/, replacement: piSource("packages/client/src/index.ts") },
			{ find: /^@earendil-works\/pi-client\/unix$/, replacement: piSource("packages/client/src/unix.ts") },
			{ find: /^@earendil-works\/pi-server$/, replacement: piSource("packages/server/src/index.ts") },
			{ find: /^@earendil-works\/pi-server\/unix$/, replacement: piSource("packages/server/src/transports/unix/index.ts") },
			{ find: /^@earendil-works\/pi-tui$/, replacement: piSource("packages/tui/src/index.ts") },
			// Source-only coding-agent experimental modules used by the Endophasia runtime layer.
			{
				find: /^@earendil-works\/pi-coding-agent\/experimental\/(.+)$/,
				replacement: `${piSource("packages/coding-agent/src/experimental")}/$1.ts`,
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		// Runtime and presentation tests start real servers and Session worker
		// processes, as the donor coding-agent tests do.
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
