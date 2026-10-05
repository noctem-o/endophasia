# Steering study results: STEER and QUEUE at a fixed point, Pi 1.0.1 with qwen3.8-27b on llama.cpp

Design: [DESIGN.md](DESIGN.md), committed before any data. §9a records N, chosen from the pilot before the main run.
§13 records three deviations found after the data was collected (the cassettes were committed before the operator was told
their size; two analysis-code corrections to match the design's text; and the post-hoc runs below). None changes a
pre-registered result.

All figures are from the main run unless marked "pilot".

## What the study holds to (§7)

**The study holds.** M1 to M3, M5, M6, I1 and I2 passed, and **P1 to P4 held in every one of the 120 trials.**

| Check | Result |
| :--- | :--- |
| **P1**, the noise floor | PASS on both tasks: all 20 baseline trials make identical requests, and the four judged layers are EXACT across them (4 requests on `tool-use`, 5 on `implement-function`) |
| **P2**, nothing differs before the point | 40/40 steered trials: requests 1 and 2 equal the baseline's |
| **P3**, where the first divergence is | 40/40: for a steer, exactly request 3; for a queue, exactly request n + 1 (5 on `tool-use`, 6 on `implement-function`), with requests 1 to n equal to the baseline's |
| **P4**, consumption is shown by the proxy and is the divergence | 40/40: every steered trial has an `intervention.consumed` record whose exchange is the first divergent request |

No trial diverged before the point, and none was consumed early or late. Nothing is reported as a bug or a
manipulation failure.

## Delivery: where Pi consumed the message

Pi delivered the message where its documentation says, in all 40 steered trials:
- **STEER** was applied once exchange 2's first chunk was relayed (in E3's recordings, about 15 ms after its request) and arrived as a user
  message in request 3, after the tool result of the turn that was streaming and before the next model call.
- **QUEUE** (`follow_up`) was applied at the same point and arrived as the first request of a new run, after the
  baseline's last request: request 5 on `tool-use`, request 6 on `implement-function`.

In every trial the consumption is the proxy's evidence, an exact keyed digest of a user message in a captured request
(the message text is kept outside the records). Pi's acceptance (`queued`) said nothing about consumption: they are
three separate records. Pi's acceptance carries no identity for the queued message, so consumption can only be tied to
a message by its content, which is what the proxy shows.

## The effect (P5): what the agent did, reported as measured

| Task | Arm | Compliance [95% Wilson] | Success check | Outcome | Judged layers EXACT against base |
| :--- | :--- | :--- | :--- | :--- | :--- |
| tool-use | steer | **20/20** [83.9, 100] | 20/20 | completed 20 | lifecycle 18, tool calls 0, tool results 0, outcome 18 |
| tool-use | queue | **20/20** [83.9, 100] | 20/20 | completed 20 | none (each trial has more requests) |
| implement-function | steer | **0/20** [0.0, 16.1] | 20/20 | completed 20 | lifecycle 20, tool calls 0, tool results 20, outcome 20 |
| implement-function | queue | **20/20** [83.9, 100] | 20/20 | completed 20 | none |
| both | base | n/a | 40/40 | completed 40 | n/a |

**Compliance** is read from the captured requests: after the message, an assistant `bash` tool call whose command,
trimmed, is exactly the task's command. It is measured apart from the success check.

**The success check passed in all 120 trials.** The commands asked for change no file, so the success checks could not
distinguish "followed" from "ignored", which is why compliance is measured separately. **No effect on the success
check is shown, and none of this says a steer or a queue improved anything.** What the data shows is below.

- **QUEUE was followed in 40/40, on both tasks.** The follow-up started a new run after the work was done, and the
  agent then ran the command. It cost one more run: 2 more requests on each task and, on `tool-use`, a median of 3.8 s more.
- **STEER on `tool-use` was followed in 20/20, and cost ten times the output.** After the steer the agent reasoned
  about the conflict between the original step 3 and the message (10,439 characters of reasoning in trial 0 for that
  turn, against 79 for the same turn in the baseline), then ran **both** commands in one turn: `wc -l notes.txt` and `cat notes.txt`.
  - Output tokens: **2,851** against 289 for the baseline (identical in all 20 trials). Wall time: a median of
    **34.2 s** against 6.9 s.
  - It replaced no request: the run has the same 4 requests as the baseline, with different tool calls and results.
- **STEER on `implement-function` was not followed in 0/20,** though it was consumed in all 20 (P4). After the steer the
  agent reasoned for longer before writing the function (1,311 characters, against 109 in the baseline) and its tool calls differ from the
  baseline's, but it never ran `cat src/roman.js`. Lifecycle, tool results and outcome are EXACT against the baseline.
  Output tokens 1,164 against 641.
- **Within-arm determinism.** Every arm is as repeatable as the baseline: modal agreement is 20/20 [83.9, 100] on all
  four layers in every arm, except lifecycle and outcome under `tool-use` STEER (18/20), which are the two trials in the
  transport note below.

### Usage and timing (never judged)

| Task | Arm | Output tokens (median) | Input tokens (median) | Wall time, median (IQR) |
| :--- | :--- | ---: | ---: | :--- |
| tool-use | base | 289 | 7,548 | 6.9 s (6.9 to 6.9) |
| tool-use | steer | 2,851 | 10,161 | 34.2 s (34.2 to 34.2) |
| tool-use | queue | 415 | 11,835 | 10.7 s (10.6 to 10.7) |
| implement-function | base | 641 | 11,182 | 10.9 s (10.9 to 10.9) |
| implement-function | steer | 1,164 | 12,181 | 16.0 s (16.0 to 16.0) |
| implement-function | queue | 761 | 17,217 | 15.7 s (15.7 to 15.8) |

The cache is off in every arm: cache reads are 0.

## A post-hoc finding: the response to a steer differed between two working-directory paths

The pilot (18 trials, reported apart from the analysis, §9a) ran the same conditions with the same code. In it:
- STEER on `tool-use` was followed in **0/3**, where the main run's was followed in 20/20. All 3 pilot trials made
  exactly the baseline's tool calls (the agent never ran `cat notes.txt`); in trial 0's reasoning it noted that the
  original instructions said to run `wc -l notes.txt` as step 3.
- STEER on `implement-function`: 0/3, as in the main run.
- QUEUE: 3/3 on both tasks, as in the main run.

**The pilot's and the main run's requests differ only in the working directory.** The runner puts the scratch root at
a path made from a hash of the spec (Pi's system prompt carries it), so the pilot and the main run, which have
different specs, ran at different paths. Replacing that hash in the first request of a baseline trial of each run makes
them byte-identical (checked).

**A post-hoc replication** (not pre-registered; `analysis/posthoc-pilot-path.json`, `analysis/posthoc-main-path.json`):
- **The pilot spec again,** 18 trials, at the pilot's path, with a new ordering seed: **all 18 trials' requests are
  byte-identical to the original pilot's**, and `tool-use` STEER is followed in 0/3 again.
- **One block of the main spec,** 6 trials, at the main run's path, with a new ordering seed: **all 6 trials' requests
  are byte-identical to the main run's**, and `tool-use` STEER is followed (1/1).

So at a given path the whole trajectory is reproduced exactly, across runs at different times and orders, and the two
paths, which differ only in that hash, gave different behaviour on `tool-use` STEER and the same on the other cells.
**The agent's response to a steer is a reproducible function of the whole prompt, the path included, and on this task
it was not robust to that irrelevant string.** The main run's STEER compliance is a measurement at one path. A third
run, a single pre-design feasibility trial at yet another path (DESIGN §5, not data), also followed the steer.

What this does not show: two paths were tried, and nothing was varied except as the spec's hash varied it, so the
mechanism, and how many paths would follow the steer, are unknown.

**Followed up.** The [path-sensitivity study](../../path-sensitivity/1.0.1/RESULTS.md) varied the path over 30 new
values. A STEER on `tool-use` was followed at 27 of 30 (robustly followed), so this pilot's 0/3 was one of the rare
paths; a STEER on `implement-function` was followed at 6 of 30 (path-dependent at that N), so the main run's 0/20 was the
common case; a QUEUE was followed at all 30. It also found that the `implement-function` baseline itself is not
path-invariant. The numbers in this document are unchanged.

## Validity

### Manipulation checks (§6)

| Run | M1 | M2a | M2b | M3 | M5 | M6 | I1 | I2 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Pilot | PASS (93 requests) | PASS (18 trials) | PASS (93) | PASS (18 trials) | PASS (18 trials) | PASS (0 durations in 93 requests) | PASS (18 trials) | PASS |
| Main | PASS (622 requests) | PASS (120 trials) | PASS (622) | PASS (120 trials) | PASS (120 trials) | PASS (0 durations in 622 requests) | PASS (120 trials: 80 chains, 40 baseline) | PASS |

Every arm is valid in both runs. I2: the capability study (18 s, once per run session) admitted `steering.steer` and
`steering.follow-up` (both admitted-partial) before the first trial.

### Transport

The main run recorded **2** `Connection error.` turns in 622 requests, both in `tool-use` under STEER, at exchange 4
(trials #4 and #11). The proxy recorded that the upstream had closed the connection before the request arrived: a
keep-alive connection that llama.cpp closed as Pi reused it. Pi retried and finished; the success check passed, the
tool calls are identical to the other 18, and P1 to P4 hold. They are the two trials whose lifecycle and outcome
differ (an extra turn): within-arm lifecycle and outcome agreement for that cell is 18/20. The pilot had none.

A pass-through proxy cannot prevent a server closing an idle connection at the moment a client reuses it.

## Pre-registered results (§8)

Columns, per judged layer:
- **Modal:** the trials whose layer equals the most common one, with a 95% Wilson interval.
- **Verdict:** stable if the lower bound is at least 0.70, unstable if the upper bound is below it, otherwise
  inconclusive.
- **Distinct:** the number of distinct trajectories.
- **Pairs:** the pairwise exact-match rate, with a 95% bootstrap interval that resamples trials.

The steer and queue arms are compared with the baseline in the table above, not here. These tables show how repeatable
each arm is within itself.
### tool-use

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| base | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | lifecycle | 18/20 [69.9, 97.2] | inconclusive | 2 | 81.1 [57.9, 100.0] |
| steer | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | outcome | 18/20 [69.9, 97.2] | inconclusive | 2 | 81.1 [58.3, 100.0] |
| queue | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |

### implement-function

| Arm | Layer | Modal [95% Wilson] | Verdict | Distinct | Pairs [95% trial bootstrap] |
| :--- | :--- | :--- | :--- | ---: | :--- |
| base | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| base | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| steer | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | lifecycle | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | tool calls | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | tool results | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |
| queue | outcome | 20/20 [83.9, 100.0] | stable | 1 | 100.0 [100.0, 100.0] |

Calls up to the first divergent input (all 190 pairs per cell): identical in every cell.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (as E2 and E3) |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080, as already running. Not restarted, reconfigured or queried beyond `/health`, `/v1/models` and the completions Pi made. |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, RTX 4090, 31 GiB RAM; Node v26.10.0 |
| Runner | `endo-experiment-runner.3` |
| Digest domain | `fixture-public` (fixture-experiment mode) |
| Pilot | 18 trials (2 tasks × 3 arms × 3), seed 3312024923, 2026-10-04 15:45 to 15:49 UTC, 18 completed |
| Main run | 120 trials (2 tasks × 3 arms × N = 20), seed 3004904282, 15:50 to 16:23 UTC, 120 completed, 0 errored, 0 interrupted |
| Report | `main/bundle.json` (`endo.experiment-report.v1`), digest `68d832f67c50ec2…` |

## Checks after the run (§10)

**Spot-check replay**, chosen by the run's seed (`analysis/spotcheck.json`): `tool-use/queue/#17`,
`implement-function/queue/#14` and `implement-function/steer/#18`. Each is EXACT on lifecycle, tool calls, tool results
and outcome, with 0 misses, and each reports its intervention re-issued at its recorded point (exchange 2, chunk 1) with
the recorded proposal digest, and accepted: two queue trials and one steer trial.

**The steered cassettes** (`analysis/cassette-replays.json`, `cassettes/`): one per task per arm, the first completed
trial of each cell. Each of the **4 steered cassettes was replayed 5 times** (3 immediate, 2 as-recorded) against the
real Pi 1.0.1, and each of the 2 baseline cassettes once. **All 22 replays are EXACT on lifecycle, tool calls, tool
results and outcome, with 0 misses and 0 unserved exchanges.** Each steered replay reports its intervention re-issued
at the recorded point (exchange 2, chunk 1), with the same proposal digest, and accepted.

**Cassettes.** The 6 cassettes passed the secret scan with 0 findings, and are committed under the operator's standing
process: [cassettes/](cassettes/README.md). 2.6 MB in 103 files.

## Limits

- The limits of DESIGN §11.
- **The effect depended on the path.** Two runs at different scratch-root paths, with that path as the only difference
  in the requests, differed in STEER compliance on `tool-use` (0/3 and 20/20), and each was reproduced exactly (the
  post-hoc finding above). The study measures one path. A sensible follow-up varies the path, or another irrelevant
  string, on purpose, as an arm, over more than two values.
- **Two tasks, one message each, one point.** Three behaviours were seen for one message: ignored, deliberated and
  followed with both commands, and followed after the run. Nothing is known about other messages or points.
- **The compliance measure** is one exact tool call. Under STEER on `implement-function` the agent's reasoning and
  arguments changed, and compliance (0/20) does not show that.
- **A keep-alive race** produced 2 transport errors in 622 requests (above).
- **Server session.** As in DESIGN §2; no restart was reported.

## Files

| Path | What it is |
| :--- | :--- |
| `DESIGN.md` | the design, N (§9a) and the deviations (§13, none) |
| `make-spec.ts`, `spec-pilot.json`, `spec.json` | the spec generator and its outputs |
| `analyze.ts` | M5, M6, I1, I2, P1 to P5, the estimate, the spot checks, the replays and the sensitivity scan |
| `pilot/` | the pilot's report, plan, run record and journal |
| `main/` | the main run: `bundle.json`, `summary.md`, `experiment.json`, `plan.json`, `journal.jsonl`, `environment/`, `trials/**/result.json` |
| `analysis/` | the pilot estimate, manipulation checks and P checks (pilot and main), the spot checks, the cassette replays, and the post-hoc path replication |
| `cassettes/` | one cassette per task per arm, with the consent note and the secret-scan result |
| (raw data) | the complete run directories (pilot, main and the two post-hoc runs): every trial's store, evidence and logs, with the operator's documented path exception to the secret scan. **Kept outside the repository** since 2026-10-05 (it was committed here before): see [`research/DATA.md`](../../DATA.md) |
