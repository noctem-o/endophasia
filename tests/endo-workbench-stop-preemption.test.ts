// A STOP supersedes an unapproved STEER or QUEUE (adapters/pi/workbench-interventions.ts): it is requested while the request that holds the
// terminal is still awaiting its approval, it waits for that request to settle, and it then needs its OWN exact approval. At the broker's
// boundary, against a terminal that models readline's rules (one question at a time; an abort releases its question asynchronously; text
// typed while no question is open goes nowhere). The real desk and a real pseudo-terminal are exercised in the *-live and *-cli suites.
import { describe, expect, it } from "vitest";
import { type WorkbenchApprovalRequestV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { FakeDesk, FakeSession, settle } from "./workbench-fixtures.ts";

/** A controlling terminal: one question at a time, answered by typing. */
class Terminal {
	asked: WorkbenchApprovalRequestV0[] = [];
	active = 0;
	maxActive = 0;
	/** Questions begun while another was still open: must stay empty. */
	overlaps: string[] = [];
	/** Lines typed while no question was open (readline would hand them to its line handler, not to a question). */
	stray: string[] = [];
	#current: { request: WorkbenchApprovalRequestV0; done(answer: "allow" | "deny" | null): void } | null = null;
	readonly approver = (request: WorkbenchApprovalRequestV0, signal: AbortSignal) =>
		new Promise<"allow" | "deny" | null>((resolve) => {
			if (this.active > 0) this.overlaps.push(request.operation);
			this.active += 1;
			this.maxActive = Math.max(this.maxActive, this.active);
			this.asked.push(request);
			let finished = false;
			const done = (answer: "allow" | "deny" | null) => {
				if (finished) return;
				finished = true;
				this.active -= 1;
				if (this.#current?.request === request) this.#current = null;
				resolve(answer);
			};
			this.#current = { request, done };
			// An abort releases the question one microtask later, as readline's does: not at the instant the signal fires.
			const release = () => queueMicrotask(() => done(null));
			if (signal.aborted) release();
			else signal.addEventListener("abort", release, { once: true });
		});
	type(line: string): void {
		const current = this.#current;
		if (current === null) this.stray.push(line);
		else current.done(line === current.request.phrase ? "allow" : "deny");
	}
	/** The question runs out of time: nothing was answered. */
	expire(): void {
		this.#current?.done(null);
	}
	async waitForQuestion(count: number): Promise<WorkbenchApprovalRequestV0> {
		for (let i = 0; i < 400 && this.asked.length < count; i++) await new Promise((r) => setTimeout(r, 5));
		const question = this.asked[count - 1];
		if (question === undefined) throw new Error(`question ${count} was never asked (${this.asked.length} asked)`);
		return question;
	}
}

function setup() {
	const session = new FakeSession();
	session.runActive = true;
	const desk = new FakeDesk(session);
	const terminal = new Terminal();
	let now = 1_000_000;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: terminal.approver,
		interventions: desk,
		now: () => now,
	});
	const call = (method: "GET" | "POST", route: string, body: unknown = null, grant: string | null = null) =>
		broker.handle({ method, route: route.split("/"), query: "", grant, body });
	const pair = async () =>
		((await call("POST", "pair", { code: broker.issuePairingCode().code })).body as { grant: string }).grant;
	const view = async (id: string, grant: string) => (await call("GET", `intervention/${id}`, null, grant)).body as any;
	const request = (grant: string, operation: string, message?: string) =>
		call("POST", "intervention/propose", message === undefined ? { operation } : { operation, message }, grant);
	return {
		session,
		desk,
		terminal,
		broker,
		call,
		pair,
		view,
		request,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
type Setup = ReturnType<typeof setup>;

/** A steer or queue that waits on the terminal. */
async function waiting(t: Setup, grant: string, operation: "steer" | "queue" = "steer") {
	const before = t.terminal.asked.length;
	const reply = await t.request(grant, operation, "look at the notes again");
	expect(reply.status).toBe(202);
	const id = (reply.body as { proposalId: string }).proposalId;
	await t.terminal.waitForQuestion(before + 1);
	return id;
}

describe("a STOP supersedes an unapproved request, and still needs its own approval", () => {
	for (const operation of ["steer", "queue"] as const) {
		it(`cancels a ${operation} that awaits approval, asks its own question afterwards, and sends nothing unapproved`, async () => {
			const t = setup();
			const grant = await t.pair();
			const first = await waiting(t, grant, operation);
			expect(
				(await t.broker.handle({ method: "GET", route: ["status"], query: "", grant: null, body: null })).body,
			).toMatchObject({ offers: { stop: { offered: true } } });

			const stop = await t.request(grant, "stop");
			expect(stop.status).toBe(202);
			const stopId = (stop.body as { proposalId: string }).proposalId;
			const question = await t.terminal.waitForQuestion(2);
			await settle();

			// The superseded request is cancelled, unapproved, with its own reason; it never reached the desk's gate.
			expect(await t.view(first, grant)).toMatchObject({
				state: "refused",
				approved: false,
				reason: "superseded-by-stop",
			});
			expect(t.desk.refusals).toEqual([
				{
					proposalId: first,
					reason: "not-authorized",
					detail: "superseded by a stop request before its approval was acted on",
				},
			]);
			expect(t.desk.authorizations).toEqual([]);
			expect(t.desk.applyCalls).toEqual([]);
			// The STOP's own question: its operation, its exact phrase, and what it replaced. It is not yet approved.
			expect(question).toMatchObject({ operation: "stop", message: null, supersedes: operation });
			expect(question.phrase).toMatch(/^APPROVE STOP [0-9a-f]{16}$/);
			expect(await t.view(stopId, grant)).toMatchObject({ state: "awaiting-approval", approved: false });
			expect(t.terminal.maxActive).toBe(1);
			expect(t.terminal.overlaps).toEqual([]);

			// Only the operator's exact STOP phrase sends it.
			t.terminal.type(question.phrase);
			await settle();
			expect(t.desk.applyCalls).toEqual([stopId]);
			expect(t.desk.authorizations.map((a) => a.decision)).toEqual(["allow"]);
			t.desk.release(stopId);
			await settle();
			expect(await t.view(stopId, grant)).toMatchObject({ state: "accepted", approved: true });
			expect(t.terminal.maxActive).toBe(1);
		});
	}

	it("discards an approval typed for the superseded request in the same instant, and in the instants after", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		const steerPhrase = t.terminal.asked[0]!.phrase;
		// The operator approves the steer; before the broker acts on that answer, a STOP is requested.
		t.terminal.type(steerPhrase);
		const stop = await t.request(grant, "stop");
		await settle();
		expect(await t.view(first, grant)).toMatchObject({
			state: "refused",
			approved: false,
			reason: "superseded-by-stop",
		});
		expect(t.desk.authorizations).toEqual([]);
		expect(t.desk.applyCalls).toEqual([]);

		// The stale steer phrase, typed into the STOP's question, is not an approval of the STOP: it declines it.
		const question = await t.terminal.waitForQuestion(2);
		expect(steerPhrase).not.toBe(question.phrase);
		t.terminal.type(steerPhrase);
		await settle();
		const stopId = (stop.body as { proposalId: string }).proposalId;
		expect(await t.view(stopId, grant)).toMatchObject({
			state: "refused",
			approved: false,
			reason: "authorization-denied",
		});
		expect(t.desk.applyCalls).toEqual([]);
		// And once no question is open, a typed phrase reaches nothing.
		t.terminal.type(steerPhrase);
		expect(t.terminal.stray).toEqual([steerPhrase]);
		expect(t.desk.applyCalls).toEqual([]);
	});

	it("leaves an unrelated pending approval alone when the STOP is not admitted, and when the run is not open", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		t.desk.admitted.stop = "steering.abort is not admitted by conformance evidence for this runtime";
		const refused = await t.request(grant, "stop");
		expect(refused).toMatchObject({ status: 409, body: { error: "not-offered" } });
		expect(await t.view(first, grant)).toMatchObject({ state: "awaiting-approval" });
		t.session.runActive = false;
		expect((await t.request(grant, "stop")).status).toBe(409);
		t.session.runActive = true;
		delete t.desk.admitted.stop;
		// The steer is still answerable.
		t.terminal.type(t.terminal.asked[0]!.phrase);
		await settle();
		expect(t.desk.applyCalls).toEqual([first]);
		expect(t.terminal.asked).toHaveLength(1);
	});

	it("leaves the pending approval valid when the STOP's proposal cannot be recorded", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		t.desk.proposeFails = true;
		expect(await t.request(grant, "stop")).toMatchObject({ status: 503, body: { error: "not-recording" } });
		t.desk.proposeFails = false;
		await settle();
		expect(await t.view(first, grant)).toMatchObject({ state: "awaiting-approval", approved: false });
		expect(t.desk.refusals).toEqual([]);
		expect(t.terminal.asked).toHaveLength(1);
		t.terminal.type(t.terminal.asked[0]!.phrase);
		await settle();
		expect(t.desk.applyCalls).toEqual([first]);
	});

	it("refuses a STOP that is denied or never approved, and does not bring the cancelled request back", async () => {
		const denied = setup();
		const grant = await denied.pair();
		const first = await waiting(denied, grant);
		const stop = (await denied.request(grant, "stop")).body as { proposalId: string };
		await denied.terminal.waitForQuestion(2);
		denied.terminal.type("no");
		await settle();
		expect(await denied.view(stop.proposalId, grant)).toMatchObject({
			state: "refused",
			reason: "authorization-denied",
		});
		expect(await denied.view(first, grant)).toMatchObject({ state: "refused", reason: "superseded-by-stop" });
		expect(denied.desk.applyCalls).toEqual([]);

		// A STOP nobody answers in time (the terminal's own timeout answers nothing) is refused as timed out, not approved.
		const timed = setup();
		const g2 = await timed.pair();
		await waiting(timed, g2);
		const s2 = (await timed.request(g2, "stop")).body as { proposalId: string };
		await timed.terminal.waitForQuestion(2);
		timed.terminal.expire();
		await settle();
		expect(await timed.view(s2.proposalId, g2)).toMatchObject({
			state: "refused",
			approved: false,
			reason: "approval-timed-out",
		});
		expect(timed.desk.applyCalls).toEqual([]);

		// A STOP the operator withdraws on the page is withdrawn, and the cancelled request is still cancelled.
		const withdrawn = setup();
		const g3 = await withdrawn.pair();
		await waiting(withdrawn, g3);
		const s3 = (await withdrawn.request(g3, "stop")).body as { proposalId: string };
		await withdrawn.terminal.waitForQuestion(2);
		await withdrawn.call("POST", "intervention/discard", { proposalId: s3.proposalId }, g3);
		await settle();
		expect(await withdrawn.view(s3.proposalId, g3)).toMatchObject({ state: "refused", reason: "withdrawn" });
		expect(withdrawn.desk.applyCalls).toEqual([]);
	});

	it("keeps duplicate STOP requests to one proposal and one question", async () => {
		const t = setup();
		const grant = await t.pair();
		await waiting(t, grant);
		const a = (await t.request(grant, "stop")).body as { proposalId: string };
		const b = await t.request(grant, "stop");
		expect(b).toMatchObject({ status: 200, body: { proposalId: a.proposalId } });
		await settle();
		expect(t.terminal.asked.map((q) => q.operation)).toEqual(["steer", "stop"]);
		expect(t.desk.proposals.size).toBe(2);
	});

	it("does not cancel a request that was already approved and is waiting for Pi", async () => {
		const t = setup();
		const grant = await t.pair();
		const steer = await waiting(t, grant);
		t.terminal.type(t.terminal.asked[0]!.phrase);
		await settle();
		expect(t.desk.applyCalls).toEqual([steer]);
		expect(await t.view(steer, grant)).toMatchObject({ approved: true, state: "sent" });

		const stop = (await t.request(grant, "stop")).body as { proposalId: string };
		await settle();
		// The steer is untouched and nothing was refused on its behalf; the STOP asks its own question straight away.
		expect(await t.view(steer, grant)).toMatchObject({ approved: true, state: "sent", reason: null });
		expect(t.desk.refusals).toEqual([]);
		const q = await t.terminal.waitForQuestion(2);
		expect(q).toMatchObject({ operation: "stop", supersedes: null });
		t.desk.release(steer);
		await settle();
		expect(await t.view(steer, grant)).toMatchObject({ state: "accepted" });
		expect(await t.view(stop.proposalId, grant)).toMatchObject({ state: "awaiting-approval" });
	});

	it("refuses a superseded request and the STOP safely when the session closes during the handover", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		const stop = (await t.request(grant, "stop")).body as { proposalId: string };
		t.desk.finish();
		await settle();
		expect(await t.view(first, grant)).toMatchObject({ state: "refused" });
		expect(await t.view(stop.proposalId, grant)).toMatchObject({ state: "refused", reason: "session-ended" });
		expect(t.desk.applyCalls).toEqual([]);
		expect(t.terminal.asked.map((q) => q.operation)).toEqual(["steer"]);
		expect(t.terminal.active).toBe(0);
	});

	it("refuses both and asks no second question when the session ends during the handover (disconnect)", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		const stop = (await t.request(grant, "stop")).body as { proposalId: string };
		// The runtime goes away before the superseded request has finished releasing its question.
		t.session.live = false;
		t.broker.endSession();
		await settle();
		// The ending revokes the grant, so the page can read nothing more; the desk's record shows both were refused and neither sent.
		expect((await t.request(grant, "stop")).status).toBe(401);
		expect(t.desk.refusals.map((r) => [r.proposalId, r.reason])).toEqual([
			[first, "not-authorized"], // superseded: cancelled, unapproved
			[stop.proposalId, "session-ended"],
		]);
		expect(t.terminal.asked.map((q) => q.operation)).toEqual(["steer"]);
		expect(t.terminal.active).toBe(0);
		expect(t.desk.applyCalls).toEqual([]);
	});

	it("refuses the STOP when the page is no longer paired by the time it is approved", async () => {
		const t = setup();
		const grant = await t.pair();
		await waiting(t, grant);
		const stop = (await t.request(grant, "stop")).body as { proposalId: string };
		const q = await t.terminal.waitForQuestion(2);
		const replacement = await t.pair(); // a new pairing replaces the grant
		expect(replacement).not.toBe(grant);
		t.terminal.type(q.phrase);
		await settle();
		expect(t.desk.applyCalls).toEqual([]);
		expect(await t.view(stop.proposalId, replacement)).toMatchObject({
			state: "refused",
			approved: true,
			reason: "not-authorized",
		});
	});

	it("reports a run that ended naturally before the STOP was approved as the gate's refusal, not as a stop", async () => {
		const t = setup();
		const grant = await t.pair();
		const first = await waiting(t, grant);
		const stop = (await t.request(grant, "stop")).body as { proposalId: string };
		const q = await t.terminal.waitForQuestion(2);
		t.session.runActive = false;
		t.desk.nextApply = {
			status: "refused",
			reason: "no-active-run",
			requestId: null,
			detail: "no run is active",
		} as any;
		t.terminal.type(q.phrase);
		await settle();
		expect(await t.view(stop.proposalId, grant)).toMatchObject({
			state: "refused",
			approved: true,
			reason: "no-active-run",
		});
		// The steer stays cancelled: a cancellation is not undone.
		expect(await t.view(first, grant)).toMatchObject({ state: "refused", reason: "superseded-by-stop" });
	});

	it("does not supersede a prompt awaiting approval, and says so", async () => {
		const t = setup();
		t.session.runActive = false;
		const grant = await t.pair();
		const prompt = await t.call("POST", "prompt/propose", { message: "hello" }, grant);
		expect(prompt.status).toBe(202);
		await t.terminal.waitForQuestion(1);
		t.session.runActive = true;
		const status = (await t.call("GET", "status")).body as any;
		expect(status.offers.stop.offered).toBe(false);
		expect(status.offers.stop.reason).toContain("prompt is waiting");
		expect((await t.request(grant, "stop")).status).toBe(409);
		expect(t.terminal.asked).toHaveLength(1);
	});
});
