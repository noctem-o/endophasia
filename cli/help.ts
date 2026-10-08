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
	"usage: endo <doctor|status|events|ingest|ledger|artifacts|harness|trajectory|digest-key|proxy|replay|experiment|steer> ...";

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
the invocation itself was invalid (unknown or missing command).

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
