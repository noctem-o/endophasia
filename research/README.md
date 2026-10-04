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

The pilot, which differed from the main run only in a hash in the working-directory path, followed the steer on
`tool-use` in 0 of 3 trials. So one irrelevant string changed whether the agent acted on a steer, and this study
measured one path. Each steered cassette replays EXACT five times against the real Pi. Two transport errors in 622
requests were a keep-alive race. This is one Pi release, one model, two tasks, one message each and one point.

## Fake-only paths

The earlier `completes-repeat` runs, made under a deleted scratch key, were retired. The hostile trajectory cases
(reordered or different tool calls, different result content, missing usage, another Pi version, another digest
domain) are exercised only against the fake Pi (`tests/fixtures/trajectory/`).
