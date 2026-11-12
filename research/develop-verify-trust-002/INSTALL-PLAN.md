# DEVELOP-VERIFY-TRUST-002: installation plan for the approved host experiment

**Nothing in this file has been executed.** It is the operator approval package that PROTOCOL.md §6 and the brief's approval boundary
require. Every root command below is in [`install/install.sh`](install/install.sh) or [`install/uninstall.sh`](install/uninstall.sh), which
were syntax-checked (`sh -n`) and never run.

## 1. Precondition: H0 (the agent's account has no passwordless route to root)

On this host H0 fails (THREAT-MODEL.md §6, and `audit.ts`, RESULTS.md §3). The operator account is a member of `docker` (with a
writable `/run/docker.sock`) and `libvirt` (polkit `YES` for system hypervisor management). Either route makes the agent root, and with
it every ownership row of the matrix meaningless. The installed experiment therefore **starts only after**:

| Step | Command (root) | Reversal |
| :-- | :-- | :-- |
| Remove the operator from `docker` | `gpasswd -d noctem docker` | `gpasswd -a noctem docker` |
| Remove the operator from `libvirt` | `gpasswd -d noctem libvirt` | `gpasswd -a noctem libvirt` |
| End every process that still holds those groups | log out of every session, or reboot | — |
| Confirm no `NOPASSWD` sudo rule and no global sudo timestamp for the account | `sudo -l` (read the output); `grep -r timestamp_type /etc/sudoers /etc/sudoers.d` | — |

Removing the groups from the processes is not enough: `newgrp` and `sg` let a member of a group in `/etc/group` regain it without a
password. The membership itself has to go. The harness checks this from the attacker's session (`audit.ts`, gate IP0) and stops before any
trial if it fails.

During the experiment the operator should not authenticate any polkit or `sudo` action in the agent's login session. `auth_admin_keep`
and sudo timestamps could otherwise be reused by the agent for a few minutes.

## 2. Exact changes

| Path | Owner, mode | What |
| :-- | :-- | :-- |
| user and group `endo-verify-002` | system uid and gid (allocated by `systemd-sysusers`), locked, shell `/usr/bin/nologin`, no supplementary groups | the verifier principal |
| `/etc/sysusers.d/endo-verify-002.conf` | `root:root 0644` | its definition (`/etc/sysusers.d` is created if absent, and removed again by uninstall if it was) |
| `/usr/local/lib/endo-verify-002/` | `root:root`, dirs `0755`, files `0644` | 8 TypeScript modules (the verifier, its reader and their value-import closure: `bubblewrap.ts`, `containment.ts`, `preflight.ts`, `canonical-json.ts`, `objects.ts`, `request.ts`, `records.ts`, `verifier.ts`), `package.json`, `installation.json` |
| `/usr/local/lib/endo-verify-002/oracle/roman-numerals-cli/` | `root:endo-verify-002`, dirs `0750`, files `0640` | the pinned oracle, reference and negative |
| `/var/lib/endo-verify-002-home/.config/systemd/user/` | `root:root 0755` | the principal's home: masks (links to `/dev/null`) for every user unit enabled globally at install time (here: `wireplumber`, `xdg-user-dirs`, `gnome-keyring-daemon.socket`, `p11-kit-server.socket`, `pipewire-pulse.socket`, `pipewire.socket`) |
| `/etc/tmpfiles.d/endo-verify-002.conf` | `root:root 0644` | creates the next two at boot |
| `/var/lib/endo-verify-002/` | `endo-verify-002 0755` | state: `work/` (`0700`), `journal/`, `records/` |
| `/run/endo-verify-002/` | `endo-verify-002 0755` | holds `verify.sock` (`0666`), created by the principal's manager |
| `/etc/systemd/user/endo-verify-002.socket`, `/etc/systemd/user/endo-verify-002@.service` | `root:root 0644` | the units (rendered by `install/layout.ts`; `ConditionUser=endo-verify-002`) |
| `/etc/systemd/user/sockets.target.wants/endo-verify-002.socket` | link, by `systemctl --global enable` | starts the socket in the principal's manager. Other users' managers skip it (`ConditionUser`). |
| `/var/lib/systemd/linger/endo-verify-002` | by `loginctl enable-linger` | PID 1 runs `user@<uid>.service` for the principal, now and at boot |

**Not changed:** no package installed or upgraded; no `/etc/sudoers`, polkit, PAM, kernel, sysctl, cgroup, namespace or ptrace setting;
no network configuration; no existing unit, user or group other than the operator's `docker`/`libvirt` membership (§1, reversible).

**Executables and dependencies.** None new. The verifier runs the packaged `/usr/bin/node` (26.13.1), `/usr/bin/bwrap` (0.13.1) and
`/usr/bin/systemd-run` (systemd 262), all root-owned and checked at each run. It does not use Git.

**Network.** None. The socket is a Unix socket; the candidate's sandbox has its own empty network namespace; the verifier opens no
inet socket.

**Files the verifier can write.** Its state directory, `/run/user/<uid>` (its manager's) and its private `/tmp` directories. Everything
else it reads is root's.

## 3. Installation

As the operator, from a clean checkout of the frozen commit, in a session where H0 holds:

```sh
node research/develop-verify-trust-002/install/layout.ts package --commit <frozen commit> \
  --out /tmp/endo-verify-002.tar --operator-uid "$(id -u)" --operator-home "$HOME"
```

The package is reproducible: the same commit gives the same SHA-256 (tested: two builds, one digest). The operator compares the printed
digest with the one in the approval request on the PR page, then, as root:

```sh
sh research/develop-verify-trust-002/install/install.sh /tmp/endo-verify-002.tar <sha256 from the approval request>
```

`install.sh` refuses a digest mismatch, any existing target path, a package that holds anything but files and directories, and an
existing user of that name.

**The weak moment.** `install.sh` itself and the package are read from files the operator's account can write. Root runs whatever is there
at that instant. Compare `sha256sum install.sh` and the package digest with the approval request read on GitHub, from a session the agent
has not touched, immediately before running it.

## 4. Inspection

`sh research/develop-verify-trust-002/install/inspect.sh` (any user, read-only) lists the principal, linger state, its processes, the
ownership and mode of every path in §2, the installation identity and the record count. `node research/develop-verify-trust-002/audit.ts
--installed` adds the ownership audit of the installed tree and H0.

## 5. Removal

As root: `sh research/develop-verify-trust-002/install/uninstall.sh [/root/endo-verify-002-records.tar.gz]`

It does the following, in order:
1. Optionally archives `records/` and `journal/`.
2. Disables linger and stops the principal's manager, which ends its instances, scopes and sandboxes.
3. Disables and removes the units and the sysusers and tmpfiles entries.
4. Removes `/usr/local/lib/endo-verify-002`, `/var/lib/endo-verify-002`, its home and `/run/endo-verify-002`.
5. Deletes the user and group.
6. Checks that every path is gone, and that no file or process of the old uid remains in `/tmp`, `/var/tmp`, `/dev/shm`, `/run` or
   `/var/lib`.

It can be run more than once and after a partial install. Then restore the operator's groups (§1) if wanted, and log in again.

## 6. The experiment (installed phase)

From a fresh login session of the operator, after §1 and §3, from a clean checkout of the frozen commit:

```sh
node research/develop-verify-trust-002/audit.ts --installed          # gate IP0: must print "h0": true
env -i PATH=/usr/bin HOME=$HOME LANG=C.UTF-8 XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
  /usr/bin/node research/develop-verify-trust-002/rehearsal.ts run ~/projects/endophasia-research/develop-verify-trust-002/installed-1 \
  --commit <frozen commit> --target installed
```

Two rows need the operator's own interruption, because the agent's `kill` is expected to fail (`EPERM`). When the harness prints
`T10: interrupt …` and later `E3: restart …`, run within 120 seconds, as root in a second terminal:
- **T10:** `pkill -KILL -u endo-verify-002 -f 'verifier.ts serve'`
- **E3:** `systemctl restart user@$(id -u endo-verify-002).service`

Then run it a second time into `installed-2`, and remove (§5).

## 7. Expected resource use (measured in the rehearsal)

| | |
| :-- | :-- |
| Idle | The principal's user manager and `(sd-pam)`: about 10 to 20 MB resident, no CPU. No verifier process. |
| Per request | About 3.3 s wall time and 1 CPU second; about 110 MB peak for the instance, plus one short sandbox at a time (TasksMax 512 per scope, 16 MiB tmpfs). |
| Disk | About 15 KB per record and 18 KB per journal. |
| Concurrency | At most 4 instances (`MaxConnections=4`); systemd refuses further connections until one ends. |

## 8. Security assumptions and residual risks after installation

- **Trusted:** root, the kernel, PID 1, logind, PAM, the package-managed `node`, `bwrap` and systemd, and the install moment (§3).
- **H0 must keep holding.** Re-adding the operator to `docker` or `libvirt`, a `NOPASSWD` rule, or a polkit `YES` rule for the operator
  voids the boundary silently.
- **Request-triggered code execution in the verifier** would give the attacker the verifier principal, **persistently**. It could write
  forged records, which would be authoritative. It could also add runtime drop-ins or environment to the principal's own user manager
  (`/run/user/<uid>/systemd/user`), which later instances would run until reboot or removal (review V4). The request parser and object verifier are the surface; the candidate itself runs only
  inside Bubblewrap.
- **Consumers running as the operator's uid** can be subverted by the agent: an edited `PATH`, `.bashrc` or reader script makes any
  verdict look like anything. The evidence stays authentic, but the operator's view of it does not. ARCHITECTURE §6's reading rule
  helps only when the reader itself is outside the agent's reach: root-owned reader code, run from a trusted shell, or a consumer on
  another principal.
- **The units are visible to every user manager.** `ConditionUser` keeps them from starting elsewhere. A user unit enabled globally after
  the install is not masked for the principal (§2); `inspect.sh` lists the principal's processes.
- **Oracle exposure:** the operator's checkout still holds the public oracle. The installed copy is readable by the verifier only, but
  that hides nothing here.
