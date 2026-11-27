#!/usr/bin/env bash
# Bounded wake wrapper for S2-LIVE-001 Phase D (24-hour naturalistic experiment).
# Template only — NOT activated automatically.
# Prevents execution past CUTOFF_EPOCH even if the user timer has not yet been stopped.
set -euo pipefail

: "${ENDO_NODE_BIN:?ENDO_NODE_BIN must be pinned to the absolute Node binary path}"
: "${ENDO_CLI_ENTRY:?ENDO_CLI_ENTRY must be pinned to the absolute Endophasia cli/index.ts path}"
: "${ENDO_STORE_ROOT:?ENDO_STORE_ROOT must be set to the operator-approved store root}"
: "${ENDO_LOG_FILE:?ENDO_LOG_FILE must be set to the append-only tick log path}"
: "${CUTOFF_EPOCH:?CUTOFF_EPOCH must be set to the UTC epoch second when the 24h window ends}"

NOW_EPOCH="$(date -u +%s)"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$ENDO_LOG_FILE")"

if [ "$NOW_EPOCH" -ge "$CUTOFF_EPOCH" ]; then
  printf '{"timestampUtc":"%s","status":"window-expired-stopped","nowEpoch":%s,"cutoffEpoch":%s}\n' \
    "$NOW_ISO" "$NOW_EPOCH" "$CUTOFF_EPOCH" >> "$ENDO_LOG_FILE"
  exit 0
fi

START_MS="$(date -u +%s%3N)"
OUT="$("$ENDO_NODE_BIN" "$ENDO_CLI_ENTRY" advisory tick --root "$ENDO_STORE_ROOT" --quiet 2>&1)" || RC=$?
RC="${RC:-0}"
END_MS="$(date -u +%s%3N)"
ELAPSED_MS=$((END_MS - START_MS))

printf '{"timestampUtc":"%s","exitCode":%s,"elapsedMs":%s,"output":%s}\n' \
  "$NOW_ISO" "$RC" "$ELAPSED_MS" "$("$ENDO_NODE_BIN" -e 'console.log(JSON.stringify(process.argv[1]))' "$OUT")" \
  >> "$ENDO_LOG_FILE"

exit "$RC"
