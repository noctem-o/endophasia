# Path-sensitivity study design: does the working-directory path decide how Pi 1.0.1 with qwen3.8-27b answers a steer?

This file was committed before any data for this study was collected, as the first commit of its PR. It is not edited
after data collection starts. The only exception is §9a ("Pilot, and the number of paths"), which this design reserves
for the pilot's outcome. Anything done differently from this design is recorded in §13 ("Deviations"), which starts
empty.

## 1. Why this study exists

This is a **robustness check on evidence already in the repository**, not a new line of research. The steering study
(`research/steering/1.0.1/`) measured what an operator's STEER and QUEUE change in the fully pinned deterministic
condition. Its main run found:
- QUEUE was followed in 40 of 40 trials;
- STEER was followed in 20 of 20 trials on `tool-use`, and in 0 of 20 on `implement-function`.

Its pilot, whose requests differ from the main run's only in a hash in the working-directory path, followed the steer on
`tool-use` in 0 of 3 trials. A post-hoc replication reproduced each run byte for byte at its own path. So at one path
the whole trajectory is reproducible, and two paths that differ only in that hash gave different behaviour.

**Two paths were all that was tried.** Every finding so far (E2, E3 and the steering study) was measured at one path per
run. Whether the main run's STEER result is a property of the model, a coin flip over paths, or a rare event cannot be
read from two points. This study varies the path over many values and asks what fraction of paths follow the steer.

This is also why it comes before any further steering or cognition-control work: an effect measured at one path is not
interpretable until its robustness to an irrelevant string is known.

## 2. Question

**Main question.** Over many working-directory paths of the same shape, in E3's fully pinned deterministic condition,
what fraction of paths is the steer followed at, for each of the four steered cells (tool-use and implement-function,
STEER and QUEUE)?

**Secondary questions.**
- **Is the baseline path-invariant?** After removing the path itself, does the baseline make the same tool calls at
  every path?
- **Does the path change delivery?** Does Pi still deliver the message where it documents (P3 and P4 of the steering
  study) at every path?
- **Is each path deterministic?** At a fixed path, do repeated trials agree?

## 3. Environment, fixed for the study

| Part | Setting |
| :--- | :--- |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, 16 CPUs, 31 GiB RAM, one NVIDIA RTX 4090 (24 GiB) |
| Node | v26.10.0 |
| Pi | 1.0.1, identity `f91821fd54dd…`, entrypoint `e79626f2dd6f94aa…` (as E2, E3 and the steering study), run with scratch HOME, agent directory and workspace. The operator's configuration is never touched. |
| Server | llama.cpp at `http://127.0.0.1:8080`, model `qwen3.8-27b` (Q4_K_M, context 98304; `/health` ok and `/v1/models` on 2026-10-04), as already running. Not started, stopped, restarted or reconfigured by this study. No settings, slot or admin endpoint is called. |
| Server session | The operator restarted llama.cpp at about 10:39 UTC on 2026-10-04. No later restart has been reported to me, and I cannot observe one. |
| Runner | `endo experiment run` (`endo-experiment-runner.3`, unchanged), one run per path |
| Digest domain | `fixture-public`, in explicit fixture-experiment mode. The tasks are synthetic. |

## 4. What varies, and what does not

**The only factor is the scratch-root path.** The runner puts the scratch root at
`<tmp>/endo-experiment-<12 hex digits>/scratch`, where the 12 hex digits are the start of the sha256 of the spec. Pi's
system prompt carries the working directory (`<tmp>/endo-experiment-<hex>/scratch/work`), and the model sees the path in
its prompt and writes it into some tool calls.

**One run per path, one spec per run.** Every path's spec is the steering study's main spec (E2's two tasks, the B+C
extension, E3's pinned environment, and the three arms base, steer and queue with the same messages at the same point),
with **only its `id` changed**: `endo.experiment.path-sensitivity-1.0.1-<label>`. The `id` and `description` never
reach a prompt; they only change the hash, and so the path. The runner needs no change.

**Why separate runs.** It keeps the path's exact shape, adds no runner surface, and each run is a complete, resumable
steering experiment. The cost is that paths are not interleaved in time. That is accepted, because the post-hoc
replication showed byte-identical requests and outcomes across runs made at different times and in different orders, and
the manipulation check M-path (§6) would show any drift in the requests.

**Trials.** 2 trials per cell per path (2 tasks × 3 arms × 2 = 12 trials per path), enough to check determinism at each
path. The unit of analysis is the path, so more paths matter more than more trials.

**Excluded paths.** The two paths already known, `e5bacd997570` (the steering pilot) and `372c52355fe7` (the steering
main run), are **not in the pre-registered sample**: they are why the study exists, and including them would select the
sample on the outcome. They are reported beside the results, labelled.

**Path labels and order.** The sample is paths `p01` to `pNN`. Their order of execution is shuffled by mulberry32 with a
seed drawn at the start and recorded in `paths.json` (Fisher-Yates). If a spec's hash ever equalled one of the two
excluded paths, its label would be skipped and the next used (not expected).

## 5. Tasks, arms, and the point

As the steering study (`research/steering/1.0.1/DESIGN.md` §3 and §4), unchanged:
- **Tasks:** `tool-use` and `implement-function`, with E2's prompts and success checks.
- **Message:** one per task, asking for one extra tool call with an exact command (`cat notes.txt`, and
  `cat src/roman.js`), in the steering study's words.
- **Arms:** `base` (no intervention), `steer` and `queue`, applied once the first chunk of exchange 2's response has been
  relayed.
- **Condition:** `temperature: 0`, `seed: 1234`, `cache_prompt: false`, and the pinned environment.
- **Capability evidence:** one live capability study per run, before its trials, as in the steering study. It is model
  traffic before each path's trials.

## 6. Manipulation checks

Computed from the recorded request bodies, capture logs and snapshots, on the pilot and on every main run.

**The path normalization (fixed now).** For every cross-path comparison, the replacement
`/tmp/endo-experiment-[0-9a-f]{12}` → `/tmp/endo-experiment-<path>` is applied to the whole request body, tool-call
arguments included, before comparing. Tool-call ids are normalized to their ordinal as in E3 and the steering study.
Nothing else is normalized.

- **M-path, the path is the only factor varied.** For each task, the first request of every trial at every path,
  after the path normalization and after removing the injected sampling fields, is byte-identical (canonical JSON)
  across all paths and arms. This shows that nothing but the path differs between paths.
- **M1 to M3, M5, M6, I1, I2**, per path, as the steering study: injected fields, nothing else changing, cache off, the
  pinned environment, no durations, the intervention chain, and the capability study admitting `steering.steer` and
  `steering.follow-up` before the first trial.

An arm of a path that fails a check is **invalid at that path**, and its result is not counted, but it is reported.

## 7. Pre-registered measures

Per path and cell, the two trials of a cell give a **cell outcome**:
- **followed** if both trials comply, **ignored** if neither does, **mixed** if exactly one does (a violation of
  determinism at that path, reported as such).
- **Compliance** is the steering study's `complied()`, unchanged: after the user message carrying the task's message,
  some assistant `bash` tool call whose command, trimmed, is exactly the task's command.

**Primary result, per steered cell (tool-use STEER, tool-use QUEUE, implement-function STEER, implement-function QUEUE).**
The number of paths at which the cell is **followed**, over the paths with a determinate outcome (followed or ignored),
with a 95% Wilson interval over paths. The **mixed** paths are listed and counted, and a worst-case reading (every mixed
path counted as ignored, and as followed) is reported beside the interval.

**How a cell is read, fixed now.** With [L, U] the Wilson interval over determinate paths:
- **robustly followed** if L ≥ 0.70;
- **robustly ignored** if U ≤ 0.30;
- **path-dependent at this N** otherwise.

These thresholds are a judgment, chosen so that 20 or more paths can reach either verdict.

**Secondary results.**
- **Baseline path-invariance.** For each task, the number of distinct baseline tool-call signatures across paths, where
  a signature is the sequence of tool names with their normalized canonical arguments (§6). The expectation is 1, and
  any other number is reported with the differing signatures.
- **Within-path determinism.** Per path, whether the two trials of each cell are identical (requests, after the
  normalization of tool-call ids only). The number of cells that are not identical.
- **Delivery.** P1 to P4 of the steering study, per path, on the 2 trials per cell: the baseline is internally identical
  (P1), no steered trial differs before the point (P2), the first divergence is request 3 for a steer and one past the
  baseline's last for a queue (P3), and the proxy shows the message consumed in exactly that request (P4). A violation is
  reported as a bug or a manipulation failure, not an effect.
- **Success checks**, reported as a rate with a 95% Wilson interval, not part of any verdict.

**Descriptive only (never judged):** output tokens, wall time, and the response pattern of a followed steer: both
commands in one turn, or the commands in separate turns, or only the asked-for one.

**The two known paths** are reported beside the results from the steering study's data (pilot 0/3 and main 20/20 on
`tool-use` STEER), labelled as not part of the sample.

## 8. What would count as a finding

- **The main run's result is a coin flip over paths** if `tool-use` STEER is path-dependent at this N, with the share of
  paths followed reported. Then the steering study's 20/20 is a measurement at one lucky or unlucky path, and the README
  and RESULTS wording is revised to say so.
- **The main run's result is robust** if `tool-use` STEER is robustly followed, or robustly ignored, at this N. If
  robustly ignored, the main run's 20/20 is the rare path.
- **A cell where the baseline is not path-invariant** is a finding on its own: the path changes what the agent does
  with no intervention.
- Nothing here claims why a path matters. The study measures how many paths follow, not the mechanism.

## 9. Order, run hygiene

- **Order:** the paths run one at a time, in the shuffled order (§4). Within a path, the runner's blocked randomization
  over the 6 cells applies, with a seed drawn per run.
- **One trial at a time**, on one server. The cache is off in every arm.
- **Other clients** cannot be controlled or observed, and are a limit.
- **Resumability.** An interrupted path resumes by the runner's rules. A new session starts a new capability study.
- **A path whose capability study does not admit steering** (so the run stops before any trial) is **rerun once** with
  the same spec. If it stops again, it counts as **missing** and is reported, never replaced by another path.
- **A trial with a transport error** (a `Connection error.` turn) still counts, and is reported per path. This was
  2 of 622 requests in the steering study.

## 9a. Pilot, and the number of paths

**Pilot.** 2 paths that are not in the sample (labels `pilot-1` and `pilot-2`), 12 trials each, run the same way. It is
used to:
- run every check above. If M-path or a manipulation check fails, stop and report;
- measure the mean wall time per path, giving *T(N) = N × (mean wall time per path + 10% overhead)*.

Pilot paths are not part of the analysis.

**Choosing N** (the number of paths in the sample): the largest value in {12, 20, 30} with T(N) ≤ 3 hours. If T(12) is
over 3 hours, the study stops and the operator is asked. The chosen N is written in the section below before the main
run starts, in a separate commit.

### The number of paths, chosen after the pilot

Written on 2026-10-04 from the pilot, before the main run started. The pilot ran 2 paths outside the sample
(`pilot-1`, scratch hash `db865aedb21e`, and `pilot-2`, `0a275d344317`), 12 trials each, from 18:27 to 18:34 UTC. All
24 trials completed; none errored; there were no transport errors.

**Manipulation checks:** all passed.

| Check | Result |
| :--- | :--- |
| M-path | PASS: after the path normalization, the first request is byte-identical across the two paths for each task (1 distinct first request per task) |
| M1 to M3, M5, M6, I1, I2 | PASS at both paths |
| P1 to P4 | held at both paths (0 violations) |

The pilot's measures are in `analysis/pilot-analysis.json` and are not summarised here, because the pilot is not part of
the analysis. One thing it showed, which the pre-registered measures cover: after the path normalization the
`implement-function` baseline's tool-call signature differed between the two paths, so baseline path-invariance (§7)
may not hold on that task.

**Time:** the capability study took 18 s, and one path took 199.6 s and 185.6 s, a mean of 192.6 s. With 10% overhead:

| N paths | T(N) |
| ---: | ---: |
| 12 | 0.71 h |
| 20 | 1.18 h |
| 30 | 1.77 h |

**N = 30**: the largest value in {12, 20, 30} with T(N) ≤ 3 h. The main run is 30 paths × 12 trials = 360 trials.
With 30 paths all followed, the 95% Wilson lower bound is 0.886, so "robustly followed" (L ≥ 0.70) is reachable with
room to spare, and with 30 all ignored the upper bound is 0.114, so is "robustly ignored" (U ≤ 0.30).

## 10. Checks after the run

- **Spot-check replay.** 3 trials chosen at random from all main-run trials (the paths' recorded ordering seed, by
  mulberry32 and Fisher-Yates over the completed trials in path order, then plan order), replayed from their recordings
  (`endo replay … --fixture`). Each must be EXACT on every judged layer with zero misses, and a steered one must report
  its intervention re-issued at its recorded point with the same proposal digest.
- **Data.** The reports, plans, results and the analysis are committed. The raw run directories are large (about
  0.7 MB per trial, so hundreds of MB for the sample): their size is told to the operator before they are committed, and
  they pass the secret scan with the operator's documented path exception or not at all. Their `*.log` event files need
  an explicit un-ignore.

## 11. Limits, known in advance

- One Pi release, one model and quantization, one server build and session, one machine and GPU, one provider API.
- **Only the path hash varies.** Other irrelevant strings (the path's length or shape, a username, a date, the message's
  wording) are not varied. A robust result here would not show robustness to them.
- Two tasks, one message each, one point, in a deterministic condition. Under Pi's default sampling the effect of a
  steer, and of a path, is not measured.
- Paths are not interleaved in time (§4).
- The sample of paths is arbitrary hex strings of one shape, not drawn from any real distribution of paths.
- Compliance is one exact tool call. It says nothing about how the model read the message.
- The thresholds in §7 are a judgment, not a standard.

## 12. Why this and not the deferred research tracks

The README's experimental tracks, including metamorphic robustness, are deferred until the core runtime → replay →
evaluation loop is reliable, and are not to be started early. This study does not start one. It checks how far an
already-published result in that loop generalizes across one irrelevant factor, with the existing runner and analysis.

## 13. Deviations

(None.)
