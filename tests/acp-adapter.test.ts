// The ACP v1 adapter against a deterministic fake agent (tests/fixtures/fake-acp-agent.ts, built on the official SDK).
// No OMP, network, model or credentials. Real OMP is the opt-in tests/acp-omp-real.test.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AcpClientOptionsV0,
	AcpClientV0,
	AcpProcessExitedErrorV0,
	AcpProtocolErrorV0,
	AcpRefusedErrorV0,
	AcpTimeoutErrorV0,
} from "../adapters/acp/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");

let scratch: string;
let out: string;
let live: AcpClientV0[];
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "endo-acp-"));
	out = join(scratch, "agent-notes.jsonl");
	live = [];
});
afterEach(async () => {
	await Promise.all(live.map((client) => client.close()));
	rmSync(scratch, { recursive: true, force: true });
});

function launch(mode: string, extra: Record<string, string> = {}) {
	return {
		command: process.execPath,
		args: [FAKE],
		cwd: scratch,
		env: { FAKE_ACP_MODE: mode, FAKE_ACP_OUT: out, ...extra },
	};
}

async function attach(mode: string, options: Partial<AcpClientOptionsV0> = {}, env: Record<string, string> = {}) {
	const events: EndoEventV0[] = [];
	const client = await AcpClientV0.connect(
		{
			launch: launch(mode, env),
			attachment: "fake.default",
			onEvent: (event) => events.push(event),
			closeGraceMs: 300,
			...options,
		},
		{ cwd: scratch },
	);
	live.push(client);
	return { client, events };
}

/** connect() that is expected to fail: the events seen so far come back with the error. */
async function attachFailing(mode: string) {
	const events: EndoEventV0[] = [];
	const error = await AcpClientV0.connect(
		{ launch: launch(mode), attachment: "fake.default", onEvent: (event) => events.push(event), closeGraceMs: 300 },
		{ cwd: scratch },
	).then(
		() => null,
		(caught: unknown) => caught,
	);
	return { error, events };
}

const kinds = (events: readonly EndoEventV0[]) => events.map((event) => event.kind);
const find = (events: readonly EndoEventV0[], kind: string) => events.filter((event) => event.kind === kind);
const notes = () =>
	readFileSync(out, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("ACP v1 vertical slice, fake agent", () => {
	it("negotiates v1, records what the agent reported, runs one prompt, and closes cleanly", async () => {
		const { client, events } = await attach("normal");
		expect(client.initialize.protocolVersion).toBe(1);
		expect(client.initialize.agentInfo).toMatchObject({ name: "fake-acp-agent", version: "9.9.9" });
		expect(client.initialize.agentCapabilities).toMatchObject({ loadSession: false });
		const initialized = find(events, "harness.acp-initialized")[0]!;
		expect(initialized.payload).toMatchObject({
			protocolVersion: 1,
			agentInfo: { name: "fake-acp-agent" },
			authMethodIds: ["none"],
		});
		expect(find(events, "lifecycle.session-started")[0]!.payload).toMatchObject({
			runtime: "acp",
			runtimeSessionId: "fake-session-1",
		});

		const result = await client.prompt("hello");
		expect(result.stopReason).toBe("end_turn");
		expect(result.updates).toEqual({ agent_message_chunk: 2, tool_call: 1, tool_call_update: 1 });

		// Chunks are counted, not stored; tool updates are minimal observations.
		expect(find(events, "session.update-observed").map((event) => event.payload)).toEqual([
			{ update: "tool_call", toolCallId: "call_1", toolKind: "read", status: "pending" },
			{ update: "tool_call_update", toolCallId: "call_1", status: "completed" },
		]);
		const lifecycle = events.filter((event) => event.source === "interpretation").map((event) => event.kind);
		expect(lifecycle).toEqual(["lifecycle.session-started", "lifecycle.run-started", "lifecycle.run-completed"]);
		expect(find(events, "lifecycle.run-started")[0]!.payload).toMatchObject({ basis: "client-sent-session-prompt" });
		expect(find(events, "lifecycle.run-completed")[0]!.payload).toMatchObject({
			stopReason: { status: "reported", value: "end_turn" },
			turns: { status: "UNAVAILABLE" },
		});
		// No text the agent or the prompt carried reaches evidence.
		const all = JSON.stringify(events);
		expect(all).not.toContain("SECRET");
		expect(all).not.toContain("hello");
		// Session coordinate and derivation.
		expect(new Set(events.slice(2).map((event) => event.coordinates.sessionId))).toEqual(
			new Set(["endo.session.acp.fake-session-1"]),
		);
		const responded = find(events, "agent.prompt-responded")[0]!;
		expect(find(events, "lifecycle.run-completed")[0]!.derivedFrom).toEqual([responded.id]);
		expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

		const exit = await client.close();
		expect(exit.signal === null || exit.code === 0 || exit.signal !== null).toBe(true);
		expect(client.liveProcessMembers()).toBe(false);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ expected: true });
		expect(kinds(events).at(-1)).toBe("lifecycle.detached");
	});

	it("gives the agent only the declared environment", async () => {
		process.env.ENDO_ACP_LEAK_PROBE = "leaked";
		try {
			await attach("normal");
		} finally {
			delete process.env.ENDO_ACP_LEAK_PROBE;
		}
		expect(notes()[0]).toEqual({ leakProbe: null });
	});

	it("rejects an agent that negotiates protocol version 2, and leaves no child", async () => {
		const { error, events } = await attachFailing("version-2");
		expect(error).toBeInstanceOf(AcpProtocolErrorV0);
		expect(String((error as Error).message)).toMatch(/version 2.*only 1/);
		expect(find(events, "harness.protocol-fault")[0]!.payload).toMatchObject({
			fault: "unsupported-protocol-version",
			reported: 2,
		});
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")).toHaveLength(1);
	});

	it("reports an agent that exits right after initialize, not a session", async () => {
		const { error, events } = await attachFailing("exit-after-init");
		expect(error).toBeInstanceOf(AcpProcessExitedErrorV0);
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ code: 3, expected: false });
	});

	it("reports a command that cannot start", async () => {
		const events: EndoEventV0[] = [];
		const error = await AcpClientV0.connect(
			{
				launch: { command: join(scratch, "no-such-agent"), args: [], cwd: scratch, env: {} },
				attachment: "fake.default",
				onEvent: (event) => events.push(event),
				closeGraceMs: 300,
			},
			{ cwd: scratch },
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(find(events, "harness.attached")).toEqual([]);
		expect(find(events, "harness.process-exited")[0]!.payload).toMatchObject({ spawnFailed: true });
	});

	it("refuses relative paths", async () => {
		await expect(
			AcpClientV0.connect(
				{ launch: { ...launch("normal"), cwd: "rel" }, attachment: "x", onEvent: () => {} },
				{ cwd: scratch },
			),
		).rejects.toThrow(/absolute/);
		await expect(
			AcpClientV0.connect({ launch: launch("normal"), attachment: "x", onEvent: () => {} }, { cwd: "rel" }),
		).rejects.toThrow(/absolute/);
	});

	it("keeps unknown and malformed session updates visible", async () => {
		const { client, events } = await attach("unknown-update");
		const result = await client.prompt("go");
		expect(result.stopReason).toBe("end_turn");
		expect(find(events, "runtime.unrecognized-event")[0]!.payload).toEqual({
			runtimeEvent: "future_variant_from_v9",
			method: "session/update",
		});
		expect(find(events, "lifecycle.unrecognized-runtime-event")[0]!.payload).toEqual({
			runtimeEvent: "future_variant_from_v9",
		});
		expect(find(events, "runtime.malformed-event")[0]!.payload).toMatchObject({ runtimeEvent: "session/update" });
		expect(result.updates.future_variant_from_v9).toBe(1);
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	describe("permissions fail closed", () => {
		it("rejects with the agent's own reject_once option by default", async () => {
			const { client, events } = await attach("permission");
			await client.prompt("go");
			expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
				permissionOutcome: { outcome: "selected", optionId: "reject" },
			});
			const decided = find(events, "permission.decided")[0]!;
			expect(decided.source).toBe("authority-decision");
			expect(decided.payload).toEqual({
				decidedBy: "adapter-default",
				decision: "selected",
				optionKind: "reject_once",
			});
			expect(decided.derivedFrom).toEqual([find(events, "permission.requested")[0]!.id]);
			expect(JSON.stringify(events)).not.toContain("SECRET");
		});

		it("cancels when the agent offered nothing to reject with", async () => {
			const { client } = await attach("permission-only-allow");
			await client.prompt("go");
			expect(notes().find((note) => "permissionOutcome" in note)).toEqual({
				permissionOutcome: { outcome: "cancelled" },
			});
		});

		it("honors an explicit handler only for an offered option, and cancels otherwise", async () => {
			const allowed = await attach("permission", {
				permissionHandler: () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
			});
			await allowed.client.prompt("go");
			expect(find(allowed.events, "permission.decided")[0]!.payload).toMatchObject({
				decidedBy: "handler",
				decision: "selected",
				optionKind: "allow_once",
			});
			await allowed.client.close();

			for (const handler of [
				() => ({ outcome: { outcome: "selected" as const, optionId: "not-offered" } }),
				() => {
					throw new Error("boom");
				},
				() => ({}) as never,
			]) {
				const { client, events } = await attach("permission", { permissionHandler: handler });
				await client.prompt("go");
				expect(find(events, "permission.decided")[0]!.payload).toMatchObject({
					decision: "cancelled",
					optionKind: null,
				});
				await client.close();
			}
			expect(
				notes()
					.filter((note) => "permissionOutcome" in note)
					.slice(1)
					.map((note) => note.permissionOutcome),
			).toEqual([{ outcome: "cancelled" }, { outcome: "cancelled" }, { outcome: "cancelled" }]);
		});
	});

	it("serves no file system: an fs request gets an error response, not a hang", async () => {
		const { client } = await attach("fs");
		await client.prompt("go");
		expect(notes().find((note) => "fsReadError" in note)).toEqual({ fsReadError: -32601 });
	});

	describe("a turn that does not complete", () => {
		it("times out without claiming an outcome, and close() ends the child and the turn", async () => {
			const { client, events } = await attach("hang", { promptTimeoutMs: 200 });
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpTimeoutErrorV0);
			expect(find(events, "harness.prompt-timeout")).toHaveLength(1);
			expect(kinds(events).filter((kind) => /run-(completed|failed|aborted)/.test(kind))).toEqual([]);
			await client.close();
			expect(client.liveProcessMembers()).toBe(false);
			expect(find(events, "lifecycle.interrupted")[0]!.payload).toMatchObject({
				cause: "runtime-exited",
				runOpen: true,
			});
		});

		it("is ended by cancel(): the agent's cancelled stop reason is an abort, with the request recorded", async () => {
			const { client, events } = await attach("cancellable");
			const turn = client.prompt("go");
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			expect(await client.cancel()).toBe(true);
			expect((await turn).stopReason).toBe("cancelled");
			expect(find(events, "lifecycle.stop-requested")).toHaveLength(1);
			expect(find(events, "lifecycle.run-aborted")[0]!.payload).toMatchObject({ stopRequested: true });
			expect(await client.cancel()).toBe(false);
		});

		it("is a completion, not an abort, when completion wins the race against cancel()", async () => {
			const { client, events } = await attach("cancel-ignored");
			const turn = client.prompt("go");
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			await client.cancel();
			expect((await turn).stopReason).toBe("end_turn");
			expect(find(events, "lifecycle.run-aborted")).toEqual([]);
			expect(find(events, "lifecycle.run-completed")[0]!.payload).toMatchObject({ stopRequested: true });
		});

		it("is an interruption, never a completion, when the agent exits mid-turn", async () => {
			const { client, events } = await attach("exit-during-prompt");
			await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
			expect(find(events, "lifecycle.interrupted")).toHaveLength(1);
			expect(kinds(events)).not.toContain("agent.prompt-responded");
			expect(kinds(events).filter((kind) => /run-(completed|failed|aborted|unclassified)/.test(kind))).toEqual([]);
		});

		it("does not become success when the agent writes garbage and dies", async () => {
			const { client, events } = await attach("malformed");
			await expect(client.prompt("go")).rejects.toBeInstanceOf(Error);
			expect(kinds(events)).not.toContain("agent.prompt-responded");
			expect(kinds(events).filter((kind) => /run-completed/.test(kind))).toEqual([]);
		});
	});

	it("does not accept a stop reason outside ACP v1's set", async () => {
		const { client, events } = await attach("bad-stop");
		await expect(client.prompt("go")).rejects.toBeInstanceOf(AcpProtocolErrorV0);
		expect(find(events, "harness.protocol-fault")[0]!.payload).toEqual({ fault: "stop-reason-malformed" });
		expect(find(events, "lifecycle.run-unclassified")).toHaveLength(1);
		expect(kinds(events)).not.toContain("lifecycle.run-completed");
	});

	it("records a JSON-RPC refusal as a failed run by code, without its message", async () => {
		const { client, events } = await attach("refuse");
		const error = await client.prompt("go").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AcpRefusedErrorV0);
		expect((error as AcpRefusedErrorV0).code).toBe(-32000);
		expect(find(events, "lifecycle.run-failed")[0]!.payload).toMatchObject({
			cause: { source: "jsonrpc-error", code: -32000 },
		});
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});

	it("reports a non-completion stop reason as reported, not as success or failure", async () => {
		const { client, events } = await attach("max-tokens");
		expect((await client.prompt("go")).stopReason).toBe("max_tokens");
		expect(find(events, "lifecycle.run-unclassified")[0]!.payload).toMatchObject({
			reason: "acp-stop-reason:max_tokens",
			stopReason: { status: "reported", value: "max_tokens" },
		});
	});

	describe("teardown", () => {
		it("ends a descendant of the agent", async () => {
			const { client } = await attach("grandchild");
			const pid = (notes().find((note) => "grandchildPid" in note) as { grandchildPid: number }).grandchildPid;
			expect(alive(pid)).toBe(true);
			await client.close();
			await until(() => !alive(pid));
			expect(client.liveProcessMembers()).toBe(false);
		});

		it("ends an agent that ignores SIGTERM and its descendant within bounds", async () => {
			const { client } = await attach("ignore-sigterm");
			const pid = (notes().find((note) => "grandchildPid" in note) as { grandchildPid: number }).grandchildPid;
			const started = Date.now();
			const exit = await client.close();
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(exit.signal).toBe("SIGKILL");
			await until(() => !alive(pid));
			expect(client.liveProcessMembers()).toBe(false);
		});

		it("is idempotent, and refuses work afterwards", async () => {
			const { client, events } = await attach("normal");
			const [first, second] = await Promise.all([client.close(), client.close()]);
			expect(second).toBe(first);
			await client.close();
			expect(find(events, "harness.process-exited")).toHaveLength(1);
			await expect(client.prompt("late")).rejects.toThrow(/closed/);
			expect(await client.cancel()).toBe(false);
		});

		it("allows one open turn at a time", async () => {
			const { client } = await attach("cancellable");
			const turn = client.prompt("one");
			await expect(client.prompt("two")).rejects.toThrow(/already open/);
			await until(() => (client.updateCounts.tool_call_update ?? 0) === 1);
			await client.cancel();
			await turn;
		});
	});
});
