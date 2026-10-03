# Pi attachment: inventory, mapping and decisions

Status: implemented on branch `pi-rpc-attachment` (stacked on `phase-12-operational-substrate`); audited (see
[pi-attach-audit.md](pi-attach-audit.md)). This document
supersedes the read-only proposal drafted on 2026-10-03 (local commit `ba1045b`, never pushed).

Endophasia attaches to a Pi **the user installs and manages**, through Pi's documented RPC mode. It never installs,
updates, downgrades, patches or rebuilds Pi. It observes the installed runtime, records what it is and what it did,
checks what it can do, and offers only the capabilities current evidence supports.

## 1. What was verified, and against what

| Subject | Revision |
| :--- | :--- |
| Endophasia stack tip before this work | `dab7806` (`phase-12-operational-substrate`, PR #13) |
| Retired fork pin (`pi/` submodule) | `ab4caf5a0d3a245ccc29a97a13283b93f9174f78`, now `HEAD` of `noctem-o/endophasia-pi-legacy-deprecated` |
| Upstream Pi | `github.com/earendil-works/pi` tag `v1.0.0`; npm `@earendil-works/pi-coding-agent@1.0.0` (`latest` on 2026-10-03) |
| Real runtime exercised | Pi 1.0.0 installed with `npm install -g` into a scratch prefix, outside the repository |

Findings that drove the design, each checked against upstream sources or the running binary:

1. **The fork's API no longer exists upstream.** Upstream commit `7fd478a2` (2026-10-01, before 1.0.0) removed the
   experimental harness from `pi-agent-core` (`AgentHarness`, `AgentLane`, `Session`, `scanUsage`, `getResult`,
   `HarnessClosed`, `./harness/*`, `./node`). Every fork-era `adapters/pi` module was written against it.
2. **The fork's hooks never existed upstream.** `createHostFacets`, `sessionWorkerEntryUrl`, `additionalListeners` and
   `scanUsage` have zero occurrences in upstream Pi.
3. **An installed Pi does not ship the experimental modules.** `@earendil-works/pi-coding-agent@1.0.0` exports `.`,
   `./rpc-entry`, `./client`, `./experimental/plugin`, and its `files` exclude `dist/experimental`.
4. **Upstream's plugin facets cannot see the harness.** `pi server -e <pkg>` session plugins reach only
   `AgentController`, `PresentationUI`, `SlashCommands` (and the worker's `Transcript`/`Models`), so they offer nothing
   over RPC for usage or operation outcomes.
5. **`pi --mode rpc` is documented and stable** (`docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`,
   `src/modes/rpc/rpc-types.ts` at `v1.0.0`) and, run against the real binary, behaves as documented. Observed
   specifics this implementation depends on:
   - `get_entries {since}` returns entries strictly after the opaque id; an unknown id is refused
     (`"Entry not found: <id>"`).
   - Responses are correlated by `id`; Pi may emit an event (e.g. `queue_update`) before the response to the command
     that caused it. A parse failure answers with `command: "parse"` and no id.
   - Pi persists a session file only at the first message: two processes on the same `--session-id` without a prompt
     get different sessions. Cross-process continuity holds after a prompt (`--session-id` then resumes it).
   - With no model configured, `get_state.model` is a placeholder `unknown/unknown`.
   - A `--session-id` Pi does not know yet produces a warning on stderr; stdout carries only protocol records.
   - Closing stdin is the orderly shutdown (exit 0).

## 2. Architecture delivered

```text
operator (endo harness …)                                cli/harness.ts
        │
        ▼
PiAttachmentV0  identify → compare → record → notify      adapters/pi/attachment.ts
        │        local checks (automatic) / live study (authorized only)
        │        session: launch, catch-up, live events, reconnect, controls
        ▼
PiRpcClientV0   documented commands, validated responses   adapters/pi/rpc.ts
        ▼
RpcConnectionV0 JSONL framing, ID correlation, process     adapters/rpc-jsonl/  (shared with Prime)
                group, bounded shutdown, stderr apart
        ▼
user-installed `pi --mode rpc …`   (spawned directly, never through a shell)

records:  protocol/harness.ts       fingerprint · change · capability evidence · capability state · notification ·
                                    opaque source entry reference
storage:  storage/harness-registry  per-attachment append-only frame log of those records
          storage/event-store       endo.event.v0 stream (durable, replayable)
          storage/artifacts         content-addressed check transcripts the evidence cites
```

### Fingerprint and change lifecycle

`identify()` resolves the executable (explicit `--pi` path, else `pi` on `PATH`; empty and relative `PATH` entries
are skipped), follows symlinks, hashes the real file, reads the nearest `package.json`, and runs `<pi> --version` once
with a 15 s bound, bounded output, and `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0`.

The record (`endo.harness-fingerprint.v0`) separates **local facts** (requested, resolved path, real path, entrypoint
SHA-256 and size, package name/version/root) from **reported facts** (version output, parsed semver). Every missing
fact is listed in `gaps` with its reason; the validator rejects a gap list that disagrees with the null facts.

- **Identity digest**: SHA-256 over runtime, real path, entrypoint digest, package name and version, reported version.
- **Confidence**: `strong` when both the entrypoint digest and a parsed version exist; otherwise `reduced`.
- **Scope, plainly**: the entrypoint digest covers one file (`dist/bundle/cli.js` for npm installs of 1.0.0). It does
  not cover what that file loads: node_modules, the Node binary, user configuration or extensions. The package
  manifest is a local claim, not verified provenance. Pi is launched by its resolved path after fingerprinting; a
  reinstall between the two would go unnoticed until the next attachment fingerprints again.

Each observation is its own record. `piChangeV0` compares it with the previous one for the same attachment:

| Case | Record | Notification |
| :--- | :--- | :--- |
| First attachment | `first-observation` | "Pi runtime observed for the first time" |
| Same identity | `unchanged` (new fingerprint record, same digest) | none |
| Different version, rebuild, other executable, downgrade | `changed`, with `differences` and an informational `versionOrder` (`higher`/`lower`/`equal`/`incomparable`/`unknown`) | "Pi runtime changed" |
| Unparseable/failed `--version` | fingerprint with a `version` gap and `reduced` confidence | as above |
| Nothing identifies the runtime | `collection-failed` with the reason; no session opens | "Pi runtime could not be identified" |

Every notice ends with: *Endophasia will not install, update, downgrade or replace Pi. If you want a different version,
use your normal installation method.* No notice says an update is available; a comparison cannot know that.

### Evidence validity (adapters/pi/evidence.ts)

An `endo.capability-evidence.v0` record applies to the current attachment only when **all** hold:

1. the runtime is identified now;
2. same identity digest;
3. both identities `strong` — or the evidence was recorded against this very observation (reduced identities never
   carry evidence across observations);
4. same `adapterVersion`, `mappingVersion`, `suiteVersion` (`adapters/pi/version.ts`);
5. same definition digest of the check that produced it (rewording one check invalidates only its evidence);
6. same configuration digest for the check kind. Every kind depends on Pi's behaviour-relevant user configuration
   (`adapters/pi/configuration.ts`: `settings.json`, `models.json`, `mcp.json`, system-prompt and instruction files,
   `extensions/`, `skills/`, `prompts/` in the agent directory, and non-secret `PI_*` switches; never `auth.json`).
   The live study also depends on provider, model and the tool set it ran with;
7. same extension dependency (none in this version).

**Combining what applies.** No check kind outranks another by default: a live study is narrower in scope (one provider,
one model, one scratch workspace) as often as it is stronger, so it must not silently replace broader protocol
evidence. Per capability:

- the latest applicable record of each check is kept (a re-run replaces that check's earlier result);
- a record is dropped only when another present, applicable check **declares** in its definition that it supersedes
  that check for that capability. One declaration exists: the live study supersedes the local state check for
  `session.identity` (it re-tests a stable session id across two processes, a strict superset). The declaration is part
  of the check's definition digest;
- the most conservative classification among the rest decides (`MISMATCH` › `UNAVAILABLE` › `PARTIAL` › `QUALIFIED` ›
  `EXACT`), and the reason names every disagreeing check.

With nothing applicable, the capability is `unverified` — whatever earlier evidence said and even if Pi starts fine.
Statuses follow
the canonical `EndoConformanceClassificationV0` vocabulary exactly: `EXACT`/`QUALIFIED` → `admitted`, `PARTIAL` →
`admitted-partial`, `UNAVAILABLE` → `unavailable`, `MISMATCH` → `mismatch`. A result the observation cannot decide is
**inconclusive** and records nothing.

Capability state is derived state, not authority: it creates no runtime-admission, promotion or permission record.

### Checks

| Kind | When | What it does |
| :--- | :--- | :--- |
| documented-surface review | automatic, for a **reviewed release** (1.0.0) | records absences documented for that release (no run ids, no operation outcome). Evidence about that release's documentation, so it cannot apply to another release |
| local protocol | automatic, skipped when current evidence covers it | one ephemeral `--no-session --offline --no-tools` Pi; state, cursor, tree, stats and configuration commands; **no prompt, no provider call, nothing persisted** |
| live study | only with explicit authorization (`--authorize-live-study`; `studyLive({ authorized: true })`) | scratch workspace and scratch session; prompts, Pi's `read` tool on a fixture file, steer/follow-up/abort mid-run, a second process on the same session id; also observes, on any release, whether lifecycle events or prompt responses carry run or operation identifiers. Runs agent work and calls the configured provider (may cost money) |

Transcripts of every check are stored content-addressed (JSON Lines); each evidence record cites its transcript
digest. After every check the runtime is fingerprinted again; if it changed while the check ran, nothing is recorded
and the change is recorded instead.

### Session recording and cursors

The attachment chooses a session id once (`<root>/harness/<attachment>/pi-session.json`) and launches
`pi --mode rpc --session-dir … --session-id …`. Then:

- `harness.attached` records the fingerprint, the process instance and the session id **Pi reported** (a mismatch with
  the requested id is recorded, not corrected).
- Durable entries arrive by `get_entries {since: <last recorded entry id>}` at start and at `turn_end`,
  `agent_settled` and `compaction_end`. Each becomes `session.entry-observed`, with an
  `endo.source-entry-ref.v0` (Pi session id + **opaque** entry id) and an event id derived from those two, so the same
  entry can never be stored twice. Leaf moves are recorded as `session.leaf-observed`.
- If Pi refuses the recorded cursor (the session was replaced or rewritten), the attachment reads everything and
  deduplicates (`harness.catch-up` mode `full-after-refusal`).
- Live events are observations of one process (`endo.event.pi-live.<instance>.<n>`). Pi does not replay them; a
  process exit is recorded (`harness.process-exited`, with `expected`), and reconnect starts a new instance and catches
  up durable entries. Live-event gaps are visible, never filled.
- Endophasia's event id and store sequence are its own; Pi's ids stay opaque payload fields.
- Payloads carry no message text, tool arguments or results, queued text, summaries or Pi refusal text. Streaming
  deltas (`message_start`/`message_update`/`tool_execution_update`/`bash_execution_update`) are counted, not stored.
  Unknown event types are stored by name only (`runtime.unrecognized-event`); malformed records become
  `harness.protocol-fault`.
- Extension dialogs (`select`/`confirm`/`input`/`editor`), which block Pi until answered, are answered `cancelled`
  (there is no operator UI) and recorded.
- Controls (`steer`, `follow_up`, `abort`, `set_model`, `set_thinking_level`) are offered only for `admitted` /
  `admitted-partial` capabilities. Each records `control.requested` then `control.accepted` (or `control.refused`):
  acceptance only; effects are whatever Pi's later events and entries show.

### Session lifecycle

Every recorded event of the attachment's stream is also folded into canonical `lifecycle.*` events
(`adapters/pi/lifecycle.ts`; vocabulary in `protocol/session-lifecycle.ts`). The fold is pure:
- each lifecycle event's id derives from the recorded event it interprets (`derivedFrom`, source `interpretation`);
- its `at` and coordinates are copied from that recorded event, and its sequence counts the lifecycle stream.

So the same recording always yields byte-identical lifecycle events. On open, the attachment re-derives and stores any
lifecycle event a crash kept it from storing; deterministic ids mean this never stores one twice.

| Pi record (Pi 1.0.0 docs) | Lifecycle |
| :--- | :--- |
| `get_state.sessionId` at attach | `session-started`, or `session-resumed` for a session recorded before (with how the previous observation ended) |
| `agent_start` while idle; a later `agent_start` before `agent_settled` | `run-started`; the later one is a continuation (retry, overflow recovery, follow-up) |
| `turn_start` / `turn_end` | `turn-started` / `turn-completed`, with the reported `stopReason` |
| `agent_settled` | `run-completed`, `run-failed`, `run-aborted` or `run-unclassified`, from the run's last assistant stop reason |
| `abort` request, response | `stop-requested`, then `stop-accepted` or `stop-refused` |
| `harness.process-exited` | `interrupted` (cause `runtime-exited`) with a run open, else `detached` |
| an attach after an instance with no recorded exit | `interrupted` (cause `observer-lost`), carrying the store recovery report recorded as `harness.store-opened` |
| `compaction_end` with a `result` | `compacted` |
| an unknown event type | `unrecognized-runtime-event` |
| a record out of lifecycle order | `anomaly` |

How the outcome at `agent_settled` is decided:
- `run-failed` when the last assistant stop reason is `error`, or when the retry loop gave up. Its cause is Pi's own
  `errorMessage` or `finalError`.
- `run-aborted` when the last stop reason is `aborted`.
- `run-unclassified` when no stop reason was observed.
- `run-completed` otherwise.

Pi answers `abort` only once the session is idle (`rpc-commands.md#abort`), so a STOP's acceptance normally arrives
after `run-aborted`. Neither is inferred from the other.

A cause enters canonical evidence only by reference (mapping `pi-rpc-mapping.2`):
- its source (the Pi record and field);
- the sha256 and UTF-8 length of the text;
- whether the text was cut at 65,536 characters;
- a classification from a closed vocabulary (`rate-limited`, `overloaded`, `timeout`, `authentication`,
  `context-length`, `network`, `server-error`, `client-error`, `unclassified`), by fixed patterns over the text.
  Pi reports no category; this is Endophasia's.

The text itself goes to `<root>/runtime-text/artifacts/<sha256>`, outside the event log, its record digests and any
committed fixture.

`reduceEndoSessionOverviewV0` (`runtime/contracts/session-overview.ts`) reduces the lifecycle events to an
`endo.session-overview.v0`. `endo harness overview <root>` prints it, read-only. Run and turn ids, the operation
outcome, STOP targeting and lanes are UNAVAILABLE, each with its reason.

## 3. Capability mapping: fork adapter → Pi 1.0 RPC

Classification column: the result recorded against one real Pi 1.0.0 installation, with Pi's provider pointed at a local
fake endpoint (`research/pi-conformance/1.0.0/`, whose README lists what that recording does **not** establish). It is
evidence for that fingerprint and configuration only; another release or configuration starts unverified.

| Fork-era capability | Pi 1.0 surface | New capability | Real 1.0.0 result | Disposition |
| :--- | :--- | :--- | :--- | :--- |
| Mission Trace v0 (`harness.events`) | `agent_start/end/settled`, `turn_start/end`, `message_end`, `tool_execution_*` | `lifecycle.trace` | PARTIAL | available; no run/turn ids, no resume/suspend |
| — run/turn ids | none on any lifecycle event | `run.identity` | UNAVAILABLE (review and observation agree) | needs upstream change (declined: #3682) |
| Runtime Metrics v0 (`watch().stats`) | `get_session_stats` | `runtime.metrics` | PARTIAL | available; cost total only, no reasoning/1h-cache in stats |
| Operation Outcome v0 (`getResult`) | none | `operation.outcome` | UNAVAILABLE (review and observation agree) | needs upstream change; not inferred |
| Usage v0 ledger (`scanUsage`, integer seq) | per-entry `usage` via `get_entries`, opaque cursor | `usage.entries` | EXACT | available; integer ledger replaced by opaque entry cursor (`endo.source-entry-ref.v0`) |
| Session Overview v0 (`lanes()`) | `get_state` | `session.overview` | PARTIAL | one session, no lanes, no operation id |
| Continuity v0 (`watch`, `findEntries`) | `get_tree`, `get_entries`, compaction `firstKeptEntryId` | `continuity.active-path` | QUALIFIED | context boundary derived from compaction entries |
| Continuity v0 active tool names; Control Deck `setActiveTools` | none (`get_active_tools` → "Unknown command") | `control.active-tools` | UNAVAILABLE | optional extension (`pi.getActiveTools/setActiveTools`) — not built; upstream declined (#7432) |
| Control Deck model | `set_model` + `get_state` | `control.model` | EXACT | available (re-selection exercised) |
| Control Deck thinking | `set_thinking_level` + `get_available_thinking_levels` | `control.thinking` | QUALIFIED | available; only one level for the fake provider's model |
| Steering STEER | `steer` → `{disposition}` | `steering.steer` | PARTIAL | consumption observed; no receipt id |
| Steering QUEUE | `follow_up` → `{disposition}` | `steering.follow-up` | PARTIAL | as above |
| Steering STOP (`requestAbort(id)`) | `abort` (untargeted) | `steering.stop` | PARTIAL | cannot be confined to the observed run |
| Session identity | `get_state.sessionId`, `--session-id` | `session.identity` | EXACT (live study, declared to supersede the local QUALIFIED) | available after first message |
| Entry cursor | `get_entries {since}` | `session.entries-cursor` | EXACT | available |
| Tool activity | `tool_execution_start/end` by `toolCallId` | `tool.activity` | EXACT | available |
| Prime transport | — | `adapters/rpc-jsonl` | — | **reused**: extracted unchanged in behaviour, Prime keeps its names |
| Session-worker host facets, Chord services, lane ports | fork-only `createHostFacets` | — | — | **dropped**: no upstream equivalent with harness access |
| Browser listener, presentation client, browser cockpit | fork-only listener; unpublished experimental services | — | — | **dropped** (see §5); the operator view is `endo harness status/attach` |

## 4. Version baseline

Pi 1.0.0 is the **currently verified baseline**: the release whose documented RPC surface was reviewed, whose records
the deterministic suite's fake Pi models, and against which the attachment was run end to end. It is not a support
whitelist. Compatibility stays evidence-driven:

- `adapters/pi/version.ts` reports a version **standing** for the operator — `verified-baseline`,
  `unverified-release`, `unverified-prerelease` or `unknown` — and nothing reads it to admit, refuse or skip anything.
- Every release, the baseline included, is admitted capability by capability on current evidence for its own
  fingerprint and configuration. A later, earlier or locally built release runs the same automatic local checks and,
  when the operator authorizes it, the same live study, and earns the same admissions if it behaves the same.
- The one record tied to the baseline is the documented-surface review, because it is evidence about that release's
  documentation. On another release the live study observes the same absences directly.
- A downgrade is a change like any other. An unparseable version reduces identity confidence unless the entrypoint
  digest exists; reduced evidence is never reused across observations.

What the baseline claim covers is narrow on purpose: one release, one platform (Linux, Node 22.22), one provider path
(Pi's `openai-completions` API against a local fake endpoint), no extensions, no project configuration.

## 5. Migration dispositions

| Removed | Reason | Replacement |
| :--- | :--- | :--- |
| `pi/` submodule, `.gitmodules`, npm workspaces, tsconfig `paths`, vitest aliases | vendored fork; pin only in a renamed repo | none: no Pi package is a dependency |
| `adapters/pi/{continuity,control-deck,durable-outcomes,mission-trace,observation-sources,ports,runtime-metrics,session-overview,steering,usage-feed,usage-ledger}.ts` | written against `pi-agent-core`'s removed harness API | `adapters/pi/{rpc,mapping,checks,attachment}.ts` (§3) |
| `runtime/{server,session-worker}.ts` | fork-only `sessionWorkerEntryUrl` / `createHostFacets` | the attachment launches `pi --mode rpc` |
| `runtime/{browser-server,browser-listener,cockpit,cockpit-host,cockpit-main}.ts`, `presentation/*`, `cockpit/*` | spoke Pi's private Chord services over a fork-only listener; unrunnable against an installed Pi | `endo harness status|attach` (CLI). A browser cockpit over Endophasia's own store is future work |
| `runtime/contracts/{continuity,continuity-facet,inspector,mission-trace,runtime-facts,runtime-profile,runtime-profile-facet,usage,usage-facet}.ts`, `runtime/ports.ts`, `runtime/observation/ports.ts` | Chord facets for Pi's worker; lane-bound ports | capability state + event store |
| `scripts/check-browser-smoke.mjs`, `scripts/endophasia-browser-transport-smoke-entry.ts`, `scripts/check-cockpit-types.mjs`, `scripts/biome/*.grit` | browser bundle / donor lint plugin | none |
| devDependencies `ws`, `@types/ws`, `esbuild`; `protobufjs` override | used only by the removed browser path / Pi workspace | none |
| 29 test files and 9 test helpers/fixtures of the above | tested removed modules | `tests/pi-*.test.ts`, `tests/endo-pi-boundary.test.ts` |

Kept: every protocol schema (the fork-era v0 observation schemas remain valid neutral contracts; the Prime study uses
them), `runtime/contracts/{canonical-json,event-store,event-replay,immutability}.ts`, `runtime/admission.ts`,
graph, visualization, lab, evolution, trust, models, collab, storage, cli, provider adapters, Prime/Codex/REEF/trust
mappings and all research.

## 6. Upstream gaps and requests

Search of `earendil-works/pi` issues (2026-10-03):

| Gap | Existing issue | Recommendation |
| :--- | :--- | :--- |
| Run/turn/command ids on events | #3682 "streaming events are not tagged with originating command id" — closed **not planned** | do not re-file; keep `run.identity` UNAVAILABLE |
| `get/set_active_tools` over RPC | #7432 "Introduce get_tools and set_active_tools RPC commands" — closed **not planned** | do not re-file; an optional extension is the route if needed |
| Targeted abort + receipt ids for steer/follow_up | none found (closest: #8432 clear_queue on abort, #9098 prompt disposition — both about other fields) | draft below; not filed |
| Durable operation outcome | none found | folded into the draft below |

Draft (not filed; GitHub access in this session is limited to `noctem-o/endophasia`):

> **RPC: identify queued input and allow aborting a specific run**
>
> `steer`/`follow_up` respond with `{disposition}` only, and `queue_update` lists queued texts. A client cannot tell
> which queued message a later user entry consumed except by matching text, and `abort` stops whatever is current, so a
> client that observed run A can abort run B if A ended in between.
>
> Proposal (additive): (1) include the persisted entry id that a queued message will occupy — or a queue item id that
> later appears on the consuming entry — in `steer`/`follow_up` responses and `queue_update` items; (2) emit an opaque
> `runId` on `agent_start`/`agent_end`/`agent_settled`; (3) accept an optional `runId` on `abort` and refuse when it is
> not the current run. Existing clients are unaffected.

## 7. Local workaround vs extension vs upstream

- **Local** (implemented): opaque entry cursors; content-addressed entry event ids; explicit gap events; capability
  limitations recorded instead of inferred values.
- **Optional extension** (not built): active-tool inspection/control via Pi's documented extension API. If built, it is
  separately versioned, detected, and its identity becomes the `extension` evidence dependency.
- **Upstream** (§6): targeted abort, queue receipts, run ids, operation outcomes.

## 8. Tests and how to run them

```sh
npm ci
npm run typecheck          # tsc --noEmit
npm run lint               # biome check .
npm test                   # full deterministic suite (fake Pi child process, fake OpenAI endpoint)
ENDO_PI_EXECUTABLE=$(command -v pi) npm run test:pi-real   # opt-in: a Pi you installed; provider = local fake endpoint
```

- `tests/pi-rpc-transport.test.ts` — subprocess boundary: argv without shell, concurrency, out-of-order replies,
  interleaved events, 3-byte fragmented UTF-8, malformed/id-less/unknown-id records, refusals, malformed documented
  shapes, missing/non-executable binaries, immediate and mid-session exit, timeouts, orderly and forced shutdown, no
  orphan processes.
- `tests/pi-attachment.test.ts` — identity, all change cases, notices, local checks, reuse and invalidation, the
  authorization gate, live study, controls gating, recording, crash/reconnect/catch-up, lost cursor, protocol faults,
  replay, no installation mutation, no authority records.
- `tests/pi-evidence-rules.test.ts` — validators, deterministic comparison, validity one dependency at a time, state
  precedence, version policy, mapping identity and payload minimality.
- `tests/endo-provider-fake-endpoint.test.ts` — the OpenAI-compatible adapter over real HTTP: request construction,
  SSE split across writes, usage, malformed bodies, HTTP/transport errors and retry classification, digests. The
  adapter buffers complete SSE bodies: no incremental streaming is claimed.
- `tests/pi-audit.test.ts` — the adversarial audit (pi-attach-audit.md): evidence combination, runtime and
  configuration changes during and between checks, reconnect after replacement, concurrent writers, blocking dialogs,
  undocumented identifiers, non-baseline releases.
- `tests/endo-pi-boundary.test.ts`, `tests/endo-host-import-boundary.test.ts` — architecture guards.
- `tests/pi-real-runtime.test.ts` — opt-in real Pi.
