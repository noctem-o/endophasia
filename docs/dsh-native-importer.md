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
projector only after a successful import. The projection is `dsh-native-trajectory.3`; open outcomes count the turn-started
events observed in that run, including zero when no step started.

## CLI: explicit cold import

The installed `endo` uses this same importer; DSH does not need to be installed:

```sh
endo dsh import /path/to/session-directory
endo dsh import --root ./recordings /path/to/session-directory
endo dsh import ./recordings /path/to/session-directory
endo dsh loss-accounting
```

The source must be one explicit session **directory**, never a DSH home, transcript file or process. The importer selects its
highest-generation log. Preflight requires one newest readable regular log; symbolic-link log files are refused. No directory
scanning outside that source, DSH lock access, session resume, model call or background import occurs.

Store selection uses the existing positional/`--root`/default rules. Name a root only once; spell a path beginning with `-` as
`./-name` to distinguish it from a flag. Defaults are `ENDO_STORE_ROOT`, then
`$XDG_DATA_HOME/endophasia/store`, then `$HOME/.local/share/endophasia/store`; a default selection is announced on stderr.
The private installation comparison key is loaded or created using `ENDO_DIGEST_KEY_FILE`, then
`$XDG_DATA_HOME/endophasia/digest-key`, then `$HOME/.local/share/endophasia/digest-key`. Existing key format, permission warnings
and public-fixture-key refusal apply; there is no DSH-specific key or domain.

`import` prints one canonical-JSON `DshImportReportV0`. `imported` and `unchanged` exit **0**; `refused` exits **1** with its report
on stdout and no evidence appended. Operational failures exit **1**, diagnose the failed phase on stderr and print no fabricated
report. Malformed family/command arguments retain the CLI's existing exit **1** convention (unknown top-level commands exit 2).
Report status, codes, counts, valid sequence references and physical tail classifications are preserved. Free-form finding,
refusal and unreadable-tail descriptions are withheld: the API's diagnostic strings can echo source tool names, event types,
malformed values or unaudited stored metadata. Unrepresentable sequence references are omitted, not converted into zero.
Plain identifiers and classification tokens retain the privacy qualifications below; this is not a general secret detector.

Arguments and source/destination locations are validated before acquiring resources. Source/store overlap, key files inside
the source or destination, unresolved aliases and multiply linked destination logs are refused. Existing destination tails are
inspected read-only; a torn, sealed or unopenable destination is left untouched, with no automatic recovery. Only the first
actual append opens a writer. A valid preflight followed by a malformed/unsupported-source refusal can still create the
installation key, but creates no destination store. A later I/O failure can leave a resumable partial import; retry with the same
source and key. There is no rollback or new transaction mechanism. Acquired stores are closed on every path.

DSH bytes, names, permissions and modification/change times are not changed. Filesystem reads may update access times; the CLI
does not restore them through a metadata write. Import timestamps are separate from source timestamps. Incremental imports
retain their additional checkpoints and individual import clocks: source evidence and derived layers agree with a one-shot
import, while the two complete stores need not be byte-identical. Run one writer per store and do not replace source/destination
aliases concurrently; preflight is not an isolation boundary against hostile concurrent filesystem changes.

`loss-accounting` prints `DSH_NATIVE_LOSS_ACCOUNTING_V0` exactly as one canonical-JSON document and exits **0**. It takes no source,
root or options, needs no key or DSH installation, and creates nothing. It is the **static mapping/fidelity contract**, not a
measurement of which events occurred in a session. EXACT, QUALIFIED, LOSSY and UNREPRESENTABLE retain their existing meanings.
DSH trajectory selection is not added to `endo trajectory show`; that command retains its Pi-specific behavior.

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
Tool-call references are always domain-separated keyed `callIdDigest` values, including ordinary IDs, and the projector pairs
by digest key ID and value. Raw call IDs are not retained; missing/non-string required call IDs are refused before append. Empty
string IDs remain identities, distinct from missing IDs. Plain runtime identifiers and classification tokens remain metadata;
their grammar is not a general detector of private text.

## What is implemented, and what stays unavailable

| DSH semantic | Becomes | Fidelity (loss accounting) |
| --- | --- | --- |
| turn | `lifecycle.run-*`; `completed`→run-completed, `aborted`→run-aborted (cause kept; `stopRequested` only for a user cause), `error`→run-failed (code, status, keyed message digest), `blocked`/`max-tokens`→run-unclassified naming the reported kind | QUALIFIED: a DSH turn is an Endophasia **run**, not the same thing |
| turn closed by DSH on resume (`interrupted`) or by a fork seed (`forked`) | `run-unclassified`, `provenance: "dsh-written-closer"`, `finalStep`; the trajectory outcome is `unclassified` | Never `lifecycle.interrupted` (Endophasia's own observation) and never `session-resumed` |
| step | `lifecycle.turn-started` / `turn-completed` (stop reason of its assistant message, else UNAVAILABLE; `output`: `none`, `attempt-only`, `committed` or `cancelled-prefix`) | QUALIFIED: a DSH step is an Endophasia **turn**. An assistant message says the model produced output, not that the step finished (`interrupted: true` is a cancelled stream's prefix). A `step/end` directly followed by a `turn/end` of reason `interrupted` or `forked` may be DSH's own recovery closer (recovery closes an open step whatever it had committed, with the last event's time): **no `turn-completed` is claimed**, and the closing event records `finalStep` (output kind, recovered tool results, whether a step end was written) |
| `tool/call`, `tool/result` | `dsh.tool-requested`, `dsh.tool-result-recorded`; trajectory `toolCalls` (the model's requests) and `toolResults` (paired by the keyed identity of the call id in the result message) | QUALIFIED: **never** `tool.started`/`tool.finished`. No start time, duration or "executed" claim exists |
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
7. **Mapping version 4.** This retains the earlier keyed cwd commitment, qualified recovery handling, safe content counts and
   runtime-ID withholding, and gives every tool-call reference a domain-separated keyed identity. Stores imported under mappings
   1, 2 or 3 refuse re-import (`mapping-changed`); use a fresh store rather than reinterpreting previous records. No released
   package carried these candidate mappings. The derived fork cut is compared independently of the header digest.
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

## Validation

The [importer validation record](dsh-native-importer-validation.md) covers parent integration, the four Codex findings, adjacent
counter/privacy fixes, deterministic tests and cold imports of retained raw runtime evidence. No active DSH sessions are read.

The study (#70) and importer (#71) are merged into `main`. CLI subprocess and installed-package tests use the retained sanitised
fixtures and synthetic adversarial inputs; no fresh real transcripts or active DSH sessions are needed for CLI validation.
