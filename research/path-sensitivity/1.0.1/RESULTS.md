# Path-sensitivity study results: does the working-directory path decide how Pi 1.0.1 with qwen3.8-27b answers a steer?

Design: [DESIGN.md](DESIGN.md), committed before any data. §9a records N, chosen from the pilot before the main run.
§13 records no deviation, and one post-hoc addition (the baseline description below). Everything here is from the main run (30 paths, 360 trials) unless marked "pilot".

## The answer

**Over 30 paths that differ only in a hash in the working-directory path, a QUEUE was followed at every path, a STEER on
`tool-use` at 27 of 30, and a STEER on `implement-function` at 6 of 30.** Read by the thresholds fixed in DESIGN §7:

| Cell | Followed | Ignored | Mixed | Followed over determinate paths [95% Wilson] | Reading (§7) |
| :--- | ---: | ---: | ---: | :--- | :--- |
| tool-use steer | 27 | 3 | 0 | 27/30 [74.4, 96.5] | **robustly followed** |
| tool-use queue | 30 | 0 | 0 | 30/30 [88.6, 100.0] | **robustly followed** |
| implement-function steer | 6 | 24 | 0 | 6/30 [9.5, 37.3] | **path-dependent at this N** |
| implement-function queue | 30 | 0 | 0 | 30/30 [88.6, 100.0] | **robustly followed** |

"Followed" means, at a path, that both trials ran the asked-for command (the steering study's `complied()`, unchanged),
"ignored" that neither did. No path was **mixed**: every cell was deterministic at its path.

**What this says about the steering study:**
- **QUEUE is robust.** The steering study's 40/40 holds across paths.
- **STEER on `tool-use` is robustly followed.** The steering pilot's 0/3 was one of the rare paths: 3 of the 30 new paths
  ignored the steer (`p03`, `p10`, `p25`). The main run's 20/20 was at a path of the majority kind. The pre-registered
  worry (DESIGN §8), that its result was a coin flip over paths, is not what the data shows.
- **STEER on `implement-function` is not robustly anything at this N.** It was followed at 6 paths (`p02`, `p05`, `p07`,
  `p12`, `p24`, `p29`), so about one in five, with an interval from 9.5% to 37.3%. The main run's 0/20 was at a path of
  the majority kind, and a steer on this task is not always ignored.
- **The two known paths**, reported beside the sample and not part of it (DESIGN §4), from the steering study's data:

  | Path | Source | tool-use steer | tool-use queue | implement-function steer | implement-function queue |
  | :--- | :--- | :--- | :--- | :--- | :--- |
  | `e5bacd997570` | the steering pilot | 0/3 | 3/3 | 0/3 | 3/3 |
  | `372c52355fe7` | the steering main run | 20/20 | 20/20 | 0/20 | 20/20 |

  Each is consistent with the sample: the pilot's path is one of the three `tool-use` STEER paths that ignore it.

Nothing here says **why** a path matters. The study counts how many paths follow; it does not test a mechanism.

## Secondary results (§7)

**The baseline is not path-invariant on `implement-function`.** After the path normalization, `tool-use` has **1**
distinct baseline tool-call signature across the 30 paths, and `implement-function` has **20**.
- On `implement-function` the agent's tool-call sequence has 3 distinct tool-name orders across paths (5 or 6 calls):
  `bash, read, read, write, bash`; the same with a third `read`; and `read, bash, read, write, bash`. It also has 9
  distinct first tool calls, and the file it writes differs.
- The path changes what the agent does **with no intervention at all**, on this task. The success check passed in every
  trial regardless.
- The steered cells vary alike: 22 distinct signatures for `implement-function` STEER and 20 for QUEUE; `tool-use` has 2
  for STEER (followed or ignored) and 1 for QUEUE.

**Within-path determinism: held.** At every path, the two trials of every cell make identical requests (0 of 180 cells
differ). With the manipulation checks below, that is what lets the path be the unit of analysis.

**Delivery: held at every path.** P1 to P4 of the steering study had 0 violations over all 360 trials: the baseline is
internally identical, no steered trial differs before the point, the first divergence is request 3 for a steer and one past
the baseline's last for a queue, and the proxy shows the message consumed in exactly that request. The path never changed
where Pi delivers a message, only what the agent did with it.

**Success checks: 360 of 360.** No arm, path or pattern affected whether the task was done.

### How a followed steer looked (descriptive only)

Over the 60 trials of each cell:

| Cell | Both commands in one turn | Commands in separate turns | Only the asked-for command | Ignored |
| :--- | ---: | ---: | ---: | ---: |
| tool-use steer | 8 | 46 | 0 | 6 |
| tool-use queue | 0 | 0 | 60 | 0 |
| implement-function steer | 0 | 12 | 0 | 48 |
| implement-function queue | 0 | 0 | 60 | 0 |

On `tool-use`, the steering main run's pattern (both commands in one turn) is the minority one here: 4 of the 27
following paths (8 trials); 23 ran the commands in separate turns. A queue is followed in one way everywhere: the asked-for command alone, in the new
run.

**Cost, descriptive:** the median output tokens across paths were 290 (tool-use baseline), 1,184 (steer) and 416 (queue),
and 580 (implement-function baseline), 961 (steer) and 710 (queue). Under `tool-use` STEER, the paths that followed used a
median of 1,219 output tokens and the paths that ignored it 672.

## A post-hoc look at the baseline variation (not pre-registered)

Computed from the raw data after the analysis above (`post-hoc-baseline.ts`,
`analysis/post-hoc-implement-function-baseline.json`). It describes how the `implement-function` baseline, with no
intervention, varies across the 30 paths. It tests nothing.

- **Every path's baseline makes the same number of requests (5).** What varies is what the agent does within them:
  19 paths use the tool order `bash, read, read, write, bash`, 10 add a third `read`, and 1 starts with a `read`.
- **9 distinct first tool calls** (for example `ls -la && ls -la src test`, `ls -R <path>`, or a `find`), and **8
  distinct versions of the function the agent writes.**
- **A STEER was followed at 2 of the 19 paths with the common order, at 4 of the 10 with the extra `read`, and at 0 of
  the 1 that starts with a `read`.** The counts are too small to say whether the baseline variant and the following of a
  steer are related, and this study did not set out to ask.
- **The 3 paths that ignored the `tool-use` STEER** also ignored the `implement-function` STEER, and none of the 6 paths
  that followed the `implement-function` STEER is among them.

So the path changes how the agent works on this task even before anything is steered, in ways that did not change
whether the task was done (360 of 360). Whether that variation matters for any later study is an open question; the
direct way to ask it would be a design that targets `implement-function` alone, with many more paths.

## Validity

| Check | Result |
| :--- | :--- |
| **M-path** (the path is the only factor varied) | **PASS:** after the path normalization, the first request is byte-identical across all 30 paths, for each task (1 distinct first request per task) |
| M1 to M3, M5, M6, I1, I2 | PASS at every path |
| Capability study | admitted steer and follow-up at every path, before its first trial: no path was missing or rerun |
| Transport | 0 `Connection error.` turns, 0 incomplete exchanges, in 360 trials |
| Pilot (2 paths outside the sample) | every check passed |

Every arm is valid at every path. The manipulation checks could not have caught a difference in what the agent *does*; they
show that the requests the agent received differ only in the path.

**One process note.** About halfway through the run I analysed the paths finished so far, to check that the manipulation
checks and delivery were healthy. That showed a failure at `p30`, which turned out to be the path still running: its
directory held 4 of 12 trials, and a path with half its trials cannot satisfy the baseline-relative checks. Re-run on the 11
finished paths: 0 violations, all checks passing. Nothing was stopped, changed or selected on the effect measures, and the
analysis above is the full pre-registered one on the finished run.

## What ran

| Item | Value |
| :--- | :--- |
| Pi | 1.0.1, identity `f91821fd54dd80c4…`, entrypoint `e79626f2dd6f94aa…` (as before) |
| Model | `qwen3.8-27b`, Q4_K_M, context 98304, reported by `/v1/models` |
| Server | llama.cpp at 127.0.0.1:8080, as already running. Not restarted, reconfigured or queried beyond `/health`, `/v1/models` and the completions Pi made. |
| Machine | Arch Linux, kernel 7.2.6-arch2-1, RTX 4090, 31 GiB RAM; Node v26.10.0 |
| Runner | `endo-experiment-runner.3`, one run per path |
| Digest domain | `fixture-public` (fixture-experiment mode) |
| Pilot | 2 paths (`pilot-1`, `pilot-2`), 24 trials, 2026-10-04 18:27 to 18:34 UTC |
| Main run | 30 paths × 12 trials = 360 trials, paths shuffled by seed 3826429729, 18:35 to 20:10 UTC. 360 completed, 0 errored, 0 missing paths. A path took a median of 187 s (164 to 245 s). |

The order of the paths (`main/paths.json`): `p23 p27 p12 p24 p06 p26 p17 p04 p18 p14 p13 p30 p05 p11 p22 p02 p01 p10 p21
p28 p20 p08 p03 p29 p09 p25 p19 p07 p16 p15`. Each path's scratch hash is there too.

## Checks after the run (§10)

**Spot-check replay**, chosen by the paths' seed over all 360 trials (`analysis/spotcheck.json`): `p17` implement-function
base #1, `p20` implement-function queue #0 and `p13` implement-function base #1. Each is EXACT on lifecycle, tool calls,
tool results and outcome, with 0 misses and 0 unserved exchanges, and the queue trial reports its intervention re-issued at
its recorded point (exchange 2, chunk 1) with the recorded proposal digest.

## Limits

- The limits of DESIGN §11.
- **Only the path hash varied.** Its length and shape, a username, a date and the message's wording were not. A robust
  result here is not robustness to them.
- **A path is not a random draw** from any real distribution of paths: 30 hex strings of one shape.
- **Paths were not interleaved in time** (§4), justified by the post-hoc replication and by M-path.
- **"Path-dependent at this N"** for `implement-function` STEER means the interval [9.5, 37.3] does not reach either
  threshold, not that the rate is 0.2.
- **One server session, two tasks, one message each, one point,** in a deterministic condition.

## Files

| Path | What it is |
| :--- | :--- |
| `DESIGN.md` | the design, N (§9a) and the deviations (§13, none) |
| `make-spec.ts`, `run-paths.ts`, `analyze.ts` | the spec generator, the driver and the analysis |
| `post-hoc-baseline.ts` | a post-hoc description of the `implement-function` baseline across paths (not pre-registered), writing `analysis/post-hoc-implement-function-baseline.json` |
| `pilot/` | the pilot's paths, reports, plans, run records and per-trial results |
| `main/` | the main run: `paths.json`, the paths' journal, and for each path its report, plan, run record, journal and per-trial results |
| `analysis/` | the pilot's analysis and estimate, the main run's analysis (`main-analysis.json`) and the spot checks |
| `logs/` | the driver's output |
| (raw data) | the complete run directories (pilot and main): every trial's store, evidence and logs, **kept outside the repository** (see below) |

The raw run directories (every trial's store: 273 MB on disk, 10,531 files, about 7 MB compressed) were approved by the operator and committed here at first. Moved out of the repository (it is large and every file was checked on each change): see [`research/DATA.md`](../../DATA.md). It was committed here until 2026-10-05 and is unchanged. The secret scan and its documented path exception are in the data directory's `raw/README.md`.
