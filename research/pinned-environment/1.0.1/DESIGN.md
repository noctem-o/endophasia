# Pinned-environment study design: Pi 1.0.1 with qwen3.8-27b on llama.cpp

This file was committed before any data for this study was collected, as the first commit of its PR. It is not edited
after data collection starts. The only exception is §9 ("N, chosen after the pilot"), which this design reserves for
the pilot's outcome. Anything done differently from this design is recorded in §12 ("Deviations"), which starts empty.

## 1. Question

The variance study (`research/variance/1.0.1/`, "E2") split run-to-run divergence into three sources:
- **sampling:** removed by temperature 0 and a fixed seed;
- **prompt cache:** under deterministic sampling, the cache changed tool-call sequences, but only on input that already
  differed;
- **environment:** under deterministic sampling with the cache off, every trial made the same tool calls with the same
  arguments, yet the tools layer was 1/20 on both coding tasks. Every pair's first difference was a tool result
  carrying a timing value: `node --test` durations, or `ls -la` modification times.

E2's verdict was "unstable" under every arm, and by its decomposition the remaining instability under B+C came from
the world the tools observed. This study tests that explanation directly by pinning that world.

**Main question.** With the environment pinned (§4: a fixed time zone and locale, fixed modification times on every
file and directory Pi starts with, and a test reporter that prints no durations), and with deterministic sampling and
the prompt cache off, does Pi 1.0.1 with qwen3.8-27b produce the same trajectory on every layer and every task?

**Two further questions:**
- **Environment, within this study.** Is the pinned arm more stable than the same arm unpinned, run interleaved in the
  same session? E2's comparison was across arms only. This one isolates the environment as the cause.
- **The prompt cache on identical input.** E2 could not say whether the cache alone, on byte-identical input, changes
  a reply: under its arm B, input always differed first. With the environment pinned, input stays identical for
  longer. Does the cache (B against B+C) then change replies to identical requests?

## 2. Environment, fixed for the study

| Part | Setting |
| :--- | :--- |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, 16 CPUs, 31 GiB RAM, one NVIDIA RTX 4090 (24 GiB) |
| Node | v26.10.0 (the `node` on PATH, which the tasks' tests and the success checks use) |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (the same as E2), run with scratch HOME, agent directory and workspace. The operator's configuration is never touched. |
| Server | llama.cpp at `http://127.0.0.1:8080`, model `qwen3.8-27b` (Q4_K_M, context 98304; `/v1/models` on 2026-10-04 10:54 UTC), as already running. Not started, stopped, restarted or reconfigured by this study. No settings, slot or admin endpoint is called. |
| Server session | **The operator restarted llama.cpp at about 10:39 UTC on 2026-10-04**, after E2 and before any data for this study. Every trial of this study, pilot included, runs in that one server session. E2 ran in an earlier one. |
| Runner | `endo experiment run`, with the condition environment added for this study (§4, "Runner capability"). Every trial is recorded through the byte-exact capture proxy, so every trial is also a cassette. |
| Digest domain | `fixture-public`, in explicit fixture-experiment mode. The tasks are synthetic. |
| Thinking level | Pi's default (none is configured). Pi sends no reasoning field. |

**Server defaults.** As in E2, llama.cpp's documented defaults are `temperature` 0.8, `seed` −1 and `cache_prompt`
true. The values this server actually runs with cannot be read without a settings endpoint, so they are UNAVAILABLE.
The restart is the operator's own, with the same address and model. Whether its flags are unchanged cannot be
observed.

## 3. Tasks

**The three tasks of E2, unchanged:** `tool-use`, `fix-failing-test` and `implement-function`, with the same
workspaces, prompts and success checks, byte for byte (E2 DESIGN §3). The spec generator imports E2's task definitions
rather than copying them, so they cannot drift.

Keeping the tasks fixed is deliberate: only the environment changes. Nothing in a prompt asks for a different test
command, so the model's choice of commands is not part of the manipulation.

## 4. Arms

Three pinned arms, nested as in E2, and one unpinned control:

| Arm | Sampling extension (E2 §4) | Environment |
| :--- | :--- | :--- |
| **A-p** | A: no-op | pinned |
| **B-p** | B: `temperature: 0, seed: 1234` | pinned |
| **B+C-p** | B+C: also `cache_prompt: false` | pinned |
| **B+C-u** | B+C | **unpinned**: exactly E2's environment |

The extension sources are E2's, byte for byte. Each condition records its extension's source and sha256.

**The pinned environment** is a condition's environment, applied by the runner:
- **Time zone and locale.** Pi's environment, which every tool inherits, gains `TZ=UTC` and `LC_ALL=C`.
- **A test reporter without durations.** Pi's environment gains `NODE_OPTIONS=--test-reporter=<root>/env/test-reporter.mjs`.
  - That file is written into the scratch root's `env/` directory, outside the workspace. Its source is in the spec,
    and its sha256 is recorded.
  - It prints what Node's default reporter prints (one line per test, ✔ or ✖, the counts, and for each failing test
    its location and assertion message), but never a duration.
  - A plain `node --test`, and a test file run directly with `node`, both use it. That was checked before this design
    was written.
  - Every built-in reporter (`spec`, `dot`, `tap`, `junit`) prints durations, so a built-in one cannot do this.
- **Fixed file times.** Every entry under the scratch root, and the root itself, gets the modification and access time
  **2026-01-01T00:00:00Z**. The entries include the workspace, `home/`, `agent/` and `env/`. The time is applied after
  the scratch root is set up, and before the snapshot and Pi's start.
  - That date is more than six months before the run, so `ls -la` prints it as `Jan  1  2026`, with no clock time.
  - The workspace's `..` (the scratch root) is pinned too.

**What is deliberately not pinned:**
- the clock itself (no time is faked);
- the times of files that Pi or a tool creates or modifies during the session;
- process ids;
- anything outside the scratch root.

§6 measures what of that still reaches the model.

**The unpinned control B+C-u** runs E2's B+C condition exactly as E2 did: no added variables, no `env/` directory, and
fresh file times. It is interleaved with the pinned arms (§8). The environment contrast B+C-u against B+C-p is
therefore within one server session and one randomized run.

There is no unpinned A or B arm. E2 measured them, and this study's questions do not need them again.

### Runner capability (added after this commit, before the pilot)

An experiment condition gains an optional `environment` with these fields:
- `variables`: added to Pi's environment. Only `TZ`, `LC_ALL`, `LANG` and `NODE_OPTIONS` are allowed. `{root}` in a
  value stands for the scratch root.
- `files`: written under `<root>/env/`.
- `fileTime`: an ISO-8601 UTC time.

The cassette recording records the environment (the variables, the file time, and the files' digests) in the capture
log. `endo replay` reapplies the recorded variables. The files and times come back with the snapshot, because a v1
workspace archive restores times. A recording without that event replays exactly as before.

The success check is not part of the manipulation. It runs in the runner's own environment, as in E2, and only its exit
code is judged.

## 5. Manipulation checks

These are computed from the recorded request bodies, usage, capture log and snapshots, on the pilot and on every
main-run trial, and reported in RESULTS.md. An arm that fails a check is **invalid**: its results are not
interpreted, and it is not reinterpreted as something else.

- **M1, injected fields.** As E2. Every request of B-p carries `temperature: 0` and `seed: 1234`. Every request of
  B+C-p and B+C-u carries those plus `cache_prompt: false`. No request of A-p carries any of `temperature`, `seed`,
  `cache_prompt`, `top_p`, `top_k`, `min_p` or the penalties.
- **M2, nothing else in the request changes.** As E2, with A-p as the baseline. (a) The first request of every trial
  of a task, after removing the injected fields, is byte-identical as canonical JSON across all trials and all four
  arms. (b) In every request, the system message, `tools` and the set of top-level fields equal A-p's for that task.
- **M3, cache off.** Every B+C-p and B+C-u trial reports zero cache reads, by Pi's `cacheRead` and by the server's
  `cached_tokens`.
- **M5, the environment is what the arm says.** For every trial, from its capture log and its scratch snapshot:
  - In a pinned arm, the recorded variables equal the spec's (with `{root}` resolved), and the recorded reporter's
    sha256 equals the spec's.
  - In a pinned arm, every entry of the snapshot, and its root, carries exactly the fixed time.
  - In B+C-u, no environment is recorded and the snapshot has no `env/`.
- **M6, the reporter is in effect.** No tool result in any request of a pinned arm contains a duration from Node's
  test reporters. That means `duration_ms`, or `(<number>ms)` at the end of a line that begins with ✔ or ✖.

  M6 is checked on the model's own tool calls, so a model that ran tests some other way could fail it. Failing it
  marks the arm **"manipulation incomplete"**: the count and the instances are reported, and that arm does not count
  towards the environment question (§7). Its other results are still reported.

E2's M4 (a no-op extension equals no extension) is not repeated. It passed in E2 with the same extension source and
the same Pi.

## 6. Metrics and how each is computed

All of E2's metrics (E2 §6), computed by `endo experiment report` (`endo.experiment-report.v1`). Within each
(task, arm) cell, over the completed trials:

1. **Headline: modal agreement, per judged layer,** with a 95% Wilson interval. The judged layers are now lifecycle,
   tool calls, tool results and outcome (`pi-trajectory.3`). They replace E2's single tools layer, as decided for
   `endo.trajectory.v1`.
2. **Distinct trajectories,** per judged layer.
3. **Pairwise exact-match rate,** per judged layer, with the trial-bootstrap interval (10 000 resamples, seeded from
   the spec sha256, the cell and the layer).
4. **First-divergence distribution,** per layer, and per pair which layers diverged.
5. **Tool calls up to the first divergent input,** per cell: over diverged pairs, whether the calls were identical up
   to the first divergent tool result (`trajectory-comparison.3`).
6. **Outcome agreement and success:** the outcome kinds, and the success-check pass rate with a 95% Wilson interval.
7. **Final workspaces:** the number of distinct final workspaces.
8. **Usage and timing:** median and IQR. **Never judged.**

**Pre-registered here (exploratory in E2): where the requests first differ.**

- **9. First difference per pair.** For each pair of trials in a cell, walk their recorded requests in order, and find
  the first request whose canonical body differs, and in it the first differing message. Classify the pair as:
  - **model:** the first differing message is an assistant message. The two requests before it were identical, so the
    model answered identical input differently.
  - **environment:** the first differing message is a tool result.
  - **identical:** every request is identical.
  - **other:** anything else, reported as it is.
- **10. Residual environment, by source.** For each environment pair, the differing tool-result text is classified by
  the first rule that matches:
  - **duration:** a number followed by `ms` or `s`, or `duration_ms`;
  - **clock time:** a time of day `HH:MM` or a date;
  - **other:** anything else, with an excerpt.

  The rule is implemented in the study's `analyze.ts` and tested on E2's recorded examples before the pilot.

## 7. What counts as stable, inconclusive or unstable

E2's criteria (E2 §7), unchanged:
- The threshold is 0.70.
- **Per (task, arm, layer)**, from the modal agreement's 95% Wilson interval [L, U]:
  - **stable** if L ≥ 0.70;
  - **unstable** if U < 0.70;
  - **inconclusive at this N** otherwise.
- **Per arm.** "Pi + this model is stable" under an arm if every judged layer is stable on all three tasks;
  "unstable" if any layer is unstable on any task; otherwise inconclusive.
- **Arm comparisons** need non-overlapping intervals: arm X is more stable than arm Y only if X's L > Y's U.

**The three questions are answered as follows, fixed now.**

1. **Main question.** The verdict for arm B+C-p.
   - If it is "stable", this study reports: with the environment pinned, deterministic sampling and the cache off,
     Pi 1.0.1 with this model reproduced every judged layer on all three tasks.
   - If it is not, the residual sources (§6.10) say what remained.
2. **Environment, within this study.** On each coding task's tool-results layer, B+C-p against B+C-u by the
   non-overlap rule:
   - **"the pinned environment is more stable"** if B+C-p's L > B+C-u's U;
   - **"no difference shown"** otherwise.

   This requires M5 and M6 to pass for B+C-p. The tool-use task printed no timings in E2, so no difference is
   expected there. It is reported, not tested.
3. **The prompt cache on identical input.** From §6.9, the number of **model** pairs in B-p and in B+C-p, per task.
   - **Evidence that the cache changes replies to identical input:** B-p has at least one model pair and B+C-p has
     none.
   - **No evidence at this N:** both have none.
   - If B+C-p has a model pair, deterministic sampling with the cache off did not hold the model's reply fixed on
     identical input. That is reported as a finding, and the question is not answered.

   The tool-calls layer is reported per arm alongside, with the non-overlap rule applied.

**A-p** shows sampling under the pinned environment. It is reported with the same criteria and is not part of the
three answers. It is expected to be unstable, as A was in E2.

**Success-check pass rate is reported, not part of stability.**

## 8. Order, independence and run hygiene

As E2 §8:
- **Order:** blocked randomization over the 12 (task, arm) cells. Every block runs each cell once, in an order
  shuffled by a recorded seed drawn at the first run. Pinned and unpinned arms are interleaved in every block.
- **One trial at a time.** All trials share one server and its prompt cache. A-p and B-p can hit the cache from earlier
  trials, including trials of other arms. B+C-p and B+C-u cannot.
- **Other clients.** The server may be used by other clients. This cannot be controlled or observed, and is listed as a
  limit.
- **Resumability.** An interrupted run resumes. Unfinished trials are moved to `interrupted/` and rerun.
- **Same path.** The scratch root sits at the same absolute path for every trial of a run. Pi's system prompt carries
  the working directory.
- **Transport.** As in E2's repeated run, the number of `Connection error.` turns, requests without a recorded end, and
  incomplete exchanges is reported per cell.

## 9. Pilot, and choosing N

**Pilot.** 3 trials per cell: 36 trials, in its own run directory, recorded the same way. The pilot is used to:
- run M1, M2, M3, M5 and M6. If an arm fails, stop and report; no main run follows for that arm;
- measure the mean wall time per trial for each cell, giving *T(N) = N × Σ mean(cell) + 10% overhead* over the 12
  cells.

Pilot trials are not part of the main analysis. Their results are reported separately.

**Choosing N:**
- N is the largest value in {10, 12, 15, 20} with T(N) ≤ 10 hours.
- If T(10) exceeds 10 hours, N is reduced below 10 to fit, and RESULTS.md says so.

The chosen N and its justification are written in the section below **before the main run starts**, in a separate
commit. That section is reserved for this; it is not a change to the design.

### N, chosen after the pilot

(Reserved.)

## 10. Checks after the run

- **Spot-check replay.** Choose 3 main-run trials at random, as in E2 §10: seeded by the run's ordering seed, using
  mulberry32 and Fisher-Yates over the completed trials in plan order, taking the first three. Also replay every
  committed B+C-p cassette (below). Each replay uses `endo replay … --timing immediate --fixture`.
  - **Expected:** EXACT on every judged layer with zero misses. A replay restores the pinned file times and reapplies
    the pinned variables.
  - **Exception:** a replay of a pinned trial may still miss where a tool printed the time of a file that the session
    itself wrote (§4, not pinned). Any miss is classified (environment or control flow) and reported, never hidden.
- **Cassettes.** The operator's standing process (from E2):
  - commit a representative subset: one trial per task per arm, 12 cassettes;
  - only after the secret scan (`cli/secret-scan.ts`) passes as a hard gate;
  - the operator's consent to their username, hostname, kernel string and dates appearing is noted in the cassette
    README;
  - the operator is told the size before the commit.

  The experiment bundle, the specs and the run metadata are committed in any case.

## 11. Limits, known in advance

- One Pi release, one model and quantization, one server build and session, one machine and GPU, one provider API.
- The same three small synthetic tasks as E2. N per cell is set in §9.
- The server's actual sampling defaults are unknown (§2). The server was restarted before this study, so comparisons
  with E2's numbers are across server sessions. The within-study B+C-u arm exists for that reason.
- **The pinned set is exactly what E2 found and the operator decided:** time zone, locale, file times at the start, and
  test durations. Anything else that varies (the time of a file written during the session, process ids, the clock)
  is measured (§6.10), not pinned.
- **The pinning adds an environment variable that Pi's own process also sees** (`NODE_OPTIONS`). `--test-reporter`
  affects only Node's test runner. Pi 1.0.1 was checked to start and report its version with it set.
- The model is not told about the pinning. If it ran tests in a way that bypasses `NODE_OPTIONS`, M6 reports it.
- Stability is defined on Endophasia's trajectory layers. The model's text is not a judged layer.
- The thresholds in §7 are a judgment, not a standard.

## 12. Deviations

(None.)
