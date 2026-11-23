# DEVELOP-EVIDENCE-BRIDGE-001: read-only attempt-to-evidence bridge

*   **Status:** implemented on `feat/develop-evidence-bridge-001` (draft PR; read-only qualified read model + CLI `endo attempt bridge`).
*   **Builds on:** projects and tasks ([../develop-tasks.md](../develop-tasks.md)), attempt execution ([develop-attempt-execution.md](develop-attempt-execution.md)), attempt evidence ([develop-attempt-evidence.md](develop-attempt-evidence.md)), verification receipts ([develop-verification-receipts.md](develop-verification-receipts.md)), verification plans ([develop-verification-plans.md](develop-verification-plans.md)), working-tree provenance ([develop-candidate-provenance.md](develop-candidate-provenance.md)), multi-file staged change sets ([protected-staged-changeset.md](protected-staged-changeset.md)), and `DEVELOP-ACCEPTANCE-001` ([../../research/develop-acceptance-001/README.md](../../research/develop-acceptance-001/README.md)).
*   **Scope:** one read-only projection (`endo.develop-evidence-bridge.v0`) and CLI entrypoint (`endo attempt bridge`). No new event store, no coordinator, no second harness, no new write authority, no mutation of task status, no candidate checkout application, and no side-effect evaluator execution.

## 1. Transition audit: what existing records establish, and where the real gap is

Tracing identities across `Task -> Attempt -> Authorization -> Dispatch -> Run -> Candidate -> Evaluation/Receipt -> Operator decision` on `main`:

| Transition | Existing source records & validators | Epistemic standing | Exact join / limit |
| :--- | :--- | :--- | :--- |
| **Task -> Attempt** | `develop/tasks.json` (`DevelopTasksStoreV0`) + `develop/attempts/<id>.prepared.json` (`validateEndoDevelopAttemptV0`) | **Operator-declared** (unsigned local files) | Exact `projectId`, `taskId`, `task.revision` and frozen task words; drift detected via `endoDevelopTaskWordsChangedV0`. |
| **Attempt -> Authorization** | `<id>.authorized.json` (`validateEndoDevelopAttemptAuthorizationV0`) + `events/events.log` (`endoAttemptExecutionFindingV0`) | **Controller-observed** (unsigned local files) | Exact join on `attemptId`, recomputed `briefSha256`, `proposalId`, recomputed `proposalDigest`, `authorizationEventId` (`decision: "allow"`), `session`, `attachment`, `message`. Damaged/misnamed files fail closed (`EVIDENCE-INTEGRITY-001`). |
| **Authorization -> Dispatch** | `events/events.log`: `workbench.prompt-dispatched`, `workbench.prompt-accepted` / `workbench.prompt-refused` | **Controller-observed** dispatch; **Pi-reported** acceptance | Exact `derivedFrom` chain (`proposal -> authorization -> dispatch -> accepted|refused`). |
| **Dispatch -> Run** | `events/events.log`: `lifecycle.run-started` -> `lifecycle.run-completed|failed|aborted|unclassified|interrupted` | **Window-attributed** (controller-observed session/process window; **Pi-reported** completion/failure/abort; controller-observed `interrupted`/`process-ended`) | **No Pi run ID.** Attributed by log append order to the first run in the same session and Pi process instance after dispatch and before any later dispatch. |
| **Run -> Working-Tree State** | `develop/observations/<id>/*.json` (`DevelopObservationsServiceV0`, `endoAttemptProvenanceV0`) | **Controller-observed** (`before-send` / `after-run`) or **operator-declared** (`endo attempt observe`) | Workbench observations carry `binding: { proposalId, authorizationEventId }` matching `<id>.authorized.json`. Records Git blob IDs only — **not reconstructable candidate bytes** and **not authorship** (ignored files excluded; shared unsandboxed tree). |
| **Attempt -> Reconstructable Candidate** | Protected runs (`protected-run.v0..v3`, `record.json`, `baseline/` + `changeset/` or `submission/`) validated by `inspectProtectedExperimentV0` + `verifyStagedChangeSetV0` / `verifyFixedSubmissionV0` | **Unavailable across spaces** (internal to a protected run: controller-observed arrangement-C; across DEVELOP <-> protected run: **missing**) | **THE REAL GAP.** Neither DEVELOP attempt records (`endo.attempt.<32 hex>`) nor protected-run/staged-changeset records carry the other space's identity (`research/develop-acceptance-001/DESIGN.md`). |
| **Candidate -> Verification / Receipt** | **Ordinary:** `develop/receipts/<id>/*.json` (`DevelopReceiptsServiceV0`, `endoReceiptRelationV0`, `endoAcceptanceLedgerV0`). **Protected:** offline evaluator inside `protected-run` (`evaluation`, `evaluators` qualification). | **Ordinary:** controller-observed host check, **operator-declared** attempt link, freshness computed against reader's tree now. **Protected:** experimental, non-authoritative offline evaluator. | Ordinary receipts are compared with `after-run` observation via `provenance.checked` (`same` vs `different` Git content) and with `HEAD` now (`at-head` vs `head-differs` stale). Protected evaluation is never merged with ordinary receipts. |
| **Verification -> Operator Decision** | `develop/tasks.json` (`status`, `history`, `movedToDone`) | **Operator-declared** (status only) | Records status transitions and notes, **never** a commit hash or candidate digest (`operator-decision-revision-binding` absent). |

### The minimum missing relation (and why we do not fabricate it)

Existing records establish two genuinely verified islands:
1. **DEVELOP working-tree chain**: `Task -> Attempt -> Authorization -> Dispatch -> Run (window) -> Bound before/after Git observation -> Clean-HEAD ordinary receipt (+ optional plan ledger) -> Task status`.
2. **Protected-experiment chain**: `Operator spec pin (specSha256) -> Preflight & confirmed systemd scope termination -> Reconstructable staged candidate (baselineSha256 + changesetSha256 -> candidateSha256) or fixed-path submission -> Qualified offline evaluator -> Model relay recording`.

What is missing is **one cross-space binding record** linking a DEVELOP `endo.attempt.<32 hex>` to a protected-experiment trial (`specSha256`, `runId`, trial coordinates, `recordSha256`, and `candidateSha256` / `submissionSha256`).

Per the mission rules, this read-only bridge **never** invents that link from timestamps, prompt/objective text, filenames, or agent self-reports. When `--protected-run <dir> --spec-pin <sha256>` is passed to `endo attempt bridge`, the bridge independently re-verifies the protected run and its candidate bytes completely read-only, labels its scope as `experimental-non-authoritative` (`workstationH0: "blocked"`), and returns a **bounded negative association result**:
- `candidate.reconstructable.attemptAssociation = "unestablished"`
- `missingRecord = "develop-attempt-protected-candidate-binding"`
- finding `protected-attempt-association-unestablished`

### Smallest explicitly authorized way to capture the missing relation (proposal for a future PR)

Do not add a general event store or coordinator. In a future PR that adds explicit write/dispatch authority for running a prepared attempt inside a protected runner, capture **one write-once record** beside `<attemptId>.prepared.json` in `<root>/develop/attempts/<attemptId>.candidate.json` (`endo.develop-attempt-candidate-binding.v0`):

```json
{
  "schemaVersion": "endo.develop-attempt-candidate-binding.v0",
  "attemptId": "endo.attempt.<32 hex>",
  "briefSha256": "<64 hex>",
  "recordedAtMs": 0,
  "boundBy": "controller | operator",
  "via": "protected-attempt-dispatch | cli",
  "target": {
    "kind": "protected-experiment",
    "runId": "<spec.id>",
    "specSha256": "<64 hex>",
    "trial": { "position": 0, "task": "<id>", "condition": "<id>", "trial": 0, "attempt": 1 },
    "recordSha256": "<64 hex>",
    "candidate": {
      "mode": "staged-changeset",
      "baselineSha256": "<64 hex>",
      "changesetSha256": "<64 hex>",
      "candidateSha256": "<64 hex>"
    }
  }
}
```

*   `boundBy: "controller"` is written only by a future explicitly terminal-authorized protected-attempt launcher that itself constructs the spec from the prepared attempt's `briefSha256`, runs the sandbox, confirms termination, and seals the binding.
*   `boundBy: "operator"` (if an explicit CLI bind is ever desired) carries strictly weaker standing (`operator-declared`), never upgraded to controller-observed provenance.
*   On read, the bridge would require every digest (`briefSha256`, `specSha256`, `recordSha256`, `baselineSha256`, `changesetSha256`, `candidateSha256`) to match the independently re-verified protected-run files on disk before reporting `attemptAssociation: "established"`.

## 2. What is newly established vs `endo attempt evidence` and PR #159

| Capability | `endo attempt evidence` (`v3`) | PR #159 (`research/develop-acceptance-001/report.ts`) | `endo attempt bridge` (`DEVELOP-EVIDENCE-BRIDGE-001`) |
| :--- | :--- | :--- | :--- |
| Reads DEVELOP task, attempt, auth, dispatch, run, receipts & plan ledger | Yes | No | **Yes** (reuses `endoAttemptEvidenceV0`) |
| Integrates `develop/observations/` working-tree provenance & compares `after-run` with checked commits in one shared Git snapshot | No (`candidate.recorded: false` only) | No | **Yes** (one shared `observationsService.take` feeds both provenance and receipt freshness; flags `checked-commit-differs-from-observed-run-end` and `working-tree-changed-since-observation`) |
| Explicitly audits every transition (`Task -> ... -> Operator decision`) with epistemic basis & missing record | No | No | **Yes** (8 closed transitions) |
| Distinguishes Pi-reported run endings from controller-observed `interrupted`/`process-ended` | Partial (`pi.source`) | N/A | **Yes** (`piReport.runSource: "pi-reported" | "controller-observed"`) |
| Supports multi-file staged-changeset protected runs (`v2`/`v3`) AND fixed-path (`v0`/`v1`) completely read-only (zero temp files) | No | Fixed-path `count.mjs` only (wrote temp copy via `exportSubmissionV0`) | **Yes** (reuses `inspectProtectedExperimentV0` + new read-only in-memory `verifyFixedSubmissionV0`) |
| Distinguishes ordinary host receipts from experimental protected-experiment evaluation | No | Protected only | **Yes** (separate sections, explicit trust boundary) |
| Separates verified observations from advisory review outcome | No (gaps only) | Yes (`recommendation` for single fixture) | **Yes** (`review.kind: "advisory-suggestion-not-authority"`, `decisionAuthority: "operator-only"`) |
| Refuses cross-space heuristic linking with explicit missing-record diagnosis | N/A | Noted in prose only | **Yes** (tested bounded negative result) |

## 3. Trust boundary

*   **Workstation protected verifier H0 remains `BLOCKED`.**
*   The guest verifier experiments (PRs #160–162) demonstrated a guest boundary, not a production trust boundary on the operator's host.
*   No experimental protected-run result is ever classified as an authoritative protected `PASS`. Every bridge output carries `trustBoundary.workstationH0 = "blocked"` and `protectedExperimentAuthority = "experimental-non-authoritative"`.
*   DEVELOP records are unsigned local files under `<root>/develop/`; a same-uid host writer can alter them.
*   Reading the bridge is strictly read-only: zero files created or modified (verified by recursive directory manifests in tests), zero status changes, zero candidate bytes applied to any checkout, zero evaluator or agent processes spawned.

## 4. Implementation layout

*   [`protocol/develop-evidence-bridge.ts`](../../protocol/develop-evidence-bridge.ts) — pure schema, closed transition/finding/suggestion vocabularies, fixed trust boundary (zero Node imports).
*   [`runtime/contracts/develop-evidence-bridge.ts`](../../runtime/contracts/develop-evidence-bridge.ts) — pure `endoDevelopEvidenceBridgeV0` projection + `renderEndoDevelopEvidenceBridgeV0` operator text renderer (zero adapter imports).
*   [`adapters/sandbox/submission.ts`](../../adapters/sandbox/submission.ts) — adds read-only in-memory `verifyFixedSubmissionV0` (zero temp dirs/files).
*   [`adapters/develop/evidence-bridge.ts`](../../adapters/develop/evidence-bridge.ts) — read-only adapter wiring DEVELOP stores/services + `inspectProtectedExperimentV0` + `verifyFixedSubmissionV0`.
*   [`cli/develop-attempts.ts`](../../cli/develop-attempts.ts), [`cli/help.ts`](../../cli/help.ts), [`cli/index.ts`](../../cli/index.ts) — `endo attempt bridge` subcommand.
*   [`tests/develop-evidence-bridge.test.ts`](../../tests/develop-evidence-bridge.test.ts) — positive case, all 8 negative cases, and CLI side-effect-free manifest test.

Studio UI exposure is intentionally deferred to a later PR so Studio can consume this exact read model without inventing a second evidence model.

## 5. Example operator-facing output

```text
$ endo attempt bridge --root /tmp/store --attempt endo.attempt.0123... --cwd /tmp/repo

evidence-bridge endo.attempt.0123... (task endo.task.abcd..., project endo.project.ef01...)
  objective [operator-declared] Fix calc.mjs so it adds the two arguments instead of subtracting
  trust     [boundary] workstation H0=blocked; develop=unsigned-local-records; protected-experiment=experimental-non-authoritative
  chain:
    Task -> Attempt                      [established; operator-declared] Prepared record endo.attempt.0123... explicitly names project endo.project.ef01... and task endo.task.abcd... (frozen task words match current revision 2).
    Attempt -> Authorization             [established; controller-observed] Exact join: endo.attempt.0123....authorized.json -> workbench.prompt-proposed (endo.evidence.workbench-prompt-0123..., digest recomputed) -> workbench.prompt-authorized (endo.event.2222..., allow); briefSha256 matches.
    Authorization -> Dispatch            [established; controller-observed] Controller recorded workbench.prompt-dispatched derived from endo.event.2222...; Pi replied started (acknowledgment only, not completion).
    Dispatch -> Run                      [established; window-attributed] Bounded log-order window in session endo.session.pi.1111... (Pi reports no run ID): Pi reported the run completed. Not verified [Pi-reported]. (missing: pi-native-run-id)
    Run -> Observed Working-Tree State   [established; controller-observed] Controller observations (send-and-run, end=endo.observation....) bound to exact proposalId/authorizationEventId. Records Git blob hashes only — not reconstructable candidate bytes and not authorship.
    Attempt -> Reconstructable Candidate [unestablished; missing] No existing DEVELOP record names a reconstructable staged change set or protected-experiment candidate, and no protected run was supplied. (missing: develop-attempt-protected-candidate-binding)
    Candidate -> Verification / Receipt  [established; controller-observed] Ordinary receipts pass at clean HEAD b2e755585fb9, whose Git tree content equals the bound run-end observation (ignored files excluded; receipt-to-attempt link is operator-declared).
    Verification -> Operator Decision    [unestablished; operator-declared] Task status is review (operator decision pending; this reader never changes task status).
  execution:
    auth      [controller-observed] record=recorded proposal=endo.evidence.workbench-prompt-0123... brief=matches
    dispatch  [controller-observed] Sent to Pi, and Pi acknowledged it. That is a reply, not completion (log: complete)
    run       [pi-reported] Pi reported the run completed. Not verified
  candidate:
    worktree  [controller-observed] state=observed basis=send-and-run span=(1 path differs: M calc.mjs) now=(same content)
    checked   [controller-observed] commit b2e755585fb9 (1 receipt) vs run-end: same content
    staged    [not-supplied] integrity=not-supplied — No protected-experiment run was supplied. Existing DEVELOP records do not name a reconstructable staged candidate.
  verification:
    ordinary  [operator-triggered-host-check] head=b2e755585fb9 (clean) receipts=1 problems=0
      receipt [observed; linkedBy=operator] node calc.mjs 2 3: Observed check passed at b2e755585fb9 (Recorded at this working tree's current HEAD)
      plan    [criterion 1; sum] calc adds its two inputs: Planned checks passed at HEAD
      plan    [criterion 2; operator judgment] code stays readable: Your judgment
    protected [not-supplied] no protected-experiment run inspected alongside this attempt
  review (advisory only — operator decides; status unchanged):
    suggest   [ready-for-operator-review] Authorisation, dispatch, Pi's run-end window, controller-bound working-tree provenance, and clean-HEAD ordinary verification receipts align with no detected contradictions or staleness. This is an advisory summary over unsigned local records, not an authoritative protected PASS and not acceptance.
    decision  [operator-declared] task status=review
  findings:
    [info] not-accepted: The task's status is not done: the operator has not recorded acceptance.
  not established:
    - No existing record links a DEVELOP attempt (endo.attempt.<id>) to a protected-experiment run or reconstructable staged change set; cross-space candidate association is never fabricated by timestamp, prompt text, filename or agent self-report.
    - Who or what wrote any changed byte in the working tree: Pi, the operator, an editor, a hook, or another process.
    - That Pi's reported run completion or tool output is truthful, or that a passing ordinary check satisfies acceptance criteria.
    - Which commit or candidate bytes the operator inspected when moving a task's status (tasks.json records no revision or candidate digest).
    - Protection against a same-uid host writer modifying unsigned local records or recomputing unkeyed seals.
    - Workstation protected verifier H0 authority (remains BLOCKED).
```
