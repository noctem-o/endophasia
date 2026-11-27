# COORDINATOR-GROUNDING-002 Implementation Design: Subject-Scoped Factual Grounding & Bounded Coordination Visibility

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Stacked Baseline:** PR #192 (`research/s2-live-001` @ `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`, built on `origin/main` `2f730eb680e87d04d3a41bbb9d398e6b9a97794c` + OpenClaw `2026.11.10` fix `ce126a53a`)  
**Status:** Implemented, deterministically verified (23-item acceptance matrix + installed OpenClaw `2026.11.10` fake-provider end-to-end + Stage 1 offline replay), independently adversarially reviewed, and hardened with 14/14 substantiated findings remediated. Stage 2 paired live comparisons are prepared only and await separate explicit operator authorization.

---

## 1. Root Causes Diagnosed in S2-LIVE-001

S2-LIVE-001 surfaced three concrete architectural limitations, each deterministically reproduced in `tests/coordinator-grounding-repro.test.ts`:

1. **Project-wide wording backstop conflation (`adapters/coordinator/status.ts:60-94`):**
   - `receipt-absence-unestablished` tested `tasks.some(t => t.verification.incomplete || ["unavailable", "not-read", "not-current"].includes(t.verification.state))` against ANY absence-of-check phrasing anywhere in the answer. On multi-task projects mixing a `no-checks` task (`T1`) with a `not-current` (`W8`) or unplanned passing `incomplete: true` (`W9`, `W10`) task (`T2`), following the prompt's own `"no check is recorded for this task"` rule caused 3/3 consecutive refusals (3,702 completion tokens and 92.6 s consumed with zero published output).
   - `verification-positive-contradiction` similarly tested `tasks.some(t => t.verification.state === "failing")` against ANY positive verification phrase anywhere in the answer, suppressing accurate claims that Task A passed at HEAD while Task B failed.
2. **Model-visible coordination blindness (`adapters/coordinator/openclaw.ts:226-265`):**
   - Both `readCoordinatorBriefStatusV0` and `pinnedCoordinatorBriefStatusV0` validated `endo.coordinator-coordination.v0` on the host, yet omitted it from `toolOutcome` (`externalEndophasiaStatusV0` only). Host-side `endoAdvisoryGroundProposalV0` consulted `coordination`, creating an asymmetry where the model twice proposed `consider-attempt-for-assignment` on an unassigned task (`W0` in Run 1 and Run 2).
3. **Post-dispatch local runtime failures (`adapters/develop/advisory-tick.ts:1112-1206`):**
   - S2 Phase E linked `turns/<id>.dispatched.json` before Phase F ran local non-inference checks inside `runOpenClawCoordinatorV0` (OpenClaw version pin, `XDG_RUNTIME_DIR`, `/usr/bin/bwrap`, prompt/view byte bounds), charging the full 4,096-token reservation despite zero HTTP requests.

---

## 2. Architecture & Versioned Contracts

### 2.1 Snapshot-Local Model-Visible View (`endo.coordinator-model-view.v1`)

Defined in `protocol/coordinator-grounding.ts` and constructed in `runtime/contracts/coordinator-grounding.ts` (`buildEndoCoordinatorModelViewV1`):

- **Single-tool invariant preserved:** Delivered through the existing single `endophasia_status` tool — zero new tools, zero expanded execution or mutation authority.
- **Strict single-project isolation:** `buildEndoCoordinatorModelViewV1` asserts `statusView.projects.length === 1 && statusView.projects[0].project === projectId` and, when coordination is included, asserts `coordination.scope.requested` and `coordination.projects` match `projectId` exclusively (throwing `TypeError` on any scope mismatch). Sessions and attention entries are filtered to `projectId`'s task IDs, dropping foreign task links and foreign-only sessions.
- **Snapshot-local `evidenceRef`s:** Every disclosed entity carries an explicit deterministic identifier (`ev:project`, `ev:sources`, `ev:task:<taskId>`, `ev:session:<n>`, and when `visibilityMode: "status-and-coordination-v1"`, `ev:coordination`, `ev:assignment:<id>`, `ev:dependency:<id>`, `ev:candidate:<id>`, `ev:worktree:<id>`, `ev:conflict:<n>`, `ev:review:<id>`).
- **Bounded, path-redacted, prioritized coordination:**
  - Strips all host filesystem paths (`worktreePath`), session keys (`sessionKey`), and operator worktree labels (`label`).
  - Explicitly encodes `sourceState` (`absent | ready | unreadable`), `completeness` (`complete | partial | unavailable`), `truncated`, and exact `omitted` counts.
  - Prioritizes highest-salience items deterministically before bounding (`maxAssignments: 16`, `maxDependencies: 24`, `maxCandidates: 24`, `maxWorktrees: 16`, `maxConflicts: 16`, `maxReviews: 16`): hazardous -> active -> ended assignments; unsatisfied -> unknown -> satisfied dependencies; current -> historical candidates; critical write-overlap -> liveness-unverified -> shared-mutable -> acknowledged -> path-hint conflicts; non-approved -> approved advisory reviews.
  - Preserves E2 offline liveness honesty (`liveness: "unknown"`, `terminationConfirmed: false`) and advisory review standing (`standing: "advisory-agent-review"`, `basis: "agent-reported"`).
  - Exposes deterministic `proposalEligibility` for **all** visible project tasks derived purely from the disclosed snapshot.
- **Exact evidence binding & anti-substitution:** `modelViewSha256 = sha256(canonicalJson(modelView))` hashes the full `endo.coordinator-model-view.v1` JSON. `validateAndRenderGroundedBriefV1` verifies `args.modelViewSha256 === endoCoordinatorModelViewSha256V1(args.modelView)` (failing closed as `ungrounded` on mismatch), and S2 Phase G (`adapters/develop/advisory-tick.ts`) verifies both `projectionSha256` and `modelViewSha256` before marking a `grounded-v1` briefing `current-at-publication`.

### 2.2 Subject-Scoped Grounded Briefing (`endo.coordinator-grounded-brief.v1`)

- **Strict closed JSON output:** Single JSON object (optional single JSON fence with zero surrounding prose), `<= 16 KiB` raw response, duplicate-key rejected at every depth (`hasDuplicateJsonKeysV1`), closed keys only, and duplicate claims/uncertainties/recommendations/`supportingRefs` rejected. Any unstructured prose or malformed payload fails closed as `grounding-malformed` with zero permissive fallback and zero automatic retries.
- **Mechanically verified `claims` (`1..16`) & `uncertainties` (`0..10`):**
  - Every entry must name `(subjectKind, subjectId, evidenceRef)` where `evidenceRef` exists in the evidence index built **exclusively** from `modelView` and matches `(subjectKind, subjectId)`. Host-only data can never validate a claim.
  - `task.verification-state = "no-checks"` and `task.current-head-check = "none-recorded"` are permitted on Task A (`no-checks`, `incomplete: false`) even when Task B is `not-current`, `incomplete`, or `not-read`, and are **refused** (`receipt-absence-unestablished`) on Task B (or if `incomplete: true`).
  - `task.current-head-check = "passing"` requires a **complete** at-HEAD passing check (`!incomplete`, not failing/inconclusive/not-current); `"passing-incomplete"` covers unplanned at-HEAD passes (`incomplete: true`, not failing/inconclusive/not-current); `"not-established"` (and uncertainty `verification-not-established`) are **refused** on tasks failing at HEAD; historical checks accept only genuine historical relations (`head-differs`, `at-head-changed`, `other-worktree`, `other-repository`), never `unavailable`.
  - `sources.session-activity = "none-linked"` requires `events`, `attempts`, AND `tasks` all `"ready"` (refusing with `event-absence-unestablished` if `events` is not ready and `grounding-claim-unsupported` if `attempts` or `tasks` is not ready), preserving Phase B-1 protective refusal mechanically.
  - `coordination.coordination-assignments = "none"` is **refused** when `coordination.completeness === "unavailable"`, `sourceState === "unreadable"`, or `truncated === true`.
- **Zero-free-prose closed `recommendations` (`0..4`) (Post-Adversarial Hardening C1/M3):**
  - Following independent adversarial review, unstructured model-supplied `rationale` text was replaced completely with a closed, snapshot-verified `rationaleCode` enum (`18` closed codes) rendered deterministically by the host.
  - Every recommendation must include its own subject's `evidenceRef` in `supportingRefs`, pass mechanical `verifyRecommendationKind` checks (e.g., coordination recommendations refused when `coordination === null`; `no-action-needed` refused when actionable issues exist), and pass mechanical `verifyRecommendationRationaleCode` checks against `supportingRefs` (e.g., `unassigned-open-task` requires complete disclosed coordination).
  - Because **zero model-supplied prose** enters `renderedAnswer`, Unicode obfuscation, regex lookbehind bypasses, paraphrases, prompt-injection text, and authority-expansion strings are eliminated structurally rather than patched with fragile regexes.
- **Host-enforced completeness/truncation disclosures & rendered byte bound (H3/H5):**
  - `renderEndoCoordinatorGroundedBriefV1` unconditionally appends a `Snapshot disclosures (host-reported):` section whenever any store source is non-ready, status findings exist, or coordination is `partial`, `unavailable`, or `truncated` (with exact `omitted` counts and `gaps`).
  - `validateAndRenderGroundedBriefV1` enforces `Buffer.byteLength(renderedAnswer, "utf8") <= 4096` (matching S2's `L.maxAnswerBytes`).
- **Disclosed proposal eligibility gate (C2):**
  - `brief.proposal !== null` is **refused** whenever `includeProposalLine === false` OR `(proposal.taskId, proposal.kind)` is not present in `modelView.proposalEligibility`. Thus Condition B (`coordination: null`) cannot ground coordination-only proposals by guessing, and Condition C cannot ground proposals for truncated/omitted assignments.
  - When `includeProposalLine === true`, the renderer deterministically emits the trailing `PROPOSAL:` line and S2's existing `endoAdvisoryParseProposalLineV0` + `endoAdvisoryGroundProposalV0` remain the authoritative host publication gate.

### 2.3 Non-Inference Preflight Placement (§6 & H4/M4/M5)

- `preflightOpenClawCoordinatorV0` (`adapters/coordinator/openclaw.ts`) performs purely local non-inference checks (selector format, mode combination check rejecting `status-and-coordination-v1` with `legacy-v0`, IPv4 loopback origin, `XDG_RUNTIME_DIR` 0700 ownership, `/usr/bin/bwrap` regular-file + executable bit `X_OK`, OpenClaw binary & verified version allowlist, prompt `<= maxPromptBytes`, pinned status `<= 256 KiB`) with zero network I/O and zero subprocesses.
- `runEndoAdvisoryTickV0` invokes preflight in **Phase D.5** (after member selection, **before** Phase E links `turns/<id>.dispatched.json`), wrapped in `try/catch` so even an unexpected synchronous error returns `not-dispatched` (`runtime-preflight-failed`, 0 requests, 0 charged tokens) and releases the advisory lease cleanly.
- `runOpenClawCoordinatorV0` re-runs every check in Phase F for TOCTOU safety; any post-dispatch failure remains conservatively charged.

---

## 3. Compatibility, Migration & Policy-Digest Implications

- **Zero silent v0 mutation:** `legacy-v0` / `status-v0` remain the default on all M0, M1, and S2 v0 APIs, keeping every existing historical briefing, proposal, and test byte-compatible.
- **Explicit versioning & opt-in selection:** `--briefing-mode <legacy-v0|grounded-v1>` and `--visibility <status-v0|status-and-coordination-v1>` on `endo coordinator brief` and `endo advisory tick` cleanly separate Conditions A, B, and C. Passing `--visibility status-and-coordination-v1` without `--briefing-mode grounded-v1` is rejected across CLI, preflight, tick, and runner.
- **Prompt & evidence digests:** Grounded instructions (`ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_V1`) are **4,922 bytes** (`ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_V1` adds **275 bytes**; total prompt with project header ~5,280 bytes — **64.5%** of M0's unchanged **8,192-byte** `maxPromptBytes` ceiling).
- **No weakening of limits:** Relay request (512 KiB), transfer (8 MiB), exchanges (2), prompt (8,192 B), tool output (256 KiB), rendered answer (4,096 B), and generation (2,048 tokens/request) ceilings remain unchanged.
