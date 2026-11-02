// The DEVELOP attempt records: `<root>/develop/attempts/`, beside the task file and never inside it (protocol/develop-attempts.ts,
// docs/designs/develop-work-attempts.md).
//
// Write-once. Each record is its own small file, written ONE time and never rewritten:
//   1. a temporary file `.tmp-<pid>-<12 hex>` is created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600), written whole and fsynced;
//   2. it is HARD-LINKED to its final name, which the system refuses when that name exists (a file, a link, anything), so of several
//      writers of the same record exactly one succeeds and the others are told it exists; nothing is ever replaced or merged;
//   3. the temporary name is removed and the directory fsynced.
// A reader therefore sees a record whole (its bytes were durable before its name appeared) or not at all. A crash leaves at most a
// temporary file, which a later writer removes once it is a minute old (a younger one may be a live writer's). There is no lock: nothing
// here reads, modifies and writes back.
//
// This module does not know the task file and never touches it. It never reads or writes outside `<root>/develop/attempts/`: the directory
// and every file are checked with lstat and opened with O_NOFOLLOW; a symbolic link is refused, not followed. A file that is malformed, of
// an unknown version, over its bound, misnamed or reached through a link is reported as a problem by name and left exactly as found.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import {
	ENDO_DEVELOP_ATTEMPT_LIMITS_V0,
	type EndoDevelopAttemptHandoffV0,
	type EndoDevelopAttemptOutcomeV0,
	type EndoDevelopAttemptV0,
	validateEndoDevelopAttemptHandoffV0,
	validateEndoDevelopAttemptOutcomeV0,
	validateEndoDevelopAttemptV0,
} from "../protocol/develop-attempts.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import { writeExactSyncV0 } from "./log.ts";

export const ENDO_DEVELOP_ATTEMPTS_DIRECTORY_V0 = "attempts";
const RECORD = /^(endo\.attempt\.[0-9a-f]{32})\.(prepared|handoff|outcome)\.json$/;
const TEMPORARY = /^\.tmp-[0-9]+-[0-9a-f]{12}$/;

export type EndoAttemptRecordKindV0 = "prepared" | "handoff" | "outcome";

/** One attempt as found: its prepared record and, when the operator recorded them, its handoff and outcome. */
export interface EndoAttemptEntryV0 {
	attempt: EndoDevelopAttemptV0;
	handoff: EndoDevelopAttemptHandoffV0 | null;
	outcome: EndoDevelopAttemptOutcomeV0 | null;
}

/** A file that is not a usable record, with a closed reason. It is never shown as an attempt and never written over. */
export interface EndoAttemptProblemV0 {
	name: string;
	reason: "unsafe-path" | "too-large" | "malformed" | "invalid" | "misnamed" | "orphan" | "unknown-file" | "io";
}

export type EndoAttemptsReadV0 =
	| { ok: true; entries: EndoAttemptEntryV0[]; problems: EndoAttemptProblemV0[] }
	| { ok: false; reason: "unsafe-path" | "io" };

export interface EndoDevelopAttemptsStoreOptionsV0 {
	/** For tests: runs after the temporary file is complete and before it is linked (a throw there is a crash at that point). */
	beforeLink?: () => void;
}

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

export class DevelopAttemptsStoreV0 {
	readonly #develop: string;
	readonly #dir: string;
	readonly #beforeLink: (() => void) | undefined;

	constructor(root: string, options: EndoDevelopAttemptsStoreOptionsV0 = {}) {
		this.#develop = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#dir = join(this.#develop, ENDO_DEVELOP_ATTEMPTS_DIRECTORY_V0);
		this.#beforeLink = options.beforeLink;
	}

	get directory(): string {
		return this.#dir;
	}

	/** Every attempt in the directory, read now. A missing directory is no attempts (nothing is created). */
	read(): EndoAttemptsReadV0 {
		let names: string[];
		try {
			for (const dir of [this.#develop, this.#dir]) {
				const info = lstatSync(dir, { throwIfNoEntry: false });
				if (info === undefined) return { ok: true, entries: [], problems: [] };
				if (!info.isDirectory()) return { ok: false, reason: "unsafe-path" };
			}
			names = readdirSync(this.#dir).sort();
		} catch (error) {
			return { ok: false, reason: errno(error) === "ENOTDIR" || errno(error) === "ELOOP" ? "unsafe-path" : "io" };
		}
		const problems: EndoAttemptProblemV0[] = [];
		const found = new Map<string, Partial<Record<EndoAttemptRecordKindV0, unknown>>>();
		for (const name of names) {
			if (TEMPORARY.test(name)) continue;
			const match = RECORD.exec(name);
			if (match === null) {
				problems.push({ name, reason: "unknown-file" });
				continue;
			}
			const [, id, kind] = match as unknown as [string, string, EndoAttemptRecordKindV0];
			const limit =
				kind === "prepared"
					? ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPreparedBytes
					: ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxNoteFileBytes;
			const read = this.#readFile(name, limit);
			if (!read.ok) {
				problems.push({ name, reason: read.reason });
				continue;
			}
			let record: EndoDevelopAttemptV0 | EndoDevelopAttemptHandoffV0 | EndoDevelopAttemptOutcomeV0;
			try {
				record =
					kind === "prepared"
						? validateEndoDevelopAttemptV0(read.value)
						: kind === "handoff"
							? validateEndoDevelopAttemptHandoffV0(read.value)
							: validateEndoDevelopAttemptOutcomeV0(read.value);
			} catch {
				problems.push({ name, reason: "invalid" });
				continue;
			}
			// A record is the one its name says: a file copied under another attempt's name is not that attempt's.
			if (("id" in record ? record.id : record.attemptId) !== id) {
				problems.push({ name, reason: "misnamed" });
				continue;
			}
			found.set(id, { ...found.get(id), [kind]: record });
		}
		const entries: EndoAttemptEntryV0[] = [];
		for (const [id, records] of found) {
			if (records.prepared === undefined) {
				// A handoff or outcome without its attempt (the prepared file was removed): listed as a problem, never shown as an attempt.
				for (const kind of ["handoff", "outcome"] as const)
					if (records[kind] !== undefined) problems.push({ name: `${id}.${kind}.json`, reason: "orphan" });
				continue;
			}
			entries.push({
				attempt: records.prepared as EndoDevelopAttemptV0,
				handoff: (records.handoff as EndoDevelopAttemptHandoffV0 | undefined) ?? null,
				outcome: (records.outcome as EndoDevelopAttemptOutcomeV0 | undefined) ?? null,
			});
		}
		entries.sort((a, b) => a.attempt.preparedAtMs - b.attempt.preparedAtMs || (a.attempt.id < b.attempt.id ? -1 : 1));
		return { ok: true, entries, problems };
	}

	#readFile(
		name: string,
		limit: number,
	): { ok: true; value: unknown } | { ok: false; reason: EndoAttemptProblemV0["reason"] } {
		const path = join(this.#dir, name);
		try {
			const entry = lstatSync(path);
			if (!entry.isFile()) return { ok: false, reason: "unsafe-path" };
			if (entry.size > limit) return { ok: false, reason: "too-large" };
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let bytes: Buffer;
			try {
				const opened = fstatSync(fd);
				if (!opened.isFile()) return { ok: false, reason: "unsafe-path" };
				if (opened.size > limit) return { ok: false, reason: "too-large" };
				bytes = Buffer.alloc(opened.size);
				let at = 0;
				while (at < bytes.length) {
					const n = readSync(fd, bytes, at, bytes.length - at, at);
					if (n === 0) break;
					at += n;
				}
				if (at !== bytes.length) return { ok: false, reason: "io" };
			} finally {
				closeSync(fd);
			}
			try {
				return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
			} catch {
				return { ok: false, reason: "malformed" };
			}
		} catch (error) {
			return { ok: false, reason: errno(error) === "ELOOP" ? "unsafe-path" : "io" };
		}
	}

	/** Make `develop/` and `develop/attempts/` (owner-only) when missing, and prove both are plain directories, not links. */
	#ensureDirectory(): boolean {
		try {
			for (const dir of [this.#develop, this.#dir]) {
				const existing = lstatSync(dir, { throwIfNoEntry: false });
				if (existing === undefined) {
					if (dir === this.#develop) mkdirSync(join(dir, ".."), { recursive: true });
					mkdirSync(dir, { mode: 0o700 });
				}
				if (!lstatSync(dir).isDirectory()) return false;
			}
			return true;
		} catch {
			return false;
		}
	}

	/** A temporary file a crashed writer left. Only one at least a minute old: a younger one may belong to a writer about to link it. */
	#sweep(): void {
		try {
			for (const name of readdirSync(this.#dir)) {
				if (!TEMPORARY.test(name)) continue;
				const info = lstatSync(join(this.#dir, name), { throwIfNoEntry: false });
				if (info?.isFile() === true && Date.now() - info.mtimeMs >= 60_000)
					rmSync(join(this.#dir, name), { force: true });
			}
		} catch {
			// a sweep that cannot run leaves the files for the next writer
		}
	}

	/**
	 * Write one record under its final name, once. `exists`: that record was already written (by this operator earlier, or by a concurrent
	 * writer a moment ago), and it was left as it is. `unsafe-path`: the directory is not a plain directory. `failed`: nothing was written.
	 */
	write(
		id: string,
		kind: EndoAttemptRecordKindV0,
		record: EndoDevelopAttemptV0 | EndoDevelopAttemptHandoffV0 | EndoDevelopAttemptOutcomeV0,
	): "created" | "exists" | "unsafe-path" | "failed" {
		const name = `${id}.${kind}.json`;
		if (!RECORD.test(name)) return "failed";
		const bytes = Buffer.from(`${canonicalEndoJsonV0(record as never)}\n`, "utf8");
		const limit =
			kind === "prepared"
				? ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPreparedBytes
				: ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxNoteFileBytes;
		if (bytes.length > limit) return "failed";
		if (!this.#ensureDirectory()) return "unsafe-path";
		this.#sweep();
		const temporary = join(this.#dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
		let fd: number | undefined;
		try {
			fd = openSync(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			writeExactSyncV0(fd, bytes, temporary);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			this.#beforeLink?.();
			try {
				linkSync(temporary, join(this.#dir, name));
			} catch (error) {
				return errno(error) === "EEXIST" ? "exists" : "failed";
			}
			const directory = openSync(this.#dir, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			return "created";
		} catch {
			return "failed";
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// the descriptor is gone either way
				}
			}
			rmSync(temporary, { force: true });
		}
	}
}
