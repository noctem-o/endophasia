# Endophasia Migration Ledger

Migration of the demonstrated Endophasia v0 from the Pi-fork monorepo
(`../endophasia-source/`, the DONOR — read-only) into this standalone
repository (the TARGET). This ledger records, per component, where it came
from, where it goes, what changes, and which demonstrated tests protect it.

> **Superseded in part (2026-10-03).** §3 "Pi integration decision" (vendor the fork as a `pi/` submodule) and the
> components that existed to host Pi's Session worker, Chord services and browser presentation are superseded by the
> Pi RPC attachment: Endophasia no longer vendors or depends on Pi; it attaches to a user-installed Pi over its
> documented `--mode rpc`. The fork pin `ab4caf5` remains available in `noctem-o/endophasia-pi-legacy-deprecated`.
> Decisions, the capability mapping and every removal's disposition are in
> [pi-attach-inventory.md](pi-attach-inventory.md). The rest of this ledger stands as the migration history.

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

- **Neutral ports landed in Phase 12** (steering, control-deck,
  session-overview capture, continuity capture): `runtime/ports.ts`
  defines the four lane-bound capability interfaces in Endophasia's
  v0 semantics and `adapters/pi/ports.ts` supplies the Pi-backed
  closures (§5.23); Phases 0–11 kept them Pi-direct behind
  `adapters/pi/`.
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

### 5.14 Phase 3 components (cognition graph)

README "# Roadmap" Phase 3: the cognition graph — a normalized object
store over the `endo.node.*` / `endo.edge.*` namespaces, budgeted
traversal ("root → frontier → batched expansion → dedupe/visited set →
emit snapshot → continue until depth/node/edge budget"),
subscriptions, and temporal projection. The `DonorGraphScout` re-check
(2026-10-02) confirmed the DONOR has no cognition graph and no object
store: four negative greps found no graph/node/edge/frontier
vocabulary in the overlay, and none of the README relation names
appear in it. The closest demonstrated analogs are continuity
`activePath` (a linearized tip→root parent chain), the mission-trace
sequence discipline ("sequence is an order, not a time"), and the
cursor-based attach pattern. Phase 3 therefore establishes new
Endophasia capability from the README contract, reusing the
demonstrated disciplines (append-only log, 1-based sequences, strict
doors, the observation-ports subscription semantics) rather than
porting donor code.

| README requirement | Disposition |
| :--- | :--- |
| Typed cognition objects ("include:" 18 object types) | `protocol/graph.ts`: `ENDO_NODE_KINDS_V0` (18) plus the open `EndoObjectV0` kind grammar (`isWellFormedKindV0`, 1+ kebab/dot segments) — "include:" is an open list, so the validator enforces the grammar and the tuple is a documented recommendation |
| Typed relationships ("include:" 10 relations) | `ENDO_EDGE_RELATIONS_V0` (10) plus the same open grammar on `EndoGraphEdgeV0.relation`; the edge envelope (`endo.edge.v0`) lands now, per the §5.12 deferral note |
| Normalized object store | `graph/store.ts`: `createEndoGraphStoreV0()` — last-write-wins lookups with per-id revision history, a global 1-based append revision log (`EndoGraphRevisionV0`), adjacency index rebuilt on edge revision |
| Incremental/budgeted traversal | `graph/traversal.ts`: `expandEndoGraphV0` implements the README pipeline verbatim — BFS frontier, dedupe/visited set, sorted snapshot emission, `maxDepth`/`maxNodes`/`maxEdges` budgets (absent = unbounded), `in`/`out`/`both` direction, relation filter (governs traversal only; the snapshot shows every recorded edge between visited nodes), honest `truncated` and `missing` |
| Subscriptions | `graph/subscriptions.ts`: `createEndoGraphSubscribersV0()` mirrors `runtime/observation/ports.ts` (idempotent unsubscribe; a throwing listener must not stop the stream; unsubscribe-during-emit is safe); the store's `subscribe` delegates; one `EndoGraphChangeV0` per upsert |
| Temporal projection ("the graph is not 'the truth'… a structured projection of recorded state") | `graph/projections.ts`: `projectEndoGraphAtV0(store, upToSequence)` replays the store's own revision log — honest because the log is evidence material; 0 = empty projection, beyond the log end = current state, sorted and deterministic |

Design decisions (recorded per the handoff constraints):

- Node kinds and edge relations are OPEN well-formed vocabularies
  (kebab segments, dot segments allowed) with documented recommended
  tuples — README "include:" semantics, not closed unions.
- Dangling endpoints are legal: a recorded edge belongs to the graph
  even when an endpoint object is never recorded; traversal reports
  such endpoints in `snapshot.missing` (the README honesty rule), and
  expansion from a missing root still follows its recorded edges.
- Per-id revisions plus the global append sequence mirror the Phase 2
  event-store discipline: the revision log is evidence material, not
  implementation detail — it is what makes temporal projection honest.
- Strict doors: `upsertObject`, `upsertEdge`, the
  `expandEndoGraphV0` options, and `projectEndoGraphAtV0` validate
  `unknown` and throw TypeError (the Phase 2 discipline continues).
- The remaining deferred object envelopes (Artifact, Decision,
  Proposal, Receipt, Evaluation, VisualizationState) stay v1, with
  their identifier-kind namespaces as v1 additions.
- No Chord service handle/facet yet (it lands with the first consumer)
  and no Pi adapter yet.

- **Status (2026-10-02, done):** `protocol/graph.ts` + five graph
  modules + five suites (68 tests); self-check at §10.6.

### 5.15 Phase 4 components (real visual cognition)

README "# Roadmap" Phase 4: real visual cognition — semantic visual
state, engineering cockpit, live graph updates, model/runtime-directed
animation, a Dream mode renderer, graceful unavailable-state rendering,
"use one state model for both renderers". The donor has no visual
cognition substrate (the §5.14 scout found no cognition graph at all),
so Phase 4 builds new capability on the Phase 3 cognition graph,
reusing the demonstrated disciplines (1-based sequences, strict doors,
the ports subscription semantics, honest degraded reporting).

| README requirement | Disposition |
| :--- | :--- |
| Semantic visual state | `protocol/visualization.ts` + `visualization/semantic-state.ts`: `buildEndoSemanticVisualStateV0(store, options?)` — whole-store, or rooted with the Phase 3 expansion options (`root`/`budgets`/`relations`/`direction`) passed through unchanged; per-component BFS depth from the smallest identifier; node signals (attention/cluster/uncertainty) projected from the recorded payload keys with the documented availability vocabulary; scene signals (atmosphere/camera-intent) decided by the smallest recording identifier; honest `missing`/`truncated`/`source` coordinates; `buildEndoSemanticVisualStateAtV0` re-derives at a past store sequence over the Phase 3 revision log (whole-store only) |
| Engineering cockpit | `visualization/engineering.ts`: `renderEngineeringSceneV0` — four deterministic sections (claims-evidence, degraded-states, graph-inspector, status) of labelled rows with a tone; every absent thing renders an explicit row, never a silent hole |
| Live graph updates / model-runtime-directed animation | `visualization/live.ts`: `createEndoSemanticVisualUpdaterV0` — subscribes to the Phase 3 store; every graph change delivers a rebuilt state carrying a derived temporal-motion signal (the sequence delta since the last successful delivery); a throwing listener drops its delivery without advancing the motion baseline; the initial delivery is synchronous; unsubscribe is idempotent |
| Dream mode renderer | `visualization/dream.ts`: `renderDreamSceneV0` — topology (depth + recorded cluster), attention/uncertainty fields, active regions, branching hypotheses (hypothesis nodes with incident relations), recorded clusters, model/tool boundaries, scene signals; missing motion renders an explicit unavailable signal |
| Graceful unavailable-state rendering | every signal is an `EndoVisualSignalV0` with the `available`/`unavailable`/`unrecognized` availability vocabulary and a recorded reason; out-of-range or mistyped recorded values are carried as-sent under `unrecognized`, never normalized or invented |
| One state model for both renderers | both renderers validate the same `EndoSemanticVisualStateV0` with its own validator (TypeError at the door) and are pure projections of it |

Design decisions:

- Signals are projections of recorded cognition: node signals are read
  from the node's recorded payload under the strict-JSON discipline;
  availability is a three-way vocabulary — `available` (value +
  `recorded` origin), `unavailable` (reason), `unrecognized` (value
  as-sent + reason) — with the value/origin/reason co-presence
  enforced by the validator.
- Scene-signal precedence: the smallest node identifier among the
  recorders decides; a scene signal with no recorder is an explicit
  unavailable with a recorded reason.
- Motion is derived, not recorded: a single build has no predecessor,
  so the builder emits an unavailable motion with a reason; only the
  live updater derives motion (the sequence delta), and it replaces
  the builder's unavailable entry rather than duplicating it.
- Depth is a graph fact, not a layout hint: BFS distance from each
  component's smallest identifier (rooted builds measure from the
  root), so the same state always yields the same topology.
- Strict doors: `buildEndoSemanticVisualStateV0` options,
  `buildEndoSemanticVisualStateAtV0`, and both renderers validate
  `unknown` input and throw TypeError — the Phase 2/3 discipline
  continues.
- No Chord service handle/facet and no Pi adapter yet: both land with
  the first cockpit consumer (the cockpit/ presentation wiring).

- **Status (2026-10-02, done):** `protocol/visualization.ts` + four
  visualization modules + five suites (65 tests); self-check at §10.7.

### 5.16 Phase 5 components (evaluation and conformance lab)

Phase 5 scope (README "# Roadmap"): evaluation — the "Store:" list of
producing coordinates, the "Distinguish:" list of data partitions, repeated
trials — the conformance lab — a reusable conformance framework for testing
runtime claims with a closed five-way classification — and the replay
workflow — record, persist, replay, rebuild the graph, rebuild the visual
state, compare against the original, and report exact/reconstructed/
unreproducible per layer. Donor re-check (read-only): no Phase 5 analogue in
production; the only conformance mention in `src/` is a JSDoc pointer in
`runtime-profile-service.ts`, and the conformance/replay machinery sits
quarantined in `research/`. Phase 5 is BUILD, as were Phases 1–4: new
capability on the Phase 1–4 substrates (event records, the cognition graph,
semantic visual state), reusing the demonstrated discipline — canonical
JSON, SHA-256 digests, strict doors, honest availability.

| README requirement | Disposition |
| :--- | :--- |
| Evaluation "Store:" — candidate revision, runtime/model identity, cognition policy, environment identity/revision/sandbox, evaluator and grader identity, recorded seeds, trial count, usage, wall time, raw results, derived metrics, result-bundle digest, selection policy, promotion state | `protocol/evaluation.ts`: `endo.evaluation-profile.v0` records the producing coordinates (experimentId, candidateId?, candidateRevision?, runtime, model, closed `work`/`dream` cognition policy, `endo.environment-profile.v0` environment — identity, optional revision, optional sandboxId, explicit `simulated` flag — evaluator?, grader?, seeds?, trialCount) and `endo.evaluation-result.v0` records what the process produced (id, profile stored verbatim, trials, usage?, wallTimeMs?, resultBundleDigest?, selectionPolicy?, promotionState?). The profile is stored, not merely digested: equal-looking outputs with different producing coordinates are different results |
| Repeated trials | `lab/trials.ts`: `runEndoTrialsV0({id, profile, runTrial, usage?, wallTimeMs?})` — exactly `profile.trialCount` trials, in declared order; trial i draws seed `i % seeds.length` (absent seeds are an honest absence); per-trial coordinates from the Phase 1 trial-coordinates grammar (experimentId, candidateId?, trial index, the runId the outcome reports); the consumer's raw/derived split is copied through apart |
| "Distinguish:" partitions — evolve-set, held-out, out-of-distribution, live-traffic, simulated, replay | `ENDO_EVALUATION_PARTITIONS_V0`: a closed six-literal vocabulary on each trial result. A partition is a statement about the trial's data, never about its quality; "a simulated result must say it was simulated" is the environment profile's explicit `simulated` flag |
| Conformance lab — a reusable conformance framework for testing runtime claims (subject, version, scenario, decoder, predicate, expected meaning, observed result, classification, evidence, limitations) | `protocol/evaluation.ts`: `endo.conformance-study.v0` (the README field list, all ten fields) + `endo.conformance-suite.v0` (the studies in the order the study declared) and `lab/conformance.ts`: `studyEndoConformanceV0` / `runEndoConformanceSuiteV0`. The classification is a closed five-way union carrying the README's own UPPERCASE literals EXACT/QUALIFIED/PARTIAL/UNAVAILABLE/MISMATCH — a documented divergence from the house lowercase unions, because the README presents classifications as data values, not vocabulary keys. UNAVAILABLE is first-class: "nothing matched exactly" is a useful scientific result |
| Result bundle digest (README "Store:") | `lab/experiment-bundle.ts`: `buildEndoExperimentBundleV0(id, result)` — `endo.experiment-bundle.v0` = the validated result + its canonical-JSON SHA-256 digest; the protocol validator checks the 64-hex grammar only (no node:crypto in `protocol/`), the lab recomputes |
| Replay — per-layer exact/reconstructed/unreproducible, through graph and visual-state rebuild | `lab/replay-compare.ts`: `compareEndoReplayV0({record, originalGraph?, rebuildGraph?, originalVisual?})` — the events and derived layers carry the Phase 2 `replayEndoEventRecordV0` report verbatim (plus the computed digest); the graph layer is rebuilt through `projectEndoGraphAtV0` (the Phase 3 projection) and canonical-compared against the recorded snapshot; the visualState layer is rebuilt through `buildEndoSemanticVisualStateV0` (Phase 4) and compared. An absent input is an honest unreproducible; a present-but-malformed input is a TypeError at the door. Deterministic fixtures are a conformance aid, not proof that a real runtime is deterministic (README line 793) |

Design decisions:

- **New top-level `lab/` module** (precedent: `graph/` Phase 3, `visualization/` Phase 4): the README's "retain a reusable conformance framework for testing runtime claims" is a production capability, and the Prime conformance machinery stays quarantined in `research/`. `lab/` imports only `protocol/` + `runtime/contracts/` + `graph/` + `visualization/` + intra-lab; the prime-research-boundary guard now covers it (closing the Phase 3/4 gap).
- **The lab is a service layer, not a framework**: every entry point is a pure function behind a strict door (TypeError); the lab owns no state, scheduler, or provider. The consumer supplies the doing — a trial function, a rebuild function, a conformance reading — and the lab supplies the discipline: the exact count, the declared order, the coordinates, the comparison, the digest. Providers, runtimes, and evaluators remain replaceable integrations around stable contracts.
- **Recorded vs derived vs claim stay apart end-to-end**: raw/derived are separate fields on trial results; expected/observed/classification/limitations are separate fields on studies; results, suites, and comparisons are distinct records with `endo.evidence.*` identities — never events. An evaluator's judgement is never recorded as a runtime fact, and `selectionPolicy`/`promotionState` are recorded context, not gates: the decision that follows them is a Phase 6 record.
- **The three-way replay vocabulary is extended, not replaced**: the events/derived layers carry the Phase 2 report's own values; `graph` and `visualState` are new layers with identical exact/reconstructed/unreproducible semantics (exact = the re-derivation equals the recorded original; reconstructed = re-derivable but different; unreproducible = the inputs are insufficient). The visualState layer cascades unreproducible from the graph layer: there is no rebuilt store to build a visual state from.
- **Digest split**: protocol validators check the 64-hex grammar only, keeping `protocol/` dependency-free; lab services recompute the canonical digests and compare.
- **Suite order discipline** (mirrors the quarantined `research/conformance/order.ts`; not imported from it): declared scenario order, unique non-empty scenarios of at most 256 characters, and every study names the suite's subject, version, and the scenario it was asked about; a hand-resorted suite is a different suite.
- **Steer outcomes (2026-10-02 architecture review, 12 guardrails)**: the design was reviewed against all twelve and left as-is — it is consistent. Explicitly NOT adopted: a generic experiment event stream (evaluation results, conformance suites, and replay comparisons remain distinct records; not every observable state becomes a durable event, and Event/Artifact/Snapshot/Projection/Evidence stay distinct — no token-level durable events); a catch-all identity/context object (identity, coordinates, provenance, resource usage, evaluation context, and policy remain composable fields on separate shapes); flattening the graph into the event store (replay comparison consumes the Phase 3 projection; the graph keeps its own revision log and temporal projection); importing the research/Prime conformance machinery into production (the ordering/uniqueness discipline is mirrored, the quarantined modules are untouched). Explicitly adopted: honest unavailable/qualified states (UNAVAILABLE classification, unreproducible layers, the explicit `simulated` flag), consistent with the Phase 2 replay vocabulary and the Phase 4 availability model; and deterministic reconstruction over mutable presentation state (a replayed visual state is rebuilt from the rebuilt graph store, never read from a live presentation layer).
- **Phase 6 boundary**: the selection/promotion gates, the evolution substrate (RRSI/GEPA), and the trust providers stay deferred (§8); Phase 5 records the fields they will gate on and decides nothing.

- **Status (2026-10-02, done):** `protocol/evaluation.ts` + four lab modules + five suites (70 tests); self-check at §10.8.

### 5.17 Phase 6 components (evolution substrate)

Phase 6 scope (README "## Phase 6 — Evolution substrate"): the
candidate model, mutation records, experiment lifecycle, evidence
ledger, selection contracts, promotion gates, and artifact/version
semantics — the algorithm-neutral substrate behind the README's
evolution layer (README lines 299–336), whose recorded-field list
(candidate identity, parent, source revision, hypothesis, proposed
diff, expected/observed effect, cost delta, trial-level and held-out
results, selection decision, promotion state, provenance) is the
field inventory here. Donor re-check (read-only, word-boundary): no
Phase 6 analogue in production — "promotion" has zero matches,
"candidate" matches only in `research/prime-conformance/` plus
incidental loop/path variables, and "mutation"/"selection" only
incidentally. Phase 6 is BUILD, as were Phases 1–5: new capability
on the Phase 1–5 substrates (evaluation results, trial coordinates,
event records), reusing the demonstrated discipline — canonical
JSON, SHA-256 digests, strict doors, honest absence.

| README requirement | Disposition |
| :--- | :--- |
| Candidate model | `protocol/evolution.ts`: `endo.candidate.v0` — `endo.candidate.*` identity, parentCandidateId?, sourceRevision?, artifactId?, model?, runtime?, environment? (`endo.environment-profile.v0`), hypothesis?, `mutations: string[]` REQUIRED (empty = base candidate), provenance?, closed `active`/`superseded`/`retired` state?, revision? |
| Mutation records | `endo.mutation.v0` — component (well-formed dotted kind), closed four-way operation (add/replace/remove/reconfigure), sourceRevision?/targetRevision?, artifactId?, hypothesis?, expectedEffect?, observedEffect?, costDelta? (strict JSON), description? |
| Experiment lifecycle | `endo.experiment.v0` record + `endo.experiment-transition.v0` + `evolution/experiment.ts`: an 11-state closed machine (`ENDO_EXPERIMENT_STATES_V0`) with an explicit transition table (`ENDO_EXPERIMENT_STATE_TRANSITIONS_V0`) the validator itself enforces; `createEndoExperimentLifecycleV0` (strict doors, starts `created`, state is a closure variable, never a record field) + `replayEndoExperimentLifecycleV0` (experimentId match, sequence exactly 1..n, from === previous to, duplicate ids) |
| Evidence ledger | `endo.evidence-ledger.v0` — closed eleven-way kind entries `{sequence, kind, recordId}`, sequences exactly 1..n, no duplicate recordId — + `evolution/evidence.ts`: `createEndoEvidenceLedgerV0` (append-time referential integrity: every reference must already be in the ledger; id-less records get content-addressed identities) + `replayEndoEvidenceLedgerV0` |
| Selection contracts | `endo.selection-policy.v0` (name + revision — the Phase 7 policy seam), `endo.selection-condition.v0`, `endo.selection-decision.v0` — closed three-way outcome, conditions always non-empty, evidence non-empty iff `selected`, `selected` ⇔ candidateId present, heldOutEvidence? |
| Promotion gates | `endo.promotion-request.v0` + `endo.promotion-decision.v0` — closed two-way outcome, authority = the decision recorder's identity (1–256, not a grant), evidence non-empty iff `granted`; a recorded decision at the decision/evidence boundary, conferring no authority and triggering no effect |
| Artifact/version semantics | `endo.artifact.v0` — kind, digest = SHA-256 over content only, strict-JSON content? or digest, sourceRevision? — + `evolution/artifacts.ts`: `buildEndoArtifactV0` (content present → computed digest must match; absent → digest required) + `ENDO_ARTIFACT_KINDS_V0` (10 kinds) |

Design decisions:

- **`protocol/` holds the contracts, `evolution/` the substrate services**: a flat `evolution/{core,artifacts,experiment,evidence,index}.ts` — deliberately no `policies/` directory; it is reserved for the Phase 7 RRSI/GEPA policy seams (the README's `policies/` tree lands with them). `evolution/` imports only `protocol/` + `runtime/contracts/` + intra-evolution, and the prime-research-boundary guard now covers it (new `evolution` root in `tests/prime-research-boundary.test.ts`).
- **The closed identifier union stays at 10**: candidates → `endo.candidate.*`, experiments → `endo.experiment.*`, everything else (artifacts, mutations, ledgers/entries, selection decisions, promotion requests/decisions, transitions) → `endo.evidence.*`. The ledger's kind union is closed eleven-way including `"candidate"`; only a `kind === "candidate"` entry may carry an `endo.candidate.*` recordId.
- **Candidate ≠ artifact ≠ evaluation ≠ selection decision ≠ promotion ≠ authority grant**: each is a distinct record with its own validator. A passing benchmark is not truth (evaluation results are evidence), and a `granted` promotion is a recorded decision — Phase 8's receipts and trust providers close that loop.
- **Content-addressed ledger identity**: `EndoConformanceSuiteV0` and `EndoReplayComparisonV0` have no `id`; the ledger identifies them as `endo.evidence.<kind>.<sha256(canonical JSON)>`, so identical content collides and different content does not. All other records use their own `id`.
- **The core does not cross-check mutation→artifact**: `evolution/core.ts` cross-checks candidate→parent+mutations, selection→candidate, promotionRequest→candidate+selected-selection, promotionDecision→request; a mutation's `artifactId` reference is enforced only by the evidence ledger's append-time integrity. The core registries store; the ledger is the causal chain.
- **State is not data**: the experiment state lives in the lifecycle closure (read-only) and is reconstructed by replay; `EndoExperimentRecordV0` carries no state field, and the transition table is the single source of legality — an illegal from→to is an invalid protocol value, not a service error.
- **Proposal ≠ executed effect**: a mutation is a proposal (operation + component + optional artifact/hypothesis/effects); nothing in Phase 6 applies a mutation, deploys an artifact, or calls an evaluator — Phase 7 policies and Phase 8 providers do the doing.

- **Status (2026-10-02, done):** `protocol/evolution.ts` + four
  `evolution/` modules + four suites (191 tests); self-check at
  §10.9.

### 5.18 Phase 7 components (RRSI + REEF provider seams)

Phase 7 scope (README "## Phase 7 — RRSI + REEF providers"): the
policy seam through which any adaptation policy — RRSI first, GEPA or
another harness-evolution method later — reads an Endophasia
experiment and records a selection decision under the same
experiment and evidence semantics (README lines 376–407), plus the
REEF adapter that maps REEF's scenario, receipt, feedback, candidate,
artifact, and release records into the common experiment/evidence
model (README lines 340–372). Phase 7 is seams, not implementations:
no RRSI LLM proposer/critic, no REEF HTTP client, no GEPA internals,
no network — all of that stays provider-side behind the seam. Donor
re-check (read-only, word-boundary, `research/prime-conformance/`):
every `provider` match is ACP LLM-API conformance plumbing
(`fake-provider.ts`, base URLs, request/usage/failure records) and
the single `policy` match is the publication-gate comment in
`publication.ts` — no selection policy, no candidate comparison, no
harness-evolution loop: no Phase 7 analogue, BUILD.

| README requirement | Disposition |
| :--- | :--- |
| RRSI policy provider | `evolution/policies/ports.ts`: `EndoEvolutionPolicyContextV0` — exactly the records the substrate keeps (experiment, candidate/mutation histories, results, held-out, the ledger's causal chain) — + `EndoEvolutionPolicyV0` `{ policy: endo.selection-policy.v0, decide(context, id) }`: pure and deterministic over the context, the caller supplies the decision id, the returned record is valid by the Phase 6 selector. A provider implements only the capability it can provide truthfully; a method that needs live traffic, an LLM judge, or a served state stays provider-side, not a selection policy |
| GEPA or other harness-evolution provider | the same seam: the `EndoSelectionPolicyV0` identity (name + revision) is what the substrate stamps on every decision, so RRSI versus GEPA versus a custom rule set compare under identical experiment and evidence semantics — one interface, no per-method shapes |
| REEF adaptation provider | `adapters/reef/{shapes,mapping}.ts`: seven REEF mirror shapes + seven pure mappers (scenario→experiment, report→evaluation result, mutation→mutation, candidate→candidate, artifact→artifact, release→promotion request, release→promotion decision); every input crosses a strict door, every output exits through the Phase 6 validators — the REEF service itself stays external |
| Candidate-evidence mapping | report receipts become one trial each (`endo.run.reef-<receipt>`, 0-based index, candidate-stamped coordinates), `score` → `derived.score` (finite-number door), `feedback` → `trial.raw` (strict-JSON door); the baseline policy's `selected` outcome carries exactly the best candidate's scored evolve-set result ids as `evidence` and its scored held-out ids as `heldOutEvidence` |
| Release-version integration | release → promotion request (target defaults to `reef release <releaseId>`, artifact optional) → `granted` promotion decision (`authority` defaults to `reef-<releaseId>` — a recorded identity, never a grant); rollback is a NEW request+decision pair pointing the same component back at the prior content: append-only, decision-not-effect |

Design decisions:

- **Seams, not implementations**: `evolution/policies/` holds only the context/capability types and one algorithm-neutral baseline; no RRSI/GEPA internals, no HTTP, no model serving, no Python in the tree. `evolution/` still imports only `protocol/` + `runtime/contracts/` + intra-evolution; `adapters/reef/` only `protocol/` + `runtime/contracts/` + `evolution/`. The Phase 6-reserved `policies/` directory lands now, per §5.17.
- **RRSI → substrate mapping (documented, not built)**: one edit → one `endo.mutation.v0`; the L_t edit history → mutations + evaluation results + selection decisions in ledger order; the noise band δ, cost rule, and guards → `endo.selection-condition.v0` entries `{name, parameters, observed, met}`; the evolve/held-out/ood splits → `ENDO_EVALUATION_PARTITIONS_V0`; the annealed budget, tried set, stall handling, exploration, critic, and novelty/prune bookkeeping stay provider-internal state behind the seam.
- **The baseline policy is the seam's executable spec**: `ENDO_HIGHEST_SCORE_POLICY_V0` (identity `highest-score`/`v1`) — a trial's score is a finite `derived.score` only (absent or non-finite contributes nothing); evidence is the union of `results` ∪ `heldOut` deduped by record id; the three conditions are always recorded — `evidence-present`, `strictly-best` (exactly one candidate holds the unique max evolve-set mean; a tie records nulls), `held-out-present` (the best has ≥1 scored held-out trial); all met → `selected`, otherwise `inconclusive` naming the first unmet condition; never `rejected`. A policy that cannot truthfully select says so in the record.
- **Honest absence through the mapper**: a report without score/feedback maps to a trial without `derived`/`raw` (never invented); a report without receipts, a non-finite score, a non-strict feedback, a receipt outside the run-identifier grammar, an entry path the kind grammar rejects, or an evidence id outside `endo.evidence.*` is a `TypeError` at the door — the adapter records REEF data, it does not launder it.
- **Candidate ≠ artifact ≠ evaluation ≠ selection ≠ promotion ≠ authority holds end-to-end**: the adapter integration drives a REEF scenario through the full Phase 6 spine — scenario→experiment, mutation, candidate, two reports, the seven-step lifecycle, the baseline `selected`, the released artifact, request/decision, and a rollback pair — then replays the 18-entry ledger and the lifecycle; the replayed state is `promoted` with the same transitions and a content-identical ledger.

- **Status (2026-10-02, done):** two `evolution/policies/` modules +
  two `adapters/reef/` modules + `evolution/index.ts` (+2 re-exports)
  + two suites (41 tests); self-check at §10.10.

### 5.19 Phase 8 components (Trust integrations)

Phase 8 scope (README "## Phase 8 — Trust integrations", lines
1274–1282): the Cogitator witness integration, the Magpie
epistemic integration, and the Deadbolt authority integration —
kept optional and protocol-bound. Phase 8 is seams, not
implementations: no Rust, no network, no filesystem, no provider
internals in the tree — each provider stays external behind its
seam. Donor re-check (read-only, case-insensitive, over the whole
donor): 16 `cogitator|magpie|deadbolt` matches, all prose — 15 in
`endophasia-source/README.md` (the roadmap's "Magpie integration,
Deadbolt integration … are future work" and the "Magpie and
Deadbolt" section, lines 372–405) and one in
`docs/prime-runtime-conformance-v0.md:329` — and zero Cogitator
matches anywhere; no trust-provider code in `packages/`: no
Phase 8 analogue, BUILD.

| README requirement | Disposition |
| :--- | :--- |
| Cogitator witness integration | `adapters/cogitator/{shapes,mapping}.ts`: a mirror of the documented witness bundle shape + a pure mapper to `endo.witness.v0` (`protocol/trust.ts`) — `runId` verbatim, `witnessRoot` and the optional `expectedRoot` 64 lowercase hex, `witnessAlgorithm` closed at `blake3`, and the verification state DERIVED, never trusted: recomputed root absent → `not-verified`, recomputed ≠ root → `recomputed-mismatched`, equal → `recomputed-matched`, `externally-confirmed` only when a separately recorded `expectedRoot` also agrees (the one level that detects wholesale bundle replacement); a root anchors integrity, not occurrence |
| Magpie epistemic integration | `adapters/magpie/{shapes,mapping}.ts`: a mirror of the documented standing-output shape + a pure mapper to `endo.standing.v0` — `claimId` verbatim (1–256), `policy` closed at `v0`–`v4` (caller-selected, no default), `standing` closed at four values, `evidence` `endo.evidence.*` ids, and the door enforces the per-policy ceiling (`ENDO_STANDING_CEILING_V0`) — a standing above its policy's ceiling is a `TypeError`, never a repair; `v2`/`v3` never record `settled`, and failure is recorded, never falsified |
| Deadbolt authority integration | `adapters/deadbolt/{shapes,mapping}.ts`: mirrors of the documented lease and receipt shapes + two pure mappers to `endo.lease.v0` / `endo.receipt.v0` — typed route (well-formed dotted kind, ≤128), the lease bound to the exact record, `outcome` closed three-way, `result` strict JSON — plus `trust/authority.ts::verifyEndoPromotionClosureV0(request, decision, lease, receipt)`: the derived closure report with the five conditions in fixed order (decision-granted, decision-matches-request, lease-binds-decision, receipt-closes-lease, receipt-route-matches); a rolled-back or refused receipt still closes the loop at its recorded outcome; a closure is a report, never a grant — "The model may suggest. Authority stays outside the model." |

Design decisions:

- **All four trust records live in `endo.evidence.*`**: witness, standing, lease, and receipt join the Phase 6 spine in the same append-only evidence ledger — the closed 10-way identifier union is intact, and a trust record is a record like any other: named, ordered, replayable.
- **Ledger kind union 11 → 15, with forward-reference wiring**: `evolution/evidence.ts::referencesV0` gains four cases — witness → `[]` (a root stands on its own), standing → `record.evidence`, lease → `[record.boundTo]`, receipt → `[record.leaseId, ...(record.rollbackOf ?? [])]`; and the existing promotion-request case already references its `selectionId`, so the ledger enforces the full causal order: a lease before its decision, or a receipt before its lease, is not a ledger.
- **Reports are derived views, not ledgerable**: `endo.witness-coverage.v0` and `endo.promotion-closure.v0` carry validators for serialization and round-trip, but they are outside the ledger's kind union — computed from named records, never recorded as if they were events.
- **Seams, not implementations**: `trust/` imports only `protocol/`; `adapters/{cogitator,magpie}/` only `protocol/`; `adapters/deadbolt/` `protocol/` + `runtime/contracts/` (the strict-JSON door on the receipt result). No Rust, no HTTP, no Ed25519, no BLAKE3 in the tree — the providers' epistemic state is recorded, never re-derived: the signed chain, the hash chain, and the signed lease stay provider-side.
- **The spine is a 21-entry ledger + the seven-step lifecycle + a closed closure report**: the integration drives two results, two witnesses, the selection → request → decision spine, a standing, a lease, and a receipt through the full lifecycle; the replayed ledger is content-identical, the state is `promoted`, and the closure report closes at the recorded `committed` outcome.
- **Strict-JSON door hardening (house-wide)**: `protocol/trust.ts` and `protocol/evaluation.ts` carried an identical `isStrictJsonValue` with a prototype hole — `Object.entries(new Date())` is `[]`, so `Date`/`Map`/class instances passed as strict JSON, contradicting `runtime/contracts/canonical-json.ts::assertPlainJsonValueV0` in the same dependency chain. Both copies now gate on a plain-object prototype (Object.prototype or null) — what `JSON.parse` cannot produce is not strict JSON; the full-suite re-run confirms no pre-existing test pins the hole.

- **Status (2026-10-02, done):** `protocol/trust.ts` + three
  `trust/` modules + six `adapters/{cogitator,magpie,deadbolt}/`
  modules + `protocol/evolution.ts` (ledger kind union 11 → 15) +
  `protocol/evaluation.ts` (strict-JSON door) + four suites (106
  tests); self-check at §10.11.

### 5.20 Phase 9 components (Runtime expansion)

Phase 9 scope (README "## Phase 9 — Runtime expansion", lines
1286–1294): the Prime research adapter, the Codex conformance
study, and additional runtimes — "Runtime admission remains
evidence-based." Phase 9 is seams, not implementations: no Rust,
no network, no filesystem, no provider process in the tree — each
runtime stays external behind its seam, and an admission record
names evidence; it does not start a runtime. Donor re-check
(read-only, case-insensitive, over the whole donor): the
meaningful `prime`/`codex` matches are all roadmap and
conformance prose — `endophasia-source/README.md:185` (Pi is the
reference runtime, Codex a future candidate, Prime's admission
dormant after the sealed 0.9.7 audit), `README.md:305–321` (the
sealed Prime 0.9.7 study at
`08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`: 12 RPC + 15 ACP
scenarios, probe `0.14.7`, "admits no exact capability," the
recorded blockers — durable operation/outcome identity, complete
lifecycle semantics, committed Usage allocation/paging, matching
continuity/context semantics — plus "a version bump alone is
insufficient," "transport ingress does not imply an admitted
runtime," and the Codex app-server surfaces: threads, turns,
items, steering, interruption, forks, compaction, usage, review,
approvals, and runtime settings, in the planned order "transport
first, evidence second, admission last"), `README.md:445` ("Codex
remains a candidate until its own pinned study exists"), and
`docs/conformance-lab-v0.md:76` ("A genuinely different second
subject should inform any later abstraction; sharing transport
shape is insufficient"); the `packages/` matches are the OpenAI
"codex" model-API strings in `packages/ai/scripts/generate-models.ts`
(model-catalog noise); no runtime-admission record, mapper, or
check code in `packages/`: no Phase 9 analogue, BUILD (seams
only).

| README requirement | Disposition |
| :--- | :--- |
| Prime research adapter | `adapters/prime/{shapes,mapping}.ts`: a mirror of the documented probe-outcome shape + a pure mapper to `endo.conformance-study.v0` — subject pinned `"prime"`, classification closed five-way (`ENDO_CONFORMANCE_CLASSIFICATIONS_V0`), evidence entries hex64 or `endo.evidence.*`, field-grammar doors at the protocol's 256/4096 caps, absent arrays defaulting to `[]`, extra keys ignored; exits through `validateEndoConformanceStudyV0`. The probe transport (`adapters/prime/transport/`: jsonl, limits, process-group, rpc-connection, runtime-identity) is Phase 0 and byte-verified; the mapper reads recorded outcomes only |
| Codex conformance study | `adapters/codex/{shapes,mapping}.ts`: a deliberately independent second mapper — per `docs/conformance-lab-v0.md:76` a genuinely different second subject, sharing no abstraction with the Prime mapper — with the subject pinned `"codex"`, the identical doors, and the documented app-server surface vocabulary `CODEX_APP_SERVER_SURFACES_V0` (threads, turns, items, steering, interruption, forks, compaction, usage, review, approvals, runtime-settings) recorded as a documented vocabulary, not a mapper door. No transport: the donor's planned order is transport first, evidence second, admission last — Phase 9 lands the evidence shapes only |
| Additional runtimes | `protocol/runtime.ts` + `runtime/admission.ts`: the runtime admission record `endo.runtime-admission.v0` (status closed four-way candidate/dormant/reference/admitted with per-status doors — `reference` pinned to subject `"pi"` with zero blockers; `dormant` requires recorded evidence and recorded blockers; `admitted` requires recorded evidence; `candidate` the floor) and the derived check report `endo.runtime-admission-check.v0` (`holds` ↔ empty violations) that decides whether a position holds against the presented conformance suites: every presented suite must name the record's exact subject and version, and `admitted` requires at least one EXACT study across the presented suites — a sealed audit that admits no exact capability cannot admit |

Design decisions:

- **A 16th evidence kind, ledgerable**: `runtime-admission` joins `ENDO_EVIDENCE_KINDS_V0` (15 → 16) and the `evolution/evidence.ts` kind/validator/references maps; an admission cites its conformance suites by record id and the ledger enforces the causal order — a suite must be appended before the admission that cites it. The admission carries its own id (not content-addressed), so its ledger identity is `record.id`.
- **The check is a derived view, not ledgerable**: `endo.runtime-admission-check.v0` carries a validator for serialization and round-trip (including the holds/violations agreement door), but sits outside the ledger's kind union — computed from named records, never recorded as an event.
- **The reference runtime is a checkable record, not prose**: `reference` is a closed status whose door pins the subject to `"pi"` with zero blockers — the donor's "Pi is the reference runtime" becomes a record that can be appended to the evidence ledger.
- **Seams, not implementations**: `protocol/runtime.ts` imports only `protocol/identity.ts` (zero-dependency, no `node:crypto`); `runtime/admission.ts` imports only `protocol/`; `adapters/{prime,codex}/` import only `protocol/`. No Rust, no HTTP, no process spawn, no provider internals — the Prime probe transport stays behind the Phase 0 `adapters/prime/transport/` boundary.
- **Two independent mappers, one neutral record**: the Prime and Codex mappers deliberately duplicate their shape and door code rather than share a second-subject abstraction (`docs/conformance-lab-v0.md:76`); both exit to the same neutral `endo.conformance-study.v0`, so the evidence ledger never knows which runtime recorded a study.

- **Status (2026-10-02, done):** `protocol/runtime.ts` +
  `runtime/admission.ts` + four `adapters/{prime,codex}/` modules +
  `protocol/evolution.ts` (ledger kind union 15 → 16) +
  `evolution/evidence.ts` (ledger wiring) + four suites (67
  tests); self-check at §10.12.

### 5.21 Phase 10 components (Model/runtime orchestration)

Phase 10 scope (README "## Phase 10 — Model/runtime
orchestration", lines 1298–1309): ModelPool,
capability-aware routing, adaptive concurrency, queueing,
retries, health, performance/resource telemetry, local-model
integrations. Non-goal (README:1334): "a model-serving engine" —
nothing here serves, calls, or contacts a model. Phase 10 is
seams, not implementations: the model stays external behind its
profile record, the scheduler steps recorded state and events,
and telemetry is a record of observations, not a collector.
Donor re-check (read-only, case-insensitive, over the whole
donor): zero meaningful `ModelPool`/`model pool` matches in
`*.md`/`*.ts` (excluding node_modules); the
routing/concurrency/queue/retry/telemetry matches are all
Prime-conformance prose
(`docs/prime-runtime-conformance-0.9.7.md`,
`prime-runtime-conformance-v0.md:92,174,176,316,323,324`,
`prime-runtime-ingress-v0.md:46,73,140,273`,
`runtime-observation-boundary-v0.md:89`) and the README
STEER/QUEUE/STOP prose (README.md:39,88,155–156); the local-model
prose is README:257 ("never fabricated for API-only models"),
270 (Model profile definition), 278, 354, 424; no `models/`
directory pre-existed (deferred in §8): no Phase 10 analogue,
BUILD (seams only).

| README requirement | Disposition |
| :--- | :--- |
| ModelPool | `protocol/models.ts`: `endo.model-pool.v0` — a named pool of at least one member, each citing a profile by its `endo.model.*` id and declaring a `maxConcurrency` bound (integer ≥ 1), members unique. The pool is a record, not a process: it names capacities, it consumes none |
| Capability-aware routing | `models/orchestration.ts`: `routeModelV0` — given a pool, the presented profiles of its members, and requested capabilities (unique, each 1–512), computes the eligible members (pool order, capabilities ⊇ all requested) and selects the lexicographic first; the result is the derived report `endo.model-routing-decision.v0` (`reason` closed two-way capability-match / no-eligible-model, with the `(selected !== null) === (reason === "capability-match")` and selected-∈-eligible doors). Doors throw `TypeError` for an invalid pool or profile, a double presentation, a missing member profile, and a profile that is not a member |
| Adaptive concurrency, queueing, retries | `models/orchestration.ts`: `stepPoolSchedulerV0` — a pure step over the scheduler state `endo.pool-scheduler-state.v0` (per-member `inFlight` counts, FIFO `queue` of model ids) driven by `endo.pool-scheduler-event.v0` (enqueue / complete / retry; `attempt` present exactly on retry). Admits the queue head while its member is under its `maxConcurrency` bound (FIFO, head-of-line blocking, no overtaking); a retry re-enqueues at the tail — a recorded event, not a state field |
| Health, performance/resource telemetry | `protocol/models.ts`: `endo.model-telemetry.v0` — a ledgerable observation record per model: `health` closed three-way healthy/degraded/unhealthy plus non-negative counters `calls`/`tokensIn`/`tokensOut`/`failures`/`durationMs`. A record of what was observed, not a collector; the all-zero window is a valid record |
| Local-model integrations | `endo.model-profile.v0`: `deployment` closed two-way hosted/local and `observation` closed two-way none/j-space, with the door `hosted ∧ j-space → null` — the donor's "never fabricated for API-only models" (README:257) becomes a validator door. **No local-model adapter**: the donor documents no local-model wire shape at all (unlike Cogitator, Prime, Magpie, and Deadbolt, which have documented bundles); inventing one would violate honest absence. The integration seam is the profile record itself |

Design decisions:

- **Three ledgerable kinds, two derived reports**:
  `model-profile`, `model-pool`, and `model-telemetry` join
  `ENDO_EVIDENCE_KINDS_V0` (16 → 19) and the
  `evolution/evidence.ts` kind/validator/references maps; the
  pool cites its members' model ids and telemetry cites a model
  id, so the ledger enforces causal order — a profile must be
  appended before the pool or telemetry row that cites it.
  `endo.model-routing-decision.v0` and
  `endo.pool-scheduler-state.v0` / `-event.v0` sit outside the
  kind union: computed or presented, never recorded as events.
- **Profiles and pools live in `endo.model.*`**: the entry
  namespace rule of `validateEndoEvidenceLedgerEntryV0` is
  three-way now (candidate → `endo.candidate.*`;
  model-profile/model-pool → `endo.model.*`; every other kind →
  `endo.evidence.*`); the evolution-protocol suite pins all three
  directions.
- **All three ledgerable records carry ids**: the
  `ledgerIdentityV0` default (`record.id`) covers them — no
  content addressing.
- **The scheduler is a pure step, not a loop**: one event in,
  one state out; the state is a snapshot (per-member in-flight
  counts, zero rows when idle, the queue), not an event log; the
  pump stops at the first head-of-line item whose member is at
  its bound.
- **Seams, not implementations**: `protocol/models.ts` imports
  only `protocol/identity.ts` (zero-dependency, no
  `node:crypto`); `models/orchestration.ts` imports only
  `protocol/models.ts`. No network, no filesystem, no Rust, no
  model calls — a routing decision and a scheduler step are
  computations over records, not contact with a model.

- **Status (2026-10-02, done):** `protocol/models.ts` (six
  shapes) + `models/orchestration.ts` (routing + scheduler) +
  `protocol/evolution.ts` (ledger kind union 16 → 19, entry
  namespace rule) + `evolution/evidence.ts` (ledger wiring) +
  three suites (67 tests); self-check at §10.13.

### 5.22 Phase 11 components (Collaboration)

Phase 11 scope (README "## Phase 11 — Collaboration",
lines 1313–1322): add Buzz integration — experiments as
rooms, candidate discussions, evidence/receipt links,
approval flows, repository/patch context, and
human-in-the-loop steering. Non-goal: nothing here runs a
relay, opens a socket, signs a nostr event, or contacts
Buzz — Phase 11 is records and one pure summarizer, not an
integration. Donor re-check (read-only, case-insensitive,
over the whole donor): zero `buzz` matches anywhere in
`*.md`/`*.ts` (excluding node_modules); the
`room`/`discussion`/`approval`/`steering`/`patch` matches
are all colloquial or other-domain (the README's "leaves
room for disagreement", the Pi tool-approval gates,
release-lockstep patching, the README's STEER/QUEUE/STOP
prose at README.md:39,88,155–156); `feature branch` → 0.
No Phase 11 analogue in the donor: BUILD (seams only).
**No Buzz adapter**: the donor documents no Buzz wire shape
at all; the Buzz notes (`/tmp/p8/buzz-prime.md`) are prose
only ("Agents are members, not bots"; "Name it, describe
it, make it private"; the status table marks relay /
channels / threads / DMs done and "Workflow approval gates"
in progress). The seam is the record itself; an adapter
would be invention.

| README requirement | Disposition |
| :--- | :--- |
| Experiments as rooms | `protocol/collab.ts`: `endo.collab-room.v0` — `experimentId` cites the experiment seed by its `endo.experiment.*` id (provenance, not a ledger reference — §below), `title` 1–256, optional `summary` 1–4096, `visibility` closed two-way open/private |
| Candidate discussions | `endo.collab-discussion.v0` — one post by a `human`/`agent` author (name 1–256) in a room about a candidate, body 1–8192, citing the room and the candidate |
| Evidence/receipt links | the discussion's `evidenceRefs` / `receiptRefs` and the approval request's `evidenceRefs`: lists of unique `endo.evidence.*` identifiers that must already be ledger entries when the record is appended |
| Approval flows | `endo.collab-approval-request.v0` (candidate, `rationale` 1–4096, cited evidence) and `endo.collab-approval-decision.v0` (cites the request by id, `outcome` closed three-way approved/rejected/changes-requested, `deciderKind`/`decider` 1–256, required `reason` 1–4096 — a decision without a reason is not a decision) |
| Repository/patch context | `endo.collab-patch.v0` — `repo` 1–512, `branch` 1–256, `patchId` 1–256, `status` closed three-way open/merged/closed (the NIP-34 git-event vocabulary the Buzz notes name for patches and repo announcements) |
| Human-in-the-loop steering | `endo.collab-steering.v0` — reuses `SteeringActionV0` from `protocol/steering.ts` (steer/queue/stop) with the door: `stop` carries no instruction, `steer`/`queue` require one (1–4096) |

Design decisions:

- **Six ledgerable kinds, one derived report**:
  `collab-room`, `collab-discussion`,
  `collab-approval-request`, `collab-approval-decision`,
  `collab-patch`, and `collab-steering` join
  `ENDO_EVIDENCE_KINDS_V0` (19 → 25) and the
  `evolution/evidence.ts` kind/validator/references maps;
  all six carry `endo.evidence.*` ids, so there is no new
  identifier namespace and the entry namespace rule of
  `validateEndoEvidenceLedgerEntryV0` is unchanged (the six
  fall in the `endo.evidence.*` branch).
  `endo.collab-room-report.v0` sits outside the kind union:
  `collab/room-report.ts` `summarizeCollabRoomV0` derives it
  from a validated room plus the presented room records —
  per-candidate discussion counts (candidate order), the
  sorted unique union of cited evidence and receipt
  references, one approval row per presented request
  (the decision's outcome, or `null` when undecided), patch
  rows in patch-id order, and the steering counts; it
  exits through `validateEndoCollabRoomReportV0`.
- **A room references nothing**: the experiment is the
  ledger's seed, not an appendable entry, so the room's
  `referencesV0` is `[]`; `experimentId` is provenance
  recorded on the room, and the ledger enforces it by
  namespace, not by reference.
- **Causal chains are the ledger's job**: a discussion
  needs its room, candidate, and every cited ref already
  appended; a request needs its room, candidate, and refs;
  a decision needs its request; a patch and a steering
  record need their room. Duplicated record ids are
  rejected.
- **Two decisions for one request is a door**: the
  summarizer refuses the presented records instead of
  adopting "last presented wins" — an ambiguous record
  presentation is a defect, not a choice to make.
- **Seams, not an integration**: `protocol/collab.ts`
  imports only `protocol/identity.ts` and
  `protocol/steering.ts` (zero-dependency, no
  `node:crypto`); `collab/room-report.ts` imports
  `protocol/collab.ts` and
  `runtime/contracts/canonical-json.ts`. No network, no
  sockets, no nostr, no filesystem, no Rust — a Buzz
  adapter, if one is ever built, is a later phase against
  a documented wire shape.

- **Status (2026-10-02, done):** `protocol/collab.ts`
  (seven shapes) + `collab/room-report.ts` (summarizer) +
  `protocol/evolution.ts` (kind union 19 → 25) +
  `evolution/evidence.ts` (ledger wiring) + three suites
  (73 tests); self-check at §10.14.

### 5.23 Phase 12 components (Operational substrate & integration)

Phase 12 scope (README "## Phase 12 — Operational
substrate & integration"): durable storage, a thin operator CLI,
neutral runtime ports, the provider contract with an
OpenAI-compatible adapter, model routing and concurrency policies,
RRSI and GEPA policy seams, immutability and strict-JSON
hardening, and the integration harness. Non-goals held: no relay or
socket, no model-serving engine, no general-purpose database; the
provider adapter takes an injected transport, and nothing in this
phase promotes a candidate. Donor re-check (read-only): no donor
module provides frame-based durable storage, a CLI, a neutral
lane-port surface, or an injected-transport provider adapter; the
nearest donor seams stay as recorded in §5.4. No Phase 12 analogue
in the donor: BUILD (new substrate; the donor carries no RRSI/GEPA
documentation, so the policy seams are records and named constants,
not ports to a documented wire shape).

| README requirement | Disposition |
| :--- | :--- |
| Frame log | `storage/log.ts`: `<u32be length><payload><sha256(length header plus payload)>` frames over sync `node:fs` I/O; open classifies the tail — torn frame → truncate to the last verified frame (recovery reported), digest mismatch → seal at `corruptAt` (append disabled, the verified prefix stays readable), undecodable frame → TypeError at open; a log is never silently repaired |
| Artifact store | `storage/artifacts.ts`: content-addressed files at `<root>/artifacts/<sha256hex>`; `put` is idempotent (same bytes and hash → `{created:false}`; an existing file with a different hash → TypeError), `get`/`has` re-verify the stored hash, `list` is sorted |
| Durable event store | `storage/event-store.ts`: `events.log` + the in-memory store replayed from verified frames; `record` is the digest-pinned event stream; the recovery classification is surfaced on every open |
| Durable evidence ledger | `storage/ledger.ts`: `ledger.log` + `ledger.meta.json` + `ledger.snapshot.json`; `append` validates through the closed evidence-kind map and writes the meta on first append; `replay()` classifies the layer `empty`/`log`/`snapshot`/`snapshot+log` with per-entry verification; `snapshot()` writes the snapshot, then truncates the log to it |
| Operator CLI | `cli/commands.ts` + `cli/index.ts` (`COMMANDS_V0` dispatch): `status`, `events`, `ingest`, `ledger`, `artifacts`; each command prints exactly one canonical-JSON document; `status` omits the ledger key when no meta exists (honest absence); `ledger` never calls `snapshot()` |
| Neutral runtime ports | `runtime/ports.ts`: the four lane-bound capability interfaces (continuity capture, session-overview capture, steering, control deck), each a closure that already knows its own lane or harness; `adapters/pi/ports.ts` supplies the Pi-backed implementations; consumers receive the capability alone, never a lane or harness; re-wired through `runtime/session-worker.ts` |
| Provider contract + adapter | `models/provider/contract.ts` (the neutral request/response/stream/usage/error/capabilities/health seam) + `adapters/provider/openai.ts` (OpenAI-compatible chat + SSE over an injected `request` transport; digest-derived outcome ids; the retryable/error grammar; usage honest-absent when the wire is malformed; no `fetch`, no new dependency) |
| Routing and concurrency | `models/routing-policy.ts` (`routeModelByPolicyV0`, capability-aware over a presented roster) + `models/concurrency-policy.ts` (`createModelConcurrencyPlanV0` / `applyConcurrencyPlanV0` — bounded slots and deterministic ordering on the Phase 10 `models/orchestration.ts` scheduler) |
| RRSI and GEPA seams | on the Phase 7 policy boundary (`evolution/policies/ports.ts`: the context is exactly the records the substrate keeps, the output exactly `EndoSelectionDecisionV0`; `baseline.ts`: the highest-score rule set) this phase adds `rrsi.ts` and `gepa.ts` (named policy constants); a policy result is evidence, never promotion authority; the protocol records which policy decided and never executes one |
| Immutability + strict-JSON | `runtime/contracts/immutability.ts` (`deepFreezeV0`, `deepFreezeCopyV0` at the service exits); the 13 hardened `protocol/*` modules apply the `isPlainJsonObjectV0` plain-object door and finite-number checks to their fields; `tests/endo-strict-json-audit.test.ts` audits the class parametrically (13 representative validators × 5 cases + the predicate + non-finite numbers) |
| Integration harness | `tests/endo-integration-harness.test.ts`: golden path (record → compact → close → reopen → replay → verify, content-identity by canonical-JSON `toBe`), adversarial (torn tails, digest mismatch, undecodable frames, tampered artifact — refused, never repaired), persisted e2e (torn tails on both logs, recover, replay, continue, snapshot+log layer) |

Design decisions:

- **Storage and CLI are host infrastructure**: they may use
  `node:crypto`/`node:fs` (sync only) and may import core services;
  `tests/endo-host-import-boundary.test.ts` pins that `storage/` and
  `cli/` import nothing from `pi/`, `adapters/`, or
  `presentation/` (their import set is `node:crypto`, `node:fs`,
  `node:path`, and relative `protocol/`/`runtime/`/`evolution/`/
  `storage/` modules only).
- **Refuse, never repair**: the only automatic recovery is
  truncating a torn tail to the last verified frame; every other
  corruption seals the log (append disabled, prefix readable) or
  throws at open. The CLI and the replay reports surface the
  classification verbatim.
- **The provider seam is transport-injected**:
  `adapters/provider/openai.ts` takes a `request` function at its
  door; the wire grammar (SSE in-order deltas, `[DONE]`, usage from
  the first well-formed chunk, health via `GET <endpoint>/models`)
  is validated into the protocol shapes and exits through their
  validators.
- **Policy result ≠ promotion authority**: the RRSI/GEPA/baseline
  constants emit selection decisions that enter the ledger as
  evidence records; no Phase 12 module promotes a candidate or
  mutates a mutation.

- **Status (2026-10-03, done):** `storage/{log,artifacts,event-store,
  ledger,index}.ts`, `cli/{commands,index}.ts`, `runtime/ports.ts`,
  `adapters/pi/ports.ts`, `models/provider/contract.ts`,
  `adapters/provider/openai.ts`, `models/{routing-policy,
  concurrency-policy}.ts`, `evolution/policies/{rrsi,gepa}.ts` (on the
  Phase 7 policy boundary `ports.ts`/`baseline.ts`),
  `runtime/contracts/immutability.ts`, the 13 hardened
  `protocol/*` modules, and ten new suites (206 tests); self-check at
  §10.15.

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
     Phase 12 adds five host-bound modules to the forbidden set
     (`scripts/check-browser-smoke.mjs:95-101`):
     `runtime/ports.ts`, `adapters/pi/ports.ts`, and
     `adapters/pi/{steering,control-deck,session-overview}.ts` —
     the lane ports and their Pi-backed implementations stay on the
     host; the bundled contracts reach them only through neutral
     closures; `adapters/prime/**`, `research/**`.
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

- Protocol: the remaining five of the README's 14 object types have no
  v0 envelope yet (Artifact, Decision, Proposal, Receipt, Evaluation)
  and their namespaces are v1 additions to `ENDO_IDENTIFIER_KINDS_V0` —
  each lands with the phase that owns it (the Evaluation shapes landed
  in Phase 5 as `endo.evaluation-*/conformance-*/replay-*/experiment-bundle.v0`;
  the Evidence result types with Phase 6); the VisualizationState v0
  envelope landed in Phase 4 as `endo.semantic-visual-state.v0`. The schema/IR/
  code-generation approach (README line 714) lands only after the protocol
  stabilises.
- Prime conformance as a live gate; Codex adapter; the cockpit/
  presentation wiring for the Phase 4 scenes.
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

### 10.6 Phase 3 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the ten scope directories: 124 files, no fixes
  needed (after `--write` normalized the new protocol module, the five
  graph modules, and the five suites + fixture).
- `grep -rn '@earendil-works/pi-' protocol/ graph/`: 0 matches. Import
  direction: `protocol/graph.ts` imports only `./identity.ts` and
  `./object.ts` (intra-protocol; `protocol/` remains zero-dependency);
  `graph/` imports only `protocol/` + `runtime/contracts/canonical-json.ts`
  (store only) + intra-graph.
- New suites: `tests/{endo-graph-protocol,endo-graph-store,endo-graph-traversal,endo-graph-projections,endo-graph-subscriptions}.test.ts`
  + shared `tests/graph-fixture.ts` — 5 files, 68 passed: validator
  accept/reject per field for the six new protocol shapes; the strict
  ingestion doors (including the structural-pass / plain-JSON-fail
  Date-payload seam); per-id revisions plus the global sequence;
  adjacency rebuild on edge endpoint movement; the README traversal
  pipeline verbatim (budgets, direction, relation filtering with the
  snapshot-includes-all-edges-between-visited semantics, honest
  `truncated`/`missing`, expansion from a missing root); temporal
  projection over the revision log (sequence points, edge revisions,
  beyond-log-end = current state); subscription semantics (registration
  order, throwing listener, idempotent unsubscribe,
  unsubscribe-during-emit).
- Full `npx vitest --run`: **55/55 files, 1739 passed, 3 skipped, 0
  failed** (1671 pre-existing + 68 new).
- Donor untouched (read-only): Phase 3 adds no donor files; the
  `DonorGraphScout` re-check found no donor cognition graph or object
  store to port (§5.14).

### 10.7 Phase 4 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the ten scope directories: 179 files, no fixes
  needed (after `--write` formatted the four new modules and the five
  suites + fixture).
- `grep -rn '@earendil-works/pi-' protocol/ visualization/`: 0
  matches. Import direction: `protocol/visualization.ts` imports only
  `./identity.ts` and `./primitives.ts` (intra-protocol; `protocol/`
  remains zero-dependency); `visualization/` imports only
  `protocol/` + `graph/` (store, traversal, projections) +
  intra-visualization.
- New suites: `tests/{endo-visualization-protocol,endo-visualization-semantic-state,endo-visualization-engineering,endo-visualization-dream,endo-visualization-live}.test.ts`
  + shared `tests/visualization-fixture.ts` — 5 files, 65 passed:
  validator accept/reject per field for the fourteen new protocol
  shapes plus the value/origin/reason co-presence per availability;
  whole-store and rooted projection (per-component depth from the
  smallest identifier, `missing`/`truncated` honesty, budgets,
  relation filtering, expansion from an unstored root); the strict
  options doors; temporal rebuild at a past store sequence;
  engineering sections (every row, the empty-store explicit rows,
  degraded-signal rows carrying the recorded reasons, stance
  counting); dream projections (fields, regions, hypotheses,
  clusters, boundaries, motion pass-through); live deliveries
  (synchronous initial, derived motion delta, a dropped delivery not
  advancing the baseline, idempotent unsubscribe,
  unsubscribe-during-delivery).
- Full `npx vitest --run`: **60/60 files, 1804 passed, 3 skipped, 0
  failed** (1739 pre-existing + 65 new).
- Donor untouched (read-only): Phase 4 adds no donor files.

### 10.8 Phase 5 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the eleven scope directories: 182 files, no
  fixes applied (after `--write` formatted the five new modules and
  suites and two unused imports were dropped).
- `grep -rn '@earendil-works/pi-' protocol/ lab/`: 0 matches. Import
  direction: `protocol/evaluation.ts` imports only intra-protocol
  (`./coordinates.ts`, `./event-record.ts`, `./identity.ts`,
  `./primitives.ts`; `protocol/` remains zero-dependency); `lab/`
  imports only `protocol/` + `runtime/contracts/` + `graph/` (store,
  projections) + `visualization/` (semantic state) + intra-lab.
- New suites: `tests/{endo-evaluation-protocol,endo-lab-trials,endo-lab-conformance,endo-lab-bundle,endo-lab-replay-compare}.test.ts`
  — 5 files, 70 passed: per-field validator accept/reject for the
  eight new protocol shapes, the closed partition/policy/
  classification unions, the declared-trial-count invariant, the
  digest grammars; the trial service (exact count, declared order,
  round-robin seeds, per-trial coordinates, raw/derived/partition
  copied only when reported, usage and wall time optional through,
  the strict doors); the conformance suite (declared order, unique
  scenarios, the study names the suite's subject/version/scenario,
  all five classifications first-class, the doors); the experiment
  bundle (digest stable across ids, different across results,
  reference-preserving, the doors); the replay comparison (exact
  when the rebuild reproduces, reconstructed per differing layer,
  unreproducible per absent input, the visualState cascade, the
  doors, snapshot parse normalization).
- Full `npx vitest --run`: **65/65 files, 1877 passed, 3 skipped, 0
  failed** (1807 pre-existing + 70 new).
- Donor untouched (read-only): Phase 5 adds no donor files.

### 10.9 Phase 6 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the eleven scope directories: 192 files, no
  fixes applied (after `--write` formatted the ten new modules and
  suites and an unused import was dropped).
- `grep -rn '@earendil-works/pi-' protocol/ evolution/`: 0 matches. Import
  direction: `protocol/evolution.ts` imports only intra-protocol
  (`./identity.ts`, `./evaluation.ts`, `./primitives.ts`; `protocol/`
  remains zero-dependency, no `node:crypto`); `evolution/` imports only
  `protocol/` + `runtime/contracts/` + intra-evolution.
- New suites: `tests/{endo-evolution-protocol,endo-evolution-core,endo-evolution-experiment,endo-evolution-evidence}.test.ts`
  — 4 files, 191 passed: per-field validator accept/reject for the
  twelve new protocol shapes plus canonical-JSON round-trips over the
  twelve record shapes; the core (digest = SHA-256 of canonical
  content, determinism, mismatch throws, absent-content-needs-digest,
  namespace/kind strictness, duplicate ids across the six registries,
  parent/self-parent, mutation/candidate/selection/promotion
  referential checks, id-sorted listings); the experiment lifecycle
  (the seven-step spine with per-step state and sequence, alternative
  terminals at `compared`, terminal-state attempts, every
  table-illegal from→to pair generated from the 11-state × transition
  table, replay with sequence gaps, from≠previous-to, wrong
  experimentId, duplicate ids, invalid nested transitions); the
  evidence ledger (kind derivation for all eleven schema versions,
  content-addressed identities, duplicate content/ids, unknown schema
  versions, every forward-reference rejection, a full fifteen-record
  causal chain, snapshot immutability; replay tamper detection; a
  cross-layer integration from artifact to promotion).
- Full `npx vitest --run`: **69/69 files, 2069 passed, 3 skipped, 0
  failed** (1878 pre-existing — 1877 at Phase 5 plus the one new
  `evolution` boundary-guard root — + 191 new).
- Donor untouched (read-only): Phase 6 adds no donor files.

### 10.10 Phase 7 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the twelve scope directories: 198 files, no
  fixes applied (after `--write` formatted the five new/changed
  modules and the two suites and an unused import was dropped).
- `grep -rn '@earendil-works/pi-' protocol/ evolution/ adapters/reef/`:
  0 matches; the ten pre-existing `adapters/pi/` matches (the only
  production modules allowed to import Pi, §5.4) are untouched.
  Import direction: `evolution/policies/` imports only `protocol/` +
  intra-evolution; `adapters/reef/` imports only `protocol/` +
  `runtime/contracts/` + `evolution/`; `protocol/` remains
  zero-dependency, no `node:crypto`.
- New suites: `tests/endo-evolution-policies.test.ts` (18 tests) —
  the baseline policy's selected path (evidence + held-out evidence
  ids), mean aggregation across results, unscored and non-numeric
  trials contributing nothing, the no-evidence case, the tie
  (`strictly-best` records nulls), strict-best-without-held-out,
  held-out-only never selecting, a held-out record carried in
  `results`, a record in both arrays counted once, unknown-candidate
  results ignored, determinism over shuffled input order, caller
  identity, the `endo.evidence.*` door, lying shapes, and a
  cross-layer integration from mutation to promotion replayed end to
  end (17 ledger entries); `tests/endo-reef-adapter.test.ts` (23
  tests) — per-mapper accept/negative pairs (id + provenance
  mapping, grammar and prefix-overflow doors, receipts→trials,
  score/feedback doors, the operation map, entry-path→kind, the
  candidate's ordered mutation ids, the content-addressed artifact
  deep-equal against `buildEndoArtifactV0`, release request/decision
  defaults and doors) plus the full REEF→substrate spine integration
  (18 ledger entries, the rollback pair, both replays).
- Full `npx vitest --run`: **71/71 files, 2110 passed, 3 skipped, 0
  failed** (2069 pre-existing at Phase 6 per §10.9 + 41 new: 18
  policy + 23 adapter).
- Donor untouched (read-only): Phase 7 adds no donor files.

### 10.11 Phase 8 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the thirteen scope directories: 209 files,
  no fixes applied (after `--write` formatted the new/changed
  modules and the four suites).
- `grep -rn '@earendil-works/pi-' protocol/ evolution/ trust/ adapters/`:
  0 matches outside `adapters/pi/`; the ten pre-existing
  `adapters/pi/` matches (the only production modules allowed to
  import Pi, §5.4) are untouched. Import direction: `trust/`
  imports only `protocol/`; `adapters/{cogitator,magpie}/` only
  `protocol/`; `adapters/deadbolt/` `protocol/` +
  `runtime/contracts/`; `protocol/` remains zero-dependency, no
  `node:crypto`.
- New suites: `tests/endo-trust-protocol.test.ts` (52 tests) —
  per-record accept/negative pairs on all four trust records
  (closed schema versions, the `endo.evidence.*` namespace doors,
  the run-id door, the hex64 root and digest doors, the closed
  algorithm, the per-policy standing-ceiling matrix, the route
  grammar including the 128-character bound, the receipt
  strict-JSON door including the `Date` prototype hole) plus both
  report validators (fixed condition order, closed/open
  consistency) and the canonical-JSON round-trip of all six
  shapes; `tests/endo-trust-ledger.test.ts` (10 tests) — the closed
  15-way kind union, the forward-reference wiring (the witness
  appends first since it references nothing; standing→evidence,
  lease→boundTo, receipt→leaseId, rollback→superseded receipt,
  each rejected before its reference exists), duplicate record
  ids, the 8-entry full-trust-chain replay, an id-less conformance
  suite's content-addressed identity preceding trust records, and
  trust records reachable from the artifact builder;
  `tests/endo-trust-adapters.test.ts` (33 tests) — per-mapper
  accept/negative pairs: the Cogitator verification-state
  derivation matrix, the expected-root honesty door, the Magpie
  per-policy ceiling matrix and its refusals, the Deadbolt
  route/grammar/hex doors and the receipt strict-JSON door, and
  the rollback receipt superseding its predecessor;
  `tests/endo-trust-core.test.ts` (11 tests) — `witnessCoverageV0`
  (trial order, first matching witness wins, honest absence, the
  doors) and `verifyEndoPromotionClosureV0` (the closed loop, each
  of the five conditions broken in turn, a rolled-back/refused
  receipt still closing at its recorded outcome, the doors, the
  report validating through the protocol), and the 21-entry spine
  integration (the seven-step lifecycle, the replay, the
  lease-before-decision refusal).
- Full `npx vitest --run`: **75/75 files, 2216 passed, 3 skipped,
  0 failed** (2110 pre-existing at Phase 7 per §10.10 + 106 new:
  52 protocol + 10 ledger + 33 adapters + 11 core).
- Donor untouched (read-only): Phase 8 adds no donor files.

### 10.12 Phase 9 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the thirteen scope directories: 218 files,
  no fixes applied (after `--write` formatted the new/changed
  modules and the four suites); `npx biome check runtime/admission.ts`
  (outside the thirteen): 1 file, no fixes applied.
- `grep -rn '@earendil-works/pi-' protocol/ evolution/ trust/ adapters/`:
  0 matches outside `adapters/pi/`; the ten pre-existing
  `adapters/pi/` matches (the only production modules allowed to
  import Pi, §5.4) are untouched; the Phase 9 files
  (`protocol/runtime.ts`, `runtime/admission.ts`,
  `adapters/prime/{shapes,mapping}.ts`,
  `adapters/codex/{shapes,mapping}.ts`) carry no Pi imports.
  Import direction: `runtime/admission.ts` imports only `protocol/`;
  `adapters/{prime,codex}/` import only `protocol/`; `protocol/`
  remains zero-dependency, no `node:crypto`.
- New suites: `tests/endo-runtime-protocol.test.ts` (32 tests) —
  the four-way status matrix with the per-status doors in both
  directions (reference pinned to subject `"pi"` with zero blockers;
  dormant requires recorded evidence and recorded blockers;
  admitted requires recorded evidence), the 128-character subject
  grammar bound, the 256-character version cap, the 512-character
  blocker cap, the 4096-character provenance cap, the
  `endo.evidence.*`-only evidence namespace (hex64 rejected — an
  admission cites evidence, it does not hash it), unknown keys,
  non-object inputs, the holds/violations agreement door, the
  violation-entry grammar, and the canonical-JSON round-trip of
  both shapes; `tests/endo-runtime-ledger.test.ts` (6 tests) — the
  closed 16-way kind union, kind derivation and record identity,
  a no-reference candidate append, the forward-reference refusal,
  the duplicate-id refusal, and the 7-entry runtime chain replay
  (three conformance suites + four admissions, including the
  dormant Prime 0.9.7 record carrying the four recorded donor
  blockers and an admitted record), content-identical after
  `replayEndoEvidenceLedgerV0`; `tests/endo-runtime-adapters.test.ts`
  (17 tests) — per-mapper accept/negative pairs: the Prime probe
  outcome mapped to `endo.conformance-study.v0` with the subject
  pinned `"prime"`, all five closed classifications, the
  non-object and closed-classification doors, the field-grammar
  doors, the evidence-entry door (hex64 or `endo.evidence.*`), the
  limitations cap, absent arrays defaulting to `[]`, extra keys
  ignored; the same set for the independent Codex mapper (subject
  pinned `"codex"`), plus `CODEX_APP_SERVER_SURFACES_V0` deep-equal
  to the eleven documented surfaces, each a well-formed kind;
  `tests/endo-runtime-core.test.ts` (12 tests) —
  `runtimeAdmissionCheckV0`: the full report for a candidate
  studied by no suite, reference/dormant/admitted holds, EXACT
  counting, the admitted-without-EXACT violation, the
  wrong-subject and wrong-version violations, accumulation across
  suites, both `TypeError` doors, the exit through the report
  validator, and the spine integration (a real ledger, the replay,
  a check that holds, and the copy promoted to `admitted` against
  the zero-EXACT suite → `holds: false`).
- Full `npx vitest --run`: **79/79 files, 2283 passed, 3 skipped,
  0 failed** (2216 pre-existing at Phase 8 per §10.11 + 67 new:
  32 protocol + 6 ledger + 17 adapters + 12 core).
- Donor untouched (read-only): Phase 9 adds no donor files.

### 10.13 Phase 10 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the thirteen scope directories plus
  `models/orchestration.ts` (outside the thirteen): 222 files, no
  fixes applied (after `--write` formatted the new/changed modules
  and the three suites).
- `grep -rn '@earendil-works/pi-' protocol/ evolution/ trust/ adapters/`:
  0 matches outside `adapters/pi/`; the ten pre-existing
  `adapters/pi/` matches (the only production modules allowed to
  import Pi, §5.4) are untouched; the Phase 10 files
  (`protocol/models.ts`, `models/orchestration.ts`) carry no Pi
  imports. Import direction: `models/orchestration.ts` imports
  only `protocol/models.ts`; `protocol/models.ts` imports only
  `protocol/identity.ts`; `protocol/` remains zero-dependency, no
  `node:crypto`.
- New suites: `tests/endo-models-protocol.test.ts` (45 tests) —
  the six shapes: profile (hosted/none, local/j-space, and
  local/none accepted; hosted ∧ j-space rejected — the "never
  fabricated for API-only models" door; the closed two-way
  deployment and observation sets; the `endo.model.*` id
  namespace; the 1–256 name; the provider dotted-kind grammar
  including the 129-character reject; capability uniqueness, the
  512-character cap, and non-string entries; unknown fields and
  non-object inputs; canonical-JSON round-trip), pool (two
  members, the bound-1 member, the empty member list, the
  duplicate member, the 0 and 1.5 bounds, the wrong-namespace
  member id, the unknown field, round-trip), telemetry (a valid
  row, the all-zero window, the health three-way rejects, the
  negative and fractional counters, the namespaces, round-trip),
  routing decision (capability-match, no-eligible with null
  selection, the reason↔selected door in both directions,
  selected-∉-eligible, duplicate requested capabilities, the
  namespaces, round-trip), scheduler state (a valid state, the
  idle state, negative and fractional counts, the duplicate row,
  the namespaces, round-trip), scheduler event (enqueue,
  complete, retry with its attempt, retry without/0/1.5 attempt,
  enqueue with an attempt, the closed kinds, round-trip);
  `tests/endo-models-ledger.test.ts` (6 tests) — the closed
  nineteen-way kind union, kind derivation and record identity
  for the three model kinds, the causal-order refusals (a pool
  citing a not-yet-appended model; a telemetry row citing one),
  and the 5-entry model chain replay (two profiles + pool + two
  telemetry rows), content-identical after
  `replayEndoEvidenceLedgerV0`; `tests/endo-models-core.test.ts`
  (16 tests) — `routeModelV0`: pool-order eligibility,
  lexicographic selection, the no-eligible null, the
  missing-member-profile, not-a-member, and double-presentation
  `TypeError` doors, the capability-grammar doors (duplicate and
  513-character), and the exit through the routing-decision
  validator; `stepPoolSchedulerV0`: admission under the bound,
  queuing over the bound with admission on completion, the retry
  re-enqueue at the tail, the different-pool, non-member-event,
  and complete-without-in-flight `TypeError` doors, and the exit
  through the scheduler-state validator; and the spine
  integration (routing + scheduling against a materialized,
  replayed ledger).
- Updated suites: `tests/endo-runtime-ledger.test.ts` (the closed
  kind list, sixteen → nineteen) and
  `tests/endo-evolution-protocol.test.ts` (the closed
  nineteen-way kind reject; the entry-namespace test is
  three-way now and pins model-profile/model-pool to
  `endo.model.*`, model-telemetry to `endo.evidence.*`, and both
  cross-namespace rejects).
- Full `npx vitest --run`: **82/82 files, 2350 passed, 3 skipped,
  0 failed** (2283 pre-existing at Phase 9 per §10.12 + 67 new:
  45 protocol + 6 ledger + 16 core).
- Donor untouched (read-only): Phase 10 adds no donor files.

### 10.14 Phase 11 self-check record (2026-10-02)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the thirteen scope directories plus
  `collab/room-report.ts` (outside the thirteen): 226 files,
  no fixes applied (after `--write` formatted the new modules
  and the three suites).
- `grep -rn '@earendil-works/pi-' protocol/ evolution/ trust/ adapters/`:
  0 matches outside `adapters/pi/`; the ten pre-existing
  `adapters/pi/` matches are untouched; the Phase 11 files
  (`protocol/collab.ts`, `collab/room-report.ts`) carry no Pi
  imports. Import direction: `collab/room-report.ts` imports
  only `protocol/collab.ts` and
  `runtime/contracts/canonical-json.ts`; `protocol/collab.ts`
  imports only `protocol/identity.ts` and
  `protocol/steering.ts` (a type only); `protocol/` remains
  zero-dependency, no `node:crypto`.
- New suites: `tests/endo-collab-protocol.test.ts` (49 tests) —
  the four closed sets (visibility, identity kind, approval
  outcome, patch status) and the seven shapes: room
  (experiment-namespace citation, the 1–256 title and 1–4096
  summary caps, the closed two-way visibility), discussion
  (the author-kind two-way, the 1–256 author and 1–8192 body
  caps, unique evidence/receipt lists, the id/room/candidate
  namespaces), approval request (the 1–4096 rationale, the
  evidence list, the namespaces), approval decision (the
  three-way outcome, the decider-kind two-way, the required
  1–4096 reason — the "a decision without a reason is not a
  decision" door), patch (the three-way NIP-34 status, the
  1–512 repo / 1–256 branch / 1–256 patch-id caps), steering
  (steer/queue/stop, the action-instruction door in both
  directions, the 4096 cap), and the room report (the empty
  report, the row grammars, the duplicate candidate/request/
  patch keys, the steering-count grammar); each shape with a
  canonical-JSON round-trip;
  `tests/endo-collab-ledger.test.ts` (8 tests) — kind
  derivation and record identity for `collab-room`, the
  causal-order refusals (a discussion before its room,
  candidate, or cited refs; a decision before its request; a
  patch or steering record before its room), the duplicate
  record-id refusal, and the 8-entry chain replay (candidate +
  room + artifact + discussion + request + decision + patch +
  steering), content-identical after
  `replayEndoEvidenceLedgerV0`; `tests/endo-collab-core.test.ts`
  (16 tests) — `summarizeCollabRoomV0`: the empty room, the
  per-candidate grouping in candidate order, the sorted unique
  union of evidence and receipt references, the decided and
  undecided approval rows, the patch rows in patch-id order,
  the steering counts, the exit through the report validator,
  and the doors (invalid room, non-array records, a room
  record or an unknown record shape in the list, a duplicate
  record id, a record from another room, a decision citing an
  absent request, two decisions for one request, a duplicate
  patch id); plus the spine (a real ledger appending the
  8-record chain in causal order, replay, summarizing the
  collected records, full-report equality).
- Updated suites: `tests/endo-runtime-ledger.test.ts` (the
  closed kind list, nineteen → twenty-five),
  `tests/endo-models-ledger.test.ts` (the twenty-five closed
  kinds), and `tests/endo-evolution-protocol.test.ts` (the
  closed twenty-five-way reject, and the entry-namespace pins
  adding `collab-room` to `endo.evidence.*` with the
  cross-namespace reject).
- Full `npx vitest --run`: **85/85 files, 2423 passed, 3
  skipped, 0 failed** (2350 pre-existing at Phase 10 per
  §10.13 + 73 new: 49 protocol + 8 ledger + 16 core).
- Donor untouched (read-only): Phase 11 adds no donor files.

### 10.15 Phase 12 self-check record (2026-10-03)

- `npx tsc --noEmit` (root): 0 errors.
- `npx biome check` over the fifteen scope directories
  (`protocol graph visualization lab evolution runtime adapters
  presentation cockpit research storage cli tests scripts models`):
  no fixes applied (after `--write` formatted the new modules and
  suites).
- Import boundary: `grep -rn '@earendil-works/pi-' storage/ cli/`: 0
  matches — `storage/` and `cli/` import only `node:crypto`,
  `node:fs`, `node:path`, and relative `protocol/`/`runtime/`/
  `evolution/`/`storage/` modules;
  `tests/endo-host-import-boundary.test.ts` pins it (4 tests).
- Import direction: `protocol/` zero-dependency (no inbound import
  from below it); `models/provider/` imports `protocol/` only;
  `adapters/provider/` imports `protocol/` + `runtime/contracts/` +
  `models/provider/`; `adapters/pi/ports.ts` imports `protocol/` +
  `runtime/ports.ts` + Pi type-only (the carried `HarnessClosed`
  value import in `adapters/pi/steering.ts` is unchanged).
- `node scripts/check-browser-smoke.mjs`: exit 0, silent (a
  violation prints the forbidden inputs and exits 1) — five
  host-bound
  modules added to the forbidden set at
  `scripts/check-browser-smoke.mjs:95-101`
  (`runtime/ports.ts`, `adapters/pi/ports.ts`,
  `adapters/pi/{steering,control-deck,session-overview}.ts`).
- New suites (ten, 206 tests): `tests/endo-storage.test.ts` (32),
  `tests/endo-cli.test.ts` (10), `tests/endo-lane-ports.test.ts` (9),
  `tests/endo-host-import-boundary.test.ts` (4),
  `tests/endo-provider-openai.test.ts` (18),
  `tests/endo-evolution-rrsi-gepa.test.ts` (23),
  `tests/endo-models-policies.test.ts` (27),
  `tests/endo-immutability.test.ts` (7),
  `tests/endo-strict-json-audit.test.ts` (69),
  `tests/endo-integration-harness.test.ts` (7).
- Updated suite: `tests/endo-event-replay.test.ts` (13) — the
  non-canonicalizable-stream case now pins the strict-JSON door: a
  record whose event payload is not strict JSON is rejected with a
  TypeError at the door instead of misclassified (the record
  validator re-validates every event, so a door-passing stream is
  always canonicalizable).
- Full `npx vitest --run`: **95/95 files, 2629 passed, 3 skipped, 0
  failed** (85 files / 2423 passed at Phase 11 per §10.14 + 10 new
  files / 206 tests).
- Donor untouched (read-only): Phase 12 adds no donor files.

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

Next: none — Phase 12 (Operational substrate & integration) closes the phase series, recorded in §5.23 and verified in §10.15.

## 12. Pi RPC attachment (2026-10-03)

The vendored-fork decision of §3 is reversed. Recorded here for continuity; the full record is
[pi-attach-inventory.md](pi-attach-inventory.md).

- Removed: `pi/` submodule and `.gitmodules`, npm workspaces, tsconfig `paths`, vitest aliases, the fork-era
  `adapters/pi/*`, `runtime/{server,session-worker,browser-server,browser-listener,cockpit,cockpit-host,cockpit-main,ports}.ts`,
  `runtime/observation/ports.ts`, the Chord service contracts in `runtime/contracts/`, `presentation/`, `cockpit/`, the
  browser smoke and cockpit-type scripts, the donor biome plugin, and their tests.
- Added: `protocol/harness.ts`, `adapters/rpc-jsonl/` (the Prime transport, extracted), the RPC-based `adapters/pi/`,
  `storage/harness-registry.ts`, `cli/harness.ts`, `adapters/provider/fetch-transport.ts`, the fake Pi and fake
  OpenAI-compatible fixtures, and `research/pi-conformance/1.0.0/`.
- Fixed on the way: `storage/log.ts` no longer appends past a torn tail or a corrupt frame; `endo.event.v0` `at` is
  validated as ISO-8601 UTC.
- Baseline before the change (legacy pin restored locally from the legacy repository): typecheck 43 errors, all in the
  vendored `pi/packages/ai` (model data cannot be hydrated: models.dev answers 403 in the build environment); tests
  2566 passed, 8 failed, 2 skipped, with 6 files failing at import for the same reason. After: typecheck clean, lint
  clean, tests 2306 passed, 8 failed, 3 skipped (opt-in suites). The 8 failures are the same 8 tests as before: 6 are in the
  atomic-publication path built on `mv --exchange` (4 fail on the command itself, 2 in a publication child or the
  step after an exchange; GNU coreutils here is 9.4, which lacks `--exchange`), and 2 resolve donor commit `45adf6b`,
  which is not in this repository's history.


## 13. Audit of the Pi boundary and evidence invalidation (2026-10-03)

Findings, fixes and accepted limitations are in [pi-attach-audit.md](pi-attach-audit.md). Pi 1.0.0 is recorded as the
verified baseline rather than a support whitelist; evidence combines conservatively with explicit supersession only;
evidence depends on Pi's user configuration. Adapter and suite versions were bumped and the baseline re-recorded.
Verification after the audit: typecheck clean, lint clean, tests 2322 passed, 8 failed (the same 8 environmental
failures as §12), 3 skipped (opt-in suites); the real Pi 1.0.0 acceptance suite passed.
