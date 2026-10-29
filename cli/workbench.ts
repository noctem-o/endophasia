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
import type { PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { type WorkbenchApproverV0, WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { cockpitAliasesV0 } from "../cockpit/index.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
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

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

/**
 * Start the workbench for an attached session. Order: the terminal is verified first, then the frontend and the dedicated cockpit key
 * (host), then the broker, then the listener; a failure before the last leaves nothing listening.
 */
export async function startWorkbenchV0(session: PiSessionAttachmentV0): Promise<WorkbenchHandleV0> {
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
	const approver: WorkbenchApproverV0 = async (request, signal) => {
		write(
			[
				"",
				"=== WORKBENCH: approve this prompt? ===",
				`session     ${request.session}`,
				`attachment  ${request.attachment}`,
				`size        ${request.bytes} bytes   expires ${hhmmss(request.expiresAtMs)}`,
				"--- the exact prompt ---",
				request.message,
				"--- end of prompt ---",
				"Approving starts agent work, which may use the model and cost money. The page cannot approve this; only you can.",
				`Type ${request.phrase} to send exactly this prompt; anything else declines.`,
				"",
			].join("\n"),
		);
		try {
			const answer = await input.question("> ", {
				signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, request.expiresAtMs - Date.now()))]),
			});
			return answer === request.phrase ? "allow" : "deny";
		} catch {
			return null;
		}
	};
	const broker = new WorkbenchBrokerV0({
		session,
		key: session.owner.digestKey(),
		attachment: session.owner.attachment,
		approver,
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
			`workbench: pairing code ${code}  (one use; expires ${hhmmss(expiresAtMs)}). Type it into the page to let it ask for prompts.\n`,
		);
	};
	input.on("line", (line) => {
		if (line.trim() === "pair") showCode();
		else if (line.trim() !== "")
			write("workbench: type `pair` for a new pairing code; approvals are typed when a prompt is waiting\n");
	});
	write(
		"workbench: the address below is private to this launch; anyone who can read it can read what this store records. It lets a page READ and ask; only you, here, can approve a prompt.\n",
	);
	write(`workbench: ${launched.server.baseUrl}/\n`);
	showCode();
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
