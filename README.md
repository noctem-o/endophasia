<a id="endophasia"></a>

<div align="center">

<h1>endophasia</h1>

<p><strong>Instrumented cognition for coding agents.</strong></p>

<p>
An experimental instrument for asking defensible questions about coding-agent behaviour:<br>
it records what a harness actually does, and keeps observation, evidence, interpretation and permission apart.
</p>

<p>
  <a href="#what-works-today"><img src="https://img.shields.io/badge/status-experimental-637d69?style=flat-square" alt="Status: experimental"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/reference%20runtime-Pi-536c85?style=flat-square" alt="Reference runtime: Pi"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94765e?style=flat-square" alt="License: MIT"></a>
</p>

<p>
  <a href="#studio">Studio</a> &nbsp; · &nbsp;
  <a href="#quick-start">Quick start</a> &nbsp; · &nbsp;
  <a href="#what-works-today">What works today</a> &nbsp; · &nbsp;
  <a href="#architecture">Architecture</a> &nbsp; · &nbsp;
  <a href="#research-direction">Research</a> &nbsp; · &nbsp;
  <a href="#documentation">Documentation</a>
</p>

</div>

---

Endophasia attaches to a coding-agent harness you already run, through an explicit adapter, and records what the harness
actually does into a durable store. Everything else is built from those records: what runtime was attached and what it can
be shown to do, a comparison of two runs, a replay, an experiment, and a read-only view of the store called Studio.

It is harness-neutral by design and does not replace the harness's execution loop. It is not an agent runtime, a model
provider, a benchmark or a deployment system. Today the harness is [Pi](https://github.com/earendil-works/pi).

*Endophasia* is an old term for inner speech. The project is built on the opposite discipline: it records the outside of an
agent (what it requested, what it was told, what it reported and what it did), and it does not claim to read what a model
"thought".

> [!IMPORTANT]
> Experimental, and honest about it. The first published alpha, `0.1.0-alpha.1`, **predates Studio** and has no `endo studio`.
> Studio ships in `0.1.0-alpha.2` and later; the source tree has it today ([quick start](#quick-start)). A README cannot say
> which versions the registry holds: `npm view endophasia versions` does, and the release status and procedure for
> `0.1.0-alpha.2` are in [docs/release-0.1.0-alpha.2.md](docs/release-0.1.0-alpha.2.md). The earlier
> Pi-fork version, which demonstrated the v0 cockpit and observation contracts, lives at
> [endophasia-pi-legacy-deprecated](https://github.com/noctem-o/endophasia-pi-legacy-deprecated).

### Why you might use it

- To know which harness build and configuration produced a result, and to be told when that has changed.
- To replay a recorded session and learn whether it reproduces, with any divergence classified.
- To compare two runs layer by layer: lifecycle, tool calls, tool results, outcome.
- To steer a running session through an explicit, authorised intervention, and to see separately whether the runtime accepted
  it, whether a later model request captured by the recording proxy carried it, and what the agent then did.
- To run pre-registered experiments in which the harness and its configuration are treated as variables, not as plumbing.

### What it keeps apart

~~~text
observation  != inference
acceptance   != execution
evidence     != standing
proposal     != permission
~~~

An observed event is shown as an observation. A reported value says who reported it. A derived value names its derivation.
A capability a runtime cannot be shown to meet stays `UNAVAILABLE`; Endophasia does not fill the gap. And it keeps three
properties of reproducibility apart, because they are different claims:

~~~text
exact replay               did the recorded session reproduce under its recorded responses?
fixed-condition repeat     do repeated live runs under the same declared conditions agree?
perturbation invariance    does behaviour hold when an input that should not matter changes?
~~~

The fuller statement of these distinctions, and the projects Endophasia stays separate from, is in [docs/vision.md](docs/vision.md).

## Studio

<p align="center">
  <img src="docs/images/studio.png" alt="Endophasia Studio's observation page: runtime and capabilities on the left, a storage-ordered event timeline in the middle, source conditions and an inspector on the right" width="920">
</p>

<p align="center"><sub><strong>A real, read-only view of recorded observations.</strong> The page as served by the installed
command, captured in headless Chromium over a demo store seeded from the repository's committed records (fake-Pi lifecycle
fixtures and the real Pi 1.0.0 conformance specimen, by <code>scripts/seed-cockpit-demo.ts</code>). It is not a mock-up, a
simulation, a model-brain visualisation or a live display of internal activations.</sub></p>

Studio (`endo studio`) is the first Endophasia-native interface. Today it is **one read-only observation page**, served from
the installed package on `127.0.0.1` behind a private per-launch address. It shows, as recorded:

- the **runtime identity**: which harness installation the registry recorded, its fingerprint, and what changed;
- the **capability state**, each capability with its status, classification and the limits that qualify it;
- a **timeline in storage order**, filterable, with a per-event inspector for the recorded fields and where each came from;
- the **condition of each source**: the event log and each registry are read independently, and each says whether it was
  readable, empty, absent, degraded or unopenable.

Each claim carries its basis (observed, reported or derived) or the N/A mark with the record's own reason; a value that was
never recorded is shown as not recorded, never as zero. The page does not poll, draws no live activity or scores, and has no controls other
than refresh, paging, filtering and selection. It does not start, attach to or steer an agent, and it does not write to the
store it reads.

Studio is meant to grow into more modes. **DEVELOP, WORK, DREAM, EVOLVE and a model-internal OBSERVE view do not exist yet**;
they are future work, not tabs, and the page has no navigation for them. Details: [docs/studio.md](docs/studio.md) and
the page's [design reference](docs/cockpit-ui.md).

## Quick start

Requires **Node >= 22.19.0**. Pi is installed separately, by you; Endophasia never installs, updates or patches it.

**The first published alpha, `0.1.0-alpha.1`,** contains the CLI, not Studio:

~~~sh
npm install -g endophasia@0.1.0-alpha.1
endo doctor                          # read-only: Node, Pi, store locations, recorded evidence
endo harness check                   # local Pi checks, no model call; records evidence
endo harness attach --prompt "..."   # calls the model provider Pi is configured with, and may cost money
endo harness status                  # recorded identity and capability state
endo harness overview                # the recorded session lifecycle
endo trajectory show <session-id>    # the id attach prints
~~~

**Studio.** `endo studio` is in `0.1.0-alpha.2` and later. If `npm view endophasia versions` lists such a version,
`npm install -g endophasia@<that version>` provides it (name the version: the `latest` tag can point at an older alpha). Otherwise
build from source:

~~~sh
git clone https://github.com/noctem-o/endophasia.git && cd endophasia
npm ci && npm run build
node scripts/seed-cockpit-demo.ts ./demo-store    # optional: a demo store from committed fixtures and the Pi 1.0.0 specimen; no Pi needed
node dist/cli/index.js studio ./demo-store        # prints one private address on stdout; open it in a browser
~~~

Omit the store to read the default one that `endo harness attach` writes. Studio listens on loopback only and prints its
address once; anyone who can read that address can read the store, so treat it as a secret. It never writes the store it
reads. The one thing it creates is its own comparison key, on first launch, and it says so. Complete first-run guide:
[docs/install.md](docs/install.md). Studio arguments, key handling and limits: [docs/studio.md](docs/studio.md).

## What works today

Maturity is stated by the **evidence** behind each row, because that is what differs:

- **Real runtime:** exercised against a real Pi. The CI `acceptance` job runs the installed package against a separately
  installed **Pi 1.0.0** and a local fake model endpoint (no credentials, no provider cost). The research studies used
  **Pi 1.0.1** with one local model on one machine.
- **Deterministic:** exercised only against a fake Pi, a fake agent or committed fixtures.
- **Library:** implemented and unit-tested, but not reachable from any command or from Studio.
- **Not built:** designed or planned, with no implementation.

| Capability | Reached through | Evidence |
| :--- | :--- | :--- |
| Pi attachment: runtime identity, change records, evidence invalidation, capability admission | `endo doctor`, `endo harness check\|attach\|status` | Real runtime (Pi 1.0.0 acceptance; Pi 1.0.1 studies) and deterministic suites |
| Recorded sessions: durable store with validated recovery, lifecycle events, session overview | `endo harness overview`; `endo status\|events\|ledger` | `harness overview`: real runtime. The others: deterministic (no command writes a ledger yet) |
| Trajectory show and diff, layer by layer | `endo trajectory show\|diff` | Real recordings; hostile cases against the fake Pi only |
| Capture and cassette replay | `endo proxy record\|replay`, `endo replay` | Real runtime: 40 replays EXACT, plus a negative control that diverged as it should |
| Experiments: specs, blocked randomisation, manipulation checks, pinned environments (the studies pre-registered their designs; the CLI does not enforce that) | `endo experiment run\|report` | Real runtime: the studies below. Also writes evaluation records |
| Authorised steering: STEER, QUEUE, STOP | `endo harness attach --control` with `endo steer`; or an experiment's declared intervention | Real runtime for the intervention desk, driven by `endo experiment run` (the steering study) and the lifecycle recorder (STOP). The `attach --control` / `endo steer` endpoint is tested against the fake Pi only. v0 proposals come only from the operator; an external authority provider is a documented seam, not wired |
| **Studio**: one read-only observation page | `endo studio` (`0.1.0-alpha.2` and later, or a source build) | Real Pi 1.0.0 acceptance (fake model endpoint) serves a real-Pi store and, where Chromium exists (it does in CI), loads it in a real browser; the page's own tests |
| ACP v1 adapter (`adapters/acp`) | none; a library | Deterministic fake agent; an opt-in smoke against real OMP that CI does not run. No capability admitted from it |
| ACP v2 conformance study | none; a library; experimental, against a Draft protocol | Deterministic fake agent only; no real v2 agent. No capability admitted from it |
| Cognition graph; evolution and promotion records and selection policies (the CLI can read an evidence ledger, but no command writes one); Codex, Prime, REEF, Magpie, Deadbolt and Cogitator record mappings; model orchestration; an OpenAI-compatible provider adapter; the unwired scene state in `visualization/` | none; libraries | Unit tests only. The sealed Prime 0.9.7 study admitted no exact capability |
| Studio modes beyond the first page; model-internal observation; WebGPU rendering; WORK and DREAM policies; an EVOLVE operator interface; forkable checkpoints | none | Not built |

Some of the distinctions that matter when reading the table:

- **Replay.** Exact cassette replay reproduces a session under its *recorded* responses. It says nothing about whether a live
  run would repeat, or whether behaviour survives an irrelevant change. Those are separate measurements.
- **Steering.** An intervention is a chain of separate records: a proposal, an authorisation bound to its exact digest, the
  request, the runtime's acceptance, the consumption the recording proxy shows, and the consequence. Acceptance is not
  execution, and an effect is only what the trajectory afterwards shows.
- **OBSERVE.** What exists is harness-level observation: lifecycle, context, tools, usage and trajectories. That is not
  model-internal interpretability. Residual-stream capture, logits and probes would be provider-specific and capability-gated, and
  none is implemented.
- **EVOLVE.** Records, selection policies and promotion gates exist as libraries. Nothing in this repository is a working
  autonomous self-improvement system.

The implementation detail, limits included, is in [docs/status.md](docs/status.md).

## Architecture

~~~mermaid
flowchart TB
    subgraph native["Native harness, installed and run by you"]
        H["Pi<br/>its own execution loop"]
    end
    subgraph record["Recording"]
        A["Adapter<br/>identity · lifecycle events"]
        X["Recording proxy<br/>optional, in front of the model"]
    end
    M["Model endpoint<br/>provider or local server"]
    S[("Durable store<br/>events · evidence · registry · cassettes")]
    V["Evidence and projections, read-only<br/>capability state · trajectories · replay · experiment reports<br/>the observation bridge"]
    C["endo CLI"]
    N["Local HTTP boundary<br/>127.0.0.1 · private address · GET only"]
    U["Studio<br/>one read-only page"]

    H -->|"documented RPC"| A
    H -.->|"model requests"| X
    X -.-> M
    A --> S
    X --> S
    S --> V
    V --> C
    V --> N
    N --> U
    C -.->|"authorised STEER · QUEUE · STOP"| A
~~~

The harness keeps its own execution loop. The commands that record (attach, check, the proxy, steering, experiments) write to
the store; the reporting commands and the observation bridge open it read-only. The only data the HTTP boundary serves is the
bridge's projection, so Studio can show nothing that projection does not carry. Apart from starting sessions (attach, replay,
experiments), Endophasia acts on a running session only through an authorised STEER, QUEUE or STOP at the intervention desk,
reached from `endo steer` (the dotted path) or from an experiment's declared condition, and never through Studio.

Capabilities are admitted only on current evidence, in order: transport, then identity, then local protocol checks, then a
live study if you ask for one, then admission. When the installed runtime or its configuration changes, the evidence that
depended on it stops counting and says so. How that works, with the Pi conformance table: [docs/attachment.md](docs/attachment.md).

## Research direction

The long-term ambition is a reproducible way to study coding agents as systems: what the harness and the model contribute,
how to observe both without confusing measurement with interpretation, and how to change them under explicit, evidence-backed
gates. These six words name the directions. Where each stands today:

<a id="roadmap"></a>

| Word | What it names | Today |
| :--- | :--- | :--- |
| **DEVELOP** | The current session: what the agent is doing, what the runtime reported, whether to intervene | Observation and authorised steering from the CLI. Studio's read-only page shows recorded sessions but is not a DEVELOP mode |
| **OBSERVE** | The measurement surface: what was recorded and what can be derived reproducibly | Harness level: implemented. Model-internal signals: design only ([docs/observe.md](docs/observe.md)) |
| **VERIFY** | What the observations justify: replay, repetition, perturbation invariance, comparison | Replay, trajectory comparison and experiments implemented; causal interventions at a checkpoint need forkable checkpoints, not built |
| **EVOLVE** | Explicit candidate, evaluation, admission and promotion, never silent self-modification | Records and policies as libraries; no operator interface ([docs/evolve.md](docs/evolve.md)) |
| **WORK** | A cognition policy: one bounded main trajectory | Planned |
| **DREAM** | A cognition policy: wider search with counterfactual branches | Planned |

The chain for any adaptation loop is longer than "the score went up", and every link is its own record:
grader evidence is not reward, reward is not selection, selection is not promotion, and promotion is not authority.

**What the studies have found so far.** All of it comes from Pi 1.0.1, one local model (qwen3.8-27b on llama.cpp) and one
machine, so none of it is a statement about other runtimes or models. The full designs, results and caveats are in
[research/README.md](research/README.md).

- [Variance](research/README.md#variance-study-e2) and [pinned environment](research/README.md#pinned-environment-study-e3):
  runs were "unstable" under every arm, from sampling and then from tool output that carried wall-clock values; with the
  environment pinned, sampling deterministic and the cache off, every judged layer and every request was identical across the
  20 trials of each of three small tasks. That is an observation under a declared condition, not a claim that intrinsic noise
  is zero.
- [Steering](research/README.md#steering-study) and [path sensitivity](research/README.md#path-sensitivity-study): in the
  deterministic condition a STEER and a QUEUE were consumed where Pi documents (80 of 80 steered trials). A QUEUE was followed at
  every path; whether a STEER was followed varied by task and with the working-directory path (27 of 30 paths on one task, 6 of
  30 on the other), and on one task the path changed the baseline too. Two tasks, one message each, one point.
- [Discriminating tasks](research/README.md#discriminating-task-study) and the [completion cap](research/README.md#completion-cap-study):
  of 12 small tasks only two discriminate for this model (13 of 20 and 7 of 20), and, in a post-hoc reading that was not
  pre-registered, 21 of the 25 failures on the advancing tasks were responses cut off at Pi's default completion cap. Raising
  the cap from 16,384 to 32,768 tokens raised success on those two tasks from 10 of 24 to 19 of 23 (pooled over four paths at
  3 trials per cell; the interval excludes 0 only with all four paths included).

The next delivery step is forkable checkpoints, beneath counterfactual comparison and evolution work. The full sequence, the
numbered capability map and the deferred research tracks are in [docs/roadmap.md](docs/roadmap.md). One proposed, not yet run
study (a shadow epistemic ledger beside a deliberately gameable post-training environment) is in
[research/epistemic-alignment-experiment.md](research/epistemic-alignment-experiment.md).


### Candidate study: durable execution compatibility (not implemented)

[Vercel's `durable-harness`](https://github.com/vercel-labs/durable-harness)
([design explanation](https://vercel.com/blog/making-every-harness-durable)) is a candidate *external execution layer*
to investigate, starting with its Pi/`pi-durable` integration. It records model/tool-call intents and outcomes in a
Workflow SDK World and can resume interrupted turns. This is **not** Endophasia's durable observation store or cassette
replay: those can reconstruct and compare *recorded behaviour*, but do not themselves provide automatic mid-turn
continuation. No compatibility, adapter support or execution durability is currently claimed.

A bounded, opt-in compatibility study should:

1. Pin the experimental `durable-harness` and Pi versions; use a local World, a fake model endpoint and a synthetic
   workspace, without adding a required runtime dependency or changing Endophasia's harness-owned execution loop.
2. Check whether the existing Pi attachment can observe the durable runtime with authentic identity, lifecycle and
   capability evidence. If the interface or evidence is absent, record `UNAVAILABLE` rather than asserting support.
3. Inject process death before a call, during a tool call, after an external effect but before its outcome is recorded,
   and during recovery. Compare World records, Endophasia's observed trajectory and the actual external effects.
4. Distinguish completed, not-started and *outcome-unknown* operations; test declared safe retries versus never-retry
   operations, reconciliation/idempotency where available, and possible duplicate side effects. Neither a retry policy
   nor a durable intent alone proves exactly-once execution.
5. Verify ordering, session continuity, provenance of reconstructed events, interruption/recovery attribution and
   divergence classifications. Keep **execution resumption**, **exact cassette replay**, **live repeatability** and
   **perturbation invariance** as separate claims.

Only consider a private, self-hosted Postgres World after the local test demonstrates a useful observable boundary.
This is a research candidate, not the next delivery milestone: forkable checkpoints remain next, and Endophasia
remains the observer rather than becoming the execution engine. The upstream package is currently experimental
(`0.0.x`); revisit its interfaces and security properties before any integration.

## Documentation

<a id="current-state"></a>
<a id="try-it"></a>

**Using it**
[Install and first run](docs/install.md) ·
[Studio](docs/studio.md) ·
[Release notes and procedure: 0.1.0-alpha.2, Studio](docs/release-0.1.0-alpha.2.md) ·
[Alpha release scope and verification](docs/release-alpha.md) ·
[v0.1.0-alpha.1 release notes](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1) ·
[Changelog](CHANGELOG.md)

**What is implemented, and how it works**
[Status, in detail](docs/status.md) ·
[Attaching and evidence admission](docs/attachment.md) ·
[Capture and replay](docs/replay.md) ·
[Trajectories](docs/trajectory.md) ·
[Experiments](docs/experiments.md) ·
[Steering](docs/steering.md) ·
[Schema compatibility](docs/schema-compatibility.md)

**Studio and the observation bridge**
[Observation bridge and local server](docs/cockpit.md) ·
[Page design reference](docs/cockpit-ui.md) ·
[Sequencing after the first slice](docs/cockpit-next-stages.md)

**Adapters and boundaries**
[Pi attach inventory](docs/pi-attach-inventory.md) ·
[Pi attach audit](docs/pi-attach-audit.md) ·
[ACP v1 adapter](docs/acp-v1-slice.md) ·
[ACP v2 study](docs/acp-v2-study.md) ·
[Deadbolt intervention contract](docs/deadbolt-intervention-contract.md)

**Vision and design** (intent, not implementation)
[Vision and distinctions](docs/vision.md) ·
[OBSERVE and VERIFY](docs/observe.md) ·
[EVOLVE](docs/evolve.md) ·
[Roadmap](docs/roadmap.md)

**Research**
[Real recordings and studies](research/README.md) ·
[Where the raw run data lives](research/DATA.md) ·
[Epistemic alignment experiment (proposed)](research/epistemic-alignment-experiment.md) ·
[Developmental epistemic training v0 (proposed)](research/developmental-epistemic-training-v0.md) ·
[Migration ledger](docs/migration-ledger.md)

**Neighbouring projects**, each with its own job, none granting another authority:
[Magpie](https://github.com/noctem-o/magpie) (claims, evidence and derived standing) ·
[Deadbolt](https://github.com/noctem-o/deadbolt) (authorising consequential actions) ·
[Cogitator](https://github.com/noctem-o/cogitator) (sealed run records) ·
[Buzz](https://github.com/noctem-o/buzz-prime) (a shared workspace for people and agents).

## Development

`npm ci`, then `npm test` (needs only Node and git; no network, no API key) and `npm run typecheck`. The opt-in checks against
your own Pi (`ENDO_PI_EXECUTABLE=$(command -v pi) npm run test:pi-real`) and the host-dependent tests are described in
[docs/install.md](docs/install.md#running-the-tests).

## License

MIT. Upstream components such as Pi remain under their own licenses.
