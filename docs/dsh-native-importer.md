# DSH native cold importer

`adapters/dsh-native/` imports a persisted DeepSeek Harness (DSH) Session, **format 4**, into the Endophasia event store, and projects
the stored events into the existing `endo.trajectory.v1`. It is the implementation of option B of the
[conformance study](dsh-native-attachment.md) (§5 to §8). It reads a file; it never drives DSH. Nothing in `protocol/`, `runtime/`,
`storage/`, `cockpit/`, Studio or the Pi and ACP adapters changed, and no trajectory or event schema is new.

```ts
import { importDshSessionDirectoryV0, projectDshTrajectoryV0 } from "./adapters/dsh-native/index.ts";

const report = importDshSessionDirectoryV0(sessionDirectory, store, { digestKey, now: () => new Date().toISOString() });
// This example fits one page; collect every page for larger sessions.
const trajectory = projectDshTrajectoryV0(store.page({ limit: 10_000 }).events, {
  session: report.session!, sessionKind: "endo-coordinate", store: root,
});
```

The projector treats `session` as a **raw DSH ID** by default, even if it starts with `endo.session.`. Select a coordinate
explicitly with `sessionKind: "endo-coordinate"`; prefixes are never used to guess between two possible sessions. Call the
projector only after a successful import. The projection is `dsh-native-trajectory.2`; open outcomes count the turn-started
events observed in that run, including zero when no step started.

## Guarantees

**Read-only toward DSH.** The file layer uses `readdirSync` and `readFileSync` only. It never opens a file for writing, never opens
`session.lock`, never repairs a torn tail, never resumes a session and spawns no process. Every session is treated as possibly open:
DSH has no reliable "closed" signal, so a log is read once, as a snapshot, up to its last complete frame, and the state of its end
(`clean`, `torn-frame`, `torn-row`) is reported and recorded in an import checkpoint.

**Strict input.** Only format 4 (an `.v5` file beside it is refused, not guessed). The complete physical header is validated
against the pinned format before structural checking or mapping: required keys, boolean `isSeeded`, safe nonnegative creation
time and delegation depth (excluding negative zero), absolute optional cwd, optional field types and the exact key set. The
importer additionally requires a nonempty ID. Unknown required event types, non-ignorable `plugin:` records, sequence gaps,
invalid UTF-8 or JSON, blank complete rows, skippable/reserved framing, missing checksum flags and a decoded size above 64 MiB
are refused. The checksum requirement matches the pinned writer; upstream's decoder is more permissive. Rows cannot span
independent frames. A final complete frame ending inside a row, a torn frame and a torn raw row retain the complete prefix and
report damage; an earlier incomplete row in a complete frame is corruption and is refused. The physical frame count includes
all structurally complete frames found even when decoding fails.

**Idempotent, append-only toward the store.** Event ids are deterministic functions of (DSH session id, seq). Re-importing the same
log appends nothing (`unchanged`). An extended log appends only the new rows, and the stored result equals a single full import
(tested at five cut points). Before appending, every previously imported row is verified by its keyed digest. A changed historical
row (reported with its DSH seq), a changed header (another session under the same id), a log shorter than what was imported, another
digest key, a changed inherited cut (even with only the header previously stored), or another mapping version is `refused` and **nothing is appended or replaced**. A partial import resumes: each missing
event is appended by its id.

**Three clocks, never merged.** `at` is the import time, from an injected clock. `payload.source.reportedTimeMs` is DSH's own time,
as reported. DSH's `seq` is `payload.source.dshSeq`; it is neither the storage sequence nor the producer `sequence`.

**Privacy.** Persisted payloads hold only structure: types, counts, byte lengths, enumerated reasons, opaque ids, usage numbers,
short classification tokens (provider, model, tool name, error code, only when they match a conservative pattern), and **keyed
digests** (HMAC under the caller's comparison-domain key) of whole rows, tool arguments, tool results, failure messages, request
configuration and the agent preset. Prompts, system and injected text, reasoning, tool text, titles, approval reasons, the working
directory and failure messages are never stored. A **public** digest key is refused on real input (its digests would be
confirmation oracles) unless a test or fixture explicitly allows it. Raw runtime IDs are retained only when they match the
plain identifier grammar `[A-Za-z0-9._-]{1,200}`. Other IDs, including paths, remain usable through their stable coordinate but
are explicitly UNAVAILABLE as runtime IDs, with a withholding reason; the coordinate is never substituted as the runtime ID.
Plain identifiers and classification tokens remain metadata; this grammar is not a general detector of private text.

## What is implemented, and what stays unavailable

| DSH semantic | Becomes | Fidelity (loss accounting) |
| --- | --- | --- |
| turn | `lifecycle.run-*`; `completed`→run-completed, `aborted`→run-aborted (cause kept; `stopRequested` only for a user cause), `error`→run-failed (code, status, keyed message digest), `blocked`/`max-tokens`→run-unclassified naming the reported kind | QUALIFIED: a DSH turn is an Endophasia **run**, not the same thing |
| turn closed by DSH on resume (`interrupted`) or by a fork seed (`forked`) | `run-unclassified`, `provenance: "dsh-written-closer"`, `finalStep`; the trajectory outcome is `unclassified` | Never `lifecycle.interrupted` (Endophasia's own observation) and never `session-resumed` |
| step | `lifecycle.turn-started` / `turn-completed` (stop reason of its assistant message, else UNAVAILABLE; `output`: `none`, `attempt-only`, `committed` or `cancelled-prefix`) | QUALIFIED: a DSH step is an Endophasia **turn**. An assistant message says the model produced output, not that the step finished (`interrupted: true` is a cancelled stream's prefix). A `step/end` directly followed by a `turn/end` of reason `interrupted` or `forked` may be DSH's own recovery closer (recovery closes an open step whatever it had committed, with the last event's time): **no `turn-completed` is claimed**, and the closing event records `finalStep` (output kind, recovered tool results, whether a step end was written) |
| `tool/call`, `tool/result` | `dsh.tool-requested`, `dsh.tool-result-recorded`; trajectory `toolCalls` (the model's requests) and `toolResults` (paired by the call id in the result message) | QUALIFIED: **never** `tool.started`/`tool.finished`. No start time, duration or "executed" claim exists |
| tool result DSH wrote itself during recovery (`TOOL_NOT_STARTED`, `TOOL_OUTCOME_UNKNOWN`) | `dsh.tool-result-recorded` flagged `dshRecovery`, no result digest; trajectory status and digest UNAVAILABLE | DSH speaking after the fact, never a tool outcome |
| failed attempts, retries | `dsh.attempt-recorded`, `dsh.retry-recorded`, `dsh.retry-started` | QUALIFIED: DSH-specific kinds on purpose (Pi's `retry.*` carry Pi's semantics) |
| usage | recorded per assistant message under Endophasia's names; absent categories are **absent**, never 0. The trajectory reports a run's tokens only if all five required categories are present on every message, else UNAVAILABLE naming what is missing | Real DSH usage lacks `cacheWrite`, so the usage layer is UNAVAILABLE on real data |
| permission, sandbox, approval records | `dsh.authority-recorded`, source class `runtime-fact` | Observations of **DSH's** authority state; never an Endophasia decision |
| request configuration | `dsh.request-config-recorded` (provider, model, tool count and names, keyed digest of the whole configuration) | LOSSY |
| fork and subagent ancestry | `dsh.session-imported` (parent as a coordinate, validated cut, depth, origin) and `dsh.seed-boundary`; rows before the cut are not imported | LOSSY: no inherited copy, no cross-session order |
| compaction, orchestration, hooks, commands, goals, plans, workspace, titles | `dsh.record` (family, keyed digest of the payload) | recorded-only; deliberately **not** `lifecycle.compacted` |
| timing | UNAVAILABLE layer | DSH time is reported, the import clock is not an observation |
| tool execution start/duration, request start, HTTP headers and bodies, cost, runtime version and identity, plugin composition | UNAVAILABLE | not in the log |
| streaming frames, `agent/error`, anything not flushed before a crash | not importable | a cold reader cannot see them |

`endo.dsh-native-loss-accounting.v0` (`adapters/dsh-native/loss.ts`) holds this as data: one entry per row of the study's fidelity
matrix, covering each of the 62 pinned DSH event types exactly once, tested against `research/dsh-native/`.

## Deliberate differences from PR #70's handoff

1. **`blocked` and `max-tokens` become `run-unclassified`, not `run-completed`.** The study pointed at Pi's rule (other stop reasons
   to `run-completed`). DSH's reasons are turn-end reasons, not provider stop reasons, and `run-completed` would claim the run
   finished. ACP maps `max_tokens` and `refusal` the same conservative way.
2. **No `turn-completed` before a DSH recovery turn end.** The study accepted `turn-completed` with an UNAVAILABLE stop reason. A
   one-row lookahead keeps the fold append-stable and honest: an unfinished final step waits for the next import, and a `step/end`
   directly followed by an `interrupted` or `forked` turn end is not claimed complete whatever the step had committed, because DSH
   recovery writes such a step end itself. The cost is an under-claim: a genuine last step followed by a recovery turn end also gets
   no `turn-completed`.
3. **Retries use `dsh.*` kinds**, not Pi's `retry.*`.
4. **Compaction is recorded, not mapped to `lifecycle.compacted`.**
5. **An import checkpoint** (`dsh.import-checkpoint`, its own producer) records how far the evidence reaches (DSH seq, tail state),
   under which key and mapping. It replaces nothing in the study; it makes "evidence up to seq N, tail torn" a stored fact.
6. **The trajectory outcome of a DSH-written closer is `unclassified`**, not `interrupted`, so a DSH crash and a Pi crash compare as
   different outcomes. That is the honest result: they are different claims.
7. **Mapping version 3.** This retains mapping 2's keyed commitment to cwd, qualified step output and recovery-result handling,
   and corrects arbitrary content-kind counts and unsafe raw runtime-ID disclosure. Stores imported under mappings 1 or 2 are
   refused on re-import (`mapping-changed`); use a fresh store rather than reinterpreting or overwriting previous records. No
   released package carried these candidate mappings. The derived fork cut is compared independently of the header digest.
8. **Reader promoted, not copied.** `research/dsh-native/log.ts` moved to `adapters/dsh-native/log.ts`; the study and its tests import it from there.

## Known limitations

* **Single writer per store root.** The durable event store has no writer lock, and deterministic ids turn two racing importers (or an
  importer racing a recorder on the same root) into a duplicate id the next open rejects. Run one writer per store root.
* A genuine last `step/end` followed by a DSH recovery turn end is indistinguishable from DSH's own closer and is not claimed complete.
* Usage is UNAVAILABLE on real DSH data until DSH reports `cacheWrite` (the partial counts are in the recorded events).
* The session overview (`runtime/contracts/session-overview.ts`) will show an open imported run as "running"; a cold import cannot know
  the process is gone. Use the checkpoint's `tail` and `highWaterDshSeq` for coverage.
* A model, provider, tool or code string that does not match the conservative token pattern is dropped, not digested.
* Zstd frames that DSH could recover through a write handle (the complete rows of a torn frame) are dropped here and reported.
* Not verified against a real torn write or a live-written file (only SYNTHETIC cuts and one clean SIGKILL); not exercised on Windows.
* The fixtures all use the id `session-1`; importing two of them into one store is refused as a changed history (a feature).

## Validation and stacked merge order

The [importer validation record](dsh-native-importer-validation.md) covers parent integration, the four Codex findings, adjacent
counter/privacy fixes, deterministic tests and cold imports of retained raw runtime evidence. No active DSH sessions are read.

This PR remains based on `dsh-native-attachment-study` (#70). Merge #70 first, then retarget #71 to `main` and verify the resulting
importer-only diff and CI. If #70 is squash-merged or rebased, restack #71 onto the resulting `main` commit before retargeting.
Neither PR is merged by this repair work.
