# COORDINATOR-STATUS-001: read-only, evidence-aware Coordinator status (+ OpenClaw tool)

*   **Status:** read-only projection `endo.coordinator-status.v0`, CLI `endo coordinator status`, and an OpenClaw tool plugin (`integrations/openclaw-endophasia-status`) exposing `endophasia_status`; the [Studio Mission Board](coordinator-board.md) reads the same projection through a paired workspace host.
*   **Builds on:** projects and tasks ([../develop-tasks.md](../develop-tasks.md)), work attempts and send authorisations ([develop-attempt-execution.md](develop-attempt-execution.md)), verification receipts and the attention projection ([develop-attention.md](develop-attention.md)), the canonical session lifecycle (`protocol/session-lifecycle.ts`, `protocol/session-overview.ts`), and the evidence bridge ([develop-evidence-bridge.md](develop-evidence-bridge.md)).
*   **Scope:** one projection, one CLI entry point, one OpenClaw plugin, tests and this note. No Mission Board UI, no assignment, no multi-agent execution, no new execution or authorisation capability, no change to the verifier trust boundary or the protected-path census.

## 1. Source of truth

The status is a **projection computed at the read and never stored**. Its only sources are records that already exist in one store root:

| Section | Source records | Standing |
| :--- | :--- | :--- |
| Projects, tasks, phases | `develop/tasks.json` (`DevelopTasksStoreV0.read`) | **operator-declared**. The phase is the operator's status renamed (`review` → `awaiting-review`, `done` → `completed`); nothing else moves a task. |
| Attempts | `develop/attempts/*.json` (`DevelopAttemptsStoreV0.read`) | operator-declared (`reported` is a statement, never verification) |
| Verification results | the attention projection `endoDevelopAttentionViewV0` over `develop/receipts/`, compared with each project's HEAD observed once with the read-only Git observer | **controller-observed host checks**, with each result's relation to HEAD |
| Sessions | `events/events.log` opened `{ readOnly: true }`, grouped by `coordinates.sessionId`, each reduced by `reduceEndoSessionOverviewV0` | the state inherits the basis of the evidence for the lifecycle event that set it; each activity item carries its own basis |
| Session ↔ task links | task `sessions[]` references (operator-linked) and attempt `.authorized.json` records (send-authorised, controller-observed) | explicit only |

OpenClaw is a **conversation surface over this projection**, not a second source of truth: the plugin holds no state, caches nothing, and every answer is a fresh read validated against `validateEndoCoordinatorStatusV0`.

## 2. The five distinctions, structurally

1.  **Active vs last-observed.** `sessions[].observation` is `active` only when the session's own record says it is attached (`idle` or `running`), its newest event is younger than `staleAfterMs` (default 10 min, `--stale-after`), and the log was read whole. Otherwise `last-observed`. A record that still says `running` but went quiet raises `session-recorded-open-but-stale`. The validator refuses `active` without fresh evidence.
2.  **Agent-reported vs controller-observed.** Every activity item, open run and last run carries `basis`, derived from the evidence and not from the event's name. A directly recorded fact (`source: runtime-fact`, no `derivedFrom`) written under `harness.*`, `workbench.*` or `control.*` is `controller-observed`, and anything else a recording relays is `agent-reported`. An interpretation (`lifecycle.*`) inherits the basis of the events it derives from. So ACP v1's `lifecycle.run-started`, derived from the controller's own `control.requested`, is `controller-observed`, and Pi's, derived from the runtime's `agent_start`, is `agent-reported`. A missing parent, a cycle, a parentless interpretation or another source class is `unclassified`, never promoted.
3.  **In progress vs awaiting review vs completed.** `phase` is fixed by `ENDO_COORDINATOR_PHASE_OF_STATUS_V0`; the validator refuses a phase that does not follow the operator's status. Completed tasks are not re-verified (`verification.state: "not-read"`, gap `completed-not-reverified`).
4.  **Verification results vs unresolved evidence gaps.** `verification.results[]` (each with `relation` and `freshness`) is kept apart from `gaps[]` (closed codes: `no-check-recorded`, `checks-not-current`, `no-check-at-current-head`, `earlier-failure-not-current`, `receipts-unreadable`, `report-recorded-unverified`, `review-without-passing-check`, …). **Only results at the current HEAD decide the current state.** A failure at an earlier commit, in a changed tree or in another worktree is history: the task reads `not-current` [stale], or [incomplete] when not every read completed, with gap `earlier-failure-not-current`. It never reads `failing` [fresh]. Results are listed current first. The receipt store enumerates surviving files, with no independent inventory or supersession record. A later same-HEAD failure can disappear while an earlier pass survives. In that case (and whenever only current passes are visible), the projection reports the receipt facts and `incomplete` with `receipt-history-unverifiable`, never an aggregate task pass.
5.  **Explicit association vs unknown relationship.** `association` is `explicit` only when a record names both task and session; otherwise `unknown`. Never derived from names, prompt text or timestamps (tested with a look-alike session id started at the task's update time). The validator refuses `explicit` without links.

And every section carries `freshness: { state: fresh | stale | unavailable | incomplete, observedAtMs, ageMs, reason }`.

Contradictions are findings, never silent overrides: `status-contradicts-verification` (in review while a check at the current HEAD fails), `session-lifecycle-anomalies` and `session-link-not-in-log`. A recorded report plus a failing check is **not** a contradiction. The attempt record says the operator recorded that a report exists, not what result the agent claimed, so the gap `report-recorded-unverified` keeps the record's source (`operator-declared`) and draws no inference.

The validator re-derives labels rather than trusting them. It recomputes every `ageMs` from `readAtMs`, refuses observations after the read, and re-checks `fresh`, `stale` and `active` against `staleAfterMs`, the recorded state and whether the log was read whole. It checks `failing`, `inconclusive` against the current-HEAD results and the observed HEAD. It reconciles `scope` with the request and refuses an unavailable or partial source that lacks its finding, or a completed or not-current task that lacks its gap. An event dated after the read is left out of freshness, its session is not reported active (`incomplete`), and the read raises `event-time-in-future`.

## 3. Interface

```text
endo coordinator status [<root> | --root dir] [--project <id>]... [--stale-after <seconds>] [--quiet]
```

One canonical JSON document on stdout (`{ "coordinatorStatus": … }`) and the operator text on stderr (suppressed by `--quiet`), like `endo attempt bridge`. With `--project`, only those projects are read. Sessions of unknown relationship are **counted** (`unlistedSessions.unknownRelationship` / `unknownActive`), not listed. Sessions linked only to other projects are counted in `outOfScope` with no activity figure, so a scoped reader learns nothing about another project's activity.

Text (fixture store):

```text
coordinator status endo.coordinator-status.v0 read 2026-11-23T11:25:44.678Z (read-only; grants nothing; decisions are yours)
  sources   tasks=ready/fresh attempts=ready/fresh events=ready/fresh
  project   endo.project.0af2786c834823ef5315281ad7428aad Disk Demo [fresh] HEAD 18fe697cc1e8
    task    [awaiting-review; operator-declared] endo.task.43ecae8d… Make ok.mjs succeed — verification incomplete [incomplete]; attempts 1 (latest prepared); sessions unknown
  session   [active] endo.session.pi.disk-0001 recorded running [fresh] last event 2026-11-23T11:25:14.319Z (30s ago); last run none; association unknown
  attention [awaiting-your-review] Task endo.task.43ecae8d… awaits your review (verification: incomplete).
  not established:
    - That a session is alive now: there is no read-only liveness probe, …
```

JSON (same read, abbreviated):

```json
{
  "schemaVersion": "endo.coordinator-status.v0",
  "staleAfterMs": 600000,
  "authority": { "kind": "read-only-projection", "grants": "none", "writes": "none", "decisionAuthority": "operator-only" },
  "scope": { "requested": null, "projects": ["endo.project.0af2786c…"], "unknown": [] },
  "sources": { "tasks": { "state": "ready", "freshness": { "state": "fresh", "ageMs": 0 } }, "attempts": { … }, "events": { … } },
  "projects": [{
    "id": "endo.project.0af2786c…", "head": { "commit": "18fe697c…", "clean": true }, "freshness": { "state": "fresh" },
    "counts": { "awaiting-review": 1, "in-progress": 0, "blocked": 0, "open": 0, "completed": 0 },
    "tasks": [{
      "taskId": "endo.task.43ecae8d…", "status": "review", "phase": "awaiting-review", "statusSource": "operator-declared",
      "attempts": { "count": 1, "latest": { "state": "prepared", "stateBasis": "operator-declared", "sendAuthorized": false } },
      "verification": { "state": "incomplete", "basis": "controller-observed-host-check", "incomplete": true,
        "freshness": { "state": "incomplete" },
        "results": [{ "command": "node ok.mjs", "outcome": "passed", "relation": "at-head", "freshness": "fresh", "basis": "controller-observed" }] },
      "gaps": [{ "code": "receipt-history-unverifiable", "text": "…" }], "sessions": [], "association": "unknown"
    }]
  }],
  "sessions": [{
    "sessionId": "endo.session.pi.disk-0001", "observation": "active", "recordedState": "running", "stateBasis": "agent-reported",
    "freshness": { "state": "fresh", "ageMs": 30359 },
    "openRun": { "turns": 0, "basis": "agent-reported" }, "lastRun": null,
    "activity": [
      { "kind": "lifecycle.run-started", "basis": "agent-reported" },
      { "kind": "lifecycle.session-started", "basis": "controller-observed" }
    ],
    "association": "unknown", "links": []
  }],
  "unlistedSessions": { "unknownRelationship": 0, "unknownActive": 0, "outOfScope": 0 },
  "attention": [{ "kind": "awaiting-your-review", "subject": "endo.task.43ecae8d…", "text": "…" }],
  "findings": [],
  "notEstablished": ["…"]
}
```

## 4. Read-only guarantee and how it is proven

A missing attempts or receipts directory in a populated store is unavailable evidence, not a fresh absence of checks. The status carries an `attempt-records-missing` or `receipt-records-missing` finding and a gap for affected tasks. The validator requires an `at-head` result to name the observed HEAD commit. A scoped read emits session findings only for sessions it lists, and the validator rejects findings about subjects outside the reported scope.

The adapter (`adapters/develop/coordinator-status.ts`) opens the event log read-only, reads the task and attempt files without locks, and observes HEAD with `GitRevisionObserverV0` (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`: no index refresh). It never connects to `<root>/control/endpoint.sock`, which is a command channel.

Proof (`tests/coordinator-status.test.ts`, `tests/openclaw-endophasia-status.test.ts`): a recursive manifest (path, mode, mtime, size, sha256) of the store **and** the project repository including `.git/` is identical before and after the real CLI runs as a subprocess, and after the plugin runs it end to end (through the real bwrap sandbox, and through a test-only runner that strips the bwrap prefix on hosts without it). The negative control runs `endo task status` against the same store and shows the manifest changes on `develop/tasks.json`, so the proof is not vacuous. On the host, the same comparison was repeated against the operator's real store and project repository (§6).

## 5. OpenClaw integration

### What is installed on `archlinux` (measured 2026-11-23)

*   `openclaw` 2026.10.5 (`1b58cb9`), npm global at `~/.local/lib/node_modules/openclaw`, CLI `~/.local/bin/openclaw`.
*   Gateway: systemd user unit `openclaw-gateway.service`, **enabled and running** (MainPID 825 since 2026-11-22 00:12; its thread name is `node-MainThread`, which is why `ps -eo comm=` does not show `openclaw`). Listens on `127.0.0.1:18789` and `[::1]:18789`, plus a second loopback-only listener, `127.0.0.1:45327` (`ss -ltnp`: `node-MainThread`, pid 825). That second listener is proxied to the tailnet by a **foreground** `tailscale serve` session: pid 3555 `/usr/bin/tailscale serve --yes --bg=false 45327`, child of the gateway's route-owner worker pid 3547 (`tailscale-route-owner.worker.js`), child of pid 825. `tailscale serve status --json` shows one `Foreground` session, HTTPS on the tailnet host's :443, `/` → `http://127.0.0.1:45327`. At the same moment the plain `tailscale serve status` printed `No serve config`, so the plain output alone cannot rule out a foreground session. What the gateway serves on 45327 has not been established.
*   Config shape (keys only, no values read out): messaging-capable plugins enabled (`whatsapp`, `x`, `a2a`; channel `a2a` configured), `tools.profile: full`, two enabled cron jobs (a model heartbeat and "Memory Dreaming Promotion"). No existing Endophasia integration (no mention in the config or `~/.openclaw/extensions`).
*   The plugin API this version supports for tool-only plugins: `defineToolPlugin` from `openclaw/plugin-sdk/tool-plugin` (first exported in 2026.5.17), TypeBox schemas, generated `openclaw.plugin.json` with `contracts.tools` and `toolMetadata.<tool>.optional`. The built plugin has run through 2026.5.18 and 2026.10.5 only (the ENDO-29 review ran both), so the peer is `>=2026.5.18 <=2026.10.5`.

### The plugin

`integrations/openclaw-endophasia-status/` — `src/plugin.ts` (definition, SDK injected), `src/status-reader.ts` (config validation, command, run, validation, summary), `src/index.ts` (binds the real SDK), `build.mjs` (esbuild bundle; the repository's protocol validator is bundled so the plugin validates with the same code that defines the schema).

*   One tool, `endophasia_status`, declared `optional: true`. Being optional does **not** isolate it: on 2026.10.5 the `full` profile resolves to `allow: ["*"]` and grants it through that wildcard (ENDO-29 review). It belongs on a dedicated agent whose tool list is exactly `["endophasia_status"]`. One parameter: `project` (a configured label or id). Anything else is refused before any process runs.
*   It runs exactly `<node> <entry> coordinator status --quiet --root <storeRoot> --stale-after <n> --project <id>…`, built from operator config only, via `execFile` (no shell), with `PATH`/`HOME`/`LANG` only (the gateway's provider credentials never reach the child), a timeout (default 20 s, max 60 s, SIGKILL) and a 4 MiB stdout bound.
*   **Always sandboxed with `bwrap`; no opt-out, no whole-host bind.** The sandbox uses `--unshare-all` (no network), `--die-with-parent --new-session --clearenv`, an empty root and a tmpfs `/tmp` as `HOME`. It gets read-only binds of only `/usr` (with `/bin`, `/lib`… as the same symlinks), a few `/etc` files, the node prefix if it is outside `/usr`, endo's code root, `<store>/develop` and `<store>/events`, and each requested project's configured `root`. The launcher never reads Git pointers to decide what to mount. It refuses a Git pointer file or symlink at `.git`, or a `.git/commondir` entry, as `unavailable/project-git-layout-refused` before spawning. Use a standalone or primary checkout; linked worktrees, including Capy worktrees on this host, are unsupported. The launcher binds the resolved path rather than dereferencing a configured symlink at launch. A root resolving outside its configured parent returns `unavailable/project-root-refused`; opt-in detailed output lists the resolved host root for each mounted project. The home directory, `~/.openclaw` and every other credential store, `<store>/control` (the control socket) and unrequested projects are not mounted. A probe inside gets `EROFS` writing to the store, cannot see the credential canary, the control path or an unrequested project, and has no host interface; the same probe outside writes and sees all of them (test-controlled). If bubblewrap is missing the read is `unavailable` (`spawn-failed`), and if it cannot start (for example user namespaces denied) it is `unavailable` (`exited-nonzero`); endo never runs in either case. **Residual, not governed:** a read still reaches everything inside those mounts that the gateway user can read, including a pathname Unix socket inside a mounted project tree or Git directory, because read-only binds and a network namespace do not stop `connect()` to it. That is reduced exposure, not confinement.
*   Answers carry `summary` (plain language, each claim qualified, built only from the trimmed view), `provenance` and `status`, a trimmed view holding only what a status answer needs. That view has phases, counts, verification state and freshness, gap codes, association and the number of linked sessions, linked sessions' observation and freshness with no identifiers, attention kinds and finding codes. It leaves out check command strings (argv), commit ids, task-file project names (the operator's label or the opaque id is used instead), session, runtime, receipt and event ids, finding prose and store-wide session counts. `disclose.taskTitles` adds titles, and `disclose.detail` adds the whole validated status. The reader also refuses a status whose `scope.requested` differs from the projects it asked for. An Endophasia-side failure is `availability: "unavailable"` with a closed reason and an instruction not to infer anything.
*   It cannot reach terminal control: the only command it can run is the status read; it never touches the control socket, the workbench, `endo attempt`, or `endo steer`.

### Compatibility findings

| Check | Result | Evidence |
| :--- | :--- | :--- |
| `openclaw plugins build --entry ./dist/index.js` | wrote `openclaw.plugin.json` (`contracts.tools: ["endophasia_status"]`, `toolMetadata.endophasia_status.optional: true`) | host run, live config hash unchanged |
| `openclaw plugins validate --entry ./dist/index.js` | `Plugin endophasia-status is valid.` | host run |
| Real loader, isolated instance (`HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` all scratch; `plugins.load.paths`) | `status: loaded`, `toolNames: ["endophasia_status"]`, config schema accepted; trust `record-missing` (a path-loaded plugin has no install record) | `openclaw plugins inspect endophasia-status --runtime --json` |
| Real SDK wrapper | the built bundle, bound to the installed `defineToolPlugin`, registered via its own `register(api)` and invoked through the concrete `execute(toolCallId, params, signal)` against the operator's real store (bwrap, and before this change also the now-removed `none` mode) | §6 |
| Natural-language turn through a model | **not run**: needs a model. The local llama.cpp endpoint (`127.0.0.1:8090`) was not listening on 2026-11-23; starting a managed one, or using the gateway's cloud providers (stored credentials, spend), is outside this task's authority | — |
| Install into the live gateway | **not done, by design**: it would change `~/.openclaw/openclaw.json` / extensions | — |

## 6. Local evidence on `archlinux` (measured, 2026-11-23)

Against the operator's real store (`~/.local/share/endophasia/store`: one project, one open task, one prepared attempt, one Pi session last recorded `detached` on 2026-11-15):

*   `endo coordinator status` and the plugin (bwrap, and the now-removed `none` mode) answered: project `webpage-test` HEAD `dc942b286dcb` clean; 1 open task, verification `failing` [fresh]; attention `verification-failing`; 0 active sessions; the one session in the store is `last-observed`, `stale` (8 days), relationship unknown. A `project: "--root /"` request was refused without running anything.
*   Store and project repository (`.git` included) manifest hashes identical before and after every read; live OpenClaw surfaces (`openclaw.json`, gateway unit, `~/.openclaw/extensions`, user units, crontab, user timers) identical; TCP listeners identical; gateway still MainPID 825.

## 7. Before remote messaging and scheduled summaries are safe

1.  **A dedicated, tool-restricted agent.** The live config runs `tools.profile: full`; an agent that can call `endophasia_status` there can also run shell. The Coordinator should be an agent whose tool allowlist is `endophasia_status` alone, so a messaging-reachable conversation cannot reach `exec`.
2.  **Recipient scoping.** WhatsApp, X and A2A are enabled and the gateway's second loopback listener (127.0.0.1:45327) is proxied to the tailnet over HTTPS by a foreground `tailscale serve` session (§5). Before any channel can ask, decide which senders may (owner-only), and keep `disclose.taskTitles` off for anything that leaves the host.
3.  **Run the plugin under the gateway's real service context.** The bwrap sandbox was proven as the operator's uid in a shell; confirm it starts inside the systemd unit's context (unit hardening can forbid user namespaces). If it does not, the tool answers `unavailable`; it never falls back to an unsandboxed run.
4.  **A real model turn.** With George's llama.cpp running, `openclaw agent exec --config <scratch> --model <local>` with only `endophasia_status` allowed would show the natural-language answer end to end without touching live config.
5.  **Liveness.** `active` is freshness-bounded inference from records. A real liveness signal needs a read-only probe the controller publishes (not the control socket), which is new design work.
6.  **Scheduled briefing (next experiment, not activated).** One OpenClaw cron job delivering a summary to the owner only, after 1–3 are settled.
7.  **Signed records.** Everything read is an unsigned same-uid file; a remote reader inherits that limit.

## 8. What did not change

No execution, authorisation, provenance or verification semantics changed. No existing file's behaviour changed except the CLI dispatch table and help text (one new `coordinator` family). The protected verifier trust boundary, H0 status and the protected-path census are untouched.
