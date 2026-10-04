# Variance study design: Pi 1.0.1 with qwen3.8-27b on llama.cpp

This file was committed before any data for this study was collected, as the first commit of its PR. It is not edited
after data collection starts. The only exception is §9 ("N, chosen after the pilot"), which this design reserves for
the pilot's outcome. Anything done differently from this design is recorded in §12 ("Deviations"), which starts empty.

## 1. Question

PR D showed that, with model responses held fixed, Pi 1.0.1 reproduced its control flow: 40 of 40 cassette replays
were EXACT on lifecycle, tools and outcome, and a negative control worked. Any divergence between live runs of the same
task is therefore attributable to the model and serving stack, not to Pi.

**Main question.** When the same task is run live repeatedly, how often do Pi 1.0.1 and qwen3.8-27b (Q4_K_M, on this
llama.cpp server) produce the same trajectory, judged layer by layer (lifecycle, tools, outcome)? What does the noise
band look like for each layer?

**Two follow-up questions:**
- How much of the divergence goes away with deterministic-intended sampling (temperature 0 and a fixed seed)?
- How much more goes away when llama.cpp's prompt cache is also disabled for the request?

## 2. Environment, fixed for the study

| Part | Setting |
| :--- | :--- |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, 16 CPUs, 31 GiB RAM, one NVIDIA RTX 4090 (24 GiB) |
| Pi | 1.0.1, identity `f91821fd54dd…`, run with scratch HOME, agent directory and workspace. The operator's configuration is never touched. |
| Server | llama.cpp at `http://127.0.0.1:8080`, model `qwen3.8-27b` (Q4_K_M, context 98304), as already running. Not started, stopped, restarted or reconfigured. No settings, slot or admin endpoint is called. |
| Runner | `endo experiment run` (PR E1 and its follow-up), recording every trial through the byte-exact capture proxy, so every trial is also a cassette |
| Digest domain | `fixture-public`, in explicit fixture-experiment mode. The tasks are synthetic. |
| Thinking level | Pi's default (none is configured). Pi sends no reasoning field. |

**Server defaults.** llama.cpp's documented defaults are `temperature` 0.8, `seed` −1 (random) and `cache_prompt`
true. The values this server actually runs with (it may have been started with flags) cannot be read without a
settings endpoint, so they are UNAVAILABLE.

## 3. Tasks

All three tasks are synthetic and scratch-only, with no personal content. Each runs as one prompt in a fresh scratch
workspace, always at the same path (Pi's system prompt carries the working directory). Each has a deterministic
success check, run after the session in the workspace the agent left.

### T1 `tool-use`

The scenario of the committed cassette fixtures.

- **Workspace:** `notes.txt` = `status: draft\nowner: endophasia fixture\nnote: this file is part of a synthetic test workspace\n`.
- **Prompt:** "Work only in the current working directory. Do these three steps in order, one tool call each: 1. Use
  the read tool to read notes.txt. 2. Use the edit tool to replace the word draft with the word final in notes.txt.
  3. Use the bash tool to run exactly this command: wc -l notes.txt. Then reply with the single word: done".
- **Check:** `grep -q "status: final" notes.txt`.

### T2 `fix-failing-test`

A bug to find and fix.

- **Workspace:** `package.json` (`{"name":"slug-task","private":true,"type":"module"}`), `src/slug.js` (a `slugify`
  that lowercases and maps each other character to `-`, but neither collapses runs nor trims) and `test/slug.test.js`
  (three `node:test` cases: plain words, collapsing runs of punctuation, trimming leading and trailing dashes). Two of
  the three tests fail at the start.
- **Prompt:** "The tests in this directory fail. Run them with: node --test. Then fix the bug in src/slug.js so that
  every test passes. Do not change any file under test/. When all tests pass, reply with the single word: done".
- **Check:** `test/slug.test.js` still has its original sha256, and `node --test` exits 0.

### T3 `implement-function`

A function to write against given tests.

- **Workspace:** `package.json` (`{"name":"roman-task","private":true,"type":"module"}`), `src/roman.js` (a stub
  `toRoman` that throws `not implemented`) and `test/roman.test.js` (`node:test` cases: 1, 4, 9, 14, 40, 90, 400,
  1994 and 3999 map to their Roman numerals; 0 and 4000 throw a RangeError).
- **Prompt:** "Implement the function toRoman in src/roman.js so that the tests pass. Run the tests with: node --test.
  Do not change any file under test/. When all tests pass, reply with the single word: done".
- **Check:** `test/roman.test.js` still has its original sha256, and `node --test` exits 0.

The exact files and check commands are in the experiment spec (`spec.json`, committed with the data). Its sha256 is
recorded in every run's `experiment.json`.

## 4. Arms

The arms are nested. Every arm installs exactly one documented Pi extension (a `before_provider_request` handler, the
documented route; see `research/pi-conformance/1.0.1/sampling-control/`) in the scratch agent directory's
`extensions/`. Pi changes its own requests; the capture proxy stays byte-exact pass-through. Each condition records
its extension's source and sha256.

| Arm | Extension returns | What changes against the previous arm |
| :--- | :--- | :--- |
| **A** | nothing: a no-op handler, so the payload is unchanged | (baseline: Pi's defaults) |
| **B** | `{ ...payload, temperature: 0, seed: 1234 }` | sampling (A→B) |
| **B+C** | `{ ...payload, temperature: 0, seed: 1234, cache_prompt: false }` | prompt cache (B→B+C) |

There is deliberately no cache-off arm under default sampling. `cache_prompt` is a llama.cpp request field: "Re-use KV
cache from a previous request if possible … enabling this option can cause nondeterministic results. Default: true"
(llama.cpp server README).

**Pilot-only control, arm `none`.** No extension at all, used for manipulation check M4. It is not part of the main run.

## 5. Manipulation checks

These are computed from the recorded request bodies and usage, on the pilot and on every main-run trial, and reported
in RESULTS.md. An arm that fails a check is **invalid**: its results are not interpreted, and it is not reinterpreted
as something else.

- **M1, injected fields.** Every request of arm B carries `temperature: 0` and `seed: 1234`. Every request of B+C
  carries those plus `cache_prompt: false`. No request of arm A (or `none`) carries any of `temperature`, `seed`,
  `cache_prompt`, `top_p`, `top_k`, `min_p` or the penalties.
- **M2, nothing else changes.** Let *strip(r)* be a request body without the injected fields. Then:
  - (a) The first request of every trial of a task, after strip, is byte-identical as canonical JSON across all
    trials and all arms of that task. That covers the same system prompt, tools, user message and other parameters.
  - (b) In every request of every arm, the system message (`messages[0]`), `tools`, and the set of top-level fields
    after strip equal those of arm A for that task.

  Later messages differ wherever the model's replies differ; that is the quantity measured, not a manipulation
  failure.
- **M3, cache off.** Every B+C trial reports zero cache reads: Pi's `cacheRead` is 0 for every assistant message, and
  every recorded response's `prompt_tokens_details.cached_tokens` (when present) is 0.
- **M4, the no-op is a no-op (pilot only).** For each task, the first request of every arm-A pilot trial is
  byte-identical (canonical JSON) to the first request of every `none` pilot trial. In every request, `messages[0]`,
  `tools` and the top-level fields match too.

## 6. Metrics and how each is computed

Everything is computed by `endo experiment report` from the run directory. The report is deterministic and carries
its own digest. Within each (task, arm) cell, over the completed trials:

1. **Headline: modal agreement, per judged layer** (lifecycle, tools, outcome). The share of trials whose layer
   (canonical JSON of the trajectory layer, `pi-trajectory.2`) equals the most common one, with a 95% Wilson interval.
   Trials are independent, so this interval is honest.
2. **Distinct trajectories, per judged layer:** how many different layers the trials produced.
3. **Pairwise exact-match rate, per judged layer.** EXACT / (EXACT + DIVERGED) over all unordered pairs, compared with
   `trajectory-comparison.2`; UNAVAILABLE pairs are counted separately.

   **Why the interval needs the trial bootstrap.** The n(n−1)/2 pairs of n trials are not independent: every trial
   takes part in n−1 pairs. A Wilson interval that treats 45 pairs of 10 trials as 45 observations claims far more
   precision than 10 trials hold. The 95% interval is therefore a percentile bootstrap that **resamples trials** with
   replacement: 10 000 resamples, seeded from the spec sha256, the cell and the layer. Two draws of the same trial are
   not a pair. The pairwise rate itself is reported for comparability with PR C and PR D; the headline is (1).
4. **First-divergence distribution:** per layer, the index of the first differing entry over the diverged pairs; per
   pair, which set of layers diverged.
5. **Outcome agreement and success:** the distribution of outcome kinds, and the success-check pass rate with a 95%
   Wilson interval.
6. **Final workspaces:** the number of distinct final workspaces (keyed digest of the archived workspace).
7. **Usage** (Pi-reported tokens: input, output, cacheRead, total) **and timing** (observer wall clock per trial):
   median and IQR (type 7). **Never judged.**

## 7. What counts as stable, inconclusive or unstable

These thresholds are a judgment call, fixed now. The threshold is 0.70 because 10 identical trials out of 10 give a
95% Wilson lower bound of 0.722, so the criterion is reachable at N = 10.

**Per (task, arm, layer)**, using the headline modal agreement and its 95% Wilson interval [L, U]:
- **stable** if L ≥ 0.70;
- **unstable** if U < 0.70 (the most common trajectory is credibly produced by fewer than 70% of trials);
- **inconclusive at this N** otherwise.

**"Pi + this model is stable" under an arm** if lifecycle, tools and outcome are stable on all three tasks. It is
**"unstable"** under that arm if any layer is unstable on any task. Otherwise the arm is inconclusive.

**Arm comparison.** "Arm X is more stable than arm Y on (task, layer)" only if X's L exceeds Y's U (non-overlapping
intervals). Overlapping intervals support no claim about a difference.

**Success-check pass rate is reported, not part of stability.** A trajectory can be stable and wrong, or varied and
correct.

**The noise band** for each judged layer is reported as the modal agreement and pairwise rate with their intervals,
per task under arm A (Pi's defaults). Arms B and B+C show how much of it the sampling and the cache account for.

## 8. Order, independence and run hygiene

- **Order:** blocked randomization (`endo experiment run`). For each trial index, every (task, arm) cell runs once, in
  an order shuffled by a recorded seed (drawn at the first run). Arms are interleaved in every block, so time-of-day,
  thermal or cache-state drift is spread across arms instead of confounded with one.
- **One trial at a time.** All trials share one server and its prompt cache. Arms A and B can hit the cache from
  earlier trials, and the recorded `cacheRead` shows it. B+C cannot.
- **Other clients.** The server may be used by other clients during the run. This cannot be controlled or observed
  and is listed as a limit.
- **Resumability.** An interrupted run resumes. Unfinished trials are moved to `interrupted/` and rerun, and RESULTS.md
  reports their count.

## 9. Pilot, and choosing N

**Pilot.** 3 trials per task for each of A, B, B+C and `none`: 36 trials, in its own run directory, recorded the same
way. The pilot is used to:
- run M1 to M4. If an arm fails, stop and report; no main run follows for that arm;
- measure the mean wall time per trial for each (task, arm), giving the estimate
  *T(N) = N × Σ mean(task, arm) + 10% overhead* for the three main arms.

Pilot trials are not part of the main analysis. Their results are reported separately.

**Choosing N:**
- N is the largest value in {10, 12, 15, 20} with T(N) ≤ 10 hours.
- If T(10) exceeds 10 hours, N is reduced below 10 to fit, and RESULTS.md says so.

The chosen N and its justification are written in the section below **before the main run starts**, in a separate
commit. That section is reserved for this; it is not a change to the design.

### N, chosen after the pilot

Written on 2026-10-04 from the pilot, before the main run started. The pilot ran 36 trials (3 tasks × A, B, B+C,
`none` × 3), with ordering seed 2892665600; all completed.

**Manipulation checks:** all passed. M1 186/186 requests, M2a 36/36 trials, M2b 186/186 requests, M3 9/9 trials, M4
18/18 trials. Every arm is valid.

**Mean wall time per trial** (start to end, including Pi's start-up):

| task | A | B | B+C |
| :--- | ---: | ---: | ---: |
| tool-use | 5.3 s | 4.0 s | 8.4 s |
| fix-failing-test | 6.4 s | 9.9 s | 19.9 s |
| implement-function | 7.5 s | 6.6 s | 15.5 s |

One round of the three main arms takes 83.6 s. With 10% overhead, T(10) = 0.26 h, T(12) = 0.31 h, T(15) = 0.38 h
and T(20) = 0.51 h.

**N = 20**: the largest value in {10, 12, 15, 20} with T(N) ≤ 10 h. With 20 identical trials out of 20, the 95%
Wilson lower bound is 0.839, so §7's threshold of 0.70 is reachable with room to spare. The main run is 180 trials
(3 tasks × 3 arms × 20).

## 10. Checks after the run

- **Spot-check replay.** Choose 3 main-run trials at random. The random choice is seeded by the run's recorded
  ordering seed, using mulberry32 and Fisher-Yates over the completed trials in plan order, taking the first three.
  Replay each from its cassette (`endo replay … --timing immediate --fixture`) and confirm lifecycle, tools and outcome
  are EXACT with zero misses. PR D says they should be. **Any that is not is a finding**, reported as such.
- **Sensitivity check before committing cassettes.** Every request body and every response, blobs decoded, is
  searched for system-prompt content beyond Pi's own, the working directory and paths, dates, OS and host details,
  usernames and hostnames. Cassettes are committed only if they pass, and if their total size is reasonable for the
  repository (a judgment recorded in RESULTS.md). The experiment bundle (`report/bundle.json`), the spec and the run
  metadata are committed in any case.

## 11. Limits, known in advance

- One Pi release (1.0.1), one model and quantization (qwen3.8-27b Q4_K_M), one server build, one machine and GPU.
- One provider API (`openai-completions`).
- Three small synthetic tasks. N per cell is set in §9.
- The server's actual default sampling settings are unknown (§2).
- The server is shared across trials, and possibly with other clients.
- Stability is defined on Endophasia's trajectory layers. Two trajectories can be EXACT on every layer while the
  model's text differs: text is not a judged layer.
- The thresholds in §7 are a judgment, not a standard.

## 12. Deviations

1. **An exploratory analysis was added after the pilot, before the main run.** The pilot showed that on the coding
   tasks, tool output differs between runs: `ls -la` prints modification times and the owner, and `node --test` prints
   durations. That output enters the next request, so trials can diverge for a reason that is neither Pi nor the
   model. RESULTS.md therefore adds an analysis this design did not plan: for each pair of trials whose requests
   diverge, the first differing request message, classified as a tool result (environment) or an assistant message
   (model and serving). It is labelled exploratory. The pre-registered metrics (§6), criteria (§7) and checks (§5) are
   unchanged and reported as designed.
2. **The first main run is invalid, and the main run was repeated.** Main run 1 (seed 363281846) recorded many
   `Connection error.` turns (13 of 20 `implement-function` trials in arm A). They were caused by the recording proxy:
   it delayed relaying llama.cpp's connection close by its own disk writes, and Pi reused the connection in that
   window. Sent straight to llama.cpp, the same task had none in 20 trials. The proxy was fixed (commit 688d9ad18),
   and the fix was checked live: 0 of 20. The main run is repeated with the same spec (N = 20) and a newly drawn seed.
   Main run 1 is not interpreted; its report and the artifact evidence are kept in `main-run-1-invalid/`.

   **The pilot is not repeated:**
   - Its purposes were the manipulation checks M1–M4 and the wall-time estimate.
   - M1–M4 compare the request bodies that reached the server, which the artifact did not alter.
   - The artifact added a few error turns. That cannot move T(20) ≈ 0.5 h anywhere near the 10 h limit, so N = 20
     stands.

   **The manipulation checks could not catch this artifact,** because they check what requests carry, not whether
   they arrived. RESULTS.md therefore also reports the number of `Connection error.` turns per cell for the repeated
   run.
