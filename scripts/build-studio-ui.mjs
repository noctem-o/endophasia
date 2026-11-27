// Build the Studio frontend foundation: bundle studio-ui/src (React, TypeScript) with esbuild into one flat directory of
// content-hashed files that the launcher serves from memory, write the page that references them, and write a manifest that lists
// every file with its size and sha256. The host (cockpit-http/host.ts) refuses a directory that does not match its manifest, so a
// damaged, partial or tampered install fails before anything listens.
//
// Why esbuild and not Vite: the production server serves a flat, closed set of files at /<capability>/assets/<name>, and checks the
// page's own references. esbuild gives exactly that with one dependency: flat output names, no HTML transform, no generated preload
// or CSS-injection helper, no absolute base, and a metafile that names every output. Nothing here runs at install time: the
// published package carries only the output.
//
// Publication contract (CI-RELIABILITY-001 F1):
// - Writers targeting the same `outDir` serialize via an exclusive sibling lock file (`openSync(..., "wx")`).
// - If `outDir` already exists as a real directory whose regular files and manifest match byte-for-byte, publication is a
//   zero-mutation no-op (existing readers observe no disruption).
// - If `outDir` does not yet exist, staging followed by a single `renameSync(stage, target)` publishes it in one directory entry.
// - If `outDir` exists with different contents, replacement uses two POSIX renames (`target -> stale`, `stage -> target`) with
//   deterministic rollback (`stale -> target`) on failure and NO destructive `rmSync(target)` fallback. Because POSIX `rename(2)`
//   cannot atomically replace a non-empty directory with another directory without Linux-specific `renameat2(RENAME_EXCHANGE)`,
//   there is a brief non-atomic swap interval when replacing an existing directory whose contents changed; production builds
//   (`npm run build` -> `dist/studio-ui`) run offline without concurrent readers, and concurrent Vitest runs isolate their
//   in-process browser/host consumers into per-execution immutable directories (see `tests/global-setup.ts`).
//
//   node scripts/build-studio-ui.mjs [outDir]       (default studio-ui/dist)
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

export const STUDIO_UI_MANIFEST_NAME = "studio-ui.manifest.json";
export const STUDIO_UI_MANIFEST_FORMAT = "endo.studio-ui-manifest/v0";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_MAX_AGE_MS = 120_000;

function lstatExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function sleepSyncOrAsync(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Acquire an exclusive writer lock file beside `target` so concurrent builders never interleave
 * directory swaps or corrupt each other's staging directories.
 * @param {string} lockPath
 * @param {number} [timeoutMs]
 */
async function acquirePublicationLock(lockPath, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
	mkdirSync(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
			} catch (writeErr) {
				closeSync(fd);
				try {
					unlinkSync(lockPath);
				} catch {}
				throw writeErr;
			}
			closeSync(fd);
			return () => {
				try {
					const raw = readFileSync(lockPath, "utf8");
					const parsed = JSON.parse(raw);
					if (parsed?.token === token) unlinkSync(lockPath);
				} catch {
					// Lock already gone or replaced.
				}
			};
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			// Inspect whether an existing lock belongs to a dead process or has expired; serialize
			// stale-lock reaping through a short-lived sibling `.reap` lock so two waiters cannot
			// unlink a fresh lock acquired by the other.
			try {
				const isStale = () => {
					const stat = lstatSync(lockPath);
					const ageMs = Date.now() - stat.mtimeMs;
					let stale = ageMs > STALE_LOCK_MAX_AGE_MS;
					try {
						const holder = JSON.parse(readFileSync(lockPath, "utf8"));
						if (typeof holder?.pid === "number" && !isPidAlive(holder.pid)) {
							stale = true;
						}
					} catch {
						if (ageMs > 5_000) stale = true;
					}
					return stale;
				};
				if (isStale()) {
					const reapLock = `${lockPath}.reap`;
					try {
						const rfd = openSync(reapLock, "wx", 0o600);
						closeSync(rfd);
						try {
							if (lstatExists(lockPath) && isStale()) unlinkSync(lockPath);
						} finally {
							try {
								unlinkSync(reapLock);
							} catch {}
						}
					} catch {
						// Another waiter is currently reaping or lock vanished.
					}
					continue;
				}
			} catch {
				// Lock disappeared between openSync and lstatSync; retry immediately.
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out after ${timeoutMs}ms waiting for Studio UI publication lock ${lockPath}`);
			}
			await sleepSyncOrAsync(20);
		}
	}
}

/**
 * Checks whether `target` is already a real directory holding regular files byte-for-byte identical
 * to `manifestText` and `files` (no missing files, no extra files, no symlinks).
 * @param {string} target
 * @param {string} manifestText
 * @param {Array<{ name: string, bytes: number, sha256: string }>} files
 */
function isDirectoryIdentical(target, manifestText, files) {
	try {
		if (!lstatSync(target).isDirectory()) return false;
		const manifestPath = join(target, STUDIO_UI_MANIFEST_NAME);
		if (!lstatSync(manifestPath).isFile()) return false;
		if (readFileSync(manifestPath, "utf8") !== manifestText) return false;
		const expectedNames = [...files.map((f) => f.name), STUDIO_UI_MANIFEST_NAME].sort();
		if (readdirSync(target).sort().join("\0") !== expectedNames.join("\0")) return false;
		return files.every((f) => {
			const filePath = join(target, f.name);
			if (!lstatSync(filePath).isFile()) return false;
			const bytes = readFileSync(filePath);
			return bytes.length === f.bytes && createHash("sha256").update(bytes).digest("hex") === f.sha256;
		});
	} catch {
		return false;
	}
}

/**
 * Publishes an already-built Studio UI directory `sourceDir` into `outDir` under an exclusive writer lock.
 * - Zero-mutation no-op if `outDir` is already byte-for-byte identical.
 * - Single `renameSync(stage, target)` if `outDir` does not yet exist.
 * - Writer-serialized staged swap with deterministic rollback if `outDir` exists with different contents
 *   (never falls back to destructive `rmSync(target)`).
 *
 * @param {string} sourceDir
 * @param {string} outDir
 * @param {{
 *   manifestText: string,
 *   files: Array<{ name: string, bytes: number, sha256: string }>,
 *   lockTimeoutMs?: number,
 *   hooks?: {
 *     onLockAcquired?: () => void | Promise<void>,
 *     beforeSwap?: (ctx: { stage: string, target: string, stale: string }) => void | Promise<void>,
 *     afterMoveOld?: (ctx: { stage: string, target: string, stale: string }) => void | Promise<void>,
 *   }
 * }} options
 */
export async function publishStudioUiDirectory(sourceDir, outDir, options) {
	const target = resolve(outDir);
	const parent = dirname(target);
	mkdirSync(parent, { recursive: true });
	const lockPath = join(parent, `.${basename(target)}.build.lock`);
	const releaseLock = await acquirePublicationLock(lockPath, options.lockTimeoutMs);
	try {
		if (options.hooks?.onLockAcquired) await options.hooks.onLockAcquired();
		if (isDirectoryIdentical(target, options.manifestText, options.files)) {
			return { outDir, replaced: false };
		}
		const tag = `${process.pid}-${randomBytes(6).toString("hex")}`;
		const stage = join(parent, `.${basename(target)}.stage-${tag}`);
		const stale = join(parent, `.${basename(target)}.old-${tag}`);
		mkdirSync(stage, { recursive: true });
		let movedOld = false;
		try {
			for (const name of readdirSync(sourceDir)) {
				copyFileSync(join(sourceDir, name), join(stage, name));
			}
			if (options.hooks?.beforeSwap) await options.hooks.beforeSwap({ stage, target, stale });
			if (lstatExists(target)) {
				// Never fall back to destructive `rmSync(target)`: if moving `target` aside fails,
				// abort cleanly with `target` untouched.
				renameSync(target, stale);
				movedOld = true;
				if (options.hooks?.afterMoveOld) await options.hooks.afterMoveOld({ stage, target, stale });
			}
			renameSync(stage, target);
			return { outDir, replaced: true };
		} catch (error) {
			rmSync(stage, { recursive: true, force: true });
			if (movedOld && !lstatExists(target) && lstatExists(stale)) {
				try {
					renameSync(stale, target);
					movedOld = false;
				} catch {
					// Preserve original error; stale remains on disk for recovery inspection.
				}
			}
			throw error;
		} finally {
			if (movedOld && lstatExists(stale) && lstatExists(target)) {
				rmSync(stale, { recursive: true, force: true });
			}
		}
	} finally {
		releaseLock();
	}
}

/**
 * Build into `outDir` using writer-serialized staged publication. Returns the directory, the manifest,
 * the manifest SHA-256 hex digest, and the packages whose code or font is in the output for licence notices.
 * The output is a function of the sources and pinned dependencies only: no timestamp, no absolute path,
 * no source map.
 */
export async function buildStudioUi(outDir = join(root, "studio-ui", "dist"), options = {}) {
	const scratch = mkdtempSync(join(tmpdir(), "endo-studio-ui-"));
	try {
		const result = await build({
			absWorkingDir: root,
			entryPoints: { main: "studio-ui/src/main.tsx" },
			outdir: scratch,
			bundle: true,
			splitting: true,
			format: "esm",
			platform: "browser",
			target: "es2022",
			minify: true,
			sourcemap: false,
			legalComments: "none",
			jsx: "automatic",
			tsconfig: "studio-ui/tsconfig.json",
			entryNames: "[name]-[hash]",
			chunkNames: "[name]-[hash]",
			assetNames: "[name]-[hash]",
			loader: { ".woff2": "file" },
			// React reads this at run time; without it the browser would see `process` or get the development build.
			define: { "process.env.NODE_ENV": '"production"' },
			metafile: true,
			logLevel: "silent",
		});
		if (result.errors.length > 0) throw new Error("the Studio frontend did not compile");
		const outputs = Object.entries(result.metafile.outputs);
		const entry = outputs.find(([, meta]) => meta.entryPoint === "studio-ui/src/main.tsx");
		const style = entry?.[1].cssBundle;
		if (entry === undefined || style === undefined)
			throw new Error("the Studio frontend produced no entry script or style sheet");
		const page = readFileSync(join(root, "studio-ui", "index.html"), "utf8")
			.replace("{{SCRIPT}}", basename(entry[0]))
			.replace("{{STYLE}}", basename(style));
		writeFileSync(join(scratch, "index.html"), page);
		copyFileSync(join(root, "studio-ui", "icon.svg"), join(scratch, "icon.svg"));
		const files = readdirSync(scratch)
			.sort()
			.map((name) => {
				const bytes = readFileSync(join(scratch, name));
				return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
			});
		const manifest = { format: STUDIO_UI_MANIFEST_FORMAT, entry: "index.html", files };
		const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
		const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
		writeFileSync(join(scratch, STUDIO_UI_MANIFEST_NAME), manifestText);
		const publication = await publishStudioUiDirectory(scratch, outDir, {
			manifestText,
			files,
			lockTimeoutMs: options.lockTimeoutMs,
			hooks: options.hooks,
		});
		const packages = new Set();
		for (const [, meta] of outputs)
			for (const input of Object.keys(meta.inputs)) {
				const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
				if (match) packages.add(match[1]);
			}
		return {
			outDir,
			manifest,
			manifestText,
			manifestSha256,
			replaced: publication.replaced,
			packages: [...packages].sort(),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The licence notices of the third-party code and font in the output, as one text: each package's name, version and licence file as
 * published. The bundle drops the licence comments of the code it includes, so this file is what carries them.
 */
export function studioUiNotices(packages) {
	const parts = [
		"Third-party code and fonts included in the Studio frontend (dist/studio-ui).\n" +
			"Each section is the package's licence as published with it.\n",
	];
	for (const name of packages) {
		const directory = join(root, "node_modules", name);
		const { version } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		const licenceFile = readdirSync(directory).find((file) => /^licen[sc]e(\.|$)/i.test(file));
		if (licenceFile === undefined) throw new Error(`${name} has no licence file to carry`);
		parts.push(`\n----\n${name}@${version}\n----\n${readFileSync(join(directory, licenceFile), "utf8").trim()}\n`);
	}
	return parts.join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = process.argv[2];
	const built = await buildStudioUi(out);
	console.log(`built ${built.manifest.files.length} files into ${relative(process.cwd(), built.outDir) || "."}`);
}
