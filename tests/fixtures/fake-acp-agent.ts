// A deterministic fake ACP v1 agent for the adapter tests, built on the official SDK's agent API. It needs no model,
// network or credentials. `FAKE_ACP_MODE` picks the behaviour; `FAKE_ACP_OUT` (optional) is a file the agent appends
// JSON lines to, so a test can see what the agent itself observed (a permission outcome, a pid).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const out = process.env.FAKE_ACP_OUT;
const note = (value: Record<string, unknown>): void => {
	if (out !== undefined) appendFileSync(out, `${JSON.stringify(value)}\n`);
};

if (mode === "ignore-sigterm") process.on("SIGTERM", () => {});
if (mode === "grandchild" || mode === "ignore-sigterm") {
	// A descendant in the agent's process group, outliving the agent unless the group is ended.
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	note({ grandchildPid: child.pid });
}

// What the agent's environment holds: launch.env must be the whole of it.
note({ leakProbe: process.env.ENDO_ACP_LEAK_PROBE ?? null });

let cancelled: (() => void) | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = "fake-session-1";

const agent = acp
	.agent({ name: "fake-acp-agent" })
	.onRequest(acp.methods.agent.initialize, () => {
		return {
			protocolVersion: (mode === "version-2" ? 2 : 1) as 1,
			agentInfo: { name: "fake-acp-agent", title: "Fake", version: "9.9.9" },
			agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
			authMethods: [{ id: "none", name: "No authentication" }],
		};
	})
	.onRequest(acp.methods.agent.session.new, () => {
		if (mode === "exit-after-init") process.exit(3);
		// The agent's stdout closes while the process lives on.
		if (mode === "close-stdout") setTimeout(() => process.stdout.end(), 50);
		// Answers, then dies at once.
		if (mode === "exit-after-session-new") setImmediate(() => process.exit(5));
		return { sessionId };
	})
	.onNotification(acp.methods.agent.session.cancel, () => cancelled?.())
	.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
		const update = (u: Record<string, unknown>) =>
			ctx.client.notify(acp.methods.client.session.update, { sessionId, update: u } as never);
		await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SECRET-AGENT-TEXT" } });
		await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "more" } });
		await update({
			sessionUpdate: "tool_call",
			toolCallId: "call_1",
			title: "SECRET-TITLE",
			kind: "read",
			status: "pending",
		});
		await update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
		switch (mode) {
			case "unknown-update":
				await update({ sessionUpdate: "future_variant_from_v9", payload: "SECRET-FUTURE" });
				await update({ nonsense: true });
				break;
			case "permission": {
				const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
					sessionId,
					toolCall: { toolCallId: "call_2", title: "SECRET-PERMISSION-TITLE" },
					options: [
						{ kind: "allow_once", name: "Allow", optionId: "allow" },
						{ kind: "reject_once", name: "Reject", optionId: "reject" },
					],
				});
				note({ permissionOutcome: response.outcome });
				break;
			}
			case "permission-duplicate-ids": {
				const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
					sessionId,
					toolCall: { toolCallId: "call_6" },
					options: [
						{ kind: "allow_once", name: "Allow", optionId: "same" },
						{ kind: "reject_once", name: "Reject", optionId: "same" },
					],
				});
				note({ permissionOutcome: response.outcome });
				break;
			}
			case "malformed-nested":
				await update({ sessionUpdate: "agent_message_chunk", content: { type: "text" } });
				await update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } });
				await update({ sessionUpdate: "agent_message_chunk", content: { type: "future-block" } });
				await update({ sessionUpdate: "plan", entries: [{ content: "do it" }] });
				await update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "x" }] });
				await update({ sessionUpdate: "config_option_update", configOptions: [{ name: "x" }] });
				await update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", name: "Model" }] });
				await update({ sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: {} } });
				await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
				break;
			case "permission-only-allow": {
				const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
					sessionId,
					toolCall: { toolCallId: "call_2" },
					options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
				});
				note({ permissionOutcome: response.outcome });
				break;
			}
			case "permission-wrong-session": {
				const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
					sessionId: "some-other-session",
					toolCall: { toolCallId: "call_3" },
					options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
				});
				note({ permissionOutcome: response.outcome });
				break;
			}
			case "permission-late":
				// After the turn has been answered: no turn is open.
				setTimeout(() => {
					void ctx.client
						.request(acp.methods.client.session.requestPermission, {
							sessionId,
							toolCall: { toolCallId: "call_4" },
							options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
						})
						.then((response) => note({ permissionOutcome: response.outcome }));
				}, 50);
				break;
			case "permission-unawaited":
				// Asks, then finishes the turn without waiting for the answer.
				void ctx.client
					.request(acp.methods.client.session.requestPermission, {
						sessionId,
						toolCall: { toolCallId: "call_5" },
						options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
					})
					.then((response) => note({ permissionOutcome: response.outcome }));
				await sleep(50);
				break;
			case "malformed-known":
				await update({ sessionUpdate: "agent_message_chunk" });
				await update({ sessionUpdate: "tool_call", toolCallId: "call_9" });
				await update({ sessionUpdate: "usage_update", used: 5 });
				await update({ sessionUpdate: "session_info_update" });
				await update({ sessionUpdate: "session_info_update", title: null });
				await update({ sessionUpdate: "session_info_update", title: "SECRET-TITLE" });
				break;
			case "bad-envelope":
				// A valid-looking update, but not a JSON-RPC 2.0 notification.
				process.stdout.write(
					`${JSON.stringify({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } })}\n`,
				);
				await sleep(50);
				break;
			case "exit-retaining-pipe": {
				// A descendant keeps the agent's stdout open after the agent exits.
				spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "ignore"] });
				setTimeout(() => process.exit(4), 100);
				await new Promise(() => {});
				break;
			}
			case "late-update-after-exit": {
				// A descendant outlives the agent and writes an update to the stdout it still holds.
				const line = JSON.stringify({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
					},
				});
				spawn(
					process.execPath,
					[
						"-e",
						`setTimeout(()=>process.stdout.write(${JSON.stringify(`${line}\n`)}),500);setInterval(()=>{},1000)`,
					],
					{ stdio: ["ignore", "inherit", "ignore"] },
				);
				setTimeout(() => process.exit(4), 100);
				await new Promise(() => {});
				break;
			}
			case "permission-after-exit": {
				// A descendant outlives the agent holding both pipes: it asks for permission over the dead agent's stdout and
				// notes whatever answer arrives on the stdin it shares.
				const request = JSON.stringify({
					jsonrpc: "2.0",
					id: 9001,
					method: "session/request_permission",
					params: {
						sessionId,
						toolCall: { toolCallId: "late_call" },
						options: [
							{ kind: "allow_once", name: "Allow", optionId: "allow" },
							{ kind: "reject_once", name: "Reject", optionId: "reject" },
						],
					},
				});
				const script = `const fs=require("fs");setTimeout(()=>{process.stdout.write(${JSON.stringify(`${request}\n`)});process.stdin.on("data",d=>fs.appendFileSync(process.env.FAKE_ACP_OUT,JSON.stringify({lateAnswer:String(d).trim()})+"\\n"))},500);setInterval(()=>{},1000)`;
				spawn(process.execPath, ["-e", script], { stdio: ["inherit", "inherit", "ignore"] });
				setTimeout(() => process.exit(4), 100);
				await new Promise(() => {});
				break;
			}
			case "bad-enums":
				await update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "succeeded" });
				await update({ sessionUpdate: "tool_call", toolCallId: "e2", title: "t", kind: "teleport" });
				await update({ sessionUpdate: "current_mode_update", currentModeId: "mode with spaces \u00e9" });
				break;
			case "odd-tool-id": {
				const id = "has space \u00e9 and more";
				await update({ sessionUpdate: "tool_call", toolCallId: id, title: "t", status: "pending" });
				await update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
				await update({ sessionUpdate: "tool_call", toolCallId: "x".repeat(300), title: "t" });
				break;
			}
			case "weird-variants":
				await update({ sessionUpdate: "__proto__" });
				await update({ sessionUpdate: "constructor" });
				break;
			case "fs": {
				const error = await ctx.client
					.request(acp.methods.client.fs.readTextFile, { sessionId, path: "/etc/hostname" })
					.then(
						() => null,
						(e: { code?: number }) => e.code ?? "error",
					);
				note({ fsReadError: error });
				break;
			}
			case "hang":
			case "grandchild":
			case "ignore-sigterm":
				await new Promise(() => {});
				break;
			case "cancellable":
				await new Promise<void>((resolve) => {
					cancelled = resolve;
				});
				return { stopReason: "cancelled" as const };
			case "cancel-ignored":
				// Completes regardless: the cancel raced the completion.
				await new Promise<void>((resolve) => {
					cancelled = resolve;
				});
				await sleep(10);
				return { stopReason: "end_turn" as const };
			case "exit-during-prompt":
				process.exit(4);
				break;
			case "malformed":
				process.stdout.write("this is not json\n");
				await sleep(50);
				process.exit(0);
				break;
			case "bad-stop":
				return { stopReason: "bogus" } as never;
			case "refuse":
				throw new acp.RequestError(-32000, "SECRET-ERROR-TEXT");
			case "max-tokens":
				return { stopReason: "max_tokens" as const };
		}
		return { stopReason: "end_turn" as const };
	})
	.connect(
		acp.ndJsonStream(
			Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
			Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
		),
	);

await agent.closed;
// A stubborn agent outlives its stdin: only the group kill ends it.
if (mode === "ignore-sigterm" || mode === "close-stdout") setInterval(() => {}, 1000);
