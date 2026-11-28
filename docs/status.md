# What is implemented, in detail

The README's [What works today](../README.md#what-works-today) gives the short inventory with a maturity label per row. This page
holds the evidence and limits behind each row, then the implementation detail for the older subsystems. The real recordings and
studies, with what each establishes and does not, are in [research/README.md](../research/README.md). The claim-by-claim
reconciliation from the November 2026 refresh is in [audits/documentation-reconciliation-2026-11.md](audits/documentation-reconciliation-2026-11.md).

**Pinned tree for the sections marked "current":** `d2024ac51` (28 November 2026).

## Maturity vocabulary

| Label | Meaning |
| :--- | :--- |
| Implemented | On `main`, with an operator surface (CLI or Studio) and deterministic tests. |
| Narrow | Implemented, but validated only in the configuration stated. |
| Library | Implemented and tested, with no CLI or Studio entry point. |
| Experimental | Works, and is explicitly non-authoritative, opt-in or disabled by default. |
| Design only | A specification with no implementation. |
| Under research | Open empirical question. Evidence may sit on unmerged research branches. |
| Planned / exploratory | Intent, not capability. See [roadmap.md](roadmap.md). |
| Gated | Held behind a written entry gate. Not to be promoted without meeting it. |

## Current: evidence and limits, row by row

<a id="develop"></a>
<a id="coordinate"></a>

| Capability | Evidence and limits |
| :--- | :--- |
| Projects, tasks, attempts and briefs | Atomic, locked, revisioned metadata under `<root>/develop/`, separate from the event store. Exercised by unit, multi-process, broker, HTTP, PTY and browser tests plus real work cycles ([WORK-CYCLE-001A/B](../research/work-cycle/README.md)); damaged authorisation records fail closed (`EVIDENCE-INTEGRITY-001`). |
| Checks, receipts, plans, ledger & attention | Shell-free execution at clean commits with timeouts and lingering-process detection (Linux `/proc`; inconclusive where `/proc` is absent). Behavioural checks compare exit code and stdout only (no stdin, stderr, servers or browsers). Both `attempt evidence` and the cross-task attention overview read planned checks through the same acceptance ledger (`DEVELOP-ATTENTION-002`). Check environment variables are inherited and not attested. |
| Protected attempt execution (`attempt protected-run`) | Terminal-approved execution of one prepared attempt through the Bubblewrap protected runner with controller binding, cross-route exclusivity (preventing dual live/protected dispatch of one attempt) and `attempt bridge` evidence inspection. Nothing is applied automatically to the live checkout and no task status moves. |
| Working-tree provenance | Records Git blob ids and modes, never contents. Ignored paths are excluded; two equal states do not prove nothing happened between them; diffs never establish authorship. |
| Workspace without an agent | Separate pairing; zero harness, session or command surface; hosts the read-only Coordinator Mission Board for the launched project. Covered by host, CLI and browser tests. |
| Governed live Pi workbench | Terminal approval (or attested narrow Everyday grant on Linux with Pi 1.5.2 + local `Ornith-1.5-9B-Q8_0`), Course gauges, Field atmospheres, structured private activity (`tool` / `file-change` / `activity`) and non-authorising capability descriptor. Linux systemd user scopes confirm process cleanup where available. No general real-model workbench conformance claim. |
| Governed live Codex CLI & workbench | Local Codex App Server behind `endo.develop-adapter.v0` in an isolated conservative `CODEX_HOME` (inherited MCP disabled at startup). Strict-only (no Everyday grants), targeted `turn/interrupt`, explicit `Reasoning summary` vs raw-thinking provenance, live usage with cached tokens, fail-closed deny-only native approval handling (read-only pending banner in Studio), and shared Pi/Codex single-writer store lock. Validated live against Codex CLI (`gpt-6.2-sol`) in CLI trials plus deterministic broker, PTY, HTTP and headless Chromium Studio tests. No `STEER` (`turn/steer` is wired, but its capability is `unverified` by default, so it isn't offered), no `QUEUE`, no prepared-attempt dispatch (`attempt/propose` is refused) and no concurrent Pi + Codex store sharing (E4) yet. |
| Pi identity, recording & capability admission | Installed-package CI pins Pi 1.0.0 with a fake endpoint; real-model studies span Pi 1.0.1, 1.0.4, 1.5.0, 1.5.2 and 1.6.0. Not general-version conformance. |
| Representation Explorer | Read-only offline TransformerLens 4.x `TransformerBridge` captures (`SmolLM2-135M-Instruct` verified with `9Q/3KV` GQA semantics), scale-invariant 2D Householder-QL PCA, explicit `UNAVAILABLE` gaps and strict CSP/wire gates. No live serving-time or GGUF internal-activation capture. |
| DSH cold import & loss accounting | Five retained captures from pinned `dsh-v0.2.1-rc.2` (including failure/resume) plus adversarial tests. No live DSH control. |
| Oh My Pi saved-session observer | Read-only metadata from OMP 18.x format-3 files, verified in place against local OMP 18.13.3/18.14.1 stores plus adversarial tests. No live observation or control. Claude Code, Hermes and Amp are not integrated. |
| Capture & cassette replay | 40 exact replays across 4 recorded Pi sessions plus negative control with model responses held fixed. |
| Sandboxed protected experiments (`v0`–`v3`) | Linux Bubblewrap with inside-sandbox preflight, confirmed scope termination before collection, controller-pinned baseline + verified staged change-set reconstruction (`v2`/`v3`), opt-in capability-consistent Pi prompt (`PI-RUNTIME-CONSISTENCY-001`), recording model relay and isolated hidden evaluator. Verified with real Pi 1.5.2 / 1.6.0 against local models (`DEVELOP-ACCEPTANCE-001`, protected real-repo studies). Same-uid host tampering is detected by re-hashing, not prevented. |
| Initial scratch copies, continuation & A/A | Fresh tool-free Pi turns with separate approvals and independent receipt verification (`research/governed-initial-continuation/aa/operate.ts`). Not historical process restore or a general effect sandbox. |
| Adapter contract, ACP v1 & v2 study | `endo.develop-adapter.v0` validated by conformance suites across Pi, synthetic Codex and real Codex App Server. ACP v1/v2 has deterministic tests plus opt-in OMP smoke path; no admitted ACP capability or real v2-agent conformance. |
| Coordinator status, Mission Board & OpenClaw plugin (#174, #175) | Read-only projection (`endo.coordinator-status.v0`) of tasks, verification standing and recorded sessions, with freshness and an explicit basis per source. The board is project-scoped behind the paired workspace grant with bounded reads. The OpenClaw plugin (`integrations/openclaw-endophasia-status/`) reads the same projection. It never writes, moves tasks or dispatches. |
| Coordination intent, E1 (#184) | `endo assign`, `dep`, `candidate` and `coordinator coordination`: atomic, revisioned `develop/coordination.json`. Every change names a revision, and dependency satisfaction is computed on read and never stored. Records intent only, and grants no execution authority. |
| Governed assignment integration, E2 (#186) | `endo worktree register` (pointer-verified sibling worktrees, max 32) and `endo review` (project-scoped write-once advisory reviews, never receipts) are operator surfaces. Studio adds read-only Lanes and Graph views, and the offline liveness vocabulary never claims live state. One shared write-once route reservation (`develop/attempt-routes/`) covers the Pi workbench, protected and adapter dispatch. **The assignment dispatcher (`dispatchEndoAssignmentAttemptV0`) is library-only**: tests exercise AT01–AT24, but no CLI or Studio command calls it, and raw Pi and protected routes refuse assignment-linked attempts (`assignment-required`). Cross-file crash windows W1–W3 are handled conservatively and documented, and are not presented as transactions. |
| S0 automation architecture (#187) | Design specification only. |
| M1 local model pool (#188) | `endo.coordinator-model-pool.v0` with local `127.0.0.1` OpenAI-compatible members only. Health is zero-token `GET /health` and `/props` (and `/models` only on a single server). Nothing sends `/slots` or `/metrics`, which can wake or load a llama.cpp model, so capacity is reported unknown. Fallback happens only before inference. Loopback does not attest which process or weights are listening. No hosted inference. |
| S1 scheduler and resource observations (#189) | Durable schedule ledger under `develop/automation/` admitting only `observe-health` and `refresh-projection`. `endo scheduler tick` is one bounded, lease-fenced, zero-token pass. Endophasia installs no timer: `print-systemd-unit` writes to stdout only. Disabled by default. |
| Coordinator briefing (#178, hardened in #195) | One sandboxed OpenClaw turn with one read-only status tool, through a relay allowing one route, one model and two exchanges. The answer is capped at 4,096 bytes, with closed termination diagnostics and no raw reasoning stored. Marked non-authoritative model interpretation. Validated against OpenClaw 2026.11.7 and 2026.11.10. |
| S2 scheduled advisory intelligence (#191, hardened in #195) | `endo advisory`. Schedules are created disabled and unauthorised. A grant binds schedule id, revision and incarnation, project, action, pool digest, uncertainty policy, budget and validity window. Deterministic semantic-digest wake gating, write-once turn ledger, reservations charged in full when usage is missing, and no automatic retry. Proposals are one of six closed kinds, stored untrusted, and grant nothing. Writes only under `develop/automation/advisory/`. Live experiments (#192–#194, unmerged) found the mechanism sound, but Inkling 2 Mini achieved no grounded advisory competence under the experimental `grounded-v1`, and advisory value above deterministic rules is unproven ([consolidation](designs/coordinator-consolidation-001.md) §6). |
| Studio F1 (#196) | Attention (`endo.coordinator-attention-rules.v1`, four tiers, observed / rule consequence / not established), Resources (recorded only, `liveProbed: false`), Schedules (`executesSchedules: false`) and Advisory (untrusted, `authority: none`, no accept, dismiss or execute controls). A project-scoped `GET` endpoint with zero cross-project disclosure, zero locks held across I/O, and zero network or model probes, proven by a sentinel in the browser test. F2 actions are not delivered. |

<a id="history-detail"></a>
## Implementation detail by subsystem

The sections below predate the Codex and Coordinator work and describe the older subsystems in depth. They remain accurate for what they cover; where a statement has since been overtaken it is marked with a dated note.


**Implemented and tested here:**

- The runtime-neutral protocol layer: versioned `endo.*` events and identities, an evidence store with replay,
  durable storage, and the `endo` CLI (store commands and `endo harness …`). A writable open cuts a torn log tail only
  after every remaining record validated, keeps the cut bytes in a side file, and reports their length and SHA-256.
  The reporting commands (`status`, `events`, `ledger`, `artifacts`, `harness status`) open stores read-only and change
  nothing on disk.
- **The Pi attachment** (`adapters/pi`, `endo harness …`): executable resolution, fingerprints and change records,
  neutral notifications, explicit evidence-validity rules, automatic local checks, an authorization-gated live study,
  and session recording into the durable event store with opaque source cursors, deduplicated catch-up, crash
  recovery and replay. Controls are offered only for admitted capabilities. `harness status` adds an upstream
  assessment derived read-only from those records ([harness-upgrades.md](harness-upgrades.md)): the previous and current
  runtime, every dependency that invalidated evidence, what re-establishes each capability, and the claims no check
  makes. A Pi 1.0.4 → 1.4.0 assessment, with offline checks and fake-endpoint live studies of both releases, is in
  [pi-1.4.0-upgrade.md](pi-1.4.0-upgrade.md); it does not add 1.4.0 to the verified baseline.
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
    Its fake-runtime test verifies one captured model exchange and unchanged prepared siblings. A separate
    [Pi 1.0.4/Nanbeige A/A pilot](../research/governed-initial-child/1.0.4/RESULTS.md) completed four approved
    tool-free turns and locally verified their private receipts. This does not restore a historical Pi process
    or establish operating-system confinement. The source-tree
    [initial-continuation API](initial-continuation.md) adds a separately approved second turn in the same newly
    launched Pi session, with a provisional boundary, gated requests and independently verified two-turn lineage.
    Synthetic tests and a Pi 1.0.4/fake-endpoint compatibility check cover two turns. One separately approved
    [real Pi 1.0.4/Nanbeige two-turn attempt](../research/governed-initial-continuation/REAL-ACCEPTANCE.md)
    completed with two captured exchanges and an independently verified private receipt. The API
    does not provide historical process restoration, general tool use or a general fork. These checkpoint/execution
    slices are absent from the published npm alpha versions.
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
- **DEVELOP projects and tasks** ([how it works](develop-tasks.md)): `endo project add|list` and `endo task list|add|status`, and the live
  workbench's **Task** view and project/task bar (`endo harness attach --control --workbench --project <id>`). A project is a directory the
  operator registered; a task is what they intend to get done, with an operator-owned status; both live in `<root>/develop/tasks.json`,
  separate from the evidence, written atomically under a lock with per-task revisions. A session reference is explicit, made by the operator
  in the workbench and scoped to its launch (historical after a restart). The routes sit inside the existing broker, behind the pairing grant;
  none sends a command, and `endo studio` has none of them. The CLI and the workbench's routes share one application-level implementation,
  the workspace service `runtime/contracts/develop-workspace.ts` ([decision record](develop-workspace-service.md)), which is usable as a library without
  Pi, a server or a browser; it is not a daemon, a network service or a coordinator.
- **Oh My Pi saved sessions in DEVELOP** ([how it works](develop-omp-observer.md)): `endo studio --omp-sessions <dir>` shows OMP 18.x's
  saved JSONL sessions (format 3) from the directory the operator names, read-only and metadata only (counts, entry kinds, tool and model
  names, OMP's own exit records and lineage; no text, title or path). A whole fresh read per request, never a tail; unknown formats
  refused visibly; no file written; no control and no liveness claim. Tested with adversarial synthetic journals over the adapter, HTTP
  and a real browser, and against the existing saved sessions in the local OMP directory (OMP 18.14.1 installed; 18.14.1 and 18.13.3 recorded in the files;
  read in place, unchanged; no OMP process run).
- Tests: a deterministic suite with a fake Pi child process and a fake OpenAI-compatible endpoint, plus an opt-in
  acceptance suite against a real installed Pi. The real Pi 1.0.0 recording (mapping.1, a historical specimen pinned by digest) is in
  [`research/pi-conformance/1.0.0/`](../research/pi-conformance/1.0.0/).

## Browser interface (Endophasia Web, currently `endo studio`)

> **Note (28 November 2026):** this section describes the browser interface as it stood before the Codex workbench (#183),
> the Protected Experiment Inspector (#171), the Mission Board (#175), E2's Lanes and Graph views (#186) and Studio F1 (#196).
> All of those are on `main`; see [studio.md](studio.md) and the rows above.

**Endophasia Web** is the proposed user-facing name for the existing read-only browser interface (`endo studio`, [docs/studio.md](studio.md)): a read-only
browser interface on `127.0.0.1`, behind a private per-launch address, over the observation bridge (`cockpit/`) and a local
read-only server (`cockpit-http/`) ([design](cockpit.md), [the frontend](cockpit-ui.md)). It shows an Observe workspace: an overview of the recorded window, the
recorded runtime identity, capability state with its limits, the session timeline in storage order with an evidence-first inspector and each source's condition. It
writes nothing to the store, attaches to nothing and does not poll. The React Compare workspace discovers recorded Pi/DSH candidates and presents authoritative comparisons, and the read-only Develop workspace browses recorded sessions and their recorded lifecycle and activity (a recording is not a live process; project association is not established by the evidence and is not shown); DEVELOP presents every session in a neutral, versioned surface ([docs/develop-session-surface.md](develop-session-surface.md)) that separates source identity from alias, observed from reported, and recorded from live, and authorises nothing; Develop also has a live, paired workbench for an attached Pi session (conversation, terminal-approved requests, read-only Git change review, optional Field appearance) and the operator's own persistent project and task metadata ([docs/develop-tasks.md](develop-tasks.md)); other modes remain unbuilt.
Published `0.1.0-alpha.2` contains the first, earlier browser page; the newer React
Observe, Compare and Develop workspaces are in the source tree, as are the DSH CLI and Compare APIs described above. `endo web`, a native Endophasia binary and
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
listed in [research/README.md](../research/README.md). A separate [Pi 1.0.4 / Nanbeige initial-child acceptance and
A/A pilot](../research/governed-initial-child/1.0.4/RESULTS.md) exercised the source-tree governed API with private
evidence; it is not a package acceptance or general fork claim. Hostile trajectory cases and the lifecycle's failure,
retry, compaction and unknown-record paths are
exercised only against fake Pi ([research/README.md](../research/README.md#fake-only-paths)).
The separate [E4e-G CPU numerical experiment](../research/numerical-execution-probe/FIRST-RESULT.md) used a pinned
llama.cpp executable and SmolLM2 f16 model, without Pi. It measured differences between application-level token
submission schedules, not CUDA behaviour or live model-internal observation in Studio.

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

> **Note (28 November 2026):** written before the Codex live integration and the Coordinator programme. DEVELOP now also
> attaches a live Codex App Server, and coordination intent (E1/E2) and deterministic and advisory scheduling (S1/S2) exist as
> described above. What remains unbuilt among the items below: Studio F2 operator actions, concurrent heterogeneous sessions in one
> store (E4), and live attachments for harnesses other than Pi and Codex.

**Not yet built:** the proposed COGNITION, VERIFY and EVOLVE browser workspaces (DEVELOP was then built for recorded sessions and for one attached Pi session); a
model-internal OBSERVE view, observation providers and typed Observe scenes; the WebGPU browser renderer; an optional Pi
extension for active-tool control; model-originated steering proposals and an external authority provider; any live provider
integration wired into a command; the full trajectory / experience laboratory; RL training-provider integration;
live attachments for harnesses other than Pi and Codex; and the proposed Rust/GPUI native Endophasia application. WORK and DREAM are proposed
cognition profiles within a possible COGNITION workspace, not existing top-level workspaces; no profile selector or policy
compiler exists. A dedicated Research workspace, skill benchmarking, agent-hierarchy experiments and hardware workflows
also remain proposals, not implemented capabilities.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.
