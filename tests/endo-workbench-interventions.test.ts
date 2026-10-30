// STEER, QUEUE and STOP through the workbench broker (adapters/pi/workbench-interventions.ts), at the broker's boundary: what is offered
// and why not, the terminal approval, each state kept apart, and the lifecycle (duplicates, a held reply, a withdrawn or expired approval,
// a replaced grant, the close). The desk is a controllable stand-in with the real desk's shape; the real desk, against a fake Pi and a real
// pseudo-terminal, is exercised in endo-workbench-interventions-live.test.ts.
import { describe, expect, it } from "vitest";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeDesk, FakeSession, settle } from "./workbench-fixtures.ts";

const SECRET = "CANARY-steer-71c4-do-not-record";

function setup(overrides: Partial<ConstructorParameters<typeof WorkbenchBrokerV0>[0]> = {}) {
	const session = new FakeSession();
	session.runActive = true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	let now = 1_000_000;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		now: () => now,
		...overrides,
	});
	const call = (
		method: "GET" | "POST",
		route: string,
		body: unknown = null,
		grant: string | null = null,
		query = "",
	) => broker.handle({ method, route: route.split("/"), query, grant, body });
	const pair = async () =>
		((await call("POST", "pair", { code: broker.issuePairingCode().code })).body as { grant: string }).grant;
	const status = async () => (await call("GET", "status")).body as any;
	return {
		session,
		desk,
		approval,
		broker,
		call,
		pair,
		status,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const propose = (t: ReturnType<typeof setup>, grant: string, operation: string, message?: string) =>
	t.call("POST", "intervention/propose", message === undefined ? { operation } : { operation, message }, grant);

describe("what is offered, and why not", () => {
	it("offers steer, queue and stop only while a run is open, and says why not otherwise", async () => {
		const t = setup();
		expect((await t.status()).offers).toMatchObject({
			steer: { offered: true },
			queue: { offered: true },
			stop: { offered: true },
		});
		t.session.runActive = false;
		const idle = (await t.status()).offers;
		for (const op of ["steer", "queue", "stop"]) {
			expect(idle[op].offered).toBe(false);
			expect(idle[op].reason).toContain("No run is open");
		}
		// A prompt is the converse: only when idle.
		expect(idle.prompt.offered).toBe(true);
		t.session.live = false;
		// A runtime that is no longer running ends the session before anything is answered: nothing is offered after that.
		expect((await t.status()).offers.steer.reason).toContain("has ended");
	});

	it("explains a capability the runtime's evidence does not admit, per operation", async () => {
		const t = setup();
		t.desk.admitted.steer = "steering.steer is not admitted by conformance evidence for this runtime";
		const { offers } = await t.status();
		expect(offers.steer).toEqual({
			offered: false,
			reason: expect.stringContaining("steering.steer is not admitted by conformance evidence"),
		});
		expect(offers.queue.offered).toBe(true);
		const grant = await t.pair();
		const refused = await propose(t, grant, "steer", "hello");
		expect(refused).toEqual({ status: 409, body: { error: "not-offered" } });
		expect(t.desk.proposals.size).toBe(0);
	});

	it("offers nothing without a desk, and says so", async () => {
		const t = setup({ interventions: undefined });
		const { offers, interventions } = await t.status();
		expect(offers.stop).toEqual({ offered: false, reason: "Interventions are not configured for this launch." });
		expect(interventions).toEqual([]);
		const grant = await t.pair();
		expect((await propose(t, grant, "stop")).status).toBe(404);
	});
});

describe("a steer: requested, approved on the terminal, sent, accepted", () => {
	it("sends nothing until the terminal approves, binds the approval to the request, and never records the text", async () => {
		const t = setup();
		const grant = await t.pair();
		const proposed = await propose(t, grant, "steer", `also ${SECRET}`);
		expect(proposed.status).toBe(202);
		const view = proposed.body as { proposalId: string; state: string; bytes: number };
		expect(view).toMatchObject({
			operation: "steer",
			state: "awaiting-approval",
			approved: false,
			bytes: 5 + SECRET.length,
		});
		const request = await t.approval.waitForRequest();
		expect(request).toMatchObject({
			operation: "steer",
			message: `also ${SECRET}`,
			session: "endo.session.pi.fake-session-1",
		});
		expect(request.phrase).toMatch(/^APPROVE STEER [0-9a-f]{16}$/);
		// The phrase carries the digest of the proposal the desk recorded, so a typed phrase is for this request and no other.
		expect(request.phrase.slice(-16)).toBe(
			t.desk.proposals.get(view.proposalId)!.proposal.proposalDigest.slice(0, 16),
		);
		// HTTP acceptance is only a request.
		expect(t.desk.applyCalls).toEqual([]);
		t.approval.answer("allow");
		await settle();
		expect(t.desk.applyCalls).toEqual([view.proposalId]);
		// The authorization is the local operator's, typed on the terminal, for this exact proposal.
		expect(t.desk.authorizations).toHaveLength(1);
		expect(t.desk.authorizations[0]).toMatchObject({
			proposalId: view.proposalId,
			decision: "allow",
			authority: { kind: "local-operator", confirmation: "terminal-phrase" },
		});
		expect(t.desk.proposals.get(view.proposalId)!.proposal.origin).toBe("operator-workbench");
		// Sent, and Pi has not replied: not accepted.
		const sent = (await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body as { state: string };
		expect(sent.state).toBe("sent");
		t.desk.release(view.proposalId);
		await settle();
		const done = (await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body as Record<
			string,
			unknown
		>;
		expect(done).toMatchObject({ state: "accepted", approved: true, disposition: "queued", consumption: null });
		// The text lives nowhere the page can read it: not in a view, a status or a record.
		expect(JSON.stringify([done, await t.status(), t.session.records])).not.toContain(SECRET);
	});

	it("binds the launch into what the digest covers", async () => {
		const a = setup();
		const b = setup();
		const grantA = await a.pair();
		const grantB = await b.pair();
		const first = (await propose(a, grantA, "steer", "same words")).body as { proposalId: string };
		const second = (await propose(b, grantB, "steer", "same words")).body as { proposalId: string };
		// Two launches, the same words, the same session: different proposals, so one launch's approval cannot apply in the other.
		expect(first.proposalId).not.toBe(second.proposalId);
		expect(a.desk.proposals.get(first.proposalId)!.proposal.nonce).toBe(`wb-${a.broker.launchId}-1`);
	});

	it("records a declined approval as a denial and sends nothing", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "steer", "no thanks")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("deny");
		await settle();
		expect(t.desk.authorizations[0]).toMatchObject({ decision: "deny" });
		expect(t.desk.applyCalls).toEqual([]);
		expect(t.desk.refusals).toEqual([
			{ proposalId: view.proposalId, reason: "authorization-denied", detail: expect.any(String) },
		]);
		expect((await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "authorization-denied",
			approved: false,
		});
	});

	it("treats a withdrawn approval and an unanswered one differently, and sends neither", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = (await propose(t, grant, "queue", "later")).body as { proposalId: string };
		await t.approval.waitForRequest();
		expect((await t.call("POST", "intervention/discard", { proposalId: first.proposalId }, grant)).status).toBe(200);
		await settle();
		expect((await t.call("GET", `intervention/${first.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "withdrawn",
		});
		// Unanswered: the approver gives up (null) without being aborted.
		t.approval.requests.length = 0;
		const second = (await propose(t, grant, "queue", "later")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer(null);
		await settle();
		expect((await t.call("GET", `intervention/${second.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "approval-timed-out",
		});
		expect(t.desk.applyCalls).toEqual([]);
		expect(t.desk.refusals.map((r) => r.reason)).toEqual(["not-authorized", "not-authorized"]);
		// A request that is no longer waiting cannot be withdrawn.
		expect((await t.call("POST", "intervention/discard", { proposalId: second.proposalId }, grant)).status).toBe(409);
	});

	it("refuses an approval typed after its window, and one given after the page was paired anew", async () => {
		const t = setup();
		const grant = await t.pair();
		const late = (await propose(t, grant, "steer", "late")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.advance(5 * 60_000 + 1);
		t.approval.answer("allow");
		await settle();
		expect((await t.call("GET", `intervention/${late.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "authorization-expired",
			approved: true,
		});
		const second = setup();
		const g1 = await second.pair();
		const replaced = (await propose(second, g1, "steer", "x")).body as { proposalId: string };
		await second.approval.waitForRequest();
		const g2 = await second.pair(); // a new pairing replaces the grant the request was made with
		second.approval.answer("allow");
		await settle();
		expect((await second.call("GET", `intervention/${replaced.proposalId}`, null, g2)).body).toMatchObject({
			state: "refused",
			reason: "not-authorized",
		});
		expect(t.desk.applyCalls).toEqual([]);
		expect(second.desk.applyCalls).toEqual([]);
	});

	it("refuses unsafe, empty and oversized text, and a malformed request, before the desk records anything", async () => {
		const t = setup();
		const grant = await t.pair();
		for (const message of ["", "   ", "a\u001b[2Jb", "a\rb", "a‮b", "x".repeat(16 * 1024 + 1)])
			expect((await propose(t, grant, "steer", message)).status).toBe(400);
		expect((await propose(t, grant, "stop", "text")).status).toBe(400); // a stop carries no message
		expect((await propose(t, grant, "steer")).status).toBe(400);
		expect((await propose(t, grant, "abort_and_prompt", "x")).status).toBe(400); // no raw passthrough
		expect(
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "x", extra: 1 }, grant)).status,
		).toBe(400);
		expect((await t.call("POST", "intervention/propose", null, grant)).status).toBe(400);
		expect(t.desk.proposals.size).toBe(0);
	});
});

describe("one approval at a time, and no duplicate dispatch", () => {
	it("holds the terminal for one request: a second, of any kind, is refused and records nothing", async () => {
		const t = setup();
		t.session.runActive = false;
		const grant = await t.pair();
		const prompt = await t.call("POST", "prompt/propose", { message: "start" }, grant);
		expect(prompt.status).toBe(202);
		t.session.runActive = true;
		// An intervention while a prompt waits for the terminal.
		expect((await propose(t, grant, "steer", "x")).status).toBe(409);
		await t.call("POST", "prompt/discard", { proposalId: (prompt.body as { proposalId: string }).proposalId }, grant);
		await settle();
		// A double click: one request, one approval, one dispatch.
		const [one, two] = await Promise.all([propose(t, grant, "steer", "once"), propose(t, grant, "steer", "once")]);
		expect([one.status, two.status].sort()).toEqual([202, 409]);
		expect(t.desk.proposals.size).toBe(1);
		// And a prompt cannot start while an intervention waits.
		t.session.runActive = false;
		expect((await t.call("POST", "prompt/propose", { message: "start" }, grant)).status).toBe(409);
		expect((await t.status()).offers.prompt.reason).toContain("waiting for approval in the terminal");
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		expect(t.desk.applyCalls).toHaveLength(1);
	});

	it("does not let a request that is sent and waiting for Pi hold the terminal", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = (await propose(t, grant, "steer", "one")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		expect((await t.status()).interventions[0].state).toBe("sent");
		// Pi has not answered the first; the second can be requested and approved.
		t.approval.requests.length = 0;
		const second = await propose(t, grant, "queue", "two");
		expect(second.status).toBe(202);
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		expect(t.desk.applyCalls).toHaveLength(2);
		t.desk.release(first.proposalId);
		t.desk.release((second.body as { proposalId: string }).proposalId);
		await settle();
		expect((await t.status()).interventions.map((i: any) => i.state)).toEqual(["accepted", "accepted"]);
	});
});

describe("a stop", () => {
	it("is a request without a message, with its own phrase, and is only acknowledged once Pi answers", async () => {
		const t = setup();
		const grant = await t.pair();
		const proposed = await propose(t, grant, "stop");
		expect(proposed.status).toBe(202);
		const view = proposed.body as { proposalId: string };
		expect(proposed.body).toMatchObject({ operation: "stop", bytes: null, state: "awaiting-approval" });
		const request = await t.approval.waitForRequest();
		expect(request).toMatchObject({ operation: "stop", message: null, bytes: 0 });
		expect(request.phrase).toMatch(/^APPROVE STOP [0-9a-f]{16}$/);
		t.approval.answer("allow");
		await settle();
		// Pi answers an abort only once idle: sent, reply pending. Reads stay responsive meanwhile.
		const started = Date.now();
		const pending = await t.status();
		expect(Date.now() - started).toBeLessThan(500);
		expect(pending.interventions[0]).toMatchObject({ state: "sent", operation: "stop", runEnded: null });
		expect((await t.call("GET", "transcript", null, grant)).status).toBe(200);
		// Withheld while pending: another stop is this one, a steer is not offered.
		const again = await propose(t, grant, "stop");
		expect(again.status).toBe(200);
		expect((again.body as { proposalId: string }).proposalId).toBe(view.proposalId);
		expect(pending.offers.steer.reason).toContain("A stop is pending");
		expect(pending.offers.stop.reason).toContain("already pending");
		expect((await propose(t, grant, "steer", "hmm")).status).toBe(409);
		expect(t.desk.applyCalls).toHaveLength(1);
		t.desk.release(view.proposalId, { status: "accepted", requestId: "r", disposition: null });
		await settle();
		expect((await t.status()).interventions[0]).toMatchObject({
			state: "accepted",
			disposition: null,
			runEnded: null,
		});
	});

	it("reports the run's end as the runtime reported it, and never as this stop's doing", async () => {
		const t = setup();
		const grant = await t.pair();
		t.session.live_({ type: "agent_start", record: {} });
		const view = (await propose(t, grant, "stop")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		t.session.live_({
			type: "message_end",
			record: { message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "" }] } },
		});
		t.session.live_({ type: "agent_settled", record: {} });
		expect((await t.status()).interventions[0]).toMatchObject({ state: "sent", runEnded: "aborted" });
		t.desk.release(view.proposalId, { status: "accepted", requestId: "r", disposition: null });
		await settle();
		expect((await t.status()).interventions[0]).toMatchObject({ state: "accepted", runEnded: "aborted" });
		// A run that ends on its own while a stop waits is a completion, not a stop.
		const u = setup();
		const g = await u.pair();
		u.session.live_({ type: "agent_start", record: {} });
		await propose(u, g, "stop");
		await u.approval.waitForRequest();
		u.approval.answer("allow");
		await settle();
		u.session.live_({
			type: "message_end",
			record: { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
		});
		u.session.live_({ type: "agent_settled", record: {} });
		expect((await u.status()).interventions[0]).toMatchObject({ runEnded: "completed" });
	});

	it("says outcome unknown when the request was written and Pi's reply was lost, and not refused", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "stop")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		t.desk.release(view.proposalId, {
			status: "refused",
			requestId: "r",
			reason: "runtime-failed",
			detail: "Pi did not answer within 10000ms",
		});
		await settle();
		expect((await t.status()).interventions[0]).toMatchObject({ state: "unknown", reason: null });
		// Pi's own refusal is a refusal.
		const u = setup();
		const g = await u.pair();
		const v = (await propose(u, g, "stop")).body as { proposalId: string };
		await u.approval.waitForRequest();
		u.approval.answer("allow");
		await settle();
		u.desk.release(v.proposalId, { status: "refused", requestId: "r", reason: "runtime-refused", detail: "no" });
		await settle();
		expect((await u.status()).interventions[0]).toMatchObject({ state: "refused", reason: "runtime-refused" });
	});

	it("shows a reply that arrives after the page went away, from the broker's memory alone", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "steer", "x")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		// No request from any page while Pi replies.
		t.desk.release(view.proposalId);
		await settle();
		expect((await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body).toMatchObject({
			state: "accepted",
		});
	});
});

describe("consumption is checked on request, and only reported as the capture shows", () => {
	it("keeps acceptance and consumption apart, and never reads the capture on a status poll", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "steer", "look")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		// Not checkable before Pi accepted it.
		expect((await t.call("POST", "intervention/check", { proposalId: view.proposalId }, grant)).status).toBe(409);
		t.desk.release(view.proposalId);
		await settle();
		for (let i = 0; i < 5; i++) await t.status();
		expect(t.desk.consumptionChecks).toBe(0);
		// A check starts and returns at once; the answer is read back from the request's view.
		const started = await t.call("POST", "intervention/check", { proposalId: view.proposalId }, grant);
		expect(started.status).toBe(202);
		expect(started.body).toMatchObject({ consumption: { status: "checking" } });
		await settle();
		const read = async () => (await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body;
		expect(await read()).toMatchObject({
			state: "accepted",
			consumption: { status: "not-observed", reason: "this session store holds no proxy capture" },
		});
		// Within the cooldown the same answer comes back and the capture is not read again.
		t.desk.consumptionResult = { status: "observed", exchange: 3, captureEvent: "endo.event.c3" };
		const again = await t.call("POST", "intervention/check", { proposalId: view.proposalId }, grant);
		expect(again.body).toMatchObject({ consumption: { status: "not-observed" } });
		expect(t.desk.consumptionChecks).toBe(1);
		t.advance(6_000);
		expect((await t.call("POST", "intervention/check", { proposalId: view.proposalId }, grant)).status).toBe(202);
		await settle();
		expect(await read()).toMatchObject({ consumption: { status: "observed", exchange: 3 } });
		// A stop has no message to consume.
		const stop = setup();
		const g = await stop.pair();
		const s = (await propose(stop, g, "stop")).body as { proposalId: string };
		expect((await stop.call("POST", "intervention/check", { proposalId: s.proposalId }, g)).status).toBe(409);
	});
});

describe("the close, and who may ask", () => {
	it("needs the grant on every route, and knows only requests this launch made", async () => {
		const t = setup();
		const grant = await t.pair();
		for (const [method, route, body] of [
			["POST", "intervention/propose", { operation: "stop" }],
			["POST", "intervention/discard", { proposalId: "x" }],
			["POST", "intervention/check", { proposalId: "x" }],
			["GET", "intervention/endo.evidence.intervention.proposal.x", null],
		] as const)
			expect((await t.call(method, route, body)).status).toBe(401);
		// A proposal id made up by a page, or one the desk holds from elsewhere, is not this broker's to apply.
		const foreign = t.desk.propose({ operation: "steer", message: "from the control socket", nonce: "cli" });
		expect((await t.call("GET", `intervention/${foreign.proposalId}`, null, grant)).status).toBe(404);
		expect((await t.call("POST", "intervention/discard", { proposalId: foreign.proposalId }, grant)).status).toBe(
			404,
		);
		expect((await t.call("POST", "intervention/check", { proposalId: foreign.proposalId }, grant)).status).toBe(404);
		expect(t.desk.applyCalls).toEqual([]);
		expect((await t.call("GET", "intervention/propose", null, grant)).status).toBe(404);
		expect((await t.call("POST", "intervention/propose/extra", { operation: "stop" }, grant)).status).toBe(404);
	});

	it("withdraws what waits for the terminal when the desk begins to close, and takes nothing after", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "steer", "too late")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.desk.finish(); // the desk's finish begins: consequences are about to be recorded
		await settle();
		expect((await t.call("GET", `intervention/${view.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "session-ended",
		});
		// A late "yes" on the terminal changes nothing.
		t.approval.answer("allow");
		await settle();
		expect(t.desk.applyCalls).toEqual([]);
		expect((await propose(t, grant, "stop")).status).toBe(409);
		expect((await t.status()).offers.stop.reason).toContain("closing");
	});

	it("offers and sends no prompt once the desk's final finish begins, including an approval already given", async () => {
		const t = setup();
		t.session.runActive = false;
		const grant = await t.pair();
		const waiting = (await t.call("POST", "prompt/propose", { message: "late prompt" }, grant)).body as {
			proposalId: string;
		};
		await t.approval.waitForRequest();
		t.desk.finish();
		t.approval.answer("allow"); // approval resolved just as the close began
		await settle();
		expect(t.session.promptCalls).toEqual([]);
		expect((await t.call("GET", `prompt/${waiting.proposalId}`, null, grant)).body).toMatchObject({
			state: "refused",
			reason: "session-ended",
		});
		expect((await t.status()).offers.prompt).toMatchObject({ offered: false, reason: "The session is closing." });
		expect((await t.call("POST", "prompt/propose", { message: "again" }, grant)).status).toBe(409);
	});

	it("reports a run's end like the recorded lifecycle: unclassified without a stop reason, failed when retries are exhausted", async () => {
		const ending = async (events: Parameters<FakeSession["live_"]>[0][]) => {
			const t = setup();
			const grant = await t.pair();
			t.session.live_({ type: "agent_start", record: {} });
			await propose(t, grant, "stop");
			await t.approval.waitForRequest();
			t.approval.answer("allow");
			await settle();
			for (const e of events) t.session.live_(e);
			t.session.live_({ type: "agent_settled", record: {} });
			return (await t.status()).interventions[0].runEnded;
		};
		expect(await ending([])).toBe("unclassified");
		expect(await ending([{ type: "auto_retry_end", record: { success: false } }])).toBe("failed");
		expect(
			await ending([
				{ type: "message_end", record: { message: { role: "assistant", stopReason: "stop", content: [] } } },
				{ type: "auto_retry_end", record: { success: false } },
			]),
		).toBe("failed");
		expect(
			await ending([
				{ type: "auto_retry_end", record: { success: true } },
				{ type: "message_end", record: { message: { role: "assistant", stopReason: "stop", content: [] } } },
			]),
		).toBe("completed");
	});

	it("ends the session without holding on to a stop Pi has not answered", async () => {
		const t = setup();
		const grant = await t.pair();
		await propose(t, grant, "stop");
		await t.approval.waitForRequest();
		t.approval.answer("allow");
		await settle();
		const started = Date.now();
		await t.broker.dispose();
		expect(Date.now() - started).toBeLessThan(4_000);
		expect((await t.call("GET", "status")).status).toBe(200);
		expect((await propose(t, grant, "stop")).status).toBe(401);
	});

	it("withdraws a waiting approval when the runtime ends", async () => {
		const t = setup();
		const grant = await t.pair();
		const view = (await propose(t, grant, "steer", "x")).body as { proposalId: string };
		await t.approval.waitForRequest();
		t.session.live = false;
		await t.call("GET", "status");
		await settle();
		expect(t.desk.applyCalls).toEqual([]);
		expect(t.desk.refusals[0]).toMatchObject({ proposalId: view.proposalId, reason: "session-ended" });
	});
});
