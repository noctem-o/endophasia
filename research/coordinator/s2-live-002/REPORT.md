# S2-LIVE-002 Research Report: Evidence-Scoped Coordinator Cognition & Comparative Live Evaluation

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Stacked Draft PR #193 Target:** `research/s2-live-001` (PR #192 head `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`, preserved untouched and unmerged)  
**Upstream Baselines Verified:** `origin/main` = `2f730eb680e87d04d3a41bbb9d398e6b9a97794c`; OpenClaw `2026.11.10` remediation = `ce126a53a`  
**Frozen Experimental Commit:** `b1c6b7be989fe7ca21ed1cdfbd5266b310684d7e`  
**Stage 2 Live Inference Executed:** **24 / 24 bounded turns** (`44,757` charged generated tokens out of `98,304` authorized ceiling; sequential under `flock -n`; zero prompt/validator/condition modifications during execution; Phase D remains unauthorized and unactivated).

---

## 1. Executive Summary

`COORDINATOR-GROUNDING-002` successfully built, adversarially hardened (14/14 substantiated findings remediated), and deterministically verified (23-item acceptance matrix + installed OpenClaw `2026.11.10` 24-cell fake-provider dry run + Stage 1 offline replay) three architectural upgrades addressing the failure modes discovered in `S2-LIVE-001`:

1. Versioned subject-scoped typed grounding (`endo.coordinator-grounded-brief.v1`, zero model-supplied prose in rendered briefings, closed host-rendered `rationaleCode`, unconditional host completeness disclosures, disclosed `proposalEligibility` verification).
2. Single-tool bounded, path-redacted, strictly single-project coordination visibility (`endo.coordinator-model-view.v1` inside `endophasia_status`).
3. Pre-dispatch non-inference preflight (`preflightOpenClawCoordinatorV0` in S2 Phase D.5, preventing token charges on local runtime mismatches).

**However, Stage 2 live paired comparisons against `Inkling-2-Mini-Uncensored-AD-Q4_K` (24 bounded live turns across Conditions A, B, and C) produced a decisive negative empirical finding:**

- **Condition A (`legacy-v0`, `status-v0`):** **4 / 8 (50.0%)** published (`S2`, `S3`, `S4`, `S8`), **4 / 8** refused (`1` protective `event-absence-unestablished` on `S1`, `2` false-positive `receipt-absence-unestablished` collisions on `S5` & `S7`, `1` `runtime-unavailable` at `2,119` completion tokens on `S6`); `3` grounded proposals created (`S3`, `S4`, `S8`), `1` ungrounded proposal refused (`S2`).
- **Condition B (`grounded-v1`, `status-v0`):** **0 / 8 (0.0%)** published (`2` `generation-limit`, `6` `runtime-unavailable`). Every turn hit **`2,115–2,119` completion tokens** (~70 exchange-1 tool-call tokens + full `2,048`-token ceiling on exchange 2).
- **Condition C (`grounded-v1`, `status-and-coordination-v1`):** **0 / 8 (0.0%)** published (`8` `runtime-unavailable`). Every turn hit **`2,115–2,125` completion tokens** (100% exhaustion of the `2,048`-token exchange-2 ceiling inside internal reasoning).
- **Stage 3 Independent Qualitative Evaluation:** **0 / 4** published live briefings achieved a positive value delta (`+1` or `+2`) over Endophasia's deterministic `status` + `coordination` + `proposalEligibility` outputs (`BRIEF-01`: `-1`, `BRIEF-02`: `0`, `BRIEF-03`: `0`, `BRIEF-04`: `-2` harmful/misleading due to silent coordination blindness on S8). Even on synthetic dry-run renders of `grounded-v1`, the closed 18-code `rationaleCode` format traded away cross-entity relational synthesis and readability for mechanical integrity.
- **Phase D Readiness Verdict:** **`blocked`**.

---

## 2. Direct Answers to All Six Stage 2/3 Evaluation Questions

1. **Did the live model resolve the previously problematic mixed-verification scenarios (`S5`, `S6`, `S7`)?**  
   **No (in live execution).** While Stage 1 offline replay and the 24-cell fake-provider dry run proved that `endo.coordinator-grounded-brief.v1` mechanically resolves `S5/S6/S7` (`3/3` published in B & C vs `0/3` in A), live `Inkling-2-Mini` exhausted its `2,048`-token completion budget inside internal reasoning on **16/16** `grounded-v1` turns (`0/6` published on `S5/S6/S7` across B & C). Meanwhile, Condition A again hit `receipt-absence-unestablished` on `S5` and `S7` and hit `2,048`-token reasoning exhaustion on `S6` (`ct=2119`).
2. **Did Condition C make useful coordination-aware recommendations beyond Condition B?**  
   **No (`0/8` published in both B and C).** Condition C's bounded coordination projection delivered real multi-agent evidence into the sandboxed OpenClaw relay (confirmed by `+1,878` prompt tokens on `S8`: `10,681` in C vs `8,803` in B), but `Inkling-2-Mini` exhausted `2,048` completion tokens before emitting any valid JSON output.
3. **Does the closed `rationaleCode` vocabulary limit useful synthesis?**  
   **Yes — materially.** Independent Stage 3 evaluation of the `grounded-v1` rendered format (`observations/stage3-blinded-evaluation.md`) confirmed that replacing free prose with 18 host-rendered single-sentence templates eliminates hallucination and self-contradiction, but reduces complex multi-agent state (S8) to **disconnected flat triples** lacking task↔assignment↔dependency↔conflict↔review links, cross-action prioritization explanation, and severity counts. Furthermore, demanding strict compliance with 11 subject kinds, 35 predicates, 13 uncertainty codes, 12 recommendation kinds, 18 rationale codes, and exact 32-hex `evidenceRef`s directly triggered the `100%` reasoning-token exhaustion on `Inkling-2-Mini` under the `2,048`-token ceiling.
4. **Did recommendations provide measurable value beyond deterministic rules and status summaries?**  
   **No (`0/4` live published turns achieved `+1` or `+2`).** On single-task states (`S2`, `S3`), Condition A spent 26–30 s and ~7,200–7,500 tokens to restate deterministic JSON (and emitted an ungrounded proposal on `S2`). On `S4`, it matched a 1-line deterministic severity ranker (`failing > awaiting-review`) while contradicting itself (`"fresh"` vs `"stale"`). On `S8`, it scored `-2` (harmful/misleading) by hiding all coordination hazards. Even synthetic `grounded-v1` renders scored `0` (parity) against a deterministic host renderer + `proposalEligibilityC`.
5. **Did additional model-visible evidence increase inference costs?**  
   **Yes — substantially:**
   - **Prompt tokens (mean/turn):** Condition A `6,355` -> Condition B `8,695` (**`+36.8%`** from grounded schema instructions + `modelView v1`) -> Condition C `9,140` (**`+43.8%`** vs A; **`+5.1%`** vs B; and **`+65.9%`** on `S8` at `10,681` vs `6,438` in A).
   - **Completion tokens (mean/turn):** Condition A `1,357` -> Condition B `2,118` (**`+56.1%`**) -> Condition C `2,120` (**`+56.2%`**).
   - **Wall-clock latency (mean/turn):** Condition A `32.3 s` -> Condition B `46.3 s` (**`+43.1%`**) -> Condition C `47.2 s` (**`+46.0%`**).
   - **Completion tokens per published briefing:** Condition A `2,715` -> Conditions B & C **∞** (`16,942 / 0` and `16,957 / 0`).
6. **Honest handling of unavailable candidate identity, worktree observations, and session liveness:**  
   Mechanically verified in preflight (`stage2-preflight-manifest.json`) and 24-cell dry run (`stage2-dry-run.jsonl`): S2's `defaultObserveAdvisoryProjectV0` honestly reports `C1.identity: "unavailable"`, `worktrees[0].observation: "unavailable"`, and `session.liveness: "unknown"` / `terminationConfirmed: false`. In live execution, Condition C never published a turn (`0/8`), while Condition A on `S8` failed this boundary at the system level by publishing `"No linked sessions recorded for either task; sessions list is empty"` without disclosing that coordination was unread.

---

## 3. Runtime Verification, Warm State & Configuration Notes

Recorded in [observations/stage2-runtime-verification.json](./observations/stage2-runtime-verification.json) prior to Turn 1:
- **Warm state:** `Inkling-2-Mini-Uncensored-AD-Q4_K` (`26.07B` params, `Q4_K - Medium`, `ctx_size: 131,072`, `parallel: 1`) was already `status: "loaded"` (2 `llama-server` processes resident) before Turn 1 — zero cold-load confound across the 24 turns.
- **Effective sampling vs server preset:** Server preset defaults (`temperature: 1.0, top_k: 0`) were overridden per-request by the Endophasia OpenClaw plugin (`temperature: 0, top_k: 1, top_p: 1, min_p: 0, seed: 101, max_tokens: 2048`).
- **Critical runtime discovery:** Although OpenClaw is invoked with `--thinking off`, the `llama.cpp` Jinja chat template for `Inkling-2-Mini-Uncensored-AD-Q4_K` continues generating internal `reasoning_content` tokens inside the `max_tokens: 2048` budget, causing silent reasoning-only exhaustion (`runtime-unavailable`) whenever reasoning exceeds `2,048` tokens.

---

## 4. Honest Research Classifications (Post-Stage-2 & Stage-3)

| Dimension | Classification | Measured Evidence Basis |
| :--- | :---: | :--- |
| **Mechanical subject-scoped grounding & coordination projection contract** | **supported** | Deterministically verified across 23-item matrix, 14 adversarial regressions, Stage 1 offline replay (`5/5`), and 24-cell installed-OpenClaw dry run (`24/24`). Fail-closed integrity held `100%` in live execution (`0` malformed/ungrounded `grounded-v1` outputs leaked). |
| **Pre-dispatch non-inference preflight & crash-proof accounting** | **supported** | Verified in unit/integration tests and live 24-turn run (`44,757 / 98,304` charged tokens, exact usage reconciliation, `0` leaked temp dirs, `0` concurrent runs under `flock -n`). |
| **Live `Inkling-2-Mini` usability & publication improvement under `grounded-v1` (`2,048`-token cap)** | **not supported** | **0 / 16** live turns published (`0/8` Condition B, `0/8` Condition C) due to `100%` 2,048-token reasoning exhaustion; `+37–44%` prompt tokens, `+56%` completion tokens, `+43–46%` latency. |
| **Live Coordinator advisory value beyond deterministic summaries** | **not supported** | **0 / 4** published live turns achieved a `+1` or `+2` value delta (`-1`, `0`, `0`, `-2`); closed 18-code templates also scored `0` on synthetic renders due to loss of cross-entity relational synthesis. |
| **Phase D 24-hour naturalistic deployment readiness** | **blocked** | `grounded-v1` has `0%` live publication on `Inkling-2-Mini` under current token/thinking controls; `legacy-v0` has `50%` publication with false-positive collisions, ungrounded proposals, and harmful (`-2`) coordination blindness. |

---

## 5. Recommended Next Engineering Steps (Before Any Future Live Experiment)

Do **not** weaken grounding or authority boundaries, and do **not** activate Phase D. Before reconsidering live Coordinator automation:

1. **Control reasoning tokens explicitly at the local inference boundary:** Investigate `llama.cpp` reasoning controls (`reasoning_budget` / `chat_template_kwargs: { enable_thinking: false }`) or test a non-reasoning local model / grammar-constrained (`json_schema` / GBNF) decoding mode — and expose `reasoning_content` exhaustion as a distinct refusal reason (e.g., `reasoning-budget-exhausted`) rather than conflating it with `runtime-unavailable`.
2. **Simplify the model's output contract & let the host render structured facts deterministically:** The host already knows every fact in `modelView` (and every relational edge `task ↔ assignment ↔ dependency ↔ conflict ↔ review`). Instead of forcing a 26B local model to transcribe 16 claims and 32-hex IDs back to the host in JSON (burning ~2,000 reasoning tokens to echo known state), have the **host deterministically render the relational status + coordination brief**, and restrict any optional LLM turn strictly to high-salience cross-entity triage/prioritization (skipping LLM inference completely on trivial single-task states like `S2` and `S3`!).
3. **Fix Condition A / S2 proposal hygiene:** Strip refused `PROPOSAL:` lines from operator-visible briefing text so a refused proposal (like `S2/A`'s `investigate-incomplete-verification`) is never displayed alongside `PROPOSAL: ...` as if valid.
4. **F1/F2 Studio implication:** Prioritize deterministic relational views of `endo.coordinator-model-view.v1` in Studio first; add optional LLM advisory overlays only after controlled live evaluation demonstrates a real `+1`/`+2` value delta over deterministic views.

---

## 6. Privacy & Redaction Audit Note

All Stage 2 and Stage 3 files under `research/coordinator/s2-live-002/` were inspected before commit:
- `stage2-runtime-verification.json` had raw local binary/model paths from `/v1/models` redacted (`hostPathsRedacted: true`).
- Zero API keys, bearer tokens, credentials, or `/home/` operator paths exist in `observations/stage2-paired-live.jsonl`, `observations/stage2-runtime-verification.json`, `observations/stage3-blinded-evaluation.md`, or any report/script file.
- PR #192 (`research/s2-live-001` @ `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`) remains open, draft, and untouched; Phase D remains unauthorized and unactivated.
