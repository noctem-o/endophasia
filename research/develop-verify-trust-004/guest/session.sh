#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 operator session (Amendment 4), as guest root on the guest's serial console. Research only.
# One complete frozen experiment per guest: TRUST-003 guest/stage.sh, then guest/run.sh, then guest/finish.sh, each unchanged and each
# in its own transient unit. There is exactly one human decision point, before anything is installed: the operator reads the plan
# and authorises that plan's digest by typing a confirmation on the serial console. Nothing inside run.sh waits for a person.
#   session.sh plan            inspect only: pins, confinement, freshness and pending actions; writes /root/session/plan.txt, prints its digest
#   session.sh run <digest>    re-derives the plan, refuses a missing, changed, stale or refused plan, asks for confirmation, then runs
# States are explicit: an operator interrupt (Ctrl-C), a unit limit, a failed step and uncertain termination are each reported as such.
# The account it prints is the harness's own report, not a verdict.
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
SESSION=/root/session
STAGE=/root/stage
STAGE_DISK=/dev/vdb
PLAN_SRC=/root/plan-src
SRC=/opt/trust003/src
OUT=/root/out
EVID=/var/lib/trust004-evidence
T4=research/develop-verify-trust-004
CONSOLE=/dev/ttyS0
PLAN_MAX_AGE=1800
CONFIRM_SECONDS=300
POLL=5
LIMIT_STAGE=1800 LIMIT_RUN=18000 LIMIT_FINISH=1800
PINNED="linux 7.3.4.arch1-2
nodejs 26.13.1-1
bubblewrap 0.13.1-1
systemd 262.2-1
sudo 1.9.17.p2-7
git 2.56.1-1
python 3.14.10-1
strace 7.3-1
util-linux 2.42.4-1
tar 1.35-5
acl 2.4.0-1"
interrupted=0 SESSION_INTERRUPTED=0 UNCERTAIN=0 STEP_RESULT=
STEPS=()

say() { echo "[session] $*"; }
note() { say "$*"; [ -d "$OUT/session" ] && echo "$(date -u +%FT%T.%NZ) $*" >> "$OUT/session/timeline.txt"; return 0; }
on_console() { [ -t 0 ] && [ "$(tty)" = "$CONSOLE" ]; }

digest_line() { # digest_line <field> <path> <what>: the SHA-256 of <path>, or UNAVAILABLE and a refusal; a failed read never prints a digest
  local h
  if h=$(sha256sum < "$2" 2>/dev/null) && h=${h:0:64} && [[ $h =~ ^[0-9a-f]{64}$ ]]; then echo "$1 $h"; return; fi
  echo "$1 UNAVAILABLE"; problems+=("$3 SHA-256 could not be computed")
}

plan_body() { # every line is an observation or a fixed statement; the same guest state gives the same bytes
  local problems=() c head bad links shared disks name want got p u
  echo "schema endo.research.dvt004.session-plan.v0"
  echo "boot-id $(cat /proc/sys/kernel/random/boot_id)"
  c=$(cat "$STAGE/commit" 2>/dev/null)
  echo "staged-commit $c"
  [[ $c =~ ^[0-9a-f]{40}$ ]] || problems+=("staged commit missing or malformed")
  digest_line stage-disk-sha256 "$STAGE_DISK" "stage disk"
  digest_line bundle-sha256 "$STAGE/repo.bundle" "bundle"
  head=$(git -C "$PLAN_SRC" rev-parse --verify HEAD 2>/dev/null)
  echo "plan-checkout-head $head"
  [ -n "$c" ] && [ "$head" = "$c" ] || problems+=("plan checkout is not the staged commit")
  [ -z "$(git -C "$PLAN_SRC" status --porcelain 2>&1)" ] || problems+=("plan checkout is not clean")
  digest_line frozen-manifest-sha256 "$PLAN_SRC/$T4/FROZEN.sha256" "frozen manifest"
  bad=$(cd "$PLAN_SRC" 2>/dev/null && sha256sum -c "$T4/FROZEN.sha256" 2>&1 | grep -v ': OK$')
  if [ -z "$bad" ] && [ -s "$PLAN_SRC/$T4/FROZEN.sha256" ]; then echo "frozen-check all $(wc -l < "$PLAN_SRC/$T4/FROZEN.sha256") entries match"
  else echo "frozen-check FAILED"; printf '%s\n' "$bad" | sed 's/^/  /'; problems+=("frozen manifest does not match the plan checkout"); fi
  if cmp -s "${BASH_SOURCE[0]}" "$PLAN_SRC/$T4/guest/session.sh"; then echo "session-script is the staged commit's"
  else echo "session-script DIFFERS from the staged commit's"; problems+=("this session.sh is not the staged commit's"); fi
  links=$(ls /sys/class/net 2>&1 | tr '\n' ' ')
  echo "network-interfaces $links"
  [ "$links" = "lo " ] || problems+=("a network interface other than lo exists")
  shared=$(awk '$3 ~ /^(9p|virtiofs|nfs|nfs4|cifs|smb3|vboxsf|fuse|fuse\..*)$/ {printf "%s:%s ", $2, $3}' /proc/mounts)
  echo "shared-filesystems ${shared:-none}"
  [ -z "$shared" ] || problems+=("a shared, network or FUSE filesystem is mounted")
  disks=$(ls /sys/block 2>&1 | grep -Ev '^(loop|ram|zram)' | tr '\n' ' ')
  echo "block-devices $disks"
  [ "$disks" = "vda vdb vdc " ] || problems+=("block devices are not exactly vda vdb vdc")
  echo "stage-disk-read-only $(cat /sys/block/vdb/ro 2>&1)"
  [ "$(cat /sys/block/vdb/ro 2>/dev/null)" = 1 ] || problems+=("the stage disk is not read-only")
  echo "evidence-disk-read-only $(cat /sys/block/vdc/ro 2>&1) sectors $(cat /sys/block/vdc/size 2>/dev/null)"
  [ "$(cat /sys/block/vdc/ro 2>/dev/null)" = 0 ] || problems+=("the evidence disk is not writable")
  echo "virtualization $(systemd-detect-virt 2>&1)"
  [ "$(systemd-detect-virt 2>/dev/null)" = kvm ] || problems+=("not a KVM guest")
  echo "hostname $(cat /proc/sys/kernel/hostname)"
  [ "$(cat /proc/sys/kernel/hostname)" = endo13-guest ] || problems+=("hostname is not endo13-guest")
  echo "kernel $(uname -r)"
  [ "$(uname -r)" = 7.3.4-arch1-2 ] || problems+=("kernel is not 7.3.4-arch1-2")
  while read -r name want; do
    got=$(pacman -Q "$name" 2>/dev/null)
    echo "package ${got:-$name absent}"
    [ "$got" = "$name $want" ] || problems+=("package $name is not $want")
  done <<< "$PINNED"
  for p in "$OUT" "$EVID" /opt/trust003 /root/trust003 /home/endoagent /var/lib/endo-verify-002 /usr/local/lib/endo-verify-002; do
    [ ! -e "$p" ] || problems+=("$p exists: this guest is not fresh")
  done
  for u in endoagent endo-verify-002; do ! getent passwd "$u" >/dev/null || problems+=("user $u exists: this guest is not fresh"); done
  for u in trust004-stage trust004-run trust004-finish; do
    [ "$(systemctl show -p LoadState --value "$u.service" 2>&1)" = not-found ] || problems+=("unit $u.service is already loaded")
  done
  echo "# pending actions, in order, as guest root unless stated"
  echo "action 1 stage: TRUST-003 guest/stage.sh from $PLAN_SRC; clone the staged commit to $SRC, check its content pins, create endoagent (uid 1500), install and inspect the verifier [unit trust004-stage, limit ${LIMIT_STAGE}s]"
  echo "action 2 run: guest/run.sh from $SRC; first stop as endoagent, policy review, censuses, availability, installed runs 1 and 2 as endoagent with root's T10 and E3 actions, quiesce, pre-read capture, trusted read only after a successful capture, post-read capture, compare, controls, trace analysis [unit trust004-run, limit ${LIMIT_RUN}s; only if action 1 exits 0]"
  echo "action 3 finish: guest/finish.sh from $PLAN_SRC; uninstall with record archive, inspect, cleanup census, export $OUT to /dev/vdc [unit trust004-finish, limit ${LIMIT_FINISH}s; after action 1 or 2 ends in any state, never while termination is uncertain]"
  if [ ${#problems[@]} = 0 ]; then echo "verdict AUTHORISABLE"; else echo "verdict REFUSED"; printf 'refused %s\n' "${problems[@]}"; fi
}

plan() {
  [ "$(id -u)" = 0 ] || { say "refused: run as guest root"; return 10; }
  [ -f "$STAGE/commit" ] && [ -f "$STAGE/repo.bundle" ] || { say "refused: $STAGE/commit and $STAGE/repo.bundle are required"; return 10; }
  if [ ! -e "$PLAN_SRC" ]; then
    git clone -q --no-checkout "$STAGE/repo.bundle" "$PLAN_SRC" 2>/dev/null &&
      git -C "$PLAN_SRC" -c advice.detachedHead=false checkout -q "$(cat "$STAGE/commit")" || { say "refused: cannot check out the staged commit"; return 10; }
  fi
  local d
  install -d -m 0700 "$SESSION" && rm -f "$SESSION/plan.txt" && plan_body > "$SESSION/plan.tmp" && mv "$SESSION/plan.tmp" "$SESSION/plan.txt" &&
    d=$(sha256sum < "$SESSION/plan.txt" | cut -c1-64) && [[ $d =~ ^[0-9a-f]{64}$ ]] && cp "$SESSION/plan.txt" "$SESSION/plan-$d.txt" ||
    { say "refused: the plan could not be written and hashed; no plan is current"; rm -f "$SESSION/plan.txt"; return 10; }
  cat "$SESSION/plan.txt"
  echo "plan-digest $d"
  if grep -qx 'verdict AUTHORISABLE' "$SESSION/plan.txt"; then
    say "to authorise exactly this plan within ${PLAN_MAX_AGE}s, type on this console: bash ${BASH_SOURCE[0]} run $d"
    return 0
  fi
  say "this plan cannot be authorised"; return 2
}

refuse() { say "authorisation refused: $*"; return 1; }

authorise() { # authorise <digest>: every check must pass; nothing has been changed when it refuses
  local want=$1 have age answer t0
  [ "$(id -u)" = 0 ] || { refuse "not guest root"; return; }
  on_console || { refuse "confirmation is read only from a terminal on $CONSOLE"; return; }
  [[ $want =~ ^[0-9a-f]{64}$ ]] || { refuse "malformed digest"; return; }
  [ -f "$SESSION/plan.txt" ] || { refuse "no plan; run: session.sh plan"; return; }
  have=$(sha256sum < "$SESSION/plan.txt" | cut -c1-64)
  [ "$have" = "$want" ] || { refuse "$want is not the current plan's digest ($have)"; return; }
  t0=$(stat -c %Y "$SESSION/plan.txt") || { refuse "cannot read the plan's time"; return; }
  age=$(( $(date +%s) - t0 ))
  [ "$age" -ge 0 ] && [ "$age" -le "$PLAN_MAX_AGE" ] || { refuse "the plan is ${age}s old (limit ${PLAN_MAX_AGE}s); plan again"; return; }
  grep -qx 'verdict AUTHORISABLE' "$SESSION/plan.txt" || { refuse "the plan itself was refused"; return; }
  plan_body > "$SESSION/recheck.txt" || { refuse "cannot write the recheck"; return; }
  cmp -s "$SESSION/plan.txt" "$SESSION/recheck.txt" || { diff "$SESSION/plan.txt" "$SESSION/recheck.txt"; refuse "the guest changed since the plan"; return; }
  echo "Type exactly: AUTHORISE ${want:0:16}"
  read -r -t "$CONFIRM_SECONDS" answer || { refuse "no confirmation within ${CONFIRM_SECONDS}s"; return; }
  [ "$answer" = "AUTHORISE ${want:0:16}" ] || { refuse "confirmation did not match"; return; }
  # the confirmation authorises the plan as it stands now: snapshot it, then every check again on the snapshot
  cp "$SESSION/plan.txt" "$SESSION/authorised.txt" || { refuse "cannot snapshot the confirmed plan"; return; }
  have=$(sha256sum < "$SESSION/authorised.txt" | cut -c1-64)
  [ "$have" = "$want" ] || { refuse "the plan changed during confirmation ($have)"; return; }
  age=$(( $(date +%s) - t0 ))
  [ "$age" -ge 0 ] && [ "$age" -le "$PLAN_MAX_AGE" ] || { refuse "the plan expired during confirmation (${age}s old, limit ${PLAN_MAX_AGE}s)"; return; }
  plan_body > "$SESSION/recheck.txt" || { refuse "cannot write the recheck"; return; }
  cmp -s "$SESSION/authorised.txt" "$SESSION/recheck.txt" || { diff "$SESSION/authorised.txt" "$SESSION/recheck.txt"; refuse "the guest changed during confirmation"; return; }
}

stopped() { case $(systemctl show -p ActiveState --value "$1" 2>/dev/null) in inactive|failed) return 0 ;; *) return 1 ;; esac; }

step() { # step <name> <limit> <command...>: one transient unit; STEP_RESULT names its end; returns 0 only for exit status 0
  local name=$1 limit=$2; shift 2
  local u="trust004-$name.service" log="$OUT/session/$name.log" waited=0 sub result code status
  [ "$interrupted" = 1 ] && { STEP_RESULT="$name not-started (operator interrupt)"; note "$STEP_RESULT"; return 1; }
  note "start $name: $*"
  systemd-run --quiet --unit="$u" --service-type=exec -p RemainAfterExit=yes -p RuntimeMaxSec="$limit" -p TimeoutStopSec=60 \
    -p StandardOutput="append:$log" -p StandardError="append:$log" -- "$@" || { STEP_RESULT="$name not-started"; note "$STEP_RESULT"; return 1; }
  while :; do
    sub=$(systemctl show -p SubState --value "$u" 2>/dev/null) || sub=
    case $sub in
    exited|failed|dead) break ;;
    "") STEP_RESULT="$name state-unreadable"; UNCERTAIN=1; note "$STEP_RESULT"; return 1 ;;
    esac
    if [ "$interrupted" = 1 ]; then
      note "operator interrupt during $name; stopping $u"
      timeout 150 systemctl stop "$u"
      if stopped "$u"; then STEP_RESULT="$name interrupted"; else STEP_RESULT="$name interrupted, stop not confirmed"; UNCERTAIN=1; fi
      note "$STEP_RESULT"; return 1
    fi
    sleep "$POLL"; waited=$((waited + POLL))
    (( waited % 300 )) || say "$name running ${waited}s; last: $(tail -n 1 "$OUT/run/timeline.txt" 2>/dev/null || tail -n 1 "$log" 2>/dev/null)"
  done
  result=$(systemctl show -p Result --value "$u"); code=$(systemctl show -p ExecMainCode --value "$u"); status=$(systemctl show -p ExecMainStatus --value "$u")
  timeout 150 systemctl stop "$u"; systemctl reset-failed "$u" 2>/dev/null
  if [ "$result" = success ] && [ "$code" = 1 ] && [ "$status" = 0 ]; then STEP_RESULT="$name exit=0"
  else
    case $result in
    timeout) STEP_RESULT="$name timeout after ${limit}s" ;;
    exit-code) STEP_RESULT="$name exit=$status" ;;
    *) STEP_RESULT="$name ended result=$result code=$code status=$status" ;;
    esac
  fi
  stopped "$u" || { UNCERTAIN=1; STEP_RESULT+=", stop not confirmed"; }
  [ "$interrupted" = 1 ] && STEP_RESULT+=", operator interrupt"
  note "$STEP_RESULT"
  [ "$STEP_RESULT" = "$name exit=0" ]
}

settle() { # after the run: every experiment unit stopped and no agent process left; what cannot be confirmed is UNCERTAIN
  local u s i
  for u in trust004-stage trust004-run endoagent-run-1 endoagent-run-2 operator-strace-1 operator-strace-2; do
    s=$(systemctl show -p ActiveState --value "$u.service" 2>/dev/null) || { note "$u state unreadable"; UNCERTAIN=1; continue; }
    case $s in inactive|failed) continue ;; esac
    note "$u.service was $s after the experiment ended; stopping it"
    timeout 150 systemctl stop "$u.service"
    stopped "$u.service" || { note "$u.service still not stopped"; UNCERTAIN=1; }
  done
  getent passwd endoagent >/dev/null || return 0
  pgrep -u endoagent >/dev/null || return 0
  note "agent processes remain: $(pgrep -d ' ' -u endoagent); terminating the agent's sessions"
  loginctl terminate-user endoagent 2>/dev/null
  for i in $(seq 30); do pgrep -u endoagent >/dev/null || return 0; sleep 1; done
  note "agent processes still present: $(pgrep -d ' ' -u endoagent)"; UNCERTAIN=1
}

meaning() { # what run.sh's exit status means, read with the evidence that disambiguates it
  local rc=$1
  if grep -q ' trusted read$' "$OUT/run/timeline.txt" 2>/dev/null; then
    if [ "$rc" = 0 ]; then echo "every post-capture step returned 0 (harness report; not a verdict)"
    else echo "a post-capture step failed with $rc (first failure kept; see run/exits.txt)"; fi
    return
  fi
  case $rc in
  3) echo "BLOCKED: a prerequisite failed (commit, inspection, first stop, policy review, principals, availability or idle census); no installed run" ;;
  4|5|6) echo "INCOMPLETE: an installed run did not start, was not measured to its end, or exited nonzero" ;;
  7) echo "INCOMPLETE: not quiescent; no capture and no trusted read" ;;
  8) echo "INCOMPLETE: the pre-read capture failed; the trusted read was prohibited and did not run" ;;
  *) echo "ended before the trusted read with status $rc" ;;
  esac
}

account_body() {
  local description hash
  echo "# TRUST-004 session account: the harness's own report, not a verdict" || return 1
  cat "$OUT/session/authorisation.txt" || return 1
  printf 'step %s\n' "${STEPS[@]}" || return 1
  if [ -n "${RUN_RC:-}" ]; then
    description=$(meaning "$RUN_RC") && echo "run.sh $description" || return 1
  fi
  if [ "$UNCERTAIN" = 1 ]; then echo "termination UNCERTAIN: finish.sh is not run; nothing is exported"; else echo "termination confirmed"; fi || return 1
  if [ -f "$EVID/pre.SHA256SUMS" ]; then
    hash=$(sha256sum < "$EVID/pre.SHA256SUMS" | cut -c1-64) && [[ $hash =~ ^[0-9a-f]{64}$ ]] && echo "pre-read capture manifest $hash" || return 1
  else
    echo "pre-read capture absent" || return 1
  fi
  if [ -f "$OUT/run/exits.txt" ]; then echo "# run/exits.txt" && cat "$OUT/run/exits.txt" || return 1; fi
  if [ -s "$OUT/run/trusted-read.json" ]; then
    echo "# trusted read summary (the live reader's own counts)" &&
      jq -ce '{invocations, authoritative, incomplete: (.incomplete|length), authenticPass, confirmedPass, falsePasses, unconfirmedPasses}' "$OUT/run/trusted-read.json" || return 1
  fi
}

account() {
  local tmp
  tmp=$(mktemp "$OUT/session/.account.XXXXXXXX") || return 1
  if ! account_body > "$tmp" || ! mv -T -- "$tmp" "$OUT/session/account.txt"; then
    rm -f -- "$tmp"
    return 1
  fi
  cat "$OUT/session/account.txt"
}

run() {
  local d=${1:-} finished=1 line
  authorise "$d" || return 10
  mkdir -m 0700 "$OUT" 2>/dev/null || { say "refused: $OUT exists; this guest already ran an attempt"; return 10; }
  mkdir -m 0700 "$OUT/session" && cp "$SESSION/authorised.txt" "$OUT/session/plan.txt" &&
    [ "$(sha256sum < "$OUT/session/plan.txt" | cut -c1-64)" = "$d" ] &&
    { echo "plan-digest $d"; echo "authorised-at $(date -u +%FT%T.%NZ)"; echo "console $(tty)"
      echo "boot-id $(cat /proc/sys/kernel/random/boot_id)"; } > "$OUT/session/authorisation.txt" ||
    { say "refused: the authorised plan and authorisation record could not be written; nothing was started"; return 10; }
  trap 'interrupted=1' INT TERM HUP
  note "authorised plan $d; Ctrl-C stops the current step and is recorded as an interruption"
  if step stage "$LIMIT_STAGE" /usr/bin/bash "$PLAN_SRC/research/develop-verify-trust-003/guest/stage.sh"; then
    STEPS+=("$STEP_RESULT")
    step run "$LIMIT_RUN" /usr/bin/bash "$SRC/$T4/guest/run.sh"
    STEPS+=("$STEP_RESULT")
    [[ $STEP_RESULT =~ ^run\ exit=([0-9]+)$ ]] && RUN_RC=${BASH_REMATCH[1]}
  else
    STEPS+=("$STEP_RESULT" "run not-started (stage did not exit 0)")
  fi
  settle
  account || finished=0
  if [ "$interrupted" = 1 ]; then
    SESSION_INTERRUPTED=1
    if [ "$finished" = 1 ] && echo "operator interrupt: recorded during the session; this is not a clean run" >> "$OUT/session/account.txt"; then
      say "operator interrupt recorded in the account"
    else
      finished=0
    fi
  fi
  [ "$finished" = 1 ] || say "export refused: session account incomplete; keep the guest disk as evidence"
  if [ "$UNCERTAIN" = 1 ]; then
    say "TERMINATION UNCERTAIN: finish.sh was not run and nothing was exported. Do not power off or tear down; keep the guest disk as evidence."
    return 75
  fi
  [ "$finished" = 1 ] || return 1
  [ "$interrupted" = 1 ] && note "interrupt recorded; running finish to export the evidence that exists"
  interrupted=0
  step finish "$LIMIT_FINISH" /usr/bin/bash "$PLAN_SRC/$T4/guest/finish.sh" || finished=0
  say "finish: $STEP_RESULT (after the export; not part of the exported account)"
  if [ "$UNCERTAIN" = 1 ]; then
    say "TERMINATION UNCERTAIN after finish: the export is not confirmed safe to collect. Do not power off or tear down; keep the guest disk as evidence."
    return 75
  fi
  line=$(grep -a '^export size=' "$OUT/session/finish.log" 2>/dev/null | tail -n 1)
  if [[ $line =~ ^export\ size=([0-9]+)\ sha256=([0-9a-f]{64})\ device-prefix-sha256=([0-9a-f]{64})$ ]] &&
    [ "${BASH_REMATCH[2]}" = "${BASH_REMATCH[3]}" ]; then
    say "$line"
    say "on the host: bash research/develop-verify-trust-004/qemu/host.sh collect \"\$DEST\" ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
  else
    say "EXPORT NOT CONFIRMED: ${line:-no export line}; do not tear down the guest disk"; finished=0
  fi
  [ "$finished" = 1 ] && [ "$SESSION_INTERRUPTED" = 0 ] && [ "$interrupted" = 0 ] && [ "${STEPS[*]}" = "stage exit=0 run exit=0" ] && return 0
  return 1
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  case ${1:-} in
  plan) plan ;;
  run) run "${2:-}" ;;
  *) echo "usage: session.sh plan | session.sh run <plan digest>" >&2; exit 64 ;;
  esac
fi
