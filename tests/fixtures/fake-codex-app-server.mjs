#!/usr/bin/env node
/**
 * Deterministic fake Codex App Server process for `DEVELOP-CODEX-LIVE-001` tests.
 * Speaks the exact stdio JSON-RPC wire shape observed on `codex-cli 0.171.0` (no `jsonrpc` field on replies/notifications).
 */

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
	process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.171.0"}\n`);
	process.exit(0);
}

const scenarios = new Set(
	(process.env.FAKE_CODEX_SCENARIO ?? "default")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
const logFile = process.env.FAKE_CODEX_LOG_FILE ?? null;
const recorded = [];
const record = (entry) => {
	recorded.push(entry);
	if (logFile) {
		try {
			writeFileSync(logFile, `${JSON.stringify(recorded, null, 2)}\n`);
		} catch {
			// Ignore test log write errors.
		}
	}
};

const send = (obj) => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
};

let threadId = "019a0000-0000-7000-8000-000000000010";
let sessionId = "019a0000-0000-7000-8000-000000000000";
let turnSeq = 0;
let activeTurnId = null;
let pendingServerReqId = null;
let pendingServerResolve = null;

// Emit a benign startup notification just like real codex-cli 0.171.0.
send({
	method: "remoteControl/status/changed",
	params: { status: "disconnected", serverName: null, installationId: null, environmentId: null },
});

if (scenarios.has("stderr-noise")) {
	process.stderr.write("fake-codex diagnostic warning line 1\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, idx).replace(/\r$/, "");
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		handleMessage(msg);
	}
});

process.stdin.on("end", () => {
	setTimeout(() => process.exit(0), 20);
});

function handleMessage(msg) {
	record({ direction: "in", msg });

	// Response from client to one of our ServerRequests.
	if (msg.method === undefined && msg.id !== undefined) {
		record({ direction: "server-request-reply", id: msg.id, result: msg.result, error: msg.error });
		if (pendingServerResolve && msg.id === pendingServerReqId) {
			const fn = pendingServerResolve;
			pendingServerResolve = null;
			pendingServerReqId = null;
			fn(msg);
		}
		return;
	}

	const { id, method, params = {} } = msg;

	if (method === "initialize") {
		if (scenarios.has("malformed-init")) {
			send({ id, result: { broken: true } });
			return;
		}
		send({
			id,
			result: {
				userAgent: "fake-codex-app-server/0.171.0 (Linux; x86_64)",
				codexHome: scenarios.has("ignore-codex-home")
					? "/tmp/wrong-unisolated-codex-home"
					: (process.env.CODEX_HOME ?? "/tmp/fake-codex-home"),
				platformFamily: "unix",
				platformOs: "linux",
			},
		});
		return;
	}

	if (method === "initialized") {
		if (scenarios.has("malformed-frames")) {
			process.stdout.write("not-json-at-all\n");
			process.stdout.write(`${JSON.stringify({ id: 99999, result: {} })}\n`);
			process.stdout.write(`${"x".repeat(4096)}\n`);
		}
		return;
	}

	if (method === "config/read") {
		const mcpServers = scenarios.has("unsafe-mcp-name")
			? {
					legacy_mcp: { url: "https://example.invalid/mcp", enabled: true },
					"dotted.mcp.server": { url: "https://example.invalid/bad", enabled: true },
				}
			: {
					legacy_mcp: { url: "https://example.invalid/mcp", enabled: true },
				};
		send({
			id,
			result: {
				config: {
					approval_policy: "on-request",
					approvals_reviewer: "user",
					sandbox_mode: "workspace-write",
					mcp_servers: mcpServers,
				},
				origins: {},
				layers: null,
			},
		});
		return;
	}

	if (method === "model/list") {
		send({
			id,
			result: {
				data: [
					{
						id: "gpt-6.2-sol",
						model: "gpt-6.2-sol",
						displayName: "GPT-6.2-Sol",
						isDefault: true,
						hidden: false,
						defaultReasoningEffort: "low",
						supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
					},
				],
				nextCursor: null,
			},
		});
		return;
	}

	if (method === "thread/start") {
		let approvalPolicy = params.approvalPolicy ?? "on-request";
		let approvalsReviewer = params.approvalsReviewer ?? "user";
		let sandbox =
			params.sandbox === "read-only"
				? {
						type: "readOnly",
						networkAccess: false,
					}
				: {
						type: "workspaceWrite",
						writableRoots: [],
						networkAccess: false,
						excludeTmpdirEnvVar: false,
						excludeSlashTmp: false,
					};
		if (scenarios.has("permissive-approval-never")) approvalPolicy = "never";
		if (scenarios.has("permissive-approval-object")) approvalPolicy = { reject: { sandbox_approval: true } };
		if (scenarios.has("permissive-auto-reviewer")) approvalsReviewer = "auto_review";
		if (scenarios.has("permissive-danger-sandbox")) sandbox = { type: "dangerFullAccess" };
		if (scenarios.has("permissive-external-sandbox")) sandbox = { type: "externalSandbox", networkAccess: "restricted" };
		if (scenarios.has("permissive-writable-roots")) {
			sandbox = { type: "workspaceWrite", writableRoots: ["/etc"], networkAccess: false };
		}
		if (scenarios.has("permissive-network-access")) {
			sandbox = { type: "workspaceWrite", writableRoots: [], networkAccess: true };
		}
		if (scenarios.has("broaden-readonly-to-workspace")) {
			sandbox = { type: "workspaceWrite", writableRoots: [], networkAccess: false };
		}

		const thread = {
			id: threadId,
			sessionId,
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: Boolean(params.ephemeral),
			cwd: params.cwd ?? process.cwd(),
			cliVersion: "0.171.0",
			modelProvider: "openai",
			model: params.model ?? "gpt-6.2-sol",
			reasoningEffort: "low",
			createdAt: 1795500000,
			updatedAt: 1795500000,
			status: { type: "idle" },
			turns: [],
		};
		if (scenarios.has("unexpected-mcp-startup")) {
			send({
				method: "mcpServer/startupStatus/updated",
				params: { threadId, name: "rogue_mcp", environmentId: null, status: "starting", error: null },
			});
		}
		send({
			id,
			result: {
				thread,
				model: thread.model,
				modelProvider: "openai",
				serviceTier: null,
				disabledPluginIds: [],
				cwd: thread.cwd,
				instructionSources: [],
				approvalPolicy,
				approvalsReviewer,
				sandbox,
				reasoningEffort: "low",
			},
		});
		send({ method: "thread/started", params: { thread } });
		if (scenarios.has("native-approval-idle")) {
			send({
				id: "srv-idle-1",
				method: "item/commandExecution/requestApproval",
				params: {
					kind: "command",
					threadId,
					turnId: "019a0000-0000-7000-8000-000000000099",
					itemId: "item-idle-1",
					startedAtMs: Date.now(),
					environmentId: null,
					command: "echo idle",
					cwd: "/tmp/fixture",
				},
			});
		}
		if (scenarios.has("native-approval-idle-null-turn")) {
			setTimeout(() => {
				send({
					id: "srv-idle-null-turn-1",
					method: "item/commandExecution/requestApproval",
					params: {
						kind: "command",
						threadId,
						itemId: "item-idle-null-1",
						startedAtMs: Date.now(),
						environmentId: null,
						command: "echo idle-null-turn",
						cwd: "/tmp/fixture",
					},
				});
			}, 25);
		}
		if (scenarios.has("late-unexpected-mcp-startup")) {
			setTimeout(() => {
				send({
					method: "mcpServer/startupStatus/updated",
					params: { threadId, name: "late_rogue_mcp", environmentId: null, status: "starting", error: null },
				});
			}, 30);
		}
		return;
	}

	if (method === "thread/read") {
		send({
			id,
			result: {
				thread: { id: params.threadId ?? threadId, sessionId, status: { type: "idle" }, turns: [] },
			},
		});
		return;
	}

	if (method === "thread/unsubscribe") {
		send({ id, result: { status: "unsubscribed" } });
		return;
	}

	if (method === "turn/start") {
		if (scenarios.has("disconnect-mid-turn")) {
			process.exit(1);
		}
		if (scenarios.has("runtime-refuse-turn")) {
			send({ id, error: { code: -32010, message: "simulated turn/start runtime refusal" } });
			return;
		}
		turnSeq += 1;
		const turnId = `019a0000-0000-7000-8000-${String(turnSeq).padStart(12, "0")}`;
		activeTurnId = turnId;
		const turn = { id: turnId, rootTurnId: turnId, items: [], itemsView: "complete", status: "inProgress", error: null };
		if (scenarios.has("same-chunk-turn-failed")) {
			activeTurnId = null;
			process.stdout.write(
				`${JSON.stringify({ id, result: { turn } })}\n` +
					`${JSON.stringify({ method: "turn/started", params: { threadId, turn } })}\n` +
					`${JSON.stringify({
						method: "turn/completed",
						params: {
							threadId,
							turn: { ...turn, status: "failed", error: { message: "boom", codexErrorInfo: "other" } },
						},
					})}\n`,
			);
			return;
		}
		send({ id, result: { turn } });
		send({ method: "turn/started", params: { threadId, turn } });

		if (scenarios.has("foreign-thread-event")) {
			send({
				method: "item/completed",
				params: {
					threadId: "019a0000-0000-7000-8000-ffffffffffff",
					turnId: "foreign-turn",
					item: { type: "agentMessage", id: "foreign-item", text: "FOREIGN_SECRET_TEXT" },
				},
			});
			send({
				id: "srv-foreign-1",
				method: "item/commandExecution/requestApproval",
				params: {
					kind: "command",
					threadId: "019a0000-0000-7000-8000-ffffffffffff",
					turnId: "foreign-turn",
					itemId: "foreign-cmd",
					startedAtMs: Date.now(),
					environmentId: null,
					command: "rm -rf /",
					cwd: "/tmp",
				},
			});
		}

		if (scenarios.has("stream-slow-deltas")) {
			const userText = Array.isArray(params.input) && params.input[0]?.text ? params.input[0].text : "";
			send({
				method: "item/completed",
				params: {
					threadId,
					turnId,
					completedAtMs: Date.now(),
					item: {
						type: "userMessage",
						id: `item-user-${turnSeq}`,
						clientId: null,
						content: [{ type: "text", text: userText, text_elements: [] }],
					},
				},
			});
			send({
				method: "item/reasoning/summaryTextDelta",
				params: { threadId, turnId, itemId: `item-reason-${turnSeq}`, delta: "Inspecting workspace ", summaryIndex: 0 },
			});
			setTimeout(() => {
				if (activeTurnId !== turnId) return;
				send({
					method: "item/reasoning/summaryTextDelta",
					params: { threadId, turnId, itemId: `item-reason-${turnSeq}`, delta: "and verifying tests.", summaryIndex: 0 },
				});
				send({
					method: "item/completed",
					params: {
						threadId,
						turnId,
						completedAtMs: Date.now(),
						item: {
							type: "reasoning",
							id: `item-reason-${turnSeq}`,
							summary: ["Inspecting workspace and verifying tests."],
							content: [],
						},
					},
				});
				send({
					method: "item/started",
					params: {
						threadId,
						turnId,
						startedAtMs: Date.now(),
						item: {
							type: "commandExecution",
							id: `item-cmd-${turnSeq}`,
							command: "npm test",
							cwd: "/tmp/fixture",
							status: "inProgress",
							exitCode: null,
						},
					},
				});
				send({
					method: "item/started",
					params: {
						threadId,
						turnId,
						startedAtMs: Date.now(),
						item: {
							type: "fileChange",
							id: `item-file-${turnSeq}`,
							status: "inProgress",
							changes: [],
						},
					},
				});
			}, 120);
			setTimeout(() => {
				if (activeTurnId !== turnId) return;
				send({
					method: "item/completed",
					params: {
						threadId,
						turnId,
						completedAtMs: Date.now(),
						item: {
							type: "commandExecution",
							id: `item-cmd-${turnSeq}`,
							command: "npm test",
							cwd: "/tmp/fixture",
							status: "completed",
							exitCode: 0,
						},
					},
				});
				send({
					method: "item/completed",
					params: {
						threadId,
						turnId,
						completedAtMs: Date.now(),
						item: {
							type: "fileChange",
							id: `item-file-${turnSeq}`,
							status: "completed",
							changes: [
								{ path: "src/app.ts", kind: "update" },
								{ path: "tests/app.test.ts", kind: "update" },
							],
						},
					},
				});
				send({
					method: "item/agentMessage/delta",
					params: { threadId, turnId, itemId: `item-msg-${turnSeq}`, delta: "Streaming reply part 1. " },
				});
			}, 260);
			setTimeout(() => {
				if (activeTurnId !== turnId) return;
				send({
					method: "item/agentMessage/delta",
					params: { threadId, turnId, itemId: `item-msg-${turnSeq}`, delta: "Streaming reply part 2." },
				});
				send({
					method: "item/completed",
					params: {
						threadId,
						turnId,
						completedAtMs: Date.now(),
						item: {
							type: "agentMessage",
							id: `item-msg-${turnSeq}`,
							text: "Streaming reply part 1. Streaming reply part 2.",
						},
					},
				});
				send({
					method: "thread/tokenUsage/updated",
					params: {
						threadId,
						turnId,
						tokenUsage: {
							last: {
								totalTokens: 320,
								inputTokens: 210,
								cachedInputTokens: 64,
								cacheWriteInputTokens: 0,
								outputTokens: 110,
								reasoningOutputTokens: 35,
							},
							total: {
								totalTokens: 320 * turnSeq,
								inputTokens: 210 * turnSeq,
								cachedInputTokens: 64 * turnSeq,
								cacheWriteInputTokens: 0,
								outputTokens: 110 * turnSeq,
								reasoningOutputTokens: 35 * turnSeq,
							},
							modelContextWindow: 200000,
						},
					},
				});
				activeTurnId = null;
				send({
					method: "turn/completed",
					params: { threadId, turn: { ...turn, status: "completed" } },
				});
			}, 450);
			return;
		}

		if (scenarios.has("slow-turn")) {
			// Stay open until turn/interrupt arrives.
			return;
		}

		if (
			scenarios.has("native-approval-cmd") ||
			scenarios.has("native-approval-cmd-long") ||
			scenarios.has("native-approval-cmd-oversized") ||
			scenarios.has("native-approval-file") ||
			scenarios.has("native-approval-permissions") ||
			scenarios.has("native-approval-unknown") ||
			scenarios.has("native-approval-user-input") ||
			scenarios.has("native-approval-mcp-elicitation") ||
			scenarios.has("native-approval-legacy-patch") ||
			scenarios.has("native-approval-legacy-exec") ||
			scenarios.has("native-approval-tool-call") ||
			scenarios.has("native-approval-missing-thread") ||
			scenarios.has("duplicate-server-req")
		) {
			runApprovalTurn(turnId);
			return;
		}

		// Standard deterministic turn lifecycle with summary-only reasoning, command/file items, and usage.
		const userText = Array.isArray(params.input) && params.input[0]?.text ? params.input[0].text : "";
		send({
			method: "item/completed",
			params: {
				threadId,
				turnId,
				completedAtMs: Date.now(),
				item: {
					type: "userMessage",
					id: `item-user-${turnSeq}`,
					clientId: null,
					content: [{ type: "text", text: userText, text_elements: [] }],
				},
			},
		});
		send({
			method: "item/reasoning/summaryTextDelta",
			params: { threadId, turnId, itemId: `item-reason-${turnSeq}`, delta: "Checking fixture ", summaryIndex: 0 },
		});
		if (scenarios.has("raw-reasoning-delta")) {
			send({
				method: "item/reasoning/textDelta",
				params: { threadId, turnId, itemId: `item-reason-${turnSeq}`, delta: "Raw step 1 ", contentIndex: 0 },
			});
		}
		send({
			method: "item/completed",
			params: {
				threadId,
				turnId,
				completedAtMs: Date.now(),
				item: scenarios.has("redacted-reasoning")
					? {
							type: "reasoning",
							id: `item-reason-${turnSeq}`,
							summary: [],
							content: [],
							encryptedContent: "opaque-encrypted-reasoning-payload",
						}
					: {
							type: "reasoning",
							id: `item-reason-${turnSeq}`,
							summary: ["Checking fixture safely."],
							content: scenarios.has("raw-reasoning-delta") ? ["Raw step 1 complete."] : [],
						},
			},
		});
		send({
			method: "item/started",
			params: {
				threadId,
				turnId,
				startedAtMs: Date.now(),
				item: {
					type: "commandExecution",
					id: `item-cmd-${turnSeq}`,
					command: "SENSITIVE_CMD_SECRET_TOKEN",
					cwd: "/tmp/fixture",
					status: "inProgress",
					exitCode: null,
				},
			},
		});
		send({
			method: "item/completed",
			params: {
				threadId,
				turnId,
				completedAtMs: Date.now(),
				item: {
					type: "commandExecution",
					id: `item-cmd-${turnSeq}`,
					command: "SENSITIVE_CMD_SECRET_TOKEN",
					cwd: "/tmp/fixture",
					status: "completed",
					exitCode: 0,
				},
			},
		});
		const assistantFinal = scenarios.has("untrusted-html-reply")
			? '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> safe text'
			: "ASSISTANT_PRIVATE_REPLY_PART1 DONE";
		send({
			method: "item/agentMessage/delta",
			params: { threadId, turnId, itemId: `item-msg-${turnSeq}`, delta: "ASSISTANT_PRIVATE_REPLY_PART1 " },
		});
		send({
			method: "item/completed",
			params: {
				threadId,
				turnId,
				completedAtMs: Date.now(),
				item: {
					type: "agentMessage",
					id: `item-msg-${turnSeq}`,
					text: assistantFinal,
				},
			},
		});

		if (!scenarios.has("missing-usage")) {
			send({
				method: "thread/tokenUsage/updated",
				params: {
					threadId,
					turnId,
					tokenUsage: {
						last: {
							totalTokens: 120,
							inputTokens: 80,
							cachedInputTokens: 20,
							cacheWriteInputTokens: 0,
							outputTokens: 40,
							reasoningOutputTokens: 15,
						},
						total: {
							totalTokens: 120,
							inputTokens: 80,
							cachedInputTokens: 20,
							cacheWriteInputTokens: 0,
							outputTokens: 40,
							reasoningOutputTokens: 15,
						},
						modelContextWindow: 200000,
					},
				},
			});
		}

		activeTurnId = null;
		send({
			method: "turn/completed",
			params: { threadId, turn: { ...turn, status: "completed" } },
		});
		return;
	}

	if (method === "turn/steer") {
		if (activeTurnId === null || params.expectedTurnId !== activeTurnId) {
			send({ id, error: { code: -32602, message: "expectedTurnId does not match active turn" } });
			return;
		}
		send({ id, result: { turnId: activeTurnId } });
		return;
	}

	if (method === "turn/interrupt") {
		if (activeTurnId === null || params.turnId !== activeTurnId) {
			send({ id, error: { code: -32602, message: "no matching active turn to interrupt" } });
			return;
		}
		const interruptedId = activeTurnId;
		send({ id, result: {} });
		setTimeout(() => {
			if (activeTurnId === interruptedId) {
				activeTurnId = null;
				send({
					method: "turn/completed",
					params: {
						threadId,
						turn: { id: interruptedId, items: [], itemsView: "complete", status: "interrupted", error: null },
					},
				});
			}
		}, 20);
		return;
	}

	send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
}

function runApprovalTurn(turnId) {
	const reqId = `srv-req-${turnSeq}`;
	pendingServerReqId = reqId;
	pendingServerResolve = (reply) => {
		const accepted = reply.result?.decision === "accept";
		if (scenarios.has("emit-server-request-resolved")) {
			send({
				method: "serverRequest/resolved",
				params: { threadId, requestId: reqId },
			});
		}
		send({
			method: "item/completed",
			params: {
				threadId,
				turnId,
				completedAtMs: Date.now(),
				item: {
					type: scenarios.has("native-approval-file") ? "fileChange" : "commandExecution",
					id: `item-appr-${turnSeq}`,
					status: accepted ? "completed" : "declined",
					changes: [],
					command: "echo test",
					cwd: "/tmp/fixture",
					exitCode: accepted ? 0 : null,
				},
			},
		});
		activeTurnId = null;
		send({
			method: "turn/completed",
			params: {
				threadId,
				turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null },
			},
		});
	};

	if (
		scenarios.has("native-approval-cmd") ||
		scenarios.has("native-approval-cmd-long") ||
		scenarios.has("native-approval-cmd-oversized") ||
		scenarios.has("duplicate-server-req")
	) {
		const cmd = scenarios.has("native-approval-cmd-oversized")
			? `${"echo padding ".repeat(400)}&& echo HIDDEN_OVERSIZED_TAIL`
			: scenarios.has("native-approval-cmd-long")
				? `${"echo harmless_prefix_".repeat(15)} && echo VISIBLE_TAIL_320_CHARS`
				: "node --test";
		const req = {
			id: reqId,
			method: "item/commandExecution/requestApproval",
			params: {
				kind: "command",
				threadId,
				turnId,
				itemId: `item-appr-${turnSeq}`,
				startedAtMs: Date.now(),
				environmentId: null,
				command: cmd,
				cwd: "/tmp/fixture",
				proposedExecpolicyAmendment: { command: ["node", "--test"] },
			},
		};
		send(req);
		if (scenarios.has("duplicate-server-req")) {
			send(req);
		}
	} else if (scenarios.has("native-approval-file")) {
		send({
			id: reqId,
			method: "item/fileChange/requestApproval",
			params: {
				threadId,
				turnId,
				itemId: `item-appr-${turnSeq}`,
				startedAtMs: Date.now(),
				reason: "edit parser.js",
				grantRoot: "/tmp/outside-root",
			},
		});
	} else if (scenarios.has("native-approval-permissions")) {
		send({
			id: reqId,
			method: "item/permissions/requestApproval",
			params: {
				threadId,
				turnId,
				itemId: `item-appr-${turnSeq}`,
				environmentId: null,
				startedAtMs: Date.now(),
				cwd: "/tmp/fixture",
				reason: "request network access",
				permissions: { network: { enabled: true } },
			},
		});
	} else if (scenarios.has("native-approval-user-input")) {
		send({
			id: reqId,
			method: "item/tool/requestUserInput",
			params: { threadId, turnId, itemId: `item-appr-${turnSeq}`, questions: [] },
		});
	} else if (scenarios.has("native-approval-mcp-elicitation")) {
		send({
			id: reqId,
			method: "mcpServer/elicitation/request",
			params: { threadId, turnId, serverName: "legacy_mcp", mode: "form", message: "enter token" },
		});
	} else if (scenarios.has("native-approval-legacy-patch")) {
		send({
			id: reqId,
			method: "applyPatchApproval",
			params: { conversationId: threadId, callId: `item-appr-${turnSeq}`, fileChanges: {} },
		});
	} else if (scenarios.has("native-approval-legacy-exec")) {
		send({
			id: reqId,
			method: "execCommandApproval",
			params: { conversationId: threadId, callId: `item-appr-${turnSeq}`, command: ["echo", "hi"], cwd: "/tmp" },
		});
	} else if (scenarios.has("native-approval-tool-call")) {
		send({
			id: reqId,
			method: "item/tool/call",
			params: { threadId, turnId, callId: `item-appr-${turnSeq}`, tool: "customTool", arguments: {} },
		});
	} else if (scenarios.has("native-approval-missing-thread")) {
		send({
			id: reqId,
			method: "item/commandExecution/requestApproval",
			params: {
				kind: "command",
				turnId,
				itemId: `item-appr-${turnSeq}`,
				command: "echo missing-thread",
				cwd: "/tmp/fixture",
			},
		});
	} else if (scenarios.has("native-approval-unknown")) {
		send({
			id: reqId,
			method: "item/futureUnknown/requestApproval",
			params: { threadId, turnId, itemId: `item-appr-${turnSeq}` },
		});
	}
}
