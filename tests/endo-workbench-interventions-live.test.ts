// STEER, QUEUE and STOP through the workbench broker onto the REAL intervention desk, against the fake Pi (a real child process speaking
// Pi's RPC) and a hand-resolved terminal approver. What the broker test cannot show: the desk's own gate, its records in a real store,
// what reaches Pi and what does not, and the order of the chain. No provider, no model, no network.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
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

async function ready(options: { admitted?: boolean; stepMs?: number } = {}) {
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
	const desk = new PiInterventionDeskV0(session, KEY);
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: KEY,
		attachment: session.owner.attachment,
		approver: approval.approver,
		interventions: desk,
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
		const checked = await t.call("POST", "intervention/check", { proposalId: id }, t.grant);
		expect(checked.body).toMatchObject({
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
		await t.desk.finish();
		expect(await t.view(id)).toMatchObject({ state: "refused", reason: "session-ended" });
		t.approval.answer("allow");
		await settle(100);
		expect(t.commands().slice(before)).not.toContain("steer");
		const chain = events(t.root).filter((e) => e.kind.startsWith("intervention."));
		expect(chain.map((e) => e.kind)).toEqual(["intervention.proposal", "intervention.refused"]);
	}, 60_000);
});
