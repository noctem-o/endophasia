// The host of the cockpit server: what a launcher needs besides the server itself, as callable functions with explicit inputs and no
// effect at import. Two entry points use it, both thin: the development launcher (cockpit-http/launch.ts) and the installed command
// `endo studio` (cli/studio.ts). It adds no route, header, policy or reader of its own: `startEndoCockpitServerV0` is the one place a
// request is answered, and this module only prepares what that function is given.
//
//   loadEndoCockpitUiFilesV0   read a built page from a directory and check it is complete, so a damaged install fails at start
//                              instead of serving a page that cannot load
//   (studio-ui.ts)             the same check for the bundled React frontend (scripts/build-studio-ui.mjs), chosen with `uiFormat`
//   launchEndoCockpitV0        the page, then the dedicated comparison key, then the server, in that order, so a missing asset or an
//                              unusable key is reported before anything listens
//   serveUntilSignalV0         close the server once when asked to stop, and let the process end by itself afterwards
//
// The key is a dedicated, persistent cockpit key (storage/digest-key.ts: created on first use, mode 0600, in a 0700 directory) beside
// the installation key, so a refresh never needs a new one and the installation key is not reused. The one write this module can
// cause is that first creation; the observed store is never written.

import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { endoDigestKeyPathV0, loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { type EndoCockpitServerV0, startEndoCockpitServerV0 } from "./server.ts";
import { loadEndoStudioUiFilesV0 } from "./studio-ui.ts";

/** The files of a page the server accepts (it also checks each name and size): HTML, modules, style and icon. */
const PAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|js|css|svg)$/;

/** A page reference the page's own files make: `./assets/<name>` in the HTML, `./<name>.js` between modules. */
const ASSET_REFERENCE = /(?:src|href)="\.\/assets\/([^"/?#]+)"/g;
const MODULE_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.\/([^"'/]+)["']/g;

/**
 * Read a built page from `directory` into memory (the server holds it there and reads no file itself) and check that it is whole:
 * `index.html` exists, every asset it names exists, and every module imports only modules that exist. A page that fails the check is
 * a `TypeError` naming the missing file; nothing is started from it.
 */
export function loadEndoCockpitUiFilesV0(directory: string): Record<string, string> {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		throw new TypeError(`the browser page was not found in ${directory}`);
	}
	const files: Record<string, string> = {};
	for (const name of names.sort()) {
		if (!PAGE_FILE.test(name)) continue;
		const path = join(directory, name);
		if (!statSync(path).isFile()) continue;
		files[name] = readFileSync(path, "utf8");
	}
	const index = files["index.html"];
	if (index === undefined)
		throw new TypeError(`the browser page is incomplete: index.html is missing from ${directory}`);
	const missing = (name: string, from: string): never => {
		throw new TypeError(`the browser page is incomplete: ${name} is missing (${from} needs it)`);
	};
	for (const [, name] of index.matchAll(ASSET_REFERENCE)) if (files[name!] === undefined) missing(name!, "index.html");
	for (const [file, text] of Object.entries(files))
		if (file.endsWith(".js"))
			for (const [, name] of text.matchAll(MODULE_REFERENCE)) if (files[name!] === undefined) missing(name!, file);
	return files;
}

/** The dedicated cockpit key file: beside the installation key, so it follows the same location rules. */
export function defaultEndoCockpitKeyFileV0(): string {
	return join(dirname(endoDigestKeyPathV0()), "cockpit-digest-key");
}

export interface EndoCockpitLaunchOptionsV0 {
	/** The store to read. Made absolute, so the server does not depend on the working directory. It is never created or written. */
	root: string;
	/** The loopback port; 0 lets the operating system pick one. */
	port?: number;
	/** The cockpit key file. Default: `defaultEndoCockpitKeyFileV0()`. It may not be the installation key. */
	keyFile?: string;
	/** The built page: a directory holding `index.html` and what it needs. The caller says where; this module never guesses. */
	uiDirectory: string;
	/**
	 * What `uiDirectory` holds: `page` (default), the existing page `endo studio` serves, or `studio`, the bundled React frontend,
	 * which must match its manifest exactly (`loadEndoStudioUiFilesV0`). Either way the same server answers with the same guards.
	 */
	uiFormat?: "page" | "studio";
	/** Called once the key is loaded (or created), before anything listens, so a launch that fails afterwards still reports the write. */
	onKey?: (key: { path: string; created: boolean }) => void;
	/** Called with an internal failure's error for the host's own diagnostics. The server never sends it to a client. */
	onError?: (error: unknown) => void;
}

export interface EndoCockpitLaunchedV0 {
	server: EndoCockpitServerV0;
	/** The key file in use, and whether this launch created it (the one write a launch can cause). */
	key: { path: string; created: boolean };
}

const SEPARATORS = sep === "\\" ? /[\\/]+/ : /\/+/;

/**
 * Where a path lies, as one canonical string, without needing the file to exist. It is `realpath` extended past what is not there:
 * the path is walked one component at a time, a symbolic link is followed where it stands (its target joins the components still to
 * come, so `..` after a link means the link's target's parent, not the path's), and from the first component that does not exist
 * the rest is appended as written. So `store-link -> absent-store` and `absent-store` are one place, and so is a path that reaches
 * a directory through a link and `..`. Null when that cannot be established (a link that loops, or a directory that cannot be
 * looked into): the callers refuse then rather than guess.
 */
function placeOf(path: string): string | null {
	const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
	// A backslash separates components only where the platform says so: on POSIX it is an ordinary character of a file name.
	const split = (text: string): string[] => text.split(SEPARATORS).filter((part) => part !== "");
	let resolved = parse(absolute).root;
	let queue = split(absolute.slice(resolved.length));
	let links = 0;
	while (queue.length > 0) {
		const part = queue.shift() as string;
		if (part === ".") continue;
		if (part === "..") {
			resolved = dirname(resolved);
			continue;
		}
		const next = join(resolved, part);
		let target: string | null = null;
		try {
			if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return null; // it may be there and not readable to us: not a place to guess
		}
		if (target === null) {
			resolved = next;
			continue;
		}
		links += 1;
		if (links > 255) return null;
		if (isAbsolute(target)) resolved = parse(target).root;
		queue = [...split(target.slice(isAbsolute(target) ? parse(target).root.length : 0)), ...queue];
	}
	return resolved;
}

/** The file system's own identity of an existing file (a hard link shares it), or null when there is none to compare. */
const identity = (path: string): string | null => {
	try {
		const { dev, ino } = statSync(path);
		return ino === 0 ? null : `${dev}:${ino}`;
	} catch {
		return null;
	}
};

/** Whether `path` is the directory `root` or lies anywhere beneath it. Both are canonical places (see `placeOf`). */
const isWithin = (root: string, path: string): boolean => {
	const from = relative(root, path);
	return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};

const installationKeyPath = (): string | null => {
	try {
		return endoDigestKeyPathV0();
	} catch {
		return null;
	}
};

const exists = (path: string): boolean => {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Start the cockpit server on the loopback interface. Order matters and is the contract: the page is read and checked first, the key
 * file is checked (it is neither the installation key, by place or by file identity, nor inside the store) and loaded or created
 * second, and only then does anything listen, so a failure before the last step leaves no listener (and a
 * failure of the last step, which the server guarantees leaves none either, leaves at most the key file).
 */
export async function launchEndoCockpitV0(options: EndoCockpitLaunchOptionsV0): Promise<EndoCockpitLaunchedV0> {
	const ui =
		options.uiFormat === "studio"
			? loadEndoStudioUiFilesV0(options.uiDirectory)
			: loadEndoCockpitUiFilesV0(options.uiDirectory);
	const keyFile = resolve(options.keyFile ?? defaultEndoCockpitKeyFileV0());
	// Where each lies. A place that cannot be established (a link that loops) is refused: the checks below are what keep Studio from
	// writing the store it reads or using the installation key, and they are not skipped for a path they cannot judge.
	const place = (path: string, what: string): string => {
		const found = placeOf(path);
		if (found === null)
			throw new TypeError(`cannot tell where ${what} lies: a symbolic link in its path loops or cannot be followed`);
		return found;
	};
	const keyPlace = place(keyFile, "the cockpit key file");
	// Where the installation key would be, if this environment says. Where it says nothing (no HOME, no XDG_DATA_HOME, no
	// ENDO_DIGEST_KEY_FILE: a container, a service) there is no installation key to confuse a key file given by name with.
	const installation = installationKeyPath();
	if (installation !== null) {
		const sameName = keyPlace === place(installation, "the installation key");
		const first = identity(keyFile);
		if (sameName || (first !== null && first === identity(installation)))
			throw new TypeError(
				"the cockpit key file is the installation key: Studio keeps a key of its own so the two comparison domains stay apart",
			);
	}
	// Creating the key would write into the store being read, and make a store that was absent: refuse it before anything is made.
	// The store path is made absolute once, here (a `..` in it collapsed as written, as the reader's own joins collapse it), and this
	// same string is what the server is given, so the check and the read are about one path. The server is NOT given the place that
	// links resolve to: it must see the path itself, so a dangling link is reported as unopenable, never as an absent store.
	const rootPath = resolve(options.root);
	if (isWithin(place(rootPath, "the store"), keyPlace))
		throw new TypeError(
			"the cockpit key file is inside the store Studio reads: Studio never writes the store, so keep the key elsewhere",
		);
	const created = !exists(keyFile);
	const digestKey = loadOrCreateEndoDigestKeyV0(keyFile);
	options.onKey?.({ path: keyFile, created });
	const server = await startEndoCockpitServerV0({
		root: rootPath,
		digestKey,
		ui,
		port: options.port ?? 0,
		...(options.onError === undefined ? {} : { onError: options.onError }),
	});
	return { server, key: { path: keyFile, created } };
}

/** What a signal source offers: Node's `process` in a launcher, a plain emitter in a test. */
export interface EndoSignalSourceV0 {
	on(signal: string, listener: () => void): unknown;
}

/**
 * Close the server when asked to stop, once. The listeners are attached when this is called (call it before showing the access
 * address, so the address is never visible while the process cannot stop cleanly). A signal that arrives while the close runs, or
 * after it, is absorbed: the server is never closed twice, and a second Ctrl-C does not kill the process by its default action in the
 * last instants of a shutdown that is already under way. The listeners stay attached for that reason, and cost nothing: a signal
 * handler does not keep Node's event loop alive. The promise settles after the server has released its port. This never calls
 * `process.exit`: with nothing else open the process ends by itself, which is how a leaked socket, timer or promise would show up.
 */
export function serveUntilSignalV0(
	server: Pick<EndoCockpitServerV0, "close">,
	signals: EndoSignalSourceV0 = process,
	names: readonly string[] = ["SIGINT", "SIGTERM"],
): Promise<void> {
	return new Promise<void>((resolveStopped, rejectStopped) => {
		let closing = false;
		const onSignal = (): void => {
			if (closing) return;
			closing = true;
			server.close().then(resolveStopped, rejectStopped);
		};
		for (const name of names) signals.on(name, onSignal);
	});
}
