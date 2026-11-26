// Pure, zero-subprocess filesystem validation of linked Git worktree `.git` pointers (E2-C).
//
// Shared across `adapters/develop/coordination.ts`, `cockpit-http/coordinator.ts`, and
// `runtime/contracts/develop-attempt-dispatch.ts` without introducing any `adapters/` import into `cockpit-http/`.
// Never spawns `git`, never follows symlinks (`O_NOFOLLOW`), and never modifies the filesystem.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_GIT_POINTER_BYTES = 4096;

const real = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

const isWithin = (parent: string, child: string): boolean => {
	const rel = relative(parent, child);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Read a small plain regular file without following symlinks (`O_NOFOLLOW | O_NONBLOCK`). */
function readRegularSmallTextSync(path: string, maxBytes: number): string | null {
	let fd: number | undefined;
	try {
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st === undefined || !st.isFile() || st.size > maxBytes) return null;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > maxBytes) return null;
		const buf = Buffer.alloc(opened.size);
		let at = 0;
		while (at < buf.length) {
			const n = readSync(fd, buf, at, buf.length - at, at);
			if (n === 0) break;
			at += n;
		}
		if (at !== buf.length) return null;
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore close error
			}
		}
	}
}

/**
 * Resolve a primary checkout's `.git` common directory synchronously when `<primaryPath>/.git` is a plain directory.
 * Returns null if missing, symlinked, or itself a linked pointer file.
 */
export function primaryGitCommonDirSyncV0(primaryPath: string): string | null {
	const dotGit = join(primaryPath, ".git");
	const st = lstatSync(dotGit, { throwIfNoEntry: false });
	if (st === undefined || !st.isDirectory()) return null;
	const canonical = real(dotGit);
	if (canonical === null || canonical !== resolve(dotGit)) return null;
	return canonical;
}

/**
 * Validate a linked sibling worktree's `.git` pointer file against `primaryCommonDir` WITHOUT trusting symlinks
 * or arbitrary external `gitdir:` targets:
 * 1. `<worktreePath>/.git` MUST be a plain regular file (never a symlink or directory).
 * 2. It MUST contain a single `gitdir: <target>` line (no control chars, no extra lines).
 * 3. Its normalized `resolvedTarget` MUST have no symlink components (`resolvedTarget === canonicalGitDir`),
 *    be a plain directory, and lie strictly inside `<primaryCommonDir>/worktrees/`.
 * 4. `<gitDir>/gitdir` MUST be a plain regular file pointing back to `<worktreePath>/.git` (bidirectional check).
 * 5. `<gitDir>/commondir` MUST resolve to `primaryCommonDir`.
 */
export function inspectLinkedGitPointerV0(
	worktreePath: string,
	primaryCommonDir: string,
): { ok: true; gitDir: string } | { ok: false; detail: string } {
	const dotGitPath = join(worktreePath, ".git");
	const dotGitText = readRegularSmallTextSync(dotGitPath, MAX_GIT_POINTER_BYTES);
	if (dotGitText === null) {
		return {
			ok: false,
			detail:
				"sibling worktree .git must be a bounded plain regular pointer file (symlinks and directories refused)",
		};
	}
	const trimmed = dotGitText.replace(/\r?\n$/, "");
	if (/[\u0000-\u001f\u007f]/.test(trimmed) || !trimmed.startsWith("gitdir: ")) {
		return { ok: false, detail: "sibling worktree .git pointer is malformed" };
	}
	const rawTarget = trimmed.slice("gitdir: ".length);
	if (rawTarget.length === 0) return { ok: false, detail: "sibling worktree .git pointer target is empty" };
	// Always normalize via `resolve` (strips trailing slashes so `lstatSync` never follows a leaf symlink).
	const resolvedTarget = resolve(worktreePath, rawTarget);
	const gitDirStat = lstatSync(resolvedTarget, { throwIfNoEntry: false });
	if (gitDirStat === undefined || !gitDirStat.isDirectory()) {
		return { ok: false, detail: "sibling worktree gitdir target is missing or not a plain directory" };
	}
	const canonicalGitDir = real(resolvedTarget);
	if (canonicalGitDir === null || canonicalGitDir !== resolvedTarget) {
		return {
			ok: false,
			detail: "sibling worktree gitdir contains symlinks or could not be canonicalized",
		};
	}

	const worktreesRoot = join(primaryCommonDir, "worktrees");
	if (!isWithin(worktreesRoot, canonicalGitDir)) {
		return {
			ok: false,
			detail: "sibling worktree .git pointer resolves outside the primary repository's worktrees/ directory",
		};
	}

	// Bidirectional check: `<gitDir>/gitdir` must point back to `<worktreePath>/.git`.
	const backPointerText = readRegularSmallTextSync(join(canonicalGitDir, "gitdir"), MAX_GIT_POINTER_BYTES);
	if (backPointerText === null) {
		return { ok: false, detail: "sibling worktree gitdir lacks a valid back-pointer file" };
	}
	const backTargetRaw = backPointerText.replace(/\r?\n$/, "");
	if (/[\u0000-\u001f\u007f]/.test(backTargetRaw) || backTargetRaw.length === 0) {
		return { ok: false, detail: "sibling worktree back-pointer is malformed" };
	}
	const backResolved = real(resolve(canonicalGitDir, backTargetRaw));
	const expectedDotGit = real(dotGitPath);
	if (backResolved === null || expectedDotGit === null || backResolved !== expectedDotGit) {
		return {
			ok: false,
			detail: "sibling worktree gitdir back-pointer does not match this worktree (possible path substitution)",
		};
	}

	// Verify `<gitDir>/commondir` resolves to `primaryCommonDir`.
	const commonPointerText = readRegularSmallTextSync(join(canonicalGitDir, "commondir"), MAX_GIT_POINTER_BYTES);
	if (commonPointerText === null) {
		return { ok: false, detail: "sibling worktree gitdir lacks a valid commondir file" };
	}
	const commonRel = commonPointerText.replace(/\r?\n$/, "");
	if (/[\u0000-\u001f\u007f]/.test(commonRel) || commonRel.length === 0) {
		return { ok: false, detail: "sibling worktree commondir file is malformed" };
	}
	const resolvedCommon = real(resolve(canonicalGitDir, commonRel));
	if (resolvedCommon !== primaryCommonDir) {
		return { ok: false, detail: "sibling worktree commondir does not match the project's repository" };
	}

	return { ok: true, gitDir: canonicalGitDir };
}

/**
 * Re-validate an already-registered sibling worktree's path, `.git` pointer, `commonDir`, and `gitDir`
 * synchronously (before spawning Git or admitting workbench execution).
 */
export function revalidateRegisteredSiblingPointerSyncV0(
	registered: { worktreePath: string; commonDir: string; gitDir: string },
	primaryCommonDir: string,
): { ok: true; gitDir: string } | { ok: false; detail: string } {
	if (registered.commonDir !== primaryCommonDir) {
		return { ok: false, detail: "registered worktree commonDir does not match project primary repository" };
	}
	const dirStat = lstatSync(registered.worktreePath, { throwIfNoEntry: false });
	if (dirStat === undefined || !dirStat.isDirectory()) {
		return { ok: false, detail: "registered worktree path is missing, symlinked, or not a directory" };
	}
	if (real(registered.worktreePath) !== registered.worktreePath) {
		return { ok: false, detail: "registered worktree path is not canonical (possible symlink substitution)" };
	}
	const pointer = inspectLinkedGitPointerV0(registered.worktreePath, primaryCommonDir);
	if (!pointer.ok) return pointer;
	if (pointer.gitDir !== registered.gitDir) {
		return { ok: false, detail: "registered worktree gitDir no longer matches registration" };
	}
	return pointer;
}
