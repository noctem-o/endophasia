# S2-LIVE-002 Stage 3 Independent Qualitative Evaluation

**Evaluator:** Independent read-only `research` subagent (`conversationId: e0864ee5-c0d8-482f-83c6-1e219a56aa8f`)  
**Inputs Inspected:** Anonymized Stage 3 evaluation packet (all 4 published live briefings + deterministic controller ground truth + 2 synthetic zero-inference `grounded-v1` dry-run reference renders) and `research/coordinator/s2-live-001/EVALUATION-RUBRIC.md`.

---

## 1. Blinding & Denominator Audit

Arm-level blinding is **structurally broken** for four compounding reasons, and no valid blinded A/B/C comparison can be claimed from this dataset:

1. **Zero-denominator collapse across two of three arms (4/8 vs 0/8 vs 0/8):** Out of 24 live turns across Conditions A (`legacy-v0`), B (`grounded-v1` status-only), and C (`grounded-v1` + coordination), only **4/24 (16.7%)** published a briefing. All 4 came exclusively from Condition A (`legacy-v0`), while Conditions B and C published **0/8** and **0/8** (**0/16 combined**) due to 2,048-token completion/reasoning exhaustion. Comparative evaluation across arms is statistically and qualitatively impossible when two arms have zero published outputs.
2. **Trivial format unblinding:** Condition A emits free-form bulleted prose ending in `PROPOSAL: ...`, whereas `grounded-v1` renders host-templated sections (`Verified facts (snapshot ...)`, `Snapshot disclosures`, `Uncertainties`, `Advisory recommendations`, `PROPOSAL:`) with inline `ev:` pointers. Even if `grounded-v1` had published live turns, output structure alone immediately identifies the arm.
3. **Substitution of synthetic dry-run outputs for live model behavior:** Part 2 (`DRY-RUN-CLOSED-FORMAT`) contains zero-inference host renders from S4 and S8, **not** live model outputs. They can only evaluate the expressiveness ceiling of the rendered template format—they provide zero evidence of whether a live model can accurately select facts, rationales, or proposals under token/latency constraints.
4. **Packet scope notes:** `BRIEF-01` is a *published* Condition A briefing whose proposal was refused (`proposal-ungrounded`), while the 20 unpublished turns (16 from B/C, 4 from A) sit outside the published text sample and are audited in the full 24-cell ledger (`observations/stage2-paired-live.jsonl`). `source.currency` (recorded in the full ledger as `current-at-publication` for all 4 published turns) and timestamps were omitted from the anonymized text packet, so `Timely` was marked `n/a` by the blind grader rather than assumed.

---

## 2. Per-Briefing Rubric Grading (`BRIEF-01` through `BRIEF-04`)

Graded against all 6 dimensions of `EVALUATION-RUBRIC.md` §2 (`pass` / `partial` / `fail` / `n/a`) and §3 Value Delta (`+2` to `-2`), anchored strictly to the deterministic controller ground truth (`endo.coordinator-status.v0` + `endo.coordinator-coordination.v0`).

| Briefing | Scenario / Arm | Factually grounded | Relevant | Novel | Timely | Actionable as advice | Uncertainty calibration | Proposal accuracy | Value delta | Accounting |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **BRIEF-01** | `S2-W0-unassigned` / A | `partial` | `partial` | `fail` | `n/a` | `partial` | `partial` | **Fail** (`proposal-ungrounded`, refused by host) | **`-1` (Net drag)** | 6,250p / 945c / 25.7s |
| **BRIEF-02** | `S3-W3-blocked` / A | `pass` | `pass` | `fail` | `n/a` | `pass` | `pass` | **Pass** (`resolve-blocked-task`, created) | **`0` (Neutral / parity)** | 6,303p / 1,204c / 29.8s |
| **BRIEF-03** | `S4-W6-review-fail` / A | `partial` | `pass` | `partial` | `n/a` | `pass` | `partial` | **Pass** (`review-failing-verification`, created) | **`0` (Neutral / parity)** | 6,566p / 1,668c / 37.4s |
| **BRIEF-04** | `S8-multi-agent` / A | `fail` | `fail` | `fail` | `n/a` | `partial` | `fail` | **Partial / Misprioritized** (`review-awaiting-review` created; missed `investigate-liveness-hazard`) | **`-2` (Harmful / misleading)** | 6,438p / 1,452c / 33.9s |

### Key Briefing Findings
- **`BRIEF-01` (`S2-W0-unassigned`, A):** Prose bullets match status snapshot, but emitted `PROPOSAL: investigate-incomplete-verification` directly contradicts `incomplete: false` / `no-checks` / `proposalEligibility: []` (refused by host as `proposal-ungrounded`). Pure field-by-field recitation; net drag (`-1`).
- **`BRIEF-02` (`S3-W3-blocked`, A):** Accurate, well-calibrated, valid `resolve-blocked-task` proposal created; adds zero value beyond instant deterministic status + `proposalEligibility` (`0`).
- **`BRIEF-03` (`S4-W6-review-fail`, A):** Mild prioritization (picking `review-failing-verification` over `review-awaiting-review`), offset by an internal self-contradiction (Bullet 2 reports `failed at-head result (fresh, not incomplete)`, then Bullet 4 claims it cannot establish `"whether the failing check is a real regression or stale"`), overstated absence (`"so no one reported or observed recent activity"`), and truncated 4-char ID for `T2` (`52fe…`). Net parity (`0`).
- **`BRIEF-04` (`S8-multi-agent`, A):** Against full controller ground truth, fails grounding, relevance, and calibration (`-2` harmful/misleading): claims `"No linked sessions recorded for either task; sessions list is empty"` while missing revoked builder `A1` (`hazard: "liveness-unverified"`, `terminationConfirmed: false`), active builder `A2` (`shared-writable-worktree-acknowledged` conflict), unsatisfied `T1 -> T2` dependency `D1`, active reviewer `A3` (`prerequisites-not-satisfied`), and `changes-requested` (1 high, 1 medium) review on `C1`.

---

## 3. Value Beyond Deterministic Status Summaries & Rules

Across **all 4 published live briefings (`0/4` positive value delta) AND both synthetic closed-rationale renders (`0/2` positive value delta)**, LLM interpretation added **zero demonstrated net operator value** over Endophasia's deterministic `endo coordinator status` + `endo coordinator coordination` + deterministic `proposalEligibility`:
- On trivial 1-task states (`BRIEF-01`, `BRIEF-02`), 25–30 s and ~7,200–7,500 tokens merely paraphrased 5 JSON fields (and introduced an ungrounded proposal on `BRIEF-01`).
- On `BRIEF-03`, a 1-line deterministic severity ranker (`failing > awaiting-review`) reproduces the prioritization in <5 ms without the `"fresh"` vs `"stale"` self-contradiction.
- On `BRIEF-04`, Condition A hid every critical coordination hazard.
- On `DRY-RUN-CLOSED-FORMAT` (S4 & S8), every fact, disclosure, and uncertainty line is host-rendered deterministic state, and each recommendation maps 1-to-1 to a deterministic `proposalEligibilityC` predicate.

---

## 4. Closed `rationaleCode` Vocabulary Synthesis Trade-Off

*(Strict disclaimer: `DRY-RUN-CLOSED-FORMAT` S4 and S8 are synthetic zero-inference renders, NOT live model outputs.)*

### What Is Gained
- **Elimination of prose hallucination and self-contradiction** (e.g., `BRIEF-03`'s `"fresh"` vs `"stale"` contradiction cannot occur).
- **Hard visual & epistemic trust boundaries** separating verified facts, host disclosures, uncertainties, and advisory recommendations.
- **Canonical full IDs and `ev:` provenance** plus elimination of brittle project-wide wording-collision refusals.
- **Coordination exposure in Condition C** (`liveness-unverified`, `dependency-satisfaction: unsatisfied`, `review-verdict: changes-requested`, `termination-unconfirmed`, `advisory-review-not-host-check`).

### What Is Lost
1. **Cross-entity causal & relational synthesis:** In S8, the real operational story is a connected chain (*do not approve `T1` yet because `T1` depends on `T2` via `D1`, `T2`'s candidate `C1` has `changes-requested` (1H/1M) and no host receipts, and `T2` has a revoked builder `A1` with unconfirmed termination sharing a writable worktree with active builder `A2`*). The closed format emits **disconnected flat triples** where an operator cannot even see which task `assignment 50be...`, `dependency e957...`, or `review 613b...` belong to!
2. **Cross-action prioritization rationale:** A single canned sentence from 18 templates cannot explain *why* `investigate-liveness-hazard` preempts `review-awaiting-review` across tasks.
3. **Compounding-risk & quantitative nuance:** Drops `shared-writable-worktree-acknowledged` conflict details, `A3`'s `prerequisites-not-satisfied`, and `1 high, 1 medium` severity counts.
4. **Human scannability & the LLM-vs-ruleset paradox:** Repeating 32-hex IDs twice per bullet is harder to scan than a deterministic CLI table, and constraining the LLM to select 1 of 18 fixed sentences turns it into an expensive, fragile selector over deterministic predicates—while simultaneously breaking live completion (`0/16` under 2,048 tokens).

---

## 5. Phase D Readiness Verdict

### Verdict: **`blocked`**

Phase D (24-hour naturalistic operation) is unequivocally **blocked**:
- `grounded-v1` (Conditions B & C) achieved **0/16 (0%) live publication** under the 2,048-token ceiling.
- `legacy-v0` (Condition A) achieved only **4/8 (50%) live publication**, with 2/8 false-positive collisions, 1/8 reasoning exhaustion, 1/8 ungrounded proposal, `0/4` positive value deltas, and a `-2` harmful/misleading briefing on multi-agent `S8`.

### Exit Criteria Required Before Reconsidering Phase D
1. Resolve `grounded-v1` reasoning/token exhaustion and prove sustained live publication reliability (e.g., `>= 85–90%` with 0 reasoning-exhaustion refusals and bounded latency).
2. Complete a valid multi-arm live comparative evaluation with live outputs across all arms and full accounting/currency visibility.
3. Eliminate silent coordination blindness (never publish `"sessions list is empty"` while coordination is unread) and strip refused `PROPOSAL:` lines from published operator text.
4. Demonstrate genuine `+1` / `+2` value delta beyond deterministic `status` + `coordination` + `proposalEligibility` (or explicitly keep simple status/eligibility reporting 100% deterministic and reserve LLM inference strictly for relational multi-entity synthesis).
