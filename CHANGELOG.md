# Changelog

## Unreleased

### Added
- **Field, an optional appearance for DEVELOP:** an **Instrument | Field** switch in the top bar (DEVELOP only; Instrument stays the
  default). Field draws the same workspace, state and controls as a survey sheet: a slow contour field in text behind the work (Canvas 2D,
  loaded on demand, GPU not needed), a reading surface with a measure, and, where there is nothing to read yet, a ledger of what is
  **known**, **not known**, **possible here** and **yours**, each line with its provenance mark. The field's motion comes from typed state
  only (`model/field.ts`): a run Pi reports open flows only while the page is re-reading it; a recording never moves; an unreachable broker is
  drawn broken, not ended; a request awaiting terminal approval holds the field and shows a text beacon that names the terminal; reading
  changes stills it. A legend says what the field shows; it pauses on request, under reduced motion, and while the page is hidden. Nothing is
  persisted (the page has no storage), no route, hook or dependency was added, and the one animation-frame loop is confined to the renderer
  by a source test. See [docs/develop-field.md](docs/develop-field.md).
- **Project and worktree context, and a read-only Changes review, in the DEVELOP live workbench:** a worktree bar (repository, branch or
  detached/unborn HEAD, short commit, per-area counts) above the run strip; a Conversation | Changes switch in the centre with unified
  diffs of staged (HEAD → index), unstaged (index → working tree) and untracked files, previous/next file, and `j`/`k`/`Esc`; the changed-file
  inventory and the repository's other worktrees (places, not sessions) in the context column. The directory is the one Pi was launched in
  (configured, then read with Git): a recorded Pi or DSH session still has no project, and nothing says who changed a file. Two GET routes
  behind the workbench grant (`project`, `project/diff`) with a fixed query shape and no browser-supplied path; Git is run with a fixed list
  of reads that run no program a repository names (fsmonitor, filters, textconv, external diff, hooks, pagers), take no lock and write nothing
  (plumbing, not `git diff`, which rewrites the index), under timeouts and output caps, with symlink and scope checks, display-safe names, and
  a revalidation that refuses a diff once the working tree has moved on. Nothing is polled; the last confirmed facts stay, marked out of
  date or unconfirmed. The live view now fills the window (the conversation scrolls between a pinned header and a docked composer), the composer stays
  editable during a run, the sessions list is a drawer at laptop widths, and the privacy of live text is stated once instead of under every
  message. See [docs/develop-project-review.md](docs/develop-project-review.md).
- **Neutral DEVELOP session surface (`endo.develop-session-surface.v0`):** one presentation contract for a session whatever produced it, with a
  source-qualified key and its scope kept apart from the display alias, ownership, observed/reported/recorded status claims that are never
  merged, live/recorded/unavailable observation, separate observe/control/coordinate capabilities (every action present, a reason for each
  that is not supported) and independently qualified parent/child edges. The live Pi workbench, recorded Pi and recorded DSH sessions are
  projected into it in the browser, with no change to any server response, and DEVELOP now shows a live-or-recorded tag per row and a
  source, ownership and offers block per session. Offers are descriptions: the composer and STOP still follow the broker's own offers and
  its admission. Two test-only shapes (an externally owned session; a meta-harness job with two children) show external and hierarchical
  sessions can be represented without inventing observations or authority. See [docs/develop-session-surface.md](docs/develop-session-surface.md).
- **STEER, QUEUE and STOP from the DEVELOP workbench:** the composer gains Steer and Queue modes (never switched for the operator,
  each showing its delivery semantics) and STOP sits in the run strip. They drive the existing intervention desk and chain, behind the
  same terminal approval for every one: the page only requests, the operator types `APPROVE STEER|QUEUE|STOP <digest prefix>` on the
  attached terminal (recorded as `confirmation: "terminal-phrase"`, origin `operator-workbench`). Offered only for an open run on the
  live session and an admitted capability, with the reason when not. Cards in the conversation keep requested, approved, sent, Pi's reply,
  consumption and the run's end apart: acceptance is not consumption, consumption is checked only on request against the proxy capture
  (and is not established without one), and a run's end is what Pi reported, never attributed to the request. A lost reply is "outcome
  unknown", not refused. One approval waits at a time; a duplicate STOP returns the pending one; the desk tells the broker before it
  records consequences, so nothing is approved after they are written. Steer and queue text is kept in `<root>/interventions/` before
  approval, as `endo steer` does. See [docs/develop-workbench.md](docs/develop-workbench.md#13-slice-b-steer-queue-and-stop-through-the-broker).
- **DEVELOP live workbench for one governed Pi session (opt-in):** `endo harness attach <root> --control --workbench` serves the Studio
  page on its own loopback address behind a small command broker. The page shows the live connection and run state the broker
  reports, a private in-memory conversation (never written to evidence or any read route; Pi keeps its own session file), and can
  request one new prompt, which is sent only after the operator types its exact phrase on the attached terminal. The prompt has its own
  record chain (`workbench.prompt-*`, by keyed digest only). Pairing by a one-time terminal code, a single in-memory grant, exact
  same-origin guards, closed routes, no shell, no PTY, no raw RPC. `endo studio` remains read-only (its server gains only a constant
  "no workbench" status answer). OMP and streaming are not built. See
  [docs/develop-workbench.md](docs/develop-workbench.md).
- **Develop workspace (read-only session desk) in Endophasia Web:** browse the recorded Pi and DSH sessions in a store, group them by
  source, select one and read its recorded lifecycle state (as recorded, never as a live process), counts, positions, per-run usage as
  reported, and its events in storage order with provenance marks, with explicit paging, client-side filters that say they cover only
  what is loaded, and hand-offs to Observe and Compare. Two new GET routes (`develop/sessions`, `develop/session/<selector>`) with
  versioned, validated presentations (`endo.cockpit-develop-sessions.v0`, `endo.cockpit-develop-session.v0`), selectors and cursors bound to
  their own purpose and to the verified log generation, and the timeline's own withholding of arguments, results, prompts and paths. No
  write path, polling, project inference or execution authority. See [docs/studio.md](docs/studio.md#develop-workspace-read-only-session-desk).
- **AA-LIVE-001 result (research):** the first real matched two-turn A/A ran once against the pinned llama.cpp build and
  model: `COMPLETE-UNDER-DECLARED-ASSUMPTIONS`, 4 of 4 slots, 8 of 8 requests bound, server binary `MATCH`, cleanup
  confirmed. Redacted summary and limits in
  [research/governed-initial-continuation/aa/RESULTS.md](research/governed-initial-continuation/aa/RESULTS.md). Harness
  validation only: not model parity, not attestation, no noise floor.

### Fixed
- **DEVELOP: a STOP no longer waits behind an unapproved steer or queue, and the evidence check no longer holds the workbench:** requesting a
  STOP while a STEER or QUEUE awaits terminal approval now supersedes it. The STOP's proposal is recorded first (if that fails nothing is
  disturbed), the pending request is cancelled with a recorded `not-authorized` refusal whose detail says it was superseded, its terminal
  question is released before the STOP asks its own, and anything typed for the cancelled request is discarded. The STOP still needs its own
  exact `APPROVE STOP` phrase, and every gate is checked at dispatch; a request already approved and waiting for Pi is never touched.
  *Check evidence* now returns at once and runs as a bounded, resumable scan in slices that yield to the event loop, with limits per slice,
  per check, per request (one at a time, a cooldown) and overall; an incomplete check (a limit, an unreadable body, a closing session)
  establishes nothing, and `intervention.consumed` is still written only when the capture shows the message one more time, once. The close-time
  check still reads the whole capture; a body it cannot read is now reported rather than skipped. A pending prompt approval still blocks STOP,
  and a cancelled steer's text stays in `<root>/interventions/`. See
  [docs/develop-workbench.md](docs/develop-workbench.md#14-stop-priority-and-bounded-evidence-checks).
- **Task-owned launcher now waits for the model mapping (research):** a real llama.cpp server listens before it loads its
  model, but the launcher inspected the process the moment the listener appeared and required the model to be mapped, so
  it refused a real server. It now waits, inside its startup deadline and under the same cancellation, for the first
  model mapping and then runs the unchanged inspection; a server that exits, never maps, or times out is ended. Found by
  the first real launch attempt (refused before any request). AA-LIVE-001 revision 3 records it.

### Added
- **AA-LIVE-001 preflight (research; read-only):** pre-registration, local environment qualification, recovery and
  dependency identity of the historical pinned llama.cpp build (build 11518, commit `1f8fa5231`), `--fit off` profile
  assessment and go/no-go for the first real matched A/A, in
  [research/governed-initial-continuation/aa/LIVE-PREFLIGHT-001.md](research/governed-initial-continuation/aa/LIVE-PREFLIGHT-001.md).
  The operator's printed outcome now states the server-binary status, so a study with an unpinned executable is not
  presented as a pinned one. No server or inference was run.
- **Terminal-governed A/A operator (research; fakes only):** `research/governed-initial-continuation/aa/operate.ts --inspect|--run <config>` (a research script, not an `endo` subcommand) connects the
  task-owned server lifecycle, a bounded read-only `GET /health` readiness gate, the governed two-turn A/A study with real
  procfs admission, and fresh-process verification behind typed terminal approvals (one for the server, one per turn). `--run`
  refuses unless stdin and stdout are the controlling terminal; there is no approval flag, environment variable or unattended
  path. SIGINT/SIGTERM/SIGHUP, EOF and every failure path stop the owned server exactly once and report `cleanup-unconfirmed`
  rather than success when that cannot be confirmed. Exercised only with a fake relay, Pi and endpoint through a real
  pseudo-terminal; no llama.cpp server or real inference. See
  [research/governed-initial-continuation/aa/OPERATOR.md](research/governed-initial-continuation/aa/OPERATOR.md).
- **Task-owned server provenance v0 (research; plumbing only):** a keyed `endo.research.aa.task-owned-provenance.0` record,
  an approval-gated launch/stop lifecycle function for a loopback server the launcher owns, a real-observation continuation
  admission hook with per-turn sidecars bound to the request-body digest and dispatch marker, and an offline fresh-process
  reader that reports record validity, observed process consistency, declared trust assumptions, unavailable host facts and
  study admission separately. `OWNERSHIP_UNVERIFIED` is never upgraded. Tested with fake executables, Pi and endpoint only:
  no real server or inference, no operator command. See
  [research/governed-initial-continuation/aa/TASK-OWNED-PROVENANCE.md](research/governed-initial-continuation/aa/TASK-OWNED-PROVENANCE.md).
- **React Compare workspace (source builds and tested tarballs):** discover eligible Pi/DSH recordings, explicitly select
  A/B through opaque generation-bound selectors, load bounded candidate pages, and inspect authoritative per-layer verdicts,
  divergent entries, qualifications, ordering assessment and B-minus-A deltas. Unknown/malformed responses, invalid selections,
  cancellation, pacing and stale request completions fail closed. Observe state and its single initial snapshot request are
  preserved; navigation triggers no extra Observe read. Native keyboard controls, evidence disclosures and narrow layouts
  retain the Studio security and accessibility model. No new comparator, backend API or runtime control is added.
- **Merged Compare presentation and APIs (PRs #69 and #73):** `endo.cockpit-trajectory-comparison.v0`
  (`protocol/cockpit-comparison.ts`) and `projectEndoCockpitTrajectoryComparisonV0` preserve the existing comparator's
  `EXACT` / `DIVERGED` / `UNAVAILABLE` verdicts per layer, keep tool calls apart from tool results, avoid cross-layer
  divergence or event pairing, leave unavailable deltas unset, and withhold store paths and content-committing digests as
  keyed tokens. The projection is registered and served through guarded read-only comparison APIs. See
  [docs/cockpit.md](docs/cockpit.md#the-trajectory-comparison-presentation-implemented-and-served).
- **Merged Compare candidate discovery (PR #74):** a validated, bounded and paginated candidate presentation reports eligibility
  and supplies generation-bound opaque selectors for selected comparisons. Selectors become invalid when the verified
  store generation changes; candidate rows use privacy-safe display identities. The React Compare workspace consumes this contract.
  See [docs/cockpit.md](docs/cockpit.md#compare-candidate-discovery) and
  [docs/studio.md](docs/studio.md#compare-workspace).
- **Merged DSH study, importer and CLI (PRs #70–72):** the version-pinned native conformance study covers a fidelity matrix over
  all 62 persisted event types and five retained sanitised captures from DSH `dsh-v0.2.1-rc.2`. This is version-pinned
  evidence, not general-version conformance. `adapters/dsh-native/` reads one persisted Session format-4 directory into
  the event store with verified append-only re-import, keyed digests, qualified lifecycle/tool mapping, an
  `endo.trajectory.v1` projection and `endo.dsh-native-loss-accounting.v0`. PR #72 exposes this offline, read-only path as
  `endo dsh import` and `endo dsh loss-accounting`. It does not drive, resume, attach to or sync DSH;
  DSH tool requests do not establish execution, and DSH-written crash closers are not `lifecycle.interrupted`.
  See [docs/dsh-native-attachment.md](docs/dsh-native-attachment.md) and
  [docs/dsh-native-importer.md](docs/dsh-native-importer.md).
- These source-tree additions, along with the newer React Observe frontend, are absent from the npm registry artifacts
  for `endophasia@0.1.0-alpha.1` and `endophasia@0.1.0-alpha.2`; alpha.2 contains the earlier browser page.
- The Studio frontend: a React/TypeScript application bundled by `esbuild` into `dist/studio-ui/` (content-hashed files and a manifest
  that the host checks, file for file and byte for byte, before anything starts), served through the same hardened server. Its
  **Observe workspace** reads the one recorded snapshot and shows an overview of the recorded window, the runtime, the capability state
  with its limits, the timeline in storage order with an evidence-first inspector, and the condition of each source, each on its own;
  loading, empty, absent, degraded, unopenable, withheld, unsupported-version, failed and paced reads are each said differently, and a
  window is never presented as the whole log. It makes one read at open and one per explicit action, and polls nothing. Responsive, with a
  modal inspector below 1024 px that carries the source warnings with it. Capabilities and Evolve remain marked as unavailable and show nothing. See [docs/studio-ui-architecture.md](docs/studio-ui-architecture.md) and
  [docs/cockpit-ui.md](docs/cockpit-ui.md).
- `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (build-time only; their licence notices are packed in `dist/licenses/`).

### Changed
- Studio, Observe: a selection bar above the table with **Show in table** (reveals the open event's row in the table's own scroller, with no
  read) and, when filters hide the open event, **Clear filters that hide it** (clears only the filters that exclude it); the pager says why a
  move is not available; the inspector is a short invitation with the reference as collapsible sections (a closed *Reading guide* beside a
  selected event); long identifiers open in place and displayed identifiers can be copied; the left rail and right panel are more readable
  and the three-column layout starts at 1360 px.
- The licence is now the **Apache License 2.0** (it was MIT). `0.1.0-alpha.1` and `0.1.0-alpha.2` were published under MIT and remain available under it; the
  Apache License applies from this change onward.
- `endo studio` now serves the Studio frontend. The earlier page (`cockpit-ui/`, `dist/cockpit-ui/`) is retired in the same change, with
  its browser, source and model tests moved onto the new frontend and not dropped. The command's arguments, address line, exit codes
  and key handling are unchanged. `npm run cockpit` serves the same frontend; `build:cockpit-ui` is replaced by `build:studio-ui`.
- The page policy gains `font-src 'self'` and the server can serve `.woff2` files, so a bundled typeface can load; no remote or
  `data:` font is admitted.
- The host reads one kind of frontend and checks it against its manifest; names are held to the server's 64-character limit and sizes
  are checked before a file is read.

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
