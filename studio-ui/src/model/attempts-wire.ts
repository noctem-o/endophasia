// Browser wire gate for the work-attempts route (`GET workspace/attempts`, protocol/develop-attempts.ts, served read-only by
// adapters/pi/workbench-tasks.ts). The broker is authoritative for what an attempt is; this checks that a body has exactly the shape the
// section reads, that each attempt's state is the one its records imply (an attempt cannot claim "reported" without an outcome, or arrive
// with an outcome and claim "prepared"), and refuses the body whole when it does not. The words are the operator's own and are only shown
// as text. There is no request body: the page names no project, task or attempt, and nothing here can make or record one.
import type {
	EndoDevelopAttemptStateV0,
	EndoDevelopAttemptsViewV0,
	EndoDevelopAttemptViewV0,
} from "../../../protocol/develop-attempts.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type {
	EndoDevelopAttemptStateV0 as AttemptState,
	EndoDevelopAttemptsViewV0 as AttemptsView,
	EndoDevelopAttemptViewV0 as Attempt,
} from "../../../protocol/develop-attempts.ts";

export const ATTEMPTS_SCHEMA = "endo.develop-attempts-view.v0";

/** These mirror the protocol's closed lists and labels; a contract test holds them equal. */
export const ATTEMPT_STATES: readonly EndoDevelopAttemptStateV0[] = ["prepared", "handed-off", "reported", "abandoned"];
export const ATTEMPT_LABELS: Readonly<Record<EndoDevelopAttemptStateV0, string>> = {
	prepared: "Prepared",
	"handed-off": "Handoff recorded",
	reported: "Result reported, not verified",
	abandoned: "Abandoned",
};

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
	});

export function readAttempts(v: unknown): EndoDevelopAttemptsViewV0 | null {
	if (
		!shape(v, {
			schemaVersion: one(ATTEMPTS_SCHEMA),
			state: one("ready", "no-task", "unreadable"),
			taskId: eitherNull(taskId),
			attempts: (x) => list(attempt)(x) && (x as unknown[]).length <= 50,
			problems: count,
		})
	)
		return null;
	const view = v as unknown as EndoDevelopAttemptsViewV0;
	if (view.state !== "ready" && view.attempts.length > 0) return null;
	if ((view.state === "ready" || view.state === "no-task") && (view.taskId === null) !== (view.state === "no-task"))
		return null;
	if (new Set(view.attempts.map((a) => a.id)).size !== view.attempts.length) return null;
	for (const a of view.attempts as EndoDevelopAttemptViewV0[]) {
		const implied = a.outcome !== null ? a.outcome.kind : a.handoff !== null ? "handed-off" : "prepared";
		if (a.state !== implied) return null;
		if (a.outcome?.kind === "reported" && a.outcome.note.trim() === "") return null;
		if (!a.brief.startsWith(`# Work brief ${a.id}\n`) || !a.brief.endsWith(`End of brief ${a.id}.\n`)) return null;
	}
	return view;
}

export type AttemptsReply =
	| { kind: "attempts"; record: EndoDevelopAttemptsViewV0 }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: "grant-required" | "invalid" | "unreachable" | "other" };
