# Attempt 1 — INCOMPLETE

Installed source: `42abf71b8280d301ca53d212659688c432a2fa99`, based on main at
`e8f3cd1c4df4f3802c2c5ecd6061181984010d23`. The frozen attempt branch is unchanged.
The guest stopped at the supplemental protected-path census, before the first submission.
No installed matrix rows ran. There are no PASS, FAIL, BLOCKED, false-PASS or
unconfirmed-PASS records to count. No candidate binding, Git-child identity, grading,
termination, pre/post comparison or offline reanalysis was observed.

**Guest observation.** Agent UID/GID 1500 and verifier UID/GID 968 had only their
own groups. The installed gate and strict sudo-policy check passed. The failed
check was the unnamed `principals` predicate in TRUST-004 run.sh lines 45–46,
not TRUST-002's `installed-root` or `installed-socket-gate`. It rejected any
line from the writable-path survey matching a protected prefix, without distinguishing
a writable endpoint or link target from a replaceable directory entry.

**Operator-root observation.** The two literal matches and subsequent stat output
are in [console-excerpt.txt](console-excerpt.txt). The mask was in the verifier's
home, not in /etc/systemd/user. The frozen installer creates root-owned masks for
globally enabled user units. Its target is writable; its containing directory
was root:root 0755. The second entry was the submission socket, verifier-owned
0666 in a verifier:endoagent 0750 directory. The agent needs socket access to
submit; the independent grader does not. Neither line demonstrates an ability
to change a directory entry, verifier configuration or an authoritative record.

**Environment.** Arch cloud image 20261101.620452, SHA-256
`794eb4889b39e1f0ed7d5ae998b2a1ed2137db8cf8c3476cf2962c7437ecb003`.
Its detached signature verified against arch-boxes signing subkey
`656E4C5AC1CC3B86E539D97E343635A6859A9174`; trust in the published key
still rests on its distribution channels. QEMU 11.1.3/KVM, 4 vCPU, 4 GiB,
20 GiB overlay; test boot used -nic none and showed only lo. There was no QEMU
host listener; guest systemd-resolved had wildcard listeners **inside the guest**.
Guest kernel 7.3.4-arch1-2, Node 26.13.1, bubblewrap 0.13.1, Git 2.56.1.

**Retention.** The guest powered off. At review the overlay and console under
`~/.capy/work/endo13/vm/` hashed to
`26c0877e89bee49b47427f3a54b389fed78b6cd8284aa66cd11b60201febf18b`
and `114f34699f4e42fc111ff85372e7a209ca1545c330feab0b1965dfe80a7dcbce`
respectively. These are retained local files, not independently immutable public
archives. Uninstall and destructive teardown were not performed. Workstation H0
remains blocked.

## Amendment 2 proposal — 2026-11-19 (not applied to the live driver)

Review the exact socket only as an intended submission endpoint, never as
trusted state. Require its observed type, owner, mode, parent ownership and
permissions, unique group membership, absence of other agent-writable nodes,
and independently established effective access and protected ancestry. This
justifies connecting to this endpoint; it makes no claim about what messages
the verifier can safely process. For the installer mask require the exact path,
root-owned symlink to /dev/null, and protected ancestry. Neither exception
applies to a state file, installation file or unit in /etc. Missing observations
must not be inferred from a successful fixture.

**Deterministic fixture only.** Run `python3 -B -m unittest test_review` in this
directory. The offline metadata predicates exercise positive and negative controls;
they neither acquire live metadata nor authorize a run. No new installed
attempt was frozen or started. The original acceptance criteria remain unchanged.
