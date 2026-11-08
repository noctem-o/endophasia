# Experience dataset v1: research design (EXPERIENCE-001)

**Question.** Can Endophasia produce qualified, reusable *experience bundles* from the records it already keeps? A bundle is one task
attempt, with what it started from, who acted, what happened, what was produced, how it was checked and decided, and under which
conditions. Each bundle is qualified for what it may be used for.

**Answer, in short:**
- **Yes, as a derived projection.** Every field a bundle needs already has a canonical home in an existing record, or is a named gap below.
  Nothing requires a second authoritative store.
- **The projection should be an extension of MEM-000's**, not a new one.
- **No prototype is built here** (§6): the source that would make one worth building is not yet a product record.
- **MEM-000 lacked diversity by construction, not by bad luck** (§4). §5 is a concrete experiment to produce the missing material.

Date: 2026-11-08. Main at `c7fee52`. Inputs read:
- MEM-000 ([evidence-eligibility/RESULTS.md](../evidence-eligibility/RESULTS.md) and its manifest);
- the record formats in `protocol/`;
- the experiment specs under `research/`;
- EVAL-ISO-001 ([docs/protected-experiments.md](../../docs/protected-experiments.md));
- EVAL-ISO-002 as proposed in PR #134 (docs/protected-model-access.md on that branch);
- WORK-CYCLE-001A/B and REVIEW-PILOT-001 (#131).

## 1. Principles

1. **Derived, never authoritative.** A bundle is a projection: it names its sources by path and digest, and is re-derivable from them,
   byte for byte. The event log, the capture log, the attempt records and the trial records stay the only authorities. A bundle that
   disagrees with its sources is wrong, not the sources.
2. **Versioned.** A bundle names its projection version (`endo.experience-bundle.v1`) and its extractor version, as MEM-000's report
   does (`extractor 0.3.0`). A new rule is a new extractor version; old bundles are not rewritten.
3. **Unknown is not false.** A field whose source is missing, damaged or never recorded is `unknown` with a reason, never a default.
   This is EVIDENCE-INTEGRITY-001's rule (#130), applied to the projection.
4. **Eligibility is per objective**, with the reasons that remove it: MEM-000's contract (`descriptive`, `symptom`, `lesson`,
   `causal-policy`), reused as is and extended only by new reasons.
5. **Content is tiered.** By default a bundle carries digests, lengths, counts and closed vocabularies. Prompt, transcript and output
   text stay in the blob stores they already live in, behind their keys, and are referenced, not copied.

## 2. Where each dimension lives today

Status words:
- **recorded**: a field exists in a versioned record;
- **derivable**: it can be computed from recorded material by a stated rule;
- **operator**: declared by the operator, not observed;
- **missing**: nothing records it.

Sources:
- **E**: experiment runs and trials (`endo.experiment-run.v0`, `endo.experiment-trial.v0/v1`);
- **P1**: offline protected trials (`endo.protected-trial.v0`, EVAL-ISO-001);
- **P2**: model-connected protected trials (EVAL-ISO-002, research record `endo.model-connected-trial.v0`, PR #134);
- **D**: DEVELOP attempts and the session around them (tasks, attempts, authorisations, receipts, the event log;
  `endo attempt evidence`).

| Dimension | E | P1 | P2 | D |
| :-- | :-- | :-- | :-- | :-- |
| **Task identity** | recorded: the task id in the plan; the brief in the spec | recorded: task id, spec digest | operator: the prompt (digest) | recorded: task id, revision; the frozen title, description and acceptance copied into the prepared attempt |
| **Acceptance criteria** | derivable: the hidden check's argv in the spec (not its meaning) | recorded: the evaluator definition by digest, with cases kept in the controller | **missing** (the driver has none yet) | recorded as **text** (`task.acceptance`, frozen at preparation); machine-checkable only through receipts the operator runs |
| **Initial environment state** | recorded: the workspace snapshot (`endo.workspace-archive.v1`) in the capture log; the pinned environment (`capture.environment`) | recorded: the agent tree digest and the profile digest | recorded: the Pi `dist` tree digest, the runtime files by digest, the profile; the workspace is empty | **missing**: a prepared attempt records no baseline commit (MEM-000 §4.4); `attempt evidence` reads HEAD *now* |
| **Model identity** | recorded: the model name in the spec; v1 trials add request-parameter values | n/a (offline) | recorded: the model name, pinned by the relay; **not** the served weights' digest | **missing** (WORK-CYCLE-001A §7, 001B §5.6) |
| **Harness identity** | v1: the effective harness surface by keyed digest; v0: an unversioned session file | recorded (the agent tree) | recorded (the dist digest) | recorded: the Pi fingerprint (`harness.attached`) |
| **Trajectory** | recorded: the event log (Pi's entries, tool calls by keyed digest) and the capture log (every exchange) | stdout digest only | recorded: the capture log (a verified cassette) and Pi's session directory | recorded: the event log of the attachment, joined to the attempt by exact ids |
| **Artifact provenance** | derivable: the workspace at the end; nothing binds an artifact to a decision | recorded: the submission manifest (path, bytes, sha256), collected after confirmed termination | recorded: the workspace tree digest | **missing**: no record names a candidate revision (001B §5.3); the operator's commit is not bound to the attempt |
| **Verification evidence** | recorded: the check's exit and output digest; output kept for some studies only (420 trials have none) | recorded: an independent evaluator in a second sandbox, qualified against a reference and a negative | **missing** (no evaluator in the research driver) | recorded: receipts (exit, byte counts, revision, relation to HEAD), output **not** kept |
| **Human decisions** | n/a, except exclusions written in study prose | n/a | n/a | recorded: the terminal authorisation (approval phrase), the status history; **not** which revision was reviewed (001B §5.4) |
| **Experiment conditions** | recorded: the condition in the spec; randomized, blocked order | recorded | recorded: limits, policy digest, runtime set | n/a: the operator chose (`assignment-not-randomized`) |
| **Validity / eligibility** | machine-readable for 2 of 6 studies; prose for 4 (MEM-000 §4.1) | recorded: invalidating conditions in every record; the reader refuses contradictions | recorded: the verify checks | derivable: `attempt evidence` gaps |
| **Isolation boundary** | **missing**: 0 of 85 runs (MEM-000) | **recorded**: preflight probes, scope, termination | **recorded**, plus the relay's policy | missing (a live session is the operator's own) |

**What the table says.** The protected trial records (P1, and P2 once it is integrated) are the first source that carries a full bundle:
- a boundary;
- an independent verifier;
- artifact provenance;
- conditions;
- with P2, a trajectory.

The DEVELOP records carry the human decisions no experiment has, but three fields that would make a DEVELOP bundle qualified are missing:
- the baseline commit;
- the candidate revision;
- the model identity.

## 3. The bundle (proposal, `endo.experience-bundle.v1`)

One JSON document per attempt, derived and sealed. Fields, each with a `source` (record path and digest) or `unknown` and a reason:

```text
bundle
  schemaVersion, extractor, derivedFrom: [{ path, sha256, version }], bundleSha256
  task        { id, revision?, acceptance: { kind: "evaluator" | "check-argv" | "text", digest }, family, difficultyTier? }
  initial     { workspace: { kind: "archive" | "tree-digest" | "commit" | unknown, digest }, environment: { pinned?, runtimeSet } }
  actor       { harness: { name, version, fingerprint }, model: { name, servedDigest? | unknown }, sampling?: { keyed digest } }
  conditions  { study?, condition?, randomized: boolean, assignment: "plan" | "operator", limits?, isolation: { boundary, profileSha256 } | unknown }
  trajectory  { source: "capture-log" | "event-log", exchanges, toolCalls: [{ name, status, argsDigest }], turns, endedBy }
  artifacts   [{ path, sha256, bytes, collectedAfter: "confirmed-termination" | "operator-commit" | unknown }]
  verification{ kind: "independent-evaluator" | "in-workspace-check" | "receipt" | none, outcome, cases?: { passed, failed }, outputDigest? }
  decisions   [{ kind: "authorisation" | "status" | "exclusion", by: "operator" | "study", at, revisionReviewed: unknown }]
  eligibility { descriptive, symptom, lesson, causal-policy: { eligible, reasons[] } }      // MEM-000's contract
  caveats     [ "pilot-stage" | "task-examined" | "runtime-set-limited" | ... ]
```

**New eligibility reasons this would add** (each from a gap in §2):
- `acceptance-text-only`: a DEVELOP attempt whose acceptance has no machine check bound to it. It removes `lesson` as evidence of success,
  not `descriptive`.
- `baseline-unrecorded`: the initial state cannot be re-materialised. It removes `causal-policy` and any replay use.
- `candidate-unbound`: no record binds the artifact to the attempt. It is MEM-000's `artifact-unbound`, generalised to protected trials
  without a submission.
- `model-unidentified`: the model's name is known but not the served weights. It removes `causal-policy` across model contrasts.
- `runtime-set-limited`: the agent asked for tools its runtime does not hold (observed in EVAL-ISO-002's real trial: 4 of 9 tool calls
  exited 127). A **caveat**, not an exclusion: the condition is part of what was measured.

**Where it lives:** `research/evidence-eligibility/`, as a new source adapter beside `experiment-source.ts` and `develop-source.ts`
(`protected-source.ts`), and a bundle writer over the existing examples. Not under `protocol/` or `storage/`: it is a research projection,
and promoting it would be a separate decision.

## 4. Why MEM-000 lacked eligible diversity

From MEM-000's own numbers and the committed specs:

| Axis | What the corpus holds | Why |
| :-- | :-- | :-- |
| **Models** | one: `qwen3.8-27b`, in every study | Every study measured the *harness* (variance, pinned environment, steering, path sensitivity, cap) with the model held fixed, which is correct for those questions |
| **Harness** | one release: Pi 1.0.1 | Same reason; and Pi has since moved to 1.5.0, so every card is out of scope until re-qualified |
| **Tasks** | 15 distinct: 3 small ones (`fix-failing-test`, `implement-function`, `tool-use`) used by four studies (two of them use only two of the three), and 12 discriminating tasks, 4 of them reused by the cap study | Measurement studies need tasks that usually pass, so that variance and steering effects are visible. A task bank built to discriminate was built once |
| **Failures** | 79 failed checks, all on 4 tasks; 11 specific failures with reasoning on, 10 of them one rule of one task | Few tasks, a capable model, and tasks chosen to be passable |
| **Readable evidence** | 420 trials with no check output and no content; 1,006 without a machine-readable validity reading | The record formats of the time: outputs were digested, not kept; validity was written as prose |
| **Evaluation** | 0 runs with an isolation boundary; the check runs in the agent's own workspace | The runner had no boundary (EVAL-ISO-001 added one later) |

**The root cause is a purpose mismatch.** The corpus was built to measure a fixed agent's behaviour under controlled harness changes. An
experience dataset needs the opposite:
- **variation** in tasks, models and difficulty;
- **failures** that recur across tasks in recognisable forms;
- an **evaluator** whose verdict the agent cannot influence.

Rereading the old data more cleverly cannot recover what it was not designed to contain. MEM-000 said the same ("new failure material, not
a better selector").

## 5. Proposed experiment: EXPERIENCE-DIVERSITY-001

**Goal.** Produce failure material that MEM-000's readiness rules would judge sufficient for MEM-001. **Success means producing qualified
material, not producing lessons.**

**Prerequisite (owner):** EVAL-ISO-002 integrated into `endo experiment protected-run`, or the research driver extended with an evaluator.
Either way, every trial needs:
- a boundary;
- the relay;
- an independent evaluator;
- a sealed record.

**Design:**
- **Task families: 8 new**, written for this study and never shown to any agent or reviewer before the main run. Each family has 3
  difficulty tiers, with function-case evaluators (EVAL-ISO-001's kind), a reference and a negative.
  - Families are chosen so that failure modes can recur *across* families. Examples: boundary handling, stated precedence between rules,
    stateful iteration, parsing with escapes, numeric edge cases, and API contracts with optional fields.
  - The **acceptance criteria are executable** (the evaluator's cases), and the **brief states every rule**, so that a failure is a failure
    to follow a stated rule, not a hidden requirement.
- **Models: 2 local models of different capability** behind the relay: Muse Glimmer 30B, and a small Qwen3 (1.7B, present on the router).
  Capability differences are the cheapest source of failure diversity, and both are local: no cost.
- **Harness:** Pi 1.5.0, fixed. **Runtime set:** declared and fixed (§3, `runtime-set-limited`), including the tools a model plausibly
  asks for (`wc`, `od`), so that the runtime is not itself the dominant failure.
- **Completion:** a cap that does not bind (MEM-000's first lesson); reasoning on.
- **Plan:** blocked randomization over family × tier × model, 3 trials per cell: 8 × 3 × 2 × 3 = **144 trials**. Every planned trial
  stays in the denominator.
- **Pilot first:** 2 families × 3 tiers × 2 models × 2 trials (24 trials) to calibrate tiers. The main run proceeds only if each model's
  pilot failure rate is between 20% and 70% overall, so that neither model passes nearly everything nor fails nearly everything.
  Otherwise the tiers are revised, and the pilot is reported as development data (`task-examined`).

**Measured, with acceptance criteria fixed in advance:**

| Criterion | Threshold | Why |
| :-- | :-- | :-- |
| Qualified trials (boundary established, termination confirmed, evaluator ran or no acceptable submission) | ≥ 90% of planned | attrition must not decide the result |
| Lesson-eligible examples (MEM-000's rules, with the §3 reasons) | ≥ 120 | comparable to MEM-000's 307, from a fresh bank |
| Specific failures (a named case failed while others passed) | ≥ 30, from ≥ 5 families, no family over 30% of them | MEM-000 had 11, 10 from one rule |
| Recurring failure patterns (one stated-rule kind failing in ≥ 2 families) | ≥ 2 | the precondition for a card that transfers |
| Hand-written candidate cards that pass MEM-000's support and **separability** rules | ≥ 2 usable, separable, or over the shared allowance | MEM-000's own bar for "selection matters" |
| Contamination | 0 hidden-material reads (the boundary makes this structural; the probes record it) | MEM-000's cap study recorded one |

**Reported, not judged:** the per-model failure distributions, the runtime-set misses, and the trajectories' tool use.

**Stopping rules:**
- the pilot gate above;
- a family whose evaluator fails its reference or passes its negative is withdrawn before the main run;
- an interruption after an agent started is final attrition (EVAL-ISO-001's rule).

**What it costs:** local compute only. At about 25 s per trial with Glimmer (EVAL-ISO-002's real trial), the main run is on the order of
an hour or two of model time, plus the 1.7B model's time. The real cost is writing 8 families with evaluators, and their independent
review.

**What it would not show:** that any card helps (that is MEM-001), or anything about cloud models or other harnesses.

## 6. Prototype: not built, and why

A prototype bundle writer was considered and **not built** in this change:
- **Its best source is not a product record yet.** P2 (model-connected trials) exists only as a research driver in PR #134. A writer
  built against it would be built against a provisional format the owner has not accepted.
- **Over today's product records it would duplicate MEM-000.** For E and D, MEM-000's extractor already derives eligibility per example
  deterministically. A bundle adds packaging, not knowledge: the gaps in §2 are what limits those sources, and a writer cannot fill them.
- **"No abstractions without a demonstrated need."** The need appears when EXPERIENCE-DIVERSITY-001 produces P2 trials with evaluators.
  The first consumer is that experiment's report.

**What would justify building it:**
1. EVAL-ISO-002 is integrated, so that a protected model-connected trial has a product record.
2. That record carries an evaluator result.
3. A consumer is named (MEM-001, or a replay study), whose inputs the bundle fixes.

Then: `protected-source.ts` in MEM-000's extractor, with the bundle as one more output of the same report, reproduced byte for byte by
its corpus test.

## 7. Cheap repairs that would raise DEVELOP and experiment bundles, independent of this

Each is a separate, small decision for the owner. None changes an existing record's meaning. All are additions.
1. **A baseline commit on a prepared attempt** (`baseline-unrecorded`). The prepared record would gain the HEAD at preparation, observed,
   with its own provenance word.
2. **An observed candidate revision** at dispatch and at the run's end (001B §5.3, approach 3). It must be worded so that it cannot be read
   as authorship.
3. **Model identity in the attachment record**: the served model's name and, where the server reports it, a weights digest
   (001A §7).
4. **Machine-readable validity readings** for the four prose-only studies (MEM-000 §4.1). These are mechanical transcriptions, but they
   add no failure material, as MEM-000 showed.
5. **Process cleanup as evidence** (LIVE-PROCESS-CONTAINMENT-001, PR #133, deferred decision 1). A bundle could then say whether a
   DEVELOP run's processes were confirmed ended.

## 8. Decisions for the owner

1. Whether the bundle belongs in MEM-000's extractor (proposed), or is deferred until MEM-001 is reconsidered.
2. Whether EXPERIENCE-DIVERSITY-001 should be prepared. It needs EVAL-ISO-002's integration decision first.
3. Which of the §7 repairs to make, and in which order. The baseline commit is the cheapest, and unblocks replay as well (see the
   counterfactual replay research).
4. Whether a 1.7B model is an acceptable second subject. It is chosen for failure diversity, not as a target.
