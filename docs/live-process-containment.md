# Live process containment (LIVE-PROCESS-CONTAINMENT-001)

**Status:** implemented for the operator's live Pi session (`endo harness attach`, with or without `--control --workbench`).
It works on Linux where a systemd user manager is reachable. Elsewhere it is explicitly reported as **unverified**.

**The rule:** a harness's exit is never reported as its cleanup. `endo` says that Pi and everything it started have ended only when the
user manager has stopped the session's scope **and** the scope's cgroup holds no process.

## 1. The problem (WORK-CYCLE-001B §5.2)

- The attachment ran Pi in a process group it owns, led by a keeper (`adapters/rpc-jsonl/process-group.ts`).
- Pi 1.5.0's `bash` tool starts its command **detached**, in a process group of its own, so the command is not a member of Pi's group.
- When Pi was killed (SIGKILL) while its tool ran `sleep 20`:
  - the attachment ended Pi's group, reaped it and exited;
  - **the `sleep 20` survived, reparented to init**, with nothing linking it back to the session.
- `tests/work-cycle-001a.test.ts` pinned this behaviour so that a fix would show.

**Reproduction without Pi** (`tests/live-process-containment.test.ts`, "the gap, reproduced without a scope"):
- A command in a `ProcessGroupV0` starts `sleep 300` with `detached: true`.
- `release()` ends the group, and the sleep is still running.
- That release now reports `{ boundary: "process-group", result: "unverified" }`. It never reports `confirmed`.

## 2. Design

A process group cannot hold a process that leaves it. Two Linux mechanisms can hold one: a cgroup, or a child subreaper. Node exposes
neither directly, so a dedicated cgroup per session is obtained from the systemd user manager, which **EVAL-ISO-001 already uses** for
every protected sandbox (`adapters/sandbox/containment.ts`; docs/protected-experiments.md §2, "Lifetime"). It reuses:

- `detectContainmentV0`. Trusted root-owned `systemd-run` and `systemctl`, a reachable user manager, and a real probe scope created with
  the required properties, read back, and stopped. Anything else is a refusal with a reason.
- `stopScopeV0`. It stops the scope through the manager, never by writing cgroup files. It returns `confirmed` only when the manager no
  longer runs the unit and the cgroup's `cgroup.events` says `populated 0` (or the cgroup is gone).
- The `KillSignal=SIGKILL` and `TimeoutStopSec=5s` properties: a scope ends with SIGKILL, with no 90-second grace.

### What is new

| Piece | Where | What it does |
| :-- | :-- | :-- |
| `ProcessScopeV0` | `adapters/rpc-jsonl/process-group.ts` | An interface: wrap a command so that it runs inside a scope, stop the scope, count what it still holds. The shared JSONL transport defines it but names no mechanism: it still imports only `node:` builtins and its own modules (`tests/prime-runtime-ingress.test.ts`). |
| `liveScopeV0(containment)` | `adapters/sandbox/containment.ts` | Implements the interface with a transient user scope `endo-live-<24 hex>`. The unit's description names its owner by pid and kernel start time. |
| `ProcessGroupV0({ scope })` | process-group.ts | The keeper is started through `systemd-run --user --scope … -- node -e KEEPER`. `systemd-run` registers the scope, with itself in it, and then **execs the keeper in place** (same pid, same descriptors, same process group). Every descendant of the keeper is in the scope's cgroup, whatever pid, process group or session it moves to. |
| `release(): Promise<ProcessCleanupV0>` | process-group.ts | Ends the group as before, then stops the scope and confirms it is empty. Idempotent. |
| `RpcConnectionV0.cleanup()` | rpc-connection.ts | The cleanup of the connection's group, once it was released. `RpcTerminationV0` is unchanged. |
| `PiAttachmentOptionsV0.processScope`, `PiSessionAttachmentV0.processCleanup()` | adapters/pi/attachment.ts | A factory for a new scope per Pi process, injected by the CLI: the Pi adapter still reaches only the shared transport, never `adapters/sandbox` (`tests/endo-pi-boundary.test.ts`). One cleanup per Pi process the session started (a reconnect starts another). |
| `liveContainmentV0`, `describeProcessCleanupV0` | cli/process-cleanup.ts | Detection and the notes before the session starts; one line per Pi process after it ends. |
| `endo harness attach` | cli/harness.ts | Detects containment, runs the session's Pi in a scope where it can, and reports the cleanup on stderr after the session closes. |

### Ownership and identification

- **Owned:** every process whose cgroup is the session's scope. The kernel assigns that membership at fork, so it does not depend on what
  a process does with its process group, session or parent.
- **Named:** each scope is named by the controller (`endo-live-` and 24 random hex digits). Only names of that shape are ever stopped or
  read (`stopScopeV0` and `scopeProcessesV0` refuse any other name).
- **Owner:** the unit's description holds `owner pid <pid> start <start time>`, read from `/proc`. A pid can be reused, but the pair of
  pid and start time cannot.
- **Never signalled by number:** no process found in a scope is signalled individually. The scope is stopped through the user manager.

### Termination, by case

| Case | What ends the processes | What is reported |
| :-- | :-- | :-- |
| Orderly end (`close`: Pi's input ends, then a bounded wait, SIGTERM and SIGKILL of the group) | `release()` stops the scope after the group | `confirmed`, or `incomplete` (below) |
| **Timeout** (a runtime that ignores the end of its input and SIGTERM) | the connection's existing escalation (closeTimeoutMs, then SIGTERM, then SIGKILL of the group), then the scope stop | `confirmed` (test: a runtime trapping SIGTERM with a detached descendant) |
| **Cancellation** (`terminate()`) | immediate SIGKILL of the group, then the scope stop | `confirmed` (test) |
| **Ctrl-C** on `endo harness attach --control` | SIGINT ends the wait; the session closes as in an orderly end | stderr: `harness: Pi and every process it started have ended (scope … stopped; its cgroup is empty).` (end-to-end test with the fake Pi; real Pi below) |
| **Pi dies on its own** (killed or crashed) | the connection terminates, and its group is reaped and released, which stops the scope at once, before the operator exits | the same line when the session closes |
| **The controller (`endo`) is SIGKILLed** | the keeper sees its control socket close, runs `systemctl --user stop --no-block <unit>.scope`, then SIGKILLs its own group. The stop also ends the keeper. | nothing can be printed, since the controller is gone. Test: the detached descendant ends and the unit is no longer active. |
| **The controller and the keeper are both SIGKILLed** | **nothing**: the scope keeps running | at the next `endo harness attach` on this host: `warning: an earlier live session left scope … running with N processes; its owner (pid …) is gone. \`systemctl --user stop ….scope\` ends them.` It is reported, **not stopped**: that session did not belong to this one. Test: the scope is found with `ownerAlive: false`, then stopped. |

### Reporting incomplete cleanup

`ProcessCleanupV0`:

- `scope` / `confirmed`: the only result worded as "every process it started has ended".
- `scope` / `incomplete`:
  - the manager gave up (`TimeoutStopSec`), or the cgroup still held processes when the 10-second bound expired, for example a process
    in uninterruptible I/O;
  - `remaining` is the count read from `cgroup.procs`, or null if unreadable;
  - stderr: `harness: CLEANUP INCOMPLETE: scope … was not confirmed empty (N processes left). systemctl --user stop ….scope ends what is left; systemd-cgls --user-unit ….scope lists it.`
- `process-group` / `incomplete`: no scope, and a group member was still running at release.
- `process-group` / `unverified`:
  - no scope; no group member is seen, but a descendant that left the group would not be seen either;
  - stderr: `harness: Pi has exited; whether every process it started has ended is UNVERIFIED (not contained): one started outside its process group may still be running.`
  - Before the session starts, the operator is told why: `note: Pi's processes are not contained here (<reason>). …`

## 3. Evidence

On this host (Arch Linux, systemd 262, cgroup v2, Node 26.12.1), 2026-11-08:

- **`tests/live-process-containment.test.ts`: 10 passed.**
  - The uncontained reproduction.
  - With a scope:
    - release ends a detached descendant and a `setsid` one, is confirmed, and the unit is gone;
    - timeout;
    - cancellation;
    - controller SIGKILL;
    - controller and keeper SIGKILL (the residual case: reported, then stopped).
  - An incomplete scope reported with its count.
  - The words.
  - The note given when there is no user manager.
  - Ctrl-C on a real `endo harness attach --control` process with the fake Pi starting a detached child.
- **With no user manager** (`env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS`, as on GitHub's runners): 5 passed, 5 skipped. The
  Ctrl-C test asserts the UNVERIFIED note and line, and that the detached child is in fact still running.
- **Real Pi 1.5.0** (`ENDO_PI_EXECUTABLE=/usr/bin/pi`, disposable fake endpoint, no model):
  - `tests/work-cycle-001a.test.ts` passed 9, skipped 1 (tier 3 needs a real model);
  - the 001B case "Pi killed while one of its tools runs" now finds **no process of the run left**, and the terminal shows the
    confirmed line;
  - without a user manager, the same test still pins the old survivor and expects UNVERIFIED.
- **The full suite** (`npx vitest --run`): see the PR for the run on the final commit.
  - The two import-boundary tests caught the first version, which imported `adapters/sandbox` from the transport and from the Pi
    adapter. Both now take an injected scope.
  - `tests/aa-operator.test.ts` "an unconfirmed process or listener…" failed once under the full parallel load, at its own launch count.
    It passed 5 times out of 5 alone on this branch, and alone on `main`. It uses no code this change touches beyond `release()`'s
    return value, which it ignores.
- **Mutations**, each restored afterwards; each made the suite fail:

  | Mutation | Tests failed |
  | :-- | :-- |
  | `release()` reports `confirmed` without stopping the scope | 5 |
  | The keeper does not stop the scope when its owner dies | 1 (controller SIGKILL) |
  | `unverified` worded as "have ended" | 1 |
  | `endo harness attach` does not pass the containment | 1 (Ctrl-C end to end) |
  | The work-cycle driver drops `XDG_RUNTIME_DIR` from the attach's environment | 1 (real Pi kill: `sleep 20` survived, outside the scope) |

## 4. Changes in behaviour, stated

- **A process Pi starts no longer outlives the session** where containment is available. That includes a deliberate background
  process, such as a dev server started with `nohup … &` from Pi's bash tool: it ends when the session ends. That is the meaning of
  owning the session's processes. If a workflow needs a process to outlive the session, it must be started outside Pi.
- **The work-cycle driver passes `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`** (when set) into the attach's environment, which is
  also Pi's. They name the user manager, not any configuration. `DRIVER_VERSION` is now `work-cycle-001b.2`, so runs made before and after
  are distinguishable.
- **`ProcessGroupV0.release()` resolves to a `ProcessCleanupV0`** instead of `void`. Callers that ignore the value are unaffected.
- **Nothing persisted changed:** no event, record or schema. The cleanup is reported on the terminal and through the API only (see §6).

## 5. Limitations

- **Linux with a systemd user manager only.** macOS, Windows, containers without a user manager, and CI runners get `unverified`, as
  before but now said.
- **Only the operator's session Pi is contained.** These are not:
  - the identification run (`pi --version`);
  - the local protocol checks (offline, with `--tools none`);
  - the live capability study;
  - ACP agents;
  - DEVELOP check commands (`adapters/develop/check-runner.ts`);
  - the cassette runner.
  Each uses `ProcessGroupV0`, which now accepts a scope, so containing any of them is a one-line change. Each is a separate decision with
  its own tests: a check command's descendants, for example, are a receipt question.
- **Both the controller and the keeper killed** leaves the scope running until someone stops it. It is found and named at the next attach
  on the host, not stopped automatically.
- **No resource limits.** A live scope sets no `TasksMax`, `MemoryMax` or `CPUQuota`: an operator's session runs real builds. Limits
  belong to protected experiments (EVAL-ISO-002), not to the operator's own session.
- **The user's own account** can stop the user manager, or move processes between its cgroups. This contains processes; it does not
  protect against the user.
- **The window before the keeper reads its configuration:** if the controller dies after `systemd-run` started but before the keeper
  read its first line, the keeper exits on the closed socket with nothing started, and the scope ends with it.

## 6. Decisions deferred to the owner

1. **Recording cleanup as evidence.** Should `harness.process-cleanup` (scope, result, remaining) be appended to the session's event log,
   so that `endo attempt evidence` can say whether a run's processes were confirmed ended? That is a persisted-schema change. It is not
   made here. Until it is, a later reader cannot know, which is "unknown", not "ended".
2. **Containing the other launchers** listed in §5, in particular DEVELOP check commands.
3. **Stopping orphaned live scopes automatically** at the next attach, instead of naming them.
4. **Requiring containment**, for example refusing a workbench session on a host without it, as protected experiments already do.

## 7. Reproduce

```sh
npx vitest --run tests/live-process-containment.test.ts
env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS npx vitest --run tests/live-process-containment.test.ts   # as CI sees it
ENDO_PI_EXECUTABLE=/usr/bin/pi npx vitest --run tests/work-cycle-001a.test.ts -t "WORK-CYCLE-001B"         # real Pi, fake endpoint
```

While a session runs, `systemctl --user list-units 'endo-live-*'` shows its scope, and `systemd-cgls --user-unit <unit>.scope` shows
everything Pi has started.
