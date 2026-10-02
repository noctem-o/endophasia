# Endophasia Migration Ledger

Migration of the demonstrated Endophasia v0 from the Pi-fork monorepo
(`../endophasia-source/`, the DONOR — read-only) into this standalone
repository (the TARGET). This ledger records, per component, where it came
from, where it goes, what changes, and which demonstrated tests protect it.

## 1. Precedence and vocabulary

When donor code and target design conflict, priority is:

1. This repository's `README.md` architecture (the architectural contract).
2. The demonstrated semantics and their tests in the donor (the baseline).
3. A clean runtime-neutral design consistent with both.
4. The current donor layout.

The donor layout is **not** authoritative: the target tree follows the README
"suggested repository shape", and the old `packages/endophasia/src`
partition is preserved only where it marks a demonstrated boundary.

Dispositions:

- **KEEP** — copy into the target with path/import updates only; semantics
  and wire shape unchanged.
- **ADAPT** — move and modify imports/structure; demonstrated semantics
  unchanged; protected by the same tests (re-targeted).
- **REWRITE** — re-derive a module in the target design (e.g. split a
  contract from its Pi coupling); demonstrated semantics and wire shape
  unchanged; protected by the same tests plus the boundary guards.
- **RETIRE** — remove; no demonstrated consumer in the target.
- **DEFER** — a later mission phase; recorded here so it is not lost.

## 2. Baseline record

Recorded 2026-10-02 at donor HEAD `ab4caf5a0`
(Merge PR #27 "research/conformance-lab-v0").

- Install: `npm ci --no-audit --no-fund` at the donor root (341 packages).
- Prerequisite: `cd packages/ai && npm run hydrate-model-data` — six test
  suites reference gitignored generated provider data
  (`packages/ai/src/providers/data/*.json`); without it they fail on missing
  files. Run once per checkout.
- Suite: `npx vitest --run` in `packages/endophasia` (node env,
  testTimeout 30 s).
- **Result: 43/43 test files, 1522 passed, 3 skipped, 0 failed** (~96 s;
  the runtime/presentation suites start real servers and Session worker
  processes).

Re-measured 2026-10-02 (same donor HEAD, clean worktree, two
consecutive runs): **1578 passed, 3 skipped (1581 total)** — the
donor suite is stable at 1581. The original 1522 capture stands as
recorded; no donor change explains the +59, so the original capture is
attributed to a transient checkout state [INFERENCE]. The effective
parity reference is the re-measured donor: the target matches the
donor per-file on all 43 files, with one intentional exception —
`prime-research-boundary.test.ts` carries +2 tests because its guard
`it.each` root list was expanded 4 → 6 trees to cover the target
split (§7.4).

This is the "demonstrated semantics" reference: every migrated test must
pass against the pinned Pi checkout in this repository with the same
observable behaviour.

## 3. Pi integration decision

**Decision: a git submodule at `pi/` pinned to the donor fork's HEAD
`ab4caf5a0d3a245ccc29a97a13283b93f9174f78`
(`https://github.com/noctem-o/endophasia.git`), plus npm workspaces
spanning `pi/packages/*` and `pi/packages/session-backends/*`.**

Evidence:

1. **All 13 Pi packages are consumed from source, never dist.** In the donor
   every `@earendil-works/*` specifier resolves through (a) root tsconfig
   `paths` to `packages/*/src/*.ts` for type-checking, (b) vitest aliases +
   `resolve.conditions: ["source"]` for tests, and (c)
   `packages/coding-agent/src/experimental/source-resolver.ts` (a
   `node:module.registerHooks` resolver) for Node processes. Tests import
   `AgentHarness` from the agent **source**
   (`../../agent/src/harness/agent-harness.ts`), never a package entry.
2. **The coding-agent experimental subpaths are source-only.**
   `@earendil-works/pi-coding-agent` exports only `.`, `./rpc-entry`,
   `./client`, `./experimental/plugin`; `files` excludes `dist/experimental`.
   The Endophasia host entries and presentation client import
   `experimental/server`, `experimental/session-worker`,
   `experimental/process`, `experimental/services/*` — none of which resolve
   from published npm. Consuming Pi from a git checkout is therefore the
   demonstrated mechanism, not a migration invention.
3. **Runtime workers self-resolve.** `source-resolver.ts` computes the Pi
   root from its own file location (`../../../..`) and reads **that
   checkout's** tsconfig `paths`. A worker process spawned from `pi/`
   therefore resolves every `@earendil-works/*` import from the submodule's
   source with zero standalone-side resolver machinery. The standalone only
   needs its own aliases for its own tests and type-checks.
4. **Pin choice — the fork extends Pi, so the fork HEAD is the pin.** The
   donor fork is not merely "upstream + `packages/endophasia`": it carries
   deliberate Pi-side extensions that the demonstrated worker composition
   depends on, and which do NOT exist at pure upstream. Verified by diffing
   donor `packages/` against the last upstream merge tip
   `cb7969d212836b8939001dce159fbd2ed6ad395f` (parent of merge
   `6355e6ea7`):
   - `packages/coding-agent/src/experimental/session-worker.ts`
     (`createHostFacets` hook, `CodingAgentSessionWorkerHostRuntime`,
     `runCodingAgentSessionWorker(args, { createHostFacets })` — the hook
     `runtime/session-worker.ts` uses);
   - `packages/coding-agent/src/experimental/server.ts` +
     `services/worker.ts` + `session-worker-manager.ts` (trusted host
     listeners and worker plumbing);
   - `packages/agent/src/harness/session/{session,types,memory}.ts` (narrow
     `scanUsage` reader exposed to trusted host facets — the usage-ledger
     source);
   - `packages/agent/src/harness/session/testing/conformance/session-repo.ts`
     (+ tests, model-resolver Kimi-K3 default, coding-agent tests).
   `grep -c createHostFacets` on the pure-upstream pin returns 0; on the
   donor it returns 6. Pinning pure upstream would therefore break the
   demonstrated worker contract, so `pi/` = the donor fork at
   `ab4caf5a0d3a245ccc29a97a13283b93f9174f78` — exactly the Pi state the
   §2 baseline (43/43, 1522 passed) ran against. `cb7969d21` is recorded as
   the last upstream merge tip for future deliberate synchronization per
   item 5. The donor fork's own `pi/packages/endophasia`
   (`@endophasia/core`, deps: chord + pi-agent-core only, dist-only exports)
   remains a workspace member but is inert: nothing in the standalone
   imports it, and it is not built — the standalone's own `protocol/
   runtime/ adapters/` tree is the canonical home of the migrated code.
5. **Upstream methodology.** `docs/pi-upstream.md` (donor) requires the
   explicit upstream remote and pinned revisions; Pi remains the reference
   runtime, not authority. The standalone keeps this: `pi/` is a pinned
   checkout (donor fork HEAD, which tracks upstream), and `pi-upstream.md`
   is migrated with the boundary docs.
6. **Workspaces.** The donor root workspaces are `packages/*`,
   `packages/session-backends/*`, and five example extension workspaces.
   The standalone declares only the first two (retargeted under `pi/`),
   excluding the examples so their dependencies do not enter the install.
   npm links the Pi packages into the root `node_modules` and installs their
   external dependencies (photon-node, ws, typebox, …); the standalone's
   own code is a single root package (no `packages/` wrapper), matching the
   README tree.

Consequences:

- `pi/packages/endophasia` does not exist at the pinned upstream commit
  (Endophasia was added by the fork), so there is no duplicated Endophasia
  inside the submodule.
- The standalone's tsconfig `paths` and vitest aliases point at
  `pi/packages/*/src`; the runtime host entries load
  `pi/packages/coding-agent/src/experimental/source-resolver.ts` via
  `node --import` exactly as the donor does.

## 4. Target layout (Phase 0)

Only directories with a concrete Phase 0 purpose are created; the rest of
the README tree is deferred.

```text
endophasia-standalone/
├── pi/                    # git submodule — pinned upstream Pi monorepo
├── protocol/              # Pi-free v0 wire schemas + capability catalogue
│   ├── mission-trace.ts
│   ├── runtime-facts.ts
│   ├── usage.ts
│   ├── continuity.ts      # REWRITTEN Pi-free (see §6)
│   ├── runtime-profile.ts # capability catalogue + RuntimeProfileV0
│   ├── session-overview.ts# REWRITTEN Pi-free (see §6)
│   ├── steering.ts        # receipt/rejection types (from steering.ts)
│   └── control.ts         # control state/receipt types (from control-deck.ts)
├── runtime/
│   ├── observation/
│   │   └── ports.ts       # the four neutral observation ports (KEEP)
│   ├── contracts/         # Chord service definitions + facets
│   │   ├── index.ts       # public contract surface (was src/index.ts)
│   │   ├── mission-trace.ts
│   │   ├── runtime-facts.ts
│   │   ├── usage.ts       # includes usage-facet logic (parse, copies, facet)
│   │   ├── continuity.ts  # includes continuity-facet logic (remote limit)
│   │   ├── runtime-profile.ts # includes profile validator + facet
│   │   └── inspector.ts
│   ├── session-worker.ts  # composition root (PI_STANDARD_RUNTIME_PROFILE_V0)
│   ├── server.ts
│   ├── browser-server.ts
│   ├── browser-listener.ts
│   ├── cockpit.ts         # esbuild asset build + host+server launch
│   ├── cockpit-host.ts
│   └── cockpit-main.ts
├── adapters/
│   ├── pi/                # the Pi boundary (type-only Pi imports; one value)
│   │   ├── observation-sources.ts  # was src/pi-runtime-observation.ts
│   │   ├── mission-trace.ts        # observe/attach projections
│   │   ├── runtime-metrics.ts
│   │   ├── durable-outcomes.ts
│   │   ├── usage-ledger.ts
│   │   ├── usage-feed.ts
│   │   ├── continuity.ts
│   │   ├── session-overview.ts     # capture only
│   │   ├── steering.ts
│   │   └── control-deck.ts
│   └── prime/
│       └── transport/     # was runtime/prime/ (jsonl, limits,
│                          # process-group, rpc-connection, runtime-identity)
├── presentation/
│   ├── client.ts
│   └── websocket-transport.ts
├── cockpit/               # browser cockpit (KEEP; own tsconfig, DOM lib)
│   ├── main.ts  view.ts  controller.ts  view-model.ts
│   ├── lifecycle.ts  bootstrap.ts  index.html  styles.css
├── research/              # quarantined (KEEP; never imported by production)
│   ├── conformance/
│   └── prime-conformance/
├── tests/                 # migrated suites + helpers + fixtures
├── docs/                  # this ledger + migrated boundary docs
├── scripts/               # check-browser-smoke.mjs (rewritten), type checks
├── package.json           # private root package "endophasia"
├── tsconfig.json          # paths → pi/packages/*/src; excludes cockpit DOM files
├── cockpit/tsconfig.json  # extends root; lib + DOM
├── vitest.config.ts       # aliases → pi sources; conditions ["source"]
├── biome.json  .gitignore  LICENSE.md  README.md
```

Dependency direction (README:982+): `protocol` → `runtime/contracts` →
`adapters` → host entries / `presentation` / `cockpit`. The core rule
(README:978): core contracts do not import concrete providers.

## 5. Component ledger

Source paths are relative to the donor `packages/endophasia/`. "Protects"
lists the donor test file(s) whose semantics must survive.

### 5.1 Neutral observation ports

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `src/runtime-observation.ts` | `runtime/observation/ports.ts` | **KEEP** |

The four ports — `RuntimeMissionTraceSourceV0`, `RuntimeMetricsSourceV0`,
`RuntimeOperationOutcomeSourceV0`, `RuntimeUsageSourceV0` (plus the optional
aggregate `RuntimeObservationSourcesV0`) — are the runtime-neutral boundary.
The module's only import is `type Context` from `@earendil-works/chord`.
Also carries `UsageFeedListenerV0`, `UsageFeedSubscriptionV0` (idempotent
unsubscribe), `RuntimeUsageTailV0`.

- Deps: chord (type-only).
- Risks: none — already neutral.
- Protects: `runtime-observation-boundary.test.ts` (fake runtimes prove the
  facets work from neutral capabilities alone; import-graph assertions).

### 5.2 Protocol schemas (wire definitions)

The schema halves of the six service modules split out of the donor
`src/*-service.ts` files into `protocol/` (REWRITE as a pure move; wire
shape byte-identical), plus one new shared-primitives module:

| Source (schema content) | Target | Disposition | Notes |
| :--- | :--- | :--- | :--- |
| (new; neutral re-derivation of Pi literals, §6) | `protocol/primitives.ts` | **ADAPT** | `OperationStatusV0 = "running" \| "open" \| "aborting"` (Pi `agent-harness.ts:147`), `ThinkingLevelV0` (Pi `types.ts:345`), `ModelIdentityV0 { provider, modelId }` (Pi `agent-harness.ts:142`); identical wire literals, shared by the session-overview / steering / control / runtime-facts / continuity schemas. The message role of a continuity entry is NOT a shared primitive: the pinned fork's `CustomAgentMessages` is non-empty (`harness/messages.ts:55–60`), so the donor's role type is the full 8-literal `AgentMessage` role union, redefined locally in `protocol/continuity.ts` |
| `src/mission-trace-service.ts` (event union, limits, observation type) | `protocol/mission-trace.ts` | **REWRITE** | `MissionTraceEventV0` discriminated union on `kind`; `MISSION_TRACE_REPLICATED_EVENT_LIMIT = 1024`; observation = bounded window since worker activation, NOT durable, sequence restarts at 1 |
| `src/runtime-facts-service.ts` (metrics + outcome types) | `protocol/runtime-facts.ts` | **REWRITE** | `RuntimeMetricsV0` (cumulative session accounting incl. failed/retried/aborted; not context occupancy, not invoice); `OperationOutcomeV0` (immutable terminal record) |
| `src/usage-service.ts` (ledger types) | `protocol/usage.ts` | **REWRITE** | `UsageLedgerQueryV0` (defaults 0/1000, max 10000), `UsageLedgerRowV0` (session-global sequence, gaps normal, no lane/cause/timestamp), `UsageLedgerPageV0` (not atomic), `USAGE_REPLICATED_ROW_LIMIT = 1024`, `UsageObservationV0` (sticky `hasEarlierRows`) |
| `src/continuity-service.ts` (entry + snapshot types) | `protocol/continuity.ts` | **REWRITE** | see §6 for the Pi-free re-derivation |
| `src/runtime-profile-service.ts` (catalogue + profile type) | `protocol/runtime-profile.ts` | **REWRITE** | `ENDOPHASIA_RUNTIME_CAPABILITY_IDS_V0` — the closed six-ID catalogue in canonical order (session-overview, mission-trace, runtime-metrics, operation-outcome, usage, continuity); Endophasia semantics, not Chord service IDs; Runtime Metrics and Operation Outcome are separate capabilities though one service exposes both |
| `src/session-overview.ts` (overview types) | `protocol/session-overview.ts` | **REWRITE** | see §6 |
| `src/steering.ts` (receipt/rejection types) | `protocol/steering.ts` | **REWRITE** | `SteeringReceiptV0`, `SteeringActionV0`, `SteeringRejectionReasonV0`, `SteeringActionResultV0` — Pi-free strings/ids only; acceptance ≠ consumption semantics preserved in docs |
| `src/control-deck.ts` (state/receipt types) | `protocol/control.ts` | **REWRITE** | `ControlStateV0`, `ControlReceiptV0` ("Pi accepted the change and Endophasia then observed this configured value"); `ModelIdentity` leak → neutral `{provider, modelId}` (identical to the Pi shape, `agent-harness.ts:142`) |

Protects (all): the corresponding `*-service.test.ts` Chord binding suites
over the strict-JSON wire.

### 5.3 Contracts (Chord services + facets)

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `src/mission-trace-service.ts` (service + facet) | `runtime/contracts/mission-trace.ts` | **REWRITE** | schema half to `protocol/mission-trace.ts` |
| `src/runtime-facts-service.ts` (service + facet) | `runtime/contracts/runtime-facts.ts` | **REWRITE** | schema half to `protocol/runtime-facts.ts` |
| `src/usage-service.ts` (service) | `runtime/contracts/usage.ts` | **REWRITE** | schema half to `protocol/usage.ts` |
| `src/usage-facet.ts` (facet logic) | `runtime/contracts/usage-facet.ts` | **ADAPT** | query parsing, payload copies, `createEndophasiaUsageFacetV0` — chord-only |
| `src/continuity-service.ts` (service) | `runtime/contracts/continuity.ts` | **REWRITE** | schema half to `protocol/continuity.ts` |
| `src/continuity-facet.ts` (facet logic) | `runtime/contracts/continuity-facet.ts` | **ADAPT** | `withinRemoteLimit` (8 MiB, fail never truncate), `createEndophasiaContinuityFacetV0` — type-only Pi `AgentLane` handle |
| `src/runtime-profile-service.ts` (service) | `runtime/contracts/runtime-profile.ts` | **REWRITE** | schema + catalogue half to `protocol/runtime-profile.ts` |
| `src/runtime-profile-facet.ts` (facet logic) | `runtime/contracts/runtime-profile-facet.ts` | **ADAPT** | `runtimeProfileV0` validator, `createEndophasiaRuntimeProfileFacetV0` — chord-only |
| `src/inspector-service.ts` (service + facet) | `runtime/contracts/inspector.ts` | **ADAPT** | type-only `AgentHarness` handle |
| `src/index.ts` | `runtime/contracts/index.ts` | **ADAPT** | public contract surface, re-targeted |

- **Status (milestone c, done):** all ten modules are migrated, including
  the barrel `runtime/contracts/index.ts` (donor `src/index.ts` name set,
  re-targeted per module). The non-schema halves of `mission-trace`,
  `runtime-facts`, `usage-facet`, `continuity-facet`, and
  `runtime-profile-facet` are verbatim against the donor, retargeted only
  for imports.

- Service identities unchanged: `endophasia.mission-trace.v0`,
  `endophasia.runtime-facts.v0`, `endophasia.usage.v0`,
  `endophasia.continuity.v0`, `endophasia.runtime-profile.v0`,
  `endophasia.inspector.v0` (plus `endophasia.session-overview.v0` semantics
  inside the inspector service).
- Facet semantics preserved: mission-trace facet (BACKGROUND_CONTEXT,
  payload-minimal copies); runtime-facts facet requires BOTH sources and
  never synthesizes; usage facet (plain-object query parsing, bounded
  window reseeded from ledger tail); continuity facet (8 MiB remote limit —
  oversize FAILS, never truncates; failed capture fails the call, never an
  empty snapshot); runtime-profile facet (one immutable validated copy;
  malformed profile = bug, not input).
- **Known v0 seam (kept as demonstrated):** the inspector facet takes
  `Pick<AgentHarness, "lanes">` and the continuity facet takes
  `Pick<AgentLane, "watch" | "findEntries">` — type-only Pi handles,
  constructor-argument-only coupling, exactly as the donor boundary doc
  sanctions ("seam to widen or wrap"). These two facets are browser-forbidden
  (see §7) but the cockpit reaches their contract types type-only.
- Risks: splitting a file that currently mixes schema/service/facet must not
  change any exported name the tests or worker import.
- Protects: `mission-trace-service.test.ts`, `runtime-facts-service.test.ts`,
  `usage-service.test.ts`, `continuity-service.test.ts`,
  `runtime-profile-service.test.ts`, `inspector-service.test.ts`,
  `runtime-observation-boundary.test.ts`, plus every runtime-host suite that
  exercises the facets over real transports.

### 5.4 Pi adapter (the boundary)

All nine Pi projection modules plus the aggregate seam move to
`adapters/pi/`. They are the only production modules allowed to import
`@earendil-works/pi-agent-core` (type-only, except one value — see below).

| Source | Target | Disposition | Notes |
| :--- | :--- | :--- | :--- |
| `src/pi-runtime-observation.ts` | `adapters/pi/observation-sources.ts` | **ADAPT** | THE seam: `createPiRuntimeObservationSourcesV0(input): Required<RuntimeObservationSourcesV0>` — Pi supplies all four ports. Type-only Pi imports |
| `src/mission-trace.ts` | `adapters/pi/mission-trace.ts` | **ADAPT** | `observeMissionTraceV0` (finished events numbered from 1, no retention, listener-throw isolation), `attachMissionTraceV0` (sync replay then live; cursor assertions) |
| `src/runtime-metrics.ts` | `adapters/pi/runtime-metrics.ts` | **ADAPT** | `projectStats(SessionStats)`, `captureRuntimeMetricsV0` — short-lived `lane.watch()`; read failures propagate |
| `src/durable-outcomes.ts` | `adapters/pi/durable-outcomes.ts` | **ADAPT** | `captureOperationOutcomeV0` — `undefined` → null; projected error → `errorCode` only |
| `src/usage-ledger.ts` | `adapters/pi/usage-ledger.ts` | **ADAPT** | `projectUsageLedgerRowV0` (shared by ledger+feed), `readUsageLedgerV0` (afterSequence exclusive; Pi fromSeq = afterSequence+1; MAX_SAFE_INTEGER guard; RangeError on bad range), `readUsageLedgerTailV0` (one descending read of limit+1; never replays the whole ledger) |
| `src/usage-feed.ts` | `adapters/pi/usage-feed.ts` | **ADAPT** | trusted precondition: same Pi harness+session (usage events carry no session identity); subscribe-then-replay-then-live; dedupe `seq > cursor`; at-least-once across reconnects; listener failure stops the feed without advancing past the failed row; slow listener backpressures the harness bus |
| `src/continuity.ts` | `adapters/pi/continuity.ts` | **ADAPT** | `projectEntry` (payload-minimal: `hasSummary` = summary.length>0, `hasData` = data!==undefined, terminate flag), `projectContinuity` (boundary = transcript[0]; compaction only if that boundary is a compaction entry), `captureContinuityV0` (watch → snapshot → findEntries oldestFirst → project → unsubscribe in finally) |
| `src/session-overview.ts` (capture half) | `adapters/pi/session-overview.ts` | **REWRITE** | `captureSessionOverviewV0(harness: Pick<AgentHarness,"lanes">, context)` moves with its only Pi dependency; types stay in `protocol/session-overview.ts` (§6) |
| `src/steering.ts` | `adapters/pi/steering.ts` | **ADAPT** | `steerV0` (durable steer queue), `queueFollowUpV0` (follow-up boundary), `stopV0` (cancels ONLY the run observed by `inspectExecution`; never retargets), `captureSteeringStateV0`. **The only VALUE Pi import in production src: `HarnessClosed`** — re-homed here with its rejection semantics |
| `src/control-deck.ts` | `adapters/pi/control-deck.ts` | **ADAPT** | `captureControlStateV0`, `configureModelV0`, `configureThinkingLevelV0`, `configureActiveToolsV0` (setter commits but failed readback rejects although config changed; nothing retried) |

- **Status (milestone c, done):** all ten modules are migrated with their
  test suites. `continuity.ts` and `session-overview.ts` (the two capture
  modules the contract facets import) landed in milestone b; the remaining
  eight in milestone c.

- **No neutral port yet** (steering, control-deck, session-overview capture,
  continuity capture): per the donor boundary doc, those need their own
  evidence before they get a boundary. Flagged for a later phase; Phase 0
  keeps them Pi-direct behind `adapters/pi/`.
- Risks: the adapter must keep importing the Pi types it needs by the same
  structural shape the tests exercise (real `AgentHarness`, real lanes).
- Protects: `continuity.test.ts`, `control-deck.test.ts`,
  `durable-outcomes.test.ts`, `mission-trace.test.ts` (node:vm isolation),
  `runtime-metrics.test.ts`, `session-overview.test.ts`, `steering.test.ts`
  (HarnessClosed rejection), `usage-feed.test.ts` (gap-safe, resume cursor),
  `usage-ledger.test.ts`, `runtime-observation-boundary.test.ts` (adapter
  layer), and the six `*-session-worker.ts` fixtures that install adapter
  facets.

### 5.5 Host entries (Node-only)

| Source | Target | Disposition | Notes |
| :--- | :--- | :--- | :--- |
| `runtime/session-worker.ts` | `runtime/session-worker.ts` | **ADAPT** | composition root: `PI_STANDARD_RUNTIME_PROFILE_V0` (frozen claim: schemaVersion `runtime-profile.v0`, scope `session-worker-lifetime`, runtimeFamily `pi`, adapterProfileId `endophasia.pi-standard.v0`, six capability IDs in canonical order) + `createEndophasiaSessionWorkerFacetsV0` (installs exactly six facets) + `runEndophasiaSessionWorker` entry guard (`isDirectInternalProcessEntry` + role `session-worker`) |
| `runtime/server.ts` | `runtime/server.ts` | **ADAPT** | `startEndophasiaServer` = Pi `startServer` with `sessionWorkerEntryUrl` bound to this file; `EndophasiaServerOptions` |
| `runtime/browser-server.ts` | `runtime/browser-server.ts` | **ADAPT** | adds the loopback WS listener; capability URL `ws://127.0.0.1:<port>/pi/<32-byte token>` |
| `runtime/browser-listener.ts` | `runtime/browser-listener.ts` | **ADAPT** | origin allowlist (canonical http/https only; wildcards/`null`/paths/patterns rejected), binary-only frames, pending-byte backpressure (default 4 × `DEFAULT_MAX_FRAME_LENGTH` from pi-protocol), graceful close, exactly-one-terminal error/close on `WebSocketByteConnection` |
| `runtime/cockpit.ts` | `runtime/cockpit.ts` | **ADAPT** | `buildCockpitAssets()` (esbuild in-memory bundle of `cockpit/main.ts`, platform browser/esm/es2022, `write:false`, plus index.html + styles.css) + launch |
| `runtime/cockpit-host.ts` | `runtime/cockpit-host.ts` | **KEEP** | 127.0.0.1-only; exactly 4 routes under `/c/<32-byte base64url token>/`; `timingSafeEqual`; constant-time prefix; exact-Host loopback authority check (403, DNS-rebinding guard); GET/HEAD only; no-cache; CSP `cockpitContentSecurityPolicy(websocketOrigin)`; 503 bootstrap until `setBootstrap` |
| `runtime/cockpit-main.ts` | `runtime/cockpit-main.ts` | **KEEP** | foreground CLI; strict parseArgs (provider/model/directory/port); prints page URL; SIGINT/SIGTERM stop |

- **Status (milestone d, done):** all seven host entries are migrated.
  `session-worker.ts` landed in milestone c (pulled forward because
  `runtime-profile-service.test.ts` imports
  `PI_STANDARD_RUNTIME_PROFILE_V0` from it, as in the donor); the
  remaining six landed in milestone d. `browser-server.ts`,
  `browser-listener.ts` and `cockpit-host.ts` are byte-identical to the
  donor (`cmp`); `server.ts` retargets only its loader-path comment
  (`packages/coding-agent/…` → `pi/packages/coding-agent/…`); `cockpit.ts`
  retargets only `REPOSITORY_ROOT` depth (`../../../` → `../`, so the
  in-memory esbuild bundle resolves the target root's `tsconfig.json`);
  `cockpit-main.ts` retargets only the comment script name (`npm run
  endophasia:cockpit` → `npm run cockpit`, the target root script).

- `cockpit-host.ts`, `cockpit-main.ts` and the prime transport have **zero**
  `@earendil-works` imports (verified) — KEEP means literal copy apart from
  relative-path fixes.
- Protects: `runtime.test.ts` (full server integration over unix transport),
  `session-host.test.ts`, `browser-server.test.ts` (e2e via the browser WS
  capability URL), `browser-listener.test.ts`, `cockpit-host.test.ts`,
  `cockpit-integration.test.ts`.

- Test placement: `browser-server.test.ts` migrates in milestone e with
  the `cockpit/` and `presentation/` modules it imports
  (`cockpit/controller.ts`, `presentation/client.ts`,
  `presentation/websocket-transport.ts`); the other four host suites
  migrated in milestone d.

### 5.6 Prime ingress

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `runtime/prime/jsonl.ts` | `adapters/prime/transport/jsonl.ts` | **ADAPT** |
| `runtime/prime/limits.ts` | `adapters/prime/transport/limits.ts` | **KEEP** |
| `runtime/prime/process-group.ts` | `adapters/prime/transport/process-group.ts` | **ADAPT** |
| `runtime/prime/rpc-connection.ts` | `adapters/prime/transport/rpc-connection.ts` | **ADAPT** |
| `runtime/prime/runtime-identity.ts` | `adapters/prime/transport/runtime-identity.ts` | **ADAPT** |

- **Status (milestone c, done):** all five files are migrated; each
  verified byte-identical to the donor via `cmp`.

- Pure Node; **zero** `@earendil-works` imports; zero external importers in
  the donor (grep-verified) — the transport layer of a Prime RPC ingress.
- Semantics: `PrimeRpcResponseV0` (`success: false` = refusal, not error),
  uninterpreted `PrimeRpcEventV0`, bounded-time shutdown, 64 MiB default
  record limit, `MAX_TIMER_MS` guard, `PrimeInstallationV0`
  (binary | source-checkout) — identity, not certification.
- **Installs 0 Endophasia capabilities** — admission stays DORMANT; this is
  the demonstrated state (README feature table: "It installs no Prime
  semantic capability").
- Sealed research evidence stays valid: Prime 0.9.7 study sealed at commit
  `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`, `candidateForPR27 = []`,
  report SHA-256 `d61a8b29…6a53`, golden inventory digest
  `7e9f090a…9ac`, probe `prime-conformance-v0@0.14.7`, capture commit
  `45adf6b1…0bda`, research hash `56e25aee…f0`.
- Protects: `prime-runtime-ingress.test.ts` (strict JSONL framing held to
  the research decoder by differential tests, correlation, ordered events,
  listener isolation, bounded lifecycle, runtime identity, hermetic env,
  import-graph boundaries; live smoke opt-in only via
  `ENDOPHASIA_PRIME_LIVE_SMOKE=1`, never CI).

### 5.7 Presentation

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `presentation/client.ts` | `presentation/client.ts` | **KEEP** |
| `presentation/websocket-transport.ts` | `presentation/websocket-transport.ts` | **KEEP** |

- `EndophasiaPresentationClientV0`: readonly `ReplicatedState` fields
  (connection, attachment, sessions, transcript, models, missionTrace,
  usage, runtimeProfile) + `attach/detach/sessionOverview/runtimeMetrics/
  operationOutcome/usagePage/continuitySnapshot/dispose`. The profile state
  is bound on its **own separate binding**; Pi clears all session bindings in
  the same turn as reporting attaching. `usagePage` sends `query ?? {}`
  (remote args cannot be undefined). `continuitySnapshot` fails over 8 MiB,
  never truncates. `dispose()` = one shared promise; AggregateError if
  cleanup also fails. Startup failure → dispose + AggregateError on cleanup
  failure; a throwing `onError` is ignored.
- `websocket-transport.ts`: duck-typed `BrowserWebSocket`
  (`WEBSOCKET_OPEN = 1`), binary-only, framed-CBOR bytes pass through
  unchanged, one arraybuffer socket per factory call, no reconnect,
  pending-byte backpressure (default `DEFAULT_MAX_FRAME_LENGTH * 4`).
- The Pi `Client` + `createServerServiceSource`/`createSessionServiceSource`
  + `Models`/`SessionDirectory`/`SessionManagement`/`Transcript` imports are
  the demonstrated presentation-side boundary (transport/service-source
  plumbing, value imports). Kept as-is in Phase 0; a neutral transport
  interface is a later phase.
- Protects: `presentation-client.test.ts` (all six services + profile
  hydration, degraded attachment proven by the six fixture workers,
  attach/detach/dispose), `websocket-transport.test.ts`,
  `runtime.test.ts`.
- **Status (milestone e, done):** `websocket-transport.ts` byte-identical to
  the donor (`cmp`-verified). `client.ts` is `cp` + retarget of its seven
  `../src/*` imports (diff-verified, import lines only): six schema
  type-imports → `protocol/{continuity,mission-trace,runtime-facts,
  runtime-profile,session-overview,usage}.ts`, six Chord service
  value-imports → `runtime/contracts/{continuity,inspector,mission-trace,
  runtime-facts,runtime-profile,usage}.ts`.

### 5.8 Cockpit (browser)

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `cockpit/main.ts` | `cockpit/main.ts` | **KEEP** |
| `cockpit/view.ts` | `cockpit/view.ts` | **KEEP** |
| `cockpit/controller.ts` | `cockpit/controller.ts` | **KEEP** |
| `cockpit/view-model.ts` | `cockpit/view-model.ts` | **KEEP** |
| `cockpit/lifecycle.ts` | `cockpit/lifecycle.ts` | **KEEP** |
| `cockpit/bootstrap.ts` | `cockpit/bootstrap.ts` | **KEEP** |
| `cockpit/index.html`, `cockpit/styles.css` | same | **KEEP** |

- Imports only: `presentation/client.ts` + `presentation/websocket-transport.ts`,
  chord `Context`/`BACKGROUND_CONTEXT`, and **type-only** Pi service state
  shapes (`ServerConnectionState`, `SessionAttachmentState`, `ModelsState`,
  `SessionDirectoryState`, `TranscriptState`). No value Pi imports.
- `view-model.ts` bounds: `PREVIEW_LIMIT 2000`, `TEXT_LIMIT 20000`,
  `MISSION_TRACE_ROW_LIMIT 50`, `USAGE_ROW_LIMIT 20`,
  `CONTINUITY_ENTRY_ROW_LIMIT 100`; reasoning content = activity marker
  only. `controller.ts`: 9-region burst-coalesced invalidation;
  `CockpitPresentation = Pick<EndophasiaPresentationClientV0, …>`;
  explicit-only captures. `lifecycle.ts`: pagehide → dispose always;
  pageshow → reload only when persisted. `bootstrap.ts`: parseBootstrap
  loopback `ws:` URL only.
- Own `cockpit/tsconfig.json` with `lib: ["ES2024", "DOM", "DOM.Iterable"]`;
  excluded from the root tsconfig (as in the donor).
- Protects: `cockpit-controller.test.ts`, `cockpit-view-model.test.ts`,
  `cockpit-lifecycle.test.ts`, `cockpit-compaction.test.ts` (real harness;
  compaction removes earlier entries; bounded projections),
  `cockpit-integration.test.ts` (import-graph assertions).
- **Status (milestone e, done):** `main.ts`, `view.ts`, `lifecycle.ts`,
  `bootstrap.ts`, `index.html`, `styles.css` byte-identical to the donor
  (`cmp`-verified). `controller.ts` (six type imports) and
  `view-model.ts` (five type imports) retargeted to
  `protocol/{continuity,mission-trace,runtime-facts,runtime-profile,
  session-overview,usage}.ts` (diff-verified, import lines only);
  `cockpit/tsconfig.json` `extends` retargeted to `../tsconfig.json`.
  `scripts/check-cockpit-types.mjs` (ADAPT of the donor
  `check-endophasia-cockpit-types.mjs`) passes with exactly one external
  diagnostic, `pi/packages/ai/src/api/openai-codex-responses.ts(403,8)`
  TS2769 — donor-identical.

### 5.9 Research (quarantined)

| Source | Target | Disposition | Notes |
| :--- | :--- | :--- | :--- |
| `research/conformance/` (5 files) | `research/conformance/` | **KEEP** | `files.ts` (plain/member path assertions), `json.ts` (canonicalJson: sorted keys, preserved array order, UTF-8 LF — "a local format, not RFC 8785"), `order.ts` (study-declared order, never fs order), `reference.ts` (`ReferenceMember {path, sha256}`, 16 MiB cap, `verifyReference` closed inventory, `publishReference` Linux-only atomic exchange), `repository.ts` |
| `research/prime-conformance/` (34 files) | `research/prime-conformance/` | **KEEP** | CLI chain (`cli.ts`, `cli-097.ts`, `offline-097.ts`), classification/comparison/probe/publication modules, sealed `audited-instrument-097.json` |
| `test/fixtures/prime/0.9.6/` (12 scenario JSONs), `test/fixtures/prime/0.9.7/` (report + 12 rpc + 15 acp), `test/fixtures/conformance/prime-097-reference.json` (28-file golden inventory) | `tests/fixtures/…` | **KEEP** | byte-identical; digests must not change |

- Never imported by production; guarded transitively (see §7.4).
- Prime 0.9.7 findings that travel with it: Overview + Continuity
  incompatible, Trace qualified fragments, Metrics qualified reconstruction,
  Outcome unavailable/incompatible, Usage qualified durable projection.
- Live gates (`check:prime-conformance*`) stay opt-in plain-node scripts
  (env `PRIME_AGENT_BIN`/`PRIME_AGENT_ROOT`), never CI.
- Protects: `conformance-lab.test.ts` (Linux-gated; SIGKILL crash-swap,
  process boundary), `conformance-prime-specimen.test.ts` (golden read-side),
  `prime-conformance.test.ts`, `prime-097-conformance.test.ts`,
  `prime-097-remediation.test.ts` + `prime-097-review2…7.test.ts`
  (hostile mutations, in-memory only), `prime-acp-probe.test.ts`,
  `prime-rpc-probe.test.ts`.
- **Status (milestone e, done):** 36 files copied; 15 path retargets,
  each diff-verified against the donor to change only the intended line:
  three donor-relative imports (`acp-client.ts` →
  `adapters/prime/transport/process-group.ts`; `mission-trace.ts` →
  `protocol/mission-trace.ts`; `projection.ts` → `protocol/runtime-facts.ts`
  + `protocol/usage.ts`), ten layout-depth fixes — the three CLIs read
  fixtures from `<root>/tests/fixtures/prime` (was
  `<package>/test/fixtures/prime`) and `repoRoot` is now `<root>` itself
  (two up, was four up): `offline-097.ts`, `cli-097.ts`, `cli.ts`
  (fixture root, repo root, comment), `command.ts` (doc comment) — and
  two instrument retargets: `instrument.ts` `INSTRUMENT_ROOT` two up
  (was four) and the `requireCleanResearchInstrument` entry
  `research/prime-conformance/cli-097.ts` (was
  `packages/endophasia/research/…`); the
  `prime-097-remediation.test.ts` synthetic temp repo was retargeted
  to the same layout.
  All data fixtures byte-identical (`diff -rq`: only the six retargeted
  worker `.ts` fixtures differ); fixture digests intact (the prime-097
  suites assert the report SHA-256, the 28-file golden inventory digest,
  the capture commit and the research hash).

### 5.10 Tests

`test/` → top-level `tests/` (README tree). Every test file is **ADAPT**:
imports re-targeted, semantics unchanged. Import re-targeting rules:

- `../../agent/src/harness/agent-harness.ts` → `../pi/packages/agent/src/harness/agent-harness.ts`
- `../../agent/src/harness/context.ts` → `../pi/packages/agent/src/harness/context.ts`
- `../src/index.ts` → `../runtime/contracts/index.ts`; `../src/<schema>` →
  `protocol/<name>.ts`; `../src/<service|facet>` →
  `runtime/contracts/<name>.ts`; `../src/pi-runtime-observation.ts` →
  `adapters/pi/observation-sources.ts`; `../runtime/prime/<module>` →
  `adapters/prime/transport/<module>.ts`; `../runtime/<module>` /
  `../presentation/<module>` / `../cockpit/<module>` / `../research/<module>`
  are same-depth and unchanged.
- Repo root from a test file: donor `packages/endophasia/test/x.test.ts`
  used `new URL("../../../", import.meta.url)`; target `tests/x.test.ts`
  uses `new URL("../", import.meta.url)`. Fixture files one level
  deeper (`tests/fixtures/<dir>/`) stay three up.
- Faux providers stay `@earendil-works/pi-ai` (workspace source).

The 43 test files, by protection target:

| Category | Files |
| :--- | :--- |
| Contract binding (strict-JSON wire) | `continuity-service.test.ts`, `inspector-service.test.ts`, `mission-trace-service.test.ts`, `runtime-facts-service.test.ts`, `runtime-profile-service.test.ts`, `usage-service.test.ts` |
| Neutral boundary (machine-verified) | `runtime-observation-boundary.test.ts` — import-graph assertions retargeted in (c) (§7.1) |
| Pi adapter (real harness) | `continuity.test.ts`, `control-deck.test.ts`, `durable-outcomes.test.ts`, `mission-trace.test.ts`, `runtime-metrics.test.ts`, `session-overview.test.ts`, `steering.test.ts`, `usage-feed.test.ts`, `usage-ledger.test.ts` |
| Runtime host (real servers/workers) | `runtime.test.ts`, `session-host.test.ts`, `browser-server.test.ts`, `browser-listener.test.ts` |
| Presentation/cockpit | `presentation-client.test.ts`, `websocket-transport.test.ts`, `cockpit-controller.test.ts`, `cockpit-view-model.test.ts`, `cockpit-lifecycle.test.ts`, `cockpit-compaction.test.ts`, `cockpit-host.test.ts` |
| Cockpit integration | `cockpit-integration.test.ts` — **UPDATE** import-graph assertions (§7.2) |
| Research/offline (no @earendil-works imports) | `conformance-lab.test.ts`, `conformance-prime-specimen.test.ts`, `prime-097-conformance.test.ts`, `prime-097-remediation.test.ts`, `prime-097-review2…7.test.ts`, `prime-acp-probe.test.ts`, `prime-conformance.test.ts`, `prime-research-boundary.test.ts` — **UPDATE** paths (§7.4), `prime-rpc-probe.test.ts`, `prime-runtime-ingress.test.ts` |

Helpers (KEEP + path fixes): `strict-json-transport.ts` (chord
`createFacetHost`/`createRemoteServiceBinding` over a strict-JSON wire with
`$chord.service` control calls; `HOST_REQUEST` context key),
`exact-usage-provider.ts` (faux provider reporting exact queued Usage),
`continuity-synthetic.ts` (arbitrarily long synthetic ancestry for the
8 MiB limit), `prime-097-controls.ts` (in-memory augmentation; never writes
to the fixture directory).

Fixtures (KEEP + path fixes): the six `*-session-worker.ts` degraded-entry
fixtures (`no-usage-`, `no-runtime-profile-`, `no-continuity-`,
`inspector-only-`, `inspector-and-trace-`, `large-continuity-`; each
`runCodingAgentSessionWorker` with a facet subset +
`consumeInternalProcessRole` guard; `no-continuity-` and
`inspector-and-trace-` additionally import the Pi observation seam), the
prime fixture trees (§5.9), and the `fake-*.mjs` servers
(`fake-acp-server.mjs`, `fake-rpc-server.mjs`, `fake-prime-rpc.mjs`,
`fake-reference-swap.mjs`, `publication-child.mjs`).
- **Status (milestone e, done):** 43 `.test.ts` files + 4 helpers + 53
  fixture files in place (donor count: 43). Fifteen suites +
  `prime-097-controls.ts` byte-identical to the donor (same-depth
  `../research/…` and `./fixtures/…` specifiers). Retargeted: the six
  worker fixtures (imports → `runtime/contracts/*` +
  `adapters/pi/observation-sources.ts`); `browser-server.test.ts` +
  `presentation-client.test.ts` (source-resolver `new URL` →
  `pi/packages/coding-agent/src/experimental/source-resolver.ts`);
  `cockpit-compaction.test.ts` (five agent-harness imports →
  `pi/packages/agent/…`); `cockpit-controller.test.ts` (barrel +
  session-overview); `cockpit-view-model.test.ts` (five schema type
  imports → `protocol/*`); `prime-rpc-probe.test.ts` (barrel `new URL`);
  `conformance-prime-specimen.test.ts` (repo root three-up → one-up;
  two `packages/endophasia/…` paths → target layout);
  `prime-097-conformance.test.ts` (repo root depth for
  `sourceDigestAtCommit`); `prime-097-remediation.test.ts` (synthetic
  temp-repo layout → target layout: entry, transitive and generated
  paths); the four boundary guards (§7.1 in (c); §7.2
  `cockpit-integration`, §7.4 `prime-research-boundary`, and
  `prime-runtime-ingress.test.ts` in (e): four imports →
  `adapters/prime/transport/*`, the child-script import URL, and both
  import-boundary tests re-pointed at the target tree — its file lists
  now cover `protocol/ runtime/contracts/ runtime/observation/
  adapters/pi/ presentation/ cockpit/` + `runtime/session-worker.ts`).
  Stale-specifier greps (`../src/`, `../../agent/`, `../../coding-agent/`,
  `../runtime/prime`) return nothing outside `pi/packages`.

### 5.11 Scripts and tooling

| Source | Target | Disposition |
| :--- | :--- | :--- |
| `scripts/check-browser-smoke.mjs` (donor root) | `scripts/check-browser-smoke.mjs` | **REWRITE** for the §4 tree; Endophasia expected/forbidden set preserved (§7.3); the Pi-internal portions of the donor script belong to the Pi repo |
| `scripts/check-endophasia-cockpit-types.mjs` (donor root) | `scripts/check-cockpit-types.mjs` | **ADAPT** (read before wiring; expected: runs tsc against the cockpit tsconfig) |
| donor root `tsconfig.json` paths | `tsconfig.json` | **REWRITE**: same `@earendil-works/*` path map retargeted to `pi/packages/*/src`; include `protocol/ runtime/ adapters/ presentation/ cockpit/ research/ tests/ scripts/`; exclude `cockpit/main.ts` + `cockpit/view.ts` |
| donor root `vitest.base.ts` + `packages/endophasia/vitest.config.ts` | `vitest.config.ts` | **REWRITE**: `test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30_000 }`; `resolve.conditions: ["source"]` (+ ssr); aliases: every `@earendil-works/*` (incl. subpaths) → `pi/packages/*/src/*.ts`, plus `^@earendil-works/pi-coding-agent/experimental/(.+)$` → `pi/packages/coding-agent/src/experimental/$1.ts` |
| donor `biome.json`, `.gitignore`, `LICENSE.md` | root | **KEEP** (biome config copied; ignore adds `pi`-generated artifacts as needed — the submodule itself is tracked) |
| `docs/runtime-observation-boundary-v0.md`, `docs/continuity-remote-v0.md`, `docs/runtime-profile-v0.md`, `docs/conformance-lab-v0.md`, `docs/pi-upstream.md` | `docs/` | **KEEP** + path updates; the boundary docs define the seams §5.4 keeps deliberately |
- **Status (milestone e, done):** `check-browser-smoke.mjs` REWRITTEN for
  the §4 tree (two esbuild browser bundles, expected/forbidden sets per
  §7.3) — first green run 2026-10-02, exit 0 in 0.20 s.
  `endophasia-browser-transport-smoke-entry.ts` written (donor intent,
  target paths). `check-cockpit-types.mjs` ADAPTED (see §5.8).

### 5.12 Phase 1 components (protocol + identity)

Phase 1 (README "Phase 1 — Protocol + identity") builds the versioned
protocol foundation. The donor has no Phase 1 counterpart (its v0 schemas
are runtime-observation-specific); these are new target modules in the
house style of `protocol/mission-trace.ts`: type-centric,
`<name>.v0` schemaVersion literals, closed literal unions, and zero
dependency outside `protocol/`.

| README Phase 1 item | Disposition | Where |
| :--- | :--- | :--- |
| Versioned protocol | **BUILD** | `protocol/{identity,event,object,coordinates}.ts` + `JsonValueV0` in `protocol/primitives.ts`; every schema carries an `endo.*.v0` literal; the existing v0 modules (`mission-trace`, `runtime-profile`, …) are untouched |
| Stable identifiers | **BUILD** | `protocol/identity.ts`: the `endo.<kind>.<local>` grammar; the closed 10-namespace v0 set is exactly the README example list (`endo.session.*` … `endo.evidence.*`); pure `parse`/`format`/`is` functions; the local part is opaque `[A-Za-z0-9._-]{1,256}` |
| Event/object schemas | **BUILD** | `protocol/event.ts` (the envelope: closed 6-class `source` — the README "Those are not interchangeable" distinction; 2+-segment dotted `kind`; monotonic `sequence`; ISO-8601 UTC `at`; namespaced coordinates; `derivedFrom` lineage; strict-JSON `payload`) + `protocol/object.ts` (the minimal 4-field object envelope; the normalized object store is Phase 3) |
| Capability vocabulary | **KEEP** (pre-existing) | `protocol/runtime-profile.ts` — the closed v0 capability catalogue is the Phase 1 capability vocabulary, carried verbatim from the donor |
| Experiment/evidence coordinate model | **BUILD** | `protocol/coordinates.ts`: trial coordinates (experiment, optional candidate, 0-based trial index, optional recorded run) + evidence coordinates (evidence id, nested trial coordinates, optional replay run id) |

Design decisions (recorded per the handoff constraints):

- The event `source` class is a **closed** 6-literal union — the
  distinction the README insists on; the event `kind` is **open but
  well-formed** (the README kind list is "Examples:" and "Not every
  runtime will emit every event"); identifier namespaces stay closed.
- Strict-JSON discipline in the validators: unknown fields rejected,
  non-finite numbers rejected, identifiers checked against the correct
  namespace. Validators return the validated value unchanged (pure,
  allocation-free) or null — never a throw.
- `protocol/` remains zero-dependency: the new modules import only
  `./identity.ts` and `./primitives.ts`.

- **Status (2026-10-02, done):** all four modules + four suites green
  (40 tests); self-check at §10.4.

### 5.13 Phase 2 components (event and evidence substrate)

Phase 2 (README "Phase 2 — Event and evidence substrate") is the
"foundation of everything else": the persisted, append-oriented event
record and its replay. The donor's nearest relative is the quarantined
conformance-lab record/replay (research, not production); these are new
target modules in the house service style of `runtime/contracts/usage.ts`,
with strict doors: the service validates `unknown` at the boundary and
throws TypeError rather than coercing.

| README Phase 2 item | Disposition | Where |
| :--- | :--- | :--- |
| Structured event ingestion | **BUILD** | `runtime/contracts/event-store.ts`: `ingest` is the strict door — the value must pass `validateEndoEventV0` AND `assertPlainJsonValueV0` (structural validity ≠ canonicalizability: a Date payload passes the validator, fails canonicalization); duplicate `id` rejected; the returned event is what the store holds |
| Append-oriented event storage | **BUILD** | `createEndoEventStoreV0`: in-memory, append-only; the storage sequence is the 1-based append order, independent of the producer numbering in `event.sequence`; `page` is the demonstrated usage-ledger cursor pagination (strict `afterSequence`, 1-based, default 1000, max 10000) |
| Replay | **BUILD** | `runtime/contracts/event-replay.ts`: `replayEndoEventRecordV0` re-validates the record, re-canonicalizes the stream, recomputes the digest and the built-in summary, and classifies each layer `exact` / `reconstructed` / `unreproducible` (the README's own three-way); a layer is never omitted from the report |
| Reducers | **BUILD** | the built-in `reduceEndoEventSummaryV0` (count, maxSequence, the closed 6-source tally with zeros for unobserved classes) + the generic `reduceEndoEventsV0` left-to-right fold |
| Provenance | **BUILD** (v0 scope) | per-event: the Phase 1 envelope fields (`id`, `coordinates`, `producer`, `derivedFrom`, `source`); record-level: `id` in the `endo.evidence.*` namespace, `coordinates`, and the canonical digest; the "optional integrity/witness attachments" land as the digests — the witness is deferred |
| Resource accounting | **BUILD** | `EndoResourceUsageV0` on the record (`tokens` / `cost` / `durationMs`, all optional — an absent field is an honest absence, not a zero); reported values, never recomputed from components |
| Result bundles | **BUILD** | `buildEndoResultBundleV0`: the record + an optional replay report + the bundle's own SHA-256 over the two in canonical form; strict doors; a report about a different record is a TypeError |

The substrate schemas (record, page, replay report, stream summary,
resource usage, bundle) live in `protocol/event-record.ts` —
zero-dependency, strict validators that never throw;
`runtime/contracts/canonical-json.ts` is the production copy of the
quarantined research canonicalization discipline
(`research/conformance/json.ts`): sorted object keys, preserved array
order, tab indent, one trailing LF — "a local format, not RFC 8785" — and
the record digest is `sha256HexV0(canonicalEndoJsonV0(events))`.

Design decisions (recorded per the handoff constraints):

- Record, bundle, and replay-report identity uses the `endo.evidence.*`
  namespace — a persisted record is evidence material; the artifact
  namespace stays a v1 addition.
- Digest discipline is split: protocol validators check the
  64-lowercase-hex GRAMMAR only (language-neutral, no `node:crypto` in
  `protocol/`); the services check CORRECTNESS (recompute, compare) —
  which is what makes the three-way replay vocabulary honest.
- The replay events layer is `unreproducible` when an event fails
  re-validation or the stream cannot be canonicalized; the derived layer
  is `unreproducible` when the record carries no summary to compare
  against. The layers are independent: a non-canonicalizable stream is
  still classified by the derived layer's own summary comparison.
- Strict doors: `ingest`, `replayEndoEventRecordV0`, and
  `buildEndoResultBundleV0` validate `unknown` at the boundary and throw
  TypeError (the house `parseUsageLedgerQuery` style).
- The store does not copy events at ingest (JSDoc: the producer treats the
  returned event as the stored one); `record()` materializes a snapshot,
  so a persisted record never moves under later ingestion.
- No Chord service handle/facet yet (it lands with the first consumer,
  Phase 3+) and no Pi adapter yet (the mapping evidence is Phase 5
  conformance).

- **Status (2026-10-02, done):** four new source modules + the barrel
  exports + three suites (51 tests); self-check at §10.5.

## 6. Contract leaks to sever (the REWRITES)

Type-only Pi imports inside contract modules must end in `protocol/`.
Shapes verified at the donor:

1. **`src/continuity-service.ts:5`** — `import type { Entry, ThinkingLevel }
   from "@earendil-works/pi-agent-core"`.
   - `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" |
     "xhigh" | "max"` (donor `packages/agent/src/types.ts:345`) →
     `ThinkingLevelV0` in `protocol/primitives.ts` (shared with control).
   - `Entry` union = `MessageEntry | CompactionEntry |
     BranchSummaryEntry | CustomEntry`, `EntryType = "message" |
     "compaction" | "branch_summary" | "custom"` (donor
     `packages/agent/src/harness/session/types.ts:16,64`).
     `ContinuityEntryV0` already projects entries payload-minimally (base
     `{id, parentId, seq, timestamp}` + per-type minimal fields,
     `hasSummary`/`hasData` booleans) — the neutral type set is exactly that
     projection; no wire change.
2. **`src/session-overview.ts:1`** — `import type { AgentHarness, Context,
   LaneInfo, OperationStatus } from …`.
   - `OperationStatus = "running" | "open" | "aborting"` (donor
     `packages/agent/src/harness/agent-harness.ts:147`) →
     `OperationStatusV0` in `protocol/primitives.ts` (shared with
     steering and control).
   - `LaneInfo` usage is via `harness.lanes` inside the capture function,
     which moves to `adapters/pi/session-overview.ts`; the protocol types
     (`SessionLaneOverviewV0`, `SessionOverviewV0` — per-lane consistency,
     lanes sorted by name, aborting counts) are already Pi-free data.
3. **`src/control-deck.ts:1`** — `ModelIdentity` =
   `{ provider: string; modelId: string }` (donor
   `packages/agent/src/harness/agent-harness.ts:142`) → neutral
   `ModelIdentityV0` of the identical shape (also matches the continuity
   configuration model shape already in `protocol/continuity.ts`).

Wire shape is unchanged by all three rewrites: the projected values were
already plain JSON-serializable data; only the type identities change.

## 7. Machine-verified boundary invariants

These tests encode the architecture; the migration must keep them green,
with path updates only.

1. **`runtime-observation-boundary.test.ts`** (donor lines 573–584): three
   layers — (1) fake runtimes prove the facets work from the neutral ports
   alone; (2) compile-time guards fail if the neutral boundary starts
   accepting Pi objects; (3) import-graph assertions: neutral modules reach
   only `@earendil-works/chord`; the adapter reaches
   `@earendil-works/pi-agent-core`; the worker imports Pi only through the
   adapter. **DONE (c)**: module paths retargeted to the §4 targets
   (record in §10.1).
2. **`cockpit-integration.test.ts`** (donor lines 348–362): `cockpit/**`
   may import only `presentation/websocket-transport.ts`,
   `@earendil-works/chord/context`, and — type-only — chord, the contract
   schemas, and the pi-coding-agent experimental service state shapes.
   **DONE (e)**: allow-set retargeted — value: `./`,
   `../presentation/client.ts`,
   `../presentation/websocket-transport.ts`,
   `@earendil-works/chord/context`; type-only: chord, `../protocol/*`,
   `@earendil-works/pi-coding-agent/experimental/services/*`.
3. **Browser smoke** (`scripts/check-browser-smoke.mjs`, REWRITTEN): esbuild
   browser bundles over the §4 tree. The donor invariant is preserved
   file-for-file: the donor's service files (mixed, chord-only) map to
   `runtime/contracts/*` service files; the donor's facet-only files map to
   `runtime/contracts/*-facet.ts`; the Pi projection modules map to
   `adapters/pi/*`.
   - Bundle 1 (transport smoke entry) MUST include:
     `presentation/websocket-transport.ts`, `presentation/client.ts`,
     `runtime/contracts/continuity.ts`, `runtime/contracts/
     runtime-profile.ts`.
   - Bundle 2 (`cockpit/main.ts`) MUST include: `cockpit/view.ts`,
     `cockpit/controller.ts`, `runtime/contracts/{mission-trace,
     runtime-facts,usage,continuity,runtime-profile}.ts`,
     `presentation/{websocket-transport,client}.ts`,
     `pi/packages/client/src/client.ts`,
     `pi/packages/protocol/src/index.ts`.
   - FORBIDDEN in both: `node:*`, `node_modules/ws`,
     `node_modules/esbuild`, `pi/packages/agent/src/**`,
     `runtime/{session-worker,server,browser-server,browser-listener,
     cockpit,cockpit-host,cockpit-main}.ts`, `runtime/observation/
     ports.ts`, `runtime/contracts/{usage,continuity,runtime-profile}-
     facet.ts`, `adapters/pi/**` — resolved at the first green run to the
     seven host-bound projection modules
     (`adapters/pi/{observation-sources,mission-trace,runtime-metrics,
     durable-outcomes,usage-feed,usage-ledger,continuity}.ts`);
     `adapters/pi/session-overview.ts` is allowed (value-imported by
     `runtime/contracts/inspector.ts`; its Pi imports are type-only) and
     `adapters/pi/{steering,control-deck}.ts` are allowed (not in the
     client tree); `adapters/prime/**`,
     `research/**`.
   - First green run 2026-10-02; the smoke entry file
     (`scripts/endophasia-browser-transport-smoke-entry.ts`) was written
     for the target tree.
4. **`prime-research-boundary.test.ts`**: transitive guard — src,
   runtime/prime, presentation, cockpit import no `research/` module; no
   `prime-agent`/`agentclientprotocol` dependency in `package.json` /
   `package-lock.json`. **DONE (e)**: roots retargeted to the target tree
   (`protocol/`, `research/` guard via `file.includes("/research/")`,
   roots `["protocol", "runtime/contracts", "runtime/observation",
   "adapters", "presentation", "cockpit"]`; repoRoot = package root).

## 8. Deferred (later mission phases, in order)

- Protocol: the remaining seven of the README's 14 object types have no
  v0 envelope yet (Artifact, Edge, Decision, Proposal, Receipt,
  Evaluation, VisualizationState) and their namespaces are v1 additions
  to `ENDO_IDENTIFIER_KINDS_V0` — each lands with the phase that owns it
  (Edge with the Phase 3 cognition graph; Evaluation/Evidence result
  types with Phases 5/6). The schema/IR/code-generation approach (README
  line 714) lands only after the protocol stabilises.
- Graph, evaluation/conformance (lab), evolution substrate (RRSI/GEPA),
  RRSI/REEF, trust providers.
- Neutral ports for steering, control-deck, session-overview capture,
  continuity capture (the §5.4 "no port yet" seams).
- Prime conformance as a live gate; Codex adapter; visualization layer
  beyond the cockpit; `storage/`, `cli/`, `models/`.
- NOT started this phase: RRSI/REEF/Magpie/Deadbolt/Dream work.

## 9. Disposition summary

| Disposition | Components |
| :--- | :--- |
| KEEP | `runtime/observation/ports.ts`, `runtime/cockpit-host.ts`, `runtime/cockpit-main.ts`, `runtime/prime/limits.ts`, all of `presentation/`, all of `cockpit/`, all of `research/` + fixtures, test helpers + worker fixtures, `biome.json`/`LICENSE.md`, boundary docs |
| ADAPT | `protocol/primitives.ts` (new shared neutral literals), `adapters/pi/*` (9 projections + observation-sources), `runtime/{server,browser-server,browser-listener,cockpit,session-worker}.ts`, `adapters/prime/transport/*` (all 5, byte-verified vs donor), `runtime/contracts/{inspector,usage-facet,continuity-facet,runtime-profile-facet,index}.ts`, all 43 test files, `check-cockpit-types.mjs` |
| REWRITE | the 8 `protocol/*` schema modules (contract/service split, 3 Pi-leak severances §6; the shared `protocol/primitives.ts` is ADAPT, not REWRITE), the 5 `runtime/contracts/*` service modules, `adapters/pi/session-overview.ts` (capture split), `scripts/check-browser-smoke.mjs`, `tsconfig.json`, `vitest.config.ts`, the 4 boundary-guard tests (assertion paths) |
| RETIRE | nothing in Phase 0 — every demonstrated component has a target home; retirement decisions (e.g. Pi-internal portions of the donor browser-smoke script, donor `packages/endophasia` package metadata) apply to the donor copy, which stays read-only |
| DEFER | §8 |

## 10. Verification plan (per milestone)

After each milestone commit:

1. `npx tsc --noEmit` (root) + `npx tsc --noEmit -p cockpit/tsconfig.json`.
2. Migrated suites for the touched boundary (full `npx vitest --run` at the
   DEVELOP baseline).
3. Import-direction check: no `protocol/` import below it; no
   `adapters/pi` import outside `runtime/` composition + tests; no Pi value
   import outside `adapters/pi/steering.ts` (`HarnessClosed`) and the host
   entries.
4. Browser smoke script (rewritten) green.
5. Accidental-Pi-coupling check: grep `protocol/` for
   `@earendil-works/pi-` (must be empty); the three guard tests green.
6. Ledger status updated; target README updated.

### 10.1 Milestone (c) self-check record

Milestones (a) and (b) were verified with the same checks at their commits
(tsc + biome clean; no vitest surface yet).

Milestone (c):

- `npx tsc --noEmit` (root): 0 errors. Two program-shape fixes were needed
  once the tests pulled Pi package source into the program: (a)
  `pi/packages/ai/src/providers/data/*.json` generated by
  `npm run hydrate:model-data` (43 TS2307s before); (b) tsconfig `files`
  now includes `pi/packages/coding-agent/src/utils/highlight-js.d.ts` —
  the donor's own ambient declaration for the untyped `highlight.js`
  subpath imports in `syntax-highlight.ts` (22 TS7016s before; the donor
  root include glob picks the file up, the target's `exclude: pi/**`
  needed the explicit `files` entry).
- `npx biome check protocol/ runtime/ adapters/ tests/`: clean (14
  import-organization/format fixes applied to the retargeted files).
- `grep -rn '@earendil-works/pi-' protocol/`: 0 matches.
- `npx vitest --run tests/`: 16 files, 224 tests, all pass.
  `runtime-observation-boundary.test.ts` re-asserts its on-disk graph
  checks against the target tree (neutral set:
  `runtime/observation/ports.ts` +
  `runtime/contracts/{mission-trace,runtime-facts,usage-facet,usage}.ts`;
  Pi-specific set:
  `adapters/pi/{observation-sources,mission-trace,runtime-metrics,
  durable-outcomes,usage-feed,usage-ledger}.ts`; schema versions read from
  `protocol/{mission-trace,runtime-facts,usage}.ts`).

### 10.2 Milestone (d) self-check record

- `npx tsc --noEmit` (root): 0 errors. The new suites pulled
  `pi/packages/agent/src/harness/**` and `pi/packages/coding-agent`
  experimental-services sources into the program with no new
  program-shape errors (the two (c) fixes suffice).
- `npx biome check protocol/ runtime/ adapters/ tests/`: clean (two
  import-organization fixes applied to retargeted `session-host.test.ts`).
- `grep -rn '@earendil-works/pi-' protocol/`: 0 matches.
- `npx vitest --run tests/`: 20 files, 266 passed + 1 skipped, 0 failed.
- Host entries: three byte-identical to the donor (`browser-server.ts`,
  `browser-listener.ts`, `cockpit-host.ts`, `cmp`-verified); three
  one-line retargets (`server.ts` comment path, `cockpit.ts`
  `REPOSITORY_ROOT` depth, `cockpit-main.ts` comment script name), each
  `diff`-verified against the donor to change only the intended line.
- `browser-server.test.ts` stays in the donor for milestone e, with its
  cockpit/presentation dependencies plus the same one-line source-resolver
  URL retarget applied when it lands.

### 10.3 Milestone (e) self-check record

- `npx tsc --noEmit` (root): 0 errors (no new program-shape issues in
  this wave; the (c) fixes suffice).
- Import-direction check (DEVELOP baseline): `protocol/` imports
  nothing below itself (its only non-chord imports are intra-protocol
  `./primitives.ts` type imports); `adapters/pi` value edges exist only
  in `runtime/` composition (`runtime/contracts/{inspector,
  continuity-facet,index}.ts` + `runtime/session-worker.ts`); the only
  Pi value import in `runtime/`+`adapters/pi/` is
  `adapters/pi/steering.ts` (`HarnessClosed`); `research/` has zero Pi
  imports. The 7 donor-identical Pi value imports in the host-bound app
  layer (`presentation/client.ts` × 5: pi-client `Client`,
  pi-protocol `DEFAULT_MAX_FRAME_LENGTH` in
  `websocket-transport.ts`, pi-coding-agent experimental
  `services/{connection,models,sessions,transcript}`;
  `cockpit/view-model.ts` × 1: experimental `services/connection`) are
  the demonstrated presentation/cockpit edges — the §10.3 rule's "host
  entries" is interpreted as the host-bound app layer for (e).
- `node scripts/check-cockpit-types.mjs`: exit 0 — 1 diagnostic outside
  the cockpit (`pi/packages/ai/src/api/openai-codex-responses.ts(403,8)`
  `error TS2769`), donor-identical.
- `node scripts/check-browser-smoke.mjs`: exit 0 (first green run;
  §7.3 forbidden set resolved as recorded there).
- `npx biome check` on `protocol/ runtime/ adapters/ presentation/
  cockpit/ research/ tests/ scripts/`: 140 files clean (10
  import-organization/format fixes applied, then re-checked).
- `grep -rn '@earendil-works/pi-' protocol/`: 0 matches.
- Stale-specifier greps (`../src/`, `../../agent/`, `../../coding-agent/`,
  `../runtime/prime`): clean outside the remediation synthetic strings.
- Full `npx vitest --run`: **43/43 files, 1580 passed, 3 skipped,
  0 failed** (~95 s). Parity with the re-measured donor (1578 passed,
  3 skipped, 43 files; §2): identical per-file counts on all 43 files
  except the intentional +2 in `prime-research-boundary.test.ts` (§7.4
  root-list expansion).
- Failure forensics (first two full runs of this phase): (1) `ENOENT`
  on `<root>/test/fixtures/prime/0.9.7/rpc` — the research CLIs still
  pointed at the donor fixture path / four-up repo roots; (2) `fatal:
  not a git repository` in `sourceDigestAtCommit` — the repo-root URL
  in the conformance suites was three-up (donor depth) and resolved to
  the parent of the target root; one-up is correct from `tests/`.
- The donor capture commit `45adf6b103bf484f40aa69b4774c089ccd170bda`
  (the provenance `endophasiaCommit` asserted by the prime-097/
  conformance suites; `sourceDigestAtCommit` hashes that commit's own
  tree, repo-independently) is reachable via `refs/remotes/source/*`
  and is now also pinned at `refs/migration/donor-capture` so
  `git gc` / `git remote prune` cannot orphan the object the digest
  checks hash against.
- Donor worktree verified clean at HEAD `ab4caf5a0` before and after
  the re-measurement runs.

### 10.4 Phase 1 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the nine scope directories: 148 files, no fixes
  needed (after `--write` formatted the four new test files).
- `grep -rn '@earendil-works/pi-' protocol/`: 0 matches. Import
  direction: the new modules import only `./identity.ts` and
  `./primitives.ts` (intra-protocol); `protocol/` remains
  zero-dependency.
- New suites: `tests/{endo-identity,endo-event,endo-object,endo-coordinates}.test.ts`
  — 4 files, 40 passed: identifier grammar boundaries and the
  `format ∘ parse = id` round-trip, envelope accept/reject per field,
  namespace discipline for every identifier field, strict-JSON payload
  discipline (non-finite numbers rejected).
- Full `npx vitest --run`: **47/47 files, 1620 passed, 3 skipped, 0
  failed** (1580 pre-existing + 40 new).
- Donor untouched (read-only): Phase 1 adds no donor files.

### 10.5 Phase 2 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the nine scope directories: 155 files, no fixes
  needed (after `--write` normalized the four new modules + three suites).
- `grep -rn '@earendil-works/pi-' protocol/`: 0 matches. Import
  direction: `protocol/event-record.ts` imports only `./event.ts` and
  `./identity.ts` (intra-protocol; `protocol/` remains zero-dependency);
  the new `runtime/contracts/` modules import only `protocol/` +
  intra-contracts (`node:crypto` / `node:util` in `canonical-json.ts`).
- New suites: `tests/{endo-event-record,endo-event-store,endo-event-replay}.test.ts`
  — 3 files, 51 passed: validator accept/reject per field; the strict
  ingestion door (including the structural-pass / canonicalization-fail
  Date-payload seam); 1-based cursor pagination at the demonstrated
  boundaries; digest determinism across independently built stores; the
  three-way replay classification (tampered digest → reconstructed events,
  tampered summary → reconstructed derived, deleted summary →
  unreproducible derived, non-canonicalizable stream → unreproducible
  events with the `computedDigest` key absent); bundle strict doors and
  canonical digest stability.
- Full `npx vitest --run`: **50/50 files, 1671 passed, 3 skipped, 0
  failed** (1620 pre-existing + 51 new).
- Donor untouched (read-only): Phase 2 adds no donor files.

## 11. Phase 0 closure — standalone boundary

Phase 0 (README "# Roadmap") goal: complete the migration from the Pi
fork into endophasia-standalone. **DONE — 2026-10-02, commit
`dcd13e978`.**

| Phase 0 goal | Status | Evidence |
| :--- | :--- | :--- |
| Preserve the useful current behaviour | done | 43/43 donor suites migrated; full target suite 1580 passed / 3 skipped; per-file parity with the re-measured donor except the intentional +2 guard expansion (§2, §10.3) |
| Keep Pi upstream-aware | done | `pi/` submodule pinned at donor fork HEAD `ab4caf5a0…`; `docs/pi-upstream.md` migrated; the upstream tip `cb7969d21` recorded for future synchronization (§3, §7 item 5) |
| Establish a clean project boundary | done | `protocol → runtime/contracts → adapters → presentation/cockpit` import direction verified (§10.3 import-direction check); 4 boundary-guard suites green |
| Stop treating Pi's internal architecture as Endophasia's architecture | done | 22 donor `src/` modules mapped to the target split (§9: 0 RETIRE); 3 contract-leak severances (§6); `protocol/` is zero-dependency (no non-intra-protocol import) |

Milestones (a)–(e) of this phase: `91d40e145` (protocol + ports),
`5f38f17b2` (contracts + 2 adapters), `f1b62d23b` (8 adapters, prime
transport, session worker, 16 suites), `c65543e97` (6 host entries, 4
host suites), `dcd13e978` (presentation, cockpit, research, scripts,
remaining 23 suites + fixtures).

Next: Phase 3 (cognition graph — typed nodes/edges, normalized object store, incremental traversal; README "# Roadmap"). Phase 2 (event and evidence substrate) is recorded in §5.13 and verified in §10.5.

