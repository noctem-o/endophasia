# DEVELOP-CODEX-STUDIO-001 — Live Codex Integration in Endophasia Studio DEVELOP

- **Status**: Implemented (Draft PR; automated deterministic, PTY, headless Chromium, packaging, and offline real-binary checks complete; human operator bounded live `gpt-6.2-sol` acceptance pending)
- **Baseline**: `origin/main` (`7db2a9852b310c8271a5bbf123f8da16a6addd68` — PRs #180, #181, #182 merged)
- **Branch**: `feat/develop-codex-studio-001`

---

## 1. Architecture & Minimal Integration Path

Rather than modifying Pi's `WorkbenchBrokerV0` or `PiInterventionDeskV0`, `DEVELOP-CODEX-STUDIO-001` adds a dedicated Codex workbench broker implementing the existing harness-neutral `EndoCockpitWorkbenchV0` HTTP adapter contract (`protocol/workbench-http.ts`) and plugs directly into the existing loopback `cockpit-http` server (`cockpit-http/host.ts` / `cockpit-http/server.ts`):

- **CLI entry points** (`cli/harness.ts`, `cli/codex.ts`, `cli/help.ts`):
  - `endo develop --harness codex [--root dir] [--cwd dir] [--project id] [--attachment id] [--executable path] [--model id] [--effort level] [--sandbox read-only|workspace-write] [--ephemeral] [--confirm phrase|short]`
  - `endo codex session --workbench ...` (equivalent spelling)
  - One-word `endo develop` remains **Pi unchanged**.
  - `--harness codex` explicitly rejects Pi-only flags (`--pi`, `--provider`, `--tools`, `--prompt`, `--wait`) and refuses `--mode everyday` / `--mode protected` (Codex is **Strict-only** in v0).
  - Requires a verified controlling terminal (`requireWorkbenchTerminalV0()`) before starting Codex or HTTP, shares `<root>/events/session-attachment.lock` with Pi (`storage/writer-lock.ts`), and inherits PR #182's isolated conservative `CODEX_HOME` startup boundary (preserving disclosure of the `auth.json` symlink OAuth-refresh limitation).
- **Memory-only live transcript** (`adapters/codex/live-transcript.ts`):
  - Implements `endo.workbench-transcript.v3` (`LiveTranscriptViewV0`) with the same UTF-8 byte/item bounds (`MAX_ITEMS = 400`, `MAX_BYTES = 2 MiB`, `MAX_MESSAGE_BYTES = 32 KiB`, `MAX_REASONING_BLOCK_BYTES = 64 KiB`, `MAX_REASONING_MESSAGE_BYTES = 96 KiB`, `PAGE = 200`, `PAGE_BYTES = 512 KiB`).
  - Subscribes to `CodexDevelopAdapterV0` observations and memory-only streaming deltas (`subscribeTranscriptDeltas`), folding partial text and reasoning updates into the `open` snapshot and replacing them cleanly on `item/completed` without duplicating streamed items.
  - Preserves reasoning provenance honestly (`reasoning-summary` vs `raw-thinking` vs `withheld`/redacted vs `empty`/unavailable) and emits structured `PrivateActivity` items (`tool`, `file-change`, `activity`) with `source: "codex-live"`.
  - Never persists private text to canonical events, logs, or errors; clears immediately on disconnect or disposal.
- **Codex workbench broker** (`adapters/codex/workbench.ts`):
  - Reuses all 15 existing `./api/v0/workbench/` HTTP routes (zero new `fetch` endpoints in `studio-ui/src/api.ts`, zero weakened HTTP guards in `cockpit-http/server.ts`, zero mutation routes on read-only `endo studio`).
  - Reuses `EndoPairingV0`, `GitProjectInspectorV0` (`endoProjectRouteV0`), and optional metadata-only `EndoWorkspaceRoutesV0` (`--project`).
  - Delegates **every** governed prompt (`turn/start`), targeted stop (`turn/interrupt`), and admitted steer (`turn/steer`) exclusively through `CodexLiveControllerV0` — never calling `CodexAppServerClientV0` or `adapter.dispatch()` directly.
  - Passes an explicit opaque approval bridge object directly through `CodexLiveControllerV0` (eliminating shared lookup queues), re-verifying grant validity, session/instance identity, withdrawal/supersession, and expiry after terminal confirmation before returning approval to the controller.
  - Exposes read-only `codex` status metadata (`version`, `fingerprintConfidence`, `model`, `reasoningEffort`, `sandbox`, `approvalPolicy`, `approvalsReviewer`, `connectionReason`, plus paired-only `threadId`, `activeTurnId`, `usage`, `pendingNativeApprovals`, `recentNativeApprovals`) validated by closed browser wire gates.
- **Studio DEVELOP UI** (`studio-ui/src/`):
  - Wires `presentLiveCodex()` into DEVELOP via `presentLiveWorkbenchSession()` (`studio-ui/src/model/develop-session.ts`).
  - Widens `studio-ui/src/model/workbench-wire.ts` closed gates for `harness: "pi" | "codex"`, optional `codex` status metadata (forbidden on Pi, required on Codex), and optional `provenance` on supplied `ReasoningPart` blocks.
  - Renders harness/model/sandbox/policy/effort posture, live token usage (including cached input tokens; missing counts and cost remain `"unavailable"`, never `0`), honest `Reasoning summary` vs `Raw reasoning` labels (`studio-ui/src/develop/Reasoning.tsx`), an **unmistakable read-only Pending Native Approval card** with zero approval buttons (`studio-ui/src/develop/Live.tsx`), targeted `turn/interrupt` step chains, recent terminal-resolved native approvals separate from tool execution, and Codex-accurate wording across Instrument and Field (including Storm) appearances without leaking text to Field renderers.
  - Fixes a real browser post-pairing race in `studio-ui/src/use-workbench.ts` where `latest.current` lagged behind React's `dispatch` during the immediate post-pair `GET status` read.

---

## 2. Authority & Scope Boundaries Preserved

| Boundary | Enforcement |
|---|---|
| Strict-only Codex control | `mode` is fixed `strict`; `sessionControl.state` is always `none`; `POST session-control/revoke` returns `409 no-session-control`; CLI rejects `--mode everyday` and `--mode protected`. |
| Terminal-only native approvals | No browser native-approval decision route exists (returns `404 not-found`); `CodexNativeApprovals` renders zero buttons; only controlling-terminal `ALLOW ONCE` / `CANCEL` / decline decides Codex `ServerRequest`s, strictly one-time only. |
| Browser STOP preemption | Requesting STOP from Studio while the terminal is paused on `native-approval>` preempts the local readline prompt so the operator can confirm `APPROVE STOP <digest>` without deadlock; Codex's `turn/interrupt` then cancels the pending native approval. |
| Unsupported operations | `queue` returns `409 not-offered`; `attempt/propose` returns `409 not-offered` (Codex prepared-attempt execution remains out of scope for v0); `intervention/check` returns `409 not-offered`. |
| Unpaired privacy | Unpaired `GET status` redacts `threadId`, `activeTurnId`, `usage`, `pendingNativeApprovals`, `recentNativeApprovals`, `command`, and `interventions`; private routes return `401 grant-required`. |
| Policy-triggered teardown | `late-unexpected-mcp-startup` triggers fail-closed disconnect & teardown, immediately clearing `CodexLiveTranscriptV0` and `CodexDevelopAdapterV0` live transcript buffers, revoking grants, and aborting awaiting proposals. |
| Single writer per store | Shared `<root>/events/session-attachment.lock` prevents concurrent Pi/Codex writes to the same event store (E4 per-attachment storage intentionally out of scope). |
| Read-only `endo studio` | Zero command or workbench routes exposed when `workbench` is absent. |

---

## 3. Independent Adversarial Review & Remediations

An independent read-only adversarial diff audit inspected the complete implementation and surfaced the following substantiated findings, all of which were remediated and covered by regression tests:

1. **[HIGH] Context-correlation race in `#pendingContexts` (`adapters/codex/workbench.ts`, `adapters/codex/controller.ts`)**: Replaced the digest-keyed FIFO map with direct opaque `context` pass-through in `CodexLiveControllerV0.requestPrompt`/`requestStop`/`requestSteer` -> `approveOperation(prompt, signal, context)`, making cross-record or terminal/browser origin misbinding structurally impossible.
2. **[MEDIUM] Closed wire-gate mismatches (`adapters/codex/workbench.ts`)**: Split `mapPromptRefusalCode` to emit only prompt-admitted `REASONS`, capped `pendingNativeApprovals` / `recentNativeApprovals` at 20, and bounded/sanitized `offers.*.reason` (400), `version` (64), `model` (128), and `reasoningEffort` (32).
3. **[MEDIUM] `STOP` blocked behind waiting `native-approval>` (`cli/codex.ts`)**: Added controlled local readline preemption so browser-requested `STOP` preempts a waiting `native-approval>` prompt without answering Codex, re-prompting only if STOP is declined and the turn remains active (verified via PTY test).
4. **[MEDIUM] Stale awaiting-approval `stop`/`steer` after turn completion (`adapters/codex/workbench.ts`)**: Turn completion now immediately transitions matching awaiting interventions to `refused` (`no-active-run`) and aborts their terminal prompt so subsequent prompts are not blocked.
5. **[MEDIUM] Private text retention after settlement/disconnect (`adapters/codex/workbench.ts`, `adapters/codex/develop-adapter.ts`)**: Removed retained `message` fields from prompt/intervention records, nulled `fullMessage` once approval finishes, cleared broker maps on `dispose()`, and cleared `CodexDevelopAdapterV0.#transcript` on disconnect/`close()`.
6. **[MEDIUM] Terminal resource leak & EOF `rl.write` crash (`cli/codex.ts`)**: Wrapped `readline`, signal listeners, and broker initialization inside `try/finally` and added `rl.on("close")` guards around `rl.write`.
7. **[LOW] Streaming/input/controller polish**: Normalized delta `itemId`s and added reasoning fallback clearing in `CodexLiveTranscriptV0`, aligned `UNSAFE_PROMPT_CHARS_V0` with Pi (rejecting bare `\r` and `\u2028`/`\u2029`), preserved `signal.reason` in `CodexLiveControllerV0`, matched `targetTurnId` on idempotent STOP, and synced `latest.current` in `use-workbench.ts` `unpair()`.

---

## 4. Automated & Visual Verification Summary

- **Broker, HTTP security & negative controls** (`tests/codex-workbench-broker.test.ts`): unpaired redaction, 401/403/400/404/409 guards, read-only `endo studio` mutation refusal, nonce idempotency, streaming partial→completed without duplication, redacted reasoning, missing usage=`null`, eviction bounds, `late-unexpected-mcp-startup` teardown, Pi/Codex writer-lock exclusion, CLI Strict-only/TTY/flag rejections, rapid withdraw+re-propose, bare CR rejection, and adapter transcript clearing.
- **Real PTY controlling-terminal CLI tests** (`tests/codex-workbench-cli.test.ts`): full `endo develop --harness codex` loopback pairing, terminal phrase approval, terminal-only `ALLOW ONCE` native approval, browser `STOP` preempting waiting `native-approval>`, and clean shutdown.
- **Headless Chromium browser integration & visual audit** (`tests/endo-studio-codex-workbench-browser.test.ts`): verified against packaged `studio-ui` + synthetic Git repo + fake Codex App Server at 4K (`1920×1080` DPR 2) and smaller desktop (`1280×800`) across Instrument and Field (Storm) appearances with zero console/CSP/JS errors and clean visual inspection of unpaired, awaiting-approval, expanded reasoning summary, tool/file-change activity, token usage, pending read-only native approval banner, targeted interruption, reload, XSS inertness, and disconnect states.
- **Pi & package regression**: Pi workbench broker/interventions/PTY/browser suites (`endo-workbench-*`, `endo-studio-workbench-*`, `develop-ux-001`, `develop-ux-002-cli`), source guards (`endo-studio-source`, `endo-studio-ui-source`, `endo-workbench-tools`), `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:package`, and offline real-binary `endo codex check --sandbox read-only` (zero model calls) all verified green.

---

## 5. Operator-Driven Bounded Live `gpt-6.2-sol` Acceptance Procedure

> **Live Human Acceptance Status: PENDING OPERATOR EXECUTION.**
> Endophasia agents must never impersonate the human operator or programmatically type real approval phrases or `ALLOW ONCE` against a live Codex session. Run the bounded trial below directly in an interactive terminal on the workstation.

### Safeguards & Budget

- Disposable synthetic Git repo (`/tmp/endo-codex-sol-trial-repo`) and isolated Endophasia store (`/tmp/endo-codex-sol-trial-store`).
- Model: `gpt-6.2-sol`, reasoning effort: `low`, sandbox: `read-only`, ephemeral thread (`--ephemeral`), Strict-only terminal approvals.
- Maximum **4 turns** on **1 ephemeral thread**; do not inspect or mutate `~/.codex` or any production repository.

### Step 1 — Prepare disposable synthetic workspace & store

```bash
TRIAL_DIR=$(mktemp -d /tmp/endo-codex-sol-trial-XXXXXX)
mkdir -p "$TRIAL_DIR/repo" "$TRIAL_DIR/store"
git -C "$TRIAL_DIR/repo" init -b main
git -C "$TRIAL_DIR/repo" config user.email "operator@example.invalid"
git -C "$TRIAL_DIR/repo" config user.name "Endophasia Operator"
cat <<'EOF' > "$TRIAL_DIR/repo/math.js"
export function add(a, b) {
  return a + b;
}
EOF
git -C "$TRIAL_DIR/repo" add math.js
git -C "$TRIAL_DIR/repo" commit -m "initial synthetic fixture"
echo "TRIAL_DIR=$TRIAL_DIR"
```

### Step 2 — Launch Codex DEVELOP workbench

From the repository checkout (after `npm run build`):

```bash
node dist/cli/index.js develop \
  --harness codex \
  --root "$TRIAL_DIR/store" \
  --cwd "$TRIAL_DIR/repo" \
  --model gpt-6.2-sol \
  --effort low \
  --sandbox read-only \
  --ephemeral
```

Verify on the terminal:
1. Effective policy reports `model="gpt-6.2-sol"`, `sandbox={type:"readOnly",...}`, `approvalPolicy="on-request"`, `approvalsReviewer="user"`.
2. Private loopback URL (`http://127.0.0.1:<port>/<capability>/`) and initial single-use pairing code are printed on stderr.

### Step 3 — Browser acceptance checklist (max 4 turns)

1. **Unpaired check**: Open the printed loopback URL in Chromium. Confirm DEVELOP opens on the live Codex session showing `Mode: Strict`, `harness: Codex`, `model: gpt-6.2-sol`, `sandbox: readOnly`, `approval policy: on-request (user)`, and **no** transcript or usage before pairing.
2. **Pair**: Enter the terminal pairing code in the browser. Confirm the composer, worktree context (`main`, `math.js`), and token usage panel unlock.
3. **Turn 1 — Simple read-only prompt**: Request `"Read math.js and describe what add(a, b) returns in one sentence."` from the browser. Confirm the awaiting-approval card appears with no browser Approve button. Type the exact `APPROVE PROMPT <6-hex>` phrase in the terminal. Confirm streaming output settles cleanly without duplication, reasoning (if emitted) is labeled honestly (`Reasoning summary` vs `Raw reasoning`), and token usage (including cached input tokens if reported; cost `unavailable`) updates.
4. **Turn 2 — Native approval refusal**: Request `"Run a shell command that prints the current date."` and approve the prompt phrase in the terminal. If Codex issues a native command approval request, confirm Studio shows the **read-only** `Terminal action required` amber banner with zero approve buttons. Decline it on the terminal (press Enter or type `no`) and verify the banner clears and `Recent native approvals` records `declined`.
5. **Turn 3 — Targeted interruption (optional)**: Request a longer explanation (`"Write a detailed step-by-step analysis of JavaScript IEEE-754 addition edge cases."`), approve the prompt, then click **Request stop** while active, type `APPROVE STOP <6-hex>` in the terminal, and verify `Codex acknowledged the targeted turn/interrupt request` followed by `interrupted, as Codex reported`.
6. **Clean shutdown & privacy check**: Type `quit` (or press `Ctrl+C`) in the terminal. Confirm Studio transitions to disconnected and clears the live transcript, the terminal prints `Closed Codex workbench (cleanup=...)`, and inspecting `$TRIAL_DIR/store/events/events.log` shows recorded lifecycle/authority/usage metadata with zero prompt or reply text.

### Step 4 — Cleanup

```bash
rm -rf "$TRIAL_DIR"
```
