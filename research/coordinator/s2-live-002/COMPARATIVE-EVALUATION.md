# S2-LIVE-002 Comparative Evaluation (Stage 1, Stage 2 Live, & Stage 3 Complete)

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Frozen Experimental Commit:** `b1c6b7be989fe7ca21ed1cdfbd5266b310684d7e`  
**Live Inference Executed:** **24 / 24 bounded turns** (explicitly authorized; executed sequentially under `flock -n`; warm `Inkling-2-Mini-Uncensored-AD-Q4_K` worker resident at `http://127.0.0.1:8091`; **0** prompt/validator changes during execution).

---

## 1. Stage 1 — Deterministic Offline Replay Results (0 Live Inference)

Executed via `node research/coordinator/s2-live-002/scripts/run-stage1-offline-replay.mjs` against immutable S2-LIVE-001 captured snapshots under `research/coordinator/s2-live-001/`. Raw evidence: [observations/stage1-offline-replay.json](./observations/stage1-offline-replay.json).

- **False-positive multi-task collisions resolved mechanically:** `3 / 3` (`W8`, `W9`, `W10` equivalent fixtures publish cleanly under B and C vs `0 / 3` under legacy regex).
- **Protective refusals preserved:** `1 / 1` (`B-1` unsupported `session-activity: "none-linked"` refused as `event-absence-unestablished`; `4 / 4` acceptance states refused as `receipt-absence-unestablished`).
- **Host-only validation isolation:** `1 / 1` (Condition C assignment claim rejected under Condition B; Condition B guessing coordination proposal rejected as `grounding-claim-unsupported`).
- **Zero-inference 24-cell dry run (`observations/stage2-dry-run.jsonl`):** `24 / 24` cells passed end-to-end through installed OpenClaw `2026.11.10` + `/usr/bin/bwrap` + model relay against an ephemeral fake provider (`8 / 8` scenarios semantically equivalent across A/B/C).

---

## 2. Stage 2 — Paired Live Comparison Results (24 / 24 Turns Executed)

Raw append-only ledger (24 `turn-intent` + 24 `turn-result` rows): [observations/stage2-paired-live.jsonl](./observations/stage2-paired-live.jsonl).  
Pre-run runtime & warm-state verification: [observations/stage2-runtime-verification.json](./observations/stage2-runtime-verification.json).

### 2.1 Aggregate Comparative Scorecard (Explicit Denominators)

| Metric | Denominator | Condition A (`legacy-v0`, `status-v0`) | Condition B (`grounded-v1`, `status-v0`) | Condition C (`grounded-v1`, `status-and-coordination-v1`) |
| :--- | :--- | :---: | :---: | :---: |
| **Briefing publication rate** | Published / 8 turns | **4 / 8 (50.0%)** | **0 / 8 (0.0%)** | **0 / 8 (0.0%)** |
| **Refusal: `runtime-unavailable` (2,048-tok reasoning-only exhaustion)** | Refusals / 8 turns | 1 / 8 (`S6`, `ct=2119`) | **6 / 8** (`ct=2115–2119`) | **8 / 8** (`ct=2115–2125`) |
| **Refusal: `generation-limit` (2,048-tok truncated output)** | Refusals / 8 turns | 0 / 8 | **2 / 8** (`S1`, `S2`, `ct=2118–2119`) | 0 / 8 |
| **Refusal: `grounding-malformed` / `grounding-claim-unsupported`** | Refusals / 8 turns | N/A | **0 / 8** *(never reached validator)* | **0 / 8** *(never reached validator)* |
| **Refusal: `event-absence-unestablished` (protective)** | Refusals / 8 turns | **1 / 8** (`S1`) | 0 / 8 | 0 / 8 |
| **Refusal: `receipt-absence-unestablished` (false-positive collision)** | Refusals / 8 turns | **2 / 8** (`S5`, `S7`) | 0 / 8 | 0 / 8 |
| **Unsupported factual claims released** | Published briefings | 1 / 4 (`BRIEF-04` blind to coord; plus `BRIEF-03` fresh/stale contradiction) | **0 / 0** *(0 published)* | **0 / 0** *(0 published)* |
| **Grounded proposals created** | Created / 6 proposal turns (`S2–S6, S8`) | **3 / 6** (`S3`, `S4`, `S8`) | **0 / 6** | **0 / 6** |
| **Ungrounded proposals refused (`proposal-ungrounded`)** | Refused / 6 proposal turns | **1 / 6** (`S2`) | 0 / 6 *(6 `briefing-unavailable`)* | 0 / 6 *(6 `briefing-unavailable`)* |
| **Coordination info used accurately** | Coord-present turns (`S5–S8`) | **0 / 4** *(not disclosed)* | **0 / 4** *(not disclosed)* | **0 / 4** *(0 published)* |
| **Total / Mean prompt tokens** | Across 8 turns | 50,840 / **6,355** | 69,560 / **8,695** (`+36.8%` vs A) | 73,121 / **9,140** (`+43.8%` vs A) |
| **Total / Mean completion tokens** | Across 8 turns | 10,858 / **1,357** | 16,942 / **2,118** (`+56.1%` vs A) | 16,957 / **2,120** (`+56.2%` vs A) |
| **Completion tokens per published briefing** | Total completion / published | **2,715** (`10,858 / 4`) | **∞** (`16,942 / 0`) | **∞** (`16,957 / 0`) |
| **Mean wall-clock latency / inference latency** | Across 8 turns | **32.3 s** / 32.3 s | **46.3 s** / 46.2 s (`+43.1%`) | **47.2 s** / 47.2 s (`+46.0%`) |
| **Total charged generated tokens (all 24 turns)** | 24 turns (`98,304` ceiling) | 10,858 | 16,942 | 16,957 (**44,757 total / 45.5% of ceiling**) |

### 2.2 Complete 24-Cell Live Matrix

| Scenario | Order | Cond A (`legacy-v0`) | Cond B (`grounded-v1`, `status-v0`) | Cond C (`grounded-v1`, `coord-v1`) |
| :--- | :---: | :--- | :--- | :--- |
| **`S1-B1-partial`** | ABC | Refused: `event-absence-unestablished` (`6,100p / 669c / 21.5s`) — protective | Refused: `generation-limit` (`8,450p / 2,118c / 45.9s`) | Refused: `runtime-unavailable` (`8,598p / 2,123c / 46.2s`) |
| **`S2-W0-unassigned`** | BCA | **Published** (`6,250p / 945c / 25.7s`); proposal refused: `proposal-ungrounded` (`investigate-incomplete-verification`) | Refused: `generation-limit` (`8,522p / 2,119c / 45.8s`) | Refused: `runtime-unavailable` (`8,656p / 2,120c / 46.1s`) |
| **`S3-W3-blocked`** | CAB | **Published** (`6,303p / 1,204c / 29.8s`); proposal created: `resolve-blocked-task` | Refused: `runtime-unavailable` (`8,570p / 2,117c / 46.0s`) | Refused: `runtime-unavailable` (`8,723p / 2,118c / 46.3s`) |
| **`S4-W6-review-fail`** | ABC | **Published** (`6,566p / 1,668c / 37.4s`); proposal created: `review-failing-verification` | Refused: `runtime-unavailable` (`8,897p / 2,115c / 46.5s`) | Refused: `runtime-unavailable` (`9,050p / 2,121c / 46.9s`) |
| **`S5-W8-mixed-head`** | BCA | Refused: `receipt-absence-unestablished` (`6,516p / 1,285c / 31.4s`) — false-positive collision | Refused: `runtime-unavailable` (`8,876p / 2,117c / 46.6s`) | Refused: `runtime-unavailable` (`9,243p / 2,117c / 47.3s`) |
| **`S6-W9-unplanned-pass`** | CAB | Refused: `runtime-unavailable` (`6,460p / 2,119c / 44.3s`) — 2,048-tok exhaustion | Refused: `runtime-unavailable` (`8,804p / 2,119c / 46.5s`) | Refused: `runtime-unavailable` (`9,191p / 2,125c / 47.4s`) |
| **`S7-W10-digest`** | ABC | Refused: `receipt-absence-unestablished` (`6,207p / 1,516c / 34.7s`) — false-positive collision | Refused: `runtime-unavailable` (`8,638p / 2,119c / 46.4s`) | Refused: `runtime-unavailable` (`8,979p / 2,115c / 47.5s`) |
| **`S8-multi-agent`** | BCA | **Published** (`6,438p / 1,452c / 33.9s`); proposal created: `review-awaiting-review` *(blind to liveness hazard/conflicts/dep/review)* | Refused: `runtime-unavailable` (`8,803p / 2,118c / 46.6s`) | Refused: `runtime-unavailable` (`10,681p / 2,118c / 50.0s`) |

---

## 3. Root Cause Diagnosis of the `0 / 16` `grounded-v1` Live Failure

Every single Condition B (`8/8`) and Condition C (`8/8`) turn — plus Condition A on `S6-W9-unplanned-pass` (`1/8`) — completed **exactly 2 exchanges** and reported **`2,115–2,125` total completion tokens** (~67–77 tokens for the exchange-1 `endophasia_status` tool call + **exactly `2,048` tokens** on exchange 2, hitting the `max_tokens: 2048` ceiling):

1. **`Inkling-2-Mini-Uncensored-AD-Q4_K` is a reasoning model whose internal reasoning channel is not suppressed by OpenClaw's `--thinking off` flag** on this `llama.cpp` Jinja preset. Even in Condition A (`legacy-v0`), producing ~150 visible prose tokens consumed `669–1,668` completion tokens (and overflowed `2,048` on `S6-W9-unplanned-pass`).
2. **Closed-schema rule complexity + larger prompts pushed reasoning past `2,048` tokens on 100% of `grounded-v1` turns:** Condition B increased prompt size by `+36.8%` (`+2,340` tokens/turn) and Condition C by `+43.8%` (`+65.9%` on S8: `10,681` vs `6,438`), while requiring the model to reason across 11 subject kinds, 35 predicates, 13 uncertainty codes, 12 recommendation kinds, 18 rationale codes, and exact 32-hex `evidenceRef` IDs.
3. **Why `14/16` reported `runtime-unavailable` vs `2/16` `generation-limit`:** In `adapters/coordinator/openclaw.ts:491-494`, when `llama.cpp` exhausts all `2,048` tokens inside `reasoning_content` with **zero visible `content` tokens**, OpenClaw exits non-zero (`!ran.ok` -> `runtime-unavailable`, matching M1's documented `reasoning-only` refusal path). When at least one visible token appears before truncation (`S1/B`, `S2/B`), OpenClaw exits `0` and the relay reports `finish === "length"` -> `generation-limit`.
4. **Fail-closed safety held 100%:** Zero malformed JSON, zero ungrounded prose, and zero unauthorized proposals leaked past the boundary.

---

## 4. Stage 3 Independent Qualitative Evaluation Summary

Full independent report: [observations/stage3-blinded-evaluation.md](./observations/stage3-blinded-evaluation.md) (read-only evaluator `e0864ee5-c0d8-482f-83c6-1e219a56aa8f`).

- **Blinding audit:** Full arm blinding was structurally broken by the `4/8` vs `0/8` vs `0/8` publication split and structural format differences; documented transparently.
- **Live value delta across published briefings (`0 / 4` positive):** `BRIEF-01` (`S2/A`): **`-1`** (ungrounded proposal emitted in text, refused by host); `BRIEF-02` (`S3/A`): **`0`** (parity); `BRIEF-03` (`S4/A`): **`0`** (parity, with `"fresh"` vs `"stale"` self-contradiction); `BRIEF-04` (`S8/A`): **`-2`** (harmful/misleading — claimed `"sessions list is empty"` while missing revoked builder liveness hazard, shared writable worktree conflict, unsatisfied dependency, and `changes-requested` review).
- **Closed `rationaleCode` synthesis trade-off (assessed on synthetic dry-run renders):** Eliminating free prose achieves airtight factual integrity, but reduces the rendered output to disconnected flat triples + 1 of 18 canned sentences — losing cross-entity causal storytelling, prioritization rationale, and human scannability, and delivering `0` value delta over a `<5 ms`, 0-token deterministic renderer + priority ruleset.
- **Phase D readiness verdict:** **`blocked`**.
