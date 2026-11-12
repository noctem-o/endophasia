#!/bin/sh
# DEVELOP-VERIFY-TRUST-001: start the controlled verifier (verify.ts) with an environment built here, never the caller's (PROTOCOL.md §4).
# Every command is named by absolute path, so the caller's PATH chooses nothing. The user manager's address comes from the uid, not from
# inherited variables. What this cannot protect is this file and verify.ts themselves: they are as trustworthy as the checkout they live in.
#   run.sh run ...     run.sh read ...      (arguments as verify.ts takes them)
uid=$(/usr/bin/id -u)
here=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
exec /usr/bin/env -i \
	PATH=/usr/bin \
	HOME=/nonexistent \
	LANG=C.UTF-8 \
	XDG_RUNTIME_DIR="/run/user/$uid" \
	DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
	/usr/bin/node "$here/verify.ts" "$@"
