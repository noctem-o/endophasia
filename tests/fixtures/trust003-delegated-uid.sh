#!/bin/bash
set -eu -o pipefail
skip() { echo "SKIP: $*"; exit 77; }
[[ ${ENDO_TRUST_SUBID_TEST:-} == 1 ]] || skip "requires opt-in for the configured subordinate IDs"
[[ $(id -u) != 0 && -f /etc/arch-release ]] || skip "this fixture uses the Arch device runtime layout"
for tool in unshare newuidmap newgidmap lsns bwrap; do command -v "$tool" >/dev/null || skip "missing $tool"; done
user=$(id -un)
sub=$(awk -F: -v u="$user" '$1==u && $3>0 {print $2; exit}' /etc/subuid)
[[ $sub =~ ^[1-9][0-9]*$ ]] || skip "no delegated UID"
awk -F: -v u="$user" -v s="$sub" '$1==u && $2<=s && s<$2+$3 {ok=1} END {exit !ok}' /etc/subgid || skip "no corresponding delegated GID"
unused() { ps -eo ruid=,euid=,suid=,fuid= | awk -v s="$sub" '{for(i=1;i<=NF;i++)if($i==s)used=1} END {exit used}'; }
unused || skip "delegated UID is busy"
for p in $(lsns -t user -n -o PID); do
  for m in uid_map gid_map; do
    awk -v s="$sub" '$3!=4294967295 && $2<=s && s<$2+$3 {exit 1}' "/proc/$p/$m" || skip "mapping unavailable or in use"
  done
done
S=$(mktemp -d)
export S
trap 'rm -rf "$S"' EXIT
mkdir "$S/bin"
for b in bwrap node python3 setpriv prlimit true; do cp -L "/usr/bin/$b" "$S/bin/$b"; done
rc=0
unshare --map-root-user --map-users="65534:$sub:1" --map-groups="65534:$sub:1" --pid --fork --kill-child /bin/bash -ceu '
  readlink /proc/self/ns/user > "$S/ns"
  cat /proc/self/uid_map /proc/self/gid_map
  exec bwrap --unshare-pid --die-with-parent --unshare-net --cap-add CAP_SETUID --cap-add CAP_SETGID --cap-add CAP_SYS_ADMIN \
    --perms 0755 --dir /usr --ro-bind "$S/bin" /usr/bin --ro-bind /usr/lib /usr/lib \
    --symlink lib /usr/lib64 --symlink usr/lib /lib --symlink usr/lib /lib64 --symlink usr/bin /bin --dev /dev --proc /proc --tmpfs /tmp \
    --ro-bind "$PWD/adapters" /src/adapters --ro-bind "$PWD/runtime" /src/runtime --ro-bind "$PWD/research" /src/research \
    --ro-bind "$PWD/package.json" /src/package.json --ro-bind "$PWD/tests/fixtures/trust003-nested-grade.mjs" /src/tests/fixtures/trust003-nested-grade.mjs \
    -- /usr/bin/node /src/tests/fixtures/trust003-nested-grade.mjs
' || rc=$?
unused || { echo "delegated UID still in use"; exit 1; }
if [[ ! -s $S/ns ]]; then skip "kernel or mapping helpers refused setup (status $rc)"; fi
inode=$(tr -dc '0-9' < "$S/ns")
lsns -t user -n -o NS | awk -v n="$inode" '$1==n {alive=1} END {exit alive}' || { echo "namespace still present"; exit 1; }
echo "namespace $inode gone; no remaining real, effective, saved or filesystem UID $sub"
exit "$rc"
