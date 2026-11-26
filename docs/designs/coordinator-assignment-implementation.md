# COORDINATOR-ASSIGNMENT-002: durable, operator-controlled coordination metadata (E1)

* **Status:** implemented (E1 of [coordinator-assignment.md](coordinator-assignment.md) §14).
* **Baseline:** `origin/main` `99423a9241a87950a78a74c7d43381ac34c91afc`.
* **Principle:** an assignment is not an authorisation, and readiness is not permission to execute. E1 records the operator's *intent*. Nothing here dispatches, schedules, prompts, stops a process, moves a task or accepts a candidate.

## 1. What E1 adds

| Layer | File | What it is |
| :--- | :--- | :--- |
| Protocol | `protocol/develop-coordination.ts` | `endo.develop-coordination.v0`: assignments, dependencies and per-task candidates in one file, read through `defineEndoVersionTableV0`. Strict, closed validation: id patterns, enums, supersession symmetry, candidate/target cross-references, duplicate pairs, dependency cycles (iterative DFS), bounded sizes. |
| Storage | `storage/develop-coordination.ts` | `DevelopCoordinationStoreV0`: `<root>/develop/coordination.json` under `<root>/develop/coordination.lock.<n>`. Every change is checked against a revision the operator read (file revision for creations, record revision for changes). |
| Lock | `storage/numbered-lock.ts` | The numbered lock extracted unchanged from `storage/develop-tasks.ts`, now shared by `tasks.lock.<n>` and `coordination.lock.<n>`. Test-only interleaving hooks. |
| Projection | `protocol/coordinator-coordination.ts`, `runtime/contracts/develop-coordination.ts`, `storage/coordinator-coordination.ts` | `endo.coordinator-coordination.v0`: a read-only, deterministic companion projection with closed codes only. |
| Host re-verification | `adapters/develop/coordination.ts` | Git (commit → tree in the same common dir) and protected-run re-establishment, injected into the read-only gatherer. |
| CLI | `cli/develop-coordination.ts`, `cli/coordinator.ts` | `endo assign …`, `endo dep …`, `endo candidate …`, `endo coordinator coordination`. |
| Sandbox | `adapters/coordinator/*` | The status worker also emits the coordination projection for the one requested project; `coordination.json` is descriptor-pinned like the other files. |

### 1.1 Records

* **Assignment:** participant (slug, role builder/reviewer/investigator, intended harness family or null), task and the task revision it was confirmed against, workspace intent (canonical worktree path, `project-path` or `same-repository-unregistered`, read-write or read-only intent, advisory path hints, explicit shared-worktree acknowledgement), an optional operator-declared session association (`pi-live`/`codex-live` only; `test-*` is refused as `synthetic-not-admitted`), linked prepared attempts (references only), an optional target candidate for reviewers and investigators, and a lifecycle: `active` → `superseded` | `revoked` | `closed`, with symmetric supersession links.
* **Worktree hazard:** a terminal transition records `liveness-unverified` with the bases the on-disk evidence warrants (`attempt-authorized`, `attempt-route-claimed`, `attempt-evidence-unreadable`, `writable-session-associated`). Only `endo assign clear-hazard --note …` clears it, and the bases stay as a record. No timer, lease or agent claim clears it.
* **Dependency:** `dependent → prerequisite` in one project, under `operator-task-done`, `candidate-declared`, `candidate-has-passing-receipt` or `operator-decision`. Decisions are bound to the prerequisite's task revision.
* **Candidate:** immutable `git-commit` (common dir, worktree, full commit and tree ids) or `protected-candidate` (attempt, run, binding and candidate digests). A new declaration supersedes the current one and keeps it; `candidate select` changes which is current and never erases.

### 1.2 Refusals and outcomes

Every refusal writes nothing: `not-found`, `stale-revision`, `invalid-transition`, `bad-request`, `limit`, `duplicate`, `dependency-cycle`, `cross-project`, `worktree-write-overlap`, `synthetic-not-admitted`, `unsupported-source`, `unreadable`, `tasks-unreadable`, `attempts-unreadable`, `busy`, `storage-failed`. One outcome is not a refusal: `commit-uncertain` (§3.2). An unreadable, oversize, unknown-version or invalid `coordination.json` is reported and left byte for byte; it is never repaired.

### 1.3 The projection

Per project: assignments (task binding `current`/`task-stale`/`task-missing`, session standing `operator-declared` with liveness always `unknown`, hazard, target relation, attempt links and recorded execution evidence, findings), dependencies (`satisfied`/`unsatisfied`/`unknown` with closed reasons, warnings and disclosures), tasks (readiness and every candidate's identity, workspace and receipt reading) and worktree conflicts. Constant authority: `grants: none`, `writes: none`, `assignmentIsAuthorization: false`, `readinessIsPermission: false`. `basis.consistency` is `per-file-snapshot`. A store without `coordination.json` reads as `absent`, not as an error.

The receipt predicate is bound to one immutable candidate: only receipts at its exact (common dir, commit, tree), with a clean recorded post-check observation, count. Planned checks are read through their plan, so a declared non-zero exit passes. A pass at a superseded candidate stays history for that candidate and never satisfies the current one.

## 2. Boundaries kept

* No dispatch, scheduling, database, agent registry, event sourcing or new authority. An assignment never changes a task.
* No lock is held across a prompt, a Git subprocess, a model call or harness I/O. Git and protected re-verification happen before the store is called (writes) or in the gatherer, which takes no lock (reads).
* `tasks.lock.<n>` and `coordination.lock.<n>` are never nested: the coordination writer reads `tasks.json` lock-free as one atomic snapshot.
* The OpenClaw-facing model view is unchanged; the coordination projection is validated and scoped to the one project but is not part of it. The Coordinator gains no tool; `assign`, `dep` and `candidate` are operator CLI only.

## 3. Deviations from the design, with evidence

### 3.1 Lock extraction

The design names `coordination.lock.<n>` with "the same discipline" as `tasks.lock.<n>`. Rather than copy the lock, it was moved unchanged into `storage/numbered-lock.ts` and both stores use it. The existing task-store suites (including the six-process contention test) pass unchanged, and `tests/numbered-lock.test.ts` drives the two designed races deterministically through hooks.

### 3.2 `commit-uncertain`

The task store treats a failed directory fsync after the rename like any storage failure. For coordination that would tell the operator "nothing changed" when the new file is already visible. E1 reports `storage-failed` only before the rename and `commit-uncertain` after it ("re-read before acting"). Tested with the `beforeReplace` and `afterReplace` hooks.

### 3.3 `writable-session-associated` hazard basis

§6 derives the hazard from attempt authorisation and route evidence only. Since #183, Studio lets the operator prompt a Codex session directly, with no attempt, so a writable assignment with an associated session can have a live writer that no attempt record shows. A terminal transition on such an assignment records `liveness-unverified` with basis `writable-session-associated`.

### 3.4 Sessions are operator-declared only

The CLI cannot reach the live adapters' in-process session registry, so E1 records the operator's declaration (`standing: operator-declared`, liveness always `unknown`) and validates its shape against `endoAdapterSessionKeyV0`'s format. Observing liveness is E2's.

### 3.5 Candidates in the sandbox read `unavailable`

The sandboxed status worker has no Git and does not mount protected runs or route reservations. Its projection says so (`git-unavailable`, `protected-runs-unavailable`, routes `unknown`) and nothing is satisfied on identity there. `endo coordinator coordination` on the host re-verifies.

### 3.6 Finding names

The closed codes differ in places from §12's prose (for example scenario 13's `prerequisite-invalidated` reads as `prerequisites-not-satisfied` with the dependency's own reason, `prerequisite-not-done`). The meanings are the ones §12 specifies.

### 3.7 Pre-existing exposure, documented rather than changed

`integrations/openclaw-endophasia-status` mounts the whole `develop/` directory read-only, so it can read `coordination.json` bytes. It parses only `coordinatorStatus`. Narrowing that mount is outside E1.

## 4. Known limits

* **No cross-file atomicity.** `tasks.json` and `coordination.json` are separate snapshots. A task edited between the coordination writer's read and its write is bound at the revision that was read, and the projection then reports the assignment `task-stale`. Nothing claims the two files agree at one instant.
* **Same-host, same-uid, cooperative.** The lock and the records are unsigned local files. Attribution is `unsigned-local-record`.
* **Receipt history is not re-verified.** Receipts are read as recorded; the projection discloses `receipt-history-unverifiable`.
* **Protected candidates have no host receipt reading** (`protected-candidate-has-no-host-receipt`).

## 5. What E2's dispatch commitment needs

E2 must make dispatch the linearisation point §6.2 describes: inside `coordination.lock.<n>`, re-read the assignment (active, at the revision the operator approved, task binding current), every dependency of its task, and the worktree conflicts; claim `.route.json` and write the harness-neutral authorisation; record the dispatched attempt on the assignment; then release the lock before any transport I/O. A revocation that wins the lock first must make dispatch refuse; a dispatch that wins must leave the revoked assignment hazardous with `attempt-route-claimed`. E1's store already refuses on a stale assignment revision and computes those hazard bases from the on-disk route and authorisation evidence, so E2 adds the commitment, not a second source of truth.

## 6. Verification

* `tests/develop-coordination-store.test.ts`: mutations and refusals, stale revisions, unreadable files left untouched, `storage-failed` vs `commit-uncertain`, the cross-file window, `busy`, no lock nesting, four processes writing at once, and the file validator.
* `tests/numbered-lock.test.ts`: the lock's races through hooks.
* `tests/coordinator-coordination.test.ts`: the projection over real stores (readiness, exact candidate-bound receipts, superseded candidates, identity failure, stale decisions, stale task bindings, conflicts, determinism, zero writes).
* `tests/coordinator-coordination-sandbox.test.ts`: the bubblewrap worker with and without `coordination.json`, and with an unreadable one.
* `tests/develop-coordination-cli.test.ts`: the commands as real processes over a temporary Git repository.
* `tests/develop-protected-attempt.test.ts`: a bound protected attempt resolves to a candidate that is re-established on read; a forged binding is not.
