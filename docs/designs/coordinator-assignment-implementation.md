# COORDINATOR-ASSIGNMENT-002: durable, operator-controlled coordination metadata (E1)

* **Status:** implemented (E1 of [coordinator-assignment.md](coordinator-assignment.md) §14).
* **Baseline:** `origin/main` `99423a9241a87950a78a74c7d43381ac34c91afc`.
* **Principle:** an assignment is not an authorisation, and readiness is not permission to execute. E1 records the operator's *intent*. Nothing here dispatches, schedules, prompts, stops a process, moves a task or accepts a candidate.

## 1. What E1 adds

| Layer | File | What it is |
| :--- | :--- | :--- |
| Protocol | `protocol/develop-coordination.ts` | `endo.develop-coordination.v0`: assignments, dependencies and per-task candidates in one file, read through `defineEndoVersionTableV0`. Strict, closed validation: id patterns, enums, supersession symmetry, candidate/target cross-references, duplicate pairs, dependency cycles (iterative DFS), bounded sizes. |
| Storage | `storage/develop-coordination.ts` | `DevelopCoordinationStoreV0`: `<root>/develop/coordination.json` under `<root>/develop/coordination.lock.<n>`. Every change is checked against a revision the operator read (file revision for creations, record revision for changes). |
| Lock | `storage/numbered-lock.ts` | The numbered lock extracted from `storage/develop-tasks.ts`, now shared by `tasks.lock.<n>` and `coordination.lock.<n>`. Test-only interleaving hooks. |
| Projection | `protocol/coordinator-coordination.ts`, `runtime/contracts/develop-coordination.ts`, `storage/coordinator-coordination.ts` | `endo.coordinator-coordination.v0`: a read-only, deterministic companion projection with closed codes only. |
| Host re-verification | `adapters/develop/coordination.ts` | Git (commit → tree in the same common dir) and protected-run re-establishment, injected into the read-only gatherer. |
| CLI | `cli/develop-coordination.ts`, `cli/coordinator.ts` | `endo assign …`, `endo dep …`, `endo candidate …`, `endo coordinator coordination`. |
| Sandbox | `adapters/coordinator/*` | The status worker also emits the coordination projection for the one requested project; `coordination.json` is descriptor-pinned like the other files. |

### 1.1 Records

* **Assignment:** participant (slug, role builder/reviewer/investigator, intended harness family or null), task and the task revision it was confirmed against, workspace intent (canonical worktree path, `project-path` or `same-repository-unregistered`, read-write or read-only intent, advisory path hints, explicit shared-worktree acknowledgement), an optional operator-declared session association (`pi-live`/`codex-live` only; `test-*` is refused as `synthetic-not-admitted`), linked prepared attempts (references only), an optional target candidate for reviewers and investigators, and a lifecycle: `active` → `superseded` | `revoked` | `closed`, with symmetric supersession links.
* **Worktree hazard:** a terminal transition records `liveness-unverified` with the bases the on-disk evidence warrants (`attempt-authorized`, `attempt-route-claimed`, `attempt-evidence-unreadable`, `writable-session-associated`). Only `endo assign clear-hazard --evidence-digest <sha256> --note …` clears it, binding the clearance to the exact observed execution-evidence snapshot (`acknowledgedEvidence`) and preserving earlier assertions in `priorClearances`. No timer, lease or agent claim clears it; newly observed or unreadable execution evidence reactivates `liveness-unverified` while retaining prior clearance history.
* **Dependency:** `dependent → prerequisite` in one project, under `operator-task-done`, `candidate-declared`, `candidate-has-passing-receipt` or `operator-decision`. Decisions are bound to the prerequisite's task revision.
* **Candidate:** immutable `git-commit` (common dir, worktree, full commit and tree ids) or `protected-candidate` (attempt, run, binding and candidate digests). A new declaration supersedes the current one and keeps it; `candidate select` changes which is current and never erases.

### 1.2 Refusals and outcomes

Every refusal writes nothing: `not-found`, `stale-revision`, `stale-evidence`, `invalid-transition`, `bad-request`, `limit`, `duplicate`, `dependency-cycle`, `cross-project`, `worktree-write-overlap`, `synthetic-not-admitted`, `unsupported-source`, `unreadable`, `tasks-unreadable`, `attempts-unreadable`, `busy`, `storage-failed`. One outcome is not a refusal: `commit-uncertain` (§3.2). An unreadable, oversize, unknown-version or invalid `coordination.json` is reported and left byte for byte; it is never repaired.

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

The design names `coordination.lock.<n>` with "the same discipline" as `tasks.lock.<n>`. Rather than copy the lock, it was moved into `storage/numbered-lock.ts` and both stores use it. The existing task-store suites (including the six-process contention test) pass unchanged, and `tests/numbered-lock.test.ts` drives the two designed races deterministically through hooks.

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

## 7. §12 scenario coverage

Every row of [coordinator-assignment.md §12](coordinator-assignment.md), in its own wording. **E1** means this milestone covers it, and the named test proves it. **E2**, **E4** and **Phase F** mean the scenario needs the machinery that milestone adds; the reason is given. **N/A** means it is outside coordination metadata, with the reason.

| # | Scenario (§12) | Class | Evidence or reason |
| :-: | :--- | :--- | :--- |
| 1 | Concurrent assignment race | **E1** | Both writers checked against the same file revision: the second is refused `stale-revision` and writes nothing (`tests/develop-coordination-store.test.ts`: "refuses a stale file revision…"). Real contention: four processes, 24 writes, nothing lost (`tests/develop-coordination-store.test.ts`: "many processes writing at once…"). |
| 2 | Coordinator proposes on stale task revision | **Phase F** | E1 has no proposals: the Coordinator gains no tool, and every record is `confirmedBy: operator`, `via: cli`. The nearest E1 behaviour is that an assignment bound to an older task revision reads `task-stale` until reconfirmed (`tests/coordinator-coordination.test.ts`: "a task edited after binding is reported stale…"). |
| 3a | Race: Revocation wins `coordination.lock.<n>` before dispatch | **E2** | There is no dispatch commitment in E1. E1 supplies its preconditions: revocation bumps the assignment revision under `coordination.lock`, so a dispatcher holding `(A1, rev 3)` can detect the change, and the revoked assignment refuses every further transition (`tests/develop-coordination-store.test.ts`: "supersede ends the old one…"). |
| 3b | Race: Dispatch commitment wins `coordination.lock.<n>` before revocation | **E2** | Needs the commitment and `.aborted.json`. E1 already derives `attempt-route-claimed` from the on-disk route when an assignment is ended (see row 4a). |
| 4a | Assignment revoked after transport delivery / acknowledgement (B4–B5) | **E1** (record side) / **E2** (delivery) | A revoked assignment whose linked attempt has a claimed route is `liveness-unverified`, and a new writer on that worktree is refused (`tests/develop-coordination-store.test.ts`: "§12 4a: a linked attempt whose route is claimed…"). No process is killed and nothing is freed. Transport delivery itself is E2's. |
| 4b | Crash in W1 (after `.route.json`), W1b (after auth, before `coordination.json`), or W2 (after lock release, before transport write) | **E2** | The windows are inside E2's dispatch commitment. E1's own crash windows (before and after the rename) are covered: `tests/develop-coordination-store.test.ts`, "a failure before the rename is storage-failed…" and "…after the rename is commit-uncertain…". |
| 5 | Worker disappears with unknown execution outcome (W3) | **E2** | Needs the live dispatcher's `unknown` outcome. E1 never retries anything: it has no execution path. |
| 6 | Assignment closed, revoked, or superseded while process may still be running | **E1** | An ended writer with an associated session stays hazardous. A same-worktree writer is refused until the operator clears the hazard, and the bases are kept (`tests/develop-coordination-store.test.ts`: "an ended writer with an associated session stays hazardous…"). The clean counter-case leaves no hazard ("an ended writer with nothing on disk…"). |
| 7 | Stale worker output / report arrives after reassignment | **E1** (lifecycle) / **E2–F** (capture) | A superseded assignment keeps its history, links to its replacement, and refuses every transition (`tests/develop-coordination-store.test.ts`: "supersede ends the old one…"). Ingesting worker reports does not exist until E2/F. |
| 8 | New session tries to inherit old session's authority | **E2** | E1 sessions are operator-declared with liveness `unknown` and carry no authority to inherit (`tests/coordinator-coordination.test.ts`: "a declared session reads as operator-declared…"). Detecting `session-binding-stale` needs E2's live binding. |
| 9 | Protected attempt already reserved its route | **N/A to E1** (pre-existing) | Enforced today by `DevelopAttemptDispatchV0` and the protected launcher through `link(2)` on `.route.json`. E1 does not touch routes; it only reads them as hazard evidence. E2 widens the routes. |
| 10 | Builder reports success without candidate reference | **E1** | Only the operator declares candidates. Without one, `candidate-declared` is `unsatisfied` (`no-current-candidate`) and the dependent waits (`tests/coordinator-coordination.test.ts`: "§12 10…"). |
| 11 | Reviewer evaluates superseded candidate `C1` after `C2` declared | **E1** (relation) / **Phase F** (review capture) | A reviewer pinned to `C1` reads `superseded-candidate` with a finding once `C2` is current (`tests/coordinator-coordination.test.ts`: "§12 11…"). `C1`'s receipts stay its history (`tests/coordinator-coordination.test.ts`: "a new candidate is evaluated afresh…"). Persisted reviews are a later milestone. |
| 12a | Worktree dirties or moves after passing receipt at `C1` (`C1` still current) | **E1** | The receipt stays passing for `C1`. The workspace reads `moved-from-candidate`, the dependency warns `workspace-drifted-from-candidate`, and readiness is `ready-for-pinned-candidate` (`tests/coordinator-coordination.test.ts`: "§12 12a…"). |
| 12b | New candidate `C2` declared after passing receipt at `C1` | **E1** | The dependency is evaluated against `C2` and is `unsatisfied`. `C1` stays `superseded` with `passing` receipts (`tests/coordinator-coordination.test.ts`: "a new candidate is evaluated afresh…"). |
| 13 | Dependency invalidated after downstream work begins | **E1** (finding) / **E2** (dispatch refusal) | The dependent's assignment stays `active` with `prerequisites-not-satisfied`; this is §12's `prerequisite-invalidated` (§3.6). Tested in `tests/coordinator-coordination.test.ts`: "an assignment whose prerequisites are not satisfied…". Refusing new dispatches under it is E2's. |
| 14 | Dependency cycle attempted | **E1** | Refused `dependency-cycle` and the bytes are unchanged (`tests/develop-coordination-store.test.ts`: "refuses self edges, duplicates and cycles…"). The validator also rejects a cycle written by hand ("rejects a cycle…"). |
| 15 | Overlapping worktree scopes | **E1** | Refused `worktree-write-overlap` by default. With `--allow-shared-worktree yes` the acknowledgement is recorded (`tests/develop-coordination-store.test.ts`: "a second writer on the same worktree is refused…") and is reported permanently as a conflict (`tests/coordinator-coordination.test.ts`: "an acknowledged shared writable worktree…", "…does not depend on file order…"). |
| 16 | Source becomes incomplete or unreadable | **E1** | Malformed, unknown-version, invalid and oversize files are left byte for byte and every write is refused (`tests/develop-coordination-store.test.ts`: "a file that cannot be read is never repaired"; an unreadable `tasks.json` too). Reads report `unreadable` with a gap (`tests/coordinator-coordination.test.ts`, `tests/coordinator-coordination-sandbox.test.ts`). |
| 17 | Malicious task description prompt injection | **N/A to E1** | The Coordinator runtime, its trimmed view and its tool allowlist are unchanged (`tests/coordinator-brief.test.ts`). E1 adds no tool, and the model view carries no coordination data (`tests/coordinator-coordination-sandbox.test.ts`). |
| 18 | Coordinator proposes unsupported native harness operation | **E2** | Admission belongs to `endoEvaluateDevelopAdmissionV0` at dispatch. E1 records no operations. |
| 19 | Synthetic adapter presented as real assignment target | **E1** | `test-*` sources are refused `synthetic-not-admitted`, and unknown sources `unsupported-source` (`tests/develop-coordination-store.test.ts`: "refuses synthetic and unknown session sources…"; `tests/develop-coordination-cli.test.ts`: "refuses a synthetic session source"). |
| 20 | Agent claims privileged operator or verifier identity | **E1** (records) / limit stated | Any record not attributed to the operator is invalid (`tests/develop-coordination-store.test.ts`: "§12 20…"). A forged protected binding is `not-established` (`tests/develop-protected-attempt.test.ts`). §12's explicit limit stands: a same-uid writer can edit the file, so attribution is `unsigned-local-record`. |
| 21 | Concurrent per-attachment sessions race on one attempt or corrupt one log (E4) | **E4** (logs) / **E2** (route) | Per-attachment logs are E4's (§8 below). The single store-wide `.route.json` and `coordination.lock` domain is preserved: E1 adds no per-attachment state. |

## 8. E4 reconnaissance: what #182's shared writer lock implies for the store-format sentinel

This is reconnaissance only. Nothing here is implemented.

#182 moved the event-store writer lock into `storage/writer-lock.ts`, shared by Pi and Codex. It works like this:
- **Ownership:** each lock carries a random token. Release removes the file only when the token is still its own.
- **Acquisition:** exactly one exclusive `wx` create.
- **Fail closed:** an unreadable lock, a lock without a positive integer `pid` (named explicitly as "any future E4 non-PID store-format barrier"), or a live or `EPERM` pid all refuse.
- **Dead-PID recovery:** never renames or overwrites. It takes a separate `<lock>.recover` barrier with `wx`, re-reads the lock, unlinks it only if it is byte-identical and still dead, makes one `wx` attempt, and releases `.recover` by token. An existing `.recover` is never stolen.
- **Recovery instructions:** refusals say "verify no Endophasia session (Pi or Codex) is writing this store before manually removing …".

The cases below follow from that.

* **Legacy writers starting after a migration.** The permanent `{"format":"per-attachment-v1"}` sentinel at `events/session-attachment.lock` has no `pid`. Both the #182 lock and the pre-#182 `acquireWriterLock` (baseline `241eadfc4`: `pid === undefined` is "held") therefore refuse it. A legacy writer cannot append to `events/events.log` after migration, so the sentinel needs no new code in legacy binaries. **It must never contain a numeric `pid`**, or a legacy writer would judge it dead and remove it.
* **Legacy writers starting before a migration.** A live legacy pid holds the lock, and E4 must refuse to migrate (fail closed, as §6.4 says). Migration should install the sentinel through the same discipline #182 uses: `wx` when the lock is absent, or the `.recover` protocol when a dead-PID lock must go. It must never rename over a lock.
* **Contemporary Pi and Codex writers.** Since #182 both take the same lock, so today one harness at a time writes the store, whichever it is. E4's per-attachment locks replace this for E4 writers only. The legacy path keeps one shared lock until the sentinel is installed. A mixed population is safe because every #182-or-later writer refuses the sentinel.
* **A stale legacy lock with a concurrent recovery.** #182 serialises recovery behind `.recover`. A **pre-#182** binary does not know `.recover`: it reads the dead lock, then `rmSync`s and `wx`-creates without re-verifying. It can therefore delete a lock a #182 process has just created inside its own recovery, and both would then write. **E4 therefore needs every writer on a store to be #182 or later before migration.** A pre-#182 binary cannot be fenced out by a file it does not read, so this is a documented version floor, not a lock rule.
* **A leftover `.recover` barrier.** A crash inside recovery leaves `.recover`. Normal acquisition still works when the lock is absent, but every later dead-PID recovery, including a migration that must clear a dead lock, refuses until the operator removes it. E4 should report it as a distinct state with its own instruction ("stale-lock recovery barrier left by pid N; confirm no recovery is running, then remove …"). E4 must never treat `.recover` as permission to migrate.
* **The recovery hint is wrong for the sentinel.** The current hint tells the operator to "manually remove" any lock that has no pid. Applied to the E4 sentinel, that advice would re-admit legacy writers to a migrated store. E4 must recognise the sentinel by its `format` and give a different instruction: a store-format marker, never to be removed. E4 should also add a test proving a legacy writer refuses it in both startup orders (§6.4, acceptance criterion 2).
* **Legacy-to-new-stream historical identity.** `events/events.log` becomes the frozen `legacy` stream and is never rewritten or moved. A resumed attachment (for example `pi.default`) seeds its duplicate set and cursor from the legacy log, so its deterministic event ids do not raise false duplicates. Cross-attachment duplicates are an integrity finding. E1's records hold no event ids or offsets: sessions are keyed by `sessionKey`, and attempts by id. Coordination metadata therefore needs no migration for E4.
* **Shared attempt-route exclusivity.** `.route.json` (`link(2)` per attempt), `coordination.json` with `coordination.lock.<n>`, `attempts/` and `tasks.json` stay one store-root-wide domain. The event-log lock, per-attachment or legacy, is long-lived (held for a session) and must never be taken inside `coordination.lock`. E2's commitment takes only `coordination.lock`, plus the `link(2)` on the route, and releases before harness I/O, so the two lock families cannot deadlock. E1 nests neither with the other.

## 9. Independent review and disposition

One read-only reviewer on archlinux inspected draft head `d0bfd641d` across the ten requested areas. The reviewer ran Node reproductions against temporary stores; the principal agent checked the findings against the implementation and §7.1, and ran the regressions. The earlier confirmation-time tie was a **self-review** finding.

| Finding | Disposition |
| --- | --- |
| R1: silently binding a newer task revision | Fixed. Create, supersede and reconfirm require `--task-revision`; decide requires `--prerequisite-revision`. These are checked against the task snapshot inside the coordination lock. The store regression checks all four stale refusals and unchanged bytes. |
| R2: invalidate candidate conditions after every task edit | Rejected as a blanket rule. §7.1 defines these conditions by current candidate identity and receipts, not the mutable task revision. It binds the operator decision to the prerequisite revision. Scenario 13 specifies an `operator-task-done` edge: the test now moves that prerequisite to done and reopens it, checking the assignment remains active with a finding. |
| R3: session unbinding or a late route bypasses a hazard | Fixed. A writable session association cannot be removed before closure to evade the hazard. Ended writable assignments with no stored hazard are checked against current attempt/route evidence before admitting another writer, projecting conflicts or clearing a hazard. Both paths have store regressions. Operator cleanup is an assertion, not observed liveness. |
| R4: optional coordination data suppresses primary status | Fixed. Unsafe files aren't mounted; the companion reports a gap. Invalid or out-of-scope companion data is discarded without suppressing valid primary status. Oversized combined output drops the companion rather than expanding the existing byte budget. The symlink regression checks both primary availability and the gap. |
| R5: damaged tasks prevent revocation | Fixed. Task snapshots are read only on first use. A store regression revokes an assignment with malformed task bytes. |
| R6: failed release can reset lock numbering | Fixed in the shared numbered lock. A failed marker write preserves the highest lock and fails closed. A fault-injection regression checks that the next writer cannot acquire. |
| R7: parent durability, serialized size and ignored option | A newly created develop directory is synced into its parent; hitting the serialized byte limit now returns `limit`; supersede no longer accepts the ignored project flag. |
| R8: cross-project conflicts and disclosure | Exclusion is global. Foreign assignment IDs are omitted from overlap refusals. Projection conflicts are computed across the visible projects only: the two-project regression shows an all-project read reporting the overlap and a scoped read withholding the other assignment. |

The lock assumes one host, user and PID namespace. A repeated session key for the same participant is a declared association, not proof of an independent session or an execution capability. Neither was established as another authority path. No event-log format, migration, live dispatch or replay change is included.

## 10. Remediation: evidence-bound hazard clearance (`d95577d9b` follow-up)

### 10.1 Reproduced counterexample

Against reviewed head `d95577d9bf244d13e1bdb27bbf47451aac8f43f9`, `endoEffectiveAssignmentV0()` returned early whenever `a.worktreeHazard.state !== "none"`. Running the 9-step counterexample deterministically against a temporary store confirmed:

1. Writable assignment `A1` bound session `S1` and linked prepared attempt `AT1` (undispatched), then was revoked → `liveness-unverified` (`["writable-session-associated"]`).
2. Operator cleared `A1`'s hazard → `operator-cleared`.
3. `DevelopAttemptRoutesStoreV0.claim(AT1, "workbench", ...)` claimed `AT1`'s route after clearance.
4. Both `readEndoCoordinatorCoordinationV0` (`hazard: "operator-cleared"`, `conflicts: []`) and `DevelopCoordinationStoreV0.createAssignment` (`A2` admitted with `ok: true`) failed to reactivate the hazard.

### 10.2 Exact hazard-clearance semantics

Hazard clearance now acknowledges a bounded, canonical **observed execution-evidence snapshot** (`EndoHazardEvidenceSnapshotV0`) rather than establishing a permanent exemption:

* **`writableSession`:** `{ source, sessionKey, attachmentId, instanceId, runtimeFingerprintId }` when writable with a declared session, else `null` (no timestamps).
* **`attempts`:** one entry per linked attempt on the assignment, sorted lexicographically by `attemptId`, recording:
  * `route`: `{ state: "absent" }` | `{ state: "claimed", route: "workbench" | "protected" }` (consulting both `<root>/develop/attempt-routes/<id>.route.json` and the `<root>/develop/protected-attempts/<id>.{launch,candidate}.json` fallback) | `{ state: "unknown", reason }`.
  * `authorization`: `{ state: "absent" }` | `{ state: "authorized", proposalId, authorizationEventId }` | `{ state: "unknown", reason, problems }` where `problems` is a canonical sorted per-`(kind, reason)` count summary from `endoAttemptProblemsOfV0` (checked **before** `entry.authorized`, so orphaned or corrupted authorization/misnamed files never collapse into earlier `handoff`/`outcome` problems or get masked by an existing valid authorization).
* **Re-evaluation (`endoEffectiveAssignmentFromSnapshotV0` & `endoUncoveredHazardBasesV0`):** every ended assignment (whether stored `none`, `liveness-unverified`, or `operator-cleared`, and regardless of advisory `accessIntent`) is re-evaluated against current on-disk evidence. An `operator-cleared` hazard stays cleared **only** while every currently observed non-absent session, route, authorization, or unreadable-evidence item matches its `acknowledgedEvidence`. Any new attempt route, new authorization on a previously route-claimed attempt, changed route/authorization identity, or newly unreadable/unavailable source reactivates `liveness-unverified`, appends the expired clearance assertion to `priorClearances`, and emits the closed Coordinator finding `hazard-clearance-expired`.
* **Worktree occupation (`endoOccupiesWorktreeV0`):** an assignment occupies its worktree against new writers whenever it is an active writable assignment **or** any ended assignment with effective `worktreeHazard.state === "liveness-unverified"`.
* **Stale-evidence binding (`clearHazard`):** `DevelopCoordinationStoreV0.clearHazard(assignmentId, expectedRevision, expectedEvidenceDigest, note)` and `endo assign clear-hazard --evidence-digest <sha256>` require the SHA-256 digest of the exact canonical snapshot (`endoHazardEvidenceDigestV0`, displayed by `endo assign show`). Inside `coordination.lock.<n>`, the store captures current evidence once, checks `effective.worktreeHazard.state === "liveness-unverified"`, and refuses with `stale-evidence` (writing nothing) if the digest changed. On commit, it records `clearedBy: "operator"`, `via: "cli"`, `acknowledgedEvidence`, `bases`, `note`, and preserves prior clearances in `priorClearances` (bounded by `maxClearanceHistoryPerAssignment: 16`, refusing `limit` if exceeded).

### 10.3 Schema changes and compatibility

Narrow amendment to `endo.develop-coordination.v0` (no migration framework):

* New writes emit the closed 8-key canonical `operator-cleared` shape: `{ state, clearedBy: "operator", via: "cli", clearedAtMs, bases, acknowledgedEvidence, note, priorClearances }`.
* Closed validation verifies `acknowledgedEvidence` matches the assignment's `session` and `attemptIds`, every implied basis appears in `bases`, `note` is non-empty, and `priorClearances` stays within `maxClearanceHistoryPerAssignment = 16` and `maxFileBytes = 4 MiB`.
* **Compatibility with earlier draft v0 files:** the pre-remediation 4-key `operator-cleared` shape (`{ state, clearedAtMs, bases, note }`) remains strictly closed-validated and accepted read-only without silent repair or discarding. Because it lacks `acknowledgedEvidence`, `endoUncoveredHazardBasesV0` treats it conservatively: if any current hazard evidence exists, it reactivates to `liveness-unverified` while preserving the legacy assertion in `priorClearances` (`acknowledgedEvidence: null`); if no current hazard evidence exists, it stays `operator-cleared`. Explicit operator re-clearance upgrades the record to the canonical shape while retaining the legacy entry in `priorClearances`.
* Companion projection (`endo.coordinator-coordination.v0`): adds one closed finding code, `"hazard-clearance-expired"`, to `ENDO_COORDINATION_ASSIGNMENT_FINDINGS_V0`; operator notes and raw `acknowledgedEvidence` are never disclosed to the Coordinator.

### 10.4 Regression coverage

* `tests/develop-coordination-store.test.ts`: covers all 10 required regressions (session clearance → late route claim; AT1 vs AT2 same-category route claim; route clearance → late authorization on same attempt; unreadable authorization file after clearance; unchanged evidence idempotency; explicit re-clearance with history preservation; `createAssignment` and `supersedeAssignment` overlap refusals on reactivated hazard; `stale-evidence` refusal and deterministic `afterEvidenceRead` race hook), plus legacy 4-key draft compatibility, closed validator tampering rejections, and all 4 adversarial-review regressions.
* `tests/coordinator-coordination.test.ts`: verifies Coordinator projection parity with the store's conflict evaluator, already-admitted replacement writer reported as `unacknowledged-worktree-write-overlap` + `worktree-liveness-unverified` + `hazard-clearance-expired` on late evidence, `attempt-evidence-unknown` emitted alongside positive channels, and sandbox `routes: "unknown"` conservative reactivation for host-cleared linked attempts.
* `tests/develop-coordination-cli.test.ts`: end-to-end CLI flow for `assign show` → `assign clear-hazard --evidence-digest` → `stale-evidence` refusal → late route reactivation → re-clearance.

### 10.5 Independent adversarial review (remediation) and disposition

One fresh read-only adversarial research reviewer audited the remediation diff across all 10 review areas (clearance identity/scope, late route/auth, unreadable evidence, repeated clearance, conflict semantics, stale revision/evidence, cross-file claims, Coordinator projection/disclosure, accidental execution authority, and `storage/numbered-lock.ts`).

| Finding | Severity | Disposition |
| --- | --- | --- |
| Multi-problem `firstReason` collapsing & `entry.authorized` short-circuit in `endoAttemptExecutionEvidenceFromReadV0` could swallow a newly orphaned/corrupted or misnamed authorization file | **HIGH** | **Fixed.** `endoAttemptProblemsOfV0` is now checked before `entry.authorized`, and `authorization.state === "unknown"` records a canonical sorted `problems: [{ kind, reason, count }]` summary compared in `endoUncoveredHazardBasesV0`. Covered by three counterexample regressions (`tests/develop-coordination-store.test.ts`: "review #1"). |
| `endoOccupiesWorktreeV0` gated `liveness-unverified` behind `accessIntent === "read-write-intended"`, allowing a new writer when an ended `read-only-intended` assignment had an unverified linked-attempt hazard | **MEDIUM** | **Fixed.** Any ended assignment with effective `worktreeHazard.state === "liveness-unverified"` now occupies its worktree against unacknowledged new writers. Covered by regression (`tests/develop-coordination-store.test.ts`: "review #2"). |
| Coordinator projection derived `"attempt-evidence-unknown"` from `ran === "unknown"`, suppressing the finding whenever the other evidence channel was `route-claimed` or `workbench-authorized` | **MEDIUM** | **Fixed.** `"attempt-evidence-unknown"` is now emitted whenever `e.authorization.state === "unknown" || e.route.state === "unknown"`. Covered by regression (`tests/coordinator-coordination.test.ts`: "review #3"). |
| Pre-route `develop/protected-attempts/<id>.{launch,candidate}.json` presence/unreadability without `.route.json` was not consulted | **LOW/MEDIUM** | **Fixed.** Shared `endoRouteEvidenceForAttemptV0` falls back to `checkProtectedAttemptPresenceSyncV0` whenever `.route.json` is absent (matching `DevelopAttemptDispatchV0`). Covered by regression (`tests/develop-coordination-store.test.ts`: "review #4"). |

No regressions were found in `storage/numbered-lock.ts`, cross-file consistency disclosures, Coordinator disclosure boundaries, or execution authority boundaries.

### 10.6 Remaining E1 consistency limits & explicit E2 requirements

* **No cross-file linearisation in E1:** `coordination.lock.<n>` still does not serialize existing attempt-route or attempt-authorization writers (`DevelopAttemptRoutesStoreV0`, `DevelopAttemptsStoreV0`). A route/authorization written after `clearHazard` captures its snapshot inside the lock and before rename is NOT silently acknowledged: `clearHazard` commits only the pre-race snapshot, and subsequent reads/admissions immediately reactivate `liveness-unverified`. If another writer was admitted during the cleared interval, Coordinator reports the resulting conflict without pretending E1 can undo admission or terminate a process.
* **Boolean `sharedWorktreeAcknowledged` limit:** E1's counted-not-ordered overlap check (`writers.filter((a) => !a.workspace.sharedWorktreeAcknowledged).length <= 1`) remains an E1 metadata limit if an ended writer already carried `sharedWorktreeAcknowledged: true` from an earlier overlap.
* **Explicit E2 requirements:** E2 must linearise dispatch commitment inside `coordination.lock.<n>` (re-checking active assignment at approved revision, dependencies, and effective worktree conflicts, claiming `.route.json`, writing harness-neutral authorization, and recording the dispatched attempt before releasing the lock and performing transport I/O) and introduce controller-observed session liveness / termination evidence.
* **Protected-candidate validation standing:** no pre-existing genuine compatible `staged-changeset` protected-run artifact was present under `research/`; synthetic protected-candidate resolution and forged-binding rejection tests in `tests/develop-protected-attempt.test.ts` remain the E1 verification baseline, and live protected-run validation is deferred per operator decision (workstation H0 remains BLOCKED).
