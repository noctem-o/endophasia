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
corrupt registry log is reported as DAMAGED (the valid prefix is shown, never repaired). It says whether the Pi found now has the identity the evidence describes, and lists next steps.

It never installs or modifies Pi, starts an agent session, calls a provider, runs a study, creates a key, or writes to
the store; the only process it runs is `<pi> --version`. **Finding Pi is not a capability**: nothing is admitted until
`endo harness check` records evidence. A missing prerequisite is a normal report with exit 0 (`--json` carries the
detail); exit 1 means the doctor itself failed or was misused (`diagnosticErrors`). The JSON shape is
`endo.doctor.v0` (see `cli/doctor.ts`).

## Default store root

One resolver (`cli/store-root.ts`), first match wins:

1. an explicit `--root` (doctor today),
2. `ENDO_STORE_ROOT` (absolute; a relative `ENDO_STORE_ROOT`, `XDG_DATA_HOME` or `HOME` is refused),
3. `$XDG_DATA_HOME/endophasia/store`,
4. `$HOME/.local/share/endophasia/store`.

Never the working directory or the checkout. The installation digest key keeps its own location and override
(`ENDO_DIGEST_KEY_FILE`, else `$XDG_DATA_HOME/endophasia/digest-key`, else `~/.local/share/endophasia/digest-key`); the
two do not influence each other. **Existing commands still take an explicit `<root>` and do not use the default yet**;
wiring the default (and rejecting a positional root that conflicts with `--root`) belongs with the operator loop in
tranche 3, so no command changes where it reads or writes in this tranche.

## Not yet (pending tranches)

3. A coherent installed Pi loop: check, attach, status/overview and trajectory from the installed package, using the
   default store root.
4. Clean-install acceptance with a pinned Pi and a local fake model endpoint, then a versioned prerelease.

No platform other than the CI image (Ubuntu, Node 22) has been exercised for the packaged CLI.
