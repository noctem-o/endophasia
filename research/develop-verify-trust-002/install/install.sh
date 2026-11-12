#!/bin/sh
# DEVELOP-VERIFY-TRUST-002 research verifier: installation (INSTALL-PLAN.md §3).
#
# NOT EXECUTED in the unprivileged phase. Run as root only with the operator's explicit approval:
#   sh install.sh <package.tar> <expected sha256>
# The expected digest comes from the approval request, read from a view the agent cannot edit, never from a local file.
#
# It refuses to overwrite anything, adds only the paths INSTALL-PLAN.md §2 lists, and changes nothing else. uninstall.sh removes it all.
set -eu
umask 022
export PATH=/usr/bin LC_ALL=C

USER_NAME=endo-verify-002
LIB=/usr/local/lib/endo-verify-002
STATE=/var/lib/endo-verify-002
HOME_DIR=/var/lib/endo-verify-002-home
RUN_DIR=/run/endo-verify-002
UNITS=/etc/systemd/user

[ "$(id -u)" = 0 ] || { echo "install.sh: run as root" >&2; exit 64; }
[ $# = 2 ] || { echo "usage: install.sh <package.tar> <expected sha256>" >&2; exit 64; }
TARBALL=$1
EXPECTED=$2

for p in "$LIB" "$STATE" "$HOME_DIR" "$RUN_DIR" "$UNITS/$USER_NAME.socket" "$UNITS/$USER_NAME@.service" \
	"/etc/sysusers.d/$USER_NAME.conf" "/etc/tmpfiles.d/$USER_NAME.conf" "/var/lib/systemd/linger/$USER_NAME"; do
	[ ! -e "$p" ] || { echo "install.sh: $p exists; refusing to overwrite (run uninstall.sh first)" >&2; exit 66; }
done
! getent passwd "$USER_NAME" >/dev/null || { echo "install.sh: user $USER_NAME exists" >&2; exit 66; }

# The package: first copied where only root can reach, then checked and extracted from that same private copy. Checking the
# operator's file and then reading it again would let anything that can write it swap it in between (review V1).
# PRIVATE is never reassigned: the exit trap removes all of it, the package copy included (operator review: the trap used to name a
# variable that was later pointed at a subdirectory, which left the package behind).
PRIVATE=$(mktemp -d /root/endo-verify-002.XXXXXX)
trap 'rm -rf "$PRIVATE"' EXIT
cp -- "$TARBALL" "$PRIVATE/package.tar"
got=$(sha256sum -- "$PRIVATE/package.tar" | cut -d' ' -f1)
[ "$got" = "$EXPECTED" ] || { echo "install.sh: package digest $got, expected $EXPECTED" >&2; exit 65; }
mkdir "$PRIVATE/x"
tar -x --no-same-owner --no-same-permissions -C "$PRIVATE/x" -f "$PRIVATE/package.tar"
STAGE="$PRIVATE/x"
[ -z "$(find "$STAGE" ! -type f ! -type d)" ] || { echo "install.sh: the package holds something other than files and directories" >&2; exit 67; }
[ "$(ls "$STAGE")" = "$(printf 'lib\nsystem')" ] || { echo "install.sh: unexpected package layout" >&2; exit 67; }

# The socket directory's group (tmpfiles.conf): only its members can reach the socket. It must exist, and its members are listed for the
# operator to confirm before anything is installed.
SOCKET_GROUP=$(awk '$2 == "/run/endo-verify-002" { print $5 }' "$STAGE/system/tmpfiles.conf")
getent group "$SOCKET_GROUP" >/dev/null || { echo "install.sh: socket group '$SOCKET_GROUP' does not exist" >&2; exit 68; }
echo "install.sh: the socket will be reachable by root and by group $SOCKET_GROUP: $(getent group "$SOCKET_GROUP")"

# 1. The principal: a locked system user, no login shell.
created_sysusers_dir=no
[ -d /etc/sysusers.d ] || { install -d -m 0755 -o root -g root /etc/sysusers.d; created_sysusers_dir=yes; }
install -m 0644 -o root -g root "$STAGE/system/sysusers.conf" "/etc/sysusers.d/$USER_NAME.conf"
systemd-sysusers "/etc/sysusers.d/$USER_NAME.conf"
[ "$created_sysusers_dir" = no ] || touch /etc/sysusers.d/.created-by-endo-verify-002

# 2. The code: root's, readable by all; the oracle: readable by the verifier only.
cp -R "$STAGE/lib" "$LIB"
chown -R root:root "$LIB"
find "$LIB" -type d -exec chmod 0755 {} +
find "$LIB" -type f -exec chmod 0644 {} +
chgrp -R "$USER_NAME" "$LIB/oracle"
find "$LIB/oracle" -type d -exec chmod 0750 {} +
find "$LIB/oracle" -type f -exec chmod 0640 {} +

# 3. A root-owned home that holds only masks: the verifier's user manager starts none of the user units enabled for every user.
install -d -m 0755 -o root -g root "$HOME_DIR" "$HOME_DIR/.config" "$HOME_DIR/.config/systemd" "$HOME_DIR/.config/systemd/user"
for unit in $(systemctl --global list-unit-files --state=enabled --no-legend | cut -d' ' -f1); do
	ln -s /dev/null "$HOME_DIR/.config/systemd/user/$unit"
done

# 4. The state directory and the socket directory, the verifier's.
install -m 0644 -o root -g root "$STAGE/system/tmpfiles.conf" "/etc/tmpfiles.d/$USER_NAME.conf"
systemd-tmpfiles --create "/etc/tmpfiles.d/$USER_NAME.conf"

# 5. The units, for every user manager but started only by the verifier's (ConditionUser=).
install -m 0644 -o root -g root "$STAGE/system/$USER_NAME.socket" "$STAGE/system/$USER_NAME@.service" "$UNITS/"
systemctl --global enable "$USER_NAME.socket"

# 6. Linger: PID 1 starts the verifier's user manager now and at every boot; it starts the socket.
loginctl enable-linger "$USER_NAME"

echo "install.sh: installed. Inspect with: sh inspect.sh"
