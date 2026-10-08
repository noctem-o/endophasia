# Installing the `endo` CLI and first run (Operator Alpha, tranches 1–2 of 4)

Status: **experimental; not published.** The package is `private` at version `0.0.0`. Nothing here is a release.

## What the tarball is

`npm pack` produces `endophasia-<version>.tgz`: the compiled JavaScript of the `endo` command's import closure
(`dist/`), `package.json`, `README.md` and `LICENSE`, about 85 files and 0.26 MB packed. It has **no runtime npm
dependencies** and ships no TypeScript, tests, source maps, declarations, private keys, captures or research data.

The one non-JavaScript runtime asset is the pair of public synthetic fixture keys (`dist/research/fixture-keys/`),
which `storage/digest-key.js` resolves relative to itself (`../research/fixture-keys/`) for the fixture recorders. They
are public by design and are never accepted as an installation key. `scripts/build-cli.mjs` copies them there.

## Why no TypeScript at runtime

Node (>= 22.19) can run `.ts` directly in a checkout, but refuses to strip types for files under `node_modules`
([Node TypeScript docs](https://nodejs.org/api/typescript.html)). So the package ships compiled `.js`.
`tsconfig.cli.json` extends `tsconfig.base.json` and uses
[`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html) to
turn `./x.ts` imports into `./x.js`. No bundler is used. The full-repository `npm run typecheck` is unchanged.

## Build, pack, install

~~~sh
npm ci
npm run build                      # tsc -p tsconfig.cli.json + fixture keys -> dist/
npm pack                           # endophasia-0.0.0.tgz (prepack rebuilds dist/)
npm install --prefix ~/endo-try --ignore-scripts --omit=dev ./endophasia-0.0.0.tgz
~/endo-try/node_modules/.bin/endo --help
~/endo-try/node_modules/.bin/endo --version
~/endo-try/node_modules/.bin/endo harness overview ./some-store   # read-only; a missing store creates nothing
~~~

`npm install -g ./endophasia-0.0.0.tgz` puts `endo` on `PATH`. To remove a trial install: `rm -rf ~/endo-try`
(or `npm uninstall -g endophasia`). Requires Node >= 22.19.0.

`npm run test:package` (`scripts/package-smoke.mjs`) does this in a scratch directory with an isolated `HOME` and
`XDG_*`, runs the installed binary under `node --no-strip-types` from two other working directories, audits the
inventory and every relative import, and checks that help, version and read-only inspection created no state. CI runs it
in the `package` job.

## Exit codes

`0` success (including `--help`/`--version`); `1` a command ran and failed, or printed its own usage error (unchanged);
`2` an invalid invocation (unknown or missing command).

## Pi is installed separately

Endophasia attaches to a Pi you installed; it never installs, upgrades, patches or rebuilds it, and help and version
need no Pi. Command semantics, store formats and output formats are unchanged by this tranche.

## First run: `endo doctor`

~~~sh
endo doctor [--root dir] [--pi path] [--attachment a] [--json]
~~~

Read-only. It reports the Endophasia version, Node compatibility, the platform (only Linux with Node 22 is exercised),
whether Pi is found (an explicit `--pi`, else `pi` on `PATH`) and what it reports for `--version`, where the store and
the installation key would live and whether each exists, and the identity and capability evidence already recorded in
that store, copied as recorded (ADMITTED, UNVERIFIED, UNAVAILABLE and the rest are all shown; the evaluator is not
re-run). Capabilities derived for an earlier identity than the latest recorded one are marked STALE, and a torn or
corrupt registry log is reported as DAMAGED (the valid prefix is shown, never repaired). It says whether the Pi found now has the identity the evidence describes (a match is claimed only between strong identities; a reduced-confidence identity, whose entrypoint or version could not be observed, is shown with its gaps and a match is reported as not established), and lists next steps. It does not recommend a re-check that a sealed registry would refuse.

It never installs or modifies Pi, starts an agent session, calls a provider, runs a study, creates a key, or writes to
the store; the only process it runs is `<pi> --version`. **Finding Pi is not a capability**: nothing is admitted until
`endo harness check` records evidence. A missing prerequisite is a normal report with exit 0 (`--json` carries the
detail); exit 1 means the doctor itself failed or was misused (`diagnosticErrors`). The JSON shape is
`endo.doctor.v0` (see `cli/doctor.ts`).

## Default store root

One resolver (`cli/store-root.ts`), first match wins:

1. an explicit root (`--root dir`, or the positional `<root>` of the older spelling),
2. `ENDO_STORE_ROOT` (absolute; a relative `ENDO_STORE_ROOT`, `XDG_DATA_HOME` or `HOME` is refused),
3. `$XDG_DATA_HOME/endophasia/store`,
4. `$HOME/.local/share/endophasia/store`.

Never the working directory or the checkout. The installation digest key keeps its own location and override
(`ENDO_DIGEST_KEY_FILE`, else `$XDG_DATA_HOME/endophasia/digest-key`, else `~/.local/share/endophasia/digest-key`); the
two do not influence each other.

Every store-taking command (`status`, `events`, `ingest`, `ledger`, `artifacts`, `harness *`, `steer *`,
`trajectory show`) accepts the positional `<root>` as before, `--root dir`, or neither (the default store; stderr says
so). Naming the root both ways is a usage error, never a silent choice. `trajectory diff`, `replay`, `proxy` and
`experiment` still take explicit stores. Commands that write create the default store on first use; the read-only ones
never do.

## The installed Pi loop

Pi is installed and managed separately (`pi` on `PATH`, or `--pi /path/to/pi`). Endophasia only attaches to it. The
working directory Pi runs in is independent of the store: `--cwd dir`.

```sh
endo doctor                                  # 1. diagnose: Node, Pi, store/key locations, recorded evidence
endo harness check [--pi path]               # 2. fingerprint Pi, run the local checks (no model call), record evidence
endo harness attach [--pi path] [--cwd dir] \
    --provider p --model m --prompt "..."     # 3. record one session (may call the provider Pi is configured with: cost)
endo harness status                          # 4. recorded identity and capability evidence
endo harness overview                        #    the recorded session lifecycle
endo trajectory show <pi-session-id>         # 5. project the trajectory from the durable records
```

`attach` prints its JSON document on stdout and, on stderr, what was observed and the next commands with the real session
id and root filled in. A prompt reported as *accepted* is only that; the run is separately *seen to settle* or not within
`--wait` ms, and a run that did not settle may still have been going when the session closed. If Pi reports no session
id, none is named. Everything after `attach` reads the store only, so it works after the process has exited.

The live study (`harness study --authorize-live-study`) remains a separate, explicit authorisation; nothing in this loop
runs one, and `doctor` never starts a session. The automated acceptance (`npm run test:package`) runs this loop from the
installed tarball against a prepared **fake** Pi (a test fixture speaking Pi's documented RPC surface; it is not Pi and
proves nothing about a Pi release) and a local fake OpenAI-compatible endpoint: no credentials, no provider. Only Pi on
the platform CI exercises is verified; no general runtime support is claimed.

## Not yet (pending)

A versioned prerelease: see [release-alpha.md](release-alpha.md) for what is verified, what is not claimed and the owner's
checklist. The real-Pi acceptance (`npm run test:acceptance`, CI job `acceptance`) installs the pinned Pi separately and
runs the loop from the installed tarball against a fake model endpoint.

No platform other than the CI image (Ubuntu, Node 22) has been exercised for the packaged CLI.
