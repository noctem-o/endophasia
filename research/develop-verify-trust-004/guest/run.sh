#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13) guest run, step 2, as guest root (the evidence operator). PROTOCOL.md section 6, in order.
# Reuses TRUST-003's merged driver (guest/matrix.sh, sourced as a library, unchanged) for the first stop, the policy review, the
# passive census, the installed runs, their polling budget and exit statuses. Replaces only the operator's interruptions (operator.py:
# live identification, pidfd signalling) and everything after the runs. Failed prerequisites stop the run. After capture,
# preserve the first failure while collecting independent evidence.
#   run.sh            (reads /root/stage/commit; writes /root/out/run)
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
OUT=/root/out/run
SRC=/opt/trust003/src
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  MATRIX_LIB=1 . "$SRC/research/develop-verify-trust-003/guest/matrix.sh" || exit 3
fi
T4=$SRC/research/develop-verify-trust-004/guest
# Amendment 10: matrix.sh's start_run, with the harness replaced by TRUST-004's copy (IA3 judged by export digest, passes.ts).
start_run() { # start_run <k>: the agent's installed run, in the background
  systemd-run --quiet --collect --unit="endoagent-run-$1" --uid=endoagent --gid=endoagent -p PAMName=login \
    -p StandardOutput=file:"$OUT/run-$1.out" -p StandardError=file:"$OUT/run-$1.err" -p WorkingDirectory=/home/endoagent \
    /usr/bin/env -i PATH=/usr/bin HOME=/home/endoagent LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1500 \
    /usr/bin/node "$T4/harness.ts" run "/home/endoagent/dvt/installed-$1" --commit "$COMMIT" --target installed || return 1
  invocation=$(systemctl show --property=InvocationID --value "endoagent-run-$1.service")
  [[ $invocation =~ ^[0-9a-f]{32}$ ]] || { stop_unit "endoagent-run-$1.service"; return 1; }
}
WS="/home/endoagent/dvt/installed-1 /home/endoagent/dvt/installed-2 /home/endoagent/dvt/availability"
stamp() { echo "$(date -u +%FT%T.%NZ) $*" | tee -a "$OUT/timeline.txt"; }

# The operator's actions while run k is going. strace attaches only after the agent's own IP0 has passed (TRUST-003 attempt 2).
on_prompts() {
  local k=$1 log="$OUT/run-$1.out" rc
  if [ "$traced" = no ] && grep -q 'installed run; installation' "$log" 2>/dev/null; then
    traced=yes; local main; main=$(systemctl show -p MainPID --value "endoagent-run-$k.service")
    [ "$(stat -c %u "/proc/$main")" = 1500 ] || { log_exit "run-$k main pid $main is not the agent's"; return 1; }
    systemd-run --quiet --collect --unit="operator-strace-$k" /usr/bin/strace -f -qq -Z -o "$OUT/run-$k.strace" -p "$main" || return 1
    stamp "run-$k strace requested for agent pid $main; attachment is judged only by the trace's contents"
  fi
  if [ "$t10" = no ] && grep -q '^T10: interrupt' "$log" 2>/dev/null; then
    t10=yes; stamp "run-$k T10 prompt"
    python3 -I "$T4/operator.py" census > "$OUT/run-$k-T10-census.json" || return $?
    probe "live-$k" $(pgrep -u endo-verify-002 | tr '\n' ' ') || return 1
    python3 -I "$T4/operator.py" kill-instance > "$OUT/run-$k-T10-operator.json"; rc=$?
    log_exit "run-$k T10 operator exit=$rc"
    [ "$rc" = 0 ] || return "$rc"
  fi
  if [ "$e3" = no ] && grep -q '^E3: restart' "$log" 2>/dev/null; then
    e3=yes; stamp "run-$k E3 prompt"
    python3 -I "$T4/operator.py" restart-manager > "$OUT/run-$k-E3-operator.json"; rc=$?
    log_exit "run-$k E3 operator exit=$rc"
    return "$rc"
  fi
}

principals() { # root's view of both principals, and what the agent can write (run as the agent)
  { id endoagent; id endo-verify-002; id nobody; getent passwd endoagent endo-verify-002; passwd -S endoagent; passwd -S endo-verify-002
    grep -E '^(endoagent|endo-verify-002):' /etc/shadow | cut -d: -f1,3-9
    echo "# verifier manager"; systemctl show -p ActiveState -p MainPID "user@$(id -u endo-verify-002).service"
    python3 -I "$T4/operator.py" census || return 1
    echo "# capabilities of every verifier process"; for p in $(pgrep -u endo-verify-002); do echo "$p $(grep -E '^(Uid|Gid|Groups|CapEff|CapPrm|CapBnd|NoNewPrivs)' /proc/$p/status | tr '\t\n' '  ')"; done
    echo "# user units and sockets"; ls -la /run/endo-verify-002 /run/user 2>&1; ss -lxp | grep -E 'endo|968' ; } > "$OUT/principals.txt" 2>&1
  agent writable /usr/bin/bash -c 'find / -xdev \( -path /proc -o -path /sys -o -path /home/endoagent \) -prune -o -writable -print 2>/dev/null | sort; echo "# sockets connectable"; for s in $(find /run /var/run -xdev -type s 2>/dev/null); do [ -w "$s" ] && echo "writable-socket $s"; done; true' || return 1
  agent census-access /usr/bin/python3 -I "$T4/review.py" agent || return 1
  local rc=0
  grep -E '(^| )(/usr/local/lib/endo-verify-002|/var/lib/endo-verify-002|/run/endo-verify-002|/run/user/[0-9]+|/etc/systemd|/etc/sysusers.d|/etc/tmpfiles.d|/var/lib/systemd/linger|/var/lib/trust004-evidence|/opt/trust003|/usr/bin|/usr/lib)' "$OUT/writable.out" > "$OUT/writable-candidates.txt" || rc=$?
  [ "$rc" -le 1 ] || return 1
  python3 -I "$T4/review.py" "$OUT/census-access.out" "$OUT/writable-candidates.txt" > "$OUT/writable-protected.txt"
}

availability() { # one attributable request, separate from H0 and closure
  agent availability /usr/bin/bash "$T4/availability.sh" || { echo "availability: agent request exit"; return 1; }
  local inv; inv=$(sed -n '2p' "$OUT/availability.out" | jq -r '.invocation // empty')
  [[ $inv =~ ^[0-9a-f]{32}$ ]] || { echo "availability: no invocation in the response"; return 1; }
  local rec=/var/lib/endo-verify-002/records/$inv.json
  { echo "invocation $inv"; stat -c '%F %u %g %a %h %n' "$rec" "/var/lib/endo-verify-002/journal/$inv.jsonl"
    jq -c '{verdict, invocation: .invocation.id, commit: .candidate.commit, exportSha256: .candidate.exportSha256}' "$rec"
    journalctl -q -o short-iso _UID="$(id -u endo-verify-002)" --since=-10min | grep -E 'endo-verify-002@' | tail -n 5
  } > "$OUT/availability-root.txt" 2>&1
  [ "$(stat -c %u "$rec")" = "$(id -u endo-verify-002)" ] && [ "$(jq -r .verdict "$rec")" = PASS ] || { echo "availability: record not the verifier's PASS"; return 1; }
}

quiesce() { # every experiment-owned run ended, the agent has no process, no verifier instance is alive
  local k i
  for k in 1 2; do unit_active "endoagent-run-$k.service" && { echo "quiesce: run-$k still active"; return 1; }; done
  for k in 1 2; do unit_active "operator-strace-$k.service" && { echo "quiesce: strace $k still active"; return 1; }; done
  loginctl terminate-user endoagent 2>/dev/null
  for i in $(seq 60); do pgrep -u endoagent >/dev/null || break; sleep 1; done
  { echo "# agent processes"; ps -o pid,user,cmd -u endoagent 2>&1; echo "# verifier census"; python3 -I "$T4/operator.py" census
    echo "# work directories"; ls -la /var/lib/endo-verify-002/work; echo "# transient units"; systemctl list-units --all --no-legend 'endoagent-*' 'operator-*'
  } > "$OUT/quiesce.txt" 2>&1
  pgrep -u endoagent >/dev/null && { echo "quiesce: agent processes remain"; return 1; }
  python3 -I "$T4/operator.py" census | jq -e 'all(.[]; .instance == false)' >/dev/null || { echo "quiesce: a verifier instance is alive"; return 1; }
}

reader() { # the corrected trusted reader, unchanged, traced so that its children's identities are the kernel's record
  mkdir -p "$OUT/reader-trace"
  timeout --kill-after=30 3600 strace -ff -v -s 256 -tt -qq --seccomp-bpf -o "$OUT/reader-trace/t" \
    -e trace=process,setuid,setgid,setreuid,setregid,setresuid,setresgid,setgroups,prctl,chdir \
    node "$SRC/research/develop-verify-trust-003/guest/read-records.ts" /usr/local/lib/endo-verify-002 $WS > "$OUT/trusted-read.json" 2> "$OUT/trusted-read.err"
  local rc=$?
  log_exit "reader exit=$rc"
  jq -c '{invocations, authoritative, incomplete: (.incomplete|length), authenticPass, confirmedPass, falsePasses, unconfirmedPasses}' "$OUT/trusted-read.json"
  return $rc
}

main() {
  COMMIT=$(cat /root/stage/commit) || return 3
  [[ $COMMIT =~ ^[0-9a-f]{40}$ && $COMMIT == "$(git -C "$SRC" rev-parse --verify HEAD)" ]] || { echo "invalid or mismatched staged commit"; return 3; }
  mkdir -p "$OUT"
  stamp "start commit=$COMMIT"
  inspect inspect-before.txt || return 3
  stamp "first stop (as endoagent, untraced)"
  first_stop || { log_exit "ABORT: first stop failed; nothing else runs"; return 3; }
  policy_review || return 3
  principals || { log_exit "ABORT: the agent can write a protected path (writable-protected.txt)"; return 3; }
  stamp "availability"
  availability || { log_exit "ABORT: verifier not available"; return 3; }
  stamp "passive idle census"
  probe idle || { log_exit "ABORT: idle census failed"; return 3; }
  local k status
  for k in 1 2; do
    stamp "installed run $k"
    start_run "$k" || { log_exit "ABORT: run-$k did not start"; return 4; }
    wait_run "$k" || { log_exit "ABORT: run-$k measurement or wait failed"; return 5; }
    status=$(run_status "$k"); log_exit "run-$k ExecMainStatus=$status"
    [ "$status" = 0 ] || { log_exit "ABORT: run-$k ended with status $status"; return 6; }
  done
  stamp "quiesce"
  quiesce || { log_exit "ABORT: not quiescent; no capture, no read"; return 7; }
  inspect inspect-after.txt || return 7
  stamp "pre-read capture"
  bash "$T4/capture.sh" pre $WS > "$OUT/capture-pre.txt" 2>&1 || { log_exit "ABORT: pre-read capture failed; no read"; return 8; }
  after_capture
}

record_status() {
  log_exit "$1 exit=$2"
  if [ "$result" = 0 ]; then result=$2; fi
}

after_capture() {
  local result=0 reader_rc=0 post_rc=0 k
  stamp "trusted read"
  reader || reader_rc=$?
  result=$reader_rc
  stamp "post-read capture"
  bash "$T4/capture.sh" post $WS > "$OUT/capture-post.txt" 2>&1 || post_rc=$?
  record_status "post-read capture" "$post_rc"
  if [ "$post_rc" = 0 ]; then
    stamp "compare"
    bash "$T4/compare.sh" /var/lib/trust004-evidence/pre /var/lib/trust004-evidence/post > "$OUT/compare.txt" 2>&1; record_status compare "$?"
  fi
  if [ "$reader_rc" = 0 ]; then
    stamp "controls"
    mkdir -p "$OUT/controls-trace" &&
      strace -ff -v -s 256 -tt -qq --seccomp-bpf -o "$OUT/controls-trace/t" -e trace=process,setuid,setgid,setreuid,setregid,setresuid,setresgid,setgroups,prctl,chdir \
        node "$T4/controls.ts" /usr/local/lib/endo-verify-002 /var/lib/trust004-evidence/pre "$OUT/trusted-read.json" "$OUT/controls.json" $WS > "$OUT/controls.out" 2>&1
    record_status controls "$?"
  fi
  stamp "trace analysis"
  for k in 1 2; do python3 -I "$T4/traces.py" refusals "$OUT/run-$k.strace" > "$OUT/run-$k.refusals.json"; record_status "run-$k refusals" "$?"; done
  python3 -I "$T4/traces.py" identity "$OUT/reader-trace" "$(id -u endoagent)" "$(id -g endoagent)" > "$OUT/reader-identity.json"; record_status "reader identity" "$?"
  if [ "$reader_rc" = 0 ]; then
    python3 -I "$T4/traces.py" identity "$OUT/controls-trace" "$(id -u endoagent)" "$(id -g endoagent)" > "$OUT/controls-identity.json"; record_status "controls identity" "$?"
  fi
  collect
  record_status collect "$?"
  stamp "done reader_rc=$reader_rc result=$result"
  return "$result"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
