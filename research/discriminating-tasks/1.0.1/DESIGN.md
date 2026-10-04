# Discriminating-task-set study design: tasks where Pi 1.0.1 with qwen3.8-27b sometimes fails

This file was committed before any data for this study was collected, as the first commit of its PR. It is not edited
after data collection starts. The only exception is §9a ("Screen result and the confirmation set"), which this design
reserves for the pilot's outcome. Anything done differently from this design is recorded in §13 ("Deviations"), which
starts empty.

## 1. Why this study exists

Every real bundle in the repository has saturated success. Across the variance study, the pinned-environment study, the
steering study and the path-sensitivity study, every success check that ran passed: there is variance in cost and
trajectory (turns, tokens, time) and none in whether the task is done. That has two consequences:

- **A candidate comparison has nothing to measure.** The evolution policies (roadmap item 11) choose among candidates by
  validated outcome, with an untouched promotion holdout. Candidates that all succeed differ only in cost, and the
  README's own rule is that a score alone never grants promotion, nor does cost alone.
- **A cognition control (roadmap item 7), a skill, or a steer cannot be shown to help or hurt.** There is no room.

This study builds and validates **a set of tasks whose success rate under this model, runtime and condition is neither
near 0 nor near 1**, so that later candidates can differ in either direction. It does not compare candidates.

## 2. Question

**Main question.** Of a fixed pool of 12 small coding tasks, written to the standard in §4, which have a success rate in the
band that leaves headroom both ways, under Pi's defaults in E3's pinned environment, estimated on trials that were not
used to select them?

**Secondary questions.**
- How heterogeneous is a task's success rate across working-directory paths? (The path-sensitivity study showed that
  trials at one path can be correlated.)
- What does a failure look like: a wrong solution, an unfinished one (a timeout), or a tool problem?
- Is any trial invalid because the agent read what it must not (§7)?

## 3. Environment and condition

| Part | Setting |
| :--- | :--- |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, 16 CPUs, 31 GiB RAM, one NVIDIA RTX 4090 (24 GiB) |
| Node | v26.10.0 |
| Pi | 1.0.1, identity `f91821fd54dd…`, run with scratch HOME, agent directory and workspace. The operator's configuration is never touched. |
| Server | llama.cpp at `http://127.0.0.1:8080`, model `qwen3.8-27b` (Q4_K_M, context 98304), as already running. Not started, stopped, restarted or reconfigured. No settings, slot or admin endpoint is called. |
| Runner | `endo experiment run` (`endo-experiment-runner.3`, unchanged) |
| Digest domain | `fixture-public`, in explicit fixture-experiment mode. The tasks are synthetic. |

**The condition: Pi's defaults, no extension, with E3's pinned environment** (`TZ=UTC`, `LC_ALL=C`, a test reporter without
durations, every scratch entry at one fixed time). It is the condition later candidate comparisons are meant to use:
sampling is the server's default, so a success rate is a rate over fresh trials and not a property of one deterministic
trajectory (under temperature 0 and a fixed seed each path is one outcome, and a "rate" would measure path variance). The
server's actual sampling defaults are UNAVAILABLE; the runner records the request fields Pi sent.

**The set is validated for this condition only,** on this model, quantization, server session and Pi release. A task in the
band here may saturate under another model, and the set says nothing about absolute capability.

## 4. The pool, and how it is written

**12 tasks, fixed before the pilot.** A task is never edited, added or replaced after the pilot starts. A task found broken
is **dropped**, and that is recorded in §13. It is not fixed and rerun.

| Id | Kind | What it asks |
| :--- | :--- | :--- |
| `slot-pack` | implement to spec | pack sized items into fixed-capacity slots by an invented placement rule |
| `ticket-code` | implement to spec | encode and decode a ticket code with bijective-base-26 rows and a checksum letter |
| `rolling-median` | implement to spec | a sliding-window median class with a lower-median rule |
| `booking-conflicts` | implement to spec | find room-booking conflicts on half-open intervals, with ordering and error rules |
| `markup-lite` | implement to spec | convert a small invented markup to HTML, with escaping and flanking rules |
| `tax-brackets` | implement to spec | progressive tax in integer cents with half-to-even rounding |
| `route-normalize` | implement to spec | normalize a URL path with percent-decoding of unreserved characters only |
| `retry-schedule` | implement to spec | a retry-delay schedule with a given jitter formula and an injected random source |
| `inventory-bugs` | debug a multi-file project | three interacting bugs across three files, specified by a README and failing tests |
| `report-bugs` | debug a multi-file project | a parse, aggregate and format pipeline with three bugs |
| `fetch-cache` | edit existing code | add a TTL cache to an existing module without breaking its API |
| `config-extends` | edit existing code | add an `extends` mechanism to an existing configuration loader |

The mix is deliberate (the roadmap asks for transfer, and one task type cannot show it): eight tasks implement a function
or class from a written specification, two debug a small multi-file project, and two edit an existing module.

**Idiosyncratic rules, fully specified.** The implement-to-spec tasks use invented or non-canonical rules (an unusual
tie-break, a lower median, a checksum alphabet), not textbook problems, so that a memorized canonical solution does not
decide the outcome. Every rule is written down.

**Fairness is checked mechanically, not by trust.** Each task's prompt (or, for the debugging and editing tasks, the
`README.md` in its workspace) states its rules as numbered lines `R1.`, `R2.`, and so on. Every assertion in the task's
hidden check is in a test named `R<n>: …`. A test in the default suite fails if a hidden test names a rule the prompt does
not state, or if a stated rule is never tested. So every behaviour the check asserts is stated, and the rule number is the
mapping from assertion to sentence. A task that failed on an unstated convention would look discriminating and be worthless
for comparing candidates.

**Every task is validated mechanically, in the default suite:**
- the reference solution passes the success check;
- the starting workspace fails it;
- a plausible wrong solution fails it (the check discriminates);
- the check's text is not in the task's `workspace`, and it depends on no scratch path, time zone or duration.

## 5. Success

A task's **success check** runs after the session, in the runner's own (unpinned) environment, against the workspace the
agent left: the task's hidden check (§4) must exit 0. The hidden check is written, only when the check
runs, to a directory beside the workspace (inside the scratch root, §13), and never into the workspace. Success is that exit code, and nothing else.

**Failure rules, fixed now:**
- **A session that does not finish** (the step timeout of 600 s, with no `agent_settled`) is a **failure**, unless the check
  passes anyway.
- **A trial the runner records as an error** (a runner or Pi failure before a result) is **excluded and reported**, not
  counted as a failure. If more than 10% of a task's trials in a stage are errors, the task is reported as **unmeasured**
  for that stage.
- **A trial that is invalid** (§7) is excluded and reported.
- A trial with a transport error turn (`Connection error.`) that Pi retries and finishes counts as an ordinary trial.

## 6. Stages: screen, then confirm, on independent trials

**Stage 1, the screen (the pilot).** 6 trials per task, 72 trials, in one run (so one path), blocked-randomized by the
runner. A task **advances** if its successes are in 1 to 5 of its counted trials (not 0, not all).

**The screen's miss rate, stated now.** It misses a task whose true rate is in the band: with 6 trials, a task whose true
success rate is 0.3 shows 0 of 6 with probability 0.118, and at 0.2 with probability 0.262; symmetrically a task at 0.7
shows 6 of 6 with probability 0.118. A task at 0.5 passes the screen with probability 0.969. The screen is cheap and lets
a good task through far more often than not, but it will drop some. That is a limit (§11), and it is the reason the
confirmation uses fresh trials: a task that was dropped is not re-run.

**Selection.** At most **8** advance. If more than 8 would, the 8 whose screen rate is closest to 0.5 advance, ties broken
by the task id in alphabetical order. The advancing set is written in §9a before any confirmation trial.

**Stage 2, the confirmation.** Each advancing task gets **20 fresh trials in 4 paths of 5**: four runs of the same spec,
differing only in `id`, so only the scratch-root hash varies (as in the path-sensitivity study); the order of the four runs is
shuffled by a recorded seed. The screen's trials are **not** part of the estimate (they were used to select, and would
overstate the rates).

## 7. Manipulation and validity checks

Computed from the recorded requests, tool calls and snapshots, on both stages.

- **Leakage, the main risk.** There is no sandbox: Pi has `bash`, and the hidden checks, the reference solutions and the
  specs sit on disk outside the scratch root. A trial is **invalid** only if the agent could have found, or did find, what
  it must not have (amended before any data, §13):
  - the marker planted in every hidden check (`ENDO-HIDDEN-MARKER` followed by its task id) appears in any tool result,
    or in any tool call's arguments;
  - or any tool call's arguments name a path under a **protected root**: the repository checkout (which holds the hidden
    checks and references) or the operator's real home directory;
  - or any tool call's arguments name one of the study's own directories (`endo-experiment-…`, `endo-hidden-…`) outside
    the trial's own scratch root, such as the run directory above it.

  Every other absolute path outside the scratch root in a tool call (a throwaway script in `/tmp`, a path the task is itself
  about, such as `/etc/app/main.json` in a configuration task) is **counted and reported per task, and does not invalidate
  the trial.** `leakage.ts` is the rule, with its tests.
- **M1, the condition.** No request carries a sampling field the agent did not get from the server's defaults:
  `temperature`, `seed`, `cache_prompt`, `top_p`, `top_k`, `min_p` or a penalty, as in the earlier studies' arm A. The
  request fields Pi did send are recorded.
- **M5 and M6**, as the pinned-environment study: the recorded environment and snapshot match the spec, and no tool result
  carries a test-reporter duration.
- **M-ws, the workspace is what the task says.** Every trial's first request carries the task's prompt, and its snapshot
  holds the task's workspace files and not the hidden check.
- **The capability studies of the earlier work are not used:** no intervention is applied.

## 8. Measures

Per task, for the confirmation stage over its counted, valid trials:

- **The success rate** p̂ = successes / counted trials.
- **Two intervals, because trials at one path are not independent.** The 95% Wilson interval, computed as if the 20 trials
  were independent, and a 95% **cluster interval over the 4 paths** (a t interval with 3 degrees of freedom on the four
  per-path rates). Both are reported. The path-sensitivity study showed paths can differ; the wider interval is the honest
  one when they do.
- **Per-path counts** (successes of 5), and a **heterogeneity flag**: the per-path counts differ by 3 or more.

**The band, fixed now,** applied to p̂ (the point estimate, because it is what a later comparison's headroom depends on):

| Class | Rule |
| :--- | :--- |
| **discriminating** | 0.20 ≤ p̂ ≤ 0.80 (4 to 16 of 20) |
| **marginal** | 0.10 ≤ p̂ < 0.20, or 0.80 < p̂ ≤ 0.90 |
| **saturated** | p̂ < 0.10 (a floor) or p̂ > 0.90 (a ceiling) |

The band leaves headroom both ways on purpose: a candidate can also be worse, so a task at 0.9 cannot show harm and a task at
0.1 cannot show help. A **heterogeneity flag** on a discriminating task is reported with it, and does not change its class.

**Descriptive only:** per task, the output tokens and wall time (median and range), the number of tool calls, and the
failure mode of each failure: the hidden check failed with a wrong result, the session did not finish, or the check could not
run.

## 9. Order, hygiene

- The runner's blocked randomization applies within a run. The four confirmation runs are not interleaved in time, justified
  by the path-sensitivity study (requests and outcomes reproduced across runs made at different times).
- One trial at a time, on one server and its prompt cache. The server may be used by other clients, which cannot be
  controlled or observed.
- **Resumability.** An interrupted run resumes by the runner's rules.
- The raw run directories are large (about 0.7 MB per trial): their size is told to the operator before they are committed,
  they pass the secret scan with a documented path exception or not at all, and their `*.log` event files need an
  explicit un-ignore.

## 9a. Screen result and the confirmation set

(Reserved.)

## 10. The holdout, designed now

The README's acceptance criteria require an untouched promotion holdout. This study fixes the split now, so the set can be
used for roadmap item 11 later.

- **The split.** After the confirmation, the *discriminating* tasks (§8) are split by a seeded shuffle: sort their ids
  alphabetically, apply a Fisher-Yates shuffle with `mulberry32(20261004)`, and take the first ⌈m/2⌉ as the **validation**
  tasks and the rest as the **holdout** tasks. The result is written to `validated-tasks.json`. Marginal and saturated
  tasks are in neither.
- **Where the checks live.** Every task's hidden check is in `tasks/<id>/hidden.test.mjs`, in the repository. That does not
  seal the holdout: in this repository everything is readable. Sealing is a process obligation on whoever later builds a
  candidate generator: **it must not be shown the holdout tasks' hidden checks, references or confirmation results**, and a
  promotion decision must be taken on the holdout alone. This study cannot enforce that, and says so.
- **The checks of the holdout are used to evaluate, and not to generate.** A candidate that was generated or tuned while
  its author could read a holdout task's check has no valid holdout result.

## 11. Limits, known in advance

- One Pi release, one model and quantization, one server session, one machine, one provider API, one condition (§3).
- **A pool of 12 small synthetic tasks.** It is a tool for detecting differences between candidates, not a benchmark, and
  a score on it is not capability.
- **The screen drops some in-band tasks** (§6), and 20 confirmation trials per task give a wide interval (a rate of 0.5 is
  known to within about ±0.2 at best, and wider across paths).
- **Success is one hidden check per task.** A task can be solved in a way the check does not anticipate and fail, which is
  why every rule is stated and every assertion is tied to one.
- The leakage check catches an agent naming an outside path or printing a marker. It does not catch an agent that
  reconstructs a check from the prompt's rules, which is the intended solution.
- Paths are not interleaved in time, and the path is one irrelevant factor among many that could move a rate.
- The band and the thresholds are a judgment, not a standard.

## 12. Why this, and why now

The roadmap's ordering is runtime truth, then replay, then evaluation, then evolution, and it says the contracts must
survive a real agent and produce evidence before more is built. The evidence so far cannot separate candidates. A set of
tasks that can is the missing input to item 11 and to any claim about a cognition control or a skill. This study produces
that input, and it does not run the policies.

## 13. Deviations

All three were made after the pool was committed and **before any trial ran** (no model call has been made for this study).
They came from an advisor review of the committed pool.

1. **The leakage rule is narrower (§7).** As first written, any absolute path under `/etc`, `/opt`, `/home`, `/tmp` (and others)
   outside the scratch root invalidated a trial. Several tasks invite exactly such paths without any peeking (a configuration
   task is about absolute paths, and a careful agent writes a throwaway script to `/tmp`), so the rule would have excluded the
   more careful trials, biased the rate down and could have pushed a task over the 10% exclusion line. The rule now
   invalidates only on the marker, a protected root and the study's own directories, and counts the rest.
2. **The hidden check's directory (§5).** It was a random directory under the system temporary directory. It is now
   `hidden-check-<name of the working directory>` beside the working directory, so inside the scratch root when the runner
   runs it: no random path and no path outside the scratch root in the recorded check output, and no collision between
   concurrent checks. I ran the check under the runner's environment shape against a reference workspace (not a model
   trial): the directory is removed afterwards, and the output names only paths inside the scratch root.
3. **Three prompt sentences were tightened** where a reasonable reader could have gone the other way and the check
   asserted one reading: `fetch-cache` R1 (`ttlMs: null` is a `RangeError`) and R7 (the copy is deep), and
   `config-extends` R1 (`extends: null` is a `TypeError`) and R7 (the result's prototype, and `__proto__` merging). The
   timing of two assertions in `fetch-cache` was also relaxed (the counts are read after the callers have settled, not
   synchronously). Added to the validation: the visible tests must pass on the reference (and on the starting workspace for
   the debug and edit tasks), so that a visible test can never contradict the hidden check.
