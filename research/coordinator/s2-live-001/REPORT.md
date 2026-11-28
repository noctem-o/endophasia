# S2-LIVE-001 Report: First Live Persistent Coordinator Experiment

**Mission:** `S2-LIVE-001`  
**Status:**
- **Phase A (Preparation):** **COMPLETE** (passive only, zero model wake).
- **Phase B (Single Live Smoke Test):** **COMPLETE** (operator-authorized; cold-load protective refusal in B-1 + warm live advisory cognition validated in B-2; repeat-tick no-replay verified).
- **Phase C (Controlled Observation Experiment):** **COMPLETE** (operator-authorized; Run 1 W0–W5 + Run 2 full 12-window live run covering idle periods, task transitions, failing & passing controller-observed receipts, HEAD advance, active assignment, proposal creation/staleness/ack, co-due digest windows, and isolated closed-port outage).
- **Phase D (Naturalistic 24-Hour Experiment):** **PREPARED — NOT ACTIVATED** (templates, budgets, and stop/revoke/cleanup procedures ready; awaiting separate operator approval naming the target project and store).

**Baseline:** `origin/main` @ `2f730eb68` (PR #191, `COORDINATOR-AUTOMATION-S2`), isolated worktree branch `research/s2-live-001`.  
**Measured vs Simulated Boundary:** Every latency, token count, refusal, briefing, and proposal in §§1–4 below is **measured live** against `http://127.0.0.1:8091` (`Inkling-2-Mini-Uncensored-AD-Q4_K`, `llama.cpp` router `b12622-19bc41dbb`) through sandboxed `OpenClaw 2026.11.10`. None of these figures come from `scripts/s2-simulate-24h.ts`.

---

## Executive Answer to Primary Research Question

> **Does persistent, selectively invoked Coordinator intelligence provide measurable value beyond deterministic monitoring alone?**

**Measured verdict from S2-LIVE-001: Mechanically sound, selectively useful on multi-signal triage, but currently bottlenecked in live multi-task operation by two concrete runtime interactions.**

1. **Where S2 clearly succeeds (mechanical + selective triage):**
   - **Selective invocation works cleanly:** Across 12 zero-token idle/repeat/post-refusal ticks, S2 dispatched **zero** unnecessary inference (`358–390 ms` per tick, `0` tokens). Budget accounting matched server-reported usage to the exact token (`usageReportComplete: true` on 12/12 dispatched turns; `0` uncertain turns). Outage handling (`127.0.0.1:18099`) returned `refused-model-unavailable` in `390 ms` with `0` token charge and never retried on unchanged state.
   - **Multi-signal prioritization & grounded proposals add mild value (`+1`):** When `T2` entered `review` with a controller-observed FAIL receipt at HEAD alongside `T1` (`in-progress`, `no-checks`), the Coordinator immediately prioritized the `status-contradicts-verification` contradiction and emitted a grounded `review-failing-verification` proposal (`98a73d1d15e0…`). Likewise, when `T1` moved to `blocked`, it reliably emitted `resolve-blocked-task` across both runs, and S2 automatically marked prior proposals `stale` once state moved on.
2. **Where live value currently falls short of deterministic monitoring (`0` to `-1`):**
   - **Project-wide wording backstop causes multi-task availability collapse (P0 live finding):** Once a project has *any* `no-checks` task alongside *any* task with `not-current` or `incomplete` verification (including **every** unplanned passing `attempt check` receipt!), the prompt tells the model to say `"no check is recorded for this task"` for the `no-checks` task, and the project-wide regex in `adapters/coordinator/status.ts:84-92` withholds the entire briefing as `receipt-absence-unestablished`. In Phase C Run 2, this withheld **3 / 3 consecutive turns (W8, W9, W10)** — burning `3,702` tokens and `92.6 s` for zero output while deterministic `endo coordinator status` remained immediately clear.
   - **Single-task and unchanged `digest-window` turns provide parity (`0`) at ~25–35 s cost:** On simple single-task states and unchanged digest windows, Inkling faithfully paraphrased the 12-line deterministic status output without surfacing new insight.
   - **Coordination-blind proposal hallucinations:** Because `endophasia_status` omits `endo.coordinator-coordination.v0`, the model twice emitted `PROPOSAL: consider-attempt-for-assignment` on an unassigned open task (safely refused as `proposal-ungrounded` by S2).

---

## 1. Phase A — Environment, Passive Inspection & Isolated Defect

All Phase A checks preserved M1's no-wake observation policy (`GET /health` and `GET /props` only; 0 child workers spawned).

| Component | Observed Value |
| :--- | :--- |
| Worktree / Branch | `/home/noctem/.gemini/antigravity/worktrees/endophasia/live_coordinator_experiment_s2` (`research/s2-live-001` from `origin/main` `2f730eb68`) |
| Ambient `endo` CLI | `/home/noctem/.local/bin/endo` defaults to `$HOME/projects/endophasia` (`99423a924`, 31 commits behind `origin/main`, lacking S1/S2/M1); all runs pinned the worktree's `cli/index.ts`. |
| Runtime stack | Node `v26.13.1`, npm `12.2.3`, bubblewrap `0.13.1`, `/usr/bin/git 2.56.1`, `XDG_RUNTIME_DIR=/run/user/1000` (`0700`, owner `noctem`), OpenClaw `2026.11.10 (6ea542f)`. |
| Local inference server | `http://127.0.0.1:8091`, `llama-server` PID `1426952`, router `b12622-19bc41dbb`, `--models-dir /home/noctem/models/inkling-2-mini/atomicchat --models-max 1 --ctx-size 131072 --parallel 1 --jinja`. |
| Actual Inkling model | `Inkling-2-Mini-Uncensored-AD-Q4_K` (`Inkling-2-Mini-Uncensored-AD-Q4_K.gguf`, 16.53 GB). Verified from `--models-dir` + `llama.cpp/common/preset.cpp:449-450`. Initially unloaded (0 workers). |
| Passive `pool check` | `poolSha256: 290ba309ec80c733d07b5a4825e40c9f49bd9a6b4d42718a8aad0f4f708aaa32`, `readiness: "model-unconfirmed"`, `elapsedMs: 8`, `requests: ["/health", "/props"]`, `inferenceTokens: 0`. |

### Isolated Production Defect & Smallest Remediation (`S2-LIVE-001-DEFECT-01`)

- **Defect:** `adapters/coordinator/openclaw.ts:348` hardcoded `version !== "2026.11.7"`, while the workstation has OpenClaw `2026.11.10 (6ea542f)`. Before remediation, running `ENDO_COORDINATOR_OPENCLAW=$HOME/.local/bin/openclaw npx vitest --run tests/coordinator-brief.test.ts tests/coordinator-model-pool.test.ts tests/develop-advisory-s2.test.ts` failed **12 / 12** installed-OpenClaw fake-provider tests with `runtime-unavailable` and `0` completions. Because S2 writes `turns/<id>.dispatched.json` in Phase E prior to invoking OpenClaw in Phase F, this mismatch would also burn full 4,096-token budget reservations despite 0 HTTP requests.
- **Minimal Remediation:** Added explicit verified allowlist `ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0 = ["2026.11.7", "2026.11.10"]` in `adapters/coordinator/openclaw.ts` (preserving fail-closed rejection for unverified versions) and set `runtime.harness = "OpenClaw <installedVersion>"` for honest provenance.
- **Verification:** Same fake-provider suite passed **228 / 228** (all 12 installed OpenClaw `2026.11.10` wire, tool-surface, model-pinning, truncation, reasoning-only, 20 s timeout, and abort-cancellation tests + all 50 S2 advisory tests). `openclaw-gateway.service` stayed untouched (`MainPID=2965835`, `InvocationID=9c6deee269bb4f2a8528f0bef799ecad`).

---

## 2. Phase B — Live Smoke Validation (Measured)

| Trial | Store Completeness | Model Load | Outcome | End-to-End / Inference Latency | Exchanges / Prompt / Completion (Charged) | Repeat Tick |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **B-1** (`smoke`) | `partial` (bare store: no `events/events.log`, no `develop/attempts/`) | **Cold load** (spawned worker PID `1085366`, 1.50 GB host RSS + GPU VRAM) | `briefing-refused` (`event-absence-unestablished`) | `36,600 ms` / `36,193 ms` | `2` / `6,099` / `675` (reserved `4,096`, charged `675`) | `nothing due; inference not dispatched` (`334 ms`) |
| **B-2** (`smoke-complete`) | `complete` (disjoint real Git repo + initialized `events/events.log` + `develop/attempts/`, no `--permit-partial-observation`) | **Warm** (PID `1085366` resident) | **`briefing-published`** (`available`, `current-at-publication`) | `21,500 ms` / `21,099 ms` | `2` / `6,017` / `612` (reserved `4,096`, charged `612`) | `nothing due; inference not dispatched` |

- **Model identity pinning on live `b12622-19bc41dbb` verified:** `reportedModel` matched `"Inkling-2-Mini-Uncensored-AD-Q4_K"` verbatim on every streamed SSE chunk; `harness` recorded `"OpenClaw 2026.11.10"`.
- **Cold-load penalty measured:** **~15.1 s** (`36.19 s` cold vs `21.10 s` warm) to autoload the 16.53 GB Q4_K GGUF onto GPU.
- **Isolation verified:** `openclaw-gateway.service`, project files, and `develop/tasks.json` remained byte-identical.

---

## 3. Phase C — Controlled Real-Time Observation Experiment (Measured)

Two real-time live runs were executed against isolated real Git repositories (`calc.mjs` + `test.mjs`) and disjoint complete stores (`/tmp/endo-s2-live-001/controlled/{project,store}`):
- **Run 1 (`W0–W5`, archived in `evidence/phase-c-run1/`):** Stopped at W6 due to a script-side task transition error (`open -> review` requires `open -> in-progress -> review`). Captured 3 live turns (`W0` `briefing-published` + refused ungrounded proposal, `W3` `briefing-published` + created `resolve-blocked-task`, `W5` `ctrl-digest` `briefing-published` on unchanged state), 3 zero-token idle skips, and a real **co-due grace timing discovery** (`ctrl-digest`'s 32.6 s turn exceeded `ctrl-on-change`'s 1m `floor(60s/4) = 15s` grace, causing `missed-skipped` with zero catch-up).
- **Run 2 (`W0–W11`, complete 12-window run in `evidence/phase-c-controlled/`):** Fixed `open -> in-progress -> review` and staggered `ctrl-digest` by +35 s.

### Phase C Run 2 Mechanical Summary (16 Fires, 8 Turn Records, 7 Live Dispatches, 2 Proposals)

| Schedule | Dispatched Turns | Charged Tokens / Ceiling | Uncertain Turns | Fire Outcomes |
| :--- | ---: | ---: | ---: | :--- |
| `ctrl-on-change` (`emit-operator-proposal`, `on-change`, `1m`) | 5 | `6,155` / `40,960` | 0 | 3 `briefing-published` (`W0`, `W3`, `W6`), 2 `briefing-refused` (`W8`, `W9`: `receipt-absence-unestablished`), 5 `skipped-unchanged` (`W1`, `W2`, `W4`, `W5`, `W7`), 2 `skipped-already-attempted` (`W10`, `W11`) |
| `ctrl-digest` (`generate-advisory-brief`, `digest-window`, `5m`) | 2 | `1,932` / `12,288` | 0 | 1 `briefing-published` (`W5` unchanged), 1 `briefing-refused` (`W10`: `receipt-absence-unestablished`) |
| `ctrl-outage` (`127.0.0.1:18099`, isolated closed port) | 0 | `0` / `8,192` | 0 | 1 `refused-model-unavailable` (`W10`, `390 ms`, `no-eligible-member`), 1 `skipped-already-attempted` (`W11`, `367 ms`) |

### Phase C Assessment Checklist

| Criterion | Measured Result |
| :--- | :--- |
| Reasons only when warranted | **Pass.** `on-change` reasoned only on `first-observation` and genuine state transitions (`W0`, `W3`, `W6`, `W8`, `W9`). |
| Avoids unnecessary inference | **Pass.** 8/8 unchanged idle ticks (Run 1 + Run 2) returned `skipped-unchanged` (`358–368 ms`, 0 tokens); 3/3 post-refusal/post-outage ticks returned `skipped-already-attempted` (`363–372 ms`, 0 tokens). |
| Preserves correct accounting | **Pass.** Exact sum of reported completion tokens (`6,155` + `1,932` + `0` = `8,087` across Run 2; `usageReportComplete: true` on all 7 dispatches; 0 charged for pre-dispatch outage refusal). |
| Identifies relevant state changes | **Mixed.** Accurately identified `T1 -> blocked` (W3) and `T2` review + FAIL at HEAD contradiction (W6). Blocked by project-wide wording backstop on W8 (assignment + HEAD advance) and W9 (fresh PASS receipt). |
| Produces grounded, useful briefings | **Mixed.** 8/8 released briefings (B-2, Run 1 x3, Run 2 x4) were factually grounded and uncertainty-calibrated (`+1` on W3/W6, `0` on single-task/digest); 4/12 total live turns were withheld by the backstop (1 protective, 3 false-positive multi-task collisions). |
| Produces valid advisory proposals | **Pass with caveat.** Created 3 grounded proposals (`resolve-blocked-task` x2, `review-failing-verification` x1), properly tracked staleness (`currency: stale` after state changes), respected `advisory ack` with zero mutations outside `develop/automation/advisory/`, and deterministically blocked 2 ungrounded `consider-attempt-for-assignment` proposals in W0. |
| Remains functional during outage | **Pass.** Isolated closed-port schedule (`127.0.0.1:18099`) failed closed in `390 ms` with `0` tokens and did not affect `ctrl-on-change`, `ctrl-digest`, or the operator's `127.0.0.1:8091` server. |
| Store, route & Gateway isolation | **Pass.** `routeFilesFound: []`, `gatewayUnchanged: true`, `nonAdvisoryStoreUnchanged: true`, `projectFilesUnchanged: true` on every tick and proposal ack. |

Full per-turn and per-proposal qualitative scoring is in [QUALITATIVE-EVALUATION.md](QUALITATIVE-EVALUATION.md).

---

## 4. Measured Performance & Hidden Reasoning Overhead (All 12 Live Turns)

- **Warm inference latency:** `21.1 s – 34.4 s` (mean **`29.4 s`** across 11 warm turns); cold load **`36.2 s`** (+15.1 s).
- **Prompt tokens (2 exchanges summed):** `6,017 – 6,590` tokens.
- **Completion tokens (2 exchanges summed):** `612 – 1,463` tokens (mean **`1,111` tokens**, peak **71.4%** of the 2,048-token cap). Because visible answers are only ~100–155 words (~140–200 tokens), **~75–85% of generated tokens are hidden deliberation tokens** (not separated in S2's `EndoAdvisoryAccountingV0`). Zero turns hit `generation-limit`, though `1,463` leaves only ~585 tokens of headroom on more complex multi-task projects.

---

## 5. Known Limitations

1. **Project-wide wording backstop collision on multi-task projects (P0):** Any project mixing a `no-checks` task with a `not-current`, `incomplete`, or `not-read` (completed) task reliably triggers `receipt-absence-unestablished` when the model obeys the prompt's `"no check is recorded for this task"` instruction.
2. **Coordination state omitted from model view:** `endophasia_status` delivers `status.view` without `coordinator-coordination.v0`, so the model cannot ground assignment-dependent proposals (`consider-attempt-for-assignment`, `investigate-liveness-hazard`).
3. **Reasoning-token accounting gap:** `usageOf()` aggregates `prompt_tokens` and `completion_tokens` only; `reasoning_tokens` / `reasoning_content` volume is not separately recorded.
4. **Pre-launch harness failures charge full reservation:** A local harness preflight refusal (e.g. unverified OpenClaw version, unsafe `XDG_RUNTIME_DIR`) inside Phase F occurs *after* Phase E's dispatch linearization record, charging the full reservation despite 0 HTTP requests.
5. **Co-due grace sensitivity on short intervals:** S1's `effectiveOnTimeGraceMs = min(600s, floor(everyMs / 4))` means a 30–40 s inference turn causes co-due `1m` schedules (`15 s` grace) to skip; Phase D's `5m` cadence (`75 s` grace) accommodates warm turns comfortably, but staggering `digest-window` by +90 s prevents cold-load collisions.
6. **S2 §13 step 7 path-overlap hazard:** Registering `--root "$R" --path "$R"` overlaps store and project paths and yields `head: null` (`project-head-unavailable`). Always use disjoint store and real Git project paths.
7. **Ambient `endo` CLI version skew:** `$HOME/.local/bin/endo` still points to `$HOME/projects/endophasia` (`99423a924`).

---

## 6. Recommendations

### For F1 / F2 Studio Integration
1. **Fix multi-task backstop availability before enabling continuous advisory UI:** Pair deterministic `coordinator status` directly alongside every advisory turn in F2's inbox, show withheld turns with their exact refusal code (`receipt-absence-unestablished`, `event-absence-unestablished`), and do not treat a withheld briefing as silent idle state.
2. **Surface pre-flight runtime & store completeness readiness in F1:** Show OpenClaw version pin status, `XDG_RUNTIME_DIR` health, and whether `events/events.log` + `develop/attempts/` exist before an operator authorizes a schedule.
3. **Render proposal staleness and evidence facts prominently:** S2's automatic `current -> stale` currency tracking worked accurately in Phase C and is one of the highest-value UX primitives for F2's proposal inbox.

### For Coordinator Runtime & M2 Model-Pool Development
1. **Replace project-wide `receipt-absence-unestablished` with task-scoped checking (or non-colliding prompt wording):** This is the single largest blocker to real-world multi-task advisory usefulness (3/3 multi-task turns withheld in Phase C W8–W10).
2. **Expose trimmed coordination summary to `endophasia_status` (or align proposal vocabulary):** Either include trimmed assignment/hazard presence in the model view or suppress assignment-dependent proposal kinds when coordination data is absent from the tool view.
3. **Move non-inference harness preflight checks before Phase E dispatch:** Check OpenClaw binary/version, `bwrap`, and `XDG_RUNTIME_DIR` before linking `turns/<id>.dispatched.json` so local runtime misconfigurations remain `not-dispatched` with `0` token charge.
4. **Record reasoning-token telemetry in M2/S2 accounting:** Capture `completion_tokens_details.reasoning_tokens` and `reasoning_content` byte/token counts where reported so operators can monitor deliberation headroom against the 2,048-token cap.
5. **Stagger co-due schedules by default in operator templates:** Offset `digest-window` anchors from `on-change` multiples to prevent cold-load turns from tripping `floor(everyMs/4)` on-time grace.

---

## 7. Phase D — Naturalistic 24-Hour Experiment (Prepared, Awaiting Separate Operator Approval)

Phase D is fully prepared in [PROTOCOL.md](PROTOCOL.md) (§2), [SETUP-TEARDOWN.md](SETUP-TEARDOWN.md), and [templates/](templates/) (**NOT installed or activated**):

- **Model & Endpoint:** Local `Inkling-2-Mini-Uncensored-AD-Q4_K` on `http://127.0.0.1:8091` only (`config/pool-local-inkling.json`).
- **Schedules & 24h Ceilings (16 turns max combined):**
  - `nat-on-change`: `emit-operator-proposal`, `wake: on-change`, `--every 5m`, `--max-turns 12`, `--max-output-tokens 2048`, `--max-generated-tokens 49152`, `--period 24h`, `--expires-in 24h`.
  - `nat-digest-6h`: `generate-advisory-brief`, `wake: digest-window`, `--every 6h` (recommend anchoring +90 s offset from `nat-on-change`), `--max-turns 4`, `--max-output-tokens 2048`, `--max-generated-tokens 16384`, `--period 24h`, `--expires-in 24h`.
  - Fixed 2 completion requests/turn; 1 concurrent turn/store; zero operational authority; zero auto-renewal.
- **Bounded Wake Driver:** Operator-owned temporary `systemd --user` timer (`templates/endo-s2-live-001.timer` — omits `[Install]` to prevent permanent enablement, `OnUnitInactiveSec=60s`, `Persistent=false`) + wrapper (`templates/endo-s2-live-001-tick.sh`) enforcing a hard `CUTOFF_EPOCH` 24h wall-clock stop on top of S2's 24h authorization expiry.
- **Operator inputs required before Phase D activation:**
  1. Explicit approval to activate the 24h timer.
  2. Target plain Git project path (not a linked worktree) and disjoint store root to observe.
  3. Decision on whether to run Phase D as-is (measuring real-world frequency of the multi-task `receipt-absence-unestablished` backstop collision) or after addressing that backstop in a follow-up PR.
