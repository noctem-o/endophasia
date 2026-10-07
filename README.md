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

Endophasia is a harness-neutral cognition, observation, control and evolution substrate that can attach to agent runtimes without replacing their native execution loops.

It records what a harness actually does, evaluates capabilities against
explicit evidence, and keeps observation, experimentation, and authority
as separate layers.

It is not an agent runtime, model provider, benchmark, or deployment system.

In practice it has become an experimental instrument: a way to ask defensible questions about agent behaviour.
It keeps three properties apart, because they are different claims:

~~~text
exact replay               did the recorded session reproduce under its recorded responses?
fixed-condition repeat     do repeated live runs under the same declared conditions agree?
perturbation invariance    does behaviour hold when an input that should not matter changes?
~~~

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

For any adaptation loop, the chain is longer and every link is its own record:

~~~text
grader evidence != reward
reward          != selection
selection       != promotion
promotion       != authority
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

Independent architectural context for this direction: [*Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents*](https://arxiv.org/abs/2609.00006) (arXiv 2609.00006, a source-code study of eleven systems) separates a harness from a meta-harness, describes the shift from harness-as-tool to harness-as-platform, identifies minimal-core / extension-host designs (Pi among them), and treats memory, verification, extension surfaces and harness evolution as first-class concerns. It also notes ACP increasingly serving as a harness-hosting and interoperability boundary. It does not evaluate Endophasia; it is cited as context for the design, which attaches around a harness's own execution loop instead of replacing it.

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
| ACP v1 agents | A protocol-level adapter (`adapters/acp`) launches any ACP v1 agent command: the PR #37 slice, then semantic coverage with schema-validated updates, capability-gated `session/list`/`resume`/`close`, and explicit EXACT / QUALIFIED / LOSSY / UNREPRESENTABLE loss accounting, pinned to one SDK and schema revision. Tested against a deterministic fake agent; real OMP (`omp acp`) is an opt-in smoke. See [docs/acp-v1-slice.md](docs/acp-v1-slice.md). No capability is admitted from it yet |
| ACP v2 agents | Planned conformance subjects through a protocol-level adapter. ACP v2 is still a Draft protocol: a baseline schema is published and draft additions are layered separately, so any study is explicit, feature-gated and pinned to one exact revision |

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

Evaluation itself can also be an adaptation target. Endophasia treats **evaluator adaptation** as a separate capability from evaluator execution: proposed rubrics, critics, judge programs, or metric expressions are versioned candidates, tested against fixed anchors and held-out evidence, and cannot promote themselves.

| Job | Candidate provider |
| :--- | :--- |
| Run reusable task / solver / scorer evaluations | [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) |
| Run packaged agent benchmarks | [Harbor](https://github.com/harbor-framework/harbor), or an Inspect-native evaluation pack where its task contract fits |
| Run control, sabotage and monitor experiments | [ControlArena](https://github.com/UKGovernmentBEIS/control-arena), built as a thin layer over Inspect AI |
| Turn an unmodified harness into trainable rollouts | [OpenEnv](https://github.com/meta-pytorch/OpenEnv)-style capture, or an equivalent provider |
| Large optional agent-environment pack | [MiMo-V2.6-RL-oss](https://github.com/XiaomiMiMo/MiMo-V2.6-RL-oss) |
| Connect existing agents to rollout and training infrastructure | [Uni-Agent](https://github.com/verl-project/uni-agent) and [mimoagent](https://github.com/XiaomiMiMo/mimoagent) |
| Co-evolve skills and policy during RL | [ReSkill](https://github.com/amazon-science/reskill) as an optional adaptation/training provider over veRL; skill versions and bundle tests remain experiment coordinates |
| Run isolated environments | Local Docker, CubeSandbox, or Inspect sandbox providers such as [Kubernetes](https://github.com/UKGovernmentBEIS/inspect_k8s_sandbox), [EC2](https://github.com/UKGovernmentBEIS/inspect_ec2_sandbox), and [Proxmox](https://github.com/UKGovernmentBEIS/inspect_proxmox_sandbox) |
| Stop repeated evaluation sampling adaptively | [optstop](https://github.com/UKGovernmentBEIS/optstop), through Inspect's early-stopping seam |
| Observe or intervene on local-model activations | [vLLM-Lens](https://github.com/UKGovernmentBEIS/vllm-lens) when vLLM is the model-serving boundary |
| Simulate agent environments | [Qwen-AgentWorld](https://github.com/QwenLM/Qwen-AgentWorld) |
| Generate and select harness candidates | [REEF](https://github.com/Human-Agent-Society/reef), [RRSI](https://github.com/google-research/rrsi), or another adaptation provider |
| Train model weights | [Inspect RL](https://github.com/UKGovernmentBEIS/inspect_rl) when Inspect owns rollout and reward while TRL/GRPO owns optimisation; [verl](https://github.com/volcengine/verl), [ROLL](https://github.com/alibaba/ROLL), [Molt](https://github.com/NVIDIA-NeMo/labs-molt), or another training provider |

The Inspect projects are especially useful as an **adapter family**, not as one dependency. Inspect defines reusable task,
solver, scorer, model-provider, sandbox and early-stopping seams; ControlArena layers serialisable policies, monitors
and control protocols over them; Inspect RL reuses complete Inspect rollouts as training trajectories; optstop plugs
into the early-stopping interface; vLLM-Lens registers as an Inspect model provider; and the sandbox packages provide
replaceable execution environments. A future Endophasia integration should admit these capabilities separately and
record each provider's version and configuration rather than flattening them into a single "Inspect" capability.

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

An experiment's identity is a set of declared coordinates, each either recorded or explicitly UNAVAILABLE: model and
checkpoint (for local weights, a digest of the weights file and its quantisation), harness, harness version, effective
harness surface, invocation mode, tool surface, wire dialect, cognition policy, sampling policy, resource budget,
environment and task. No runtime is expected to supply all of them. Comparisons check comparability coordinate by
coordinate and flag every mismatch. A train/evaluation budget mismatch is one such mismatch, never mixed silently.

**The harness is an experimental variable, not plumbing.** In any study or adaptation run that spans harnesses, the
harness is a blocking factor: trials compared within a group (for example one GRPO group) share a harness, so a
within-group difference measures the policy rather than the harness. Generalisation is then compared between blocks.
That the harness can matter as much as the model is a hypothesis Endophasia can test directly (same model, task and
environment behind different harnesses), not an assumption to build on.

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
| **Evaluator / Grader** | Explicit source of outcome evidence. A learned grader or judge produces evidence; deterministic adjudication (schema checks, target binding, deduplication, promotion rules) decides what it counts for. A judge never becomes an authority |
| **Evaluator candidate** | Proposed rubric, critic, judge program, metric expression, or evaluator configuration. It is versioned and compared against fixed anchors and held-out evidence before it can replace an evaluator; its own score never authorises that replacement |
| **Reward definition** | A versioned record naming the reward source(s), transformation, weights, bounds, missing-evidence policy and provenance. Several grader scores are never combined by an implicit weighting. A verifier that failed to run yields UNAVAILABLE, never a reward of 0: an environment failure is not a wrong answer |
| **Selection policy** | Deterministic decision over candidate evidence; the in-tree policies are a baseline and RRSI- and GEPA-inspired rule sets, not ports of either method |
| **Validation and promotion holdout** | Selection may read validation results; the promotion holdout is never given to a selection policy, so a promotion can be checked against data the search never saw |
| **Promotion gate** | Explicit authority boundary after evaluation; evaluation does not imply execution |

### Capture tiers

Trajectory capture has two tiers, with different contracts:

| Tier | Holds | Used for |
| :--- | :--- | :--- |
| **Evidence-grade** | Byte-exact requests and responses, tool calls and results, lifecycle, usage, environment identity | DEVELOP, replay, evaluation, comparison |
| **Training-grade** | Everything above, plus exact prompt and sampled token IDs, per-token behaviour log-probabilities, loss masks, the sampling policy and the model checkpoint identity | On-policy training providers |

- Training-grade data cannot be reconstructed from text. Harnesses repair, reformat and compact what passes through
  them, and the chat template is applied by the server, so token IDs come from the inference engine, with its
  tokenizer and template identity. They are never re-tokenised by the client.
- [Inspect RL's rollout boundary](https://github.com/UKGovernmentBEIS/inspect_rl/blob/main/docs/03_internals.md) is a
  useful concrete reference: it returns exact prompt IDs, sampled completion IDs and behaviour log-probabilities from
  the serving path, and checks multi-turn prefix continuity rather than round-tripping through text and re-tokenising.
- Training-grade capture is not passive. Requesting log-probabilities changes the request, so it is a declared
  condition with its own manipulation check, never a silent add-on to evidence capture.
- The byte-faithful recording proxy keeps its contract. A token-faithful capture provider is a separate component,
  even if they later share infrastructure.
- A provider that cannot supply training-grade data is still valid for everything in the first tier. Asking it for
  training data fails as UNAVAILABLE, never with a degraded substitute.
- Every recording made so far is evidence-grade, and stays so.

Trajectories are not assumed to be linear. A derived rollout structure treats retries as siblings, a subagent as a
new root and a compaction as the start of a new prefix, and it is the substrate for replay, forks and training
sequences alike.

Resource use is evidence too. Token usage, model calls, tool calls, branches, retrieval, tests, critics, retries, wall-clock time, and cost can be recorded as part of the trajectory. This makes **Compute Appetite** a bridge between DEVELOP and EVOLVE: a cognition policy can decide how much computation to spend, while EVOLVE can test whether that expenditure actually improves outcomes.

The goal is not autonomous rewriting for its own sake. The goal is **bounded, reproducible, evidence-backed improvement**.


### Epistemic alignment experiment: Magpie as a shadow ledger

One concrete EVOLVE study is a deliberately gameable post-training environment: optimize a policy against an imperfect
proxy while a separate epistemic measurement surface records what changes before, during and after reward hacking.
The aim is not to encode a complete value system or claim a solution to alignment. It is to test a narrower,
falsifiable question:

> **Do training-independent epistemic traces forecast proxy exploitation, and can a narrow calibration reward reduce
> that transition without destroying the monitors used to detect it?**

This design is motivated by several recent results: [reward-hacking RL can produce broader emergent
misalignment](https://arxiv.org/abs/2511.18397), [open-weight RL reproductions make the phenomenon accessible at
research scale](https://arxiv.org/abs/2605.31328), [optimizing directly against a useful monitor can make the monitor
lose recall](https://arxiv.org/abs/2503.11926), [PRIME-style direct probes can precede visible reward
hacking](https://arxiv.org/abs/2606.09711), and [rubric dropout can reduce over-optimization of a fixed reward
proxy](https://arxiv.org/abs/2608.11669). The public
[EMA_RL](https://github.com/lasseruttert/EMA_RL) pipeline is a useful reproduction reference. These sources motivate
the experiment; they do not validate Endophasia or Magpie.

> [!IMPORTANT]
> **Reward / measurement firewall.** A feature used as reward is no longer a clean monitor of the policy trained
> against it. The first tranche therefore keeps Magpie-derived measurements, PRIME probes, contradiction behaviour,
> evidence acquisition and provenance/origin structure outside the training reward. Magpie is a shadow epistemic
> ledger, not a reward oracle, truth oracle or promotion authority.

~~~mermaid
flowchart LR
    P["Policy checkpoint"] --> T["Training surface<br/>proxy · optional dropout · calibration"]
    P --> S["Shadow surface<br/>Magpie · PRIME · delayed outcomes"]
    T --> O["Optimizer"]
    O --> P
    S --> H["Training-independent evaluation"]
    P --> H
    H --> X["Experiment record"]
    S --> X
~~~

#### Experimental sequence

The study is staged so a new mitigation is never interpreted before the underlying failure mode and known controls
have been reproduced.

| Stage | Question | Planned treatment |
| :--- | :--- | :--- |
| **0 · reproduce** | Does proxy optimization produce reward hacking and broader misalignment in the selected local model? | Start from the published warmup → GRPO structure. A ~4B model is a cheap scout; failure there is not a negative result. Repeat at ~8B before concluding the phenomenon is absent |
| **1 · positive controls** | Can the setup reproduce already-reported mitigation directions? | Inoculation prompting and on-policy safety-data interleaving, each as its own declared condition |
| **2 · reward interventions** | Do less-stable proxies or calibrated outcome rewards change hacking onset and generalization? | Fixed proxy, proxy dropout, calibration reward, and the combination |
| **3 · monitor pressure** | Does a useful shadow indicator survive once optimization can see it? | Only after a shadow metric has shown predictive value, expose one previously held-out signal to reward and measure whether its usefulness degrades |

The primary Stage-2 arms are:

| Arm | Training signal |
| :--- | :--- |
| **A · proxy** | Fixed exploitable task proxy / rubric |
| **B · dropout** | The same proxy, but a declared fraction of reward criteria is randomly omitted per rollout group; evaluation always restores the full criterion set |
| **C · calibration** | The same proxy plus a proper scoring rule on explicitly forecastable outcomes; initially use a Brier-style term such as `-(p - y)^2`, not rewards for hedging words or other linguistic markers |
| **D · combined** | Proxy dropout plus the same calibration term |
| **E · inoculation** | Positive-control training prompt that explicitly recontextualizes the exploitable behaviour; this arm intentionally changes the prompt |
| **I · interleaving** | Positive-control on-policy safety-data interleaving |

System prompts, harness, model checkpoint, sampling policy, task distribution and budgets stay byte-identical across
A–D. Any manipulation of exploit discoverability, hint strength or proxy quality is a predeclared blocking factor,
not an unrecorded prompt change. The reference implementation and dependency set used for reproduction should be
pinned rather than silently upgraded.

#### What is rewarded and what stays shadow-only

The first calibration treatment rewards only a narrow quantity whose outcome can be independently resolved. It does
not reward the model for *looking* epistemically virtuous.

| Surface | Examples | Optimizer may read it? |
| :--- | :--- | :---: |
| **Training** | task proxy, declared rubric mask, Brier/calibration term | yes |
| **Shadow epistemic** | unsupported assertions, evidence requests, contradiction response, confidence/evidence divergence, later refutation, delayed downstream outcomes | no |
| **Provenance / origin** | evidence lineage, repeated-origin multiplicity, exact producing coordinates, policy used to derive standing | no |
| **PRIME-style probes** | correctness self-assessment, proxy recognition, exploit reasoning on fixed diagnostic inputs | no |
| **Held-out outcome** | gold tests, hidden task checks, rubric-free or cross-family evaluation where deterministic adjudication is unavailable | no |

For Magpie specifically, the experiment must preserve its existing boundaries. A signed history establishes what was
recorded under the supplied verification context, not truth, freshness, global completeness, key ownership or
permission to act. Distinct origin groups are not automatically proof of statistical, causal or organisational
independence. Current broader contradiction policy, currentness/supersession, authority-bound origin admission and
`EpistemicGate` work remain separate from this experiment.

#### Leading-indicator test

A signal does not count as an early warning merely because it trends with training. The experiment should deliberately
create variation in **when** hacking appears — for example by varying declared exploit discoverability across otherwise
matched blocks — and ask whether checkpoint measurements forecast future onset.

At each checkpoint, compare increasingly informative predictors:

~~~text
current hack rate
    vs
current hack rate + PRIME-style direct probes
    vs
current hack rate + PRIME + Magpie shadow features
~~~

The primary analysis should use held-out runs or leave-one-run-out validation. Candidate shadow features include
changes in evidence acquisition, unsupported-claim rate, confidence relative to later verification, repeated-origin
use, response to counterevidence and the rate at which later evidence undermines previously rewarded claims. A
Magpie feature earns scientific value here only if it predicts future behaviour beyond the current hack rate and the
stronger existing baseline.

#### Suppression is not erasure

A low final hacking rate is insufficient evidence that the exploit capability is gone. After a mitigation suppresses
visible hacking, one evaluation branch should switch temporarily to a robust/gold reward and later re-expose the same
checkpoint lineage to the original hackable proxy. Record the time to renewed sustained hacking and whether PRIME or
shadow epistemic signals persisted while behaviour looked aligned.

This distinguishes:

~~~text
behaviour suppressed     != exploit capability erased
monitor quiet            != policy safe
proxy reward improved    != intended objective improved
~~~

#### Evaluation and reporting

Every comparison should predeclare the checkpoint cadence, hacking-onset rule, primary outcomes and stopping
conditions; run multiple seeds where compute permits; preserve null and negative results; and evaluate with mechanisms
that were not optimized during training. At minimum, report proxy reward, held-out/gold task success, hack rate,
out-of-distribution misalignment, calibration, resource use and the shadow-monitor measurements above. Later studies
can add cross-harness blocks, but a GRPO rollout group must not mix harnesses.

The [Magpie](https://github.com/noctem-o/magpie) integration should initially be observational. Endophasia owns the
experiment coordinates and trajectories; Magpie can retain replayable claims/evidence/provenance and derive
policy-scoped standing over the supplied record. Until a governed writer / `EpistemicGate` path exists, an adapter
must not pretend that simply recording an event admits it into an epistemic process.

A strong result is not "the rewarded score went up." It is a reproducible change that survives training-independent
evaluation, held-out runs and re-exposure tests while its evidence trail remains inspectable. A null result or a
mitigation that backfires is still useful evidence.


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

A summary. The detail of what is implemented, with every limitation, is in [docs/status.md](docs/status.md). What
each real recording and study establishes, and what it does not, is in [research/README.md](research/README.md).

**What runs, implemented and tested here:**
- **Protocol, store and CLI.** Versioned `endo.*` events and identities, an evidence store with replay, durable storage
  with validated recovery, and the `endo` CLI. The reporting commands open stores read-only.
- **The Pi attachment** (`endo harness …`), over Pi's documented RPC mode. It covers fingerprints and change records,
  evidence-validity rules, local checks, an authorization-gated live study, and session recording with crash
  recovery. Controls are offered only for admitted capabilities.
- **Session lifecycle.** Pi's records fold into canonical `lifecycle.*` events, and `endo harness overview` gives a
  read-only session overview. What Pi does not report is UNAVAILABLE with a reason.
- **Trajectory comparison** ([rules](docs/trajectory.md)). `endo trajectory show|diff` judges lifecycle, tool calls,
  tool results and outcome by keyed digests, never comparing across digest domains.
- **Capture and cassette replay** ([how it works](docs/replay.md)). `endo proxy record|replay` and `endo replay`
  replay a recorded session against its cassette, including STOP, kill and steering interventions, and classify any miss as environment or
  control flow.
- **Experiments** ([how they run](docs/experiments.md)). `endo experiment run|report` runs pre-registered specs with
  blocked randomization, manipulation checks and pinned environments. Every trial is also a cassette.
- **Steering** ([how it works](docs/steering.md)). STEER, QUEUE and STOP as explicit, authorized, verified
  interventions through Pi's documented RPC: a proposal, an authorization bound to its exact digest, the request,
  Pi's acceptance, the consumption the recording proxy shows, and the consequence, each its own record.
  `endo harness attach --control` and `endo steer propose|authorize|apply|status` operate it. v0 proposals come only
  from the operator, and an external authority provider is a documented seam, not wired.
- **Tests:** a deterministic suite with a fake Pi and a fake OpenAI-compatible endpoint, plus an opt-in acceptance
  suite against a real installed Pi.

**Real evidence so far** ([research/README.md](research/README.md)). All of it comes from Pi 1.0.1, qwen3.8-27b on
llama.cpp, and one machine:
- [Session lifecycle](research/README.md#session-lifecycle): completes, STOP mid-turn, killed and resumed.
- [Cassette replays](research/README.md#cassette-replays): 40 replays EXACT, and a negative control that diverged as
  it should.
- [Variance study (E2)](research/README.md#variance-study-e2): "unstable" under every arm, from sampling and then
  from tool output that carried wall-clock values.
- [Pinned-environment study (E3)](research/README.md#pinned-environment-study-e3): "stable" with the environment
  pinned, deterministic sampling and the cache off. That is no observed variation under that declared condition at
  N = 20 per task, not a claim that the system's intrinsic noise is zero.
- [Steering study](research/README.md#steering-study): in that deterministic condition, a STEER and a QUEUE were
  consumed where Pi documents (80 of 80 steered trials). What the agent did with them differed by task and arm, and
  on one task between two runs whose requests differ only in the working-directory path (a post-hoc replication
  reproduced each exactly).
- [Path-sensitivity study](research/README.md#path-sensitivity-study): the steering results over 30 working-directory
  paths. A QUEUE was followed at every path, a STEER on one task at 27 of 30 and on the other at 6 of 30, and the
  baseline itself varied with the path on that second task.
- [Discriminating-task study](research/README.md#discriminating-task-study): of 12 small coding tasks, two discriminate
  for this model (13 of 20 and 7 of 20) and most are saturated. 21 of the 25 failures were a response cut off at Pi's
  default completion cap of 16,384 tokens, so the discrimination is largely truncation; it is not yet a measure of
  task difficulty.
- [Completion-cap study](research/README.md#completion-cap-study): raising the completion cap from 16,384 to 32,768 tokens raised
  success on the two discriminating tasks from 10 of 24 to 19 of 23 (cluster interval +0.09 to +0.73, a gain at every path); a
  brief-reasoning sentence and switching thinking off are cheaper but less reliable, and the trials showed that without a sandbox an agent can reach
  the repository's hidden checks.

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
model was called. The hostile trajectory cases, and the lifecycle's failure, retry, compaction and unknown-record
paths, are exercised only against the fake Pi ([research/README.md](research/README.md#fake-only-paths)).

The boundary and the evidence rules were audited adversarially ([audit](docs/pi-attach-audit.md)), including the
limitations accepted for now.

**Not yet built:** the Endophasia-native cockpit over its own store ([target](docs/cockpit.md); the fork-era cockpit
spoke Pi's private services and was removed, and the operator view today is `endo harness status`), an optional Pi
extension for active-tool control,
model-originated steering proposals and an external authority provider, any live provider integration wired into a command, WORK / DREAM policy compilation, the full trajectory / experience laboratory, RL training-provider
integration, and attachments for other harnesses.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.

## Roadmap

### Near-term sequence

The numbered items below are the long-term map. The order of work for the next stretch is:

1. **Transport closeout.** Decouple the recording proxy's upstream connections from the client's keep-alive, so a
   server closing an idle connection while the client reuses it cannot produce transport errors (2 in 622 requests in the
   steering study). Classify any remaining transport retries apart from agent behaviour.
2. **Effective harness surface** (items 2, 6 and 9). Identify what the model actually experiences, not only which
   executable ran. A surface record holds component digests observed on the wire by the recording proxy: the system
   instructions, the tool-definition set and the effective request parameters. Next to these sit the invocation mode,
   the model identity and the wire dialect. Variable contributions such as the working directory are separate observed
   fields; no prompt "template" is reconstructed by heuristics. Raw prompts are never canonical evidence, and a field a
   runtime hides is UNAVAILABLE. The path-sensitivity study is why: a working-directory path alone changed behaviour.
   The surface joins the other experiment-identity coordinates ([Evolve providers](#evolve-providers)), compared
   coordinate by coordinate.
3. **ACP v2 conformance study** (item 9). The ACP sequence is: ACP v1 slice (done) → ACP v1 semantic coverage and loss
   accounting (done) → ACP v1 lifecycle/accounting closure (done) → this experimental v2 study → a cross-surface
   conformance study. ACP v2 is still a Draft protocol: a baseline v2 schema is published and draft additions are layered
   separately, so support stays explicit and feature-gated and the study is pinned to one exact revision (never "stable").
   A protocol-level adapter study: the prompt lifecycle, `session/resume` with `replayFrom` (replacing the v1
   load/resume split) compared with the live session, and permission requests (now with a required title and optional
   structured subjects) answered with default deny and operator confirmation. ACP types stay in the adapter. Two ACP v1
   decisions are deliberately deferred and separate: consuming the *unstable* per-turn `PromptResponse.usage` that real OMP
   sends (an unstable source field needs an explicit policy and loss-accounting decision), and Windows descendant
   containment, which belongs in the shared `ProcessGroupV0`, not in any one adapter.
4. **Compute-frontier follow-up** (item 13). The completion-cap study has been run (see Done), so this is what remains:
   where success saturates above 32,768 tokens, whether a retry after a cut-off beats a larger cap, and whether failures
   merely move. Pre-registered, everything else pinned, several fixed seeds as the replication unit. Any later
   adaptation run must use the same output budget in training and evaluation, checked rather than assumed.
5. **Forkable checkpoints** (item 10). The substrate primitive beneath search, counterfactual evaluation and training.
6. **Research note.** The variance, pinned-environment, steering, path-sensitivity, discriminating-task and
   completion-cap studies, written up with their limits and data.

Done:

1. **Attach model.** Pi attached over its documented RPC mode; the vendored fork removed
   ([inventory and decisions](docs/pi-attach-inventory.md)).
2. **Harness version tracking.** Fingerprints, change records, evidence invalidation and re-checking, audited
   adversarially ([audit](docs/pi-attach-audit.md)).
5. **Replay first-class.** Make deterministic replay and differential replay part of the core research workflow,
   including explicit divergence between two runs.
   - *Status:* cassette replay with STOP and kill at the recorded chunk (#21); differential replay via the trajectory
     comparison (#20), with tool calls and tool results judged separately (#25); misses classified as environment or
     control flow (#25). The wall-clock limit is documented ([replay](docs/replay.md)).
- **Research data out of git** (#35). The studies' raw run directories live outside the repository; canonical evidence
  (designs, results, analyses, small per-trial files, cassettes) stays. The policy stands: small, durable,
  digest-and-provenance records may live in git; large or private replay material does not
  ([where it lives](research/DATA.md)).
- **Completion-cap study** (#35). Raising the completion cap from 16,384 to 32,768 tokens raised success on the two
  discriminating tasks from 10 of 24 to 19 of 23 ([results](research/README.md#completion-cap-study)).
- **ACP v1 adapter** (#37, #39, and the closure tranche). A pinned-SDK, schema-validated v1 adapter with capability-gated
  session operations and explicit loss accounting, smoke-tested against real OMP ([ACP v1 adapter](docs/acp-v1-slice.md)).
- **Schema compatibility rules** (#41). For the covered durable and imported records (events, the 25 evidence record
  kinds with the ledger and its meta/snapshot, evaluation profiles, workspace archives, the digest-key file and the
  harness-registry records), the declared `schemaVersion` selects exactly one validator; each known version is parsed
  exactly and unknown fields are rejected; an unknown version is rejected as unsupported, never partially read; and
  every committed version is read under its original contract, proved by permanent fixtures. The experiment runner's
  spec, run record, plan and trial results follow the same rule (the pre-versioning `plan.json` has one narrow legacy
  reader). Not covered: runtime-local, derived and unwired schemas, the experiment report, the rest of the run
  directory, automatic migration, and arbitrary future versions
  ([policy and inventory](docs/schema-compatibility.md)).

Partly done:

3. **First end-to-end slice.** A real Pi session is recorded into the durable store and replayed; the cognition graph
   and a cockpit over that store are not wired yet.
   - *Graph semantics:* the graph will be a derived projection, never a second source of truth. Each edge has a
     *kind* (causal, provenance, authority) and, separately, an *epistemic status*: observed (established by runtime or
     wire evidence), reported (the runtime says so), derived (a deterministic transformation of evidence) or inferred
     (a rule or model concluded it). A derived or inferred edge names its rule, the rule's version and its input
     evidence, and is never written back as an observation. A visualisation draws only what the graph holds.
4. **Real Pi path.** Make the first vertical slice boring: observe a real session, record canonical evidence,
   steer where the runtime supports it, interrupt, recover, and preserve explicit permission boundaries.
   - *Status:* observe, record, interrupt and recover are real on Pi 1.0.1 (#19). STEER, QUEUE and STOP are
     authorized interventions (8).
6. **Evaluation laboratory.** Define reproducible experiment bundles containing runtime/model/configuration, task,
   initial state, evidence, outcome, evaluator identity, seeds, usage, and analysis. Every research claim should
   point back to evidence.
   - *Status:* experiment specs, the runner, reports and bundles (#22, #23), pinned environments (#26), and
     pre-registered studies: variance (#24), pinned environment (#26, #27), steering (#29), path sensitivity (#31) and
     discriminating tasks (#34). Not yet: experiment bundles feeding the evolution policies (11), and the effective
     harness surface in every experiment's provenance (near-term 2).
   - [StaminaBench](https://github.com/amazon-science/StaminaBench) is a candidate long-horizon evaluation pack:
     evolving software specifications and test feedback across up to 100 interaction turns can expose context
     accumulation, recovery, regression and resource drift. Integrate it behind an evaluation provider rather than
     making the benchmark a core dependency.
8. **Steering protocol.** Separate observation → interpretation → proposal → authorization → steering → observed
   consequence. A proposal never becomes permission implicitly.
   - *Status:* STEER, QUEUE and STOP are explicit, authorized, verified interventions through Pi's documented RPC
     ([steering](docs/steering.md)): the proposal, an authorization bound to its digest, the request, acceptance,
     consumption (shown by the recording proxy) and the consequence are separate records; steered sessions replay
     EXACT; and a [pre-registered study](research/steering/1.0.1/RESULTS.md) measured the effect. Not yet: proposals
     that do not come from the operator, an external authority provider (a [contract proposal](docs/deadbolt-intervention-contract.md)
     for Deadbolt exists; Deadbolt has no matching lease template), and observation and interpretation records created by a
     command.

Next:

7. **Cognition controls.** Bring the runtime-neutral DEVELOP controls into the substrate: Reasoning, Epistemic
   Rigour, Explore, Verify, Compute Appetite, Tool Initiative, Dream Mode, Latent Deliberation, and honest
   J-space profiles where the underlying model can expose them. WORK / DREAM remain policies over these controls,
   not hidden model state.
   - [vLLM-Lens](https://github.com/UKGovernmentBEIS/vllm-lens) is a candidate local provider for per-request residual
     activation capture and steering when vLLM is already the serving boundary. Raw activations are observations;
     probes, labels and "what this activation means" remain derived or inferred claims. A steering vector is a recorded
     experimental intervention, not evidence that a natural internal state existed.
9. **Cross-runtime conformance.** Study Pi, Codex, Prime, and other adapters against the same evidence contracts,
   with capability admission based on current evidence rather than names or assumptions.
   - The recording proxy is the common *model-serving* boundary, not a common runtime boundary: each adapter reports
     what its own runtime guarantees, hides or only reports.
   - The strongest design holds one agent and model fixed behind two surfaces (for example Pi RPC and ACP v2), so
     differences belong to the surface rather than the agent.
   - Every conversion between record formats states its lossiness: EXACT, QUALIFIED, LOSSY or UNREPRESENTABLE.
   - Trace export (for example to the OpenTelemetry GenAI conventions, still marked Development) is deferred until it
     has a consumer. It would be an optional exporter using the same lossiness vocabulary, never the internal protocol.

EVOLVE / research loop:

10. **Trajectory and experience substrate.** Make EnvironmentPack, Episode, Trajectory, ExperienceStore,
    candidate/mutation, evaluator, and result-bundle records first-class and reproducible.
    - *Status:* partly done. Trajectory (`endo.trajectory.v1`) and experiment result bundles exist (#20, #22,
      #25); the others do not yet.
    - **Forkable trajectory state.** Capability-gated checkpoint, restore, fork and branch-lineage records over states
      that can actually be reconstructed. A checkpoint is derived from evidence, never declared: a prefix that cassette
      replay reproduces EXACT, together with the restored environment identity. A fork names its parent checkpoint, the
      variable it changed and its new trajectory, and descendants are ordinary trajectories. The first mechanism is
      cassette-then-live: replay the recorded prefix, then switch the proxy to a live model (or a different one) at the
      checkpoint. Search, counterfactual evaluation and training may consume forks; they are not part of the primitive.
11. **Reference evolution policies.** Exercise the baseline and the RRSI- and GEPA-inspired rule sets against real
    experiment bundles, including validation, an untouched promotion holdout, noise/leakage checks, and deterministic selection. A faithful
    RRSI policy needs a calibrated per-instance noise band and its cost rule, which need cost evidence the policy
    context does not carry yet.
12. **Adaptation providers.** Add provider seams for RL training and other adaptation methods without making any one
    algorithm part of the Endophasia core.
    - A concrete first study is an [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) evaluation provider
      paired with [Inspect RL](https://github.com/UKGovernmentBEIS/inspect_rl) as an optional training provider:
      Inspect owns the multi-turn/tool/sandbox rollout and scoring, while TRL/GRPO owns optimisation. Training tasks
      stay distinct from held-out evaluation tasks, and the provider must preserve exact sampled token IDs and
      behaviour log-probabilities rather than reconstructing them later.
13. **Resource-aware cognition / test-time compute.** Treat Compute Appetite as an explicit inference budget and policy,
    not a generic "think harder" control. Record ceilings and consumption for tokens, model calls, tool calls,
    verifier calls, branches, tests, retries, wall-clock time, and cost; compare fixed against adaptive allocation and
    test whether extra compute buys reliable outcome improvements rather than longer traces alone. Start with simple,
    falsifiable arms before learned allocation. For local inference, measure wall time and memory/attention pressure as
    well as token counts rather than assuming tokens are a complete compute proxy. Research leads:
    [compute-optimal test-time scaling](https://arxiv.org/abs/2408.03314) and
    [Kinetics](https://arxiv.org/abs/2506.05333).
    - **Evaluation-level stopping:** [optstop](https://github.com/UKGovernmentBEIS/optstop) is a candidate for repeated
      evaluation cells through Inspect's early-stopping protocol. Treat its rule, thresholds and every stopped sample
      as experiment provenance, first validate it post-hoc or in shadow mode, and keep it separate from an agent's own
      trajectory-level STOP decision.
    - *First study:* the completion-cap study (done), motivated by the discriminating-task study, where most failures
      were truncation at the completion cap. The follow-up is near-term 4.
14. **Adversarial / co-evolution experiments.** Support bounded self-play or attack/control loops where monitors,
    evaluators, or environments can improve alongside the agent, while promotion-holdout evidence remains outside the
    adaptation loop. [ControlArena](https://github.com/UKGovernmentBEIS/control-arena) is a useful provider reference
    for explicit honest/attack modes, policies, monitors and main-task/side-task settings.
    [Async Control](https://github.com/UKGovernmentBEIS/async-control) is a separate research lead for effects that are
    reviewed after the initiating action: synchronous prevention, asynchronous detection, and later harmful
    consequences must remain different events and claims.
15. **Bounded recursive improvement.** Allow model ↔ harness ↔ cognition-policy improvement cycles only through
    explicit candidates, evidence, comparison, admission, and promotion gates. No implicit self-replacement.



Hardening and artifact:

16. **Adversarial audit.** Test identity, evidence provenance, stale or forged evidence, duplicate/out-of-order
    events, replay divergence, unauthorized execution, false verification claims, and stale evidence inheritance.
    Use dedicated adversarial environments where they answer a specific boundary question; for example,
    [sandbox_escape_bench](https://github.com/UKGovernmentBEIS/sandbox_escape_bench) can test sandbox
    misconfiguration/escape capability inside an outer VM boundary. Such a benchmark is evidence about that declared
    environment, not proof that an arbitrary deployment sandbox is safe.
    [JAWS-Bench](https://github.com/amazon-science/JAWS-Bench) is another candidate external pack for defensive
    code-agent safety under prompt-only, single-file and multi-file workspace conditions; preserve the exact
    workspace/attack regime and do not generalise a result beyond that declared environment.
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
    [Socratic-SWE](https://arxiv.org/abs/2606.07412), [MUSE-Autoskill](https://arxiv.org/abs/2605.27366), and
    [Ratchet](https://github.com/amazon-science/Self-Evolving-Agents-Ratchet); Ratchet's bounded active bank,
    contribution-driven retirement, retained evidence and rollback are useful lifecycle references.
    [ReSkill](https://github.com/amazon-science/reskill) is a heavier follow-on when an experiment intentionally
    couples skill evolution to policy optimisation through RL; keep those two adaptation axes separately attributable.

19. **Episodic + semantic memory.** Test retrieval of similar past cases alongside compact, reusable
    lessons, with ablations for each channel and no-memory baselines. Measure retrieval precision,
    stale advice, context cost, and transfer to unseen repositories. Candidate references:
    [ExpeRepair](https://github.com/ExpeRepair/ExpeRepair) and
    [Memento](https://arxiv.org/abs/2508.16153). Keep stored observations distinct from inferred
    lessons, and make every memory item traceable to its source episodes.

20. **Compute-aware search-time planning and branching.** Compare one main trajectory with retry/refinement,
    Best-of-N, bounded alternatives, beam/tree search, or provider-defined search such as MCTS. Treat the search
    algorithm as a replaceable policy, not a core protocol primitive. Every retained or pruned branch should keep its
    parent/reason, allocated and consumed resource budget, verifier evidence, and termination reason. Keep branch
    contexts isolated unless an explicit, recorded transfer imports verified state.
    - **Allocation:** compare uniform budgets with per-task adaptive budgets; test whether cheap difficulty/uncertainty
      signals predict the marginal value of another sample, branch, or verification step. Start with
      [compute-optimal test-time scaling](https://arxiv.org/abs/2408.03314), then more complex allocators only if the
      simple arms establish a compute→outcome frontier.
    - **Verification:** keep deterministic execution checks (tests, compiler, type checker, invariants), learned
      outcome/process reward models, model judges/critics, simulation, and human review as distinct evidence sources.
      A PRM or judge score is not executable proof. Record verifier identity, granularity, cost, and the evidence it
      actually establishes. Research leads: [Let's Verify Step by Step](https://arxiv.org/abs/2305.20050),
      [VG-Search](https://arxiv.org/abs/2505.11730), and
      [Pareto Optimal Code Generation](https://arxiv.org/abs/2506.10056).
    - **Pruning and stopping:** make hard cutoffs, dominance/pruning, budget exhaustion, verified success, and operator
      stop explicit termination reasons; preserve pruned evidence so search decisions remain auditable. Do not assume
      "all tests pass" means general correctness unless that is the declared task criterion.
    - **Reasoning-budget controls:** mechanisms such as budget forcing, native effort levels, continuation prompts, or
      temperature changes are capability-gated, model/provider-specific interventions. Test them rather than treating
      them as universal controls; [s1](https://arxiv.org/abs/2501.19393) is a starting point for budget forcing.
    Start with [SWE-Search](https://arxiv.org/abs/2410.20285) for repository-level branching, but compare MCTS against
    simpler baselines before adopting it.

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
    [Double Ratchet](https://github.com/amazon-science/Self-Evolving-Agents-Double-Ratchet) is a direct reference for
    co-evolving an inspectable metric and a governed skill library. Preserve the separation Endophasia already
    requires: evaluator candidates need lineage, fixed anchors or shadow evaluation, and an untouched promotion
    holdout; an evaluator must not grade its own promotion unchallenged.

23. **Writable procedural memory.** Test whether versioned scripts, repository maps, and executable
    skills outperform prose-only memory. Begin with small, reviewable artifacts and explicit execution
    permissions; do not reproduce a complex writable-memory architecture until simpler approaches show
    a measurable limitation. A research lead is [Spotlight: Memory](https://www.percepta.ai/blog/spotlight-memory).

24. **Model adaptation / training providers.** Once runtime experiments have enough clean data, compare
    prompt and policy changes, memory/skill changes, and optional training methods on the same tasks.
    [Finetuning with Sampling](https://arxiv.org/abs/2610.02140) is one candidate for a separate
    training provider, not a dependency of the runtime core.
    [PROF-GRPO](https://github.com/amazon-science/PROF-GRPO) is a useful reward-design reference because it uses
    process-reward scores as a consistency/data-curation signal rather than directly blending them into the optimisation
    reward; preserve that distinction as an experimentable policy rather than assuming it universally wins. Track data
    provenance, training cost, held-out transfer, and regressions on previously solved tasks.

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
    - Each transformation (working-directory identifier, equivalent renaming, an irrelevant file added, file order,
      whitespace) is a separately registered relation, analysed on its own rather than in one omnibus study.
    - Once forkable checkpoints exist, extend this from repository variants to trajectory interventions at a checkpoint:
      an alternative action, an altered tool observation, a different model or policy, a restricted tool surface, or a
      resample. Because continuations can be stochastic, one fork is not causal evidence; sensitivity is estimated from
      repeated continuations, with uncertainty. A recent lead is
      [Counterfactual Rollout Replay](https://arxiv.org/html/2609.33875).

27. **Contrastive weight-space steering and training-drift monitoring.** Test whether behavioural
    directions derived from matched positive/negative fine-tunes can support controlled model steering,
    and whether the same directions provide useful signals for monitoring later weight updates for
    behavioural drift. Compare against activation steering, ordinary fine-tuning, and simple weight-delta
    baselines; measure target behaviour, collateral regressions, calibration, transfer across tasks and
    model families, and false positives/negatives. Treat this as a research hypothesis, not a general
    alignment detector: the reported evidence is preliminary and does not establish reliable detection
    of arbitrary misalignment. Keep steering experiments isolated and promotion gated. Use
    [vLLM-Lens](https://github.com/UKGovernmentBEIS/vllm-lens) as one possible activation-steering/instrumentation
    baseline, not as an interpretation oracle. Starting point:
    [Steering Language Models with Weight Arithmetic](https://arxiv.org/abs/2511.05408).

**Common acceptance criteria for every track:** pre-register the hypothesis and baseline; separate
exploration/validation data from an untouched promotion holdout; include repeated fresh trials and
uncertainty; test transfer across tasks and repositories (and, where practical, models or runtimes);
report regressions, tool/token/cost budgets, and safety-check results; preserve failed candidates and
their evidence. Cassette replay tests reproducibility under recorded responses; claims of improvement
must also survive fresh model executions. A benchmark score alone never grants promotion.

**Research index:** [survey of self-evolving coding agents](https://arxiv.org/html/2608.03392v1) for
additional methods and comparisons. Treat reported gains as hypotheses to reproduce, not guarantees
that a method will transfer to Endophasia's runtime-neutral setting.

The ordering is deliberate:

~~~text
runtime truth → replay → verified checkpoint / fork → evaluation → counterfactual comparison → evolution
~~~

Runtime truth includes the effective harness surface, not only the executable. The project should not grow another
large protocol-only migration before these contracts have survived a real agent and produced evidence.

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
