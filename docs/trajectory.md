# Trajectories and trajectory comparison

This page decides what "the same run" means for Endophasia. Cassette replay and the run-to-run variance study are
both built on this definition.

A **trajectory** (`endo.trajectory.v0`, `protocol/trajectory.ts`) is a read-only projection of one recorded session.
A **comparison** (`endo.trajectory-comparison.v0`) is a pure function of two trajectories. Neither needs Pi, a model
or the network. The same inputs always give the same bytes.

**Identity is location-free.** Each record carries `digest`: the sha256 of its canonical JSON with `digest` and
`provenance` left out. A trajectory's identity covers its content: the session, the sha256 of the session's recorded
events, the environment and the layers. A comparison's identity covers each side's session, events digest and
trajectory digest, plus the result. The store path is kept in `provenance`, which is not digested, so the same
comparison has the same digest on any machine.

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
| tools | tool calls in start order: `name`, `argsDigest` (keyed digest of the arguments' canonical JSON, with its key id), `result` (`ok` / `error`), and the run and turn they fell in | argument or result text, tool call ids |
| outcome | one entry per run: `completed`, `failed`, `aborted`, `interrupted`, `unclassified` or `open`, with turns, stop reason, whether a STOP was requested, and the failure cause by reference (sha256, length, classification) | cause text |
| usage | per run: Pi-reported tokens summed over its assistant messages | anything Pi did not report |
| timing | per run: wall time from run start to run end, labelled `clock: "observer"` | anything presented as Pi's: Pi reports no durations |

A layer the recording cannot supply is `UNAVAILABLE` with a reason. So is a field inside an entry: an interrupted run
has no stop reason or wall time, and a call recorded before `pi-rpc-mapping.3` has no argument digest. The record also
names its source (session, attachment, event count, sha256 of the events read) and the environment of each attachment
(Pi identity digest and version, mapping version, digest domain, configuration digests, configured model), plus the
models Pi reported on its assistant messages.

Usage and timing are separate layers because they have separate provenance. Usage is what Pi reported. Timing is what
Endophasia observed on its own clock: the `at` of the lifecycle events that opened and ended the run.

## Argument digests and digest domains

**The risk.** A plain sha256 of a tool call's arguments is a confirmation oracle. Arguments are short and guessable
(`{"path":"src/index.ts"}`, `{"command":"ls"}`). Anyone holding a recording can hash candidate arguments until one
matches, and so learn which files were read and which commands were run, even though the text was never stored.

**The digest.** From `pi-rpc-mapping.3`, `tool.started` records `argsDigest`: HMAC-SHA256 of the arguments' canonical
JSON under a **comparison-domain key**, together with the key's id (`runtime/contracts/keyed-digest.ts`). Without the
key, a guess cannot be checked. The key id is derived from the key by HMAC, so it identifies the key without revealing
it. `harness.attached` records the attachment's digest domain (key id and label), never the key.

**The key.** It is held outside every store (`storage/digest-key.ts`). It comes from `ENDO_DIGEST_KEY_FILE`, else
`$XDG_CONFIG_HOME/endophasia/digest-key`, else `~/.config/endophasia/digest-key`. By default there is one key per
installation, so every local store compares with every other. It is created on first use with 32 random bytes, mode
0600, in a 0700 directory, and is never overwritten. A key file that group or others can read is refused. To compare
stores across machines, share the key file between them. Anyone holding the key can confirm guesses, so treat it as a
secret.

**Why not a per-store salt.** It would make every cross-store comparison impossible, and cross-store comparison is
the point (run-to-run, recording vs replay).

**Comparing.** Digests are compared only within one digest domain (the same key id). Digests made under different
key ids are `UNAVAILABLE` ("different digest domains"), never `DIVERGED`: two HMACs under different keys say nothing
about whether the arguments were equal. A difference in the call's name or result still diverges. A domain
difference is also listed in `flags` (`digest-domain-differs`).

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
     not be verified (`unverified`: each position with its reason). A tool call whose argument digest one side did not
     record, or whose digests are in different digest domains, is unverifiable, never equal and never diverged.
3. **usage and timing are never judged.** They report deltas (b − a) per aligned run and in total, with `null` where
   a side does not report a value. Calling two usages or timings "the same" needs a noise band, which the variance
   study has to establish. Timing is always labelled `clock: "observer"`.
4. **Mixed sources are allowed, and always flagged.** These differences go into `flags`: runtime fingerprint, runtime
   version, mapping, digest domain, configuration, configured model, reported model, projection version. They never change a verdict
   and are never silently mixed.
5. **Symmetric.** `compare(b, a)` is `compare(a, b)` with the sides swapped and the usage and timing deltas negated.
   Reasons never name a side.
   `compare(a, a)` is `EXACT` on every layer `a` reports.

## What the committed data shows

- The real Pi 1.0.1 `completes` and `stop-mid-turn` recordings share their first three lifecycle entries (session
  started, run started, turn 1 started). They diverge at index 3: `turn-completed` vs `stop-requested`. Outcome
  diverges at index 0: completed vs aborted.
- `research/pi-conformance/1.0.1/completes-repeat/` holds two further real `completes` runs. It is a preliminary
  observation, not a variance result: see its README.
- `tests/fixtures/trajectory/fake-pi/` holds hostile fake-Pi sessions (reordered calls, different arguments, a tool
  error, missing usage, an unknown runtime record, another Pi version, another digest domain). They are digested
  under two TEST-ONLY keys derived from public strings, which protect nothing. `tests/trajectory.test.ts` pins every
  comparison's digest.

## Limits

- Whoever holds the domain key can confirm guessed arguments. The key file is the secret.
- Tool results are compared by status only: no digest of the result content is recorded yet.
- `lab/replay-compare.ts` compares graph snapshots. It is a different, unwired library and is unrelated to this one.
