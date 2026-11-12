# DEVELOP-VERIFY-TRUST-002: architecture

Research only: nothing here is a product path, and nothing here was installed. The threat model is [THREAT-MODEL.md](THREAT-MODEL.md);
the experiment is [PROTOCOL.md](PROTOCOL.md).

## 1. What 001 left open

Bubblewrap and the per-case scope protect the oracle and the host **from the candidate**. Nothing protected the verifier from the
**agent**, which shares the operator's uid. Every same-user false PASS in 001 happened outside the sandbox:
- 9d: a forged, resealed record;
- R4b: an edited verifier that reported the original source digests;
- R3: concurrent tampering with an honest verifier's staged files;
- R1 and R2: the candidate repository's Git metadata, before C1;
- V1: loader variables in the launcher's own caller.

The question is where to put a boundary that excludes all of these at once.

## 2. Three arrangements

### A. A separate verifier service (a permanent daemon)

A distinct system uid runs a long-lived verifier process that accepts requests on a Unix socket (`Accept=no`). Code is root-owned; staging
and records belong to the service uid.

### B. A separate principal, one short-lived process per request

The same principal and ownership as A, but no verifier process exists between requests. A socket held by a manager starts one verifier
instance per connection (`Accept=yes`), which reads one request on standard input, writes one response and exits.

**The trusted starter.** An ordinary `systemd --user` instance runs as its own user and cannot start processes under another uid, so the
operator's user manager cannot be it. The candidates were:

| Starter | Verdict |
| :-- | :-- |
| **The verifier uid's own user manager**, started by PID 1 because root created its linger file | **Selected.** The environment is root's configuration (PAM and `/etc/systemd`); the verifier's home is root's. Its per-case scopes are in its own delegated cgroup subtree, so 001's `containment.ts` and `runSandboxV0` are reused **unchanged**. |
| A system socket and template service (`User=endo-verify-002`) under PID 1 | Rejected **for now**. The instance would sit under `system.slice`, so a `systemd-run --user --scope` from it would have to move processes across a root-owned common ancestor, which cgroup v2 refuses. It would need new containment code on a delegated cgroup (`Delegate=yes`, `cgroup.kill`, `cgroup.events`). That is feasible but untested, and it is not 001's mechanism. |
| A setuid helper | Rejected. It inherits the caller's environment, file descriptors, limits, working directory and signals, and it needs native code. |
| A `sudo` or `run0` rule | Rejected. It needs `/etc/sudoers` or polkit changes, and the environment is partly the caller's. A `NOPASSWD` rule is one more route to another uid. |

### C. Isolate the agent, keep the ordinary verifier

Run the DEVELOP agent inside the existing protected sandbox (`endo experiment protected-run`, EVAL-ISO-001 to 003), and keep
verification outside it, as the operator's uid.

## 3. Comparison

| | A. Service daemon | **B. Per-request, separate principal** | C. Isolated agent |
| :-- | :-- | :-- | :-- |
| **Enforced against an unsandboxed agent** (Pi, Codex, Claude Code run directly by the operator) | Code, staging and records out of the agent's reach, **if H0 holds** | The same, **if H0 holds** | **Nothing**: such an agent is never in the sandbox, and the verifier is its own uid |
| **Enforced against an agent Endophasia launches** | As above | As above | The sandbox hides the verifier, its records and the docker and user-bus sockets (001's preflight checks them). This holds **even without H0**. |
| **Remaining attack paths** | Code execution in the daemon from a hostile request persists across requests; H0; the install step | Code execution from a hostile request lasts one request (its writes to `records/` would persist); H0; the install step | **The workspace is a channel back to the operator's uid.** An agent that writes `.git/hooks`, `.git/config` (`core.fsmonitor`, `core.hooksPath`), `package.json` scripts, `.envrc` or editor tasks runs code as the operator the next time the operator uses that worktree. From there it can forge any same-uid record (001's 9d). C holds only until agent-written content first runs unsandboxed. |
| **Harness integration** | Any harness: a client is a small program that sends objects to a socket | The same | Only harnesses Endophasia can run inside bubblewrap: Pi today (EVAL-ISO-002/003, local model through a relay). Codex and Claude Code would need their own network relays and tools inside the sandbox. |
| **Local-first** | Yes | Yes | Yes |
| **Start-up per request** | None | One `node` start (~0.1 s) plus the work | None for verification |
| **Execution cost** | The same in all three: qualification plus cases, 45 sandboxes for this oracle (measured in RESULTS.md) | | |
| **Idle resources** | A resident `node` process (tens of MB) and a lingering manager | The verifier's lingering user manager only (~10 to 20 MB resident; the operator's own manager is 18 MB with a desktop session's units) | None |
| **Installation** | System uid, linger, units, root-owned code; and a daemon to monitor | System uid, linger, units and root-owned code; nothing resident of its own | None |
| **Failure recovery** | A crashed or wedged daemon blocks everything until restarted; in-flight work is lost | Each request is independent; an instance that dies leaves its journal without a record (INCOMPLETE), and the next instance clears its working files | Unchanged from today |
| **Portability** | Linux with systemd (as all three: bubblewrap and cgroup v2) | The same | The same |

**Recommendation: B.** It is the smallest arrangement that addresses the stated threat (an agent with the operator's uid, launched by
anything). It adds no resident code and reuses 001's isolation unchanged. A is B plus a process that has to be kept alive. C does not
address agents started outside Endophasia, and for those it does start it holds only until the workspace is used. C remains the right
**complement** on a host where H0 fails, because the sandbox hides the root-equivalent sockets.

Neither a native binary nor a rewrite is part of the selection. As 001's addendum §6 found, integrity comes from who can write the
files, not from the language.

## 4. The trust boundary

### 4.1 Ownership and permissions

| Asset | Path (installed) | Owner, mode | Who can replace it |
| :-- | :-- | :-- | :-- |
| Verifier code and its whole import closure (the 001 adapters it reuses, the canonical JSON module) | `/usr/local/lib/endo-verify-002/` | `root:root`, dirs `0755`, files `0644` | root |
| A `package.json` with `"type": "module"` at that root | the same | `root:root 0644` | root. Without it, Node walks to ancestor directories to decide the module type (001 addendum §9). |
| Installation manifest: every installed file's digest, the oracle pins, the source commit and the operator uid | `…/installation.json` | `root:root 0644` | root. Its digest is the **installation identity**. |
| Runtime and tools | `/usr/bin/node`, `/usr/bin/bwrap`, `/usr/bin/systemd-run`, `/usr/bin/systemctl` and their shared libraries | `root:root`, from the package manager | root. Checked at each run by 001's `resolveRuntimeV0` and `detectBubblewrapV0`. Git is **not** used by the verifier. |
| Oracle, reference and negative programs | `…/oracle/<task>/` | `root:endo-verify-002`, dirs `0750`, files `0640` | root. Readable by the verifier only. **All three** are pinned in the installation manifest (001's R9 pinned the case list only). |
| Units | `/etc/systemd/user/endo-verify-002.socket`, `/etc/systemd/user/endo-verify-002@.service` | `root:root 0644` | root. `ConditionUser=endo-verify-002` keeps every other user's manager from starting them. |
| Principal and directories | `/etc/sysusers.d/endo-verify-002.conf`, `/etc/tmpfiles.d/endo-verify-002.conf` | `root:root 0644` | root |
| Linger | `/var/lib/systemd/linger/endo-verify-002` (by `loginctl enable-linger`) | root | root |
| Socket | `/run/endo-verify-002/verify.sock` | created by the verifier's manager; dir `endo-verify-002 0755`, socket `0666` | the verifier's manager. Any local uid may connect; the verifier serves only the installed operator uid (§5.5). |
| State directory | `/var/lib/endo-verify-002/` | `endo-verify-002 0755` | the verifier uid |
| Working files (staged candidate, qualification copies) | `…/work/<invocation>/` | `0700`; staged files `0444`/`0555` | the verifier uid. The agent cannot list, read or swap them. |
| Journals | `…/journal/<invocation>.jsonl` | `0644` | the verifier uid |
| Records | `…/records/<invocation>.json` | `0644`, written once (`wx`, then `rename`) | the verifier uid. The operator, and so the agent, can read them. |
| Integrity or signing keys | **none** | | A key would be the verifier uid's, and the record's location already proves the same on this host (§6). Signatures become useful only for records that leave the host, which is not studied. |
| The candidate repository | the operator's | the operator's | the agent. The verifier never opens it (§5). |

### 4.2 Questions the boundary must answer

| Question | Answer |
| :-- | :-- |
| Who is trusted to initiate the verifier? | The verifier's user manager, per connection. Any local process can cause a start by connecting; none can choose what runs. |
| Who can replace its binaries? | root (installation, `pacman` for `node`, `bwrap` and systemd). |
| Who can modify its service configuration? | root (`/etc/systemd/user`, sysusers, tmpfiles, linger). The principal's home, `/var/lib/endo-verify-002-home`, is root's and holds only masks for the user units every user's manager would otherwise start (INSTALL-PLAN §2), so neither the principal nor anyone else can add user configuration for it. |
| Who can stop or interfere with it? | root; the verifier uid itself. The operator can only with its password: `systemctl stop user@<uid>.service` and `loginctl disable-linger` are polkit `auth_admin`. The agent can stop its own client, which does not stop the instance. |
| Can the agent inspect the verifier process? | It can see that it runs and its `cmdline`, which holds no secret. It cannot read its `environ`, `mem` or file descriptors, `ptrace` it or signal it (different uid). |
| Does the verifier read user-writable scripts, libraries or configuration? | No, by design: its code, runtime closure, oracle and configuration are root-owned; its home is root's; its environment comes from the unit and its manager; the candidate arrives as bytes on the socket. RESULTS.md reports the audit of the runtime closure on this host (`audit.ts`). |
| How do consumers tell service evidence from a forged copy? | By location and owner, never by content: §6. |

## 5. The request protocol and candidate transfer

### 5.1 Transport

One request per connection. The client writes one JSON document and closes its write side; the instance reads at most 8 MiB from
standard input, then writes one JSON line and exits. The instance never reads the caller's environment, arguments, file descriptors or
working directory: the manager started it, and the connection is its standard input.

### 5.2 The request

```json
{
  "schemaVersion": "endo.research.dvt002.request.v0",
  "task": "roman-numerals-cli",
  "objectFormat": "sha1",
  "commit": "<40 or 64 hex digits>",
  "objects": [{ "type": "commit" | "tree" | "blob", "data": "<base64 of the object's content>" }]
}
```

These are the only keys. Any other key, at any level, refuses the request (`request-invalid`). There is no field for an executable, a path,
an environment variable, an argument, a shell fragment, a time limit, an expected output or any verifier option. `task` selects an oracle
**by name** from the installation's registry; it is never a path.

### 5.3 Verified object transfer, chosen over a bundle and over Git reads

| Option | Why not, or why |
| :-- | :-- |
| Hardened Git reads of the operator's repository (001's C1) | The verifier would open an agent-writable repository: its configuration, its object store and Git's parsers become inputs to the trusted context. C1 closed two known routes; it is a deny list. |
| A Git bundle | The verifier would run `git` (`index-pack`, `fetch`) on attacker bytes in a repository of its own. Pack parsing, deltas and thin packs are a large surface, and a bundle of one commit has to carry its parents' objects or prerequisites. |
| **Verified object transfer** | The verifier runs no Git at all. It computes each object's id itself (`<type> <size>\0<content>`, SHA-1 or SHA-256), parses commit and tree objects with a strict parser of its own, walks the tree from the requested commit and refuses anything not reachable, missing, duplicated, of the wrong type, a symbolic link, a submodule, a non-plain name or over bounds. **R1 and R2 cannot occur by construction**: no replace refs, no promisor, no configuration, because no repository. |

The client builds the object list with `git cat-file` under C1's environment, but the client is the agent's and is not trusted: a lying
client can only send bytes whose ids do not match, which leaves the requested commit unresolved (`object-missing`).

**Object identity versus byte identity.**
- *Object identity* is the Git id the request names. The verifier recomputes it, so the staged files are exactly the commit's.
- *Byte identity* is the export digest (001's `endoSubmissionDigestV0` over each file's path, mode, size and SHA-256), which the record also
  carries.
- **SHA-1 caveat.** Git's own SHA-1 detects known collision attacks; Node's does not. A chosen-prefix collision would give two commits the
  same id. A consumer that recomputes the export digest of the commit it is about to use, and compares it with the record's, closes that
  gap. The consumer reader does this (§6).

### 5.4 Bindings

Every record states, and the reader checks, its binding to:
1. the exact commit (object id and object format);
2. the export digest (SHA-256 bytes);
3. the installation identity (the digest of `installation.json`, which lists every installed file's digest);
4. the oracle (manifest, reference and negative digests, all pinned by the installation);
5. the invocation (a 128-bit random id chosen by the instance, the request's SHA-256, the requester's uid and pid, the start time).

### 5.5 Requester identity

systemd names an `Accept=yes` instance after the connection, including the peer's pid and uid from `SO_PEERCRED`. The instance refuses
any uid other than the installed operator uid (`requester-not-permitted`) and records the pid and uid. It proves that the verifier
produced the result, and which **uid** connected. It does not prove which human or which program; the agent has the operator's uid. No
record says "approved".

### 5.6 Retries, replay, interruption, concurrency, partial writes

| Situation | Behaviour |
| :-- | :-- |
| Retry | A new invocation with a new id. Nothing is overwritten. |
| Interruption (client gone, instance killed, manager restarted) | A lost client does not stop the instance: its record completes and the response write fails silently. A killed instance leaves `journal/<id>.jsonl` without `records/<id>.json`: INCOMPLETE for that invocation. The next instance removes working directories whose owner process is gone. |
| Stale PASS | Impossible by layout: records are named by invocation id, written once, never replaced (001's V2 needed a reused path). |
| Replay | A record is bound to its commit and export digest; presented for another commit, it reads `candidate-mismatch`. |
| Retry until a flaky PASS | The consumer rule (§6) refuses a binding that has any complete FAIL. |
| Concurrency | Each instance has its own id, working directory, journal and record. `MaxConnections=4` bounds parallel instances; systemd refuses further connections until one ends (the client reports BLOCKED `service-unavailable`). |
| Partial writes | The record is written to `records/.<id>.tmp` (`wx`) and renamed. A reader never sees half a record, and ignores dotfiles. |

## 6. Records and their authority

A record's **content** cannot authenticate it: 001's 9d resealed a forgery that every content check accepted, and a signature with a key
the agent can read changes nothing. Authority comes from **where** a record is and **who owns it**. The consumer's reader (`records.ts`
`readAuthoritative`) accepts a record as authoritative only if all hold:

1. It is `records/<id>.json` under the configured state root, named by a well-formed id, opened with `O_NOFOLLOW`.
2. The opened file (by `fstat` of the same descriptor) and each directory from the state root down are owned by the configured verifier
   uid, and none is writable by group or others. Every ancestor of the state root is owned by root and not writable by group or others.
3. **The verifier uid is not the reader's own uid**, and not root. A record owned by the reader's own account is never authoritative,
   whatever it says: that is every record of 001, and every rehearsal record of this study.
4. Its content passes 001's consistency checks (seal, case set, recomputed matches, derived verdict), against the installed oracle's
   pins.
5. Its bindings equal what the consumer asks about: the commit, the export digest it computed itself from its own copy of the commit, the
   installation identity and the oracle.

**Consumer rule for a commit:** PASS only if at least one authoritative, complete record with that exact binding says PASS and none says
FAIL. INCOMPLETE and BLOCKED records are listed, and never count as PASS.

A copy of a genuine record anywhere else is not authoritative: it is a copy. On a host where H0 fails, rule 2 means nothing, because the
agent can become root.
