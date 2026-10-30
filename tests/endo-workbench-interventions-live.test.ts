// STEER, QUEUE and STOP through the workbench broker onto the REAL intervention desk, against the fake Pi (a real child process speaking
// Pi's RPC) and a hand-resolved terminal approver. What the broker test cannot show: the desk's own gate, its records in a real store,
// what reaches Pi and what does not, and the order of the chain. No provider, no model, no network.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { WorkbenchEvidenceBudgetV0 } from "../adapters/pi/workbench-interventions.ts";
import { endoInterventionCaptureSourceV0 } from "../cli/intervention-capture.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { Approval, settle } from "./workbench-fixtures.ts";

const KEY = endoDigestKeyV0(Buffer.alloc(32, 7), "workbench-intervention-test");
const SECRET = "CANARY-live-steer-5b0e-do-not-record";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

async function ready(
	options: {
		admitted?: boolean;
		stepMs?: number;
		capture?: boolean;
		yieldMs?: number;
		budget?: Partial<WorkbenchEvidenceBudgetV0>;
	} = {},
) {
	const install = installFakePi("1.0.0");
	cleanup.push(() => install.remove());
	const root = temp("endo-wbi-");
	const cwd = temp("endo-wbi-cwd-");
	const log = join(temp("endo-wbi-log-"), "commands.log");
	const pi = new PiAttachmentV0({
		root,
		cwd,
		executable: install.bin,
		env: fakePiEnv({ FAKE_PI_STEP_MS: String(options.stepMs ?? 40), FAKE_PI_LOG: log }),
		requestTimeoutMs: 10_000,
		digestKey: KEY,
	});
	await pi.checkLocal();
	if (options.admitted !== false) await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
	install.setScenario("");
	const session = await pi.openSession();
	let closed = false;
	cleanup.push(async () => {
		if (!closed) await session.close();
	});
	const desk = new PiInterventionDeskV0(
		session,
		KEY,
		options.capture === true ? endoInterventionCaptureSourceV0(root, KEY) : null,
	);
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: KEY,
		attachment: session.owner.attachment,
		approver: approval.approver,
		interventions: desk,
		...(options.budget === undefined ? {} : { evidenceBudget: options.budget }),
		...(options.yieldMs === undefined
			? {}
			: { yieldToLoop: () => new Promise<void>((done) => setTimeout(done, options.yieldMs)) }),
	});
	cleanup.push(() => broker.dispose());
	const call = (method: "GET" | "POST", route: string, body: unknown = null, grant: string | null = null) =>
		broker.handle({ method, route: route.split("/"), query: "", grant, body });
	const grant = ((await call("POST", "pair", { code: broker.issuePairingCode().code })).body as { grant: string })
		.grant;
	const commands = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
	const status = async () => (await call("GET", "status")).body as any;
	const view = async (id: string) => (await call("GET", `intervention/${id}`, null, grant)).body as any;
	const until = async (what: string, ok: () => Promise<boolean> | boolean) => {
		const deadline = Date.now() + 15_000;
		while (!(await ok())) {
			if (Date.now() > deadline) throw new Error(`never: ${what}`);
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	const approve = async () => {
		await approval.waitForRequest();
		approval.answer("allow");
		approval.requests.length = 0;
	};
	return {
		root,
		session,
		desk,
		broker,
		call,
		grant,
		status,
		view,
		until,
		approve,
		approval,
		commands,
		close: async () => {
			closed = true;
			await session.close();
		},
	};
}

async function untilStreaming(session: PiSessionAttachmentV0): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!session.runActive || session.counters.deltasDropped < 2) {
		if (Date.now() > deadline) throw new Error("Pi never streamed");
		await new Promise((done) => setTimeout(done, 5));
	}
}

function events(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const all: EndoEventV0[] = [];
	for (let after = 0; ; ) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		if (page.events.length === 0) break;
		all.push(...page.events);
		after = page.nextAfterSequence;
	}
	store.close();
	return all;
}

describe("the broker on the real desk (fake Pi)", () => {
	it("steers an open run: the whole existing chain, bound to the terminal approval, with the text outside the evidence", async () => {
		const t = await ready();
		const settled = t.session.waitForSettled(20_000);
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const before = t.commands().length;
		const offers = (await t.status()).offers;
		expect(offers).toMatchObject({ steer: { offered: true }, queue: { offered: true }, stop: { offered: true } });
		expect(offers.prompt.offered).toBe(false);
		const proposed = await t.call(
			"POST",
			"intervention/propose",
			{ operation: "steer", message: `also ${SECRET}` },
			t.grant,
		);
		expect(proposed.status).toBe(202);
		const id = (proposed.body as { proposalId: string }).proposalId;
		const request = await t.approval.waitForRequest();
		expect(request.phrase).toMatch(/^APPROVE STEER [0-9a-f]{16}$/);
		// Requested is not sent: Pi has been told nothing.
		await settle(100);
		expect(t.commands().slice(before)).not.toContain("steer");
		expect(await t.view(id)).toMatchObject({ state: "awaiting-approval", approved: false });
		t.approval.answer("allow");
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		expect(t.commands().slice(before)).toContain("steer");
		expect(await t.view(id)).toMatchObject({
			state: "accepted",
			disposition: "queued",
			approved: true,
			consumption: null,
		});
		// Consumption is not established from acceptance, nor from text in a later conversation: this store has no proxy capture.
		expect((await t.call("POST", "intervention/check", { proposalId: id }, t.grant)).status).toBe(202);
		await t.until("checked", async () => (await t.view(id)).consumption?.status === "not-observed");
		expect(await t.view(id)).toMatchObject({
			consumption: { status: "not-observed", reason: "this session store holds no proxy capture" },
		});
		expect(await settled).toBe(true);
		await t.desk.finish();
		await t.close();
		const chain = events(t.root).filter((e) => e.kind.startsWith("intervention."));
		expect(chain.map((e) => [e.kind, e.source])).toEqual([
			["intervention.proposal", "policy-conclusion"],
			["intervention.authorization", "authority-decision"],
			["intervention.request", "runtime-fact"],
			["intervention.accepted", "runtime-fact"],
			["intervention.consequence", "evaluation-result"],
		]);
		expect(chain[0]!.payload).toMatchObject({ origin: "operator-workbench", operation: "steer" });
		expect(chain[1]!.payload).toMatchObject({
			decision: "allow",
			authority: { kind: "local-operator", confirmation: "terminal-phrase" },
			session: `endo.session.pi.${t.session.piSessionId}`,
		});
		expect(chain[4]!.payload).toMatchObject({
			acceptance: { status: "accepted", disposition: "queued" },
			consumption: { status: "not-observed" },
		});
		expect(JSON.stringify(events(t.root))).not.toContain(SECRET);
	}, 60_000);

	it("queues a follow-up the same way, through Pi's follow_up", async () => {
		const t = await ready();
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const before = t.commands().length;
		const id = (
			(
				await t.call(
					"POST",
					"intervention/propose",
					{ operation: "queue", message: "afterwards, summarise" },
					t.grant,
				)
			).body as any
		).proposalId;
		await t.approve();
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		expect(t.commands().slice(before)).toContain("follow_up");
		expect(t.commands().slice(before)).not.toContain("steer");
	}, 60_000);

	it("stops a run: sent and pending until Pi is idle, reads stay responsive, and the end is what Pi reported", async () => {
		const t = await ready({ stepMs: 60 });
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = ((await t.call("POST", "intervention/propose", { operation: "stop" }, t.grant)).body as any)
			.proposalId;
		await t.approve();
		await t.until("sent", async () => ["sent", "accepted"].includes((await t.view(id)).state));
		// Reads are not held behind the abort.
		const started = Date.now();
		await t.status();
		await t.call("GET", "transcript", null, t.grant);
		expect(Date.now() - started).toBeLessThan(1_000);
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		await t.until("run ended", async () => (await t.view(id)).runEnded !== null);
		expect(await t.view(id)).toMatchObject({ state: "accepted", disposition: null, runEnded: "aborted" });
		expect(t.commands()).toContain("abort");
		// Nothing is offered once the run is over.
		await t.until("idle", async () => (await t.status()).run === "idle");
		expect((await t.status()).offers.stop).toMatchObject({ offered: false });
	}, 60_000);

	it("refuses to offer or send what the runtime's evidence does not admit, and what is not an open run", async () => {
		const t = await ready({ admitted: false });
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const { offers } = await t.status();
		for (const op of ["steer", "queue", "stop"]) {
			expect(offers[op].offered, op).toBe(false);
			expect(offers[op].reason, op).toContain("Not admitted for this runtime");
		}
		const before = t.commands().length;
		expect((await t.call("POST", "intervention/propose", { operation: "steer", message: "x" }, t.grant)).status).toBe(
			409,
		);
		expect(t.commands().slice(before)).toEqual([]);
		// And with no open run at all (a recording's last known state is never one): nothing is offered.
		const idle = await ready();
		const reasons = (await idle.status()).offers;
		for (const op of ["steer", "queue", "stop"]) expect(reasons[op].reason, op).toContain("No run is open");
		expect((await idle.call("POST", "intervention/propose", { operation: "stop" }, idle.grant)).status).toBe(409);
	}, 60_000);

	it("sends nothing when the session ends before the operator approves, and never sends one request twice", async () => {
		const t = await ready();
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "late" }, t.grant)).body as any
		).proposalId;
		await t.approval.waitForRequest();
		const before = t.commands().length;
		await t.close(); // the session ends while the operator is still deciding
		t.approval.answer("allow");
		await settle(200);
		expect(await t.view(id)).toEqual({ error: "grant-required" }); // the grant died with the session: nothing is readable
		expect(t.commands().slice(before)).not.toContain("steer");
		const chain = events(t.root).filter((e) => e.kind.startsWith("intervention."));
		expect(chain.map((e) => e.kind)).not.toContain("intervention.request");

		// A second apply of an approved request is the desk's duplicate: Pi hears it once.
		const u = await ready();
		await u.session.prompt("count to forty");
		await untilStreaming(u.session);
		const sentBefore = u.commands().filter((c) => c === "steer").length;
		const uid = (
			(await u.call("POST", "intervention/propose", { operation: "steer", message: "once" }, u.grant)).body as any
		).proposalId;
		await u.approve();
		await u.until("accepted", async () => (await u.view(uid)).state === "accepted");
		const authorization = events(u.root).find((e) => e.kind === "intervention.authorization")!.payload as {
			authorizationId: string;
		};
		expect(await u.desk.apply(uid, authorization.authorizationId)).toMatchObject({ status: "duplicate" });
		expect(u.commands().filter((c) => c === "steer")).toHaveLength(sentBefore + 1);
	}, 60_000);

	it("refuses an approval for a session that is no longer the one it was requested for, and sends nothing", async () => {
		const t = await ready();
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "swap" }, t.grant)).body as any
		).proposalId;
		await t.approval.waitForRequest();
		const before = t.commands().length;
		// The Pi session is substituted while the operator decides.
		Object.defineProperty(t.session, "piSessionId", { get: () => "another-session", configurable: true });
		t.approval.answer("allow");
		await t.until("refused", async () => (await t.view(id)).state === "refused");
		expect(await t.view(id)).toMatchObject({ reason: "authorization-for-another-session", approved: true });
		expect(t.commands().slice(before)).not.toContain("steer");
	}, 60_000);

	it("keeps working after a mid-session finish: controls stay offered and a waiting request stays waiting", async () => {
		const t = await ready();
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "still here" }, t.grant))
				.body as any
		).proposalId;
		await t.approval.waitForRequest();
		await t.desk.finish(); // the control socket's `finish`: consequences so far, nothing closed
		expect(await t.view(id)).toMatchObject({ state: "awaiting-approval" });
		t.approval.answer("allow");
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		expect((await t.status()).offers.stop.offered).toBe(true);
	}, 60_000);

	it("withdraws a waiting approval when the desk finishes, so no request is approved after the consequences", async () => {
		const t = await ready();
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "too late" }, t.grant))
				.body as any
		).proposalId;
		await t.approval.waitForRequest();
		const before = t.commands().length; // the conformance study that admitted the capabilities sent its own steer, queue and abort
		await t.desk.finish({ final: true });
		expect(await t.view(id)).toMatchObject({ state: "refused", reason: "session-ended" });
		t.approval.answer("allow");
		await settle(100);
		expect(t.commands().slice(before)).not.toContain("steer");
		const chain = events(t.root).filter((e) => e.kind.startsWith("intervention."));
		expect(chain.map((e) => e.kind)).toEqual(["intervention.proposal", "intervention.refused"]);
	}, 60_000);
});

describe("a STOP supersedes an unapproved steer on the real desk (fake Pi)", () => {
	it("sends the abort only after the STOP's own approval, and never sends the steer it cancelled", async () => {
		const t = await ready({ stepMs: 60 });
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const before = t.commands().length;
		const steer = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: `also ${SECRET}` }, t.grant))
				.body as any
		).proposalId;
		await t.until("the steer's question", () => t.approval.requests.length === 1);
		const stop = ((await t.call("POST", "intervention/propose", { operation: "stop" }, t.grant)).body as any)
			.proposalId;
		await t.until("the stop's question", () => t.approval.requests.length === 2);
		expect(t.approval.requests.map((r) => r.operation)).toEqual(["steer", "stop"]);
		expect(t.approval.requests[1]!.supersedes).toBe("steer");
		expect(await t.view(steer)).toMatchObject({ state: "refused", approved: false, reason: "superseded-by-stop" });
		// Nothing has reached Pi: the steer was cancelled and the STOP has not been approved.
		await settle(100);
		expect(t.commands().slice(before)).not.toContain("steer");
		expect(t.commands().slice(before)).not.toContain("abort");
		expect(await t.view(stop)).toMatchObject({ state: "awaiting-approval", approved: false });

		t.approval.answer("allow");
		await t.until("the stop is sent", async () => ["sent", "accepted"].includes((await t.view(stop)).state));
		expect(t.commands().slice(before)).toContain("abort");
		expect(t.commands().slice(before)).not.toContain("steer");
		await t.desk.finish();
		await t.close();

		const chain = events(t.root).filter((e) => e.kind.startsWith("intervention."));
		const of = (kind: string) => chain.filter((e) => e.kind === kind);
		// The cancelled steer's chain ends at a refusal recorded as "not authorized", with no authorization and no request.
		expect(of("intervention.proposal").map((e) => (e.payload as any).operation)).toEqual(["steer", "stop"]);
		expect(of("intervention.refused").map((e) => (e.payload as any).reason)).toEqual(["not-authorized"]);
		// The canonical record says why, in fixed words, so a supersession can be told from a withdrawal or a timeout.
		expect((of("intervention.refused")[0]!.payload as any).detail).toBe(
			"superseded by a stop request before its approval was acted on",
		);
		expect((of("intervention.refused")[0]!.payload as any).proposalId).toBe(steer);
		expect(of("intervention.authorization")).toHaveLength(1);
		expect((of("intervention.authorization")[0]!.payload as any).proposalId).toBe(stop);
		expect(of("intervention.request").map((e) => (e.payload as any).operation)).toEqual(["stop"]);
		expect(JSON.stringify(events(t.root))).not.toContain(SECRET);
	}, 60_000);

	it("discards the steer's approval typed after it was cancelled, and declines the STOP with it", async () => {
		const t = await ready({ stepMs: 60 });
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const before = t.commands().length;
		const steer = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "late approval" }, t.grant))
				.body as any
		).proposalId;
		await t.until("the steer's question", () => t.approval.requests.length === 1);
		const steerPhrase = t.approval.requests[0]!.phrase;
		const stop = ((await t.call("POST", "intervention/propose", { operation: "stop" }, t.grant)).body as any)
			.proposalId;
		await t.until("the stop's question", () => t.approval.requests.length === 2);
		expect(steerPhrase).not.toBe(t.approval.requests[1]!.phrase);
		// The operator types the old steer's phrase: it is an answer to the STOP's question, and it is not the STOP's phrase.
		t.approval.answer("deny");
		await t.until("the stop is declined", async () => (await t.view(stop)).state === "refused");
		expect(await t.view(stop)).toMatchObject({ reason: "authorization-denied", approved: false });
		expect(await t.view(steer)).toMatchObject({ state: "refused", reason: "superseded-by-stop" });
		await settle(100);
		expect(t.commands().slice(before)).not.toContain("steer");
		expect(t.commands().slice(before)).not.toContain("abort");
	}, 60_000);
});

/** Record `count` captured model requests of about `bytes` each; the message appears one more time from request `deliveredAt` on. */
function captureHistory(root: string, count: number, bytes: number, message: string, deliveredAt: number): void {
	const log = new EndoCaptureLogV0(root, KEY, "record");
	const padding = "x".repeat(bytes);
	for (let exchange = 1; exchange <= count; exchange++) {
		const messages = [
			{ role: "user", content: "count to forty" },
			{ role: "user", content: `${padding} ${exchange}` },
			...(exchange >= deliveredAt ? [{ role: "user", content: message }] : []),
		];
		const body = log.keep(Buffer.from(JSON.stringify({ model: "m", messages })));
		log.record("capture.request", {
			exchange,
			attempt: 1,
			method: "POST",
			path: "/v1/chat/completions",
			requestDigest: body.digest as unknown as JsonValueV0,
			body: body as unknown as JsonValueV0,
			headers: {},
		});
	}
	log.close();
}

describe("the evidence check over a real on-disk capture", () => {
	it("finds consumption in a large capture while status, the transcript and a STOP stay answerable between slices", async () => {
		const t = await ready({ stepMs: 100, capture: true, yieldMs: 1 });
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(
				await t.call(
					"POST",
					"intervention/propose",
					{ operation: "steer", message: "look at the notes again" },
					t.grant,
				)
			).body as any
		).proposalId;
		await t.approve();
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		// 120 captured requests of ~100 kB, recorded after the steer; the steer's text arrives in request 90.
		captureHistory(t.root, 120, 100_000, "look at the notes again", 90);

		const slices: number[] = [];
		const step = t.desk.consumptionStep.bind(t.desk);
		t.desk.consumptionStep = (...args) => {
			const started = performance.now();
			const result = step(...args);
			slices.push(performance.now() - started);
			return result;
		};

		expect((await t.call("POST", "intervention/check", { proposalId: id }, t.grant)).status).toBe(202);
		let answered = 0;
		let stopAsked = false;
		while ((await t.view(id)).consumption?.status === "checking") {
			await t.status();
			await t.call("GET", "transcript", null, t.grant);
			answered += 1;
			// A page's requests arrive over a socket, one turn of the loop apart: wait a timer, as a real client's would.
			await settle(2);
			if (!stopAsked) {
				stopAsked = true;
				const stop = await t.call("POST", "intervention/propose", { operation: "stop" }, t.grant);
				expect(stop.status).toBe(202); // requested while the check is still reading
				await t.until("the stop's question", () => t.approval.requests.length >= 1);
			}
		}
		// The check was read in slices, and the broker was served between them.
		expect(answered).toBeGreaterThan(2);
		expect(slices.length).toBeGreaterThan(5);
		expect(await t.view(id)).toMatchObject({ consumption: { status: "observed", exchange: 90 } });
		const longest = Math.max(...slices);
		console.info(
			`evidence check: ${slices.length} slices, longest ${longest.toFixed(1)} ms, served ${answered} reads between them`,
		);
		expect(longest).toBeLessThan(500); // a coarse sanity bound on one slice (~1 MiB of bodies), not a benchmark
		t.approval.answer("deny");
		await t.desk.finish();
		await t.close();
		// Exactly one consumed record, however the check and the close interleaved.
		expect(events(t.root).filter((e) => e.kind === "intervention.consumed")).toHaveLength(1);
	}, 120_000);

	it("stops at its work limit as incomplete, says what it read, and the next check resumes instead of starting over", async () => {
		const t = await ready({
			stepMs: 100,
			capture: true,
			yieldMs: 1,
			budget: { checkRequests: 30, cooldownMs: 40 },
		});
		await t.session.prompt("count to forty");
		await untilStreaming(t.session);
		const id = (
			(await t.call("POST", "intervention/propose", { operation: "steer", message: "later words" }, t.grant))
				.body as any
		).proposalId;
		await t.approve();
		await t.until("accepted", async () => (await t.view(id)).state === "accepted");
		captureHistory(t.root, 100, 20_000, "later words", 100);
		const done = async () => (await t.view(id)).consumption?.status !== "checking";
		await t.call("POST", "intervention/check", { proposalId: id }, t.grant);
		await t.until("first check ends", done);
		const first = (await t.view(id)).consumption;
		expect(first.status).toBe("incomplete");
		expect(first.reason).toContain("work limit");
		expect(first.scanned.requests).toBeLessThan(100);
		// Asked again at once: no new work.
		await t.call("POST", "intervention/check", { proposalId: id }, t.grant);
		expect((await t.view(id)).consumption.status).toBe("incomplete");
		// After the cooldown it carries on from where it stopped, and reaches the end of the capture in a few checks.
		let latest = first;
		for (let round = 0; round < 6 && latest.status !== "observed"; round++) {
			await settle(60);
			await t.call("POST", "intervention/check", { proposalId: id }, t.grant);
			await t.until("check ends", done);
			latest = (await t.view(id)).consumption;
		}
		expect(latest).toMatchObject({ status: "observed", exchange: 100 });
		expect(events(t.root).filter((e) => e.kind === "intervention.consumed")).toHaveLength(1);
	}, 60_000);
});
