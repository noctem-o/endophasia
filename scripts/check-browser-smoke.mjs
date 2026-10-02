import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "endophasia-browser-smoke.js");
const errorLogPath = join(tmpdir(), "endophasia-browser-smoke-errors.log");

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

try {
	// The Presentation Client, its browser transport and the Standard Cockpit must bundle without Node or host code.
	for (const [entryPoint, expectedInputs] of [
		[
			"scripts/endophasia-browser-transport-smoke-entry.ts",
			[
				"presentation/websocket-transport.ts",
				"presentation/client.ts",
				"runtime/contracts/continuity.ts",
				"runtime/contracts/runtime-profile.ts",
			],
		],
		[
			"cockpit/main.ts",
			[
				"cockpit/view.ts",
				"cockpit/controller.ts",
				"runtime/contracts/mission-trace.ts",
				"runtime/contracts/runtime-facts.ts",
				"runtime/contracts/usage.ts",
				"runtime/contracts/continuity.ts",
				"runtime/contracts/runtime-profile.ts",
				"presentation/websocket-transport.ts",
				"presentation/client.ts",
				"pi/packages/client/src/client.ts",
				"pi/packages/protocol/src/index.ts",
			],
		],
	]) {
		const endophasiaBuild = await build({
			entryPoints: [entryPoint],
			bundle: true,
			platform: "browser",
			format: "esm",
			logLevel: "silent",
			metafile: true,
			outfile: outputPath,
			write: false,
		});
		const endophasiaInputs = endophasiaBuild.metafile.inputs;
		for (const expectedInput of expectedInputs) {
			if (!findInput(endophasiaInputs, expectedInput)) {
				throw new Error(`Endophasia browser bundle ${entryPoint} does not include ${expectedInput}`);
			}
		}
		// adapters/pi/session-overview.ts is deliberately not forbidden: it is browser-safe (type-only Pi
		// imports), as the donor's src/session-overview.ts was in the donor's smoke check.
		const forbiddenEndophasiaInputs = Object.keys(endophasiaInputs).filter((input) => {
			const normalized = normalizePath(input);
			return (
				normalized.startsWith("node:") ||
				normalized.includes("node_modules/ws/") ||
				normalized.includes("node_modules/esbuild/") ||
				normalized.includes("pi/packages/agent/src/") ||
				normalized.includes("pi/packages/server/") ||
				normalized.endsWith("pi/packages/client/src/unix.ts") ||
				normalized.endsWith("pi/packages/coding-agent/src/experimental/server.ts") ||
				normalized.includes("adapters/prime/") ||
				normalized.includes("research/") ||
				normalized.endsWith("runtime/session-worker.ts") ||
				normalized.endsWith("runtime/server.ts") ||
				normalized.endsWith("runtime/browser-server.ts") ||
				normalized.endsWith("runtime/browser-listener.ts") ||
				normalized.endsWith("runtime/cockpit.ts") ||
				normalized.endsWith("runtime/cockpit-host.ts") ||
				normalized.endsWith("runtime/cockpit-main.ts") ||
				// Runtime observation ports are not needed to render a profile.
				normalized.endsWith("runtime/observation/ports.ts") ||
				// The Usage contract is bundled; the durable ledger, feed and host facet stay on the host.
				normalized.endsWith("runtime/contracts/usage-facet.ts") ||
				normalized.endsWith("adapters/pi/usage-feed.ts") ||
				normalized.endsWith("adapters/pi/usage-ledger.ts") ||
				// The Continuity contract is bundled; the Pi-backed capture and its host facet stay on the host.
				normalized.endsWith("adapters/pi/continuity.ts") ||
				normalized.endsWith("runtime/contracts/continuity-facet.ts") ||
				// The Runtime Profile contract is bundled; its host publisher and the composition roots that state a
				// profile (runtime/, including runtime/session-worker.ts) stay on the host.
				normalized.endsWith("runtime/contracts/runtime-profile-facet.ts") ||
				// Runtime observation contracts are bundled; the runtime adapter and its projections stay on the host.
				normalized.endsWith("adapters/pi/observation-sources.ts") ||
				normalized.endsWith("adapters/pi/mission-trace.ts") ||
				normalized.endsWith("adapters/pi/runtime-metrics.ts") ||
				normalized.endsWith("adapters/pi/durable-outcomes.ts")
			);
		});
		if (forbiddenEndophasiaInputs.length > 0) {
			throw new Error(
				`Endophasia browser bundle ${entryPoint} unexpectedly includes ${forbiddenEndophasiaInputs.join(", ")}`,
			);
		}
	}

	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Endophasia browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
