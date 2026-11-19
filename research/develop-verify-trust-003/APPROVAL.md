# Approval boundary: a guest first, not this workstation

**Requested decision:** authorize a single disposable Linux VM with a dedicated **guest** agent and the 002 verifier, or keep DEVELOP at protected, review-only C. No workstation install, group removal, socket permission change or promotion is requested. Do not run the following on the workstation. These are proposed operator actions, not results. No guest was created.

Use a clean, snapshotted guest with systemd user managers, cgroup v2, unprivileged user namespaces, package-managed Node/bwrap/Python/bash/Git, a compiler for the 002 fixtures, the classic `sudo` package, and no Docker/libvirt sockets. **sudo is required:** the installed gate stops unless `sudo -n true` returns status 1 with one of classic sudo's policy messages (*a password is required*, *not allowed to execute*, *not in the sudoers*), so a sudo-less guest reports BLOCKED for a reason unrelated to H0. **sudo-rs caveat (untested):** sudo-rs words its non-interactive refusal differently (for example *interactive authentication is required*), which the check does not recognise, so a guest with sudo-rs would also be falsely BLOCKED. That is a gate defect, not an H0 result; do not widen the pattern on the spot. Fix it in the repository with a test first. Give it bounded disk/CPU/RAM and no shared folders, host devices, SSH agent, host session bus or host credentials. Keep a separate trusted guest root console. If prerequisites need installing, agree the image separately; do not change the host to accommodate it. The package's uid, home and group are **not** the workstation operator's.

**Staging (unprivileged). Pinned by content, not by commit.** The trials ran at `89b6100b3b17779925da45cc170f5a657a307b0d`, which exists only on this branch; a squash merge and branch deletion would remove it. So the precondition is that the checkout **contains the pinned bytes**, whatever commit they arrive in (this branch, or `main` after a squash). Two pin lists in this directory carry the content: [guest-checkout.sha256](evidence/guest-checkout.sha256) covers the harness, audit, layout, install scripts, their import closure and fixtures (37 files); [guest-package-content.sha256](evidence/guest-package-content.sha256) covers every file of the package except its manifest. Compare these two literal digests of the lists themselves with an independent view of this review before trusting either:

```text
d812f1f776c756f9cceffa52538074cd27dd02490d65c8be63fe1e0025847bad  research/develop-verify-trust-003/evidence/guest-checkout.sha256
ff2387c48893461095b786c0619627b0b87fe6227d175aade26831fc75adac7c  research/develop-verify-trust-003/evidence/guest-package-content.sha256
```

Then, from a clean checkout of whichever commit holds them:

```sh
set -eu
e=research/develop-verify-trust-003/evidence
a=research/develop-verify-trust-002
test -z "$(git status --porcelain)"
sha256sum -c - <<'PINS'
d812f1f776c756f9cceffa52538074cd27dd02490d65c8be63fe1e0025847bad  research/develop-verify-trust-003/evidence/guest-checkout.sha256
ff2387c48893461095b786c0619627b0b87fe6227d175aade26831fc75adac7c  research/develop-verify-trust-003/evidence/guest-package-content.sha256
PINS
sha256sum --quiet -c "$e/guest-checkout.sha256"
c=$(git rev-parse HEAD)
node "$a/install/layout.ts" package --commit "$c" --out /tmp/trust003-guest.tar \
  --operator-uid 1500 --operator-home /home/endoagent --operator-group endoagent
```

The package's manifest names its source commit, so the **tar digest depends on the commit**: `00c5b3c70ef7cee858f29f4cd84d5d47a17b97d9b08c6e5e3eca1f5d11e5eedc` holds only for a build from `89b6100b3` (two independent builds matched). From any other commit, check the content instead. Copy the tar, `install.sh`, `uninstall.sh`, `inspect.sh` and the package-content list to **guest-root-only** staging (`/root/trust003`). As guest root:

```sh
set -eu
cd /root/trust003
sha256sum -c - <<'PINS'
ff2387c48893461095b786c0619627b0b87fe6227d175aade26831fc75adac7c  guest-package-content.sha256
400d9cfec70e6f5156922f3cdc01678847a9200a3cebb700b759b5d0192ed94b  install.sh
b58320b5a2824f5841c83c55464f1555fef044666fbe2e2c4da0d887eecc4727  uninstall.sh
f1433420c6d8429114bc8ba5a05b6061ed64da9d52bdd439d828cb38ffc874e4  inspect.sh
PINS
rm -rf x && mkdir x && tar -xf trust003-guest.tar -C x
test "$(cd x && find . -type f | sort | sed 's|^\./||')" = "$( (cut -c67- guest-package-content.sha256; echo lib/installation.json) | sort)"
(cd x && sha256sum --quiet -c ../guest-package-content.sha256)
test "$(jq -S -c 'del(.sourceCommit)' x/lib/installation.json | sha256sum | cut -c1-64)" = d1a018c4607936cb67c2b4d21df3615ba74536f71ca059fd497c6545d73c1cf0
jq -r .sourceCommit x/lib/installation.json   # record it with the results
P=$(sha256sum trust003-guest.tar | cut -c1-64); rm -rf x
```

Run that block and the installation below in the same root shell. `$P` is the digest of this root-held copy, checked by content just above; it is what `install.sh` verifies again on its own private copy. The normalized manifest digest covers every file digest, the oracle pins, the tools and the operator uid and home; only `sourceCommit` is excluded. The tar does not install the agent identity or the host runtimes. Verify runtime ownership, versions and hashes again in the guest.

**Guest-only changes, after approval.** Require uid/gid 1500, both account names and *every* target path in [002's installation inventory](../develop-verify-trust-002/INSTALL-PLAN.md) to be unused. Abort on any collision. Create a private guest-only workspace identity with no supplementary groups. Do not add it to the developer's group; check NSS primary groups as well as explicit members. If using a console password, set a fresh guest-only one interactively, never in a script.

```sh
groupadd -g 1500 endoagent
useradd -m -d /home/endoagent -u 1500 -g endoagent -s /usr/bin/bash endoagent
chmod 0700 /home/endoagent
passwd endoagent
sh /root/trust003/install.sh /root/trust003/trust003-guest.tar "$P"
sh /root/trust003/inspect.sh
```

Installation creates the separate locked verifier, root-owned code/oracle/units and verifier-owned state, enables linger and a Unix socket. Its user units are visible to other **guest** managers. A compromised verifier could persist in its own runtime manager. From root, review actual groups, ACLs, all sudoers/polkit rules, privileged services, writable startup paths and other users with the same primary group. Supply the agent and independent reader with separate clean, pinned copies of their tools. **Never run the agent's checkout as root or as the operator.**

**First stop, before testing authority.** In a new local login as endoagent, run `id` and `/usr/bin/node research/develop-verify-trust-002/audit.ts --installed` in the frozen checkout. Require uid 1500, the private group only, independent verifier uid, expected runtime/installation digests, socket directory `0750 verifier:endoagent`, `h0:true` and `closure:true`; require the operator's independent policy review as well. These checks are necessary, not sufficient. Only the guest operator checks sudo policy in that session; an error starting a policy tool is not a denial. If any condition fails, preserve the output and stop. No new socket ACL or weaker gate as a workaround.

The subsequent **guest-only** experiment retains 002's [installed protocol](../develop-verify-trust-002/PROTOCOL.md) and [operator-run sequence, §6](../develop-verify-trust-002/INSTALL-PLAN.md), using the commit you staged from (`$c`, content-checked above; pass it as `--commit`) and new output directories under the guest agent's private home. Run twice. At the two interrupt/restart prompts, confirm the dedicated guest verifier instance before acting; never interrupt the developer's manager or a process selected only by a reused PID. Independently read the final records from the protected state root with a trusted reader, binding both commit and export digest. Review every row, including the errno for the T7 configuration write, overwritten-record list and orphan state from the trusted console; the aggregate IA flags alone do not check all of these. No authentic incorrect PASS is tolerable. A VM pass says nothing about the operator's workstation until repeated there under a separately approved plan.

**Rollback.** As guest root, archive records/journals before stopping the verifier:

```sh
sh /root/trust003/uninstall.sh /root/trust003/verifier-records.tar.gz
sh /root/trust003/inspect.sh
```

Verify the archive and preserve only reviewed evidence outside the guest. Restore the pre-experiment VM snapshot or discard the VM, including the agent account, staging, credentials and scratch space. If installation/cleanup failed partway, retain its diagnostics and discard the guest rather than attempting a live-host repair. No workstation rollback is needed. This package does **not** authorize applying the guest commands to the workstation.
