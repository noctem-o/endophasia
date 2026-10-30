// The workbench over its real HTTP surface, then end to end with the fake Pi: the guards a browser request must pass, the closed route
// list, the absence of any command route on the read-only server, and one real prompt that is requested, approved on the (stand-in)
// terminal, sent to a real Pi child process and seen in a private transcript that never reaches canonical evidence or a read route.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { event, ingestAll, removeTempRoots, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, raw, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { Approval, FakeDesk, FakeSession, settle, textMessage } from "./workbench-fixtures.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	await stopServers();
	for (const done of cleanup.splice(0).reverse()) await done();
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

const API = "/api/v0/workbench/";
const SECRET = "CANARY-live-text-5b7a-never-in-evidence";

async function startBroker(options: { interventions?: boolean } = {}) {
	const session = new FakeSession();
	const approval = new Approval();
	const desk = new FakeDesk(session);
	session.runActive = options.interventions === true;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		...(options.interventions === true ? { interventions: desk } : {}),
	});
	const root = tempRoot("endo-wb-http-");
	ingestAll(root, [
		event("harness.attached", {}, { session: "endo.session.pi.x", producer: "pi-rpc-adapter:pi.default" }),
	]);
	const server = await serve(root, { workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	const origin = server.origin;
	const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
		send(server, `${capabilityOf(server)}${API}${route}`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	const getW = (route: string, headers: Record<string, string> = {}) => get(server, `${API}${route}`, headers);
	return { session, approval, desk, broker, root, server, origin, post, getW };
}
const errorOf = (r: { body: string }) => (JSON.parse(r.body) as { error: string }).error;

describe("the read-only server has no command surface", () => {
	it("refuses every POST and has no workbench: one constant status answer, nothing else", async () => {
		const root = tempRoot("endo-wb-ro-");
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.pi.x", producer: "pi-rpc-adapter:pi.default" }),
		]);
		const server = await serve(root);
		const target = `${capabilityOf(server)}${API}pair`;
		for (const method of ["POST", "PUT", "DELETE", "PATCH"])
			expect((await send(server, target, { method })).status).toBe(405);
		// HEAD is refused too (checked on the wire: a client cannot parse a body on a HEAD answer).
		expect(
			await raw(
				server,
				`HEAD ${capabilityOf(server)}${API}status HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`,
			),
		).toMatch(/^HTTP\/1\.1 405/);
		// The one constant answer: this server has no workbench (a quiet probe; nothing else under the prefix exists).
		const probe = await get(server, `${API}status`);
		expect([probe.status, JSON.parse(probe.body)]).toEqual([
			200,
			{ available: false, schemaVersion: "endo.workbench-status.v0" },
		]);
		expect((await get(server, `${API}status?x=1`)).status).toBe(404);
		expect((await get(server, `${API}transcript`)).status).toBe(404);
		// No intervention route exists here either: Studio holds no control authority, ever.
		for (const route of ["propose", "discard", "check"])
			expect(
				(await send(server, `${capabilityOf(server)}${API}intervention/${route}`, { method: "POST" })).status,
			).toBe(405);
		expect(
			(await get(server, `${API}intervention/endo.evidence.intervention.proposal.${"0".repeat(64)}`)).status,
		).toBe(404);
	});
});

describe("the intervention routes", () => {
	it("pass the same guards as every command: a same-origin Origin, JSON, the grant in its header, a bounded body", async () => {
		const { broker, post, server, origin } = await startBroker({ interventions: true });
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		const body = { operation: "stop" };
		const url = `${capabilityOf(server)}${API}intervention/propose`;
		const fetchWith = (headers: Record<string, string>, payload: string = JSON.stringify(body)) =>
			send(server, url, { method: "POST", headers, body: payload });
		const good = { Origin: origin, "Content-Type": "application/json", "X-Endo-Grant": grant };
		expect((await fetchWith({ "Content-Type": "application/json", "X-Endo-Grant": grant })).status).toBe(403); // no Origin
		expect((await fetchWith({ ...good, Origin: "http://evil.example" })).status).toBe(403);
		expect((await fetchWith({ ...good, "Content-Type": "text/plain" })).status).toBeGreaterThanOrEqual(400);
		expect((await fetchWith({ Origin: origin, "Content-Type": "application/json" })).status).toBe(401); // no grant
		expect((await fetchWith({ ...good, "X-Endo-Grant": `${grant}x` })).status).toBe(401);
		expect((await fetchWith(good, "x".repeat(100_000))).status).toBeGreaterThanOrEqual(400);
		// A grant in the URL is no grant.
		expect(
			(
				await send(server, `${url}?grant=${grant}`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})
			).status,
		).toBeGreaterThanOrEqual(400);
		expect((await fetchWith(good)).status).toBe(202);
	});

	it("are a closed list: nothing passes a raw Pi command through, and a made-up operation or id reaches nothing", async () => {
		const { broker, post, getW, desk } = await startBroker({ interventions: true });
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		const headers = { "X-Endo-Grant": grant };
		for (const operation of ["abort", "abort_and_prompt", "clear_queue", "bash", "follow_up", "prompt", "STOP", ""])
			expect((await post("intervention/propose", { operation, message: "x" }, headers)).status, operation).toBe(400);
		for (const route of [
			"intervention/abort",
			"intervention/rpc",
			"intervention/apply",
			"intervention/authorize",
			"intervention/propose/x",
		])
			expect((await post(route, { proposalId: "x" }, headers)).status, route).toBe(404);
		// The page cannot authorise or apply: there is no such route, and an id it makes up is unknown.
		expect((await getW("intervention/apply", headers)).status).toBe(404);
		expect((await post("intervention/discard", { proposalId: "made-up" }, headers)).status).toBe(404);
		expect(desk.proposals.size + desk.applyCalls.length + desk.authorizations.length).toBe(0);
	});

	it("let exactly one of two concurrent steer requests through, and keep the text out of every read route", async () => {
		const { broker, post, getW, approval, desk, server, session } = await startBroker({ interventions: true });
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		const headers = { "X-Endo-Grant": grant };
		const [a, b] = await Promise.all([
			post("intervention/propose", { operation: "steer", message: SECRET }, headers),
			post("intervention/propose", { operation: "steer", message: SECRET }, headers),
		]);
		expect([a.status, b.status].sort()).toEqual([202, 409]);
		await approval.waitForRequest();
		expect(approval.requests).toHaveLength(1);
		expect(desk.proposals.size).toBe(1);
		// Nothing a read route serves carries the text, even though the page asked with it.
		for (const route of [`${API}status`, "/api/v0/snapshot", "/api/v0/develop/sessions"])
			expect((await get(server, route, headers)).body, route).not.toContain(SECRET);
		const view = JSON.parse(a.status === 202 ? a.body : b.body) as { proposalId: string };
		expect((await getW(`intervention/${view.proposalId}`, headers)).body).not.toContain(SECRET);
		expect(JSON.stringify(session.records)).not.toContain(SECRET);
	});
});

describe("a STOP and an evidence check over the real HTTP surface", () => {
	it("lets a STOP replace a steer that awaits approval, and answers a check at once, then by reading its view", async () => {
		const { broker, post, getW, approval, desk, server } = await startBroker({ interventions: true });
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		const headers = { "X-Endo-Grant": grant };
		const steer = JSON.parse(
			(await post("intervention/propose", { operation: "steer", message: "first thought" }, headers)).body,
		) as { proposalId: string };
		await approval.waitForRequest();
		// A second steer is withheld; a STOP is not.
		expect((await post("intervention/propose", { operation: "queue", message: "x" }, headers)).status).toBe(409);
		const stop = await post("intervention/propose", { operation: "stop" }, headers);
		expect(stop.status).toBe(202);
		for (let i = 0; i < 200 && approval.requests.length < 2; i++) await settle(5);
		expect(approval.requests.map((r) => r.operation)).toEqual(["steer", "stop"]);
		expect(JSON.parse((await getW(`intervention/${steer.proposalId}`, headers)).body)).toMatchObject({
			state: "refused",
			reason: "superseded-by-stop",
			approved: false,
		});
		approval.answer("deny");
		await settle(30);
		expect(desk.applyCalls).toEqual([]);

		// A check on a steer that Pi accepted: answered at once with its progress, then read back from the view.
		const second = JSON.parse(
			(await post("intervention/propose", { operation: "steer", message: "second thought" }, headers)).body,
		) as { proposalId: string };
		await approval.waitForRequest();
		approval.answer("allow");
		await settle(30);
		desk.release(second.proposalId);
		await settle(30);
		const started = await post("intervention/check", { proposalId: second.proposalId }, headers);
		expect(started.status).toBe(202);
		expect(JSON.parse(started.body)).toMatchObject({ consumption: { status: "checking" } });
		await settle(60);
		expect(JSON.parse((await getW(`intervention/${second.proposalId}`, headers)).body)).toMatchObject({
			consumption: { status: "not-observed" },
		});
		expect(server.baseUrl).toBeTruthy();
	});
});

describe("the guards on a command request", () => {
	it("answers a POST only with an exact same-origin Origin, the one content type and a bounded JSON body", async () => {
		const { post, getW, server, origin } = await startBroker();
		const ok = await post("pair", { code: "AAAA-AAAA" });
		expect(ok.status).toBe(401); // reached the broker: a wrong code
		for (const [name, headers] of [
			["no Origin", { Origin: undefined }],
			["foreign Origin", { Origin: "http://evil.example" }],
			["null Origin", { Origin: "null" }],
			["Origin with another port", { Origin: "http://127.0.0.1:1" }],
			["cross-site fetch metadata", { "Sec-Fetch-Site": "cross-site" }],
		] as const) {
			const h: Record<string, string> = { Origin: origin, "Content-Type": "application/json" };
			for (const [k, v] of Object.entries(headers))
				if (v === undefined) delete h[k];
				else h[k] = v;
			const r = await send(server, `${capabilityOf(server)}${API}pair`, { method: "POST", headers: h, body: "{}" });
			expect([r.status, errorOf(r)], name).toEqual([403, "forbidden"]);
		}
		for (const [name, type] of [
			["a form type", "application/x-www-form-urlencoded"],
			["text", "text/plain"],
			["json with a parameter", "application/json; charset=utf-8"],
			["no type", ""],
		] as const) {
			const headers: Record<string, string> = { Origin: origin };
			if (type !== "") headers["Content-Type"] = type;
			const r = await send(server, `${capabilityOf(server)}${API}pair`, { method: "POST", headers, body: "{}" });
			expect([r.status, errorOf(r)], name).toEqual([400, "bad-request"]);
		}
		const hostile = await send(server, `${capabilityOf(server)}${API}pair`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json", Host: "evil.example" },
			body: "{}",
		});
		expect(hostile.status).toBe(421);
		// The transport bound fits the largest prompt with every byte escaped (40 KiB); beyond it the body is refused before the broker.
		expect((await post("pair", "x".repeat(41_000))).status).toBe(400);
		expect((await post("pair", "x".repeat(9000))).status).toBe(401); // reached the broker: a pairing body that is not a code
		expect(
			(
				await send(server, `${capabilityOf(server)}${API}pair`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: "{not json",
				})
			).status,
		).toBe(400);
		expect(
			(
				await send(server, `${capabilityOf(server)}${API}pair`, {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: "",
				})
			).status,
		).toBe(400);
		// Chunked bodies are refused outright.
		const chunked = await raw(
			server,
			`POST ${capabilityOf(server)}${API}pair HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
		);
		expect(chunked).toMatch(/^HTTP\/1\.1 400/);
		// A path without the capability reaches nothing.
		expect((await send(server, `${API}status`)).status).toBe(404);
		// Duplicate grant headers are ambiguous and refused.
		const dup = await raw(
			server,
			`GET ${capabilityOf(server)}${API}transcript HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Endo-Grant: a\r\nX-Endo-Grant: b\r\n\r\n`,
		);
		expect(dup).toMatch(/^HTTP\/1\.1 400/);
		expect((await getW("status")).status).toBe(200);
	});

	it("takes the grant only from its header: not a query, a cookie or another header", async () => {
		const { broker, post, getW } = await startBroker();
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		expect((await getW("transcript", { "X-Endo-Grant": grant })).status).toBe(200);
		expect((await getW(`transcript?grant=${grant}`)).status).toBe(401);
		expect((await getW("transcript", { Cookie: `grant=${grant}` })).status).toBe(401);
		expect((await getW("transcript", { Authorization: `Bearer ${grant}` })).status).toBe(401);
	});

	it("refuses a POST to a read route and any method it does not list", async () => {
		const { server, origin } = await startBroker();
		const headers = { Origin: origin, "Content-Type": "application/json" };
		for (const route of ["/api/v0/snapshot", "/api/v0/develop/sessions", "/api/v0/timeline"])
			expect(
				(await send(server, `${capabilityOf(server)}${route}`, { method: "POST", headers, body: "{}" })).status,
				route,
			).toBe(405);
		for (const method of ["PUT", "DELETE", "PATCH"])
			expect((await send(server, `${capabilityOf(server)}${API}status`, { method })).status, method).toBe(405);
	});

	it("offers no route that could run a command, reach a shell or pass raw RPC through", async () => {
		const { broker, post, getW } = await startBroker();
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		for (const route of [
			"rpc",
			"exec",
			"shell",
			"bash",
			"command",
			"prompt/steer",
			"prompt/stop",
			"prompt/queue",
			"control",
			"..%2f",
			"a/b/c",
		])
			expect(
				(await post(route, { type: "get_state" }, { "X-Endo-Grant": grant })).status,
				route,
			).toBeGreaterThanOrEqual(400);
		expect((await getW("rpc", { "X-Endo-Grant": grant })).status).toBe(404);
	});

	it("lets exactly one of two concurrent prompt requests through", async () => {
		const { broker, post, approval } = await startBroker();
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		const [a, b] = await Promise.all([
			post("prompt/propose", { message: "one" }, { "X-Endo-Grant": grant }),
			post("prompt/propose", { message: "one" }, { "X-Endo-Grant": grant }),
		]);
		expect([a.status, b.status].sort()).toEqual([202, 409]);
		await approval.waitForRequest();
		expect(approval.requests).toHaveLength(1);
	});

	it("keeps live text out of every read route and writes nothing to the store", async () => {
		const { session, broker, post, getW, root, server } = await startBroker();
		const before = treeHash(root);
		session.live_(textMessage("user", SECRET));
		session.live_(textMessage("assistant", SECRET));
		const grant = (
			JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
		).grant;
		expect((await getW("transcript", { "X-Endo-Grant": grant })).body).toContain(SECRET);
		for (const route of [
			"/api/v0/snapshot",
			"/api/v0/timeline",
			"/api/v0/develop/sessions",
			"/api/v0/compare/candidates",
			`${API}status`,
		])
			expect((await get(server, route)).body, route).not.toContain(SECRET);
		expect(treeHash(root)).toBe(before);
	});
});

describe("one real prompt, end to end, with the fake Pi", () => {
	it("is requested, approved on the terminal, sent to Pi, followed in the private transcript, and recorded without its text", async () => {
		const install = installFakePi("1.0.0");
		const root = mkdtempSync(join(tmpdir(), "endo-wb-root-"));
		const cwd = mkdtempSync(join(tmpdir(), "endo-wb-cwd-"));
		cleanup.push(() => {
			install.remove();
			rmSync(root, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
			requestTimeoutMs: 10_000,
		});
		await pi.checkLocal();
		const session = await pi.openSession();
		const approval = new Approval();
		const broker = new WorkbenchBrokerV0({
			session,
			key: pi.digestKey(),
			attachment: pi.attachment,
			approver: approval.approver,
		});
		const server = await serve(root, { workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
		const w = (route: string) => `${capabilityOf(server)}${API}${route}`;
		const post = (route: string, body: unknown, grant?: string) =>
			send(server, w(route), {
				method: "POST",
				headers: {
					Origin: server.origin,
					"Content-Type": "application/json",
					...(grant ? { "X-Endo-Grant": grant } : {}),
				},
				body: JSON.stringify(body),
			});
		const getJson = async (route: string, grant?: string) =>
			JSON.parse((await send(server, w(route), { headers: grant ? { "X-Endo-Grant": grant } : {} })).body) as Record<
				string,
				any
			>;
		try {
			expect(await getJson("status")).toMatchObject({
				connection: "connected",
				run: "idle",
				offers: { prompt: { offered: true } },
			});
			const grant = (
				JSON.parse((await post("pair", { code: broker.issuePairingCode().code })).body) as { grant: string }
			).grant;
			const proposed = await post("prompt/propose", { message: `Count to five ${SECRET}` }, grant);
			expect(proposed.status).toBe(202);
			const id = (JSON.parse(proposed.body) as { proposalId: string }).proposalId;
			const request = await approval.waitForRequest();
			expect(request.message).toContain("Count to five");
			// Not approved yet: Pi has been sent nothing.
			expect(session.counters.ingested).toBeGreaterThan(0);
			approval.answer("allow");
			let view: Record<string, any> = {};
			for (let i = 0; i < 200 && view.state !== "accepted" && view.state !== "refused"; i++) {
				await settle(25);
				view = await getJson(`prompt/${id}`, grant);
			}
			expect(view).toMatchObject({ state: "accepted" });
			expect(["started", "queued", "handled"]).toContain(view.disposition);
			// The private transcript has the user's prompt and the assistant's reply; the run is followed to its end.
			let transcript: { items: { kind: string; role?: string; text?: string; state?: string }[] } = { items: [] };
			for (let i = 0; i < 400; i++) {
				transcript = (await getJson("transcript", grant)) as typeof transcript;
				if (transcript.items.some((x) => x.kind === "run" && x.state === "ended")) break;
				await settle(25);
			}
			expect(transcript.items.find((x) => x.role === "user")?.text).toContain("Count to five");
			expect(transcript.items.find((x) => x.role === "assistant")?.text).toBeTruthy();
			for (let i = 0; i < 400 && session.runActive; i++) await settle(25);
			expect(session.runActive).toBe(false);
			expect(await getJson("status")).toMatchObject({ run: "idle", command: { state: "accepted" } });
			// Read routes never carry the text.
			for (const route of ["/api/v0/snapshot", "/api/v0/timeline", "/api/v0/develop/sessions"])
				expect((await get(server, route)).body, route).not.toContain(SECRET);
		} finally {
			await broker.dispose();
			await session.close();
		}
		// After the session has closed: the chain is recorded, the text is nowhere in the store, and the transcript is gone.
		const store = createEndoDurableEventStoreV0(root, { readOnly: true });
		const events: EndoEventV0[] = [];
		for (let after = 0; ; ) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		store.close();
		const kinds = events.map((e) => e.kind);
		for (const k of [
			"workbench.prompt-proposed",
			"workbench.prompt-authorized",
			"workbench.prompt-dispatched",
			"workbench.prompt-accepted",
		])
			expect(kinds, k).toContain(k);
		expect(kinds.indexOf("workbench.prompt-proposed")).toBeLessThan(kinds.indexOf("workbench.prompt-authorized"));
		expect(kinds.indexOf("workbench.prompt-authorized")).toBeLessThan(kinds.indexOf("workbench.prompt-dispatched"));
		expect(kinds.indexOf("workbench.prompt-dispatched")).toBeLessThan(kinds.indexOf("workbench.prompt-accepted"));
		// The runtime fact of the send is the adapter's own record; the workbench chain does not replace it.
		expect(
			events.filter((e) => e.kind === "control.requested" || e.kind === "control.accepted").length,
		).toBeGreaterThanOrEqual(2);
		const everything = JSON.stringify(events);
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain("Count to five");
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
				d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
			);
		// Pi keeps its own conversation in its own session file (under the store root, as it always does for a persistent session): that is
		// Pi's retention, outside Endophasia's evidence. Everything Endophasia writes (events, registries, runtime-text and artifact
		// stores, interventions) must not hold the text.
		const piOwn = join(root, "pi-sessions");
		const ours = walk(root).filter((f) => !f.startsWith(piOwn) && statSync(f).size < 5_000_000);
		expect(ours.length).toBeGreaterThan(0);
		for (const file of ours) expect(readFileSync(file, "utf8"), file).not.toContain(SECRET);
		expect(walk(piOwn).some((f) => readFileSync(f, "utf8").includes(SECRET))).toBe(true);
		expect(broker.transcript.cleared).toBe(true);
		expect(JSON.stringify(broker.transcript.view())).not.toContain("Count to five");
	}, 60_000);

	it("shows the session as disconnected when Pi exits, and offers no prompt", async () => {
		const install = installFakePi("1.0.0");
		const root = mkdtempSync(join(tmpdir(), "endo-wb-root-"));
		const cwd = mkdtempSync(join(tmpdir(), "endo-wb-cwd-"));
		cleanup.push(() => {
			install.remove();
			rmSync(root, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		});
		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
			requestTimeoutMs: 10_000,
		});
		await pi.checkLocal();
		const session = await pi.openSession();
		const approval = new Approval();
		const broker = new WorkbenchBrokerV0({
			session,
			key: pi.digestKey(),
			attachment: pi.attachment,
			approver: approval.approver,
		});
		try {
			const status = async () =>
				(await broker.handle({ method: "GET", route: ["status"], query: "", grant: null, body: null }))
					.body as Record<string, any>;
			expect(await status()).toMatchObject({ connection: "connected" });
			process.kill(session.pid!, "SIGKILL");
			await session.exited();
			for (let i = 0; i < 100 && (await status()).connection === "connected"; i++) await settle(20);
			expect(await status()).toMatchObject({
				connection: "disconnected",
				run: "unknown",
				offers: { prompt: { offered: false } },
			});
		} finally {
			await broker.dispose();
			await session.close();
		}
	}, 60_000);
});
