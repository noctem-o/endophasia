// The DEVELOP workbench broker, at its own boundary: the memory-only transcript, pairing and the grant, and the whole prompt command
// (propose, terminal approval, the gate at the moment of sending, dispatch, acceptance). A controllable stand-in for the session and for
// the terminal approver: no Pi, no model, no network.
import { describe, expect, it } from "vitest";
import {
	LIVE_TRANSCRIPT_MAX_ITEMS_V0,
	LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0,
	LiveTranscriptV0,
} from "../adapters/pi/live-transcript.ts";
import { PiRpcRefusalV0 } from "../adapters/pi/rpc.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeSession, settle, textMessage } from "./workbench-fixtures.ts";

const SECRET = "CANARY-prompt-9d2e-do-not-record";

describe("the live transcript", () => {
	it("keeps user and assistant text and tool names and outcomes, and nothing else", () => {
		const t = new LiveTranscriptV0();
		t.push({ type: "agent_start", record: {} });
		t.push(textMessage("user", "hello"));
		t.push({
			type: "message_end",
			record: {
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking: "SECRET-REASONING" },
						{ type: "text", text: "hi " },
						{ type: "text", text: "there" },
					],
				},
			},
		});
		t.push({ type: "tool_execution_start", record: { toolCallId: "c1", toolName: "read", args: { path: SECRET } } });
		t.push({
			type: "tool_execution_end",
			record: { toolCallId: "c1", toolName: "read", result: { content: SECRET }, isError: false },
		});
		t.push(textMessage("system", "not shown"));
		t.push(textMessage("toolResult", "not shown"));
		t.push({ type: "agent_end", record: {} });
		const view = t.view();
		expect(
			view.items.map((i) => [
				i.kind,
				"role" in i ? i.role : "status" in i ? i.status : i.kind === "run" ? i.state : "",
			]),
		).toEqual([
			["run", "started"],
			["message", "user"],
			["message", "assistant"],
			["tool", "running"],
			["tool", "ok"],
			["run", "ended"],
		]);
		const assistant = view.items[2]!;
		expect(assistant.kind === "message" && assistant.text).toBe("hi there");
		const everything = JSON.stringify(view);
		expect(everything).not.toContain("SECRET-REASONING");
		expect(everything).not.toContain(SECRET);
		expect(view.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		// A reader that already holds the running item gets the outcome by the same cursor: it is a NEW item.
		expect(t.view(4).items).toEqual([
			{ seq: 5, kind: "tool", callId: "c1", name: "read", status: "ok" },
			{ seq: 6, kind: "run", state: "ended" },
		]);
	});

	it("marks a tool error, and reports a gap as a gap: the oldest items are evicted and counted", () => {
		const t = new LiveTranscriptV0();
		t.push({ type: "tool_execution_start", record: { toolCallId: "x", toolName: "bash" } });
		t.push({ type: "tool_execution_end", record: { toolCallId: "x", toolName: "bash", isError: true } });
		expect(t.view().items.map((i) => i.kind === "tool" && i.status)).toEqual(["running", "error"]);
		for (let i = 0; i < LIVE_TRANSCRIPT_MAX_ITEMS_V0 + 50; i++) t.push(textMessage("user", `m${i}`));
		const view = t.view(0);
		expect(t.size.items).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_ITEMS_V0);
		expect(view.evicted).toBeGreaterThan(0);
		expect(view.firstSeq).toBeGreaterThan(1);
		expect(view.items.length).toBeLessThanOrEqual(200);
		const next = t.view(view.items.at(-1)!.seq);
		expect(next.items[0]!.seq).toBe(view.items.at(-1)!.seq + 1);
	});

	it("cuts one long message at a UTF-8 boundary and says it was cut; bounds the total bytes", () => {
		const t = new LiveTranscriptV0();
		t.push(textMessage("assistant", "é".repeat(LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0)));
		const m = t.view().items[0]!;
		expect(m.kind === "message" && m.truncated).toBe(true);
		expect(m.kind === "message" && Buffer.byteLength(m.text)).toBeLessThanOrEqual(
			LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0,
		);
		for (let i = 0; i < 60; i++) t.push(textMessage("assistant", "x".repeat(30_000)));
		expect(t.size.bytes).toBeLessThanOrEqual(1024 * 1024);
	});

	it("cuts a very long non-ASCII message in linear time, at a character boundary", () => {
		const t = new LiveTranscriptV0();
		const started = performance.now();
		t.push(textMessage("assistant", "漢".repeat(100_000)));
		expect(performance.now() - started).toBeLessThan(500);
		const m = t.view().items[0]!;
		expect(m.kind === "message" && m.truncated).toBe(true);
		expect(m.kind === "message" && Buffer.byteLength(m.text)).toBeLessThanOrEqual(
			LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0,
		);
		expect(m.kind === "message" && m.text.includes("\ufffd")).toBe(false);
	});

	it("forgets everything when cleared and ignores anything after", () => {
		const t = new LiveTranscriptV0();
		t.push(textMessage("user", SECRET));
		t.clear();
		t.push(textMessage("user", SECRET));
		expect(t.cleared).toBe(true);
		expect(JSON.stringify(t.view())).not.toContain(SECRET);
		expect(t.size).toEqual({ items: 0, bytes: 0 });
	});
});

function setup(overrides: Partial<ConstructorParameters<typeof WorkbenchBrokerV0>[0]> = {}) {
	const session = new FakeSession();
	const approval = new Approval();
	let now = 1_000_000;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
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
	const pair = async () => {
		const { code } = broker.issuePairingCode();
		const reply = await call("POST", "pair", { code });
		return (reply.body as { grant: string }).grant;
	};
	return {
		session,
		approval,
		broker,
		call,
		pair,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("pairing and the grant", () => {
	it("serves status without a grant and everything else only with one", async () => {
		const { call, pair } = setup();
		expect((await call("GET", "status")).status).toBe(200);
		expect((await call("GET", "transcript")).status).toBe(401);
		expect((await call("POST", "prompt/propose", { message: "x" })).status).toBe(401);
		expect((await call("GET", "prompt/anything")).status).toBe(401);
		const grant = await pair();
		expect((await call("GET", "transcript", null, grant)).status).toBe(200);
		expect((await call("GET", "transcript", null, `${grant}x`)).status).toBe(401);
	});

	it("exchanges a code once, refuses it afterwards, and answers every refusal alike", async () => {
		const { broker, call } = setup();
		const { code } = broker.issuePairingCode();
		const refused = await call("POST", "pair", { code: "WRONG-CODE" });
		expect(refused).toEqual({ status: 401, body: { error: "pairing-refused" } });
		expect((await call("POST", "pair", { code: code.toLowerCase() })).status).toBe(200);
		expect(await call("POST", "pair", { code })).toEqual(refused);
		expect(await call("POST", "pair", {})).toEqual(refused);
		expect(await call("POST", "pair", { code: 5 })).toEqual(refused);
	});

	it("invalidates the code after five wrong attempts, even for the right code", async () => {
		const { broker, call } = setup();
		const { code } = broker.issuePairingCode();
		for (let i = 0; i < 5; i++) await call("POST", "pair", { code: "AAAA-AAAA" });
		expect((await call("POST", "pair", { code })).status).toBe(401);
	});

	it("lets a code and a grant expire, and a new pairing replaces the grant", async () => {
		const { broker, call, advance } = setup();
		const { code } = broker.issuePairingCode();
		advance(10 * 60_000 + 1);
		expect((await call("POST", "pair", { code })).status).toBe(401);
		const first = await (async () => {
			const c = broker.issuePairingCode().code;
			return ((await call("POST", "pair", { code: c })).body as { grant: string }).grant;
		})();
		const second = ((await call("POST", "pair", { code: broker.issuePairingCode().code })).body as { grant: string })
			.grant;
		expect((await call("GET", "transcript", null, first)).status).toBe(401);
		expect((await call("GET", "transcript", null, second)).status).toBe(200);
		advance(60 * 60_000 + 1);
		expect((await call("GET", "transcript", null, second)).status).toBe(401);
	});
});

describe("status", () => {
	it("reports the connection and run state from the live session, never from a recording", async () => {
		const { session, call } = setup();
		const read = async () =>
			(await call("GET", "status")).body as Record<string, unknown> & {
				offers: { prompt: { offered: boolean; reason: string | null } };
			};
		expect(await read()).toMatchObject({
			connection: "connected",
			run: "idle",
			harness: "pi",
			offers: { prompt: { offered: true } },
		});
		session.runActive = true;
		expect(await read()).toMatchObject({ run: "active", offers: { prompt: { offered: false } } });
		session.live = false;
		const gone = await read();
		expect(gone).toMatchObject({ connection: "disconnected", run: "unknown" });
		expect(gone.offers.prompt.reason).toContain("no admitted connection");
		session.piSessionId = null;
		expect((await read()).session).toBeNull();
	});
});

describe("the prompt command", () => {
	it("is proposed, approved on the terminal, dispatched and accepted, each as its own record, with the text never recorded", async () => {
		const { session, approval, call, pair } = setup();
		const grant = await pair();
		const proposed = await call("POST", "prompt/propose", { message: `please ${SECRET}` }, grant);
		expect(proposed.status).toBe(202);
		const view = proposed.body as { proposalId: string; state: string };
		expect(view.state).toBe("awaiting-approval");
		const request = await approval.waitForRequest();
		expect(request.message).toBe(`please ${SECRET}`);
		expect(request.phrase).toMatch(/^APPROVE PROMPT [0-9a-f]{16}$/);
		// Nothing has been sent: HTTP acceptance is only a request.
		expect(session.promptCalls).toEqual([]);
		approval.answer("allow");
		await settle();
		expect(session.promptCalls).toEqual([`please ${SECRET}`]);
		const done = (await call("GET", `prompt/${view.proposalId}`, null, grant)).body as {
			state: string;
			disposition: string;
		};
		expect(done).toMatchObject({ state: "accepted", disposition: "started" });
		expect(session.records.map((r) => r.kind)).toEqual([
			"workbench.prompt-proposed",
			"workbench.prompt-authorized",
			"workbench.prompt-dispatched",
			"workbench.prompt-accepted",
		]);
		// Each step derives from the one before.
		expect(session.records.slice(1).map((r) => r.derivedFrom)).toEqual([
			[session.records[0]!.id],
			[session.records[1]!.id],
			[session.records[2]!.id],
		]);
		expect(session.records[1]!.payload).toMatchObject({ decision: "allow", confirmation: "terminal" });
		expect(JSON.stringify(session.records)).not.toContain(SECRET);
		expect(JSON.stringify((await call("GET", "status")).body)).not.toContain(SECRET);
	});

	it("records a denial and sends nothing; an unanswered approval times out; a discard is a refusal, not an approval", async () => {
		const a = setup();
		const grantA = await a.pair();
		await a.call("POST", "prompt/propose", { message: "one" }, grantA);
		await a.approval.waitForRequest();
		a.approval.answer("deny");
		await settle();
		expect(a.session.promptCalls).toEqual([]);
		expect(a.session.records.map((r) => r.kind)).toEqual([
			"workbench.prompt-proposed",
			"workbench.prompt-authorized",
			"workbench.prompt-refused",
		]);
		expect(a.session.records[2]!.payload.reason).toBe("authorization-denied");
		expect(a.session.records[1]!.payload.decision).toBe("deny");

		const b = setup();
		const grantB = await b.pair();
		await b.call("POST", "prompt/propose", { message: "two" }, grantB);
		await b.approval.waitForRequest();
		b.approval.answer(null);
		await settle();
		expect(b.session.records.at(-1)!.payload.reason).toBe("approval-timed-out");

		const c = setup();
		const grantC = await c.pair();
		const view = (await c.call("POST", "prompt/propose", { message: "three" }, grantC)).body as {
			proposalId: string;
		};
		await c.approval.waitForRequest();
		expect((await c.call("POST", "prompt/discard", { proposalId: view.proposalId }, grantC)).status).toBe(200);
		await settle();
		expect(c.session.records.at(-1)!.payload.reason).toBe("not-authorized");
		expect(c.session.promptCalls).toEqual([]);
	});

	it("refuses to propose while the agent is running, the runtime is gone, or another prompt is open", async () => {
		const { session, call, pair, approval } = setup();
		const grant = await pair();
		session.runActive = true;
		expect((await call("POST", "prompt/propose", { message: "x" }, grant)).status).toBe(409);
		session.runActive = false;
		expect((await call("POST", "prompt/propose", { message: "first" }, grant)).status).toBe(202);
		await approval.waitForRequest();
		// A duplicate or concurrent request cannot open a second approval.
		expect((await call("POST", "prompt/propose", { message: "first" }, grant)).status).toBe(409);
		expect(approval.requests).toHaveLength(1);
		expect(session.records.filter((r) => r.kind === "workbench.prompt-proposed")).toHaveLength(1);
		// A runtime that is gone ends the session: the grant is revoked, so nothing more can even be asked.
		session.live = false;
		expect((await call("POST", "prompt/propose", { message: "x" }, grant)).status).toBe(401);
	});

	it("validates the request: exactly one message member, text only, bounded, no control characters", async () => {
		const { call, pair, session } = setup();
		const grant = await pair();
		for (const body of [
			null,
			{},
			{ message: "" },
			{ message: "   " },
			{ message: 5 },
			{ message: "ok", extra: 1 },
			{ message: "bad\u001bescape" },
			{ message: "nul\u0000" },
			{ message: "Delete the repository\rOnly list files" },
			{ message: "csi\u009b2K" },
			{ message: "reorder \u202eabc" },
			{ message: "isolate \u2066abc" },
			{ message: "separator\u2028line" },
			{ message: "x".repeat(16 * 1024 + 1) },
		])
			expect((await call("POST", "prompt/propose", body, grant)).status, JSON.stringify(body)?.slice(0, 40)).toBe(
				400,
			);
		expect(session.records).toEqual([]);
	});

	it("checks the gate again at the moment of sending: a run, a lost session, a replaced grant or an expired window refuse it", async () => {
		const cases: [string, (ctx: ReturnType<typeof setup>) => Promise<void> | void, string][] = [
			[
				"a run opened meanwhile",
				(c) => {
					c.session.runActive = true;
				},
				"run-active",
			],
			[
				"the session ended",
				(c) => {
					c.session.live = false;
				},
				"session-ended",
			],
			[
				"another session id",
				(c) => {
					c.session.piSessionId = "other";
				},
				"session-ended",
			],
			[
				"a new pairing replaced the grant",
				async (c) => {
					await c.pair();
				},
				"not-authorized",
			],
			[
				"the window passed",
				(c) => {
					c.advance(5 * 60_000 + 1);
				},
				"authorization-expired",
			],
		];
		for (const [name, change, reason] of cases) {
			const ctx = setup();
			const grant = await ctx.pair();
			await ctx.call("POST", "prompt/propose", { message: "go" }, grant);
			await ctx.approval.waitForRequest();
			await change(ctx);
			ctx.approval.answer("allow");
			await settle();
			expect(ctx.session.promptCalls, name).toEqual([]);
			expect(ctx.session.records.at(-1)!.payload.reason, name).toBe(reason);
			expect(ctx.session.records.at(-1)!.kind, name).toBe("workbench.prompt-refused");
		}
	});

	it("says the runtime refused only when Pi itself refused; a lost reply or an odd answer is unknown, never 'not sent'", async () => {
		const cases: [() => Promise<string>, string, string | null][] = [
			[async () => Promise.reject(new PiRpcRefusalV0("prompt", "no")), "refused", "runtime-refused"],
			[async () => Promise.reject(new Error("request timed out")), "unknown", null],
			[async () => "mystery", "unknown", null],
		];
		for (const [result, state, reason] of cases) {
			const ctx = setup();
			ctx.session.promptResult = result;
			const grant = await ctx.pair();
			const view = (await ctx.call("POST", "prompt/propose", { message: "go" }, grant)).body as {
				proposalId: string;
			};
			await ctx.approval.waitForRequest();
			ctx.approval.answer("allow");
			await settle();
			const kinds = ctx.session.records.map((r) => r.kind);
			expect(kinds).toContain("workbench.prompt-dispatched");
			expect(kinds).not.toContain("workbench.prompt-accepted");
			// An unknown outcome is not recorded as a refusal: the dispatch stands as the last step.
			expect(kinds.includes("workbench.prompt-refused")).toBe(state === "refused");
			const view2 = (await ctx.call("GET", `prompt/${view.proposalId}`, null, grant)).body as {
				state: string;
				reason: string | null;
				approved: boolean;
			};
			expect(view2).toMatchObject({ state, reason, approved: true });
		}
	});

	it("takes the largest prompt even when every byte is escaped in JSON, and refuses one byte more", async () => {
		const { call, pair, session, approval } = setup();
		const grant = await pair();
		const max = 16 * 1024;
		expect((await call("POST", "prompt/propose", { message: '"'.repeat(max) }, grant)).status).toBe(202);
		await approval.waitForRequest();
		expect(session.records[0]!.payload.message).toMatchObject({ bytes: max });
		const other = setup();
		const g2 = await other.pair();
		expect((await other.call("POST", "prompt/propose", { message: "x".repeat(max + 1) }, g2)).status).toBe(400);
	});

	it("fails closed when the store cannot record: nothing is proposed and nothing is sent", async () => {
		const { session, call, pair } = setup();
		const grant = await pair();
		session.failRecording = true;
		expect((await call("POST", "prompt/propose", { message: "go" }, grant)).status).toBe(503);
		expect(session.promptCalls).toEqual([]);
	});

	it("answers only its closed list of routes and methods", async () => {
		const { call, pair } = setup();
		const grant = await pair();
		for (const [method, route] of [
			["GET", "rpc"],
			["POST", "rpc"],
			["POST", "shell"],
			["POST", "prompt/steer"],
			["POST", "prompt/stop"],
			["GET", "prompt/propose"],
			["POST", "transcript"],
			["POST", "status"],
			["GET", "pair"],
			["GET", "prompt/a/b"],
		] as const)
			expect(
				(await call(method, route, method === "POST" ? {} : null, grant)).status,
				`${method} ${route}`,
			).toBeGreaterThanOrEqual(400);
		expect((await call("GET", "transcript", null, grant, "after=-1")).status).toBe(400);
		expect((await call("GET", "transcript", null, grant, "after=1&x=2")).status).toBe(400);
	});
});

describe("the approval is attributed only when it happened", () => {
	it("marks a prompt approved only after the terminal allowed it: not when withdrawn, timed out or declined", async () => {
		const outcome = async (act: (c: ReturnType<typeof setup>, id: string, grant: string) => Promise<void>) => {
			const ctx = setup();
			const grant = await ctx.pair();
			const view = (await ctx.call("POST", "prompt/propose", { message: "go" }, grant)).body as {
				proposalId: string;
			};
			await ctx.approval.waitForRequest();
			await act(ctx, view.proposalId, grant);
			await settle();
			return (await ctx.call("GET", `prompt/${view.proposalId}`, null, grant)).body as {
				approved: boolean;
				state: string;
				reason: string | null;
			};
		};
		expect(await outcome(async (c) => c.approval.answer("allow"))).toMatchObject({
			approved: true,
			state: "accepted",
		});
		expect(await outcome(async (c) => c.approval.answer("deny"))).toMatchObject({
			approved: false,
			reason: "authorization-denied",
		});
		expect(await outcome(async (c) => c.approval.answer(null))).toMatchObject({
			approved: false,
			reason: "approval-timed-out",
		});
		expect(
			await outcome(async (c, id, g) => void (await c.call("POST", "prompt/discard", { proposalId: id }, g))),
		).toMatchObject({ approved: false, reason: "not-authorized" });
		// Approved and then refused at the gate: the approval did happen, and the reason says why it was not sent.
		const late = await outcome(async (c) => {
			c.session.runActive = true;
			c.approval.answer("allow");
		});
		expect(late).toMatchObject({ approved: true, state: "refused", reason: "run-active" });
	});
});

describe("the end of the runtime", () => {
	it("withdraws a waiting approval, revokes the grant and clears the transcript as soon as the runtime is gone", async () => {
		const { session, call, pair, broker, approval } = setup();
		const grant = await pair();
		session.live_(textMessage("user", SECRET));
		expect(JSON.stringify((await call("GET", "transcript", null, grant)).body)).toContain(SECRET);
		await call("POST", "prompt/propose", { message: "go" }, grant);
		await approval.waitForRequest();
		session.live = false; // the Pi child exited or crashed; the host keeps running
		expect((await call("GET", "transcript", null, grant)).status).toBe(401);
		expect(broker.transcript.cleared).toBe(true);
		expect(JSON.stringify(broker.transcript.view())).not.toContain(SECRET);
		await settle();
		expect(session.records.at(-1)!.payload.reason).toBe("session-ended");
		expect(session.promptCalls).toEqual([]);
		const status = (await call("GET", "status")).body as { connection: string; run: string; paired: boolean };
		expect(status).toMatchObject({ connection: "disconnected", run: "unknown", paired: false });
		// A process that comes back is a new connection, never a continuation: the ended workbench does not resume.
		session.live = true;
		expect((await call("POST", "pair", { code: broker.issuePairingCode().code })).status).toBe(401);
		expect((await call("GET", "transcript", null, grant)).status).toBe(401);
		expect(((await call("GET", "status")).body as { connection: string }).connection).toBe("disconnected");
		broker.endSession(); // idempotent
	});
});

describe("disposal", () => {
	it("withdraws a waiting approval, revokes the grant, clears the transcript and stops listening to the session", async () => {
		const { session, call, pair, broker, approval } = setup();
		const grant = await pair();
		session.live_(textMessage("user", SECRET));
		expect(JSON.stringify((await call("GET", "transcript", null, grant)).body)).toContain(SECRET);
		await call("POST", "prompt/propose", { message: "go" }, grant);
		await approval.waitForRequest();
		await broker.dispose();
		expect(session.promptCalls).toEqual([]);
		expect(session.records.at(-1)!.payload.reason).toBe("session-ended");
		expect((await call("GET", "transcript", null, grant)).status).toBe(401);
		expect(JSON.stringify(broker.transcript.view())).not.toContain(SECRET);
		expect(session.onLiveEvent).toBeNull();
		expect((await call("POST", "pair", { code: broker.issuePairingCode().code })).status).toBe(401);
		await broker.dispose();
	});
});
