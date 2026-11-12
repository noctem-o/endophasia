#!/bin/sh
# DEVELOP-VERIFY-TRUST-002 research verifier: read-only inspection of the installed state (INSTALL-PLAN.md §4).
# Any user can run it; it changes nothing.
export PATH=/usr/bin LC_ALL=C
USER_NAME=endo-verify-002

echo "== principal"; getent passwd "$USER_NAME" || echo "absent"; id "$USER_NAME" 2>/dev/null
echo "== linger"; loginctl show-user "$USER_NAME" -p Linger -p State 2>/dev/null || echo "no manager"
echo "== processes"; ps -o pid,user,etime,rss,cmd -u "$USER_NAME" 2>/dev/null || echo "none"
echo "== ownership"
for p in /usr/local/lib/endo-verify-002 /usr/local/lib/endo-verify-002/installation.json /usr/local/lib/endo-verify-002/oracle \
	/var/lib/endo-verify-002 /var/lib/endo-verify-002/records /var/lib/endo-verify-002/work /var/lib/endo-verify-002-home \
	/run/endo-verify-002 /run/endo-verify-002/verify.sock /etc/systemd/user/endo-verify-002.socket /etc/systemd/user/endo-verify-002@.service \
	/etc/sysusers.d/endo-verify-002.conf /etc/tmpfiles.d/endo-verify-002.conf /var/lib/systemd/linger/endo-verify-002; do
	stat -c '%A %U:%G %n' "$p" 2>/dev/null || echo "absent $p"
done
echo "== installation identity"; sha256sum /usr/local/lib/endo-verify-002/installation.json 2>/dev/null
echo "== records"; ls /var/lib/endo-verify-002/records 2>/dev/null | wc -l
echo "== full audit: node research/develop-verify-trust-002/audit.ts --installed (from the frozen checkout)"
