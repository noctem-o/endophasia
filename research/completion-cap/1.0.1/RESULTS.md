# Completion-cap study results: how much of the discriminating tasks' failure is the completion cap, and what do cheap compute arms buy?

Design: [DESIGN.md](DESIGN.md), committed before any data. §9a records the pilot and N; §13 records two deviations, both decided from the
pilot and before any main-run trial. Everything here is from the main run (4 paths, 192 trials: 4 arms × 4 tasks × 3 trials per path) unless marked
"pilot". No runner errors, no session timeouts and no server errors occurred in the main run.

## The answer

**On `fetch-cache` and `markup-lite`, the cap is binding.** Raising Pi's completion cap from 16,384 to 32,768 tokens (arm B against the control A)
raised the pooled success rate from **10 of 24 (42%) to 19 of 23 (83%)**: a difference of **+0.41**, with a cluster interval over the four paths of
**[+0.09, +0.73]** and a gain at every path (+0.63, +0.50, +0.33, +0.17). By the thresholds fixed in DESIGN §9 (the interval above 0 and the
difference at least +0.25) the pre-registered reading is **"the cap is binding"**.

| Arm | What it does | Pooled over the two primary tasks | 95% Wilson |
| :--- | :--- | ---: | :--- |
| **A** control | Pi's default cap (16,384) | 10/24 = 0.42 | [24.5, 61.2] |
| **B** | cap 32,768 | **19/23 = 0.83** | [62.9, 93.0] |
| **D** | one sentence asking for short reasoning, cap 16,384 | 15/24 = 0.63 | |
| **E** | thinking off per request, cap 16,384 | 10/22 = 0.45 | |

The prediction made in DESIGN §2 was that removing truncation would saturate **both** tasks. **It was half right.**

| Task | A | B | D | E |
| :--- | ---: | ---: | ---: | ---: |
| `fetch-cache` (primary) | 5/12 [19.3, 68.0] | **11/11** [74.1, 100] | 11/12 [64.6, 98.5] | 6/10 [31.3, 83.2] |
| `markup-lite` (primary) | 5/12 [19.3, 68.0] | 8/12 [39.1, 86.2] | 4/12 [13.8, 60.9] | 4/12 [13.8, 60.9] |
| `config-extends` (heavy control) | 10/12 [55.2, 95.3] | 12/12 [75.8, 100] | 12/12 [75.8, 100] | 6/10 [31.3, 83.2] |
| `booking-conflicts` (light control) | 12/12 | 12/12 | 12/12 | 11/12 |

- **`fetch-cache` measures the cap.** With the cap raised it is 11 of 11 (a trial was excluded, below), and A's seven failures were all cut-off
  responses. By the DESIGN's band it is saturated once the cap is not binding.
- **`markup-lite` also measures the code.** At the raised cap it is 8 of 12 [39.1, 86.2], with **no cut-off response and four wrong answers**: it is still in the
  discriminating band when truncation is removed. That is the more useful task for judging candidates.
- **The heavy control is hurt by the cap too:** `config-extends` failed twice under A, both times a cut-off (10/12), and was 12/12 under B and D.

## Secondary results

Reported, none a headline (DESIGN §9). The pre-registered reading applies to B against A only; the other contrasts have an interval and no reading.

| Contrast (pooled over the two primary tasks) | Difference | Cluster interval (4 paths, t) | Per path |
| :--- | ---: | :--- | :--- |
| **B − A** (primary) | **+0.41** | **[+0.09, +0.73]** | +0.63, +0.50, +0.33, +0.17 |
| D − A | +0.21 | [−0.13, +0.54] | +0.17, +0.50, +0.17, 0 |
| E − A | +0.04 | [−0.46, +0.47] | −0.17, +0.33, −0.30, +0.17 |

- **D (brief reasoning)** is a large gain on `fetch-cache` (11/12 against 5/12) and a loss on `markup-lite` (4/12 against 5/12, with 7 of its 12 trials cut off
  against A's 7: the instruction did not stop the long reasoning there). Its pooled interval includes 0.
- **E (thinking off)** removes all reasoning output (the reasoning share of the streamed characters is 0, against 94 to 99% elsewhere) and cuts the median output tokens
  of a trial by about 20 to 70% (to 5,268 on `markup-lite` from 16,464, though A's trials there were cut off at 16k),
  but **accuracy is worse where the task needs the reasoning**: `config-extends` 6/10 (A: 10/12) and `markup-lite` 4/12 are wrong results, not
  cut-offs. **The harm check flags `config-extends` under E** (a rate 0.23 below A's; counting the two excluded E trials it is still 0.25).
- **Arm C (49,152) was dropped** by the §8 rule (§13): whether it adds anything over 32,768 is not answered here. Under B the largest peak prompt was 38k tokens.

## What a trial costs (item 13), per success

Median output tokens, wall time and peak prompt tokens of a trial are in `analysis/main.json`. The cost of an arm per success (the arm's total over its successes):

| Task | A | B | D | E |
| :--- | :--- | :--- | :--- | :--- |
| `fetch-cache` | 52,093 tokens, 687 s | 32,995 tokens, 425 s | **25,631 tokens, 319 s** | 33,333 tokens, 333 s |
| `markup-lite` | 45,737 tokens, 571 s | 39,296 tokens, 495 s | 61,007 tokens, 770 s | **22,426 tokens, 233 s** |
| `config-extends` | 25,582 tokens, 331 s | **23,051 tokens, 294 s** | **17,954 tokens, 221 s** | 32,520 tokens, 338 s |
| `booking-conflicts` | 9,462 tokens, 88 s | 8,199 tokens, 78 s | 7,384 tokens, 66 s | **3,819 tokens, 31 s** |

- **A larger cap is cheaper per success, not dearer, where the cap binds:** a trial that is cut off spends 16k tokens for nothing. A needs about 50k tokens and 12
  minutes per success on `fetch-cache`; B needs 33k and 7 minutes.
- **No arm is cheapest everywhere.** D wins on `fetch-cache` and `config-extends`, E on `markup-lite` and `booking-conflicts` (but not on the tasks where it is
  inaccurate), and the cut-off arms are the most expensive. A static policy is a compromise; that is what an adaptive allocator (roadmap item 13) would be tested
  against.
- **Tokens are not wall time:** E's trials were about 3 to 4 times faster than A's per trial on `booking-conflicts` (24 s against 82 s) and `markup-lite` (56 s against 219 s). Peak prompt tokens (the attention-pressure proxy) rose under B
  because the agent worked longer: cell medians up to 38k tokens, the largest single trial 49,547, inside the 98k context.

## Validity

| Check | Result |
| :--- | :--- |
| M-inj (the cap and E's template field reached every request) | PASS, all arms, all four paths |
| M-sys, M-tools, M1 (no sampling field), M5, M-ws | PASS |
| M-trunc (B has fewer cut-off responses than A) | PASS: 0 under B and E, 0.7 to 2.0% of D's responses, 2.1 to 6.1% of A's (per path) |
| M-time / M-ctx | 0 sessions did not finish, 0 server errors, in every arm. (The pilot had one hung agent test.) |
| M6 (no reporter duration in a tool result) | **Incomplete in two paths, in arm E only:** the E agent twice ran tests under a reporter of its own; both trials are also among the five excluded below |

**Excluded as invalid by the leakage rule (§7): five trials, four of them in arm E.** What each did, read from its recorded tool calls:

| Trial | What it did outside its workspace | Hidden check read? |
| :--- | :--- | :--- |
| B, `fetch-cache`, path c3 | searched the filesystem for `fc.test.*` and found **a copy of the hidden check in the operator-side Claude Code scratchpad under `/tmp`, left there by me** (a file I had made while validating the task); it learned the repository path from it, then **read the task's reference solution and its hidden check in the repository and ran the hidden check against its own solution** | **yes** (marker in a tool result) |
| E, `fetch-cache`, path c3 | `find / -name client.test.js`, then compared its visible test with the repository's copy of the workspace | no (only the visible test's copy) |
| E, `config-extends`, path c1 | named its own run directory (`/tmp/endo-experiment-<hash>`, the directory above its scratch root) | no |
| E, `fetch-cache`, path c2 | the same | no |
| E, `config-extends`, path c4 | the same, as a relative path | no |

So **one trial had the hidden check and the reference in hand (my leftover file, which I have since deleted), one searched the whole filesystem and found a copy of the visible test,
and three only named their own run directory (the leakage rule flags that by design; no content outside their workspace was read).** None read Pi's configuration or sessions, and
the repository has no change beyond the long-standing untracked `.agents/` and `.commandcode/`. Four of the five passed their check and one (E, `config-extends`, c4) failed.

**Sensitivity to the exclusions, recomputed (not just the difference):** counting all five, B − A is **+0.42** with a cluster interval **[+0.07, +0.76]**: the reading is unchanged.
E on `config-extends` is 7/12 against A's 10/12, still flagged.

**Sensitivity to the paths (leave one path out, all five counted).** The cluster interval has 3 degrees of freedom with four paths and 2 with three, so it widens:
leaving out c1 gives +0.39 [−0.24, +1.02], c2 +0.44 [−0.19, +1.08], c3 +0.33 [−0.08, +0.75], c4 +0.50 [+0.09, +0.91]. **The difference is positive and at least +0.33 every time, but with only three
paths the interval includes 0 in three of the four cases:** the pre-registered reading ("the cap is binding") rests on all four paths, and the study cannot say more than that.

**Cross-trial contamination through the shared `/tmp`.** Agents left scripts in `/tmp`, which every trial shares and which was not cleared between trials, so a later trial could in principle read an earlier
one's leftover. Path-based searches were too noisy to settle it (agents often `cd /tmp` and use relative names), so I checked **content provenance**: for each of the 232 trials I looked for tool
results that showed a line (60 characters or more) authored by one or two other trials and not by the trial itself or its task files. **Three trials showed any such line, and all three are explained** (the
B trial that read the hidden check; a trial that saw its own path-run's scratch path; and one coincidental import line). **No trial's results contained another trial's leftover
content.** The check detects idiosyncratic lines, not short common ones. One E trial (c2, `fetch-cache`) also **ran `rm -f` with broad globs on `/tmp`** (`/tmp/h*.mjs`, `/tmp/r*.mjs`, `/tmp/dbg*.mjs` and others), which could have removed files that
were not its own; I cannot tell which, if any, were.

**Prompt sizes (corrected).** The largest peak prompt of a trial was **49,547 tokens in arm B** (B's cell medians are 26k to 38k), 44,024 in A and 45,961 in D, and **84,190 in arm E** (an exploratory trial of
`config-extends`; two other E trials were over 65k). 84,190 plus E's cap of 16,384 is above the 98,304 context, and no server error was recorded. Arm C (49,152) would not have fitted the E-style long trials; it was dropped for time, not for this.

## What this means for the project

- **For the roadmap's item 11 (evolution on real bundles).** Judge candidates at a cap that is not binding (32,768 or higher, with the context checked), or the
  headroom on `fetch-cache` is the cap. **`markup-lite` is the one discriminating task that is left** (8/12 at the raised cap), and it was the discriminating-task study's
  designated holdout: **this study read it** (DESIGN §10). A promotion holdout needs new tasks that no cap or reasoning analysis has touched, and writing them is the next job.
- **For item 13 (Compute Appetite).** The simple arms already show the shape the roadmap expects: a budget that is too small wastes the whole trial, a short-reasoning
  instruction is cheaper where a task is easy and harmful where it is not, and no fixed arm is best on every task. The next falsifiable arm is a **retry after a cut-off**
  (a documented `agent_before_settle` continuation), which targets the one failure that a bigger cap only moves.
- **For the evidence trail.** The control arm A replicates the discriminating-task study (10/24 here, 20/40 there, on the same two tasks), under a longer timeout.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (as before) |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080, as already running. Not restarted, reconfigured or queried beyond `/health`, `/v1/models` and the completions Pi made. |
| Runner | `endo-experiment-runner.3`; every arm a documented `before_provider_request` extension; session timeout 3,600,000 ms for every arm; E3's pinned environment |
| Pilot | 5 arms × 4 tasks × 2 trials = 40, one path, 2026-10-05 from 07:03 UTC |
| Main | arms A, B, D, E; 4 tasks; 3 trials per cell per path; 4 paths; 192 trials, 192 completed; path order `c3 c1 c2 c4` (seed 1146841054); from 2026-10-05 about 10:30 UTC |
| Digest domain | `fixture-public` (fixture-experiment mode) |

## Limits

- The limits of DESIGN §11, and the deviations of §13: **arm C was dropped**, so 49,152 against 32,768 is not answered, and **N = 3 per cell per path** (12 trials per cell) gives wide intervals
  (the primary interval is [+0.09, +0.73]).
- **Four tasks, one model, one server session.** The two controls make the harm check weak, and the per-task Wilson intervals are wide.
- The arms are crude (a cap, one sentence, one template field). Nothing here says anything about learned or adaptive allocation.
- **A is not exactly the discriminating-task study's condition** (a one-hour timeout and concurrency), and the two studies' rates are compared as a consistency check only.
- **There is no sandbox, and this study showed what that costs.** Agents roam the host: one read the hidden check and the reference in the repository (found through a leftover file of mine in `/tmp`), one searched the
  whole filesystem, and one deleted files in `/tmp` by glob. The leakage rule detects what the agent typed; it prevents nothing. The repository itself is an easier target now: it holds committed raw data with past
  solutions, and `spec-pilot.json` embeds every hidden check in its argv. **A future study should run trials with the checkout unreachable** (a separate user or namespace, with the hidden checks outside any path the agent can read),
  and `/tmp` private to each trial.
- **Five invalid trials** (four in arm E) and **one confirmed read of a hidden check** (arm B, excluded; the cause was my own leftover file).
- The pooled reading is over `fetch-cache` and `markup-lite`, one of which is saturated at the raised cap: the primary difference is the sum of one task that moves a lot and one that moves a little.

## Files

| Path | What it is |
| :--- | :--- |
| `DESIGN.md` | the design, the pilot and N (§9a) and the deviations (§13) |
| `make-spec.ts`, `run.ts`, `analyze.ts`, `stats.ts`, `wire.ts` | the arms and specs, the driver, the analysis, the pure decisions and the response reader; tested by `tests/completion-cap.test.ts` |
| `spec-pilot.json` | the pilot's spec |
| `analysis/` | `pilot.json` and `main.json` |
