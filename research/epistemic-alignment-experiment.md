# Epistemic alignment experiment: Magpie as a shadow ledger

Status: **a proposed study. It has not been run and has no results.** It is a design and preregistration-style contract, listed
under "Proposed studies — not run" in [README.md](README.md#proposed-studies--not-run). Nothing here establishes an empirical
claim, and no code in this repository executes it.

The text was moved here from the project README unchanged.

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

### Experimental sequence

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

### Budget, power and comparison families

Before any arm is run, predeclare the budget and what it can detect; otherwise a null result is uninterpretable.

- **Run budget and power.** Fix the number of independent seeds per arm, the checkpoint cadence and the smallest
  difference in hacking onset or hack rate the design could detect, together with the significance threshold, target
  power, statistical test and censoring assumptions that define "detect". Onset is a time-to-event outcome with censoring
  (runs that never hack), so plan the analysis for that. A comparison the budget cannot power is reported as
  exploratory, not as evidence of no effect.
- **Stage 0 is a gate with a compute cap.** State the maximum runs and compute at the ~4B scout and at ~8B, and the
  outcome that ends the programme if hacking is still absent at ~8B. Stages 1-3 are not funded from an unbounded
  Stage 0.
- **A-D is one comparison family.** Arms E and I each change exactly one coordinate on purpose (E the training
  prompt, I the interleaved safety data), so the byte-identical guarantee above is lifted for that coordinate only.
  Model checkpoint, harness, sampling policy, task distribution and total budgets stay matched to A, otherwise a
  difference cannot be attributed to the control. Treat them as positive controls against A, in a separate family:
  never pool them into A-D comparisons or the same multiplicity correction, and do not read them as competing
  mitigations.

### What is rewarded and what stays shadow-only

The first calibration treatment rewards only a narrow quantity whose outcome can be independently resolved. It does
not reward the model for *looking* epistemically virtuous. The outcome must be resolved independently of the
policy and of the training proxy, named before training, never by the policy's own grading or by the proxy being
optimized. Two further rules keep the term honest. First, calibration outcomes come from a **training-outcome set that is
disjoint from every held-out and shadow evaluation set**: an outcome the optimizer's reward is computed from is no
longer a clean evaluation surface. Second, the forecast must be about something **the policy cannot influence**
(a fixed external quantity or a held-fixed resolution), not about whether its own answer will be judged correct: a
proper scoring rule only rewards honest forecasts when the forecast does not change the outcome. A design that must
score a policy-influenced outcome has to declare a scoring mechanism built for that case, or treat the arm as
exploratory.

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

### Leading-indicator test

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

### Suppression is not erasure

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

### Evaluation and reporting

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
