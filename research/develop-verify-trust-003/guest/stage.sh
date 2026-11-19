#!/bin/bash
# DEVELOP-VERIFY-TRUST-003 guest run, step 1 (guest root): stage from the content pins and install (APPROVAL.md Part 1).
set -euo pipefail
umask 022
export PATH=/usr/bin LC_ALL=C
c=$(cat /root/stage/commit)
echo "== collision check"
for p in /usr/local/lib/endo-verify-002 /var/lib/endo-verify-002 /var/lib/endo-verify-002-home /run/endo-verify-002 \
  /etc/systemd/user/endo-verify-002.socket /etc/systemd/user/endo-verify-002@.service /etc/sysusers.d/endo-verify-002.conf \
  /etc/tmpfiles.d/endo-verify-002.conf /var/lib/systemd/linger/endo-verify-002 /home/endoagent /opt/trust003 /root/trust003; do
  [ ! -e "$p" ] || { echo "COLLISION $p"; exit 66; }
done
for n in 1500 endoagent endo-verify-002; do
  ! getent passwd "$n" >/dev/null || { echo "COLLISION user $n"; exit 66; }
  ! getent group "$n" >/dev/null || { echo "COLLISION group $n"; exit 66; }
done
echo "no collisions"
echo "== root-owned checkout of $c"
install -d -m 0755 /opt/trust003
git clone -q --no-hardlinks /root/stage/repo.bundle /opt/trust003/src
cd /opt/trust003/src
git -c advice.detachedHead=false checkout -q "$c"
test "$(git rev-parse HEAD)" = "$c"
test -z "$(git status --porcelain)"
e=research/develop-verify-trust-003/evidence
a=research/develop-verify-trust-002
sha256sum -c - <<'PINS'
05cb46a763e8b8748336c76dc64ab3f380979277262bd0f7c7cf939ab6f0a6a0  research/develop-verify-trust-003/evidence/guest-checkout.sha256
84aa73ecafadc0561a9409f10071e866ce1fc35b778b5cb0f4e7fbff4ad1f523  research/develop-verify-trust-003/evidence/guest-package-content.sha256
PINS
sha256sum --quiet -c "$e/guest-checkout.sha256"
echo "checkout pins: all $(wc -l < "$e/guest-checkout.sha256") files match"
chmod -R go-w /opt/trust003
echo "== package"
install -d -m 0700 /root/trust003
node "$a/install/layout.ts" package --commit "$c" --out /root/trust003/trust003-guest.tar \
  --operator-uid 1500 --operator-home /home/endoagent --operator-group endoagent
cp "$a/install/install.sh" "$a/install/uninstall.sh" "$a/install/inspect.sh" "$e/guest-package-content.sha256" /root/trust003/
cd /root/trust003
sha256sum -c - <<'PINS'
84aa73ecafadc0561a9409f10071e866ce1fc35b778b5cb0f4e7fbff4ad1f523  guest-package-content.sha256
400d9cfec70e6f5156922f3cdc01678847a9200a3cebb700b759b5d0192ed94b  install.sh
b58320b5a2824f5841c83c55464f1555fef044666fbe2e2c4da0d887eecc4727  uninstall.sh
f1433420c6d8429114bc8ba5a05b6061ed64da9d52bdd439d828cb38ffc874e4  inspect.sh
PINS
rm -rf x && mkdir x && tar -xf trust003-guest.tar -C x
test "$(cd x && find . -type f | sort | sed 's|^\./||')" = "$( (cut -c67- guest-package-content.sha256; echo lib/installation.json) | sort)"
(cd x && sha256sum --quiet -c ../guest-package-content.sha256)
test "$(jq -S -c 'del(.sourceCommit)' x/lib/installation.json | sha256sum | cut -c1-64)" = d1a018c4607936cb67c2b4d21df3615ba74536f71ca059fd497c6545d73c1cf0
echo "package content: file list, $(wc -l < guest-package-content.sha256) digests and normalized manifest match"
echo "sourceCommit $(jq -r .sourceCommit x/lib/installation.json)"
P=$(sha256sum trust003-guest.tar | cut -c1-64); rm -rf x
echo "package sha256 $P"
echo "== agent identity"
groupadd -g 1500 endoagent
useradd -m -d /home/endoagent -u 1500 -g endoagent -s /usr/bin/bash endoagent
chmod 0700 /home/endoagent
id endoagent; getent group endoagent; passwd -S endoagent
echo "== install"
sh /root/trust003/install.sh /root/trust003/trust003-guest.tar "$P"
sleep 3
sh /root/trust003/inspect.sh
