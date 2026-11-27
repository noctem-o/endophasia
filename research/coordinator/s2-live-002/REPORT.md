# S2-LIVE-002 Research Report: Evidence-Scoped Coordinator Cognition & Comparative Evaluation Preparation

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Stacked Draft PR Target:** `research/s2-live-001` (PR #192 head `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`, preserved untouched and unmerged)  
**Upstream Baselines Verified:** `origin/main` = `2f730eb680e87d04d3a41bbb9d398e6b9a97794c`; OpenClaw `2026.11.10` remediation = `ce126a53a`  
**Live Inference Executed in This Package:** **0 turns / 0 tokens** (Stage 2 paired live comparisons are prepared and gated behind explicit operator authorization)

---

## 1. Executive Summary

`S2-LIVE-001` proved that Endophasia's persistent Coordinator runtime (M0/M1/S1/S2) enforces deterministic wake gating, durable budget accounting, and grounded proposal creation on local inference (`Inkling-2-Mini-Uncensored-AD-Q4_K` via OpenClaw `2026.11.10` inside bubblewrap). However, it exposed three structural deficiencies:

1. **Project-wide wording backstop collisions (`W8`, `W9`, `W10`):** `coordinatorAnswerRefusalV0` conflated task-specific claims across unrelated tasks, withholding 3 consecutive multi-task briefings (`3,702` tokens, `92.6 s` burned) whenever a `no-checks` task coexisted with a `not-current` or unplanned passing (`incomplete: true`) task — and similarly suppressed valid PASS claims when any sibling task was failing.
2. **Model-visible coordination blindness (`W0`, `W8–W10`):** The host read and validated `endo.coordinator-coordination.v0`, yet omitted it from `endophasia_status`, causing the model to guess `consider-attempt-for-assignment` on unassigned tasks while blinding it to active assignments, liveness hazards, worktree conflicts, dependencies, candidates, and advisory reviews.
3. **Post-dispatch local runtime failures:** Local non-inference checks (OpenClaw version pin, `XDG_RUNTIME_DIR`, `/usr/bin/bwrap`, prompt/status bounds) ran *after* S2 Phase E linked `turns/<id>.dispatched.json`, burning full token reservations despite 0 HTTP requests.

`COORDINATOR-GROUNDING-002` resolves all three deficiencies with versioned, opt-in contracts that preserve `legacy-v0` compatibility and strengthen epistemic integrity:
- **Versioned subject-scoped grounding (`endo.coordinator-grounded-brief.v1`):** Closed typed claims, typed uncertainties, closed host-rendered `rationaleCode` recommendations (**zero model-supplied free prose** enters the rendered briefing), unconditional host completeness/truncation disclosures, and disclosed `proposalEligibility` verification bound to snapshot-local `evidenceRef`s and `modelViewSha256`.
- **Single-tool bounded coordination visibility (`endo.coordinator-model-view.v1`):** Extends the existing single `endophasia_status` tool with a path-redacted, severity-prioritized, strictly single-project coordination projection and `proposalEligibility`, without adding tools or authority.
- **Pre-dispatch non-inference preflight (`preflightOpenClawCoordinatorV0` in Phase D.5):** Refuses local runtime mismatches as `not-dispatched` (`runtime-preflight-failed`, 0 charged tokens) before Phase E links `turns/<id>.dispatched.json`, while keeping Phase F TOCTOU re-checks intact.
- **Independent read-only adversarial audit:** Audited across all 12 mandatory security domains (`8ab92344-ed58-430c-980a-37e007ae8037`), identifying 14 substantiated findings (2 CRITICAL, 6 HIGH, 5 MEDIUM, 1 LOW), **14/14 remediated** with dedicated regression tests.

---

## 2. Reproduced S2-LIVE-001 Failure Mechanisms

Commit `adf1831ca` (`tests/coordinator-grounding-repro.test.ts`, 5/5 passing) deterministically reproduces:
- **W8 collision:** Task A (`no-checks`, `incomplete: false`) + Task B (`not-current`, historical FAIL `head-differs`) -> legacy regex refuses accurate prose as `receipt-absence-unestablished`.
- **W9/W10 collision:** Task A (`no-checks`, `incomplete: false`) + Task B (unplanned at-HEAD PASS `incomplete: true`) -> legacy regex refuses accurate prose as `receipt-absence-unestablished`.
- **Positive-contradiction collision:** Task A (passing at HEAD) + Task B (failing at HEAD) -> legacy regex refuses accurate prose as `verification-positive-contradiction`.
- **Protective refusals that must remain enforced:** historical PASS claimed as current, historical FAIL alongside current PASS, `unavailable`/`not-read` absence claims, and Phase B-1 missing event source (`event-absence-unestablished`).
- **Coordination invisibility:** `pinnedCoordinatorBriefStatusV0` drops `coordination` from `view`, withholding active assignments, conflicts, dependencies, candidates, and reviews from the model.

---

## 3. Architectural Changes & Rejected Alternatives

Full implementation contracts are documented in [docs/designs/coordinator-grounding-002-implementation.md](../../../docs/designs/coordinator-grounding-002-implementation.md) and trade-offs in [GROUNDING-DESIGN.md](./GROUNDING-DESIGN.md). Key architectural decisions:

- **Rejected regex task-ID attribution over prose** and **rejected second-LLM factuality judging** in favor of closed mechanical verification over snapshot-local `evidenceRef`s.
- **Rejected free-prose `rationale` text after adversarial audit (Finding C1):** Replaced with closed, snapshot-verified `rationaleCode` (`18` codes) rendered deterministically by the host. This structurally eliminates Unicode obfuscation, regex lookbehind negation, paraphrases, and prompt-injection text smuggling.
- **Rejected a second OpenClaw tool** in favor of extending the single `endophasia_status` payload (`endo.coordinator-model-view.v1`) with strict single-project scope isolation, host-path/session-key/label redaction, severity-sorted bounding, and explicit `completeness`/`truncated`/`omitted` metadata.
- **Preserved all M0/M1/S1/S2/E2 authority and resource boundaries:** Zero execution/dispatch/mutation/route/merge authority; unchanged prompt (`8,192 B`; grounded prompt is `4,922 B` + `275 B` question), tool output (`256 KiB`), rendered answer (`4,096 B`), relay (`512 KiB` / `8 MiB` / 2 exchanges), and generation (`2,048` tokens/request) ceilings.

---

## 4. Verification & Independent Adversarial Review Summary

- **Baseline reproductions (`tests/coordinator-grounding-repro.test.ts`):** 5/5 passing.
- **23-item deterministic & adversarial acceptance matrix + 14 adversarial review regressions (`tests/coordinator-grounding-002.test.ts`):** 17/17 passing, including real installed **OpenClaw `2026.11.10`** running inside `/usr/bin/bwrap` against a deterministic fake local provider (zero live model contact).
- **Stage 1 deterministic offline replay (`observations/stage1-offline-replay.json`):** 5/5 S2-LIVE-001 scenarios replayed cleanly (see [COMPARATIVE-EVALUATION.md](./COMPARATIVE-EVALUATION.md)).
- **Independent adversarial security review ([ADVERSARIAL-REVIEW.md](./ADVERSARIAL-REVIEW.md)):** 14/14 substantiated findings remediated (including C1 prose-bypass elimination, C2 `proposalEligibility` gate, H1–H6 epistemic/scope/disclosure/lease/size fixes, M1–M5 anti-substitution/mode/preflight fixes, L1 consistency & duplicate rejection).

---

## 5. Honest Research Classifications (Pre-Stage-2)

Per `COORDINATOR-GROUNDING-002` evaluation discipline, deterministic verification cannot substitute for live model adherence measurement:

| Dimension | Classification | Evidence Basis & Remaining Gap |
| :--- | :---: | :--- |
| **Mechanical subject-scoped grounding remediation (W8–W10 & positive-contradiction)** | **supported** | Deterministically reproduced and resolved across 23-item acceptance suite, 14 adversarial regressions, and Stage 1 offline replay (`3/3` collisions resolved, `0` unsupported claims released, all protective refusals preserved). |
| **Bounded single-project coordination visibility & path/scope redaction** | **supported** | Verified end-to-end including installed OpenClaw `2026.11.10` bubblewrap/relay transport; zero cross-project disclosure; host paths/session keys/labels stripped; `modelViewSha256` bound. |
| **Pre-dispatch non-inference preflight accounting** | **supported** | Verified in real S2 store: failing and throwing preflight both refuse as `not-dispatched` (`runtime-preflight-failed`), charge `0` tokens, create no `turns/<id>.dispatched.json`, and release the advisory lease cleanly. |
| **Live `Inkling-2-Mini` JSON schema compliance, briefing usefulness, and token efficiency under Conditions A vs B vs C** | **inconclusive** | **Stage 2 live comparisons have NOT yet been executed** (0 live turns run; awaiting separate explicit operator authorization for the 24-turn Stage 2 harness). |
| **Phase D 24-hour naturalistic deployment readiness** | **conditional** | Mechanical grounding, visibility, and preflight prerequisites are complete, **conditioned on** passing Stage 2 paired live comparisons (verifying `Inkling-2-Mini` emits valid `endo.coordinator-grounded-brief.v1` JSON reliably with higher useful publication rate and zero unsupported claims released) and explicit operator sign-off. |

---

## 6. F1/F2 Studio Implications

- **Deterministic rendering compatibility:** Because `endo.coordinator-grounded-brief.v1` separates `Verified facts`, `Uncertainties`, `Snapshot disclosures (host-reported)`, and `Advisory recommendations (untrusted model interpretation; grants nothing)` cleanly — and exposes `grounding?: EndoCoordinatorGroundedBriefSummaryV1` on `EndoCoordinatorBriefResultV0` — future Studio (F1/F2) views can render clickable evidence badges (`evidenceRef` -> task/assignment/conflict/review) and clearly style advisory recommendations separately from controller-observed facts without parsing free prose.
- **No Studio schema churn:** Existing S2 briefing files remain `endo.advisory-briefing.v0` with `answer: string` (`<= 4,096 B`) and `standing: "untrusted-model-interpretation"`.

---

## 7. Privacy & Redaction Audit Note

Before committing this research package, all files under `research/coordinator/s2-live-002/` were inspected to confirm:
- Zero API keys, bearer tokens, cookies, credentials, or auth secrets.
- Zero private operator filesystem paths inside generated evidence (`observations/stage1-offline-replay.json` uses synthetic `/replay/...` paths only; Stage 2 harness creates ephemeral `tmpdir()` stores and deletes them in `finally`).
- PR #192 (`research/s2-live-001` @ `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`) was neither modified nor overwritten.

---

## 8. Stage 2 Live Comparison Authorization Request

Stage 2 (`scripts/run-stage2-paired-live.mjs`) is prepared and **blocked behind `--authorize-live-stage2`** pending explicit operator approval:

- **Target Model & Endpoint:** `Inkling-2-Mini-Uncensored-AD-Q4_K` at `http://127.0.0.1:8091` (`llama.cpp` router `b12622-19bc41dbb`; existing server untouched).
- **Harness:** Installed OpenClaw `2026.11.10` inside `/usr/bin/bwrap` (read-only single tool `endophasia_status`).
- **Turn & Token Ceilings:** Exactly **24 bounded live advisory turns** (8 scenarios × 3 conditions A/B/C in rotated paired blocks), max 2 completion requests/turn, max `2,048` generated tokens/request (`4,096` reserved/turn; `98,304` max combined reservation), `180 s` wall-clock cap/turn, 1 concurrent turn/store, zero retries.
- **Side Effects:** Ephemeral temp Git repos & stores under `/tmp/endo-s2-live-002-*` (cleaned up automatically) plus raw observations written to `research/coordinator/s2-live-002/observations/stage2-paired-live.jsonl`. Zero changes to operator repos, `openclaw-gateway.service`, `llama-server`, systemd units, or PR #192.
