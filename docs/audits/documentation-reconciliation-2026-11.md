# Documentation reconciliation — November 2026 (ENDO-DOCUMENTATION-002)

**Pinned tree:** `origin/main` at `d2024ac51d5d2a25279ef352477ac696acc597d2` (merge of #196, 28 November 2026).
**Purpose:** a compact claim-to-evidence record behind the November 2026 README and living-document refresh. Each row names
the public claim as it stood, what the tree establishes, and where the corrected wording now lives. It is a review aid, not a
second status page: [status.md](../status.md) remains the capability inventory and the design records remain the detail.

**Method.** Claims were checked against implementation (`cli/`, `adapters/`, `storage/`, `cockpit-http/`, `studio-ui/`), CLI help
(`cli/help.ts`), tests, merged design records and `git log --first-parent origin/main`. A design document's own "Status" line was not
treated as authoritative; several still say "draft PR" after merge. Registry facts were read live with `npm view endophasia` on
28 November 2026.

## Merged milestones verified on the pinned tree

| PR | Merged | Mechanism | Operator surface on `main` | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| #171 | 2026-11-22 | Protected Experiment Inspector (Evolve) | `endo studio --protected-runs <dir>` (read-only, opt-in) | [studio.md](../studio.md#evolve--protected-experiment-inspector-read-only-opt-in), `tests/endo-studio-evolve-browser.test.ts` |
| #174 | 2026-11-23 | Evidence-aware Coordinator status | `endo coordinator status`; OpenClaw status plugin (`integrations/openclaw-endophasia-status/`) | [coordinator-status.md](../designs/coordinator-status.md) |
| #175 | 2026-11-24 | Coordinator Mission Board | Paired `endo workspace open` | [coordinator-board.md](../designs/coordinator-board.md) |
| #176 | 2026-11-24 | Governed protected attempt execution | `endo attempt protected-run` | [protected-attempt-execution.md](../designs/protected-attempt-execution.md) |
| #178 | 2026-11-24 | Restricted local Coordinator briefing | `endo coordinator brief` (sandboxed OpenClaw, one local model, one read-only tool) | [coordinator-runtime.md](../designs/coordinator-runtime.md) |
| #180 | 2026-11-25 | Harness-neutral `endo.develop-adapter.v0` | Library contract used by Pi and Codex | [develop-adapter-contract.md](../designs/develop-adapter-contract.md) |
| #182 | 2026-11-25 | Live Codex App Server integration | `endo codex check`, `endo codex session` | [develop-codex-live.md](../designs/develop-codex-live.md) |
| #183 | 2026-11-25 | Codex in Studio DEVELOP | `endo develop --harness codex` | [develop-codex-studio.md](../designs/develop-codex-studio.md) |
| #184 | 2026-11-26 | E1 durable coordination metadata | `endo assign`, `dep`, `candidate`, `coordinator coordination` | [coordinator-assignment-implementation.md](../designs/coordinator-assignment-implementation.md) |
| #185 | 2026-11-26 | Codex Observe timeline classification | `endo studio` Observe | CHANGELOG (Unreleased) |
| #186 | 2026-11-26 | E2 governed assignment integration | `endo worktree`, `endo review`; Lanes and Graph views. **Dispatcher is library-only** (see C7) | [coordinator-assignment-e2-implementation.md](../designs/coordinator-assignment-e2-implementation.md) |
| #187 | 2026-11-26 | S0 automation architecture | None: design specification only | [coordinator-automation.md](../designs/coordinator-automation.md) |
| #188 | 2026-11-26 | M1 local model pool | `endo coordinator pool check`, `coordinator brief --pool` | [coordinator-model-pool-m1-implementation.md](../designs/coordinator-model-pool-m1-implementation.md) |
| #189 | 2026-11-26 | S1 deterministic scheduling and resource observations | `endo schedule`, `endo scheduler tick`, `endo resource` | [coordinator-automation-s1-implementation.md](../designs/coordinator-automation-s1-implementation.md) |
| #191 | 2026-11-27 | S2 scheduled advisory intelligence | `endo advisory …` (disabled by default; explicit grant per revision) | [coordinator-automation-s2-implementation.md](../designs/coordinator-automation-s2-implementation.md) |
| #195 | 2026-11-27 | Research-to-production consolidation | Preflight, diagnostics, V0 hardening; `grounded-v1` **not** promoted | [coordinator-consolidation-001.md](../designs/coordinator-consolidation-001.md) |
| #196 | 2026-11-28 | Coordinator Studio F1 | Attention, Resources, Schedules, Advisory views in paired `endo workspace open` | [coordinator-studio-f1-002.md](../designs/coordinator-studio-f1-002.md), `tests/coordinator-studio-f1-browser.test.ts` |
| #197 | 2026-11-27 | CI reliability engineering | Test partitions and accounting | [testing.md](../testing.md) |

## Claims corrected

| # | Claim as published | What the tree establishes | Correction |
| :--- | :--- | :--- | :--- |
| C1 | README: "**Coordinator** currently ships read-only status, brief and Mission Board views while governed multi-agent assignment remains architectural design." | E1 (#184) and E2 (#186) are merged: durable coordination intent, dependencies, candidates, registered worktrees, advisory reviews, liveness vocabulary, shared route reservations and Lanes/Graph views. | README Coordinate section and status table; [status.md](../status.md#coordinate). |
| C2 | README capability table: "Coordinator (read-only)" with status and brief only. | M1, S1, S2 and F1 exist with CLI or Studio surfaces. | Capability table lists each with maturity. |
| C3 | README: "Endophasia keeps records; it does not decide, and nothing runs on its own." | Still true that Endophasia installs no timer or service. But `scheduler tick` and `advisory tick` are designed to be run unattended by a timer the operator owns (`scheduler print-systemd-unit` prints an example and installs nothing), and an authorised S2 tick can contact a local model. | Replaced by an explicit "autonomy is not authority" account: what may run when the operator schedules it, and what never acquires authority. |
| C4 | README: Mission Board "shows read-only task, verification and recorded session evidence". | F1 (#196) adds deterministic Attention (`endo.coordinator-attention-rules.v1`), Resources, Schedules and Advisory views, all read-only. | README Coordinate section; [studio.md](../studio.md#coordinator-mission-board-paired-workspace-read-only). |
| C5 | README architecture diagram: inputs → records → read-only surfaces. | Omits the coordination substrate, automation ledger, model pool, advisory store and the operator's authorisation path. | New authority-aware architecture diagram with stated arrow semantics. The evidence-pipeline diagram is preserved in [architecture.md](../architecture.md). |
| C6 | README "Delivery direction": next is "implement governed multi-agent assignment proposals". | Implemented in E1/E2. The November roadmap sets three independent tracks. | README roadmap and [roadmap.md](../roadmap.md#current-direction-november-2026). |
| C7 | E2 design doc §1: E2 "connects … coordination records … to governed execution across admitted live harnesses". | `dispatchEndoAssignmentAttemptV0` is called only from `tests/develop-assignment-e2.test.ts`; no CLI or Studio command reaches it (E2 doc §5 item 4 says so). Raw Pi workbench and protected routes refuse assignment-linked attempts (`assignment-required`). So no operator surface dispatches an assignment-linked attempt on `main`. | Stated as "implemented, library-level; no operator dispatch surface yet" everywhere. Recorded as finding F-1. |
| C8 | README Codex row: "no `STEER`, `QUEUE` or prepared-attempt dispatch yet". | Accurate. `turn/steer` is wired but its capability is `unverified` by default, so it is not offered; `attempt/propose` is refused (`adapters/codex/workbench.ts`). | Kept, with the steer nuance in status.md. |
| C9 | `package.json` description: "an experimental research instrument that attaches to an existing agent harness and records what it observes." | Under-describes a governed workbench, coordination substrate and experiment platform. | Descriptive field updated; version, files, scripts and dependencies untouched. |
| C10 | README: "source-tree `main` as of 25 November 2026". | Stale by #184–#197. | Dated to the pinned commit (28 November 2026). |
| C11 | [status.md](../status.md) "Not yet built: … DEVELOP … does not yet start harnesses, open arbitrary projects, schedule work or coordinate agents … attachments for other harnesses". | Codex live integration, coordination metadata and S1/S2 scheduling exist. | status.md restructured around the four capabilities with a maturity per row. |
| C12 | [studio.md](../studio.md): no Coordinator section. | Mission Board and F1 views ship in the paired workspace. | Section added. |
| C13 | [roadmap.md](../roadmap.md) "Delivery sequence — current priority" ends at two-turn continuation. | Predates DEVELOP, Codex and the Coordinator programme. | Dated current-direction section added above; the earlier sequence kept as dated history. |
| C14 | [vision.md](../vision.md): Endophasia "Observes, steers, and compares agent runs". | Narrow. | Related-projects row widened. |
| C15 | Design records for E2, S1, S2, F1 and consolidation say "draft PR" / "review package". | All merged. | One dated merge annotation added under each title; body unchanged. |
| C17 | Old README and quickstart: Codex native approvals are "deny-only fail-closed". | `cli/codex.ts` and `adapters/codex/native-approvals.ts` accept `ALLOW ONCE` for command and file approvals; unsupported requests are declined, and a requested widening (a policy amendment or file `grantRoot`) is never granted, though the underlying action can still be allowed once. Found by the adversarial review. | Corrected in quickstart.md and status.md. |
| C18 | README: "nothing runs on its own" was replaced in the first draft by "every consequential act is approved on the terminal". | Also too broad: `harness attach --prompt` dispatches on the command line, S2 grants come from CLI arguments, and paired pages edit task metadata. Found by the adversarial review. | README now distinguishes per-send terminal approval, bounded grants and explicit commands. |
| C19 | S1 described as "disabled by default". | `schedule add` enables a schedule unless `--disabled` is passed (`cli/scheduler.ts`); what is absent by default is any timer. | Corrected everywhere. |
| C16 | README Studio summary: "Every mode binds strictly to `127.0.0.1` … with no external requests." | Accurate for the server and page. `coordinator brief` and an authorised `advisory tick` are CLI-side and are the only Coordinator paths that run inference (on a local model). `coordinator pool check` and S1 health ticks also contact local endpoints, but only with zero-token `GET`s. | Distinguished in the README's Coordinate section. |

## Claims re-verified and kept

- **npm.** `latest` → `0.1.0-alpha.1` (2026-10-08), `alpha` → `0.1.0-alpha.2` (2026-10-22); no later version. The source manifest still reads `0.1.0-alpha.2`.
- **Codex is Strict-only.** `session-grant` is refused at protocol, adapter and dispatcher layers (E2 doc §1; `cli/help.ts`).
- **Pi Everyday is narrow.** `cli/everyday-pi.ts` returns no grant unless: Linux, non-root, `--provider relay`, model `Ornith-1.5-9B-Q8_0`, no tools, `/usr/bin/pi`, `/usr/bin/bwrap`, a local filesystem and a trusted Pi installation. The CHANGELOG's DEVELOP-UX-002 entry ("no provider in this build reports one") predates commit `7384d1c02` and is left as history.
- **E4 is not implemented.** Pi and Codex share one single-writer store lock; concurrent heterogeneous sessions in one store are not supported.
- **S1 installs no timer**, but `schedule add` enables a schedule unless `--disabled` is passed (`cli/scheduler.ts`).
- **S2 is disabled by default.** `advisory add` creates a disabled, unauthorised schedule; a grant binds the exact revision, pool digest, budget and validity window (S2 doc §5).
- **F1 makes zero model calls.** The browser test runs a prohibited-route sentinel and asserts zero hits (`tests/coordinator-studio-f1-browser.test.ts`).
- **Workstation H0 remains BLOCKED** (`cli/help.ts`, `attempt bridge`).

## Findings recorded for separate missions (not fixed here)

| ID | Finding | Why it is out of scope |
| :--- | :--- | :--- |
| F-1 | No operator surface dispatches an assignment-linked attempt. E2's dispatcher is library-only, and the raw Pi and protected routes refuse such attempts. An operator who links an attempt with `endo assign link` can't send it through any shipped command. | Wiring a dispatch command is runtime work (the E2 doc's E3 handoff names `endo assign dispatch`). |
| F-2 | `endo --help` opens with "an experimental research instrument … attaches to an existing agent harness and records what it observes", and `endo studio --help` says "Studio currently shows a single read-only observation page … does not yet implement the other modes". Both are stale. | They are CLI output strings with tests around them. Changing them is a small, separate code change. |
| F-3 | In `tests/coordinator-studio-f1-browser.test.ts`, capture `06-desktop-field-attention` shows the top-bar appearance toggle still on *Instrument*. The test asserts `data-appearance=field` on the board, but the image doesn't visibly show Field. | Test or capture-timing issue. The README doesn't use that frame. |
| F-4 | The README's `Everyday` description and the CHANGELOG's Unreleased DEVELOP-UX-002 entry disagree about whether any provider attests a boundary. | Closed in this PR: a correction note under Unreleased → Documentation cites `7384d1c02`. |

## Capability manifest (brief §13): declined

A generated README capability table would add a third copy of each capability statement (manifest, README, status.md) and
a generator for it to maintain. The drift this refresh found was not mechanical. Every stale row had been true when written, and
went stale because a later milestone changed what was true. A schema can't catch that. This refresh reduces duplication
instead: the README carries one short table with a maturity per row and links into status.md, status.md carries the
detail, and this record keeps the evidence links. A manifest becomes worth building if the README table and status.md drift apart
again after this consolidation. If so, propose it as a separate change that adds a `test:docs` check outside the required CI gates.
