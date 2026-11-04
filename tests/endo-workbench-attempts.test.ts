// Sending a prepared work attempt through the live workbench (docs/designs/develop-attempt-execution.md).
//
// Part 1, the broker with a stand-in session and REAL attempt and task stores: the request is the terminal's only (no page route, no grant),
// the approval is bound to the exact brief under its own phrase, the authorisation record is written after the approval and BEFORE the send
// is recorded, and every refusal, change and race in between sends nothing.
//
// Part 2, the broker over a REAL attachment to the fake Pi (a real child process speaking Pi's RPC) and a real event store: the relation
// from the attempt to the session is recovered later, from the files alone, by a reader that is not the process that sent it; including
// after Pi never answered, and after Pi exited on the prompt. No provider, no model, no network.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { endoDevelopServiceV0, endoSessionLogV0 } from "../cli/develop-service.ts";
import type { EndoDevelopAttemptAuthorizationV0 } from "../protocol/develop-attempt-execution.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoWorkbenchKindV0 } from "../protocol/workbench.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { readAttempts } from "../studio-ui/src/model/attempts-wire.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { Approval, FakeSession, settle } from "./workbench-fixtures.ts";

const KEY = endoDigestKeyV0(Buffer.alloc(32, 9), "workbench-attempt-test");
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};

/** A store with a project registered at `cwd`, its selected task, and one prepared attempt. */
function store(root: string, cwd: string) {
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name: "demo", path: cwd, observedGitRoot: null }));
	const t = ok(tasks.createTask(p.id, { title: "Fix parser", acceptance: "npm test passes" }, { select: true }));
	const attempts = new DevelopAttemptsStoreV0(root);
	const service = new DevelopAttemptsServiceV0(tasks, attempts);
	const attempt = ok(service.prepare(p.id, t.id, { objective: "Accept trailing commas" }));
	const dispatch = new DevelopAttemptDispatchV0(tasks, attempts, { projectId: p.id, launchDirectory: cwd });
	return { tasks, attempts, service, dispatch, projectId: p.id, taskId: t.id, attempt };
}
const authorizedFile = (root: string, id: string) => join(root, "develop", "attempts", `${id}.authorized.json`);
const authorizedOf = (root: string, id: string): EndoDevelopAttemptAuthorizationV0 =>
	JSON.parse(readFileSync(authorizedFile(root, id), "utf8"));

/** A stand-in session that notes, at the moment the send is recorded, whether the attempt's authorisation was already on disk. */
class OrderedSession extends FakeSession {
	boundWhenDispatched: boolean | null = null;
	failOn: EndoWorkbenchKindV0 | null = null;
	watch: string | null = null;
	override recordWorkbench(
		kind: EndoWorkbenchKindV0,
		payload: Parameters<FakeSession["recordWorkbench"]>[1],
		from?: readonly string[],
	) {
		if (kind === this.failOn) throw new TypeError("the session attachment is not recording");
		if (kind === "workbench.prompt-dispatched" && this.watch !== null)
			this.boundWhenDispatched = existsSync(this.watch);
		return super.recordWorkbench(kind, payload, from);
	}
}

function fakeBroker(options: { attempts?: boolean } = {}) {
	const root = temp("endo-wba-");
	const cwd = temp("endo-wba-cwd-");
	const s = store(root, cwd);
	const session = new OrderedSession();
	session.watch = authorizedFile(root, s.attempt.id);
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: KEY,
		attachment: "pi.default",
		approver: approval.approver,
		...(options.attempts === false ? {} : { attempts: s.dispatch }),
	});
	cleanup.push(() => broker.dispose());
	const call = (method: "GET" | "POST", route: string, body: unknown = null, grant: string | null = null) =>
		broker.handle({ method, route: route.split("/"), query: "", grant, body });
	return { root, cwd, ...s, session, approval, broker, call };
}

describe("the broker: an attempt is requested on the terminal and approved as itself", () => {
	it("approved: the authorisation is written after the approval and before the send is recorded, then the brief is sent once", async () => {
		const w = fakeBroker();
		const asked = w.broker.requestAttempt(w.attempt.id);
		expect(asked.ok).toBe(true);
		const request = await w.approval.waitForRequest();
		const brief = renderEndoDevelopBriefV0(w.attempt);
		expect(request).toMatchObject({
			operation: "attempt",
			message: brief,
			attempt: { attemptId: w.attempt.id, taskId: w.taskId, taskRevision: 0, preparedOnRevision: 0 },
		});
		expect(request.phrase).toMatch(/^APPROVE ATTEMPT [0-9a-f]{16}$/);
		// Asking sends nothing and binds nothing.
		expect(w.session.promptCalls).toEqual([]);
		expect(existsSync(authorizedFile(w.root, w.attempt.id))).toBe(false);
		w.approval.answer("allow");
		await settle(30);
		expect(w.session.promptCalls).toEqual([brief]);
		expect(w.session.boundWhenDispatched).toBe(true);
		expect(w.session.records.map((r) => r.kind)).toEqual([
			"workbench.prompt-proposed",
			"workbench.prompt-authorized",
			"workbench.prompt-dispatched",
			"workbench.prompt-accepted",
		]);
		const rec = authorizedOf(w.root, w.attempt.id);
		const [proposed, authorized] = w.session.records;
		expect(rec).toMatchObject({
			attemptId: w.attempt.id,
			session: "endo.session.pi.fake-session-1",
			attachment: "pi.default",
			launchId: w.broker.launchId,
			proposalId: proposed!.payload.proposalId,
			proposalDigest: proposed!.payload.proposalDigest,
			message: proposed!.payload.message,
			authorizationEventId: authorized!.id,
			approvedBy: "operator",
			via: "workbench-terminal",
		});
		// The attempt cannot be sent again: retrying is preparing another attempt.
		expect(w.broker.requestAttempt(w.attempt.id)).toMatchObject({ ok: false, code: "already-authorized" });
		// The task file was not written, and the attempt's own notes are unchanged: sending is not an outcome.
		expect(ok(w.service.get(w.attempt.id)).state).toBe("prepared");
	});

	it("declined, withdrawn, timed out or superseded by the session ending: nothing is bound and nothing is sent", async () => {
		for (const ending of ["deny", "withdraw", "timeout", "session-ends"] as const) {
			const w = fakeBroker();
			const asked = w.broker.requestAttempt(w.attempt.id);
			if (!asked.ok) throw new Error(asked.code);
			await w.approval.waitForRequest();
			if (ending === "deny") w.approval.answer("deny");
			else if (ending === "timeout") w.approval.answer(null);
			else if (ending === "withdraw") {
				const pair = await w.call("POST", "pair", { code: w.broker.issuePairingCode().code });
				await w.call("POST", "prompt/discard", { proposalId: asked.view.proposalId }, (pair.body as any).grant);
			} else {
				w.session.live = false;
				w.broker.endSession();
			}
			const view = await w.broker.settled(asked.view.proposalId);
			expect(view?.state, ending).toBe("refused");
			expect(w.session.promptCalls, ending).toEqual([]);
			expect(existsSync(authorizedFile(w.root, w.attempt.id)), ending).toBe(false);
			expect(w.broker.attemptBindingOf(asked.view.proposalId), ending).toEqual({ bound: false, refusal: null });
			// The attempt stays sendable after a decline: nothing ambiguous happened.
			if (ending !== "session-ends") expect(w.dispatch.check(w.attempt.id).ok, ending).toBe(true);
		}
	});

	it("a change while the operator read the brief, or another workbench binding it first, refuses at the moment of sending", async () => {
		const changed = fakeBroker();
		const a = changed.broker.requestAttempt(changed.attempt.id);
		if (!a.ok) throw new Error(a.code);
		await changed.approval.waitForRequest();
		ok(changed.tasks.updateTask(changed.projectId, changed.taskId, 0, { acceptance: "something else" }));
		changed.approval.answer("allow");
		const v = await changed.broker.settled(a.view.proposalId);
		expect(v).toMatchObject({ state: "refused", reason: "attempt-changed", approved: true });
		expect(changed.broker.attemptBindingOf(a.view.proposalId)).toEqual({
			bound: false,
			refusal: "task-words-changed",
		});
		expect(changed.session.promptCalls).toEqual([]);
		expect(existsSync(authorizedFile(changed.root, changed.attempt.id))).toBe(false);

		const raced = fakeBroker();
		const b = raced.broker.requestAttempt(raced.attempt.id);
		if (!b.ok) throw new Error(b.code);
		await raced.approval.waitForRequest();
		// Another workbench on the same store binds the same attempt while this one waits for its operator.
		const other = new DevelopAttemptDispatchV0(
			new DevelopTasksStoreV0(raced.root),
			new DevelopAttemptsStoreV0(raced.root),
			{
				projectId: raced.projectId,
				launchDirectory: raced.cwd,
			},
		);
		const theirs = ok(
			other.authorize(ok(other.check(raced.attempt.id)), {
				session: "endo.session.pi.another",
				attachment: "pi.default",
				launchId: "aaaaaaaaaaaaaaaa",
				proposalId: `endo.evidence.workbench-prompt-${"b".repeat(32)}`,
				proposalDigest: "b".repeat(64),
				authorizationEventId: "endo.event.other-1",
				message: { digest: { algorithm: "hmac-sha256", keyId: "k", value: "c".repeat(64) }, bytes: 10 },
			}),
		);
		const theirBytes = readFileSync(authorizedFile(raced.root, raced.attempt.id));
		raced.approval.answer("allow");
		expect(await raced.broker.settled(b.view.proposalId)).toMatchObject({ state: "refused", reason: "duplicate" });
		expect(raced.session.promptCalls).toEqual([]);
		expect(readFileSync(authorizedFile(raced.root, raced.attempt.id))).toEqual(theirBytes);
		expect(theirs.session).toBe("endo.session.pi.another");
	});

	it("a substituted session, an expired approval or an open run refuses before binding", async () => {
		const swapped = fakeBroker();
		const a = swapped.broker.requestAttempt(swapped.attempt.id);
		if (!a.ok) throw new Error(a.code);
		await swapped.approval.waitForRequest();
		swapped.session.piSessionId = "another-session";
		swapped.approval.answer("allow");
		expect(await swapped.broker.settled(a.view.proposalId)).toMatchObject({
			state: "refused",
			reason: "session-ended",
		});
		expect(existsSync(authorizedFile(swapped.root, swapped.attempt.id))).toBe(false);

		const busy = fakeBroker();
		const b = busy.broker.requestAttempt(busy.attempt.id);
		if (!b.ok) throw new Error(b.code);
		await busy.approval.waitForRequest();
		busy.session.runActive = true;
		busy.approval.answer("allow");
		expect(await busy.broker.settled(b.view.proposalId)).toMatchObject({ state: "refused", reason: "run-active" });
		expect(existsSync(authorizedFile(busy.root, busy.attempt.id))).toBe(false);
		expect(busy.session.promptCalls).toEqual([]);
	});

	it("once bound, a failure to record the send or a lost reply is never 'not sent' and is never retried", async () => {
		const failing = fakeBroker();
		failing.session.failOn = "workbench.prompt-dispatched";
		const a = failing.broker.requestAttempt(failing.attempt.id);
		if (!a.ok) throw new Error(a.code);
		await failing.approval.waitForRequest();
		failing.approval.answer("allow");
		await failing.broker.settled(a.view.proposalId);
		// Nothing was sent (the send is recorded first), and the attempt is bound: it is not sendable again.
		expect(failing.session.promptCalls).toEqual([]);
		expect(failing.broker.attemptBindingOf(a.view.proposalId)).toEqual({ bound: true, refusal: null });
		expect(failing.dispatch.check(failing.attempt.id)).toEqual({ ok: false, code: "already-authorized" });

		const lost = fakeBroker();
		lost.session.promptResult = () => Promise.reject(new Error("connection lost"));
		const b = lost.broker.requestAttempt(lost.attempt.id);
		if (!b.ok) throw new Error(b.code);
		await lost.approval.waitForRequest();
		lost.approval.answer("allow");
		expect(await lost.broker.settled(b.view.proposalId)).toMatchObject({ state: "unknown" });
		expect(lost.session.promptCalls).toHaveLength(1);
		await settle(50);
		expect(lost.session.promptCalls).toHaveLength(1); // no retry
		expect(lost.broker.requestAttempt(lost.attempt.id)).toMatchObject({ ok: false, code: "already-authorized" });
	});

	it("only the terminal can request one: no page route takes an attempt, and without --project nothing can", async () => {
		const w = fakeBroker();
		const pair = await w.call("POST", "pair", { code: w.broker.issuePairingCode().code });
		const grant = (pair.body as { grant: string }).grant;
		expect((await w.call("POST", "prompt/propose", { attemptId: w.attempt.id }, grant)).status).toBe(400);
		expect((await w.call("POST", "prompt/propose", { message: "x", attemptId: w.attempt.id }, grant)).status).toBe(
			400,
		);
		for (const route of [
			"attempt/propose",
			"attempt",
			`attempt/${w.attempt.id}`,
			"workspace/attempts/send",
			"prompt/attempt",
		])
			expect((await w.call("POST", route, { attemptId: w.attempt.id }, grant)).status, route).toBe(404);
		expect(w.approval.requests).toEqual([]);
		expect(existsSync(authorizedFile(w.root, w.attempt.id))).toBe(false);

		const none = fakeBroker({ attempts: false });
		expect(none.broker.requestAttempt(none.attempt.id)).toMatchObject({ ok: false, code: "not-configured" });
		// The check's own refusals pass through, and an attempt waits its turn behind another request.
		expect(w.broker.requestAttempt("endo.attempt.0000")).toMatchObject({ ok: false, code: "bad-request" });
		const first = w.broker.requestAttempt(w.attempt.id);
		expect(first.ok).toBe(true);
		const second = ok(w.service.prepare(w.projectId, w.taskId, { objective: "Another" }));
		expect(w.broker.requestAttempt(second.id)).toMatchObject({ ok: false, code: "not-offered" });
	});
});

describe("over a real attachment to the fake Pi and a real event store", () => {
	async function attached(scenario = "") {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-wba-real-");
		const cwd = temp("endo-wba-real-cwd-");
		const s = store(root, cwd);
		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "20" }),
			requestTimeoutMs: 3_000,
			digestKey: KEY,
		});
		await pi.checkLocal();
		install.setScenario(scenario);
		const session = await pi.openSession();
		let closed = false;
		const close = async () => {
			if (!closed) {
				closed = true;
				await session.close();
			}
		};
		cleanup.push(close);
		const approval = new Approval();
		const broker = new WorkbenchBrokerV0({
			session,
			key: KEY,
			attachment: session.owner.attachment,
			approver: approval.approver,
			attempts: s.dispatch,
		});
		cleanup.push(() => broker.dispose());
		/** A reader in another "process": new store objects over the same files, the log opened read-only. */
		const reread = () =>
			ok(
				new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root), {
					sessionLog: () => endoSessionLogV0(root),
				}).get(s.attempt.id),
			);
		return { root, cwd, ...s, session, approval, broker, close, reread };
	}

	it("sends the brief, and later, from the files alone, the attempt reads as sent, acknowledged, and run to completion", async () => {
		const w = await attached();
		const asked = w.broker.requestAttempt(w.attempt.id);
		if (!asked.ok) throw new Error(asked.code);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		expect(await w.broker.settled(asked.view.proposalId)).toMatchObject({
			state: "accepted",
			disposition: "started",
		});
		expect(await w.session.waitForSettled(15_000)).toBe(true);
		await w.broker.dispose();
		await w.close();
		const r = w.reread();
		expect(r.execution).toMatchObject({
			send: "runtime-accepted",
			disposition: "started",
			run: "completed",
			evidence: "complete",
			brief: "matches",
		});
		expect(r.authorized?.session).toMatch(/^endo\.session\.pi\./);
		// What the record is NOT: a handoff, an outcome, a receipt or a change to the task.
		expect([r.state, r.handoff, r.outcome]).toEqual(["prepared", null, null]);
		const tasks = w.tasks.read();
		if (!tasks.ok) throw new Error("task file unreadable");
		expect(tasks.file.tasks.map((t) => [t.id, t.status])).toEqual([[w.taskId, "open"]]);
		// What `endo workspace open` serves for this task later, with no Pi and no session of its own: the same reading, by alias.
		const host = endoDevelopServiceV0(w.root).forLaunch(
			{ projectId: w.projectId, launchDirectory: w.cwd },
			{ launchId: "0123456789abcdef", attachment: "pi.default", session: null, aliasOf: () => "session-alias" },
		);
		const shown = (await host.attemptsView())?.attempts.find((a) => a.id === w.attempt.id);
		expect(shown?.execution).toMatchObject({ send: "runtime-accepted", run: "completed", session: "session-alias" });
		expect(readAttempts(JSON.parse(JSON.stringify(await host.attemptsView())))).not.toBeNull();
		// The brief's text is in no event: only its keyed digest.
		const log = readFileSync(join(w.root, "events", "events.log"), "utf8");
		expect(log).not.toContain("Accept trailing commas");
	});

	it("Pi never answers the prompt: after the process is gone the attempt reads as sent with the outcome unknown", async () => {
		const w = await attached("hang-on:prompt");
		const asked = w.broker.requestAttempt(w.attempt.id);
		if (!asked.ok) throw new Error(asked.code);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		// Mid-flight, from another reader: bound and sent, no reply yet.
		for (let i = 0; i < 100 && w.reread().execution?.send !== "sent-no-reply"; i++) await settle(20);
		expect(w.reread().execution).toMatchObject({ send: "sent-no-reply", run: "not-observed" });
		const view = await w.broker.settled(asked.view.proposalId);
		expect(view?.state).toBe("unknown");
		await w.broker.dispose();
		await w.close();
		const r = w.reread();
		expect(r.execution?.send).toBe("sent-no-reply");
		expect(r.execution?.run).toBe("process-ended");
		// Never retried, and never sendable again without a new attempt.
		expect(w.dispatch.check(w.attempt.id)).toEqual({ ok: false, code: "already-authorized" });
	});

	it("Pi exits on the prompt: the record survives the process, and nothing claims the run happened", async () => {
		const w = await attached("exit-on:prompt");
		const asked = w.broker.requestAttempt(w.attempt.id);
		if (!asked.ok) throw new Error(asked.code);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		await w.broker.settled(asked.view.proposalId);
		await w.broker.dispose();
		await w.close();
		const r = w.reread();
		expect(r.execution?.send).toBe("sent-no-reply");
		expect(r.execution?.run).toBe("process-ended");
		expect(readdirSync(join(w.root, "develop", "attempts")).sort()).toEqual(
			[`${w.attempt.id}.authorized.json`, `${w.attempt.id}.prepared.json`].sort(),
		);
	});

	it("a log cut at the dispatch boundary reads as not sent before it and unknown after it", async () => {
		const w = await attached();
		const asked = w.broker.requestAttempt(w.attempt.id);
		if (!asked.ok) throw new Error(asked.code);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		await w.broker.settled(asked.view.proposalId);
		await w.session.waitForSettled(15_000);
		await w.broker.dispose();
		await w.close();
		const whole = endoSessionLogV0(w.root);
		if (whole.state === "unavailable") throw new Error("no log");
		const events = whole.events as EndoEventV0[];
		const at = events.findIndex((e) => e.kind === "workbench.prompt-dispatched");
		const service = (cut: EndoEventV0[]) =>
			ok(
				new DevelopAttemptsServiceV0(w.tasks, w.attempts, {
					sessionLog: () => ({ state: "complete", events: cut }),
				}).get(w.attempt.id),
			).execution?.send;
		// As if the attached process had died just before recording the send, or just after.
		expect(service(events.slice(0, at))).toBe("no-send-recorded");
		expect(service(events.slice(0, at + 1))).toBe("sent-no-reply");
	});
});
