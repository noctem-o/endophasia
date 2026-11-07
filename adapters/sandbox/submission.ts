// Collecting a protected attempt's submission: after the agent's sandbox is gone (its PID namespace confirmed empty), the trusted
// controller copies the declared files, and nothing else, from the agent's workspace into a new staging directory it alone creates. The
// evaluator only ever sees that copy. Each file's digest, and the digest of the sorted manifest, identify exactly what was evaluated.
//
// Policy: every declared path must be a plain relative path whose every directory is a real directory (no symbolic link anywhere on the
// way) and whose file is a regular file with one link, within the size bounds. Anything else refuses the whole submission, by reason.
//
// Races: Node has no openat, so a path is resolved component by component and the file is opened with O_NOFOLLOW, then compared with what
// lstat saw (device, inode, size, change time), read to its end, and compared again before and after with a fresh lstat. This detects a
// file or directory that changes during collection. It does not make collection safe against a live writer that swaps a directory between
// those steps: that is why collection runs only after the agent's processes are confirmed gone, when no sandboxed process can write.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EndoProtectedRefusalV0, EndoProtectedTrialV0 } from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { writeAllSyncV0 } from "../../runtime/contracts/write-all.ts";

export interface EndoSubmissionLimitsV0 {
	maxFileBytes: number;
	maxTotalBytes: number;
}

export type EndoSubmissionV0 = EndoProtectedTrialV0["submission"];

const PLAIN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,200}$/;

/** Test-only: runs after a file is opened and before it is read, to simulate a change during collection. */
export interface EndoSubmissionHooksV0 {
	afterOpen?: (path: string) => void;
}

/** The filesystem errors an agent can cause in its own workspace: removed access, a vanished entry, a link or directory in the way. */
const AGENT_CAUSED = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EISDIR"];
const agentCaused = (code: string | undefined): boolean => AGENT_CAUSED.includes(code ?? "");

const same = (a: { dev: number; ino: number; size: number; ctimeMs: number }, b: typeof a) =>
	a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs;

/** The digest of a submission: sha256 of the canonical JSON of its sorted manifest. */
export const endoSubmissionDigestV0 = (files: EndoSubmissionV0["files"]): string =>
	sha256HexV0(canonicalEndoJsonV0(files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }))));

function readExactly(
	path: string,
	root: string,
	max: number,
	hooks: EndoSubmissionHooksV0,
): Buffer | EndoProtectedRefusalV0 {
	// Every directory on the way is a real directory, not a link.
	const parts = path.split("/");
	let at = root;
	for (const part of parts.slice(0, -1)) {
		at = join(at, part);
		const d = lstatSync(at, { throwIfNoEntry: false });
		if (d === undefined) return "missing";
		if (d.isSymbolicLink()) return "symbolic-link";
		if (!d.isDirectory()) return "unsafe-path";
	}
	const full = join(root, path);
	const before = lstatSync(full, { throwIfNoEntry: false });
	if (before === undefined) return "missing";
	if (before.isSymbolicLink()) return "symbolic-link";
	if (!before.isFile()) return "not-a-regular-file";
	if (before.nlink !== 1) return "hard-link";
	if (before.size > max) return "too-large";
	let fd: number;
	try {
		fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") return "symbolic-link";
		if (agentCaused(code)) return "unreadable";
		throw error;
	}
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || !same(opened, before)) return "changed-during-collection";
		hooks.afterOpen?.(path);
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.alloc(Math.min(65_536, max + 1 - total));
			if (chunk.length === 0) return "too-large";
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
			if (total > max) return "too-large";
		}
		const after = fstatSync(fd);
		const again = lstatSync(full, { throwIfNoEntry: false });
		if (
			total !== before.size ||
			!same(after, before) ||
			again === undefined ||
			!same(again, before) ||
			again.nlink !== 1
		)
			return "changed-during-collection";
		return Buffer.concat(chunks);
	} catch (error) {
		// Removed access or a vanished entry is the agent's doing; the host's I/O (EIO, EMFILE, ...) is not, and propagates.
		if (agentCaused((error as NodeJS.ErrnoException).code)) return "unreadable";
		throw error;
	} finally {
		closeSync(fd);
	}
}

/**
 * Collect the declared `paths` from `workspace` into `staging` (which must not exist; it is created here, its files read-only). Refuses the
 * whole submission on any refusal; `missing` when every refusal is a missing file.
 */
export function exportSubmissionV0(
	workspace: string,
	paths: readonly string[],
	limits: EndoSubmissionLimitsV0,
	staging: string,
	hooks: EndoSubmissionHooksV0 = {},
): EndoSubmissionV0 {
	const refusals: EndoSubmissionV0["refusals"] = [];
	const read: { path: string; bytes: Buffer }[] = [];
	let total = 0;
	for (const path of [...new Set(paths)].sort()) {
		if (!PLAIN.test(path)) {
			refusals.push({ path, reason: "unsafe-path" });
			continue;
		}
		let got: Buffer | EndoProtectedRefusalV0;
		try {
			got = readExactly(path, workspace, limits.maxFileBytes, hooks);
		} catch (error) {
			// What an agent can cause (removed access, a vanished entry, a link or a directory in the way) is a refusal of this file. Anything
			// else (the host's I/O, too many open files) is not the agent's: it propagates, and the controller records it as its own failure.
			if (!agentCaused((error as NodeJS.ErrnoException).code)) throw error;
			got = "unreadable";
		}
		if (typeof got === "string") {
			refusals.push({ path, reason: got });
			continue;
		}
		total += got.length;
		if (total > limits.maxTotalBytes) {
			refusals.push({ path, reason: "total-too-large" });
			continue;
		}
		read.push({ path, bytes: got });
	}
	if (refusals.length > 0)
		return {
			status: refusals.every((r) => r.reason === "missing") ? "missing" : "refused",
			files: [],
			sha256: null,
			refusals,
		};
	// The copy: a new directory the controller creates, new files created exclusively, never through a link; then read-only.
	mkdirSync(staging, { mode: 0o700 });
	const files: EndoSubmissionV0["files"] = [];
	for (const { path, bytes } of read) {
		const target = join(staging, path);
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
		chmodSync(target, 0o444);
		files.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	// The files are read-only; the directories stay the controller's to remove. The evaluator mounts the whole copy read-only.
	return { status: "collected", files, sha256: endoSubmissionDigestV0(files), refusals: [] };
}
