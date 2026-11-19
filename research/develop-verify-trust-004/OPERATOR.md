# TRUST-004 operator handoff: gates, evidence and shutdown

**Do not start the frozen runner for a split operator/reader session.** Its
main function goes from the idle census straight into both installed runs,
then from quiescence to pre-read capture and the trusted reader. It has no
handoff at either point. T10 (instance interruption) and E3 (manager restart)
are automated operator actions, not interactive confirmation prompts. An
unmodified run cannot promise to wait for a second operator. This checklist
covers inspection and evidence custody; it is not a matrix launcher.

### Before a guest session

On the host, from the repository root, check the input files without running
them:

```sh
git rev-parse --verify HEAD
sha256sum -c research/develop-verify-trust-004/FROZEN.sha256
```

Record the full checkout ID separately from the authorised experiment SHA.
A manifest match is necessary but does not identify the staged commit.
Use [the protocol, §3 and amendments](PROTOCOL.md) for the frozen image,
signature fingerprints, runtime and code pins. Do not substitute the latest
image or infer signature verification from a matching filename.

For an already booted guest, with ENDO13_WORK set to that session's dedicated
directory, inspect it from the host:

```sh
bash research/develop-verify-trust-004/qemu/host.sh audit
```

Check the actual argv for the no-network configuration and expected disks,
the open descriptors for unexpected host access, and the socket listing for
listeners. From the guest console, confirm `ip -br link` shows only loopback.
If the host audit cannot identify this guest, stop; do not signal the PID.

### What counts as a passed preflight

Require the untraced agent login's measured uid/gid 1500, only its own group,
zero effective capabilities, and installed audit results with both `h0` and
`closure` true. Require the strict sudo policy refusal, not merely exit 1.
Check the distinct non-root verifier identity against the process credentials.
Require a separate attributable availability record and journal. None of these
can stand in for the writable-path and idle censuses.

If a gate or census fails, preserve its raw output, exit status, identities
and timestamps. Do not modify permissions, broaden the two reviewed exceptions,
attach a tracer early, or resume at the next row. A failed prerequisite is
BLOCKED; missing later observations are not passes.

### Evidence handoff

Before any reader, require both run units and tracers inactive, no agent
process and no live verifier instance. If quiescence fails, stop: no capture
and no trusted read. If capture fails, keep the partial acquisition and do not
run the reader. A capture taken after a read cannot be renamed as the baseline.

Retain the root-acquired pre-read directory and its separate manifest outside
agent control: state (records and journals), install (including oracle),
system files, repository archives with Git objects, refs and configuration,
harness output, acquisition log, ownership, ACLs and runtime digests. Preserve
the reader outputs, per-process traces, post-read capture and comparison as
separate evidence. Never replace object databases with an exported worktree.
Keep all failed runs. A harness summary or a zero exit is not an independent
verdict.

### Closing a session

Do not uninstall or shut down a guest that still holds the only evidence a
live reader needs. When live work has finished or been explicitly abandoned,
retain the guest cleanup census and export size, digest and device-prefix
digest. The two guest digests must agree. On the host, use a **new, private
destination outside ENDO13_WORK**; SIZE and DIGEST below are the recorded guest
values, not estimates:

```sh
bash research/develop-verify-trust-004/qemu/host.sh collect "${DEST:?}" "${SIZE:?}" "${DIGEST:?}"
```

Verify the retained export and manifests before disposing of any disk. Keep
the host audit, console measurements and failed-attempt logs outside the
scratch directory. For an incomplete run, inventory missing evidence explicitly.
Confirm guest services, experiment processes and grading children are gone;
then power off at the guest console. Only after confirming QEMU has exited,
no listener survives, and the scratch path contains **only** this disposable
session, remove it:

```sh
: "${ENDO13_WORK:?set to the verified disposable session directory}"
bash research/develop-verify-trust-004/qemu/host.sh teardown && test ! -e "$ENDO13_WORK"
```

Record what was removed, including the overlay and disposable credentials,
and verify the external evidence still exists. If identity, export integrity
or teardown is uncertain, stop and report that uncertainty rather than
claiming a clean run. Workstation H0 remains BLOCKED.
