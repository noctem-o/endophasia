// Browser wire gate for the work-attempts route (`GET workspace/attempts`, protocol/develop-attempts.ts, served read-only by
// runtime/contracts/workspace-routes.ts). The broker is authoritative for what an attempt is; this checks that a body has exactly the shape the
// section reads, that each attempt's state is the one its records imply (an attempt cannot claim "reported" without an outcome, or arrive
// with an outcome and claim "prepared"), and refuses the body whole when it does not. The words are the operator's own and are only shown
// as text. There is no request body: the page names no project, task or attempt, and nothing here can make or record one.
//
// Each attempt carries its verification receipts (protocol/develop-receipts.ts): what Endophasia observed when the operator ran a check.
// A receipt's outcome must be the one its execution and reasons imply ("passed" only for exit 0 with no reason; "failed" only for another
// exit code with no reason; anything else "inconclusive"); a receipt that claims more is refused with the whole body. There is no path.
//
// An attempt prepared with a verification plan carries the plan and the acceptance ledger derived from it
// (docs/designs/develop-verification-plans.md). The gate re-derives each criterion's state from its checks' states by the protocol's one
// rule, requires each check's state to agree with the receipts it names (by id, in this attempt's own list, at the relation the state
// needs), and refuses the body whole otherwise: a ledger cannot claim a pass the receipts beside it do not show.
//
// A behavioural check (DEVELOP-BEHAVIOUR-001) declares an expected exit code and output; the gate reads each of its receipts by the protocol's
// behaviour rule (re-derived here, held equal by a contract test) from the receipt's exit code and output digest, so a ledger cannot claim
// a behaviour passed when the digest beside it differs.
//
// An attempt that was authorised or observed carries its provenance (model/provenance-wire.ts): what Git showed of the working tree around
// it. Its own coherence is checked there; here, that every commit it says was checked is one a receipt in this attempt's list names.
import type {
	EndoAttemptRunStateV0,
	EndoAttemptSendStateV0,
	EndoDevelopAttemptExecutionViewV0,
} from "../../../protocol/develop-attempt-execution.ts";
import type {
	EndoAttemptVerificationViewV0,
	EndoDevelopAttemptStateV0,
	EndoDevelopAttemptsViewV5,
	EndoDevelopAttemptViewV5,
} from "../../../protocol/develop-attempts.ts";
import type {
	EndoDevelopReceiptViewV0,
	EndoReceiptLimitationV0,
	EndoReceiptOutcomeV0,
	EndoReceiptReasonV0,
	EndoReceiptRelationV0,
} from "../../../protocol/develop-receipts.ts";
import type { EndoCriterionStateV0, EndoPlannedCheckStateV0 } from "../../../protocol/develop-verification.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";
import { provenance_, provenanceCoherent } from "./provenance-wire.ts";

export type { EndoDevelopAttemptExecutionViewV0 as Execution } from "../../../protocol/develop-attempt-execution.ts";
export type {
	EndoAttemptVerificationViewV0 as Verification,
	EndoDevelopAttemptStateV0 as AttemptState,
	EndoDevelopAttemptsViewV5 as AttemptsView,
	EndoDevelopAttemptViewV5 as Attempt,
} from "../../../protocol/develop-attempts.ts";
export type {
	EndoDevelopReceiptViewV0 as Receipt,
	EndoReceiptRelationV0 as ReceiptRelation,
} from "../../../protocol/develop-receipts.ts";

export const ATTEMPTS_SCHEMA = "endo.develop-attempts-view.v5";

/** These mirror the protocol's closed lists and labels; a contract test holds them equal. */
export const ATTEMPT_STATES: readonly EndoDevelopAttemptStateV0[] = ["prepared", "handed-off", "reported", "abandoned"];
export const ATTEMPT_LABELS: Readonly<Record<EndoDevelopAttemptStateV0, string>> = {
	prepared: "Prepared",
	"handed-off": "Handoff recorded",
	reported: "Result reported, not verified",
	abandoned: "Abandoned",
};

/** These mirror protocol/develop-receipts.ts; a contract test holds them equal. */
export const RECEIPT_OUTCOME_LABELS: Readonly<Record<EndoReceiptOutcomeV0, string>> = {
	passed: "Observed check passed",
	failed: "Observed check failed",
	inconclusive: "Inconclusive",
};
export const RECEIPT_REASON_TEXT: Readonly<Record<EndoReceiptReasonV0, string>> = {
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
};
export const RECEIPT_LIMITATION_TEXT: Readonly<Record<EndoReceiptLimitationV0, string>> = {
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
};
export const RECEIPT_RELATION_LABELS: Readonly<Record<EndoReceiptRelationV0, string>> = {
	"at-head": "Recorded at this working tree's current HEAD",
	"at-head-changed": "Recorded at the current HEAD, but the working tree has changed since",
	"head-differs": "Stale: this working tree's HEAD is now a different commit",
	"other-worktree": "Recorded in a different working tree; not compared",
	"other-repository": "Recorded in a different repository; not compared",
	unavailable: "Current revision unavailable; not compared",
};
/** These mirror protocol/develop-verification.ts; a contract test holds them equal. None of them says a criterion is met. */
export const CRITERION_LABELS: Readonly<Record<EndoCriterionStateV0, string>> = {
	judgment: "Your judgment",
	failed: "A planned check failed at HEAD",
	inconclusive: "A planned check was inconclusive at HEAD",
	passed: "Planned checks passed at HEAD",
	unavailable: "Not compared",
	"not-shown": "Not shown at HEAD",
};
export const CRITERION_TEXT: Readonly<Record<EndoCriterionStateV0, string>> = {
	judgment:
		"No check addresses this criterion in the plan: it rests on your judgment, and nothing observed bears on it.",
	failed: "A check you planned for this criterion failed at the current HEAD.",
	inconclusive:
		"A check you planned for this criterion was inconclusive at the current HEAD, or its results at this commit disagree.",
	passed:
		"Every check you planned for this criterion passed at the current HEAD. That they address it is your plan's statement, not something observed.",
	unavailable: "The working tree could not be read, so no result is compared with it.",
	"not-shown":
		"A check you planned for this criterion has no result at the current HEAD of this clean working tree: not run here, run only at another commit or in another tree, or the tree has changed since.",
};
export const PLANNED_CHECK_LABELS: Readonly<Record<EndoPlannedCheckStateV0, string>> = {
	passed: "Passed at HEAD",
	failed: "Failed at HEAD",
	inconclusive: "Inconclusive at HEAD",
	mixed: "Results at HEAD disagree",
	"tree-changed": "At HEAD, but the tree has changed since",
	stale: "Not run at HEAD (only at other commits)",
	elsewhere: "Run only in another working tree",
	"not-run": "Not run",
	unavailable: "Not compared",
};

/** The protocol's one rule (endoCriterionStateV0), mirrored; a contract test holds them equal over every combination. */
export function criterionState(checks: readonly EndoPlannedCheckStateV0[]): EndoCriterionStateV0 {
	if (checks.length === 0) return "judgment";
	if (checks.includes("failed")) return "failed";
	if (checks.includes("inconclusive") || checks.includes("mixed")) return "inconclusive";
	if (checks.every((s) => s === "passed")) return "passed";
	if (checks.includes("unavailable")) return "unavailable";
	return "not-shown";
}

/** These mirror protocol/develop-attempt-execution.ts; a contract test holds them equal. None of them says the work succeeded. */
export const EXECUTION_SEND_LABELS: Readonly<Record<EndoAttemptSendStateV0, string>> = {
	"evidence-unavailable":
		"Authorised to send to Pi; the session's log could not be read, so what happened next is unknown",
	"not-attributable":
		"Authorised to send to Pi, but the session's log does not hold that request as recorded; nothing after it is attributed",
	"not-sent": "Authorised, then not sent (the workbench refused it before sending)",
	"no-send-recorded":
		"Authorised; no send recorded. It is recorded before it is sent, so it had not been sent as of this read",
	"sent-no-reply": "Sent to Pi; Pi's reply was not recorded. Work may have started; the outcome is unknown",
	"runtime-accepted": "Sent to Pi, and Pi acknowledged it. That is a reply, not completion",
	"refused-by-runtime": "Sent to Pi, and Pi refused it",
};
export const EXECUTION_RUN_LABELS: Readonly<Record<EndoAttemptRunStateV0, string>> = {
	"not-observed": "No run observed after the send",
	open: "A run started; no end is recorded (it may still be running, or its end was not recorded)",
	completed: "Pi reported the run completed. Not verified",
	failed: "Pi reported the run failed",
	aborted: "Pi reported the run aborted",
	unclassified: "The run ended with no stop reason Pi reported",
	interrupted: "Interrupted: the Pi process or its observer ended with the run open; no outcome was reported",
	"process-ended": "The Pi process ended before a run was observed",
};
/** The workbench's prompt refusal reasons an execution can carry (protocol/workbench.ts). */
export const EXECUTION_REFUSALS = [
	"not-authorized",
	"authorization-denied",
	"approval-timed-out",
	"authorization-expired",
	"session-ended",
	"run-active",
	"capability-unavailable",
	"duplicate",
	"runtime-refused",
	"attempt-changed",
	"attempt-not-recorded",
] as const;

export const keysOf = <T extends string>(record: Readonly<Record<T, string>>): T[] => Object.keys(record) as T[];

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const multiline =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max && !UNSAFE.test(v);
export const oneLine =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v) && !UNSAFE.test(v);
export const stamp: Check = (v) => count(v) && v <= 8.64e15;
export const attemptId: Check = (v) => typeof v === "string" && /^endo\.attempt\.[0-9a-f]{32}$/.test(v);
export const taskId: Check = (v) => typeof v === "string" && /^endo\.task\.[0-9a-f]{32}$/.test(v);

export const receiptId: Check = (v) => typeof v === "string" && /^endo\.receipt\.[0-9a-f]{32}$/.test(v);
export const objectId: Check = (v) => typeof v === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v);
const sha256: Check = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const execution: Check = (v) =>
	shape(v, { kind: one("exited"), code: (x) => count(x) && x <= 255 }) ||
	shape(v, { kind: one("signaled"), signal: (x) => typeof x === "string" && /^SIG[A-Z0-9]{1,12}$/.test(x) }) ||
	shape(v, { kind: one("timed-out", "interrupted", "output-limit", "spawn-failed") });
export const distinct = (x: unknown): boolean => new Set(x as unknown[]).size === (x as unknown[]).length;

const receipt: Check = (v) =>
	shape(v, {
		id: receiptId,
		startedAtMs: stamp,
		endedAtMs: stamp,
		argv: (x) => list(oneLine(400))(x) && (x as unknown[]).length >= 1 && (x as unknown[]).length <= 64,
		commit: objectId,
		branch: eitherNull(oneLine(1024)),
		execution,
		outcome: one(...keysOf(RECEIPT_OUTCOME_LABELS)),
		reasons: (x) => list(one(...keysOf(RECEIPT_REASON_TEXT)))(x) && distinct(x),
		limitations: (x) => list(one(...keysOf(RECEIPT_LIMITATION_TEXT)))(x) && distinct(x),
		relation: one(...keysOf(RECEIPT_RELATION_LABELS)),
		stdout: (x) =>
			shape(x, { sha256: eitherNull(sha256), bytes: count, recorded: (b) => typeof b === "boolean" }) &&
			// Not recorded (a v0 receipt) has no digest; a digest missing from a recorded one only on an inconclusive receipt.
			((x as { recorded: boolean }).recorded || (x as { sha256: unknown }).sha256 === null),
	});

/** Whether a receipt's outcome is the one its execution and reasons imply. */
export function coherent(
	r: Pick<EndoDevelopReceiptViewV0, "startedAtMs" | "endedAtMs" | "execution" | "reasons" | "outcome">,
): boolean {
	if (r.endedAtMs < r.startedAtMs) return false;
	const exited = r.execution.kind === "exited";
	if (!exited && !r.reasons.includes(r.execution.kind as EndoReceiptReasonV0)) return false;
	if (r.reasons.length > 0 || !exited) return r.outcome === "inconclusive";
	return r.outcome === ((r.execution as { code: number }).code === 0 ? "passed" : "failed");
}

/** The protocol's first-difference pointer (endoFirstDifferenceV0), mirrored for the page; a contract test holds the two equal. */
export function firstDifference(
	expected: string,
	observed: string,
): { line: number; expected: string | null; observed: string | null } | null {
	if (expected === observed) return null;
	const a = expected.split("\n");
	const b = observed.split("\n");
	for (let i = 0; i < Math.max(a.length, b.length); i += 1)
		if (a[i] !== b[i]) return { line: i + 1, expected: a[i] ?? null, observed: b[i] ?? null };
	return { line: a.length, expected: a.at(-1) ?? null, observed: b.at(-1) ?? null };
}

/** A recorded digest is missing only from an inconclusive receipt (its output was not read whole). */
export const stdoutCoherent = (r: Pick<EndoDevelopReceiptViewV0, "outcome" | "stdout">): boolean =>
	!(r.stdout.recorded && r.stdout.sha256 === null && r.outcome !== "inconclusive");

/** The protocol's behaviour rule (endoBehaviourOutcomeV0), mirrored; a contract test holds the two equal. */
export function behaviourOutcome(
	r: Pick<EndoDevelopReceiptViewV0, "outcome" | "execution" | "stdout">,
	expected: { exitCode: number; stdoutSha256: string },
): EndoReceiptOutcomeV0 {
	if (r.outcome === "inconclusive" || r.stdout.sha256 === null || r.execution.kind !== "exited") return "inconclusive";
	return r.execution.code === expected.exitCode && r.stdout.sha256 === expected.stdoutSha256 ? "passed" : "failed";
}

const execution_: Check = (v) =>
	shape(v, {
		authorizedAtMs: stamp,
		session: oneLine(256),
		attachment: oneLine(256),
		taskRevision: count,
		send: one(...keysOf(EXECUTION_SEND_LABELS)),
		refusal: eitherNull(one(...EXECUTION_REFUSALS)),
		disposition: eitherNull(one("started", "queued", "handled")),
		run: one(...keysOf(EXECUTION_RUN_LABELS)),
		evidence: one("complete", "partial", "unavailable"),
		brief: one("matches", "differs"),
	});

/** Whether the session's log shows the brief was sent (whatever Pi then said). */
export const executionSent = (e: Pick<EndoDevelopAttemptExecutionViewV0, "send">): boolean =>
	e.send === "sent-no-reply" || e.send === "runtime-accepted" || e.send === "refused-by-runtime";

/**
 * Whether an execution's parts agree: a refusal only with a refusal state, a disposition only with an acceptance, a run only after a send,
 * and nothing read from a log that could not be read.
 */
export function executionCoherent(e: EndoDevelopAttemptExecutionViewV0): boolean {
	const sent = executionSent(e);
	// A refusal reason only with a refusal. `not-sent` may carry none: a reason this build does not know is read as unknown, not invalid.
	if (e.refusal !== null && e.send !== "not-sent" && e.send !== "refused-by-runtime") return false;
	if (e.send === "refused-by-runtime" && e.refusal !== "runtime-refused") return false;
	if ((e.disposition !== null) !== (e.send === "runtime-accepted")) return false;
	if (!sent && e.run !== "not-observed") return false;
	// An unreadable log decides nothing; a complete one always decides something.
	if (e.evidence === "unavailable" && e.send !== "evidence-unavailable") return false;
	if (e.evidence === "complete" && e.send === "evidence-unavailable") return false;
	return true;
}

const attempt: Check = (v) =>
	shape(v, {
		id: attemptId,
		state: one(...ATTEMPT_STATES),
		preparedAtMs: stamp,
		taskRevision: count,
		objective: (x) => multiline(4000)(x) && (x as string).trim() !== "",
		handoff: eitherNull((h) =>
			shape(h, {
				recordedAtMs: stamp,
				target: (x) => oneLine(80)(x) && (x as string) !== "",
				note: eitherNull(oneLine(280)),
			}),
		),
		outcome: eitherNull((o) =>
			shape(o, { recordedAtMs: stamp, kind: one("reported", "abandoned"), note: multiline(4000) }),
		),
		taskWordsChanged: (x) =>
			list(one("title", "description", "acceptance"))(x) && new Set(x as unknown[]).size === (x as unknown[]).length,
		// The brief is rendered by the broker from the attempt's record; bounded, and it names its own attempt. v0's six fenced texts reach
		// about 61 000 characters with fence expansion; a v1 plan section adds at most about three times its 16 KiB (each text inside a fence
		// at most one longer than its longest backtick run, on both sides) plus its fixed lines. A test renders a worst case under this.
		brief: (x) => multiline(160_000)(x),
		receipts: (x) =>
			shape(x, {
				state: one("ready", "unreadable"),
				list: (l) => list(receipt)(l) && (l as unknown[]).length <= 500,
				problems: count,
			}),
		execution: eitherNull(execution_),
		verification: eitherNull(verification_),
		provenance: eitherNull(provenance_),
	});

const outcomes = one("passed", "failed", "inconclusive");
const behaviour_: Check = (v) =>
	shape(v, {
		expected: (e) =>
			shape(e, {
				exitCode: (x) => count(x) && x <= 255,
				// 4 KiB of UTF-8 is at most 4 096 UTF-16 units; line breaks and tabs only.
				stdout: (x) => multiline(4096)(x) && !/[\r\u200e\u200f\u061c\ufffd]/.test(x as string),
				stdoutSha256: sha256,
			}),
		observed: eitherNull((o) =>
			shape(o, {
				receiptId,
				exitCode: eitherNull((x) => count(x) && x <= 255),
				stdoutBytes: count,
				stdoutSha256: eitherNull(sha256),
				kept: (k) =>
					shape(k, { state: one("not-recorded", "off", "not-text") }) ||
					shape(k, {
						state: one("text"),
						text: (t) => typeof t === "string" && t.length <= 8192 && !UNSAFE.test(t),
						truncated: (b) => typeof b === "boolean",
					}),
			}),
		),
	});
const ledgerReceipt: Check = (v) =>
	shape(v, { receiptId, commit: objectId, outcome: outcomes, startedAtMs: stamp, endedAtMs: stamp });
const verification_: Check = (v) =>
	shape(v, {
		checks: (x) =>
			list((c) =>
				shape(c, {
					name: (n) => typeof n === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(n),
					argv: (a) => list(oneLine(400))(a) && (a as unknown[]).length >= 1 && (a as unknown[]).length <= 64,
					shows: (t) => oneLine(280)(t) && (t as string) !== "",
					state: one(...keysOf(PLANNED_CHECK_LABELS)),
					current: eitherNull(ledgerReceipt),
					atHead: (a) => shape(a, { passed: count, failed: count, inconclusive: count }),
					otherCommit: eitherNull(ledgerReceipt),
					runs: count,
					behaviour: eitherNull(behaviour_),
				}),
			)(x) && (x as unknown[]).length <= 8,
		criteria: (x) =>
			list((c) =>
				shape(c, {
					text: (t) => oneLine(280)(t) && (t as string) !== "",
					checks: (l) => list((n) => typeof n === "string")(l) && distinct(l),
					state: one(...keysOf(CRITERION_LABELS)),
				}),
			)(x) &&
			(x as unknown[]).length >= 1 &&
			(x as unknown[]).length <= 12,
		unplanned: count,
	});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

type LedgerReceipt = { receiptId: string; commit: string; outcome: string; startedAtMs: number; endedAtMs: number };

/**
 * Whether an attempt's ledger agrees with itself and with the receipts listed beside it: every check is named by a criterion and every
 * name resolves; each criterion's state follows from its checks' states; each check's state agrees with the receipts it names (by id, in
 * this list, with the same argv, commit, outcome and times, at the relation the state needs) and with its counts at HEAD.
 */
export function verificationCoherent(a: Pick<EndoDevelopAttemptViewV5, "receipts" | "verification">): boolean {
	const v = a.verification;
	if (v === null) return true;
	const names = v.checks.map((c) => c.name);
	if (!distinct(names)) return false;
	if (!distinct(v.checks.map((c) => JSON.stringify(c.argv)))) return false;
	if (!names.every((n) => v.criteria.some((c) => c.checks.includes(n)))) return false;
	const stateOf = new Map(v.checks.map((c) => [c.name, c.state]));
	for (const c of v.criteria) {
		if (!c.checks.every((n) => stateOf.has(n))) return false;
		if (c.state !== criterionState(c.checks.map((n) => stateOf.get(n) as EndoPlannedCheckStateV0))) return false;
	}
	const unavailable = v.checks.filter((c) => c.state === "unavailable").length;
	if (unavailable !== 0 && unavailable !== v.checks.length) return false;
	const listed = new Map(a.receipts.list.map((r) => [r.id, r]));
	type Listed = (typeof a.receipts.list)[number];
	type Planned = (typeof v.checks)[number];
	/** How this check reads a listed receipt: its exit status, or for a behavioural check the behaviour rule. */
	const outcomeOf =
		(c: Planned) =>
		(r: Listed): string =>
			c.behaviour === null ? r.outcome : behaviourOutcome(r, c.behaviour.expected);
	const resolves = (x: LedgerReceipt | null, c: Planned, relations: readonly string[]): boolean => {
		if (x === null) return true;
		const r = listed.get(x.receiptId);
		return (
			r !== undefined &&
			sameList(r.argv, c.argv) &&
			r.commit === x.commit &&
			outcomeOf(c)(r) === x.outcome &&
			r.startedAtMs === x.startedAtMs &&
			r.endedAtMs === x.endedAtMs &&
			relations.includes(r.relation)
		);
	};
	// Counted from the receipts listed beside the ledger, never taken from it: a planned argument cannot hold a character the display-safe
	// form puts in (protocol/develop-verification.ts), so a listed argv equals a planned one only when it is that argv.
	const ofCheck = (argv: readonly string[]) => a.receipts.list.filter((r) => sameList(r.argv, argv));
	if (v.unplanned !== a.receipts.list.filter((r) => !v.checks.some((c) => sameList(r.argv, c.argv))).length)
		return false;
	for (const c of v.checks) {
		const mine = ofCheck(c.argv);
		if (c.runs !== mine.length) return false;
		for (const o of ["passed", "failed", "inconclusive"] as const)
			if (
				c.atHead[o] !==
				mine.filter((r) => (r.relation === "at-head" || r.relation === "at-head-changed") && outcomeOf(c)(r) === o)
					.length
			)
				return false;
		const total = c.atHead.passed + c.atHead.failed + c.atHead.inconclusive;
		const relation = c.current === null ? null : listed.get(c.current.receiptId)?.relation;
		if (!resolves(c.current, c, ["at-head", "at-head-changed"])) return false;
		if (!resolves(c.otherCommit, c, ["head-differs"])) return false;
		if (
			c.behaviour !== null &&
			!behaviourAgrees(c.behaviour, c.current === null ? undefined : listed.get(c.current.receiptId))
		)
			return false;
		if ((c.current === null) !== (total === 0)) return false;
		if (c.runs < total + (c.otherCommit === null ? 0 : 1)) return false;
		switch (c.state) {
			case "passed":
			case "failed":
			case "inconclusive":
				if (relation !== "at-head" || c.current?.outcome !== c.state || c.atHead[c.state] !== total) return false;
				break;
			case "mixed":
				if (relation !== "at-head" || c.current === null || c.atHead[c.current.outcome] === total) return false;
				break;
			case "tree-changed":
				if (relation !== "at-head-changed") return false;
				break;
			case "stale":
				if (c.current !== null || c.otherCommit === null) return false;
				break;
			case "elsewhere":
				if (c.current !== null || c.otherCommit !== null || c.runs === 0) return false;
				break;
			case "not-run":
				if (c.current !== null || c.otherCommit !== null || c.runs !== 0) return false;
				break;
			case "unavailable":
				if (c.current !== null || c.otherCommit !== null) return false;
				break;
		}
	}
	return true;
}

/**
 * Whether a behavioural check's observation is the listed receipt's: present exactly when the check has a receipt at HEAD, that receipt,
 * with its exit code, size and digest; output "not recorded" exactly when the receipt recorded none. And the expectation's digest is a
 * digest (the broker computed it from the plan's text; the page cannot hash synchronously).
 */
function behaviourAgrees(
	b: NonNullable<EndoAttemptVerificationViewV0["checks"][number]["behaviour"]>,
	r: EndoDevelopReceiptViewV0 | undefined,
): boolean {
	const o = b.observed;
	if (o === null || r === undefined) return o === null && r === undefined;
	return (
		o.receiptId === r.id &&
		o.exitCode === (r.execution.kind === "exited" ? r.execution.code : null) &&
		o.stdoutBytes === r.stdout.bytes &&
		o.stdoutSha256 === r.stdout.sha256 &&
		(o.kept.state === "not-recorded") === !r.stdout.recorded
	);
}

/**
 * Whether a receipt's relation is the one the view's HEAD implies: at HEAD only at that commit (clean or not, as read), another commit only
 * when it differs, and "unavailable" only when nothing was read. Another worktree or repository cannot be told here (no paths are sent).
 */
export function relationAgrees(
	r: Pick<EndoDevelopReceiptViewV0, "commit" | "relation">,
	head: EndoDevelopAttemptsViewV5["head"],
): boolean {
	const commit = head?.commit ?? null;
	switch (r.relation) {
		case "unavailable":
			return commit === null;
		case "at-head":
			return commit === r.commit && head?.clean === true;
		case "at-head-changed":
			return commit === r.commit && head?.clean === false;
		case "head-differs":
			return commit !== null && commit !== r.commit;
		default:
			return commit !== null;
	}
}

export function readAttempts(v: unknown): EndoDevelopAttemptsViewV5 | null {
	if (
		!shape(v, {
			schemaVersion: one(ATTEMPTS_SCHEMA),
			state: one("ready", "no-task", "unreadable"),
			taskId: eitherNull(taskId),
			// A sanity bound only: the per-task cap is checked without a lock and can be passed, and a read never refuses because of it.
			attempts: (x) => list(attempt)(x) && (x as unknown[]).length <= 500,
			problems: count,
			head: eitherNull((h) =>
				shape(h, {
					readAtMs: stamp,
					commit: eitherNull(objectId),
					clean: eitherNull((c) => typeof c === "boolean"),
				}),
			),
		})
	)
		return null;
	const view = v as unknown as EndoDevelopAttemptsViewV5;
	if (view.state !== "ready" && view.attempts.length > 0) return null;
	if ((view.state === "ready" || view.state === "no-task") && (view.taskId === null) !== (view.state === "no-task"))
		return null;
	if (new Set(view.attempts.map((a) => a.id)).size !== view.attempts.length) return null;
	if (view.head !== null && (view.head.commit === null) !== (view.head.clean === null)) return null;
	for (const a of view.attempts as EndoDevelopAttemptViewV5[]) {
		const implied = a.outcome !== null ? a.outcome.kind : a.handoff !== null ? "handed-off" : "prepared";
		if (a.state !== implied) return null;
		if (a.outcome?.kind === "reported" && a.outcome.note.trim() === "") return null;
		if (!a.brief.startsWith(`# Work brief ${a.id}\n`) || !a.brief.endsWith(`End of brief ${a.id}.\n`)) return null;
		if (a.receipts.state === "unreadable" && a.receipts.list.length > 0) return null;
		if (new Set(a.receipts.list.map((r) => r.id)).size !== a.receipts.list.length) return null;
		if (!a.receipts.list.every(coherent)) return null;
		if (!a.receipts.list.every(stdoutCoherent)) return null;
		if (!a.receipts.list.every((r) => relationAgrees(r, view.head))) return null;
		if (a.execution !== null && !executionCoherent(a.execution)) return null;
		if (!verificationCoherent(a)) return null;
		if (a.provenance !== null) {
			if (!provenanceCoherent(a.provenance)) return null;
			// A commit the provenance says was checked is one a receipt listed here names.
			const commits = new Set(a.receipts.list.map((r) => r.commit));
			if (a.provenance.checked.some((c) => !commits.has(c.commit))) return null;
			// "Now" in the provenance is the same reading of the tree as the view's HEAD.
			if (a.provenance.now !== null && view.head !== null && a.provenance.now.commit !== view.head.commit)
				return null;
		}
	}
	return view;
}

export type AttemptsReply =
	| { kind: "attempts"; record: EndoDevelopAttemptsViewV5 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: "grant-required" | "invalid" | "unreachable" | "other" };
