# Roadmap

Status: **plans and research directions, not implemented capabilities.** Items marked done have evidence in the repository
(linked); everything else is intent. The item numbers below (1-27) are cited by research notes and design documents and are kept.
What runs today is in [status.md](status.md) and the [README](../README.md#what-works-today).

The text of this page was moved from the README's "Roadmap" section unchanged.

## Delivery sequence — current priority

The numbered capability map below remains the long-term architecture. The **current delivery sequence is intentionally
shorter and more product-shaped**. Evidence closure and the installable Operator Alpha are complete; the next delivery
priority was the first read-only browser interface (built: `endo studio`), followed by real comparison usability,
forkable checkpoints and deeper EVOLVE work. The proposed native desktop binary is a distinct future interface.

~~~text
evidence closure (done)
      ↓
installable operator alpha (released: 0.1.0-alpha.1)
      ↓
browser Observe (built: endo studio)
      ↓
Compare over recorded sessions + existing review closeout
      ↓
native GPUI feasibility spike (independent, optional)
      ↓
forkable checkpoints (core milestone)
      ↓
native Endophasia read-only instrument v0 (conditional)
      ↓
counterfactual / evolution / training work
~~~

1. **Evidence closure before the first alpha.**
   - **Transport closeout.** Decouple the recording proxy's upstream connections from the client's keep-alive, so a
     server closing an idle connection while the client reuses it cannot produce transport errors (2 in 622 requests in
     the steering study). Classify any remaining transport retries apart from agent behaviour. *Status: done.* Each
     exchange now has its own upstream connection (`docs/replay.md`, "Connections"), and a genuine upstream failure
     is recorded with its kind; the steering study's result stands as recorded.
   - **Effective harness surface** (items 2, 6 and 9). Record what the model actually experiences, not only which
     executable ran: component digests observed on the wire for system instructions, the tool-definition set and
     effective request parameters, alongside invocation mode, model identity and wire dialect. Variable contributions
     such as the working directory remain separate observed fields; no prompt "template" is reconstructed by
     heuristics. Raw prompts are never canonical evidence, and a field a runtime hides is UNAVAILABLE. The
     path-sensitivity study is why: a working-directory path alone changed behaviour. *Status: done.* Each experiment trial
     (`endo.experiment-trial.v1`) now carries the keyed digests of the system and developer instructions, the tool
     definitions (ordered and as a set) and the request parameters the model server received, with the observed model and
     the stream flag, derived from the recorded requests; the report states, per cell, whether the trials showed one
     surface (`docs/experiments.md`, "The effective harness surface"). Historical `v0` trials still read as they were
     and report their surface as UNAVAILABLE. Not recorded: the server's defaults, and the model's internals.

2. **Operator Alpha — installable first-run Pi workflow (complete).**
   - *Status: released.* Tranches [1](https://github.com/noctem-o/endophasia/pull/52), [2](https://github.com/noctem-o/endophasia/pull/53), [3](https://github.com/noctem-o/endophasia/pull/54) and [4](https://github.com/noctem-o/endophasia/pull/55) are merged. [`v0.1.0-alpha.1`](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1) is published on [npm](https://www.npmjs.com/package/endophasia); see [installation](install.md) and [release verification](release-alpha.md).
   - Compiled JavaScript CLI with an `endo` executable, `--help`/`--version`, read-only `endo doctor`, runtime discovery,
     default store root, capability/evidence reporting and operator guidance. No TypeScript execution from `node_modules`.
   - The installed-tarball path exercises diagnose → local checks → attach → status/overview → trajectory against a
     fake Pi and, separately in CI, a real pinned Pi 1.0.0 with a local fake model endpoint.
   - Scope is intentionally narrow: a user-installed Pi on the CI-verified platform, not stable multi-runtime support.
     Live-provider behaviour and other platforms still require their own evidence.

3. **First Endophasia-native operator surface.**
   - Wire a thin, read-only cockpit to the real durable store, following the first-slice contract in
     [docs/cockpit.md](cockpit.md): runtime identity/change state, capability state with reasons and a live session
     timeline, all projected from Endophasia records without depending on Pi private services. Built: the projection and
     read-only reader layer (`cockpit/`), the local read-only HTTP server (`cockpit-http/`), the Studio frontend (`studio-ui/`, its Observe workspace) and
     the installed `endo studio` command ([docs/studio.md](studio.md)), currently branded Studio in the UI.
     The intended product name is **Endophasia Web**; `endo web` is only a proposed compatibility alias, not an
     implemented command. Published `0.1.0-alpha.2` carries the earlier page, whereas the source tree now contains
     the newer React Observe frontend.
   - Add the semantic graph/visualisation projection after the derived cognition graph is wired to the durable store;
     it is a follow-on within this stage, not a first-slice acceptance requirement. Keep Dream scenes and
     model-observation scenes as separate typed projections even if they later share one renderer.
   - Follow with capability-gated model-internal observation. Prefer TransformerLens 4.0's Driver model as the common
     hook/capability vocabulary where supported: compiled vLLM for the live capture tier and Hugging Face for deep
     reference replay. Keep vLLM-Lens as an optional specialist provider for Q/K-derived attention, Jacobian/R-lens,
     persistent/custom hooks or other capabilities that justify its eager-mode trade-off. Preserve raw observations
     apart from derived PCA/MFA/SAE/lens artifacts, and make every missing signal explicit.
   - A later WebGPU renderer may consume both Dream and Observe scenes. WebGPU is a presentation backend, never a
     source of truth; scene geometry must remain reproducible from recorded state and declared transforms.
   - Keep this intentionally smaller than the full Dream/visual-cognition vision. The goal is to make one real
     recorded session inspectable through Endophasia's own state model before adding richer rendering or control.

**Near-term presentation and harness studies (not shipped capabilities).** [Compare PR #69](https://github.com/noctem-o/endophasia/pull/69)
adds a pure evidence-backed comparison presentation projection on its open branch, not the Compare browser workspace.
[DSH study PR #70](https://github.com/noctem-o/endophasia/pull/70) is a version-pinned conformance study;
[DSH importer PR #71](https://github.com/noctem-o/endophasia/pull/71) is a stacked, read-only cold importer.
Neither changes the support claims of the published Pi alpha until merged, tested and released. Native DSH fidelity is
studied separately from ACP interoperability, with losses and unavailable signals explicit.

**Optional native interface track (not implemented).** The future native desktop application would be called
**Endophasia**, distinct from **Endophasia Web** (currently `endo studio`) and the `endo` CLI. A bounded Rust/GPUI Kit +
`wgpu` feasibility spike may follow the initial Compare data/view work without blocking checkpoints. Build an actual
native read-only instrument only after stable validated presentation contracts, real graph/trajectory comparisons and
minimal forkable checkpoints. Its authority comes from existing TypeScript projections, not a second independent
implementation of evidence semantics. Keep a read-only boundary, deterministic fixtures, explicit missing signals,
GPU composition feasibility tests, and the browser frontend as an equal client. AppImage, Windows packaging, and
`endo web` remain future options, not current deliverables. Do not displace core checkpoints, the installed Pi loop,
or real-session usability with graphics work.

4. **Forkable checkpoints** (item 10).
   - Land the substrate primitive beneath search, counterfactual evaluation and training: reconstructable checkpoints,
     restore/fork lineage and cassette-then-live continuation.
   - Once this exists, use it to support controlled continuation experiments rather than adding another large
     protocol-only migration.

5. **Return to the broader research loop.**
   - Resume the compute-frontier follow-up (item 13): where success saturates above 32,768 tokens, whether retry after
     cut-off beats a larger cap, and whether failures merely move. Pre-register the comparison, pin everything else,
     and use several predefined fixed seeds as the replication unit, with the same seed set across compared arms.
   - Write the consolidated research note for the variance, pinned-environment, steering, path-sensitivity,
     discriminating-task and completion-cap studies.
   - Then feed real experiment bundles and forked trajectories into the evolution, counterfactual and adaptation tracks
     below, with the same holdout and authority rules already defined. Baseline and candidate comparisons must use a
     matched declared inference envelope for the coordinate being compared, verified rather than assumed. Output-token
     caps are mandatory matched coordinates for the current studies; model calls, tool/verifier calls, retries,
     branches, wall-clock limits and cost must likewise be held fixed when they are part of the claimed comparison, or
     recorded as separate experimental coordinates rather than silently folded into an adaptation gain.

## Parked or upstream-gated

These are valid directions, but they should **not** displace the delivery sequence above (browser Observe is built; comparisons and checkpoints are the core priorities).

- **ACP v2:** the experimental, version-pinned study is complete. ACP v2 remains Draft upstream and its own migration
  guide recommends version negotiation plus feature flags until stabilization. Do not chase the moving draft. Re-study
  it when the published baseline materially moves and at least one useful real agent negotiates v2 without relying on a
  development-only path. Keep ACP v1 working beside it.
- **DeepSeek Harness native attachment:** the study ([docs/dsh-native-attachment.md](dsh-native-attachment.md)) chose a read-only cold
  importer of DSH's persisted Session log (format 4) over a live Cordis observer or the SDK; the importer is the next DSH step
  and is not started. ACP stays the interoperability path.
- **ACP v1 unstable per-turn usage:** real OMP sends unstable `PromptResponse.usage`, but consuming it still needs an
  explicit source-stability and loss-accounting decision. It is not required for the first alpha.
- **Windows descendant containment:** this belongs in the shared `ProcessGroupV0`, not an ACP adapter. It should land
  when Windows becomes an acceptance target rather than growing one adapter around it.
- **Further protocol breadth:** new adapters and large protocol-only migrations wait until the current contracts have
  survived the installable operator path and produced evidence there.

## Capability map

The entries below keep their existing numbers because research notes and design documents already refer to them.
They describe **capability dependencies**, not the immediate shipping order above.

### Done
1. **Attach model.** Pi attached over its documented RPC mode; the vendored fork removed
   ([inventory and decisions](pi-attach-inventory.md)).
2. **Harness version tracking.** Fingerprints, change records, evidence invalidation and re-checking, audited
   adversarially ([audit](pi-attach-audit.md)).
5. **Replay first-class.** Make deterministic replay and differential replay part of the core research workflow,
   including explicit divergence between two runs.
   - *Status:* cassette replay with STOP and kill at the recorded chunk (#21); differential replay via the trajectory
     comparison (#20), with tool calls and tool results judged separately (#25); misses classified as environment or
     control flow (#25). The wall-clock limit is documented ([replay](replay.md)).
- **Research data out of git** (#35). The studies' raw run directories live outside the repository; canonical evidence
  (designs, results, analyses, small per-trial files, cassettes) stays. The policy stands: small, durable,
  digest-and-provenance records may live in git; large or private replay material does not
  ([where it lives](../research/DATA.md)).
- **Completion-cap study** (#35). Raising the completion cap from 16,384 to 32,768 tokens raised success on the two
  discriminating tasks from 10 of 24 to 19 of 23 ([results](../research/README.md#completion-cap-study)).
- **ACP v1 adapter** (#37, #39, and the closure tranche). A pinned-SDK, schema-validated v1 adapter with capability-gated
  session operations and explicit loss accounting, smoke-tested against real OMP ([ACP v1 adapter](acp-v1-slice.md)).
- **ACP v2 experimental study** (this tranche). A Draft, version-pinned study of the v2 *baseline*: vendored baseline
  schema pinned to an upstream commit and the SDK's layered schema, separate v2 client and loss accounting, prompt
  acceptance versus completion, resume/replay equivalence by reconstructed state, fail-closed permission subjects,
  deterministic fake-agent suite with mutation checks ([ACP v2 study](acp-v2-study.md)). ACP v1 is unchanged.
- **Schema compatibility rules** (#41). For the covered durable and imported records (events, the 25 evidence record
  kinds with the ledger and its meta/snapshot, evaluation profiles, workspace archives, the digest-key file and the
  harness-registry records), the declared `schemaVersion` selects exactly one validator; each known version is parsed
  exactly and unknown fields are rejected; an unknown version is rejected as unsupported, never partially read; and
  every committed version is read under its original contract, proved by permanent fixtures. The experiment runner's
  spec, run record, plan and trial results follow the same rule (the pre-versioning `plan.json` has one narrow legacy
  reader). Not covered: runtime-local, derived and unwired schemas, the experiment report, the rest of the run
  directory, automatic migration, and arbitrary future versions
  ([policy and inventory](schema-compatibility.md)).

### Partly done
3. **First end-to-end slice.** A real Pi session is recorded into the durable store and replayed, and a read-only Studio page
   shows it (`endo studio`); the cognition graph is not wired yet.
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
     discriminating tasks (#34). Not yet: experiment bundles feeding the evolution policies (11). The effective harness
     surface is in every new trial's provenance (delivery sequence 1).
   - [StaminaBench](https://github.com/amazon-science/StaminaBench) is a candidate long-horizon evaluation pack:
     evolving software specifications and test feedback across up to 100 interaction turns can expose context
     accumulation, recovery, regression and resource drift. Integrate it behind an evaluation provider rather than
     making the benchmark a core dependency.
8. **Steering protocol.** Separate observation → interpretation → proposal → authorization → steering → observed
   consequence. A proposal never becomes permission implicitly.
   - *Status:* STEER, QUEUE and STOP are explicit, authorized, verified interventions through Pi's documented RPC
     ([steering](steering.md)): the proposal, an authorization bound to its digest, the request, acceptance,
     consumption (shown by the recording proxy) and the consequence are separate records; steered sessions replay
     EXACT; and a [pre-registered study](../research/steering/1.0.1/RESULTS.md) measured the effect. Not yet: proposals
     that do not come from the operator, an external authority provider (a [contract proposal](deadbolt-intervention-contract.md)
     for Deadbolt exists; Deadbolt has no matching lease template), and observation and interpretation records created by a
     command.

### Next
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

### EVOLVE / research loop
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
      were truncation at the completion cap. The follow-up is delivery sequence 5.
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

## Experimental research tracks (deferred; not commitments)

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
    lessons, with ablations for each channel and no-memory baselines. Also test temporal, multiresolution context
    construction inspired by [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
    and [OptMem](https://github.com/VictorTaelin/OptMem): retain an append-only source history, derive a bounded,
    progressively compressed view, and permit deterministic expansion back toward source records. Compare this
    temporal channel independently and in combination with semantic retrieval rather than treating either as the
    canonical memory architecture. Measure retrieval precision, stale advice, context and cache cost, source recovery,
    and transfer to unseen repositories. Candidate references also include
    [ExpeRepair](https://github.com/ExpeRepair/ExpeRepair) and
    [Memento](https://arxiv.org/abs/2508.16153). Keep stored observations distinct from inferred lessons, and make
    every derived memory item traceable to its source episodes. Magpie-style epistemic standing remains a separate
    layer: retrieval or inclusion in active context does not make a claim true.

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
