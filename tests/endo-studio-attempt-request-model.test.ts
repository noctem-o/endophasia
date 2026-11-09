// The page's words for a page-requested attempt and the selected task's next step (studio-ui/src/model/attempt-request.ts): pure, read only
// from the broker's request (which names its attempt) and the attempts' records. No sentence says the work succeeded or the task is done;
// a lost reply is uncertainty, not failure; a request that bound the attempt is never offered again.
import { describe, expect, it } from "vitest";
import {
	failureWords,
	nextStep,
	requestable,
	requestFor,
	requestWords,
} from "../studio-ui/src/model/attempt-request.ts";
import type { Attempt, AttemptsView, Execution, Receipt } from "../studio-ui/src/model/attempts-wire.ts";
import type { WorkbenchCommand } from "../studio-ui/src/model/workbench-wire.ts";

const A = `endo.attempt.${"a".repeat(32)}`;
const B = `endo.attempt.${"b".repeat(32)}`;
const command = (over: Partial<WorkbenchCommand> = {}): WorkbenchCommand => ({
	proposalId: `endo.evidence.workbench-prompt-${"0".repeat(32)}`,
	state: "awaiting-approval",
	approved: false,
	reason: null,
	disposition: null,
	bytes: 100,
	digestPrefix: "0123456789abcdef",
	expiresAtMs: 1,
	attempt: { attemptId: A, taskId: "endo.task.x", bound: false, refusal: null },
	...over,
});
const execution = (over: Partial<Execution> = {}): Execution => ({
	authorizedAtMs: 1,
	session: "s",
	attachment: "pi.default",
	taskRevision: 0,
	send: "runtime-accepted",
	refusal: null,
	disposition: "started",
	run: "completed",
	evidence: "complete",
	brief: "matches",
	...over,
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({
	id: A,
	state: "prepared",
	preparedAtMs: 10,
	taskRevision: 0,
	objective: "o",
	handoff: null,
	outcome: null,
	taskWordsChanged: [],
	brief: "b",
	receipts: { state: "ready", list: [], problems: 0 },
	execution: null,
	verification: null,
	provenance: null,
	...over,
});
const view = (...attempts: Attempt[]): AttemptsView => ({
	schemaVersion: "endo.develop-attempts-view.v4",
	state: "ready",
	taskId: "endo.task.x",
	attempts,
	problems: 0,
	head: null,
});
const receipt = { id: "r" } as unknown as Receipt;
const NEVER = /(?<!not a )success\b|succeeded|task is done|completed the task|(?<!not )verified|accepted the work/i;

describe("the words for a page-requested attempt", () => {
	it("say no more than the broker reported at each step, and never call a reply a result", () => {
		const all = [
			command(),
			command({ state: "dispatching", approved: true }),
			command({
				state: "dispatching",
				approved: true,
				attempt: { attemptId: A, taskId: "t", bound: true, refusal: null },
			}),
			command({ state: "accepted", approved: true, disposition: "started" }),
			command({ state: "unknown", approved: true }),
			command({ state: "refused", reason: "authorization-denied" }),
		].map(requestWords);
		expect(all[0]!.head).toContain("Waiting for approval in the attached terminal");
		expect(all[0]!.detail).toContain("This page cannot approve it");
		expect(all[1]!.head).toContain("Checking the attempt again");
		expect(all[2]!.head).toContain("Authorisation recorded");
		expect(all[3]!.head).toBe("Recorded as sent, once. Pi replied: started");
		expect(all[3]!.detail).toContain("not a result");
		// A lost reply: uncertainty, never failure or success, never a retry.
		expect(all[4]!.detail).toContain("not a failure, and not a success");
		expect(all[4]!.detail).toContain("will not be sent again");
		expect(all[5]!.head).toBe("Not sent: it was declined in the terminal");
		expect(all[5]!.detail).toContain("can be requested again");
		for (const w of all) expect(`${w.head} ${w.detail}`).not.toMatch(NEVER);
	});

	it("name the attempt's own refusal when binding was refused, and say it is spent when it was bound", () => {
		const changed = requestWords(
			command({
				state: "refused",
				approved: true,
				reason: "attempt-changed",
				attempt: { attemptId: A, taskId: "t", bound: false, refusal: "task-words-changed" },
			}),
		);
		expect(changed.head).toContain("the task's words changed");
		expect(changed.detail).toContain("cannot be sent as it stands");
		const spent = requestWords(
			command({
				state: "refused",
				approved: true,
				reason: "session-ended",
				attempt: { attemptId: A, taskId: "t", bound: true, refusal: null },
			}),
		);
		expect(spent.detail).toContain("will not be sent again");
		expect(requestWords(command({ state: "refused", reason: "runtime-refused" })).head).toBe(
			"Recorded as sent, once. Pi refused it",
		);
	});

	it("relate a request to an attempt only by the id the broker reported", () => {
		expect(requestFor(command(), A)).not.toBeNull();
		expect(requestFor(command(), B)).toBeNull();
		expect(requestFor(command({ attempt: null }), A)).toBeNull();
		expect(requestFor(null, A)).toBeNull();
	});

	it("offer to request only a prepared attempt that was never authorised and whose task's words are unchanged", () => {
		expect(requestable(attempt()).ok).toBe(true);
		expect(requestable(attempt({ execution: execution({ send: "not-sent" }) })).ok).toBe(false);
		expect(requestable(attempt({ state: "handed-off" })).ok).toBe(false);
		expect(requestable(attempt({ state: "reported" })).ok).toBe(false);
		expect(requestable(attempt({ taskWordsChanged: ["acceptance"] })).ok).toBe(false);
	});
});

describe("the selected task's next step", () => {
	it("puts a request in flight first, then reads the newest attempt's records", () => {
		expect(nextStep(view(attempt()), command())?.kind).toBe("awaiting-approval");
		expect(nextStep(view(attempt()), command({ state: "dispatching", approved: true }))?.kind).toBe("sending");
		expect(nextStep(view(attempt()), null)?.kind).toBe("ready");
		// Sent, and the attempts not yet read again: the records are awaited, never assumed.
		expect(nextStep(null, command({ state: "accepted", approved: true }))?.kind).toBe("awaiting-evidence");
		expect(nextStep(view(attempt({ execution: execution({ run: "open" }) })), null)?.kind).toBe("run-open");
		expect(nextStep(view(attempt({ execution: execution({ run: "not-observed" }) })), null)?.kind).toBe(
			"awaiting-evidence",
		);
		const ended = nextStep(view(attempt({ execution: execution() })), null);
		expect(ended?.kind).toBe("no-check");
		expect(ended?.text).toContain("Pi reported the run completed. Not verified");
		expect(ended?.text).toContain("The task's status is yours");
		const checked = nextStep(
			view(attempt({ execution: execution(), receipts: { state: "ready", list: [receipt], problems: 0 } })),
			null,
		);
		expect(checked?.kind).toBe("review");
		expect(checked?.text).toContain("your decision");
		// An interrupted run is not described as one Pi reported ending.
		expect(nextStep(view(attempt({ execution: execution({ run: "interrupted" }) })), null)?.text).toContain(
			"Interrupted",
		);
	});

	it("never suggests sending an authorised attempt again", () => {
		for (const send of [
			"not-sent",
			"no-send-recorded",
			"not-attributable",
			"evidence-unavailable",
			"refused-by-runtime",
		] as const) {
			const step = nextStep(
				view(attempt({ execution: execution({ send, run: "not-observed", disposition: null }) })),
				null,
			);
			expect(step?.kind, send).toBe("unclear");
			expect(step?.text, send).toContain("prepare a new attempt");
			expect(step?.text, send).not.toMatch(/request it|resend|send it again/i);
		}
	});

	it("reads the newest attempt, and says nothing when there is nothing to say", () => {
		const older = attempt({ id: B, preparedAtMs: 1, execution: execution() });
		expect(nextStep(view(older, attempt({ preparedAtMs: 5 })), null)).toMatchObject({ kind: "ready", attemptId: A });
		expect(nextStep(view(), null)).toBeNull();
		expect(nextStep(null, null)).toBeNull();
		expect(nextStep(view(attempt({ state: "abandoned" })), null)).toBeNull();
		// A typed prompt in flight is not an attempt's.
		expect(nextStep(view(), command({ attempt: null }))).toBeNull();
		for (const a of [attempt(), attempt({ execution: execution() })])
			expect(nextStep(view(a), null)?.text ?? "").not.toMatch(NEVER);
	});
});

describe("review regressions", () => {
	it("say an attempt refused at binding for a lasting reason cannot be sent as it stands, not that it can be asked again", () => {
		for (const refusal of [
			"already-authorized",
			"handed-off",
			"outcome-recorded",
			"task-done",
			"task-words-changed",
		] as const) {
			const w = requestWords(
				command({
					state: "refused",
					approved: true,
					reason: refusal === "already-authorized" ? "duplicate" : "attempt-changed",
					attempt: { attemptId: A, taskId: "t", bound: false, refusal },
				}),
			);
			expect(w.detail, refusal).toContain("cannot be sent as it stands");
			expect(w.detail, refusal).not.toContain("can be requested again");
		}
		for (const refusal of ["tasks-unreadable", "storage-failed", "unreadable"] as const)
			expect(
				requestWords(
					command({
						state: "refused",
						approved: true,
						reason: "attempt-not-recorded",
						attempt: { attemptId: A, taskId: "t", bound: false, refusal },
					}),
				).detail,
				refusal,
			).toContain("can be requested again");
	});

	it("never offers an attempt as ready while the broker says it was bound and the attempts were read before that", () => {
		for (const c of [
			command({ state: "accepted", approved: true, disposition: "started" }),
			command({ state: "unknown", approved: true }),
			command({
				state: "refused",
				approved: true,
				reason: "session-ended",
				attempt: { attemptId: A, taskId: "t", bound: true, refusal: null },
			}),
		]) {
			const step = nextStep(view(attempt()), c);
			expect(step?.kind, c.state).toBe("awaiting-evidence");
			expect(step?.text, c.state).not.toMatch(/not sent|request it/i);
		}
		// A request for another attempt changes nothing for this one.
		expect(
			nextStep(
				view(attempt()),
				command({ state: "accepted", attempt: { attemptId: B, taskId: "t", bound: true, refusal: null } }),
			)?.kind,
		).toBe("ready");
	});

	it("never says no check is recorded when the receipts could not all be read", () => {
		for (const receipts of [
			{ state: "unreadable" as const, list: [], problems: 0 },
			{ state: "ready" as const, list: [], problems: 2 },
		]) {
			const step = nextStep(view(attempt({ execution: execution(), receipts })), null);
			expect(step?.kind, receipts.state).toBe("unclear");
			expect(step?.text, receipts.state).toContain("whether one is recorded is unknown");
			expect(step?.text, receipts.state).not.toMatch(/No check is recorded|run one yourself/);
			expect(step?.text ?? "", receipts.state).not.toMatch(NEVER);
		}
	});

	it("say nothing was requested only when the broker refused; a lost or malformed answer may have been requested", () => {
		const refused = failureWords({
			kind: "failure",
			status: 409,
			code: "attempt-task-done",
			message: "M.",
			retrySeconds: null,
		});
		expect(refused).toEqual({ text: "M. Nothing was recorded or sent.", uncertain: false });
		const notRecording = failureWords({
			kind: "failure",
			status: 503,
			code: "not-recording",
			message: "The session is not recording, so nothing was requested.",
			retrySeconds: null,
		});
		expect(notRecording.text).toBe("The session is not recording, so nothing was requested.");
		for (const f of [
			{ kind: "failure" as const, status: 0, code: "", message: "Unreachable.", retrySeconds: null },
			{ kind: "failure" as const, status: 202, code: "", message: "Malformed.", retrySeconds: null },
			{ kind: "failure" as const, status: 500, code: "", message: "Failed.", retrySeconds: null },
		]) {
			const w = failureWords(f);
			expect(w.uncertain, String(f.status)).toBe(true);
			expect(w.text, String(f.status)).toContain("may still have been requested");
			expect(w.text, String(f.status)).not.toContain("Nothing was recorded");
		}
	});
});
