/**
 * `endo harness attach <root> --control --workbench`: the attached process also serves the DEVELOP workbench on a loopback address of
 * its own, behind a command broker (adapters/pi/workbench.ts). This module is only the process wiring: the controlling-terminal
 * check, the terminal approval, the pairing code, and starting and stopping the server. Nothing here sends a command.
 *
 * The terminal is the authority. Approvals are typed on the process's CONTROLLING terminal: stdin and stderr must both be that
 * terminal itself (a pipe, a file, a socket, another terminal, or no terminal is refused before anything starts), so a page, a script
 * or a redirected stream cannot approve a prompt. The same rule as the terminal-governed A/A operator, written here for production
 * code (production `cli/` never imports `research/`).
 */
import { randomInt } from "node:crypto";
import { fstatSync, readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import type { PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import type { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import { type WorkbenchApproverV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { cockpitAliasesV0 } from "../cockpit/index.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { endoWorkbenchTerminalCommandInV0 } from "../protocol/workbench.ts";
import {
	DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0,
	DevelopAttemptDispatchV0,
} from "../runtime/contracts/develop-attempt-dispatch.ts";
import type { EndoExecutionProtectionV0 } from "../runtime/contracts/execution-protection.ts";
import type { EndoWorkbenchModeV0 } from "../runtime/contracts/session-control.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { endoDevelopObservationsV0, endoDevelopServiceV0 } from "./develop-service.ts";
import { endoStudioUiDirectoryV0 } from "./studio.ts";

/** A Linux dev_t as /proc/<pid>/stat spells a terminal number (the kernel's `new_encode_dev`). */
function kernelDeviceNumber(rdev: bigint): number {
	const major = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn);
	const minor = (rdev & 0xffn) | ((rdev >> 12n) & ~0xffn);
	return Number((minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n));
}

/** Throws unless stdin and stderr are this process's controlling terminal. Linux only: where it cannot be verified it refuses. */
export function requireWorkbenchTerminalV0(): void {
	if (!process.stdin.isTTY || !process.stderr.isTTY)
		throw new TypeError(
			"--workbench needs a terminal on stdin and stderr; approvals are never read from a pipe or a file",
		);
	let controlling: number;
	try {
		const stat = readFileSync("/proc/self/stat", "utf8");
		controlling = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
	} catch {
		throw new TypeError("--workbench needs a controlling terminal it can verify (Linux /proc)");
	}
	if (!Number.isSafeInteger(controlling) || controlling === 0)
		throw new TypeError("--workbench needs a controlling terminal");
	for (const fd of [0, 2])
		if (kernelDeviceNumber(fstatSync(fd, { bigint: true }).rdev) !== controlling)
			throw new TypeError("--workbench needs stdin and stderr to be the controlling terminal");
}

export interface WorkbenchHandleV0 {
	/** `http://127.0.0.1:<port>/<capability>/` — a secret: anyone who can read it can read the store. */
	address: string;
	broker: WorkbenchBrokerV0;
	stop(): Promise<void>;
}

/** What approving each operation does, in the operator's own terminal. The page cannot approve any of them; only the operator can. */
const EFFECT_WORDS: Readonly<Record<"prompt" | "attempt" | "steer" | "queue" | "stop", string>> = {
	prompt:
		"Approving starts agent work, which may use the model and cost money. The page cannot approve this; only you can.",
	attempt:
		"Approving records that you authorised this attempt to be sent once, then sends its brief to this Pi session as a new prompt. That starts agent work in this directory, which may use the model and cost money. It is not retried: to try again, prepare a new attempt. Pi finishing a run does not mean the attempt succeeded; check it with `endo attempt check` and decide the task yourself. Terminal approval is not a sandbox: Pi runs with its own tools and permissions.",
	steer: "Approving sends this to the run that is open, after its current turn's tool calls and before the next model request. That may use the model and cost money. The page cannot approve this; only you can.",
	queue: "Approving sends this to the run that is open, to be delivered when the agent has no more tool calls or steering. That may use the model and cost money. The page cannot approve this; only you can.",
	stop: "Approving asks Pi to abort the run that is open. Pi answers only once it is idle, so this is a request, not an immediate stop. The page cannot approve this; only you can.",
};

const SESSION_CONTROL_END_WORDS: Readonly<Record<string, string>> = {
	expired: "its time ran out",
	"budget-spent": "its count of sends was used up",
	"revoked-on-terminal": "revoked here",
	"revoked-by-page": "given up by the page",
	"re-paired": "a page was paired again, so the page that held it is no longer the paired one",
	"session-changed": "the connected session is not the one it was granted for",
	"workspace-changed": "the workspace is not the one it was granted for",
	"protection-lost": "the agent's execution boundary is no longer observed as enforced",
	closing: "the session is closing",
};

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

/**
 * The short confirmation's alphabet (`--confirm short`, DEVELOP-UX-002 §6): lower case, no character that reads as another. It has no
 * `i` and no `o`, so a code can never spell this terminal's own commands (`pair`, `control`, `revoke`, `attempt`).
 */
const SHORT_CODE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const SHORT_CODE_LENGTH = 4;
const shortCode = (): string =>
	Array.from({ length: SHORT_CODE_LENGTH }, () => SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)]).join("");

const minutes = (ms: number): string => {
	const m = Math.round(ms / 60_000);
	return `${m} minute${m === 1 ? "" : "s"}`;
};

/**
 * Start the workbench for an attached session. Order: the terminal is verified first, then the frontend and the dedicated cockpit key
 * (host), then the broker, then the listener; a failure before the last leaves nothing listening.
 */
export async function startWorkbenchV0(
	session: PiSessionAttachmentV0,
	desk: PiInterventionDeskV0,
	/** The working directory Pi was launched in: the one place the project context reads (read-only Git), never a value from the page. */
	options: {
		cwd: string /** A registered project (`endo project add`) the operator named for this launch. */;
		projectId?: string;
		/**
		 * The mode the operator asked for on this command line (DEVELOP-UX-002 §4.1). Absent: Strict, as before. Everyday and Protected
		 * take effect only while `protection` observes an enforced boundary around the agent; otherwise Strict is what runs, and the
		 * terminal says why.
		 */
		mode?: EndoWorkbenchModeV0;
		/** What observes the agent's execution boundary on this host. Absent: nothing is enforced. */
		protection?: EndoExecutionProtectionV0;
		isolated?: true;
		/**
		 * `short`: a question may also be answered with the four-character code shown for it (DEVELOP-UX-002 §6). Authority stays on this
		 * terminal; the code is never sent to a page. Absent or `phrase`: only the phrase, as before. An attempt always needs its phrase.
		 */
		confirm?: "phrase" | "short";
	},
): Promise<WorkbenchHandleV0> {
	requireWorkbenchTerminalV0();
	const uiDirectory = endoStudioUiDirectoryV0();
	if (uiDirectory === null)
		throw new Error(
			"the workbench frontend's files were not found next to this command (reinstall the package, or in a checkout run `npm run build:studio-ui`)",
		);
	const input = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	const write = (text: string): void => {
		process.stderr.write(text);
	};
	let aliasOf: (id: string) => string = (id) => id;
	// ONE question at a time. The broker already serialises its approvals (a STOP waits for the request it superseded to settle), and this
	// is the second, independent guard at the terminal itself: a question starts only after the previous one has settled, whatever
	// called it. A question that is cancelled also discards the line the operator was typing, so half an approval typed for it cannot
	// complete into the next question's answer. The next question is compared to its own exact phrase, which carries its operation and
	// digest, so even a complete stale phrase could only ever decline it.
	let questioning: Promise<unknown> = Promise.resolve();
	const approver: WorkbenchApproverV0 = (request, signal) => {
		const asked = questioning.then(() => ask(request, signal));
		questioning = asked.catch(() => {});
		return asked;
	};
	const ask = async (
		request: Parameters<WorkbenchApproverV0>[0],
		signal: AbortSignal,
	): Promise<"allow" | "allow-code" | "deny" | null> => {
		const what = request.operation;
		if (signal.aborted) return null;
		// A code for THIS question only: made here, written only to this terminal, compared only with what is typed here, and gone when the
		// question is. A page never sees it, so it cannot choose a request whose code matches a line the operator is already typing.
		const code = options.confirm === "short" && what !== "attempt" ? shortCode() : null;
		// A message that is this terminal's own command reaches Pi as chat, not as the command (REVIEW-PILOT-001, run 1): said before the
		// phrase, so the one word that differs (PROMPT, not ATTEMPT) is not the only sign.
		const asCommand =
			what === "attempt" || what === "stop" || request.message === null
				? null
				: endoWorkbenchTerminalCommandInV0(request.message);
		write(
			[
				"",
				`=== WORKBENCH: approve this ${what}? ===`,
				`session     ${request.session}`,
				`attachment  ${request.attachment}`,
				...(request.requestedFrom === undefined
					? []
					: [
							request.requestedFrom === "page"
								? "requested   from the paired page (it can only ask: nothing is sent unless you type the phrase here)"
								: "requested   on this terminal",
						]),
				request.message === null
					? `expires ${hhmmss(request.expiresAtMs)}`
					: `size        ${request.bytes} bytes   expires ${hhmmss(request.expiresAtMs)}`,
				...(request.attempt === undefined
					? []
					: [
							`attempt     ${request.attempt.attemptId}`,
							`task        ${request.attempt.taskId} (revision ${request.attempt.taskRevision}; the brief was prepared on revision ${request.attempt.preparedOnRevision}, and its words are unchanged)`,
						]),
				...(request.supersedes === undefined || request.supersedes === null
					? []
					: [
							`This stop replaced a ${request.supersedes} that was still waiting for approval. That ${request.supersedes} was cancelled; it was not sent.`,
						]),
				...(request.message === null
					? []
					: what === "attempt"
						? ["--- the exact brief, sent as the prompt ---", request.message, "--- end of brief ---"]
						: [`--- the exact ${what} ---`, request.message, `--- end of ${what} ---`]),
				...(asCommand === null
					? []
					: [
							`NOTE: this ${what} is the text of this terminal's \`${asCommand.command}\` command. Approving sends it to Pi as a chat message. ${
								asCommand.command === "attempt"
									? "It does NOT send any attempt's brief, and records no authorisation for one. To send the attempt, decline this, then type the command at the `>` prompt here."
									: asCommand.command === "revoke"
										? "It does NOT revoke session control. To revoke it, type `revoke` at the `>` prompt here (that also declines this)."
										: asCommand.command === "control"
											? "It does NOT grant session control. To grant it, decline this, then type `control` at the `>` prompt here."
											: "It does NOT pair the page. To pair, decline this, then type `pair` at the `>` prompt here."
							}`,
						]),
				EFFECT_WORDS[what],
				`Type ${code === null ? request.phrase : `${code} (or the whole phrase ${request.phrase})`} to ${request.message === null ? "send it" : what === "attempt" ? "send exactly this brief" : `send exactly this ${what}`}; anything else declines.`,
				"",
			].join("\n"),
		);
		try {
			const answer = await input.question("> ", {
				signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.expiresAtMs - Date.now()))]),
			});
			// `revoke` typed while a question is open is read by the question, not by the line handler below. It still means what it
			// says: session control ends now, and this request is declined like any answer that is not its phrase.
			if (answer.trim() === "revoke" && !broker.revokeSessionControl())
				write("workbench: no session control was in effect. That request was declined.\n");
			const decided = answer === request.phrase ? "allow" : code !== null && answer === code ? "allow-code" : "deny";
			// An attempt the PAGE asked for: the operator typed here, so its outcome is told here too, as for `attempt <id>` typed here.
			if (request.operation === "attempt" && request.requestedFrom === "page" && request.attempt !== undefined) {
				const attemptId = request.attempt.attemptId;
				queueMicrotask(() => reportAttempt(attemptId, request.proposalId));
			}
			return decided;
		} catch {
			// Cancelled or out of time: the question is gone; so is any half-typed answer to it.
			input.write(null, { ctrl: true, name: "u" });
			if (signal.aborted)
				write(
					signal.reason === "superseded-by-stop"
						? "\nworkbench: that request was cancelled, unapproved, because a stop was requested. It was not sent.\n"
						: "\nworkbench: that request was withdrawn.\n",
				);
			return null;
		}
	};
	const projectId = options.projectId;
	const mode = options.mode ?? "strict";
	// The canonical directory: the one a grant's scope names, and the one a boundary would have to confine the agent to.
	let workspaceRoot = options.cwd;
	try {
		workspaceRoot = realpathSync(options.cwd);
	} catch {
		// an unreadable directory is no workspace: nothing can be enforced around it, and the protection will not name it
	}
	const broker = new WorkbenchBrokerV0({
		control: {
			mode,
			workspaceRoot,
			...(options.protection === undefined ? {} : { protection: options.protection }),
		},
		onSessionControl: (event) => {
			if (event.type === "granted")
				write(
					`\nworkbench: SESSION CONTROL is now held by the page that typed that code, until ${hhmmss(event.grant.expiresAtMs)} or ${event.grant.maxSends} sends: ${event.grant.operations.join(", ")} are sent without asking here. Type \`revoke\` to end it now.\n`,
				);
			// A session that is closing says so itself; a notice inviting a new grant would be noise.
			else if (event.reason !== "closing")
				write(
					`\nworkbench: session control ENDED (${SESSION_CONTROL_END_WORDS[event.reason]}) after ${event.sends} send${event.sends === 1 ? "" : "s"}. Every request is approved here again. Type \`control\` for a new grant.\n`,
				);
		},
		session,
		key: session.owner.digestKey(),
		attachment: session.owner.attachment,
		approver,
		interventions: desk,
		...(options.isolated === true ? {} : { project: new GitProjectInspectorV0({ cwd: options.cwd }) }),
		...(projectId === undefined || options.isolated === true
			? {}
			: {
					tasks: {
						// The operator's configuration for this launch; the broker adds the host's own facts when it opens the scope.
						open: (host) =>
							endoDevelopServiceV0(session.owner.options.root).forLaunch(
								{ projectId, launchDirectory: options.cwd },
								host,
							),
					},
				}),
		...(projectId === undefined || options.isolated === true
			? {}
			: {
					// Sending an attempt's brief: requested by the `attempt <id>` line below or by the paired page; approved only on this terminal.
					attempts: new DevelopAttemptDispatchV0(
						new DevelopTasksStoreV0(session.owner.options.root),
						new DevelopAttemptsStoreV0(session.owner.options.root),
						{ projectId, launchDirectory: options.cwd },
					),
					// What Git shows of this launch's directory just before an attempt is sent and when its run ends. Never a gate on the send.
					provenance: (() => {
						const observations = endoDevelopObservationsV0(session.owner.options.root, { timeoutMs: 15_000 });
						return {
							take: () => observations.take(options.cwd, { within: true }),
							record: (attemptId, input) => observations.record(attemptId, input),
						};
					})(),
				}),
		aliasOf: (id) => aliasOf(id),
	});
	let launched: Awaited<ReturnType<typeof launchEndoCockpitV0>>;
	try {
		launched = await launchEndoCockpitV0({
			root: session.owner.options.root,
			uiDirectory,
			workbench: broker,
			// The workbench is where the operator works: its page opens on DEVELOP, as the workspace host's does (DEVELOP-UX-001, F3). Said
			// in the page itself; it changes no route, grant or approval, and Observe and Compare are one click away as before.
			start: "develop",
			onKey: (key) => {
				if (key.created) write(`workbench: created the cockpit's own digest key ${key.path}\n`);
			},
			onError: () => write("workbench: an internal error occurred (the request was refused)\n"),
		});
	} catch (error) {
		input.close();
		await broker.dispose();
		throw error;
	}
	const cockpitAliases = cockpitAliasesV0(loadOrCreateEndoDigestKeyV0(launched.key.path));
	aliasOf = (id) => cockpitAliases.id(id);
	/**
	 * A new pairing code. With `control`, it also carries session control, and WHAT IS BEING GRANTED is said here, before the operator
	 * types the code anywhere: the operations, the workspace, the limits, and how to end it. Where control cannot be granted, the code is
	 * a plain one and the reason is said instead.
	 */
	const showCode = (control = false): void => {
		const issued = broker.issuePairingCode({ control });
		if (issued.control !== null)
			write(
				[
					`workbench: pairing code ${issued.code}  (one use; expires ${hhmmss(issued.expiresAtMs)}). THIS CODE ALSO GRANTS SESSION CONTROL.`,
					`  The page that types it may send ${issued.control.operations.join(", ")} to this session WITHOUT asking here,`,
					`  for ${minutes(issued.control.lifetimeMs)} or ${issued.control.maxSends} sends, whichever comes first, in ${issued.control.workspaceRoot}.`,
					"  It cannot be extended, widened or renewed from a page; a reload or a new pairing ends it. Attempts are still approved here.",
					"  Type `revoke` here to end it at once, or `pair` instead for a code that only lets a page read and ask.",
					"",
				].join("\n"),
			);
		else
			write(
				`workbench: pairing code ${issued.code}  (one use; expires ${hhmmss(issued.expiresAtMs)}). Type it into the page to let it ask for prompts and interventions.${issued.refused === null ? "" : ` It carries NO session control: ${issued.refused}`}\n`,
			);
	};
	// The terminal is in raw mode, so Ctrl+C reaches readline, not the process: hand it to the same shutdown path a signal takes.
	input.on("SIGINT", () => {
		process.kill(process.pid, "SIGINT");
	});
	// A runtime that exits or is lost ends the session now: its private transcript and the grant do not wait for the host to stop.
	void session.exited().then(
		() => broker.endSession(),
		() => broker.endSession(),
	);
	// `attempt <id>`: the operator asks, HERE, to send a prepared work attempt's brief to this Pi session. It is only a request: the brief is
	// shown whole and nothing is sent unless its own phrase is typed. The paired page can make the same request (attempt/propose); it is approved here too.
	const requestAttempt = (attemptId: string): void => {
		const asked = broker.requestAttempt(attemptId);
		if (!asked.ok) {
			const why =
				asked.reason ??
				(asked.code in DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0
					? DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0[
							asked.code as keyof typeof DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0
						]
					: asked.code);
			write(
				`workbench: attempt not requested (${asked.code}): ${why}. Nothing was recorded for the attempt or sent.\n`,
			);
			return;
		}
		reportAttempt(attemptId, asked.view.proposalId);
	};
	/** Tell the terminal how an attempt request ended: sent and Pi's reply, or why not and whether the attempt is spent. */
	function reportAttempt(attemptId: string, id: string): void {
		void broker.settled(id).then((view) => {
			if (view === null) return;
			const binding = broker.attemptBindingOf(id);
			const refusal = binding?.refusal ?? null;
			if (view.state === "refused")
				write(
					`workbench: attempt ${attemptId} was not sent (${view.reason}${refusal === null ? "" : `: ${DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0[refusal]}`}). ${binding?.bound === true ? "Its authorisation was recorded, so it will not be sent again; prepare a new attempt to try again." : "This request recorded no authorisation for the attempt."}\n`,
				);
			else if (view.state === "accepted")
				write(
					`workbench: attempt ${attemptId} was sent and Pi accepted it (${view.disposition}). That is not completion; \`endo attempt show --attempt ${attemptId}\` shows what the session recorded.\n`,
				);
			else if (view.state === "unknown")
				write(
					`workbench: attempt ${attemptId} was sent; Pi's reply was not seen. Work may have started. It will not be retried.\n`,
				);
		});
	}
	input.on("line", (line) => {
		const words = line.trim().split(/\s+/);
		if (line.trim() === "pair") showCode();
		// A new terminal authorisation for session control: a new code, with what it grants said above it. Never a renewal of an old grant.
		else if (line.trim() === "control") showCode(true);
		else if (line.trim() === "revoke")
			write(
				broker.revokeSessionControl()
					? "" // the broker's own notice says it ended, and why
					: "workbench: no session control was in effect. Any code waiting to be typed now carries none.\n",
			);
		else if (words[0] === "attempt" && words.length === 2) requestAttempt(words[1] as string);
		else if (words[0] === "attempt")
			write(
				"workbench: `attempt` takes one attempt id, typed here: `attempt endo.attempt.<32 hex digits>`. `endo attempt list --project <id>` lists a project's attempts; the page's Task view can also ask for one.\n",
			);
		else if (line.trim() !== "")
			write(
				"workbench: type `pair` for a new pairing code, `control` for one that also grants session control, `revoke` to end session control, or `attempt <id>` to ask to send a prepared attempt's brief; approvals are typed when a request is waiting\n",
			);
	});
	write(
		"workbench: the address below is private to this launch; anyone who can read it can read what this store records. It lets a page READ and ask; only you, here, can approve a prompt or an intervention.\n",
	);
	write(`workbench: ${launched.server.baseUrl}/\n`);
	// The mode, said before the first code: what was asked for, what is in effect, and exactly what prevents the difference.
	const control = broker.sessionControl();
	if (mode !== "strict") {
		if (control.mode.effective === mode)
			write(
				`workbench: mode ${mode.toUpperCase()}. The agent's execution boundary is observed as enforced (${control.protection.mechanism}, level ${control.protection.level}).\n`,
			);
		else
			write(
				[
					`workbench: mode ${mode.toUpperCase()} was requested and is NOT in effect. STRICT is: every prompt, steer, queue and stop is approved here${options.confirm === "short" ? " (by its code or its phrase)" : ", by its phrase"}.`,
					...(control.protection.limitations.length === 0
						? [`  why: ${control.mode.reason ?? "no execution boundary is enforced for the agent"}`]
						: control.protection.limitations.map((line, index) => `  ${index === 0 ? "why:" : "also:"} ${line}`)),
					"",
				].join("\n"),
			);
	}
	if (options.confirm === "short")
		write(
			"workbench: --confirm short: a request may be approved by the four-character code shown for it, here. It is recorded as a code, not as the phrase.\n",
		);
	showCode(control.mode.effective !== "strict");
	// Say what the page will be told about the project, in plain words, before the operator looks at it.
	const workspace = broker.workspaceView();
	if (workspace !== null)
		write(
			workspace.state === "ready" && workspace.project !== null
				? workspace.project.launch === "same"
					? `workbench: project "${workspace.project.name}" (${workspace.project.id}): this directory is the registered one; tasks can be changed from the page.\n`
					: `workbench: project "${workspace.project.name}" (${workspace.project.id}): this directory is NOT the registered one (${workspace.project.path}); its tasks are shown read-only and nothing is changed.\n`
				: workspace.state === "unknown-project"
					? "workbench: --project names no project in this store (endo project list); the page will show no tasks.\n"
					: `workbench: the task file cannot be used (${workspace.reason ?? "unreadable"}); it was not changed and the page will show no tasks.\n`,
		);
	// No project was named. If this very directory is one the operator registered, say how to see its tasks; nothing is selected for them
	// (a project is named, never inferred), and a store with no task file, or one that cannot be read, says nothing.
	else {
		try {
			const here = realpathSync(options.cwd);
			const file = endoDevelopServiceV0(session.owner.options.root).read();
			const registered = file.ok
				? file.value.projects.filter((p) => {
						try {
							return realpathSync(p.path) === here;
						} catch {
							return false;
						}
					})
				: [];
			if (registered.length === 1)
				write(
					`workbench: no project was named, so the page shows no tasks. The task file registers this directory as "${registered[0]?.name}" (${registered[0]?.id}). Check it with \`endo project list\`, then start with --project <id> when you want its tasks.\n`,
				);
		} catch {
			// The hint is a convenience; its absence changes nothing.
		}
	}
	return {
		address: `${launched.server.baseUrl}/`,
		broker,
		stop: async () => {
			await broker.dispose();
			input.close();
			await launched.server.close();
		},
	};
}
