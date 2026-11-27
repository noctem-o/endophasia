# S2-LIVE-002 Grounding & Coordination Visibility Design Notes

This note records the design trade-offs, rejected alternatives, and security evolution for `COORDINATOR-GROUNDING-002`. Full implementation contracts live in [docs/designs/coordinator-grounding-002-implementation.md](../../../docs/designs/coordinator-grounding-002-implementation.md); the independent adversarial security review and all 14 remediations are recorded in [ADVERSARIAL-REVIEW.md](./ADVERSARIAL-REVIEW.md).

---

## 1. Alternatives Considered for Subject-Scoped Grounding

| Option | Summary | Disposition |
| :--- | :--- | :--- |
| **Option 1: Regex task-ID extraction over free-form prose** | Parse sentences in free-form prose and attribute absence/positive claims to nearby `endo.task.*` IDs. | **Rejected (§4 prohibited shortcut).** Pronoun resolution, conjunctions, multi-task clauses, and paraphrases make free-text attribution brittle and easily bypassed. |
| **Option 2: Second-LLM factuality judge** | Send model prose + snapshot to a second LLM to score groundedness. | **Rejected (§4).** Adds latency, token cost, and non-deterministic verification for facts Endophasia already holds in closed structured projections. |
| **Option 3a (Initial v1 draft): Typed claims + bounded single-line `rationale` prose with regex guard** | Model emits strict JSON with typed claims, typed uncertainties, and single-line `rationale` (<= 240 chars) checked by regex anti-bypass rules. | **Superseded after independent adversarial review (Finding C1).** Independent review demonstrated 5 distinct bypasses in the free-prose `rationale` field (non-task `supportingRefs`, multi-task `.every(...)` laundering, regex lookbehind negation, paraphrases, and invisible Unicode). |
| **Option 3b (Final hardened v1): Typed claims + closed host-rendered `rationaleCode` + unconditional host disclosures (`endo.coordinator-grounded-brief.v1`)** | Model emits strict JSON with typed claims, typed uncertainties, closed recommendations (`kind`, `priority`, `supportingRefs`, closed `rationaleCode`), and optional `proposalEligibility`-checked proposal. **Zero model-supplied free prose enters the rendered briefing.** Host verifies every field against an evidence index built exclusively from `modelView` and unconditionally appends host completeness/truncation disclosures. | **Selected.** Mechanically resolves W8–W10 and positive-contradiction collisions, preserves Phase B-1 protective refusals, eliminates free-prose bypasses structurally, prevents host-only validation leakage, and preserves interpretive prioritization & correlation under explicit untrusted labeling. |

---

## 2. Alternatives Considered for Coordination Visibility

| Option | Summary | Disposition |
| :--- | :--- | :--- |
| **Option 1: Add a second tool (`endophasia_coordination`)** | Give OpenClaw a second read-only tool. | **Rejected (§5).** Expands tool surface, doubles relay/wire complexity, and breaks the single-tool (`endophasia_status`) M0/M1 invariant. |
| **Option 2: Include raw `endo.coordinator-coordination.v0` inside `endophasia_status`** | Pass raw coordination JSON verbatim. | **Rejected.** Leaks host filesystem `worktreePath` strings, session keys, operator labels, and risks unbounded payload size. |
| **Option 3: Bounded, path-redacted, severity-prioritized coordination section inside `endo.coordinator-model-view.v1` + `proposalEligibility`** | Single `endophasia_status` tool returns `endo.coordinator-model-view.v1`, enforcing strict single-project scope, redacting host paths/session keys/labels, prioritizing hazardous/active/unsatisfied/critical-conflict records, declaring `sourceState`/`completeness`/`truncated`/`omitted`, and hashing the entire view into `modelViewSha256`. | **Selected.** Preserves single-tool invariant, zero cross-project disclosure, offline liveness honesty (`liveness: "unknown"`, `terminationConfirmed: false`), and exact snapshot identity binding. |

---

## 3. Conceptual Grounding Lineage

- **FActScore (Min et al., EMNLP 2023, https://aclanthology.org/2023.emnlp-main.741/):** Decomposing generated outputs into atomic, independently verifiable factual claims rather than scoring whole paragraphs monolithically motivates our subject-scoped atomic claim representation.
- **Claim-level verification & epistemic calibration (https://arxiv.org/abs/2406.19276):** Separates verifiable atomic claims from uncertain or interpretive statements; in Endophasia, because authoritative structured projections already exist, verification is strictly mechanical rather than relying on an auxiliary judge LLM.

---

## 4. Payload & Prompt Budget Analysis

- Grounded system instructions (`ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_V1`): **4,922 bytes**.
- Grounded proposal question (`ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_V1`): **275 bytes**.
- Combined prompt with project header: **~5,280 bytes** against the unchanged **8,192-byte** `maxPromptBytes` ceiling (64.5% utilization; ~2.9 KiB headroom).
- Rendered briefing output ceiling: **4,096 bytes** enforced directly inside `validateAndRenderGroundedBriefV1` (matching S2's `L.maxAnswerBytes`).
- Bounded coordination caps (`maxAssignments: 16`, `maxDependencies: 24`, `maxCandidates: 24`, `maxWorktrees: 16`, `maxConflicts: 16`, `maxReviews: 16`) keep `EndoCoordinatorModelViewV1` well below the **256 KiB** tool-result cap and **512 KiB** relay request cap while unconditionally rendering host disclosures with exact `omitted` counts whenever caps bind.
