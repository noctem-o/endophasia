/**
 * `endo --help` and `endo --version`. Both are pure: they read the package manifest and print, creating no store, key
 * or configuration. The version is the package.json version, found by walking up from this module, so it is the same
 * file in a checkout (cli/) and in the built package (dist/cli/): it cannot drift from the manifest.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The version in the nearest enclosing package.json named "endophasia". */
export function endoVersionV0(from: string = dirname(fileURLToPath(import.meta.url))): string {
	for (let dir = from; ; dir = dirname(dir)) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (manifest.name === "endophasia" && typeof manifest.version === "string") return manifest.version;
		} catch {
			// no readable manifest here: keep walking
		}
		if (dirname(dir) === dir) throw new Error("cannot find the endophasia package.json to read the version from");
	}
}

export const ENDO_USAGE_LINE_V0 =
	"usage: endo <doctor|status|events|ingest|ledger|artifacts|harness|trajectory|digest-key|studio|proxy|replay|experiment|steer> ...";

export function endoHelpV0(): string {
	return `endo — Endophasia, an experimental research instrument (alpha; not a stable product).

Endophasia attaches to an existing agent harness and records what it observes. It does not replace the harness.
Pi is installed and managed separately: endo never installs, upgrades or patches it.

Usage: endo <command> [arguments]
       endo --help | --version

Read-only inspection (create no store, directory or key):
  doctor [--root dir] [--pi path] [--json]   first-run diagnosis: Node, Pi discovery, store/key locations, recorded evidence
  status <root>                      summarise a durable store
  events <root> [--limit n] [--after sequence]
  ledger <root>
  artifacts <root>
  harness status <root>              recorded runtime identity and capability state
  harness overview <root>            recorded sessions and their lifecycle
  trajectory show <store> <session>  project a recorded trajectory
  trajectory diff ...                compare recorded trajectories
  digest-key id                      show which comparison-domain key would be used

Interactive, read-only with respect to the store (long-running; stop it with Ctrl-C):
  studio [<root>] [--root dir] [--port n] [--key-file path]
                                     Endophasia Studio: a read-only browser interface on 127.0.0.1, behind a private address
                                     printed once. Writes nothing to the store; the first launch creates its own digest key.
                                     Prints a human line, not a JSON document. "endo studio --help" for details.

Commands that write to a store:
  ingest <root> <file>               append records from a file
  harness identify|check <root> ...  observe a Pi executable (local protocol checks; no model call)
  steer <propose|authorize|apply|status|close> <root> ...

Commands that run a prompted agent session or an experiment:
  harness attach <root> ...          start a Pi session
  harness study <root> ...           a live study: requires --authorize-live-study
  experiment <run|report> ...
  replay, proxy <record|replay> ...
  A prompted agent session can call the model provider Pi is configured with, and may incur cost. Live studies are
  explicit, authorised operations; nothing runs one implicitly.

Run a command family without arguments (for example "endo harness") to see its usage. Each command that succeeds
prints one canonical-JSON document on stdout (except "doctor", which prints a human report unless given --json); errors are one line on stderr with exit status 1. Exit status 2 means
the invocation itself was invalid (unknown or missing command; for "studio", also invalid arguments, which it refuses before
creating or starting anything, where other commands report their argument errors with status 1).

The store: every command that takes <root> also takes --root dir, or neither (the default store). Naming it both ways is an
error. Default store (reported by doctor): $ENDO_STORE_ROOT, else $XDG_DATA_HOME/endophasia/store, else
~/.local/share/endophasia/store. A command that uses the default says so on stderr.

The installed Pi loop (Pi installed separately; --pi path selects an executable, --cwd dir its working directory, which is
independent of the store):
  1. endo doctor                                  diagnose the installation
  2. endo harness check [--pi path]               fingerprint Pi and run the local checks (no model call)
  3. endo harness attach [--pi path] [--cwd dir] --prompt "..." [--provider p --model m]
                                                  record one session; the prompt may incur provider cost
  4. endo harness status | overview               recorded identity, capability evidence, session lifecycle
  5. endo trajectory show <pi-session-id>         project the recorded trajectory (attach prints the id and these commands)
Acceptance of a prompt is not completion: attach reports whether Pi accepted it and whether the run was seen to settle.

Requires Node >= 22.19.0.
`;
}

/** `endo studio --help`: pure, like `endo --help`. */
export function endoStudioHelpV0(): string {
	return `endo studio — Endophasia Studio: a read-only browser interface over a recorded store.

Usage: endo studio [<root>] [--root dir] [--port n] [--key-file path]
       endo studio --help | -h

Starts a server on 127.0.0.1 only and prints one private access address for this launch; open it in a browser on this machine.
Studio currently shows a single read-only observation page: runtime identity, capability state, the session timeline and the
state of each source, exactly as recorded. It does not yet implement the other modes Endophasia is meant to host. It writes
nothing to the store, attaches to no harness, runs no model, calls no provider, loads nothing from the network and does not poll:
it reads the store when the page opens and when you press Refresh.

Arguments:
  <root> | --root dir    the store to read; naming it both ways is an error. Default: the default store ($ENDO_STORE_ROOT, else
                         $XDG_DATA_HOME/endophasia/store, else ~/.local/share/endophasia/store), reported on stderr. A store
                         that does not exist is shown as absent and is never created.
  --port n               the loopback port, 0 to 65535, written without leading zeros. Default 0: the operating system picks
                         a free port, so the address differs on every launch.
  --key-file path        the comparison key Studio reads under. Default: cockpit-digest-key beside the installation digest key
                         (see "endo digest-key id"). It may not be the installation key, under any name, nor lie inside the store.

Side effects: Studio is read-only with respect to the observed store. The first launch creates its dedicated key file if it
does not exist (32 random bytes, mode 0600, in a 0700 directory) and says so on stderr; that is the only thing it writes. Help,
invalid arguments and a page that is missing files create nothing.

The access address printed on stdout is a secret for this launch: anyone who can read it can read what the store records, and it
stops working when Studio stops. It is printed once, never logged and never part of an error. Share it with no one.

Output: unlike the other commands, Studio prints one human line on stdout (the address) and its notes on stderr, not a
canonical-JSON document. It runs until interrupted: SIGINT (Ctrl-C) or SIGTERM closes the server, releases the port and exits.
Exit status: 0 stopped that way (or help); 1 Studio could not start (page files missing, key unusable, port in use); 2 the
invocation was invalid (nothing was created or started).
`;
}
