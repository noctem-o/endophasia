# Installing the `endo` CLI (Operator Alpha, tranche 1 of 4)

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

## Not yet (pending tranches)

2. `endo doctor`, runtime discovery, a default data root (stores are still passed explicitly as `<root>`).
3. A coherent installed Pi loop: check, attach, status/overview and trajectory from the installed package.
4. Clean-install acceptance with a pinned Pi and a local fake model endpoint, then a versioned prerelease.

No platform other than the CI image (Ubuntu, Node 22) has been exercised for the packaged CLI.
