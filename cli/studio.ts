/**
 * `endo studio`: Endophasia Studio, a read-only browser interface over a recorded store. A thin command: it validates its arguments,
 * finds the page packaged beside it, and hands both to the shared host (cockpit-http/host.ts), which starts the unchanged cockpit
 * server on the loopback interface. It adds no route, header or policy and reads no store itself.
 *
 *   endo studio [<root>] [--root dir] [--port n] [--key-file path]     serve until interrupted
 *   endo studio --help | -h
 *
 * Order, and what each step may do: (1) the arguments are parsed and refused, if wrong, before anything exists (exit 2); (2) the
 * page's files are found and checked whole; (3) the dedicated cockpit key is loaded, or created on the first launch (the one write
 * Studio can cause; never the installation key, never the store); (4) the server starts; (5) the stop handlers are attached; (6) the
 * access address is printed, once, on stdout. A failure at 2 to 4 is exit 1 with a fixed sentence that never carries the address.
 * SIGINT or SIGTERM closes the server and the command returns, so the process ends by itself with exit 0.
 *
 * Studio's stdout is a human line, an explicit exception to the canonical-JSON documents the other commands print. The host module
 * (and with it HTTP and the cockpit library) is imported only after the arguments are valid, so `endo status` and the rest never load
 * them, and this module is itself imported only when the command is `studio` (cli/index.ts).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { endoStudioHelpV0 } from "./help.ts";
import { takeEndoRootV0 } from "./root-args.ts";

export const ENDO_STUDIO_USAGE_V0 = "usage: endo studio [<root>] [--root dir] [--port n] [--key-file path]";

export interface EndoStudioArgsV0 {
	readonly root: string;
	/** Set when the default store was chosen: the one line that says which and why, for stderr. */
	readonly defaultNote: string | null;
	readonly port: number;
	/** The key file named with `--key-file`, or null for the dedicated default. */
	readonly keyFile: string | null;
}

/** A port as written without leading zeros, 0 to 65535: the range the server accepts, enforced before a key is created. */
const PORT = /^(0|[1-9][0-9]{0,4})$/;

/**
 * Parse the arguments of `endo studio`, or return "help". Pure: reads no file, creates nothing. Any problem is a `TypeError` naming
 * it. `--help` (or `-h`) anywhere wins, since no value this command accepts begins with a dash.
 */
export function parseEndoStudioArgsV0(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): EndoStudioArgsV0 | "help" {
	if (argv.some((arg) => arg === "--help" || arg === "-h")) return "help";
	// Every option here is spelled with two dashes, so a leading argument with one is a mistyped option, not a store named "-x"
	// (which takes `./-x`): reading it as the root would start Studio, and create its key, on the wrong thing.
	const leading = argv[0];
	if (leading?.startsWith("-") && !leading.startsWith("--")) throw new TypeError(`unknown option: ${leading}`);
	const taken = takeEndoRootV0(argv, 0, new Set(["--port", "--key-file"]), env);
	let port: number | undefined;
	let keyFile: string | undefined;
	const value = (rest: readonly string[], index: number, flag: string): string => {
		const given = rest[index + 1];
		if (given === undefined || given.startsWith("--")) throw new TypeError(`the flag ${flag} needs a value`);
		return given;
	};
	for (let index = 0; index < taken.rest.length; index += 1) {
		const arg = taken.rest[index]!;
		if (arg === "--port") {
			if (port !== undefined) throw new TypeError("--port was given more than once");
			const given = value(taken.rest, index, "--port");
			if (!PORT.test(given) || Number(given) > 65535)
				throw new TypeError("--port must be a whole number from 0 to 65535, written without leading zeros");
			port = Number(given);
			index += 1;
		} else if (arg === "--key-file") {
			if (keyFile !== undefined) throw new TypeError("--key-file was given more than once");
			keyFile = value(taken.rest, index, "--key-file");
			if (keyFile.length === 0) throw new TypeError("the key file is empty");
			index += 1;
		} else if (arg.startsWith("-")) throw new TypeError(`unknown option: ${arg}`);
		else throw new TypeError(`unexpected argument: ${arg} (a store is named first, or with --root)`);
	}
	return { root: taken.root, defaultNote: taken.defaultNote, port: port ?? 0, keyFile: keyFile ?? null };
}

/**
 * The directory holding the page built for this command, found relative to this module and nowhere else (not the working directory,
 * not the environment): `dist/cockpit-ui/` beside `dist/cli/` in an installed package, `cockpit-ui/dist/` after
 * `npm run build:cockpit-ui` in a checkout. A directory counts only if it holds the built entry module, which the checkout's source
 * directory of the same name does not. Null when there is none.
 */
export function endoStudioUiDirectoryV0(moduleUrl: string = import.meta.url): string | null {
	for (const relative of ["../cockpit-ui/", "../cockpit-ui/dist/"]) {
		const directory = fileURLToPath(new URL(relative, moduleUrl));
		if (existsSync(join(directory, "main.js"))) return directory;
	}
	return null;
}

/** What to say when starting failed. Fixed sentences or this program's own validation messages: never the address, never raw. */
function startupFailure(error: unknown, port: number): string {
	if (error instanceof TypeError) return `studio: ${error.message}`;
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "EADDRINUSE") return `studio: port ${port} is already in use`;
	if (code === "EACCES") return `studio: not permitted to listen on port ${port}`;
	return "studio: Studio could not start";
}

export async function studioCommand(argv: readonly string[]): Promise<void> {
	let args: EndoStudioArgsV0 | "help";
	try {
		args = parseEndoStudioArgsV0(argv);
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		// An invalid invocation: refused before anything is created or started, and told apart from a failed start by status 2.
		process.stderr.write(`${error.message}\n${ENDO_STUDIO_USAGE_V0}\n`);
		process.exitCode = 2;
		return;
	}
	if (args === "help") {
		process.stdout.write(endoStudioHelpV0());
		return;
	}
	if (args.defaultNote !== null) process.stderr.write(`${args.defaultNote}\n`);
	const uiDirectory = endoStudioUiDirectoryV0();
	if (uiDirectory === null)
		throw new Error(
			"studio: the page's files were not found next to this command. An installed package carries them in dist/cockpit-ui (reinstall it); in a checkout run `npm run build:cockpit-ui` first",
		);
	const { launchEndoCockpitV0, serveUntilSignalV0 } = await import("../cockpit-http/host.ts");
	let launched: Awaited<ReturnType<typeof launchEndoCockpitV0>>;
	try {
		launched = await launchEndoCockpitV0({
			root: args.root,
			port: args.port,
			...(args.keyFile === null ? {} : { keyFile: args.keyFile }),
			uiDirectory,
			onKey: (key) => {
				if (key.created) process.stderr.write(`studio: created Studio's own digest key ${key.path}\n`);
			},
			onError: () => process.stderr.write("studio: an internal error occurred (the request was refused)\n"),
		});
	} catch (error) {
		throw new Error(startupFailure(error, args.port));
	}
	const { server } = launched;
	// Stop handling is attached before the address is shown, so the address is never visible while Ctrl-C cannot stop Studio cleanly.
	const stopped = serveUntilSignalV0(server);
	// The notes come first and the address last: it is the line to find and copy, and a reader that has seen it has seen the notes.
	process.stderr.write(
		"studio: the address below is private to this launch; anyone who can read it can read what this store records. Ctrl-C stops Studio\n",
	);
	process.stdout.write(`Endophasia Studio (read-only, loopback only): ${server.baseUrl}/\n`);
	await stopped;
	process.stderr.write("studio: stopped\n");
}
