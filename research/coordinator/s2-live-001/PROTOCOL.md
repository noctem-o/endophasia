# S2-LIVE-001 Experimental Protocol: First Live Persistent Coordinator Experiment

**Mission:** `S2-LIVE-001`  
**Primary research question:** Does persistent, selectively invoked Coordinator intelligence provide measurable value beyond deterministic monitoring alone?  
**Baseline:** `origin/main` @ `2f730eb68` (PR #191, `COORDINATOR-AUTOMATION-S2`).  
**Standing:** Research and operational validation mission. All S2 security boundaries remain in force without weakening.

---

## 1. Security Invariants (Non-Negotiable Across All Phases)

- **Local inference only:** Only `http://127.0.0.1:8091` serving local Inkling weights (`Inkling-2-Mini-Uncensored-AD-Q4_K`). Zero hosted inference, zero remote API calls, zero credentials.
- **Advisory only (zero execution authority):** Zero autonomous harness dispatch, zero worktree mutations by the Coordinator, zero `.route.json` claims, zero candidate acceptance, zero automatic merging, zero operational standing authority, zero external communications.
- **No weakened gates:** Grounding (`endophasia_status` exact single tool, paired call ID, projection digest binding), answer backstop filters, inference admission fences, budget reservation/charging, and per-revision authorization boundaries remain untouched.
- **Workstation H0 status unchanged:** No changes to workstation security posture, system-wide configuration, or elevated privileges.
- **Passive observation rule (M1 §3):** During preparation and zero-token health checks, send only `GET /health` and `GET /props` to the llama.cpp router at `127.0.0.1:8091`. Never send `/slots`, `/metrics`, router `/models` or `/v1/models`, or query-string probes.
- **Non-interference with operator workloads:** Never stop, restart, or reconfigure the operator's `llama-server` or `openclaw-gateway.service`. Outage tests use isolated unreachable loopback endpoints or naturally occurring conditions.

---

## 2. Phase Structure & Explicit Approval Gates

### Phase A — Preparation (Authorized)

1. Synchronise isolated research worktree with `origin/main` (PR #191, `2f730eb68`).
2. Read and reconcile S2 (§13), S1, M1, and M0 runtime design specifications.
3. Inspect installed Endophasia CLI, OpenClaw runtime, bubblewrap, Node, Git, `XDG_RUNTIME_DIR`, local `llama-server` command line and `--models-dir` contents, and passive `GET /health` + `GET /props` responses on `http://127.0.0.1:8091`.
4. Isolate and reproduce any runtime compatibility defect against deterministic fake providers (zero live model contact).
5. Prepare a reproducible experimental store (`/tmp/endo-s2-live-001/smoke/store`) and disjoint real Git project (`/tmp/endo-s2-live-001/smoke/project`), verify passive `coordinator pool check` (`inferenceTokens: 0`), and verify zero model wake.
6. **Gate:** Stop before any live inference. Present exact model, endpoint, resource ceilings, experimental store path, OpenClaw remediation diff (if required), and possible side effects to the operator for explicit approval.

### Phase B — Single Live Smoke Test (Requires Explicit Operator Approval)

1. Using the prepared disjoint store (`/tmp/endo-s2-live-001/smoke/store`) and real Git project (`/tmp/endo-s2-live-001/smoke/project`):
   - Add one disabled `generate-advisory-brief` schedule (`id: smoke`, `wake: on-change`, `--once` ~1 minute ahead).
   - Explicitly enable (`revision 2`) and authorize (`--period 1h --max-turns 1 --max-output-tokens 2048 --max-generated-tokens 4096 --turn-timeout 180 --expires-in 1h --observation recorded-or-passive-probe --permit-capacity-unknown --permit-model-unconfirmed --permit-partial-observation`).
2. Capture a deterministic baseline snapshot (`endo coordinator status` + `endo advisory list`) and passive pre-tick state (whether `llama-server` has a loaded worker child).
3. After the `--once` timestamp passes, execute exactly one `advisory tick`.
4. Measure and record raw JSON outputs:
   - End-to-end tick wall-clock latency and `accounting.inferenceElapsedMs`.
   - Reported input (`reportedPromptTokens`), generated (`reportedCompletionTokens`), and reasoning-token usage where available.
   - Budget reservation (`accounting.reserved`) vs charged usage (`chargedCompletionRequests`, `chargedGeneratedTokens`, `usageReportComplete`).
   - Selected member, `selectedModelId`, `reportedModel`, `harness`, `provider`, `poolSha256`, `selectedReadiness`, `capacityConfirmed`.
   - Grounding and validation result (`availability`, `refusal`, `currency`, `evidence.projectionSha256`, `evidence.modelViewSha256`).
   - Model-loading effects (cold worker spawn on `llama-server`, VRAM/loading latency if model started unloaded).
   - Qualitative advisory usefulness vs the deterministic `coordinator status` summary.
5. Execute a second `advisory tick` immediately afterward and verify it reports nothing due and `inferenceDispatched: false` (no replay of the completed fire).
6. Explicitly revoke (`advisory revoke --id smoke`) and preserve raw store records before optional cleanup.
7. **Evaluation rule:** A correctly handled refusal is valid diagnostic evidence, but does not establish successful live advisory cognition.

### Phase C — Controlled Observation Experiment (Requires Phase B Validation + Explicit Operator Approval)

- **Duration:** Bounded 1–2 hours on a fresh isolated real Git repository and disjoint store (`/tmp/endo-s2-live-001/controlled/{project,store}`).
- **Schedules:**
  - `ctrl-on-change`: `emit-operator-proposal`, `wake: on-change`, `--every 5m`, `--missed-run skip-and-report` (budget e.g. 8 turns / 32,768 tokens over `2h`, expires in `2h`).
  - `ctrl-digest`: `generate-advisory-brief`, `wake: digest-window`, `--every 1h`, `--missed-run skip-and-report` (budget e.g. 2 turns / 8,192 tokens over `2h`, expires in `2h`).
- **Controlled timeline of known state transitions & idle periods:**
  1. **T+00m (Initial state):** Isolated Git repo with 1 open task (no checks yet). Expect initial `first-observation` turn.
  2. **T+05m..T+15m (Unchanged idle window, 2–3 ticks):** No store/repo mutations. Expect `skipped-unchanged` with **0 inference requests** and **0 token charges**.
  3. **T+20m (Task state change -> `blocked`):** Operator moves task to `blocked`. Expect 1 `state-changed` advisory turn and grounded `resolve-blocked-task` proposal evaluation.
  4. **T+25m..T+35m (Unchanged idle window):** Expect `skipped-unchanged`, 0 inference.
  5. **T+40m (Verification evidence change — controller-observed failure at HEAD):** Record a failing verification receipt at current HEAD and move task to `review` (or add a second task with failing check). Expect 1 `state-changed` turn recognizing the failing verification at HEAD and/or `review-failing-verification` / `review-awaiting-review`.
  6. **T+50m (Coordination state change + git HEAD advance):** Add an assignment / advance Git HEAD (making prior receipt `not-current`). Expect `state-changed` turn distinguishing historical vs current-HEAD evidence and marking prior proposal `stale`.
  7. **T+60m (Digest window on unchanged state):** Expect `ctrl-digest` to fire once on unchanged state (`wakeReason: digest-window`) while `ctrl-on-change` stays `skipped-unchanged`.
  8. **T+70m (Isolated outage test — non-disruptive):** On a separate isolated third schedule (or temporary isolated pool pointing to a closed loopback port `http://127.0.0.1:18099`, NEVER stopping the operator's `127.0.0.1:8091` server!), verify `refused-model-unavailable`, 0 charged tokens, scheduler stays healthy, and repeated ticks on unchanged state do not hammer or mischarge.
  9. **T+80m (Cleanup & audit):** Revoke all grants, verify byte-integrity outside `<store>/develop/automation/advisory/`, and export full JSONL measurement ledger.

### Phase D — Naturalistic 24-Hour Experiment (Prepared Only; Requires Separate Explicit Operator Approval)

- **Not activated without separate operator approval.**
- **Target scope:** One explicitly operator-approved project and store (must be a plain Git repository — not a linked worktree — disjoint from the store root and Endophasia code root).
- **Proposed schedule & budget split (combined ceiling: 16 advisory turns over 24 hours):**
  - Schedule 1 (`nat-on-change`): `--action emit-operator-proposal --wake on-change --every 5m --missed-run skip-and-report`
    - Budget (`--period 24h`): `--max-turns 12 --max-output-tokens 2048 --max-generated-tokens 49152 --turn-timeout 180 --expires-in 24h`
  - Schedule 2 (`nat-digest-6h`): `--action generate-advisory-brief --wake digest-window --every 6h --missed-run skip-and-report`
    - Budget (`--period 24h`): `--max-turns 4 --max-output-tokens 2048 --max-generated-tokens 16384 --turn-timeout 180 --expires-in 24h`
  - Combined allowance: `12 + 4 = 16` advisory turns max over 24 hours; max 2,048 generated tokens per completion request; fixed 2 completion requests per turn; 1 concurrent advisory turn per store (enforced by S2 advisory lease); both authorizations expire automatically after 24 hours with zero auto-renewal.
- **Wake mechanism:** Temporary operator-owned `systemd --user` timer (`endo-s2-live-001.timer` + `endo-s2-live-001.service`) firing every 60 seconds (`OnUnitActiveSec=60s` / `OnCalendar=*-*-* *:*:00`, `Persistent=false`), pinning exact Node binary, Endophasia worktree `cli/index.ts`, store root, and log sink, with a hard wall-clock stop wrapper (`ConditionPathExists` / UTC cutoff timestamp check) so it stops invoking ticks after 24 hours even if not yet disabled. Never uses root, never installs system-wide units, never enables linger.
- **Observation rule:** Observe ordinary Endophasia development without manufacturing artificial work to justify inference.

---

## 3. Evidence Separation & Reporting Rules

- Mechanical correctness (scheduling, gating, fencing, accounting, grounding, provenance, refusal handling) is reported separately from qualitative advisory value.
- Raw evidence (tick JSON, briefing JSON, proposal JSON, deterministic status baselines, passive probe logs) is preserved without editing.
- Measured live data is strictly labeled as **measured** and separated from S2's `scripts/s2-simulate-24h.ts` (**simulated**) and any design projections (**speculative**).
