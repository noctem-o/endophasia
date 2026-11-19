#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): protected evidence acquisition, as guest root (the evidence operator). Research only.
#   capture.sh <label> <agent workspace>...      writes /var/lib/trust004-evidence/<label>/ and makes it immutable
# Run with no experiment process alive (run.sh's quiesce): the agent has no process that could race the acquisition.
# Nothing follows a symbolic link: every acquisition root and each of its ancestors is checked with lstat first, tar archives links as
# links (no --dereference), find runs with -P. Archives keep numeric owners, modes, ACLs and xattrs; atime is dropped so that reading
# a file does not change its archive, ctime is kept so that any metadata change does.
set -euo pipefail
umask 077
export PATH=/usr/bin LC_ALL=C TZ=UTC
EVID=/var/lib/trust004-evidence
L=$1; shift
D=$EVID/$L
install -d -m 0700 -o root -g root "$EVID"
mkdir -m 0700 "$D"
log() { printf '%s %s\n' "$(date -u +%FT%T.%NZ)" "$*" >> "$D/acquisition.log"; }
log "start label=$L pid=$$ uid=$(id -u) $(tr '\0' ' ' < /proc/$$/cmdline)"
log "tools: $(tar --version | head -n1); $(sha256sum --version | head -n1); $(find --version | head -n1); $(getfacl --version 2>&1 | head -n1); kernel $(uname -r)"

safe_root() { # every component of $1 must exist and be a real directory, not a symbolic link
  local p=/ part
  IFS=/ read -ra parts <<< "${1#/}"
  for part in "${parts[@]}"; do
    p=${p%/}/$part
    [ -d "$p" ] && [ ! -L "$p" ] || { log "UNSAFE $p"; echo "capture: unsafe path $p" >&2; exit 70; }
  done
  stat -c '%F %u %g %a %n' "$1" >> "$D/roots.txt"
}
archive() { # archive <name> <dir> <member>...
  local name=$1 dir=$2; shift 2
  safe_root "$dir"
  tar --create --format=pax --pax-option=delete=atime --numeric-owner --acls --xattrs --one-file-system --sort=name \
    -f "$D/$name.tar" -C "$dir" "$@"
  log "archived $name.tar from $dir: $*"
}
listing() { # listing <dir>: metadata (no atime) and content digests of everything under it, links not followed
  safe_root "$1"
  find -P "$1" -printf '%y %m %U %G %n %s %T@ %C@ %i %p\n' | sort -k10 >> "$D/listing.txt"
  find -P "$1" -type f -print0 | sort -z | xargs -0 -r sha256sum >> "$D/files.sha256"
  getfacl -R -P -n --absolute-names "$1" 2>/dev/null | grep -v '^$' >> "$D/acl.txt" || true
}

for a in / /var /var/lib /var/lib/endo-verify-002 /var/lib/endo-verify-002/records /var/lib/endo-verify-002/journal /usr /usr/local \
  /usr/local/lib /usr/local/lib/endo-verify-002 /usr/local/lib/endo-verify-002/installation.json; do
  stat -c '%F %u %g %a %h %n' "$a" >> "$D/ancestors.txt" 2>&1 || echo "absent $a" >> "$D/ancestors.txt"
done
archive state /var/lib endo-verify-002
listing /var/lib/endo-verify-002
archive install /usr/local/lib endo-verify-002
listing /usr/local/lib/endo-verify-002
archive system / etc/systemd/user/endo-verify-002.socket etc/systemd/user/endo-verify-002@.service etc/sysusers.d/endo-verify-002.conf \
  etc/tmpfiles.d/endo-verify-002.conf var/lib/systemd/linger/endo-verify-002 var/lib/endo-verify-002-home
for w in "$@"; do
  n=$(basename "$w")
  archive "repos-$n" "$w" repos
  listing "$w/repos"
  archive "harness-$n" "$w" --exclude=./repos .
done
sha256sum /etc/passwd /etc/group /usr/bin/node /usr/bin/git /usr/bin/bwrap /usr/bin/setpriv >> "$D/runtime.sha256"
getent passwd endoagent endo-verify-002 nobody > "$D/principals.txt"
log "end"
(cd "$D" && sha256sum -- *.tar listing.txt files.sha256 acl.txt ancestors.txt roots.txt runtime.sha256 principals.txt acquisition.log > SHA256SUMS)
cp "$D/SHA256SUMS" "$EVID/$L.SHA256SUMS"
chmod 0400 "$D"/* "$EVID/$L.SHA256SUMS"
chattr +i "$D"/* "$EVID/$L.SHA256SUMS"
chmod 0500 "$D"
chattr +i "$D"
cat "$D/SHA256SUMS"
