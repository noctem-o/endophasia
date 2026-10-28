# Task-owned server provenance v0: plumbing complete, interactive live execution gated

Status: **TASK-OWNED PROVENANCE PLUMBING COMPLETE / INTERACTIVE LIVE EXECUTION GATED**. No real model request, llama.cpp server or Pi session was made by this work. Everything below was exercised only with task-owned fake executables (a C relay that maps a stand-in model file and listens on loopback), a fake Pi and the in-process fake OpenAI endpoint. The terminal-governed command that now calls it is described in [OPERATOR.md](OPERATOR.md); no unattended path starts a server.

## Trust contract

The mechanism assumes a **trusted local host**. It relies on:

- a separately authorised Endophasia-owned server lifecycle: this code spawns the server itself, from a pinned executable and model, with arguments built from one definition shared with the Linux inspector;
- a recorded launch configuration (profile, keyed digests of the exact argv and environment-name list);
- bounded identity rechecks of that one process before every dispatch.

It does **not** protect against a compromised kernel or procfs, a privileged or same-user attacker who swaps the process, files or listener between samples, a process in a hidden PID or network namespace that shares the listener, or unobserved GPU, RNG and KV-cache state. The eight declared assumptions are recorded verbatim in every provenance record (`TASK_OWNED_TRUST_ASSUMPTIONS_V0`). A reader rejects a record that omits or edits any of them, and reports them as declared, not verified.

**Ownership is never upgraded.** Linux does not let an unprivileged observer prove that a process is the only holder of a socket. The launcher *declares* lifecycle ownership (`declared-task-spawned`) and records that the port was free immediately before and after approval. The host fact `checks.ownership` stays `UNAVAILABLE`, `OWNERSHIP_UNVERIFIED` stays in the blocking reasons, and any record that claims `MATCH`, drops those facts or upgrades `effectiveRuntimeConfiguration` is refused. PR #94's inspection and its honest outcomes are reused unchanged. On a shared host the visible-owner scan and the reuse-port helper commonly report `UNAVAILABLE` (unreadable processes, ptrace policy); that is recorded and reported as a missing fact, while an observed second owner or an enabled reuse-port option is a refusal. A server whose digest is not the historically pinned llama.cpp build is recorded as `supportedBinary: UNSUPPORTED`; "pinned" here means pinned by the provenance record, not by build attestation.

## Record and lifecycle

`aa/task-owned-provenance.ts` defines `endo.research.aa.task-owned-provenance.0`, a keyed-sealed record committing to: the profile and declared parameters; executable and model paths, SHA-256 digests and file identities (device, inode, size, mtime, ctime); pid, start ticks, boot id and network namespace; the listener endpoint, socket inode and descriptor; keyed digests of the exact argv and environment names (raw argv and environment values are not stored; a reader recomputes the expected argv digest from the declared profile); lifecycle facts (launcher pid, process group, spawn time, the launch-plan commitment and a digest of the operator's approval phrase); the inspection's check states, blocking reasons and unavailable facts; and the trust assumptions. A second sealed record (`...-end.0`) written at shutdown records exit status and whether the process and listener were confirmed gone.

`aa/task-owned-server.ts` exports `launchTaskOwnedServerV0`, a function, not a command. It hashes the pinned executable and model, requires the port to be free, and needs the exact approval phrase (bound to the launch-plan commitment) from a caller-supplied callback inside a five-minute window. Only then does it start the server under the runtime's existing keeper (`ProcessGroupV0`) with a minimal environment, wait for the listener, run the existing bounded host inspection, confirm from `/proc` that the server is a member of the keeper-led group, and require the kernel-reported argv to equal the approved launch. Any failure, timeout or cancellation after the start ends the owned group before the error is raised. `stop()` sends SIGTERM to that group, then SIGKILLs whatever is left and waits, signalling a group id only while the keeper that holds it is alive, and records what was confirmed gone. If the launching process itself dies (including by SIGKILL, SIGTERM or a crash), the keeper sees its control socket close and ends the group; tests kill a launcher by SIGKILL and SIGTERM and check that the server and listener disappear. The group is the boundary: a descendant that deliberately leaves it is not contained, as for the other runtime processes. The library installs no process-wide signal handlers; the operator command installs its own SIGINT/SIGTERM/SIGHUP handlers that only abort, and calls `stop()` once in a `finally` so that the end record is written. The only caller of the launcher is the operator in `aa/operator.ts`, reachable only through `operate.ts --run` after a controlling-terminal check, and a test asserts that chain. The module itself sends no HTTP request.

## Per-turn admission

`aa/task-owned-admission.ts` implements the existing `ContinuationAdmissionHookV0`, separate from the synthetic fixture. Before dispatch an asynchronous observer re-reads the process from procfs (boot id, start ticks, network namespace, executable link and file identity, model file identity, argv and environment digests, listener descriptor and tables, visible socket owners). At the one-shot admission boundary, after the complete request body is buffered and before the upstream hop opens, a synchronous recheck repeats everything cheap, **without** re-hashing files, and an observation older than 10 seconds is refused. The hook then exclusively publishes `task-owned-admission-{turn}.json`, binding the provenance, study, slot, position, attempt, turn, upstream, the digest of the actual request body, the dispatch marker and approval commitments, and the observed process facts. Any refusal sends no upstream request. Existing no-retry, cancellation, timeout and cleanup rules are unchanged: a refused or cancelled slot is spent.

A study plan opts in with `taskOwnedProvenance` (exclusive with the synthetic mode), and `runNextSlot` takes the observer as an additional argument; the existing positional arguments are unchanged. A mismatch between plan and mode, or a stopped server, is refused.

## Fresh-process reader

`readTaskOwnedStudyV0` (and `read-private.ts --task-owned`) re-verifies receipts and captures with the unchanged study reader and then checks the provenance, optional end record and all eight sidecars **offline**; it reads no procfs. It reports, separately:

- `records`: provenance and sidecars are well formed, keyed, bound to the plan, slot, request and dispatch, unique, and ordered (otherwise it throws);
- `observedProcessIdentity`: every sidecar's pid, start ticks, socket and launch digests equal the provenance (`consistent` / `inconsistent` / `unavailable`, with the differing fields);
- `declaredTrustAssumptions`, `hostFacts` (including `ownership: OWNERSHIP_UNVERIFIED`, the check states, unavailable facts and blocking reasons) and `lifecycle` (`open`, `cleaned`, `cleanup-unconfirmed`);
- `studyAdmission`: `complete` only for four verified receipts with eight consistent sidecars, otherwise `partial`, `refused` or `unavailable`.

`complete` means the recorded observations are internally consistent under the declared assumptions. It is not server parity, not sole ownership and not proof of runtime configuration.

## Not established

Readiness: the launcher waits for the listener and a passing procfs inspection, which is not model readiness (a real server can listen before its model has loaded); the operator adds a separate bounded `GET /health` gate (see [OPERATOR.md](OPERATOR.md)), which is a server-reported observation and not proof of inference. Source-to-binary provenance, GPU-resident weights, effective runtime settings after startup, RNG or KV state, sole socket ownership, and anything about a real llama.cpp build. The interactive operator command that supplies the approval callback now exists and was exercised only against fakes; a live run is a separately authorised step.
