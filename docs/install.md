# Installing the `endo` CLI and first run (Operator Alpha 0.1.0-alpha.1)

Status: **experimental alpha, published** on [npm](https://www.npmjs.com/package/endophasia) and as a [GitHub prerelease](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1). Node >= 22.19.0 is required; Pi is installed separately.

## What the tarball is

> **The published alpha is older than the source tree.** `endophasia@0.1.0-alpha.1` on the registry (published 2026-10-08)
> contains the compiled CLI only: no `endo studio` and no `dist/cockpit-ui/`. The source tree reports the same version string but
> has since gained Studio, and a tarball packed from it contains the browser page described below. The two are different
> artifacts; do not read the version number as saying which one you have (`endo studio` printing `unknown command: studio` means
> the registry alpha).

`npm pack` from a current checkout produces `endophasia-<version>.tgz`: the compiled JavaScript of the `endo` command's import closure
(`dist/`), `package.json`, `README.md`, `CHANGELOG.md` and `LICENSE`. It has **no runtime npm dependencies** and
ships no TypeScript, tests, source maps, declarations, private keys, captures or research data.

The non-JavaScript runtime assets are the pair of public synthetic fixture keys (`dist/research/fixture-keys/`), which
`storage/digest-key.js` resolves relative to itself (`../research/fixture-keys/`) for the fixture recorders (they are public by
design and are never accepted as an installation key; `scripts/build-cli.mjs` copies them there), and the three files of the
browser page `endo studio` serves: `dist/cockpit-ui/index.html`, `cockpit.css` and `icon.svg`, beside its compiled JavaScript
modules. The page is built into the package, never at run time, and nothing else is served.

## Why no TypeScript at runtime

Node (>= 22.19) can run `.ts` directly in a checkout, but refuses to strip types for files under `node_modules`
([Node TypeScript docs](https://nodejs.org/api/typescript.html)). So the package ships compiled `.js`.
`tsconfig.cli.json` extends `tsconfig.base.json` and uses
[`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html) to
turn `./x.ts` imports into `./x.js`. No bundler is used. The full-repository `npm run typecheck` is unchanged.

## Install from npm

~~~sh
npm install -g endophasia@0.1.0-alpha.1
endo --version
endo doctor                          # read-only first-run diagnosis; Pi is installed separately
~~~

This installs the published alpha, which does not include Studio. Or install in a project with `npm install endophasia@0.1.0-alpha.1`, then run
`npx --no-install endo doctor` from that project. To uninstall the global CLI:
`npm uninstall -g endophasia`.

## Build and test a tarball from a checkout (contributors)

~~~sh
npm ci
npm run build                      # tsc -p tsconfig.cli.json + fixture keys -> dist/
npm pack                           # endophasia-0.1.0-alpha.1.tgz (prepack rebuilds dist/)
npm install --prefix ~/endo-try --ignore-scripts --omit=dev ./endophasia-0.1.0-alpha.1.tgz
~/endo-try/node_modules/.bin/endo --help
~/endo-try/node_modules/.bin/endo --version
~/endo-try/node_modules/.bin/endo harness overview ./some-store   # read-only; missing store creates nothing
~~~

This tarball test uses a clean prefix instead of the registry package. To remove it: `rm -rf ~/endo-try`.

`npm run test:package` (`scripts/package-smoke.mjs`) does this in a scratch directory with an isolated `HOME` and
`XDG_*`, runs the installed binary under `node --no-strip-types` from two other working directories, audits the
inventory and every relative import, and checks that help, version and read-only inspection created no state. CI runs it
in the `package` job.

## Exit codes

`0` success (including `--help`/`--version`); `1` a command ran and failed, or printed its own usage error (unchanged);
`2` an invalid invocation (unknown or missing command; and, for `endo studio` only, invalid arguments, which it refuses before
creating or starting anything). For `endo studio`, `0` also means it was stopped by SIGINT or SIGTERM and `1` that it could not
start ([studio.md](studio.md#output-and-exit-status)).

## Pi is installed separately

Endophasia attaches to a Pi you installed; it never installs, upgrades, patches or rebuilds it. Help, version and
`doctor` can run without Pi; a missing Pi is reported rather than inferred to have capabilities.

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
working directory Pi runs in is independent of the store: `--cwd dir`. Use `--pi /path/to/pi` to select a non-default
executable and `--attachment name` to track several installations separately.

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
runs one, and `doctor` never starts a session.

## Endophasia Studio

Studio is **not in the published `0.1.0-alpha.1`**. It runs from a source build (`npm ci && npm run build`, then
`node dist/cli/index.js studio`) or from a tarball packed from one, where the installed binary is `endo`:

```sh
endo studio                           # the default store; prints one private address, then runs until Ctrl-C
endo studio --root ./recordings --port 8085
endo studio --help
```

Studio is a read-only browser interface on `127.0.0.1` over a recorded store (today one observation page; the other modes are not
built). It needs only what is installed: no checkout, TypeScript, build step, network or model provider. It never writes the
store (a store that does not exist is shown as absent and stays absent); the first launch creates its own digest key
(`cockpit-digest-key`, mode 0600, beside the installation key) and says so. The address it prints is a secret for that launch.
Arguments, the key, the address, exit statuses and limits: [studio.md](studio.md).

## Running the tests

From a source checkout, `npm ci`, `npm test` and `node cli/index.ts ...` develop and run the deterministic suite.
`ENDO_PI_EXECUTABLE=$(command -v pi) npm run test:pi-real` is an opt-in test against your installed Pi.

`npm test` needs only Node and git; it reads no network, no API key and no git history. Two kinds of checks depend on
the host and say so instead of failing (the Studio browser tests also skip when no Chromium is found, set `CHROME_BIN` to run
them; the raw-data tests skip without the out-of-repository research data, see [../research/DATA.md](../research/DATA.md); and the
`ENDO_PI_EXECUTABLE` and `ENDO_OMP_EXECUTABLE` suites are opt-in):

- Replacing a published conformance reference needs `mv --exchange` (GNU coreutils 9.5 or later on Linux). Where `mv`
  lacks it, the replacement tests are skipped and a test checks that replacement is refused before anything is
  touched. CI runs the exchange tests in a container that has it.
- The Prime 0.9.7 specimen records the donor-repository commit that measured it. Checking the recorded source digest
  against that commit's tree is opt-in: `ENDO_HISTORICAL_PROVENANCE=1 npm test` in a clone that carries the commit
  (this repository does not).

## Release and verification

[`v0.1.0-alpha.1`](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1) is published on
[npm](https://www.npmjs.com/package/endophasia). The installed-tarball package smoke (`npm run test:package`, CI
`package`) exercises this loop with a **fake** Pi and a local fake OpenAI-compatible endpoint, without real credentials
or provider cost. The separate `npm run test:acceptance` CI job installs a pinned **real Pi 1.0.0** independently and
runs the same operator loop against a local fake model endpoint; it does not contact a live provider.

These checks establish the packaged CLI on the CI image (Ubuntu, Node 22), not other platforms or Pi versions.
For the exact evidence and limits, see [release-alpha.md](release-alpha.md).
