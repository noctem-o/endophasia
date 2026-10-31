# Attaching to a harness: identity, evidence and admission

Status: **implemented for Pi** (over `pi --mode rpc`, in `adapters/pi`). The ACP adapters and the research records for other
runtimes are listed in the table below with the evidence each has. The ACP adapters admit no capability, and the sealed Prime 0.9.7
study admitted no *exact* capability. The summary and the maturity
labels are in the [README](../README.md#what-works-today) and [status.md](status.md).

The text of this page was moved from the README's "How it attaches" section unchanged, except the diagram: it no longer shows a
cognition graph (not wired) or a "planned cockpit" (Studio exists), and no longer lists Codex and Prime, which have record
mappings but no attachment.

Endophasia is a substrate, not a runtime. It attaches to agent harnesses you already run, through explicit adapters.

~~~mermaid
flowchart TB
    R["Harness you install<br/>Pi is the one attached today"] --> A["Endophasia adapter"]
    A --> S["Endophasia store and services<br/>events · evidence"]
    S --> C["Operator CLI · Studio, read-only"]
~~~

**You install and update harnesses with your normal method. Endophasia never installs, updates, downgrades, patches or
rebuilds one.** It finds the executable you selected (`--pi /path`, or `pi` on `PATH`), records its identity, launches
it in its documented RPC mode when you ask, and records what it does.

Each attachment records a fingerprint: facts from your installation (resolved and real path, a SHA-256 of the
entrypoint file, the package manifest) kept apart from what the runtime reports (`pi --version`), with every missing
fact listed rather than guessed. When the fingerprint differs from the last one for that attachment, Endophasia
records the change, marks the evidence that depended on it unverified, and tells you, for example:

~~~text
Pi runtime changed

  Previously observed: 1.0.0 / fingerprint 0d1bcf47a86d (strong identity) at …/dist/bundle/cli.js
  Currently detected: 1.0.1 / fingerprint 7c2e91a0b4f3 (strong identity) at …/dist/bundle/cli.js
  Differences: package, version; version order: higher; version standing: unverified-release
  Previous conformance evidence may no longer apply. Capabilities dependent on that evidence are now unverified.
  Endophasia will not install, update, downgrade or replace Pi. If you want a different version, use your normal installation method.
~~~

A changed fingerprint says the runtime differs. It does not say an update is available, and it does not say the new
runtime is incompatible. A capability can be unverified even when the runtime starts and answers.

`endo harness status` then explains the change from the recorded state: what differs, which capabilities lost their
standing and why (every changed dependency, not only the first), what re-establishes each one, and what no check
establishes (behaviour comparison, reproducibility). See [evaluating a new harness version](harness-upgrades.md) and the
[Pi 1.0.4 → 1.4.0 case study](pi-1.4.0-upgrade.md). Which responsibilities stay with the harness is in
[upstream-boundaries.md](upstream-boundaries.md).

Capabilities are admitted only on current evidence, in this order:

~~~text
transport  →  identity  →  local protocol checks  →  live study (on request)  →  capability admission
~~~

- **Local protocol checks** run automatically: an ephemeral, offline Pi with no tools answering state, cursor and
  configuration commands. No prompt, no provider call, nothing persisted.
- **The live study** sends prompts, runs a read-only tool in a scratch workspace and calls your configured model
  provider, so it may cost money. It runs only when you pass `--authorize-live-study`.

Evidence also depends on your Pi configuration (settings, model endpoints, MCP servers, system prompts, extensions;
never credentials), the adapter and suite versions, and the definition of the check that produced it. When any of
these change, the evidence that depended on it stops counting. When several checks speak to one capability, the most
conservative result decides; a check replaces another only where it is declared to re-test the same property more
broadly.

Every recorded run carries the fingerprint that produced it, so results from before and after a change are never
silently treated as comparable.

| Runtime | Role |
| :--- | :--- |
| Pi | Reference runtime, attached over `pi --mode rpc`. Current real-study baseline: Pi 1.0.1; the Pi 1.0.0 conformance recording below is retained as a historical specimen. Other installations and releases earn admission on their own evidence |
| Prime | Research subject. The sealed 0.9.7 study admitted no exact capability. |
| Codex | Future candidate, pending its own pinned study |
| ACP v1 agents | A protocol-level adapter (`adapters/acp`) launches any ACP v1 agent command: the PR #37 slice, then semantic coverage with schema-validated updates, capability-gated `session/list`/`resume`/`close`, and explicit EXACT / QUALIFIED / LOSSY / UNREPRESENTABLE loss accounting, pinned to one SDK and schema revision. Tested against a deterministic fake agent; real OMP (`omp acp`) is an opt-in smoke. See [docs/acp-v1-slice.md](acp-v1-slice.md). No capability is admitted from it yet |
| ACP v2 agents | An **experimental**, version-pinned conformance study of the Draft v2 baseline (`adapters/acp/client-v2.ts`, kept apart from v1): explicit negotiation (an agent that answers v1 is refused, with an opt-in relaunch fallback), the baseline session surface, prompt acceptance kept distinct from run completion, `session/resume` with replay judged by reconstructed state, and fail-closed permission subjects. Deterministic fake-agent evidence only, no real v2 agent yet; ACP v2 is Draft, not stable. See [docs/acp-v2-study.md](acp-v2-study.md). No capability is admitted from it |

What the evidence recorded against one Pi 1.0.0 installation establishes, with Pi's provider pointed at a local fake
endpoint ([recording and its scope](../research/pi-conformance/1.0.0/README.md), [mapping](pi-attach-inventory.md)).
That recording was made under mapping `pi-rpc-mapping.1` and is kept unchanged as a historical specimen. The current
mapping is `pi-rpc-mapping.2`, so its evidence no longer applies to a current attachment, which re-earns its own.
It is evidence for that installation and configuration, not a promise about yours: your Pi starts unverified and is
checked on its own.

| Capability | Status | Why not exact |
| :--- | :--- | :--- |
| Session identity, entry cursor, per-entry usage, tool activity, model control | admitted (exact), within the recording's scope | model control exercised by re-selecting the configured model only |
| Active path / continuity, thinking control | admitted (qualified) | context boundary derived from compaction entries; only one thinking level was available to exercise |
| Lifecycle trace, session overview, metrics | admitted (partial) | no run or turn ids; one session, no lanes; total cost only |
| Steer, follow-up, stop | admitted (partial) | no receipt ids; abort cannot target a specific run |
| Active-tool control, run identity, operation outcomes | unavailable | not exposed over RPC |

"Nothing matched exactly" is a valid research result.
