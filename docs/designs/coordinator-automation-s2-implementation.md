# COORDINATOR-AUTOMATION-S2: Scheduled Advisory Intelligence and the Persistent Operator Proposal Queue

> **Merged (dated annotation, 28 November 2026):** merged to `main` as #191 on 27 November 2026 (`2f730eb68`), then hardened by #195. The status line below is the original.

Status: implemented on branch `feat/coordinator-automation-s2` (draft PR against `main`). Builds on S0 ([design](coordinator-automation.md)), S1 ([implementation](coordinator-automation-s1-implementation.md)) and M1 ([implementation](coordinator-model-pool-m1-implementation.md)).

S2 lets the Coordinator decide, deterministically, when a reasoning turn is warranted, run that turn through the existing M0/M1 briefing path against one eligible local model, record a durable provenance-bearing briefing, and optionally record one untrusted proposal for the operator. It adds advisory cognition, not operational authority: nothing in S2 can dispatch a harness, claim a route, touch a worktree or candidate, complete a task, merge, or retry an operational outcome.

## 1. What shipped

| Layer | File | Contents |
| :--- | :--- | :--- |
| Protocol | `protocol/develop-advisory.ts` | Ten closed, versioned record schemas, the two action kinds, wake policies, the proposal vocabulary and every S2 limit (`ENDO_ADVISORY_LIMITS_V0`). |
| Pure runtime | `runtime/contracts/develop-advisory.ts` | Fire keys, the semantic digest, the wake gate, authorization identity and standing, effective-pool narrowing, budget accounting, the proposal-line parser and deterministic grounding, proposal currency. No I/O, no clock. |
| Storage | `storage/develop-advisory.ts` | The advisory store under `<root>/develop/automation/advisory/`: bounded fail-closed reads, write-once records, atomic replaces, all mutations inside S1's `automation.lock.<n>`, bounded retention. |
| Adapter | `adapters/develop/advisory-tick.ts` | The advisory tick: claim, observe, admit, select, dispatch (linearization point), infer, re-observe, publish. |
| Operator | `adapters/develop/advisory-operator.ts` | Add/enable/disable/remove, authorize/revoke, proposal acknowledge/dismiss, and the bounded lock-free projection (`endo.advisory-projection.v0`) for F2. |
| CLI | `cli/advisory.ts` | `endo advisory <add|enable|disable|remove|authorize|revoke|tick|list|fires|briefings|proposals|ack|dismiss>`. |
| Tests | `tests/develop-advisory-s2.test.ts`, `tests/fixtures/s2-advisory-worker.ts` | 29 tests: S0-AT09, S0-AT10 and S2 matrix items 1-23 (map in section 11). |
| Simulation | `scripts/s2-simulate-24h.ts` | A reproducible simulated 24-hour workload (section 12). |

S1 changes are export-only: `readBoundedValidatedJsonSync` and `replaceJsonAtomicSync` in `storage/develop-automation.ts`, and five CLI helpers in `cli/scheduler.ts`. No S1 schema, record, lock, digest or behaviour changed. S1's `schedules.json` (`endo.develop-schedules.v0`) still admits only `observe-health` and `refresh-projection`, so an S1-only reader never sees an inference-bearing action and S1 schedules stay zero-token (test S2-1).

### Storage layout and schemas

```
<root>/develop/automation/advisory/
  schedules.json                    endo.develop-advisory-schedules.v0       atomic replace (temp + fsync + rename + dir fsync)
  authorizations.json               endo.develop-advisory-authorizations.v0  atomic replace
  lease.json                        endo.develop-automation-lease.v0         atomic replace; S1's lease schema, a SEPARATE advisory lease
  observations.json                 endo.develop-advisory-observations.v0    atomic replace; latest semantic digest per project
  fires/<key>.claimed.json          endo.develop-advisory-fire-claim.v0      write-once link(2)
  fires/<key>.outcome.json          endo.develop-advisory-fire-outcome.v0    write-once
  turns/<id>.admitted.json          endo.develop-advisory-turn-admission.v0  write-once: the budget reservation
  turns/<id>.dispatched.json        endo.develop-advisory-turn-dispatch.v0   write-once: the dispatch linearization record
  turns/<id>.briefing.json          endo.develop-advisory-briefing.v0        write-once: terminal turn record + accounting
  proposals/<id>.json               endo.develop-advisory-proposal.v0        write-once
  proposals/<id>.<state>.json       endo.develop-advisory-proposal-state.v0  write-once: acknowledged | dismissed
```

Compatibility strategy: S2 is a sibling namespace rather than a v1 of S1's ledger. Widening `endo.develop-schedules.v0` to carry inference-bearing actions would silently change what an S1 binary admits; a separate directory keeps S1's closed schema exact and lets a pre-S2 binary ignore S2 entirely. Every S2 schema is closed (unknown keys, missing keys and out-of-range values are refused) and versioned through `protocol/versioned.ts`.

## 2. Trust boundaries

1. **Operator and Endophasia.** Only explicit CLI acts create schedules, enable them, grant or revoke authorizations, and decide proposals. No model output, OpenClaw state or provider response can create or modify a schedule, a grant or a budget.
2. **Endophasia and the model substrate.** The only inference path is the existing M0 briefing (`runOpenClawCoordinatorV0` via `briefFromCoordinatorSubstrateV0`): the sandboxed OpenClaw agent and the bounded relay (one route, one model, two exchanges, `endophasia_status` only, exact wire gates). S2 fixes the target to the one selected member with a host deadline. There is no second inference path.
3. **Model output and durable state.** A briefing answer is stored with `standing: "untrusted-model-interpretation"`. A proposal can only be one of six closed kinds about a task id that exists in the deterministic projection of the same project, and its evidence facts come from the projections, never from model text.
4. **Endophasia and governed state.** S2 reads tasks, coordination, receipts and events lock-free and writes only under `develop/automation/advisory/`. Test S0-AT10 compares every byte outside that directory before and after a proposal-producing turn and an acknowledgement.
5. **Loopback is not identity** (M1 residual, section 9).

## 3. Reconciliation with earlier design assumptions

| Earlier assumption | Evidence in the merged code | S2 decision |
| :--- | :--- | :--- |
| S0 section 4 / S1 section 12: gate S2 on `statusSha256` + `coordinationSha256` changes (S0-AT09). | Both hash whole projections including `readAtMs`, per-source `freshness.observedAtMs`/`ageMs`, event counts and last-event times; they change on every read. | Left untouched (integrity semantics unchanged). Added a separate allow-listed `endo.coordinator-semantic-digest.v0` (section 4). S0-AT09 is satisfied against the semantic digest. |
| S0 Appendix A: `/slots?fail_on_no_slot=1` is a passive capacity probe. | M1 established it wakes a single server and makes a router load a model. | S2 uses only M1's probe (`/health`, `/props`, and `/models` only on a single server). Unknown capacity and unconfirmed router residency are the normal case and need explicit grant policy (section 5). |
| S0: `interval` is relative to the last completed fire. | S1 anchors `anchorMs + k*everyMs`. | S2 reuses S1's evaluator unchanged. |
| S0: event-driven triggers and `endo schedule trigger`. | Not implemented in S1. | Not implemented in S2. The semantic wake gate provides change-driven reasoning on top of time triggers; a manual trigger is a `once` schedule. |
| S0: `coalesce-once` only for read-only/digest jobs; never auto-catch-up for anything that proposes. | S1 implements both policies. | Both allowed for both S2 actions: `coalesce-once` runs at most one *current* window and never replays a missed one; proposals grant nothing. |
| S1: a crashed claim stays `claimed-incomplete`. | S1 leaves it. | S2 closes an abandoned advisory claim with a typed `failed` outcome stating whether dispatch may have occurred; the uncertainty and its charge stay on the turn ledger. Nothing is replayed. |
| S1 handoff: pass `createRecordedCoordinatorModelObserverV0` into `selectCoordinatorModelV0`. | Seam exists. | Used as specified; the live-probe fallback is attached only when the grant's policy is `recorded-or-passive-probe`. |

## 4. Deterministic wake gating

`endoAdvisorySemanticStateV0(projectId, status, coordination)` projects ONE project's state through an allow-list and hashes it with canonical JSON.

- **Included:** source states (tasks/attempts/events), project HEAD, each task's status, revision, attempt count and latest attempt state, verification state/results/completeness, gap codes, linked sessions, association; sessions' recorded state, open-run presence, last outcome; attention items and findings by kind/code/subject; coordination assignments (state, revision, participant, role, harness family, binding, session key and instance status, workspace, hazard, target candidate, attempts, findings), dependencies, candidates, conflicts, registered worktree observations and reviews.
- **Excluded by construction:** every read time, freshness timestamp and age, event counts and activity lists, last-event times, review `recordedAtMs`, unlisted-session counts (another project's activity), and the time-driven finding `session-recorded-open-but-stale` and attention kind `evidence-stale`. A field added to a projection later stays excluded until deliberately added: a missed wake is recoverable through a digest window, a spurious wake costs inference.
- **Completeness:** `unavailable` (project unknown, tasks missing or unreadable) yields no digest and never reasons. `partial` (any source partial or unavailable, coordination unreadable or gapped) reasons only when the grant permits partial observations; gaps are recorded. A store with no event log reads `status-events-unavailable`, so it is `partial`.

Scope: per project; two schedules on two projects never wake each other (S2-21). Authorization revisions and pool changes are not in the digest; grant standing enforces them (section 5), so a pool change neither wakes a schedule nor inherits a grant.

| Policy | Unchanged since last considered | Unchanged since last attempted (not published as current) | Changed or first |
| :--- | :--- | :--- | :--- |
| `on-change` | `skipped-unchanged` | `skipped-already-attempted` | admit (`state-changed` / `first-observation`) |
| `digest-window` | admit (`digest-window`) | admit | admit |

`lastAttemptedSemanticDigest` is set at admission, before dispatch, and never cleared by a failure, so a failed, refused, withheld or crashed turn is never represented as considered and is never re-run for the same state automatically. Only a published `current-at-publication` briefing sets `lastConsideredSemanticDigest`. A wake reason is necessary but never sufficient: authorization, model eligibility, the uncertainty policy and the budget are checked independently.

## 5. Authorization, model policy and budgets

**Disabled by default.** `advisory add` creates a disabled, unauthorized schedule. Enabling bumps the revision. A grant must name the exact current revision of an enabled schedule and binds the schedule id and revision, project, action kind, the full pool content and its `poolSha256`, the uncertainty policy, the budget and a validity window (1 minute to 30 days). `authorizationId` is the digest of all of these, so any change is a different authorization. Standing is re-evaluated at admission, at the dispatch linearization point and at publication; it fails if the stored pool no longer hashes to its digest, if the revision, project or action differ, or if the grant is revoked, expired or not yet valid. Disabling, revising or removing a schedule supersedes its grant; re-enabling never inherits it (S2-2).

Each schedule also has a random incarnation identity bound into grants and fire claims. Reusing a removed schedule id cannot inherit a grant or an in-flight claim, even if its revision matches. Removal revokes first and refuses if its consumed-window floor cannot be retained; floors are never silently evicted.

**Effective pool.** The grant's pool narrowed, never widened: hosted members removed, members whose `maxOutputTokens` exceed the grant's per-request ceiling removed, and `unconfirmedModel` is `permit` only if both the pool and the grant permit it. With `fallback: none`, only the original first ordered member is eligible; excluding it refuses selection rather than promoting another member.

**Uncertainty policy** (each defaults to the strict value): `permitCapacityUnknown` (every M1 llama.cpp observation is capacity-unknown or model-unconfirmed), `permitModelUnconfirmed` (router members), `permitPartialObservation`, `observationSource` (`recorded-only` uses only fresh S1 recorded observations for the same `poolSha256` and sends nothing; `recorded-or-passive-probe` falls back to M1's passive probe), and `recordedObservationMaxAgeMs` (1 s to 1 h).

**Budgets and units** (per schedule, over a rolling `periodMs` of 1 h to 7 d):

| Ceiling | Unit | Bound | Enforcement |
| :--- | :--- | :--- | :--- |
| `maxTurnsPerPeriod` | advisory turns | 1-96 | Admission refuses when charged turns + 1 exceed it. |
| `completionRequestsPerTurn` | completion requests | fixed at 2 | The relay's `maxExchanges: 2`; fixed because one briefing is exactly a tool call plus an answer. |
| `maxOutputTokensPerRequest` | generated tokens per completion request | 256-2048 | Members above it are not eligible; the relay's `max_tokens` gate enforces the member's bound. |
| `maxGeneratedTokensPerPeriod` | generated tokens per period | at least one full turn reservation, at most 393216 | Admission refuses when charged + the next reservation exceed it. |
| `maxTurnWallClockMs` | ms from admission to inference deadline | 10-240 s | The turn deadline is `min(admission + ceiling, leaseExpiry - 20 s)`; the member's timeout is cut to it and host-enforced. |
| Concurrency | advisory turns in flight | 1 per store | One advisory lease; one claim per tick, given to the due schedule served least recently, so an unauthorized or refused schedule cannot starve another (R12). |

**Reservation and accounting.** The reservation (`2 x maxOutputTokensPerRequest` tokens, 2 requests, the wall-clock ceiling) is written in the write-once admission record before any model contact, under the same lock that computed the remaining allowance from the durable turn ledger, so concurrent processes cannot admit against the same allowance (S2-11). Consumption is recomputed from the ledger, never from a counter, so it survives restarts (S2-10). A turn is charged: refused before dispatch, 0; settled after dispatch, the relay-admitted requests and the reported completion tokens only when every admitted exchange reported usage, otherwise the full reservation (missing usage is never zero); dispatch record without a terminal record, **uncertain**, the full reservation for its whole period, never released and never retried; admitted, never dispatched and its lease gone, 0. Reported usage, the reservation and the charge are recorded separately on every briefing.

## 6. Crash-honest execution

### Lifecycle and the linearization point

```mermaid
sequenceDiagram
  participant T as advisory tick
  participant S as advisory store (automation.lock)
  participant M as model (one member)
  T->>S: A claim: lease epoch e, fire claim (write-once)
  T->>T: B observe projections (no lock), semantic digest
  T->>S: C admit: fence lease and schedule, wake gate, grant, budget, admission record (reservation)
  T->>T: D select member (zero tokens, no lock)
  T->>S: E LINEARIZATION: re-check lease epoch, schedule revision, grant id, window, dispatch record
  T->>M: F briefing (at most 2 completion requests, host deadline)
  T->>T: G re-observe (no lock), publication digest
  T->>S: H publish: re-check lease, schedule, grant; proposal, briefing, fire outcome, cursor, release lease
```

No lock is held across any await, model request, probe or status read: `withAdvisoryLockSync` takes a synchronous callback. The only lock is S1's `automation.lock.<n>`, never nested and never combined with `tasks.lock`, `coordination.lock` or `events/session-attachment.lock`. S2-20 writes the event store under `session-attachment.lock` and mutates `tasks.json` from inside the model call to prove neither is blocked.

**Linearization point:** the successful link(2) of `turns/<id>.dispatched.json` in phase E. No completion request is sent before it: the runner is invoked only after it returns `created`, and it is linked only while, under the lock, the advisory lease is this holder's live epoch, the schedule is at the admitted revision and enabled, grant standing is the admitted `authorizationId`, and at least 5 s of the turn window remains.

### What revocation can and cannot stop

- Revoked, expired, disabled or revised **before** the dispatch record: the turn is `not-dispatched` (`refused-unauthorized` / `cancelled-schedule-changed`), zero requests, zero charge (S2-15).
- **After** the dispatch record: S2 cannot recall a request already sent and does not abort on revocation. The call still ends at the host deadline. At publication the grant, schedule and lease are re-checked; if any changed, the result is `withheld` (answer not stored, no proposal, not considered) and the turn is charged as dispatched (S2-15). Revocation therefore stops publication immediately and dispatch of every later turn, but not tokens already in flight.

### Crash boundaries (what a concurrent observer can see)

| Process dies | Durable state an observer sees | Recovery (next tick after the lease expires) | Charge | Re-run? |
| :--- | :--- | :--- | :--- | :--- |
| after the claim, before admission | claim, no outcome; window consumed in the cursor | outcome `failed`, `inferenceDispatched: "no"` | 0 | No (window consumed) |
| after admission, before the dispatch record | + admission; `lastAttemptedSemanticDigest` set | `failed`, `"no"`; turn `never-dispatched` | 0 once the lease is gone | No (same state gives `skipped-already-attempted`) |
| after the dispatch record, before or during streaming | + dispatch record | `failed`, `"yes"`, "abandoned after dispatch" | full reservation, uncertain | Never |
| after a valid result, before publication | as above (the result is lost) | as above | full reservation, uncertain | Never |
| during proposal publication (proposal linked, briefing not) | + a proposal without its briefing (untrusted, bounded, visible) | `failed`, `"yes"` | full reservation, uncertain | Never |
| after the briefing, before the fire outcome | + briefing | outcome derived from the briefing | as settled | Never (S2-12d) |
| after the outcome, before lease release | everything terminal; lease unreleased | next tick waits for expiry (at most 300 s) | as settled | n/a |

**Indeterminate ledgers refuse.** Admission refuses whenever the turn listing reports any problem: an unreadable or mismatched record (its turn id, lease epoch, holder, authorization or revision differs from its admission), a missing admission, or a budget compaction floor later than the current clock. An I/O error is not proof that inference never ran, so it is never counted as zero; the operator projection shows the budget as unknown (`null`) in the same cases (R02, R10).

A superseded holder (its lease expired and a newer epoch exists) that reaches publication records its briefing as `withheld: lease-lost-in-flight`, writes no proposal, does not advance the cursor, and cannot overwrite the newer holder's `failed` outcome (write-once): S2-14, S2-15. S2 does not provide exactly-once inference. It provides at-most-once dispatch per fire claim, at-most-once publication per turn, and never an automatic replay of a possibly dispatched turn.

### Leases and deadlines

The advisory lease is fixed at S1's maximum TTL, 300 s; it is never extended. Lease and turn age are also measured on a monotonic clock from phase A and from admission, and rechecked at dispatch and at publication, so a paused process or a backward wall-clock step cannot keep a lease alive past 300 real seconds; publication after the turn deadline is withheld as `turn-deadline-exceeded` (R04). The turn deadline is at most `leaseExpiry - 20 s` and at most `admission + maxTurnWallClockMs` (240 s or less); the member timeout is cut to it and enforced on the host, and a result arriving after it is `inference-timeout`. A turn that cannot fit 5 s of inference is `refused-insufficient-lease`. Because a tick runs at most one turn while holding the lease, the advisory default on-time grace is two leases (600 s), so a co-due schedule is still on time at the next tick for any cadence up to 5 minutes; S1's evaluator caps grace at `period - 1`.

### Process crash versus power loss

Every record is fsynced before it becomes visible (write-once: temp, fsync, link, directory fsync; replace: temp, fsync, rename, directory fsync). The advisory store fsyncs a record's directory and its ancestors up to the store root itself, and a post-link directory fsync failure is reported as `commit-uncertain`, never `created`; dispatch proceeds only on `created`, so a dispatch record is known durable before any request is sent (R05). The shared S1 write-once helper is unchanged. After a **process crash**, every linked or renamed record is durable and complete and the table above holds exactly. After **sudden power loss**, the guarantee depends on the filesystem honouring fsync (ext4 `data=ordered`, btrfs default): a record whose directory fsync completed survives; one whose link completed but whose directory fsync did not may be absent after reboot. The ordering that matters holds: the admission is fsynced before the dispatch record is created, and the dispatch record (including its directory fsync) completes before the runner starts, so power loss can erase a dispatch record only before any request was sent. A `schedules.json` cursor update can be lost after its claim was linked; the claim still exists, and the pre-claim check stops a missed-window record from contradicting it.

## 7. Briefings

Each turn's terminal record holds: schedule id, revision and fire key; project; wake reason; lease epoch and holder; admission and publication times; authorization, pool, effective-pool, policy and budget digests; prompt identity (instruction digest, fixed proposal-question digest, the runner's prompt digest); source (admission semantic digest, observation time, completeness and gaps, the evidence digests the status tool actually delivered, the publication digest and `currency`: `current-at-publication`, `stale-at-publication` or `unknown-at-publication`); model (harness, provider label, the model the runtime *reported*, selected member, endpoint, readiness, `capacityConfirmed`, fallback and skipped members, `inferenceFailover: "never"`); accounting (section 5); availability (`available`, `unavailable`, `not-dispatched`, `withheld`), refusal code, the answer (at most 4096 bytes), and `standing: "untrusted-model-interpretation"`.

The answer passes the existing M0/M1 gates unchanged (tool surface, grounding to a delivered status read, refusal of unsupported absence claims, generation limit, model-identity pinning), `briefFromCoordinatorSubstrateV0`'s re-validation, and an S2 check that the reported model equals the selected member and arrived before the deadline. A briefing that went stale during inference keeps its admission digest and is marked `stale-at-publication`; it is never recorded as having considered the current state (S2-16).

## 8. The proposal queue

An `emit-operator-proposal` turn adds one fixed operator question (part of the prompt identity) asking the model to end with exactly `PROPOSAL: none` or `PROPOSAL: <kind> <taskId>`. Kinds: `review-failing-verification`, `review-awaiting-review`, `investigate-incomplete-verification`, `resolve-blocked-task`, `investigate-liveness-hazard`, `consider-attempt-for-assignment`.

- **Parsing** is strict: exactly one `PROPOSAL:` line, the last non-empty line, exact grammar, a valid task-id pattern. A second (for example injected) line or any trailing token makes it `proposal-unparseable` (S2-17).
- **Grounding** is deterministic: the task must exist in the same project's projection (cross-project ids are `proposal-subject-unknown`) and the named state must hold now (`resolve-blocked-task` needs `status: blocked`; `consider-attempt-for-assignment` needs an `active` assignment). Evidence facts come from the projection; uncertainties are the task's gap codes plus observation gaps.
- **Currency** reuses E1's evidence-bound clearance idea: a proposal binds the semantic digest it was grounded on and is created only if the publication digest equals the admission digest. The model is fed the pinned status projection that the admission digest was computed from (the runner no longer takes an independent third read), and a briefing is `current-at-publication` only if the runner's reported `projectionSha256` equals that pinned projection's digest and the publication re-observation is unchanged; otherwise it is `unknown-at-publication` or `stale-at-publication` (R08). Currency means "as of the publication observation", not as of a later read. The publication observation is persisted under the lease fence, so in the projection a proposal is `current` while its digest is the latest observed for its project, `stale` (still listed) otherwise, and `unknown` if the latest observation is unavailable (R09). A publication whose observation cannot be committed is withheld as `publication-observation-not-committed`.
- **Deduplication and retention:** `proposalId = H(dedupKey, semanticDigest)` with `dedupKey = H(project, kind, task, assignment)`. The same recommendation on the same evidence is `deduplicated`; on new evidence it is a new record that supersedes the old one. At most 16 pending proposals per project (`proposal-queue-full`). Retention keeps every pending proposal and removes the oldest decided or superseded ones beyond 256; fire pairs beyond 256 terminal ones; dispatched settled turns only beyond the newest 512 and older than 7 days, never-dispatched ones (charged nothing) beyond the newest 512 at any age. Proposal standing comes from the grounding order (section 9a, D1 and D2), so retention never removes the current undecided proposal for a key. Unresolved claims and unsettled turns are never removed.
- **Authority:** every proposal carries `standing: "untrusted-advisory-proposal"` and `authority: { grants: "none", executionAuthority: false, requiresOperatorConfirmationPerAttempt: true }`. `ack` and `dismiss` write one write-once record with `affects: "advisory-queue-only"`. S0-AT10 proves no `.route.json`, no harness call, and no byte outside the advisory directory changes.

## 9. Residual limitations (not resolved by S2)

- **Listener identity (M1 D1).** Loopback constrains the destination, not what answers there. A replaced or lying local listener inherits the pool's provenance. `reportedModel` is what the runtime reported; the provenance record does not attest which server process or weights produced the output. Deferred to M2.
- **Cold-load after selection.** `unconfirmedModel: refuse` cannot prevent a router from loading a model after selection; the selection observation necessarily precedes the request.
- **In-flight revocation** stops publication, not tokens already sent (section 6).
- **Same-UID threat model.** As in S1, cooperative locks and write-once files assume non-adversarial same-UID processes.
- **Per-project wake gating.** A change in project A never wakes a schedule for B; a cross-project digest needs one schedule per project.
- **No proposal-to-governance bridge.** Acting on a proposal is entirely the operator's existing per-attempt path; F2 owns the Studio inbox.

## 9a. Independent review and remediation

Reviewer: a separate read-only subagent on `openai/gpt-6.2-astra` (high reasoning), run on the operator's workstation against a `git archive` copy of `3db533d9a` with scratch HOME/TMPDIR. Independence limits: it was commissioned and briefed by the implementing thread, saw the implementer's description of the design, and ran on the same machine; it had no contact with any model server. It reported 12 findings and wrote reproductions for five of them. All 12 were accepted and fixed. Each has a regression test in `tests/develop-advisory-s2.test.ts`, and all 12 tests fail when run against `3db533d9a`.

| Finding | Severity | Fix | Regression test |
| :--- | :--- | :--- | :--- |
| R01 replacement schedule inherits a grant or claim | high | random per-add `incarnation` bound into grants, fire keys, claims and every cursor, admission, dispatch and publication check; removal revokes before deleting | R01 |
| R02 indeterminate ledger undercounts | high | any listing problem, including mismatched ids, refuses admission; projection budget `null` | R02 |
| R03 retired-cursor eviction allows replay | high | removal refuses (`too-many`) rather than evicting a floor | R03 |
| R04 no monotonic lease fence | high | monotonic age from A and C rechecked at E and H | R04 |
| R05 directory fsync failure read as durable | high | `commit-uncertain` write-once result; dispatch only on `created` | R05 |
| R06 fallback `none` became undisclosed fallback | high | only the first ordered member is a candidate; grant-excluded members reported as skipped | R06 |
| R07 missing sources read as complete | high | missing sources and unread-evidence findings are gaps | R07 |
| R08 model saw a third, unbound snapshot | medium | the runner takes the pinned admission projection; currency requires its digest | R08 |
| R09 queue currency ignored publication read | medium | publication observation persisted under the lease fence | R09 |
| R10 retention deadlock past 4096 names; clock rollback reopens periods | high | streaming retention scan; durable budget floor makes earlier clocks indeterminate | R10 |
| R11 failed claim link consumed the window | medium | non-`created`/`exists` claim fails the tick without consuming; cursor write failures fail closed before dispatch | R11 |
| R12 co-due starvation | medium | least-recently-served due schedule is claimed | R12 |

A second review by Codex at `15d8c69a2` (the operator marked the draft ready for review) raised three P2 findings. All three were fixed. Each regression asserts the observable effect, and C1, C2 and the first C3 test fail when run against `15d8c69a2` (C1: the listing reads `too-many`; C2: 256 of 301 pending proposals listed; C3: `head` is null). The second C3 test is an honesty guard and passes on both.

| Finding | Fix | Regression test |
| :--- | :--- | :--- |
| C1 the generic 4096-entry directory bound made the turn ledger unreadable at about 1,365 settled turns, so every admission refused | The turn ledger has its own bound, `maxTurnLedgerEntries`, derived from the ceilings: 3 records x (32 schedules x 96 turns x 168 one-hour periods in the 7-day window + 512 settled turns kept beyond it + 512 never-dispatched + 1 in flight) + 64. Past it, listing still fails closed. Retention may now prune never-dispatched turns at any age, because they are charged nothing, so the derivation holds. The retention scan sorts once instead of on every visit. | C1: 2,000 settled turns of another schedule at one per 5 minutes over ~6.9 days (6,000+ records). A fresh admission is dispatched; the schedule's spend is exactly 2 turns plus the reported tokens; the other schedule's 7-day spend is exactly 2,000 turns x the seed charge |
| C2 the projection clamped proposals at 256, so pending ones beyond that were unreachable | Every pending proposal is always listed; the limit applies only to decided and superseded ones. `proposalCounts` gives `retained`, `pending`, `listed`, `withheld` and a `withheldHint` naming the flag that reaches them, and the CLI prints the hint | C2: 301 pending and 20 dismissed proposals with `--limit 5`. All 301 are listed through the CLI, `withheld: 15` with its hint, the oldest is acknowledged through the CLI, and it then reads `acknowledged` |
| C3 nothing observed project HEAD, so every observation was partial and the pinned runner had no HEAD | `defaultObserveAdvisoryProjectV0` reads HEAD once with the same bounded observer the briefing status reader uses (`GitRevisionObserverV0` at /usr/bin/git, HOME unset, each Git call under `GIT_LIMITS_V0`, a non-plain or linked `.git` refused), and passes it to the status reader (`current`) and the coordination reader (`workspace`). The pinned admission observation therefore carries HEAD to the runner. An unreadable HEAD stays null and reads `project-head-unavailable` | C3: a real Git project with an event log and an attempts directory is `complete`, with no head gap. A grant without `permitPartialObservation` dispatches, and the runner's pinned status carries the commit. C3 (honesty): a non-Git project reads `head: null` and `partial` |

Residual for C1: admission reads the whole ledger, so its cost grows linearly with ledger size. At the C1 workload the S2 test file took 2.5 s. At the theoretical bound (about 1.5 M records) it would be slow but correct. The bound also assumes operators do not churn schedule ids within a week, because each new id gets a fresh per-schedule budget. A ledger past the bound refuses rather than undercounting.

A third review by Codex, at `e7c804a7c`, raised three more P2 findings. All three are fixed. Each regression test asserts the observable effect and fails when run against `e7c804a7c`:
- C4: the project the tick just observed is missing from the observation history.
- C5: renewal 88 fails with `storage-failed`.
- C6: the pending proposal reads `stale`.

| Finding | Fix | Regression test |
| :--- | :--- | :--- |
| C4 trimming the 64-project observation history kept a fixed lexicographic prefix, so it could discard the project just observed, and a proposal published as current then read `unknown` | The just-observed project is always kept. The bound evicts other projects in this order: first those no schedule names, then the least recently observed. After writing, the tick reads the record back and confirms it holds this observation for this lease epoch. Otherwise admission records `failed`, or publication is withheld as `publication-observation-not-committed`. It is never a publication with unknown currency | C4: 64 other projects that all sort before ours are already observed. The tick publishes `current-at-publication`, the history still holds 64 entries including ours, and the proposal reads `current` |
| C5 authorization history was bounded by count, not bytes. With 16-member pools a renewal failed `storage-failed` at grant 88, after the previous grant had already been revoked | Supersession and the replacement are one write, so a refused write leaves the old grant untouched. Oldest revoked grants are evicted until both the count and the serialized byte bound hold. If the live grants alone cannot fit, the operation refuses (`too-many`) and nothing is written. Recovery for a schedule an earlier build left unauthorized is `endo advisory authorize` again, which compacts the history | C5: 140 renewals of a 16-member grant all succeed, each leaving the schedule authorized, with the file at or under 512 KiB and one live grant. Revoke followed by authorize recovers |
| C6 when HEAD returned A -> B -> A, the original proposal for A was reused but stayed `superseded`, because pending was decided by `generatedAtMs` alone, and B's stale proposal stayed pending | Supersession is ordered by when a proposal was last grounded on its own evidence: its creation, or any later published briefing that re-derived exactly that proposal (outcome `created` or `deduplicated`, read from the turn ledger). The projection and the tick's pending-queue cap use the same rule | C6: a real Git project goes A -> B -> A with the blocked task unchanged. Outcomes are created, created, deduplicated. The proposal for A is the only pending one and reads `current`, and B's reads `superseded` and `stale` |

The C6 residual (ordering read from briefings that retention may prune) is closed by D1 and D2 below. Two corners remain, and neither is silent:
- If writing the grounding index fails while a proposal is being re-derived, the briefing's proposal link is recorded as refused (`storage-failed`), and the proposal keeps its previous rank.
- If `proposal-grounding.json` is unreadable, the proposal listing reports it as a problem and orders by creation time until it is rewritten.

A fourth Codex pass, at `0ea04cc36`, found that C6 still had one root cause: a proposal's standing depended on a turn record that expires. That produced two findings, both fixed by one change, and both regression tests fail when run against `0ea04cc36`:
- D1: proposal A reads as superseded instead of pending.
- D2: proposal A is deleted.

| Finding | Fix | Regression test |
| :--- | :--- | :--- |
| D1 once retention removed the only briefing recording that A was re-grounded (A -> B -> A), the projection fell back to creation times, hid current A as superseded, and made stale B pending again | A proposal's grounding rank is stored with the proposal store, not with turns. Proposal records stay write-once (their content never changes after link), so the rank lives in `proposal-grounding.json`, a lock-protected index from proposal id to the time the proposal was last re-derived from a published briefing. It holds entries only for retained proposals. A tick that re-derives an existing proposal records it there before reporting `deduplicated`. `listProposals` exposes `groundedAtMs` (the later of creation and the indexed re-derivation) and orders by it, and supersession, the pending projection, the pending-queue cap and retention all read that one order | D1: A -> B -> A, then 512 newer settled turns and retention 8 days later. The re-deriving briefing is gone, both proposals survive, A is pending and `current`, and B is superseded and `stale` |
| D2 retention chose what to keep by creation time, so past 256 retained proposals it deleted the current undecided A and kept stale B pending | Retention uses the same grounding order: only decided proposals, or proposals that are not the most recently grounded for their key, can be removed, oldest first. The current undecided proposal for a key is never removed. If the bound cannot be met without one, the store stays above the bound, and the projection's `proposalCounts.retained` shows it | D2: A -> B -> A plus 255 other pending proposals (257 retained). Retention removes exactly one, which is B; A survives as pending and `current` |

Follow-up policy for later reviews: further findings in the capacity, retention or visibility classes are recorded here as known follow-ups with their reproductions, not fixed under S2.


## 10. CLI

```
endo advisory add --id <id> --project <projectId> --action <generate-advisory-brief|emit-operator-proposal> --wake <on-change|digest-window>
                  (--once <iso> | --every <duration> [--anchor <iso>] | --calendar <spec> [--tz <iana>]) [--missed-run ...] [--label ...]
endo advisory enable|disable|remove --id <id> [--revision <n>]
endo advisory authorize --id <id> --revision <n> --pool <pool.json> --period <duration> --max-turns <n> --max-output-tokens <n>
                  --max-generated-tokens <n> --turn-timeout <seconds> --expires-in <duration>
                  [--observation recorded-only|recorded-or-passive-probe] [--observation-max-age <duration>]
                  [--permit-capacity-unknown] [--permit-model-unconfirmed] [--permit-partial-observation]
endo advisory revoke --id <id>
endo advisory tick                         # the only command that can contact a model
endo advisory list                         # schedules, effective authorization, budget standing, lease, turn states
endo advisory fires                        # why each fire ran or was skipped
endo advisory briefings                    # briefing history with provenance and accounting
endo advisory proposals [--all]            # pending (default) or all, with queue state and currency
endo advisory ack|dismiss --proposal <id> [--note <text>]
```

Every ceiling on `authorize` is required; there is no default budget. Reads are lock-free and bounded (`readEndoAdvisoryProjectionV0`). Nothing is installed: run `endo advisory tick` from a timer the operator owns (S1's `scheduler print-systemd-unit` shows the pattern) at a cadence of 5 minutes or less.

## 11. Acceptance tests and what each would catch

All in `tests/develop-advisory-s2.test.ts`. Each drives the real tick, stores and projections over a real project; the runner and member observer are counting fakes, so "zero inference" is the observed number of runner calls.

| Item | Test | Fails if |
| :--- | :--- | :--- |
| 1, 22 | S2-1, S2-22 | S2 touches S1's `schedules.json` or an S1 tick reports non-zero tokens. |
| 2 | S2-2 (x2) | A disabled, unauthorized, superseded or stale-revision grant reaches the runner or observer. |
| 3, 4, S0-AT09 | S2-5, S2-4 | Unchanged state or 72 h of clock movement causes a runner call; a status change does not. |
| 5 | S2-5 | A real change does not produce exactly one briefing. |
| 6 | S2-6 | A digest window does not reason on unchanged state, or exceeds the turn budget. |
| 7, 13 | S2-7 | An outage stops the scheduler, charges tokens, or the same state is retried automatically. |
| 8 | S2-8 | Unknown capacity is used without policy; `recorded-only` probes or infers without a recorded observation. |
| 9 | S2-9 | Fallback happens after dispatch, or a failed dispatched member is replaced. |
| 10 | S2-10 | Missing usage is charged as zero; the period ceiling is not enforced across tick invocations. |
| 11 | S2-11 (4 + 3 real processes) | More than one process admits a fire or exceeds a one-turn budget. |
| 12, 13 | S2-12 (x3), S2-12d, S2-18b | A crash or failure at a boundary replays inference, mischarges, or leaves a partial record. |
| 14 | S2-14, S2-15 | A superseded holder publishes as current or overwrites the newer outcome. |
| 15 | S2-15 (x2) | Revocation/disable before dispatch still dispatches, or after dispatch still publishes or proposes. |
| 16 | S2-16 | A state change during inference is published as current or yields a proposal. |
| 17 | S2-17 | Any of seven malformed, injected, ungrounded or cross-project answers creates a proposal. |
| 18 | S2-18, S2-18b, S2-18c | Duplicates multiply, supersession or staleness is hidden, or retention drops a pending proposal. |
| 19, S0-AT10 | S0-AT10 | Any byte outside the advisory directory changes, a `.route.json` appears, or an ack grants anything. |
| 20, S0-AT11 | S2-20 | An event write under `session-attachment.lock` or a task mutation blocks during inference. |
| 21 | S2-21 | One project's change wakes another project's schedule. |
| 23 | S2-23, `scripts/s2-simulate-24h.ts` | 24 h of idle ticks with three changes make more than four turns. |
| n/a | unsafe path, CLI | A symlinked advisory directory is followed; the CLI enables by default, authorizes without ceilings, or infers when nothing is due. |

## 12. Simulated 24-hour workload (simulated, not measured)

`node scripts/s2-simulate-24h.ts` runs 288 ticks at a 5-minute cadence over a real temporary store with two schedules (an `on-change` brief every 15 min and an `emit-operator-proposal` digest window every 6 h), five task status changes, a two-hour model outage, one injected crash after a dispatch record, and one turn whose usage is withheld. Runner and observer are deterministic fakes; nothing here measures a real model.

Output after the review remediation (simulated): 8 inference requests from 288 ticks; fire outcomes 8 `briefing-published`, 50 `skipped-unchanged`, 37 `skipped-already-attempted`, 3 `missed-skipped`, 1 `refused-model-unavailable` (outage, zero requests) and 1 `failed` (the injected crash after a dispatch record, recovered as dispatch-uncertain and charged its full reservation); 10 turns admitted, 9 dispatched, 8 briefings available, 1 not dispatched; 2 proposals created (one later superseded, both stale by the end) and 2 refused as ungrounded; per-schedule charges of 5 turns / 1824 tokens (1 uncertain) and 4 turns / 1624 tokens against ceilings of 12 turns / 8192 tokens. The long `skipped-already-attempted` run after the outage is the deliberate cost of never auto-replaying: the next real change, or a digest window, reasons again.

## 13. Operator smoke test (one real briefing against 127.0.0.1:8091)

Not run by the implementer: it needs the operator's separate authorization. It touches the Inkling server only with `GET /health` and `GET /props` before the single briefing, which sends at most two completion requests. It sends no restart, reconfiguration, load or unload commands; inference itself may cause the router to load a model, and passive checks cannot rule that out. Stop at any step whose check fails.

1. In the PR worktree: `npm ci && npx tsc --noEmit -p tsconfig.json`
2. `export R="$(mktemp -d)"` and confirm `XDG_RUNTIME_DIR` is set to a 0700 directory you own (the briefing sandbox requires it): `stat -c '%a %U' "$XDG_RUNTIME_DIR"`
3. `curl -sS --max-time 3 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8091/health` (expect `200`)
4. `curl -sS --max-time 3 http://127.0.0.1:8091/props | head -c 400; echo` (expect `"role":"router"` and a `build_info`)
5. Write the pool with the M0 model id (router residency cannot be confirmed passively, so `unconfirmedModel` must be `permit`):
   `printf '%s\n' '{"schemaVersion":"endo.coordinator-model-pool.v0","selection":{"fallback":"none","unconfirmedModel":"permit"},"members":[{"memberId":"inkling","kind":"local-openai-compat","endpoint":"http://127.0.0.1:8091","modelId":"Inkling-2-Mini-Uncensored-AD-Q4_K","priority":100,"maxPromptBytes":8192,"maxOutputTokens":2048,"timeoutMs":135000,"advisoryOnly":true}]}' > "$R/pool.json"`
6. `node cli/index.ts coordinator pool check --pool "$R/pool.json"` (expect member `inkling` `model-unconfirmed` and `inferenceTokens: 0`; on a router this sends only `/health` and `/props`)
7. `node cli/index.ts project add --root "$R" --name smoke --path "$R"` then `P=<the printed project id>`
8. `node cli/index.ts task add --root "$R" --project "$P" --title "S2 smoke"`
9. `node cli/index.ts advisory add --root "$R" --id smoke --project "$P" --action generate-advisory-brief --wake on-change --once "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)"` (revision 1, disabled)
10. `node cli/index.ts advisory enable --root "$R" --id smoke --revision 1` (revision 2)
11. `node cli/index.ts advisory authorize --root "$R" --id smoke --revision 2 --pool "$R/pool.json" --period 1h --max-turns 1 --max-output-tokens 2048 --max-generated-tokens 4096 --turn-timeout 180 --expires-in 1h --observation recorded-or-passive-probe --permit-capacity-unknown --permit-model-unconfirmed --permit-partial-observation`
12. After the `--once` time has passed (about a minute), run the single briefing: `node cli/index.ts advisory tick --root "$R"` (expect `smoke:briefing-published`, or `briefing-refused` with a refusal code; either is a valid smoke result, and `inference dispatched`)
13. Inspect: `node cli/index.ts advisory briefings --root "$R"`, `node cli/index.ts advisory fires --root "$R"`, `node cli/index.ts advisory list --root "$R"` (budget now 1 of 1 turns)
14. `node cli/index.ts advisory tick --root "$R"` (expect nothing due and `inference not dispatched`)
15. `node cli/index.ts advisory revoke --root "$R" --id smoke && rm -rf "$R"`

Record the briefing's `reportedModel`, `accounting` and `inferenceElapsedMs` as the first measured real-model figures, separately from section 12.

## 14. Deviations from the S0 design

- Semantic digest instead of `statusSha256`/`coordinationSha256` for wake gating (section 3).
- A separate advisory namespace and lease instead of new S1 action kinds (section 1).
- `completionRequestsPerTurn` fixed at the relay's 2 rather than operator-configurable.
- Abandoned advisory claims are closed with a typed `failed` outcome instead of staying `claimed-incomplete` (section 3).
- One advisory turn per tick, and a longer default on-time grace (600 s) than S1's 60 s (section 6).
- No event-driven triggers or manual trigger command (section 3).
