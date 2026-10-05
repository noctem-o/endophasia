# Discriminating-task study results: which small coding tasks does Pi 1.0.1 with qwen3.8-27b neither always nor never solve?

Design: [DESIGN.md](DESIGN.md), committed before any data. §9a records the screen's result and the confirmation set (committed before
any confirmation trial); §13 records three deviations, all before any trial. Everything here is from 132 real trials: a
screen of 72 and a confirmation of 60.

## The answer

**Two of the twelve tasks discriminate: `fetch-cache` (13 of 20) and `markup-lite` (7 of 20).** Nine tasks were dropped at the
screen (seven of them 6 of 6), and the third task that advanced, `booking-conflicts`, was 20 of 20 on confirmation. The set is
thin: the pool is mostly saturated for this model, as every earlier study's task was.

| Task | Screen | Confirmation | 95% Wilson | Cluster (4 paths, t) | Per path (of 5) | Band |
| :--- | ---: | ---: | :--- | :--- | :--- | :--- |
| `fetch-cache` | 4/5 (1 excluded) | **13/20 = 0.65** | [43.3, 81.9] | [49.1, 80.9] | 4, 3, 3, 3 | **discriminating** |
| `markup-lite` | 3/6 | **7/20 = 0.35** | [18.1, 56.7] | [0, 75.0] | 0, 2, 3, 2 | **discriminating**, heterogeneity flag |
| `booking-conflicts` | 5/6 | 20/20 = 1.00 | [83.9, 100] | [100, 100] | 5, 5, 5, 5 | saturated |
| the other nine | 6/6 each (`report-bugs` 5/5, 1 excluded) | not run | | | | dropped by the screen |

The two intervals are both reported, as designed (§8). `markup-lite`'s per-path counts differ by 3 (0 of 5 at `c4`, 3 of 5 at
`c1`), so it carries the heterogeneity flag, and its cluster interval is the honest one: the point rate 0.35 is the weaker estimate.

**The split (DESIGN §10, seed 20261004, `validated-tasks.json`):** `fetch-cache` is the validation task and `markup-lite` the
holdout task. One holdout task is a very small holdout; any use of it should say so.

## What the failures were (post-hoc, not pre-registered)

DESIGN §8 separates the failure modes "wrong result", "session did not finish" and "check could not run". It does not separate a
response that was **cut off**. Reading the recorded responses afterwards (`post-hoc-truncation.ts`,
`analysis/post-hoc-truncation.json`): **21 of the 25 failures on these three tasks, over both stages, are a response that ended with
`finish_reason: "length"`**: the model's reasoning used the whole `max_completion_tokens` of 16,384 (Pi's request default) before it wrote
the code, and the trial ended with the starting stub still in place.

| Task, stage | Failures | Of them, a response ended at the cap | Passing trials with such a response |
| :--- | ---: | ---: | ---: |
| `fetch-cache`, confirmation | 7 | 7 | 1 |
| `markup-lite`, confirmation | 13 | 11 | 0 |
| `booking-conflicts`, screen | 1 | 0 | 0 |
| `fetch-cache`, screen | 1 | 1 | 0 |
| `markup-lite`, screen | 3 | 2 | 0 |

The failures that were not a cut-off are 4: two on `markup-lite` in the confirmation (code spans, R5: a wrong answer), one on
`markup-lite` in the screen and one on `booking-conflicts` in the screen. In the cut-off trials the hidden check reports
"not implemented" for every rule, so the table in the analysis files lists them as `wrong-result`: that label is a limit of the
pre-registered failure modes, not a finding about the model's code.

**What this means for the set.** These two tasks discriminate mostly on whether the model's reasoning finishes inside Pi's default
completion cap, not on whether it can write the code when it gets to. That is a real, measurable thing a candidate can change (a
lower reasoning budget, a larger cap, a retry after a cut-off, a steer), and it is also a narrow one: a candidate that only raises the
cap would probably saturate both tasks. It should be known before these tasks are used to judge a policy.

## Secondary results

- **Delivery of the condition.** M1 passed (no sampling field in any request: the server's defaults), M5 passed (the pinned
  environment as specified), M-ws passed (every trial's first request carried the task's prompt; the snapshot held the workspace and no
  hidden check), on the screen and on all four paths. **M6 was incomplete in one screen trial** (`report-bugs` #1: the agent ran the tests
  under a reporter of its own, so 8 requests carry `duration_ms`); that trial is also one of the two excluded below.
- **Exclusions.** No runner errors in 132 trials. Two screen trials were excluded as invalid by the §7 leakage rule (a `find` on the
  run directory above the scratch root); both passed their check, and counting them changes no decision. The confirmation had none.
  The rule's counted, not invalidating, mentions of other outside paths (`/tmp` scripts, the example paths of a configuration task) were 66
  on `fetch-cache` and 3 on `booking-conflicts` in the confirmation, 0 on `markup-lite`.
- **Cost, descriptive (confirmation, median over paths).** Output tokens: `booking-conflicts` 7,220, `fetch-cache` 20,636, `markup-lite`
  16,461; wall time per trial: 65 s, 256 s, 206 s; tool calls: 6, 16, 2. `markup-lite` has a median of 2 tool calls because most
  of its trials read the stub and the example test and then the response was cut off.
- **The screen's miss rate was real.** `booking-conflicts` passed the screen at 5/6 and was 20/20 on confirmation, and the design's
  note that a screen lets some tasks through that are not in band is the reason for confirming on fresh trials.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (as before) |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080, as already running. Not restarted, reconfigured or queried beyond `/health`, `/v1/models` and the completions Pi made. |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, RTX 4090; Node v26.10.0 |
| Runner | `endo-experiment-runner.3`; condition: Pi's defaults, no extension, the pinned environment (E3) |
| Screen | `endo.experiment.discriminating-tasks-1.0.1-pilot`: 12 tasks × 6 trials = 72, 72 completed, 2026-10-04 from 22:25 UTC |
| Confirmation | 3 tasks × 5 trials × 4 paths = 60, all completed; path order `c4 c3 c1 c2` (seed 2157608440); scratch hashes `3dca01f2ba6c`, `40f6618468d6`, `5c78d675047f`, `c612fde0820b` |
| Digest domain | `fixture-public` (fixture-experiment mode) |

## Limits

- The limits of DESIGN §11. In particular this is a pool of 12 small synthetic tasks for one model, and a rate here is not a capability score.
- **Two discriminating tasks, one validation and one holdout.** Roadmap item 11 can run on them, but a promotion decision on a one-task
  holdout is weak, and `markup-lite` varies by path.
- **The discrimination is largely truncation** (above). The tasks were not built for that and the study did not set out to measure it.
- **The sampling condition is the server's defaults**, which this study could not read (`UNAVAILABLE`), and one server session.
- **The screen is one path**, the confirmation four; paths were not interleaved in time.

## Files

| Path | What it is |
| :--- | :--- |
| `DESIGN.md` | the design, the screen's result (§9a) and the deviations (§13) |
| `tasks/<id>/` | each task: `prompt.md`, `workspace/`, `hidden.test.mjs`, `reference/`, `naive/`; validated by `tests/discriminating-tasks.test.ts` |
| `tasks.ts`, `leakage.ts`, `stats.ts`, `make-spec.ts`, `run.ts`, `analyze.ts` | the loader, the leakage rule, the pure decisions, the specs, the driver and the analysis |
| `post-hoc-truncation.ts` | the post-hoc look at cut-off responses (not pre-registered) |
| `spec-pilot.json` | the screen's spec |
| `analysis/` | `pilot-screen.json`, `confirmation.json`, `post-hoc-truncation.json` |
| `validated-tasks.json` | the seeded validation/holdout split |
| (raw data) | the complete run directories (screen and four paths): every trial's store, evidence and logs, **kept outside the repository** (see below) |

The raw run directories (614 MB on disk, 3,701 files) were approved by the operator and committed here at first. Moved out of the repository (it is large and every file was checked on each change): see [`research/DATA.md`](../../DATA.md). It was committed here until 2026-10-05 and is unchanged. The secret scan and its documented path exception are in the data directory's `raw/README.md`.
