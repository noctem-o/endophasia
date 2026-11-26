# Coordinator Assignment Integration — E2 Implementation Report & E3 Handoff

**Mission**: `COORDINATOR-ASSIGNMENT-003` (Primary milestone: **E2 — Governed assignment integration**)  
**Branch**: `feat/coordinator-assignment-003`  
**Baseline**: `origin/main` @ `c2b4d07e0` (PR #185 merged)  
**Status**: Implemented, adversarially reviewed, deterministically verified (Draft PR ready for operator review)

---

## 1. Executive Summary

E2 connects Endophasia's E1 durable, operator-controlled coordination records (`develop/coordination.json`) to governed execution across admitted live harnesses (`CodexDevelopAdapterV0` and `PiDevelopAdapterV0`) and the existing protected execution runner, while extending read-only visibility into the Studio Mission Board.

All non-negotiable architectural invariants from `docs/designs/coordinator-assignment.md` are preserved:
- Assignment is intent only, never execution authorization (`assignmentIsAuthorization: false`).
- Readiness is never execution permission (`readinessIsPermission: false`).
- One shared store-wide attempt-route reservation domain (`<root>/develop/attempt-routes/<attemptId>.route.json`) governs Pi workbench, protected attempts, and harness-neutral live adapter dispatches — no separate Codex reservation mechanism exists.
- Codex remains strictly terminal-confirmed (`Strict-only`; `session-grant` refused at protocol, adapter, and dispatcher layers). Prepared work attempts on Pi also continue to exclude Everyday `session-grant`, preserving Pi Everyday boundaries.
- Native harness approvals remain completely separate from Endophasia dispatch authorization.
- Structured advisory reviews (`standing: "advisory-agent-review"`, `basis: "agent-reported"`) are isolated in project-scoped write-once storage and can never become host check receipts or satisfy `candidate-has-passing-receipt`.
- Offline projections never claim live process state or confirmed termination; `termination-confirmed` requires verified OS containment cleanup (`boundary: "scope"`, `result: "confirmed"`, `remainingProcesses: 0`).
- Workstation `H0` remains `BLOCKED`; no periodic heartbeat daemon, scheduler, automatic retry, automatic merge, or Studio mutation endpoint was added.

---

## 2. Scope Delivered (E2-A through E2-F + E1 §10.6 Remediation)

### E2-A: Harness-neutral attempt authorization
- **Protocol** ([`protocol/develop-adapter-authorization.ts`](../../protocol/develop-adapter-authorization.ts)): closed, write-once schemas `endo.develop-adapter-authorization.v0`, `endo.develop-adapter-abort.v0`, and `endo.develop-adapter-outcome.v0`. Enforces `approvedBy: "operator"`, `consequenceObserved: false`, and strict Codex authority rules.
- **Storage** ([`storage/develop-adapter-authorizations.ts`](../../storage/develop-adapter-authorizations.ts), [`storage/develop-attempt-routes.ts`](../../storage/develop-attempt-routes.ts)): write-once records at `<root>/develop/adapter-authorizations/<attemptId>.{authorized,aborted,outcome}.json` paired with widened route kind `"adapter-live"` in `<root>/develop/attempt-routes/<attemptId>.route.json`.
- **Dispatcher** ([`adapters/develop/assignment-dispatch.ts`](../../adapters/develop/assignment-dispatch.ts)): `planEndoAssignmentDispatchV0` and `dispatchEndoAssignmentAttemptV0` operate over any admitted `EndoDevelopLiveAdapterV0` (Pi or Codex), binding `proposalDigest` to exact `(attemptId, briefSha256, projectId, taskId, taskRevision, assignmentId, assignmentRevision, harnessFamily, source, controlPath, sessionKey, attachmentId, launchId, instanceId, runtimeFingerprintId, worktreePath, operationKind, payloadDigest)`. Probes adapter admission before prompting the operator so unsupported capabilities (e.g., Pi `queue` or `native-command` on Codex) fail honestly with zero route claim. Records controller-observed `.outcome.json` (`accepted` / `refused` / `unknown`, always `consequenceObserved: false`) and never retries on `unknown`.

### E2-B: Atomic revocation–dispatch commitment & anti-bypass linearisation
- **Commitment boundary** ([`storage/develop-coordination.ts`](../../storage/develop-coordination.ts)): `DevelopCoordinationStoreV0.commitAssignmentDispatch` executes inside bounded `<root>/develop/coordination.lock.<n>` (never nesting `tasks.lock.<n>`, never running Git subprocesses, terminal I/O, or harness transport I/O):
  1. Re-reads `coordination.json` and verifies the assignment is `active` at `expectedAssignmentRevision`.
  2. Re-reads `tasks.json` lock-free and verifies `task.status !== "done"` and `task.revision === expectedTaskRevision === assignment.taskRevisionAtBind`.
  3. Revalidates primary or registered sibling worktree identity (`commonDir` and non-null `gitDir`), active worktree conflicts/hazards, and prerequisite dependencies.
  4. Revalidates attempt state, brief digest, route absence, and in-lock adapter admission (`admitInLock()`).
  5. Claims `.route.json` (`link(2)`), writes `.authorized.json` (or route record), records `attemptId` in `assignment.dispatchedAttemptIds`, and atomically replaces `coordination.json`.
  6. Releases `coordination.lock.<n>` unconditionally in `finally` before any transport I/O.
- **Anti-bypass linearisation** ([`storage/develop-coordination.ts`](../../storage/develop-coordination.ts), [`runtime/contracts/develop-attempt-dispatch.ts`](../../runtime/contracts/develop-attempt-dispatch.ts), [`adapters/develop/protected-attempt.ts`](../../adapters/develop/protected-attempt.ts)):
  - Assignment-linked attempts cannot dispatch through raw Pi workbench or protected routes (`assignment-required`).
  - Unlinked Pi workbench and protected route claims also linearise through `DevelopCoordinationStoreV0.claimUnlinkedAttemptRoute` inside `coordination.lock.<n>`, closing the TOCTOU window where a concurrent `endo assign link` links an attempt between preflight and `.route.json` claim.
  - `readProtectedAttemptV0` counts `"adapter-live"` routes and `adapter-authorizations/` presence as violating `single-execution-route`.
- **Cross-file crash windows** (explicitly documented, never misrepresented as a single OS transaction):
  - **Window W1** (crash after `.route.json` claim, before authorization write): returns `commit-partial` with `routeClaimed: true, authorizationWritten: false`. `.route.json` is never deleted; retries refuse `already-authorized`; revocation retains `liveness-unverified`.
  - **Window W1b** (crash after authorization write, before `coordination.json` replace): returns `commit-partial` with `routeClaimed: true, authorizationWritten: true`. Projection reports `adapter-authorized`; retries refuse `already-authorized`; revocation retains `liveness-unverified`.
  - **Window W2** (revocation after lock release, before harness transport write): pre-transport check detects non-active/changed assignment, writes `.aborted.json`, leaves `.route.json` permanently burned, and invokes `clearHazardAfterPreTransportAbort(assignmentId, revision, attemptId, authorizationId)` which clears `liveness-unverified` **only** if the specific `(attemptId, authorizationId)` abort matches and **zero** other hazard bases (such as a linked writable session, unreadable `develop/attempts/`, or earlier unverified attempt) remain.
  - **Window W3** (transport disconnect/error during delivery): records write-once `.outcome.json` with `status: "unknown"`, `consequenceObserved: false`, and performs zero automatic retries.

### E1 §10.6 Remediation (Pairwise shared-worktree acknowledgements)
- Added optional `acknowledgedConflictIds?: string[]` on `EndoAssignmentWorkspaceV0` ([`protocol/develop-coordination.ts`](../../protocol/develop-coordination.ts)) with closed validation (sorted, unique, no self-reference).
- New E2 assignments always write explicit `acknowledgedConflictIds` (`[]` when no conflicts exist, or the exact sorted list of acknowledged conflicting assignment IDs when `--allow-shared-worktree` is confirmed).
- `endoWorktreeConflictsV0` ([`runtime/contracts/develop-coordination.ts`](../../runtime/contracts/develop-coordination.ts)) evaluates acknowledgement pairwise whenever either assignment carries `acknowledgedConflictIds`, preventing a legacy boolean `sharedWorktreeAcknowledged: true` or a cleared/reactivated assignment from masking an unacknowledged overlap.

### E2-C: Registered sibling worktrees
- **Pointer verification** ([`storage/git-worktree-pointer.ts`](../../storage/git-worktree-pointer.ts), [`adapters/develop/coordination.ts`](../../adapters/develop/coordination.ts)): pure `O_NOFOLLOW` filesystem validation checking that `<worktree>/.git` is a bounded regular file with a single `gitdir: <target>` line, that `resolve(worktreePath, rawTarget)` contains no symlinks (`resolvedTarget === canonicalGitDir`) and lies strictly under `<primaryCommonDir>/worktrees/`, that `<gitDir>/gitdir` points back to `<worktree>/.git`, and that `<gitDir>/commondir` resolves to `primaryCommonDir`.
- **Store & CLI** ([`storage/develop-coordination.ts`](../../storage/develop-coordination.ts), [`cli/develop-coordination.ts`](../../cli/develop-coordination.ts)): `endo worktree register|unregister|list` persists `registeredWorktrees[]` in `coordination.json` (max 32). Unregistered sibling worktrees and tampered/symlink-substituted registered paths are refused for governed dispatch and HEAD observation. Endophasia never creates, checks out, deletes, or merges worktrees.

### E2-D: Structured advisory reviews & sandbox isolation
- **Protocol & store** ([`protocol/develop-coordination-reviews.ts`](../../protocol/develop-coordination-reviews.ts), [`storage/develop-coordination-reviews.ts`](../../storage/develop-coordination-reviews.ts), [`cli/develop-coordination.ts`](../../cli/develop-coordination.ts)): project-scoped write-once records at `<root>/develop/coordination-reviews/<projectId>/<reviewId>.json`, exposed via `endo review record|list|show`. Validates same-project candidate, assignment, and attempt ownership; refuses cross-project references; never touches `develop/receipts/`; preserves attribution to superseded candidates (`candidateRelation: "superseded-candidate"`).
- **Bubblewrap pinning** ([`adapters/coordinator/status-mounts.ts`](../../adapters/coordinator/status-mounts.ts), [`adapters/coordinator/project-status-worker.ts`](../../adapters/coordinator/project-status-worker.ts)): descriptor-pins **only** `develop/coordination-reviews/<projectId>/` **after** primary status files (`tasks.json`, `attempts/`, `receipts/`, `events/events.log`), filters `WRITE_ONCE_TEMPORARY_V0`, applies a dedicated 320-entry cap, and rolls back mounts/FDs on any error into `reviews-unreadable` without suppressing primary Coordinator status.

### E2-E: Session liveness & termination evidence
- **Protocol & contracts** ([`protocol/develop-session-liveness.ts`](../../protocol/develop-session-liveness.ts), [`runtime/contracts/develop-session-liveness.ts`](../../runtime/contracts/develop-session-liveness.ts), [`adapters/codex/controller.ts`](../../adapters/codex/controller.ts)): closed 7-state vocabulary (`connected`, `running`, `disconnected`, `termination-confirmed`, `liveness-unknown`, `stale-observation`, `unsupported-observation`).
- `endoObserveAdapterLivenessV0` samples `adapter.snapshot()` before clock comparison and emits `termination.confirmed: true` **if and only if** `state === "termination-confirmed"` with verified OS scope cleanup (`remainingProcesses === 0`).
- `endoOfflineSessionLivenessV0` and `storage/coordinator-coordination.ts` never claim live state or confirmed termination, and treat sealed or truncated `events.log` as `eventsAvailable: false` so stale prefixes never assert `recorded-match`.

### E2-F: Read-only Studio Mission Board integration
- **HTTP boundary** ([`cockpit-http/coordinator.ts`](../../cockpit-http/coordinator.ts), [`cockpit-http/workspace-host.ts`](../../cockpit-http/workspace-host.ts), [`cockpit-http/server.ts`](../../cockpit-http/server.ts)): strictly read-only `GET /api/v0/workbench/workspace/coordinator/coordination` behind the existing loopback/origin/capability/`X-Endo-Grant` guards (re-checked after async reads; non-GET refused; sibling worktree `.git` pointers revalidated via `storage/git-worktree-pointer.ts` with zero `adapters/` imports).
- **Studio UI** ([`studio-ui/src/coordinator/CoordinationViews.tsx`](../../studio-ui/src/coordinator/CoordinationViews.tsx), [`studio-ui/src/coordinator/CoordinatorWorkspace.tsx`](../../studio-ui/src/coordinator/CoordinatorWorkspace.tsx), [`studio-ui/src/coordinator/read.ts`](../../studio-ui/src/coordinator/read.ts), [`studio-ui/src/coordinator/use-coordinator.ts`](../../studio-ui/src/coordinator/use-coordinator.ts), [`studio-ui/src/api.ts`](../../studio-ui/src/api.ts), [`studio-ui/src/studio.css`](../../studio-ui/src/studio.css)): adds read-only `Lanes` (Participant Lanes with builder/reviewer role badges, execution standing, and offline liveness) and `Graph` (Dependency Graph rendering only actual operator-declared edges), plus coordination status banner and provenance panel (worktree conflicts/hazards, registered sibling worktrees, candidates/host receipts, and advisory-only review disclosures). Zero inline `style={}` props, zero new animations, zero drag-to-dispatch, zero mutation controls.

---

## 3. Acceptance Test Matrix (AT01–AT24)

| ID | Scenario | Status | Evidence / Suite |
| :--- | :--- | :--- | :--- |
| **AT01** | Valid assignment-linked Codex attempt (Strict-only, shared `.route.json`, write-once auth & outcome, `consequenceObserved: false`, Codex `session-grant` refused, native approvals separate) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT02** | Assignment revision changed during operator approval → refused (`stale-revision`), zero route claim, zero transport | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT03** | Task revision changed during operator approval → refused (`stale-revision`), zero route claim, zero transport | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT04** | Winner A: revocation wins commitment race → refused (`assignment-not-active`), `.route.json` absent | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT05** | Winner B: dispatch commits before revocation → `liveness-unverified` retained; pre-transport abort burns `.route.json`, keeps hazard when writable session remains, clears only when zero unverified bases remain | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT06** | Pi and Codex compete for same attempt on shared `.route.json` → at most one winner in both directions | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT07** | Protected and live routes share exclusivity + raw Pi workbench / protected bypass of assignment-linked attempt refused (`assignment-required`) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT08** | Crash after `.route.json` claim (Window W1) → `commit-partial`, route stays burned, retry refused, hazard retained on revocation | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT09** | Crash after authorization write (Window W1b) → `commit-partial`, projection shows `adapter-authorized`, retry refused, hazard retained | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT10** | Uncertain transport delivery (Window W3, `disconnect-mid-turn`) → `.outcome.json` records `unknown`, zero automatic retries, projection shows `adapter-unknown` | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT11** | Runtime `instanceId` rotation → stale authorization refused (`session-binding-stale`) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT12** | Dependency invalidated mid-approval → dispatch refused (`prerequisites-not-satisfied`) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT13** | Unregistered sibling worktree refused (`worktree-not-registered`); explicitly registered sibling accepted | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT14** | Malicious `.git` symlink, foreign `gitdir:`, foreign repo, and post-registration symlink swap refused | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT15** | Review on superseded candidate `C1` after `C2` declared preserves `C1` provenance (`superseded-candidate`) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT16** | Agent falsely claiming tests passed stays `advisory-agent-review`, never touches `develop/receipts/`, `candidate-has-passing-receipt` stays `unsatisfied` | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT17** | Offline session observation never claims live state or confirmed termination; protocol rejects forged live/confirmed records | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT18** | Live controller distinguishes `connected`, `stale-observation`, `disconnected` (`termination.confirmed: false`), and `termination-confirmed` (`remainingProcesses === 0`) | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT19** | Unauthorized Coordinator HTTP calls (unpaired 401, revoked grant mid-read 401, wrong project 400, non-GET 403/405) with zero store writes | **PASS** | `tests/coordinator-studio-e2.test.ts` |
| **AT20** | Cross-project review binding refused in store (`cross-project`); real `bwrap` sandbox mounts only requested project's reviews, filters `WRITE_ONCE_TEMPORARY_V0`, isolates unsafe/bloated review dirs | **PASS** | `tests/develop-assignment-e2.test.ts`, `tests/coordinator-studio-e2.test.ts` |
| **AT21** | Pi-only capabilities (`queue`, `native-command`) on Codex return honest unsupported refusal with zero route claim | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **AT22** | Existing Pi workbench, Codex live, protected execution, Coordinator status, and Studio UI source/closure suites pass without regression | **PASS** | Full `npm test` (7,603 passed + 2 contention-flake files re-verified 68/68) + 10-suite post-fix battery (183 passed, 1 opt-in real-systemd skipped) |
| **AT23** | Read-only Studio coordination views (`Lanes`, `Graph`, banner, provenance panel) render real HTTP projection with declared-only edges, offline liveness, and zero mutation controls | **PASS** | `tests/coordinator-studio-e2.test.ts`, `tests/endo-studio-ui-source.test.ts` |
| **AT24** | E1 §10.6 pairwise `acknowledgedConflictIds` remediation catches reactivated unacknowledged shared-worktree overlap | **PASS** | `tests/develop-assignment-e2.test.ts` |
| **Real systemd scope** | Real kernel-isolated protected run (`ENDO_REAL_SCOPES=1`) | **NOT RUN (skipped)** | Skipped by default in non-systemd-user harness per PR #179; deterministic isolation tests do not substitute for kernel-isolation evidence |

### Verification commands executed (post-remediation)
- `npm run typecheck` → **PASS** (0 errors across `tsconfig.json` and `studio-ui/tsconfig.json`).
- `npm run lint` (`biome check .`) → **PASS** (0 errors; only 1 pre-existing warning in untouched `tests/endo-cockpit-eighteenth-review.test.ts`).
- `npm run build && npm run build:studio-ui` → **PASS** (CLI + 12 Studio UI assets built cleanly).
- `npx vitest --run tests/develop-assignment-e2.test.ts tests/coordinator-studio-e2.test.ts tests/develop-coordination-store.test.ts tests/develop-coordination-cli.test.ts tests/coordinator-coordination.test.ts tests/coordinator-coordination-sandbox.test.ts tests/develop-protected-attempt.test.ts tests/endo-workspace-host.test.ts tests/endo-studio-ui-source.test.ts tests/endo-cockpit-coordinator.test.ts` → **PASS** (10/10 files, 183 passed, 1 skipped).
- Full `npm test` run before final adversarial-fix batch: 317/333 files passed (7,603 tests passed; 14 opt-in/env-gated files skipped; the 2 CPU-contention flakes `tests/aa-operator.test.ts` and `tests/develop-codex-live.test.ts` subsequently passed 68/68 when re-run).

---

## 4. Independent Adversarial Review Findings & Disposition

An independent read-only adversarial security and systems review audited the full E2 diff across all six axes (authority boundaries, lock ordering/crash consistency, worktree security, session liveness, sandbox isolation, and E1 §10.6 remediation). All **11 substantiated findings** (4 HIGH, 5 MEDIUM, 2 LOW) were resolved and locked down with regression tests:

| # | Severity | Finding | Resolution |
| :--- | :--- | :--- | :--- |
| 1 | HIGH | `endoAttemptExecutionEvidenceFromReadV0` short-circuited before checking `develop/attempts/`, potentially masking unreadable/conflicting records during pre-transport hazard clear; `clearHazardAfterPreTransportAbort` did not bind to `(attemptId, authorizationId)`. | Moved `attemptsRead` validation ahead of `adapterRecords`, failed closed on dual auth/problems, matched `assignmentId`, and tightened `clearHazardAfterPreTransportAbort(assignmentId, revision, attemptId, authorizationId)`. |
| 2 | HIGH | Unlinked Pi workbench and protected route claims checked `coordination.json` outside `coordination.lock.<n>`, leaving a TOCTOU window against concurrent `endo assign link`. | Added `DevelopCoordinationStoreV0.claimUnlinkedAttemptRoute` inside `coordination.lock.<n>` and routed both unlinked Pi workbench and protected claims through it (plus fixed a `"protected"` route refusal-code race in `planProtectedAttemptV0`). |
| 3 | HIGH | `pinCoordinatorStoreV0` mounted `coordination-reviews/<projectId>/` before primary files using shared `MAX_ENTRIES` without rollback, risking primary status suppression on bloated/unsafe review directories. | Reordered reviews after `tasks.json`, `attempts/`, `receipts/`, and `events/events.log`, enforced a dedicated 320-entry per-project cap, and added full mount/FD/entry rollback on error. |
| 4 | HIGH | `cockpit-http/coordinator.ts` checked only `lstat(.git).isFile()` on registered sibling worktrees without validating `.git` pointer contents, `gitDir`, or primary `commonDir`. | Extracted pure `storage/git-worktree-pointer.ts` (zero `adapters/` imports) and enforced full pointer + `gitDir` + primary `commonDir` validation before invoking `observe`. |
| 5 | MEDIUM | `readProtectedAttemptV0` omitted `"adapter-live"` routes and `adapter-authorizations/` from `workbenchAuthorized` (`single-execution-route`). | Added `"adapter-live"` and `checkAdapterAuthorizationPresenceSyncV0` checks to `readProtectedAttemptV0`. |
| 6 | MEDIUM | Incomplete sibling `.git` pointer check in `DevelopAttemptDispatchV0.check`; nullable `verifiedWorktree.gitDir` bypass in `commitAssignmentDispatch`; absolute `gitdir:` trailing-slash/intermediate-symlink gap in `inspectLinkedGitPointer`. | Reused `revalidateRegisteredSiblingPointerSyncV0` in `DevelopAttemptDispatchV0.check`, required non-null exact `verifiedWorktree.gitDir === reg.gitDir`, and normalized with `resolve()` + `resolvedTarget === canonicalGitDir`. |
| 7 | MEDIUM | Stale disconnected live snapshots could emit `termination.confirmed: true`; `readOfflineSessionActivity` did not fail closed on sealed/truncated `events.log`. | Enforced `confirmed === (state === "termination-confirmed")` in both contract and validator; treated `store.recovery().sealed || truncated` as `eventsAvailable: false`. |
| 8 | MEDIUM | Omitting `acknowledgedConflictIds` on new E2 unacknowledged assignments let legacy E1 `sharedWorktreeAcknowledged: true` mask new overlaps; protocol did not reject self-references. | Always persist explicit `acknowledgedConflictIds` (including `[]`) on new E2 assignments and reject self-references in `protocol/develop-coordination.ts`. |
| 9 | MEDIUM | `dispatchEndoAssignmentAttemptV0` permitted `mechanism: "session-grant"` on Pi prepared work attempts, broadening Pi Everyday eligibility. | Refused `session-grant` for prepared work attempts on both Codex and Pi (requiring explicit terminal confirmation). |
| 10 | LOW | Multiline/control-character transport errors failed `validateEndoDevelopAdapterOutcomeV0` and silently dropped `.outcome.json`. | Sanitized control characters and empty strings before persisting `.outcome.json`. |
| 11 | LOW | `DevelopCoordinationReviewsStoreV0.recordReview` did not verify `input.attemptId` belongs to `input.projectId`. | Added `DevelopAttemptsStoreV0` same-project ownership verification when `attemptId !== null`. |

### Follow-up Codex PR Review Remediation (PR #186)

All 5 findings raised by Codex on Draft PR #186 were reproduced, fixed, and regression-tested:

| # | Priority | Finding | Resolution |
| :--- | :--- | :--- | :--- |
| C1 | P1 | Sibling `.git` pointer tampered while operator approval was pending succeeded because `commitAssignmentDispatch` checked only pre-approval `verifiedWorktree` strings. | Revalidate live primary path and `revalidateRegisteredSiblingPointerSyncV0(reg, primaryCommonDir)` inside `commitAssignmentDispatch` under `coordination.lock.<n>` before claiming `.route.json`. |
| C2 | P1 | Assignment-linked Pi workbench `authorize()` accepted a different session/attachment than declared on `assignment.session`. | Added `sessionBinding` validation inside `commitAssignmentDispatch` under `coordination.lock.<n>` and forwarded Pi workbench & live adapter session bindings (`session-binding-stale` refusal before `.route.json` claim). |
| C3 | P2 | Pi lifecycle/attachment events record process instance in `payload.instance` (not `payload.instanceId`), leaving Pi restarts as `instanceStatus: "unverified"`. | Normalized both `payload.instanceId` and `payload.instance` in `storage/coordinator-coordination.ts`. |
| C4 | P2 | `DevelopAttemptDispatchV0.authorize()` and `launchProtectedAttemptV0()` did not forward `verifiedCandidates`, causing valid `candidate-declared` / `candidate-has-passing-receipt` dependencies to fail `prerequisites-unknown`. | Added `verifiedCandidates` to `DevelopAttemptAssignmentBindingV0`, forwarded in both routes, and auto-verified prerequisite candidate identities outside `coordination.lock.<n>` in `launchProtectedAttemptV0` when omitted. |
| C5 | P2 | Studio discarded coordination read failures (`503`/timeout/invalid) and rendered misleading empty Lanes/Graph boards. | Passed `coordinationReply` into `Board` and added explicit `CoordinationUnavailableBanner`, `CoordinationUnavailableBoard`, and provenance unavailability disclosures whenever coordination read fails. |

---

## 5. Explicit Deviations & Remaining Limitations

1. **No synthetic `"before-send"` observation in `assignment-dispatch.ts`**: Existing `protocol/develop-observations.ts` binds `"before-send"` observations strictly to `by: "workbench"` with a real `events.log` `sendEventId`. Rather than forging workbench observation records for non-workbench adapter dispatches, E2 leaves `develop/observations/` strictly bound to real workbench/operator observations (`endo observe`).
2. **Cross-file crash windows remain explicit, not transactional**: POSIX filesystems do not provide atomic multi-file transactions across `.route.json`, `.authorized.json`, and `coordination.json`. E2 handles W1/W1b/W2/W3 conservatively by never deleting `.route.json`, never retrying automatically, and surfacing uncertainty explicitly.
3. **No periodic heartbeat daemon or live Studio WebSocket push**: Per E2 scope, E2-E provides pure pull-based observation functions (`endoObserveAdapterLivenessV0` / `endoOfflineSessionLivenessV0`) and Studio reads offline HTTP projections. Live heartbeat scheduling belongs to S0/S1+.
4. **Pi workbench & protected CLI callers do not yet expose `--assignment` CLI flags**: The underlying `DevelopAttemptDispatchV0` and `launchProtectedAttemptV0` APIs accept `assignmentBinding` / `options.assignment` and enforce the anti-bypass gate, while operator-facing CLI dispatch of assignment-linked attempts is ready to be wired cleanly during E3.
5. **Workstation `H0` remains `BLOCKED`**; no host permissions, systemd units, or OpenClaw configurations were touched.

---

## 6. Concrete Handoff for E3 (`COORDINATOR-HETEROGENEOUS-001`)

E2 establishes every governance, storage, isolation, and UI primitive required for **E3 — First Controlled Heterogeneous Builder/Reviewer Experiment**:

### Objective of E3
Execute one bounded, operator-governed heterogeneous collaboration workflow on a dedicated test/target repository:
- **Builder**: Live Codex (`CodexDevelopAdapterV0`, Strict-only terminal confirmation) on a registered worktree producing a clean Git candidate commit `C1` (and optionally a revised candidate `C2` after review feedback).
- **Reviewer**: Live Pi (`PiDevelopAdapterV0`) on a separately registered sibling worktree (`endo worktree register`) in read-only intent evaluating `C1` and recording a structured advisory review (`endo review record`).
- **Verification**: Deterministic host check receipt (`endo verify`) executed by the host — proving that Pi's advisory review never substitutes for host verification, while both appear distinctly on the Studio Mission Board (`Lanes`, `Graph`, and Provenance panels).

### Preconditions & Entry Checklist for E3
1. Merge E2 (`feat/coordinator-assignment-003`) after operator review.
2. Add a thin operator CLI entrypoint (e.g., `endo assign dispatch --assignment <id> --attempt <id> ...`) wiring `dispatchEndoAssignmentAttemptV0` to live terminal phrase confirmation for both `CodexDevelopAdapterV0` and `PiDevelopAdapterV0`.
3. Confirm explicit operator budget/allowance approval before invoking live frontier Codex/Pi sessions (zero unapproved frontier API/subscription consumption).
4. Record empirical E3 metrics: dispatch/commit latency, revocation-race behaviour, worktree isolation verification, candidate provenance fidelity across `C1 → C2`, and operator cognitive load on the Studio Mission Board.
