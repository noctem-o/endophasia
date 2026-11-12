#!/bin/sh
# DEVELOP-VERIFY-TRUST-002 research verifier: complete removal (INSTALL-PLAN.md §5).
#
# NOT EXECUTED in the unprivileged phase. Run as root:
#   sh uninstall.sh [<archive.tar.gz>]
# With an archive path, the records and journals are saved there first (owned by root; hand it to the operator with chown).
# Safe to run more than once, and after a partial installation.
set -u
umask 022
export PATH=/usr/bin LC_ALL=C

USER_NAME=endo-verify-002
LIB=/usr/local/lib/endo-verify-002
STATE=/var/lib/endo-verify-002
HOME_DIR=/var/lib/endo-verify-002-home
RUN_DIR=/run/endo-verify-002
UNITS=/etc/systemd/user

[ "$(id -u)" = 0 ] || { echo "uninstall.sh: run as root" >&2; exit 64; }
ARCHIVE=${1:-}

uid=$(id -u "$USER_NAME" 2>/dev/null || true)

if [ -n "$ARCHIVE" ] && [ -d "$STATE" ]; then
	tar -C "$STATE" -czf "$ARCHIVE" records journal && echo "uninstall.sh: records and journals saved to $ARCHIVE"
fi

# 1. Stop everything the principal runs: its user manager, its instances, their scopes and sandboxes.
loginctl disable-linger "$USER_NAME" 2>/dev/null || true
[ -z "$uid" ] || systemctl stop "user@$uid.service" 2>/dev/null || true
[ -z "$uid" ] || loginctl terminate-user "$USER_NAME" 2>/dev/null || true

# 2. The units and the configuration.
systemctl --global disable "$USER_NAME.socket" 2>/dev/null || true
rm -f "$UNITS/$USER_NAME.socket" "$UNITS/$USER_NAME@.service"
rm -f "/etc/tmpfiles.d/$USER_NAME.conf" "/etc/sysusers.d/$USER_NAME.conf"
if [ -e /etc/sysusers.d/.created-by-endo-verify-002 ]; then
	rm -f /etc/sysusers.d/.created-by-endo-verify-002
	rmdir /etc/sysusers.d 2>/dev/null || true
fi

# 3. The files.
rm -rf "$LIB" "$STATE" "$HOME_DIR" "$RUN_DIR"

# 4. The principal (sysusers created a group of the same name).
getent passwd "$USER_NAME" >/dev/null && userdel "$USER_NAME"
getent group "$USER_NAME" >/dev/null && groupdel "$USER_NAME"
systemctl daemon-reload

# 5. What is left: nothing may remain, and no file of the old uid in the places a process could have written.
left=0
for p in "$LIB" "$STATE" "$HOME_DIR" "$RUN_DIR" "$UNITS/$USER_NAME.socket" "$UNITS/$USER_NAME@.service" \
	"$UNITS/sockets.target.wants/$USER_NAME.socket" "/etc/sysusers.d/$USER_NAME.conf" "/etc/tmpfiles.d/$USER_NAME.conf" \
	"/var/lib/systemd/linger/$USER_NAME"; do
	if [ -e "$p" ] || [ -L "$p" ]; then echo "uninstall.sh: still present: $p" >&2; left=1; fi
done
if [ -n "$uid" ]; then
	stray=$(find /tmp /var/tmp /dev/shm /run /var/lib -xdev -uid "$uid" 2>/dev/null | head -20)
	[ -z "$stray" ] || { echo "uninstall.sh: files of uid $uid remain:" >&2; echo "$stray" >&2; left=1; }
	pgrep -u "$uid" >/dev/null 2>&1 && { echo "uninstall.sh: processes of uid $uid remain" >&2; left=1; }
fi
[ "$left" = 0 ] && echo "uninstall.sh: removed completely" || exit 1
