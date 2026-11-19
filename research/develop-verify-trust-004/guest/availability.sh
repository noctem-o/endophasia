#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): one attributable liveness request, run as the agent (endoagent) in its own login session.
# Separate from H0 and closure: it shows the installed verifier answers a real request; it grants and proves no security property.
# Reference candidate A from the committed fixture, in a fresh repository; the response line is the agent's view only. Guest root
# separately checks that the named record exists and is the verifier's (run.sh).
set -euo pipefail
SRC=${SRC:-/opt/trust003/src}
R=/home/endoagent/dvt/availability/repos/A
mkdir -p "$R"
cp "$SRC/research/develop-verify-trust/fixtures/candidates/A/roman.mjs" "$R/"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t \
  GIT_COMMITTER_EMAIL=t@example.invalid GIT_AUTHOR_DATE=2026-11-12T00:00:00Z GIT_COMMITTER_DATE=2026-11-12T00:00:00Z
git -C "$R" init -q -b main
git -C "$R" add -A
git -C "$R" commit -q -m availability
c=$(git -C "$R" rev-parse HEAD)
echo "commit=$c"
/usr/bin/node "$SRC/research/develop-verify-trust-002/client/client.ts" submit --socket /run/endo-verify-002/verify.sock --repo "$R" --commit "$c"
