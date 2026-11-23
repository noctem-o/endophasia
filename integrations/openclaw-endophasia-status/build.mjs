// Bundles src/index.ts (and the repository's protocol validator it uses) into dist/index.js. OpenClaw and TypeBox stay external:
// OpenClaw provides its SDK to the plugin at load time, and TypeBox is the package's one runtime dependency.
import { build } from "esbuild";

await build({
	entryPoints: [new URL("./src/index.ts", import.meta.url).pathname],
	outfile: new URL("./dist/index.js", import.meta.url).pathname,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	external: ["openclaw", "openclaw/*", "typebox"],
	legalComments: "none",
	logLevel: "warning",
});
