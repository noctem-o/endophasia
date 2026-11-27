// Shared immutable Studio UI build accessor for tests.
//
// `tests/global-setup.ts` builds the Studio UI bundle ONCE per Vitest execution context into `studio-ui/dist`
// (atomically) before any test worker starts, and exposes its path via Vitest's `provide("studioUiDistDir")`.
// Suites that consume the built Studio frontend read from this immutable directory instead of racing on
// `rmSync("studio-ui/dist")` or redundantly running esbuild 30+ times per test run.
//
// Suites that specifically test clean/repeatable builds (`tests/endo-studio-ui.test.ts`) invoke `buildStudioUi`
// directly into their own private scratch directories.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_DIST = join(REPO_ROOT, "studio-ui", "dist");

let fallbackPromise: Promise<string> | undefined;

/**
 * Return the path to the immutable Studio UI build prepared for this test execution context.
 * Never deletes or mutates the shared directory during parallel test execution.
 */
export async function ensureSharedStudioUiDir(): Promise<string> {
	let provided: string | undefined;
	try {
		provided = inject("studioUiDistDir");
	} catch {
		provided = undefined;
	}
	if (provided && existsSync(join(provided, "studio-ui.manifest.json"))) {
		return provided;
	}
	if (existsSync(join(DEFAULT_DIST, "studio-ui.manifest.json"))) {
		return DEFAULT_DIST;
	}
	fallbackPromise ??= (async () => {
		const { buildStudioUi } = (await import(join(REPO_ROOT, "scripts/build-studio-ui.mjs"))) as {
			buildStudioUi(outDir?: string): Promise<{ outDir: string }>;
		};
		const built = await buildStudioUi(DEFAULT_DIST);
		return built.outDir;
	})();
	return fallbackPromise;
}
