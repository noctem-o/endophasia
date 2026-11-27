# COORDINATOR-CONSOLIDATION-001 — Research-to-Production Consolidation Record

**Status:** Consolidation review package (branched from `origin/main` `2f730eb680e87d04d3a41bbb9d398e6b9a97794c`)  
**Preserved Research Stack (open, unmerged, untouched):**
- **PR #192** (`research/s2-live-001`): `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`
- **PR #193** (`feat/coordinator-grounding-002`): `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`
- **PR #194** (`research/coordinator-reasoning-001`): `3c22f1a91da2e64f0c0488fae767ceb70c653995`

---

## 1. Guiding Principle

> **Build an intelligent environment first. Let replaceable neural agents contribute additional intelligence when they can demonstrably improve it.**

Recent live experiments (`S2-LIVE-001`, `S2-LIVE-002`, and `COORDINATOR-REASONING-001`) produced substantial reusable infrastructure and hard empirical evidence, while demonstrating that **Inkling 2 Mini** does not currently achieve reliable advisory competence under the experimental `grounded-v1` schema contract (0/6 published turns in `COORDINATOR-REASONING-001`, even when given 16,384 completion tokens and finishing cleanly with `finish_reason: "stop"`).

This consolidation separates **verified production runtime hardening** from **experimental cognition contracts** so `main` captures every clear reliability, safety, and diagnostic improvement without prematurely promoting unvalidated neural contracts or unattended long-lease policies.

---

## 2. A1 — Complete Promotion Matrix (PR #192, PR #193, PR #194)

Every commit across the three open research PRs is classified below into one of five statuses:
1. **Ready for production review** (extracted cleanly into this PR)
2. **Suitable for promotion following specific remediation** (not promoted here; exact blockers documented in §4–§5)
3. **Experimental and opt-in only** (kept on research branch; not merged to `main`)
4. **Research evidence only** (preserved as historical record in open research PRs)
5. **Superseded or should not be promoted**

### PR #192 (`research/s2-live-001`, head `6d8d16421`)

| Commit | Scope / Mechanism | Classification | Rationale & Action |
|---|---|---|---|
| `ce126a53a` | Allow verified OpenClaw `2026.11.10` alongside `2026.11.7` and report observed `installedVersion` in `runtime.harness` (`adapters/coordinator/openclaw.ts`) | **Ready for production review** | Small (+5/-1), verified against live OpenClaw `2026.11.10` in S2-LIVE-001/002/REASONING-001. **Promoted in this PR.** |
| `6d8d16421` | `research/coordinator/s2-live-001/` live smoke test protocol, logs, raw advisory artifacts, qualitative evaluation, report | **Research evidence only** | Preserved verbatim in PR #192. |

### PR #193 (`feat/coordinator-grounding-002`, head `efd8599cd`)

| Commit | Scope / Mechanism | Classification | Rationale & Action |
|---|---|---|---|
| `adf1831ca` | Deterministic baseline reproductions of S2-LIVE-001 mixed-verification wording false positives and visibility gaps | **Research evidence only** | Documents the motivating failure modes for `grounded-v1`; tied to research evaluation suite. |
| `56d8daa76` | Subject-scoped grounding schema & validator (`protocol/coordinator-grounding.ts`, `runtime/contracts/coordinator-grounding.ts`, `grounded-v1`) | **Experimental and opt-in only** | Mechanically sound and adversarially hardened (14/14 findings remediated), but 0/6 live publication rate on Inkling 2 Mini and lacks fine-grained grounding-failure diagnostics. Keep experimental until a candidate model demonstrates live competence. |
| `aa604607f` (subset: preflight) | Deterministic local non-inference preflight (`preflightOpenClawCoordinatorV0` + S2 Phase D.5 + `"runtime-preflight-failed"`) | **Ready for production review** | Prevents local OpenClaw/bwrap/`XDG_RUNTIME_DIR` mismatches from burning full S2 token reservations (`not-dispatched`, 0 tokens charged). Strictly zero network I/O, zero subprocesses, TOCTOU-safe because `runOpenClawCoordinatorV0` re-checks at execution. **Promoted in this PR.** |
| `aa604607f` (subset: `model-view.v1` + CLI mode flags) | Bounded `status-and-coordination-v1` model view (`buildEndoCoordinatorModelViewV1`) and `--briefing-mode` / `--visibility-mode` flags | **Experimental and opt-in only** | Coupled to `grounded-v1`; should remain opt-in research until grounding competence and diagnostics are validated. |
| `e9793b343` | Remediation of 14 adversarial grounding findings + 23-item grounding acceptance suite | **Experimental and opt-in only** (preflight security checks: **Ready for production review**) | Hardening of `preflightOpenClawCoordinatorV0` is included in the promoted preflight; `grounded-v1` validator hardening stays with `grounded-v1` on PR #193. |
| `2806d8530` | S2-LIVE-002 comparative infrastructure, adversarial review, design package | **Research evidence only** | Preserved verbatim in PR #193. |
| `b1c6b7be9` | Hardened S2-LIVE-002 24-cell comparative harness & zero-inference dry-run | **Research evidence only** | Preserved verbatim in PR #193. |
| `efd8599cd` | S2-LIVE-002 Stage 2 live paired comparisons & Stage 3 blinded comparative evaluation | **Research evidence only** | Preserved verbatim in PR #193. |

### PR #194 (`research/coordinator-reasoning-001`, head `3c22f1a91`)

| Commit | Scope / Mechanism | Classification | Rationale & Action |
|---|---|---|---|
| `4891a680a` | Governed cognitive resource policy (`endo.coordinator-resource-policy.v1`, `endo.coordinator-model-pool.v1`, extended 840–1,200 s unrenewed leases, CLI `--resource-profile`) | **Suitable for promotion following specific remediation** | Mechanically verified across 6 live turns, but extended unrenewed 840–1,200 s shared leases exceed `defaultOnTimeGraceMs` (600 s) for unattended multi-schedule operation, and S1 pool observation does not yet ingest V1 pools. See full analysis in §5 (A4). **Not promoted to `main` in this PR.** |
| `eabbe7f4f` | Structured termination diagnostics (`endo.coordinator-brief-diagnostics.v1`, `reasoning-budget-exhausted`, bounded per-exchange reasoning/visible counters, `rawReasoningStored: false`) | **Ready for production review** | Pure read-only, backwards-compatible runtime instrumentation; zero raw reasoning text persisted; immediately clarifies why a turn stopped (`reasoning-budget-exhausted` vs `generation-limit` vs `inference-timeout` vs `grounding-refused`). **Promoted in this PR (V0-scoped).** |
| `9724183b4` (subset: V0 hardening `F1`–`F10`) | Closed top-level wire allowlist (`F3`), `onPayload` reasoning/template key stripping (`F3`), `spawn` with `stdout: "ignore"` + 8 KiB stderr cap (`F8`), 4096-byte V0 answer ceiling (`F5`), `finishReason` sanitization (`F9`), `diagnostics` refusal override (`F6`), S2 Phase A immediate idle-lease release (`F1`), Phase F `inference-timeout` classification fix (`F2`), Phase G+H `publicationMarginMs` fencing fix (`F4`), `ownsLease`-guarded `pruneRetained` (`F10`) | **Ready for production review** | Pure security, correctness, and observability hardening of the existing V0 Coordinator runtime & S2 advisory tick with zero breaking schema changes and zero new experimental defaults. **Promoted in this PR.** |
| `9724183b4` (subset: V1 resource-policy fixes `F1`/`F7`) | Phase A/C/E lease-TTL fencing and `reasoning_budget_tokens` headroom check | **Suitable for promotion following specific remediation** | Belongs with `endo.coordinator-resource-policy.v1` when promoted after §5 remediation. |
| `b742f8103` | `COORDINATOR-REASONING-001` harness, preflight, dry-run, design docs | **Research evidence only** | Preserved verbatim in PR #194. |
| `3c22f1a91` | Live Phase B (`R3 = 16,384`) and Phase C (`R1 = 4,096`, `R2 = 8,192`) empirical results and comparative evaluation | **Research evidence only** | Preserved verbatim in PR #194. |

---

## 3. A2 — Independently Promoted Mechanisms in This PR

Every mechanism promoted to `main` in this PR preserves existing V0 defaults (`max_tokens: 2048`, `leaseTtlMs: 300_000`, `legacy-v0` briefing mode, zero operational authority):

1. **Verified OpenClaw `2026.11.10` compatibility & observed harness reporting** (`adapters/coordinator/openclaw.ts`).
2. **Pre-dispatch non-inference local runtime preflight (`preflightOpenClawCoordinatorV0`)** + S2 Phase D.5 check + `"runtime-preflight-failed"` (`adapters/coordinator/openclaw.ts`, `adapters/develop/advisory-tick.ts`, `protocol/develop-advisory.ts`).
3. **Closed `/v1/chat/completions` top-level request allowlist & `onPayload` key stripping (`F3`)** (`adapters/coordinator/wire.ts`, `adapters/coordinator/openclaw.ts`).
4. **Bounded subprocess I/O (`spawn` with `stdout: "ignore"`, 8 KiB stderr cap, `F8`) & 4,096-byte V0 answer bound (`F5`)** (`adapters/coordinator/openclaw.ts`).
5. **Bounded termination diagnostics (`endo.coordinator-brief-diagnostics.v1`, `reasoning-budget-exhausted`, sanitized `finishReason`, `rawReasoningStored: false`, `F6`/`F9`)** (`runtime/contracts/coordinator-brief.ts`, `adapters/coordinator/wire.ts`, `adapters/coordinator/openclaw.ts`).
6. **S2 Advisory Tick lease/deadline/retention correctness fixes (`F1`/`F2`/`F4`/`F10`)** (`adapters/develop/advisory-tick.ts`):
   - Phase A immediately releases the advisory lease inside the same lock when no schedule is claimed.
   - Phase F enforces the inference deadline via `target.hostDeadline` rather than an external abort signal that misclassified timeouts as `runtime-unavailable`.
   - Phase H evaluates `turnDeadlineMs` against inference completion so Phases G+H may consume `publicationMarginMs` while holding a live lease.
   - `pruneRetained` runs only while `ownsLease(s, nowMs)` holds.
7. **A3 Grounding-Failure Diagnostic Schema Contract** (`endo.coordinator-grounding-failure-diagnostic.v1` in `runtime/contracts/coordinator-brief.ts`).

---

## 4. A3 — Grounding Failure Diagnostics Design

In `COORDINATOR-REASONING-001`, Inkling 2 Mini produced 5,430–6,503 visible characters with `finish_reason: "stop"` at `R3 = 16,384` yet failed `grounded-v1` validation with coarse refusal codes (`grounding-claim-unsupported`, `grounding-malformed`). Coarse codes alone cannot tell researchers whether a candidate model failed at JSON envelope framing, schema keys, subject resolution, evidence-ref syntax, predicate matching, or proposal-line formatting — while persisting raw untrusted model output in durable state would violate Endophasia's prompt-injection and data-minimization boundaries.

This PR introduces a strictly closed, zero-raw-text diagnostic contract (`endo.coordinator-grounding-failure-diagnostic.v1`) validated by `validateEndoCoordinatorGroundingFailureDiagnosticV1`:

- `stage`: closed enum (`envelope-parse` | `schema-validate` | `subject-resolve` | `evidence-ref-resolve` | `claim-verify` | `recommendation-verify` | `answer-length`)
- `ruleCode`: closed enum (16 specific rule failure codes)
- `claimIndex`: integer `0..64` or `null`
- `subjectKind`: closed enum (`project` | `task` | `session` | `assignment` | `dependency` | `candidate` | `review` | `conflict` | `unknown` | `none`)
- `predicateCategory`: closed enum (12 categories)
- `refResolution`: closed enum (`resolved` | `missing` | `malformed` | `unknown-id` | `wrong-subject` | `not-applicable`)
- `recommendationCode`: closed enum (6 recommendation validation outcomes)
- `rawModelTextStored`: literal `false` (mandatory attestation; unknown keys rejected)

**Boundary:** This PR defines and tests the closed diagnostic contract only; it does **not** promote experimental `grounded-v1` into production `main`. Any future Intelligence Research branch can emit this contract directly without inventing ad-hoc strings or storing raw model text.

---

## 5. A4 — Extended Advisory Resource & Unattended Lease Assessment

`COORDINATOR-REASONING-001` demonstrated that extended governed resource envelopes (`R1`–`R3`, up to 16,384 completion tokens, 720 s turn deadline, 840–1,200 s advisory lease TTL) operate cleanly for **manual, operator-invoked, sequential single-schedule ticks**.

However, promoting unrenewed 840–1,200 s leases to **unattended multi-schedule operation** introduces concrete operational hazards that MUST be remediated first:

| Operational Dimension | Current Unrenewed Long-Lease Behaviour (`COORDINATOR-REASONING-001`) | Required Remediation Before Unattended Promotion |
|---|---|---|
| **Abandoned leases** | If a tick crashes after Phase A/E under a 1,200 s lease, the shared store-wide advisory lease blocks ALL schedules for up to 20 minutes until `expiresAtMs`. | Bounded short lease TTL (e.g., 60–120 s) with explicit **renewable lease heartbeats** owned by the live tick process (not implemented in this PR). |
| **Cancellation / uncertain termination** | Killing a host process mid-inference leaves `turns/<id>.dispatched.json` without `.briefing.json`; recovery correctly charges full reservation and never retries, but the local inference server (`llama.cpp`) may still be computing on GPU after the host died if the TCP socket does not immediately terminate generation. | Active cancellation verification + short heartbeat expiry + explicit server-side slot observation before admitting a follow-up turn. |
| **Authorization revocation during long turns** | Revocation is checked at Phase C, Phase E (pre-dispatch), and Phase H (publication). A revoked turn is withheld at Phase H (`authorization-revoked-in-flight`), preventing publication, but continues consuming local GPU until completion. | Periodic revocation re-check during heartbeat renewal so an operator revoke aborts the in-flight `AbortController` within one heartbeat interval (~30–60 s) instead of waiting 12+ minutes. |
| **Publication fencing** | Phase H fences on `ownsLease`, `inferenceWithinTurnDeadline`, schedule incarnation/revision, authorization ID, and committed publication observation. Mechanically sound (F4). | Preserve exact Phase H fencing invariants when adding lease renewal (epoch must stay monotonic; lost renewal aborts inference immediately). |
| **Missed windows** | `defaultOnTimeGraceMs` is 600 s (10 min). A single 12–15 min turn exceeds `defaultOnTimeGraceMs`, causing other schedules' due windows to transition to `missed-skipped`. | Either short renewable leases + explicit per-schedule cadence guidance (cadence >= 2x max turn deadline), or schedule-aware admission spacing. |
| **Contention across schedules** | One store-wide advisory lease serializes all projects and schedules (`lease-held`). One slow project starves unrelated schedules. | Explicit contention telemetry in Studio + heartbeat-backed leases; consider per-project or priority-fair claim ordering if multiple projects share one store. |
| **S1 pool observation parity** | S1 `readCoordinatorModelPoolFileV0` only parses `endo.coordinator-model-pool.v0`; V1 pools (`maxOutputTokens > 2048`, `timeoutMs > 135_000`) require S1 observer parity before unattended `recorded-only` selection works seamlessly. | Extend S1 passive resource observation to accept `endo.coordinator-model-pool.v1` with unchanged no-wake zero-token policy. |

**Promotion criteria:**
- **Manual / bounded opt-in:** Requires S1 V1-pool observation parity and explicit operator opt-in (`--resource-profile`); acceptable only for operator-supervised runs.
- **Unattended scheduled deployment:** Prohibited until (1) renewable lease heartbeats with revocation-aware abort, (2) S1 V1-pool parity, and (3) demonstrated live grounded advisory competence on a target model are all verified.

---

## 6. A5 — Consolidation Research Record (Epistemic Discipline)

To prevent misreading our negative live results, we preserve five distinct axes of evaluation:

| Axis | Status Across S2-LIVE-001 / S2-LIVE-002 / COORDINATOR-REASONING-001 | What This Proves (and Does NOT Prove) |
|---|---|---|
| **1. Mechanism feasibility** | **Demonstrated.** Sandboxed OpenClaw execution, wire-level allowlisting, S1 zero-token resource observation, S2 durable claim/admit/dispatch/publish ledger, budget reservation/charging, and deterministic wake gating all work end-to-end on real hardware. | Endophasia's governance and isolation architecture is viable for asynchronous local coordination. |
| **2. Mechanical validation** | **Demonstrated.** Deterministic test suites (including 14 grounding adversarial remediations and 10 resource-policy adversarial remediations) pass with zero authority bypasses and zero cross-project leakage. | The safety boundaries fail closed as designed under adversarial inputs. |
| **3. Live model performance** | **Negative for Inkling 2 Mini under `grounded-v1`.** At 2,048 tokens (`S2-LIVE-002`), Inkling exhausted completion budget inside reasoning (`0/16` grounded). At 4,096–16,384 tokens (`COORDINATOR-REASONING-001`), Inkling stopped cleanly (`finish_reason: "stop"` below budget) and emitted 5,430–6,503 visible chars, yet still failed `grounded-v1` validation (`0/6`). | For Inkling 2 Mini specifically, failure under `grounded-v1` is **not** solely a 2,048-token budget ceiling; it reflects difficulty adhering to the strict `grounded-v1` schema/claim contract. **This does NOT prove local models or future reasoning models cannot succeed** under better-matched models, schemas, or contracts. |
| **4. Advisory usefulness** | **Unproven on current local model.** Legacy V0 published occasional terse summaries in `S2-LIVE-001` / `S2-LIVE-002`, but Condition C did not demonstrate measurable coordination value above deterministic status + coordination projections. | Current neural advisory output cannot yet be treated as a primary operational surface; deterministic Studio visibility must stand on its own. |
| **5. Production readiness** | **Split.** Deterministic status/coordination/S1/S2 infrastructure + V0 runtime hardening are **ready for production review**. `grounded-v1` and unattended extended-resource scheduling are **not ready**. | Ship deterministic Coordinator Studio F1 immediately; continue neural cognition as an independent, non-blocking research track. |
