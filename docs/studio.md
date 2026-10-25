# Endophasia Web (currently `endo studio`)

Status: **implemented in the source tree, read-only, one workspace.** This is the browser interface, proposed to be named **Endophasia Web**. The current UI and CLI still say Studio; it is the interface Endophasia will grow into: Compare, Capabilities and
Evolve workspaces (and DEVELOP, WORK, DREAM and a model-internal OBSERVE view) are intended to live here. Today it hosts one read-only
**Observe workspace**: an overview of the recorded window, the runtime a Pi attachment recorded, the capability state with its reasons
and limits, the session timeline in storage order with an evidence-first inspector, and the condition of each source, all as recorded and
none of it inferred. The other workspaces appear in the shell as "later", say what they would need and show nothing. It does not start,
steer or attach to anything.

`endo studio` remains the actual command; `endo web` is a proposed alias and does not work yet. A separate future Rust/GPUI native application would use the **Endophasia** product name. The implementation keeps its development names: the observation bridge is `cockpit/`, the
server `cockpit-http/`, the frontend `studio-ui/` (see [cockpit.md](cockpit.md), [cockpit-ui.md](cockpit-ui.md) and
[studio-ui-architecture.md](studio-ui-architecture.md)).

> **The frontend.** `endo studio` serves a React/TypeScript frontend, bundled at build time into the package (`dist/studio-ui/`) and
> checked against its manifest before anything starts. It replaced the earlier page (`dist/cockpit-ui/`), which `0.1.0-alpha.2` carries.

## Run it

Once a release includes Studio, nothing else is needed (no Git checkout, TypeScript, build step, network, model provider or
running agent). **`endophasia@0.1.0-alpha.1` is CLI-only.** Published `0.1.0-alpha.2` is the first version that includes
`endo studio`, with the **earlier browser page** in `dist/cockpit-ui/`. The **newer React frontend described below** is in
the source tree, not yet a published npm release. To try that version, build a tarball from a checkout
([install.md](install.md#build-and-test-a-tarball-from-a-checkout-contributors)) and install it; `endo` below is then the installed CLI:

```sh
endo studio                                   # the default store
endo studio --root ./recordings               # a store you name (or: endo studio ./recordings)
endo studio --port 8085                       # a fixed loopback port (default 0: the system picks a free one)
endo studio --root ./recordings --port 0
endo studio --help
```

It prints one line on stdout, the access address, and keeps running until you stop it with Ctrl-C (SIGINT) or SIGTERM:

```text
Endophasia Studio (read-only, loopback only): http://127.0.0.1:<port>/<capability>/
```

Open that address in a browser on the same machine. Nothing opens a browser for you.

From a **checkout** (development), the same server and frontend start with the following; `node dist/cli/index.js` is the same
command after `npm run build`:

```sh
npm run cockpit -- <store-root> [--key-file <path>] [--port <n>]     # builds the frontend, then starts it (a thin development entry)
npm run build:studio-ui && node cli/index.ts studio [<root>] ...     # the command itself, over the frontend just built
node scripts/seed-cockpit-demo.ts <empty-directory>                  # a demo store from the committed Pi recordings
```

## Arguments

| Argument | Meaning |
| :--- | :--- |
| `<root>` or `--root dir` | The store to read. Naming it both ways is an error, as for every command that takes a store. Default: `$ENDO_STORE_ROOT`, else `$XDG_DATA_HOME/endophasia/store`, else `~/.local/share/endophasia/store`; when the default is used, one line on stderr says which. A relative root is made absolute at launch with any `..` collapsed as written, as every `endo` command reads its root; that path is what the server reads (a link in it is the reader's to report: a dangling link is *unopenable*, not absent) and what Studio checks the key against, after following its links. |
| `--port n` | The loopback port, `0` to `65535`, written without leading zeros. `0` (the default) lets the operating system choose, so the address is different on every launch. |
| `--key-file path` | The comparison key Studio reads under. Default: `cockpit-digest-key` beside the installation digest key. The installation key (under any name) and a path inside the store are refused. |
| `--help`, `-h` | Print the help and exit 0. Wins over everything else on the line. |

Anything else is an invalid invocation: an unknown or repeated option, a second positional argument, a missing or empty value, a port
that is not canonical or is out of range, a root named twice, a leading single-dash word (`-x` is a mistyped option, not a store; name
such a store `./-x`). There is no `--host`, no `--open` and no remote option, on purpose. Invalid invocations and `--help` are decided
before anything is created or started.

## What it reads, and what it may write

- **The store is never written** and never created. A store that does not exist is shown on the page as *absent* (not as empty);
  neither the store nor its parent directory is created. The reader opens what the observation bridge opens and nothing else.
- **The one thing Studio can write is its own key.** On the first launch it creates `cockpit-digest-key` (32 random bytes, mode `0600`,
  in a `0700` directory) beside the installation key: `$ENDO_DIGEST_KEY_FILE`'s directory if that is set, else
  `$XDG_DATA_HOME/endophasia/`, else `~/.local/share/endophasia/`. It says so on stderr. Later launches reuse it byte for byte, so a
  refresh never needs a new key. It is a different file from the installation key, which Studio never reads, creates or changes, so
  the two comparison domains stay separate. `--key-file` is refused (exit 1, before anything is created) when it names the
  installation key under any name: the same path spelled through `..` or a linked directory, even when that key does not exist yet,
  or a second hard link to the file when it does. It is refused too when it lies inside the store being read, since creating it
  would write into the store (and create a store that was absent). Both are decided by the canonical place of the path (the real
  path of its deepest existing part, with a link whose target is not there yet followed by name) and, for an existing file, by the
  file system's identity of it, at launch. A path whose place cannot be established (a symbolic link that loops) is refused rather
  than guessed at. These are checks against a mistaken flag, not against a hostile file system: a link changed after launch is not
  re-checked, and on a case-insensitive file system two spellings of one place that differ in case are not told apart. Whoever can read the key can confirm guesses against the digests shown, as for any Endophasia key.
- If the port is taken, startup fails (exit 1) *after* the key was created; the key stays, and stderr said it was created.
  A missing page file, an invalid argument or `--help` creates nothing.

## The access address is a secret

The path segment after the port is a random 256-bit capability generated for this launch. The server answers nothing outside it, and
it stops working when Studio stops. Anyone who can read the address can read what the store records: do not paste it into a chat,
an issue or a log. Studio prints it **once**, on stdout, and nowhere else: not on stderr, not in an error, not in a stack trace. A
failure to start is a fixed sentence (or this program's own validation message), never the raw error.

Everything else about the server is the unchanged cockpit server ([cockpit.md](cockpit.md#the-local-http-server-implemented)): it
binds `127.0.0.1` only; it refuses a request whose `Host` is not exactly its own, whose `Origin` or `Sec-Fetch-Site` is foreign, whose
method is not `GET`, or whose path or query is not exactly one it serves; the page runs under a restrictive content security policy
with Trusted Types and loads nothing from anywhere else; there is no CORS, no cookie, no browser storage and no telemetry.

## Output and exit status

Unlike the other `endo` commands, Studio does not print a canonical-JSON document: it prints the address as a human line on
stdout and its notes on stderr. This is a deliberate exception for a long-running, human-facing command.

| Status | Meaning |
| :--- | :--- |
| `0` | Stopped by SIGINT or SIGTERM (the server closed and released its port; the process ended by itself), or `--help`. |
| `1` | Studio could not start: a frontend file missing from or altered in the installation, an unusable key, the port in use. No address was printed. |
| `2` | The invocation was invalid. Nothing was created or started. (Other `endo` commands report their own argument errors with status 1; Studio separates the two so a script can tell them apart.) |

Shutdown: the first SIGINT or SIGTERM closes the server once (open connections end, the listening socket is released) and the command
returns; further signals while it closes, or after, are absorbed. Studio never calls `process.exit` on this path, so a leaked socket,
timer or promise would keep the process alive and show up in the tests.

## What is in the package

`npm run build` compiles the command's import closure to `dist/` and bundles the frontend into a flat `dist/studio-ui/` with the same
builder the development launcher uses (`scripts/build-studio-ui.mjs`), after emptying `dist/`:

```text
dist/cli/index.js, studio.js, ...         the endo command; studio.js is loaded only for `endo studio`
dist/cockpit-http/host.js, server.js      the shared launcher and the server
dist/cockpit/**                           the observation bridge (a library)
dist/studio-ui/index.html, main-<hash>.js, main-<hash>.css, chunk-*.js, <lazy>.js, three .woff2 fonts, icon.svg,
               studio-ui.manifest.json    the frontend: bundled React, content-hashed, no source maps, and the manifest of every file's size and sha256
dist/licenses/studio-ui-third-party.txt   the licence notices of the bundled React and the two typefaces (outside the directory the server reads)
dist/research/fixture-keys/*.json         the two public synthetic fixture keys (unchanged)
```

The command finds the frontend relative to its own module (`../studio-ui/` from `dist/cli/`), never the working directory or the
environment, reads it into memory once and checks it is **exactly its manifest**, file for file and byte for byte, and that every
reference its files make is to a listed file beside it, before it touches a key or a socket. The server serves exactly those files by
name from memory; it is not a file server. Nothing is built, compiled or downloaded when you run it, and the installed package holds no
React and no bundler.

## Compare backend (React workspace still pending)

Merged PRs #69–73 provide the authoritative comparison presentation, recorded DSH import evidence and the guarded
raw-coordinate Compare API. The server also exposes candidate discovery for the next React Compare workspace:

- `GET /<cap>/api/v0/compare/candidates` returns the versioned, validated candidate presentation. Follow its optional
  `page.nextCursor` as `?cursor=<token>` while `page.hasMore`; pages are bounded to 100 rows, with a 10,000-candidate ceiling.
- Each row has explicit `source`, a privacy-safe display `session`, fixed `label`, `eligibility`, and an opaque `selector`.
  Use only `selectable` rows. `ambiguous` means multiple Pi recording attachments; `insufficient` includes incomplete or
  degraded native import evidence. Unknown/non-recording producers are excluded. No runtime success is inferred.
- Compare two selections with `GET /<cap>/api/v0/compare/selected/<source-a>/<selector-a>/<source-b>/<selector-b>`.
  Display aliases are never selectable coordinates. The existing raw-coordinate comparison route remains available unchanged.
- Selectors bind source kind, original identity and the full verified store generation under Studio's dedicated key. They
  resolve only against current verified evidence. Any append or rewrite invalidates held cursors/selections: on fixed
  `409 continuation-invalid` or a 404 selection, rediscover. An unchanged generation permits idempotent page replay.
- Store absence, damage and unopenable evidence refuse discovery; a verified empty store returns a complete empty list.
  No original DSH file, private path, arbitrary attachment name, raw runtime ID, source text or unsanitized exception is exposed.

Both routes are read-only and use the existing capability/Host/Origin/no-body guards and read-time budget. DSH checkpoint
claims concern recorded imports, not the external file's current state; missing usage/timing and different digest domains
retain their existing limitations. See [the detailed discovery contract](cockpit.md#compare-candidate-discovery).
The next frontend PR should consume that contract and handle eligibility, pagination and rediscovery explicitly. This backend
change adds no React Compare workspace and does not change Observe.

## Limits

- One read-only workspace. No other workspace, no steering, no attachment management, no push or live view: the frontend reads when it opens and
  when you press Refresh. A read re-validates the whole history ([cockpit.md](cockpit.md): about 1.3 s at 50,000 events).
- Loopback only: it cannot be reached from another machine, and there is no option to change that.
- No daemon, service or auto-start; no browser launcher (a future `--open` is possible and not present).
- Verified on the CI platform (Ubuntu 24.04, Node 22.19.0 and the newest 22.x) by the installed-tarball smoke test
  (`npm run test:package`), which runs the installed `endo studio`, fetches its page, assets and API, refuses foreign origins and
  hosts, fails to start on a taken port or a damaged page, stops it with SIGINT and SIGTERM, survives SIGKILL with the store and key
  untouched, and checks the store is byte-for-byte unchanged; it also drives the installed frontend in Chromium over a populated, an absent
  and a torn-tail store, at desktop and narrow widths (required in CI, skipped locally when there is none). The evidence and its limits: [release-0.1.0-alpha.2.md](release-0.1.0-alpha.2.md).
