# Real recordings and studies

What has been run against a real Pi and a real model, what each run establishes, and what it does not. The README's
[Current state](../README.md#current-state) links here instead of inlining the detail. The text of each section was
moved here unchanged.

Every entry below is one Pi release (1.0.1 unless stated), one model (qwen3.8-27b, Q4_K_M, on llama.cpp's
OpenAI-compatible server) and one machine.

| Entry | Where | Summary |
| :--- | :--- | :--- |
| [Session lifecycle](#session-lifecycle) | `pi-conformance/1.0.1/lifecycle/`, [LIFECYCLE.md](pi-conformance/LIFECYCLE.md) | completes, stop-mid-turn and killed-and-resumed, recorded live |
| [Cassette replays](#cassette-replays) | [`pi-conformance/1.0.1/cassettes/`](pi-conformance/1.0.1/cassettes/README.md) | 4 sessions, 40 replays, all EXACT; a real negative control |
| [Variance study (E2)](#variance-study-e2) | [design](variance/1.0.1/DESIGN.md), [results](variance/1.0.1/RESULTS.md) | "unstable" under every arm: sampling, then the environment |
| [Pinned-environment study (E3)](#pinned-environment-study-e3) | [design](pinned-environment/1.0.1/DESIGN.md), [results](pinned-environment/1.0.1/RESULTS.md) | "stable" with the environment pinned, deterministic sampling and the cache off |
| [Steering study](#steering-study) | [design](steering/1.0.1/DESIGN.md), [results](steering/1.0.1/RESULTS.md) | a STEER and a QUEUE at a fixed point against a baseline, all in the deterministic condition |
| [Path-sensitivity study](#path-sensitivity-study) | [design](path-sensitivity/1.0.1/DESIGN.md), [results](path-sensitivity/1.0.1/RESULTS.md) | the steering results across 30 working-directory paths: QUEUE followed at every path, STEER at most paths on one task and few on the other |
| [Discriminating-task study](#discriminating-task-study) | [design](discriminating-tasks/1.0.1/DESIGN.md), [results](discriminating-tasks/1.0.1/RESULTS.md) | 12 small coding tasks screened and confirmed: two discriminate (13/20 and 7/20), most are saturated, and most failures are a response cut off at the completion cap |
| [Completion-cap study](#completion-cap-study) | [design](completion-cap/1.0.1/DESIGN.md), [results](completion-cap/1.0.1/RESULTS.md) | raising Pi's completion cap from 16,384 to 32,768 raised success on the two discriminating tasks from 10/24 to 19/23; thinking-off and a brief-reasoning sentence are cheaper but less reliable |
| [Fake-only paths](#fake-only-paths) | `tests/fixtures/` | what has been exercised only against the fake Pi |

## Session lifecycle

The session lifecycle has one real recording ([`research/pi-conformance/1.0.1/lifecycle/`](pi-conformance/1.0.1/lifecycle/), see
[`research/pi-conformance/LIFECYCLE.md`](pi-conformance/LIFECYCLE.md)). It ran Pi 1.0.1 against a real model: qwen3.8-27b on llama.cpp's
OpenAI-compatible server, with reasoning on, on Linux. Its three sessions came out as follows:
- **completes:** a run completed with Pi's own `stop`.
- **stop-mid-turn:** a STOP, after which Pi reported its own `aborted` termination. Pi acknowledged the abort only
  after `agent_settled`, as its documentation says.
- **killed-and-resumed:** Endophasia was killed mid-turn, and the next attach recorded the interruption and the
  resume, with deduplicated catch-up.

That is one Pi release, one model and one machine. The failure, retry, compaction and unknown-record paths have been
exercised only against the fake Pi (`tests/fixtures/pi-lifecycle/`).

## Cassette replays

Four real sessions were recorded with their cassettes ([`research/pi-conformance/1.0.1/cassettes/`](pi-conformance/1.0.1/cassettes/)): completes,
stop-mid-turn, killed-and-resumed and tool-use. The tool-use session reads, edits and runs `wc -l` on a file in the
scratch workspace, so "tools EXACT" is not vacuous there. Each session was replayed 5 times as-recorded and 5 times
immediate against the same Pi 1.0.1. All 40 replays were EXACT on lifecycle, tools and outcome, with no cassette miss
and no flag. A real negative control was also run: the workspace file was changed before Pi started. That replay
diverged at the read's result digest, followed by an explicit cassette miss.

**What these replays establish:** with the model's responses held fixed, this Pi release reproduced its control flow
for these scenarios on one machine.

**What they do not establish:**
- anything about the model, whose outputs are held fixed;
- tool effects outside the scratch root;
- the behaviour of nondeterministic tools;
- behaviour on another machine, Pi release or configuration.

## Variance study (E2)

A first variance study ([design](variance/1.0.1/DESIGN.md), [results](variance/1.0.1/RESULTS.md))
ran Pi 1.0.1 with qwen3.8-27b on three small synthetic tasks: 20 live trials per task under each of three arms. The
arms were Pi's defaults, temperature 0 with a fixed seed, and that plus llama.cpp's prompt cache off; documented Pi
extensions changed the requests, and manipulation checks passed.

**Under Pi's defaults**, every pair of runs first differed at a model reply: sampling.

**With temperature 0 and a fixed seed**, no identical request got a different reply (1,140 pairs). Lifecycle and
outcome were identical in 20 of 20 trials on every task. What still varied on the coding tasks was tool output (test
durations, file timestamps). It fed back into the next request, and with the prompt cache on it sometimes changed
which tool calls followed.

The pre-registered verdict is "unstable" under every arm, because the tools layer of the coding tasks varies. Every
trial passed its success check.

Two findings came out of the study:
- **A proxy bug.** The recording proxy had delayed relaying the server's connection close, which caused Pi
  `Connection error.` turns. It was fixed, and the affected run was discarded and repeated.
- **A replay limit.** Replay cannot reproduce sessions whose tools print wall-clock values. All three spot-check
  replays of coding-task trials ended in an explicit cassette miss.

This is one Pi release, one model and quantization, one machine and N = 20.

## Pinned-environment study (E3)

A second study pinned the environment the tools observe
([design](pinned-environment/1.0.1/DESIGN.md), [results](pinned-environment/1.0.1/RESULTS.md)). It
used the same tasks and 20 live trials per task per arm. The pinning is an experiment condition's `environment`:
- `TZ=UTC` and `LC_ALL=C`;
- fixed file times on everything Pi starts with;
- a test reporter that prints no durations.

An unpinned control ran interleaved with the pinned arms.

**With temperature 0, a fixed seed, the cache off and the environment pinned**, every judged layer was identical in
20 of 20 trials on every task. The pre-registered verdict is "stable", and every pair made identical requests
throughout. The unpinned control stayed unstable (tool results 1/20 on the coding tasks), which confirms that the
variance study's remaining divergence came from the environment.

With the cache on and the environment pinned, the result was stable too. The study did not vary the cache state; a
single pilot event, the first request after a server restart, suggests a cold cache can change a reply. Pinned
coding-task cassettes replay EXACT. One metric (distinct final workspaces) is not interpreted, because the workspace
digest now includes file times.

## Steering study

A third study ([design](steering/1.0.1/DESIGN.md), [results](steering/1.0.1/RESULTS.md)) used E3's fully pinned
deterministic condition and two of E2's tasks, with three arms of 20 live trials per task: a baseline, an operator's
STEER and an operator's QUEUE, applied once the first chunk of the second model response was relayed. Pre-registered
checks held in all 120 trials: the baseline trials are identical to each other, no steered trial differs before the
point, the first difference is the request that carries the message (request 3 for a steer, one past the baseline's
last for a queue), and the recording proxy shows the message consumed in exactly that request.

What the agent did with the message was measured apart from the success check, and the success check passed in every
trial:
- **QUEUE** was followed in 40 of 40 trials.
- **STEER** was followed in 20 of 20 trials on `tool-use` (after ten times the output) and in 0 of 20 on
  `implement-function`.

The pilot, whose requests differ from the main run's only in a hash in the working-directory path, followed the steer on
`tool-use` in 0 of 3 trials. A post-hoc replication reproduced each run's requests exactly at its own path, so the
response to a steer is a reproducible function of the whole prompt, and on this task it differed between two paths that
differ only in that hash. Only two paths were tried, and this study measured one. Each steered cassette replays EXACT five times against the real Pi. Two transport errors in 622
requests were a keep-alive race. This is one Pi release, one model, two tasks, one message each and one point.

## Path-sensitivity study

A fourth study ([design](path-sensitivity/1.0.1/DESIGN.md), [results](path-sensitivity/1.0.1/RESULTS.md)) checked how far
the steering study's results generalize across one irrelevant factor: the working-directory path, which Pi puts in its
system prompt. It reran the steering main spec at 30 paths that differ only in a hash (one run per path, 2 trials per cell,
360 trials), after a pilot of 2 more. The manipulation check showed the first request is byte-identical across paths once
that hash is replaced, so the path is the only factor varied. At every path the trials of every cell were identical to each
other, Pi delivered each message exactly where it documents, and every success check passed.

Over the 30 paths:
- **QUEUE** was followed at 30 of 30, on both tasks.
- **STEER on `tool-use`** was followed at 27 of 30 [74.4, 96.5] (robustly followed by the pre-registered thresholds). The
  steering pilot's 0/3 was one of the rare paths.
- **STEER on `implement-function`** was followed at 6 of 30 [9.5, 37.3] (path-dependent at this N).
- **The baseline is not path-invariant on `implement-function`:** 20 distinct tool-call signatures across the 30 paths,
  against 1 on `tool-use`. The path changes what the agent does with no intervention.

Only the path hash varied, and the study counts paths, not mechanisms. One Pi release, one model, two tasks, one message
each and one point.

## Discriminating-task study

A fifth study ([design](discriminating-tasks/1.0.1/DESIGN.md), [results](discriminating-tasks/1.0.1/RESULTS.md)) answers the
question the earlier four raised: every success check in every study passed, so none could separate two candidates. It wrote a pool of
12 small coding tasks (8 implement-to-spec, 2 bugfix, 2 edit-existing) with hidden checks, mechanically validated before any trial
(reference passes, starting workspace and a plausible wrong solution fail, every stated rule is tested and every tested rule stated).
A screen of 6 trials per task, then 20 fresh trials on each advancing task over 4 working-directory paths, in the pinned condition.

- **Two tasks discriminate:** `fetch-cache` 13 of 20 [43, 82] and `markup-lite` 7 of 20 [18, 57] (with path heterogeneity).
  `booking-conflicts` advanced at 5/6 and was 20/20. The other nine were dropped at the screen, seven at 6 of 6.
- **Post-hoc, not pre-registered:** 21 of the 25 failures on the three tasks are a response that hit Pi's default
  `max_completion_tokens` of 16,384 while reasoning, before any code was written. The tasks discriminate mostly on that.
- The validation/holdout split is fixed (`validated-tasks.json`): one task each, so the holdout is very small.

## Completion-cap study

A sixth study ([design](completion-cap/1.0.1/DESIGN.md), [results](completion-cap/1.0.1/RESULTS.md)) tested what the discriminating-task
study's post-hoc finding implied: that most failures on `fetch-cache` and `markup-lite` were a response cut off at Pi's default
`max_completion_tokens` of 16,384. Four arms, each one documented `before_provider_request` handler, ran interleaved on four tasks over four
paths (192 trials, 3 per cell per path): the default cap (A), a 32,768 cap (B), one sentence asking for short reasoning (D), and thinking
switched off per request (E).

- **Primary:** B against A pooled over the two primary tasks is **19/23 against 10/24, +0.41, cluster interval [+0.09 to +0.73]**, a gain at every
  path: by the pre-registered thresholds the cap is binding. The reading rests on all four paths.
- `fetch-cache` is 11/11 once the cap is not binding (it measured the cap); `markup-lite` is still 8/12, with four wrong answers and no cut-off (it measures the code).
- D is cheaper per success on two tasks and worse on `markup-lite`; E is 3 to 4 times faster per trial and less accurate (the harm check flags `config-extends`), but it fails the M6 manipulation check in two paths, so by the design's rule it is reported as an invalid arm.
- **There is no sandbox, and it showed.** One excluded trial read a hidden check and the reference solution in the repository, through a leftover file of the author's in `/tmp`; another deleted files in
  `/tmp` by glob. Future trials should run with the checkout unreachable.

## Raw run data

The studies' raw run directories are not in this repository (about 1 GB of tracked files was moved out on 2026-10-05, and later studies' data was never added): see
[DATA.md](DATA.md) for where they live, how to restore them and what the secret scan found. The results, analyses, run summaries and cassettes stay here.

## Fake-only paths

The earlier `completes-repeat` runs, made under a deleted scratch key, were retired. The hostile trajectory cases
(reordered or different tool calls, different result content, missing usage, another Pi version, another digest
domain) are exercised only against the fake Pi (`tests/fixtures/trajectory/`).
