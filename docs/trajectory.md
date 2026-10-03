# Trajectories and trajectory comparison

This page decides what "the same run" means for Endophasia. Cassette replay and the run-to-run variance study are
both built on this definition.

A **trajectory** (`endo.trajectory.v0`, `protocol/trajectory.ts`) is a read-only projection of one recorded session.
A **comparison** (`endo.trajectory-comparison.v0`) is a pure function of two trajectories. Neither needs Pi, a model
or the network. The same inputs always give the same bytes, and each record carries `digest`: the sha256 of its
canonical JSON with `digest` left out.

```sh
endo trajectory show <store> <session> [--attachment a]
endo trajectory diff <storeA> <sessionA> <storeB> <sessionB> [--attachment-a a] [--attachment-b b]
```

`<session>` is the endo session coordinate (`endo.session.pi.…`) or Pi's session id. Both commands open stores
read-only and print one canonical-JSON document.

## Layers

| Layer | Entries | Never contains |
| :--- | :--- | :--- |
| lifecycle | the `lifecycle.*` stream, each event reduced to `kind` and the facts that describe the run | ids, process instances, timestamps, paths, store recovery reports |
| tools | tool calls in start order: `name`, `argsSha256` (sha256 of the arguments' canonical JSON), `result` (`ok` / `error`), and the run and turn they fell in | argument or result text, tool call ids |
| outcome | one entry per run: `completed`, `failed`, `aborted`, `interrupted`, `unclassified` or `open`, with turns, stop reason, whether a STOP was requested, and the failure cause by reference (sha256, length, classification) | cause text |
| usage | per run: Pi-reported tokens summed over its assistant messages, and wall time on the observer's clock | anything Pi did not report |

A layer the recording cannot supply is `UNAVAILABLE` with a reason. So is a field inside an entry: an interrupted run
has no stop reason or wall time, and a call recorded before `pi-rpc-mapping.3` has no argument digest. The record also
names its source (store, session, attachment, event count, sha256 of the events read) and the environment of each
attachment (Pi identity digest and version, mapping version, configuration digests, configured model), plus the
models Pi reported on its assistant messages.

The Pi projector (`adapters/pi/trajectory.ts`, `pi-trajectory.1`) takes tools and usage from Pi's live stream only.
A catch-up after a reconnect re-reads durable entries whose usage the live stream already reported, so counting
entries would count a message twice. Event ids seen twice are read once (`source.duplicatesIgnored`). The cost: a
message completed while no observer was attached has no usage in the trajectory. The interruption that caused the gap
is in the lifecycle layer.

## Comparison rules

The rules are `ENDO_TRAJECTORY_COMPARISON_RULES_V0` (`trajectory-comparison.1`). Every comparison carries them
verbatim, so a rule change is a visible version change.

1. **Alignment is by position within each layer, never by timestamp.** The first position where the two sides
   differ is the divergence. Timestamps differ on every run and say nothing about whether the run was the same.
2. **lifecycle, tools and outcome are judged.**
   - `EXACT`: both sides reported the layer, same length, and every entry equal (canonical JSON).
   - `DIVERGED`: the first differing `index`, both entries (`null` past a side's end), both lengths, and
     `commonPrefix` (equal to `index`).
   - `UNAVAILABLE`: a side did not report the layer (each side's reason is given), or no entry differs but some could
     not be verified. A tool call whose argument digest one side did not record is unverifiable, never equal.
3. **usage is never judged.** It reports deltas (b − a) per aligned run and in total, with `null` where a side does not
   report a field. Calling two usages "the same" needs a noise band, which the variance study has to establish.
4. **Mixed sources are allowed, and always flagged.** These differences go into `flags`: runtime fingerprint, runtime
   version, mapping, configuration, configured model, reported model, projection version. They never change a verdict
   and are never silently mixed.
5. **Symmetric.** `compare(b, a)` is `compare(a, b)` with the sides swapped and the usage deltas negated.
   `compare(a, a)` is `EXACT` on every layer `a` reports.

## What the committed data shows

- The real Pi 1.0.1 `completes` and `stop-mid-turn` recordings share their first three lifecycle entries (session
  started, run started, turn 1 started). They diverge at index 3: `turn-completed` vs `stop-requested`. Outcome
  diverges at index 0: completed vs aborted.
- `research/pi-conformance/1.0.1/completes-repeat/` holds two further real `completes` runs. It is a preliminary
  observation, not a variance result: see its README.
- `tests/fixtures/trajectory/fake-pi/` holds hostile fake-Pi sessions (reordered calls, different arguments, a tool
  error, missing usage, an unknown runtime record, another Pi version). `tests/trajectory.test.ts` pins every
  comparison's digest.

## Limits

- An argument digest is a reference, not a secret. Short, guessable arguments can be confirmed by hashing guesses.
- Tool results are compared by status only: no digest of the result content is recorded yet.
- `lab/replay-compare.ts` compares graph snapshots. It is a different, unwired library and is unrelated to this one.
