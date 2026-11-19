#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13) host side, as the operator's own uid. No sudo, no host share, no listener.
#   host.sh stage <commit>      stage.img: a tar holding a git bundle of <commit> and the commit id; out.img: blank 2 GiB raw disk
#   host.sh collect <dest>      read the export tar back from out.img (size and digest printed by the guest), extract to <dest>
#   host.sh audit               QEMU process, its argv, open files, listeners and forwarding, from /proc and ss
#   host.sh teardown            remove the VM working directory after confirming no QEMU process uses it
set -euo pipefail
W=${ENDO13_WORK:-$HOME/.capy/work/endo13}
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
case "$1" in
stage)
  c=$2; t=$(mktemp -d "$W/stage.XXXX")
  [ "$(git -C "$REPO" rev-parse develop-verify-trust-004)" = "$c" ] || { echo "branch tip is not $c" >&2; exit 65; }
  git -C "$REPO" bundle create "$t/repo.bundle" develop-verify-trust-004 2>/dev/null
  git -C "$REPO" bundle verify "$t/repo.bundle" >/dev/null
  echo "$c" > "$t/commit"
  tar --format=pax --numeric-owner --owner=0 --group=0 -cf "$W/vm/stage.img" -C "$t" repo.bundle commit
  truncate -s 64M "$W/vm/stage.img"; rm -rf "$t"
  rm -f "$W/vm/out.img"; truncate -s 2G "$W/vm/out.img"
  sha256sum "$W/vm/stage.img"; tar -tvf "$W/vm/stage.img" ;;
collect)
  dest=$2 size=$3 digest=$4
  got=$(head -c "$size" "$W/vm/out.img" | sha256sum | cut -c1-64)
  [ "$got" = "$digest" ] || { echo "export digest $got, guest said $digest" >&2; exit 65; }
  mkdir -p "$dest"; head -c "$size" "$W/vm/out.img" > "$dest/export.tar"; tar --no-same-owner -xf "$dest/export.tar" -C "$dest"
  echo "export $size bytes sha256 $got verified on the host" ;;
audit)
  for p in $(pgrep -x qemu-system-x86_64 || true); do
    echo "# pid $p uid $(stat -c %u /proc/$p)"; tr '\0' ' ' < /proc/$p/cmdline; echo
    ls -l /proc/$p/fd | awk '{print $NF}' | grep -v -e '^pipe:' -e '^anon_inode:' -e '^socket:' | sort -u
    grep -o -- '-nic [^ ]*\|hostfwd[^ ]*\|-netdev [^ ]*\|-device [^ ]*\|-virtfs[^ ]*\|-chardev [^ ]*' /proc/$p/cmdline | tr '\0' ' ' || true
    echo "# sockets of pid $p"; ss -anp 2>/dev/null | grep "pid=$p," || echo none
  done
  echo "# qemu processes: $(pgrep -c -x qemu-system-x86_64 || true)" ;;
teardown)
  ! pgrep -f "$W/vm" >/dev/null || { echo "a process still uses $W/vm" >&2; exit 66; }
  du -sh "$W"; rm -rf "$W"; echo "removed $W" ;;
*) echo "usage: host.sh stage|collect|audit|teardown" >&2; exit 64 ;;
esac
