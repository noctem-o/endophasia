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
import { fstatSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import type { PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import type { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import { type WorkbenchApproverV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { cockpitAliasesV0 } from "../cockpit/index.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import {
	DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0,
	DevelopAttemptDispatchV0,
} from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { endoDevelopServiceV0 } from "./develop-service.ts";
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

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

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
	): Promise<"allow" | "deny" | null> => {
		const what = request.operation;
		if (signal.aborted) return null;
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
				EFFECT_WORDS[what],
				`Type ${request.phrase} to ${request.message === null ? "send it" : what === "attempt" ? "send exactly this brief" : `send exactly this ${what}`}; anything else declines.`,
				"",
			].join("\n"),
		);
		try {
			const answer = await input.question("> ", {
				signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.expiresAtMs - Date.now()))]),
			});
			const decided = answer === request.phrase ? "allow" : "deny";
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
	const broker = new WorkbenchBrokerV0({
		session,
		key: session.owner.digestKey(),
		attachment: session.owner.attachment,
		approver,
		interventions: desk,
		project: new GitProjectInspectorV0({ cwd: options.cwd }),
		...(projectId === undefined
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
		...(projectId === undefined
			? {}
			: {
					// Sending an attempt's brief: requested by the `attempt <id>` line below or by the paired page; approved only on this terminal.
					attempts: new DevelopAttemptDispatchV0(
						new DevelopTasksStoreV0(session.owner.options.root),
						new DevelopAttemptsStoreV0(session.owner.options.root),
						{ projectId, launchDirectory: options.cwd },
					),
				}),
		aliasOf: (id) => aliasOf(id),
	});
	let launched: Awaited<ReturnType<typeof launchEndoCockpitV0>>;
	try {
		launched = await launchEndoCockpitV0({
			root: session.owner.options.root,
			uiDirectory,
			workbench: broker,
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
	const showCode = (): void => {
		const { code, expiresAtMs } = broker.issuePairingCode();
		write(
			`workbench: pairing code ${code}  (one use; expires ${hhmmss(expiresAtMs)}). Type it into the page to let it ask for prompts and interventions.\n`,
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
		else if (words[0] === "attempt" && words.length === 2) requestAttempt(words[1] as string);
		else if (line.trim() !== "")
			write(
				"workbench: type `pair` for a new pairing code, or `attempt <id>` to ask to send a prepared attempt's brief; approvals are typed when a request is waiting\n",
			);
	});
	write(
		"workbench: the address below is private to this launch; anyone who can read it can read what this store records. It lets a page READ and ask; only you, here, can approve a prompt or an intervention.\n",
	);
	write(`workbench: ${launched.server.baseUrl}/\n`);
	showCode();
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
