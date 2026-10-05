# Completion-cap study design: how much of the discriminating tasks' failure is the completion cap, and what do cheap compute arms buy?

This file is committed before any data for this study is collected, as the first commit of its PR. It is not edited after
data collection starts. The only exception is §9a ("Pilot result and N"), which this design reserves for the pilot's
outcome. Anything done differently from this design is recorded in §13 ("Deviations"), which starts empty.

## 1. Why this study exists

The discriminating-task study ([RESULTS](../../discriminating-tasks/1.0.1/RESULTS.md)) found two tasks with a success rate
between 0 and 1 for Pi 1.0.1 with qwen3.8-27b: `fetch-cache` (13 of 20) and `markup-lite` (7 of 20). A post-hoc look at the
recorded responses found that **21 of the 25 failures on the three screened tasks are a response that ended at
`finish_reason: "length"`**: the model's reasoning used all of Pi's default `max_completion_tokens` (16,384) before it wrote
any code, and the starting stub was left in place. Four failures were wrong answers.

That matters for two roadmap items.

- **Item 13 (resource-aware cognition).** Compute Appetite is to be "an explicit inference budget and policy", and the roadmap asks
  to "test whether extra compute buys reliable outcome improvements rather than longer traces alone", starting "with simple,
  falsifiable arms", and to measure wall time and memory/attention pressure for local inference, not tokens alone. A completion
  cap is the simplest budget there is, and the data already show that on these tasks it is binding.
- **Item 11 (evolution policies on real bundles).** A candidate is only compared on tasks with headroom. If the headroom on the two
  tasks is mostly the cap, a candidate that moves the cap, or the length of the reasoning, will look like a better agent, and
  one that does not will look like nothing. Both should be known before a candidate is judged on them.

This study is a **diagnostic of what the discriminating tasks measure** and a first, small test of compute arms. It is not a
candidate evaluation and it does not use the validation/holdout split (§10).

## 2. Question and prediction

**Main question.** On `fetch-cache` and `markup-lite`, does raising Pi's completion cap from 16,384 to 32,768 tokens raise the
success rate, with the 600 s step timeout, the context window and everything else held out of the way (§3)?

**Secondary questions.**
1. Does a larger cap (49,152) add anything over 32,768?
2. Does telling the model to keep its reasoning short, at the default cap, raise the success rate, and does it cost accuracy on a
   task that needed long reasoning?
3. Does switching the model's thinking off per request, at the default cap, do the same? (Only if the pilot shows the field works, §6.)
4. What does each arm cost per success: output tokens, wall time, and peak prompt tokens (the proxy for attention and memory pressure)?
5. Is the effect the same across working-directory paths? (`markup-lite` varied by path in the earlier study.)

**The prediction, stated now.** Removing the truncation will raise `fetch-cache` and `markup-lite` to **19 or 20 of 20**
(saturated), and so the two tasks measure the cap and not the code. If that is what happens it is a valid and useful result: it
says what the task set can and cannot show.

## 3. Environment and condition

As the discriminating-task study's §3 (same machine, Node, Pi 1.0.1 with identity `f91821fd54dd…`, scratch HOME and agent
directory, llama.cpp at `http://127.0.0.1:8080` with `qwen3.8-27b` Q4_K_M, context 98304, not started, stopped, restarted or
reconfigured, no settings, slot or admin endpoint called, runner `endo-experiment-runner.3`, `fixture-public` domain, E3's pinned
environment, server sampling defaults), with one change that is **pre-registered for every arm, including the control:**

- **The session timeout is 3,600,000 ms (one hour), not 600,000.** At the earlier study's rate (about 16.4k output tokens in
  about 206 s, roughly 80 tokens/s) a 32k response takes about 400 s and a 49k response about 600 s, so with the 600 s step timeout a
  cap arm could fail on time instead of tokens, the opposite of the effect being measured. **The control arm A is therefore not exactly
  the discriminating-task study's condition** (it differs by this timeout, and by running concurrently), and a rate here is not
  compared with that study's rate as if it were.
- **The context window bounds the cap.** The prompt plus `max_completion_tokens` must fit in `n_ctx` (98,304). The largest prompt in
  the committed data for these tasks was 39,779 tokens (`config-extends`; 25 tool calls on `fetch-cache`). 39,779 + 65,536 would not
  fit, so the largest cap is **49,152** (39,779 + 49,152 = 88,931). An oversize request that the server rejects is a failure mode the
  pilot must look for (§6) and the main run counts (§7).

## 4. The arms

Every arm is installed through **one documented mechanism**: a `before_provider_request` extension (as the variance and
pinned-environment studies), so the arms differ in what the handler returns and nothing else. The task prompt is never edited.

| Arm | Cap | What the handler does |
| :--- | ---: | :--- |
| **A** control | 16,384 (Pi's default) | nothing (a no-op handler) |
| **B** | 32,768 | sets `max_completion_tokens: 32768` |
| **C** | 49,152 | sets `max_completion_tokens: 49152` |
| **D** brief | 16,384 | appends one sentence to the system message: "Keep your reasoning short: decide on an approach quickly, write the code, run the tests, and fix what fails." The first user message is untouched, so M-ws still compares it to the task prompt. |
| **E** no thinking | 16,384 | adds `chat_template_kwargs: { "enable_thinking": false }`. **Only if the pilot shows it reduces reasoning output (§6); otherwise dropped and recorded.** |

**Not in this study: a retry after a cut-off.** Pi documents an `agent_before_settle` boundary where a handler can request one
continuation, which could implement "your last reply was cut off, write the implementation now". It changes every trial's
structure and needs its own contract reading, so it belongs in its own study once B's result is known.

## 5. Tasks

| Task | Role | Why |
| :--- | :--- | :--- |
| `fetch-cache` | primary | 13 of 20 in the confirmation; 7 of 7 failures cut off |
| `markup-lite` | primary | 7 of 20; 11 of 13 failures cut off |
| `booking-conflicts` | control (light) | 20 of 20; about 7k output tokens |
| `config-extends` | control (heavy) | 6 of 6 in the screen; about 21k output tokens, so a harm from D or E on a task that needs long reasoning would show here |

The tasks are the committed pool's, unchanged (their hidden checks, prompts and workspaces are not edited).

## 6. The pilot, and what it must establish before the main run

**One path, every arm and task, 2 trials per cell** (5 arms × 4 tasks × 2 = 40 trials), blocked-randomized by the runner. It
establishes, and each is a recorded gate:

1. **The cap took effect (M-inj).** In every request of arm B the field `max_completion_tokens` is 32768 (C: 49152; A, D, E: 16384).
   If the field is absent or different, the arm is rebuilt before the main run (a rebuild is a §13 deviation).
2. **No timeout and no context error in a cap arm.** Any "session did not finish" or server error on an oversize request in B or C
   is investigated and explained, and if it is a timeout the timeout is raised (a §13 deviation).
3. **E's manipulation.** E is **dropped, and that is recorded,** unless its reasoning output (the streamed `reasoning_content`
   characters per response) is at least 50% below A's median on the same task in the pilot.
4. **D's manipulation.** The system message of every D request is A's with only the one sentence appended; the tools and the other
   request fields are unchanged.
5. **The wall-time estimate,** from which N is chosen (§8).

The pilot's trials are not part of any estimate.

## 7. Success, failure and validity rules

- **Success** is the task's hidden check exiting 0 after the session, as in the discriminating-task study.
- **Failure modes,** each trial: *cut off* (a response ended with `finish_reason: "length"` and the check failed), *session did not
  finish* (no `agent_settled`), *server error* (the exchange failed, for example an oversize request), *wrong result* (anything else).
  This replaces the earlier study's `wrong-result`, which hid the cut-off.
- **A runner error** excludes the trial and is reported; more than 10% of a cell's trials makes the cell unmeasured.
- **Leakage** is the discriminating-task study's amended rule (`leakage.ts`): invalid only on the hidden marker in a tool call or
  result, a path under the repository checkout or the operator's home, or the study's own directories outside the scratch root.
  Invalid trials are excluded and reported, with a sensitivity count of what the result would be if they were counted.
- **Manipulation checks, computed from the recorded requests and responses, per arm (an arm failing one is reported invalid, and
  nothing is reinterpreted):**
  - **M-inj**: §6.1, in every request of every trial.
  - **M-sys**: a D request's system message is A's plus the one sentence; every other arm's equals A's.
  - **M-tools**: the tools of every request equal A's.
  - **M-ws**, **M5**, **M6**, **M1 (no sampling field)**: as the discriminating-task study. M1 here is "no sampling field except the arms' own
    declared one", and `max_completion_tokens` and `chat_template_kwargs` are the only fields an arm may add.
  - **M-trunc**: B must show **fewer** cut-off responses than A, or the cap did not take effect.
  - **M-time / M-ctx**: the count of "session did not finish" and server errors per arm, reported. A nonzero count in B or C needs
    an explanation in the results.

## 8. The main run

- **One spec per path, every arm and task a condition and a task in it,** so the runner's blocked randomization interleaves the
  arms in time and the path is the cluster. **Four paths** (`c1` to `c4`'s analogue: only the spec `id` differs, so only the
  scratch-root hash varies), the order of the paths shuffled by a recorded seed. A is re-run, concurrently, and the earlier
  study's trials are not reused.
- **N, trials per cell per path,** is the largest of 3, 4 or 5 whose estimated total wall time is at most **14 hours**, estimated from
  the pilot's mean wall time per cell (× 4 paths × N × 1.1). If even N = 3 exceeds 14 hours, arm C is dropped and the estimate redone.
  N is written into §9a before the main run.

## 9. Measures

**Primary contrast (named now, one only): B against A, pooled over `fetch-cache` and `markup-lite`.**
- The success rate of each arm over its counted trials, each with a 95% Wilson interval, and the **difference B − A**.
- The **cluster interval**: the difference is computed per path (the four paths' pooled rates), and a 95% t interval with 3 degrees of
  freedom is taken over the four differences. The Wilson intervals treat trials as independent; the cluster interval is the honest one if paths differ.
- **Reading, fixed now.** *The cap is binding* if the cluster interval of B − A lies above 0 and B − A ≥ +0.25. *The cap is not
  the main limit* if B − A < +0.15 and the interval includes 0. Anything else is *inconclusive* and says so.

**Secondary (each reported, none is a headline):** for each arm against A and for each task, the counts and Wilson intervals; C against B;
D against A; E against A (if kept); the same per path; and a **harm check**: on each control task, any arm whose success rate is 0.20 or more
below A's is flagged.

**Cost per success (the item-13 headline table), per arm and task, descriptive:** the median output tokens, wall time and peak prompt
tokens of a trial, and **total output tokens, total wall time per success** (the arm's totals divided by its successes), the share of trials with a cut-off
response, and the share of reasoning in the output (characters of `reasoning_content` over all streamed characters). Peak prompt tokens
is the proxy for attention and memory pressure; wall time is reported beside tokens, because tokens are not a complete compute proxy
for local inference.

## 9a. Pilot result and N

The pilot ran on 2026-10-05 (07:03 to 10:04 UTC): 5 arms × 4 tasks × 2 trials = 40 trials, 40 completed, 0 runner errors, one path
(`endo.experiment.completion-cap-1.0.1-pilot`; `analysis/pilot.json`). It is not part of any estimate. The gates of §6:

1. **M-inj: PASS** in every request of every arm (the cap reached the request: 16,384 for A, D, E, 32,768 for B, 49,152 for C; E's
   `chat_template_kwargs` was present and no other arm had it). **M-sys PASS** (D's system message is A's plus the one sentence; the
   others equal A's), **M-tools PASS**, **M1 PASS** (no sampling field), **M5 and M6 PASS**, **M-ws PASS**. Cut-off responses were
   1.3% of A's, 2.4% of D's, and none in B, C and E: **M-trunc holds** (B has fewer than A).
2. **Timeouts: one.** `fetch-cache` in arm B (#0) ran to the 3,600 s timeout (the runner noted `agent_settled was not observed`)
   because the agent's own self-check, `node --test` on a scratch test file, never returned (Pi's bash tool has no timeout of its own).
   The trial passed its hidden check. It is a hung tool, not the cap and not the context: **no server error and no oversize request in any arm**
   (the largest peak prompt was 31,744 tokens, plus a cap of 32,768 or 49,152). Hangs of this kind cost up to an hour each; they are
   counted as "session did not finish" in every arm (§7), whatever the check said.
3. **E's manipulation works, strongly:** reasoning output fell by 100% on every task (no `reasoning_content` at all), output tokens by
   about 70 to 90% and wall time to 25 to 88 s. **E is kept.** In the pilot E passed 3 of 8 trials against A's 7 of 8
   (`fetch-cache` 0/2, `markup-lite` 0/2, `config-extends` 1/2, `booking-conflicts` 2/2): not an estimate, but it shows what the harm
   check is for.
4. **D's manipulation: PASS** (above).
5. **The estimate.** One trial of every cell cost about 4,420 s (all five arms); with the pilot's means (the hung trial included) the
   estimated total for 4 paths is 19.9 h at N = 3, 26.5 h at N = 4 and 33.1 h at N = 5. **No N fits the 14-hour limit, so by §8 arm C
   is dropped** (the re-estimate: 16.5 h at N = 3, 22.0 h at N = 4).

**Decision for the main run (see §13):** arms **A, B, D and E**, **N = 3** trials per cell per path (12 per cell, 24 per arm on the two primary
tasks, 192 trials), estimated at about 16.5 h with the pilot's hung trial counted and about 10.6 h without it. A 14-hour limit
was a soft budget, the hung trial is the reason it is exceeded, and N = 3 is the smallest N the design allows.

## 10. What this study does and does not do to the holdout

The discriminating-task study fixed a validation/holdout split (`validated-tasks.json`: `fetch-cache` validation, `markup-lite` holdout). **This
study uses both tasks openly, and the split's holdout claim does not cover it:** the arms here were motivated by a failure analysis that
read `markup-lite`'s hidden check and its confirmation failures, and by the earlier study's own §10, a candidate designed while its
author could read a holdout task's check or results has no valid holdout result on that task. The consequence, stated plainly: **a
real promotion holdout for roadmap item 11 needs new tasks the cap analysis has never touched.** This study does not create them.

## 11. Limits, known in advance

- One Pi release, one model and quantization, one server session, one machine, one provider API.
- The arms are cheap and crude (a cap, one sentence, one template field). This is not learned or adaptive allocation, and a result here
  says nothing about it.
- **Four tasks.** The primary contrast rests on two; the controls are two more, and a harm check on two tasks is weak.
- **The control arm is not the earlier condition** (§3), and the two studies' rates are not compared as if they were.
- **Per-request fields the server may ignore.** E depends on `chat_template_kwargs` reaching the template; the pilot gate (§6.3) checks
  the effect, not the request.
- Paths are not interleaved across runs in time, but the arms are interleaved within each path.
- The completion cap is not the only way a response can be too long: a larger cap may also let a trial run on without converging, and
  the cost table is there to show it.

## 12. Why this, and why now

The roadmap's order is runtime truth, replay, evaluation, then evolution, and item 13 asks for compute to be an explicit, measured budget
before any adaptive policy. The discriminating-task study produced two tasks and showed their headroom is largely the cap. Establishing what
the cap buys, and what cheaper alternatives to it cost, is the smallest step that tells the next study whether to build a retry policy, an
adaptive budget, or new tasks.

## 13. Deviations

Both were decided from the pilot, before any main-run trial.

1. **N = 3 with an estimate above the 14-hour limit (§8).** §8 says to drop arm C if even N = 3 exceeds 14 hours and to redo the estimate.
   C was dropped and the estimate (16.5 h) still exceeds 14 h, mainly because one pilot trial hung for the full hour. The design did not say
   what to do then. The decision is to run N = 3 anyway: it is the smallest N the design allows, the limit was a soft budget, and the estimate
   without the hung trial is 10.6 h. **The secondary question 1 (does 49,152 add anything over 32,768) is therefore not answered by this study.**
2. **The analysis counts a session that did not finish whatever the check said (§7).** The pilot's one timeout passed its check, and the
   first version of the analysis counted "session did not finish" only among failures. It now counts every trial the runner noted as not
   settled, as §7's M-time says. Two earlier fixes to the analysis code (reading chunked responses by bytes, and skipping the proxy's empty
   stale-connection retries) were also made on the live pilot, before any analysis of it.
