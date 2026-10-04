# Pinned-environment study results: Pi 1.0.1 with qwen3.8-27b on llama.cpp

Design: [DESIGN.md](DESIGN.md), committed before any data. §9 records N, chosen from the pilot before the main run.
§12 records one deviation: metric 7 (final workspaces) does not measure content in this study and is not interpreted.

All figures are from the main run unless marked "pilot".

## The three answers (§7)

### 1. Main question: B+C-p is stable

With the environment pinned, deterministic sampling and the cache off, Pi 1.0.1 with qwen3.8-27b reproduced every
judged layer on all three tasks:
- lifecycle, tool calls, tool results and outcome were each 20/20, with 95% Wilson interval [83.9, 100], on every
  task;
- all 190 pairs of each task made identical requests from start to end (§6.9).

In E2, the same sampling and cache arm (B+C) was "unstable": the tool-results layer was 1/20 on both coding tasks.

### 2. Environment, within this study: the pinned environment is more stable

On each coding task's tool-results layer, B+C-p is 20/20 [83.9, 100] and B+C-u is 1/20 [0.9, 23.6]. B+C-p's lower
bound (0.839) exceeds B+C-u's upper bound (0.236), so by §7's rule **the pinned environment is more stable**, on both
`fix-failing-test` and `implement-function`. M5 and M6 passed for B+C-p (below).

The two arms ran interleaved in one randomized run, in one server session, with the same sampling, cache setting,
tasks and extensions. Under B+C-u, as in E2:
- the model made the same tool calls until a tool's output differed (§6.5: 190/190 pairs per task);
- every pair of each coding task first differed at a tool result (190/190);
- that result carried a **clock time** in 189 pairs: `ls -la` printing the minute the trial's workspace was created,
  for example `Oct  4 12:16` against `Oct  4 12:18`;
- it carried a **duration** in 1 pair: two trials that started in the same minute, where `node --test` durations were
  the first difference.

`tool-use`, whose tools print no times, was identical end to end under both arms (reported, not tested, as designed).

### 3. The prompt cache on identical input: no evidence at this N, with a caveat and a pilot observation

**Main run.**
- B-p had **0 model pairs** on every task, and so did B+C-p (§6.9). By §7, that is **no evidence at this N** that the
  cache changes replies to identical input.
- B-p was in fact stable on every layer of every task, like B+C-p.

**What the main run held fixed.** Within each task, every B-p trial read exactly the same number of tokens from the
cache (Pi's `cacheRead`: 7376, 12633 and 11090 for the three tasks, identical in all 20 trials). Every B-p trial
therefore met the same warm cache state. The main run shows that a repeated, identical cache state gives identical
replies. It does not test what a *different* cache state does.

**Pilot observation** (3 trials per cell; not part of the analysis, per §9). In `tool-use` under B-p:
- trial #0 was the first trial of the pilot, the first request after the llama.cpp restart;
- its first request read **0 cached tokens** from the server (`cached_tokens`), where trials #1 and #2 read 1599;
- its reply to the byte-identical first request differed. The reasoning ended "Let me start with the read first.",
  against "Let me start with step 1 first." in #1 and #2. The tool call was the same.

That is one event, in the pilot, and the pre-registered answer does not rest on it. It is consistent with llama.cpp's
documented warning that `cache_prompt` "can cause nondeterministic results". A design that manipulates the cache
state on purpose (cold against warm) would test it.

## Verdicts per arm (§7)

| Arm | Verdict | Why |
| :--- | :--- | :--- |
| **A-p** (Pi's defaults, pinned) | **unstable** | `fix-failing-test`: every layer unstable. `implement-function`: tool calls and tool results unstable. Every pair of every task first differs at the model's reply to an identical request (190/190 per task): sampling. |
| **B-p** (temperature 0, seed 1234, pinned) | **stable** | Every layer 20/20 on every task; every pair identical throughout. |
| **B+C-p** (also cache off, pinned) | **stable** | Every layer 20/20 on every task; every pair identical throughout. |
| **B+C-u** (also cache off, unpinned) | **unstable** | Coding tasks: tool results 1/20. Every pair first differs at a tool result carrying a time. |

**Success checks** passed in 240 of 240 trials (20/20 in every cell, [83.9, 100]). They are reported, not part of
stability.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (the same as E2) |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080. Restarted by the operator at about 10:39 UTC on 2026-10-04, before any data; not restarted, reconfigured or queried by this study beyond `/health`, `/v1/models` and the completions Pi made. |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, RTX 4090, 31 GiB RAM; Node v26.10.0 |
| Runner | `endo-experiment-runner.2` (the condition environment, added by this PR before the pilot) |
| Digest domain | `fixture-public` (fixture-experiment mode) |
| Pilot | 36 trials (3 tasks × 4 arms × 3), seed 2532091956, 2026-10-04 11:09–11:15 UTC. 36 completed. |
| Main run | 240 trials (3 tasks × 4 arms × N = 20), seed 3619119635, 11:15–11:54 UTC. 240 completed, 0 errored, 0 interrupted. |
| Report | `main/bundle.json` (`endo.experiment-report.v1`), digest `dd9a2a7c5f0f1bbd…` |

## Validity

### Manipulation checks (§5)

| Run | M1 injected fields | M2a first requests | M2b structure | M3 cache off | M5 environment | M6 reporter in effect |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Pilot | PASS (187 requests) | PASS (36 trials) | PASS (187) | PASS (18 trials) | PASS (36 trials) | PASS (0 durations in 139 requests) |
| Main | PASS (1242 requests) | PASS (240 trials) | PASS (1242) | PASS (120 trials) | PASS (240 trials) | PASS (0 durations in 922 requests) |

Every arm is valid in both runs.
- **M1–M3.** The sampling arms carried exactly their fields, A-p none of them, and nothing else in any request
  differed from A-p. The first request of every task was byte-identical across all four arms, so the pinning did not
  reach Pi's requests directly. The cache-off arms read no cache.
- **M5.** Every pinned trial recorded the spec's variables (with the scratch root resolved) and the reporter's
  sha256. Every entry of its snapshot, and the root, carried 2026-01-01T00:00:00Z. Every unpinned trial recorded no
  environment and had no `env/`.
- **M6.** No tool result in any pinned request carried a duration from Node's reporters. Whenever the model ran the
  tests, the duration-free reporter was in effect.

### Transport

The main run recorded **0** `Connection error.` turns: 1242 requests, every one with a recorded end, all complete.

The pilot recorded one. In `fix-failing-test/b-p/#2`, the upstream reset the connection (ECONNRESET) 8 ms after its
second request arrived, before any response byte. That is 1 of 187 pilot requests. It explains the pilot's two "model"
pairs in that cell: both involve #2, whose next request carried the error turn. The pilot's purposes (M1–M6 and the
wall-time estimate) are not affected.

## Pre-registered results (§6, §7)

Columns, per judged layer:
- **Modal:** the trials whose layer equals the most common one, with a 95% Wilson interval (the headline).
- **Verdict:** §7's criterion.
- **Distinct:** the number of distinct trajectories.
- **Pairs:** the pairwise exact-match rate, with a 95% bootstrap interval that resamples trials.

### tool-use

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| A-p | tool calls | 10/20 [29.9, 70.1] | inconclusive | 2 | 47.4 [43.4, 58.1] |
| A-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| A-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |

### fix-failing-test

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A-p | lifecycle | 8/20 [21.9, 61.3] | unstable | 5 | 25.8 [15.6, 39.4] |
| A-p | tool calls | 1/20 [0.9, 23.6] | unstable | 20 | 0.0 [0.0, 0.0] |
| A-p | tool results | 1/20 [0.9, 23.6] | unstable | 20 | 0.0 [0.0, 0.0] |
| A-p | outcome | 8/20 [21.9, 61.3] | unstable | 5 | 25.8 [15.8, 39.8] |
| B-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | tool calls | 10/20 [29.9, 70.1] | inconclusive | 5 | 32.1 [18.2, 50.9] |
| B+C-u | tool results | 1/20 [0.9, 23.6] | unstable | 20 | 0.0 [0.0, 0.0] |
| B+C-u | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |

### implement-function

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A-p | lifecycle | 18/20 [69.9, 97.2] | inconclusive | 3 | 80.5 [55.2, 100.0] |
| A-p | tool calls | 1/20 [0.9, 23.6] | unstable | 20 | 0.0 [0.0, 0.0] |
| A-p | tool results | 2/20 [2.8, 30.1] | unstable | 19 | 0.5 [0.0, 3.3] |
| A-p | outcome | 18/20 [69.9, 97.2] | inconclusive | 3 | 80.5 [55.2, 100.0] |
| B-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-p | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| B+C-u | tool calls | 16/20 [58.4, 91.9] | inconclusive | 5 | 63.2 [35.0, 89.6] |
| B+C-u | tool results | 1/20 [0.9, 23.6] | unstable | 20 | 0.0 [0.0, 0.0] |
| B+C-u | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |

### Tool calls up to the first divergent input (§6.5)

Over all 190 pairs per cell: whether the tool calls were identical up to the first tool result that differed.

| Task | A-p | B-p | B+C-p | B+C-u |
| :--- | :--- | :--- | :--- | :--- |
| tool-use | 90 identical, 100 not | 190 identical | 190 identical | 190 identical |
| fix-failing-test | 190 not | 190 identical | 190 identical | 190 identical |
| implement-function | 190 not | 190 identical | 190 identical | 190 identical |

Under B+C-u the calls diverge later (tool calls 10/20 and 16/20 on the coding tasks), but only after a tool's output
had already differed. Under A-p they diverge because the model's replies do.

### Where the requests first differ (§6.9), and the residual environment (§6.10)

Tool-call ids (random tokens the server generates) are replaced by their ordinal in each trial before comparing.
Nothing else is normalized. The last three columns classify the environment pairs by residual source.

| Cell | Pairs | model | environment | identical | other | duration | clock time | other source |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tool-use, A-p | 190 | 190 | 0 | 0 | 0 | 0 | 0 | 0 |
| tool-use, B-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| tool-use, B+C-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| tool-use, B+C-u | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| fix-failing-test, A-p | 190 | 190 | 0 | 0 | 0 | 0 | 0 | 0 |
| fix-failing-test, B-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| fix-failing-test, B+C-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| fix-failing-test, B+C-u | 190 | 0 | 190 | 0 | 0 | 1 | 189 | 0 |
| implement-function, A-p | 190 | 190 | 0 | 0 | 0 | 0 | 0 | 0 |
| implement-function, B-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| implement-function, B+C-p | 190 | 0 | 0 | 190 | 0 | 0 | 0 | 0 |
| implement-function, B+C-u | 190 | 0 | 190 | 0 | 0 | 1 | 189 | 0 |

**Pilot** (reported separately; `analysis/pilot-divergence.json`):
- B+C-p: identical in every pair.
- B+C-u: environment on both coding tasks (clock time).
- A-p: model.
- B-p: model in 2 of 3 pairs on `tool-use` (the cold-cache trial, above) and on `fix-failing-test` (the trial with
  the connection error); identical otherwise.

### Success checks, workspaces, usage and timing (§6.6–§6.8, never judged)

- **Success checks:** 20/20 in every cell.
- **Final workspaces:** 20 distinct in every cell. **Not interpreted** (DESIGN §12, deviation 1). The archive now
  carries file times, and files the agent writes get the time they were written. In B-p and B+C-p, all 20 archives of
  a task have the same length, and every call that wrote a file wrote the same content.
- **Wall time** (observer, median): turning the cache off cost 2.0× to 3.4×.

  | Task | A-p | B-p | B+C-p | B+C-u |
  | :--- | ---: | ---: | ---: | ---: |
  | tool-use | 3.7 s | 3.4 s | 7.6 s | 7.6 s |
  | fix-failing-test | 7.8 s | 5.4 s | 18.1 s | 18.2 s |
  | implement-function | 6.3 s | 5.9 s | 12.0 s | 11.7 s |

- **Cache reads** (Pi's `cacheRead`, per trial):
  - **B-p:** constant within each task (7376, 12633, 11090).
  - **A-p:** varying (for example 7891–20440 on `fix-failing-test`).
  - **B+C-p and B+C-u:** zero.

## Checks after the run (§10)

**Spot-check replay**, chosen by the run's seed (`analysis/spotcheck.json`): `tool-use/b-c-p/#17`,
`tool-use/b-p/#10` and `fix-failing-test/a-p/#17`. Each is EXACT on lifecycle, tool calls, tool results and outcome,
with 0 misses.

**Cassette replays**, all 12 exported cassettes, one per task per arm, replayed from their exported form
(`analysis/cassette-replays.json`):
- **The 9 pinned cassettes:** EXACT on every layer with 0 misses, the coding tasks included. In E2, every coding-task
  cassette missed.
- **`tool-use--b-c-u`:** EXACT.
- **`fix-failing-test--b-c-u` and `implement-function--b-c-u`:** **environment diverged** at exchange 7 and 5, near
  the end of the session. File times are restored on replay, so the `ls -la` at the start matched. What diverged was
  later tool output, which a replay cannot hold fixed without pinning (`docs/replay.md`, the wall-clock limit). Never
  control flow.

**Cassettes.** The 12 exported cassettes passed the secret scan with 0 findings. They were committed after the
operator approved their size (3.2 MB, 199 files), per the standing process: [cassettes/](cassettes/README.md).

## Against E2 (descriptive; different server sessions)

| Task, layer | E2 B+C (unpinned) | E3 B+C-u (unpinned) | E3 B+C-p (pinned) |
| :--- | :--- | :--- | :--- |
| fix-failing-test, tool results | 1/20 | 1/20 | 20/20 |
| implement-function, tool results | 1/20 | 1/20 | 20/20 |

- **E2's environment finding is replicated** by this study's unpinned control: under B+C-u, every coding-task pair
  first differed at a timed tool output.
- **E2's attribution of it to the environment is confirmed** by pinning: with the times and durations gone, the same
  arm became stable.
- **The cache.** E2's B (cache on, unpinned) had 10/20 on implement-function's tool-call sequence. This study's B-p
  (cache on, pinned) has 20/20. That fits E2's reading that the cache acted on input that already differed. These
  comparisons cross server sessions and are not tested.

## Limits

- The limits of DESIGN §11.
- **Cache state.** The main run never varied the cache state under B-p (above), so question 3 is answered only for a
  repeated cache state.
- **Final workspaces.** Metric 7 is not interpretable (deviation 1).
- **One server session.** It began with the operator's restart. Comparisons with E2 cross server sessions.

## Files

| Path | What it is |
| :--- | :--- |
| `DESIGN.md` | the design, N (§9) and the deviation (§12) |
| `make-spec.ts`, `spec-pilot.json`, `spec.json` | the spec generator and its outputs |
| `test-reporter.mjs` | the pinned environment's test reporter |
| `analyze.ts` | M5, M6, §6.9, §6.10, the estimate, the spot checks and the sensitivity scan |
| `pilot/` | the pilot's report, plan and run record |
| `main/` | the main run: `bundle.json`, `summary.md`, `experiment.json`, `plan.json`, `journal.jsonl`, `environment/`, `trials/**/result.json` |
| `analysis/` | the pilot estimate, M5/M6 (pilot and main), first difference (pilot and main), spot checks, cassette replays |
| `cassettes/` | one cassette per task per arm, with the consent note and the secret-scan result |
