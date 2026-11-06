# MEM-000 results: what the recorded evidence permits us to learn

Run on 2026-11-06 over the committed corpus ([corpus.v0.json](corpus.v0.json)): every experiment run in the repository and the raw run
directories of the four studies kept beside it (`../endophasia-research`, [research/DATA.md](../DATA.md)). Main at `74106f925` (the merge of
#125). Report sha256 `eef9c89a3db26445…`; the manifest and summary are in [report/](report/) and are reproduced byte for byte by
`tests/evidence-eligibility-corpus.test.ts` where the archives are present. The rules are in [README.md](README.md).

**The raw archives were read** (they are on the maintainer's machine, not publicly hosted). No DEVELOP store exists on this machine, so the
operational corpus is unqualified, not empty.

## The decision

**Recommendation C: reconsider the initial learning objective.** In this corpus the transferable value is held by fixed operating rules
(a completion cap that does not bind, an isolated evaluator, the workspace path as a registered block), and MEM-001 already holds each of
them fixed across its arms. What is left for retrieval to select is one candidate, drawn from one task, that restates that task's own brief.
A retrieval-against-checklist experiment on this material has no mechanism by which retrieval could differ from a checklist.

Keeping the memory objective would first need new failure material, not a better selector (see "What would change this").

| Judgement | Status | Deciding conditions |
| :-- | :-- | :-- |
| Evidence readiness | **INDETERMINATE** | The experiment corpus is fully read with provenance: 85 runs, every governing file digested, 0 refused, 0 conflicting copies, every exclusion named. But the declared DEVELOP store is absent, so operational attempts are unqualified. Four studies have no machine-readable validity reading. |
| Lesson readiness | **NOT READY** | 8 candidates, 6 supported as stated, **1 usable** in MEM-001. With fewer than two usable cards there is nothing to select between. |
| Evaluator readiness | **NOT READY** | 0 of 85 runs record an isolation boundary, and the run record has no field for one. The missing boundaries are listed below. |
| **Overall** | **NOT READY** | Lessons and evaluator. |

## 1. Which observations are eligible for what

1,834 examples were read; 504 are a second copy of the same record (a committed copy of a raw run), counted once. Of the 1,330 distinct
examples:

| Study | Examples | Descriptive | Symptom | Lesson | Causal policy |
| :-- | --: | --: | --: | --: | --: |
| completion-cap | 232 | 232 | 227 | 187 | 143 |
| discriminating-tasks | 132 | 132 | 120 | 120 | 0 |
| path-sensitivity | 384 | 384 | 384 | 0 | 0 |
| pinned-environment | 240 | 240 | 0 | 0 | 0 |
| steering | 162 | 162 | 162 | 0 | 0 |
| variance | 180 | 180 | 0 | 0 | 0 |
| **total** | **1,330** | **1,330** | **893** | **307** | **143** |

- **Causal policy: 143 examples, all from completion-cap's main run, arms A, B and D.** They form the only valid randomized contrast in the
  corpus with a validity reading. Arm E (48 examples) is invalid by the study's own check. The completion-cap pilot (no validity reading)
  is excluded. Discriminating-tasks assigns a single condition, so it offers no contrast (132).
- **Lesson: 307 examples**, the completion-cap and discriminating-tasks trials whose capture and check output are present and verified,
  whose study names its exclusions, and which were not excluded. Excluded: 5 trials by name (four in arm E, and the arm-B trial that read
  the hidden check). Unresolved: 12 trials whose task's exclusions the discriminating-task pilot counted without naming them.
- **Symptom: 893 examples** whose check output matched its recorded digest. The 420 variance and pinned-environment trials are committed
  with digests and no output: `check-output-absent` and `content-unavailable`, never text.
- Planned trials with no result in the copy read: 384 (copies that keep summaries only, and a post-hoc run that ran 6 of 120 by design).
  They are counted as missing, never as failures.

## 2. Does the evidence support conditional lessons beyond a checklist?

**The failure material is thin and concentrated.** The 893 readable outputs hold 79 failed checks, all on four tasks of one task bank
(discriminating-tasks, reused by completion-cap):

| Failures | With reasoning on | With thinking off (arm E, invalid) |
| :-- | --: | --: |
| every named check failed (nothing working was produced) | 46 | 0 |
| a specific rule failed | **11** | 22 |

The 46 failures where every check failed are what the cap study explains: a response cut off at the cap. Of the 11 specific failures with
reasoning on, **10 are one rule of one task** (markup-lite R5, code spans), and one is booking-conflicts R1. Path-sensitivity and steering
recorded no failed check in 546 readable outputs.

**The candidates** ([lessons.v0.json](lessons.v0.json), written by hand and disclosed as such):

| Card | Lever | Claim | Supported | Usable in MEM-001 | Why not |
| :-- | :-- | :-- | :-- | :-- | :-- |
| raise-binding-completion-cap | completion cap | controlled | yes (B − A +0.41, [+0.09, +0.73]) | no | MEM-001 fixes the cap at 32,768 |
| ask-for-brief-reasoning | agent context | controlled | **no**: interval [−0.13, +0.54] includes 0 | no | its mechanism, fewer cut-offs under a binding cap, is removed by MEM-001's cap |
| thinking-off-for-light-tasks | reasoning mode | controlled | **no**: arm E is invalid | no | lever fixed |
| code-span-content-is-literal | agent context | diagnostic hypothesis | yes (6 specific failures) | **yes** | (see below) |
| proto-key-is-plain-data | agent context | diagnostic hypothesis | yes (2) | no | observed only with thinking off |
| return-copies-from-cache | agent context | diagnostic hypothesis | yes (2) | no | observed only with thinking off |
| isolate-hidden-checks | evaluation | observational | yes | no | a requirement on the evaluator; generic |
| hold-workspace-path-fixed | experiment design | observational | yes | no | a design rule; MEM-001 already blocks on path |

- **The only controlled agent-context intervention in the corpus** (arm D, one sentence asking for brief reasoning) is not a supported
  lesson. Its pooled interval includes zero, it helped one task and not the other, and it worked by avoiding the cut-off that MEM-001 removes.
- **The one usable card is weak on every axis that matters for MEM-001.** All of its evidence is markup-lite, which is development data:
  it was the discriminating-task study's designated holdout, and the cap study read it. The task's own brief already states the rule
  ("inside a code span … no backslash handling"; "any backslash inside a code span is plain text"). Its one visible code-span test has no
  backslash. The failures are of following a stated interaction between rules that no visible test exercised, so the card repeats the
  brief rather than adding knowledge. On a fresh task family it applies only if that task has the same rule.
- **Everything is scoped to Pi 1.0.1.** The target was set to Pi 1.0.1, the setting most favourable to readiness. Under the Pi that is
  integrated now (1.5.0), every card is out of scope until re-qualified, and the selector abstains everywhere (case
  `other-harness-version`).
- **Task-dependent guidance versus defaults.** The supported lessons that generalise ("do not let the cap bind", "isolate the checks", "fix
  the path within a contrast") are operating rules, not context for an agent. The task-dependent ones are tied to one task's rules, or to
  a reasoning mode MEM-001 does not use.

The applicability checks (8 of 8 as specified) show that the selector selects, excludes and abstains by its rules. They are not evidence
that any card improves coding.

## 3. Is there enough to justify MEM-001?

No. MEM-001 compares retrieved cards (R) with a static checklist (S) built from the same experience, under the same 600-token allowance.
R can differ from S only if choosing among cards matters. That needs at least two usable cards that some task would separate, and either more
guidance than fits at once, or a card shown to mislead outside its conditions. The corpus supplies one usable card, about 50 tokens. S can
carry it whole, so R − S would measure nothing the cards could cause. Running the 72 holdout attempts would spend the budget on a contrast
whose answer is fixed in advance.

**Evaluator boundaries missing** (each needed by MEM-001 whatever the cards):
1. The agent can read the host: the repository (which holds past solutions, hidden checks in `spec-pilot.json`, and now raw-derived
   reports), the research archive and other trials. The cap study recorded a hidden-check read and broad deletions in a shared `/tmp`.
2. The success check runs in the agent's own workspace and environment, with no separate verifier environment or artifact export.
3. No network restriction is applied or recorded.
4. An interrupted trial is rerun into the counted set and kept aside, outside the denominator.

## What this establishes, and what remains a hypothesis

**Established (by the rules stated, over this corpus):**
- which examples serve which objective, and why each does not;
- that failure material with reasoning on is 11 specific failures, 10 of them one rule of one task;
- that the one controlled agent-context contrast is inconclusive and depends on a lever MEM-001 fixes;
- that no run records an isolation boundary;
- that the report is deterministic and the sources unchanged by reading.

**Not established:**
- **That memory cannot help.** This corpus was built to measure harness behaviour (variance, steering, cap), not to accumulate varied
  coding failures. A different corpus could support MEM-001.
- **That no other card exists.** The 307 lesson-eligible trials have their transcripts (capture logs) present under local access. This
  projection read check outputs, not transcripts. A transcript review could propose procedural cards (for example, how an agent tested before
  finishing), but they would come from the same four tasks and the same 11 specific failures.
- **That the code-span card would or would not help**, and anything about coding performance at all.
- **The validity of the four studies without a machine-readable reading.** Their prose readings were not transcribed. This blocks no
  failure material, since they recorded no failed check.

## What would change this

1. **New failure material under MEM-001's fixed setup:** fresh task families run with a cap that does not bind, reasoning on, the target
   Pi release, and checks whose outputs name their tests. Repeat this report over them. If it finds two or more usable cards whose selection
   matters, lesson readiness can turn READY.
2. **The evaluator boundary** (assessment §3.5), which is needed by MEM-001 and by any future study, whatever the lessons.
3. **Smaller, cheap repairs** that improve evidence readiness but not lesson readiness:
   - validity readers for the four prose-only studies;
   - a versioned run-session identity record;
   - for DEVELOP, a baseline commit on the prepared attempt and retained receipt output under explicit retention rules.
