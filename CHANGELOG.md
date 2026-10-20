# Changelog

## 0.1.0-alpha.2

The **Studio alpha**. It adds a read-only browser interface, `endo studio`, to the operator alpha, together with the observation
bridge and local server beneath it. `0.1.0-alpha.1` does not contain Studio. Scope, evidence, limits and the publication procedure:
[docs/release-0.1.0-alpha.2.md](docs/release-0.1.0-alpha.2.md) in the repository.

### Added
- `endo studio [<root>] [--root dir] [--port n] [--key-file path]`: Endophasia Studio, a read-only browser interface over a recorded
  store, served by the installed package on `127.0.0.1` only behind a private per-launch address printed once. Today it shows one
  observation page: the recorded runtime identity and its changes, the capability states with their reasons and limits, the event
  timeline in storage order, and the condition and provenance of each source, with filtering, paging and an explicit refresh. It
  writes nothing to the store, starts and steers nothing, does not poll, and reads no private model reasoning. The page is built into
  the package (`dist/cockpit-ui/`), so no checkout, build step or network is needed. The first launch creates its own digest key
  (`cockpit-digest-key`, mode 0600, beside the installation key) and says so. Stop it with Ctrl-C (SIGINT) or SIGTERM: exit 0. Exit 1
  means it could not start; exit 2 an invalid invocation, which it refuses before creating or starting anything. See
  [docs/studio.md](docs/studio.md).
- The observation bridge (`cockpit/`): read-only contracts and deterministic projections over the recorded evidence, a library
  with no command of its own ([docs/cockpit.md](docs/cockpit.md)).
- The package smoke test (`npm run test:package`) can be pointed at an exact artifact, `--package <tarball|name@version>`, with
  `--expect-integrity <sha512>`, so the file an owner publishes is the file that was tested. It now also runs the installed Studio
  (page, assets, API, refusals, shutdown, a taken port, SIGKILL, the store unchanged), the installed `trajectory diff`, loads
  `replay` and `proxy`, packs twice to compare, and scans the installed files for private keys and builder paths.
  `ENDO_REQUIRE_BROWSER=1` makes a missing Chromium a failure; CI sets it.

### Changed
- **A log file that exists but cannot be read now raises an error** (`EndoLogUnreadableErrorV0`) instead of being read as empty. An
  inaccessible store was previously indistinguishable from a valid empty one (`0.1.0-alpha.1` printed `endo status` and `harness
  overview` for it as an empty store, exit 0), and a writer could append to a log it had never seen. Studio shows such a store as
  *unopenable*; the commands that read the event log (`endo status`, `harness overview`, ...) fail with "the log cannot be read
  (EACCES)" and exit 1. A log that does not exist is unchanged.
- The keyed-digest shape rules and the public fixture-key table moved to `protocol/keyed-digest-shape` so the bridge's validators
  can share them. The values are unchanged and both modules re-export them.
- `package.json` publishes under the `alpha` dist-tag by default (`publishConfig.tag`), so a prerelease cannot move `latest` by
  omission.
- CI: the `package` and `acceptance` jobs fail rather than skip when Chromium is missing, and a `package-floor` job builds, packs and
  installs on the lowest supported Node (22.19.0).

### Documentation
- The README is now an introduction (what Endophasia is, Studio, a quick start, what works today with the evidence behind each row,
  one architecture diagram, the research direction and an index). The long design and research material it carried moved,
  unchanged except for relative links, heading levels, a status banner and the corrections each page states (`docs/status.md` lists its own), to [docs/vision.md](docs/vision.md), [docs/attachment.md](docs/attachment.md),
  [docs/observe.md](docs/observe.md), [docs/evolve.md](docs/evolve.md), [docs/roadmap.md](docs/roadmap.md) and
  [research/epistemic-alignment-experiment.md](research/epistemic-alignment-experiment.md).
- Corrected: the install instructions no longer imply that the published `0.1.0-alpha.1` contains `endo studio`. It does not; the
  source tree carried the same version string until this version was prepared.

### Verified
- On the CI image (Ubuntu 24.04), as an installed npm tarball: the packaged CLI and Studio under plain Node with TypeScript stripping
  disabled, on the newest Node 22.x and on the 22.19.0 floor, against a fake Pi; the operator loop against a real Pi 1.0.0 with a
  local fake model endpoint (no provider, no credentials) on the newest Node 22.x; and the installed page loaded in Chromium over
  each recorded store.

### Not claimed
- Any Pi version other than 1.0.0, any other runtime (ACP agents, OMP, OpenClaw) or platform; behaviour against a live model
  provider; model-internal observation; any Studio mode other than the one observation page; live updates; forkable checkpoints. A
  full `endo replay` round trip from the installed package is covered from source only.

## [0.1.0-alpha.1](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1) (released 2026-10-08)

The first alpha of Endophasia: an **experimental research instrument**, not a stable product. It attaches to a
user-installed agent harness (Pi) and records what it observes in a durable store. It does not install, upgrade or patch
Pi. See [docs/install.md](docs/install.md) and [docs/release-alpha.md](docs/release-alpha.md).

### Added
- A distributable `endo` CLI: compiled JavaScript, no runtime npm dependencies, `--help` and `--version`.
- `endo doctor [--root dir] [--pi path] [--attachment a] [--json]`: a read-only first-run diagnosis (Node, Pi
  discovery, store and key locations, recorded identity and capability evidence copied as recorded). It installs
  nothing, starts no session, calls no provider and writes nothing.
- A default store root (`ENDO_STORE_ROOT`, else `$XDG_DATA_HOME/endophasia/store`, else
  `~/.local/share/endophasia/store`), accepted as `--root dir`, the positional `<root>`, or neither by `status`,
  `events`, `ingest`, `ledger`, `artifacts`, `harness *`, `steer *` and `trajectory show`. `trajectory diff`, `replay`,
  `proxy` and `experiment` still take explicit stores.
- The installed Pi loop: `doctor` → `harness check` → `harness attach` → `harness status`/`overview` →
  `trajectory show`. `attach` reports whether Pi accepted a prompt and whether the run was seen to settle, the Pi
  session id as reported, and the next read-only commands.
- Acceptance from the installed tarball: against a fake Pi and fake model endpoint (CI `package`), and against a real
  Pi 1.0.0 with a fake model endpoint (CI `acceptance`). No credentials and no provider are involved.

### Verified
- Pi 1.0.0 (the verified baseline) on the CI image (Ubuntu, Node 22).

### Not claimed
- Any other Pi version, runtime or platform; stable multi-runtime support; behaviour against a live model provider
  (live studies need `--authorize-live-study` and may incur cost); model-internal observation; a cockpit.

### Changed
- `endo status`, `events`, `ledger`, `artifacts`, `harness *`, `steer *` and `trajectory show` use the default store
  when given no root. Naming the root twice is a usage error. A single argument to `trajectory show` is a session id.
