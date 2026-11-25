/**
 * CLI entrypoints for the governed live Codex App Server integration (`DEVELOP-CODEX-LIVE-001`):
 *
 *   endo codex check [<root> | --root dir] [--attachment <id>] [--executable <path>] [--cwd <dir>]
 *     Runs the offline local-protocol check (initialize, config/read, ephemeral thread/start, effective-policy
 *     verification, thread/unsubscribe — ZERO model turns) and records evidence in `<root>/harness/<attachment>/records.log`.
 *
 *   endo codex session [<root> | --root dir] --cwd <dir> [--attachment <id>] [--executable <path>] [--model <id>] [--effort <level>] [--ephemeral]
 *     Starts a Strict-only controlling-terminal governed live Codex session. Requires a verified controlling terminal
 *     (`requireWorkbenchTerminalV0`): approvals are never read from a pipe or file.
 */

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import {
	buildCodexNativeApprovalDecisionV0,
	CodexLiveControllerV0,
	type CodexOperationApproverV0,
} from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0, type CodexNativeApprovalHandlerV0 } from "../adapters/codex/develop-adapter.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";
import { requireWorkbenchTerminalV0 } from "./workbench.ts";

const VALUE_FLAGS = new Set(["--attachment", "--executable", "--cwd", "--model", "--effort"]);
const BOOL_FLAGS = new Set(["--ephemeral"]);

function parseFlags(args: readonly string[]): { flags: Map<string, string>; booleans: Set<string> } {
	const flags = new Map<string, string>();
	const booleans = new Set<string>();
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i]!;
		if (BOOL_FLAGS.has(token)) {
			booleans.add(token);
			continue;
		}
		if (VALUE_FLAGS.has(token)) {
			const val = args[i + 1];
			if (val === undefined) throw new TypeError(`flag ${token} requires a value`);
			flags.set(token, val);
			i += 1;
			continue;
		}
		throw new TypeError(`unknown flag: ${token}`);
	}
	return { flags, booleans };
}

/** `endo codex check [<root> | --root dir] [--attachment codex.default] [--executable /usr/bin/codex] [--cwd dir]` */
export async function codexCheckCommand(argv: readonly string[]): Promise<void> {
	const taken = takeEndoRootV0(argv, 0, VALUE_FLAGS);
	const { flags } = parseFlags(taken.rest);
	announceEndoRootV0(taken);
	const attachment = flags.get("--attachment") ?? "codex.default";
	const executable = flags.get("--executable");
	const checkCwd = flags.get("--cwd");

	const result = await runCodexLocalProtocolCheckV0({
		root: taken.root,
		attachment,
		...(executable === undefined ? {} : { executable }),
		...(checkCwd === undefined ? {} : { checkCwd: realpathSync(checkCwd) }),
	});

	console.log(
		canonicalEndoJsonV0({
			fingerprint: result.fingerprint,
			change: result.change,
			initialize: result.initialize,
			effectivePolicy: result.effectivePolicy,
			configurationDigest: result.configurationDigest,
			capabilityState: result.capabilityState,
			cleanup: result.cleanup,
		} as never),
	);
}

/** `endo codex session [<root> | --root dir] --cwd <dir> [--attachment codex.default] [--executable <path>] [--model <id>] [--effort low] [--ephemeral]` */
export async function codexSessionCommand(argv: readonly string[]): Promise<void> {
	requireWorkbenchTerminalV0();
	const taken = takeEndoRootV0(argv, 0, VALUE_FLAGS);
	const { flags, booleans } = parseFlags(taken.rest);
	const cwdRaw = flags.get("--cwd");
	if (cwdRaw === undefined || cwdRaw.length === 0) {
		throw new TypeError(
			"usage: endo codex session [<root> | --root dir] --cwd <dir> [--model <id>] [--effort <level>]",
		);
	}
	const projectScope = realpathSync(cwdRaw);
	const attachmentId = flags.get("--attachment") ?? "codex.default";
	const executable = flags.get("--executable");
	const model = flags.get("--model");
	const effort = flags.get("--effort") as "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | undefined;
	const ephemeral = booleans.has("--ephemeral");
	announceEndoRootV0(taken);

	const check = await runCodexLocalProtocolCheckV0({
		root: taken.root,
		attachment: attachmentId,
		...(executable === undefined ? {} : { executable }),
		checkCwd: projectScope,
	});
	if (!check.effectivePolicy.ok) {
		throw new Error(`Codex offline policy check failed: ${check.effectivePolicy.reasons.join("; ")}`);
	}
	const resolvedExecutable = check.fingerprint.local.resolvedPath ?? check.fingerprint.local.realPath;
	if (resolvedExecutable === null) {
		throw new Error("Codex executable path could not be resolved.");
	}

	const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	const write = (text: string) => process.stderr.write(text);

	const approveOperation: CodexOperationApproverV0 = async (prompt, signal) => {
		if (signal.aborted) return { approved: false, reason: "aborted" };
		write(
			`\n[GOVERNED APPROVAL REQUIRED]\n` +
				`  Operation: ${prompt.operation}\n` +
				`  Thread:    ${prompt.threadId} (instance ${prompt.instanceId})\n` +
				`  Workspace: ${prompt.projectScope}\n` +
				`  Preview:   ${prompt.preview}\n` +
				`  Type exact phrase to approve: ${prompt.requiredPhrase}\n`,
		);
		const answer = (await rl.question("approval> ", { signal })).trim();
		if (answer === prompt.requiredPhrase) {
			return { approved: true, mechanism: "terminal-phrase" };
		}
		return { approved: false, reason: "Approval phrase did not match." };
	};

	const handleNativeApproval: CodexNativeApprovalHandlerV0 = async (request, signal) => {
		if (signal.aborted) return null;
		write(
			`\n[NATIVE CODEX APPROVAL REQUEST]\n` +
				`  Request: ${request.requestId}\n` +
				`  Kind:    ${request.approvalKind} (${request.nativeMethod})\n` +
				`  Turn:    ${request.turnId ?? "(none)"} | Item: ${request.itemId ?? "(none)"}\n` +
				`  Summary: ${request.summary}\n` +
				`  Type "ALLOW ONCE" to accept once, "CANCEL" to cancel, or anything else to decline:\n`,
		);
		try {
			const answer = (await rl.question("native-approval> ", { signal })).trim();
			const decision = answer === "ALLOW ONCE" ? "accept" : answer === "CANCEL" ? "cancel" : "decline";
			return buildCodexNativeApprovalDecisionV0({ request, decision });
		} catch {
			return null;
		}
	};

	const adapter = new CodexDevelopAdapterV0({
		root: taken.root,
		attachmentId,
		projectScope,
		executable: resolvedExecutable,
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { reasoningEffort: effort }),
		ephemeral,
		onNativeApprovalRequest: handleNativeApproval,
	});

	const stopSub = adapter.subscribeObservations((obs) => {
		if (obs.body.kind === "transcript" && obs.body.role === "assistant") {
			const label =
				obs.body.contentKind === "reasoning" ? `[${obs.body.reasoningKind ?? "reasoning"}]` : "[assistant]";
			write(`\n${label} ${obs.body.text ?? ""}\n`);
		} else if (obs.body.kind === "tool-activity") {
			write(
				`\n[activity:${obs.body.activityKind}] ${obs.body.name} -> ${obs.body.phase}${obs.body.exitCode !== null ? ` (exit=${obs.body.exitCode})` : ""}\n`,
			);
		} else if (obs.body.kind === "lifecycle") {
			write(`\n[lifecycle] ${obs.body.event}${obs.body.detail ? `: ${obs.body.detail}` : ""}\n`);
		} else if (obs.body.kind === "usage" && obs.body.usage.status === "reported") {
			const u = obs.body.usage.value;
			write(
				`\n[usage] in=${u.inputTokens} out=${u.outputTokens} total=${u.totalTokens} reasoning=${String(u.reasoningTokens)} costUsd=unavailable\n`,
			);
		}
	});

	const controller = new CodexLiveControllerV0({ adapter, approveOperation });
	try {
		const opened = await adapter.open();
		write(
			`Codex live session ready (thread=${opened.threadId}, model=${opened.effectivePolicy.model ?? "default"}, ` +
				`approvalPolicy=${JSON.stringify(opened.effectivePolicy.approvalPolicy)}, reviewer=${String(opened.effectivePolicy.approvalsReviewer)})\n` +
				`Commands: prompt <text> | stop | status | view | quit\n`,
		);
		for (;;) {
			let line: string;
			try {
				line = (await rl.question("codex> ")).trim();
			} catch {
				break;
			}
			if (line === "quit" || line === "exit") break;
			if (line === "") continue;
			if (line === "status") {
				write(`${JSON.stringify(controller.status(), null, 2)}\n`);
				continue;
			}
			if (line === "view") {
				write(`${JSON.stringify(adapter.liveView(), null, 2)}\n`);
				continue;
			}
			if (line === "stop") {
				const turnId = adapter.activeTurnId;
				if (turnId === null) {
					write("No active turn to interrupt.\n");
					continue;
				}
				const out = await controller.requestStop(turnId);
				write(`${JSON.stringify(out)}\n`);
				continue;
			}
			if (line.startsWith("prompt ")) {
				const msg = line.slice("prompt ".length).trim();
				const out = await controller.requestPrompt(msg);
				write(`${JSON.stringify(out)}\n`);
				continue;
			}
			write("Unknown command. Use: prompt <text> | stop | status | view | quit\n");
		}
	} finally {
		stopSub();
		rl.close();
		const closed = await adapter.close();
		write(`Closed Codex session (cleanup=${closed.cleanup.boundary}/${closed.cleanup.result})\n`);
	}
}

export const CODEX_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	check: codexCheckCommand,
	session: codexSessionCommand,
};
