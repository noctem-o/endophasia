# S2-LIVE-001 Evaluation Rubric

Every live Coordinator turn across Phases B, C, and D is evaluated on **two independent axes**:

1. **Mechanical Correctness** (deterministic, objective, verified from stored S2 records and host observations).
2. **Qualitative Advisory Quality** (human/operator-oriented usefulness compared directly against a deterministic status summary).

Inference frequency and proposal volume are **never** treated as measures of intelligence. Zero inference during unchanged periods is a positive result.

---

## 1. Mechanical Correctness Ledger (Per Turn / Tick)

| Field | Source | Check |
| :--- | :--- | :--- |
| `tickTimestampUtc` | Host clock | Exact UTC timestamp of tick invocation |
| `phase` | Experiment metadata | `phase-b-smoke` / `phase-c-controlled` / `phase-d-naturalistic` |
| `scheduleId` / `fireKey` | `fires/<key>.outcome.json` | Matches expected due window; no replay on repeat tick |
| `wakeReason` / `outcomeStatus` | `fires/<key>.outcome.json` | Expected wake (`first-observation`, `state-changed`, `digest-window`) vs skip (`skipped-unchanged`, `skipped-already-attempted`) |
| `endToEndLatencyMs` | Tick wall-clock measurement | Total CLI tick duration |
| `inferenceElapsedMs` | `turns/<id>.briefing.json` (`accounting.inferenceElapsedMs`) | Sandboxed OpenClaw + model server latency |
| `modelLoadingEffect` | Pre/post `llama-server` child PID check | `cold-load` (no worker before, worker after) vs `warm` vs `unloaded` |
| `reportedPromptTokens` | `accounting.reportedPromptTokens` | Server-reported prompt tokens (or `null`) |
| `reportedCompletionTokens` | `accounting.reportedCompletionTokens` | Server-reported completion tokens (or `null`) |
| `reportedReasoningTokens` | Wire/server metadata where available | Recorded if exposed by server/harness; explicitly noted as `not-recorded-by-s2-schema` when S2 `usageOf()` only aggregates `prompt_tokens` + `completion_tokens` |
| `reservedTokens` / `chargedTokens` | `accounting.reserved` / `accounting.chargedGeneratedTokens` | Reservation matches `2 * maxOutputTokens`; charge matches reported tokens when `usageReportComplete: true`, else full reservation |
| `selectedModel` & `provenance` | `briefing.model` | `selectedMemberId`, `selectedModelId`, `reportedModel`, `harness`, `provider`, `selectedReadiness`, `capacityConfirmed`, `inferenceFailover: "never"` |
| `groundingAndValidation` | `briefing.availability`, `refusal`, `source.currency`, `source.evidence` | `projectionSha256` & `modelViewSha256` present on available briefings; backstop refusal code recorded on unavailable briefings |
| `proposalOutcome` | `briefing.proposal` | `not-requested`, `none-proposed`, `created`, `deduplicated`, or `refused (<reason>)` |
| `storeIsolationCheck` | Pre/post hash outside `develop/automation/advisory/` | Zero unexpected mutations outside advisory namespace |

---

## 2. Qualitative Advisory Evaluation (Per Briefing and Proposal)

Score every published briefing and every emitted proposal on all six required dimensions (`pass` / `partial` / `fail` / `n/a`, with concise justification citing the deterministic status baseline):

1. **Factually grounded:** Every claim matches the pinned deterministic `endo.coordinator-status.v0` / `endo.coordinator-coordination.v0` snapshot without fabricating checks, sessions, statuses, or causal explanations.
2. **Relevant to the operator:** Focuses on what actually matters for operator decisions right now (e.g., failing verification at HEAD, blocked tasks, review queue, incomplete evidence) rather than boilerplate filler.
3. **Novel rather than repetitive:** Adds synthesis or highlights a genuine state transition instead of repeating prior briefings verbatim when nothing meaningful changed.
4. **Timely:** Surfaces the state change or digest promptly while still `current-at-publication` (not already overtaken by newer work).
5. **Actionable as advice:** Suggests a concrete, safe, operator-owned next step without claiming or requesting execution authority.
6. **Appropriately calibrated about uncertainty:** Distinguishes operator-declared task status, controller-observed receipts, agent-reported activity, and missing/incomplete sources without overstating absence or correctness.

---

## 3. Baseline Comparison Against Deterministic Monitoring

For each published briefing, pair it side-by-side with the deterministic CLI output captured at the same state (`endo coordinator status --root <store> --project <projectId>`):

- **Value delta rating:**
  - `+2 (Clear value add)`: Synthesizes cross-task/cross-signal state or surfaces a non-obvious priority/risk faster than scanning raw deterministic output.
  - `+1 (Mild value add)`: Readable natural-language summary that saves slight scanning effort without losing accuracy.
  - `0 (Neutral / parity)`: Restates deterministic status with no extra insight (or equivalent to a deterministic template).
  - `-1 (Net drag)`: Verbose, vague, overly hedged, repetitive, or withheld by backstop when deterministic status was immediately clear.
  - `-2 (Harmful / misleading)`: False alarm, stale recommendation, misstated evidence standing, or distracting noise.

---

## 4. Failure, Waste, and Contention Log Categories

Record every instance separately:
- **False alarms:** Advisory flags a problem that does not exist in deterministic state.
- **Missed opportunities:** Meaningful state change occurred, but Coordinator failed to surface it or emitted `PROPOSAL: none` / unparseable proposal when a grounded proposal applied.
- **Stale recommendations:** Briefing or proposal became `stale-at-publication` or `stale` before operator review.
- **Refusals:** Every `briefing-refused` / `result-withheld` / `proposal-refused` event, categorized as *protective* (correctly caught bad model output) vs *false-positive availability loss* (e.g., project-wide wording backstop withholding a true statement).
- **Resource contention:** Observed GPU/RAM/latency contention, cold-load latency spikes, or timeouts on `127.0.0.1:8091`.
- **Unnecessary reasoning:** Any inference turn triggered without meaningful operator-facing state change (outside scheduled `digest-window` turns).
