/**
 * `endo workspace open`: the DEVELOP workspace of one registered project, in a browser, with no agent running (docs/designs/workspace-host.md).
 * A thin command, in the shape of `endo studio`: it validates its arguments, reads the task file once to find the project, and hands the
 * shared host (cockpit-http/host.ts) the unchanged cockpit server, the page, and ONE handler for `api/v0/workbench/*`: the workspace host
 * (cockpit-http/workspace-host.ts), which has no harness, no session and no command surface.
 *
 *   endo workspace open [<root> | --root dir] --project <id> [--port n] [--key-file path]
 *
 * Order: (1) arguments, refused before anything exists (exit 2); (2) the task file is read and the project found, or exit 1 naming the
 * registered ids; (3) the page's files and the cockpit key (cockpit-http/host.ts); (4) the server, bound to 127.0.0.1; (5) the stop
 * handlers; (6) the project line and the pairing code on stderr, the address last on stdout. Lines typed on stdin: `pair` (a new code) and
 * `revoke` (end the grant). SIGINT or SIGTERM revokes the grant, closes the server, and the command returns (exit 0).
 *
 * It imports nothing that can start, attach to or command a harness: no Pi adapter beyond the recorded-evidence projections the read-only
 * Studio already reads, no RPC connection, no broker (tests/endo-workspace-host.test.ts checks the import closure).
 */

import { createInterface } from "node:readline";
import { endoWorkspaceHelpV0 } from "./help.ts";
import { takeEndoRootV0 } from "./root-args.ts";
import { endoStudioUiDirectoryV0 } from "./studio.ts";

export const ENDO_WORKSPACE_USAGE_V0 =
	"usage: endo workspace open [<root> | --root dir] --project <id> [--port n] [--key-file path]";

export interface EndoWorkspaceArgsV0 {
	readonly root: string;
	readonly defaultNote: string | null;
	readonly projectId: string;
	readonly port: number;
	readonly keyFile: string | null;
}

const PORT = /^(0|[1-9][0-9]{0,4})$/;

/** Parse `endo workspace open`'s arguments (after `open`), or "help". Pure. A problem is a `TypeError` naming it. */
export function parseEndoWorkspaceArgsV0(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): EndoWorkspaceArgsV0 | "help" {
	if (argv.some((arg) => arg === "--help" || arg === "-h")) return "help";
	const leading = argv[0];
	if (leading?.startsWith("-") && !leading.startsWith("--")) throw new TypeError(`unknown option: ${leading}`);
	const taken = takeEndoRootV0(argv, 0, new Set(["--project", "--port", "--key-file"]), env);
	const seen = new Map<string, string>();
	for (let index = 0; index < taken.rest.length; index += 1) {
		const arg = taken.rest[index]!;
		if (arg === "--project" || arg === "--port" || arg === "--key-file") {
			if (seen.has(arg)) throw new TypeError(`${arg} was given more than once`);
			const value = taken.rest[index + 1];
			if (value === undefined || value.startsWith("--")) throw new TypeError(`the flag ${arg} needs a value`);
			if (value.length === 0) throw new TypeError(`the flag ${arg} is empty`);
			seen.set(arg, value);
			index += 1;
		} else if (arg.startsWith("-")) throw new TypeError(`unknown option: ${arg}`);
		else throw new TypeError(`unexpected argument: ${arg} (a store is named first, or with --root)`);
	}
	const projectId = seen.get("--project");
	if (projectId === undefined)
		throw new TypeError("--project <id> is required (endo project list shows the registered ids)");
	const port = seen.get("--port") ?? "0";
	if (!PORT.test(port) || Number(port) > 65535)
		throw new TypeError("--port must be a whole number from 0 to 65535, written without leading zeros");
	return {
		root: taken.root,
		defaultNote: taken.defaultNote,
		projectId,
		port: Number(port),
		keyFile: seen.get("--key-file") ?? null,
	};
}

/** Fixed sentences or this program's own validation messages: never the address. */
function startupFailure(error: unknown, port: number): string {
	if (error instanceof TypeError) return `workspace: ${error.message}`;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "EADDRINUSE") return `workspace: port ${port} is already in use`;
	if (code === "EACCES") return `workspace: not permitted to listen on port ${port}`;
	return "workspace: the workspace could not start";
}

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

async function openCommand(argv: readonly string[]): Promise<void> {
	let args: EndoWorkspaceArgsV0 | "help";
	try {
		args = parseEndoWorkspaceArgsV0(argv);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		process.stderr.write(`${error.message}\n${ENDO_WORKSPACE_USAGE_V0}\n`);
		process.exitCode = 2;
		return;
	}
	if (args === "help") {
		process.stdout.write(endoWorkspaceHelpV0());
		return;
	}
	if (args.defaultNote !== null) process.stderr.write(`${args.defaultNote}\n`);
	const { projectId, root } = args;
	// The project, from the task file, once: its registered directory is the launch directory. Nothing the page sends can change it.
	const { endoDevelopServiceV0 } = await import("./develop-service.ts");
	const service = endoDevelopServiceV0(root);
	const file = service.read();
	if (!file.ok)
		throw new Error(
			`workspace: the task file cannot be used (${file.reason ?? "unreadable"}); it was not changed. endo task upgrade shows its version`,
		);
	const project = file.value.projects.find((p) => p.id === projectId);
	if (project === undefined) {
		const ids = file.value.projects.map((p) => p.id);
		throw new Error(
			`workspace: --project ${projectId} names no project in this store. ${ids.length === 0 ? "No project is registered: endo project add --name <name> --path <directory>" : `Registered: ${ids.join(", ")}`}`,
		);
	}
	const uiDirectory = endoStudioUiDirectoryV0();
	if (uiDirectory === null)
		throw new Error(
			"workspace: the page's files were not found next to this command. An installed package carries them in dist/studio-ui (reinstall it); in a checkout run `npm run build:studio-ui` first",
		);
	const [
		{ launchEndoCockpitV0, serveUntilSignalV0 },
		{ EndoWorkspaceHostV0 },
		{ GitProjectInspectorV0 },
		{ cockpitAliasesV0 },
		{ loadOrCreateEndoDigestKeyV0 },
	] = await Promise.all([
		import("../cockpit-http/host.ts"),
		import("../cockpit-http/workspace-host.ts"),
		import("../adapters/git/project-inspector.ts"),
		import("../cockpit/index.ts"),
		import("../storage/digest-key.ts"),
	]);
	let aliasOf: (id: string) => string = (id) => id;
	const host = new EndoWorkspaceHostV0({
		open: (facts) => service.forLaunch({ projectId, launchDirectory: project.path }, facts),
		project: new GitProjectInspectorV0({ cwd: project.path }),
		aliasOf: (id) => aliasOf(id),
	});
	let launched: Awaited<ReturnType<typeof launchEndoCockpitV0>>;
	try {
		launched = await launchEndoCockpitV0({
			root,
			port: args.port,
			...(args.keyFile === null ? {} : { keyFile: args.keyFile }),
			uiDirectory,
			workbench: host,
			start: "develop",
			onKey: (key) => {
				if (key.created) process.stderr.write(`workspace: created the cockpit's own digest key ${key.path}\n`);
			},
			onError: () => process.stderr.write("workspace: an internal error occurred (the request was refused)\n"),
		});
	} catch (error) {
		host.close();
		throw new Error(startupFailure(error, args.port));
	}
	const aliases = cockpitAliasesV0(loadOrCreateEndoDigestKeyV0(launched.key.path));
	aliasOf = (id) => aliases.id(id);
	const { server } = launched;
	// The operator's terminal: the only place a code is issued or a grant revoked. Not raw mode: Ctrl-C stays the process's own signal.
	const input = createInterface({ input: process.stdin, terminal: false });
	let closing = false;
	// Stop handling first: the address is never visible while Ctrl-C cannot stop the host cleanly.
	const stopped = serveUntilSignalV0({
		close: async () => {
			closing = true;
			host.close();
			input.close();
			await server.close();
		},
	});
	const write = (text: string): void => void process.stderr.write(text);
	const showCode = (): void => {
		const { code, expiresAtMs } = host.issuePairingCode();
		write(
			`workspace: pairing code ${code}  (one use; expires ${hhmmss(expiresAtMs)}). Type it into the page. Type \`pair\` here for a new one, \`revoke\` to end the page's grant.\n`,
		);
	};
	// End of input (Ctrl-D, or a closed pipe): `pair` and `revoke` can no longer be typed, so say so; the host keeps serving until stopped.
	input.on("close", () => {
		if (!closing)
			write(
				"workspace: no more input from this terminal: `pair` and `revoke` are no longer available here. Ctrl-C stops the workspace\n",
			);
	});
	input.on("line", (line) => {
		const said = line.trim();
		if (said === "pair") showCode();
		else if (said === "revoke") {
			host.revoke();
			write(
				"workspace: the page's grant was revoked; it can no longer read tasks or change anything. Type `pair` to pair again.\n",
			);
		} else if (said !== "")
			write("workspace: type `pair` for a new pairing code, or `revoke` to end the page's grant\n");
	});
	const view = host.workspaceView();
	write(
		view.state === "ready" && view.project !== null
			? view.writable
				? `workspace: project "${view.project.name}" (${view.project.id}) at ${view.project.path}: ${view.tasks.length} task(s). No agent is attached and none is started; a paired page can change tasks, not run anything.\n`
				: `workspace: project "${view.project.name}" (${view.project.id}): its registered directory ${view.project.path} is missing, so its tasks are shown read-only.\n`
			: `workspace: the project cannot be shown now (${view.reason ?? view.state}); the page will say so.\n`,
	);
	write(
		"workspace: the address below is private to this launch; anyone who can read it can read what this store records. Ctrl-C stops the workspace\n",
	);
	showCode();
	process.stdout.write(`Endophasia workspace (tasks writable after pairing, no agent): ${server.baseUrl}/\n`);
	await stopped;
	write("workspace: stopped\n");
	// As `endo studio`: exit at the moment the loop drains, so a late Ctrl-C cannot kill the process by its default action.
	process.once("beforeExit", () => process.exit(0));
}

export const WORKSPACE_COMMANDS_V0: Record<string, (argv: readonly string[]) => Promise<void>> = {
	open: openCommand,
};
