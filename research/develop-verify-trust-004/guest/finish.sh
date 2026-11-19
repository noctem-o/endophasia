#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13) guest run, step 3, as guest root: uninstall, verify, export. Runs whatever run.sh's outcome was.
set -uo pipefail
export PATH=/usr/bin LC_ALL=C
OUT=/root/out/run
mkdir -p "$OUT"
{ echo "# census before uninstall"; ps -eo pid,user,etimes,cmd | grep -Ev ' (ps|grep|bash|sudo|agetty|-bash)' ; } > "$OUT/census-before-uninstall.txt"
sh /root/trust003/uninstall.sh "$OUT/verifier-records-uninstall.tar.gz" > "$OUT/uninstall.txt" 2>&1; echo "uninstall exit=$?" >> "$OUT/uninstall.txt"
sleep 3
sh /root/trust003/inspect.sh > "$OUT/inspect-after-uninstall.txt" 2>&1
rm -rf /var/lib/trust004-control /root/trust004-rootonly
{ echo "# processes of either principal"; ps -o pid,user,cmd -u endoagent -u endo-verify-002 2>&1 || echo none
  echo "# experiment units"; systemctl list-units --all --no-legend 'endoagent-*' 'operator-*' 'user@*'
  echo "# leftovers"; ls -d /var/lib/endo-verify-002 /usr/local/lib/endo-verify-002 /run/endo-verify-002 /var/lib/trust004-control /root/trust004-rootonly 2>&1
  echo "# grading uid processes"; pgrep -a -u 65534 || echo none
  echo "# listeners"; ss -ltunxp; echo "# links"; ip -br link; } > "$OUT/cleanup-guest.txt" 2>&1
pacman -Q > "$OUT/packages.txt"
cp -a /var/lib/trust004-evidence /root/out/evidence
tar --format=pax --numeric-owner -cf /root/export.tar -C /root out
s=$(stat -c %s /root/export.tar); h=$(sha256sum /root/export.tar | cut -c1-64)
dd if=/root/export.tar of=/dev/vdc bs=1M conv=fsync status=none
echo "export size=$s sha256=$h device-prefix-sha256=$(head -c "$s" /dev/vdc | sha256sum | cut -c1-64)"
