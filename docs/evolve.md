# EVOLVE: provider seams, experiment identity and evolution records

Status: **contracts, records and policies; no evolution loop and no operator interface for one.** Two things here are
real. `endo experiment run|report` is a working command: it records an experiment's identity coordinates and writes evaluation
records, and the real studies in [research/README.md](../research/README.md) were run with it. Everything else (the evolution and
promotion records, the baseline and RRSI- and GEPA-inspired selection policies, the provider seams) is implemented as libraries
and exercised by unit tests only; the CLI can read an evidence ledger but no command writes one. No `endo` command or Studio page
runs an evolution loop, and nothing here amounts to a working autonomous self-improvement system. The providers in
the table are candidates for future adapters, not dependencies. See [status.md](status.md#library-only-and-planned-surfaces).

The text of this page was moved from the README's EVOLVE sections unchanged.

## Provider seams

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
| Preferred compiled local-model capture and declarative intervention | [TransformerLens 4.0](https://transformerlensorg.github.io/TransformerLens/content/news/release-4.0.html) on its vLLM Driver, where the model/engine combination is supported |
| Specialist vLLM interpretability | [vLLM-Lens](https://github.com/UKGovernmentBEIS/vllm-lens) when an experiment needs Q/K reconstruction, Jacobian/R-lens readout, persistent/custom hooks, or capabilities outside the TransformerLens vLLM surface |
| Deep local inspection and reference replay | [TransformerLens](https://github.com/TransformerLensOrg/TransformerLens) on its Hugging Face `transformers` Driver; [NNsight](https://github.com/ndif-team/nnsight) where direct HF tracing is preferable |
| Simulate agent environments | [Qwen-AgentWorld](https://github.com/QwenLM/Qwen-AgentWorld) |
| Generate and select harness candidates | [REEF](https://github.com/Human-Agent-Society/reef), [RRSI](https://github.com/google-research/rrsi), or another adaptation provider |
| Train model weights | [Inspect RL](https://github.com/UKGovernmentBEIS/inspect_rl) when Inspect owns rollout and reward while TRL/GRPO owns optimisation; [verl](https://github.com/volcengine/verl), [ROLL](https://github.com/alibaba/ROLL), [Molt](https://github.com/NVIDIA-NeMo/labs-molt), or another training provider |

The Inspect projects are especially useful as an **adapter family**, not as one dependency. Inspect defines reusable task,
solver, scorer, model-provider, sandbox and early-stopping seams; ControlArena layers serialisable policies, monitors
and control protocols over them; Inspect RL reuses complete Inspect rollouts as training trajectories; optstop plugs
into the early-stopping interface; vLLM-Lens registers as an Inspect model provider; and the sandbox packages provide
replaceable execution environments. A future Endophasia integration should admit these capabilities separately and
record each provider's version and configuration rather than flattening them into a single "Inspect" capability.
Observation through a TransformerLens Driver or vLLM-Lens does not imply an EVOLVE action: activation capture can feed
OBSERVE without changing the model, while steering or intervention remains a separately admitted capability.

TransformerLens 4.0's Driver contract is the preferred reference for observation-provider design: each execution
backend declares which hook points it can and cannot serve rather than promising false parity across engines, and the
same canonical names can be reused when a hook is genuinely equivalent. Endophasia should import that capability truth
rather than maintain a hand-written fiction of backend parity. TransformerLens also ships backend-parity scripts that
compare vLLM/Inspect execution against `boot_transformers`; equivalent Endophasia studies should establish and record
a backend-specific numerical noise floor before treating small live-vs-reference differences as meaningful.

The trade-off is deliberate: current vLLM-Lens
[forces eager execution so its hooks can fire](https://github.com/UKGovernmentBEIS/vllm-lens#disabling-the-plugin),
while TransformerLens installs its vLLM capture hooks before compilation and can retain the compiled/CUDA-graph path.
That performance distinction is provider provenance, not an invisible implementation detail.

For broad local compatibility, [llama.cpp](https://github.com/ggml-org/llama.cpp) may support a lower-fidelity native
adapter through its evaluation callback, but stock `llama-server` does not expose intermediate activations as a stable
server API. Any such integration should therefore identify itself as native/callback instrumentation rather than
ordinary OpenAI-compatible serving.

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

## Evolution evidence

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

## Capture tiers

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
