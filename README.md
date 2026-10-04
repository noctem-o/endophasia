<a id="endophasia"></a>

<div align="center">

<p><sub>DEVELOP / EVOLVE &nbsp; · &nbsp; WORK / DREAM &nbsp; · &nbsp; OBSERVE / VERIFY</sub></p>

<h1>endophasia</h1>

<p><strong>Instrumented cognition for coding agents.</strong></p>

<p>
Observe agent runtimes, steer current work, compare experiments,<br>
and keep evidence separate from permission.
</p>

<p>
  <a href="#current-state"><img src="https://img.shields.io/badge/status-experimental-637d69?style=flat-square" alt="Status: experimental"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/reference%20runtime-Pi-536c85?style=flat-square" alt="Reference runtime: Pi"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94765e?style=flat-square" alt="License: MIT"></a>
</p>

<p>
  <a href="#why-endophasia">Why</a> &nbsp; · &nbsp;
  <a href="#how-it-attaches">Attach</a> &nbsp; · &nbsp;
  <a href="#develop-and-evolve">Develop / Evolve</a> &nbsp; · &nbsp;
  <a href="#work-and-dream">Work / Dream</a> &nbsp; · &nbsp;
  <a href="#evidence-and-authority">Evidence</a> &nbsp; · &nbsp;
  <a href="#current-state">Status</a> &nbsp; · &nbsp;
  <a href="#roadmap">Roadmap</a>
</p>

</div>

---

Endophasia is a runtime-neutral substrate around coding-agent harnesses.

It records what a harness actually does, evaluates capabilities against
explicit evidence, and keeps observation, experimentation, and authority
as separate layers.

It is not an agent runtime, model provider, benchmark, or deployment system.

Coding agents do more than send a prompt to a model. They select context, compact history, call tools, branch, retry, verify work, spend tokens, accept steering, and sometimes propose actions with real effects.

Endophasia gives those parts explicit contracts and one place to inspect them.

It does not expose private chain of thought. It does not treat every runtime feature as equivalent. It does not turn a benchmark score into truth, or a model's proposal into permission.

> [!IMPORTANT]
> Endophasia is experimental. This repository is the standalone home of the project; the earlier Pi-fork version, which demonstrated the v0 cockpit and observation contracts, lives at [endophasia-pi-legacy-deprecated](https://github.com/noctem-o/endophasia-pi-legacy-deprecated). See [Current state](#current-state) for exactly what runs today, and [Try it](#try-it) to attach to your own Pi.

## Why Endophasia

The project keeps these distinctions explicit:

~~~text
observation  != inference
acceptance   != execution
evidence     != standing
proposal     != permission
history      != active context
configured   != in-flight
simulation   != real execution
evaluation   != promotion
~~~

An observed event is shown as an observation. A derived value says how it was derived. A capability stays unavailable when a runtime cannot meet the contract — Endophasia reports `UNAVAILABLE` rather than filling the gap.

Related projects have separate jobs, and none grants another authority:

| Project | Job |
| :--- | :--- |
| **Endophasia** | Observes, steers, and compares agent runs |
| [Magpie](https://github.com/noctem-o/magpie) | Records claims and evidence; derives standing under explicit policy |
| [Deadbolt](https://github.com/noctem-o/deadbolt) | Decides whether a consequential action is authorised |
| [Cogitator](https://github.com/noctem-o/cogitator) | Seals run records with verifiable witness roots |
| [Buzz](https://github.com/noctem-o/buzz-prime) | Shared workspace where humans and agents coordinate around runs |

## How it attaches

Endophasia is a substrate, not a runtime. It attaches to agent harnesses you already run, through explicit adapters.

~~~mermaid
flowchart TB
    R["Harness you install<br/>Pi · Codex · Prime"] --> A["Endophasia adapter"]
    A --> S["Endophasia services<br/>events · evidence · graph"]
    S --> C["Operator CLI · cockpit"]
~~~

**You install and update harnesses with your normal method. Endophasia never installs, updates, downgrades, patches or
rebuilds one.** It finds the executable you selected (`--pi /path`, or `pi` on `PATH`), records its identity, launches
it in its documented RPC mode when you ask, and records what it does.

Each attachment records a fingerprint: facts from your installation (resolved and real path, a SHA-256 of the
entrypoint file, the package manifest) kept apart from what the runtime reports (`pi --version`), with every missing
fact listed rather than guessed. When the fingerprint differs from the last one for that attachment, Endophasia
records the change, marks the evidence that depended on it unverified, and tells you, for example:

~~~text
Pi runtime changed

  Previously observed: 1.0.0 / fingerprint 0d1bcf47a86d (strong identity) at …/dist/bundle/cli.js
  Currently detected: 1.0.1 / fingerprint 7c2e91a0b4f3 (strong identity) at …/dist/bundle/cli.js
  Differences: package, version; version order: higher; version standing: unverified-release
  Previous conformance evidence may no longer apply. Capabilities dependent on that evidence are now unverified.
  Endophasia will not install, update, downgrade or replace Pi. If you want a different version, use your normal installation method.
~~~

A changed fingerprint says the runtime differs. It does not say an update is available, and it does not say the new
runtime is incompatible. A capability can be unverified even when the runtime starts and answers.

Capabilities are admitted only on current evidence, in this order:

~~~text
transport  →  identity  →  local protocol checks  →  live study (on request)  →  capability admission
~~~

- **Local protocol checks** run automatically: an ephemeral, offline Pi with no tools answering state, cursor and
  configuration commands. No prompt, no provider call, nothing persisted.
- **The live study** sends prompts, runs a read-only tool in a scratch workspace and calls your configured model
  provider, so it may cost money. It runs only when you pass `--authorize-live-study`.

Evidence also depends on your Pi configuration (settings, model endpoints, MCP servers, system prompts, extensions;
never credentials), the adapter and suite versions, and the definition of the check that produced it. When any of
these change, the evidence that depended on it stops counting. When several checks speak to one capability, the most
conservative result decides; a check replaces another only where it is declared to re-test the same property more
broadly.

Every recorded run carries the fingerprint that produced it, so results from before and after a change are never
silently treated as comparable.

| Runtime | Role |
| :--- | :--- |
| Pi | Reference runtime, attached over `pi --mode rpc`. Verified baseline: Pi 1.0.0 (other releases earn admission on their own evidence) |
| Prime | Research subject. The sealed 0.9.7 study admitted no exact capability. |
| Codex | Future candidate, pending its own pinned study |

What the evidence recorded against one Pi 1.0.0 installation establishes, with Pi's provider pointed at a local fake
endpoint ([recording and its scope](research/pi-conformance/1.0.0/README.md), [mapping](docs/pi-attach-inventory.md)).
That recording was made under mapping `pi-rpc-mapping.1` and is kept unchanged as a historical specimen. The current
mapping is `pi-rpc-mapping.2`, so its evidence no longer applies to a current attachment, which re-earns its own.
It is evidence for that installation and configuration, not a promise about yours: your Pi starts unverified and is
checked on its own.

| Capability | Status | Why not exact |
| :--- | :--- | :--- |
| Session identity, entry cursor, per-entry usage, tool activity, model control | admitted (exact), within the recording's scope | model control exercised by re-selecting the configured model only |
| Active path / continuity, thinking control | admitted (qualified) | context boundary derived from compaction entries; only one thinking level was available to exercise |
| Lifecycle trace, session overview, metrics | admitted (partial) | no run or turn ids; one session, no lanes; total cost only |
| Steer, follow-up, stop | admitted (partial) | no receipt ids; abort cannot target a specific run |
| Active-tool control, run identity, operation outcomes | unavailable | not exposed over RPC |

"Nothing matched exactly" is a valid research result.

## Develop and Evolve

DEVELOP and EVOLVE describe what the user is doing, not which software runs.

**DEVELOP** is the current session: what the agent is doing now, what the runtime actually reported, what context was used, and whether to intervene. Steering is explicit:

~~~text
STEER  change the active trajectory
QUEUE  deliver work at the next follow-up boundary
STOP   request an abort of the observed run
~~~

A receipt records that the runtime accepted the request. It does not claim the effect happened.

**EVOLVE** is the system-level improvement loop. It treats prompts, cognition policies, harness components, tools, memory, models, environments, and execution strategies as explicit candidate changes rather than hidden self-modification.

It follows a visible sequence:

~~~text
observe → propose → isolate → evaluate → compare → admit → promote
~~~

Promotion is deliberately last. A candidate can win an evaluation and still lack permission to replace anything.

EVOLVE is intentionally broader than reinforcement learning. RL can be one adaptation mechanism; RSI is a broader research direction covering repeated improvement of the model, harness, cognition policy, tools, memory, scaffolding, or execution strategy. Endophasia provides the substrate around these mechanisms: trajectories become evidence, evidence becomes evaluation input, and promotion remains gated.

The intended loop is:

~~~text
cognitive state
      ↓
what is uncertain?
      ↓
what evidence is missing?
      ↓
what experiment is useful?
      ↓
what should we spend?
      ↓
trajectory / experience
      ↓
evidence
      ↓
evaluation
      ↓
adaptation
      ↓
new cognition
      └───────────────────────↺
~~~

### Evolve providers

EVOLVE must not require one benchmark runner, adaptation framework, sandbox, or trainer. Provider contracts should let users install only the parts they need; the runtime-neutral core defines the seams and experiment records, not a preferred stack.

~~~mermaid
flowchart TB
    E["Endophasia EVOLVE"] --> R["Runtime"]
    E --> N["Environment"]
    E --> V["Evaluation"]
    E --> A["Adaptation"]
    E --> T["Training, optional"]
    N --> S["Sandbox"]
    V --> O["Experiment record"]
    A --> O
    T --> O
~~~

These projects are reference points for future adapters, not dependencies or bundled components. Names indicate candidate roles, not a commitment to support every project.

| Job | Candidate provider |
| :--- | :--- |
| Run packaged agent benchmarks | [Harbor](https://github.com/harbor-framework/harbor) |
| Large optional agent-environment pack | [MiMo-V2.6-RL-oss](https://github.com/XiaomiMiMo/MiMo-V2.6-RL-oss) |
| Connect existing agents to rollout and training infrastructure | [Uni-Agent](https://github.com/verl-project/uni-agent) and [mimoagent](https://github.com/XiaomiMiMo/mimoagent) |
| Run isolated environments | Local Docker, CubeSandbox, or another sandbox provider |
| Simulate agent environments | [Qwen-AgentWorld](https://github.com/QwenLM/Qwen-AgentWorld) |
| Generate and select harness candidates | [REEF](https://github.com/Human-Agent-Society/reef), [RRSI](https://github.com/google-research/rrsi), or another adaptation provider |
| Train model weights | [verl](https://github.com/volcengine/verl), [ROLL](https://github.com/alibaba/ROLL), [Molt](https://github.com/NVIDIA-NeMo/labs-molt), or another training provider |

Large datasets, container images, local models, and training stacks are optional downloads. Selecting a MiMo experiment should fetch a pinned pack or only the required subset; installing Endophasia must not fetch the pack implicitly. Providers should expose their own setup and resource requirements rather than making them hidden core dependencies.

A stored experiment should identify the exact inputs needed to interpret and reproduce its result:

- candidate revision;
- runtime and model identity;
- cognition policy;
- environment pack and revision;
- sandbox image or template identity;
- evaluator and grader identity;
- seeds and run count;
- usage and wall-clock time;
- result-bundle digest.

A simulated environment must be labelled as simulated. A world-model result must never be presented as a real execution result. The record should preserve which provider produced each observation and which evaluator judged it; neither a successful simulation nor an evaluator score is, by itself, proof of real-world performance or permission to promote a candidate.

Adaptation methods, including GEPA-style selection, RL training, self-play, and bounded recursive self-improvement, can share these provider seams when their inputs and outputs can be represented honestly. They remain optional and must be evaluated against the same explicit experiment and evidence contracts.

### Evolution evidence

The evolution substrate is designed around explicit records rather than an opaque optimizer:

| Concept | Endophasia role |
| :--- | :--- |
| **EnvironmentPack** | Versioned task/environment definition and evaluation conditions |
| **Episode / Trajectory** | Recorded interaction between a harness, model, tools, and environment |
| **ExperienceStore** | Durable collection of trajectories and derived evidence |
| **Candidate / Mutation** | Proposed change to a policy, prompt, harness, tool, model, or execution strategy |
| **Evaluator / Grader** | Explicit source of outcome evidence |
| **Selection policy** | Deterministic decision over candidate evidence; the in-tree policies are a baseline and RRSI- and GEPA-inspired rule sets, not ports of either method |
| **Validation and promotion holdout** | Selection may read validation results; the promotion holdout is never given to a selection policy, so a promotion can be checked against data the search never saw |
| **Promotion gate** | Explicit authority boundary after evaluation; evaluation does not imply execution |

Resource use is evidence too. Token usage, model calls, tool calls, branches, retrieval, tests, critics, retries, wall-clock time, and cost can be recorded as part of the trajectory. This makes **Compute Appetite** a bridge between DEVELOP and EVOLVE: a cognition policy can decide how much computation to spend, while EVOLVE can test whether that expenditure actually improves outcomes.

The goal is not autonomous rewriting for its own sake. The goal is **bounded, reproducible, evidence-backed improvement**.

## Work and Dream

WORK and DREAM are planned cognition policies, separate from DEVELOP and EVOLVE.

**WORK** keeps one main trajectory, bounds exploration, and runs deterministic checks early.

**DREAM** allows broader search, more retained hypotheses, counterfactual branches, and stronger falsification.

~~~text
more cognition != more authority
more branches  != more truth
more agreement != more permission
~~~

Visualisations of either mode are projections of recorded state. If a model does not expose a signal, the view says so; it never invents cognition to make the scene look interesting.

## Evidence and authority

These are four different statements, and Endophasia keeps them as four different records:

~~~text
candidate c17 passed 43 of 50 trials          evaluation result
candidate c17's result bundle has digest X    mechanically checkable
candidate c17 is supported under policy P     epistemic conclusion  (Magpie)
candidate c17 may replace the current version authority decision    (Deadbolt)
~~~

Plans are not effects:

~~~mermaid
flowchart TB
    I["Model intent"] --> P["Structured proposal"]
    P --> R["Review and policy"]
    R --> A["Authority check"]
    A --> E["Real effect"]
    E --> C["Receipt"]
~~~

A valid proposal does not widen the model's permission.

## Current state

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
  [rules](docs/trajectory.md)).
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
- **Capture and cassette replay** ([how it works](docs/replay.md)).
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
- **Experiments** ([how they run](docs/experiments.md)).
  - `endo experiment run` runs a spec (`endo.experiment-spec.v0`): tasks with optional deterministic success checks,
    conditions expressed only through Pi's documented configuration, and N trials. Every trial is a fresh live Pi
    session recorded through the capture proxy, so each one is also a cassette.
  - The order is blocked-randomized with a recorded seed. A run resumes after interruption without duplicating trials.
  - `endo experiment report` aggregates the trials with the trajectory comparison. Per judged layer it gives the
    pairwise exact-match rate (95% Wilson) and the trial-level modal agreement. It also gives the first divergences,
    outcomes, the check pass rate, and usage and timing as median and IQR, never judged. The bundle uses the existing
    evaluation records.
  - It has run for real in the variance study below (360 trials), the pilot and a smoke test.
- Tests: a deterministic suite with a fake Pi child process and a fake OpenAI-compatible endpoint, plus an opt-in
  acceptance suite against a real installed Pi. The real Pi 1.0.0 recording (mapping.1, a historical specimen pinned by digest) is in
  `research/pi-conformance/1.0.0/`.

**Implemented as libraries, exercised only by unit tests:** nothing in the CLI or the Pi attachment calls these yet. A
typed cognition graph; evaluation, evolution and promotion records with a baseline selection policy and RRSI- and
GEPA-inspired rule sets (not ports of RRSI or GEPA; see `evolution/policies/rrsi-inspired.ts`); trust-record mappings
for Cogitator, Magpie and Deadbolt; model orchestration, routing and collaboration records; record mappings for Codex,
Prime and REEF; and an OpenAI-compatible provider adapter (whole SSE bodies are buffered, no incremental streaming).
Three protocol schemas (`protocol/{continuity,control,runtime-profile}.ts`) and the fork-era lane overview in
`protocol/session-overview.ts` are planned surfaces with no producer at all. Their fork-era producers were removed;
they are kept for the steering and replay work and the sealed Prime study.

**Simulated, not real:** the deterministic suites' Pi is a fake that speaks Pi 1.0.0's documented records; passing them
says nothing about another Pi release. The real-runtime check covered one Pi 1.0.0 installation on Linux with Node 22,
an otherwise empty Pi configuration, no extensions, and Pi's model provider pointed at a local fake endpoint; no real
model was called.

The session lifecycle has one real recording (`research/pi-conformance/1.0.1/lifecycle/`, see
`research/pi-conformance/LIFECYCLE.md`). It ran Pi 1.0.1 against a real model: qwen3.8-27b on llama.cpp's
OpenAI-compatible server, with reasoning on, on Linux. Its three sessions came out as follows:
- **completes:** a run completed with Pi's own `stop`.
- **stop-mid-turn:** a STOP, after which Pi reported its own `aborted` termination. Pi acknowledged the abort only
  after `agent_settled`, as its documentation says.
- **killed-and-resumed:** Endophasia was killed mid-turn, and the next attach recorded the interruption and the
  resume, with deduplicated catch-up.

That is one Pi release, one model and one machine. The failure, retry, compaction and unknown-record paths have been
exercised only against the fake Pi (`tests/fixtures/pi-lifecycle/`).

Four real sessions were recorded with their cassettes (`research/pi-conformance/1.0.1/cassettes/`): completes,
stop-mid-turn, killed-and-resumed and tool-use. The tool-use session reads, edits and runs `wc -l` on a file in the
scratch workspace, so "tools EXACT" is not vacuous there. Each session was replayed 5 times as-recorded and 5 times
immediate against the same Pi 1.0.1. All 40 replays were EXACT on lifecycle, tools and outcome, with no cassette miss
and no flag. A real negative control was also run: the workspace file was changed before Pi started. That replay
diverged at the read's result digest, followed by an explicit cassette miss.

**What these replays establish:** with the model's responses held fixed, this Pi release reproduced its control flow
for these scenarios on one machine.

**What they do not establish:**
- anything about the model, whose outputs are held fixed;
- tool effects outside the scratch root;
- the behaviour of nondeterministic tools;
- behaviour on another machine, Pi release or configuration.

A first variance study ([design](research/variance/1.0.1/DESIGN.md), [results](research/variance/1.0.1/RESULTS.md))
ran Pi 1.0.1 with qwen3.8-27b on three small synthetic tasks: 20 live trials per task under each of three arms. The
arms were Pi's defaults, temperature 0 with a fixed seed, and that plus llama.cpp's prompt cache off; documented Pi
extensions changed the requests, and manipulation checks passed.

**Under Pi's defaults**, every pair of runs first differed at a model reply: sampling.

**With temperature 0 and a fixed seed**, no identical request got a different reply (1,140 pairs). Lifecycle and
outcome were identical in 20 of 20 trials on every task. What still varied on the coding tasks was tool output (test
durations, file timestamps). It fed back into the next request, and with the prompt cache on it sometimes changed
which tool calls followed.

The pre-registered verdict is "unstable" under every arm, because the tools layer of the coding tasks varies. Every
trial passed its success check.

Two findings came out of the study:
- **A proxy bug.** The recording proxy had delayed relaying the server's connection close, which caused Pi
  `Connection error.` turns. It was fixed, and the affected run was discarded and repeated.
- **A replay limit.** Replay cannot reproduce sessions whose tools print wall-clock values. All three spot-check
  replays of coding-task trials ended in an explicit cassette miss.

This is one Pi release, one model and quantization, one machine and N = 20.

The earlier `completes-repeat` runs, made under a deleted scratch key, were retired. The hostile trajectory cases
(reordered or different tool calls, different result content, missing usage, another Pi version, another digest
domain) are exercised only against the fake Pi (`tests/fixtures/trajectory/`).

The boundary and the evidence rules were audited adversarially ([audit](docs/pi-attach-audit.md)), including the
limitations accepted for now.

**Not yet built:** the Endophasia-native cockpit over its own store ([target](docs/cockpit.md); the fork-era cockpit
spoke Pi's private services and was removed, and the operator view today is `endo harness status`), an optional Pi
extension for active-tool control,
any live provider integration wired into a command, WORK / DREAM policy compilation, the full trajectory / experience laboratory, RL training-provider
integration, and attachments for other harnesses.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.

## Roadmap

Done:

1. **Attach model.** Pi attached over its documented RPC mode; the vendored fork removed
   ([inventory and decisions](docs/pi-attach-inventory.md)).
2. **Harness version tracking.** Fingerprints, change records, evidence invalidation and re-checking, audited
   adversarially ([audit](docs/pi-attach-audit.md)).

Partly done:

3. **First end-to-end slice.** A real Pi session is recorded into the durable store and replayed; the cognition graph
   and a cockpit over that store are not wired yet.

Next:

4. **Real Pi path.** Make the first vertical slice boring: observe a real session, record canonical evidence,
   steer where the runtime supports it, interrupt, recover, and preserve explicit permission boundaries.
5. **Replay first-class.** Make deterministic replay and differential replay part of the core research workflow,
   including explicit divergence between two runs.
6. **Evaluation laboratory.** Define reproducible experiment bundles containing runtime/model/configuration, task,
   initial state, evidence, outcome, evaluator identity, seeds, usage, and analysis. Every research claim should
   point back to evidence.
7. **Cognition controls.** Bring the runtime-neutral DEVELOP controls into the substrate: Reasoning, Epistemic
   Rigour, Explore, Verify, Compute Appetite, Tool Initiative, Dream Mode, Latent Deliberation, and honest
   J-space profiles where the underlying model can expose them. WORK / DREAM remain policies over these controls,
   not hidden model state.
8. **Steering protocol.** Separate observation → interpretation → proposal → authorization → steering → observed
   consequence. A proposal never becomes permission implicitly.
9. **Cross-runtime conformance.** Study Pi, Codex, Prime, and other adapters against the same evidence contracts,
   with capability admission based on current evidence rather than names or assumptions.

EVOLVE / research loop:

10. **Trajectory and experience substrate.** Make EnvironmentPack, Episode, Trajectory, ExperienceStore,
    candidate/mutation, evaluator, and result-bundle records first-class and reproducible.
11. **Reference evolution policies.** Exercise the baseline and the RRSI- and GEPA-inspired rule sets against real
    experiment bundles, including validation, an untouched promotion holdout, noise/leakage checks, and deterministic selection. A faithful
    RRSI policy needs a calibrated per-instance noise band and its cost rule, which need cost evidence the policy
    context does not carry yet.
12. **Adaptation providers.** Add provider seams for RL training and other adaptation methods without making any one
    algorithm part of the Endophasia core.
13. **Resource-aware cognition.** Feed token/model/tool/branch/test/retry/cost evidence into Compute Appetite and test
    whether different cognition policies trade resources for reliable outcome improvements.
14. **Adversarial / co-evolution experiments.** Support bounded self-play or attack/control loops where monitors,
    evaluators, or environments can improve alongside the agent, while promotion-holdout evidence remains outside the
    adaptation loop.
15. **Bounded recursive improvement.** Allow model ↔ harness ↔ cognition-policy improvement cycles only through
    explicit candidates, evidence, comparison, admission, and promotion gates. No implicit self-replacement.



Hardening and artifact:

16. **Adversarial audit.** Test identity, evidence provenance, stale or forged evidence, duplicate/out-of-order
    events, replay divergence, unauthorized execution, false verification claims, and stale evidence inheritance.
17. **Research artifact.** Produce a complete baseline → observation → failure → evidence → candidate → evaluation →
    comparison → promotion decision trail that another researcher can replay.

### Experimental research tracks (deferred; not commitments)

These are candidates for a separate EVOLVE experiment mode, not features to build before the core
runtime → replay → evaluation loop is reliable. Each track should use the same candidate, trajectory,
evaluation, resource-accounting, and promotion contracts. Start with small, falsifiable experiments;
do not import a framework merely because its paper reports a benchmark gain.

18. **Experience-derived skill evolution.** Compare a versioned skill bank against no skills, static
    skills, and simple trajectory retrieval. Extract, merge, retire, and select procedural skills from
    successful *and failed* episodes. Record provenance, applicability conditions, counterexamples,
    and the tasks used to validate each skill. Useful starting points: [CODESKILL](https://arxiv.org/abs/2605.25430),
    [Socratic-SWE](https://arxiv.org/abs/2606.07412), and [MUSE-Autoskill](https://arxiv.org/abs/2605.27366).

19. **Episodic + semantic memory.** Test retrieval of similar past cases alongside compact, reusable
    lessons, with ablations for each channel and no-memory baselines. Measure retrieval precision,
    stale advice, context cost, and transfer to unseen repositories. Candidate references:
    [ExpeRepair](https://github.com/ExpeRepair/ExpeRepair) and
    [Memento](https://arxiv.org/abs/2508.16153). Keep stored observations distinct from inferred
    lessons, and make every memory item traceable to its source episodes.

20. **Search-time planning and branching.** Compare one main trajectory with bounded alternatives,
    tree search, or iterative refinement. Test whether extra branches improve verified outcomes enough
    to justify their tool calls, tokens, latency, and failure surface. Start with
    [SWE-Search](https://arxiv.org/abs/2410.20285); keep branch budgets and stopping rules explicit.

21. **Agent architecture and workflow search.** Explore candidate combinations of planner, memory,
    tool-use, verification, and orchestration components. Maintain an archive of variants and their
    evidence rather than retaining only the latest winner. References: [AgentSquare](https://arxiv.org/abs/2410.03992),
    [A Self-Improving Coding Agent (SICA)](https://arxiv.org/abs/2504.15228), and the
    [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954). Run candidate edits in disposable,
    isolated worktrees; never let an unvalidated candidate rewrite the active installation.

22. **Evaluator and task-set co-evolution.** Investigate agents that propose new tasks, edge cases,
    tests, or adversarial environments as well as changes to the agent itself. Treat generated tests as
    hypotheses, not trusted ground truth: independently validate them, test for evaluator gaming, and
    keep a sealed promotion holdout outside both candidate search and evaluator tuning.

23. **Writable procedural memory.** Test whether versioned scripts, repository maps, and executable
    skills outperform prose-only memory. Begin with small, reviewable artifacts and explicit execution
    permissions; do not reproduce a complex writable-memory architecture until simpler approaches show
    a measurable limitation. A research lead is [Spotlight: Memory](https://www.percepta.ai/blog/spotlight-memory).

24. **Model adaptation / training providers.** Once runtime experiments have enough clean data, compare
    prompt and policy changes, memory/skill changes, and optional training methods on the same tasks.
    [Finetuning with Sampling](https://arxiv.org/abs/2610.02140) is one candidate for a separate
    training provider, not a dependency of the runtime core. Track data provenance, training cost,
    held-out transfer, and regressions on previously solved tasks.

25. **Evidence lineage and epistemic lifecycle (Magpie integration).** Test whether experiment
    records can support inspectable claims without collapsing measured outcomes, evidence standing,
    and permission into one verdict. Bind claims to exact run manifests, artifacts, evaluator versions,
    and source episodes; track dependencies so changed or invalidated evidence cannot silently support
    downstream conclusions. Compare a minimal evidence ledger with richer lineage and policy-governed
    standing, measuring auditability, invalidation correctness, and unsupported-promotion rate. Keep
    Magpie optional and its current capabilities honest: this track begins with a read-only vertical
    slice, not an assumed complete claim-writing or epistemic-gate implementation. A valid policy
    result establishes only the predicate it actually checks, not general truth or authority.

26. **Metamorphic robustness and causal sensitivity.** Test agents on paired repository variants where
    semantics-preserving changes should not materially alter outcomes, causal evidence changes should
    change the repair, and irrelevant distractors should not redirect it. Validate transformations
    independently; report paired outcome differences, regressions, tool use, latency, and cost, not just
    pass rate. Keep transformation generation separate from trusted checking and adjudication, and
    test transfer across repositories, model families, and harnesses. Research leads include
    [A Jagged Frontier](https://arxiv.org/abs/2608.18389) and the
    [MetaProbe project](https://github.com/huyuelin/MetaProbe); treat submitted or unreviewed work as
    research leads, not established guarantees.

**Common acceptance criteria for every track:** pre-register the hypothesis and baseline; separate
exploration/validation data from an untouched promotion holdout; include repeated fresh trials and
uncertainty; test transfer across tasks and repositories (and, where practical, models or runtimes);
report regressions, tool/token/cost budgets, and safety-check results; preserve failed candidates and
their evidence. Cassette replay tests reproducibility under recorded responses; claims of improvement
must also survive fresh model executions. A benchmark score alone never grants promotion.

**Research index:** [survey of self-evolving coding agents](https://arxiv.org/html/2608.03392v1) for
additional methods and comparisons. Treat reported gains as hypotheses to reproduce, not guarantees
that a method will transfer to Endophasia's runtime-neutral setting.

The ordering is deliberate: runtime truth comes before replay; replay comes before evaluation; evaluation comes before
evolution. The project should not grow another large protocol-only migration before these contracts have survived a real
agent and produced evidence.

## Try it

~~~sh
npm ci
node cli/index.ts harness check  ./endo-root               # identify your `pi` and run the automatic local checks
node cli/index.ts harness status ./endo-root               # identity, last change, capability state (read-only; starts nothing)
node cli/index.ts harness overview ./endo-root             # the recorded session's lifecycle overview (read-only)
node cli/index.ts harness study  ./endo-root --authorize-live-study   # prompts your configured provider: may cost money
node cli/index.ts harness attach ./endo-root --prompt "…"  # record a session into ./endo-root
npm test                                                   # deterministic suite (no Pi, no network, no history)
ENDO_PI_EXECUTABLE=$(command -v pi) npm run test:pi-real   # opt-in check against your installed Pi
~~~

Use `--pi /path/to/pi` to select a non-default executable and `--attachment name` to track several installations
separately.

`npm test` needs only Node and git; it reads no network, no API key and no git history. Two kinds of checks depend on
the host and say so instead of failing:

- Replacing a published conformance reference needs `mv --exchange` (GNU coreutils 9.5 or later on Linux). Where `mv`
  lacks it, the replacement tests are skipped and a test checks that replacement is refused before anything is
  touched. CI runs the exchange tests in a container that has it.
- The Prime 0.9.7 specimen records the donor-repository commit that measured it. Checking the recorded source digest
  against that commit's tree is opt-in: `ENDO_HISTORICAL_PROVENANCE=1 npm test` in a clone that carries the commit
  (this repository does not).

## License

MIT. Upstream components such as Pi remain under their own licenses.
