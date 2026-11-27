# Comparative Evaluation — `COORDINATOR-REASONING-001`

**Current Status:** Phase A (engineering, adversarial hardening, zero-inference preflight, and 9-cell installed-OpenClaw fake-provider dry run) is **COMPLETE**. Live Phases B, C, and optional Phase D (`R4`) are **NOT YET EXECUTED — AWAITING EXPLICIT OPERATOR AUTHORIZATION**.

---

## 1. Historical `R0` Baseline (`S2-LIVE-002`, Condition C @ `2,048` Tokens)

Preserved verbatim from `research/coordinator/s2-live-002/` (PR #193, `efd8599cd`, frozen commit `b1c6b7be9`):

| Scenario | Condition | `max_tokens` | Published | Refusal (Legacy S2-LIVE-002 Label) | True Root Cause | Reserved Tokens | Charged Tokens |
|---|---|---|---|---|---|---|---|
| `S5-W8-mixed-head` | `R0` (Condition C) | `2,048` | No (`0/1`) | `runtime-unavailable` | Exhausted 2,048-token cap inside `reasoning_content` (`finish_reason: "length"`, empty visible `content`) | `4,096` | Full reservation / `2,048` exchange 2 |
| `S8-multi-agent` | `R0` (Condition C) | `2,048` | No (`0/1`) | `runtime-unavailable` | Exhausted 2,048-token cap inside `reasoning_content` (`finish_reason: "length"`, empty visible `content`) | `4,096` | Full reservation / `2,048` exchange 2 |

All `16/16` live grounded-v1 turns in `S2-LIVE-002` (`8` Condition B, `8` Condition C) terminated the same way before emitting visible JSON.

---

## 2. Deterministic Zero-Token Baselines (§12)

Measured from `observations/preflight-manifest.json` (zero inference tokens):

| Scenario | Model View Bytes | Deterministic Status Summary (`status-v0`) | Deterministic Relational Coordination (`coordination-v0`) | Deterministic Static Priority Ruleset Top Action | Total Priority Signals |
|---|---|---|---|---|---|
| `S5-W8-mixed-head` | `2,717` B | `T1`: `in-progress` (`no-checks`); `T2`: `awaiting-review` (`not-current`, gap `earlier-failure-not-current`); complete sources | 1 active builder assignment on `T1`; 0 dependencies/candidates/conflicts/reviews | Priority 5: `investigate-incomplete-verification` on `T2` (`not-current-or-incomplete`), followed by Priority 6 `review-awaiting-review` on `T2` | `2` |
| `S8-multi-agent` | `6,217` B | `T1`: `in-progress` (`no-checks`); `T2`: `awaiting-review` (`no-checks`); complete sources | 3 assignments (`builder-prev` ended with `liveness-unverified`, `builder-1` active with `allowSharedWorktree: true`, `reviewer-1` active targeting `C1` in sibling worktree), 1 current candidate `C1`, 1 unsatisfied dependency `T2->T1`, 2 worktree conflict entries, 1 `changes-requested` review | Priority 1: `resolve-worktree-conflict` (`conflict:0`, `conflict:1`), Priority 2: `investigate-liveness-hazard`, Priority 3: `resolve-unsatisfied-dependency`, Priority 4: `inspect-advisory-review`, Priority 6: `review-awaiting-review` | `6` |

---

## 3. Phase A Installed-OpenClaw Fake-Provider Dry Run (`observations/dry-run-fake-provider.jsonl`)

Executed end-to-end through real installed `OpenClaw 2026.11.10` + `/usr/bin/bwrap` + protected model relay + S2 `runEndoAdvisoryTickV0` against an ephemeral deterministic fake server (**zero contact with `http://127.0.0.1:8091`**):

| Cell | Mode | Tier | Authorized `max_tokens` | Observed Wire `max_tokens` (Ex1, Ex2) | Outcome | Proposal | Reserved / Charged Tokens | Diagnostics `terminationClass` | `rawReasoningStored` |
|---|---|---|---|---|---|---|---|---|---|
| `S5` × `R1` | `valid` | `light` | `4,096` | `4096, 4096` | `briefing-published` | `created` | `8,192` / `420` | `published` | `false` |
| `S5` × `R2` | `valid` | `deliberate` | `8,192` | `8192, 8192` | `briefing-published` | `created` | `16,384` / `420` | `published` | `false` |
| `S5` × `R3` | `valid` | `deep` | `16,384` | `16384, 16384` | `briefing-published` | `created` | `32,768` / `420` | `published` | `false` |
| `S5` × `R4` | `valid` | `extended` | `24,576` | `24576, 24576` | `briefing-published` | `created` | `49,152` / `420` | `published` | `false` |
| `S8` × `R1` | `valid` | `light` | `4,096` | `4096, 4096` | `briefing-published` | `created` | `8,192` / `420` | `published` | `false` |
| `S8` × `R2` | `valid` | `deliberate` | `8,192` | `8192, 8192` | `briefing-published` | `created` | `16,384` / `420` | `published` | `false` |
| `S8` × `R3` | `valid` | `deep` | `16,384` | `16384, 16384` | `briefing-published` | `created` | `32,768` / `420` | `published` | `false` |
| `S8` × `R4` | `valid` | `extended` | `24,576` | `24576, 24576` | `briefing-published` | `created` | `49,152` / `420` | `published` | `false` |
| `S5` × `R1` | `reasoning-exhausted` | `light` | `4,096` | `4096, 4096` | `briefing-refused` (`reasoning-budget-exhausted`) | `refused` | `8,192` / `4,136` | `reasoning-budget-exhausted` | `false` |

All 9 cells verified frozen sampling (`temperature=0, top_k=1, top_p=1, min_p=0, seed=101`), `rawReasoningStored: false`, and zero raw reasoning leakage.

---

## 4. Planned Live Comparative Matrix (Phases B, C, Optional D)

> [!IMPORTANT]
> **NOT YET EXECUTED — AWAITING EXPLICIT OPERATOR AUTHORIZATION.** No live completion requests have been sent to `http://127.0.0.1:8091`.

| Phase | Cell | Tier | `max_tokens` | Member / Turn / Lease Ceilings | Live Status | Published | Refusal / `terminationClass` | Completion Tokens | Wall Latency | Value Beyond Deterministic Baselines |
|---|---|---|---|---|---|---|---|---|---|---|
| Phase B | `S5` × `R3` | `deep` | `16,384` | `720s / 780s / 840s` | **Not executed** | — | — | — | — | — |
| Phase B | `S8` × `R3` | `deep` | `16,384` | `720s / 780s / 840s` | **Not executed** | — | — | — | — | — |
| Phase C | `S5` × `R1` | `light` | `4,096` | `360s / 420s / 480s` | **Not executed** | — | — | — | — | — |
| Phase C | `S8` × `R1` | `light` | `4,096` | `360s / 420s / 480s` | **Not executed** | — | — | — | — | — |
| Phase C | `S5` × `R2` | `deliberate` | `8,192` | `480s / 540s / 600s` | **Not executed** | — | — | — | — | — |
| Phase C | `S8` × `R2` | `deliberate` | `8,192` | `480s / 540s / 600s` | **Not executed** | — | — | — | — | — |
| Opt. D | `S5` × `R4` | `extended` | `24,576` | `1080s / 1140s / 1200s` | **Conditional (not executed)** | — | — | — | — | — |
| Opt. D | `S8` × `R4` | `extended` | `24,576` | `1080s / 1140s / 1200s` | **Conditional (not executed)** | — | — | — | — | — |
