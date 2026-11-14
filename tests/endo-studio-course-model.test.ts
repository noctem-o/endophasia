// The course model (studio-ui/src/model/course.ts): a presentation adapter over state the page already holds. What is pinned here is
// what it may NOT do: light a state the broker did not report, name a run the transcript does not hold, call a stage right because it
// happened, or let a model's report read as an observation.
import { describe, expect, it } from "vitest";
import type { Attempt, AttemptsView } from "../studio-ui/src/model/attempts-wire.ts";
import {
	attemptCourse,
	courseAttempt,
	courseAttention,
	liveCourse,
	recordedCourse,
	runsOf,
	runWords,
} from "../studio-ui/src/model/course.ts";
import { initialWorkbench, type WorkbenchState } from "../studio-ui/src/model/workbench.ts";
import type {
	TranscriptItem,
	WorkbenchCommand,
	WorkbenchIntervention,
	WorkbenchStatus,
} from "../studio-ui/src/model/workbench-wire.ts";

const offer = { offered: true, reason: null };
const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: "l1",
	harness: "pi",
	connection: "connected",
	run: "idle",
	session: "endo.session.pi.a",
	attachment: "pi.default",
	offers: { prompt: offer, attempt: offer, steer: offer, queue: offer, stop: offer },
	paired: true,
	command: null,
	interventions: [],
	transcript: { watermark: 0, firstSeq: 0 },
	...over,
});
const state = (over: Partial<WorkbenchState> = {}): WorkbenchState => ({
	...initialWorkbench(),
	availability: "available",
	status: status(),
	...over,
});
const run = (seq: number, s: "started" | "ended"): TranscriptItem => ({ seq, kind: "run", state: s });
const tool = (seq: number, st: "running" | "ok" | "error"): TranscriptItem => ({
	seq,
	kind: "tool",
	callId: `c${seq}`,
	name: "bash",
	status: st,
});
const message = (seq: number, stopReason: string | null = null): TranscriptItem => ({
	seq,
	kind: "message",
	role: "assistant",
	parts: [],
	truncated: false,
	partsDropped: 0,
	stopReason,
	from: null,
});
const intervention = (over: Partial<WorkbenchIntervention>): WorkbenchIntervention => ({
	proposalId: "p1",
	operation: "steer",
	state: "awaiting-approval",
	approved: false,
	reason: null,
	disposition: null,
	bytes: 4,
	digestPrefix: "abcd",
	expiresAtMs: 0,
	afterSeq: 0,
	runEnded: null,
	consumption: null,
	...over,
});
const command = (over: Partial<WorkbenchCommand>): WorkbenchCommand => ({
	proposalId: "p0",
	state: "awaiting-approval",
	approved: false,
	reason: null,
	disposition: null,
	bytes: 4,
	digestPrefix: "abcd",
	expiresAtMs: 0,
	attempt: null,
	...over,
});
const on = (lane: { nodes: { id: string; on: boolean }[] }) => lane.nodes.filter((n) => n.on).map((n) => n.id);

describe("the live course", () => {
	it("lights nothing before a status is read, and nothing as fact when the broker does not answer", () => {
		const unread = liveCourse({ ...initialWorkbench() });
		expect(unread.lanes.map(on)).toEqual([[], ["none"]]);
		expect(unread.lanes.map((l) => [l.status, l.basis])).toEqual([
			["unknown", "unavailable"],
			["unknown", "unavailable"],
		]);
		const lost = liveCourse(state({ status: status({ run: "active" }), unreachable: true }));
		expect(lost.stale).toBe(true);
		// The last report is said in words; no node is marked as where the session is.
		expect(lost.lanes.map(on)).toEqual([[], []]);
		expect(lost.lanes[0].state).toBe("last reported: run open");
		expect(lost.lanes[0].status).toBe("unknown");
		expect(lost.lanes[0].basis).toBe("unavailable");
		expect(lost.lanes[0].text).toMatch(/^Last reported: a run is open\./);
	});

	it("says what the broker reported: idle, an open run, a disconnection; never more", () => {
		expect(on(liveCourse(state()).lanes[0])).toEqual(["idle"]);
		const active = liveCourse(state({ status: status({ run: "active" }) }));
		expect(on(active.lanes[0])).toEqual(["open"]);
		expect(active.lanes[0].basis).toBe("reported");
		const gone = liveCourse(state({ status: status({ connection: "disconnected", run: "unknown" }) }));
		expect(on(gone.lanes[0])).toEqual(["disconnected"]);
		expect(gone.lanes[0].status).toBe("interrupted");
		// A connection whose run state was not reported lights neither idle nor open.
		expect(on(liveCourse(state({ status: status({ run: "unknown" }) })).lanes[0])).toEqual([]);
	});

	it("names a running tool or a message being written only inside a run the broker reports as open", () => {
		const items = [run(1, "started"), tool(2, "running")];
		const active = liveCourse(state({ status: status({ run: "active" }), items }));
		expect(on(active.lanes[0])).toEqual(["open"]);
		expect(active.lanes[0].state).toBe("run open · tool running");
		// The same items under an idle report: the stale "running" row lights nothing.
		expect(liveCourse(state({ items })).lanes[0].state).toBe("idle");
		const writing = liveCourse(
			state({
				status: status({ run: "active" }),
				items: [run(1, "started")],
				open: { id: 1, parts: [], afterSeq: 1 },
			}),
		);
		expect(on(writing.lanes[0])).toEqual(["open"]);
		expect(writing.lanes[0].state).toBe("run open · writing");
	});

	it("puts a request on its own lane: waiting for the terminal is not sent, and a run can be open beside it", () => {
		const waiting = liveCourse(
			state({ status: status({ run: "active" }), interventions: [intervention({ operation: "steer" })] }),
		);
		expect(on(waiting.lanes[0])).toEqual(["open"]);
		expect(on(waiting.lanes[1])).toEqual(["awaiting"]);
		expect(waiting.lanes[1].status).toBe("waiting");
		expect(waiting.lanes[1].state).toBe("steer awaits terminal");
		expect(waiting.lanes[1].text).toBe(
			"A steer waits for your approval in the attached terminal. Nothing has been sent.",
		);
		expect(courseAttention(waiting, null)).toBe("waiting");
		const sent = liveCourse(state({ interventions: [intervention({ operation: "stop", state: "sent" })] }));
		expect(on(sent.lanes[1])).toEqual(["sent"]);
		const prompt = liveCourse(state({ command: command({ state: "dispatching", approved: true }) }));
		expect(on(prompt.lanes[1])).toEqual(["sending"]);
		expect(prompt.lanes[1].text).toMatch(/^A prompt was approved in the terminal/);
		// A settled request is not on the lane.
		expect(on(liveCourse(state({ command: command({ state: "accepted" }) })).lanes[1])).toEqual(["none"]);
	});

	it("shows the request that needs the operator first", () => {
		const both = liveCourse(
			state({
				interventions: [
					intervention({ proposalId: "a", operation: "steer", state: "sent" }),
					intervention({ proposalId: "b", operation: "stop", state: "awaiting-approval" }),
				],
			}),
		);
		expect(both.lanes[1].state).toBe("stop awaits terminal");
		expect(courseAttention(both, null)).toBe("waiting");
	});

	it("counts runs from the markers it holds, and what came before the first marker as a run whose start is not held", () => {
		const items = [tool(1, "ok"), run(2, "ended"), run(3, "started"), tool(4, "error"), message(5, "error")];
		const runs = runsOf(items, [
			intervention({ afterSeq: 4, state: "accepted" }),
			intervention({ proposalId: "early", afterSeq: 2, operation: "queue" }),
		]);
		expect(runs.map((r) => [r.startSeq, r.state, r.tools, r.errors])).toEqual([
			[null, "ended", 1, 0],
			[3, "open", 1, 1],
		]);
		// An intervention asked outside any held run (before the start marker) is attributed to none.
		expect(runs.map((r) => r.interventions.length)).toEqual([0, 1]);
		expect(runs[1]!.reportedError).toBe(true);
		expect(runWords(runs[1]!)).toBe(
			"open, no end seen · 1 tool call · 1 reported as error · a message reported a run error · steer accepted",
		);
		const course = liveCourse(state({ items, evicted: 2, trimmed: 1 }));
		expect(course.totals).toEqual({ runs: 2, tools: 2, errors: 1, dropped: 3 });
		// The operator's message between runs belongs to no run; a tool call after an end with no new start is not invented into one.
		const user: TranscriptItem = { ...(message(7) as TranscriptItem & { kind: "message" }), role: "user" };
		expect(runsOf([run(1, "started"), run(2, "ended"), user, tool(8, "ok")], []).map((r) => r.tools)).toEqual([0]);
		// A prompt held before its run's start marker opens no phantom run.
		expect(runsOf([{ ...user, seq: 1 }, run(2, "started")], []).length).toBe(1);
	});
});

const attempt = (over: Partial<Attempt> = {}): Attempt =>
	({
		id: `endo.attempt.${"a".repeat(32)}`,
		state: "prepared",
		preparedAtMs: 1,
		taskRevision: 1,
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
	}) as Attempt;
const execution = (over: Record<string, unknown>) =>
	({
		authorizedAtMs: 2,
		session: "endo.session.pi.a",
		attachment: "pi.default",
		taskRevision: 1,
		send: "runtime-accepted",
		refusal: null,
		disposition: "started",
		run: "completed",
		evidence: "complete",
		brief: "matches",
		...over,
	}) as unknown as Attempt["execution"];
const receipt = (outcome: string) => ({ outcome }) as unknown as Attempt["receipts"]["list"][number];
const by = (a: Attempt, c: WorkbenchCommand | null = null) =>
	Object.fromEntries(attemptCourse(a, c).steps.map((s) => [s.id, [s.status, s.basis]]));

describe("an attempt's course", () => {
	it("is six stages from six records; a prepared attempt stands at Authorise with nothing after it claimed", () => {
		const course = attemptCourse(attempt(), null);
		expect(course.steps.map((s) => s.id)).toEqual(["brief", "authorise", "send", "run", "check", "judge"]);
		expect(course.at).toBe("authorise");
		expect(by(attempt())).toEqual({
			brief: ["done", "declared"],
			authorise: ["pending", "unavailable"],
			send: ["pending", "unavailable"],
			run: ["pending", "unavailable"],
			check: ["pending", "observed"],
			judge: ["pending", "unavailable"],
		});
	});

	it("takes Assent from the broker's request for THIS attempt only, and never says 'not requested' of one the broker sent", () => {
		const a = attempt();
		const of = (over: Partial<WorkbenchCommand>, bound = false) =>
			command({ ...over, attempt: { attemptId: a.id, taskId: "t", bound, refusal: null } });
		expect(by(a, of({})).authorise).toEqual(["waiting", "observed"]);
		expect(courseAttention(null, attemptCourse(a, of({})))).toBe("waiting");
		expect(by(a, of({ state: "dispatching" })).authorise).toEqual(["current", "observed"]);
		// Sent or bound by the broker's account, the attempt's records not read yet: awaited, not denied.
		for (const c of [of({ state: "accepted" }), of({ state: "unknown" }), of({ state: "refused" }, true)]) {
			const stage = attemptCourse(a, c).steps[1]!;
			expect([stage.status, stage.basis]).toEqual(["unknown", "observed"]);
			expect(stage.text).not.toMatch(/Not requested/);
		}
		const declined = attemptCourse(a, of({ state: "refused", reason: "authorization-denied" })).steps[1]!;
		expect([declined.status, declined.text]).toEqual([
			"pending",
			"Requested, and not sent. No authorisation is recorded.",
		]);
		const other = command({ attempt: { attemptId: "endo.attempt.other", taskId: "t", bound: false, refusal: null } });
		expect(by(a, other).authorise).toEqual(["pending", "unavailable"]);
		expect(by(a, command({})).authorise).toEqual(["pending", "unavailable"]);
	});

	it("never calls a run Pi reported as completed anything but reported, and never lets it stand in for a check", () => {
		const a = attempt({ execution: execution({}) });
		const stages = by(a);
		expect(stages.run).toEqual(["done", "reported"]);
		expect(stages.check).toEqual(["pending", "observed"]);
		expect(stages.judge).toEqual(["pending", "unavailable"]);
		const course = attemptCourse(a, null);
		expect(course.at).toBe("check");
		expect(course.steps.find((s) => s.id === "run")!.text).toBe("Pi reported the run completed. Not verified.");
		for (const s of course.steps)
			expect(s.text).not.toMatch(/\bverified\b(?<!Not verified)|succe|correct|\bworks\b/i);
	});

	it("gives every send and run state the status its record supports: unknown is not 'not taken', and not yet is not skipped", () => {
		const run = (over: Record<string, unknown>) => by(attempt({ execution: execution(over) })).run;
		expect(run({ run: "failed" })).toEqual(["failed", "reported"]);
		expect(run({ run: "aborted" })).toEqual(["interrupted", "reported"]);
		expect(run({ run: "interrupted" })).toEqual(["interrupted", "observed"]);
		expect(run({ run: "process-ended" })).toEqual(["interrupted", "observed"]);
		expect(run({ run: "open" })).toEqual(["current", "reported"]);
		expect(run({ run: "unclassified" })).toEqual(["unknown", "reported"]);
		expect(run({ run: "not-observed" })).toEqual(["pending", "observed"]);
		// A send whose reply was not seen may still have run.
		expect(run({ send: "sent-no-reply", run: "completed" })).toEqual(["done", "reported"]);
		const none = { run: "not-observed" };
		expect(by(attempt({ execution: execution({ send: "refused-by-runtime", ...none }) }))).toMatchObject({
			send: ["failed", "reported"],
			run: ["skipped", "observed"],
		});
		expect(by(attempt({ execution: execution({ send: "not-sent", ...none }) }))).toMatchObject({
			send: ["failed", "observed"],
			run: ["skipped", "observed"],
		});
		expect(by(attempt({ execution: execution({ send: "no-send-recorded", ...none }) }))).toMatchObject({
			send: ["pending", "observed"],
			run: ["pending", "unavailable"],
		});
		for (const send of ["evidence-unavailable", "not-attributable"])
			expect(by(attempt({ execution: execution({ send, ...none }) }))).toMatchObject({
				send: ["unknown", "unavailable"],
				run: ["unknown", "unavailable"],
			});
		expect(courseAttention(null, attemptCourse(attempt({ execution: execution({ run: "failed" }) }), null))).toBe(
			"fault",
		);
	});

	it("says where the attempt stands: past a send with no reply once a run is known, and at Judge once an outcome is recorded", () => {
		const noReply = attempt({
			execution: execution({ send: "sent-no-reply", run: "completed" }),
			receipts: { state: "ready", problems: 0, list: [receipt("passed")] },
		});
		expect(attemptCourse(noReply, null).at).toBe("judge");
		expect(
			attemptCourse(attempt({ execution: execution({ send: "sent-no-reply", run: "not-observed" }) }), null).at,
		).toBe("send");
		const handed = attempt({ state: "handed-off" } as Partial<Attempt>);
		expect(by(handed)).toMatchObject({
			authorise: ["skipped", "declared"],
			send: ["skipped", "unavailable"],
			run: ["skipped", "unavailable"],
		});
		// A closed attempt with a failed run no longer asks for attention, and stands at Judge.
		const closed = attemptCourse(
			attempt({
				state: "abandoned",
				execution: execution({ run: "failed" }),
				outcome: { recordedAtMs: 3, kind: "abandoned", note: "n" },
			} as Partial<Attempt>),
			null,
		);
		expect([closed.at, closed.closed, courseAttention(null, closed)]).toEqual(["judge", true, null]);
	});

	it("qualifies what a partly read log or a changed brief can support", () => {
		const partial = attemptCourse(attempt({ execution: execution({ run: "open", evidence: "partial" }) }), null);
		expect(partial.steps[3]!.text).toBe(
			"A run started. No end is recorded. The session's log was read only in part.",
		);
		const differs = attemptCourse(attempt({ execution: execution({ brief: "differs" }) }), null);
		expect(differs.steps[0]!.text).toContain("is not the text that was approved");
	});

	it("reads Check from the newest check Endophasia ran, or from the plan's ledger when there is a plan; never from a count", () => {
		const a = (list: string[], over: Partial<Attempt["receipts"]> = {}) =>
			attempt({
				execution: execution({}),
				receipts: { state: "ready", problems: 0, ...over, list: list.map(receipt) },
			});
		expect(by(a(["passed", "passed"])).check).toEqual(["done", "observed"]);
		// Oldest first: a failure a later run superseded is history, and a pass a later run failed is not a pass.
		expect(by(a(["failed", "passed"])).check).toEqual(["done", "observed"]);
		expect(by(a(["passed", "failed"])).check).toEqual(["failed", "observed"]);
		expect(by(a(["passed", "inconclusive"])).check).toEqual(["unknown", "observed"]);
		expect(by(a(["passed"], { problems: 1 })).check).toEqual(["unknown", "observed"]);
		expect(by(a([], { state: "unreadable" })).check).toEqual(["unknown", "unavailable"]);
		// A passed check does not judge the task: that stage is the operator's.
		expect(attemptCourse(a(["passed"]), null).at).toBe("judge");
		// With a plan, receipts that passed elsewhere do not settle the stage: the plan's checks at HEAD do.
		const planned = (states: string[]) =>
			attempt({
				execution: execution({}),
				receipts: { state: "ready", problems: 0, list: [receipt("passed")] },
				verification: { checks: states.map((state) => ({ state })), criteria: [], unplanned: 0 },
			} as unknown as Partial<Attempt>);
		expect(by(planned(["stale", "passed"])).check).toEqual(["pending", "observed"]);
		expect(by(planned(["passed", "passed"])).check).toEqual(["done", "observed"]);
		expect(by(planned(["passed", "failed"])).check).toEqual(["failed", "observed"]);
		expect(by(planned(["passed", "mixed"])).check).toEqual(["unknown", "observed"]);
	});

	it("takes Judge only from the operator's recorded outcome", () => {
		const reported = attempt({
			state: "reported",
			outcome: { recordedAtMs: 3, kind: "reported", note: "n" },
		} as Partial<Attempt>);
		expect(by(reported).judge).toEqual(["done", "declared"]);
		expect(attemptCourse(reported, null).steps.at(-1)!.text).toBe("You recorded a result: reported, not verified.");
		const abandoned = attempt({
			state: "abandoned",
			outcome: { recordedAtMs: 3, kind: "abandoned", note: "n" },
		} as Partial<Attempt>);
		expect(by(abandoned).judge).toEqual(["skipped", "declared"]);
	});

	it("charts the attempt the broker's open request names, else the newest, and none when the attempts are not read", () => {
		const view = (over: Partial<AttemptsView>): AttemptsView =>
			({ state: "ready", taskId: "t", attempts: [], problems: 0, head: null, ...over }) as AttemptsView;
		expect(courseAttempt(null, null)).toBeNull();
		expect(courseAttempt(view({ state: "unreadable" }), null)).toBeNull();
		expect(courseAttempt(view({}), null)).toBeNull();
		const older = attempt({ preparedAtMs: 1 });
		const newer = attempt({ preparedAtMs: 9, id: `endo.attempt.${"b".repeat(32)}` });
		const both = view({ attempts: [older, newer] });
		expect(courseAttempt(both, null)!.id).toBe(newer.id);
		const asking = command({ attempt: { attemptId: older.id, taskId: "t", bound: false, refusal: null } });
		expect(courseAttempt(both, asking)!.id).toBe(older.id);
		// A settled request no longer leads: the newest attempt is charted again.
		expect(courseAttempt(both, { ...asking, state: "refused" })!.id).toBe(newer.id);
	});
});

describe("a recording's course", () => {
	const detail = (recorded: unknown, entries: unknown[] = []) =>
		({
			session: { recorded },
			activity: {
				total: 9,
				tools: { calls: 2, errors: 1 },
				flagged: { interruption: 1, discontinuity: 0, anomaly: 2, unrecognized: 0 },
				entries,
			},
		}) as unknown as Parameters<typeof recordedCourse>[0];
	it("is drawn from the recorded lifecycle and the loaded events, and not at all for a recording that is not inspectable", () => {
		expect(recordedCourse(detail(null))).toBeNull();
		const course = recordedCourse(
			detail({ state: "detached", runs: 1, turns: 2, lastRunOutcome: "completed" }, [
				{ storageSequence: 5, category: "tool", flags: [], fields: [] },
				{ storageSequence: 6, category: "queue", flags: ["anomaly"], fields: [] },
				{ storageSequence: 7, category: "lifecycle", flags: [], fields: [] },
			]),
		)!;
		expect([course.state, course.runs, course.turns, course.lastRunOutcome]).toEqual(["detached", 1, 2, "completed"]);
		// Flags are counted as flags: one event may carry several.
		expect([course.flagged, course.loaded, course.total]).toEqual([3, 3, 9]);
		expect(course.marks.map((m) => [m.sequence, m.row, m.flagged])).toEqual([
			[5, "tool", false],
			[6, "other", true],
			[7, "run", false],
		]);
	});
});
