# Release preparation: 0.1.0-alpha.2 (Studio alpha)

Status: **prepared, not published.** Nothing in this document has been done on the registry or on GitHub: no `npm publish`, no
`v0.1.0-alpha.2` tag, no GitHub release. The only published alpha is [`0.1.0-alpha.1`](release-alpha.md), which does **not**
contain Studio. This page is the record of what `0.1.0-alpha.2` would be, what was verified, and the owner-operated procedure that
publishes it. It is concise on purpose; the evidence is in the cited tests and CI runs, not here.

| | Version | Contains `endo studio` | Where |
| :--- | :--- | :--- | :--- |
| Published alpha | `0.1.0-alpha.1` | no | npm (`latest` and `alpha`), GitHub prerelease `v0.1.0-alpha.1` |
| This release candidate | `0.1.0-alpha.2` | yes | this source tree, once merged; **not on npm, no tag, no release** |
| Source tree | whatever `package.json` says on `main` | yes | GitHub; moves on after the candidate |

After publication a small documentation commit flips the statements above (step 11 below). Until then the README and install guide
say "prepared, not published".

## Version

`0.1.0-alpha.2` is the next version after `0.1.0-alpha.1`. Inspected on 2026-10-20 before choosing it:

- The registry lists only `0.0.0-stage` and `0.1.0-alpha.1`. `0.1.0-alpha.2` is unused.
- Dist-tags: `latest` and `alpha` both point at `0.1.0-alpha.1`.
- Git has the tag `v0.1.0-alpha.1` only. GitHub has one release, the `v0.1.0-alpha.1` prerelease.
- `package.json`, `package-lock.json` (twice), the CLI (`endo --version`, read from the manifest), the changelog section and this
  document agree on `0.1.0-alpha.2`; `tests/release-readiness.test.ts` holds that.

A prerelease number is right: the surface is new (a browser interface and a local server), the evidence is bounded (below), and an
alpha says so. Nothing in the version changes any protocol, schema or storage version.

**`latest` stays on `0.1.0-alpha.1`** under this procedure. The manifest's `publishConfig.tag` is `alpha`, and every publish command
below names `--tag alpha`, so publishing `0.1.0-alpha.2` does not move `latest`. A bare `npm install endophasia` will therefore still
install the pre-Studio alpha; install with `endophasia@0.1.0-alpha.2` or `endophasia@alpha`. Moving `latest` is a separate decision
(`npm dist-tag add endophasia@0.1.0-alpha.2 latest`) that this procedure does not make.

## Proposed release notes

> **Endophasia 0.1.0-alpha.2: Studio.** Experimental. Adds `endo studio`, a read-only browser page over a store recorded by an
> attachment to Pi: the recorded runtime identity and its changes, the capability states with their reasons and limits, the event
> timeline in storage order, and the condition and provenance of each source, with filtering, paging and an explicit refresh. It
> binds to `127.0.0.1`, prints one private address, never writes the store it reads, does not poll and runs nothing. The package
> carries the page, so installing it is enough. Verified as an installed tarball on Ubuntu 24.04: against a fake Pi on Node 22.19.0 and on the
> newest 22.x, and against a real Pi 1.0.0 with a local fake model endpoint on the newest 22.x, including loading the page in Chromium. Not verified:
> other Pi versions, other runtimes, other platforms, a live model provider. `npm install -g endophasia@0.1.0-alpha.2`
> (the `latest` tag is unchanged). Changelog: `CHANGELOG.md`.

## The Studio alpha contract

```text
install  ->  endo doctor  ->  attach to an existing Pi  ->  record a session  ->  inspect it in Studio
         ->  compare (endo trajectory diff) or replay  ->  exit cleanly, the records preserved
```

The interfaces are the existing `endo` commands. Studio is one read-only observation page. It does not run agents, steer them, poll,
write to the observed store or read private model reasoning, and it has no mode other than that page (DEVELOP, WORK, DREAM, EVOLVE
and model-internal OBSERVE do not exist). Details: [studio.md](studio.md).

## Supported claims and their evidence

"Installed" means the packed tarball installed into an isolated prefix with an isolated `HOME`/`XDG_*`, and the installed `endo`
run under Node with TypeScript stripping disabled. That is `npm run test:package` (`scripts/package-smoke.mjs`); the real-Pi variant
is `npm run test:acceptance`. The **Subject** column says what the claim was observed against.

| Claim | Evidence | Subject |
| :--- | :--- | :--- |
| The tarball holds the compiled `endo` closure, the Studio command, launcher, server, bridge and page (15 modules, `index.html`, `cockpit.css`, `icon.svg`) and the two public fixture keys | smoke: only `dist/` and the four top-level files are packed; the non-JavaScript files and `dist/cockpit-ui/` are compared as exact sets; the rest of `dist/` is JavaScript whose imports all resolve | the tarball |
| No TypeScript, tests, source maps, `node_modules`, private-key block, capture, or builder path (checkout or home) in any packed file; no runtime dependency; `endo` bin and Node `>=22.19.0` kept | smoke: inventory, content scan, manifest | the tarball |
| Every relative import in the installed JavaScript resolves inside the package; it runs with stripping disabled | smoke | the installed package |
| The build empties `dist/` first, and two builds of one checkout give the identical tarball | smoke (stale-file and double-pack checks) | the build |
| That tarball is also byte-identical across Node 22.19.0 and 22.23.3 and across CI jobs | **observed, not asserted**: local packs on both, and the equal `sha512` lines in the CI logs; the archive bytes depend on the packing npm (npm 10 and npm 12 differ for the same tree) | the build |
| `--version`, `--help`, `doctor`, invalid arguments and read-only inspection create no store, key or server; store resolution is consistent | smoke | installed binary |
| `endo studio` starts from packaged files only, binds loopback, prints exactly one capability address, serves the page and every other file of the page byte-for-byte as installed, and refuses a wrong or missing capability, a foreign Origin, a cross-site fetch, another Host and a POST (other methods: source tests) | smoke | installed binary |
| A missing page directory or module fails at startup (exit 1, a plain sentence, no key, no listener); a taken port is a failed start (exit 1, no address) | smoke | installed binary |
| The page, in Chromium, reads the recorded session through the API and draws its events with no console error, policy violation or request outside the server | smoke, browser step (fails, not skips, with `ENDO_REQUIRE_BROWSER=1`, which CI sets); the smoke asserts at least one event is drawn | recorded by the **fake Pi** (25 events in the last run) and by **real Pi 1.0.0** (28) |
| Studio never modifies the store (byte-for-byte), including after SIGKILL; an absent store stays absent and its parent is not created | smoke | installed binary |
| SIGINT and SIGTERM stop Studio with exit 0 and release the port; SIGKILL, with a read in flight, leaves the port free and the store and key as they were | smoke (a repeated signal while it closes: source tests) | installed binary |
| Studio's own key (`cockpit-digest-key`) is created `0600` in a `0700` directory, reused byte for byte, distinct from the installation key, which is never created by Studio | smoke; source tests | installed binary |
| The address appears once, on stdout only | smoke; source tests | installed binary |
| `doctor` -> `harness check` -> `harness attach` -> `harness status`/`overview` -> `trajectory show` from the installed binary, then Studio over the recorded store after the session exits | smoke loop | **fake Pi** (`package`); **real Pi 1.0.0 + fake model endpoint** (`acceptance`) |
| `trajectory diff` of the recorded session against itself has lifecycle EXACT and no judged layer DIVERGED (on the fake Pi's session all four judged layers, lifecycle, tool calls, tool results and outcome, are EXACT; usage and timing are never judged); `replay` and `proxy` report their usage | smoke | installed binary |

Held by source-level tests only, not repeated against the installed package: the key-file refusals (the installation key under any
name, a path inside the store, loops, dangling links), the full HTTP security matrix, the page's rendering model and every
projection contract (`tests/endo-studio-*.test.ts`, `tests/endo-cockpit-*.test.ts`); and the `endo replay` round trip
([replay.md](replay.md)).

### What "real Pi" means here

Three kinds of evidence are kept apart and none stands in for another:

1. **Real Pi, fake model.** CI `acceptance` installs `@earendil-works/pi-coding-agent@1.0.0` separately and runs the loop against it
   with a local fake OpenAI-compatible endpoint. The run fails if Pi reports any other version or a reduced identity. No provider,
   no credentials, no cost.
2. **Deterministic fake Pi.** CI `package` and the source suites use a prepared Pi fixture. It shows the packaging and the
   command behaviour, not Pi's.
3. **Real-model research recordings.** The studies in [../research/README.md](../research/README.md) used Pi 1.0.1 with one local
   model on one machine. They are separate documents and are not release evidence.

The pinned Pi (`adapters/pi/version.ts`, CI `PI_PINNED_VERSION`) is **unchanged** by this release.

## Not claimed, and known limitations

- Any Pi version other than 1.0.0; ACP agents, OMP or OpenClaw; any platform other than Ubuntu 24.04; any Node major other than 22
  (the maintainer's `npm test` also passed on Node 26, which no CI job runs); a live model provider.
- Studio is one page. No other mode, no steering, no attachment management, no live view: it reads when it opens and on Refresh,
  and each read re-validates the whole history (about 1.3 s at 50,000 events).
- Studio's startup check that its page is whole compares names and references, not contents. The files are served from memory as
  packed.
- A full `endo replay` round trip from the installed package is covered from source only.
- `npm install endophasia` (no version) still installs `0.1.0-alpha.1`, because `latest` is unchanged.
- The README ships in the tarball with relative links and an image path that resolve on GitHub but not on npmjs.com.
- The registry also lists a stray `0.0.0-stage` version. It is not touched here.
- An unreadable event log is now an error rather than an empty store (a behaviour change from `0.1.0-alpha.1`; see the changelog).
- A store root that is a regular file, or whose `harness/` is one (or cannot be listed), is answered by the snapshot API with a fixed
  `internal-error` (HTTP 500) and the page's "internal error" state, not by a source condition. That is deliberate and tested
  (the library rule is pinned by `tests/endo-cockpit-twentysecond-review.test.ts`, "does not turn another enumeration failure into an
  empty list"; the page's 500 state by `tests/endo-cockpit-ui-browser.test.ts`; the HTTP behaviour for a file root was probed
  against the installed package and is not a committed check); nothing is written and the server keeps running. Damaged, torn, zeroed, empty, unreadable, directory-shaped and
  dangling-link logs, a removed registry and an absent root were each probed against the installed package and are reported as
  source conditions (`degraded`, `empty`, `unopenable`, `absent`) with the store byte-for-byte unchanged.
- `npm audit` reports moderate findings in development tooling only; `npm audit --omit=dev` is clean and nothing from
  `devDependencies` is installed with the package.

## Acceptance environment

| | |
| :--- | :--- |
| Platform | GitHub-hosted `ubuntu-24.04`; Linux only |
| Node | the newest 22.x (CI jobs `check`, `package`, `acceptance`) and exactly 22.19.0 (CI `package-floor`, fake Pi only); npm as shipped with each (npm 10.9.x) |
| Pi | `@earendil-works/pi-coding-agent@1.0.0`, installed by the CI job, separately from Endophasia |
| Model | a local fake OpenAI-compatible endpoint started by the test; no external provider |
| Browser | the runner's Chromium/Chrome (its version is printed in the job log as `browser: ...`); `ENDO_REQUIRE_BROWSER=1`, so a missing browser fails the job |
| Isolation | scratch `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`; installed with `--ignore-scripts --omit=dev`; run from other working directories |

## Build and test procedure

From a clean checkout of the commit to be released:

```sh
npm ci
npm run typecheck && npm run lint && npm test         # CI job `check`
npm run build
ENDO_REQUIRE_BROWSER=1 npm run test:package           # CI jobs `package` and `package-floor`
# with a pinned Pi installed separately (CI: acceptance):
#   ENDO_ACCEPT_PI=/path/to/pi ENDO_ACCEPT_PI_VERSION=1.0.0 ENDO_REQUIRE_BROWSER=1 npm run test:acceptance
```

`CHROME_BIN` names the browser when none is on `PATH`. Without `ENDO_REQUIRE_BROWSER=1` a machine with no Chromium skips the
browser step and says so; the CI jobs set it so that the step cannot disappear.

## Artifact under test

The values below are for the commit named in the pull request that introduced this document; any later change to a packed file
(including `README.md` and `CHANGELOG.md`) changes them. **The owner records their own from the approved commit** (step 3) and
compares them with the CI log for that commit; the published artifact is the one recorded, not the one below.

| | `0.1.0-alpha.2` (candidate) | `0.1.0-alpha.1` (published) |
| :--- | :--- | :--- |
| Files | 122 | 90 |
| Packed / unpacked bytes | see step 3 | 272,411 / 1,066,825 |
| New directories | `dist/cockpit/` (7 files incl. `projections/`), `dist/cockpit-http/` (2), `dist/cockpit-ui/` (18), `dist/cli/studio.js`, 4 files under `dist/protocol/` | |
| Existing modules changed | `dist/cli/index.js`, `dist/cli/help.js` (Studio listed), `dist/runtime/contracts/keyed-digest.js` and `dist/storage/digest-key.js` (constants moved, re-exported unchanged), `dist/storage/log.js` (unreadable log is an error) | |
| Removed | none | |

## Owner-operated publication procedure

Do this only after the pull request is reviewed and merged by the owner. Nothing here is automated: no workflow publishes, and no
publish credential is stored in the repository or in CI.

The order matters: **the tested file is the published file.** `npm publish` in a directory runs `prepack` and rebuilds; publishing
the tarball file does not.

1. **Confirm the commit and CI.** `git fetch origin && git rev-parse origin/main` is the reviewed merge commit `C`. In GitHub
   Actions, the run for `C` is green on `check`, `package`, `package-floor`, `acceptance` and `exchange`, and the `acceptance` log
   shows the real Pi 1.0.0 and the Chromium step.
2. **Clean tree.** `git clone https://github.com/noctem-o/endophasia.git release && cd release && git checkout C &&
   git status --porcelain` prints nothing. Use Node 22 (`node --version`), then `npm ci`.
3. **Pack once, and record it.**
   ```sh
   npm pack --json > pack.json                        # prepack builds; writes endophasia-0.1.0-alpha.2.tgz
   node -e 'const j=JSON.parse(require("fs").readFileSync("pack.json","utf8"));const p=Array.isArray(j)?j[0]:Object.values(j)[0];console.log(p.filename,p.integrity,p.shasum,p.size,p.unpackedSize,p.entryCount)'
   tar -tzf endophasia-0.1.0-alpha.2.tgz | sort > inventory.txt
   ```
   Record the filename, `integrity` (sha512), `shasum`, sizes, `inventory.txt` and `npm --version`. **Pack with Node 22's bundled
   npm, as CI does**: the unpacked content is identical under npm 12, but the archive bytes (and so the integrity) are not. The
   `integrity` must equal the `sha512 ...` line in the CI `package`, `package-floor` and `acceptance` logs for `C`. If it differs,
   stop and find out why (compare `inventory.txt` and `tar -xzf` contents) before publishing anything.
4. **Smoke that exact file.**
   ```sh
   ENDO_REQUIRE_BROWSER=1 node scripts/package-smoke.mjs --package ./endophasia-0.1.0-alpha.2.tgz --expect-integrity <integrity>
   ENDO_REQUIRE_BROWSER=1 ENDO_ACCEPT_PI=<pi> ENDO_ACCEPT_PI_VERSION=1.0.0 \
     node scripts/package-smoke.mjs --real-pi --package ./endophasia-0.1.0-alpha.2.tgz --expect-integrity <integrity>
   ```
5. **Dry run.** `npm publish ./endophasia-0.1.0-alpha.2.tgz --tag alpha --dry-run` lists the same inventory and the `alpha` tag.
6. **Publish** (as the owner, with the npm account's own login and two-factor prompt):
   `npm publish ./endophasia-0.1.0-alpha.2.tgz --tag alpha`
7. **Verify the registry before anything else.**
   ```sh
   npm view endophasia dist-tags                      # alpha: 0.1.0-alpha.2; latest: 0.1.0-alpha.1 (unchanged)
   npm view endophasia@0.1.0-alpha.2 dist.integrity dist.shasum    # equal to step 3
   ```
8. **Tag and release.** Only after step 7: `git tag -a v0.1.0-alpha.2 C -m "Endophasia 0.1.0-alpha.2"`,
   `git push origin v0.1.0-alpha.2`, then
   `gh release create v0.1.0-alpha.2 --prerelease --verify-tag --title "Endophasia 0.1.0-alpha.2 (Studio)" --notes-file <the release notes above> endophasia-0.1.0-alpha.2.tgz`.
   The tag comes after the publish because a version number, once published, cannot be reused, while a premature tag can mislead.
9. **Fresh install from the registry.**
   `ENDO_REQUIRE_BROWSER=1 node scripts/package-smoke.mjs --package endophasia@0.1.0-alpha.2 --expect-integrity <integrity>` installs the
   published version into an isolated prefix, checks the registry's `dist.integrity` against the fetched file, and runs the whole
   installed acceptance from it. Run it from the clone at `C` (step 2): the smoke takes its helpers and its list of page files from
   the checkout it runs in, so a clone of a later commit would check the artifact against the wrong tree. Then, by hand in a new directory: `npm install --prefix ./try endophasia@0.1.0-alpha.2`,
   `./try/node_modules/.bin/endo --version` (prints `0.1.0-alpha.2`), `./try/node_modules/.bin/endo doctor`,
   `./try/node_modules/.bin/endo studio --help`.
10. **Record** the outcome and the integrity in the release (the notes or a comment) so a later reader can check the artifact.
11. **Flip the documentation** in a follow-up documentation-only commit: `install.md`, `studio.md`, `status.md`, `cockpit.md`,
    `cockpit-ui.md`, this page's status table and the pointer in `release-alpha.md` all say "prepared, not published" and become
    "published". The `README.md` and `CHANGELOG.md` that ship in the tarball are worded to be true both before and after
    publication (a published tarball cannot change), so they need no flip; add the release date and link to the changelog
    heading in the repository if wanted. Until the follow-up lands, the repository docs still say "not published".

## Post-publication check (short)

`npm view endophasia dist-tags` shows `latest` on `0.1.0-alpha.1` and `alpha` on `0.1.0-alpha.2`; the registry integrity equals the
recorded one; a fresh-prefix install runs `endo --version`, `endo doctor` and `endo studio --help`; step 9's smoke passes.

## Rollback and correction policy

A published version number is permanent; the registry will not accept it again, and unpublishing is restricted and breaks anyone who
installed it. So a defective release is **superseded, not erased**:

1. **Contain.** If the defect is in the tarball or the behaviour: `npm deprecate endophasia@0.1.0-alpha.2 "<reason>; use <version>"`,
   and, if `alpha` should not point at it, `npm dist-tag add endophasia@0.1.0-alpha.1 alpha` (or the fixed version once it exists).
   `latest` was never moved, so it needs no rollback.
2. **Fix forward.** Ship `0.1.0-alpha.3` through the same procedure. Do not move or delete the `v0.1.0-alpha.2` tag.
3. **Say so.** Edit the GitHub release text to mark it superseded and link the fix; add a changelog entry that states the defect
   plainly.
4. **A secret or private data in the tarball** is the one case for urgent unpublishing (within npm's allowed window), together with
   rotating anything exposed. Studio's address is per-launch and never packed; installation keys are never packed and the smoke scans
   for key blocks.
5. **A documentation-only error** is fixed in a documentation commit; the README inside a published tarball cannot change, and a new
   version is warranted only if it misleads about safety or scope.
