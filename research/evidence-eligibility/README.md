# Evidence eligibility and lesson feasibility (MEM-000)

A read-only projection that asks what Endophasia's recorded evidence permits anyone to learn, before a memory selector (MEM-001) is built.
It reads the experiment runs and an optional DEVELOP store, and for every **example** (one decision with its later evidence) it says which
learning **objectives** that example may serve and every reason it may not. It then checks a small set of hand-written **lesson
candidates** against those examples, and judges whether MEM-001 is ready.

The findings and the decision are in [RESULTS.md](RESULTS.md). The committed output of the local run is in [report/](report/).

It is research tooling: nothing in the production layers imports it, it writes nothing it reads, and it changes no evidence contract.

## 1. What already existed, and what this reuses

| Need | Existing implementation (reused) | Status |
| :-- | :-- | :-- |
| Read experiment runs by declared version, refusing unknown versions and mismatched results | `cli/experiment-artifacts.ts` (`readEndoExperimentRunRecordFileV0`, `readEndoExperimentPlanFileV0`, `readEndoExperimentPlannedTrialV0`) over `protocol/experiment-artifacts.ts` | used as is |
| Trial records, v0 and v1 | `protocol/experiment-artifacts.ts` (`endo.experiment-trial.v0`, `.v1`) | used as is; every trial in the corpus is v0 |
| Verify a check output against the digest its result recorded | `storage/digest-key.ts` (committed public fixture keys), `runtime/contracts/keyed-digest.ts` (`digestBytes`) | used; an installation key is never loaded |
| Stable bytes and digests | `runtime/contracts/canonical-json.ts` | used |
| DEVELOP attempts and receipts, refusing links and misnamed files | `storage/develop-attempts.ts`, `storage/develop-receipts.ts`, `protocol/develop-attempts.ts` (`renderEndoDevelopBriefV0`) | used as is |
| Where the raw research data is | `research/data.ts` | used |
| Study validity (arm validity, excluded trials) | the studies' committed analyses: `research/completion-cap/1.0.1/analysis/main.json`, `research/discriminating-tasks/1.0.1/analysis/{pilot-screen,confirmation}.json` | read by a format-specific reader (`validity.ts`), never re-derived |

Inspected and not used, with the reason:

| Existing | Why not here |
| :-- | :-- |
| `endo.trajectory.v1`, its Pi and DSH projectors and the comparator (`runtime/contracts/trajectory.ts`, `adapters/dsh-native/loss.ts`) | They compare recordings. Eligibility needs each record's provenance, outcome and validity, not a comparison. |
| The effective harness surface (`protocol/harness-surface.ts`, trial v1) | Every committed study trial is v0, so the surface is UNAVAILABLE ("predates the surface") for the whole corpus. Harness identity comes from the unversioned `environment/session-<n>.json` instead (a gap, §4). |
| `endo.experiment-report.v2` and the lab bundle (`cli/experiment.ts`, `lab/`) | Aggregates per cell; eligibility is per decision. |
| The DEVELOP execution reader (`runtime/contracts/develop-attempt-execution.ts`) | It needs the session's event log. This projection records only whether a send was authorised. |
| OMP saved-session observation (`docs/develop-omp-observer.md`) and the DSH cold import | Neither binds an outcome to a decision (OMP is metadata only; the committed DSH fixtures are sanitised and outcome-free), so they contribute nothing to any objective beyond description. Not projected. |
| `models/routing-policy.ts`, `evolution/policies/*` | Implemented and unwired (`docs/status.md`). Nothing here selects or learns. |

## 2. The contract

`contract.ts` holds the closed vocabulary; `eligibility.ts` holds every rule.

**Objectives.** `descriptive` (count and describe it), `symptom` (read what failed, retrospectively), `lesson` (use it as source evidence
for a lesson candidate), `causal-policy` (use it to estimate what choosing one action does). An example is eligible for an objective exactly
when it has no reason against it.

**Examples.** An experiment trial: the decision is the randomized condition assignment, known from the run record and the trial's plan entry
alone (`decisionOfTrial` takes no result, so nothing recorded later can enter a decision-time feature). A DEVELOP attempt: the decision is
the operator's prepared brief, kept as its length only (`decisionOfAttempt` takes the prepared record alone). A plain digest of private words
would let a reader confirm a guess, so none is kept; an attempt's record identity is a digest of its ids, versions, times and revisions.

**Reasons** (each defined in `REASONS`; the rules say which objectives each removes):

| Reason | Removes | Rule |
| :-- | :-- | :-- |
| `duplicate-record`, `conflicting-duplicate` | all | the same run read from two locations: identical bytes are counted once, and different bytes mean neither copy is used. The canonical copy is the raw archive's, then a store's, then the repository's; content present breaks ties |
| `interrupted-execution` | learning | the runner moved it aside and never counted it; kept as an operational outcome, linked from the counted rerun |
| `outcome-missing`, `no-check` | learning | a runner error, or a task with no check: no outcome measure. Never a failure |
| `check-output-absent`, `-mismatch`, `-unverifiable`, `-unreadable` | symptom, lesson | the output beside the result is missing, is not the digested output, is under a key this projection does not hold, or is not a readable regular file (also reported as a problem of that trial) |
| `content-unavailable` | lesson | digests and counts only: no capture log and blobs |
| `trial-excluded`, `exclusions-unresolved`, `run-invalid` | learning | the study excluded it by name; excluded trials were counted but not named for its task; a document declares the run invalid |
| `validity-undeclared` | lesson, causal | no machine-readable validity reading: contamination unknown |
| `arm-invalid`, `validity-checks-incomplete` | causal | the study reported the condition invalid, or its checks did not all pass |
| `single-condition`, `harness-identity-unavailable`, `trial-attrition` | causal | no contrast between actions; no recorded runtime identity; some planned trials of the run have no usable result |
| `assignment-not-randomized`, `artifact-unbound` | causal (and learning) | DEVELOP: the operator chose; nothing binds an artifact to the attempt |
| `receipt-*`, `outcome-declared-only`, `not-executed`, `source-problems` | learning | DEVELOP: receipts keep byte counts not output, their link is the operator's, they disagree on the commit, predate the attempt or name another project; only a declaration; never authorised to be sent (whatever receipts or notes exist: verification is not dispatch); problem files |

**Caveats** travel with an example without removing it: `pilot-stage`, `task-examined` (development data now, never a holdout),
`arm-invalid`, `validity-checks-incomplete`, `rerun-after-interruption`, `symptoms-withheld`.

**Symptoms.** From a check output that matches its recorded digest under a committed public key, the projection lists the failing tests it
names (`✖ name`, `not ok N - name`) and how many tests it names in all. A failure with **zero passing named checks** (every named test
failed) is counted separately and is never evidence of one specific rule. It is a test outcome only. It does not establish that no usable
artifact was demonstrated beyond those tests, and still less that no implementation was produced, which would need separate evidence
(the response's finish reason, or the final workspace). This projection reads neither. Names are data: bounded, with control and bidirectional
characters replaced, never interpreted. (node:test also prints a line per suite; a suite counts as a named test, so a task with suites names
more tests than it has rules.)

## 3. Lesson candidates and readiness

`lessons.v0.json` (`endo.lesson-candidates.v0`) is a research-only card format, not a production memory schema. Each card states the
guidance, the **lever** it acts on, the kind of **claim** (observational, diagnostic hypothesis, controlled intervention), its model,
harness and environment **scope**, where it **applies** and where it is **excluded**, and its evidence: selectors over eligible examples,
counterexamples, numbers cited from committed analyses (checked against the file), and for a controlled claim the randomized contrast, the
direction it claims and the pointer to its interval. The cards were written by hand and the file says by whom (`review`).

A card is **supported** when all of the following hold:
- every selector finds lesson-eligible examples, and they are not all from an arm the study reported invalid;
- some matched example ran the card's declared model and harness release;
- every cited number is found and equal;
- every counterexample is found and names a feature the card `excludes`. A found counterexample inside the card's own conditions removes
  its support;
- a diagnosis states its alternatives;
- a controlled claim rests on valid arms, with an interval wholly on the side of zero its `direction` claims.

What support rests on is reported as `evidence` or, for an observational card whose only support is a number found in a committed analysis,
`citation-only`: the citation resolves, and that is all it shows.

A card is **usable in the target** (MEM-001, as `target` describes it) when its support is `evidence` and it is conditional, not a generic
default, on the lever the target varies (the agent's context), and within the target's model, harness version and environment.

The **selector** (`selectCards`) the applicability checks exercise: a card is a candidate only when it is agent guidance, supported, not
revoked, exactly in scope, has every `applies` feature and no `excludes` feature; ranked by matched features, then id; at most three;
otherwise it abstains. Card text is never read by any rule. `applicability-cases.v0.json` holds eight cases (applicable, irrelevant,
superficially similar, no features, other harness version, other environment, invalid source, binding cap). They were written by the same
reviewer and are not blinded; they check the selector's behaviour, not coding performance.

**Readiness rules** (`readiness.ts`), each READY, NOT READY or INDETERMINATE, with no confidence number:

- **Evidence:** NOT READY if a source was refused, copies conflict, or a cited study stage has no validity reading. INDETERMINATE if a
  declared source was absent or holds no run (absent is unqualified, not empty), or the raw archives were not read. Otherwise READY.
- **Lessons:** NOT READY with fewer than two usable cards, or when **selection does not matter**. That is decided structurally from the
  cards' `applies` and `excludes` (the applicability cases are not used), and it fails in either of two ways:
  - no two usable cards are separable: no case selects one and not the other. A case can leave `b` out while selecting `a` when `b`
    requires something `a` does not, or excludes something `a` does not, so cards that differ only in their exclusions are separable;
  - or every usable card fits in the shared allowance (600 tokens, approximated as UTF-8 bytes / 4) and none has a found counterexample
    naming a feature it excludes.

  Then a checklist holding every usable card carries the same guidance, and an R − S contrast has no mechanism.
- **Evaluator:** NOT READY until a run records an isolation boundary. No run record has a field for one (`endo.experiment-run.v0`), so this
  judgement is a fact of the record format, not a measurement, and the overall judgement cannot be READY until that changes. The missing
  boundaries it lists are cited from the studies, not read from data.
- **Overall:** the worst of the three. The suggested option is A only when all are READY. It is C when every supported card is kept out of the
  target by something the target holds fixed (a lever it does not vary, or a condition its setup excludes); otherwise it is B.

## 4. Gaps this found in the existing records

1. **Validity is machine-readable for two studies only** (completion-cap main; discriminating-tasks). Variance, pinned-environment,
   steering and path-sensitivity state validity in prose, so 1,006 examples are ineligible for lessons and causal use. Their tasks recorded
   no failed check among 546 readable outputs, so a reader for them would add no failure material.
2. **No effective harness surface** for any trial in the corpus (all v0); runtime identity is read from an unversioned session file.
3. **No isolation boundary** is recorded or enforceable by the runner, and an interrupted trial is rerun into the counted set (no
   interrupted execution exists in this corpus).
4. **DEVELOP:** no store exists on this machine. Where one exists, receipts keep output byte counts only, a prepared attempt records no
   baseline commit, and a receipt's link to an attempt is the operator's choice of id.
5. **Truncation** is not read here (it needs the response blobs, as `research/completion-cap/1.0.1/wire.ts` does); "every check failed"
   is a weaker, separate fact.

## 5. Running it

```sh
# The committed corpus, lesson candidates and cases; the raw archives from ../endophasia-research (or ENDO_RESEARCH_DATA):
node research/evidence-eligibility/report.ts --out ../endophasia-research/mem-000-report

# Another archive location, a DEVELOP store, or another corpus or card file:
node research/evidence-eligibility/report.ts --out <dir> --data <restored archives> --store <store root> \
  [--corpus <file>] [--lessons <file>] [--cases <file>]
```

It prints the number of examples, the report's sha256 and the overall readiness, and writes `report.json` (every example), `manifest.json`
(sources and the digests of every governing file read, problems, exclusions, totals, duplicates by count and digest, the lesson assessments
and readiness, and the report's sha256) and `summary.md`. The same inputs give the same bytes on any machine: there is no absolute path and
no time of generation in the output. The output directory may not be inside any source it reads.

**Repeating it on your own archives without publishing them:**
- Write the output **outside the repository** (as above). `report.json` holds every example's ids, digests and failing-test names; keep it
  with the data. The output directory is checked through links: one inside a source is refused.
- It contains no prompt, system text, reasoning, request body, tool argument or tool result. Failing-test names are read only from outputs
  under a committed **public** fixture key (synthetic studies); under an installation key the output is never read and is marked
  `symptoms-withheld`. A DEVELOP brief appears only as its length, with no digest of its words; receipt arguments are not copied.
- Paths appear relative to their role (`research-data/…`, `repository/…`, `store/…`). A reader's message that named an absolute path is
  rewritten the same way.
- To publish a result, commit `manifest.json` and `summary.md` only, as `report/` does; the manifest's `report.sha256` lets anyone holding
  the data check that their `report.json` is the one summarised.
- If the archives are absent, the report says so (`researchData: absent`, evidence INDETERMINATE). A run on committed records alone is not
  a qualification of the archives.

## 6. Tests

`tests/evidence-eligibility.test.ts` (hermetic; fixtures copied from a committed run): deterministic bytes and order; unknown versions of a
trial, run record, corpus, lesson file and analysis; digests without content; outputs under another key or an installation key; invalid
arms, excluded and unresolved trials, an invalid run, a contrast on an invalid arm or an inconclusive interval; interrupted executions,
duplicate and conflicting copies; attrition; a runner error against a failed check; DEVELOP receipts at two commits, before preparation, for
another project or filed under another attempt, and an unauthorised attempt with receipts; a removed or invalid source; a contrast in the
opposite direction; observations from an invalid arm only; an unobserved scope; counterexamples inside and outside a card's conditions;
decision features unchanged by any later fact; injected instructions in a check output, and two cards identical but for their guidance;
abstention and exclusion; an output reached through a link into a source; an analysis that is not JSON; cases of another version; and no
change to any source byte or time. A receipt at a revision other than the attempt's cannot be tested: a prepared attempt records no
baseline commit (§4). `tests/evidence-eligibility-corpus.test.ts`
checks the committed files everywhere, and where the archives are present reproduces the committed manifest and summary byte for byte.
