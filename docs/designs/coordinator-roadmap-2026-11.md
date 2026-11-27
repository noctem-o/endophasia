# Endophasia Coordinator Strategic Roadmap (November 2026)

**Decision Context:** Following `S2-LIVE-001` (PR #192), `COORDINATOR-GROUNDING-002` (PR #193), and `COORDINATOR-REASONING-001` (PR #194), Endophasia is consolidating verified infrastructure onto `main` and decoupling immediate Coordinator product value from neural cognition research.

**Core Architectural Principle:**
> Build an evidence-aware, deterministic coordination environment that is genuinely useful when every language model is unavailable. Neural cognition augments this environment when demonstrably competent — it is never required for operation.

---

## 1. Three Independent Tracks

### Track 1 — Product Track (Immediate Priority)

1. **Coordinator Studio F1 — Deterministic Operational Visibility (`feat/coordinator-studio-f1-002`)**
   - **Zero-model requirement:** Every primary operational surface works with zero language models, zero inference tokens, and zero endpoint wakes.
   - **Scope:**
     - Deterministic, documented priority-ranked Attention view over authoritative `status` + `coordination` + scoped operational records (explicitly distinguishing observed facts, hazards, inferred consequences, and rule ranking vs optimal planning).
     - Read-only S1 Recorded Resource Observations panel with strict epistemic distinctions (`reachable != ready`, `reported != authenticated`, `healthy != free capacity`, `unknown != zero`).
     - Read-only S1 Schedule Ledger & S2 Advisory Schedule activity view (strictly project-scoped; zero tick execution).
     - Read-only S2 Advisory History & Proposal Queue inspection (strictly project-scoped, explicitly untrusted/advisory, zero acceptance/execution controls, never obscuring deterministic state).
     - Bounded optional read-only refresh discipline (single in-flight read, obsolete-response cancellation, immediate stop on grant loss or hidden tab; no SSE/WebSockets).
   - **Dependency:** **Does NOT depend on Intelligence Research.**

2. **Coordinator Studio F2 — Guided Operator Actions (Next Product Milestone, Separately Scoped)**
   - Operator-initiated, per-action confirmed workflows (e.g., explicit proposal acknowledgement/dismissal, guided CLI command preview/copy, task triage actions with strict revision checks and zero autonomous execution).
   - Still preserves advisory-only Coordinator boundaries, Codex Strict-only posture, and per-attempt operator confirmation.

---

### Track 2 — Intelligence Research Track (Independent, Non-Blocking)

Continues independently without blocking F1/F2 product delivery:

1. **Grounding Failure Diagnostics Instrumentation:** Wire `endo.coordinator-grounding-failure-diagnostic.v1` (contract introduced in `COORDINATOR-CONSOLIDATION-001`) into experimental cognition evaluation harnesses so every validation failure identifies exact stage, rule code, subject kind, predicate category, and reference resolution without storing raw model text.
2. **Candidate Model & Cognition Contract Evaluation:** Evaluate stronger local models (and later governed hosted M2 candidates where explicitly authorized) against simpler or better-ergonomic structured grounding contracts, measuring whether neural recommendations add verifiable value beyond deterministic Studio F1 attention rules.
3. **Extended-Resource & Unattended Lease Remediation:** Before any unattended long-budget deployment, implement renewable lease heartbeats, revocation-responsive abort, and S1 V1-pool observation parity (see `docs/designs/coordinator-consolidation-001.md` §5).

---

### Track 3 — Execution & Platform Track (Parallel)

Continues independently on its own engineering milestones:

- **E3 / E4:** Structured event streaming, bounded real-time observation plumbing, and push-based updates (Studio F1 intentionally stays on bounded read-only HTTP pulls until E4 lands).
- **G1 / G2:** Execution governance, workstation hardening (Workstation H0 remains unchanged), and multi-agent workspace lifecycle safety.

---

## 2. Explicit Gating of Deferred Milestones

| Milestone | Status | Entry Gate |
|---|---|---|
| **24-Hour Naturalistic Coordinator Trial** | **Separately gated (held)** | Requires (a) a candidate model + cognition contract demonstrating repeatable live grounded advisory competence above deterministic rules, AND (b) renewable lease heartbeats + revocation-responsive abort + S1 V1-pool parity. |
| **S3 (Autonomous / Higher-Authority Scheduling)** | **Separately gated (held)** | Requires completed F1/F2 operator visibility, demonstrated S2 advisory value across naturalistic operation, and a separate explicit authority-model design review. |
| **Hosted Inference Providers (M2)** | **Out of scope for consolidation & F1** | Requires dedicated credential/egress/cost governance design and explicit operator authorization. |

---

## 3. Preserved Authority Boundaries

Across all three tracks, the following invariants remain unchanged:
- Coordinator remains **strictly advisory-only** (`authority.grants: "none"`, `executionAuthority: false`).
- Codex remains **Strict-only** (no autonomous execution widening).
- Workstation **H0** remains unchanged.
- Research PRs **#192, #193, and #194** remain open, unmerged, and unaltered as the permanent empirical archive of the initial live Coordinator experiments.
