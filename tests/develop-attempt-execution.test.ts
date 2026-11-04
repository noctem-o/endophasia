// Attempt execution (docs/designs/develop-attempt-execution.md), without Pi: the authorisation record, the dispatcher's checks and its
// write-once binding (including concurrent writers in separate processes), and the projection from a session log, against complete,
// partial, interrupted, substituted and tampered logs. The broker and a real (fake) Pi process are in endo-workbench-attempts.test.ts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	ENDO_ATTEMPT_RUN_LABELS_V0,
	ENDO_ATTEMPT_RUN_STATES_V0,
	ENDO_ATTEMPT_SEND_LABELS_V0,
	ENDO_ATTEMPT_SEND_STATES_V0,
	type EndoDevelopAttemptAuthorizationV0,
	validateEndoDevelopAttemptAuthorizationV0,
} from "../protocol/develop-attempt-execution.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { ENDO_WORKBENCH_REFUSAL_REASONS_V0 } from "../protocol/workbench.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import {
	type EndoSessionLogReadV0,
	endoAttemptExecutionFindingV0,
	endoAttemptExecutionViewV0,
	endoBriefSha256V0,
} from "../runtime/contracts/develop-attempt-execution.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import {
	EXECUTION_REFUSALS,
	EXECUTION_RUN_LABELS,
	EXECUTION_SEND_LABELS,
	readAttempts,
} from "../studio-ui/src/model/attempts-wire.ts";

const WRITER = fileURLToPath(new URL("./fixtures/develop-attempt-authorizer.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-attempt-exec-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION = "endo.session.pi.0b6f6c0e-1111-4c4c-9e9e-123456789abc";

/** A store with one project registered at `launch`, one selected task and one prepared attempt. */
function seeded() {
	const root = fresh("root");
	const launch = fresh("project");
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name: "demo", path: launch, observedGitRoot: null }));
	const t = ok(
		tasks.createTask(
			p.id,
			{ title: "Fix parser", description: "Trailing commas fail.", acceptance: "npm test passes" },
			{ select: true },
		),
	);
	const q = ok(tasks.registerProject({ name: "other", path: fresh("other"), observedGitRoot: null }));
	const u = ok(tasks.createTask(q.id, { title: "Other work" }, { select: true }));
	const attempts = new DevelopAttemptsStoreV0(root);
	const service = new DevelopAttemptsServiceV0(tasks, attempts);
	const a = ok(service.prepare(p.id, t.id, { objective: "Accept trailing commas", constraints: "No lexer changes" }));
	const dispatch = new DevelopAttemptDispatchV0(tasks, attempts, { projectId: p.id, launchDirectory: launch });
	return {
		root,
		launch,
		tasks,
		attempts,
		service,
		dispatch,
		projectId: p.id,
		taskId: t.id,
		attempt: a,
		other: { p: q, u },
	};
}

const MESSAGE = {
	digest: { algorithm: "hmac-sha256" as const, keyId: "endo.key.test", value: "a".repeat(64) },
	bytes: 100,
};

/** The proposal the broker would have recorded for `brief` at `proposedAt`: its id and digest are recomputed exactly as the broker does. */
function proposalFor(
	session = SESSION,
	attachment = "pi.default",
	message = MESSAGE,
	proposedAt = "2026-11-04T10:00:00.000Z",
) {
	const content = { session, attachment, message, origin: "operator-workbench", proposedAt };
	const proposalDigest = sha256(canonicalEndoJsonV0(content as never));
	return { content, proposalDigest, proposalId: `endo.evidence.workbench-prompt-${proposalDigest.slice(0, 32)}` };
}

let seq = 0;
const ev = (
	id: string,
	kind: string,
	payload: Record<string, unknown>,
	derivedFrom: string[] = [],
	session = SESSION,
): EndoEventV0 =>
	({
		schemaVersion: "endo.event.v0",
		id,
		kind,
		source: "runtime-fact",
		sequence: ++seq,
		at: "2026-11-04T10:00:00Z",
		coordinates: { sessionId: session },
		producer: "test",
		derivedFrom,
		payload,
	}) as EndoEventV0;

/** A whole, successful chain and run, as the attachment records it; each test cuts or alters it. */
function chain(opts: { instance?: string; runEnd?: string } = {}) {
	const p = proposalFor();
	const instance = opts.instance ?? "inst-1";
	const events: EndoEventV0[] = [
		ev("endo.event.t.start", "lifecycle.session-started", { instance }),
		ev("endo.event.t.prop", "workbench.prompt-proposed", {
			schemaVersion: "endo.workbench.v0",
			proposalId: p.proposalId,
			proposalDigest: p.proposalDigest,
			...p.content,
		}),
		ev(
			"endo.event.t.auth",
			"workbench.prompt-authorized",
			{
				schemaVersion: "endo.workbench.v0",
				proposalId: p.proposalId,
				proposalDigest: p.proposalDigest,
				decision: "allow",
				confirmation: "terminal",
				decidedAt: "2026-11-04T10:00:01.000Z",
			},
			["endo.event.t.prop"],
		),
		ev("endo.event.t.disp", "workbench.prompt-dispatched", { proposalId: p.proposalId }, ["endo.event.t.auth"]),
		ev("endo.event.t.ctl", "control.requested", { capability: "session.prompt" }),
		ev("endo.event.t.run", "lifecycle.run-started", { instance }),
		ev("endo.event.t.acc", "workbench.prompt-accepted", { proposalId: p.proposalId, disposition: "started" }, [
			"endo.event.t.disp",
		]),
		ev(`endo.event.t.end`, opts.runEnd ?? "lifecycle.run-completed", { turns: 1 }),
	];
	return { p, events };
}

function recordFor(
	p: ReturnType<typeof proposalFor>,
	brief: string,
	attemptId: string,
): EndoDevelopAttemptAuthorizationV0 {
	return validateEndoDevelopAttemptAuthorizationV0({
		schemaVersion: "endo.develop-attempt-authorization.v0",
		attemptId,
		recordedAtMs: 1_800_000_000_000,
		briefSha256: endoBriefSha256V0(brief),
		taskRevision: 0,
		harness: "pi",
		session: p.content.session,
		attachment: p.content.attachment,
		launchId: "0123456789abcdef",
		proposalId: p.proposalId,
		proposalDigest: p.proposalDigest,
		authorizationEventId: "endo.event.t.auth",
		message: p.content.message,
		approvedBy: "operator",
		via: "workbench-terminal",
	});
}

const complete = (events: EndoEventV0[]): EndoSessionLogReadV0 => ({ state: "complete", events });
const ATTEMPT = "endo.attempt.0123456789abcdef0123456789abcdef";

describe("the authorisation record", () => {
	it("is closed: unknown members, versions, sessions, approvers and malformed digests are refused", () => {
		const { p } = chain();
		const good = recordFor(p, "brief", ATTEMPT);
		expect(validateEndoDevelopAttemptAuthorizationV0(JSON.parse(JSON.stringify(good)))).toEqual(good);
		const bad: [string, unknown][] = [
			["extra", { ...good, extra: 1 }],
			["version", { ...good, schemaVersion: "endo.develop-attempt-authorization.v1" }],
			["session", { ...good, session: "endo.session.omp.x" }],
			["approver", { ...good, approvedBy: "agent" }],
			["via", { ...good, via: "page" }],
			["proposal", { ...good, proposalId: "endo.evidence.workbench-prompt-zz" }],
			["digest", { ...good, message: { ...good.message, digest: { ...good.message.digest, value: "x" } } }],
			["launch", { ...good, launchId: "nothex" }],
			["harness", { ...good, harness: "omp" }],
		];
		for (const [what, value] of bad) expect(() => validateEndoDevelopAttemptAuthorizationV0(value), what).toThrow();
	});
});

describe("the dispatcher: may this attempt be sent from this launch?", () => {
	it("offers the brief exactly as rendered from the prepared record, and reads nothing else into it", () => {
		const w = seeded();
		const c = ok(w.dispatch.check(w.attempt.id));
		expect(c.brief).toBe(renderEndoDevelopBriefV0(w.attempt));
		expect(c.briefSha256).toBe(sha256(c.brief));
		expect([c.taskId, c.taskRevision, c.preparedOnRevision]).toEqual([w.taskId, 0, 0]);
	});

	it("refuses, writing nothing, for every stale, foreign or closed context", () => {
		const w = seeded();
		const before = readFileSync(join(w.root, "develop", "tasks.json"));
		const code = (d: DevelopAttemptDispatchV0, id: string) => {
			const r = d.check(id);
			return r.ok ? "ok" : r.code;
		};
		expect(code(w.dispatch, "endo.attempt.nope")).toBe("bad-request");
		expect(code(w.dispatch, ATTEMPT)).toBe("not-found");
		// Another project's launch cannot send this project's attempt.
		const elsewhere = new DevelopAttemptDispatchV0(w.tasks, w.attempts, {
			projectId: w.other.p.id,
			launchDirectory: w.other.p.path,
		});
		expect(code(elsewhere, w.attempt.id)).toBe("other-project");
		// The right project, but Pi was started in another directory: the brief would run somewhere else.
		const wrongDir = new DevelopAttemptDispatchV0(w.tasks, w.attempts, {
			projectId: w.projectId,
			launchDirectory: fresh("elsewhere"),
		});
		expect(code(wrongDir, w.attempt.id)).toBe("launch-not-registered");
		// A status move is not staleness; changed words are.
		ok(w.tasks.setStatus(w.projectId, w.taskId, 0, "in-progress", null));
		expect(code(w.dispatch, w.attempt.id)).toBe("ok");
		ok(w.tasks.updateTask(w.projectId, w.taskId, 1, { acceptance: "npm test and lint pass" }));
		expect(code(w.dispatch, w.attempt.id)).toBe("task-words-changed");
		ok(w.tasks.updateTask(w.projectId, w.taskId, 2, { acceptance: "npm test passes" }));
		expect(code(w.dispatch, w.attempt.id)).toBe("ok");
		ok(w.tasks.setStatus(w.projectId, w.taskId, 3, "review", null));
		ok(w.tasks.setStatus(w.projectId, w.taskId, 4, "done", null));
		expect(code(w.dispatch, w.attempt.id)).toBe("task-done");
		ok(w.tasks.setStatus(w.projectId, w.taskId, 5, "open", null));
		// An outcome closes the attempt for sending.
		const b = ok(w.service.prepare(w.projectId, w.taskId, { objective: "Another go" }));
		ok(w.service.abandon(b.id));
		expect(code(w.dispatch, b.id)).toBe("outcome-recorded");
		// One attempt is not given to two executors: one handed to another agent is not also sent to Pi.
		const h = ok(w.service.prepare(w.projectId, w.taskId, { objective: "Handed elsewhere" }));
		ok(w.service.handoff(h.id, { target: "Codex" }));
		expect(code(w.dispatch, h.id)).toBe("handed-off");
		// An unreadable file at one of the attempt's names blocks it: it might be a record this build cannot read.
		const c = ok(w.service.prepare(w.projectId, w.taskId, { objective: "Third" }));
		writeFileSync(join(w.attempts.directory, `${c.id}.authorized.json`), "{not json", { mode: 0o600 });
		expect(code(w.dispatch, c.id)).toBe("unreadable");
		// A brief longer than a workbench prompt is refused, not cut.
		const long = ok(
			w.service.prepare(w.projectId, w.taskId, {
				objective: "x".repeat(4000),
				constraints: "y".repeat(4000),
				reportBack: "z".repeat(4000),
			}),
		);
		ok(w.tasks.updateTask(w.projectId, w.taskId, 6, { description: "d".repeat(4000) }));
		const longer = ok(
			w.service.prepare(w.projectId, w.taskId, {
				objective: "x".repeat(4000),
				constraints: "y".repeat(4000),
				reportBack: "z".repeat(4000),
			}),
		);
		expect(code(w.dispatch, longer.id)).toBe("brief-too-large");
		expect(code(w.dispatch, long.id)).toBe("task-words-changed");
		// None of this wrote an authorisation, and the dispatcher never writes the task file.
		expect(readdirSync(w.attempts.directory).filter((n) => n.endsWith(".authorized.json"))).toEqual([
			`${c.id}.authorized.json`,
		]);
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).not.toEqual(before); // the TEST changed it above
		const after = readFileSync(join(w.root, "develop", "tasks.json"));
		w.dispatch.check(w.attempt.id);
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).toEqual(after);
	});

	it("authorises once; checks again at that moment; a second authorisation is refused and the first is left byte for byte", () => {
		const w = seeded();
		const { p } = chain();
		const c = ok(w.dispatch.check(w.attempt.id));
		const binding = {
			session: SESSION,
			attachment: "pi.default",
			launchId: "0123456789abcdef",
			proposalId: p.proposalId,
			proposalDigest: p.proposalDigest,
			authorizationEventId: "endo.event.t.auth",
			message: MESSAGE,
		};
		const rec = ok(w.dispatch.authorize(c, binding));
		expect(rec).toMatchObject({ attemptId: w.attempt.id, briefSha256: c.briefSha256, approvedBy: "operator" });
		const file = join(w.attempts.directory, `${w.attempt.id}.authorized.json`);
		const bytes = readFileSync(file);
		const again = w.dispatch.authorize(c, { ...binding, launchId: "fedcba9876543210" });
		expect(again).toEqual({ ok: false, code: "already-authorized" });
		expect(w.dispatch.check(w.attempt.id)).toEqual({ ok: false, code: "already-authorized" });
		expect(readFileSync(file)).toEqual(bytes);

		// A change between the operator reading the brief and approving it is caught at the moment of writing.
		const v = seeded();
		const cv = ok(v.dispatch.check(v.attempt.id));
		ok(v.tasks.updateTask(v.projectId, v.taskId, 0, { title: "Fix the parser properly" }));
		expect(v.dispatch.authorize(cv, binding)).toEqual({ ok: false, code: "task-words-changed" });
		expect(readdirSync(v.attempts.directory).some((n) => n.endsWith(".authorized.json"))).toBe(false);
		// A candidate whose brief is not the one rendered now (a forged or stale candidate) is refused.
		const x = seeded();
		const cx = ok(x.dispatch.check(x.attempt.id));
		expect(x.dispatch.authorize({ ...cx, brief: `${cx.brief} ` }, binding)).toEqual({
			ok: false,
			code: "task-words-changed",
		});
	});

	it("concurrent writers in separate processes: exactly one authorisation is created", async () => {
		const w = seeded();
		const n = 6;
		const go = join(fresh("go"), "go");
		let ready = 0;
		const results = Promise.all(
			Array.from(
				{ length: n },
				(_, i) =>
					new Promise<string>((resolve) => {
						const child = spawn(
							process.execPath,
							[WRITER, w.root, w.projectId, w.launch, w.attempt.id, String(i), go],
							{ stdio: ["ignore", "pipe", "inherit"] },
						);
						let out = "";
						child.stdout.on("data", (d) => {
							out += String(d);
							if (String(d).includes("ready")) ready += 1;
						});
						child.on("close", () => resolve(out.replace("ready", "").trim()));
					}),
			),
		);
		// Every writer has loaded and checked the attempt before any of them may write: they race at the link.
		for (let i = 0; i < 600 && ready < n; i++) await new Promise((r) => setTimeout(r, 25));
		writeFileSync(go, "");
		const answers = await results;
		expect(answers.filter((r) => r === "created")).toHaveLength(1);
		expect(answers.filter((r) => r === "already-authorized")).toHaveLength(n - 1);
		const read = w.attempts.read();
		expect(read.ok && read.entries[0]?.authorized?.attemptId).toBe(w.attempt.id);
		expect(read.ok && read.problems).toEqual([]);
	});
});

describe("the projection: what the session log says happened", () => {
	const brief = "# Work brief …\nEnd of brief.\n";
	const find = (events: EndoEventV0[], log: EndoSessionLogReadV0 = complete(events)) => {
		const { p } = chain();
		return endoAttemptExecutionFindingV0(recordFor(p, brief, ATTEMPT), log);
	};

	it("a whole chain: sent, Pi acknowledged it, and the run after it completed, as Pi reported", () => {
		const { events } = chain();
		expect(find(events)).toEqual({
			send: "runtime-accepted",
			refusal: null,
			disposition: "started",
			run: "completed",
		});
		for (const [end, run] of [
			["lifecycle.run-failed", "failed"],
			["lifecycle.run-aborted", "aborted"],
			["lifecycle.run-unclassified", "unclassified"],
			["lifecycle.interrupted", "interrupted"],
		] as const)
			expect(find(chain({ runEnd: end }).events).run).toBe(run);
	});

	it("a crash between the authorisation and the recorded send reads as not sent; one after the send reads as unknown", () => {
		const { events } = chain();
		const cut = (id: string) =>
			events.slice(
				0,
				events.findIndex((e) => e.id === id),
			);
		// Bound, then the process stopped before recording the send: the broker sends only after that record.
		expect(find(cut("endo.event.t.disp"))).toMatchObject({ send: "no-send-recorded", run: "not-observed" });
		// The send was recorded, then the process stopped: work may have started. Never "not sent".
		expect(find(cut("endo.event.t.ctl"))).toMatchObject({ send: "sent-no-reply", run: "not-observed" });
		// Pi started the run but its reply was never recorded.
		expect(find(cut("endo.event.t.acc"))).toMatchObject({ send: "sent-no-reply", run: "open" });
		// Accepted, and the observation ends with the run open.
		expect(find(cut("endo.event.t.end"))).toMatchObject({ send: "runtime-accepted", run: "open" });
	});

	it("a partial log decides nothing by absence; an unreadable one decides nothing at all", () => {
		const { events } = chain();
		const cut = events.slice(0, 3);
		expect(find(cut, { state: "partial", events: cut }).send).toBe("evidence-unavailable");
		expect(find(events, { state: "partial", events }).send).toBe("runtime-accepted");
		expect(find(events, { state: "unavailable" })).toEqual({
			send: "evidence-unavailable",
			refusal: null,
			disposition: null,
			run: "not-observed",
		});
		expect(find([], complete([])).send).toBe("not-attributable");
	});

	it("a refusal recorded after the approval and before any send reads as not sent, with its reason", () => {
		const { p, events } = chain();
		const refused = [
			...events.slice(0, 3),
			ev("endo.event.t.ref", "workbench.prompt-refused", { proposalId: p.proposalId, reason: "attempt-changed" }, [
				"endo.event.t.auth",
			]),
		];
		expect(find(refused)).toEqual({
			send: "not-sent",
			refusal: "attempt-changed",
			disposition: null,
			run: "not-observed",
		});
		const runtime = [
			...events.slice(0, 4),
			ev("endo.event.t.ref", "workbench.prompt-refused", { proposalId: p.proposalId, reason: "runtime-refused" }, [
				"endo.event.t.disp",
			]),
		];
		expect(find(runtime)).toMatchObject({ send: "refused-by-runtime", refusal: "runtime-refused" });
	});

	it("substituted, tampered or ambiguous identities are not attributed", () => {
		const { p, events } = chain();
		const swap = (id: string, change: (e: EndoEventV0) => EndoEventV0) =>
			events.map((e) => (e.id === id ? change(e) : e));
		const payload = (e: EndoEventV0, patch: Record<string, unknown>) =>
			({ ...e, payload: { ...(e.payload as object), ...patch } }) as EndoEventV0;
		const cases: [string, EndoEventV0[]][] = [
			// The proposal is in another session's coordinates: a session substituted after the fact.
			[
				"other session",
				swap("endo.event.t.prop", (e) => ({ ...e, coordinates: { sessionId: "endo.session.pi.other" } })),
			],
			// A proposal whose recorded content no longer hashes to its digest.
			["tampered content", swap("endo.event.t.prop", (e) => payload(e, { attachment: "pi.other" }))],
			// A different message (another prompt's digest) under the same ids.
			[
				"other message",
				swap("endo.event.t.prop", (e) =>
					payload(e, { message: { ...MESSAGE, digest: { ...MESSAGE.digest, value: "b".repeat(64) } } }),
				),
			],
			// The authorisation is a deny, or for something else.
			["denied", swap("endo.event.t.auth", (e) => payload(e, { decision: "deny" }))],
			["auth not derived", swap("endo.event.t.auth", (e) => ({ ...e, derivedFrom: [] }))],
			// Two proposals with the same id: ambiguous.
			[
				"duplicate proposal",
				[...events.slice(0, 2), { ...(events[1] as EndoEventV0), id: "endo.event.t.prop2" }, ...events.slice(2)],
			],
		];
		for (const [what, log] of cases) expect(find(log).send, what).toBe("not-attributable");
		// A record that names another session than the one its proposal was for.
		const other = proposalFor("endo.session.pi.someone-else");
		expect(endoAttemptExecutionFindingV0(recordFor(other, brief, ATTEMPT), complete(events)).send).toBe(
			"not-attributable",
		);
		void p;
	});

	it("only a run of the same session and Pi process after the send is attributed", () => {
		const { p, events } = chain();
		const upToAccept = events.slice(0, 4);
		// The process exited before any run started; a later process resumed the session and ran something else.
		const exited = [
			...upToAccept,
			ev("endo.event.t.x", "lifecycle.detached", { instance: "inst-1" }),
			ev("endo.event.t.r2", "lifecycle.session-resumed", { instance: "inst-2" }),
			ev("endo.event.t.run2", "lifecycle.run-started", { instance: "inst-2" }),
			ev("endo.event.t.end2", "lifecycle.run-completed", { turns: 1 }),
		];
		expect(find(exited).run).toBe("process-ended");
		// A run of another session after the send is not this one.
		const elsewhere = [
			...upToAccept,
			ev("endo.event.t.o1", "lifecycle.run-started", { instance: "inst-1" }, [], "endo.session.pi.other"),
			ev("endo.event.t.o2", "lifecycle.run-completed", { turns: 1 }, [], "endo.session.pi.other"),
		];
		expect(find(elsewhere).run).toBe("not-observed");
		// A run that started BEFORE the send is never this one.
		const before = [
			events[0] as EndoEventV0,
			ev("endo.event.t.early", "lifecycle.run-started", { instance: "inst-1" }),
			ev("endo.event.t.early-end", "lifecycle.run-completed", { turns: 1 }),
			...events.slice(1, 4),
		];
		expect(find(before).run).toBe("not-observed");
		void p;
	});

	it("a later prompt's run is never this attempt's (review finding: the run window ends at the next send)", () => {
		const { p, events } = chain();
		const other = proposalFor(
			SESSION,
			"pi.default",
			{ ...MESSAGE, digest: { ...MESSAGE.digest, value: "d".repeat(64) } },
			"2026-11-04T10:05:00.000Z",
		);
		const laterPrompt = [
			ev("endo.event.t.prop-b", "workbench.prompt-proposed", {
				proposalId: other.proposalId,
				proposalDigest: other.proposalDigest,
				...other.content,
			}),
			ev("endo.event.t.disp-b", "workbench.prompt-dispatched", { proposalId: other.proposalId }, [
				"endo.event.t.auth-b",
			]),
			ev("endo.event.t.run-b", "lifecycle.run-started", { instance: "inst-1" }),
			ev("endo.event.t.end-b", "lifecycle.run-failed", { turns: 1 }),
		];
		// (a) Pi refused the attempt; prompt B then ran.
		const refusedThenB = [
			...events.slice(0, 4),
			ev("endo.event.t.ref", "workbench.prompt-refused", { proposalId: p.proposalId, reason: "runtime-refused" }, [
				"endo.event.t.disp",
			]),
			...laterPrompt,
		];
		expect(find(refusedThenB)).toMatchObject({ send: "refused-by-runtime", run: "not-observed" });
		// Even a run that follows a runtime refusal directly is not this attempt's.
		expect(
			find([
				...events.slice(0, 4),
				ev(
					"endo.event.t.ref",
					"workbench.prompt-refused",
					{ proposalId: p.proposalId, reason: "runtime-refused" },
					["endo.event.t.disp"],
				),
				ev("endo.event.t.run2", "lifecycle.run-started", { instance: "inst-1" }),
				ev("endo.event.t.end2", "lifecycle.run-completed", { turns: 1 }),
			]).run,
		).toBe("not-observed");
		// (b) The attempt's reply was lost, and B was sent and ran: B's run is not the attempt's.
		expect(find([...events.slice(0, 4), ...laterPrompt])).toMatchObject({
			send: "sent-no-reply",
			run: "not-observed",
		});
		// A run that had already started before B was sent is still the attempt's, and its end is read.
		expect(find([...events.slice(0, 6), ...laterPrompt.slice(0, 2), events[7] as EndoEventV0]).run).toBe("completed");
	});

	it("says whether the brief rendered now is the one that was approved", () => {
		const { p, events } = chain();
		const record = recordFor(p, brief, ATTEMPT);
		expect(endoAttemptExecutionViewV0(record, complete(events), brief).brief).toBe("matches");
		expect(endoAttemptExecutionViewV0(record, complete(events), `${brief}edited`).brief).toBe("differs");
		expect(endoAttemptExecutionViewV0(record, complete(events), brief, () => "s-alias").session).toBe("s-alias");
	});
});

describe("contracts between the protocol and the page", () => {
	it("the page's labels and reasons mirror the protocol's", () => {
		expect(EXECUTION_SEND_LABELS).toEqual(ENDO_ATTEMPT_SEND_LABELS_V0);
		expect(EXECUTION_RUN_LABELS).toEqual(ENDO_ATTEMPT_RUN_LABELS_V0);
		expect(Object.keys(EXECUTION_SEND_LABELS).sort()).toEqual([...ENDO_ATTEMPT_SEND_STATES_V0].sort());
		expect(Object.keys(EXECUTION_RUN_LABELS).sort()).toEqual([...ENDO_ATTEMPT_RUN_STATES_V0].sort());
		expect([...EXECUTION_REFUSALS].sort()).toEqual([...ENDO_WORKBENCH_REFUSAL_REASONS_V0].sort());
		// No label claims the work succeeded or that anything was verified or accepted by the operator.
		for (const label of [...Object.values(EXECUTION_SEND_LABELS), ...Object.values(EXECUTION_RUN_LABELS)])
			expect(label).not.toMatch(/succe|(?<!not )verified|\bdone\b|accepted by you|task accepted/i);
	});

	it("the page's gate takes a coherent execution and refuses the whole view for an incoherent one", () => {
		const w = seeded();
		const { p, events } = chain();
		const record = recordFor(p, renderEndoDevelopBriefV0(w.attempt), w.attempt.id);
		const service = new DevelopAttemptsServiceV0(w.tasks, w.attempts, { sessionLog: () => complete(events) });
		writeFileSync(
			join(w.attempts.directory, `${w.attempt.id}.authorized.json`),
			`${canonicalEndoJsonV0(record as never)}\n`,
			{
				mode: 0o600,
			},
		);
		const view = JSON.parse(JSON.stringify(service.viewFor(w.projectId, null, () => "alias")));
		expect(view.attempts[0].execution).toMatchObject({
			send: "runtime-accepted",
			run: "completed",
			brief: "matches",
		});
		expect(readAttempts(view)).not.toBeNull();
		const broken = (patch: Record<string, unknown>) => {
			const v = JSON.parse(JSON.stringify(view));
			Object.assign(v.attempts[0].execution, patch);
			return readAttempts(v);
		};
		expect(broken({ disposition: null })).toBeNull(); // accepted without Pi's disposition
		expect(broken({ send: "no-send-recorded", disposition: null })).toBeNull(); // a run without a send
		expect(broken({ evidence: "unavailable" })).toBeNull(); // an answer from a log that could not be read
		expect(broken({ extra: 1 })).toBeNull();
		// A refusal reason this build does not know is read as unknown (null), and does not invalidate the whole section.
		expect(broken({ send: "not-sent", disposition: null, run: "not-observed", refusal: null })).not.toBeNull();
		expect(
			broken({ send: "no-send-recorded", disposition: null, run: "not-observed", refusal: "duplicate" }),
		).toBeNull();
		expect(broken({ session: "a\u202eb" })).toBeNull();
	});

	it("a restart reads the same execution from the same files, and the task file is never written", () => {
		const w = seeded();
		const { p, events } = chain();
		writeFileSync(
			join(w.attempts.directory, `${w.attempt.id}.authorized.json`),
			`${canonicalEndoJsonV0(recordFor(p, renderEndoDevelopBriefV0(w.attempt), w.attempt.id) as never)}\n`,
			{ mode: 0o600 },
		);
		const tasksBefore = readFileSync(join(w.root, "develop", "tasks.json"));
		const read = () =>
			ok(
				new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(w.root), new DevelopAttemptsStoreV0(w.root), {
					sessionLog: () => complete(events),
				}).get(w.attempt.id),
			);
		const first = read();
		const second = read();
		expect(second.execution).toEqual(first.execution);
		expect(first.state).toBe("prepared"); // the operator's notes are unchanged: sending is not a handoff, an outcome or a verdict
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).toEqual(tasksBefore);
		// Without a readable log the record still shows, and says nothing is known.
		const blind = ok(new DevelopAttemptsServiceV0(w.tasks, w.attempts).get(w.attempt.id));
		expect(blind.execution).toMatchObject({ send: "evidence-unavailable", evidence: "unavailable" });
	});
});
