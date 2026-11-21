#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13) guest run, step 3, as guest root: uninstall, verify, export. Runs whatever run.sh's outcome was.
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
OUT=/root/out/run
mkdir -p "$OUT" || exit 1
cleanup=0
agent_uid=$(id -u endoagent 2>/dev/null) || cleanup=1
verifier_uid=$(id -u endo-verify-002 2>/dev/null) || cleanup=1
{
  echo "# census before uninstall"
  echo "endoagent uid=${agent_uid:-unavailable}; endo-verify-002 uid=${verifier_uid:-unavailable}"
  if [[ $agent_uid =~ ^[0-9]+$ && $verifier_uid =~ ^[0-9]+$ ]]; then
    ps -o pid,user,cmd -u endoagent -u endo-verify-002 || {
      if [ "$?" = 1 ]; then echo "no matching processes"; else cleanup=1; fi
    }
  else
    echo "combined principal census unavailable"
    cleanup=1
  fi
} > "$OUT/census-before-uninstall.txt" 2>&1 || cleanup=1
rm -rf -- /var/lib/trust004-control /root/trust004-rootonly || cleanup=1
uninstall_rc=0
sh /root/trust003/uninstall.sh "$OUT/verifier-records-uninstall.tar.gz" > "$OUT/uninstall.txt" 2>&1 || uninstall_rc=$?
echo "uninstall exit=$uninstall_rc" >> "$OUT/uninstall.txt" || cleanup=1
[ "$uninstall_rc" = 0 ] || cleanup=1
sleep 3
sh /root/trust003/inspect.sh > "$OUT/inspect-after-uninstall.txt" 2>&1 || cleanup=1
{
  echo "# processes of either principal by saved numeric UID"
  if [[ $agent_uid =~ ^[0-9]+$ && $verifier_uid =~ ^[0-9]+$ ]] &&
      processes=$(ps -eo euid=,ruid=,pid=,user=,cmd= | awk -v a="$agent_uid" -v v="$verifier_uid" '$1==a || $1==v || $2==a || $2==v'); then
    if [ -z "$processes" ]; then echo none; else echo "$processes"; cleanup=1; fi
  else
    echo "numeric principal census unavailable"
    cleanup=1
  fi
  echo "# verifier principal after uninstall"
  getent passwd endo-verify-002; principal_rc=$?
  if [ "$principal_rc" = 2 ]; then echo absent; else cleanup=1; fi
  echo "# live experiment units"
  if units=$(systemctl list-units --all --no-legend --state=active,activating,reloading,deactivating +      'endoagent-*' 'operator-*' "user@$agent_uid.service" "user@$verifier_uid.service"); then
    if [ -z "$units" ]; then echo none; else echo "$units"; cleanup=1; fi
  else
    echo "unit census unavailable"
    cleanup=1
  fi
  echo "# leftovers"
  for path in /var/lib/endo-verify-002 /usr/local/lib/endo-verify-002 /run/endo-verify-002 /var/lib/trust004-control /root/trust004-rootonly; do
    if [ -e "$path" ] || [ -L "$path" ]; then echo "present $path"; cleanup=1; else echo "absent $path"; fi
  done
  echo "# grading uid processes"
  pgrep -a -u 65534; grader_rc=$?
  if [ "$grader_rc" = 1 ]; then echo none; else cleanup=1; fi
  echo "# listeners"; ss -ltunxp || cleanup=1
  echo "# links"; ip -br link || cleanup=1
} > "$OUT/cleanup-guest.txt" 2>&1 || cleanup=1
pacman -Q > "$OUT/packages.txt" || cleanup=1
if [ -d /var/lib/trust004-evidence ]; then
  cp -a /var/lib/trust004-evidence /root/out/evidence || cleanup=1
fi
echo "cleanup exit=$cleanup" >> "$OUT/cleanup-guest.txt" || exit 1
tar --format=pax --numeric-owner -cf /root/export.tar -C /root out || exit 1
s=$(stat -c %s /root/export.tar) && h=$(sha256sum /root/export.tar | cut -c1-64) || exit 1
dd if=/root/export.tar of=/dev/vdc bs=1M conv=fsync status=none || exit 1
d=$(head -c "$s" /dev/vdc | sha256sum | cut -c1-64) || exit 1
echo "export size=$s sha256=$h device-prefix-sha256=$d"
[ "$d" = "$h" ] || exit 1
exit "$cleanup"
