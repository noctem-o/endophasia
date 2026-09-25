import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node", include: ["test/**/*.test.ts"] },
	resolve: {
		conditions: ["source"],
		alias: [
			{
				find: /^@earendil-works\/chord\/context$/,
				replacement: fileURLToPath(new URL("../chord/src/context/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/chord$/,
				replacement: fileURLToPath(new URL("../chord/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-ai\/utils\/uuid$/,
				replacement: fileURLToPath(new URL("../ai/src/utils/uuid.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-telemetry$/,
				replacement: fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-ai$/,
				replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-agent-core$/,
				replacement: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
