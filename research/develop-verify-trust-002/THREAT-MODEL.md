# DEVELOP-VERIFY-TRUST-002: threat model

Research only. It extends [DEVELOP-VERIFY-TRUST-001](../develop-verify-trust/REPORT.md) and its
[addendum](../develop-verify-trust/addendum-1/ADDENDUM.md), whose findings it takes as given and does not reinterpret.

## 1. The property under test

> An unprivileged agent running under the operator's Unix account cannot cause an incorrect candidate to receive an **authentic,
> verifier-produced PASS** by modifying trusted code, manipulating Git inputs, changing staged candidate files, or forging or replacing
> records.

**Incorrect** means: at least one oracle case does not produce its expected exit code and standard output when the candidate's committed
files run honestly under the verifier's isolation (ground truth comes from running each fixture directly, as in 001). An implementation
that passes every oracle case is *correct with respect to the oracle*. Whether the oracle is adequate (a lookup table of the visible
cases would pass) is outside the property.

**Authentic** means: a consumer following the published reading rule (ARCHITECTURE.md §6) accepts it as produced by the installed
verifier. It is not a property of a record's content alone.

The property is narrower than agent security. The agent may submit requests, may submit as many as it likes, and may learn from their
results. Who asked, and whether a human approved, are separate questions (§5).

## 2. Principals

| Principal | Unix identity | Trusted for | Can |
| :-- | :-- | :-- | :-- |
| **root** | uid 0 | installing, updating and removing the verifier; the kernel's and the system manager's configuration | everything |
| **System manager** | PID 1 | starting the verifier principal's user manager (lingering) with an environment root configured | start and stop units |
| **Verifier principal** | `endo-verify-002`, a locked system uid with no login shell, a root-owned home and no supplementary groups | running the verifier; owning its working state and records | write `/var/lib/endo-verify-002` only; create user namespaces (bubblewrap) |
| **Verifier user manager** | `systemd --user` for that uid, started by PID 1 because of a root-created linger file | socket activation of one verifier instance per request; the per-case scopes | start units as that uid |
| **Operator** | the workstation user (`noctem`, uid 1000) | deciding what to install and which records to rely on | everything the account can do |
| **Agent** (the attacker) | **the operator's uid**, unsandboxed: Pi, Codex, Claude Code or a shell, launched by Endophasia or not | nothing | everything the operator's account can do without a password |

The agent and the operator are indistinguishable to the kernel. Anything the operator can read without a password, the agent can read.
Anything the operator can write without a password, the agent can write.

## 3. Assets

1. The verifier's code, its dependency closure, its runtime (`node`) and every library, configuration and environment variable that
   decides what that code does.
2. The oracle: the case list and expected results, and the reference and negative programs used for qualification.
3. The candidate in transit, and its staged files during verification.
4. The verifier's working files, journals and final records.
5. The binding of a record to a commit, its exported bytes, the verifier installation, the oracle and one invocation.

## 4. Attacker capabilities (in scope)

As the operator's uid, without a password:
- Read and write the operator's files, including every repository, worktree, research checkout and `~/.config`.
- Start, stop, override and set the environment of the **operator's** user manager and its units.
- Run any program, including dynamic-loader variables (`LD_PRELOAD`, `LD_AUDIT`), `NODE_OPTIONS`, `PATH` shims, and Git configuration
  (replace refs, promisor remotes, hooks, `fsmonitor`).
- Connect to the verifier's socket, send any bytes, disconnect at any time, send concurrent requests and replay earlier ones.
- Race the verifier: watch, rename, replace or swap any path it can write.
- Write files anywhere it can, including copies of genuine records, resealed forgeries and symbolic links.
- Signal and `ptrace` its own processes (Yama `ptrace_scope` is 1 on this host: descendants only).

## 5. Out of scope, and why

| Excluded | Reason |
| :-- | :-- |
| Root, kernel and hardware compromise | The trusted computing base. Any principal boundary on one host assumes it. |
| **Passwordless routes to root or to the verifier uid** | They make the agent privileged. §6 records that this host **has them**; the property cannot hold on it until they are removed for the agent's sessions. |
| Attacks that need the operator's password (sudo, polkit `auth_admin`) | Out of reach of the agent, unless it can capture the password or reuse a cached credential (§6). |
| Request authorization, and human attribution | `SO_PEERCRED` (which systemd passes in the instance name) gives the connecting process's uid and pid. The agent has the operator's uid, so it proves "a process of the operator's account asked", never "the operator asked" and never "a human approved". That needs an independent channel (a second factor, a prompt in a trusted UI), which is not studied here. |
| Denial of service | The agent can flood the socket, fill the operator's disk or kill its own client. That yields BLOCKED or INCOMPLETE, never PASS. |
| Oracle adequacy and adaptive overfitting | Records are readable by the operator, hence by the agent. They say which cases failed (not their expected output). An agent can learn from repeated submissions; it can then produce a program that is correct for the oracle. |
| Side channels (timing, cache) | Not studied. |
| Non-Linux hosts | The mechanism is Linux-specific (bubblewrap, cgroup v2, systemd). |

## 6. Host prerequisite H0, observed before preregistration

The property needs **H0: the agent's account has no unauthenticated route to root or to the verifier principal.** It was checked
non-invasively (group membership, socket permissions, readable polkit rules; no `sudo` was run, and no route was exercised):

| Route | This host | Effect |
| :-- | :-- | :-- |
| `docker` group, `dockerd` active, `/run/docker.sock` `root:docker 0660` | **present** | A container with the host's root filesystem mounted is root on the host. Docker documents the group as root-equivalent. |
| `libvirt` group, system `libvirtd` active, polkit rule `50-libvirt.rules` returns `YES` for the group | **present** | Managing the system hypervisor without a password; a domain or storage pool can expose host files as root. |
| `wheel` group | present | `sudo` and polkit `auth_admin` normally ask for the password. `/etc/sudoers.d` is not readable here, so `NOPASSWD` or a global timestamp cannot be ruled out by inspection. |
| `empower` polkit group (`run0 --empower`) | absent | |

**H0 does not hold on this host as configured.** Every row of this study that depends on ownership (T6, T7, T8) is defeated on this host by
any agent that uses the docker socket, whatever the verifier's design. This is a property of the operator account, not of the verifier,
and the study does not exercise it: running a root-equivalent container is a privileged attack technique.

## 7. What each mechanism is trusted to enforce

| Mechanism | Enforces | Does not enforce |
| :-- | :-- | :-- |
| File ownership and modes (verifier uid, root) | The agent cannot write the code, the configuration, the state directory or the records; it cannot read `0700` working directories or a `0640` oracle | Anything, if H0 fails |
| Different uid | No signals, no `ptrace`, no `/proc/<pid>/environ` or `mem` across uids | `/proc/<pid>/cmdline` stays world-readable: nothing secret goes in argv |
| PID 1 and the linger file | The verifier's user manager, and so the verifier's environment, are configured by root | Nothing about the requests it serves |
| Socket activation (`Accept=yes`) | One fresh process per request, started by the verifier's manager: the caller's environment, file descriptors, limits and working directory never reach it | Which caller connected (uid only) |
| In-process object verification | What is verified is exactly the commit's bytes: every object id is recomputed from its content | SHA-1 collisions (§ARCHITECTURE 5.3) |
| Bubblewrap and the per-case scope (001, unchanged) | The candidate cannot see the oracle, the verifier or the host; its processes' end is confirmed | Anything outside the sandbox |
| The record's unkeyed digest | Detects accidental damage | Authenticity (001 row 9d) |
