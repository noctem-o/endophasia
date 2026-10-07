# Developmental Epistemic Training v0

> **Status:** proposed research contract / preregistration draft. Not run.  
> **Scope:** a small-model synthetic microworld study of whether *when* epistemically informative structure is learned changes resistance to later conflicting optimisation.  
> **Not a claim:** this document does not establish that developmental training improves alignment, that Magpie establishes truth, or that results from a toy microworld generalise to frontier systems.

## Question

The study separates two hypotheses that are easy to conflate:

1. **Epistemic-content hypothesis:** training on useful source/evidence relations improves later epistemic behaviour.
2. **Developmental-timing hypothesis:** holding that information fixed, *when* the model encounters it changes how resistant the learned behaviour is to later conflicting optimisation.

The second claim is the genuinely developmental one.

The confirmatory question is:

> **Does epistemically informative relational structure learned earlier produce a shallower degradation curve under later shortcut-favouring optimisation than the same structure learned later, beyond any timing effect produced by structurally matched but epistemically meaningless metadata?**

A null or reversed result counts against the developmental hypothesis.

## Why test this

Several results make the hypothesis plausible but far from established:

- [Metadata Conditioning then Cooldown (MeCo)](https://arxiv.org/abs/2501.01956) shows that source-like metadata can materially change pretraining efficiency, but hashed URLs work about as well as semantic URLs. Metadata may therefore act as a grouping cue rather than teach provenance semantics.
- [Implicit meta-learning may lead language models to trust more reliable sources](https://arxiv.org/abs/2310.15047) shows that models can learn arbitrary indicators of source usefulness and later internalise information differently depending on those indicators.
- [Alignment Pretraining](https://arxiv.org/abs/2601.10160) finds that alignment-relevant data changes later behaviour and that late insertion can have especially large effects on base models.
- [Constitutional Midtraining](https://arxiv.org/abs/2607.26654) finds that content presence matters much more than curriculum ordering in its setting; its curriculum/uniform differences are mostly null or transient. The authors explicitly caution that learning-rate decay may mask ordering effects.
- [Curriculum Learning for LLM Pretraining: An Analysis of Learning Dynamics](https://arxiv.org/abs/2601.21698) finds common latent learning phases across orderings and shrinking curriculum advantages at larger scales.
- [Stress-testing Alignment Midtraining](https://arxiv.org/abs/2609.20412) shows that small amounts of conflicting downstream data can overwhelm much larger midtraining interventions, and that demonstrations are substantially stronger than descriptions.
- [How far does alignment midtraining generalize?](https://alignment.openai.com/how-far-does-alignment-midtraining-generalize/) reports that alignment/misalignment midtraining differences can disappear after reasoning post-training on realistic chat and agentic evaluations.
- [When Does Metadata Conditioning (NOT) Work?](https://arxiv.org/abs/2504.17562) shows that conditioning on metadata can hurt when the relevant latent context cannot be inferred at evaluation time.

Together these results argue for a narrow controlled test, not for assuming that an "epistemic childhood" is beneficial.

## Boundary between the systems

The synthetic world, Magpie and Endophasia have distinct authorities.

~~~text
Synthetic microworld
    owns the hidden world state
    owns the gold outcome
    owns source genealogy in the simulation

Magpie
    records claims / evidence / provenance supplied to it
    verifies its retained history under explicit coordinates
    derives policy-scoped standing
    does NOT establish truth

Endophasia
    owns experiment coordinates
    owns lineage / condition / run records
    owns training and evaluation evidence
    does NOT promote an experimental result into a general alignment claim
~~~

For v0, Magpie is a **shadow measurement surface**, not the model's native input format, not a reward oracle and not a truth oracle.

If a proposed adapter would require widening Magpie's current semantics, use a narrower experiment-local record instead. Do not weaken Magpie to fit the experiment.

## Microworlds

The experiment uses synthetic worlds because every relevant fact can be resolved independently of the model and training proxy.

Each world instance contains at least:

- a hidden world state;
- propositions that can be queried;
- source identities;
- source genealogies / shared origins;
- observations or reports;
- support and contradiction relations;
- timestamps or stages where applicable;
- an exact gold resolver;
- one or more epistemically cheap shortcuts that can be rewarded later.

Example shortcut classes include:

### Corroboration shortcut

Two reports supporting (X) share one origin. One independent report supports (
eg X).

The gold decision depends on genealogy and evidence quality. A cheap policy counts reports.

### Context shortcut

The correct answer depends on which simulated world is active.

The gold policy requests or infers the missing world coordinate. A cheap policy predicts the globally common answer.

### Completion shortcut

Evidence is insufficient.

The gold policy abstains or requests evidence. A cheap proxy rewards confident completion.

The model should encounter **behavioural demonstrations**, not prose explaining principles such as "independent sources are better."

## Generator families

Surface-level holdouts are insufficient. Novel source IDs or paraphrases can still share generator artefacts.

Implement at least three structurally distinct generator families:

- **G1:** provenance / shared-origin corroboration;
- **G2:** world-conditioned context and missing information;
- **G3:** temporal revision, stale evidence or another independently implemented epistemic structure.

At least one complete family is frozen as an evaluation-only holdout.

A held-out family must differ in code path, templates, graph construction and surface realisation, not merely random parameters.

Before the confirmatory run, record:

- generator source revision;
- generator-family IDs;
- train/validation/holdout assignments;
- world seeds;
- hashes of generated manifests;
- the exact gold-resolver version.

The held-out generator family is never used to tune the curriculum, reward, thresholds or analysis.

## Pretraining conditions

The core design contains six factorial cells plus one anchor.

### Factor A — relational information

**E — epistemically informative**

Metadata and relations correctly correspond to the microworld's source genealogy and outcome-relevant evidence structure.

**N — nonce relational control**

The same kinds of metadata, relation tokens and recurring source identities remain present, but their mapping to outcome-relevant epistemic structure is permuted.

N must preserve as far as practical:

- token budget;
- field vocabulary;
- source-ID recurrence frequencies;
- source-group sizes;
- support/contradiction edge counts;
- graph-degree distribution;
- marginal reliability frequencies;
- example lengths;
- number of demonstrations.

The intended destruction is specifically the relation between the metadata and the world's correct epistemic inference.

N is **not assumed neutral**. It may teach the model to ignore source relations or otherwise harm learning. That is why the anchor exists.

### P — plain anchor

P receives the same underlying world facts without persistent relational metadata, under uniform timing only.

P exists to interpret E and N:

~~~text
E vs P  -> does useful epistemic structure help?
N vs P  -> does meaningless relational structure hurt?
E vs N  -> useful relation versus matched relational control
~~~

P is not part of the primary timing interaction because it has no early/late manipulation.

Its token and compute budget must be matched without adding another persistent grouping signal. The exact token-matching method is frozen after the pilot and before confirmatory training.

## Timing factor

E and N each have three timing conditions:

- **Early**
- **Uniform**
- **Late**

The same epistemically structured examples are used across timing conditions. Only their location in the training history changes.

### Learning-rate control

Timing must not simply mean "high learning rate versus low learning rate."

Use a warmup-stable-decay schedule or equivalent design where the early and late intervention windows both lie on the same stable learning-rate plateau.

A concrete default is:

~~~text
0-5%     warmup
5-95%    stable plateau
95-100%  decay
~~~

with, for example:

~~~text
Early window    10-30%
Uniform         spread across 10-90%
Late window     70-90%
~~~

The final implementation may change these percentages during the pilot, but the confirmatory windows and schedule must be frozen before confirmatory data are generated.

Do not use an ordinary monotonic cosine decay if it makes intervention timing inseparable from learning rate.

## Experimental cells

~~~text
                 Early       Uniform       Late

E / epistemic      E-E           E-U         E-L
N / nonce          N-E           N-U         N-L

P / plain                         P-U
~~~

The same architecture, initialisation family, tokenizer, total training compute, world-fact exposure, optimiser family and non-manipulated data distribution are held fixed.

Where practical, use **matched initialisation blocks**: seed (s) starts every condition from byte-identical initial weights. Treat seed block as a dependency in analysis rather than pretending these runs are independent.

## Competence control

E and N may differ in their ability to exploit evidence, so a simple "identical competence" requirement can itself become a selection bias.

Before downstream shortcut training, evaluate a competence battery where provenance does not affect the correct answer.

Report condition differences.

If material competence differences remain:

- do not discard inconvenient runs post hoc;
- include the preregistered competence measure as a covariate or stratification variable;
- report raw and adjusted results.

The pilot defines the competence floor required for the microworld task to be meaningful.

## Pilot before confirmatory training

Five seeds per cell is only a provisional budget, not a claim of adequate power.

Run a cheap pilot first.

The pilot may determine:

- model scale within the small-model range;
- token budget;
- whether the model reaches the capability floor;
- seed-to-seed variance;
- whether the planned shortcut doses span a useful degradation range;
- whether floor/ceiling effects break the proposed metric;
- the token-matching implementation for P;
- the stable learning-rate window;
- the final number of independent pretraining seed blocks required for the planned contrast.

Pilot lineages are **not reused as confirmatory evidence**.

After the pilot, freeze the confirmatory contract and perform a simulation- or bootstrap-based power analysis for the primary contrast.

If the available compute cannot support the chosen detectable effect, label the study exploratory rather than interpreting a null as evidence of no developmental effect.

## Downstream conflict stress test

Every confirmatory pretrained lineage is forked into matched downstream branches.

Initial planned shortcut-favouring doses:

~~~text
0%
2%
10%
50%
~~~

The percentage denotes the share of downstream training examples or reward opportunities that explicitly favour the shortcut over the gold epistemic policy.

The exact construction must be deterministic and frozen before confirmatory runs.

All branches from one lineage start from the exact same checkpoint and share downstream hyperparameters apart from the declared dose.

These branches are repeated observations from one lineage, not new independent pretraining replicates.

## Primary outcome: within-lineage degradation

Do **not** use an absolute (D_{50}) such as "dose required to fall below 50% correct."

Absolute thresholds are biased by different pre-RL starting performance.

The primary outcome is degradation relative to each lineage's own zero-dose behaviour.

Prefer an item-level or aggregate model that estimates a **dose-response decay slope** while retaining a separate intercept for each lineage / seed block.

A descriptive quantity may be:

[
Delta_i(d) = operatorname{logit}(p_{i,d}) - operatorname{logit}(p_{i,0})
]

with a preregistered smoothing rule for exact 0/1 rates.

The confirmatory statistical model should respect:

- downstream doses nested within pretrained lineage;
- matched initialisation seed blocks;
- repeated evaluation items / worlds where applicable;
- generator family.

The precise model specification is frozen after pilot diagnostics and before confirmatory data.

## One primary planned contrast

Do not make the confirmatory claim depend on an omnibus three-way interaction with many degrees of freedom.

The primary developmental contrast is the difference in **dose-response resistance** between early and late epistemic training, corrected by the same timing difference in the nonce control:

[
C =
(R_{E,early} - R_{E,late})
-
(R_{N,early} - R_{N,late})
]

where larger (R) means slower degradation under conflicting optimisation.

The developmental hypothesis predicts:

[
C > 0
]

under the chosen sign convention.

This is the one confirmatory developmental test.

Secondary/exploratory analyses may include:

- E-U versus P-U;
- N-U versus P-U;
- E-E versus E-U;
- E-U versus E-L;
- pre-RL performance by timing;
- recovery after removing conflicting reward;
- calibration;
- abstention;
- evidence acquisition;
- contradiction response;
- source-independence reasoning.

Multiplicity handling for secondary tests must be stated before confirmatory analysis.

## Directional prediction

Prior work makes a useful split possible.

Pre-register the possibility that **late training has the stronger immediate effect**:

[
	ext{Immediate performance: Late} gtrsim 	ext{Uniform} gtrsim 	ext{Early}
]

while the genuinely developmental hypothesis predicts:

[
	ext{Resistance to later conflict: Early} > 	ext{Uniform} > 	ext{Late}
]

after the nonce timing effect is accounted for.

If late wins both immediately and under conflict, the developmental hypothesis is not rescued post hoc.

If timing has no meaningful effect once content and controls are matched, report the developmental hypothesis as unsupported in this setting.

## Evaluation conditions

The main held-out evaluation removes training metadata.

Use:

- unseen source IDs;
- unseen entity names;
- new surface forms;
- new graph instances;
- the held-out generator family;
- metadata-free natural-language prompts where the needed latent structure is inferable from evidence.

Include a manipulation check for the opposite regime: prompts where the latent structure is genuinely underdetermined. A model should not be penalised for failing to infer information that is absent.

This distinction matters because metadata-conditioned models can become dependent on metadata that is unavailable at inference.

## Shadow measurement

During downstream training and evaluation, Magpie-derived measurements remain outside the optimiser.

Candidate shadow quantities include:

- unsupported-claim rate;
- evidence acquisition;
- repeated-origin use;
- response to counterevidence;
- confidence relative to later gold resolution;
- claims later undermined by new evidence;
- exact provenance lineage;
- policy-scoped standing under an explicitly selected Magpie policy.

A shadow quantity that later becomes reward is no longer a clean shadow monitor.

The synthetic world remains the source of gold truth throughout.

## Failure criteria and interpretation

| Result | Interpretation |
| :--- | :--- |
| E-U > P-U, but no timing effect | epistemic content helps; developmental claim unsupported |
| N-U < P-U | nonce metadata is harmful; E-vs-N alone would have overstated the content effect |
| E early degrades more slowly than E late, but N shows the same timing pattern | generic curriculum/timing effect, not specifically epistemic |
| planned contrast (C>0) and survives held-out generator family | evidence for developmental timing in this microworld |
| effect disappears on held-out generator family | likely generator-specific shortcut |
| late is strongest immediately and most resistant | evidence against the predeclared developmental direction |
| all conditions collapse under small conflict dose | early history is brittle in this setting |
| no cell reaches competence floor in pilot | model/task pair is unsuitable; do not interpret alignment conclusions |

A positive result supports only the tested synthetic setting, architecture, scale, optimiser, curriculum and downstream stressor.

## Repository split

This file belongs in Endophasia because it states the experiment contract the substrate may eventually execute and record.

Executable research should live in a dedicated repository, proposed name:

~~~text
noctem-o/developmental-epistemics
~~~

Suggested responsibility split:

~~~text
developmental-epistemics/
  README.md
  docs/
    protocol-v0.md
    preregistration-v0.md
  generators/
    g1-provenance/
    g2-context/
    g3-holdout/
  training/
  configs/
  schemas/
  analysis/
  tests/
  adapters/
    endophasia/
    magpie/
  results/
    README.md
  data/
    README.md
~~~

The dedicated repository owns generator code, training code, analysis code, exact configs, frozen manifests and compact result summaries.

Large raw checkpoints and trajectories should live outside git with content digests and restoration instructions, following the same general discipline already used for Endophasia research data.

Endophasia should record exact external repository revision and experiment coordinates when it executes the study.

## Non-goals for v0

This study does not attempt to:

- train a generally useful language model;
- demonstrate broad deception or scheming;
- establish that developmental training solves alignment;
- use Magpie standing as truth;
- use Magpie features as reward;
- test hippocampal consolidation or external runtime memory;
- compare alternative neural architectures;
- compare NTP against diffusion/JEPA pretraining;
- infer frontier-model behaviour from tiny models;
- optimise a large value vector;
- prove a causal mechanism inside the weights.

Those are possible later studies only after this minimal design earns them.

## Promotion rule

Do not promote this design into a general Endophasia alignment claim because the code runs successfully or a rewarded metric improves.

A result becomes worth broader follow-up only if:

1. the confirmatory contract was frozen before confirmatory runs;
2. the primary planned contrast was adequately powered;
3. the result survives the whole-generator-family holdout;
4. raw and baseline-adjusted results agree in direction;
5. competence differences do not explain the effect;
6. the effect is reproducible across independent seed blocks;
7. all experiment coordinates and relevant artifacts are retained;
8. negative and null outcomes remain visible.

The strongest v0 result would be narrow:

> In a controlled synthetic microworld, epistemically informative relational training acquired earlier changed the rate at which behaviour degraded under later shortcut-favouring optimisation, beyond matched metadata and timing controls.

Anything broader requires another experiment.
