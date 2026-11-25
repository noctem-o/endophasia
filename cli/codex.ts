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

import { randomInt } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import {
	buildCodexNativeApprovalDecisionV0,
	CodexLiveControllerV0,
	type CodexOperationApproverV0,
} from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0, type CodexNativeApprovalHandlerV0 } from "../adapters/codex/develop-adapter.ts";
import { validateCodexSandboxModeV0 } from "../adapters/codex/isolated-home.ts";
import { CODEX_MAX_APPROVAL_SUMMARY_CHARS_V0 } from "../adapters/codex/native-approvals.ts";
import { type EndoContainmentV0, liveScopeV0 } from "../adapters/sandbox/containment.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { hostExecutionProtectionV0 } from "./execution-protection.ts";
import { liveContainmentV0 } from "./process-cleanup.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";
import { requireWorkbenchTerminalV0 } from "./workbench.ts";

const VALUE_FLAGS = new Set([
	"--attachment",
	"--executable",
	"--cwd",
	"--model",
	"--effort",
	"--sandbox",
	"--project",
	"--confirm",
	"--mode",
]);
const BOOL_FLAGS = new Set(["--ephemeral", "--workbench"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const SHORT_CONFIRM_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
type CodexReasoningEffortV0 = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
const sanitizeTerminalField = (value: string, max = 256): string =>
	value
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
		.trim()
		.slice(0, max);

const TERMINAL_MULTILINE_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Escape terminal control sequences (CSI/OSC/ESC/BEL/C0/C1/DEL/bidi) in multiline output while preserving `\n` and `\t`. */
export function sanitizeCodexTerminalMultilineV0(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(TERMINAL_MULTILINE_UNSAFE, (ch) => {
		const code = ch.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

function shortCode(): string {
	let out = "";
	for (let i = 0; i < 4; i += 1) {
		out += SHORT_CONFIRM_ALPHABET[randomInt(0, SHORT_CONFIRM_ALPHABET.length)]!;
	}
	return out;
}

const hhmmss = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);

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
	const { flags, booleans } = parseFlags(taken.rest);
	if (booleans.has("--workbench") || flags.has("--project") || flags.has("--confirm") || flags.has("--mode")) {
		throw new TypeError("--workbench, --project, --confirm and --mode belong to `endo codex session --workbench`");
	}
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

/**
 * `endo codex session [<root> | --root dir] --cwd <dir> [--attachment codex.default] [--executable <path>] [--model <id>] [--effort low] [--sandbox read-only|workspace-write] [--ephemeral] [--workbench [--project <id>] [--confirm phrase|short]]`
 */
export async function codexSessionCommand(argv: readonly string[]): Promise<void> {
	const taken = takeEndoRootV0(argv, 0, VALUE_FLAGS);
	const { flags, booleans } = parseFlags(taken.rest);
	const workbench = booleans.has("--workbench");
	const projectId = flags.get("--project");
	const confirmFlag = flags.get("--confirm");
	const modeFlag = flags.get("--mode");
	if (!workbench && (projectId !== undefined || confirmFlag !== undefined || modeFlag !== undefined)) {
		throw new TypeError("--project, --confirm and --mode require --workbench");
	}
	if (modeFlag !== undefined && modeFlag !== "strict") {
		throw new TypeError(
			`Codex workbench is Strict-only in v0 (got --mode ${modeFlag}); omit --mode or pass --mode strict.`,
		);
	}
	if (confirmFlag !== undefined && confirmFlag !== "phrase" && confirmFlag !== "short") {
		throw new TypeError("--confirm is phrase or short");
	}
	if (projectId !== undefined && !ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) {
		throw new TypeError("--project is a project id (endo.project.…) from `endo project add` or `endo project list`");
	}
	const cwdRaw = flags.get("--cwd") ?? (workbench ? process.cwd() : undefined);
	if (cwdRaw === undefined || cwdRaw.length === 0) {
		throw new TypeError(
			"usage: endo codex session [<root> | --root dir] --cwd <dir> [--model <id>] [--effort <level>] [--workbench]",
		);
	}
	requireWorkbenchTerminalV0();
	const projectScope = realpathSync(resolve(cwdRaw));
	const attachmentId = flags.get("--attachment") ?? "codex.default";
	const executable = flags.get("--executable");
	const model = flags.get("--model");
	const effort = parseReasoningEffort(flags.get("--effort"));
	const sandboxMode = flags.has("--sandbox") ? validateCodexSandboxModeV0(flags.get("--sandbox")) : undefined;
	const ephemeral = booleans.has("--ephemeral");
	announceEndoRootV0(taken);

	if (workbench) {
		return runCodexWorkbenchSession({
			root: taken.root,
			projectScope,
			attachmentId,
			...(executable === undefined ? {} : { executable }),
			...(model === undefined ? {} : { model }),
			...(effort === undefined ? {} : { effort }),
			...(sandboxMode === undefined ? {} : { sandboxMode }),
			ephemeral,
			...(projectId === undefined ? {} : { projectId }),
			confirm: (confirmFlag as "phrase" | "short" | undefined) ?? "phrase",
		});
	}

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
	// `native-approval>` never overlap on stdin. Urgent prompts preempt an idle REPL prompt cleanly, including
	// when an urgent prompt arrives in the microtask window before the REPL prompt begins awaiting stdin.
	let promptQueue: Promise<unknown> = Promise.resolve();
	let replPromptAbort: AbortController | null = null;
	let pendingUrgentPrompts = 0;
	let shuttingDown = false;
	const shutdownAbort = new AbortController();
	const onSignal = (): void => {
		shuttingDown = true;
		shutdownAbort.abort();
		replPromptAbort?.abort();
		rl.close();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const enqueuePrompt = <T>(fn: () => Promise<T>, preemptRepl: boolean): Promise<T> => {
		if (preemptRepl) {
			pendingUrgentPrompts += 1;
			replPromptAbort?.abort();
		}
		const run = async (): Promise<T> => {
			try {
				return await fn();
			} finally {
				if (preemptRepl) pendingUrgentPrompts = Math.max(0, pendingUrgentPrompts - 1);
			}
		};
		const task = promptQueue.then(run);
		promptQueue = task.catch(() => {});
		return task;
	};

	const approveOperation: CodexOperationApproverV0 = (prompt, signal) =>
		enqueuePrompt(async () => {
			const combinedSignal = AbortSignal.any([signal, shutdownAbort.signal]);
			if (shuttingDown || combinedSignal.aborted) return { approved: false, reason: "aborted" };
			write(
				`\n[GOVERNED APPROVAL REQUIRED]\n` +
					`  Operation: ${prompt.operation}\n` +
					`  Thread:    ${prompt.threadId} (instance ${prompt.instanceId})\n` +
					`  Workspace: ${prompt.projectScope}\n` +
					`  Preview:   ${prompt.preview}\n` +
					`  Type exact phrase to approve: ${prompt.requiredPhrase}\n`,
			);
			try {
				const answer = (await rl.question("approval> ", { signal: combinedSignal })).trim();
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
			const combinedSignal = AbortSignal.any([signal, shutdownAbort.signal]);
			if (shuttingDown || combinedSignal.aborted) return null;
			write(
				`\n[NATIVE CODEX APPROVAL REQUEST]\n` +
					`  Request: ${sanitizeTerminalField(request.requestId, 128)}\n` +
					`  Kind:    ${sanitizeTerminalField(request.approvalKind, 64)} (${sanitizeTerminalField(request.nativeMethod, 128)})\n` +
					`  Scope:   ${sanitizeTerminalField(request.requestedScope, 32)} (Endophasia v0 permits one-time only)\n` +
					`  Turn:    ${request.turnId === null ? "(none)" : sanitizeTerminalField(request.turnId, 128)} | Item: ${request.itemId === null ? "(none)" : sanitizeTerminalField(request.itemId, 128)}\n` +
					`  Summary: ${sanitizeTerminalField(request.summary, CODEX_MAX_APPROVAL_SUMMARY_CHARS_V0)}\n` +
					`  Type "ALLOW ONCE" to accept once, "CANCEL" to cancel, or anything else to decline:\n`,
			);
			try {
				const answer = (await rl.question("native-approval> ", { signal: combinedSignal })).trim();
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
			write(`\n${label} ${sanitizeCodexTerminalMultilineV0(obs.body.text ?? "")}\n`);
		} else if (obs.body.kind === "tool-activity") {
			write(
				`\n[activity:${obs.body.activityKind}] ${sanitizeTerminalField(obs.body.name, 160)} -> ${obs.body.phase}${obs.body.exitCode !== null ? ` (exit=${obs.body.exitCode})` : ""}\n`,
			);
		} else if (obs.body.kind === "lifecycle") {
			const safeDetail = obs.body.detail ? sanitizeTerminalField(obs.body.detail, 256) : "";
			write(`\n[lifecycle] ${obs.body.event}${safeDetail ? `: ${safeDetail}` : ""}\n`);
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
					if (pendingUrgentPrompts > 0) return { kind: "preempted" };
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
				const out = await controller.requestStop(turnId, shutdownAbort.signal);
				write(`${JSON.stringify(out)}\n`);
				continue;
			}
			if (line.startsWith("prompt ")) {
				const msg = line.slice("prompt ".length).trim();
				const out = await controller.requestPrompt(msg, shutdownAbort.signal);
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

export interface CodexWorkbenchLaunchArgsV0 {
	readonly root: string;
	readonly projectScope: string;
	readonly attachmentId: string;
	readonly executable?: string;
	readonly model?: string;
	readonly effort?: CodexReasoningEffortV0;
	readonly sandboxMode?: "read-only" | "workspace-write";
	readonly ephemeral: boolean;
	readonly projectId?: string;
	readonly confirm: "phrase" | "short";
}

/**
 * Launch a Strict-only live Codex session wired into Endophasia Studio's DEVELOP browser workbench.
 * Used by both `endo codex session --workbench` and `endo develop --harness codex`.
 */
export async function runCodexWorkbenchSession(args: CodexWorkbenchLaunchArgsV0): Promise<void> {
	const write = (text: string) => process.stderr.write(text);
	const [
		{ endoStudioUiDirectoryV0 },
		{ launchEndoCockpitV0 },
		{ cockpitAliasesV0 },
		{ loadOrCreateEndoDigestKeyV0 },
		{ GitProjectInspectorV0 },
		{ endoDevelopServiceV0 },
		{ CodexWorkbenchBrokerV0 },
	] = await Promise.all([
		import("./studio.ts"),
		import("../cockpit-http/host.ts"),
		import("../cockpit/index.ts"),
		import("../storage/digest-key.ts"),
		import("../adapters/git/project-inspector.ts"),
		import("./develop-service.ts"),
		import("../adapters/codex/workbench.ts"),
	]);

	const uiDirectory = endoStudioUiDirectoryV0();
	if (uiDirectory === null) {
		throw new Error(
			"the Studio page has not been built for this installation (run `npm run build:studio-ui` in a checkout)",
		);
	}

	const live = await liveContainmentV0();
	for (const note of live.notes) write(`${note}\n`);

	const check = await runCodexLocalProtocolCheckV0({
		root: args.root,
		attachment: args.attachmentId,
		...(args.executable === undefined ? {} : { executable: args.executable }),
		checkCwd: args.projectScope,
		...(args.sandboxMode === undefined ? {} : { sandboxMode: args.sandboxMode }),
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
	let promptQueue: Promise<unknown> = Promise.resolve();
	let replPromptAbort: AbortController | null = null;
	let nativePromptAbort: AbortController | null = null;
	let pendingUrgentPrompts = 0;
	let shuttingDown = false;
	let rlClosed = false;
	const shutdownAbort = new AbortController();
	const onSignal = (): void => {
		shuttingDown = true;
		shutdownAbort.abort();
		replPromptAbort?.abort();
		nativePromptAbort?.abort();
		if (!rlClosed) rl.close();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	rl.on("SIGINT", onSignal);
	rl.on("close", () => {
		rlClosed = true;
		shuttingDown = true;
		shutdownAbort.abort();
		replPromptAbort?.abort();
		nativePromptAbort?.abort();
	});

	let adapter: CodexDevelopAdapterV0 | null = null;
	let broker: InstanceType<typeof CodexWorkbenchBrokerV0> | null = null;
	let launched: Awaited<ReturnType<typeof launchEndoCockpitV0>> | null = null;
	let stopSub: (() => void) | null = null;

	try {
		const enqueuePrompt = <T>(fn: () => Promise<T>, preemptRepl: boolean, preemptNative = false): Promise<T> => {
			if (preemptRepl) {
				pendingUrgentPrompts += 1;
				replPromptAbort?.abort();
			}
			if (preemptNative) {
				nativePromptAbort?.abort("preempted-by-stop");
			}
			const run = async (): Promise<T> => {
				try {
					return await fn();
				} finally {
					if (preemptRepl) pendingUrgentPrompts = Math.max(0, pendingUrgentPrompts - 1);
				}
			};
			const task = promptQueue.then(run);
			promptQueue = task.catch(() => {});
			return task;
		};

		const handleNativeApproval: CodexNativeApprovalHandlerV0 = async (request, signal) => {
			const combinedSignal = AbortSignal.any([signal, shutdownAbort.signal]);
			while (!shuttingDown && !rlClosed && !combinedSignal.aborted) {
				const attempt = await enqueuePrompt(async () => {
					if (shuttingDown || rlClosed || combinedSignal.aborted) return { kind: "aborted" as const };
					const localAbort = new AbortController();
					nativePromptAbort = localAbort;
					write(
						`\n[NATIVE CODEX APPROVAL REQUEST]\n` +
							`  Request: ${sanitizeTerminalField(request.requestId, 128)}\n` +
							`  Kind:    ${sanitizeTerminalField(request.approvalKind, 64)} (${sanitizeTerminalField(request.nativeMethod, 128)})\n` +
							`  Scope:   ${sanitizeTerminalField(request.requestedScope, 32)} (Endophasia v0 permits one-time only)\n` +
							`  Turn:    ${request.turnId === null ? "(none)" : sanitizeTerminalField(request.turnId, 128)} | Item: ${request.itemId === null ? "(none)" : sanitizeTerminalField(request.itemId, 128)}\n` +
							`  Summary: ${sanitizeTerminalField(request.summary, CODEX_MAX_APPROVAL_SUMMARY_CHARS_V0)}\n` +
							`  Note:    Native Codex approvals are authorized ONLY here on the terminal (never from the browser).\n` +
							`  Type "ALLOW ONCE" to accept once, "CANCEL" to cancel, or anything else to decline:\n`,
					);
					try {
						const answer = (
							await rl.question("native-approval> ", {
								signal: AbortSignal.any([combinedSignal, localAbort.signal]),
							})
						).trim();
						const decision = answer === "ALLOW ONCE" ? "accept" : answer === "CANCEL" ? "cancel" : "decline";
						return {
							kind: "decided" as const,
							decision: buildCodexNativeApprovalDecisionV0({ request, decision }),
						};
					} catch {
						if (!shuttingDown && !rlClosed) {
							rl.write(null, { ctrl: true, name: "u" });
						}
						if (localAbort.signal.aborted && !combinedSignal.aborted) {
							return { kind: "preempted" as const };
						}
						return { kind: "aborted" as const };
					} finally {
						if (nativePromptAbort === localAbort) nativePromptAbort = null;
					}
				}, true);
				if (attempt.kind === "decided") return attempt.decision;
				if (attempt.kind === "aborted") return null;
				// Yield so the preempting STOP prompt runs ahead of re-showing native-approval>.
				await Promise.resolve();
			}
			return null;
		};

		adapter = new CodexDevelopAdapterV0({
			root: args.root,
			attachmentId: args.attachmentId,
			projectScope: args.projectScope,
			executable: resolvedExecutable,
			fingerprint: check.fingerprint,
			capabilityState: check.capabilityState,
			...(args.model === undefined ? {} : { model: args.model }),
			...(args.effort === undefined ? {} : { reasoningEffort: args.effort }),
			...(args.sandboxMode === undefined ? {} : { sandboxMode: args.sandboxMode }),
			ephemeral: args.ephemeral,
			...(live.containment === null ? {} : { scope: liveScopeV0(live.containment as EndoContainmentV0) }),
			onNativeApprovalRequest: handleNativeApproval,
		});

		let aliasOf = (id: string): string => id;
		broker = new CodexWorkbenchBrokerV0({
			adapter,
			project: new GitProjectInspectorV0({ cwd: args.projectScope }),
			protection: hostExecutionProtectionV0(),
			aliasOf: (id) => aliasOf(id),
			...(args.projectId === undefined
				? {}
				: {
						tasks: {
							open: (host) =>
								endoDevelopServiceV0(args.root).forLaunch(
									{ projectId: args.projectId as string, launchDirectory: args.projectScope },
									host,
								),
						},
					}),
			approver: (ctx, signal) =>
				enqueuePrompt(
					async () => {
						const combinedSignal = AbortSignal.any([signal, shutdownAbort.signal]);
						if (shuttingDown || rlClosed || combinedSignal.aborted) return { approved: false, reason: "aborted" };
						const code = args.confirm === "short" ? shortCode() : null;
						const fullBody =
							ctx.fullMessage !== null
								? `\n--- exact ${ctx.prompt.operation} ---\n${sanitizeCodexTerminalMultilineV0(ctx.fullMessage)}\n--- end ---\n`
								: "";
						write(
							`\n[GOVERNED APPROVAL REQUIRED — STRICT CODEX WORKBENCH]\n` +
								`  Origin:    ${ctx.requestedFrom === "page" ? "paired browser page" : "attached terminal"}\n` +
								`  Operation: ${ctx.prompt.operation}${ctx.prompt.targetTurnId ? ` (target turn ${ctx.prompt.targetTurnId})` : ""}\n` +
								`  Thread:    ${ctx.prompt.threadId} (instance ${ctx.prompt.instanceId})\n` +
								`  Workspace: ${ctx.prompt.projectScope}\n` +
								`  Digest:    ${ctx.digestPrefix} (expires ${hhmmss(ctx.expiresAtMs)})\n` +
								(fullBody.length > 0 ? fullBody : `  Preview:   ${ctx.prompt.preview}\n`) +
								`  Type ${code === null ? ctx.prompt.requiredPhrase : `${code} (or ${ctx.prompt.requiredPhrase})`} to approve; anything else declines:\n`,
						);
						try {
							const answer = (await rl.question("approval> ", { signal: combinedSignal })).trim();
							if (answer === ctx.prompt.requiredPhrase) {
								return { approved: true, mechanism: "terminal-phrase" };
							}
							if (code !== null && answer === code) {
								return { approved: true, mechanism: "terminal-code" };
							}
							return { approved: false, reason: "Approval phrase did not match." };
						} catch {
							if (!shuttingDown && !rlClosed) {
								rl.write(null, { ctrl: true, name: "u" });
								write(
									signal.reason === "superseded-by-stop"
										? "\nworkbench: that request was cancelled, unapproved, because a stop was requested.\n"
										: "\nworkbench: that approval prompt ended without confirmation.\n",
								);
							}
							return { approved: false, reason: "aborted" };
						}
					},
					true,
					ctx.prompt.operation === "stop",
				),
		});

		stopSub = adapter.subscribeObservations((obs) => {
			if (obs.body.kind === "lifecycle" && obs.body.event === "connection-lost") {
				const detail = obs.body.detail ? sanitizeTerminalField(obs.body.detail, 256) : "connection lost";
				write(`\nworkbench: Codex connection lost (${detail}). Private transcript cleared.\n`);
			}
		});

		const opened = await adapter.open();
		launched = await launchEndoCockpitV0({
			root: args.root,
			uiDirectory,
			workbench: broker,
			start: "develop",
			onKey: (key) => {
				if (key.created) write(`workbench: created the cockpit's own digest key ${key.path}\n`);
			},
			onError: () => write("workbench: an internal error occurred (the request was refused)\n"),
		});
		const aliases = cockpitAliasesV0(loadOrCreateEndoDigestKeyV0(launched.key.path));
		aliasOf = (id) => aliases.id(id);

		const showCode = (): void => {
			const issued = broker!.issuePairingCode();
			write(
				`workbench: pairing code ${issued.code}  (one use; expires ${hhmmss(issued.expiresAtMs)}). ` +
					`Type it into the page to read the live Codex transcript and request prompts or turn interruption. ` +
					`Codex workbench is STRICT-only: every prompt, stop, and native Codex approval is confirmed here.\n`,
			);
		};

		write(
			`workbench: Codex live session ready (thread=${opened.threadId}, model=${opened.effectivePolicy.model ?? "default"}, ` +
				`sandbox=${JSON.stringify(opened.effectivePolicy.sandbox)}, approvalPolicy=${JSON.stringify(opened.effectivePolicy.approvalPolicy)}, ` +
				`reviewer=${String(opened.effectivePolicy.approvalsReviewer)})\n`,
		);
		write(
			"workbench: the address below is private to this launch; anyone who can read it can read what this store records. " +
				"It lets a page READ and ask; only you, here, can approve a prompt, stop, or native Codex request.\n",
		);
		write(`workbench: ${launched.server.baseUrl}/\n`);
		if (args.confirm === "short") {
			write(
				"workbench: --confirm short: prompts and stops may be approved by their 4-character code here (native Codex approvals still require ALLOW ONCE).\n",
			);
		}
		showCode();
		write("workbench: commands: pair | revoke | status | view | stop | prompt <text> | quit\n");

		while (!shuttingDown && !rlClosed) {
			const result = await enqueuePrompt(
				async (): Promise<{ kind: "line"; line: string } | { kind: "preempted" } | { kind: "eof" }> => {
					if (shuttingDown || rlClosed) return { kind: "eof" };
					if (pendingUrgentPrompts > 0) return { kind: "preempted" };
					const ac = new AbortController();
					replPromptAbort = ac;
					try {
						const raw = await rl.question("codex> ", { signal: ac.signal });
						return { kind: "line", line: raw.trim() };
					} catch {
						if (ac.signal.aborted && !shuttingDown && !rlClosed) return { kind: "preempted" };
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
			if (line === "pair") {
				showCode();
				continue;
			}
			if (line === "revoke") {
				broker.revokePairing();
				write("workbench: pairing grant revoked. Type `pair` for a new code.\n");
				continue;
			}
			if (line === "status") {
				write(`${JSON.stringify(broker.controller.status(), null, 2)}\n`);
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
				const out = await broker.controller.requestStop(turnId, shutdownAbort.signal);
				write(`${JSON.stringify(out)}\n`);
				continue;
			}
			if (line.startsWith("prompt ")) {
				const msg = line.slice("prompt ".length).trim();
				const out = await broker.controller.requestPrompt(msg, shutdownAbort.signal);
				write(`${JSON.stringify(out)}\n`);
				continue;
			}
			write("Unknown command. Use: pair | revoke | status | view | stop | prompt <text> | quit\n");
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		stopSub?.();
		broker?.beginClose();
		if (!rlClosed) rl.close();
		await launched?.server.close().catch(() => {});
		await broker?.dispose();
		if (adapter !== null) {
			const closed = await adapter.close();
			write(`Closed Codex workbench (cleanup=${closed.cleanup.boundary}/${closed.cleanup.result})\n`);
		}
	}
}

export const CODEX_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	check: codexCheckCommand,
	session: codexSessionCommand,
};
