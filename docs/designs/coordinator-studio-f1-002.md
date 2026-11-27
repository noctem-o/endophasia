# COORDINATOR-STUDIO-F1-002 — Deterministic Coordinator Studio F1

**Status:** Reviewable F1 product increment (branched from `origin/main` `2f730eb680e87d04d3a41bbb9d398e6b9a97794c`)  
**Guiding Principle:** Build an evidence-aware coordination environment that is genuinely useful when every language model is unavailable.

---

## 1. Zero-Model Value & Scope

Coordinator Studio F1 extends the existing paired workspace host (`endo workspace open`) and Mission Board (`studio-ui/src/coordinator/CoordinatorWorkspace.tsx`) with four strictly read-only, deterministic operational surfaces:

1. **Deterministic Attention View (`endo.coordinator-attention-rules.v1`)**
   - Explicit documented priority ruleset over authoritative `endo.coordinator-status.v0`, `endo.coordinator-coordination.v0`, and project-scoped `endo.coordinator-studio-operations.v0`:
     - **Tier 1 (`hazard`):** Unacknowledged worktree write overlaps (`R1-WORKTREE-HAZARD`), unverified session termination (`R1-LIVENESS-UNVERIFIED`), status-vs-verification contradictions (`R1-STATUS-CONTRADICTION`), current-HEAD failing checks (`R1-CURRENT-CHECK-FAILING`).
     - **Tier 2 (`blocker`):** Agent-reported advisory reviews requesting changes or blocked (`R2-ADVISORY-REVIEW-CHANGES`), unsatisfied declared dependencies (`R2-UNSATISFIED-DEPENDENCY`), blocked tasks (`R2-TASK-BLOCKED`), shared/path-hint worktree overlaps (`R2-WORKTREE-OVERLAP`).
     - **Tier 3 (`verification`):** Tasks awaiting operator review (`R3-AWAITING-REVIEW`), inconclusive/incomplete/historical/missing verification (`R3-VERIFICATION-*`), candidate readiness/receipt limitations (`R3-CANDIDATE-LIMITATIONS`).
     - **Tier 4 (`observation`):** Unavailable projections (`R4-COORDINATION-UNAVAILABLE`, `R4-OPERATIONS-UNAVAILABLE`), degraded status sources (`R4-STATUS-SOURCE-DEGRADED`), unresolved `claimed-incomplete` schedule fires (`R4-SCHEDULE-FIRE-INCOMPLETE`), stale/unreadable/degraded S1 recorded resources (`R4-RESOURCES-*`, `R4-LOCAL-ENDPOINTS-DEGRADED`), unreadable advisory history (`R4-ADVISORY-HISTORY-UNREADABLE`).
   - Strictly separates **Observed** (fact/symptom), **Rule consequence** (deterministic inference), and **Not established** (uncertainty). Explicitly states that rule ranking is **not** a verified optimal plan.
   - Links directly to the target Task, Participant Lanes, Dependency Graph, Resources, Schedules, or Advisory view.

2. **Read-Only S1 Resource Observations Panel (`Resources`)**
   - Reads recorded `<root>/develop/automation/resources.json` and `declarations.json` via the host projection (`liveProbed: false`).
   - **Never** probes endpoints, triggers router model loads, or wakes sleeping local models.
   - Preserves epistemic distinctions: `reachable != ready`, `reported model != authenticated weights`, `healthy != free capacity`, `unknown != zero`.

3. **Read-Only S1 & S2 Schedule Ledger Panel (`Schedules`)**
   - Displays store-level S1 observation schedules (`observe-health`, `refresh-projection`; 0 tokens) and strictly project-scoped S2 advisory schedules, authorization standing, budget standing, and recent fire outcomes.
   - Explicitly distinguishes `scheduled != running`, `claimed != dispatched != completed != published`, `disabled != unavailable`, and `unknown != failed`.
   - **Never** executes ticks, acquires locks, or installs background timers (`executesSchedules: false`).

4. **Read-Only S2 Advisory History & Proposal Queue Panel (`Advisory`)**
   - Displays authorized-project S2 briefings, refusals, withholding reasons, model provenance, recorded token expenditure, and proposal standing/currency.
   - Prominently labeled **Untrusted Model Interpretation · Advisory Only · Authority: None**.
   - **No proposal acceptance, dismissal, or execution controls** (intentionally deferred to Studio F2).
   - Failed, refused, unreadable, or stale briefings never obscure deterministic task, coordination, or attention views.

5. **Bounded Optional Read-Only Auto-Refresh (B7)**
   - Manual `Refresh` remains the default (`Auto-refresh: Off`).
   - Optional opt-in `Auto-refresh: 30s` toggle schedules a single `setTimeout` strictly after each completed read, maintains a single in-flight read bundle via `AbortController`, discards obsolete responses, pauses while `document.hidden`, and stops immediately on grant revocation, `403 forbidden`, or unmount.
   - Displays exact `"Recorded state as of <timestamp>"` — zero SSE, WebSockets, or E4 event streaming.

---

## 2. Host & Cross-Project Disclosure Boundaries

New host endpoint: `GET ./api/v0/workbench/workspace/coordinator/operations` returning closed schema `endo.coordinator-studio-operations.v0`.

| Boundary | Enforcement |
|---|---|
| **Authorization** | Requires valid per-launch capability URL AND active pairing grant (`X-Endo-Grant`). Re-validates both grant and `project.launch === "same"` before returning. |
| **HTTP surface** | Strictly `GET` with empty query string (`400 bad-request` on `?project=...` or any query parameter; `405 method-not-allowed` on non-GET). |
| **Single in-flight & bounded size** | Host enforces `#operationsBusy` (`429 too-many-requests`), 2 MiB JSON cap (`503 unavailable`), and closed runtime schema validation. |
| **Zero cross-project disclosure** | All S2 schedules, fires, turns, briefings, proposals, and aggregate totals are filtered strictly to `projectId === authorizedProjectId`. Foreign S1 worktree summaries and store-wide `projectCount` are stripped; detail strings redact foreign `endo.project.*` IDs and raw filesystem paths. |
| **Static import closure** | `storage/coordinator-studio-operations.ts` imports zero modules from `adapters/` — preserving `endo workspace open`'s harness-neutral, zero-agent closure (`tests/endo-workspace-host.test.ts`). |
| **Zero side effects** | Lock-free read-only file access only; zero locks held across I/O, zero store mutations, zero network/model probes. |

---

## 3. Reproducible Synthetic End-to-End Demonstration

Run the isolated synthetic workspace demonstration script (builds a temporary store with multi-agent S8-class tasks, worktree conflicts, dependencies, changes-requested advisory review, stale S1 resource snapshot pointing at a prohibited-route sentinel, S1 completed + incomplete fires, disabled S2 schedule + historical refusal, and an isolated second project B to prove zero leakage):

```bash
node scripts/demo-coordinator-studio-f1.mjs
```

The script prints the loopback capability URL, one-time pairing code, and sentinel hit count (`0`), keeping the operator's active store completely untouched.
