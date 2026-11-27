// Vitest global setup (CI-RELIABILITY-001 F1/F2):
// 1. Builds the Studio frontend ONCE per Vitest execution context into a unique, immutable, owned temporary
//    directory (`endo-vitest-studio-ui-*`), validates it whole against its manifest, and provides both the
//    directory path and its expected manifest SHA-256 through Vitest context. Concurrent Vitest executions
//    never delete or replace each other's artifact directories.
// 2. Publishes that already-compiled artifact to `studio-ui/dist` via writer-serialized publication (zero-mutation
//    no-op when already byte-for-byte identical) solely for checkout CLI subprocess tests whose production
//    resolver (`cli/studio.ts`) intentionally refuses environment overrides.
// 3. Removes the owned temporary Studio UI directory and scratch digest-key directory during teardown only after
//    all test workers have finished.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";

declare module "vitest" {
	export interface ProvidedContext {
		digestKeyDirectory: string;
		studioUiDistDir: string;
		studioUiManifestSha256: string;
	}
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

export default async function setup(project: TestProject): Promise<() => void> {
	let ownedStudioUiDir: string | null = null;
	if (process.env.ENDO_SKIP_STUDIO_UI_PREBUILD !== "1") {
		const { buildStudioUi, publishStudioUiDirectory } = (await import(
			join(REPO_ROOT, "scripts", "build-studio-ui.mjs")
		)) as {
			buildStudioUi(outDir?: string): Promise<{
				outDir: string;
				manifest: { files: Array<{ name: string; bytes: number; sha256: string }> };
				manifestText: string;
				manifestSha256: string;
			}>;
			publishStudioUiDirectory(
				sourceDir: string,
				outDir: string,
				options: {
					manifestText: string;
					files: Array<{ name: string; bytes: number; sha256: string }>;
				},
			): Promise<{ outDir: string; replaced: boolean }>;
		};

		// Unique, immutable artifact directory owned exclusively by this Vitest execution context.
		ownedStudioUiDir = mkdtempSync(join(tmpdir(), "endo-vitest-studio-ui-"));
		const artifactDir = join(ownedStudioUiDir, "bundle");
		try {
			const built = await buildStudioUi(artifactDir);
			loadEndoStudioUiFilesV0(built.outDir);
			// Synchronize checkout `studio-ui/dist` for child CLI processes (zero extra esbuild compile;
			// writer-locked and zero-mutation no-op when already byte-identical).
			await publishStudioUiDirectory(built.outDir, join(REPO_ROOT, "studio-ui", "dist"), {
				manifestText: built.manifestText,
				files: built.manifest.files,
			});
			project.provide("studioUiDistDir", built.outDir);
			project.provide("studioUiManifestSha256", built.manifestSha256);
		} catch (error) {
			rmSync(ownedStudioUiDir, { recursive: true, force: true });
			ownedStudioUiDir = null;
			throw error;
		}
	} else {
		project.provide("studioUiDistDir", "");
		project.provide("studioUiManifestSha256", "");
	}

	const directory = project.config.provide?.digestKeyDirectory;
	return () => {
		if (ownedStudioUiDir) rmSync(ownedStudioUiDir, { recursive: true, force: true });
		if (directory) rmSync(directory, { recursive: true, force: true });
	};
}
