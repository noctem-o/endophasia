# Changelog

## Unreleased

### Documentation
- The README is now an introduction (what Endophasia is, Studio, a quick start, what works today with the evidence behind each row,
  one architecture diagram, the research direction and an index). The long design and research material it carried moved,
  unchanged except for relative links, heading levels, a status banner and the corrections each page states (`docs/status.md` lists its own), to [docs/vision.md](docs/vision.md), [docs/attachment.md](docs/attachment.md),
  [docs/observe.md](docs/observe.md), [docs/evolve.md](docs/evolve.md), [docs/roadmap.md](docs/roadmap.md) and
  [research/epistemic-alignment-experiment.md](research/epistemic-alignment-experiment.md).
- Corrected: the install instructions no longer imply that the published `0.1.0-alpha.1` contains `endo studio`. It does not; the
  version string in the source tree is the same, but the artifacts differ.

### Added
- `endo studio [<root>] [--root dir] [--port n] [--key-file path]`: Endophasia Studio, a read-only browser interface over a recorded
  store, served by the installed package on `127.0.0.1` only behind a private per-launch address printed once. Today it shows one
  observation page (recorded runtime identity, capability state, session timeline, source conditions); it writes nothing to the store
  and does not poll. The page is built into the package (`dist/cockpit-ui/`), so no checkout, build step or network is needed. The
  first launch creates its own digest key (`cockpit-digest-key`, mode 0600, beside the installation key) and says so. Stop it with
  Ctrl-C (SIGINT) or SIGTERM: exit 0. Exit 1 means it could not start; exit 2 an invalid invocation, which it refuses before
  creating or starting anything. See [docs/studio.md](docs/studio.md).
- The package smoke test runs the installed `endo studio` (page, assets and API from the tarball, refusals, shutdown, the store
  unchanged) and now lists the package's non-JavaScript files exactly.

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
