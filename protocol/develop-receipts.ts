// DEVELOP verification receipts (docs/designs/develop-verification-receipts.md): what Endophasia itself observed when the operator asked it
// to run one check against one attempt. One closed record kind, one file per receipt under `<root>/develop/receipts/<attempt id>/`, written
// ONCE and never rewritten (storage/develop-receipts.ts).
//
//   reported claim          the agent says tests pass                      nowhere, until the operator writes it down
//   operator-declared       the operator records that statement            <attempt>.outcome.json (Slice E)
//   observed check result   Endophasia ran the operator's command          <receipt>.json (this module)
//   staleness               HEAD has moved since                           computed when read, never stored
//   acceptance              the operator accepts the work                  the task's status, by the operator's own command
//
// A receipt is not acceptance and changes nothing: no task status, no attempt state, no approval, no grant. Its OUTCOME is not stored
// as an opinion: it is derived from the recorded facts by `endoReceiptVerdictV0`, and the validator re-derives it (and the limitations), so
// a file whose verdict does not follow from its own facts is invalid. A receipt is a local, unsigned file: whoever can write the store
// can write one. It is evidence for the operator, not an attestation.
//
// What is never stored: the check's environment, file contents, a configuration value. Its standard output is stored only when the
// operator asks (`--keep-output`, receipt v1, at most `maxKeptStdoutBytes`); a v1 receipt always records the output's SHA-256, which a
// behavioural check (protocol/develop-verification.ts) compares with the plan's expected output.


import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_RECEIPT_SCHEMA_V0 = "endo.develop-receipt.v0";
/**
 * v1 (DEVELOP-BEHAVIOUR-001): `output.stdout`, the standard output's SHA-256 and, when the operator asked, its first bytes. Written by
 * every check from this version on; v0 receipts are still read, and their output is "not recorded".
 */
export const ENDO_DEVELOP_RECEIPT_SCHEMA_V1 = "endo.develop-receipt.v1";
export const ENDO_RECEIPT_ID_PATTERN_V0 = /^endo\.receipt\.[0-9a-f]{32}$/;

export const ENDO_DEVELOP_RECEIPT_LIMITS_V0 = Object.freeze({
	/** Receipts kept for one attempt (checked before a check starts, lock-free: a bound on growth, not a security boundary). */
	maxPerAttempt: 100,
	/**
	 * One receipt file. A check whose receipt could not fit is refused before it runs. 64 KiB for v0; 128 KiB since v1, so that kept
	 * output at its worst JSON escaping (six bytes a byte) fits beside the largest argv.
	 */
	maxFileBytes: 128 * 1024,
	/** The most standard output a receipt keeps, in UTF-8 bytes, when the operator asks for it (`--keep-output`). */
	maxKeptStdoutBytes: 8 * 1024,
	maxArgs: 64,
	/** All arguments together, in UTF-16 units. */
	maxArgvChars: 8 * 1024,
	maxPathChars: 4096,
	defaultTimeoutMs: 600_000,
	minTimeoutMs: 1_000,
	maxTimeoutMs: 7_200_000,
	/** Output passed through, counted, never kept: over this many bytes in total the check is stopped. */
	maxOutputBytes: 64 * 1024 * 1024,
});

/** How the process ended, as observed. Only `exited` is the command finishing by itself. */
export type EndoReceiptExecutionV0 =
	| { kind: "exited"; code: number }
	| { kind: "signaled"; signal: string }
	| { kind: "timed-out" }
	| { kind: "interrupted" }
	| { kind: "output-limit" }
	| { kind: "spawn-failed" };

/**
 * The check's standard output, as a v1 receipt records it. `sha256` is the digest of every byte of it that was read, or null when it was
 * not read whole (the output limit cut it off, or a process outside the group held the pipe); a receipt with a null digest is always
 * inconclusive. `keep` says whether the output itself is in the receipt:
 * - `off`: the operator did not ask for it (the default): only the digest;
 * - `text`: its first bytes (at most `maxKeptStdoutBytes`, cut at a character boundary), `truncated` when that is not all of it;
 * - `not-text`: asked for, but those bytes are not UTF-8 text, so nothing was kept.
 */
export type EndoReceiptStdoutV1 =
	| { sha256: string | null; keep: "off" }
	| { sha256: string | null; keep: "text"; text: string; truncated: boolean }
	| { sha256: string | null; keep: "not-text" };

/** The second observation, after the process group was stopped. */
export type EndoReceiptAfterV0 =
	| {
			state: "observed";
			/** The same worktree and common Git directory as before. */
			sameRepository: boolean;
			commit: string;
			tree: string;
			/** No staged, unstaged, untracked or conflicted entry, no flagged index entry, no submodule. */
			clean: boolean;
			/** HEAD's (and the branch's) reflog read the same as before. */
			reflogsUnchanged: boolean;
			/** The configuration and ignore rules "clean" was judged under read the same as before. */
			rulesUnchanged: boolean;
	  }
	| { state: "unavailable" };

export type EndoReceiptOutcomeV0 = "passed" | "failed" | "inconclusive";

/** Why a receipt is inconclusive, in a fixed order. */
export const ENDO_RECEIPT_REASONS_V0 = [
	"timed-out",
	"interrupted",
	"signaled",
	"output-limit",
	"spawn-failed",
	"escaped-process",
	"after-unavailable",
	"repository-changed",
	"head-moved",
	"tree-changed",
	"reflog-changed",
	"rules-changed",
] as const;
export type EndoReceiptReasonV0 = (typeof ENDO_RECEIPT_REASONS_V0)[number];

/** What a receipt does not establish. The first nine hold for every receipt; the last four when their fact does. In a fixed order. */
export const ENDO_RECEIPT_LIMITATIONS_V0 = [
	"command-defines-the-check",
	"ignored-files-not-examined",
	"environment-not-recorded",
	"changes-reverted-during-check-not-detected",
	"concurrent-writers-not-excluded",
	"clean-is-gits-stat-based-view",
	"processes-leaving-group-not-tracked",
	"attempt-link-is-operator-declared",
	"unsigned-local-record",
	"reflog-unavailable",
	"stray-processes-stopped",
	"executable-in-worktree",
	"stray-processes-not-observable",
] as const;
export type EndoReceiptLimitationV0 = (typeof ENDO_RECEIPT_LIMITATIONS_V0)[number];

/** `<root>/develop/receipts/<attemptId>/<id>.json`: immutable. */
export interface EndoDevelopReceiptV0 {
	/** v0 has no `output.stdout`; v1 always has it. */
	schemaVersion: typeof ENDO_DEVELOP_RECEIPT_SCHEMA_V0 | typeof ENDO_DEVELOP_RECEIPT_SCHEMA_V1;
	id: string;
	attemptId: string;
	/** The attempt's project; the check ran in a working tree of that project's repository. */
	projectId: string;
	requestedBy: "operator";
	via: "cli";
	observer: { tool: "endo"; version: string };
	startedAtMs: number;
	endedAtMs: number;
	/** Measured on a monotonic clock, from the spawn to the end of the process group. */
	durationMs: number;
	repository: { worktree: string; commonDir: string; linked: boolean };
	revision: { commit: string; tree: string; branch: string | null };
	/** Whether the reflogs could be compared (`unavailable`: Git had no reflog for HEAD, or for the branch HEAD names). */
	reflog: "compared" | "unavailable";
	check: {
		/** Exactly the operator's argv after `--`. */
		argv: string[];
		/** The path that was spawned (PATH-resolved, links not followed), and its real path. */
		executable: string;
		realExecutable: string;
		timeoutMs: number;
	};
	execution: EndoReceiptExecutionV0;
	output: { stdoutBytes: number; stderrBytes: number; stdout?: EndoReceiptStdoutV1 };
	/**
	 * Members of the check's process group were still running when its leader exited; they were stopped before the second observation.
	 * Null where that cannot be seen (no /proc): unknown, never "none".
	 */
	strayProcesses: boolean | null;
	/** The output pipes stayed open after the group was gone: a process outside the group held them. */
	escapedProcess: boolean;
	after: EndoReceiptAfterV0;
	outcome: EndoReceiptOutcomeV0;
	reasons: EndoReceiptReasonV0[];
	limitations: EndoReceiptLimitationV0[];
}

/** The facts a verdict is derived from. */
export type EndoReceiptFactsV0 = Pick<
	EndoDevelopReceiptV0,
	"execution" | "escapedProcess" | "strayProcesses" | "after" | "revision" | "reflog" | "repository" | "check"
>;

const within = (root: string, path: string): boolean =>
	path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The outcome, its reasons and the limitations, from the facts alone. `passed` only when the command exited by itself with 0 and nothing
 * else is wrong; `failed` only when it exited by itself with another code and nothing else is wrong; otherwise `inconclusive`, with every
 * reason that applies. A failure while the tree changed is inconclusive: its exit code is still recorded.
 */
export function endoReceiptVerdictV0(facts: EndoReceiptFactsV0): {
	outcome: EndoReceiptOutcomeV0;
	reasons: EndoReceiptReasonV0[];
	limitations: EndoReceiptLimitationV0[];
} {
	const found = new Set<EndoReceiptReasonV0>();
	const e = facts.execution;
	if (e.kind !== "exited") found.add(e.kind);
	if (facts.escapedProcess) found.add("escaped-process");
	const a = facts.after;
	if (a.state === "unavailable") found.add("after-unavailable");
	else {
		if (!a.sameRepository) found.add("repository-changed");
		if (a.commit !== facts.revision.commit || a.tree !== facts.revision.tree) found.add("head-moved");
		if (!a.clean) found.add("tree-changed");
		if (!a.reflogsUnchanged) found.add("reflog-changed");
		if (!a.rulesUnchanged) found.add("rules-changed");
	}
	const reasons = ENDO_RECEIPT_REASONS_V0.filter((r) => found.has(r));
	const outcome: EndoReceiptOutcomeV0 =
		reasons.length > 0 || e.kind !== "exited" ? "inconclusive" : e.code === 0 ? "passed" : "failed";
	const limits = new Set<EndoReceiptLimitationV0>(ENDO_RECEIPT_LIMITATIONS_V0.slice(0, 9));
	if (facts.reflog === "unavailable") limits.add("reflog-unavailable");
	if (facts.strayProcesses === true) limits.add("stray-processes-stopped");
	if (facts.strayProcesses === null) limits.add("stray-processes-not-observable");
	if (
		within(facts.repository.worktree, facts.check.realExecutable) ||
		within(facts.repository.worktree, facts.check.executable)
	)
		limits.add("executable-in-worktree");
	return { outcome, reasons, limitations: ENDO_RECEIPT_LIMITATIONS_V0.filter((l) => limits.has(l)) };
}

/** The label each outcome is shown with, everywhere. None of them says "verified" or names the task. */
export const ENDO_RECEIPT_OUTCOME_LABELS_V0: Readonly<Record<EndoReceiptOutcomeV0, string>> = Object.freeze({
	passed: "Observed check passed",
	failed: "Observed check failed",
	inconclusive: "Inconclusive",
});

/** The words each limitation is shown with. */
export const ENDO_RECEIPT_LIMITATION_TEXT_V0: Readonly<Record<EndoReceiptLimitationV0, string>> = Object.freeze({
	"command-defines-the-check":
		"The command decides what is checked: its exit status says nothing about the task's acceptance criteria.",
	"ignored-files-not-examined":
		"Ignored files (dependencies, build output, .env) were inputs; their contents were not recorded or compared.",
	"environment-not-recorded":
		"The environment (variables, tool versions, network, home directory) was inherited and not recorded.",
	"changes-reverted-during-check-not-detected":
		"A file changed and restored between the two observations is not detected; nothing watched the files.",
	"concurrent-writers-not-excluded":
		"Nothing prevented another process (an agent still working, an editor) from writing the tree during the check.",
	"clean-is-gits-stat-based-view":
		"Clean means Git reported no changes, under the repository's own settings and its index's file stamps.",
	"processes-leaving-group-not-tracked":
		"A process that left the check's process group (setsid, a daemon) was not tracked.",
	"attempt-link-is-operator-declared":
		"The operator linked this check to the attempt; Endophasia does not know which revision the attempt's work produced.",
	"unsigned-local-record": "A local, unsigned file: anyone who can write the store can write a receipt.",
	"reflog-unavailable":
		"Git had no reflog for HEAD or its branch here, so a ref that moved and came back during the check cannot be told.",
	"stray-processes-stopped":
		"Processes of the check were still running when it exited; they were stopped before the second observation.",
	"executable-in-worktree": "The executable is inside the working tree that was checked: the repository supplied it.",
	"stray-processes-not-observable":
		"Whether processes of the check were still running when it exited could not be seen here (no /proc); any were stopped with its group.",
});

/** The words each reason is shown with. */
export const ENDO_RECEIPT_REASON_TEXT_V0: Readonly<Record<EndoReceiptReasonV0, string>> = Object.freeze({
	"timed-out": "it ran past its time limit and was stopped",
	interrupted: "endo was interrupted while it ran (Ctrl-C, a hangup or a termination signal), and stopped it",
	signaled: "it was ended by a signal it did not get from Endophasia",
	"output-limit":
		"it, or a process it started, wrote more output than the limit; it was stopped or its output cut off",
	"spawn-failed": "it could not be started",
	"escaped-process": "a process outside its group still held its output",
	"after-unavailable": "the working tree could not be observed afterwards",
	"repository-changed": "the working tree or repository was not the same one afterwards",
	"head-moved": "HEAD named a different commit or tree afterwards",
	"tree-changed": "the working tree had changes afterwards",
	"reflog-changed": "a ref update was logged during the check",
	"rules-changed": "the configuration or ignore rules changed during the check",
});

// ---- staleness ----------------------------------------------------------------------------------------------------------------------

/**
 * A receipt compared with a working tree the READER chose (the CLI's `--cwd`, the workbench's launch directory). Never stored, never
 * carried forward: a new commit is a different revision even when its tree is the same.
 */
export type EndoReceiptRelationV0 =
	| "at-head"
	| "at-head-changed"
	| "head-differs"
	| "other-worktree"
	| "other-repository"
	| "unavailable";

export interface EndoReceiptCurrentV0 {
	worktree: string;
	commonDir: string;
	commit: string;
	clean: boolean;
}

export function endoReceiptRelationV0(
	receipt: Pick<EndoDevelopReceiptV0, "repository" | "revision">,
	current: EndoReceiptCurrentV0 | null,
): EndoReceiptRelationV0 {
	if (current === null) return "unavailable";
	if (current.commonDir !== receipt.repository.commonDir) return "other-repository";
	if (current.worktree !== receipt.repository.worktree) return "other-worktree";
	if (current.commit !== receipt.revision.commit) return "head-differs";
	return current.clean ? "at-head" : "at-head-changed";
}

export const ENDO_RECEIPT_RELATION_LABELS_V0: Readonly<Record<EndoReceiptRelationV0, string>> = Object.freeze({
	"at-head": "Recorded at this working tree's current HEAD",
	"at-head-changed": "Recorded at the current HEAD, but the working tree has changed since",
	"head-differs": "Stale: this working tree's HEAD is now a different commit",
	"other-worktree": "Recorded in a different working tree; not compared",
	"other-repository": "Recorded in a different repository; not compared",
	unavailable: "Current revision unavailable; not compared",
});

// ---- validation ---------------------------------------------------------------------------------------------------------------------

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const stamp = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is not a time`);
const count = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${what} is not a count`);
const exact = <T extends string>(v: unknown, value: T, what: string): T =>
	v === value ? value : bad(`${what} is not ${value}`);
const matching = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);
const flag = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : bad(`${what} is not a boolean`));
const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not known`);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** An absolute path, as the observer recorded it: well-formed, bounded, no NUL. */
function absolutePath(v: unknown, what: string): string {
	if (
		typeof v !== "string" ||
		!v.startsWith("/") ||
		v.length > ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxPathChars ||
		v.includes("\0") ||
		!v.isWellFormed()
	)
		return bad(`${what} is not an absolute path`);
	return v;
}

/** The operator's argv, checked the same way when a check is asked for and when a receipt is read. */
export function checkEndoReceiptArgvV0(v: unknown): v is string[] {
	if (!Array.isArray(v) || v.length < 1 || v.length > ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxArgs) return false;
	let total = 0;
	for (const arg of v) {
		if (typeof arg !== "string" || arg.includes("\0") || !arg.isWellFormed()) return false;
		total += arg.length;
	}
	return (v[0] as string) !== "" && total <= ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxArgvChars;
}

function execution(v: unknown): EndoReceiptExecutionV0 {
	if (typeof v !== "object" || v === null) return bad("execution is not an object");
	const kind = oneOf(
		(v as Record<string, unknown>).kind,
		["exited", "signaled", "timed-out", "interrupted", "output-limit", "spawn-failed"] as const,
		"execution.kind",
	);
	if (kind === "exited") {
		const r = closed(v, ["kind", "code"], "execution");
		const code = count(r.code, "execution.code");
		return code <= 255 ? { kind, code } : bad("execution.code is not an exit code");
	}
	if (kind === "signaled") {
		const r = closed(v, ["kind", "signal"], "execution");
		return { kind, signal: matching(r.signal, /^SIG[A-Z0-9]{1,12}$/, "execution.signal") };
	}
	closed(v, ["kind"], "execution");
	return { kind };
}

function after(v: unknown): EndoReceiptAfterV0 {
	if (typeof v !== "object" || v === null) return bad("after is not an object");
	const state = oneOf((v as Record<string, unknown>).state, ["observed", "unavailable"] as const, "after.state");
	if (state === "unavailable") {
		closed(v, ["state"], "after");
		return { state };
	}
	const r = closed(
		v,
		["state", "sameRepository", "commit", "tree", "clean", "reflogsUnchanged", "rulesUnchanged"],
		"after",
	);
	return {
		state,
		sameRepository: flag(r.sameRepository, "after.sameRepository"),
		commit: matching(r.commit, OBJECT_ID, "after.commit"),
		tree: matching(r.tree, OBJECT_ID, "after.tree"),
		clean: flag(r.clean, "after.clean"),
		reflogsUnchanged: flag(r.reflogsUnchanged, "after.reflogsUnchanged"),
		rulesUnchanged: flag(r.rulesUnchanged, "after.rulesUnchanged"),
	};
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A v1 receipt's standard output, checked against its byte count: kept text is at most the bound and at most what was read; it is cut
 * (`truncated`) exactly when it is less than what was read, and then, when the output was read whole, only at the bound (less at most a
 * split character's three bytes). That kept text which is all of it has the recorded digest needs a hash, so the store checks it
 * (storage/develop-receipts.ts: `endoKeptStdoutMatchesV0`); this module stays free of Node, since the page's types import it.
 */
function stdoutOf(v: unknown, stdoutBytes: number): EndoReceiptStdoutV1 {
	if (typeof v !== "object" || v === null) return bad("output.stdout is not an object");
	const keep = oneOf((v as Record<string, unknown>).keep, ["off", "text", "not-text"] as const, "output.stdout.keep");
	const r = closed(v, keep === "text" ? ["sha256", "keep", "text", "truncated"] : ["sha256", "keep"], "output.stdout");
	const sha256 = r.sha256 === null ? null : matching(r.sha256, /^[0-9a-f]{64}$/, "output.stdout.sha256");
	if (keep !== "text") return { sha256, keep };
	if (typeof r.text !== "string" || !r.text.isWellFormed()) return bad("output.stdout.text is not text");
	const text = r.text;
	const truncated = flag(r.truncated, "output.stdout.truncated");
	const bytes = utf8Bytes(text);
	const max = ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxKeptStdoutBytes;
	if (bytes > max || bytes > stdoutBytes) return bad("output.stdout.text is longer than its bound or than the output");
	if (truncated !== bytes < stdoutBytes) return bad("output.stdout.truncated does not follow from the counts");
	// Read whole, a cut is only ever at the bound (less a split character); cut off by the output limit, it can be anywhere.
	if (truncated && sha256 !== null && bytes < max - 3) return bad("output.stdout.text was cut short of its bound");
	return { sha256, keep, text, truncated };
}

export function validateEndoDevelopReceiptV0(value: unknown): EndoDevelopReceiptV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"id",
			"attemptId",
			"projectId",
			"requestedBy",
			"via",
			"observer",
			"startedAtMs",
			"endedAtMs",
			"durationMs",
			"repository",
			"revision",
			"reflog",
			"check",
			"execution",
			"output",
			"strayProcesses",
			"escapedProcess",
			"after",
			"outcome",
			"reasons",
			"limitations",
		],
		"receipt",
	);
	const observer = closed(r.observer, ["tool", "version"], "observer");
	const repository = closed(r.repository, ["worktree", "commonDir", "linked"], "repository");
	const revision = closed(r.revision, ["commit", "tree", "branch"], "revision");
	const check = closed(r.check, ["argv", "executable", "realExecutable", "timeoutMs"], "check");
	const schemaVersion = oneOf(
		r.schemaVersion,
		[ENDO_DEVELOP_RECEIPT_SCHEMA_V0, ENDO_DEVELOP_RECEIPT_SCHEMA_V1] as const,
		"schemaVersion",
	);
	const v1 = schemaVersion === ENDO_DEVELOP_RECEIPT_SCHEMA_V1;
	const output = closed(r.output, v1 ? ["stdoutBytes", "stderrBytes", "stdout"] : ["stdoutBytes", "stderrBytes"], "output");
	const stdoutBytes = count(output.stdoutBytes, "output.stdoutBytes");
	if (!checkEndoReceiptArgvV0(check.argv)) return bad("check.argv is not an acceptable argument list");
	const timeoutMs = count(check.timeoutMs, "check.timeoutMs");
	if (
		timeoutMs < ENDO_DEVELOP_RECEIPT_LIMITS_V0.minTimeoutMs ||
		timeoutMs > ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxTimeoutMs
	)
		return bad("check.timeoutMs is out of bounds");
	const branch =
		revision.branch === null
			? null
			: typeof revision.branch === "string" &&
					revision.branch.startsWith("refs/") &&
					revision.branch.length <= 1024 &&
					revision.branch.isWellFormed() &&
					!/[\u0000-\u001f\u007f]/.test(revision.branch)
				? revision.branch
				: bad("revision.branch is not a ref name");
	const startedAtMs = stamp(r.startedAtMs, "startedAtMs");
	const endedAtMs = stamp(r.endedAtMs, "endedAtMs");
	if (endedAtMs < startedAtMs) return bad("endedAtMs is before startedAtMs");
	const receipt: EndoDevelopReceiptV0 = {
		schemaVersion,
		id: matching(r.id, ENDO_RECEIPT_ID_PATTERN_V0, "id"),
		attemptId: matching(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		projectId: matching(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		requestedBy: exact(r.requestedBy, "operator", "requestedBy"),
		via: exact(r.via, "cli", "via"),
		observer: {
			tool: exact(observer.tool, "endo", "observer.tool"),
			version: matching(observer.version, /^[0-9A-Za-z.+-]{1,64}$/, "observer.version"),
		},
		startedAtMs,
		endedAtMs,
		durationMs: count(r.durationMs, "durationMs"),
		repository: {
			worktree: absolutePath(repository.worktree, "repository.worktree"),
			commonDir: absolutePath(repository.commonDir, "repository.commonDir"),
			linked: flag(repository.linked, "repository.linked"),
		},
		revision: {
			commit: matching(revision.commit, OBJECT_ID, "revision.commit"),
			tree: matching(revision.tree, OBJECT_ID, "revision.tree"),
			branch,
		},
		reflog: oneOf(r.reflog, ["compared", "unavailable"] as const, "reflog"),
		check: {
			argv: [...(check.argv as string[])],
			executable: absolutePath(check.executable, "check.executable"),
			realExecutable: absolutePath(check.realExecutable, "check.realExecutable"),
			timeoutMs,
		},
		execution: execution(r.execution),
		output: {
			stdoutBytes,
			stderrBytes: count(output.stderrBytes, "output.stderrBytes"),
			...(v1 ? { stdout: stdoutOf(output.stdout, stdoutBytes) } : {}),
		},
		strayProcesses: r.strayProcesses === null ? null : flag(r.strayProcesses, "strayProcesses"),
		escapedProcess: flag(r.escapedProcess, "escapedProcess"),
		after: after(r.after),
		outcome: oneOf(r.outcome, ["passed", "failed", "inconclusive"] as const, "outcome"),
		reasons: Array.isArray(r.reasons)
			? r.reasons.map((x) => oneOf(x, ENDO_RECEIPT_REASONS_V0, "reasons"))
			: bad("reasons is not a list"),
		limitations: Array.isArray(r.limitations)
			? r.limitations.map((x) => oneOf(x, ENDO_RECEIPT_LIMITATIONS_V0, "limitations"))
			: bad("limitations is not a list"),
	};
	// The verdict must follow from the facts: a file that says "passed" for an exit code of 1, or leaves out a limitation, is not a receipt.
	const derived = endoReceiptVerdictV0(receipt);
	if (
		derived.outcome !== receipt.outcome ||
		!sameList(derived.reasons, receipt.reasons) ||
		!sameList(derived.limitations, receipt.limitations)
	)
		return bad("the outcome, reasons or limitations do not follow from the recorded facts");
	// Output that was not read whole cannot be compared: only an inconclusive receipt may lack its digest.
	if (receipt.output.stdout?.sha256 === null && receipt.outcome !== "inconclusive")
		return bad("output.stdout.sha256 is missing from a conclusive receipt");
	return receipt;
}

// ---- the workbench's read model -----------------------------------------------------------------------------------------------------

/** One receipt as the paired workbench shows it: no path, and the relation to the launch directory's HEAD computed at the read. */
export interface EndoDevelopReceiptViewV0 {
	id: string;
	startedAtMs: number;
	endedAtMs: number;
	argv: string[];
	commit: string;
	branch: string | null;
	execution: EndoReceiptExecutionV0;
	outcome: EndoReceiptOutcomeV0;
	reasons: EndoReceiptReasonV0[];
	limitations: EndoReceiptLimitationV0[];
	relation: EndoReceiptRelationV0;
	/**
	 * The standard output's digest and size (attempts view v5): null for a v0 receipt (output not recorded) or output not read whole. The
	 * output itself is never in this list; a behavioural check shows its latest kept output in the ledger.
	 */
	stdout: { sha256: string | null; bytes: number; recorded: boolean };
}
