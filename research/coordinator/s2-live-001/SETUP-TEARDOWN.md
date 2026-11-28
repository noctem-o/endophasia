# S2-LIVE-001 Setup, Execution, Stop, Revoke, and Teardown Guide

All commands pin the isolated research worktree CLI explicitly rather than relying on ambient `/home/noctem/.local/bin/endo` (which defaults to `$HOME/projects/endophasia` at commit `99423a924`, 31 commits behind `origin/main`).

```sh
export ENDO_WORKTREE="/home/noctem/.gemini/antigravity/worktrees/endophasia/live_coordinator_experiment_s2"
export ENDO_CMD="node $ENDO_WORKTREE/cli/index.ts"
export POOL_FILE="$ENDO_WORKTREE/research/coordinator/s2-live-001/config/pool-local-inkling.json"
```

---

## Phase B — Single Live Smoke Test (Run ONLY After Explicit Operator Approval)

### Pre-Prepared Experimental Store (Already Created in Phase A)

- **Experimental store:** `/tmp/endo-s2-live-001/smoke/store` (`0700`)
- **Isolated real Git project:** `/tmp/endo-s2-live-001/smoke/project` (clean 1-commit repo, disjoint from store and code root)
- **Registered project ID:** `endo.project.e2225a56cdf4c6551c08ac17837f17ef`
- **Initial task ID:** `endo.task.72c41dc3d7ec68eb9607cce94442aad8` (`open`, `"S2-LIVE-001 smoke verification task"`)
- **Pinned pool file:** `/tmp/endo-s2-live-001/smoke/pool.json` (identical to `config/pool-local-inkling.json`, `poolSha256: 290ba309ec80c733d07b5a4825e40c9f49bd9a6b4d42718a8aad0f4f708aaa32`)

### Execution Steps (Post-Approval)

```sh
export SMOKE_STORE="/tmp/endo-s2-live-001/smoke/store"
export SMOKE_PROJECT="endo.project.e2225a56cdf4c6551c08ac17837f17ef"
export SMOKE_POOL="/tmp/endo-s2-live-001/smoke/pool.json"

# 1. Confirm XDG_RUNTIME_DIR and passive endpoint health (GET /health & /props only)
stat -c '%a %U' "$XDG_RUNTIME_DIR"
$ENDO_CMD coordinator pool check --pool "$SMOKE_POOL"

# 2. Record pre-tick llama-server worker state (passive)
pgrep -a -P 1426952 || echo "(no worker loaded before tick)"

# 3. Add disabled schedule, enable to revision 2, and authorize 1 bounded turn
ONCE_UTC="$(date -u -d '+10 seconds' +%Y-%m-%dT%H:%M:%SZ)"
$ENDO_CMD advisory add --root "$SMOKE_STORE" --id smoke --project "$SMOKE_PROJECT" \
  --action generate-advisory-brief --wake on-change --once "$ONCE_UTC" --missed-run coalesce-once
$ENDO_CMD advisory enable --root "$SMOKE_STORE" --id smoke --revision 1
$ENDO_CMD advisory authorize --root "$SMOKE_STORE" --id smoke --revision 2 \
  --pool "$SMOKE_POOL" \
  --period 1h \
  --max-turns 1 \
  --max-output-tokens 2048 \
  --max-generated-tokens 4096 \
  --turn-timeout 180 \
  --expires-in 1h \
  --observation recorded-or-passive-probe \
  --permit-capacity-unknown \
  --permit-model-unconfirmed \
  --permit-partial-observation

# 4. Wait until ONCE_UTC has passed, then run ONE bounded live advisory tick
sleep 12
$ENDO_CMD advisory tick --root "$SMOKE_STORE"

# 5. Inspect durable briefing, fire, and budget records + post-tick llama-server worker state
$ENDO_CMD advisory briefings --root "$SMOKE_STORE"
$ENDO_CMD advisory fires --root "$SMOKE_STORE"
$ENDO_CMD advisory list --root "$SMOKE_STORE"
pgrep -a -P 1426952 || echo "(no worker loaded after tick)"

# 6. Verify repeated scheduler tick does NOT replay the completed fire
$ENDO_CMD advisory tick --root "$SMOKE_STORE"
```

### Phase B Stop, Revoke, and Teardown

```sh
$ENDO_CMD advisory revoke --root "$SMOKE_STORE" --id smoke
$ENDO_CMD advisory disable --root "$SMOKE_STORE" --id smoke
# Archive raw artifacts before deleting disposable directory:
rm -rf /tmp/endo-s2-live-001/smoke
```

---

## Phase C — Controlled 1–2h Observation Experiment (Run ONLY After Phase B Validation + Approval)

- **Store root:** `/tmp/endo-s2-live-001/controlled/store` (`0700`)
- **Isolated Git project:** `/tmp/endo-s2-live-001/controlled/project`
- **Outage verification pool (non-disruptive):** `/tmp/endo-s2-live-001/controlled/pool-outage.json` pointing to `http://127.0.0.1:18099` (guaranteed unused loopback port; never touches `127.0.0.1:8091`).
- **Teardown:**
  ```sh
  $ENDO_CMD advisory revoke --root /tmp/endo-s2-live-001/controlled/store --id ctrl-on-change
  $ENDO_CMD advisory revoke --root /tmp/endo-s2-live-001/controlled/store --id ctrl-digest
  $ENDO_CMD advisory revoke --root /tmp/endo-s2-live-001/controlled/store --id ctrl-outage
  rm -rf /tmp/endo-s2-live-001/controlled
  ```

---

## Phase D — Naturalistic 24-Hour Experiment (Prepared Only; DO NOT Activate Without Separate Operator Approval)

Templates live under `research/coordinator/s2-live-001/templates/` and are **NOT installed** in `~/.config/systemd/user/`.

### Operator Activation Procedure (ONLY After Separate Approval of Target Project & Store)

1. Choose an operator-approved plain Git project (`TARGET_PROJECT_PATH`, NOT a linked worktree) and disjoint store (`TARGET_STORE_ROOT`, `0700`), and obtain its registered `TARGET_PROJECT_ID`.
2. Add and authorize the two 24-hour schedules (combined ceiling: `12 + 4 = 16` turns over 24 hours; zero auto-renewal):
   ```sh
   $ENDO_CMD advisory add --root "$TARGET_STORE_ROOT" --id nat-on-change --project "$TARGET_PROJECT_ID" \
     --action emit-operator-proposal --wake on-change --every 5m --missed-run skip-and-report \
     --label "S2-LIVE-001 naturalistic on-change"
   $ENDO_CMD advisory enable --root "$TARGET_STORE_ROOT" --id nat-on-change --revision 1
   $ENDO_CMD advisory authorize --root "$TARGET_STORE_ROOT" --id nat-on-change --revision 2 \
     --pool "$POOL_FILE" --period 24h --max-turns 12 --max-output-tokens 2048 --max-generated-tokens 49152 \
     --turn-timeout 180 --expires-in 24h --observation recorded-or-passive-probe \
     --permit-capacity-unknown --permit-model-unconfirmed --permit-partial-observation

   $ENDO_CMD advisory add --root "$TARGET_STORE_ROOT" --id nat-digest-6h --project "$TARGET_PROJECT_ID" \
     --action generate-advisory-brief --wake digest-window --every 6h --missed-run skip-and-report \
     --label "S2-LIVE-001 naturalistic 6h digest"
   $ENDO_CMD advisory enable --root "$TARGET_STORE_ROOT" --id nat-digest-6h --revision 1
   $ENDO_CMD advisory authorize --root "$TARGET_STORE_ROOT" --id nat-digest-6h --revision 2 \
     --pool "$POOL_FILE" --period 24h --max-turns 4 --max-output-tokens 2048 --max-generated-tokens 16384 \
     --turn-timeout 180 --expires-in 24h --observation recorded-or-passive-probe \
     --permit-capacity-unknown --permit-model-unconfirmed --permit-partial-observation
   ```
3. Compute the exact hard stop UTC epoch (`CUTOFF_EPOCH=$(( $(date -u +%s) + 86400 ))`), substitute placeholders in `templates/endo-s2-live-001.service` and `templates/endo-s2-live-001.timer`, and copy them to `~/.config/systemd/user/` (operator-owned, no `sudo`, no system-wide changes, no linger):
   ```sh
   systemctl --user daemon-reload
   systemctl --user start endo-s2-live-001.timer   # start ONLY (do NOT enable permanently)
   systemctl --user status endo-s2-live-001.timer
   ```

### Explicit Emergency Stop, Revoke, and Cleanup Procedure (Phase D)

```sh
# 1. Stop the temporary user timer immediately (takes effect before the next 60s tick)
systemctl --user stop endo-s2-live-001.timer endo-s2-live-001.service || true
systemctl --user disable endo-s2-live-001.timer 2>/dev/null || true

# 2. Revoke both S2 authorizations immediately (blocks any new dispatch and withholds any in-flight turn)
$ENDO_CMD advisory revoke --root "$TARGET_STORE_ROOT" --id nat-on-change
$ENDO_CMD advisory revoke --root "$TARGET_STORE_ROOT" --id nat-digest-6h
$ENDO_CMD advisory disable --root "$TARGET_STORE_ROOT" --id nat-on-change
$ENDO_CMD advisory disable --root "$TARGET_STORE_ROOT" --id nat-digest-6h

# 3. Remove temporary user units and reload systemd --user
rm -f "$HOME/.config/systemd/user/endo-s2-live-001.timer" \
      "$HOME/.config/systemd/user/endo-s2-live-001.service"
systemctl --user daemon-reload
systemctl --user reset-failed endo-s2-live-001.service endo-s2-live-001.timer 2>/dev/null || true

# 4. Confirm zero remaining experiment units and zero active authorizations
systemctl --user list-units --all 'endo-s2-live-001*'
$ENDO_CMD advisory list --root "$TARGET_STORE_ROOT"
```
