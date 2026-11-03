// Browser wire gate for the work-attempts route (`GET workspace/attempts`, protocol/develop-attempts.ts, served read-only by
// adapters/pi/workbench-tasks.ts). The broker is authoritative for what an attempt is; this checks that a body has exactly the shape the
// section reads, that each attempt's state is the one its records imply (an attempt cannot claim "reported" without an outcome, or arrive
// with an outcome and claim "prepared"), and refuses the body whole when it does not. The words are the operator's own and are only shown
// as text. There is no request body: the page names no project, task or attempt, and nothing here can make or record one.
//
// Each attempt carries its verification receipts (protocol/develop-receipts.ts): what Endophasia observed when the operator ran a check.
// A receipt's outcome must be the one its execution and reasons imply ("passed" only for exit 0 with no reason; "failed" only for another
// exit code with no reason; anything else "inconclusive"); a receipt that claims more is refused with the whole body. There is no path.
import type {
	EndoDevelopAttemptStateV0,
	EndoDevelopAttemptsViewV1,
	EndoDevelopAttemptViewV1,
} from "../../../protocol/develop-attempts.ts";
import type {
	EndoDevelopReceiptViewV0,
	EndoReceiptLimitationV0,
	EndoReceiptOutcomeV0,
	EndoReceiptReasonV0,
	EndoReceiptRelationV0,
} from "../../../protocol/develop-receipts.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type {
	EndoDevelopAttemptStateV0 as AttemptState,
	EndoDevelopAttemptsViewV1 as AttemptsView,
	EndoDevelopAttemptViewV1 as Attempt,
} from "../../../protocol/develop-attempts.ts";
export type {
	EndoDevelopReceiptViewV0 as Receipt,
	EndoReceiptRelationV0 as ReceiptRelation,
} from "../../../protocol/develop-receipts.ts";

export const ATTEMPTS_SCHEMA = "endo.develop-attempts-view.v1";

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
const keysOf = <T extends string>(record: Readonly<Record<T, string>>): T[] => Object.keys(record) as T[];

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const multiline =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max && !UNSAFE.test(v);
const oneLine =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v) && !UNSAFE.test(v);
const stamp: Check = (v) => count(v) && v <= 8.64e15;
const attemptId: Check = (v) => typeof v === "string" && /^endo\.attempt\.[0-9a-f]{32}$/.test(v);
const taskId: Check = (v) => typeof v === "string" && /^endo\.task\.[0-9a-f]{32}$/.test(v);

const receiptId: Check = (v) => typeof v === "string" && /^endo\.receipt\.[0-9a-f]{32}$/.test(v);
const objectId: Check = (v) => typeof v === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v);
const execution: Check = (v) =>
	shape(v, { kind: one("exited"), code: (x) => count(x) && x <= 255 }) ||
	shape(v, { kind: one("signaled"), signal: (x) => typeof x === "string" && /^SIG[A-Z0-9]{1,12}$/.test(x) }) ||
	shape(v, { kind: one("timed-out", "interrupted", "output-limit", "spawn-failed") });
const distinct = (x: unknown): boolean => new Set(x as unknown[]).size === (x as unknown[]).length;

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
function coherent(r: EndoDevelopReceiptViewV0): boolean {
	if (r.endedAtMs < r.startedAtMs) return false;
	const exited = r.execution.kind === "exited";
	if (!exited && !r.reasons.includes(r.execution.kind as EndoReceiptReasonV0)) return false;
	if (r.reasons.length > 0 || !exited) return r.outcome === "inconclusive";
	return r.outcome === ((r.execution as { code: number }).code === 0 ? "passed" : "failed");
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
	});

export function readAttempts(v: unknown): EndoDevelopAttemptsViewV1 | null {
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
	const view = v as unknown as EndoDevelopAttemptsViewV1;
	if (view.state !== "ready" && view.attempts.length > 0) return null;
	if ((view.state === "ready" || view.state === "no-task") && (view.taskId === null) !== (view.state === "no-task"))
		return null;
	if (new Set(view.attempts.map((a) => a.id)).size !== view.attempts.length) return null;
	for (const a of view.attempts as EndoDevelopAttemptViewV1[]) {
		const implied = a.outcome !== null ? a.outcome.kind : a.handoff !== null ? "handed-off" : "prepared";
		if (a.state !== implied) return null;
		if (a.outcome?.kind === "reported" && a.outcome.note.trim() === "") return null;
		if (!a.brief.startsWith(`# Work brief ${a.id}\n`) || !a.brief.endsWith(`End of brief ${a.id}.\n`)) return null;
		if (a.receipts.state === "unreadable" && a.receipts.list.length > 0) return null;
		if (new Set(a.receipts.list.map((r) => r.id)).size !== a.receipts.list.length) return null;
		if (!a.receipts.list.every(coherent)) return null;
	}
	return view;
}

export type AttemptsReply =
	| { kind: "attempts"; record: EndoDevelopAttemptsViewV1 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: "grant-required" | "invalid" | "unreachable" | "other" };
