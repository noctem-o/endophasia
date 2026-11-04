// Browser wire gate for the work-attempts route (`GET workspace/attempts`, protocol/develop-attempts.ts, served read-only by
// runtime/contracts/workspace-routes.ts). The broker is authoritative for what an attempt is; this checks that a body has exactly the shape the
// section reads, that each attempt's state is the one its records imply (an attempt cannot claim "reported" without an outcome, or arrive
// with an outcome and claim "prepared"), and refuses the body whole when it does not. The words are the operator's own and are only shown
// as text. There is no request body: the page names no project, task or attempt, and nothing here can make or record one.
//
// Each attempt carries its verification receipts (protocol/develop-receipts.ts): what Endophasia observed when the operator ran a check.
// A receipt's outcome must be the one its execution and reasons imply ("passed" only for exit 0 with no reason; "failed" only for another
// exit code with no reason; anything else "inconclusive"); a receipt that claims more is refused with the whole body. There is no path.
import type {
	EndoAttemptRunStateV0,
	EndoAttemptSendStateV0,
	EndoDevelopAttemptExecutionViewV0,
} from "../../../protocol/develop-attempt-execution.ts";
import type {
	EndoDevelopAttemptStateV0,
	EndoDevelopAttemptsViewV2,
	EndoDevelopAttemptViewV2,
} from "../../../protocol/develop-attempts.ts";
import type {
	EndoDevelopReceiptViewV0,
	EndoReceiptLimitationV0,
	EndoReceiptOutcomeV0,
	EndoReceiptReasonV0,
	EndoReceiptRelationV0,
} from "../../../protocol/develop-receipts.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type { EndoDevelopAttemptExecutionViewV0 as Execution } from "../../../protocol/develop-attempt-execution.ts";
export type {
	EndoDevelopAttemptStateV0 as AttemptState,
	EndoDevelopAttemptsViewV2 as AttemptsView,
	EndoDevelopAttemptViewV2 as Attempt,
} from "../../../protocol/develop-attempts.ts";
export type {
	EndoDevelopReceiptViewV0 as Receipt,
	EndoReceiptRelationV0 as ReceiptRelation,
} from "../../../protocol/develop-receipts.ts";

export const ATTEMPTS_SCHEMA = "endo.develop-attempts-view.v2";

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
	if ((e.refusal !== null) !== (e.send === "not-sent" || e.send === "refused-by-runtime")) return false;
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
		// The brief is rendered by the broker from the attempt's record; bounded, and it names its own attempt.
		brief: (x) => multiline(64_000)(x),
		receipts: (x) =>
			shape(x, {
				state: one("ready", "unreadable"),
				list: (l) => list(receipt)(l) && (l as unknown[]).length <= 500,
				problems: count,
			}),
		execution: eitherNull(execution_),
	});

export function readAttempts(v: unknown): EndoDevelopAttemptsViewV2 | null {
	if (
		!shape(v, {
			schemaVersion: one(ATTEMPTS_SCHEMA),
			state: one("ready", "no-task", "unreadable"),
			taskId: eitherNull(taskId),
			// A sanity bound only: the per-task cap is checked without a lock and can be passed, and a read never refuses because of it.
			attempts: (x) => list(attempt)(x) && (x as unknown[]).length <= 500,
			problems: count,
		})
	)
		return null;
	const view = v as unknown as EndoDevelopAttemptsViewV2;
	if (view.state !== "ready" && view.attempts.length > 0) return null;
	if ((view.state === "ready" || view.state === "no-task") && (view.taskId === null) !== (view.state === "no-task"))
		return null;
	if (new Set(view.attempts.map((a) => a.id)).size !== view.attempts.length) return null;
	for (const a of view.attempts as EndoDevelopAttemptViewV2[]) {
		const implied = a.outcome !== null ? a.outcome.kind : a.handoff !== null ? "handed-off" : "prepared";
		if (a.state !== implied) return null;
		if (a.outcome?.kind === "reported" && a.outcome.note.trim() === "") return null;
		if (!a.brief.startsWith(`# Work brief ${a.id}\n`) || !a.brief.endsWith(`End of brief ${a.id}.\n`)) return null;
		if (a.receipts.state === "unreadable" && a.receipts.list.length > 0) return null;
		if (new Set(a.receipts.list.map((r) => r.id)).size !== a.receipts.list.length) return null;
		if (!a.receipts.list.every(coherent)) return null;
		if (a.execution !== null && !executionCoherent(a.execution)) return null;
	}
	return view;
}

export type AttemptsReply =
	| { kind: "attempts"; record: EndoDevelopAttemptsViewV2 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: "grant-required" | "invalid" | "unreachable" | "other" };
