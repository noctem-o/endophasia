# Evidence eligibility (MEM-000)

Corpus `endo.corpus.mem-000` (sha256 `bbe2eb9ca71d2f1b…`), report sha256 `7444558c7cfa2fe9…`.
Research data: **read**. DEVELOP store: **not-given**.

Sources: 86 (85 read, 1 missing, 0 refused). Planned trials with no result in the copy read: 384. Other problems: 0. Examples with a named exclusion: 61.

## Eligible examples by objective

| Study | Examples | Descriptive | Symptom | Lesson | Causal policy |
| :-- | --: | --: | --: | --: | --: |
| completion-cap | 232 | 232 | 227 | 187 | 143 |
| discriminating-tasks | 132 | 132 | 120 | 120 | 0 |
| path-sensitivity | 384 | 384 | 384 | 0 | 0 |
| pinned-environment | 240 | 240 | 0 | 0 | 0 |
| steering | 162 | 162 | 162 | 0 | 0 |
| variance | 180 | 180 | 0 | 0 | 0 |

Duplicates are counted once, at their canonical copy (here and below).

## Why examples are not eligible

- **descriptive**: 1330 eligible, 0 not.
- **symptom**: 893 eligible, 437 not: `check-output-absent` 420, `exclusions-unresolved` 12, `trial-excluded` 5.
- **lesson**: 307 eligible, 1023 not: `check-output-absent` 420, `content-unavailable` 420, `exclusions-unresolved` 12, `trial-excluded` 5, `validity-undeclared` 1006.
- **causal-policy**: 143 eligible, 1187 not: `arm-invalid` 48, `exclusions-unresolved` 12, `single-condition` 132, `trial-attrition` 6, `trial-excluded` 5, `validity-checks-incomplete` 72, `validity-undeclared` 1006.

## Recurring failure symptoms (symptom-eligible trials with a failed check)

Zero passing named checks means every test the output names failed. It does not show that no usable artifact was produced, nor that nothing was implemented: this projection reads no truncation or workspace evidence per trial. It is never counted as evidence of one specific rule.

| Study / stage | Task | Condition | Failed / trials | Zero passing named checks | Most common specific failing checks (count) |
| :-- | :-- | :-- | --: | --: | :-- |
| completion-cap / main | booking-conflicts | arm-e | 1/12 | 0 | R1: shape and timestamp validation is a TypeError (1) |
| completion-cap / main | config-extends | arm-a | 2/12 | 2 | — |
| completion-cap / main | config-extends | arm-e | 4/10 | 0 | R5: invalid JSON and non-object JSON name the file (2) · R7: __proto__ is plain data (2) |
| completion-cap / main | fetch-cache | arm-a | 7/12 | 7 | — |
| completion-cap / main | fetch-cache | arm-d | 1/12 | 1 | — |
| completion-cap / main | fetch-cache | arm-e | 4/10 | 0 | R5: fresh bypasses the cache and replaces the entry (2) · R7: returned responses are copies, and the URL check stays (2) |
| completion-cap / main | markup-lite | arm-a | 7/12 | 7 | — |
| completion-cap / main | markup-lite | arm-b | 4/12 | 0 | R5: code spans (4) |
| completion-cap / main | markup-lite | arm-d | 8/12 | 6 | R5: code spans (2) |
| completion-cap / main | markup-lite | arm-e | 8/12 | 0 | R5: code spans (5) · R3: openers, closers and plain markers; R6: nesting and no overlap (1) |
| completion-cap / pilot | config-extends | arm-e | 1/2 | 0 | R5: invalid JSON and non-object JSON name the file; R7: __proto__ is plain data (1) |
| completion-cap / pilot | fetch-cache | arm-a | 1/2 | 1 | — |
| completion-cap / pilot | fetch-cache | arm-d | 1/2 | 1 | — |
| completion-cap / pilot | fetch-cache | arm-e | 2/2 | 0 | R7: returned responses are copies, and the URL check stays (2) |
| completion-cap / pilot | markup-lite | arm-c | 1/2 | 0 | R5: code spans (1) |
| completion-cap / pilot | markup-lite | arm-d | 1/2 | 1 | — |
| completion-cap / pilot | markup-lite | arm-e | 2/2 | 0 | R3: openers, closers and plain markers (1) · R5: code spans; R6: nesting and no overlap (1) |
| discriminating-tasks / confirmation | fetch-cache | default | 7/20 | 7 | — |
| discriminating-tasks / confirmation | markup-lite | default | 13/20 | 11 | R5: code spans (2) |
| discriminating-tasks / pilot | booking-conflicts | default | 1/6 | 0 | R1: shape and timestamp validation is a TypeError (1) |
| discriminating-tasks / pilot | markup-lite | default | 3/6 | 2 | R5: code spans (1) |

## Lesson candidates

| Card | Lever | Claim | Support | Usable in target | Problems |
| :-- | :-- | :-- | :-- | :-- | :-- |
| lesson.raise-binding-completion-cap | completion-cap | controlled-intervention | evidence | no | lever-fixed-in-target, scope-environment |
| lesson.ask-for-brief-reasoning | agent-context | controlled-intervention | no | no | contradicted-within-conditions, contrast-inconclusive, scope-environment |
| lesson.thinking-off-for-light-tasks | reasoning-mode | controlled-intervention | no | no | contrast-arm-invalid, contrast-inconclusive, observations-invalid-arm-only, lever-fixed-in-target |
| lesson.code-span-content-is-literal | agent-context | diagnostic-hypothesis | evidence | yes | none |
| lesson.proto-key-is-plain-data | agent-context | diagnostic-hypothesis | no | no | observations-invalid-arm-only, scope-environment |
| lesson.return-copies-from-cache | agent-context | diagnostic-hypothesis | no | no | observations-invalid-arm-only, scope-environment |
| lesson.isolate-hidden-checks | evaluation-infrastructure | observational | citation-only | no | generic, lever-fixed-in-target, unconditional |
| lesson.hold-workspace-path-fixed | experiment-design | observational | citation-only | no | lever-fixed-in-target, unconditional |

Applicability checks: 8 of 8 behaved as specified.

## MEM-001 readiness

**Evidence: INDETERMINATE**

- 1 declared source(s) were not present, so they are unqualified, not empty: develop/store.

**Lessons: NOT READY**

- 8 candidate(s): 4 supported by the evidence as stated, 1 usable as retrieved guidance in MEM-001 (proposed, not run).
- lesson.raise-binding-completion-cap: supported but not usable in the target (lever-fixed-in-target, scope-environment).
- lesson.isolate-hidden-checks: supported but not usable in the target (generic, lever-fixed-in-target, unconditional).
- lesson.hold-workspace-path-fixed: supported but not usable in the target (lever-fixed-in-target, unconditional).
- lesson.ask-for-brief-reasoning: not supported (contradicted-within-conditions, contrast-inconclusive).
- lesson.thinking-off-for-light-tasks: not supported (contrast-arm-invalid, contrast-inconclusive, observations-invalid-arm-only).
- lesson.proto-key-is-plain-data: not supported (observations-invalid-arm-only).
- lesson.return-copies-from-cache: not supported (observations-invalid-arm-only).
- Fewer than two usable cards: there is nothing to select between, so retrieval cannot differ from a checklist.

**Evaluator: NOT READY**

- 0 of 85 read experiment runs record an execution isolation boundary (endo.experiment-run.v0 has no field for one). This is a fact of the record format, not a measurement: it cannot turn READY until a run can record one.
- Missing boundary 1: the agent process can read the host (the repository, the research archive, hidden checks, other trials); the completion-cap study recorded a hidden-check read and broad deletions in a shared /tmp.
- Missing boundary 2: the success check runs in the agent's own workspace and environment, after the agent, without a separate verifier environment or artifact export.
- Missing boundary 3: no network restriction is applied or recorded for the agent.
- Missing boundary 4: an interrupted trial is rerun and replaced in the counted set (kept aside, not in the denominator).

**Overall: NOT READY**

- evidence INDETERMINATE, lessons NOT READY, evaluator NOT READY

The rules point to option **C**: 1 of 4 supported card(s) are usable; of the rest, 3 act on a lever the target holds fixed and 0 were observed only under a condition the target's setup excludes.
