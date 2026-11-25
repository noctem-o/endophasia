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
import { validateCodexSandboxModeV0 } from "../adapters/codex/isolated-home.ts";
import { type EndoContainmentV0, liveScopeV0 } from "../adapters/sandbox/containment.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { liveContainmentV0 } from "./process-cleanup.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";
import { requireWorkbenchTerminalV0 } from "./workbench.ts";

const VALUE_FLAGS = new Set(["--attachment", "--executable", "--cwd", "--model", "--effort", "--sandbox"]);
const BOOL_FLAGS = new Set(["--ephemeral"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
type CodexReasoningEffortV0 = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

function parseReasoningEffort(raw: string | undefined): CodexReasoningEffortV0 | undefined {
	if (raw === undefined) return undefined;
	if (!VALID_EFFORTS.has(raw)) {
		throw new TypeError(`invalid --effort value "${raw}"; expected one of: ${[...VALID_EFFORTS].join(", ")}`);
	}
	return raw as CodexReasoningEffortV0;
}

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
	const effort = parseReasoningEffort(flags.get("--effort"));
	const sandboxMode = flags.has("--sandbox") ? validateCodexSandboxModeV0(flags.get("--sandbox")) : undefined;
	const live = await liveContainmentV0();
	for (const note of live.notes) process.stderr.write(`${note}\n`);

	const result = await runCodexLocalProtocolCheckV0({
		root: taken.root,
		attachment,
		...(executable === undefined ? {} : { executable }),
		...(checkCwd === undefined ? {} : { checkCwd: realpathSync(checkCwd) }),
		...(sandboxMode === undefined ? {} : { sandboxMode }),
		...(effort === undefined ? {} : { extraConfigOverrides: [`model_reasoning_effort="${effort}"`] }),
		...(live.containment === null ? {} : { scope: liveScopeV0(live.containment as EndoContainmentV0) }),
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
	const effort = parseReasoningEffort(flags.get("--effort"));
	const sandboxMode = flags.has("--sandbox") ? validateCodexSandboxModeV0(flags.get("--sandbox")) : undefined;
	const ephemeral = booleans.has("--ephemeral");
	announceEndoRootV0(taken);

	const live = await liveContainmentV0();
	for (const note of live.notes) process.stderr.write(`${note}\n`);

	const check = await runCodexLocalProtocolCheckV0({
		root: taken.root,
		attachment: attachmentId,
		...(executable === undefined ? {} : { executable }),
		checkCwd: projectScope,
		...(sandboxMode === undefined ? {} : { sandboxMode }),
		...(live.containment === null ? {} : { scope: liveScopeV0(live.containment as EndoContainmentV0) }),
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

	// Serialize EVERY terminal readline prompt through a single queue so REPL `codex>`, `approval>`, and async
	// `native-approval>` never overlap on stdin. Urgent prompts preempt an idle REPL prompt cleanly.
	let promptQueue: Promise<unknown> = Promise.resolve();
	let replPromptAbort: AbortController | null = null;
	let shuttingDown = false;
	const onSignal = (): void => {
		shuttingDown = true;
		replPromptAbort?.abort();
		rl.close();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const enqueuePrompt = <T>(fn: () => Promise<T>, preemptRepl: boolean): Promise<T> => {
		if (preemptRepl) {
			replPromptAbort?.abort();
		}
		const task = promptQueue.then(fn);
		promptQueue = task.catch(() => {});
		return task;
	};

	const approveOperation: CodexOperationApproverV0 = (prompt, signal) =>
		enqueuePrompt(async () => {
			if (shuttingDown || signal.aborted) return { approved: false, reason: "aborted" };
			write(
				`\n[GOVERNED APPROVAL REQUIRED]\n` +
					`  Operation: ${prompt.operation}\n` +
					`  Thread:    ${prompt.threadId} (instance ${prompt.instanceId})\n` +
					`  Workspace: ${prompt.projectScope}\n` +
					`  Preview:   ${prompt.preview}\n` +
					`  Type exact phrase to approve: ${prompt.requiredPhrase}\n`,
			);
			try {
				const answer = (await rl.question("approval> ", { signal })).trim();
				if (answer === prompt.requiredPhrase) {
					return { approved: true, mechanism: "terminal-phrase" };
				}
				return { approved: false, reason: "Approval phrase did not match." };
			} catch {
				return { approved: false, reason: "aborted" };
			}
		}, true);

	const handleNativeApproval: CodexNativeApprovalHandlerV0 = (request, signal) =>
		enqueuePrompt(async () => {
			if (shuttingDown || signal.aborted) return null;
			write(
				`\n[NATIVE CODEX APPROVAL REQUEST]\n` +
					`  Request: ${request.requestId}\n` +
					`  Kind:    ${request.approvalKind} (${request.nativeMethod})\n` +
					`  Scope:   ${request.requestedScope} (Endophasia v0 permits one-time only)\n` +
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
		}, true);

	const adapter = new CodexDevelopAdapterV0({
		root: taken.root,
		attachmentId,
		projectScope,
		executable: resolvedExecutable,
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { reasoningEffort: effort }),
		...(sandboxMode === undefined ? {} : { sandboxMode }),
		ephemeral,
		...(live.containment === null ? {} : { scope: liveScopeV0(live.containment as EndoContainmentV0) }),
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
		while (!shuttingDown) {
			const result = await enqueuePrompt(
				async (): Promise<{ kind: "line"; line: string } | { kind: "preempted" } | { kind: "eof" }> => {
					if (shuttingDown) return { kind: "eof" };
					const ac = new AbortController();
					replPromptAbort = ac;
					try {
						const raw = await rl.question("codex> ", { signal: ac.signal });
						return { kind: "line", line: raw.trim() };
					} catch {
						if (ac.signal.aborted && !shuttingDown) return { kind: "preempted" };
						return { kind: "eof" };
					} finally {
						if (replPromptAbort === ac) replPromptAbort = null;
					}
				},
				false,
			);
			if (result.kind === "eof") break;
			if (result.kind === "preempted") continue;
			const line = result.line;
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
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
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
