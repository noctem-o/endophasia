# Counterfactual replay: feasibility and experiment design (COUNTERFACTUAL-REPLAY-001)

**Question.** Can Endophasia run *executable counterfactuals*? That means: take a recorded run, return to a point in it, change one thing,
continue, and attribute a difference in outcome to that change.

**Answer, in short:**
- **Feasible at the initial checkpoint now.**
- **Feasible at a mid-run checkpoint with two additions:**
  - a pinned clock inside the sandbox;
  - an upstream that serves the recorded prefix and then hands over to the live model.
- **Attribution is distributional, never from one replay.** Two measurements made for this document (§4) show it on a real model:
  - the model's decisions are stochastic **from the very first request**;
  - a cassette replay diverges at the first tool output that reads the clock.

Date: 2026-11-08. Built on EVAL-ISO-002 (PR #134): every measurement below ran in its sandbox, through its relay. **This branch is based on
#134 and must be merged after it.**

## 1. Three things that are easy to confuse

| | What is held fixed | What it can show | What it cannot show |
| :-- | :-- | :-- | :-- |
| **Deterministic cassette replay** (exists: [docs/replay.md](../../docs/replay.md)) | the model's responses, byte for byte | whether Pi's *control flow* reproduces, given the same responses | anything about the model: its determinism, quality or variance |
| **Decision reproduction** | the model's inputs (the same request) | whether the *model* chooses the same action again | why it chose; a reproduction under one setting says nothing about another |
| **Executable counterfactual** | everything up to a checkpoint, then one declared change | the *distribution* of outcomes with and without the change, from that checkpoint | a causal account of any single trace |

**A trace is not an experiment.** "The run failed because the model ran `ls -la`" is a story about one trace. A counterfactual claim
needs the same checkpoint, run repeatedly with and without the change, and a difference in outcome rates. It never comes from reading a
trace, however detailed (§6).

## 2. What exists

| Capability | Where | Relevant because |
| :-- | :-- | :-- |
| Capture of every model exchange, and cassettes that verify | `adapters/openai-proxy/record.ts`, `cassette.ts` | model responses can be served exactly; misses are explicit (`unexpected-request`) |
| Replay of a scripted Pi session from a cassette, judged layer by layer | `endo replay`, `cli/cassette-session.ts`, [docs/trajectory.md](../../docs/trajectory.md) | the control-flow half of a counterfactual |
| Workspace snapshots with file times (`endo.workspace-archive.v1`) and pinned environments | `storage/workspace-snapshot.ts`, `capture.environment` | filesystem state at the initial checkpoint |
| STOP, kill and intervention points replayed at the recorded chunk | `cli/cassette-session.ts`, [docs/steering.md](../../docs/steering.md) | a precedent for "act at a recorded point" |
| A verified initial-state checkpoint, materialised into isolated scratch, and sibling branches | [checkpoint-candidate](../../docs/checkpoint-candidate.md), [checkpoint-materialization](../../docs/checkpoint-materialization.md), [initial-branch-set](../../docs/initial-branch-set.md) | branching **at the initial state** is already a governed operation |
| A fresh child execution from a verified pre-execution checkpoint, with one changed runtime setting | [initial-child-execution](../../docs/initial-child-execution.md), [initial-continuation](../../docs/initial-continuation.md) | the closest existing thing to a counterfactual: same start, one change, new evidence |
| A sandbox with confirmed termination, a narrow model relay, resource limits and a sealed, independently verified trial record | EVAL-ISO-001, EVAL-ISO-002 (#134) | interventions isolated from the host; every arm's model access recorded |

## 3. Feasibility, dimension by dimension

| Dimension | Today | Verdict |
| :-- | :-- | :-- |
| **Checkpoint fidelity** | Initial state: exact. That is the workspace archive with times, or EVAL-ISO-002's empty workspace plus digested runtime, Pi `dist`, agent configuration and profile. **Mid-run: there is no checkpoint at all.** | Initial: **feasible now**. Mid-run: only as *prefix replay*: rebuild the state by replaying the recorded prefix through a fresh Pi (below) |
| **Filesystem state** | Snapshotted and restored at the start. During a run, tools change it, and replaying the prefix redoes those changes | Feasible, **if** every tool in the prefix is deterministic on the restored state. Measured: they are not when they print times (§4) |
| **Process state** | Not captured. Pi's memory, open tool processes and background jobs cannot be checkpointed. CRIU-style process checkpointing is out of scope, and fragile for Node | **Not feasible as a snapshot.** Feasible *logically*: a fresh Pi rebuilt by replaying the prefix, so that the conversation is the state. Background processes started in the prefix are re-started by the replay, or are a divergence |
| **Random-number state** | Pi's requests carry no random ids: the first request was identical (canonical JSON) in the source run, its 3 repeats and the replay (§4). The model's sampling is random. Pi 1.5.0 sends no `seed`, `temperature` or `top_p` (checked in the recorded request), so the server's defaults decide them | Pi side: **deterministic enough** (measured). Model side: **stochastic by default**. A fixed `seed` with temperature 0 may reduce, but not guarantee, reproduction (batching and GPU arithmetic). This would be measured, never assumed |
| **Model response replay** | Exact: cassettes serve recorded bytes, and verify | **Feasible now** for the prefix. After the checkpoint, responses must be live, or the counterfactual is not one |
| **Tool response replay** | Tools are re-executed on replay, not replayed. Re-executing is what makes a prefix replay check its own fidelity: a divergence shows | Re-execute, under a **pinned clock**. Replaying tool outputs instead would hide prefix infidelity, and is rejected for counterfactual use |
| **Intervention isolation** | EVAL-ISO-001/002: each arm runs in its own sandbox from the same digested inputs, and the record names every input by digest | **Feasible now**: two arms' records can be diffed, and must differ in exactly the declared intervention |
| **Outcome attribution** | Independent evaluators exist (function cases). Model-connected trials have none yet (#134 §7) | **Feasible as a distributional contrast** (§5). Not from single traces |
| **Replay validity certificates** | A trial record is sealed and verified; replays report served counts and misses | **Feasible**: a certificate is a sealed record of the checkpoint's identity, the prefix's fidelity, the switch point, the isolation and the verifier (§5.3) |

## 4. Measurements (2026-11-08; Pi 1.5.0, Muse Glimmer 30B, EVAL-ISO-002 sandbox)

**Source trial:** `trial-20261108-195634`. Pi was asked to create `hello.txt` containing `hello`. It did, in 10 exchanges.

**A. Deterministic cassette replay of that trial** (`probe.ts replay`):
- A fresh sandbox was made from the same digested inputs. The relay's upstream was the trial's cassette instead of the model.

| Measure | Result |
| :-- | :-- |
| Recorded exchanges | 10 |
| Replayed requests | 2 |
| Served from the cassette | 1 |
| Misses | 1 (`unexpected-request`) |
| First divergence | exchange 2, message 4, a **tool** result: classified `environment` |

- **The first request matched exactly.** Pi's prompt carries no clock, date or random id that differs between runs.
- **The second request carries the output of the model's first tool call, `pwd && ls -la`.** `ls -la` prints the workspace's modification
  times, which differ on replay. This is the wall-clock limit [docs/replay.md](../../docs/replay.md#the-wall-clock-limit) describes,
  observed inside the sandbox on the first tool call of a real model.

**B. Decision reproduction** (`probe.ts repeat`): the same task, from the same initial state, 3 more times against the live model.

| Run | Exchanges | First tool call | Tool sequence | Workspace | Answer |
| :-- | --: | :-- | :-- | :-- | :-- |
| source | 10 | `bash pwd && ls -la` | 9 calls | `fe47bd00…` | `d117fa00…` |
| repeat 1 | 8 | the same | 7 calls, different from the 2nd on | same | same |
| repeat 2 | 7 | the same | 6 calls, different from the 4th on | same | same |
| repeat 3 | 5 | **`write`**: a different first decision | 4 calls | same | same |

- **The first request was identical in all four runs** (the same canonical digest). The **first decision still differed** once in four.
  The model's sampling is stochastic from the first token of the run, independent of any tool output.
- **Four distinct trajectories, one outcome:** the same workspace digest and the same answer in all four. On this task, outcome-level
  reproduction holds while trajectory-level reproduction does not.
- **n = 4 on one trivial task.** This is a feasibility observation, not an estimate of anything.

**What A and B establish together:**
- Cassette replay of a real model run is limited by tool outputs that read the clock, **before** model stochasticity even matters.
- Reproducing a model's decisions cannot be assumed even when its input is byte-identical.
- So a counterfactual must hold the clock fixed for its prefix, and must treat the post-checkpoint continuation as a sample from a
  distribution.

Data: `~/projects/endophasia-research/counterfactual-replay/` (`replay-*/summary.json`, `repeat-*/summary.json` and the trial directories).
It is kept outside the repository, like all raw data. The probe is [probe.ts](probe.ts).

## 5. Experiment design: CF-001, executable counterfactuals at a checkpoint

### 5.1 Mechanism (what must be built; each part is an owner decision)

1. **A pinned clock in the sandbox.**
   - What: the time functions return a fixed, declared instant that advances deterministically (for example by an LD_PRELOAD faketime
     library mounted as part of the declared runtime).
   - Why: it removes the measured divergence (A).
   - Note: Endophasia's rule today is that "a replay never fakes time". This would be a **declared experiment condition** for
     counterfactual runs, exactly as a pinned environment is. It is not a change to replay in general.
2. **A prefix-then-live upstream.**
   - What: behind the same relay, serve recorded exchanges 1..k from the cassette, verifying each replayed request against the recorded
     one. At exchange k+1, forward to the live model.
   - It is a composition of the cassette server and the relay that already exist.
   - **Any miss before k invalidates the run.** It does not fall back to the live model.
3. **Arms as protected trials.** The factual arm and the intervention arm are both EVAL-ISO-002 trials from the same digested inputs,
   identical except for the declared intervention, for example:
   - one steering message inserted at k+1;
   - one context card;
   - one changed tool in the runtime set;
   - one changed file in the checkpoint workspace.
4. **An independent evaluator** for the outcome: EVAL-ISO-001's function-case evaluator, in its own sandbox.

### 5.2 Design

- **Checkpoints:** k ∈ {0, 3, 6}, on each of T tasks. k = 0 needs no prefix machinery, and is the first stage.
- **Arms:** null (A/A: the same inputs, both arms) and one intervention. They are randomized and blocked per checkpoint.
- **Samples:** N continuations per arm per checkpoint. N is chosen in advance from the A/A stage's measured variance, to detect a
  pre-registered effect size. A first planning value, for a binary outcome: a base rate near 50%, a 20-point difference, 80% power and
  α = 0.05 give about 90 per arm, pooled over checkpoints. The pilot (stage 0) replaces this with the measured rate.
- **Outcome:** the evaluator's pass or fail. Exchanges and tool sequences are reported, not judged.

### 5.3 The replay validity certificate (per run; sealed, verified like the EVAL-ISO-002 trial record)

```text
certificate
  checkpoint   { task, k, workspaceArchiveSha256, piDistSha256, runtime[], profileSha256, relayPolicyDigest, clock: { pinned, start } }
  prefix       { cassetteKeyId, recordedRequestDigests[1..k], replayedRequestDigests[1..k], served: k, misses: 0 }   // all must hold
  switch       { atExchange: k + 1, upstream: "live", model }
  intervention { arm, declaredDelta: { kind, digest }, inputsDiff: [exactly the declared delta] }
  isolation    { boundary: "model-relay", termination: "confirmed", limits }
  outcome      { evaluator: { definitionSha256 }, result, cases }
  validity     [ "prefix-miss" | "termination-unconfirmed" | "inputs-differ-beyond-delta" | "evaluator-unqualified" | ... ]
  certificateSha256
```

A run with any validity condition is **attrition**, reported by condition, and never counted as an outcome.

### 5.4 Acceptance criteria (measurable, fixed before the main run)

| # | Criterion | Threshold | Stage |
| :-- | :-- | :-- | :-- |
| 1 | Checkpoint fidelity: a restored workspace's tree digest equals the recorded one | 100% of runs | every stage |
| 2 | Prefix fidelity under a pinned clock: prefixes that reach k with zero misses | ≥ 95% at k = 3; ≥ 90% at k = 6; every miss classified (`environment`, `control-flow`) | stage 1 |
| 3 | Intervention isolation: arm inputs differ in exactly the declared delta | 100%, by diffing the certificates | every stage |
| 4 | Termination confirmed, and the boundary established | 100% (any other result is attrition, reported) | every stage |
| 5 | A/A calibration: the null contrast's outcome difference interval includes 0 | it must hold before any intervention is run | stage 0 |
| 6 | Attribution: an effect is claimed only if its interval excludes 0 in the pre-registered direction **and** criteria 1 to 5 hold | as stated | stage 3 |

### 5.5 Stages

0. **A/A at k = 0** (no new mechanism). Measure the outcome variance from the initial checkpoint. §4B is its n = 4 smoke test.
1. **Prefix fidelity** with a pinned clock (mechanism 1). Replay recorded prefixes and measure criterion 2. No model is called before k.
2. **Prefix-then-live** (mechanism 2), still A/A, at k ∈ {3, 6}. This measures whether the switch adds variance or invalidity.
3. **The intervention study.**

Each stage reports before the next starts, and a failed criterion stops the sequence with a written reason.

## 6. What this does not claim, and must not

- **No causal attribution from observational traces.** Not from the trajectories in §4, nor from any recorded run. A trace shows what
  happened once.
- **A cassette replay that matches** shows that Pi's control flow reproduced given fixed responses. It shows nothing about the model.
- **Outcome reproduction on one task** (§4B) does not show that outcomes reproduce in general. It shows only that, on a trivial task,
  different trajectories can converge.
- **A pinned clock changes the environment.** Results under it hold for that condition. Whether they transfer to unpinned runs is itself
  a question.

## 7. Decisions for the owner

1. **A pinned clock as a declared condition** for counterfactual runs. This is an exception to "a replay never fakes time", scoped to
   CF runs.
2. **Building the prefix-then-live upstream**, which composes the cassette server with the EVAL-ISO-002 relay.
3. **The certificate as a research record first** (like `endo.model-connected-trial.v0`), or directly as a product record.
4. **Whether stage 0 should run now**: it needs nothing beyond #134 and an evaluator for the task.
