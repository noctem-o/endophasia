#!/bin/bash
# DEVELOP-VERIFY-TRUST-003 guest run, step 2 (guest root, the operator): first stop, probes, the installed matrix twice, trusted read.
# Every agent-side action runs as endoagent (uid 1500) in its own PAM login session started by systemd (PAMName=login), never as root.
# Any failed prerequisite stops everything after it: no probe or attack runs past a failed first stop, no run starts while another may
# still be running, and the records are not read while a run may still be writing them.
# Sourced with MATRIX_LIB=1 (tests), it only defines its functions.
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
SRC=${SRC:-/opt/trust003/src}
OUT=${OUT:-/mnt/out/run}
POLL_BUDGET=${POLL_BUDGET:-1800}
SUDO_REFUSAL='a password is required|not allowed to execute|not in the sudoers'

log_exit() { echo "$1" >> "$OUT/exits.txt"; echo "$1"; }

agent() { # agent <name> <command...>: run as endoagent in a fresh login session; output to $OUT/<name>.out/.err; returns its status
  local name=$1; shift
  systemd-run --quiet --wait --collect --unit="endoagent-$name" --uid=endoagent --gid=endoagent -p PAMName=login \
    -p StandardOutput=file:"$OUT/$name.out" -p StandardError=file:"$OUT/$name.err" -p WorkingDirectory=/home/endoagent \
    /usr/bin/env -i PATH=/usr/bin HOME=/home/endoagent LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1500 "$@"
  local rc=$?
  log_exit "$name exit=$rc"
  return $rc
}
inspect() { sh /root/trust003/inspect.sh > "$OUT/$1" 2>&1; }
unit_active() { systemctl is-active --quiet "$1"; }
stop_unit() { systemctl stop "$1"; }
start_run() { # start_run <k>: the agent's installed run, in the background
  systemd-run --quiet --collect --unit="endoagent-run-$1" --uid=endoagent --gid=endoagent -p PAMName=login \
    -p StandardOutput=file:"$OUT/run-$1.out" -p StandardError=file:"$OUT/run-$1.err" -p WorkingDirectory=/home/endoagent \
    /usr/bin/env -i PATH=/usr/bin HOME=/home/endoagent LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1500 \
    /usr/bin/node "$SRC/research/develop-verify-trust-002/rehearsal.ts" run "/home/endoagent/dvt/installed-$1" --commit "$COMMIT" --target installed
}
run_status() { # the run's exit status from the system journal (the transient unit is gone once it ends); unknown is not a status
  local j; j=$(journalctl -q -o cat -u "endoagent-run-$1.service" 2>/dev/null)
  if grep -q 'Main process exited, code=exited, status=' <<<"$j"; then sed -n 's/.*Main process exited, code=exited, status=\([0-9]*\).*/\1/p' <<<"$j" | tail -n 1
  elif grep -q 'Deactivated successfully' <<<"$j"; then echo 0
  else echo unknown; fi
}

# The first stop, from the agent's own session. Every condition must hold; anything missing or malformed is a failure.
first_stop() {
  agent identity /usr/bin/bash -c 'id; grep -E "^(Uid|Gid|Groups|CapEff|NoNewPrivs)" /proc/self/status' || return 1
  [ "$(head -n 1 "$OUT/identity.out")" = "uid=1500(endoagent) gid=1500(endoagent) groups=1500(endoagent)" ] || { echo "first stop: identity"; return 1; }
  agent gate /usr/bin/node "$SRC/research/develop-verify-trust-002/audit.ts" --installed || { echo "first stop: audit exit"; return 1; }
  jq -e '(.h0 == true) and (.closure == true)' "$OUT/gate.out" > /dev/null 2>&1 || { echo "first stop: h0/closure not both true, or unreadable"; return 1; }
  agent sudo-n /usr/bin/bash -c '/usr/bin/sudo -n true; echo "status=$?"' || { echo "first stop: sudo probe exit"; return 1; }
  [ "$(cat "$OUT/sudo-n.out")" = "status=1" ] || { echo "first stop: sudo status"; return 1; }
  grep -Eq "$SUDO_REFUSAL" "$OUT/sudo-n.err" || { echo "first stop: no recognised sudo policy refusal"; return 1; }
  return 0
}

policy_review() {
  { echo "# sudoers (non-comment)"; grep -v '^#' /etc/sudoers | grep .; ls -la /etc/sudoers.d; echo "# polkit rules"; ls -la /usr/share/polkit-1/rules.d /etc/polkit-1/rules.d 2>&1; cat /usr/share/polkit-1/rules.d/*.rules 2>/dev/null
    echo "# setuid/setgid"; find / -xdev -perm /6000 -type f 2>/dev/null; echo "# file capabilities"; getcap -r / 2>/dev/null
    echo "# members of endoagent group / primary gid 1500"; getent group endoagent; awk -F: '$4==1500' /etc/passwd; echo "# ACLs on install"; getfacl -R -s /usr/local/lib/endo-verify-002 /var/lib/endo-verify-002 /run/endo-verify-002 2>/dev/null
    echo "# listening sockets"; ss -lxnp 2>/dev/null | grep -v '^u_dgr' | head -40; ss -ltnup; } > "$OUT/policy-review.txt" 2>&1
}

probe() { # probe <label> [pid...]
  local label=$1; shift
  agent "probe-$label" /usr/bin/bash -c "/usr/bin/strace -f -qq -Z -o /home/endoagent/probe-$label.strace /usr/bin/python3 -I $SRC/research/develop-verify-trust-003/guest/probe.py $label $*; exit \$?"
}

# The operator's actions while run k is going: strace from root after IP0, the T10 interruption and the E3 restart.
on_prompts() {
  local k=$1 log="$OUT/run-$1.out"
  if [ "$traced" = no ] && grep -q 'installed run; installation' "$log" 2>/dev/null; then
    traced=yes; local main; main=$(systemctl show -p MainPID --value "endoagent-run-$k.service")
    systemd-run --quiet --collect --unit="operator-strace-$k" /usr/bin/strace -f -qq -Z -o "$OUT/run-$k.strace" -p "$main"
    log_exit "strace attached to $main"
  fi
  if [ "$t10" = no ] && grep -q '^T10: interrupt' "$log" 2>/dev/null; then
    t10=yes
    { echo "# T10 prompt at $(date -u +%FT%TZ); verifier processes:"; ps -o pid,ppid,uid,user,etimes,cmd -u endo-verify-002; } > "$OUT/run-$k-T10-ps.txt"
    probe "live-$k" $(pgrep -u endo-verify-002 | tr '\n' ' ')
    echo "# dedicated guest verifier instance(s) confirmed: $(pgrep -u endo-verify-002 -f 'verifier.ts serve' | tr '\n' ' '); acting: pkill -KILL -u endo-verify-002 -f 'verifier.ts serve'" >> "$OUT/run-$k-T10-ps.txt"
    pkill -KILL -u endo-verify-002 -f 'verifier.ts serve'; echo "pkill exit=$?" >> "$OUT/run-$k-T10-ps.txt"
  fi
  if [ "$e3" = no ] && grep -q '^E3: restart' "$log" 2>/dev/null; then
    e3=yes
    { echo "# E3 prompt at $(date -u +%FT%TZ); verifier processes:"; ps -o pid,ppid,uid,user,etimes,cmd -u endo-verify-002; echo "# acting: systemctl restart user@$(id -u endo-verify-002).service"; } > "$OUT/run-$k-E3-ps.txt"
    systemctl restart "user@$(id -u endo-verify-002).service"; echo "restart exit=$?" >> "$OUT/run-$k-E3-ps.txt"
  fi
}

# Wait for run k within the polling budget. Exhausted: stop the experiment's own unit, record whether it stopped, and fail.
wait_run() {
  local k=$1 unit="endoagent-run-$1.service" i
  traced=no; t10=no; e3=no
  for ((i = 0; i < POLL_BUDGET; i++)); do
    sleep 1
    on_prompts "$k"
    unit_active "$unit" || { log_exit "run-$k ended after $((i + 1)) polls; t10=$t10 e3=$e3"; return 0; }
  done
  stop_unit "$unit"
  if unit_active "$unit"; then log_exit "run-$k exceeded the polling budget ($POLL_BUDGET); stop FAILED, unit still active"
  else log_exit "run-$k exceeded the polling budget ($POLL_BUDGET); unit stopped"; fi
  return 1
}

trusted_read() {
  node "$SRC/research/develop-verify-trust-003/guest/read-records.ts" /usr/local/lib/endo-verify-002 /home/endoagent/dvt/installed-1 /home/endoagent/dvt/installed-2 > "$OUT/trusted-read.json" 2> "$OUT/trusted-read.err"
  local rc=$?
  log_exit "reader exit=$rc"
  jq -c '{invocations, authoritative, incomplete: (.incomplete|length), authenticPass, confirmedPass, falsePasses, unconfirmedPasses}' "$OUT/trusted-read.json"
  return $rc
}

collect() {
  ls -ln /var/lib/endo-verify-002 /var/lib/endo-verify-002/records /var/lib/endo-verify-002/journal > "$OUT/state-listing.txt" 2>&1
  ls /var/lib/endo-verify-002/work >> "$OUT/state-listing.txt" 2>&1
  for k in 1 2; do mkdir -p "$OUT/installed-$k"; cp -a /home/endoagent/dvt/installed-$k/results.json /home/endoagent/dvt/installed-$k/rehearsal.log /home/endoagent/dvt/installed-$k/audit.json /home/endoagent/dvt/installed-$k/sudo-n.json "$OUT/installed-$k/" 2>/dev/null; done
  cp /home/endoagent/probe-*.strace "$OUT/" 2>/dev/null
  inspect inspect-after.txt
}

main() {
  COMMIT=$(cat /root/stage/commit)
  mkdir -p "$OUT"
  echo "== verifier principal before testing"; inspect inspect-before.txt
  echo "== first stop (as endoagent)"
  first_stop || { log_exit "ABORT: first stop failed; nothing else runs"; return 3; }
  echo "== operator policy review (root view)"; policy_review
  echo "== probe while idle (verifier manager only)"; probe idle
  for k in 1 2; do
    echo "== installed run $k"
    start_run "$k" || { log_exit "ABORT: run-$k did not start"; return 4; }
    wait_run "$k" || { log_exit "ABORT: run-$k did not end in time; no further run, no trusted read"; return 5; }
    local status; status=$(run_status "$k")
    log_exit "run-$k ExecMainStatus=$status"
    case "$status" in 0 | 1) ;; *) log_exit "ABORT: run-$k ended with status $status"; return 6 ;; esac
  done
  local reader_rc=0
  echo "== trusted read (root)"; trusted_read || reader_rc=$?
  collect
  echo "== done"
  return "$reader_rc"
}

[ "${MATRIX_LIB:-0}" = 1 ] || main "$@"
