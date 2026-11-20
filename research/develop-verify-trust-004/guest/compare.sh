#!/bin/bash
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): pre-read against post-read capture. Exit 0 only if nothing changed.
# Archives, metadata listings (mode, owner, links, size, mtime, ctime, inode; no atime), content digests and ACLs are compared.
set -uo pipefail
export LC_ALL=C
pre=$1 post=$2 rc=0
echo "pre manifest  $(sha256sum "$pre/SHA256SUMS" | cut -c1-64)"
echo "post manifest $(sha256sum "$post/SHA256SUMS" | cut -c1-64)"
offered=()
for f in offered-installed-{1,2}.tar; do
  if [ -e "$pre/$f" ] || [ -e "$post/$f" ]; then offered+=("$f"); fi
done
for f in state.tar install.tar system.tar listing.txt files.sha256 acl.txt ancestors.txt runtime.sha256 principals.txt $(cd "$pre" && ls repos-*.tar harness-*.tar) "${offered[@]}"; do
  a=$(grep "  $f\$" "$pre/SHA256SUMS" | cut -c1-64); b=$(grep "  $f\$" "$post/SHA256SUMS" | cut -c1-64)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "same      $f $a"; else echo "DIFFERENT $f pre=$a post=$b"; rc=1; fi
done
for f in listing.txt files.sha256 acl.txt; do diff "$pre/$f" "$post/$f" | head -n 40; done
echo "compare rc=$rc"
exit $rc
