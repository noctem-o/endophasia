// Deterministic regression tests for Studio UI build publication, execution-owned immutable artifacts,
// writer serialization, rollback recovery, and stale/corrupted build rejection (CI-RELIABILITY-001 F1 & F2).
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENDO_STUDIO_UI_MANIFEST_NAME_V0, loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import {
	ensureCheckoutStudioUiDir,
	ensureSharedStudioUiDir,
	verifyStudioUiArtifactDir,
} from "./helpers/studio-ui-build.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const cleanupDirs: string[] = [];
let referenceDir = "";
let referenceManifestText = "";
let referenceManifestSha256 = "";
let referenceFiles: Array<{ name: string; bytes: number; sha256: string }> = [];

function makeTempDir(prefix = "endo-studio-pub-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

function createSyntheticGeneration(
	dir: string,
	label: string,
): {
	dir: string;
	manifestText: string;
	manifestSha256: string;
	files: Array<{ name: string; bytes: number; sha256: string }>;
} {
	mkdirSync(dir, { recursive: true });
	const scriptName = `main-${label}.js`;
	const styleName = `main-${label}.css`;
	const html = `<!doctype html><html><head><link rel="stylesheet" href="./assets/${styleName}"></head><body><script type="module" src="./assets/${scriptName}"></script></body></html>\n`;
	const js = `export const gen = ${JSON.stringify(label)};\n`;
	const css = `body { content: ${JSON.stringify(label)}; }\n`;
	writeFileSync(join(dir, "index.html"), html, "utf8");
	writeFileSync(join(dir, scriptName), js, "utf8");
	writeFileSync(join(dir, styleName), css, "utf8");
	const files = readdirSync(dir)
		.sort()
		.map((name) => {
			const bytes = readFileSync(join(dir, name));
			return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
		});
	const manifest = { format: "endo.studio-ui-manifest/v0", entry: "index.html", files };
	const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
	const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
	writeFileSync(join(dir, ENDO_STUDIO_UI_MANIFEST_NAME_V0), manifestText, "utf8");
	return { dir, manifestText, manifestSha256, files };
}

beforeAll(async () => {
	referenceDir = await ensureSharedStudioUiDir();
	referenceManifestText = readFileSync(join(referenceDir, ENDO_STUDIO_UI_MANIFEST_NAME_V0), "utf8");
	referenceManifestSha256 = createHash("sha256").update(referenceManifestText, "utf8").digest("hex");
	const parsed = JSON.parse(referenceManifestText) as {
		files: Array<{ name: string; bytes: number; sha256: string }>;
	};
	referenceFiles = parsed.files;
}, 90_000);

afterEach(() => {
	while (cleanupDirs.length > 0) {
		rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
	}
});

afterAll(() => {
	while (cleanupDirs.length > 0) {
		rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Studio UI execution-owned immutable artifacts & publication (F1 & F2)", () => {
	it("provides a unique, immutable, execution-owned directory outside studio-ui/dist and keeps independent contexts isolated", async () => {
		const checkoutDist = join(REPO_ROOT, "studio-ui", "dist");
		expect(referenceDir).not.toBe(checkoutDist);
		expect(referenceDir).toContain("endo-vitest-studio-ui-");

		// Simulate two simultaneous independent Vitest execution contexts with distinct artifact generations.
		const ctxRoot = makeTempDir("endo-two-ctx-");
		const genA = createSyntheticGeneration(join(ctxRoot, "ctx-a", "bundle"), "genA0001");
		const genB = createSyntheticGeneration(join(ctxRoot, "ctx-b", "bundle"), "genB0002");

		const resolvedA = await ensureSharedStudioUiDir({
			ci: true,
			providedDir: genA.dir,
			expectedManifestSha256: genA.manifestSha256,
		});
		const resolvedB = await ensureSharedStudioUiDir({
			ci: true,
			providedDir: genB.dir,
			expectedManifestSha256: genB.manifestSha256,
		});
		expect(resolvedA).toBe(genA.dir);
		expect(resolvedB).toBe(genB.dir);

		// Context A finishes and cleans up its owned directory; Context B's reader retains full intact access.
		rmSync(join(ctxRoot, "ctx-a"), { recursive: true, force: true });
		expect(existsSync(genA.dir)).toBe(false);
		const filesB = loadEndoStudioUiFilesV0(resolvedB);
		expect(Buffer.from(filesB["main-genB0002.js"]!).toString("utf8")).toContain("genB0002");
		expect(verifyStudioUiArtifactDir(resolvedB, genB.manifestSha256).manifestSha256).toBe(genB.manifestSha256);
	});

	it("skips mutation on byte-identical generations, replaces different generations cleanly, and serializes concurrent writers deterministically", async () => {
		const { publishStudioUiDirectory } = (await import(join(REPO_ROOT, "scripts", "build-studio-ui.mjs"))) as {
			publishStudioUiDirectory(
				sourceDir: string,
				outDir: string,
				options: {
					manifestText: string;
					files: Array<{ name: string; bytes: number; sha256: string }>;
					hooks?: {
						onLockAcquired?: () => void | Promise<void>;
						beforeSwap?: () => void | Promise<void>;
						afterMoveOld?: () => void | Promise<void>;
					};
				},
			): Promise<{ outDir: string; replaced: boolean }>;
		};

		const root = makeTempDir("endo-pub-serial-");
		const gen1 = createSyntheticGeneration(join(root, "src-1"), "aaaa1111");
		const gen2 = createSyntheticGeneration(join(root, "src-2"), "bbbb2222");
		const target = join(root, "published");

		// First publication creates target in one rename.
		const first = await publishStudioUiDirectory(gen1.dir, target, {
			manifestText: gen1.manifestText,
			files: gen1.files,
		});
		expect(first.replaced).toBe(true);
		const inodeBefore = lstatSync(target).ino;

		// Identical generation is a zero-mutation no-op (directory inode unchanged).
		const second = await publishStudioUiDirectory(gen1.dir, target, {
			manifestText: gen1.manifestText,
			files: gen1.files,
		});
		expect(second.replaced).toBe(false);
		expect(lstatSync(target).ino).toBe(inodeBefore);

		// Deterministic writer-serialization barrier: writer 1 holds lock while writer 2 starts and must wait.
		const order: string[] = [];
		let releaseWriter1!: () => void;
		const writer1Holding = new Promise<void>((resolve) => {
			releaseWriter1 = resolve;
		});
		let writer1Entered!: () => void;
		const waitWriter1Entered = new Promise<void>((resolve) => {
			writer1Entered = resolve;
		});

		const p1 = publishStudioUiDirectory(gen2.dir, target, {
			manifestText: gen2.manifestText,
			files: gen2.files,
			hooks: {
				onLockAcquired: async () => {
					order.push("w1-acquired");
					writer1Entered();
					await writer1Holding;
					order.push("w1-releasing");
				},
			},
		});
		await waitWriter1Entered;

		const p2 = publishStudioUiDirectory(gen2.dir, target, {
			manifestText: gen2.manifestText,
			files: gen2.files,
			hooks: {
				onLockAcquired: () => {
					order.push("w2-acquired");
				},
			},
		});

		// Give writer 2 several lock-poll intervals to verify it cannot overtake writer 1.
		await new Promise((r) => setTimeout(r, 80));
		expect(order).toEqual(["w1-acquired"]);

		releaseWriter1();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(order).toEqual(["w1-acquired", "w1-releasing", "w2-acquired"]);
		expect(r1.replaced).toBe(true);
		// Writer 2 sees the already-published identical gen2 and performs a zero-mutation no-op!
		expect(r2.replaced).toBe(false);
		expect(verifyStudioUiArtifactDir(target, gen2.manifestSha256).manifestSha256).toBe(gen2.manifestSha256);
	});

	it("preserves existing target on interrupted publication and rolls back cleanly on failed replacement", async () => {
		const { publishStudioUiDirectory } = (await import(join(REPO_ROOT, "scripts", "build-studio-ui.mjs"))) as {
			publishStudioUiDirectory(
				sourceDir: string,
				outDir: string,
				options: {
					manifestText: string;
					files: Array<{ name: string; bytes: number; sha256: string }>;
					hooks?: {
						beforeSwap?: () => void | Promise<void>;
						afterMoveOld?: () => void | Promise<void>;
					};
				},
			): Promise<{ outDir: string; replaced: boolean }>;
		};

		const root = makeTempDir("endo-pub-recovery-");
		const gen1 = createSyntheticGeneration(join(root, "src-1"), "orig1111");
		const gen2 = createSyntheticGeneration(join(root, "src-2"), "next2222");
		const target = join(root, "published");

		await publishStudioUiDirectory(gen1.dir, target, { manifestText: gen1.manifestText, files: gen1.files });

		// 1. Interrupted before swap: target untouched, no leftover stage dirs.
		await expect(
			publishStudioUiDirectory(gen2.dir, target, {
				manifestText: gen2.manifestText,
				files: gen2.files,
				hooks: {
					beforeSwap: () => {
						throw new Error("simulated interruption before swap");
					},
				},
			}),
		).rejects.toThrow(/simulated interruption before swap/);
		expect(verifyStudioUiArtifactDir(target, gen1.manifestSha256).manifestSha256).toBe(gen1.manifestSha256);
		expect(readdirSync(root).filter((n) => n.includes(".stage-") || n.includes(".old-"))).toEqual([]);

		// 2. Failed replacement after moving old target aside: stale directory is rolled back onto target!
		await expect(
			publishStudioUiDirectory(gen2.dir, target, {
				manifestText: gen2.manifestText,
				files: gen2.files,
				hooks: {
					afterMoveOld: () => {
						throw new Error("simulated failure mid-swap");
					},
				},
			}),
		).rejects.toThrow(/simulated failure mid-swap/);
		expect(existsSync(target)).toBe(true);
		expect(verifyStudioUiArtifactDir(target, gen1.manifestSha256).manifestSha256).toBe(gen1.manifestSha256);
		expect(readdirSync(root).filter((n) => n.includes(".stage-") || n.includes(".old-"))).toEqual([]);
	});

	it("rejects stale-but-internally-valid assets, corrupt/missing manifests, missing files, bad hashes, unexpected files, symlinks, and missing CI context (F2)", async () => {
		const root = makeTempDir("endo-f2-guards-");
		const staleGen = createSyntheticGeneration(join(root, "stale"), "stale999");

		// Stale-but-internally-valid directory passes loadEndoStudioUiFilesV0 on its own...
		expect(() => loadEndoStudioUiFilesV0(staleGen.dir)).not.toThrow();
		// ...but is REJECTED by ensureSharedStudioUiDir and ensureCheckoutStudioUiDir when expected sha256 differs!
		await expect(
			ensureSharedStudioUiDir({
				ci: true,
				providedDir: staleGen.dir,
				expectedManifestSha256: referenceManifestSha256,
			}),
		).rejects.toThrow(/stale or unowned/);
		await expect(
			ensureCheckoutStudioUiDir({
				ci: true,
				checkoutDir: staleGen.dir,
				expectedManifestSha256: referenceManifestSha256,
			}),
		).rejects.toThrow(/stale or unowned/);

		// CI refuses unprovided context (never falls back to unowned studio-ui/dist).
		await expect(ensureSharedStudioUiDir({ ci: true, providedDir: "", expectedManifestSha256: "" })).rejects.toThrow(
			/refusing stale fallback/,
		);
		await expect(
			ensureCheckoutStudioUiDir({ ci: true, checkoutDir: staleGen.dir, expectedManifestSha256: "" }),
		).rejects.toThrow(/cannot be verified in CI/);

		// Corrupt manifest
		const corruptManifest = join(root, "corrupt-manifest");
		cpSync(staleGen.dir, corruptManifest, { recursive: true });
		writeFileSync(join(corruptManifest, ENDO_STUDIO_UI_MANIFEST_NAME_V0), "{not json");
		expect(() => verifyStudioUiArtifactDir(corruptManifest)).toThrow(TypeError);

		// Missing manifest
		const missingManifest = join(root, "missing-manifest");
		cpSync(staleGen.dir, missingManifest, { recursive: true });
		rmSync(join(missingManifest, ENDO_STUDIO_UI_MANIFEST_NAME_V0));
		expect(() => verifyStudioUiArtifactDir(missingManifest)).toThrow(/missing/);

		// Missing asset file
		const missingFile = join(root, "missing-file");
		cpSync(staleGen.dir, missingFile, { recursive: true });
		rmSync(join(missingFile, "main-stale999.js"));
		expect(() => verifyStudioUiArtifactDir(missingFile)).toThrow(/missing/);

		// Incorrect hash
		const badHash = join(root, "bad-hash");
		cpSync(staleGen.dir, badHash, { recursive: true });
		writeFileSync(join(badHash, "main-stale999.js"), "export const tampered = true;\n");
		expect(() => verifyStudioUiArtifactDir(badHash)).toThrow(/does not match/);

		// Unexpected extra file
		const extraFile = join(root, "extra-file");
		cpSync(staleGen.dir, extraFile, { recursive: true });
		writeFileSync(join(extraFile, "unexpected.js"), "// extra\n");
		expect(() => verifyStudioUiArtifactDir(extraFile)).toThrow(/present but not listed/);

		// Symlinked asset
		const symlinked = join(root, "symlinked");
		cpSync(staleGen.dir, symlinked, { recursive: true });
		const targetFile = join(root, "real-js.js");
		writeFileSync(targetFile, readFileSync(join(symlinked, "main-stale999.js")));
		rmSync(join(symlinked, "main-stale999.js"));
		symlinkSync(targetFile, join(symlinked, "main-stale999.js"));
		expect(() => verifyStudioUiArtifactDir(symlinked)).toThrow(/not a regular file/);
	});

	it("keeps checkout studio-ui/dist synchronized with the current test execution's manifest hash", async () => {
		const checkoutDir = await ensureCheckoutStudioUiDir();
		expect(checkoutDir).toBe(join(REPO_ROOT, "studio-ui", "dist"));
		expect(verifyStudioUiArtifactDir(checkoutDir, referenceManifestSha256).manifestSha256).toBe(
			referenceManifestSha256,
		);
		expect(referenceFiles.length).toBeGreaterThan(0);
	});

	it("enforces lockTimeoutMs when a live reap lock blocks recovery and recovers orphaned dead-PID reap locks", async () => {
		const { publishStudioUiDirectory } = (await import(join(REPO_ROOT, "scripts", "build-studio-ui.mjs"))) as {
			publishStudioUiDirectory(
				sourceDir: string,
				outDir: string,
				options: {
					manifestText: string;
					files: Array<{ name: string; bytes: number; sha256: string }>;
					lockTimeoutMs?: number;
				},
			): Promise<{ outDir: string; replaced: boolean }>;
		};

		const root = makeTempDir("endo-pub-reap-");
		const gen = createSyntheticGeneration(join(root, "src"), "reap1234");
		const target = join(root, "published");
		const lockPath = join(root, ".published.build.lock");
		const reapPath = `${lockPath}.reap`;

		// 1. Dead-PID publication lock + live-PID reap lock -> MUST enforce lockTimeoutMs instead of spinning.
		writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead", startedAt: Date.now() }));
		writeFileSync(reapPath, JSON.stringify({ pid: process.pid, token: "live-reaper", startedAt: Date.now() }));
		const t0 = Date.now();
		await expect(
			publishStudioUiDirectory(gen.dir, target, {
				manifestText: gen.manifestText,
				files: gen.files,
				lockTimeoutMs: 60,
			}),
		).rejects.toThrow(/Timed out after 60ms/);
		expect(Date.now() - t0).toBeLessThan(2_000);

		// 2. Dead-PID publication lock + orphaned dead-PID reap lock -> recovers cleanly and publishes.
		writeFileSync(reapPath, JSON.stringify({ pid: 999_999_998, token: "dead-reaper", startedAt: Date.now() }));
		const recovered = await publishStudioUiDirectory(gen.dir, target, {
			manifestText: gen.manifestText,
			files: gen.files,
			lockTimeoutMs: 1_000,
		});
		expect(recovered.replaced).toBe(true);
		expect(verifyStudioUiArtifactDir(target, gen.manifestSha256).manifestSha256).toBe(gen.manifestSha256);
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(reapPath)).toBe(false);
	});
});
