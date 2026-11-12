# DEVELOP-VERIFY-TRUST-002: answers, and the smallest next decision

## Answers

**1. Is the architecture feasible without a major Endophasia redesign?** Yes.
- **What it reuses.** The verifier reuses 001's isolation unchanged: `bubblewrap.ts`, `containment.ts` and `preflight.ts`. It adds about
  600 lines of research code (request parser, object verifier, instance, reader) and two unit files.
- **What it leaves alone.** Ordinary DEVELOP verification, its receipts and its ledger are untouched.
- **What integration would add later.** A client in DEVELOP and a way for a receipt to *refer* to an authoritative record. That is a
  narrow change, but it is a production design question and was not done here.

**2. Is a separate verifier principal necessary, or would isolating the agent be preferable?** Both, for different agents.
- **Agents started outside Endophasia** (Codex, Claude Code or a shell, run directly by the operator): a separate principal is the only
  arrangement studied that can protect the verifier, and only with H0.
- **Agents Endophasia launches:** isolating the agent (arrangement C) works **today, on this host, without H0**, because the sandbox
  hides the docker and libvirt sockets. But it holds only until agent-written workspace content (Git hooks and configuration, package
  scripts, editor tasks) runs unsandboxed as the operator.

On this host, as configured, isolation is the only one that can work. It covers only the agents Endophasia starts.

**3. What has been demonstrated without privileges?** RESULTS.md §5:
- the request cannot choose code, environment or configuration;
- caller contamination (`NODE_OPTIONS`, `PATH`, `LD_PRELOAD`) does not reach a manager-started instance;
- Git metadata cannot substitute the candidate or run code in the verifier;
- invocations are self-contained under retry, interruption, restart and concurrency;
- the reader never grants authority to same-uid files;
- every remaining attack goes through ownership, and works where ownership is absent.

**4. Which claims require the installed-service experiment?**
- That a separate uid stops the T6, T7, T8 and E6 attacks.
- That a lingering system user's manager starts and contains the verifier as designed, with bubblewrap and scopes working under it.
- That an authoritative PASS appears for A (IA1) and never for an incorrect candidate (IA3).
- That `install.sh` and `uninstall.sh` add and remove exactly what INSTALL-PLAN §2 lists.

**5. What risks would remain after successful isolation?**
- **H0 drift:** a group, sudo rule or polkit rule added later voids the boundary silently.
- **Code execution in the verifier through a request:** the parser, the object verifier, or Node itself. It compromises the verifier
  principal **persistently**, not for one request. It could write authoritative records directly, or add a runtime drop-in to its own
  user manager for every later instance. (Review V4. Closing this would need an instance that cannot reach its manager: a system
  service with a delegated cgroup, or the request parser in a sandbox of its own. Neither is designed here.)
- **Consumers running as the operator's uid can be subverted:** authentic evidence, untrustworthy view.
- **The install moment** trusts the operator's view of the source.
- **The verifier certifies a uid, not a person:** no human attribution.
- **Oracle exposure:** records reveal which cases failed, and repeated requests leak information.
- **SHA-1 collisions:** closed only by consumers who compare export digests.
- **The trusted base:** kernel, bubblewrap and systemd.

**6. Is the installation cost proportional to the value of the assurance?**
- **The installation itself is small.** One locked system user, two units, a dozen root-owned files, about 15 MB of idle memory, no new
  packages, and a complete removal script.
- **The real cost is H0.** The account the agents use must stop being root-equivalent: no `docker` group (rootless Docker or `sudo
  docker` instead) and no `libvirt` group.
- **What it buys.** It closes 001's R3, R4b and 9d for the agents the operator actually runs.
- **The author's view.**
  - *If the operator will give up passwordless `docker` and `libvirt` for that account,* the assurance is worth the install, and the
    experiment should run.
  - *If not,* the separate principal is **NOT WORTH INTEGRATING on this host.* The practical next step is then arrangement C: run DEVELOP
    agents through Endophasia's protected sandbox, with the workspace's `.git` metadata read-only to the agent.

**7. What exact approval is required to continue?** The request below.

## The smallest next decision

The operator decides between:
- **(a) the installed experiment with H0:** the request below; or
- **(b) no installed experiment:** this study ends at READY FOR APPROVED HOST EXPERIMENT, unexercised, and the next study is arrangement
  C (isolate Endophasia-launched agents), which needs no privilege.

Nothing proceeds without that decision.

## Operator authorization request (for (a))

> I approve the installed phase of DEVELOP-VERIFY-TRUST-002 on this workstation, as described in
> `research/develop-verify-trust-002/INSTALL-PLAN.md` at commit `e1c52e02e879732f5c9a90e07570375b2da3bee8` (the reviewed corrections):
> 1. Remove `noctem` from the `docker` and `libvirt` groups for the experiment, and log in again (INSTALL-PLAN §1).
> 2. As root, run `install/install.sh` (SHA-256 `63f30eb0177e7f257d123dac0760d54fbe5cf33ae2f421e60d2d179e0c4fa561`) on the package built
>    from that commit for uid 1000 (SHA-256 `aa06885af5e30aa7434148b09df8b7172874f2d3c6f94f2947d8d4d5409ed55b`). It creates:
>    - the locked system user `endo-verify-002`;
>    - `/usr/local/lib/endo-verify-002`, `/var/lib/endo-verify-002`, `/var/lib/endo-verify-002-home` and `/run/endo-verify-002`;
>    - two units in `/etc/systemd/user`;
>    - one `sysusers.d` and one `tmpfiles.d` entry;
>    - linger for that user.
> 3. Run the installed matrix twice from a fresh session. When prompted, perform the two root interruptions in INSTALL-PLAN §6.
> 4. Afterwards, remove everything with `install/uninstall.sh` (SHA-256
>    `b58320b5a2824f5841c83c55464f1555fef044666fbe2e2c4da0d887eecc4727`), keeping an archive of the records.
>    Restoring my groups is my own choice.

The three digests are for `e1c52e02e`, which carries the review corrections (RESULTS §9). They supersede the frozen commit's digests. Any later change to the prototype means recomputing them and reissuing this request.
