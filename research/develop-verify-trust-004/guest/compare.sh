#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): pre-read against post-read capture.
set -uo pipefail
export LC_ALL=C
shopt -s dotglob nullglob

refuse() { printf 'UNVERIFIABLE: %s\n' "$*"; exit 2; }
[[ $# = 2 ]] || refuse "expected pre and post capture directories"
pre=$1 post=$2 rc=0
required=(state.tar install.tar system.tar listing.txt files.sha256 acl.txt ancestors.txt roots.txt runtime.sha256 principals.txt acquisition.log
          {repos,harness}-{availability,installed-1,installed-2}.tar)
declare -A pre_hashes=() post_hashes=()
verify() {
  local dir=$1 name line path digest
  local -n hashes=$2
  local pattern='^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$'
  [[ -d $dir && ! -L $dir && -f $dir/SHA256SUMS && ! -L $dir/SHA256SUMS ]] ||
    refuse "$dir: missing or unsafe capture manifest"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ $pattern ]] || refuse "$dir: malformed manifest entry"
    digest=${BASH_REMATCH[1]} name=${BASH_REMATCH[2]}
    [[ $name != SHA256SUMS && ! ${hashes[$name]+present} ]] || refuse "$dir: duplicate or self-referential manifest entry: $name"
    [[ -f $dir/$name && ! -L $dir/$name ]] || refuse "$dir: missing or unsafe file: $name"
    hashes[$name]=$digest
  done < "$dir/SHA256SUMS" || refuse "$dir: cannot read manifest"
  for name in "${required[@]}"; do
    [[ ${hashes[$name]+present} ]] || refuse "$dir: required entry absent from manifest: $name"
  done
  for path in "$dir"/*; do
    name=${path##*/}
    [[ $name == SHA256SUMS || ${hashes[$name]+present} ]] || refuse "$dir: unlisted capture file: $name"
  done
  (cd -- "$dir" && sha256sum --quiet --strict -c SHA256SUMS) || refuse "$dir: checksum verification failed"
}

verify "$pre" pre_hashes
verify "$post" post_hashes
declare -A compared=()
for path in "$pre"/* "$post"/*; do
  name=${path##*/}
  case $name in SHA256SUMS|acquisition.log|roots.txt) continue ;; esac
  [[ ${compared[$name]+present} ]] && continue
  compared[$name]=1
  a=${pre_hashes[$name]-missing} b=${post_hashes[$name]-missing}
  if [[ $a == "$b" ]]; then
    printf 'same      %s %s\n' "$name" "$a"
  else
    printf 'DIFFERENT %s pre=%s post=%s\n' "$name" "$a" "$b"
    rc=1
  fi
done
if [ "$rc" = 0 ]; then
  echo "VERIFIED IDENTICAL (compared files; acquisition.log and roots.txt verified but excluded)"
else
  echo "VERIFIED DIFFERENT"
fi
echo "compare rc=$rc"
exit "$rc"
