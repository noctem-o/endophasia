# Variance study results: Pi 1.0.1 with qwen3.8-27b on llama.cpp

Design: [DESIGN.md](DESIGN.md), committed before any data. Two deviations are recorded there in §12:
1. An exploratory analysis was added after the pilot.
2. The first main run is invalid because of a measurement artifact of the recording proxy. The proxy was fixed, and
   the main run was repeated.

All figures below are from the repeated main run, unless marked otherwise.

## Summary

- **Under Pi's defaults (arm A), every run differs.** In all 570 pairs of trials (190 per task), the first difference
  is a different model reply to an identical request. That is sampling.
- **Under deterministic-intended sampling (B and B+C), the model was deterministic on identical input.** No identical
  request produced a different reply in any of the 1,140 pairs. Lifecycle and outcome were identical in 20 of 20
  trials on all three tasks.
- **What still varies under B and B+C is the environment.** On the two coding tasks, every trial's tools layer
  differs. In every such pair, the first difference is a tool's output: `node --test` durations and `ls -la`
  timestamps, which then enter the next request.
- **The prompt cache affected which tool calls followed different tool output.** With the cache off (B+C), the
  sequence of tool calls (names and argument digests) was identical in 20 of 20 trials on every task. With the cache
  on (B), it was 15 of 20 on `fix-failing-test` and 10 of 20 on `implement-function` (exploratory).
- **Pre-registered verdict (§7): "unstable" under every arm.** The tools layer is unstable on both coding tasks under
  all arms. Under B and B+C, the exploratory analysis attributes that instability to tool output, not to the model or
  to Pi.
- **Every trial passed its success check** (180 of 180). A trajectory can vary and still be correct.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f…` |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080, as already running. Not restarted, reconfigured or queried beyond `/health`, `/v1/models` and the completions Pi made. |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, RTX 4090, 31 GiB RAM |
| Digest domain | `fixture-public` (fixture-experiment mode) |
| Pilot | 36 trials, ordering seed 2892665600, 2026-10-04 06:58–07:03 (recorded through the proxy before its fix; see Validity) |
| Main run 1 | 180 trials, seed 363281846, 07:05–07:32. **Invalid** (deviation 2): [main-run-1-invalid/](main-run-1-invalid/README.md) |
| Main run (repeated) | 180 trials (3 tasks × A, B, B+C × N = 20), seed 581305836, 07:55–08:20. 180 completed, 0 errored, 0 interrupted. |
| Report | `main/bundle.json` (`endo.experiment-report.v0`), digest `d89e37997af77b09…` |

## Validity

### Manipulation checks (§5)

| Run | M1 injected fields | M2a first requests | M2b structure | M3 cache off | M4 no-op = none |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Pilot | PASS (186 requests) | PASS (36 trials) | PASS (186) | PASS (9 trials) | PASS (18 trials) |
| Main (repeated) | PASS (914 requests) | PASS (180 trials) | PASS (914) | PASS (60 trials) | not applicable (pilot only) |

Every arm is valid in both runs.

- **B and B+C** carried exactly `temperature: 0, seed: 1234`, and B+C also `cache_prompt: false`.
- **A** carried none of the watched fields.
- **Nothing else** in any request differed from arm A: same system prompt, tools and parameters.
- **B+C** read no cache, both by Pi's reported `cacheRead` and by the server's `cached_tokens`.
- **The no-op extension** produced requests byte-identical to no extension at all.

### Transport

The repeated run recorded **0** `Connection error.` turns, 0 requests without a recorded end and 0 incomplete
exchanges, in every cell.

Main run 1 recorded many such turns, for example 13 of 20 `implement-function` trials in arm A. They were caused by
the proxy delaying llama.cpp's connection close by its own disk writes. 20 trials sent straight to llama.cpp, and 20
through the fixed proxy, had none. The pilot ran through the proxy before the fix, and a few of its trials had such
turns. Its purposes (M1–M4 on request bodies, and the wall-time estimate) are not affected by them, as recorded in
deviation 2. The manipulation checks could not catch the artifact, because they verify what requests carry, not
whether they arrived.

## Pre-registered results (§6, §7)

Columns, per judged layer:
- **Modal:** the trials whose layer equals the most common one, with a 95% Wilson interval (the headline).
- **Verdict:** §7's criterion (stable if L ≥ 0.70, unstable if U < 0.70, otherwise inconclusive).
- **Distinct:** the number of distinct trajectories.
- **Pairs:** the pairwise exact-match rate, with a 95% bootstrap interval that resamples trials.

### tool-use

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A | lifecycle | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| A | tools | 12/20 [38.7, 78.1] | inconclusive | 2 | 49.5% [43.5, 64.8] |
| A | outcome | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B | lifecycle, tools, outcome | 20/20 [83.9, 100] each | stable | 1 | 100% [100, 100] |
| B+C | lifecycle, tools, outcome | 20/20 [83.9, 100] each | stable | 1 | 100% [100, 100] |

### fix-failing-test

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A | lifecycle | 12/20 [38.7, 78.1] | inconclusive | 3 | 43.2% [28.9, 64.0] |
| A | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| A | outcome | 12/20 [38.7, 78.1] | inconclusive | 3 | 43.2% [29.0, 64.0] |
| B | lifecycle | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| B | outcome | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B+C | lifecycle | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B+C | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| B+C | outcome | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |

### implement-function

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| A | lifecycle | 16/20 [58.4, 91.9] | inconclusive | 3 | 64.2% [38.7, 89.6] |
| A | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| A | outcome | 16/20 [58.4, 91.9] | inconclusive | 3 | 64.2% [39.0, 89.6] |
| B | lifecycle | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| B | outcome | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B+C | lifecycle | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |
| B+C | tools | 1/20 [0.9, 23.6] | unstable | 20 | 0% [0, 0] |
| B+C | outcome | 20/20 [83.9, 100] | stable | 1 | 100% [100, 100] |

### Verdicts per arm (§7)

| Arm | "Pi + this model is…" | Why |
| :--- | :--- | :--- |
| A | **unstable** | tools unstable on fix-failing-test and implement-function; lifecycle and outcome inconclusive on both |
| B | **unstable** | tools unstable on both coding tasks; every other layer stable on every task |
| B+C | **unstable** | the same as B |

### Arm comparisons (§7: X is more stable than Y only if X's L > Y's U)

**B more stable than A:**
- tool-use tools: L 0.839 > U 0.781.
- fix-failing-test lifecycle and outcome: L 0.839 > U 0.781.

The same holds for B+C over A.

**No claim:**
- implement-function lifecycle and outcome, A against B or B+C: A's U is 0.919, so the intervals overlap.
- B against B+C on any pre-registered layer: identical results.

### Success checks, workspaces, usage and timing (never judged)

| Task | Arm | Check passed | Distinct final workspaces | Output tokens, median (IQR) | cacheRead, median (IQR) | Wall ms, median (IQR) |
| :--- | :--- | :--- | ---: | :--- | :--- | :--- |
| tool-use | A | 20/20 | 1 | 307.5 (50.5) | 7376.5 (159) | 3825 (820.75) |
| tool-use | B | 20/20 | 1 | 330 (0) | 7393 (0) | 3608.5 (78.75) |
| tool-use | B+C | 20/20 | 1 | 330 (0) | 0 (0) | 8111 (78.75) |
| fix-failing-test | A | 20/20 | 2 | 558.5 (271.75) | 11989 (5300.75) | 8031 (3292.5) |
| fix-failing-test | B | 20/20 | 1 | 766.5 (34.5) | 17569 (25.75) | 8823.5 (240) |
| fix-failing-test | B+C | 20/20 | 1 | 444.5 (22.25) | 0 (0) | 14637 (293.5) |
| implement-function | A | 20/20 | 20 | 588.5 (98.5) | 10282 (609.25) | 6106.5 (1364.25) |
| implement-function | B | 20/20 | 4 | 570 (12.5) | 10585.5 (24.25) | 5884 (367.75) |
| implement-function | B+C | 20/20 | 1 | 504 (0) | 0 (0) | 10875.5 (273) |

Every check passed: 180/180, Wilson [97.9, 100] overall and [83.9, 100] per cell. Disabling the cache costs wall
time: about 2.2× on tool-use, 1.7× on fix-failing-test and 1.8× on implement-function, against B.

## The noise band under Pi's defaults (arm A)

| Layer | tool-use | fix-failing-test | implement-function |
| :--- | :--- | :--- | :--- |
| lifecycle | 20/20 identical [83.9, 100]; pairs 100% | 12/20 [38.7, 78.1]; 3 distinct; pairs 43.2% [28.9, 64.0] | 16/20 [58.4, 91.9]; 3 distinct; pairs 64.2% [38.7, 89.6] |
| tools | 12/20 [38.7, 78.1]; 2 distinct; pairs 49.5% [43.5, 64.8] | 1/20 [0.9, 23.6]; 20 distinct; pairs 0% | 1/20 [0.9, 23.6]; 20 distinct; pairs 0% |
| outcome | 20/20 [83.9, 100]; pairs 100% | 12/20 [38.7, 78.1]; 3 distinct; pairs 43.2% [29.0, 64.0] | 16/20 [58.4, 91.9]; 3 distinct; pairs 64.2% [39.0, 89.6] |

Under B and B+C, the band for lifecycle and outcome closes to 20/20 on every task, and so does tools on tool-use. On
the coding tasks the tools layer stays at 1/20 under every arm. Its band reflects tool output, not the model (below).

## First divergence

**Pre-registered (§6.4): first-divergence index per layer, over diverged pairs.**

| Task | Arm | lifecycle | tools | outcome |
| :--- | :--- | :--- | :--- | :--- |
| tool-use | A | none | index 1 (96 pairs) | none |
| fix-failing-test | A | index 11 (96), 13 (12) | index 0 (188), 1 (2) | index 0 (108) |
| fix-failing-test | B | none | index 0 (187), 7 (3) | none |
| fix-failing-test | B+C | none | index 0 (190) | none |
| implement-function | A | index 9 (36), 11 (32) | index 0 (181), 1 (8), 3 (1) | index 0 (68) |
| implement-function | B | none | index 0 (187), 4 (3) | none |
| implement-function | B+C | none | index 4 (190) | none |

Tool-use under B and B+C had no diverged pair on any layer.

**Exploratory (deviation 1): where the requests first differ.**

For each pair of trials, the first request whose canonical body differs, and the first differing message in it:
- **model:** an assistant reply differed after identical requests;
- **environment:** a tool result differed.

Before comparing, tool-call ids (random tokens llama.cpp generates per call) are replaced by their order of
appearance; nothing else is normalized.

| Task | Arm | Pairs | model | environment | identical requests throughout | First differing request |
| :--- | :--- | ---: | ---: | ---: | ---: | :--- |
| tool-use | A | 190 | 190 | 0 | 0 | 2 (190) |
| tool-use | B | 190 | 0 | 0 | 190 | — |
| tool-use | B+C | 190 | 0 | 0 | 190 | — |
| fix-failing-test | A | 190 | 190 | 0 | 0 | 2 (190) |
| fix-failing-test | B | 190 | 0 | 190 | 0 | 2 (187), 7 (3) |
| fix-failing-test | B+C | 190 | 0 | 190 | 0 | 2 (190) |
| implement-function | A | 190 | 190 | 0 | 0 | 2 (190) |
| implement-function | B | 190 | 0 | 190 | 0 | 2 (187), 5 (3) |
| implement-function | B+C | 190 | 0 | 190 | 0 | 5 (190) |

The differing tool output is always a timing value. Examples from the recorded requests:
- `node --test`: `✔ collapses a run of other characters into one dash (0.145264ms)` against `(0.117191ms)`;
- `ls -la`: the directory's modification time, `Oct 4 07:06` against `Oct 4 07:07`.

**Exploratory: tool-call sequences without result digests** (tool names and keyed argument digests, in order).

| Task | A | B | B+C |
| :--- | :--- | :--- | :--- |
| tool-use | 12/20 [38.7, 78.1], 2 distinct | 20/20 [83.9, 100], 1 | 20/20 [83.9, 100], 1 |
| fix-failing-test | 1/20 [0.9, 23.6], 20 distinct | 15/20 [53.1, 88.8], 2 | 20/20 [83.9, 100], 1 |
| implement-function | 1/20 [0.9, 23.6], 20 distinct | 10/20 [29.9, 70.1], 4 | 20/20 [83.9, 100], 1 |

**Reading the exploratory results:**
- Under B+C, all 20 trials of each task made the same tool calls with the same arguments. Their tools layers differ
  only in the result digests of tools that print timings.
- Under B, with the cache on, the same kind of differing tool output was followed by different calls in some trials:
  `implement-function` 10/20 (B+C's L 0.839 exceeds B's U 0.701).
- That is consistent with llama.cpp's documented warning that `cache_prompt` "can cause nondeterministic results".
  This design cannot separate the cache's effect from the differing tool text it acts on, because under B the first
  difference is always environmental.

## Spot-check replays (§10): a finding

Three main-run trials were chosen by the ordering seed and replayed from their cassettes:
- `fix-failing-test/b-c/#13`;
- `implement-function/b/#1`;
- `implement-function/b/#19`.

**None was EXACT.** Each replay ended with an explicit `unexpected-request` cassette miss at exchange 2, so
lifecycle, tools and outcome are DIVERGED against the recording.

Each was diagnosed from the evidence: in replay request 2, the first message differing from the recording is a tool
result.
- `fix-failing-test/b-c/#13`: the `node --test` duration, `0.686967ms` against `0.706454ms`.
- `implement-function/b/#1`: `ls -la` printed the restore time, `07:57` against `08:21`.
- `implement-function/b/#19`: the same, `08:20` against `08:22`.

On replay Pi runs the tools again, in the restored workspace, so their output differs, and the cassette correctly
refuses a request it does not hold.

This is the limit `docs/replay.md` names ("nondeterministic tools"), now observed. PR D's EXACT replays used a
scenario whose tools are deterministic (`wc -l` on a restored file). Replay reproduces a session whose tools print
wall-clock values only if those values are held fixed too. The workspace snapshot deliberately keeps no timestamps.
In main run 1, the same check found the same mechanism.

## Sensitivity check (§10): cassettes are not committed

Every request body (914) and response (914) of the repeated run was searched. Found:

| What | Occurrences | Where |
| :--- | ---: | :--- |
| The operator's username | 4314 | inside `ls -la` output the model asked for (the owner and group columns), carried in every later request |
| Dates and times | 2157 | `ls -la` modification times |
| Kernel and OS | 1828 | request headers Pi sends: `user-agent: pi (linux 7.2.6-arch2-1; x64)`, `x-stainless-os: Linux` |
| Paths | — | only the scratch root `/tmp/endo-experiment-5c853d82a217/…` and Pi's install path in its system prompt |

There was one distinct system prompt. No hostname, home directory, email, key, bearer token or LAN address appeared.
Because the username and dates appear, **the cassettes fail the check and are not committed.** What is committed:
- the report;
- the run metadata;
- every trial's `result.json`, which has no message content;
- the analyses. In `analysis/sensitivity.json`, the matched examples are withheld and only counts are kept.

## Limits

- **One of each:** one Pi release (1.0.1), one model and quantization (qwen3.8-27b Q4_K_M), one llama.cpp build, one
  machine and GPU, and one provider API (`openai-completions`).
- **Server defaults unknown.** Its actual default sampling settings are unknown: Pi sends none, and no settings
  endpoint was called.
- **Small study.** Three small synthetic tasks, N = 20 per cell, trials one at a time against one shared server. Other
  clients' use of the server could not be controlled or observed.
- **Tools are part of the measurement.** On the coding tasks, the tools layer measures the environment (tool output
  with timings) as much as Pi or the model. Under B and B+C it varies for that reason alone. A study of model and
  serving variance on such tasks needs deterministic tool output.
- **Stability is on Endophasia's trajectory layers.** The model's text is not a judged layer.
- **Thresholds and exploratory analyses.** The §7 thresholds are a judgment. The exploratory analyses were added after
  the pilot (deviation 1) and are labelled as such.
- **A transport artifact.** The first main run was lost to an artifact of the recording proxy (deviation 2), and the
  pilot was recorded before its fix.

## Files

| Path | Contents |
| :--- | :--- |
| `DESIGN.md` | the design, the N decision, the deviations |
| `spec-pilot.json`, `spec.json`, `make-spec.ts` | the specs and their generator |
| `analyze.ts` | the estimate, the spot checks, the sensitivity scan and the exploratory analyses |
| `pilot/` | the pilot report (`bundle.json`, `summary.md`), `experiment.json`, `plan.json` |
| `main/` | the repeated main run: `bundle.json`, `summary.md`, `experiment.json`, `plan.json`, `journal.jsonl`, `environment/`, `trials/**/result.json` |
| `analysis/` | `divergence.json`, `calls.json`, `spotcheck.json`, `sensitivity.json` (counts only), `pilot-estimate.json` |
| `main-run-1-invalid/` | the invalid first main run and the transport-artifact evidence |
