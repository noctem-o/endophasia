# What is implemented, in detail

The README's [What works today](../README.md#what-works-today) summarizes the current source-tree state. This page keeps the
implementation detail and its limitations. The real recordings and studies, with what each establishes and does not, are in
[research/README.md](../research/README.md).

**Implemented and tested here:**

- The runtime-neutral protocol layer: versioned `endo.*` events and identities, an evidence store with replay,
  durable storage, and the `endo` CLI (store commands and `endo harness …`). A writable open cuts a torn log tail only
  after every remaining record validated, keeps the cut bytes in a side file, and reports their length and SHA-256.
  The reporting commands (`status`, `events`, `ledger`, `artifacts`, `harness status`) open stores read-only and change
  nothing on disk.
- **The Pi attachment** (`adapters/pi`, `endo harness …`): executable resolution, fingerprints and change records,
  neutral notifications, explicit evidence-validity rules, automatic local checks, an authorization-gated live study,
  and session recording into the durable event store with opaque source cursors, deduplicated catch-up, crash
  recovery and replay. Controls are offered only for admitted capabilities.
- **Session lifecycle on the Pi path** (`adapters/pi/lifecycle.ts`, `protocol/session-lifecycle.ts`): the recorded
  Pi records are folded into canonical `lifecycle.*` events as they are stored.
  - The events cover session started and resumed, run and turn started and completed, failed (with Pi's own
    `errorMessage` or `finalError` as the cause, recorded by sha256, length and a pattern classification; the text
    itself is kept outside canonical evidence in the store's `runtime-text/`), a STOP's request and acceptance (kept apart from Pi's observed
    `aborted` termination), interrupted, detached and compacted.
  - Interrupted means the Pi process exited, or Endophasia ended without recording an exit. The next attachment
    records the interruption together with its store recovery report.
  - Out-of-order and unknown records are surfaced as anomalies and unrecognized events.
  - Lifecycle events are rebuilt from the recorded facts on open, so a crash between writes is repaired, never
    duplicated.
  - `endo harness overview` prints the session overview (`protocol/session-overview.ts`), reduced read-only from the
    store; what Pi does not report (run and turn ids, operation outcome, STOP targeting, lanes) is UNAVAILABLE with a
    reason.
- **Trajectory comparison** (`protocol/trajectory.ts`, `adapters/pi/trajectory.ts`, `runtime/contracts/trajectory.ts`,
  [rules](trajectory.md)).
  - `endo trajectory show` projects one recorded session into `endo.trajectory.v1`, opening the store read-only. The
    layers are:
    - lifecycle;
    - tool calls (name, keyed digest of the canonical arguments): what the agent chose;
    - tool results (name, status, keyed digest of the result content), at the same positions: what the world answered;
    - outcome (cause by reference);
    - usage (what Pi reported);
    - timing (the observer's clock).

    What the recording lacks is UNAVAILABLE with a reason.
  - `endo trajectory diff` compares two sessions with a pure function. Lifecycle, tool calls, tool results and outcome
    are judged EXACT, DIVERGED (first index, both entries, common prefix) or UNAVAILABLE, aligned by position. It also
    says whether the tool calls stayed identical up to the first divergent input (a tool result). Usage and timing
    report deltas only and are never judged. Fingerprint, mapping, digest-domain, configuration and model differences are
    flagged, never mixed silently. A record's digest covers content identities, not store paths.
  - Since `pi-rpc-mapping.3`, `tool.started` records the arguments as an HMAC-SHA256 with the key's id.
    `harness.attached` records the mapping version and the digest domain.
    - **Key:** an installation key generated automatically, with owner-only permissions, in Endophasia's data
      directory; no setup.
    - **Comparison:** digests from different domains are never compared.
    - **Fixtures:** they use a committed public key (`fixture-public`) whose digests offer no secrecy.

    Earlier recordings have none of these. Since `pi-rpc-mapping.4`, `tool.finished` also records a keyed digest of
    the result content Pi documents on `tool_execution_end` (`result.content`; the tool-specific `details` are not
    digested).
- **Capture and cassette replay** ([how it works](replay.md)).
  - `endo proxy record` is a loopback-only, byte-exact relay between Pi and an OpenAI-compatible endpoint. Pi reaches
    it through its normal `models.json`. It records each exchange (keyed request digest, headers with secret values
    dropped, every response chunk with its offset, how it ended) into `<store>/capture/`. Bodies go to a keyed blob
    store outside canonical evidence.
  - `endo proxy replay` serves a cassette in recorded order with the recorded chunk boundaries, as-recorded or
    immediate. Any mismatch is an explicit miss and a failed request, never an improvised response.
  - `endo replay <store> <session>` restores the recorded scratch root at its recorded path and serves the cassette on
    the recorded port. It drives a fresh Pi through the recorded prompts, STOP and kill (at the recorded chunk), then
    compares the result with the recording, layer by layer.
  - The proxy and the cassette server depend only on the OpenAI-compatible boundary, not on Pi.
  - A qualifying Pi replay writes a separate [`endo.checkpoint-candidate.v0` receipt](checkpoint-candidate.md) under
    the replay store's `replay-artifacts/`. It binds a verified v1 initial scratch archive to actual cassette counters and
    four EXACT comparison layers. The source-tree [programmatic materialization API](checkpoint-materialization.md)
    independently revalidates that receipt and restores the recorded initial scratch tree into a new private directory,
    accepting it only when rearchived bytes match. It does not launch Pi or provide mid-run restore, live continuation or
    forking. The source-tree [sibling preparation API and strict lineage reader](initial-branch-set.md) add two independently
    materialized children, one exact verified parent and private planned condition declarations (`endo.initial-branch-set.v0`).
    A later read distinguishes pristine, modified, missing and substituted children; no execution authority is granted.
    The source-tree [single-child execution API](initial-child-execution.md) adds a fresh exact-scope local approval,
    a separate runtime derivation, one tool-free Pi turn and a strict `endo.initial-child-execution.v0` evidence reader.
    Its fake-runtime test verifies one actual captured model exchange and unchanged prepared siblings. It does not
    restore a historical Pi process or establish operating-system confinement. These checkpoint/execution slices are
    absent from the published npm alpha versions.
- **Experiments** ([how they run](experiments.md)).
  - `endo experiment run` runs a spec (`endo.experiment-spec.v0`): tasks with optional deterministic success checks,
    conditions expressed only through Pi's documented configuration, and N trials. Every trial is a fresh live Pi
    session recorded through the capture proxy, so each one is also a cassette.
  - The order is blocked-randomized with a recorded seed. A run resumes after interruption without duplicating trials.
  - `endo experiment report` aggregates the trials with the trajectory comparison. Per judged layer it gives the
    pairwise exact-match rate (95% Wilson) and the trial-level modal agreement. It also gives the first divergences,
    outcomes, the check pass rate, and usage and timing as median and IQR, never judged. The bundle uses the existing
    evaluation records.
  - It has run for real in the variance study below (360 trials), the pilot and a smoke test, and in the
    pinned-environment study (276 trials, pilot included).
- **Steering** ([how it works](steering.md)): STEER, QUEUE and STOP as explicit, authorized, verified interventions
  through Pi's documented RPC (`protocol/intervention.ts`, `runtime/contracts/intervention.ts`,
  `adapters/pi/intervention.ts`, `cli/control.ts`, `cli/steer.ts`).
  - The records are a proposal, an authorization bound to its exact digest, session and attachment, a request, Pi's
    acceptance or a refusal, a consumption, and a consequence. Each is its own event with its own source class, linked
    by `derivedFrom`. Acceptance (Pi's reply), consumption (the message's keyed digest in a request the recording proxy
    captured) and effect (the trajectory after) are kept apart.
  - The gate denies by default and records every refusal with its reason. An operation is offered only for a capability
    that conformance evidence admits.
  - v0 proposals come only from the operator. An external authority provider is a documented seam and is not wired ([the Deadbolt contract proposal](deadbolt-intervention-contract.md)).
  - `endo harness attach --control` serves the desk on an owner-only Unix socket, and `endo steer` talks to it.
  - A recorded session with an intervention replays: the replay re-issues it at the recorded point.
- Tests: a deterministic suite with a fake Pi child process and a fake OpenAI-compatible endpoint, plus an opt-in
  acceptance suite against a real installed Pi. The real Pi 1.0.0 recording (mapping.1, a historical specimen pinned by digest) is in
  [`research/pi-conformance/1.0.0/`](../research/pi-conformance/1.0.0/).

## Browser interface (Endophasia Web, currently `endo studio`)

**Endophasia Web** is the proposed user-facing name for the existing read-only browser interface (`endo studio`, [docs/studio.md](studio.md)): a read-only
browser interface on `127.0.0.1`, behind a private per-launch address, over the observation bridge (`cockpit/`) and a local
read-only server (`cockpit-http/`) ([design](cockpit.md), [the frontend](cockpit-ui.md)). It shows an Observe workspace: an overview of the recorded window, the
recorded runtime identity, capability state with its limits, the session timeline in storage order with an evidence-first inspector and each source's condition. It
writes nothing to the store, attaches to nothing and does not poll. The React Compare workspace discovers recorded Pi/DSH candidates and presents authoritative comparisons; other modes remain unbuilt.
Published `0.1.0-alpha.2` contains the first, earlier browser page; the newer React
Observe and Compare workspaces are in the source tree, as are the DSH CLI and Compare APIs described above. `endo web`, a native Endophasia binary and
native packaging are proposed only; the implemented CLI remains `endo studio`.

## Library-only and planned surfaces

**Implemented as libraries, exercised only by unit tests:** nothing in the CLI or the Pi attachment calls these yet. A
typed cognition graph; the unwired scene state in `visualization/`; evolution and promotion records (the CLI can read an evidence ledger, but no command writes one; evaluation records are written by `endo experiment`) with a baseline selection policy and RRSI- and
GEPA-inspired rule sets (not ports of RRSI or GEPA; see `evolution/policies/rrsi-inspired.ts`); trust-record mappings
for Cogitator, Magpie and Deadbolt; model orchestration, routing and collaboration records; record mappings for Codex,
Prime and REEF; and an OpenAI-compatible provider adapter (whole SSE bodies are buffered, no incremental streaming).
Three protocol schemas (`protocol/{continuity,control,runtime-profile}.ts`) and the fork-era lane overview in
`protocol/session-overview.ts` are planned surfaces with no producer at all. Their fork-era producers were removed;
they are kept for the steering and replay work and the sealed Prime study.

## Simulation and real-runtime boundaries

**Simulation and real-runtime boundaries:** the deterministic suites' Pi is a fake speaking Pi 1.0.0's documented
records; those tests alone say nothing about a real Pi release. Separately, the installed-package `acceptance` job
exercises a **real Pi 1.0.0** on Ubuntu with Node 22 and a local fake model endpoint; no real model provider is called.
This is a packaging/operator-path acceptance baseline, distinct from the **Pi 1.0.1 + qwen3.8-27b** research studies
listed in [research/README.md](../research/README.md). Hostile trajectory cases and the lifecycle's failure, retry, compaction and unknown-record paths are
exercised only against fake Pi ([research/README.md](../research/README.md#fake-only-paths)).

The boundary and the evidence rules were audited adversarially ([audit](pi-attach-audit.md)), including the
limitations accepted for now.

## DSH native cold import

PRs #70–72 added an operational, explicit cold-import path on `main`: `endo dsh import <session-directory>` reads one
persisted DeepSeek Harness Session format-4 directory and appends validated evidence to an Endophasia store. It reads the
DSH source without changing it. The importer needs no DSH installation and does not inspect a DSH home, resume or control a
process, attach live, or sync in the background. `endo dsh loss-accounting` prints the static mapping contract; it is not
a measurement of one imported session. See [the importer contract](dsh-native-importer.md).

The version-pinned study and importer were exercised against five retained captures from DSH `dsh-v0.2.1-rc.2`, including
failure and resume cases, alongside deterministic and synthetic adversarial tests ([study](dsh-native-attachment.md),
[validation](dsh-native-importer-validation.md)). This evidence does not establish live-attachment behavior or general
conformance across DSH versions. Mapping remains qualified: a DSH turn maps to an Endophasia run and a DSH step to a turn;
a tool request does not establish execution; DSH-written recovery closers are not observed interruptions. Runtime identity,
timing and complete usage remain unavailable where the persisted log does not record them (`cacheWrite` is absent on the
retained real data). `endo trajectory show` remains Pi-specific.

## Compare projection and HTTP backend

The source tree on `main` implements the deterministic trajectory-comparison presentation from PR #69 and the guarded,
read-only comparison APIs from PRs #73–74. The registered cockpit projection preserves the existing comparator's
`EXACT`, `DIVERGED` and `UNAVAILABLE` verdicts per layer and its privacy rules. The HTTP server exposes raw-coordinate
comparison plus candidate discovery, with eligibility, bounded pagination and generation-bound opaque selectors. The
routes use the configured store and do not open original DSH files;
the detailed contracts and limits are in [cockpit.md](cockpit.md#the-trajectory-comparison-presentation-implemented-and-served)
and [studio.md](studio.md#compare-workspace).

The API and projection have deterministic coverage for Pi/Pi, DSH/DSH and mixed-source recordings. The React Compare workspace consumes these contracts, with explicit pagination, paired opaque selection and rediscovery on invalidation. Comparison preserves unavailable and
qualified evidence and does not establish causal equivalence.

These additions, including the DSH CLI, comparison APIs and newer React Observe and Compare frontend, are implemented in source on `main`.
The npm registry artifacts for `endophasia@0.1.0-alpha.1` and `endophasia@0.1.0-alpha.2` do not contain them; the alpha.2
artifact contains the earlier browser page.

## Not yet built

**Not yet built:** proposed DEVELOP, COGNITION, VERIFY and EVOLVE browser workspaces; a
model-internal OBSERVE view, observation providers and typed Observe scenes; the WebGPU browser renderer; an optional Pi
extension for active-tool control; model-originated steering proposals and an external authority provider; any live provider
integration wired into a command; the full trajectory / experience laboratory; RL training-provider integration;
attachments for other harnesses; and the proposed Rust/GPUI native Endophasia application. WORK and DREAM are proposed
cognition profiles within a possible COGNITION workspace, not existing top-level workspaces; no profile selector or policy
compiler exists. A dedicated Research workspace, skill benchmarking, agent-hierarchy experiments and hardware workflows
also remain proposals, not implemented capabilities.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.
