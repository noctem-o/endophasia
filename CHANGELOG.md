# Changelog

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
