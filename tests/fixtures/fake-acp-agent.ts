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

if (mode === "ignore-sigterm" || mode === "list-hang") process.on("SIGTERM", () => {});
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
// Which optional session methods the agent advertises (FAKE_ACP_CAPS=list,resume,close) and what it reports at open.
const caps = new Set((process.env.FAKE_ACP_CAPS ?? "").split(",").filter(Boolean));
const sessionCapabilities: Record<string, unknown> = {};
for (const name of caps) sessionCapabilities[name === "null-list" ? "list" : name] = name === "null-list" ? null : {};
const configOptions =
	(process.env.FAKE_ACP_CONFIG ?? "") === ""
		? undefined
		: [
				{
					id: "model",
					name: "SECRET-OPTION-NAME",
					category: "model",
					type: "select",
					currentValue: "m1",
					options: [
						{ value: "m1", name: "SECRET-M1" },
						{ value: "m2", name: "SECRET-M2" },
					],
				},
				{
					id: "thinking",
					name: "Thinking",
					category: "thought_level",
					type: "select",
					currentValue: "low",
					options: [
						{
							group: "g",
							name: "G",
							options: [
								{ value: "low", name: "Low" },
								{ value: "high", name: "High" },
							],
						},
					],
				},
				{ id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
			];

const agent = acp
	.agent({ name: "fake-acp-agent" })
	.onRequest(acp.methods.agent.initialize, () => {
		return {
			protocolVersion: (mode === "version-2" ? 2 : 1) as 1,
			agentInfo: { name: process.env.FAKE_ACP_NAME ?? "fake-acp-agent", title: "Fake", version: "9.9.9" },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false },
				...(caps.size > 0 ? { sessionCapabilities } : {}),
			},
			authMethods: [{ id: "none", name: "No authentication" }],
		};
	})
	.onRequest(acp.methods.agent.session.new, () => {
		if (mode === "exit-after-init") process.exit(3);
		if (mode === "new-refuse") throw new acp.RequestError(-32002, "SECRET-NEW-REFUSAL");
		// The agent's stdout closes while the process lives on.
		if (mode === "close-stdout") setTimeout(() => process.stdout.end(), 50);
		// Answers, then dies at once.
		if (mode === "exit-after-session-new") setImmediate(() => process.exit(5));
		return { sessionId, ...(configOptions ? { configOptions } : {}) } as never;
	})
	.onRequest(acp.methods.agent.session.list, async (ctx) => {
		note({ called: "session/list", params: ctx.params });
		if (mode === "list-hang") await new Promise(() => {});
		if (mode === "list-refuse") throw new acp.RequestError(-32001, "SECRET-REFUSAL");
		return {
			sessions: [
				{ sessionId, cwd: "/work/one", title: "SECRET-SESSION-TITLE", updatedAt: "2026-01-01T00:00:00Z" },
				{ sessionId: "other id with spaces", cwd: "/work/two" },
			],
			...(mode === "list-more" ? { nextCursor: "page-2" } : {}),
		} as never;
	})
	.onRequest(acp.methods.agent.session.resume, (ctx) => {
		note({ called: "session/resume", sessionId: ctx.params.sessionId });
		if (ctx.params.sessionId === "unknown-session") throw new acp.RequestError(-32602, "no such session");
		return (configOptions ? { configOptions } : {}) as never;
	})
	.onRequest(acp.methods.agent.session.close, async (ctx) => {
		note({ called: "session/close", sessionId: ctx.params.sessionId });
		cancelled?.();
		if (mode === "close-slow") await sleep(2500);
		if (mode === "close-refuse") {
			// Traffic while the close is pending, then a refusal: the session stays open.
			await ctx.client.notify(acp.methods.client.session.update, {
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "meanwhile" } },
			} as never);
			throw new acp.RequestError(-32003, "no");
		}
		if (mode === "late-after-close") {
			// Traffic about a session the agent just closed, after it answered.
			setTimeout(() => {
				void ctx.client.notify(acp.methods.client.session.update, {
					sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
				} as never);
				void ctx.client
					.request(acp.methods.client.session.requestPermission, {
						sessionId,
						toolCall: { toolCallId: "late_call" },
						options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
					})
					.then((response) => note({ permissionOutcome: response.outcome }));
			}, 50);
		}
		return {} as never;
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
			case "semantics":
				await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET-THOUGHT" } });
				await update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "SECRET-USER" } });
				await update({
					sessionUpdate: "tool_call",
					toolCallId: "call_s",
					title: "SECRET-TOOL-TITLE",
					name: "bash",
					kind: "execute",
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: "SECRET-TOOL-CONTENT" } }],
					locations: [{ path: "/secret/path" }],
					rawInput: { command: "SECRET-ARGS" },
				});
				await update({
					sessionUpdate: "tool_call_update",
					toolCallId: "call_s",
					status: "completed",
					rawOutput: { out: "SECRET-RESULT" },
				});
				await update({
					sessionUpdate: "plan",
					entries: [
						{ content: "SECRET-PLAN", priority: "high", status: "pending" },
						{ content: "two", priority: "low", status: "completed" },
						{ content: "three", priority: "low", status: "completed" },
					],
				});
				await update({
					sessionUpdate: "available_commands_update",
					availableCommands: [{ name: "SECRET-CMD", description: "SECRET-CMD-DESC" }],
				});
				await update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
				await update({ sessionUpdate: "config_option_update", configOptions: configOptions ?? [] });
				await update({
					sessionUpdate: "session_info_update",
					title: "SECRET-TITLE",
					updatedAt: "2026-01-01T00:00:00Z",
				});
				await update({ sessionUpdate: "usage_update", used: 53000, size: 200000 });
				await update({
					sessionUpdate: "usage_update",
					used: 54000,
					size: 200000,
					cost: { amount: 0.25, currency: "USD" },
				});
				await update({ sessionUpdate: "usage_update", used: 55000, size: 200000, cost: null });
				await update({ sessionUpdate: "notice", severity: "info", title: "SECRET-NOTICE" });
				await update({ sessionUpdate: "plan_update", plan: { planId: "p" } });
				break;
			case "hostile-nested": {
				const select = (options: unknown) => ({
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "m", name: "M", type: "select", currentValue: "a", options }],
				});
				await update(select([{}]));
				await update(select([{ group: "g", name: "G" }]));
				await update(select("not-an-array"));
				await update({
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "b", name: "B", type: "boolean", currentValue: "yes" }],
				});
				await update({
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "x", name: "X", type: "slider", currentValue: 1 }],
				});
				await update({ sessionUpdate: "usage_update", used: -5, size: 10 });
				await update({ sessionUpdate: "usage_update", used: 5, size: 10, cost: { amount: 1 } });
				await update({ sessionUpdate: "usage_update", used: 1.5, size: 10 });
				await update({ sessionUpdate: "plan", entries: [{ content: "x", priority: "urgent", status: "pending" }] });
				await update({ sessionUpdate: "tool_call", toolCallId: "t", title: "t", content: "not-an-array" });
				await update({ sessionUpdate: "tool_call_update", toolCallId: "t", locations: [{}] });
				await update({ sessionUpdate: "session_info_update", title: 5 });
				await update({ sessionUpdate: "current_mode_update", currentModeId: 7 });
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
if (mode === "ignore-sigterm" || mode === "close-stdout" || mode === "list-hang") setInterval(() => {}, 1000);
