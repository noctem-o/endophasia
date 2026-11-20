// Boundary-agnostic multi-file staged change-set collector, offline verifier, and host-safe diff previewer.
//
// Safe collection contract (aligned with `submission.ts` and `workspace-admission.ts`):
// - Walks a workspace tree without following symbolic links (`O_PATH | O_NOFOLLOW` via `/proc/self/fd` on Linux; `lstat` + `O_NOFOLLOW`
//   fallback elsewhere), refusing symlinks, hardlinks, special files, cross-mount entries, `.git` metadata in candidate workspaces, unsafe
//   paths, oversized trees, and mid-collection races (`changed-during-collection`).
// - Buffers only changed files in memory (bounded by `maxTotalStagedBytes`) while hashing unchanged files and discarding their bytes.
// - Never creates `stagingDir` on any refusal, and never reuses an existing `stagingDir`.
// - Writes every staged file read-only and NON-EXECUTABLE (`0o444`) under `<stagingDir>/files/<path>`, recording executability solely as
//   manifest metadata (`executable: boolean`), alongside canonical `<stagingDir>/manifest.json` (`0o444`).
// - Never executes workspace or staged bytes, and never invokes host `git` or a shell.
//
// Races: collection is designed to run ONLY after the execution boundary owning the candidate workspace has confirmed termination. File and
// directory stat re-checks detect concurrent modification during collection, but cannot substitute for confirming process termination first.

import { createHash } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	type Dir,
	fstatSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	ENDO_STAGED_CHANGESET_V0,
	ENDO_WORKSPACE_BASELINE_V0,
	type EndoChangeSetFileStateV0,
	type EndoChangeSetLimitsV0,
	type EndoChangeSetRefusalReasonV0,
	type EndoChangeSetRefusalV0,
	type EndoStagedChangeSetCollectionV0,
	type EndoStagedChangeSetManifestV0,
	type EndoStagedChangeSetSummaryV0,
	type EndoStagedChangeV0,
	type EndoWorkspaceBaselineEntryV0,
	type EndoWorkspaceBaselineV0,
	endoBaselineDigestInputV0,
	endoChangeSetDigestInputV0,
	isPlainChangeSetPathV0,
	isSafeChangeSetSegmentV0,
	readEndoStagedChangeSetManifestV0,
	readEndoWorkspaceBaselineV0,
} from "../../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { writeAllSyncV0 } from "../../runtime/contracts/write-all.ts";

const IS_LINUX = process.platform === "linux";
const O_PATH = 0o10000000;
const PATH_FLAGS = O_PATH | constants.O_NOFOLLOW;
const READ_CHUNK_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const AGENT_CAUSED = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EISDIR"]);

const isAgentCaused = (error: unknown): boolean =>
	typeof error === "object" && error !== null && AGENT_CAUSED.has(String((error as NodeJS.ErrnoException).code ?? ""));

const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;

/** Test-only hooks for simulating mid-collection races or agent-caused I/O errors. */
export interface EndoChangeSetHooksV0 {
	afterOpen?: (relPath: string) => void;
	afterDirOpen?: (relPath: string) => void;
}

export interface EndoBaselineCaptureOptionsV0 {
	/**
	 * Skip a top-level `.git` entry when capturing a baseline (for example from an `admitWorkspaceV0` snapshot or checkout).
	 * Nested `.git` entries are always refused. Defaults to `false`.
	 */
	skipRootGit?: boolean;
}

export type EndoBaselineCaptureResultV0 =
	| { ok: true; baseline: EndoWorkspaceBaselineV0 }
	| { ok: false; refusals: EndoChangeSetRefusalV0[] };

export type EndoChangeSetVerifyFailureReasonV0 =
	| "invalid-staging-dir"
	| "missing-manifest"
	| "invalid-manifest"
	| "digest-mismatch"
	| "pin-mismatch"
	| "unsafe-staged-file"
	| "executable-staged-file"
	| "missing-staged-file"
	| "unexpected-staged-entry"
	| "staged-bytes-mismatch";

export type EndoChangeSetVerifyResultV0 =
	| { ok: true; manifest: EndoStagedChangeSetManifestV0 }
	| { ok: false; reason: EndoChangeSetVerifyFailureReasonV0; detail: string };

export interface EndoChangeSetVerifyOptionsV0 {
	expectedBaselineSha256?: string;
	expectedChangesetSha256?: string;
}

export interface EndoChangeSetPreviewOptionsV0 extends EndoChangeSetVerifyOptionsV0 {
	/** Optional read-only baseline directory used to render unified diffs for modified and deleted text files. */
	baselineDir?: string;
	/** Maximum bytes per file eligible for text decoding and diff rendering. Defaults to 64 KiB. */
	maxDiffBytesPerFile?: number;
	/** Maximum lines included in a single file's unified diff before truncating. Defaults to 400. */
	maxDiffLinesPerFile?: number;
	/** Unified diff context lines around each hunk. Defaults to 3. */
	contextLines?: number;
}

export type EndoChangePreviewContentV0 =
	| "unified-diff"
	| "added-text"
	| "mode-only"
	| "binary"
	| "too-large-for-preview"
	| "baseline-unavailable";

export interface EndoStagedChangePreviewEntryV0 {
	path: string;
	kind: EndoStagedChangeV0["kind"];
	before: EndoChangeSetFileStateV0 | null;
	after: EndoChangeSetFileStateV0 | null;
	content: EndoChangePreviewContentV0;
	diff: string | null;
	truncated: boolean;
}

export type EndoChangeSetPreviewResultV0 =
	| { ok: true; manifest: EndoStagedChangeSetManifestV0; entries: EndoStagedChangePreviewEntryV0[] }
	| {
			ok: false;
			reason: EndoChangeSetVerifyFailureReasonV0 | "baseline-mismatch" | "baseline-unreadable";
			detail: string;
	  };

/** Compute the canonical SHA-256 digest of a baseline manifest. */
export function endoBaselineDigestV0(rootGitExcluded: boolean, files: readonly EndoWorkspaceBaselineEntryV0[]): string {
	return sha256HexV0(canonicalEndoJsonV0(endoBaselineDigestInputV0(rootGitExcluded, files)));
}

/** Compute the canonical SHA-256 digest of a staged change-set manifest. */
export function endoChangeSetDigestV0(
	baselineSha256: string,
	baselineRootGitExcluded: boolean,
	changes: readonly EndoStagedChangeV0[],
	summary: EndoStagedChangeSetSummaryV0,
): string {
	return sha256HexV0(
		canonicalEndoJsonV0(endoChangeSetDigestInputV0(baselineSha256, baselineRootGitExcluded, changes, summary)),
	);
}

function validateLimits(limits: EndoChangeSetLimitsV0): void {
	const check = (value: number, name: string, min: number) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
			throw new TypeError(`staged-changeset: invalid limit ${name}`);
	};
	check(limits.maxFileBytes, "maxFileBytes", 0);
	check(limits.maxTotalStagedBytes, "maxTotalStagedBytes", 0);
	check(limits.maxWorkspaceBytes, "maxWorkspaceBytes", 0);
	check(limits.maxWalkedEntries, "maxWalkedEntries", 1);
	check(limits.maxChangedFiles, "maxChangedFiles", 0);
	check(limits.maxDepth, "maxDepth", 0);
}

function sameFileStat(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.ctimeNs === b.ctimeNs &&
		a.mtimeNs === b.mtimeNs &&
		a.nlink === b.nlink
	);
}

function readMountId(fd: number): string | null {
	if (!IS_LINUX) return null;
	const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
	return /^mnt_id:\s+(\d+)$/m.exec(text)?.[1] ?? null;
}

interface WalkedFile {
	path: string;
	bytes: number;
	sha256: string;
	executable: boolean;
	content?: Buffer;
}

interface WalkOptions {
	limits: EndoChangeSetLimitsV0;
	skipRootGit: boolean;
	hooks: EndoChangeSetHooksV0;
	/** Called after hashing each file; return `true` to retain its Buffer on the yielded record. */
	retainBuffer?: (info: { path: string; bytes: number; sha256: string; executable: boolean }) => boolean;
	/** Optional custom check on file mode (used by verifier to reject executable staged files). */
	rejectExecutable?: boolean;
	/** Optional flag to reject empty directories (used by verifier on `staging/files`). */
	rejectEmptyDirs?: boolean;
}

interface WalkResult {
	files: WalkedFile[];
	refusals: EndoChangeSetRefusalV0[];
	emptyDirs: string[];
	executablePaths: string[];
}

function walkPlainTree(root: string, opts: WalkOptions): WalkResult {
	const refusals: EndoChangeSetRefusalV0[] = [];
	const files: WalkedFile[] = [];
	const emptyDirs: string[] = [];
	const executablePaths: string[] = [];

	let rootLstat: BigIntStats;
	try {
		rootLstat = lstatSync(root, { bigint: true });
	} catch (error) {
		if (isAgentCaused(error))
			return { files, refusals: [{ path: ".", reason: "unreadable" }], emptyDirs, executablePaths };
		throw error;
	}
	if (rootLstat.isSymbolicLink())
		return { files, refusals: [{ path: ".", reason: "symbolic-link" }], emptyDirs, executablePaths };
	if (!rootLstat.isDirectory())
		return { files, refusals: [{ path: ".", reason: "unsafe-path" }], emptyDirs, executablePaths };

	let walkedEntries = 0;
	let workspaceBytes = 0;
	let stagedBytes = 0;
	let stopped = false;
	const rootDev = rootLstat.dev;

	if (IS_LINUX) {
		let rootFd: number;
		try {
			rootFd = openSync(root, PATH_FLAGS);
		} catch (error) {
			if (isAgentCaused(error))
				return { files, refusals: [{ path: ".", reason: "unreadable" }], emptyDirs, executablePaths };
			throw error;
		}
		try {
			const rootStat = fstatSync(rootFd, { bigint: true });
			if (rootStat.isSymbolicLink())
				return { files, refusals: [{ path: ".", reason: "symbolic-link" }], emptyDirs, executablePaths };
			if (!rootStat.isDirectory() || rootStat.dev !== rootLstat.dev || rootStat.ino !== rootLstat.ino)
				return {
					files,
					refusals: [{ path: ".", reason: "changed-during-collection" }],
					emptyDirs,
					executablePaths,
				};
			const rootMount = readMountId(rootFd);
			if (rootMount === null)
				return { files, refusals: [{ path: ".", reason: "unreadable" }], emptyDirs, executablePaths };

			const visitDir = (dirFd: number, prefix: string, depth: number): void => {
				if (stopped) return;
				const beforeDir = fstatSync(dirFd, { bigint: true });
				let entries: Dir;
				try {
					entries = opendirSync(fdPath(dirFd));
				} catch (error) {
					if (isAgentCaused(error)) {
						refusals.push({ path: prefix === "" ? "." : prefix, reason: "unreadable" });
						return;
					}
					throw error;
				}
				let sawEntry = false;
				try {
					opts.hooks.afterDirOpen?.(prefix === "" ? "." : prefix);
					for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
						if (stopped) return;
						sawEntry = true;
						const name = entry.name;
						if (name === ".git" && opts.skipRootGit && prefix === "") continue;
						const relPath = prefix === "" ? name : `${prefix}/${name}`;
						walkedEntries++;
						if (walkedEntries > opts.limits.maxWalkedEntries) {
							refusals.push({ path: relPath, reason: "too-many-files" });
							stopped = true;
							return;
						}
						if (name === ".git") {
							refusals.push({ path: relPath, reason: "git-metadata" });
							continue;
						}
						if (!isSafeChangeSetSegmentV0(name) || !isPlainChangeSetPathV0(relPath)) {
							refusals.push({ path: relPath, reason: "unsafe-path" });
							continue;
						}

						let childFd: number;
						try {
							childFd = openSync(join(fdPath(dirFd), name), PATH_FLAGS);
						} catch (error) {
							if (isAgentCaused(error)) {
								refusals.push({ path: relPath, reason: "unreadable" });
								continue;
							}
							throw error;
						}

						try {
							const stat = fstatSync(childFd, { bigint: true });
							if (stat.isSymbolicLink()) {
								refusals.push({ path: relPath, reason: "symbolic-link" });
								continue;
							}
							const childMount = readMountId(childFd);
							if (childMount === null) {
								refusals.push({ path: relPath, reason: "unreadable" });
								continue;
							}
							if (stat.dev !== rootDev || childMount !== rootMount) {
								refusals.push({ path: relPath, reason: "separate-mount" });
								continue;
							}
							if (stat.isDirectory()) {
								if (depth + 1 > opts.limits.maxDepth) {
									refusals.push({ path: relPath, reason: "too-deep" });
									continue;
								}
								visitDir(childFd, relPath, depth + 1);
								continue;
							}
							if (!stat.isFile()) {
								refusals.push({ path: relPath, reason: "not-a-regular-file" });
								continue;
							}
							if (stat.nlink !== 1n) {
								refusals.push({ path: relPath, reason: "hard-link" });
								continue;
							}
							if (opts.rejectExecutable && (stat.mode & 0o111n) !== 0n) {
								executablePaths.push(relPath);
							}
							const declaredSize = Number(stat.size);
							if (stat.size > BigInt(opts.limits.maxFileBytes)) {
								refusals.push({ path: relPath, reason: "too-large" });
								continue;
							}
							if (workspaceBytes + declaredSize > opts.limits.maxWorkspaceBytes) {
								refusals.push({ path: relPath, reason: "total-too-large" });
								continue;
							}

							let readFd: number;
							try {
								readFd = openSync(fdPath(childFd), constants.O_RDONLY | constants.O_NONBLOCK);
							} catch (error) {
								if (isAgentCaused(error)) {
									refusals.push({ path: relPath, reason: "unreadable" });
									continue;
								}
								throw error;
							}

							let reason: EndoChangeSetRefusalReasonV0 | null = null;
							let bytesBuf: Buffer | null = null;
							try {
								const opened = fstatSync(readFd, { bigint: true });
								if (!opened.isFile() || !sameFileStat(opened, stat)) {
									reason = "changed-during-collection";
								} else {
									opts.hooks.afterOpen?.(relPath);
									const chunks: Buffer[] = [];
									let total = 0;
									for (;;) {
										const chunk = Buffer.alloc(
											Math.min(READ_CHUNK_BYTES, opts.limits.maxFileBytes + 1 - total),
										);
										if (chunk.length === 0) {
											reason = "too-large";
											break;
										}
										const n = readSync(readFd, chunk, 0, chunk.length, null);
										if (n === 0) break;
										chunks.push(chunk.subarray(0, n));
										total += n;
										if (total > opts.limits.maxFileBytes) {
											reason = "too-large";
											break;
										}
									}
									if (reason === null) {
										const afterRead = fstatSync(readFd, { bigint: true });
										let recheckFd: number | undefined;
										let recheckStat: BigIntStats | undefined;
										try {
											recheckFd = openSync(join(fdPath(dirFd), name), PATH_FLAGS);
											recheckStat = fstatSync(recheckFd, { bigint: true });
										} catch {
											recheckStat = undefined;
										} finally {
											if (recheckFd !== undefined) closeSync(recheckFd);
										}
										if (
											BigInt(total) !== stat.size ||
											!sameFileStat(afterRead, stat) ||
											recheckStat === undefined ||
											!sameFileStat(recheckStat, stat)
										) {
											reason = "changed-during-collection";
										} else {
											bytesBuf = Buffer.concat(chunks);
										}
									}
								}
							} catch (error) {
								if (isAgentCaused(error)) reason = "unreadable";
								else throw error;
							} finally {
								closeSync(readFd);
							}

							if (reason !== null || bytesBuf === null) {
								refusals.push({ path: relPath, reason: reason ?? "unreadable" });
								continue;
							}

							workspaceBytes += bytesBuf.length;
							if (workspaceBytes > opts.limits.maxWorkspaceBytes) {
								refusals.push({ path: relPath, reason: "total-too-large" });
								continue;
							}
							const sha256 = createHash("sha256").update(bytesBuf).digest("hex");
							const executable = (stat.mode & 0o100n) !== 0n;
							const retain =
								opts.retainBuffer?.({ path: relPath, bytes: bytesBuf.length, sha256, executable }) ?? false;
							if (retain) {
								stagedBytes += bytesBuf.length;
								if (stagedBytes > opts.limits.maxTotalStagedBytes) {
									refusals.push({ path: relPath, reason: "total-too-large" });
									continue;
								}
								files.push({ path: relPath, bytes: bytesBuf.length, sha256, executable, content: bytesBuf });
							} else {
								files.push({ path: relPath, bytes: bytesBuf.length, sha256, executable });
							}
						} finally {
							closeSync(childFd);
						}
					}
				} catch (error) {
					if (isAgentCaused(error)) {
						refusals.push({ path: prefix === "" ? "." : prefix, reason: "unreadable" });
						return;
					}
					throw error;
				} finally {
					entries.closeSync();
				}

				if (stopped) return;
				if (!sawEntry && prefix !== "" && opts.rejectEmptyDirs) emptyDirs.push(prefix);

				const afterDir = fstatSync(dirFd, { bigint: true });
				if (beforeDir.ctimeNs !== afterDir.ctimeNs || beforeDir.mtimeNs !== afterDir.mtimeNs) {
					refusals.push({ path: prefix === "" ? "." : prefix, reason: "changed-during-collection" });
				}
			};

			visitDir(rootFd, "", 0);
		} finally {
			closeSync(rootFd);
		}
	} else {
		// Non-Linux POSIX fallback: lstat + O_NOFOLLOW + before/after stat verification.
		const visitDirPosix = (dirPath: string, prefix: string, depth: number): void => {
			if (stopped) return;
			let beforeDir: BigIntStats;
			let entries: Dir;
			try {
				beforeDir = lstatSync(dirPath, { bigint: true });
				entries = opendirSync(dirPath);
			} catch (error) {
				if (isAgentCaused(error)) {
					refusals.push({ path: prefix === "" ? "." : prefix, reason: "unreadable" });
					return;
				}
				throw error;
			}
			let sawEntry = false;
			try {
				opts.hooks.afterDirOpen?.(prefix === "" ? "." : prefix);
				for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
					if (stopped) return;
					sawEntry = true;
					const name = entry.name;
					if (name === ".git" && opts.skipRootGit && prefix === "") continue;
					const relPath = prefix === "" ? name : `${prefix}/${name}`;
					walkedEntries++;
					if (walkedEntries > opts.limits.maxWalkedEntries) {
						refusals.push({ path: relPath, reason: "too-many-files" });
						stopped = true;
						return;
					}
					if (name === ".git") {
						refusals.push({ path: relPath, reason: "git-metadata" });
						continue;
					}
					if (!isSafeChangeSetSegmentV0(name) || !isPlainChangeSetPathV0(relPath)) {
						refusals.push({ path: relPath, reason: "unsafe-path" });
						continue;
					}
					const full = join(dirPath, name);
					let stat: BigIntStats;
					try {
						stat = lstatSync(full, { bigint: true });
					} catch (error) {
						if (isAgentCaused(error)) {
							refusals.push({ path: relPath, reason: "unreadable" });
							continue;
						}
						throw error;
					}
					if (stat.isSymbolicLink()) {
						refusals.push({ path: relPath, reason: "symbolic-link" });
						continue;
					}
					if (stat.dev !== rootDev) {
						refusals.push({ path: relPath, reason: "separate-mount" });
						continue;
					}
					if (stat.isDirectory()) {
						if (depth + 1 > opts.limits.maxDepth) {
							refusals.push({ path: relPath, reason: "too-deep" });
							continue;
						}
						visitDirPosix(full, relPath, depth + 1);
						continue;
					}
					if (!stat.isFile()) {
						refusals.push({ path: relPath, reason: "not-a-regular-file" });
						continue;
					}
					if (stat.nlink !== 1n) {
						refusals.push({ path: relPath, reason: "hard-link" });
						continue;
					}
					if (opts.rejectExecutable && (stat.mode & 0o111n) !== 0n) executablePaths.push(relPath);
					if (stat.size > BigInt(opts.limits.maxFileBytes)) {
						refusals.push({ path: relPath, reason: "too-large" });
						continue;
					}
					if (workspaceBytes + Number(stat.size) > opts.limits.maxWorkspaceBytes) {
						refusals.push({ path: relPath, reason: "total-too-large" });
						continue;
					}
					let readFd: number;
					try {
						readFd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ELOOP") {
							refusals.push({ path: relPath, reason: "symbolic-link" });
							continue;
						}
						if (isAgentCaused(error)) {
							refusals.push({ path: relPath, reason: "unreadable" });
							continue;
						}
						throw error;
					}
					let reason: EndoChangeSetRefusalReasonV0 | null = null;
					let bytesBuf: Buffer | null = null;
					try {
						const opened = fstatSync(readFd, { bigint: true });
						if (!opened.isFile() || !sameFileStat(opened, stat)) {
							reason = "changed-during-collection";
						} else {
							opts.hooks.afterOpen?.(relPath);
							const chunks: Buffer[] = [];
							let total = 0;
							for (;;) {
								const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, opts.limits.maxFileBytes + 1 - total));
								if (chunk.length === 0) {
									reason = "too-large";
									break;
								}
								const n = readSync(readFd, chunk, 0, chunk.length, null);
								if (n === 0) break;
								chunks.push(chunk.subarray(0, n));
								total += n;
								if (total > opts.limits.maxFileBytes) {
									reason = "too-large";
									break;
								}
							}
							if (reason === null) {
								const afterRead = fstatSync(readFd, { bigint: true });
								const again = lstatSync(full, { bigint: true, throwIfNoEntry: false });
								if (
									BigInt(total) !== stat.size ||
									!sameFileStat(afterRead, stat) ||
									again === undefined ||
									!sameFileStat(again, stat)
								) {
									reason = "changed-during-collection";
								} else {
									bytesBuf = Buffer.concat(chunks);
								}
							}
						}
					} catch (error) {
						if (isAgentCaused(error)) reason = "unreadable";
						else throw error;
					} finally {
						closeSync(readFd);
					}
					if (reason !== null || bytesBuf === null) {
						refusals.push({ path: relPath, reason: reason ?? "unreadable" });
						continue;
					}
					workspaceBytes += bytesBuf.length;
					const sha256 = createHash("sha256").update(bytesBuf).digest("hex");
					const executable = (stat.mode & 0o100n) !== 0n;
					const retain =
						opts.retainBuffer?.({ path: relPath, bytes: bytesBuf.length, sha256, executable }) ?? false;
					if (retain) {
						stagedBytes += bytesBuf.length;
						if (stagedBytes > opts.limits.maxTotalStagedBytes) {
							refusals.push({ path: relPath, reason: "total-too-large" });
							continue;
						}
						files.push({ path: relPath, bytes: bytesBuf.length, sha256, executable, content: bytesBuf });
					} else {
						files.push({ path: relPath, bytes: bytesBuf.length, sha256, executable });
					}
				}
			} catch (error) {
				if (isAgentCaused(error)) {
					refusals.push({ path: prefix === "" ? "." : prefix, reason: "unreadable" });
					return;
				}
				throw error;
			} finally {
				entries.closeSync();
			}

			if (stopped) return;
			if (!sawEntry && prefix !== "" && opts.rejectEmptyDirs) emptyDirs.push(prefix);

			const afterDir = lstatSync(dirPath, { bigint: true, throwIfNoEntry: false });
			if (
				afterDir === undefined ||
				beforeDir.ctimeNs !== afterDir.ctimeNs ||
				beforeDir.mtimeNs !== afterDir.mtimeNs
			) {
				refusals.push({ path: prefix === "" ? "." : prefix, reason: "changed-during-collection" });
			}
		};

		visitDirPosix(root, "", 0);
	}

	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	refusals.sort((a, b) =>
		a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0,
	);
	emptyDirs.sort();
	executablePaths.sort();
	return { files, refusals, emptyDirs, executablePaths };
}

/**
 * Capture a canonical, digest-pinned baseline manifest of a plain workspace directory.
 * Set `options.skipRootGit = true` when reading a Git checkout or `admitWorkspaceV0` snapshot; nested `.git` is always refused.
 */
export function captureWorkspaceBaselineV0(
	root: string,
	limits: EndoChangeSetLimitsV0 = DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	options: EndoBaselineCaptureOptionsV0 = {},
	hooks: EndoChangeSetHooksV0 = {},
): EndoBaselineCaptureResultV0 {
	validateLimits(limits);
	const skipRootGit = options.skipRootGit === true;
	const walked = walkPlainTree(root, { limits, skipRootGit, hooks });
	if (walked.refusals.length > 0) return { ok: false, refusals: walked.refusals };
	const entries: EndoWorkspaceBaselineEntryV0[] = walked.files.map((f) => ({
		path: f.path,
		bytes: f.bytes,
		sha256: f.sha256,
		executable: f.executable,
	}));
	let totalBytes = 0;
	for (const entry of entries) totalBytes += entry.bytes;
	const baseline: EndoWorkspaceBaselineV0 = {
		schemaVersion: ENDO_WORKSPACE_BASELINE_V0,
		rootGitExcluded: skipRootGit,
		files: entries,
		totalBytes,
		sha256: endoBaselineDigestV0(skipRootGit, entries),
	};
	return { ok: true, baseline };
}

/**
 * Compare a terminated candidate workspace against a verified baseline manifest, and stage only changed plain regular files into a new,
 * controller-owned `stagingDir` (`files/<path>` at `0o444`, plus canonical `manifest.json` at `0o444`).
 *
 * Refuses the whole change set on any refusal without creating `stagingDir`. Throws if `baseline` is invalid or if `stagingDir` already
 * exists.
 */
export function collectStagedChangeSetV0(
	baseline: EndoWorkspaceBaselineV0,
	candidateWorkspace: string,
	stagingDir: string,
	limits: EndoChangeSetLimitsV0 = DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	hooks: EndoChangeSetHooksV0 = {},
): EndoStagedChangeSetCollectionV0 {
	validateLimits(limits);
	const checkedBaseline = readEndoWorkspaceBaselineV0(baseline);
	if (!checkedBaseline.ok) throw new TypeError(`staged-changeset: invalid baseline (${checkedBaseline.message})`);
	const expectedBaselineSha = endoBaselineDigestV0(checkedBaseline.value.rootGitExcluded, checkedBaseline.value.files);
	if (expectedBaselineSha !== checkedBaseline.value.sha256)
		throw new TypeError("staged-changeset: baseline sha256 does not match baseline entries");

	const baselineMap = new Map<string, EndoWorkspaceBaselineEntryV0>();
	for (const entry of checkedBaseline.value.files) baselineMap.set(entry.path, entry);

	// Walk candidate workspace: `.git` is NEVER permitted in a candidate workspace.
	const walked = walkPlainTree(candidateWorkspace, {
		limits,
		skipRootGit: false,
		hooks,
		retainBuffer: (info) => {
			const prev = baselineMap.get(info.path);
			if (prev === undefined) return true;
			return prev.sha256 !== info.sha256 || prev.executable !== info.executable;
		},
	});
	if (walked.refusals.length > 0) {
		return { status: "refused", manifest: null, stagingDir: null, refusals: walked.refusals };
	}

	const seenCandidate = new Set<string>();
	const changes: EndoStagedChangeV0[] = [];
	const stagedBuffers = new Map<string, Buffer>();
	let unchangedFiles = 0;
	let addedFiles = 0;
	let modifiedFiles = 0;
	let modeChangedFiles = 0;
	let stagedBytes = 0;

	for (const file of walked.files) {
		seenCandidate.add(file.path);
		const prev = baselineMap.get(file.path);
		const after: EndoChangeSetFileStateV0 = {
			bytes: file.bytes,
			sha256: file.sha256,
			executable: file.executable,
		};
		if (prev === undefined) {
			addedFiles++;
			stagedBytes += file.bytes;
			changes.push({ path: file.path, kind: "added", before: null, after });
			stagedBuffers.set(file.path, file.content!);
		} else if (prev.sha256 !== file.sha256) {
			modifiedFiles++;
			stagedBytes += file.bytes;
			changes.push({
				path: file.path,
				kind: "modified",
				before: { bytes: prev.bytes, sha256: prev.sha256, executable: prev.executable },
				after,
			});
			stagedBuffers.set(file.path, file.content!);
		} else if (prev.executable !== file.executable) {
			modeChangedFiles++;
			stagedBytes += file.bytes;
			changes.push({
				path: file.path,
				kind: "mode",
				before: { bytes: prev.bytes, sha256: prev.sha256, executable: prev.executable },
				after,
			});
			stagedBuffers.set(file.path, file.content!);
		} else {
			unchangedFiles++;
		}
	}

	let deletedFiles = 0;
	for (const prev of checkedBaseline.value.files) {
		if (!seenCandidate.has(prev.path)) {
			deletedFiles++;
			changes.push({
				path: prev.path,
				kind: "deleted",
				before: { bytes: prev.bytes, sha256: prev.sha256, executable: prev.executable },
				after: null,
			});
		}
	}

	changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	if (changes.length > limits.maxChangedFiles) {
		const overflowPath = changes[limits.maxChangedFiles]?.path ?? ".";
		return {
			status: "refused",
			manifest: null,
			stagingDir: null,
			refusals: [{ path: overflowPath, reason: "too-many-files" }],
		};
	}

	const summary: EndoStagedChangeSetSummaryV0 = {
		baselineFiles: checkedBaseline.value.files.length,
		candidateFiles: walked.files.length,
		unchangedFiles,
		addedFiles,
		modifiedFiles,
		modeChangedFiles,
		deletedFiles,
		stagedBytes,
	};
	const manifest: EndoStagedChangeSetManifestV0 = {
		schemaVersion: ENDO_STAGED_CHANGESET_V0,
		baselineSha256: checkedBaseline.value.sha256,
		baselineRootGitExcluded: checkedBaseline.value.rootGitExcluded,
		changes,
		summary,
		changesetSha256: endoChangeSetDigestV0(
			checkedBaseline.value.sha256,
			checkedBaseline.value.rootGitExcluded,
			changes,
			summary,
		),
	};

	// Create `stagingDir` exclusively: never reuse an existing directory. Clean up if writing fails mid-way.
	mkdirSync(stagingDir, { mode: 0o700 });
	try {
		const filesRoot = join(stagingDir, "files");
		mkdirSync(filesRoot, { mode: 0o700 });
		for (const change of changes) {
			if (change.kind === "deleted") continue;
			const bytes = stagedBuffers.get(change.path)!;
			const target = join(filesRoot, change.path);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			const fd = openSync(
				target,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeAllSyncV0(fd, bytes);
			} finally {
				closeSync(fd);
			}
			// Read-only and NON-EXECUTABLE on the host; executability lives strictly in manifest metadata.
			chmodSync(target, 0o444);
		}
		const manifestPath = join(stagingDir, "manifest.json");
		const manifestBytes = Buffer.from(canonicalEndoJsonV0(manifest), "utf8");
		const mfd = openSync(
			manifestPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeAllSyncV0(mfd, manifestBytes);
		} finally {
			closeSync(mfd);
		}
		chmodSync(manifestPath, 0o444);
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}

	return { status: "collected", manifest, stagingDir, refusals: [] };
}

function readPlainRegularFile(
	path: string,
	maxBytes: number,
): { ok: true; bytes: Buffer; stat: BigIntStats } | { ok: false; detail: string } {
	let before: BigIntStats;
	try {
		before = lstatSync(path, { bigint: true });
	} catch {
		return { ok: false, detail: `cannot stat ${path}` };
	}
	if (before.isSymbolicLink()) return { ok: false, detail: `${path} is a symbolic link` };
	if (!before.isFile()) return { ok: false, detail: `${path} is not a regular file` };
	if (before.nlink !== 1n) return { ok: false, detail: `${path} is a hard link` };
	if (before.size > BigInt(maxBytes)) return { ok: false, detail: `${path} exceeds ${maxBytes} bytes` };
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return { ok: false, detail: `cannot open ${path}` };
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || !sameFileStat(opened, before))
			return { ok: false, detail: `${path} changed while opening` };
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
			if (chunk.length === 0) return { ok: false, detail: `${path} exceeds ${maxBytes} bytes` };
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
			if (total > maxBytes) return { ok: false, detail: `${path} exceeds ${maxBytes} bytes` };
		}
		const after = fstatSync(fd, { bigint: true });
		if (BigInt(total) !== before.size || !sameFileStat(after, before))
			return { ok: false, detail: `${path} changed while reading` };
		return { ok: true, bytes: Buffer.concat(chunks), stat: after };
	} finally {
		closeSync(fd);
	}
}

/**
 * Independent offline read-only verifier for a staged change set on disk.
 * Checks directory integrity, schema validity, canonical digest, optional baseline/changeset pins, absence of executable bits or rogue
 * entries under `stagingDir`, and exact byte-for-byte SHA-256 agreement for every staged file.
 */
export function verifyStagedChangeSetV0(
	stagingDir: string,
	options: EndoChangeSetVerifyOptionsV0 = {},
	limits: EndoChangeSetLimitsV0 = DEFAULT_ENDO_CHANGESET_LIMITS_V0,
): EndoChangeSetVerifyResultV0 {
	validateLimits(limits);
	let dirStat: BigIntStats;
	try {
		dirStat = lstatSync(stagingDir, { bigint: true });
	} catch {
		return { ok: false, reason: "invalid-staging-dir", detail: "staging directory does not exist or is unreadable" };
	}
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
		return { ok: false, reason: "invalid-staging-dir", detail: "staging path is not a plain directory" };

	const topEntries: string[] = [];
	let dirHandle: Dir;
	try {
		dirHandle = opendirSync(stagingDir);
	} catch {
		return { ok: false, reason: "invalid-staging-dir", detail: "staging directory could not be listed" };
	}
	try {
		for (let entry = dirHandle.readSync(); entry !== null; entry = dirHandle.readSync()) {
			if (entry.name !== "manifest.json" && entry.name !== "files")
				return {
					ok: false,
					reason: "unexpected-staged-entry",
					detail: `unexpected top-level entry in staging directory: ${entry.name}`,
				};
			topEntries.push(entry.name);
		}
	} catch {
		return { ok: false, reason: "invalid-staging-dir", detail: "staging directory could not be listed" };
	} finally {
		dirHandle.closeSync();
	}
	if (!topEntries.includes("manifest.json"))
		return { ok: false, reason: "missing-manifest", detail: "manifest.json is missing from staging directory" };

	const manifestRead = readPlainRegularFile(join(stagingDir, "manifest.json"), MAX_MANIFEST_BYTES);
	if (!manifestRead.ok)
		return { ok: false, reason: "invalid-manifest", detail: `manifest.json: ${manifestRead.detail}` };
	if ((manifestRead.stat.mode & 0o111n) !== 0n)
		return { ok: false, reason: "executable-staged-file", detail: "manifest.json has executable permission bits" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestRead.bytes.toString("utf8"));
	} catch {
		return { ok: false, reason: "invalid-manifest", detail: "manifest.json is not valid JSON" };
	}
	const checked = readEndoStagedChangeSetManifestV0(parsed);
	if (!checked.ok) return { ok: false, reason: "invalid-manifest", detail: checked.message };
	const manifest = checked.value;

	const recomputedDigest = endoChangeSetDigestV0(
		manifest.baselineSha256,
		manifest.baselineRootGitExcluded,
		manifest.changes,
		manifest.summary,
	);
	if (recomputedDigest !== manifest.changesetSha256)
		return {
			ok: false,
			reason: "digest-mismatch",
			detail: "manifest.changesetSha256 does not match canonical contents",
		};

	if (options.expectedBaselineSha256 !== undefined && manifest.baselineSha256 !== options.expectedBaselineSha256)
		return {
			ok: false,
			reason: "pin-mismatch",
			detail: "manifest.baselineSha256 does not match expected baseline pin",
		};
	if (options.expectedChangesetSha256 !== undefined && manifest.changesetSha256 !== options.expectedChangesetSha256)
		return {
			ok: false,
			reason: "pin-mismatch",
			detail: "manifest.changesetSha256 does not match expected changeset pin",
		};

	if (manifest.changes.length > limits.maxChangedFiles || manifest.summary.stagedBytes > limits.maxTotalStagedBytes)
		return {
			ok: false,
			reason: "invalid-manifest",
			detail: "manifest exceeds verifier change-set limits",
		};

	if (!topEntries.includes("files"))
		return { ok: false, reason: "invalid-staging-dir", detail: "files directory is missing from staging directory" };

	const filesRoot = join(stagingDir, "files");
	const walked = walkPlainTree(filesRoot, {
		limits: {
			...limits,
			maxWorkspaceBytes: Math.min(limits.maxWorkspaceBytes, limits.maxTotalStagedBytes),
		},
		skipRootGit: false,
		hooks: {},
		rejectExecutable: true,
		rejectEmptyDirs: true,
	});
	if (walked.refusals.length > 0) {
		const first = walked.refusals[0]!;
		return {
			ok: false,
			reason: "unsafe-staged-file",
			detail: `staged files refused at ${first.path}: ${first.reason}`,
		};
	}
	if (walked.executablePaths.length > 0) {
		return {
			ok: false,
			reason: "executable-staged-file",
			detail: `staged file has executable permission bits: ${walked.executablePaths[0]}`,
		};
	}
	if (walked.emptyDirs.length > 0) {
		return {
			ok: false,
			reason: "unexpected-staged-entry",
			detail: `unexpected empty directory under files/: ${walked.emptyDirs[0]}`,
		};
	}

	const onDisk = new Map<string, WalkedFile>();
	for (const file of walked.files) onDisk.set(file.path, file);

	const expectedStagedPaths = new Set<string>();
	for (const change of manifest.changes) {
		if (change.kind === "deleted") {
			if (onDisk.has(change.path))
				return {
					ok: false,
					reason: "unexpected-staged-entry",
					detail: `deleted path unexpectedly present under files/: ${change.path}`,
				};
			continue;
		}
		expectedStagedPaths.add(change.path);
		const diskFile = onDisk.get(change.path);
		if (diskFile === undefined)
			return { ok: false, reason: "missing-staged-file", detail: `missing staged file: ${change.path}` };
		if (diskFile.bytes !== change.after.bytes || diskFile.sha256 !== change.after.sha256)
			return {
				ok: false,
				reason: "staged-bytes-mismatch",
				detail: `staged file bytes or sha256 mismatch at ${change.path}`,
			};
	}

	for (const path of onDisk.keys()) {
		if (!expectedStagedPaths.has(path))
			return { ok: false, reason: "unexpected-staged-entry", detail: `unexpected file under files/: ${path}` };
	}

	return { ok: true, manifest };
}

// ---- host-safe, subprocess-free preview & unified diff renderer ---------------------------------------------------------------------

const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeTextOrBinary(bytes: Buffer): string | null {
	if (bytes.includes(0)) return null;
	try {
		return utf8Fatal.decode(bytes);
	} catch {
		return null;
	}
}

interface TextLine {
	text: string;
	noNewline: boolean;
}

function splitLines(text: string): TextLine[] {
	if (text.length === 0) return [];
	const endsWithNewline = text.endsWith("\n");
	const parts = endsWithNewline ? text.slice(0, -1).split("\n") : text.split("\n");
	return parts.map((line, index) => ({
		text: line,
		noNewline: !endsWithNewline && index === parts.length - 1,
	}));
}

const sameLine = (a: TextLine, b: TextLine): boolean => a.text === b.text && a.noNewline === b.noNewline;

type DiffOp = { type: "equal" | "delete" | "insert"; line: TextLine };

/** Deterministic LCS line diff bounded by total DP cells (`<= 2_000_000`) with a clean replace fallback for huge inputs. */
function diffLines(beforeLines: readonly TextLine[], afterLines: readonly TextLine[]): DiffOp[] {
	const m = beforeLines.length;
	const n = afterLines.length;
	if (m === 0) return afterLines.map((line) => ({ type: "insert", line }));
	if (n === 0) return beforeLines.map((line) => ({ type: "delete", line }));

	// Trim common prefix and suffix to keep the DP table small on typical edits.
	let start = 0;
	while (start < m && start < n && sameLine(beforeLines[start]!, afterLines[start]!)) start++;
	let endA = m;
	let endB = n;
	while (endA > start && endB > start && sameLine(beforeLines[endA - 1]!, afterLines[endB - 1]!)) {
		endA--;
		endB--;
	}

	const ops: DiffOp[] = [];
	for (let i = 0; i < start; i++) ops.push({ type: "equal", line: beforeLines[i]! });

	const midA = endA - start;
	const midB = endB - start;
	if (midA * midB <= 2_000_000) {
		const dp = new Uint32Array((midA + 1) * (midB + 1));
		const stride = midB + 1;
		for (let i = midA - 1; i >= 0; i--) {
			for (let j = midB - 1; j >= 0; j--) {
				if (sameLine(beforeLines[start + i]!, afterLines[start + j]!)) {
					dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)]! + 1;
				} else {
					const down = dp[(i + 1) * stride + j]!;
					const right = dp[i * stride + (j + 1)]!;
					dp[i * stride + j] = down >= right ? down : right;
				}
			}
		}
		let i = 0;
		let j = 0;
		while (i < midA && j < midB) {
			if (sameLine(beforeLines[start + i]!, afterLines[start + j]!)) {
				ops.push({ type: "equal", line: beforeLines[start + i]! });
				i++;
				j++;
			} else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
				ops.push({ type: "delete", line: beforeLines[start + i]! });
				i++;
			} else {
				ops.push({ type: "insert", line: afterLines[start + j]! });
				j++;
			}
		}
		while (i < midA) ops.push({ type: "delete", line: beforeLines[start + i++]! });
		while (j < midB) ops.push({ type: "insert", line: afterLines[start + j++]! });
	} else {
		for (let i = start; i < endA; i++) ops.push({ type: "delete", line: beforeLines[i]! });
		for (let j = start; j < endB; j++) ops.push({ type: "insert", line: afterLines[j]! });
	}

	for (let i = endA; i < m; i++) ops.push({ type: "equal", line: beforeLines[i]! });
	return ops;
}

function formatUnifiedDiff(
	path: string,
	beforeText: string | null,
	afterText: string | null,
	contextLines: number,
	maxLines: number,
): { diff: string; truncated: boolean } {
	const oldLabel = beforeText === null ? "/dev/null" : `a/${path}`;
	const newLabel = afterText === null ? "/dev/null" : `b/${path}`;
	const beforeLines = beforeText === null ? [] : splitLines(beforeText);
	const afterLines = afterText === null ? [] : splitLines(afterText);
	const ops = diffLines(beforeLines, afterLines);

	const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
	const changedIndices: number[] = [];
	for (let i = 0; i < ops.length; i++) if (ops[i]!.type !== "equal") changedIndices.push(i);

	if (changedIndices.length === 0) return { diff: out.join("\n"), truncated: false };

	// Group changed indices into hunks with surrounding context.
	const hunks: [number, number][] = [];
	let hunkStart = Math.max(0, changedIndices[0]! - contextLines);
	let hunkEnd = Math.min(ops.length, changedIndices[0]! + contextLines + 1);
	for (let k = 1; k < changedIndices.length; k++) {
		const nextStart = Math.max(0, changedIndices[k]! - contextLines);
		const nextEnd = Math.min(ops.length, changedIndices[k]! + contextLines + 1);
		if (nextStart <= hunkEnd) {
			hunkEnd = Math.max(hunkEnd, nextEnd);
		} else {
			hunks.push([hunkStart, hunkEnd]);
			hunkStart = nextStart;
			hunkEnd = nextEnd;
		}
	}
	hunks.push([hunkStart, hunkEnd]);

	// Precompute 1-based line offsets before each op index.
	const oldPos = new Int32Array(ops.length + 1);
	const newPos = new Int32Array(ops.length + 1);
	let o = 1;
	let n = 1;
	for (let i = 0; i < ops.length; i++) {
		oldPos[i] = o;
		newPos[i] = n;
		if (ops[i]!.type === "equal") {
			o++;
			n++;
		} else if (ops[i]!.type === "delete") {
			o++;
		} else {
			n++;
		}
	}
	oldPos[ops.length] = o;
	newPos[ops.length] = n;

	let truncated = false;
	for (const [hs, he] of hunks) {
		let oldCount = 0;
		let newCount = 0;
		for (let i = hs; i < he; i++) {
			const t = ops[i]!.type;
			if (t === "equal") {
				oldCount++;
				newCount++;
			} else if (t === "delete") oldCount++;
			else newCount++;
		}
		const oldStart = oldCount === 0 ? Math.max(0, oldPos[hs]! - 1) : oldPos[hs]!;
		const newStart = newCount === 0 ? Math.max(0, newPos[hs]! - 1) : newPos[hs]!;
		if (out.length >= maxLines) {
			truncated = true;
			break;
		}
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (let i = hs; i < he; i++) {
			if (out.length >= maxLines) {
				truncated = true;
				break;
			}
			const op = ops[i]!;
			const prefix = op.type === "equal" ? " " : op.type === "delete" ? "-" : "+";
			out.push(`${prefix}${op.line.text}`);
			if (op.line.noNewline) {
				if (out.length >= maxLines) {
					truncated = true;
					break;
				}
				out.push("\\ No newline at end of file");
			}
		}
		if (truncated) break;
	}

	return { diff: out.join("\n"), truncated };
}

function readPlainRelativeFile(
	rootDir: string,
	relPath: string,
	maxBytes: number,
): { ok: true; bytes: Buffer; stat: BigIntStats } | { ok: false; detail: string } {
	let cursor = rootDir;
	const parts = relPath.split("/");
	for (const part of parts.slice(0, -1)) {
		cursor = join(cursor, part);
		const st = lstatSync(cursor, { throwIfNoEntry: false });
		if (st === undefined || st.isSymbolicLink() || !st.isDirectory())
			return { ok: false, detail: `directory unsafe or missing for ${relPath}` };
	}
	return readPlainRegularFile(join(rootDir, relPath), maxBytes);
}

function readBaselineFileVerified(
	baselineDir: string,
	relPath: string,
	expected: EndoChangeSetFileStateV0,
	maxBytes: number,
):
	| { ok: true; kind: "bytes"; bytes: Buffer }
	| { ok: true; kind: "too-large" }
	| { ok: false; reason: "baseline-mismatch" | "baseline-unreadable"; detail: string } {
	if (expected.bytes > maxBytes) return { ok: true, kind: "too-large" };
	const read = readPlainRelativeFile(baselineDir, relPath, maxBytes);
	if (!read.ok) return { ok: false, reason: "baseline-unreadable", detail: `baseline ${relPath}: ${read.detail}` };
	const actualSha = createHash("sha256").update(read.bytes).digest("hex");
	if (read.bytes.length !== expected.bytes || actualSha !== expected.sha256)
		return {
			ok: false,
			reason: "baseline-mismatch",
			detail: `baseline file ${relPath} does not match manifest before.sha256`,
		};
	return { ok: true, kind: "bytes", bytes: read.bytes };
}

/**
 * Render a host-safe, subprocess-free review preview for a staged change set.
 * Always runs `verifyStagedChangeSetV0` first; refuses to render tampered staging directories or mismatched baseline files.
 */
export function renderStagedChangeSetPreviewV0(
	stagingDir: string,
	options: EndoChangeSetPreviewOptionsV0 = {},
	limits: EndoChangeSetLimitsV0 = DEFAULT_ENDO_CHANGESET_LIMITS_V0,
): EndoChangeSetPreviewResultV0 {
	const verified = verifyStagedChangeSetV0(stagingDir, options, limits);
	if (!verified.ok) return verified;

	const maxBytes = options.maxDiffBytesPerFile ?? 64 * 1024;
	const maxLines = options.maxDiffLinesPerFile ?? 400;
	const contextLines = options.contextLines ?? 3;
	const entries: EndoStagedChangePreviewEntryV0[] = [];

	for (const change of verified.manifest.changes) {
		if (change.kind === "mode") {
			entries.push({
				path: change.path,
				kind: "mode",
				before: change.before,
				after: change.after,
				content: "mode-only",
				diff: null,
				truncated: false,
			});
			continue;
		}

		if (change.kind === "added") {
			if (change.after.bytes > maxBytes) {
				entries.push({
					path: change.path,
					kind: "added",
					before: null,
					after: change.after,
					content: "too-large-for-preview",
					diff: null,
					truncated: false,
				});
				continue;
			}
			const staged = readPlainRelativeFile(join(stagingDir, "files"), change.path, maxBytes);
			if (!staged.ok) return { ok: false, reason: "missing-staged-file", detail: staged.detail };
			const actualSha = createHash("sha256").update(staged.bytes).digest("hex");
			if (staged.bytes.length !== change.after.bytes || actualSha !== change.after.sha256)
				return {
					ok: false,
					reason: "staged-bytes-mismatch",
					detail: `staged file changed during preview at ${change.path}`,
				};
			const text = decodeTextOrBinary(staged.bytes);
			if (text === null) {
				entries.push({
					path: change.path,
					kind: "added",
					before: null,
					after: change.after,
					content: "binary",
					diff: null,
					truncated: false,
				});
				continue;
			}
			const formatted = formatUnifiedDiff(change.path, null, text, contextLines, maxLines);
			entries.push({
				path: change.path,
				kind: "added",
				before: null,
				after: change.after,
				content: "added-text",
				diff: formatted.diff,
				truncated: formatted.truncated,
			});
			continue;
		}

		if (options.baselineDir === undefined) {
			entries.push({
				path: change.path,
				kind: change.kind,
				before: change.before,
				after: change.after,
				content: "baseline-unavailable",
				diff: null,
				truncated: false,
			});
			continue;
		}

		if (change.kind === "deleted") {
			const base = readBaselineFileVerified(options.baselineDir, change.path, change.before, maxBytes);
			if (!base.ok) return base;
			if (base.kind === "too-large") {
				entries.push({
					path: change.path,
					kind: "deleted",
					before: change.before,
					after: null,
					content: "too-large-for-preview",
					diff: null,
					truncated: false,
				});
				continue;
			}
			const text = decodeTextOrBinary(base.bytes);
			if (text === null) {
				entries.push({
					path: change.path,
					kind: "deleted",
					before: change.before,
					after: null,
					content: "binary",
					diff: null,
					truncated: false,
				});
				continue;
			}
			const formatted = formatUnifiedDiff(change.path, text, null, contextLines, maxLines);
			entries.push({
				path: change.path,
				kind: "deleted",
				before: change.before,
				after: null,
				content: "unified-diff",
				diff: formatted.diff,
				truncated: formatted.truncated,
			});
			continue;
		}

		// change.kind === "modified"
		if (change.before.bytes > maxBytes || change.after.bytes > maxBytes) {
			entries.push({
				path: change.path,
				kind: "modified",
				before: change.before,
				after: change.after,
				content: "too-large-for-preview",
				diff: null,
				truncated: false,
			});
			continue;
		}
		const base = readBaselineFileVerified(options.baselineDir, change.path, change.before, maxBytes);
		if (!base.ok) return base;
		if (base.kind === "too-large") {
			entries.push({
				path: change.path,
				kind: "modified",
				before: change.before,
				after: change.after,
				content: "too-large-for-preview",
				diff: null,
				truncated: false,
			});
			continue;
		}
		const staged = readPlainRelativeFile(join(stagingDir, "files"), change.path, maxBytes);
		if (!staged.ok) return { ok: false, reason: "missing-staged-file", detail: staged.detail };
		const actualSha = createHash("sha256").update(staged.bytes).digest("hex");
		if (staged.bytes.length !== change.after.bytes || actualSha !== change.after.sha256)
			return {
				ok: false,
				reason: "staged-bytes-mismatch",
				detail: `staged file changed during preview at ${change.path}`,
			};
		const beforeText = decodeTextOrBinary(base.bytes);
		const afterText = decodeTextOrBinary(staged.bytes);
		if (beforeText === null || afterText === null) {
			entries.push({
				path: change.path,
				kind: "modified",
				before: change.before,
				after: change.after,
				content: "binary",
				diff: null,
				truncated: false,
			});
			continue;
		}
		const formatted = formatUnifiedDiff(change.path, beforeText, afterText, contextLines, maxLines);
		entries.push({
			path: change.path,
			kind: "modified",
			before: change.before,
			after: change.after,
			content: "unified-diff",
			diff: formatted.diff,
			truncated: formatted.truncated,
		});
	}

	return { ok: true, manifest: verified.manifest, entries };
}
