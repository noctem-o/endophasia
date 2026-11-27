# Comparative Evaluation — `COORDINATOR-REASONING-001`

**Current Status:** Phase A (engineering, adversarial review `F1`–`F10`, zero-inference preflight, 9-cell fake-provider dry run), **Live Phase B (`R3 deep = 16,384`, 2 turns)**, and **Live Phase C (`R1 light = 4,096` & `R2 deliberate = 8,192`, 4 turns)** are **COMPLETE**. Optional Phase D (`R4 extended = 24,576`) was **NOT RUN** per the predefined `PROTOCOL.md` §3 stop rule because both `S5` and `S8` completed cleanly with `finishReason: "stop"` below `16,384` tokens under `R3`.

---

## 1. Historical `R0` Baseline (`S2-LIVE-002`, Condition C @ `2,048` Tokens)

Preserved verbatim from `research/coordinator/s2-live-002/` (PR #193, `efd8599cd`, frozen commit `b1c6b7be9`):

| Scenario | Condition | `max_tokens` | Published | Legacy S2-LIVE-002 Refusal | True Root Cause | Reserved Tokens |
|---|---|---|---|---|---|---|
| `S5-W8-mixed-head` | `R0` (Condition C) | `2,048` | No (`0/1`) | `runtime-unavailable` | Exhausted 2,048-token cap inside `reasoning_content` (`finish_reason: "length"`, empty visible `content`) | `4,096` |
| `S8-multi-agent` | `R0` (Condition C) | `2,048` | No (`0/1`) | `runtime-unavailable` | Exhausted 2,048-token cap inside `reasoning_content` (`finish_reason: "length"`, empty visible `content`) | `4,096` |

All `16/16` live grounded-v1 turns in `S2-LIVE-002` (`8` Condition B, `8` Condition C) terminated inside internal reasoning before emitting visible JSON.

---

## 2. Deterministic Zero-Token Baselines (§12)

Measured from `observations/preflight-manifest.json` (`0` tokens, `< 0.1 s`):

| Scenario | Model View Bytes | Deterministic Status Summary (`status-v0`) | Deterministic Relational Coordination (`coordination-v0`) | Deterministic Static Priority Ruleset Top Action | Total Priority Signals |
|---|---|---|---|---|---|
| `S5-W8-mixed-head` | `2,717` B | `T1`: `in-progress` (`no-checks`); `T2`: `awaiting-review` (`not-current`, gap `earlier-failure-not-current`); complete sources | 1 active builder assignment on `T1`; 0 dependencies/candidates/conflicts/reviews | Priority 5: `investigate-incomplete-verification` on `T2` (`not-current-or-incomplete`), followed by Priority 6 `review-awaiting-review` on `T2` | `2` |
| `S8-multi-agent` | `6,217` B | `T1`: `in-progress` (`no-checks`); `T2`: `awaiting-review` (`no-checks`); complete sources | 3 assignments (`builder-prev` ended with `liveness-unverified`, `builder-1` active with `allowSharedWorktree: true`, `reviewer-1` active targeting `C1` in sibling worktree), 1 current candidate `C1`, 1 unsatisfied dependency `T2->T1`, 2 worktree conflict entries, 1 `changes-requested` review | Priority 1: `resolve-worktree-conflict` (`conflict:0`, `conflict:1`), Priority 2: `investigate-liveness-hazard`, Priority 3: `resolve-unsatisfied-dependency`, Priority 4: `inspect-advisory-review`, Priority 6: `review-awaiting-review` | `6` |

---

## 3. Phase A Installed-OpenClaw Fake-Provider Dry Run (`observations/dry-run-fake-provider.jsonl`)

Executed end-to-end through real installed `OpenClaw 2026.11.10` + `/usr/bin/bwrap` + protected model relay + S2 `runEndoAdvisoryTickV0` against an ephemeral deterministic fake server (**zero contact with `http://127.0.0.1:8091`**):

- **8/8 valid cells (`S5`, `S8` × `R1`/`R2`/`R3`/`R4`):** `briefing-published`, proposal `created`, exact wire `max_tokens` (`4096`, `8192`, `16384`, `24576`), frozen sampling (`temp=0, top_k=1, top_p=1, min_p=0, seed=101`), `rawReasoningStored: false`.
- **1/1 exhaustion probe (`S5` × `R1`):** accurately classified as `reasoning-budget-exhausted` with zero raw reasoning leaked.

---

## 4. Live Phase B & Phase C Results (`observations/live-ledger.jsonl`)

Executed sequentially on `2026-11-27T13:10:42Z`–`2026-11-27T13:25:13Z` against `Inkling-2-Mini-Uncensored-AD-Q4_K` at `http://127.0.0.1:8091` (`llama.cpp b12622-19bc41dbb`, router role) via installed `OpenClaw 2026.11.10` under exclusive `flock`, frozen Condition C (`grounded-v1` + `status-and-coordination-v1`), `reasoningControl: "unchanged"`, pinned commit `b742f8103`.

| Phase | Cell | Tier | `max_tokens` | Wall Latency | Ex1 (`tool_calls`) Prompt / Comp | Ex2 Finish | Ex2 Prompt / Comp | Ex2 Reasoning Chars | Ex2 Visible Chars | Charged / Reserved Tokens | Published | Refusal / `terminationClass` | `rawReasoningStored` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Phase B** | `S5` × `R3` | `deep` | `16,384` | `231.5 s` | `3,977 / 74` | **`stop`** | `5,297 / 13,666` | `38,313` | **`5,430`** | `13,740 / 32,768` | **No** | `grounding-claim-unsupported` / `grounding-refused` | `false` |
| **Phase B** | `S8` × `R3` | `deep` | `16,384` | `152.8 s` | `3,973 / 70` | **`stop`** | `6,721 / 8,602` | `18,701` | **`6,503`** | `8,672 / 32,768` | **No** | `grounding-malformed` / `grounding-refused` | `false` |
| **Phase C** | `S5` × `R1` | `light` | `4,096` | `78.8 s` | `3,975 / 72` | `length` | `5,293 / 4,096` | `14,355` | `0` | `4,168 / 8,192` | **No** | `reasoning-budget-exhausted` / `reasoning-budget-exhausted` | `false` |
| **Phase C** | `S8` × `R1` | `light` | `4,096` | `81.1 s` | `3,972 / 69` | `length` | `6,730 / 4,096` | `14,721` | `0` | `4,165 / 8,192` | **No** | `reasoning-budget-exhausted` / `reasoning-budget-exhausted` | `false` |
| **Phase C** | `S5` × `R2` | `deliberate` | `8,192` | `140.3 s` | `3,972 / 69` | **`stop`** | `5,260 / 8,000` | `20,035` | **`5,426`** | `8,069 / 16,384` | **No** | `grounding-claim-unsupported` / `grounding-refused` | `false` |
| **Phase C** | `S8` × `R2` | `deliberate` | `8,192` | `146.4 s` | `3,974 / 71` | `length` | `6,695 / 8,192` | `29,253` | `0` | `8,263 / 16,384` | **No** | `reasoning-budget-exhausted` / `reasoning-budget-exhausted` | `false` |
| **Opt. D** | `S5`/`S8` × `R4` | `extended` | `24,576` | — | — | — | — | — | — | — | **Not run** | Stopped per `PROTOCOL.md` §3 (`R3` already finished with `finishReason: "stop"`) | — |

### Aggregate Live Accounting & Telemetry Summary
- **Total live turns executed:** `6 / 6` authorized across Phases B + C (`0` timeouts, `0` crashes, `0` retries, `100%` `tickOk: true`, `100%` `usageReportComplete: true`).
- **Total reserved tokens:** `114,688` (`65,536` Phase B + `49,152` Phase C).
- **Total charged generated tokens:** `47,077` (`41.0%` of reservation).
- **Total live wall-clock time:** `830.9 s` (`13.85 min`).
- **Observed effective decode throughput:** `~57–59 tok/s` across all 6 turns (matching historical RTX 4090 baseline).
- **Raw reasoning text stored:** `0` bytes (`rawReasoningStored: false` on 6/6 turns).

---

## 5. Dose-Response & Comparative Analysis

### 5.1 Completion-Budget Curve (`R0` → `R1` → `R2` → `R3`)
| Metric | `R0` (`2,048`, S2-LIVE-002) | `R1` (`4,096`) | `R2` (`8,192`) | `R3` (`16,384`) |
|---|---|---|---|---|
| Completed reasoning & emitted visible output (`finishReason: "stop"`) | `0 / 2` (`0%`) | `0 / 2` (`0%`) | `1 / 2` (`50%`: `S5` only) | **`2 / 2` (`100%`)** |
| Exhausted inside reasoning (`reasoning-budget-exhausted`) | `2 / 2` *(legacy `runtime-unavailable`)* | `2 / 2` (`100%`) | `1 / 2` (`50%`: `S8` only) | **`0 / 2` (`0%`)** |
| Passed `grounded-v1` validation & published | `0 / 2` (`0%`) | `0 / 2` (`0%`) | `0 / 2` (`0%`) | **`0 / 2` (`0%`)** |

### 5.2 Key Scientific Findings
1. **Budget starvation WAS a genuine blocker at `2,048` and `4,096` (and for `S8` at `8,192`), and `R3 = 16,384` completely resolved it:**
   - Every turn under `R0` (`2,048`) and `R1` (`4,096`) ran out of tokens inside internal reasoning (`0` visible chars).
   - Under `R3` (`16,384`), both `S5` (`13,666` Ex2 tokens) and `S8` (`8,602` Ex2 tokens) finished cleanly (`finishReason: "stop"`, `openclawExitOk: true`) and emitted complete visible responses (`5,430` and `6,503` visible chars).
   - Note on fixture-ID trajectory variance: even under deterministic sampling (`temp=0, top_k=1, seed=101`), isolated temp fixtures generate fresh random `endo.task.*` / `endo.assignment.*` UUIDs and timestamps, causing reasoning length to vary across runs (`S5` used `8,000` Ex2 tokens in `R2` vs `13,666` in `R3`, while emitting nearly identical `5,426` vs `5,430` visible chars; `S8` exceeded `8,192` in `R2` vs `8,602` in `R3`).
2. **Sufficient completion budget did NOT establish `grounded-v1` competence on `Inkling-2-Mini` (`0/6` published, `0/3` among completed outputs):**
   - On **`S5-W8-mixed-head`**, both completed turns (`S5::R2` and `S5::R3`) produced valid `endo.coordinator-grounded-brief.v1` JSON that passed schema parsing, but **failed subject-scoped claim verification (`grounding-claim-unsupported`)** — meaning Inkling-2-Mini asserted at least one unsupported claim/predicate/rationale against the snapshot, and the validator caught and blocked it!
   - On **`S8-multi-agent`**, the completed turn (`S8::R3`) emitted `6,503` visible chars and **failed `endo.coordinator-grounded-brief.v1` schema parsing (`grounding-malformed`)**.
   - Visible output size (`5,426–6,503` chars) is notably larger than a minimal valid `grounded-v1` payload (~`1,000–1,500` chars), indicating verbose/redundant claims or wrapper formatting.
3. **Comparison Against Zero-Token Deterministic Baselines (§12):**
   - With `0/6` published briefings after `47,077` generated tokens and `13.85` minutes of GPU inference, the three deterministic baselines (`status-v0`, `coordination-v0`, and `staticPriorityBaseline` at `0` tokens and `< 0.1 s`) strictly outperformed `Inkling-2-Mini` under the frozen `grounded-v1` contract on both `S5` and `S8`.
4. **Epistemic Integrity Held 100%:**
   - Not a single malformed or ungrounded claim was published or converted into an operator proposal (`0/6` false publications, `0/6` unauthorized proposals, `0/6` tool or authority boundary violations).
5. **Actionable Diagnostic Gap Identified for Next Mission:**
   - Because `EndoCoordinatorBriefDiagnosticsV1` records only the closed refusal code (`grounding-malformed` / `grounding-claim-unsupported`) and not a sanitized validator failure path/code, we cannot see *which* exact field or claim predicate failed in `S5::R2`, `S5::R3`, and `S8::R3` without adding a bounded, non-text `groundingFailureDetail` (e.g., failing JSON path + predicate name, never raw model text) to diagnostics in a future follow-up.
