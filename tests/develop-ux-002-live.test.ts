// DEVELOP-UX-002 over a REAL attachment to the fake Pi (a real child process speaking Pi's RPC), a real event store and the real
// intervention desk: ten prompts under one session-control grant with no terminal question, a steer and a stop on the open run, and
// what the store holds afterwards, read back from disk. No provider, no model, no network.
//
// The enforced boundary is a STAND-IN constructed here; the fake Pi runs unsandboxed. This proves the authority path end to end
// through the real runtime adapter and store. It is not evidence of containment.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import { type WorkbenchApprovalRequestV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { endoInterventionCaptureSourceV0 } from "../cli/intervention-capture.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = "CANARY-live-prompt-77aa";

function bytesUnder(dir: string): string {
	let all = "";
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			// Pi's own session files are Pi's retention, outside Endophasia's records (docs/develop-workbench.md §12), as is the desk's
			// keyed blob store for a steer's text (§13).
			if (name !== "pi-sessions" && name !== "interventions") all += bytesUnder(path);
		} else all += readFileSync(path, "latin1");
	}
	return all;
}

describe("Everyday over a real attachment and store (a stand-in boundary: authority only)", () => {
	it("sends ten prompts and a steer and a stop under one grant, asks the terminal nothing, and the store says how each was authorised", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-ux2-live-");
		const cwd = temp("endo-ux2-livecwd-");
		// The interventions are offered only for admitted capabilities: record the live study first, in the same root.
		const studier = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "5" }),
			requestTimeoutMs: 10_000,
		});
		await studier.checkLocal();
		await studier.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "5" }),
			requestTimeoutMs: 10_000,
		});
		await pi.identify();
		await pi.checkLocal();
		const session = await pi.openSession();
		let closed = false;
		const close = async () => {
			if (!closed) {
				closed = true;
				await session.close();
			}
		};
		cleanup.push(close);
		const key = session.owner.digestKey();
		const desk = new PiInterventionDeskV0(session, key, endoInterventionCaptureSourceV0(root, key));
		const asked: WorkbenchApprovalRequestV0[] = [];
		const broker = new WorkbenchBrokerV0({
			session,
			key,
			attachment: session.owner.attachment,
			interventions: desk,
			approver: async (request) => {
				asked.push(request);
				return "deny";
			},
			control: {
				mode: "everyday",
				workspaceRoot: cwd,
				protection: {
					observe: () => ({
						state: "enforced",
						level: "workspace",
						mechanism: "test-stand-in.v0",
						session: session.piSessionId === null ? null : `endo.session.pi.${session.piSessionId}`,
						workspaceRoot: cwd,
						limitations: [],
					}),
				},
			},
		});
		const call = (
			method: "GET" | "POST",
			route: string,
			body: unknown = null,
			grant: string | null = null,
		): Promise<any> => broker.handle({ method, route: route.split("/"), query: "", grant, body });
		const runsEnded = () =>
			broker.transcript.view(0).items.filter((item) => item.kind === "run" && item.state === "ended").length;
		const issued = broker.issuePairingCode({ control: true });
		expect(issued.control).toMatchObject({ workspaceRoot: cwd, operations: ["prompt", "steer", "queue", "stop"] });
		const grant = (await call("POST", "pair", { code: issued.code })).body.grant as string;

		for (let i = 0; i < 10; i++) {
			let reply = await call("POST", "prompt/propose", { message: `${SECRET} message ${i}` }, grant);
			// A prompt is offered only when the agent is idle: wait for the previous run to settle, as a person would.
			for (let n = 0; n < 400 && reply.status === 409; n++) {
				await sleep(25);
				reply = await call("POST", "prompt/propose", { message: `${SECRET} message ${i}` }, grant);
			}
			expect(reply.status, `prompt ${i}`).toBe(202);
			expect(reply.body.authorizedBy).toBe("session-grant");
			for (let n = 0; n < 400; n++) {
				const view = (await call("GET", `prompt/${reply.body.proposalId}`, null, grant)).body;
				if (view.state === "accepted") break;
				expect(view.state, `prompt ${i}`).toBe("dispatching");
				await sleep(10);
			}
			// The run this prompt opened has ended, by the broker's own live transcript (not by a wait that could miss a fast run).
			for (let n = 0; n < 1500 && runsEnded() < i + 1; n++) await sleep(10);
			expect(runsEnded(), `run ${i}`).toBe(i + 1);
		}
		// An open run, then a steer and a stop under the same grant.
		let last = await call("POST", "prompt/propose", { message: "Count to forty" }, grant);
		for (let n = 0; n < 400 && last.status === 409; n++) {
			await sleep(25);
			last = await call("POST", "prompt/propose", { message: "Count to forty" }, grant);
		}
		expect(last.status).toBe(202);
		for (let n = 0; n < 400 && (await call("GET", "status", null, grant)).body.run !== "active"; n++) await sleep(10);
		const steer = await call(
			"POST",
			"intervention/propose",
			{ operation: "steer", message: `${SECRET} go left` },
			grant,
		);
		const stop = await call("POST", "intervention/propose", { operation: "stop" }, grant);
		expect([steer.status, stop.status]).toEqual([202, 202]);
		for (let n = 0; n < 400; n++) {
			const view = (await call("GET", `intervention/${stop.body.proposalId}`, null, grant)).body;
			if (view.state === "accepted") break;
			await sleep(25);
		}
		expect((await call("GET", `intervention/${stop.body.proposalId}`, null, grant)).body).toMatchObject({
			state: "accepted",
			authorizedBy: "session-grant",
		});
		expect(asked).toEqual([]);
		expect((await call("GET", "status", null, grant)).body.sessionControl.sendsLeft).toBe(200 - 13);

		await desk.finish({ final: true });
		await broker.dispose();
		await close();

		// Read back from disk, by another reader.
		const store = createEndoDurableEventStoreV0(root, { readOnly: true });
		const events: any[] = [];
		for (let after = 0; ; ) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		store.close();
		const of = (kind: string) => events.filter((e) => e.kind === kind);
		const granted = of("workbench.session-control-granted");
		expect(granted).toHaveLength(1);
		expect(granted[0].source).toBe("authority-decision");
		const grantId = granted[0].payload.grantId;
		const authorized = of("workbench.prompt-authorized");
		expect(authorized).toHaveLength(11);
		for (const a of authorized)
			expect(a.payload).toMatchObject({ decision: "allow", confirmation: "session-grant", sessionGrant: grantId });
		expect(of("workbench.prompt-dispatched")).toHaveLength(11);
		expect(of("workbench.prompt-accepted")).toHaveLength(11);
		// Each step is its own event, in order, for every prompt.
		const chain = events.filter((e) => e.kind.startsWith("workbench.prompt-")).map((e) => e.kind.slice(17));
		expect(chain.slice(0, 4)).toEqual(["proposed", "authorized", "dispatched", "accepted"]);
		expect(
			of("intervention.authorization").map((e) => [
				e.payload.decision,
				e.payload.authority.confirmation,
				e.payload.authority.sessionGrant,
			]),
		).toEqual([
			["allow", "session-grant", grantId],
			["allow", "session-grant", grantId],
		]);
		const ended = of("workbench.session-control-ended");
		expect(ended).toHaveLength(1);
		expect(ended[0].payload).toMatchObject({ grantId, reason: "closing", sends: 13 });
		expect(ended[0].source).toBe("policy-conclusion");
		// Privacy: Endophasia's own files hold no prompt text, no workspace path in a grant record, no token and no pairing code.
		const stored = bytesUnder(root);
		for (const forbidden of [SECRET, grant, issued.code]) expect(stored).not.toContain(forbidden);
		expect(JSON.stringify([granted, ended])).not.toContain(cwd);
		expect(JSON.stringify(events)).not.toMatch(/"verified"|approved by the operator/);
	}, 120_000);
});
