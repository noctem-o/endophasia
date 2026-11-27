// Immutable Studio UI build accessors for tests (CI-RELIABILITY-001 F1 & F2).
//
// In Vitest runs, `tests/global-setup.ts` builds the Studio UI once into a unique, immutable, execution-owned
// temporary directory (`endo-vitest-studio-ui-*`) and provides both `studioUiDistDir` and `studioUiManifestSha256`
// via Vitest context.
//
// Invariants (F2):
// - Never silently accept an unowned or stale `studio-ui/dist` based solely on manifest existence.
// - Always validate full manifest + file + sha256 + reference integrity via `loadEndoStudioUiFilesV0(...)`
//   and compare the manifest SHA-256 against the owning execution's expected hash when provided.
// - In CI (`CI=true`), fail closed if Vitest did not provide a verified build artifact.
// - In standalone non-CI local execution outside Vitest `globalSetup`, build a fresh, isolated, process-owned
//   temporary directory and remove it on process exit.
// - Checkout CLI subprocess tests (which spawn `node cli/index.ts`, where `cli/studio.ts` intentionally resolves
//   `studio-ui/dist` relative to itself rather than from env vars) use `ensureCheckoutStudioUiDir()`, which
//   verifies `studio-ui/dist` against the current execution's `studioUiManifestSha256` (rejecting stale builds).

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";
import { ENDO_STUDIO_UI_MANIFEST_NAME_V0, loadEndoStudioUiFilesV0 } from "../../cockpit-http/studio-ui.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHECKOUT_DIST = join(REPO_ROOT, "studio-ui", "dist");

let standalonePromise: Promise<string> | undefined;

export interface VerifiedStudioUiArtifactV0 {
	readonly dir: string;
	readonly manifestSha256: string;
}

/**
 * Verifies that `dir` is a complete, uncorrupted Studio UI build (regular files, exact manifest listing,
 * exact sizes and SHA-256s, closed local references) and, when `expectedManifestSha256` is provided,
 * confirms it matches the exact build generation expected by this test execution.
 */
export function verifyStudioUiArtifactDir(dir: string, expectedManifestSha256?: string): VerifiedStudioUiArtifactV0 {
	loadEndoStudioUiFilesV0(dir);
	const manifestText = readFileSync(join(dir, ENDO_STUDIO_UI_MANIFEST_NAME_V0), "utf8");
	const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
	if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
		throw new Error(
			`Studio UI artifact in ${dir} is stale or unowned: manifest sha256 ${manifestSha256} does not match expected ${expectedManifestSha256}`,
		);
	}
	return { dir, manifestSha256 };
}

function readVitestProvidedContext(): { dir: string; manifestSha256: string } {
	try {
		return {
			dir: inject("studioUiDistDir") ?? "",
			manifestSha256: inject("studioUiManifestSha256") ?? "",
		};
	} catch {
		return { dir: "", manifestSha256: "" };
	}
}

/**
 * Return the verified path to the immutable Studio UI build prepared for this test execution context.
 * Fails closed on missing, corrupted, or stale artifacts and never falls back to an unowned `studio-ui/dist`.
 */
export async function ensureSharedStudioUiDir(options?: {
	readonly ci?: boolean;
	readonly providedDir?: string;
	readonly expectedManifestSha256?: string;
}): Promise<string> {
	const ctx =
		options?.providedDir !== undefined || options?.expectedManifestSha256 !== undefined
			? { dir: options.providedDir ?? "", manifestSha256: options.expectedManifestSha256 ?? "" }
			: readVitestProvidedContext();
	const isCi = options?.ci ?? process.env.CI === "true";

	if (ctx.dir) {
		if (!ctx.manifestSha256) {
			throw new Error(
				`Studio UI build context provided directory ${ctx.dir} without expected manifest sha256; refusing unverified artifact`,
			);
		}
		return verifyStudioUiArtifactDir(ctx.dir, ctx.manifestSha256).dir;
	}

	if (isCi) {
		throw new Error(
			"Studio UI build artifact was not provided by Vitest globalSetup in CI (ENDO_SKIP_STUDIO_UI_PREBUILD=1 or missing globalSetup); refusing stale fallback",
		);
	}

	// Standalone local execution outside Vitest globalSetup: build a fresh, isolated, process-owned copy.
	standalonePromise ??= (async () => {
		const ownedParent = mkdtempSync(join(tmpdir(), "endo-studio-ui-standalone-"));
		const bundleDir = join(ownedParent, "bundle");
		process.once("exit", () => {
			try {
				rmSync(ownedParent, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup on process exit.
			}
		});
		const { buildStudioUi } = (await import(join(REPO_ROOT, "scripts/build-studio-ui.mjs"))) as {
			buildStudioUi(outDir?: string): Promise<{ outDir: string; manifestSha256: string }>;
		};
		const built = await buildStudioUi(bundleDir);
		return verifyStudioUiArtifactDir(built.outDir, built.manifestSha256).dir;
	})();
	standalonePromise.catch(() => {
		standalonePromise = undefined;
	});
	return standalonePromise;
}

/**
 * Verifies that the checkout's `studio-ui/dist` directory (resolved relative to `cli/studio.ts` by child CLI
 * processes) is intact and matches the current test execution's freshly built manifest SHA-256.
 * Rejects stale-but-internally-valid assets from earlier revisions.
 */
export async function ensureCheckoutStudioUiDir(options?: {
	readonly ci?: boolean;
	readonly checkoutDir?: string;
	readonly expectedManifestSha256?: string;
}): Promise<string> {
	const checkoutDir = options?.checkoutDir ?? CHECKOUT_DIST;
	const ctx =
		options?.expectedManifestSha256 !== undefined
			? { dir: "", manifestSha256: options.expectedManifestSha256 }
			: readVitestProvidedContext();
	const isCi = options?.ci ?? process.env.CI === "true";

	if (ctx.manifestSha256) {
		return verifyStudioUiArtifactDir(checkoutDir, ctx.manifestSha256).dir;
	}

	if (isCi) {
		throw new Error(
			`Checkout Studio UI directory ${checkoutDir} cannot be verified in CI without an expected manifest sha256 from Vitest globalSetup`,
		);
	}

	// Standalone non-CI local run: build/sync checkout dir via writer-locked publication and verify against its hash.
	const { buildStudioUi } = (await import(join(REPO_ROOT, "scripts/build-studio-ui.mjs"))) as {
		buildStudioUi(outDir?: string): Promise<{ outDir: string; manifestSha256: string }>;
	};
	const built = await buildStudioUi(checkoutDir);
	return verifyStudioUiArtifactDir(built.outDir, built.manifestSha256).dir;
}
