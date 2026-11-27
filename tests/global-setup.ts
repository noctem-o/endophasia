// Vitest global setup:
// 1. Ensures the Studio frontend (`studio-ui/dist`) is freshly built ONCE per test run before any worker starts,
//    eliminating concurrent `rmSync("studio-ui/dist")` races and redundant esbuild invocations across test files.
// 2. Removes the scratch digest-key directory vitest.config.ts creates for the run during teardown.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		digestKeyDirectory: string;
		studioUiDistDir: string;
	}
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export default async function setup(project: TestProject): Promise<() => void> {
	const { buildStudioUi } = (await import(join(REPO_ROOT, "scripts", "build-studio-ui.mjs"))) as {
		buildStudioUi(outDir?: string): Promise<{ outDir: string }>;
	};
	const built = await buildStudioUi(join(REPO_ROOT, "studio-ui", "dist"));
	project.provide("studioUiDistDir", built.outDir);

	const directory = project.config.provide?.digestKeyDirectory;
	return () => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	};
}
