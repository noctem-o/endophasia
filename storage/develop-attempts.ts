// The DEVELOP attempt records: `<root>/develop/attempts/`, beside the task file and never inside it (protocol/develop-attempts.ts,
// docs/designs/develop-work-attempts.md).
//
// Write-once. Each record is its own small file, written ONE time and never rewritten, by the protocol in storage/write-once.ts (an
// exclusive temporary file, fsynced, then hard-linked to its final name, which the system refuses when that name exists). A reader sees a
// record whole or not at all; a crash leaves at most a temporary file, swept later. There is no lock: nothing here reads, modifies and
// writes back.
//
// This module does not know the task file and never touches it. It never reads or writes outside `<root>/develop/attempts/`: the directory
// and every file are checked with lstat and opened with O_NOFOLLOW; a symbolic link is refused, not followed. A file that is malformed, of
// an unknown version, over its bound, misnamed or reached through a link is reported as a problem by name and left exactly as found.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	type EndoDevelopAttemptAuthorizationV0,
	validateEndoDevelopAttemptAuthorizationV0,
} from "../protocol/develop-attempt-execution.ts";
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
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_ATTEMPTS_DIRECTORY_V0 = "attempts";
const RECORD = /^(endo\.attempt\.[0-9a-f]{32})\.(prepared|handoff|outcome|authorized)\.json$/;

/**
 * `authorized` (protocol/develop-attempt-execution.ts) is written only by the live workbench, after the operator approved sending the brief
 * to its Pi session on the attached terminal. A build that predates it lists such a file as an `unknown-file` problem and still shows the
 * attempt.
 */
export type EndoAttemptRecordKindV0 = "prepared" | "handoff" | "outcome" | "authorized";

type AnyAttemptRecordV0 =
	| EndoDevelopAttemptV0
	| EndoDevelopAttemptHandoffV0
	| EndoDevelopAttemptOutcomeV0
	| EndoDevelopAttemptAuthorizationV0;

/** One attempt as found: its prepared record and, when they were recorded, its handoff, outcome and send authorisation. */
export interface EndoAttemptEntryV0 {
	attempt: EndoDevelopAttemptV0;
	handoff: EndoDevelopAttemptHandoffV0 | null;
	outcome: EndoDevelopAttemptOutcomeV0 | null;
	authorized: EndoDevelopAttemptAuthorizationV0 | null;
}

/** A file that is not a usable record, with a closed reason. It is never shown as an attempt and never written over. */
export interface EndoAttemptProblemV0 {
	name: string;
	reason: "unsafe-path" | "too-large" | "malformed" | "invalid" | "misnamed" | "orphan" | "unknown-file" | "io";
	/**
	 * `misnamed` only: the attempt the record inside says it belongs to (a well-formed id), when that differs from its file name's. The
	 * record is still not used, but it is evidence about that attempt too (EVIDENCE-INTEGRITY-001).
	 */
	claims?: string;
}

/**
 * The problems that concern one attempt: a file at one of its own names, or a misnamed record that claims it. `kind` is the record kind
 * the file's name gives (null for a name that is not exactly a record name, such as `<id>.x.authorized.json`).
 */
export function endoAttemptProblemsOfV0(
	problems: readonly EndoAttemptProblemV0[],
	attemptId: string,
): { problem: EndoAttemptProblemV0; kind: EndoAttemptRecordKindV0 | null }[] {
	return problems.flatMap((problem) => {
		const named = RECORD.exec(problem.name);
		const own = problem.name.startsWith(`${attemptId}.`);
		if (!own && problem.claims !== attemptId) return [];
		const kind = named === null ? null : (named[2] as EndoAttemptRecordKindV0);
		return [{ problem, kind: own ? (named?.[1] === attemptId ? kind : null) : kind }];
	});
}

export type EndoAttemptsReadV0 =
	| { ok: true; entries: EndoAttemptEntryV0[]; problems: EndoAttemptProblemV0[] }
	| { ok: false; reason: "unsafe-path" | "io" };

export interface EndoDevelopAttemptsStoreOptionsV0 {
	/**
	 * For tests: runs after the temporary file is complete and before it is linked. A throw there is a failure at that point (the record
	 * is not written and the temporary file is removed); a real crash, which removes nothing, is simulated by leaving a temporary file.
	 */
	beforeLink?: () => void;
}

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
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir]);
		if (dirs === "missing") return { ok: true, entries: [], problems: [] };
		if (dirs !== "ok") return { ok: false, reason: dirs };
		let names: string[];
		try {
			names = readdirSync(this.#dir).sort();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			return { ok: false, reason: code === "ENOTDIR" || code === "ELOOP" ? "unsafe-path" : "io" };
		}
		const problems: EndoAttemptProblemV0[] = [];
		const found = new Map<string, Partial<Record<EndoAttemptRecordKindV0, unknown>>>();
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
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
			const read = readBoundedJsonSyncV0(join(this.#dir, name), limit);
			if (!read.ok) {
				problems.push({ name, reason: read.reason });
				continue;
			}
			let record: AnyAttemptRecordV0;
			try {
				record =
					kind === "prepared"
						? validateEndoDevelopAttemptV0(read.value)
						: kind === "handoff"
							? validateEndoDevelopAttemptHandoffV0(read.value)
							: kind === "outcome"
								? validateEndoDevelopAttemptOutcomeV0(read.value)
								: validateEndoDevelopAttemptAuthorizationV0(read.value);
			} catch {
				problems.push({ name, reason: "invalid" });
				continue;
			}
			// A record is the one its name says: a file copied under another attempt's name is not that attempt's.
			const claimed = "id" in record ? record.id : record.attemptId;
			if (claimed !== id) {
				problems.push({ name, reason: "misnamed", claims: claimed });
				continue;
			}
			found.set(id, { ...found.get(id), [kind]: record });
		}
		const entries: EndoAttemptEntryV0[] = [];
		for (const [id, records] of found) {
			if (records.prepared === undefined) {
				// A handoff or outcome without its attempt (the prepared file was removed): listed as a problem, never shown as an attempt.
				for (const kind of ["handoff", "outcome", "authorized"] as const)
					if (records[kind] !== undefined) problems.push({ name: `${id}.${kind}.json`, reason: "orphan" });
				continue;
			}
			entries.push({
				attempt: records.prepared as EndoDevelopAttemptV0,
				handoff: (records.handoff as EndoDevelopAttemptHandoffV0 | undefined) ?? null,
				outcome: (records.outcome as EndoDevelopAttemptOutcomeV0 | undefined) ?? null,
				authorized: (records.authorized as EndoDevelopAttemptAuthorizationV0 | undefined) ?? null,
			});
		}
		entries.sort((a, b) => a.attempt.preparedAtMs - b.attempt.preparedAtMs || (a.attempt.id < b.attempt.id ? -1 : 1));
		return { ok: true, entries, problems };
	}

	/**
	 * Write one record under its final name, once. `exists`: that record was already written (by this operator earlier, or by a concurrent
	 * writer a moment ago), and it was left as it is. `unsafe-path`: the directory is not a plain directory. `failed`: nothing was written.
	 */
	write(
		id: string,
		kind: EndoAttemptRecordKindV0,
		record: AnyAttemptRecordV0,
	): "created" | "exists" | "unsafe-path" | "failed" {
		const name = `${id}.${kind}.json`;
		if (!RECORD.test(name)) return "failed";
		const bytes = Buffer.from(`${canonicalEndoJsonV0(record as never)}\n`, "utf8");
		const limit =
			kind === "prepared"
				? ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPreparedBytes
				: ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxNoteFileBytes;
		if (bytes.length > limit) return "failed";
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir])) return "unsafe-path";
		return writeOnceSyncV0(this.#dir, name, bytes, this.#beforeLink);
	}
}
