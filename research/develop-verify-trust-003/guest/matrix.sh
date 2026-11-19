#!/bin/bash
# DEVELOP-VERIFY-TRUST-003 guest run, step 2 (guest root, the operator): first stop, probes, the installed matrix twice, trusted read.
# Every agent-side action runs as endoagent (uid 1500) in its own PAM login session started by systemd (PAMName=login), never as root.
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
c=$(cat /root/stage/commit)
SRC=/opt/trust003/src
OUT=/mnt/out/run
mkdir -p "$OUT"
n=0
agent() { # agent <name> <command...>: run as endoagent in a fresh login session; stdout+stderr to $OUT/<name>.out
  local name=$1; shift; n=$((n+1))
  systemd-run --quiet --wait --collect --unit="endoagent-$name" --uid=endoagent --gid=endoagent -p PAMName=login \
    -p StandardOutput=file:"$OUT/$name.out" -p StandardError=file:"$OUT/$name.err" -p WorkingDirectory=/home/endoagent \
    /usr/bin/env -i PATH=/usr/bin HOME=/home/endoagent LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1500 "$@"
  echo "$name exit=$?" | tee -a "$OUT/exits.txt"
}
echo "== verifier principal before testing"; sh /root/trust003/inspect.sh > "$OUT/inspect-before.txt" 2>&1; cat "$OUT/inspect-before.txt" | sed -n '1,25p'
echo "== first stop (as endoagent)"
agent identity /usr/bin/bash -c 'id; cat /proc/self/status | grep -E "^(Uid|Gid|Groups|CapEff|NoNewPrivs)"; loginctl show-session "$XDG_SESSION_ID" -p Name -p Class -p Type -p Remote 2>&1; echo XDG_SESSION_ID=$XDG_SESSION_ID'
cat "$OUT/identity.out"
agent gate /usr/bin/node "$SRC/research/develop-verify-trust-002/audit.ts" --installed
jq -c '{h0, closure, failing: [.checks[] | select(.ok|not)]}' "$OUT/gate.out"
agent sudo-n /usr/bin/bash -c '/usr/bin/sudo -n true; echo "status=$?"'
echo "sudo stdout: $(cat "$OUT/sudo-n.out")"; echo "sudo stderr: $(cat "$OUT/sudo-n.err")"
echo "== operator policy review (root view)"
{ echo "# sudoers (non-comment)"; grep -v '^#' /etc/sudoers | grep .; ls -la /etc/sudoers.d; echo "# polkit rules"; ls -la /usr/share/polkit-1/rules.d /etc/polkit-1/rules.d 2>&1; cat /usr/share/polkit-1/rules.d/*.rules 2>/dev/null
  echo "# setuid/setgid"; find / -xdev -perm /6000 -type f 2>/dev/null; echo "# file capabilities"; getcap -r / 2>/dev/null
  echo "# members of endoagent group / primary gid 1500"; getent group endoagent; awk -F: '$4==1500' /etc/passwd; echo "# ACLs on install"; getfacl -R -s /usr/local/lib/endo-verify-002 /var/lib/endo-verify-002 /run/endo-verify-002 2>/dev/null
  echo "# listening sockets"; ss -lxnp 2>/dev/null | grep -v '^u_dgr' | head -40; ss -ltnup; } > "$OUT/policy-review.txt" 2>&1
echo "== probe while idle (verifier manager only)"
agent probe-idle /usr/bin/bash -c "/usr/bin/strace -f -qq -Z -o /home/endoagent/probe-idle.strace /usr/bin/python3 -I $SRC/research/develop-verify-trust-003/guest/probe.py idle; exit \$?"
jq -c '{held, pids, broken: [.attempts[] | select(.held|not)]}' "$OUT/probe-idle.out"
for k in 1 2; do
  echo "== installed run $k"
  log="$OUT/run-$k.out"
  systemd-run --quiet --collect --unit="endoagent-run-$k" --uid=endoagent --gid=endoagent -p PAMName=login \
    -p StandardOutput=file:"$log" -p StandardError=file:"$OUT/run-$k.err" -p WorkingDirectory=/home/endoagent \
    /usr/bin/env -i PATH=/usr/bin HOME=/home/endoagent LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/1500 \
    /usr/bin/node "$SRC/research/develop-verify-trust-002/rehearsal.ts" run "/home/endoagent/dvt/installed-$k" --commit "$c" --target installed
  t10=no; e3=no; traced=no
  for i in $(seq 1 1800); do
    sleep 1
    # Syscall evidence: root attaches strace only after IP0 and the sudo check passed (a traced setuid sudo cannot refuse by policy).
    if [ $traced = no ] && grep -q 'installed run; installation' "$log" 2>/dev/null; then
      traced=yes; main=$(systemctl show -p MainPID --value "endoagent-run-$k.service")
      systemd-run --quiet --collect --unit="operator-strace-$k" /usr/bin/strace -f -qq -Z -o "$OUT/run-$k.strace" -p "$main"
      echo "strace attached to $main" >> "$OUT/exits.txt"
    fi
    if [ $t10 = no ] && grep -q '^T10: interrupt' "$log" 2>/dev/null; then
      t10=yes
      { echo "# T10 prompt at $(date -u +%FT%TZ); verifier processes:"; ps -o pid,ppid,uid,user,etimes,cmd -u endo-verify-002; } > "$OUT/run-$k-T10-ps.txt"
      pids=$(pgrep -u endo-verify-002 | tr '\n' ' ')
      agent "probe-live-$k" /usr/bin/bash -c "/usr/bin/strace -f -qq -Z -o /home/endoagent/probe-live-$k.strace /usr/bin/python3 -I $SRC/research/develop-verify-trust-003/guest/probe.py live-$k $pids; exit \$?"
      inst=$(pgrep -u endo-verify-002 -f 'verifier.ts serve' | tr '\n' ' ')
      echo "# dedicated guest verifier instance(s) confirmed: $inst; acting: pkill -KILL -u endo-verify-002 -f 'verifier.ts serve'" >> "$OUT/run-$k-T10-ps.txt"
      pkill -KILL -u endo-verify-002 -f 'verifier.ts serve'; echo "pkill exit=$?" >> "$OUT/run-$k-T10-ps.txt"
    fi
    if [ $e3 = no ] && grep -q '^E3: restart' "$log" 2>/dev/null; then
      e3=yes
      { echo "# E3 prompt at $(date -u +%FT%TZ); verifier processes:"; ps -o pid,ppid,uid,user,etimes,cmd -u endo-verify-002; echo "# acting: systemctl restart user@$(id -u endo-verify-002).service"; } > "$OUT/run-$k-E3-ps.txt"
      systemctl restart "user@$(id -u endo-verify-002).service"; echo "restart exit=$?" >> "$OUT/run-$k-E3-ps.txt"
    fi
    systemctl is-active --quiet "endoagent-run-$k.service" || break
  done
  systemctl show "endoagent-run-$k.service" -p ExecMainStatus -p Result 2>/dev/null >> "$OUT/exits.txt"
  echo "run-$k t10=$t10 e3=$e3" >> "$OUT/exits.txt"
  tail -40 "$log"
done
echo "== trusted read (root, installed reader)"
node "$SRC/research/develop-verify-trust-003/guest/read-records.ts" /usr/local/lib/endo-verify-002 "$SRC" /home/endoagent/dvt/installed-1 /home/endoagent/dvt/installed-2 > "$OUT/trusted-read.json" 2> "$OUT/trusted-read.err"
echo "reader exit=$?"; jq -c '{records, authoritative, authoritativePass, falsePasses}' "$OUT/trusted-read.json"
ls -ln /var/lib/endo-verify-002 /var/lib/endo-verify-002/records /var/lib/endo-verify-002/journal > "$OUT/state-listing.txt" 2>&1
ls /var/lib/endo-verify-002/work >> "$OUT/state-listing.txt" 2>&1
for k in 1 2; do mkdir -p "$OUT/installed-$k"; cp -a /home/endoagent/dvt/installed-$k/results.json /home/endoagent/dvt/installed-$k/rehearsal.log /home/endoagent/dvt/installed-$k/audit.json /home/endoagent/dvt/installed-$k/sudo-n.json "$OUT/installed-$k/" 2>/dev/null; done
cp /home/endoagent/probe-*.strace "$OUT/"
sh /root/trust003/inspect.sh > "$OUT/inspect-after.txt" 2>&1
echo "== done"
