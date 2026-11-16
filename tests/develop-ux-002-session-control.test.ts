// DEVELOP-UX-002 (research/develop-ux/DEVELOP-UX-002.md): bounded session authority, at the broker's own boundary.
//
// What these tests prove: the broker's AUTHORITY checks. A session-control grant is issued only on a terminal-armed pairing code and only
// while an execution boundary is observed as enforced; it is checked against the live session, attachment, workspace, time and budget
// at every use; nothing a page sends widens, renews or revives it; and every send it authorises is recorded as authorised by the grant.
//
// What they do NOT prove: containment. `Boundary` below is a stand-in the test constructs in process and tells what to report. It
// stands for "some provider says a boundary is enforced"; no agent is confined by it, and no test here is evidence that one would be.
// The only production provider (cli/execution-protection.ts) never reports `enforced`, which is tested at the end.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkbenchApprovalRequestV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { hostExecutionLimitationsV0, hostExecutionProtectionV0 } from "../cli/execution-protection.ts";
import {
	ENDO_WORKBENCH_GRANT_END_REASONS_V0,
	ENDO_WORKBENCH_SCHEMA_V0,
	endoWorkbenchPayloadProblemV0,
} from "../protocol/workbench.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import {
	type EndoExecutionProtectionStatusV0,
	type EndoExecutionProtectionV0,
	endoObserveProtectionV0,
	endoProtectionHoldsV0,
} from "../runtime/contracts/execution-protection.ts";
import {
	ENDO_SESSION_CONTROL_END_REASONS_V0,
	ENDO_SESSION_CONTROL_MAX_LIFETIME_MS_V0,
	type EndoSessionControlOperationV0,
	EndoSessionControlV0,
	type EndoWorkbenchModeV0,
} from "../runtime/contracts/session-control.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { FakeDesk, FakeSession, settle } from "./workbench-fixtures.ts";

const SECRET = "CANARY-prompt-5c1a-do-not-record";
const WORKSPACE = "/work/CANARY-workspace-path";
const SESSION = "endo.session.pi.fake-session-1";
const MINUTE = 60_000;

/** A STAND-IN for an execution boundary: it reports what the test tells it to. It confines nothing. */
class Boundary implements EndoExecutionProtectionV0 {
	status: EndoExecutionProtectionStatusV0 = {
		state: "enforced",
		level: "workspace",
		mechanism: "test-stand-in.v0",
		session: SESSION,
		workspaceRoot: WORKSPACE,
		limitations: [],
	};
	throws = false;
	observations = 0;
	observe(): EndoExecutionProtectionStatusV0 {
		this.observations += 1;
		if (this.throws) throw new Error("the boundary could not be read");
		return this.status;
	}
}

/** The controlling terminal: every question it is asked is counted, and answered only when the test types. */
class Terminal {
	asked: WorkbenchApprovalRequestV0[] = [];
	#open: { request: WorkbenchApprovalRequestV0; done(answer: "allow" | "allow-code" | "deny" | null): void } | null =
		null;
	readonly approver = (request: WorkbenchApprovalRequestV0, signal: AbortSignal) =>
		new Promise<"allow" | "allow-code" | "deny" | null>((resolve) => {
			this.asked.push(request);
			let finished = false;
			const done = (answer: "allow" | "allow-code" | "deny" | null) => {
				if (finished) return;
				finished = true;
				if (this.#open?.request === request) this.#open = null;
				resolve(answer);
			};
			this.#open = { request, done };
			const release = () => queueMicrotask(() => done(null));
			if (signal.aborted) release();
			else signal.addEventListener("abort", release, { once: true });
		});
	/** Type a line: the exact phrase allows, anything else declines. */
	type(line: string): void {
		const open = this.#open;
		open?.done(line === open.request.phrase ? "allow" : "deny");
	}
	approve(): void {
		this.type(this.#open?.request.phrase ?? "");
	}
	answerWithCode(): void {
		this.#open?.done("allow-code");
	}
	async waitFor(count: number): Promise<WorkbenchApprovalRequestV0> {
		for (let i = 0; i < 400 && this.asked.length < count; i++) await new Promise((r) => setTimeout(r, 5));
		const question = this.asked[count - 1];
		if (question === undefined) throw new Error(`question ${count} was never asked (${this.asked.length} asked)`);
		return question;
	}
}

/** Ways a test weakens the stand-in. */
const change = (members: Partial<EndoExecutionProtectionStatusV0>) => (b: Boundary) => {
	b.status = { ...b.status, ...members };
};
const replace = (status: EndoExecutionProtectionStatusV0) => (b: Boundary) => {
	b.status = status;
};
const unreadable = (b: Boundary) => {
	b.throws = true;
};

type Reply = { status: number; body: any };

function setup(
	options: {
		mode?: EndoWorkbenchModeV0;
		boundary?: Boundary | null;
		operations?: readonly EndoSessionControlOperationV0[];
		maxSends?: number;
		lifetimeMs?: number;
		noControl?: boolean;
		attempts?: Pick<DevelopAttemptDispatchV0, "check" | "authorize">;
	} = {},
) {
	const session = new FakeSession();
	const desk = new FakeDesk(session);
	const terminal = new Terminal();
	const boundary = options.boundary === undefined ? new Boundary() : options.boundary;
	const clock = { now: 1_700_000_000_000 };
	const notices: string[] = [];
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: terminal.approver,
		interventions: desk,
		now: () => clock.now,
		onSessionControl: (event) => notices.push(event.type === "granted" ? "granted" : `ended:${event.reason}`),
		...(options.attempts === undefined ? {} : { attempts: options.attempts }),
		...(options.noControl === true
			? {}
			: {
					control: {
						mode: options.mode ?? "everyday",
						workspaceRoot: WORKSPACE,
						...(boundary === null ? {} : { protection: boundary }),
						...(options.operations === undefined ? {} : { operations: options.operations }),
						...(options.maxSends === undefined ? {} : { maxSends: options.maxSends }),
						...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
					},
				}),
	});
	const call = (
		method: "GET" | "POST",
		route: string,
		body: unknown = null,
		grant: string | null = null,
	): Promise<Reply> => broker.handle({ method, route: route.split("/"), query: "", grant, body }) as Promise<Reply>;
	/** Pair with a code the TERMINAL issued: plain, or armed with session control. */
	const pair = async (control: boolean): Promise<string> => {
		const issued = broker.issuePairingCode({ control });
		return (await call("POST", "pair", { code: issued.code })).body.grant as string;
	};
	const status = async (grant: string | null = null) => (await call("GET", "status", null, grant)).body;
	const prompt = (grant: string, message: string, extra: Record<string, unknown> = {}) =>
		call("POST", "prompt/propose", { message, ...extra }, grant);
	const intervene = (grant: string, operation: string, message?: string, extra: Record<string, unknown> = {}) =>
		call(
			"POST",
			"intervention/propose",
			message === undefined ? { operation, ...extra } : { operation, message, ...extra },
			grant,
		);
	const kinds = () => session.records.map((r) => r.kind);
	const ended = () =>
		session.records.filter((r) => r.kind === "workbench.session-control-ended").map((r) => r.payload.reason);
	return {
		session,
		desk,
		terminal,
		boundary,
		clock,
		notices,
		broker,
		call,
		pair,
		status,
		prompt,
		intervene,
		kinds,
		ended,
	};
}

describe("1. Everyday: one terminal authorisation, then repeated sends", () => {
	it("sends ten prompts after one armed pairing, asks the terminal nothing, and records each as authorised by the grant", async () => {
		const w = setup();
		const grant = await w.pair(true);
		const held = (await w.status(grant)).sessionControl;
		expect(held).toMatchObject({
			state: "active",
			holder: true,
			operations: ["prompt", "steer", "queue", "stop"],
			sendsLeft: 200,
			workspaceRoot: WORKSPACE,
		});
		expect(held.expiresAtMs).toBe(w.clock.now + 30 * MINUTE);
		for (let i = 0; i < 10; i++) {
			const reply = await w.prompt(grant, `message ${i} ${SECRET}`);
			expect(reply.status).toBe(202);
			// Proposed, authorised and dispatched happened within the request; each is still its own state and record.
			expect(reply.body).toMatchObject({ approved: true, authorizedBy: "session-grant" });
			await settle(5);
			expect((await w.call("GET", `prompt/${reply.body.proposalId}`, null, grant)).body).toMatchObject({
				state: "accepted",
				disposition: "started",
				authorizedBy: "session-grant",
			});
		}
		expect(w.session.promptCalls).toHaveLength(10);
		expect(w.session.promptCalls[9]).toBe(`message 9 ${SECRET}`);
		expect(w.terminal.asked).toEqual([]);
		expect(w.kinds()).toEqual([
			"workbench.session-control-granted",
			...Array.from({ length: 10 }, () => [
				"workbench.prompt-proposed",
				"workbench.prompt-authorized",
				"workbench.prompt-dispatched",
				"workbench.prompt-accepted",
			]).flat(),
		]);
		const grantId = w.session.records[0]!.payload.grantId;
		const authorizations = w.session.records.filter((r) => r.kind === "workbench.prompt-authorized");
		// Never labelled as a typed approval.
		for (const a of authorizations)
			expect(a.payload).toMatchObject({ decision: "allow", confirmation: "session-grant", sessionGrant: grantId });
		expect((await w.status(grant)).sessionControl.sendsLeft).toBe(190);
		expect(w.notices).toEqual(["granted"]);
	});

	it("steers and queues an open run under the grant, on the existing intervention chain, recorded with the grant's authority", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.session.runActive = true;
		w.desk.hold = false;
		const steer = await w.intervene(grant, "steer", `turn left ${SECRET}`);
		const queue = await w.intervene(grant, "queue", "then stop");
		await settle(5);
		expect([steer.status, queue.status]).toEqual([202, 202]);
		expect(w.terminal.asked).toEqual([]);
		expect(w.desk.applyCalls).toHaveLength(2);
		const grantId = w.session.records[0]!.payload.grantId;
		expect(w.desk.authorizations.map((a) => [a.decision, a.authority])).toEqual([
			["allow", { kind: "local-operator", confirmation: "session-grant", sessionGrant: grantId }],
			["allow", { kind: "local-operator", confirmation: "session-grant", sessionGrant: grantId }],
		]);
		const view = (await w.call("GET", `intervention/${steer.body.proposalId}`, null, grant)).body;
		expect(view).toMatchObject({ state: "accepted", approved: true, authorizedBy: "session-grant" });
	});
});

describe("2. Strict is unchanged", () => {
	it("asks the terminal for each of ten prompts and records each as a terminal confirmation, with no grant anywhere", async () => {
		for (const w of [setup({ noControl: true }), setup({ mode: "strict" })]) {
			// Even a code the terminal tried to arm carries nothing in Strict.
			const issued = w.broker.issuePairingCode({ control: true });
			expect(issued.control).toBeNull();
			expect(issued.refused).toContain("Strict mode was chosen");
			const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
			for (let i = 0; i < 10; i++) {
				const reply = await w.prompt(grant, `message ${i}`);
				expect(reply.body).toMatchObject({ state: "awaiting-approval", approved: false, authorizedBy: null });
				expect(w.session.promptCalls).toHaveLength(i);
				const question = await w.terminal.waitFor(i + 1);
				expect(question.phrase).toMatch(/^APPROVE PROMPT [0-9a-f]{16}$/);
				w.terminal.approve();
				await settle(5);
			}
			expect(w.session.promptCalls).toHaveLength(10);
			expect(w.terminal.asked).toHaveLength(10);
			expect(w.kinds().filter((k) => k.startsWith("workbench.session-control"))).toEqual([]);
			for (const a of w.session.records.filter((r) => r.kind === "workbench.prompt-authorized")) {
				expect(a.payload.confirmation).toBe("terminal");
				expect(Object.keys(a.payload)).not.toContain("sessionGrant");
			}
			expect((await w.status(grant)).mode).toMatchObject({ requested: "strict", effective: "strict", reason: null });
		}
	});

	it("an Everyday launch with no enforced boundary is Strict: ten prompts, ten phrases, and the reason is said", async () => {
		const boundary = new Boundary();
		boundary.status = {
			state: "not-enforced",
			level: "none",
			mechanism: null,
			session: null,
			workspaceRoot: null,
			limitations: ["Pi is not placed inside an execution boundary by this build."],
		};
		const w = setup({ boundary });
		const issued = w.broker.issuePairingCode({ control: true });
		expect(issued).toMatchObject({
			control: null,
			refused: "Pi is not placed inside an execution boundary by this build.",
		});
		const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
		const status = await w.status(grant);
		expect(status.mode).toEqual({
			requested: "everyday",
			effective: "strict",
			reason: "Pi is not placed inside an execution boundary by this build.",
		});
		expect(status.sessionControl).toMatchObject({ state: "none", holder: false, armed: false });
		for (let i = 0; i < 10; i++) {
			await w.prompt(grant, `message ${i}`);
			await w.terminal.waitFor(i + 1);
			expect(w.session.promptCalls).toHaveLength(i);
			w.terminal.approve();
			await settle(5);
		}
		expect(w.terminal.asked).toHaveLength(10);
		expect(w.kinds().filter((k) => k.startsWith("workbench.session-control"))).toEqual([]);
	});

	it("records the short terminal code as a code, never as the phrase, for a prompt and for an intervention", async () => {
		const w = setup({ noControl: true });
		const grant = await w.pair(false);
		await w.prompt(grant, "one");
		await w.terminal.waitFor(1);
		w.terminal.answerWithCode();
		await settle(5);
		expect(w.session.promptCalls).toEqual(["one"]);
		expect(w.session.records.find((r) => r.kind === "workbench.prompt-authorized")!.payload).toMatchObject({
			decision: "allow",
			confirmation: "terminal-code",
		});
		w.session.runActive = true;
		w.desk.hold = false;
		const steer = await w.intervene(grant, "steer", "left");
		await w.terminal.waitFor(2);
		w.terminal.answerWithCode();
		await settle(5);
		expect(w.desk.authorizations[0]).toMatchObject({
			decision: "allow",
			authority: { kind: "local-operator", confirmation: "terminal-code" },
		});
		expect((await w.call("GET", `intervention/${steer.body.proposalId}`, null, grant)).body.authorizedBy).toBe(
			"terminal",
		);
	});
});

describe("3. Wrong session or attachment", () => {
	it("ends the grant when another session is connected, and the next request waits for the terminal instead of being sent", async () => {
		const w = setup();
		const grant = await w.pair(true);
		await w.prompt(grant, "first");
		await settle(5);
		expect(w.session.promptCalls).toEqual(["first"]);
		// The runtime behind the broker is now another session (a substitution, a restart into another id).
		w.session.piSessionId = "another-session";
		const reply = await w.prompt(grant, "second");
		expect(reply.body).toMatchObject({ state: "awaiting-approval", approved: false, authorizedBy: null });
		expect(w.session.promptCalls).toEqual(["first"]);
		expect(w.ended()).toEqual(["session-changed"]);
		expect((await w.status(grant)).sessionControl).toMatchObject({ state: "none", ended: "session-changed" });
		// Going back does not revive it.
		w.session.piSessionId = "fake-session-1";
		expect((await w.status(grant)).sessionControl.state).toBe("none");
		expect(w.session.promptCalls).toEqual(["first"]);
	});

	it("a runtime that is no longer live ends the grant with the session", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.session.live = false;
		expect((await w.prompt(grant, "x")).status).toBe(401);
		expect(w.session.promptCalls).toEqual([]);
		expect(w.ended()).toEqual(["closing"]);
	});

	it("the grant itself refuses another launch, attachment or session (the contract, where each can be varied)", () => {
		for (const change of ["launchId", "attachment", "session"] as const) {
			const boundary = new Boundary();
			const subject = {
				launchId: "a".repeat(16),
				session: SESSION as string | null,
				attachment: "pi.default",
				workspaceRoot: WORKSPACE,
			};
			const endings: string[] = [];
			const control = new EndoSessionControlV0({
				mode: "everyday",
				protection: boundary,
				now: () => 1000,
				subject: () => subject,
				closed: () => false,
				onGranted: () => true,
				onEnded: (_grant, reason) => endings.push(reason),
			});
			expect(control.arm(2000).ok).toBe(true);
			expect(control.paired("token-a")).not.toBeNull();
			expect(control.authorize("token-a", "prompt")).not.toBeNull();
			if (change === "session") {
				subject.session = "endo.session.pi.other";
				boundary.status = { ...boundary.status, session: "endo.session.pi.other" };
			} else subject[change] = change === "launchId" ? "b".repeat(16) : "pi.other";
			expect(control.authorize("token-a", "prompt"), change).toBeNull();
			expect(endings, change).toEqual(["session-changed"]);
		}
	});
});

describe("4. Wrong workspace or scope", () => {
	it("ends the grant when the boundary is observed around another workspace", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.boundary!.status = { ...w.boundary!.status, workspaceRoot: "/somewhere/else" };
		expect((await w.prompt(grant, "x")).body.state).toBe("awaiting-approval");
		expect(w.session.promptCalls).toEqual([]);
		expect(w.ended()).toEqual(["protection-lost"]);
	});

	it("ends the grant when the host's own workspace is not the granted one (the contract)", () => {
		const subject = {
			launchId: "a".repeat(16),
			session: SESSION,
			attachment: "pi.default",
			workspaceRoot: WORKSPACE,
		};
		const boundary = new Boundary();
		const endings: string[] = [];
		const control = new EndoSessionControlV0({
			mode: "everyday",
			protection: boundary,
			now: () => 1000,
			subject: () => subject,
			closed: () => false,
			onGranted: () => true,
			onEnded: (_grant, reason) => endings.push(reason),
		});
		control.arm(2000);
		control.paired("token-a");
		subject.workspaceRoot = "/work/other";
		boundary.status = { ...boundary.status, workspaceRoot: "/work/other" };
		expect(control.authorize("token-a", "prompt")).toBeNull();
		expect(endings).toEqual(["workspace-changed"]);
	});

	it("an operation the grant does not list takes the terminal path; the listed ones do not", async () => {
		const w = setup({ operations: ["prompt", "stop"] });
		const grant = await w.pair(true);
		expect((await w.status(grant)).sessionControl.operations).toEqual(["prompt", "stop"]);
		w.session.runActive = true;
		w.desk.hold = false;
		const steer = await w.intervene(grant, "steer", "left");
		expect(steer.body).toMatchObject({ state: "awaiting-approval", authorizedBy: null });
		expect(w.desk.applyCalls).toEqual([]);
		expect((await w.terminal.waitFor(1)).phrase).toMatch(/^APPROVE STEER /);
		// The grant is untouched by a request outside its scope.
		expect((await w.status(grant)).sessionControl).toMatchObject({ state: "active", sendsLeft: 200 });
	});

	it("never covers an attempt's brief: it is approved on the terminal by its own phrase, grant or no grant", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "endo-ux2-")));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const tasks = new DevelopTasksStoreV0(root);
		const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
			if (!r.ok) throw new Error(r.code);
			return r.value;
		};
		const project = ok(tasks.registerProject({ name: "demo", path: root, observedGitRoot: null }));
		const task = ok(tasks.createTask(project.id, { title: "Fix", acceptance: "tests pass" }, { select: true }));
		const attempts = new DevelopAttemptsStoreV0(root);
		const attempt = ok(
			new DevelopAttemptsServiceV0(tasks, attempts).prepare(project.id, task.id, { objective: "Do it" }),
		);
		const w = setup({
			attempts: new DevelopAttemptDispatchV0(tasks, attempts, { projectId: project.id, launchDirectory: root }),
		});
		const grant = await w.pair(true);
		const reply = await w.call("POST", "attempt/propose", { attemptId: attempt.id }, grant);
		expect(reply.status).toBe(202);
		expect(reply.body).toMatchObject({ state: "awaiting-approval", approved: false, authorizedBy: null });
		expect(w.session.promptCalls).toEqual([]);
		expect((await w.terminal.waitFor(1)).phrase).toMatch(/^APPROVE ATTEMPT [0-9a-f]{16}$/);
		expect((await w.status(grant)).sessionControl.sendsLeft).toBe(200);
		w.terminal.approve();
		await settle(20);
		expect(w.session.records.find((r) => r.kind === "workbench.prompt-authorized")!.payload.confirmation).toBe(
			"terminal",
		);
	});
});

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0).reverse()) done();
});

describe("5. Expired or revoked: refused before dispatch", () => {
	it("an expired grant authorises nothing; the request waits for the terminal and nothing was sent", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.clock.now += 30 * MINUTE - 1;
		await w.prompt(grant, "in time");
		await settle(5);
		expect(w.session.promptCalls).toEqual(["in time"]);
		w.clock.now += 1;
		const late = await w.prompt(grant, "late");
		expect(late.body).toMatchObject({ state: "awaiting-approval", approved: false });
		expect(w.session.promptCalls).toEqual(["in time"]);
		// The request is recorded as proposed, the grant as ended, and nothing as authorised or dispatched.
		expect(w.kinds().slice(-2)).toEqual(["workbench.prompt-proposed", "workbench.session-control-ended"]);
		expect(w.ended()).toEqual(["expired"]);
		expect(w.notices).toEqual(["granted", "ended:expired"]);
		// Using the grant never moved its end.
		expect(w.session.records[0]!.payload.expiresAt).toBe(new Date(1_700_000_000_000 + 30 * MINUTE).toISOString());
	});

	it("a grant cannot outlive the ceiling, whatever the host asks for", async () => {
		const w = setup({ lifetimeMs: 24 * 60 * MINUTE });
		const grant = await w.pair(true);
		expect((await w.status(grant)).sessionControl.expiresAtMs).toBe(
			w.clock.now + ENDO_SESSION_CONTROL_MAX_LIFETIME_MS_V0,
		);
	});

	it("revoked on the terminal: the very next request is not sent", async () => {
		const w = setup();
		const grant = await w.pair(true);
		expect(w.broker.revokeSessionControl()).toBe(true);
		expect((await w.prompt(grant, "x")).body.state).toBe("awaiting-approval");
		expect(w.session.promptCalls).toEqual([]);
		expect(w.ended()).toEqual(["revoked-on-terminal"]);
		// The page is still paired: it can read and ask.
		expect((await w.status(grant)).paired).toBe(true);
		expect(w.broker.revokeSessionControl()).toBe(false);
	});

	it("revoking on the terminal also disarms a code that was never typed", async () => {
		const w = setup();
		const issued = w.broker.issuePairingCode({ control: true });
		expect((await w.status()).sessionControl.armed).toBe(true);
		w.broker.revokeSessionControl();
		const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
		expect((await w.status(grant)).sessionControl).toMatchObject({ state: "none", armed: false });
		expect(w.kinds()).toEqual([]);
	});

	it("the holder can give the grant up; that can only reduce authority", async () => {
		const w = setup();
		const grant = await w.pair(true);
		expect((await w.call("POST", "session-control/revoke", { extend: true }, grant)).status).toBe(400);
		expect((await w.status(grant)).sessionControl.state).toBe("active");
		const revoked = await w.call("POST", "session-control/revoke", {}, grant);
		expect(revoked.status).toBe(200);
		expect(revoked.body.sessionControl).toMatchObject({ state: "none", ended: "revoked-by-page" });
		expect((await w.call("POST", "session-control/revoke", {}, grant)).status).toBe(409);
		expect((await w.prompt(grant, "x")).body.state).toBe("awaiting-approval");
		expect(w.session.promptCalls).toEqual([]);
	});

	it("the budget is a hard count: the send after the last one waits for the terminal", async () => {
		const w = setup({ maxSends: 3 });
		const grant = await w.pair(true);
		for (let i = 0; i < 3; i++) {
			await w.prompt(grant, `m${i}`);
			await settle(5);
		}
		expect(w.session.promptCalls).toHaveLength(3);
		expect((await w.prompt(grant, "m3")).body.state).toBe("awaiting-approval");
		expect(w.session.promptCalls).toHaveLength(3);
		expect(w.session.records.find((r) => r.kind === "workbench.session-control-ended")!.payload).toMatchObject({
			reason: "budget-spent",
			sends: 3,
		});
	});

	it("closing the session ends the grant before anything else", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.desk.finish();
		expect(w.ended()).toEqual(["closing"]);
		expect((await w.prompt(grant, "x")).status).toBe(409);
		expect(w.session.promptCalls).toEqual([]);
		await w.broker.dispose();
		expect(w.ended()).toEqual(["closing"]);
	});
});

describe("6. Replay and duplicates", () => {
	it("a repeated nonce returns the request already made: one send, one chain", async () => {
		const w = setup();
		const grant = await w.pair(true);
		const nonce = "n0nce-0123456789abcdef";
		const first = await w.prompt(grant, "once", { nonce });
		const replay = await w.prompt(grant, "once", { nonce });
		const again = await w.prompt(grant, "something else entirely", { nonce });
		await settle(5);
		expect(first.status).toBe(202);
		expect([replay.status, again.status]).toEqual([200, 200]);
		expect([replay.body.proposalId, again.body.proposalId]).toEqual([first.body.proposalId, first.body.proposalId]);
		expect(w.session.promptCalls).toEqual(["once"]);
		expect(w.kinds().filter((k) => k === "workbench.prompt-dispatched")).toHaveLength(1);
		expect((await w.status(grant)).sessionControl.sendsLeft).toBe(199);
		// Even long after it settled.
		expect((await w.prompt(grant, "once", { nonce })).status).toBe(200);
		expect(w.session.promptCalls).toEqual(["once"]);
	});

	it("a repeated steer nonce is one steer; a duplicate STOP is the one in flight", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.session.runActive = true;
		const nonce = "steer-nonce-0123456789";
		const first = await w.intervene(grant, "steer", "left", { nonce });
		const replay = await w.intervene(grant, "steer", "left", { nonce });
		expect([first.status, replay.status]).toEqual([202, 200]);
		expect(replay.body.proposalId).toBe(first.body.proposalId);
		expect(w.desk.applyCalls).toHaveLength(1);
		const stop = await w.intervene(grant, "stop");
		const stopAgain = await w.intervene(grant, "stop");
		expect([stop.status, stopAgain.status]).toEqual([202, 200]);
		expect(stopAgain.body.proposalId).toBe(stop.body.proposalId);
		expect(w.desk.applyCalls).toHaveLength(2);
		expect((await w.status(grant)).sessionControl.sendsLeft).toBe(198);
	});

	it("a nonce is not a credential and not free text", async () => {
		const w = setup();
		const grant = await w.pair(true);
		for (const nonce of ["short", "x".repeat(65), "has space 0123456789", 1234567890123456, null, { a: 1 }])
			expect((await w.prompt(grant, "x", { nonce })).status, String(nonce)).toBe(400);
		expect(w.session.promptCalls).toEqual([]);
		// Another pairing cannot fetch a request by guessing its nonce.
		const nonce = "shared-nonce-0123456789";
		await w.prompt(grant, "mine", { nonce });
		await settle(5);
		const other = await w.pair(false);
		expect((await w.prompt(other, "mine", { nonce })).status).toBe(409);
		expect(w.session.promptCalls).toEqual(["mine"]);
	});
});

describe("7. Reconnection and reload: no silent renewal", () => {
	it("a page that pairs again with a plain code holds no control, and the old token is dead", async () => {
		const w = setup();
		const first = await w.pair(true);
		await w.prompt(first, "before");
		await settle(5);
		// The page reloaded: its memory, and so its tokens, are gone. The operator types `pair` and the page pairs again.
		const second = await w.pair(false);
		expect(w.ended()).toEqual(["re-paired"]);
		expect((await w.status(second)).sessionControl).toMatchObject({
			state: "none",
			holder: false,
			ended: "re-paired",
		});
		expect((await w.prompt(second, "after")).body.state).toBe("awaiting-approval");
		expect((await w.prompt(first, "from the old page")).status).toBe(401);
		expect(w.session.promptCalls).toEqual(["before"]);
		// Nor does pairing a third time.
		const third = await w.pair(false);
		expect((await w.status(third)).sessionControl.state).toBe("none");
		expect(w.kinds().filter((k) => k === "workbench.session-control-granted")).toHaveLength(1);
	});

	it("an armed code is used once: the grant it made is not remade by it, and a plain code disarms an unused one", async () => {
		const w = setup();
		const issued = w.broker.issuePairingCode({ control: true });
		const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
		expect((await w.status(grant)).sessionControl.state).toBe("active");
		expect((await w.call("POST", "pair", { code: issued.code })).status).toBe(401);
		// `control` then `pair` on the terminal: the plain code replaces the armed one, and carries nothing.
		w.broker.issuePairingCode({ control: true });
		const plain = w.broker.issuePairingCode();
		const next = (await w.call("POST", "pair", { code: plain.code })).body.grant as string;
		expect((await w.status(next)).sessionControl).toMatchObject({ state: "none", armed: false });
	});

	it("an armed code that expires unredeemed arms nothing", async () => {
		const w = setup();
		w.broker.issuePairingCode({ control: true });
		w.clock.now += 10 * MINUTE;
		expect((await w.status()).sessionControl.armed).toBe(false);
	});

	it("a new terminal `control` makes a NEW grant: a new id, a new end, a new budget, never an extension", async () => {
		const w = setup({ maxSends: 5 });
		const first = await w.pair(true);
		await w.prompt(first, "a");
		await settle(5);
		w.clock.now += 20 * MINUTE;
		const second = await w.pair(true);
		const granted = w.session.records.filter((r) => r.kind === "workbench.session-control-granted");
		expect(granted).toHaveLength(2);
		expect(granted[1]!.payload.grantId).not.toBe(granted[0]!.payload.grantId);
		expect(w.ended()).toEqual(["re-paired"]);
		expect((await w.status(second)).sessionControl).toMatchObject({
			state: "active",
			sendsLeft: 5,
			expiresAtMs: w.clock.now + 30 * MINUTE,
		});
		expect((await w.status(first)).sessionControl.holder).toBe(false);
	});

	it("a grant that cannot be recorded is not issued", async () => {
		const w = setup();
		w.session.failRecording = true;
		const grant = await w.pair(true);
		w.session.failRecording = false;
		expect((await w.status(grant)).sessionControl.state).toBe("none");
		expect((await w.prompt(grant, "x")).body.state).toBe("awaiting-approval");
		expect(w.notices).toEqual([]);
	});
});

describe("8. Concurrency and STOP", () => {
	it("a STOP is sent at once while a steer is still waiting for Pi's reply, in the order requested", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.session.runActive = true;
		const steer = await w.intervene(grant, "steer", "left");
		expect(steer.body.state).toBe("sent");
		const stop = await w.intervene(grant, "stop");
		expect(stop.status).toBe(202);
		expect(stop.body).toMatchObject({ state: "sent", authorizedBy: "session-grant" });
		expect(w.desk.applyCalls).toEqual([steer.body.proposalId, stop.body.proposalId]);
		expect(w.terminal.asked).toEqual([]);
		// Steer and queue are withheld while the stop is pending, as before.
		expect((await w.intervene(grant, "queue", "later")).status).toBe(409);
		w.desk.release(stop.body.proposalId);
		w.desk.release(steer.body.proposalId);
		await settle(5);
		expect((await w.call("GET", `intervention/${stop.body.proposalId}`, null, grant)).body.state).toBe("accepted");
	});

	it("a STOP under the grant does not wait behind a steer that is waiting for the terminal: it supersedes it and is sent", async () => {
		const w = setup({ operations: ["stop"] });
		const grant = await w.pair(true);
		w.session.runActive = true;
		const steer = await w.intervene(grant, "steer", "left");
		const question = await w.terminal.waitFor(1);
		const stop = await w.intervene(grant, "stop");
		expect(stop.status).toBe(202);
		// The steer's phrase, typed in the same instant, is discarded: a superseded request is never sent.
		w.terminal.type(question.phrase);
		await settle(20);
		expect(w.desk.applyCalls).toEqual([stop.body.proposalId]);
		expect(w.terminal.asked).toHaveLength(1);
		expect((await w.call("GET", `intervention/${steer.body.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "superseded-by-stop",
			approved: false,
		});
		expect(
			w.desk.authorizations.map((a) => a.authority.kind === "local-operator" && a.authority.confirmation),
		).toEqual(["session-grant"]);
	});

	it("a STOP under the grant is not held back by a prompt that is waiting for the terminal", async () => {
		const w = setup({ operations: ["stop"] });
		const grant = await w.pair(true);
		await w.prompt(grant, "needs the terminal");
		await w.terminal.waitFor(1);
		// A run opens meanwhile (the only way the two meet).
		w.session.runActive = true;
		const offers = (await w.status(grant)).offers;
		expect(offers.stop.offered).toBe(true);
		// A page WITHOUT the grant's standing is still told to wait, as on main.
		expect((await w.status()).offers.stop.offered).toBe(false);
		const stop = await w.intervene(grant, "stop");
		expect(stop.status).toBe(202);
		expect(w.desk.applyCalls).toEqual([stop.body.proposalId]);
		expect(w.terminal.asked).toHaveLength(1);
	});

	it("many requests at once: each covered one is sent once, in arrival order, and none is asked of the terminal", async () => {
		const w = setup();
		const grant = await w.pair(true);
		w.session.runActive = true;
		w.desk.hold = false;
		const replies = await Promise.all([
			w.intervene(grant, "steer", "one"),
			w.intervene(grant, "queue", "two"),
			w.intervene(grant, "steer", "three"),
			w.intervene(grant, "stop"),
			w.intervene(grant, "steer", "four"),
		]);
		await settle(10);
		// The stop is pending when the last steer arrives, so that one is refused before anything is recorded.
		expect(replies.map((r) => r.status)).toEqual([202, 202, 202, 202, 409]);
		expect(w.desk.applyCalls).toEqual(replies.slice(0, 4).map((r) => r.body.proposalId));
		expect(w.terminal.asked).toEqual([]);
	});

	it("a second prompt while one is being sent is refused, not queued behind it", async () => {
		const w = setup();
		const grant = await w.pair(true);
		let release: (value: string) => void = () => {};
		w.session.promptResult = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const first = await w.prompt(grant, "one");
		expect(first.body.state).toBe("dispatching");
		expect((await w.prompt(grant, "two")).status).toBe(409);
		release("started");
		await settle(5);
		expect(w.session.promptCalls).toEqual(["one"]);
	});
});

describe("9. A compromised page cannot widen its authority", () => {
	it("no member of a request selects a mode, a scope or a lifetime: an unknown member refuses the request whole", async () => {
		const w = setup({ operations: ["prompt"], maxSends: 2 });
		const grant = await w.pair(true);
		for (const extra of [
			{ mode: "everyday" },
			{ sessionControl: true },
			{ authorizedBy: "terminal" },
			{ operations: ["stop"] },
			{ expiresAtMs: 9e15 },
			{ confirmation: "terminal" },
			{ grant },
		])
			expect((await w.prompt(grant, "x", extra)).status, JSON.stringify(extra)).toBe(400);
		w.session.runActive = true;
		expect((await w.intervene(grant, "stop", undefined, { authorizedBy: "session-grant" })).status).toBe(400);
		expect((await w.intervene(grant, "approve")).status).toBe(400);
		expect(w.session.promptCalls).toEqual([]);
		expect(w.desk.applyCalls).toEqual([]);
		expect((await w.status(grant)).sessionControl).toMatchObject({ operations: ["prompt"], sendsLeft: 2 });
	});

	it("no route issues, arms, extends or describes a grant", async () => {
		const w = setup();
		const grant = await w.pair(false);
		for (const route of [
			"session-control",
			"session-control/grant",
			"session-control/arm",
			"session-control/extend",
			"session-control/renew",
			"session-control/issue",
			"mode",
			"mode/everyday",
			"control",
		]) {
			expect((await w.call("POST", route, {}, grant)).status, route).toBe(404);
			expect((await w.call("GET", route, null, grant)).status, route).toBe(404);
		}
		// Asking for control while pairing changes nothing: the code decides, and this one was plain.
		const plain = w.broker.issuePairingCode();
		const token = (await w.call("POST", "pair", { code: plain.code, control: true, mode: "everyday" })).body
			.grant as string;
		expect((await w.status(token)).sessionControl.state).toBe("none");
		expect((await w.call("POST", "session-control/revoke", {}, token)).status).toBe(409);
		expect(w.kinds()).toEqual([]);
	});

	it("only the holder is told the scope, and only the holder's requests are covered", async () => {
		const w = setup();
		const grant = await w.pair(true);
		const anonymous = await w.status();
		expect(anonymous.sessionControl).toMatchObject({
			state: "active",
			holder: false,
			grantId: null,
			operations: [],
			sendsLeft: null,
			workspaceRoot: null,
		});
		expect(JSON.stringify(anonymous)).not.toContain(WORKSPACE);
		for (const token of [null, "", "x".repeat(43), `${grant}x`, grant.slice(0, -1)])
			expect((await w.call("POST", "prompt/propose", { message: "x" }, token)).status, String(token)).toBe(401);
		expect((await w.call("POST", "session-control/revoke", {}, null)).status).toBe(401);
		expect(w.session.promptCalls).toEqual([]);
		expect((await w.status(grant)).sessionControl.state).toBe("active");
	});

	it("the grant's own holder check is exact (the contract)", () => {
		const control = new EndoSessionControlV0({
			mode: "everyday",
			protection: new Boundary(),
			now: () => 1000,
			subject: () => ({
				launchId: "a".repeat(16),
				session: SESSION,
				attachment: "pi.default",
				workspaceRoot: WORKSPACE,
			}),
			closed: () => false,
			onGranted: () => true,
			onEnded: () => {},
		});
		control.arm(2000);
		control.paired("the-holder-token");
		for (const token of [null, "", "the-holder-toke", "the-holder-token ", "THE-HOLDER-TOKEN", "another-token-xx"]) {
			expect(control.covers(token, "prompt"), String(token)).toBe(false);
			expect(control.authorize(token, "prompt"), String(token)).toBeNull();
			expect(control.relinquish(token), String(token)).toBe(false);
		}
		expect(control.covers("the-holder-token", "prompt")).toBe(true);
		expect(control.view("another-token-xx").control).toMatchObject({
			holder: false,
			workspaceRoot: null,
			grantId: null,
		});
		expect(() => new EndoSessionControlV0({ ...({} as any), mode: "root" })).toThrow("unknown workbench mode");
		expect(
			() =>
				new EndoSessionControlV0({
					mode: "everyday",
					operations: ["prompt", "attempt" as never],
					now: () => 0,
					subject: () => ({ launchId: "", session: null, attachment: "", workspaceRoot: "" }),
					closed: () => false,
					onGranted: () => true,
					onEnded: () => {},
				}),
		).toThrow("covers only prompt, steer, queue and stop");
	});
});

describe("10. No boundary, a lost boundary, a privileged host: fails closed", () => {
	it("issues nothing when the boundary is absent, unknown, unreadable, malformed, too weak, or around something else", async () => {
		const cases: [string, (b: Boundary) => void, EndoWorkbenchModeV0?][] = [
			["unknown", change({ state: "unknown" })],
			["not enforced", change({ state: "not-enforced" })],
			["throws", unreadable],
			["level none", change({ level: "none" })],
			["no mechanism", change({ mechanism: null })],
			["another session", change({ session: "endo.session.pi.other" })],
			["no session", change({ session: null })],
			["another workspace", change({ workspaceRoot: "/elsewhere" })],
			["malformed", replace({ state: "enforced" } as never)],
			["a truthy lie", change({ state: "yes" as never })],
			["workspace level under Protected", () => {}, "protected"],
		];
		for (const [name, weaken, mode] of cases) {
			const boundary = new Boundary();
			weaken(boundary);
			const w = setup({ boundary, ...(mode === undefined ? {} : { mode }) });
			const issued = w.broker.issuePairingCode({ control: true });
			expect(issued.control, name).toBeNull();
			expect(issued.refused, name).toEqual(expect.any(String));
			const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
			const status = await w.status(grant);
			expect(status.mode.effective, name).toBe("strict");
			expect(status.sessionControl.state, name).toBe("none");
			expect((await w.prompt(grant, "x")).body.state, name).toBe("awaiting-approval");
			expect(w.session.promptCalls, name).toEqual([]);
			expect(w.kinds(), name).toEqual(["workbench.prompt-proposed"]);
		}
		const none = setup({ boundary: null });
		expect(none.broker.issuePairingCode({ control: true }).refused).toBe(
			"No execution boundary is configured for this launch.",
		);
	});

	it("Protected is in effect only at the restricted level", async () => {
		const boundary = new Boundary();
		boundary.status = { ...boundary.status, level: "restricted" };
		const w = setup({ boundary, mode: "protected" });
		const grant = await w.pair(true);
		expect((await w.status(grant)).mode).toMatchObject({ requested: "protected", effective: "protected" });
		expect(w.session.records[0]!.payload).toMatchObject({ mode: "protected", protection: { level: "restricted" } });
		boundary.status = { ...boundary.status, level: "workspace" };
		expect((await w.prompt(grant, "x")).body.state).toBe("awaiting-approval");
		expect(w.ended()).toEqual(["protection-lost"]);
	});

	it("a boundary that is lost mid-session ends the grant at the next use, before anything is sent, for every operation", async () => {
		for (const lose of [change({ state: "not-enforced" }), unreadable, change({ level: "none" })]) {
			const w = setup();
			const grant = await w.pair(true);
			w.session.runActive = true;
			await w.intervene(grant, "steer", "ok");
			expect(w.desk.applyCalls).toHaveLength(1);
			lose(w.boundary!);
			const stop = await w.intervene(grant, "stop");
			expect(stop.body.state).toBe("awaiting-approval");
			expect(w.desk.applyCalls).toHaveLength(1);
			expect(w.ended()).toEqual(["protection-lost"]);
			expect((await w.status(grant)).mode.effective).toBe("strict");
			// The boundary coming back does not bring the grant back.
			w.boundary!.throws = false;
			w.boundary!.status = new Boundary().status;
			expect((await w.status(grant)).sessionControl).toMatchObject({ state: "none", ended: "protection-lost" });
		}
	});

	it("the boundary is observed again at every use, not remembered from the issue", async () => {
		const w = setup();
		const grant = await w.pair(true);
		const before = w.boundary!.observations;
		await w.prompt(grant, "a");
		await settle(5);
		expect(w.boundary!.observations).toBeGreaterThan(before);
	});

	it("the observation is accepted only when well formed, and holds only for the exact subject", () => {
		const good = new Boundary().status;
		expect(endoObserveProtectionV0(undefined).state).toBe("not-enforced");
		expect(endoObserveProtectionV0({ observe: () => good })).toEqual(good);
		expect(endoObserveProtectionV0({ observe: () => null as never }).state).toBe("unknown");
		expect(endoObserveProtectionV0({ observe: () => ({ ...good, limitations: "none" as never }) }).state).toBe(
			"unknown",
		);
		expect(endoObserveProtectionV0({ observe: () => ({ ...good, level: "total" as never }) }).state).toBe("unknown");
		const flood = endoObserveProtectionV0({
			observe: () => ({
				...good,
				state: "not-enforced",
				limitations: Array.from({ length: 50 }, () => "x".repeat(5000)),
			}),
		});
		expect(flood.limitations).toHaveLength(8);
		expect(flood.limitations[0]).toHaveLength(300);
		const subject = { session: SESSION, workspaceRoot: WORKSPACE };
		expect(endoProtectionHoldsV0(good, "workspace", subject)).toBe(true);
		expect(endoProtectionHoldsV0(good, "restricted", subject)).toBe(false);
		expect(endoProtectionHoldsV0(good, "none", subject)).toBe(false);
		expect(endoProtectionHoldsV0({ ...good, level: "restricted" }, "workspace", subject)).toBe(true);
		expect(endoProtectionHoldsV0(good, "workspace", { ...subject, workspaceRoot: `${WORKSPACE}/` })).toBe(false);
	});

	it("the production provider never reports an enforced boundary, on any host, and says what it found", () => {
		const hosts = [
			{ uid: () => 1000, writable: () => false, read: () => null },
			{ uid: () => 1000, writable: (p: string) => p === "/run/docker.sock", read: () => "1\n" },
			{ uid: () => 0, writable: () => true, read: () => "0\n" },
			{ uid: () => null, writable: () => false, read: () => null },
		];
		for (const facts of hosts) {
			const status = hostExecutionProtectionV0(facts).observe();
			expect(status).toMatchObject({ state: "not-enforced", level: "none", mechanism: null, session: null });
			expect(status.limitations[0]).toContain("Pi is not placed inside an execution boundary by this build");
		}
		const privileged = hostExecutionLimitationsV0(hosts[1]!);
		expect(privileged.join("\n")).toContain("the Docker daemon's socket (/run/docker.sock)");
		expect(privileged.join("\n")).toContain("a route to root");
		expect(privileged.join("\n")).toContain("dev.tty.legacy_tiocsti=1");
		const root = hostExecutionLimitationsV0(hosts[2]!);
		expect(root.join("\n")).toContain("This process is root");
		expect(root.join("\n")).toContain("the system libvirt socket");
		expect(root.filter((line) => line.includes("Docker"))).toHaveLength(1);
		expect(hostExecutionLimitationsV0(hosts[0]!)).toHaveLength(1);
		// With the real provider wired in, an Everyday launch is Strict.
		const w = setup({ boundary: hostExecutionProtectionV0() as Boundary });
		expect(w.broker.issuePairingCode({ control: true }).control).toBeNull();
		expect(w.broker.sessionControl().mode).toMatchObject({ requested: "everyday", effective: "strict" });
	});
});

describe("12. Evidence and privacy", () => {
	it("records no prompt text, path, pairing code or token, and claims nothing it did not see", async () => {
		const w = setup();
		const issued = w.broker.issuePairingCode({ control: true });
		const grant = (await w.call("POST", "pair", { code: issued.code })).body.grant as string;
		await w.prompt(grant, `do it ${SECRET}`);
		await settle(5);
		w.session.runActive = true;
		w.desk.hold = false;
		await w.intervene(grant, "steer", `steer ${SECRET}`);
		await w.intervene(grant, "stop");
		await settle(5);
		w.broker.revokeSessionControl();
		const everything = JSON.stringify([w.session.records, w.desk.authorizations, w.desk.refusals]);
		for (const forbidden of [SECRET, WORKSPACE, "CANARY", grant, issued.code, "verified", "approved by the operator"])
			expect(everything).not.toContain(forbidden);
		const granted = w.session.records[0]!.payload;
		expect(Object.keys(granted).sort()).toEqual([
			"attachment",
			"confirmation",
			"expiresAt",
			"grantId",
			"issuedAt",
			"launchId",
			"maxSends",
			"mode",
			"operations",
			"protection",
			"schemaVersion",
			"session",
			"workspace",
		]);
		expect(granted).toMatchObject({
			session: SESSION,
			attachment: "pi.default",
			launchId: w.broker.launchId,
			mode: "everyday",
			operations: ["prompt", "steer", "queue", "stop"],
			protection: { level: "workspace", mechanism: "test-stand-in.v0" },
			confirmation: "terminal-pairing-code",
			maxSends: 200,
		});
		expect(granted.workspace).toMatchObject({
			algorithm: "hmac-sha256",
			value: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(w.session.records.at(-1)!.payload).toMatchObject({ reason: "revoked-on-terminal", sends: 3 });
		// The statuses a page reads carry no text either; and the unpaired one no scope.
		expect(JSON.stringify(await w.status(grant))).not.toContain(SECRET);
		expect(JSON.stringify(await w.status())).not.toContain(grant);
	});

	it("the record schema is closed: a grant-authorised send names its grant, a typed one names none, and nothing free-form fits", () => {
		const proposalId = `endo.evidence.workbench-prompt-${"a".repeat(32)}`;
		const grantId = `endo.evidence.workbench-session-grant-${"b".repeat(32)}`;
		const authorized = (extra: Record<string, unknown>) =>
			endoWorkbenchPayloadProblemV0("workbench.prompt-authorized", {
				schemaVersion: ENDO_WORKBENCH_SCHEMA_V0,
				proposalId,
				proposalDigest: "c".repeat(64),
				decision: "allow",
				decidedAt: "2026-11-16T00:00:00.000Z",
				...extra,
			} as never);
		expect(authorized({ confirmation: "terminal" })).toBeNull();
		expect(authorized({ confirmation: "terminal-code" })).toBeNull();
		expect(authorized({ confirmation: "session-grant", sessionGrant: grantId })).toBeNull();
		expect(authorized({ confirmation: "session-grant" })).toBe("unexpected members");
		expect(authorized({ confirmation: "session-grant", sessionGrant: "anything" })).toContain(
			"sessionGrant must name",
		);
		expect(authorized({ confirmation: "session-grant", sessionGrant: grantId, decision: "deny" })).toBe(
			"a session grant only allows",
		);
		expect(authorized({ confirmation: "terminal", sessionGrant: grantId })).toBe("unexpected members");
		expect(authorized({ confirmation: "browser" })).toContain("confirmation must be");
		const granted = {
			schemaVersion: ENDO_WORKBENCH_SCHEMA_V0,
			grantId,
			session: SESSION,
			attachment: "pi.default",
			launchId: "0123456789abcdef",
			mode: "everyday",
			operations: ["prompt", "stop"],
			workspace: { algorithm: "hmac-sha256", keyId: "k", value: "d".repeat(64) },
			protection: { level: "workspace", mechanism: "some-sandbox.v0" },
			confirmation: "terminal-pairing-code",
			issuedAt: "2026-11-16T00:00:00.000Z",
			expiresAt: "2026-11-16T00:30:00.000Z",
			maxSends: 200,
		};
		const problem = (change: Record<string, unknown>) =>
			endoWorkbenchPayloadProblemV0("workbench.session-control-granted", { ...granted, ...change } as never);
		expect(problem({})).toBeNull();
		expect(problem({ workspace: "/home/operator/project" })).toBe("workspace must be a keyed digest");
		expect(problem({ workspaceRoot: "/home/operator/project" })).toBe("unexpected members");
		expect(problem({ mode: "strict" })).toContain("mode must be");
		expect(problem({ operations: ["prompt", "attempt"] })).toContain("operations must be");
		expect(problem({ operations: ["prompt", "prompt"] })).toContain("operations must be");
		expect(problem({ operations: [] })).toContain("operations must be");
		expect(problem({ protection: { level: "none", mechanism: "x" } })).toContain("protection must name");
		expect(problem({ protection: { level: "workspace", mechanism: "Free text here" } })).toContain(
			"protection must name",
		);
		expect(problem({ confirmation: "browser" })).toContain("confirmation must be");
		expect(problem({ expiresAt: "2026-11-17T00:00:00.000Z" })).toBe("a grant lives at most one hour");
		expect(problem({ expiresAt: "2026-11-15T00:00:00.000Z" })).toBe("a grant lives at most one hour");
		expect(problem({ maxSends: 0 })).toContain("maxSends");
		const ended = (change: Record<string, unknown>) =>
			endoWorkbenchPayloadProblemV0("workbench.session-control-ended", {
				schemaVersion: ENDO_WORKBENCH_SCHEMA_V0,
				grantId,
				reason: "expired",
				sends: 3,
				endedAt: "2026-11-16T00:30:00.000Z",
				...change,
			} as never);
		expect(ended({})).toBeNull();
		expect(ended({ reason: "because" })).toBe("unknown end reason");
		expect(ended({ note: "free text" })).toBe("unexpected members");
		expect([...ENDO_WORKBENCH_GRANT_END_REASONS_V0]).toEqual([...ENDO_SESSION_CONTROL_END_REASONS_V0]);
	});
});
