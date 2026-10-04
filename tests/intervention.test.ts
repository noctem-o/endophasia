// STEER, QUEUE and STOP as explicit, authorized, verified interventions (protocol/intervention.ts,
// runtime/contracts/intervention.ts, adapters/pi/intervention.ts, cli/control.ts), against the fake Pi. The hostile
// cases: apply without authorization; an authorization reused for another proposal or session; a proposal tampered
// with after authorization; a steer after the session ended; STOP racing completion; a duplicate apply; an unknown
// control message; a control endpoint with the wrong permissions. In every refused case nothing reaches Pi.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import {
	endoControlDirectoryV0,
	endoControlRequestV0,
	endoControlSocketV0,
	startEndoControlServerV0,
} from "../cli/control.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	ENDO_INTERVENTION_SCHEMA_V0,
	type EndoInterventionAuthorizationV0,
	type EndoInterventionProposalV0,
} from "../protocol/intervention.ts";
import {
	endoFindConsumptionV0,
	endoInterventionAuthorizationV0,
	endoInterventionGateV0,
	endoInterventionMessageRefV0,
	endoInterventionProposalV0,
	localOperatorAuthorityV0,
} from "../runtime/contracts/intervention.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	// Short paths: a Unix socket path is limited to about 100 bytes.
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
const KEY = endoDigestKeyV0(Buffer.alloc(32, 7), "intervention-test");

// ---------------------------------------------------------------------------------------------------------------
// The gate, pure
// ---------------------------------------------------------------------------------------------------------------

const SESSION = "endo.session.pi.s1";
function proposalFor(session = SESSION, text = "look at notes.txt again", nonce = "n1"): EndoInterventionProposalV0 {
	return endoInterventionProposalV0({
		schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
		origin: "operator-cli",
		operation: "steer",
		message: endoInterventionMessageRefV0(KEY, text),
		session,
		attachment: "pi.default",
		basis: { observationId: null, interpretationId: null },
		nonce,
	});
}
const allow = (proposal: EndoInterventionProposalV0) =>
	endoInterventionAuthorizationV0(proposal, localOperatorAuthorityV0(proposal.proposalDigest), "a1");
const gate = (
	proposal: EndoInterventionProposalV0,
	authorization: EndoInterventionAuthorizationV0 | null,
	over: Partial<Parameters<typeof endoInterventionGateV0>[0]> = {},
) =>
	endoInterventionGateV0({
		proposal,
		authorization,
		messageVerified: true,
		currentSession: SESSION,
		currentAttachment: "pi.default",
		capability: { admitted: true },
		sessionLive: true,
		runActive: true,
		...over,
	});

describe("the gate (default deny)", () => {
	it("passes only an allowed, matching, untampered proposal for this live session with an active run", () => {
		const proposal = proposalFor();
		expect(gate(proposal, allow(proposal))).toEqual({ ok: true });
	});

	it("refuses each failure with its reason", () => {
		const proposal = proposalFor();
		const other = proposalFor(SESSION, "something else", "n2");
		const denied = endoInterventionAuthorizationV0(proposal, localOperatorAuthorityV0(null), "a2");
		const wrongDigest = endoInterventionAuthorizationV0(proposal, localOperatorAuthorityV0("0".repeat(64)), "a3");
		const reason = (result: ReturnType<typeof gate>) => (result.ok ? "ok" : result.reason);
		expect(reason(gate(proposal, null))).toBe("not-authorized");
		expect(reason(gate(proposal, denied))).toBe("authorization-denied");
		expect(denied.reason).toBe("the operator confirmed no digest");
		expect(reason(gate(proposal, wrongDigest))).toBe("authorization-denied");
		expect(reason(gate(other, allow(proposal)))).toBe("authorization-for-another-proposal");
		// Tampered: the content changed after the digest was taken, or the stored message no longer matches.
		const tampered = { ...proposal, operation: "queue" as const };
		expect(reason(gate(tampered, allow(proposal)))).toBe("proposal-tampered");
		expect(reason(gate(proposal, allow(proposal), { messageVerified: false }))).toBe("proposal-tampered");
		// An authorization record copied from another session, or a proposal replayed into another session.
		const forged = { ...allow(proposal), session: "endo.session.pi.s2" };
		expect(reason(gate(proposal, forged))).toBe("authorization-for-another-session");
		const elsewhere = proposalFor("endo.session.pi.s2");
		expect(reason(gate(elsewhere, allow(elsewhere)))).toBe("authorization-for-another-session");
		expect(reason(gate(proposal, { ...allow(proposal), attachment: "pi.other" }))).toBe(
			"authorization-for-another-attachment",
		);
		expect(
			reason(
				gate(proposal, allow(proposal), {
					capability: { admitted: false, reason: "steering.steer is not admitted" },
				}),
			),
		).toBe("capability-unavailable");
		expect(reason(gate(proposal, allow(proposal), { sessionLive: false }))).toBe("session-ended");
		expect(reason(gate(proposal, allow(proposal), { runActive: false }))).toBe("no-active-run");
	});

	it("consumption is found only by the message's keyed digest, from the given exchange on", () => {
		const proposal = proposalFor();
		const body = (text: string) => ({ messages: [{ role: "user", content: [{ type: "text", text }] }] });
		const requests = [
			{ exchange: 1, captureEvent: "endo.event.c1", body: body("look at notes.txt again") },
			{ exchange: 2, captureEvent: "endo.event.c2", body: body("unrelated") },
			{ exchange: 3, captureEvent: "endo.event.c3", body: body("look at notes.txt again") },
		];
		expect(endoFindConsumptionV0(requests, proposal.message!, KEY, 1)?.exchange).toBe(1);
		expect(endoFindConsumptionV0(requests, proposal.message!, KEY, 2)?.exchange).toBe(3);
		expect(endoFindConsumptionV0(requests.slice(0, 2), proposal.message!, KEY, 2)).toBeNull();
		const otherKey = endoDigestKeyV0(Buffer.alloc(32, 9), "other");
		expect(endoFindConsumptionV0(requests, proposal.message!, otherKey, 1)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// The desk against the fake Pi
// ---------------------------------------------------------------------------------------------------------------

async function ready(options: { admitted?: boolean; scenario?: string } = {}) {
	const install = installFakePi("1.0.0");
	cleanup.push(() => install.remove());
	const root = temp("endo-iv-");
	const cwd = temp("endo-iv-cwd-");
	const log = join(temp("endo-iv-log-"), "commands.log");
	const pi = new PiAttachmentV0({
		root,
		cwd,
		executable: install.bin,
		env: fakePiEnv({ FAKE_PI_STEP_MS: "15", FAKE_PI_LOG: log }),
		requestTimeoutMs: 10_000,
		digestKey: KEY,
	});
	await pi.checkLocal();
	if (options.admitted !== false) await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
	install.setScenario(options.scenario ?? "");
	const session = await pi.openSession();
	let closed = false;
	cleanup.push(async () => {
		if (!closed) await session.close();
	});
	const desk = new PiInterventionDeskV0(session, KEY);
	const commands = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
	const sinceNow = () => {
		const from = commands().length;
		return () => commands().slice(from);
	};
	return {
		root,
		session,
		desk,
		sinceNow,
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
const interventions = (root: string) => events(root).filter((event) => event.kind.startsWith("intervention."));

describe("the desk (fake Pi)", () => {
	it("records the whole chain, linked by id, with each record's source class; acceptance is Pi's reply", async () => {
		const { root, session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposal = desk.propose({ operation: "steer", message: "Endophasia steer: also say hello" });
		const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
		const sent = sinceNow();
		const result = await desk.apply(proposal.proposalId, authorization.authorizationId);
		expect(result).toMatchObject({ status: "accepted", disposition: "queued" });
		expect(sent()).toContain("steer");
		expect(await settled).toBe(true);
		desk.finish();
		await close();
		const chain = interventions(root);
		expect(chain.map((event) => [event.kind, event.source])).toEqual([
			["intervention.proposal", "policy-conclusion"],
			["intervention.authorization", "authority-decision"],
			["intervention.request", "runtime-fact"],
			["intervention.accepted", "runtime-fact"],
			["intervention.consequence", "evaluation-result"],
		]);
		for (let index = 1; index < chain.length; index += 1)
			expect(chain[index]!.derivedFrom.length, chain[index]!.kind).toBeGreaterThan(0);
		expect(chain[1]!.derivedFrom).toEqual([chain[0]!.id]);
		expect(chain[2]!.derivedFrom).toEqual([chain[1]!.id]);
		expect(chain[3]!.derivedFrom).toEqual([chain[2]!.id]);
		// No proxy capture in this store: consumption is not observed, and says why. It is never assumed.
		expect(chain[4]!.payload).toMatchObject({
			acceptance: { status: "accepted", disposition: "queued" },
			consumption: { status: "not-observed", reason: "this session store holds no proxy capture" },
		});
		// The message itself is outside canonical evidence; the records carry only its keyed digest.
		expect(JSON.stringify(events(root))).not.toContain("also say hello");
	});

	it("apply without authorization is refused and recorded; nothing reaches Pi", async () => {
		const { root, session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposal = desk.propose({ operation: "steer", message: "unauthorized steer" });
		const sent = sinceNow();
		const result = await desk.apply(proposal.proposalId, "endo.evidence.intervention.authorization.none");
		expect(result).toMatchObject({ status: "refused", reason: "not-authorized", requestId: null });
		// A denied authorization (no digest confirmed) is refused too.
		const denied = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(null));
		expect(await desk.apply(proposal.proposalId, denied.authorizationId)).toMatchObject({
			status: "refused",
			reason: "authorization-denied",
		});
		expect(sent()).not.toContain("steer");
		await settled;
		await close();
		expect(interventions(root).map((event) => event.kind)).toEqual([
			"intervention.proposal",
			"intervention.refused",
			"intervention.authorization",
			"intervention.refused",
		]);
	});

	it("an authorization is bound to its proposal: reused for another, it is refused", async () => {
		const { session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const first = desk.propose({ operation: "steer", message: "the authorized one" });
		const second = desk.propose({ operation: "steer", message: "a different one" });
		const authorization = desk.authorize(first.proposalId, localOperatorAuthorityV0(first.proposalDigest));
		const sent = sinceNow();
		expect(await desk.apply(second.proposalId, authorization.authorizationId)).toMatchObject({
			status: "refused",
			reason: "authorization-for-another-proposal",
		});
		expect(sent()).not.toContain("steer");
		await settled;
		await close();
	});

	it("an authorization record from another session is refused", async () => {
		const { session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposal = desk.propose({ operation: "steer", message: "bound here" });
		// A record copied in from another session's store: same proposal id and digest, another session.
		const copied = { ...allow(proposal), session: "endo.session.pi.another" };
		session.recordIntervention("intervention.authorization", copied as never, []);
		const reopened = new PiInterventionDeskV0(session, KEY);
		const sent = sinceNow();
		expect(await reopened.apply(proposal.proposalId, copied.authorizationId)).toMatchObject({
			status: "refused",
			reason: "authorization-for-another-session",
		});
		expect(sent()).not.toContain("steer");
		await settled;
		await close();
	});

	it("a proposal whose message was changed after authorization is refused as tampered", async () => {
		const { root, session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposal = desk.propose({ operation: "steer", message: "the confirmed text" });
		const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
		const blob = join(root, "interventions", "blobs", KEY.keyId, proposal.message!.digest.value);
		writeFileSync(blob, "a different text entirely");
		const sent = sinceNow();
		expect(await desk.apply(proposal.proposalId, authorization.authorizationId)).toMatchObject({
			status: "refused",
			reason: "proposal-tampered",
		});
		expect(sent()).not.toContain("steer");
		await settled;
		await close();
	});

	it("a steer after the run ended, or after Pi exited, is refused; nothing is sent", async () => {
		const { session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("hello");
		const proposal = desk.propose({ operation: "steer", message: "too late" });
		const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
		expect(await settled).toBe(true);
		const sent = sinceNow();
		expect(await desk.apply(proposal.proposalId, authorization.authorizationId)).toMatchObject({
			status: "refused",
			reason: "no-active-run",
		});
		process.kill(session.pid!, "SIGKILL");
		const deadline = Date.now() + 5_000;
		while (session.live && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
		const again = desk.propose({ operation: "steer", message: "after exit" });
		const allowed = desk.authorize(again.proposalId, localOperatorAuthorityV0(again.proposalDigest));
		expect(await desk.apply(again.proposalId, allowed.authorizationId)).toMatchObject({
			status: "refused",
			reason: "session-ended",
		});
		expect(sent()).not.toContain("steer");
		await close();
	});

	it("an operation whose capability evidence does not admit it is UNAVAILABLE with the reason", async () => {
		const { session, desk, close } = await ready({ admitted: false });
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		const proposal = desk.propose({ operation: "queue", message: "later" });
		const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
		const result = await desk.apply(proposal.proposalId, authorization.authorizationId);
		expect(result).toMatchObject({ status: "refused", reason: "capability-unavailable" });
		expect((result as { detail: string }).detail).toMatch(/steering\.follow-up is not admitted/);
		await settled;
		await close();
	});

	it("a duplicate apply is idempotent: one request, recorded once, however it is repeated", async () => {
		const { root, session, desk, sinceNow, close } = await ready();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposal = desk.propose({ operation: "queue", message: "after that, say done" });
		const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
		const sent = sinceNow();
		const [a, b] = await Promise.all([
			desk.apply(proposal.proposalId, authorization.authorizationId),
			desk.apply(proposal.proposalId, authorization.authorizationId),
		]);
		const c = await new PiInterventionDeskV0(session, KEY).apply(proposal.proposalId, authorization.authorizationId);
		expect([a.status, b.status, c.status].sort()).toEqual(["accepted", "duplicate", "duplicate"]);
		expect(sent().filter((command) => command === "follow_up")).toHaveLength(1);
		await settled;
		await close();
		expect(interventions(root).filter((event) => event.kind === "intervention.request")).toHaveLength(1);
		expect(interventions(root).filter((event) => event.kind === "intervention.accepted")).toHaveLength(1);
	});

	it("STOP racing completion: whichever wins, the record never claims an abort that did not happen", async () => {
		for (const delayMs of [0, 30, 60, 120]) {
			const { root, session, desk, close } = await ready();
			const settled = session.waitForSettled(10_000);
			await session.prompt("hello");
			const proposal = desk.propose({ operation: "stop" });
			const authorization = desk.authorize(proposal.proposalId, localOperatorAuthorityV0(proposal.proposalDigest));
			await new Promise((done) => setTimeout(done, delayMs));
			const result = await desk.apply(proposal.proposalId, authorization.authorizationId);
			expect(await settled).toBe(true);
			desk.finish();
			await close();
			const all = events(root);
			const aborted = all.some((event) => event.kind === "lifecycle.run-aborted");
			const consequence = all.find((event) => event.kind === "intervention.consequence")?.payload as
				| { effect: { lastRunEnding: string | null }; consumption: { status: string } }
				| undefined;
			if (result.status === "refused") {
				// The run had already ended when the gate looked: nothing was sent, and no consequence is claimed.
				expect(result.reason, `delay ${delayMs}`).toBe("no-active-run");
				expect(consequence).toBeUndefined();
				expect(aborted).toBe(false);
			} else {
				expect(result.status).toBe("accepted");
				expect(consequence!.consumption.status).toBe("not-applicable");
				// The consequence reports the run's recorded ending after the request, aborted or not, never assumed.
				const ending = consequence!.effect.lastRunEnding;
				expect(ending === "aborted").toBe(aborted);
			}
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// The control endpoint
// ---------------------------------------------------------------------------------------------------------------

describe("the control endpoint", () => {
	it("serves propose, authorize, apply and status; an unknown message is refused and recorded", async () => {
		const { root, session, desk, close } = await ready();
		const server = await startEndoControlServerV0(root, desk);
		cleanup.push(() => server.close());
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		const proposed = await endoControlRequestV0(root, {
			type: "propose",
			operation: "steer",
			message: "via control",
		});
		expect(proposed.ok).toBe(true);
		const proposal = proposed.result as unknown as EndoInterventionProposalV0;
		const authorized = await endoControlRequestV0(root, {
			type: "authorize",
			proposalId: proposal.proposalId,
			confirmDigest: proposal.proposalDigest,
		});
		const authorization = authorized.result as unknown as EndoInterventionAuthorizationV0;
		expect(authorization.decision).toBe("allow");
		const applied = await endoControlRequestV0(root, {
			type: "apply",
			proposalId: proposal.proposalId,
			authorizationId: authorization.authorizationId,
		});
		expect(applied.result).toMatchObject({ status: "accepted" });
		const unknown = await endoControlRequestV0(root, { type: "self-destruct" });
		expect(unknown).toMatchObject({ ok: false, error: 'unknown control message type "self-destruct"' });
		const status = await endoControlRequestV0(root, { type: "status" });
		expect((status.result as { proposals: unknown[] }).proposals).toHaveLength(1);
		await settled;
		await endoControlRequestV0(root, { type: "close" });
		await server.closeRequested;
		await server.close();
		await close();
		expect(
			events(root)
				.filter((event) => event.kind === "control.message-refused")
				.map((event) => event.payload),
		).toEqual([{ type: "self-destruct", reason: "unknown control message type" }]);
	});

	it("refuses an endpoint with the wrong permissions, on both sides", async () => {
		const { root, desk } = await ready();
		const server = await startEndoControlServerV0(root, desk);
		cleanup.push(() => server.close());
		// The client checks the directory and the socket before connecting.
		chmodSync(endoControlDirectoryV0(root), 0o755);
		await expect(endoControlRequestV0(root, { type: "status" })).rejects.toThrow(
			/open to others \(mode 755\); it must be 0700/,
		);
		chmodSync(endoControlDirectoryV0(root), 0o700);
		chmodSync(endoControlSocketV0(root), 0o666);
		await expect(endoControlRequestV0(root, { type: "status" })).rejects.toThrow(
			/open to others \(mode 666\); it must be 0600/,
		);
		chmodSync(endoControlSocketV0(root), 0o600);
		expect((await endoControlRequestV0(root, { type: "status" })).ok).toBe(true);
		await server.close();
		// The server refuses to serve from a directory others can enter.
		chmodSync(endoControlDirectoryV0(root), 0o750);
		await expect(startEndoControlServerV0(root, desk)).rejects.toThrow(
			/refusing to serve control: .* it must be 0700/,
		);
	});
});
