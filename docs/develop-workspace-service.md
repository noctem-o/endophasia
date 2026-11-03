# DEVELOP: the workspace service (decision record)

Status: implemented (DEVELOP Slice B). Module: [`runtime/contracts/develop-workspace.ts`](../runtime/contracts/develop-workspace.ts). It builds on
[develop-tasks.md](develop-tasks.md) (the projects, tasks and file) and [develop-workbench.md](develop-workbench.md) (the live Pi workbench).

## The goal

There should be one implementation of the operator's project and task operations, with more than one way in: the `endo` CLI, the Pi
workbench's routes, and later a local supervisor or a native desktop host. This is a library boundary. It is not a new server or a
universal transport, and it is not a second store.

## The audit before this change (main at `b940fd161`, PR #115)

| Concern | Where it was | Shared? |
| :-- | :-- | :-- |
| The file format, bounds, text rules and status transitions | `protocol/develop-tasks.ts` | Yes: one implementation |
| The lock, atomic rewrite, re-read and validate, revisions, refusals | `storage/develop-tasks.ts` (`DevelopTasksStoreV0`) | Yes: one implementation |
| Registration (realpath, directory check, read-only Git root observation) | `cli/develop-tasks.ts` | No: CLI only |
| Reading a project's tasks and the current revision for a status change | `cli/develop-tasks.ts` | No: CLI only |
| The launch relation (realpath equality), the writable gate, the read model (`endo.develop-workspace.v0`), when a reference is `current`, building a session reference | `adapters/pi/workbench-tasks.ts` | No: inside the Pi adapter |
| Request shape checks, mapping to HTTP status codes | `adapters/pi/workbench-tasks.ts` | HTTP-specific, correctly placed |

The domain rules that matter most were already shared, so this change does not add a layer. It moves out the two misplaced parts:

- the project and launch semantics, which were inside the Pi adapter;
- registration, which was inside the CLI.

It leaves the store, the file format and the HTTP checks where they were.

### What was compared: DeepSeek's `dsh-superagent` prototype

That prototype's `Engine` is the only writer of its domain records. Each command changes them in one synchronous transaction, behind small
ports. Its "glue" turns HTTP requests, tool arguments and source payloads into Engine calls, and then turns the results back into views.
Side effects are queued durably and run after commit. An immutable mandate fixes a worker's authority when the work starts.

What is taken here:

- **One writer.** Every task change goes through `DevelopTasksStoreV0`. The CLI and the workbench reach it only through the service, and a launch scope can be opened only by `forLaunch`.
- **Synchronous single-transaction commands.** Each change is one locked re-read, validate and rewrite.
- **Thin glue.** The CLI and the HTTP routes translate input and refusals and own no rules.
- **Authority fixed at construction.** A launch scope's project and directory are frozen when it is opened, and its session facts come
  from its host.

What is not taken:

- **No effects queue.** No task operation has an external effect to queue.
- **No sources, triggers, evaluator or assignments.** Nothing here schedules, accepts or executes work.
- **No orchestrator runtime.** Nothing autonomous was added.

## Implemented in this PR

### The API

```text
DevelopWorkspaceServiceV0(store, { observeGitRoot? })        operator scope: the operator's own process (the CLI, which supplies the
                                                             existing Git inspector as observeGitRoot)
  read()                                       the whole file, or `unreadable` with its closed reason
  tasks(projectId) · task(projectId, taskId)   one project's tasks; `not-found` for an unregistered project
  registerProject({ name, path })              realpath, must be a directory, the caller's read-only Git observation, then the store
  createTask(projectId, input)                 the store's rules
  setStatus(projectId, taskId, rev, to, note?) the file's transitions; a stale revision is refused
  forLaunch(config, host) → DevelopLaunchWorkspaceV0

DevelopLaunchWorkspaceV0                       launch scope: one project, as one launch sees it (the workbench)
  view()                                       endo.develop-workspace.v1 (v0 before Slice D)
  writeRefusal()                               null, or the `read-only` refusal every change would get now
  createTask · updateTask · setStatus · selectTask · unlinkSession
  linkCurrentSession(taskId, rev)              the reference is built from the HOST's facts; the caller names a task and a revision
```

Every operation returns `{ ok: true, value }`, or `{ ok: false, code, reason? }` with a closed code. The codes are:

- the store's own refusals: `not-found`, `stale-revision`, `invalid-transition`, `bad-request`, `limit`, `duplicate`, `unreadable`, `busy`
  and `storage-failed`;
- `read-only`, whose reason is `unreadable`, `project-mismatch`, `project-missing` or `unknown-project`;
- `no-session`, `unsupported-source`, `unavailable` and `not-a-directory`.

Nothing is written for any refusal. The version is in the names (`V0`) and in the two record schemas, which this slice left unchanged:
`endo.develop-tasks.v0` (the file) and `endo.develop-workspace.v0` (the read model). Slice D (below) added `endo.develop-tasks.v1` and
`endo.develop-workspace.v1`.

### The trusted caller boundary

The facts are split by who knows them, and no operation takes any of them from a request:

- **Operator configuration** (`DevelopLaunchConfigV0`): the project the operator named (`--project`) and the launch directory. These
  come from the operator's own command line.
- **Host facts** (`DevelopLaunchHostV0`):
  - the host's own random launch id;
  - the attachment name;
  - the session source the host speaks for, and the session connected now, read at each call from the host's own state (the Pi
    workbench gives `pi-live` and `piEndoSessionIdV0(…)`, the canonical mapper from PR #115);
  - `session: null` from a host that can vouch for no session.
- **The request:** a task id, a revision and the operator's words. That is all.

Who authorises and who validates each operation:

| Operation | Authorised by | Validated by |
| :-- | :-- | :-- |
| Register a project | The operator running `endo project add` (their own process) | Service: path is an existing directory. Store: name, bounds, duplicate path |
| Read or change tasks from the CLI | The operator's own process | Store: text, ids, transitions, revisions, bounds |
| Read the workspace in the workbench | The broker's pairing grant (`adapters/pi/workbench.ts`, before the route is reached) | Broker: Host, Origin, Fetch-Metadata, content type, body size |
| Change a task in the workbench | The broker's pairing grant | Route: exact keys and types. Service: writable now (file, project, directory). Store: the rest |
| Link the current session | The broker's pairing grant | Service: the host's source is one the file knows, a session is connected, the launch id and session id are well formed. Store: idempotence, bounds |

**A TypeScript interface is not an authentication boundary.** Any code that holds a service object can use it. The protection is in who
is given one:

- The CLI constructs one in the operator's own process.
- `cli/workbench.ts` gives the broker only an *opener* for one launch scope. The broker never holds the operator scope or the store, so a
  workbench request cannot register a project or reach another project's tasks.
- The source and session-id checks in `linkCurrentSession` keep trusted in-process callers consistent with each other. They do not
  authenticate a host. A host that lies about its source is a bug in that host, and nothing in this module can detect it.

The session contract `endo.develop-session-surface.v0` is untouched and has no task or project field.

### Session references

- A reference is current only when it was made in **this** launch, by a host of the **same source**, to the session connected **now**.
  The source check is new and is stricter than before.
- A reference from another launch is historical, even if the same upstream id is served again.
- A session ending changes no task: no status, no revision.
- A host of a source the file does not know (`ENDO_DEVELOP_SESSION_SOURCES_V0` is `["pi-live"]`) gets `unsupported-source`. It writes
  nothing, and none of its sessions makes a recorded reference current. That holds even when it reports the same canonical id as a Pi
  session.
- A reference is not a handle. Nothing reads one to send, steer, stop, resume or select a session.

### Persistence ownership

`DevelopTasksStoreV0` remains the only code that reads or writes `<root>/develop/tasks.json`. It keeps its numbered writer lock, re-read
and validation, atomic rewrite and per-task and per-file revisions, and nothing about them changed. The service holds no cache: every
view and every change reads the file at that moment.

### The two integrations

- **CLI** (`cli/develop-tasks.ts`): translates flags into service calls and refusals into the same sentences as before. Its output is
  byte-identical, and the existing CLI tests pass unchanged. It needs no workbench, pairing code, browser or agent process.
- **Workbench** (`adapters/pi/workbench-tasks.ts`): a translation layer. It checks a request's shape and maps refusals to status codes.
  It asks `writeRefusal()` before reading the body, so a read-only workspace answers every change with the same 409, exactly as before.
  The grant, the request guards, the terminal-approved Prompt, STEER, QUEUE and STOP, and the read-only `endo studio` are unchanged.

### Failure and recovery

| Situation | Behaviour |
| :-- | :-- |
| Damaged, unknown-version, oversize or linked file | `unreadable` with its reason; the file is left byte for byte |
| Unregistered project | `not-found` (operator scope) or `read-only`/`unknown-project` (launch scope) |
| Launch directory not the registered one, or the registered one gone | `read-only` with `project-mismatch` or `project-missing`; the tasks are still shown |
| Stale revision | `stale-revision`; read again and retry. Nothing is merged |
| Lock held | `busy` after the store's wait. A lock of a dead process is superseded (see [develop-tasks.md](develop-tasks.md#persistence-rules)) |
| Crash mid-write | The old file or the new one; leftover temporary files are swept by the next writer |

### Evidence (`tests/develop-workspace-service.test.ts`)

- In-process tests of both scopes: read-only cases, damaged files, references, malformed host facts.
- A real broker and real `endo task` processes writing one file.
- Six concurrent processes (three operator scopes, three launch scopes), each creating and moving six tasks, with no write lost.
- `tests/fixtures/develop-workspace-consumer.ts`, a **non-Pi consumer run as its own `node` process**. It opens a project, creates a task,
  moves it, has bad moves and stale revisions refused, reads the task back through another instance, and is refused when it tries to link
  or borrow a session. A Pi reference recorded earlier stays historical.
- An import walk proving that neither the service nor that consumer reaches any adapter, a
  server, the CLI or the page, and that nothing it reaches opens a socket, spawns a process or fetches.

The consumer is **not** a Codex, DSH, ACP or meta-harness integration. It shows only that the service is usable without Pi.

## Explicitly deferred

- A persistent supervisor or daemon.
- A new independent HTTP or Unix-socket control service.
- A native Tauri or Electron application.
- Autonomous acceptance of work: a task is never completed by a harness's report.
- GitHub event subscriptions and polling.
- Assignment scheduling, retries and queues.
- Multi-agent execution.
- A separate SQLite coordination database.
- Cross-machine synchronisation.
- Session sources other than `pi-live` and (since Slice D, below) `omp-saved`. Each new source needs a new version of the file format with
  its own validator in the version table; no file version silently accepts another source.

## Source-aware references (Slice D)

Status: implemented. The file is `endo.develop-tasks.v1`; the compatibility policy and the operator's view are in
[develop-tasks.md](develop-tasks.md#versions-and-the-upgrade). What changed in this module:

| | Before | Now |
| :-- | :-- | :-- |
| Sources | `pi-live` | `pi-live` (LIVE) and `omp-saved` (OBSERVED), two disjoint closed lists |
| Who makes a live reference | `linkCurrentSession`, from the launch host's facts | Unchanged. A host of any non-live source (including `omp-saved`) is `unsupported-source` |
| Who makes an observed reference | Nobody | `linkObservedSession` on the **operator scope** only, given an observation its caller established |
| `current` | Same launch, same source, same session | Unchanged for Pi; an OMP reference is `saved`, decided by its source before anything is compared |
| Idempotence | session + launch | `endoDevelopSessionKeyV1`: source + session + launch (Pi), source + scope + session (OMP) |
| New operations | | `inspect()`, `upgrade(rev?)`, `linkObservedSession(...)`, operator-scope `unlinkSession(...)` |
| New refusal | | `upgrade-required` |

**Where the authority to create an OMP link lives.** In the operator's own process, the `endo` CLI. It names the OMP directory, builds the
read-only observer (`adapters/omp/observer.ts`), asks it to `resolve` the id (one readable carrier, every file read), and passes the
resulting observation (source, id, scope digest, format) to `linkObservedSession`. The service checks the observation's shape and imports no
adapter; its truth is the CLI's duty, exactly as a live reference's truth is the launch host's. The workbench broker holds only a launch scope,
which has no observed-link operation, and its HTTP routes accept no field that describes a session, so no page request can create one.
Studio holds neither scope.

**Rejected alternatives.**
- *Loosening v0* to accept `omp-saved`: an older build would then misread a file it believes it understands. Refused by the brief and here.
- *A uniform reference shape* with a synthetic `launchId`/`attachment` for OMP: it would manufacture a live connection that does not exist.
- *A browser link action*: Studio (where OMP is browsed) is unpaired and must not gain a task route; the paired workbench has no OMP observer.
  Either would be a new control channel. Deferred.
- *Upgrading on first write, or on read*: silent; and it would break older builds without the operator deciding. The upgrade is explicit.
- *Requiring the upgrade before any write*: it would break every existing workbench and CLI workflow on the day of the update. A v0 file keeps
  being written as v0 while it says only what v0 can.
- *A v0 backup at upgrade*: a second copy of private text with no owner and no retention. The atomic rename already guarantees old-or-new; the
  dry run tells the operator to keep a copy if they may go back.
- *Storing the OMP directory path* as the scope: a path in a reference is private and machine-specific; a digest separates stores without it.
- *Matching by id prefix, alias, title, time or directory*: never. A Studio selector is refused by name.

**Evidence** (`tests/develop-tasks-v1.test.ts`, plus extensions of the workbench, Studio-privacy, observer-layering and browser suites):
format and migration (determinism, exact reversibility for Pi-only files, v0 kept by reads and v0-expressible writes, upgrade-required,
stale and competing upgrades, a crash at replacement, unknown versions and forged references), source-aware idempotence across sources and
scopes, authority (a host claiming `omp-saved`, an operator-scope live claim, forged HTTP bodies, the page given no id, scope or path, the
page's gate refusing a `current` OMP reference), resolution (duplicates, malformed and unsupported files, unreadable files, a replaced file,
two scopes), and the CLI end to end (a fake `omp` on `PATH` never runs, OMP's directory manifest unchanged, a vanished file keeps its
reference, overlapping directories refused). Mutation checks on the live-source gate, the observed-source gate, the scope in the key, the
uncertainty rule, v0 preservation, the page gate and the selector rule each make a test fail. (Dropping the source tag from the key does not:
a Pi launch id and an OMP scope can never be equal, so the two sources' keys cannot collide by construction, which the key test asserts.)

**Independent review (Opus, read-only) and dispositions.** No issue on the seven questions asked (Pi meaning preserved; no unpaired access;
no forgeable source, scope or identity over HTTP or a launch host; the observer never treated as a host; no migration loss under concurrency;
no path from a link to control). Minor findings:

| Finding | Disposition |
| :-- | :-- |
| A store root that does not exist yet, under a link into OMP's directory, passed the overlap check, and the refused link left a lock file there | **Fixed**: a link needs an existing task file (refused first, nothing created); the overlap check resolves the nearest existing ancestor; tested with a manifest |
| `resolve` did not count links, special files or directories below the depth bound, so a copy there could leave a single carrier `established` | **Fixed**: all count as unread, so the answer is `uncertain`; tested |
| Two linked OMP ids ending alike got the same page label | **Fixed**: neither is labelled; tested |
| `--apply` is parsed outside the shared flag reader | **Kept**: every misuse found ends in a usage error, never a write |
| v0 read-model constants and an unreachable `upgrade-required` HTTP mapping remain | **Kept**: stable exports for older readers; the mapping keeps the refusal table total |
| The workbench can remove an OMP reference | **Intended**: it is the operator's record; documented |
| Keeping v0 files as v0 is the most expensive part | **Kept**: the brief forbids surprising failures in existing workflows and a silent rewrite |

**Real-source evidence** (2 November 2026). The real `endo` CLI against the local OMP directory (`~/.omp/agent/sessions`: 41 files, all
readable and keyed, nothing skipped), read in place, with a disposable task store in a scratch directory. A fresh store was rewritten as v0;
`endo task upgrade` reported it and wrote nothing; `task link` answered `upgrade-required`; `--apply` upgraded it (revision 2 → 3); `task link`
of one session that ends with OMP's own exit record linked it (`new`), a second time answered `already`, `task show --omp-sessions` reported
it `established`, and a Studio selector was refused. A manifest of the whole OMP directory (size, modification and change times, inode, mode,
SHA-256) was identical before and after, while an unrelated OMP process the operator had running stayed untouched; no OMP process was started,
no model was called, and the task file held no path under the home directory. Not exercised against a real process: the workbench rendering
of an OMP reference (synthetic browser tests only), and other OMP versions or profiles.

## Work attempts (Slice E)

Design, review record and rejected alternatives: [designs/develop-work-attempts.md](designs/develop-work-attempts.md). In short, an attempt
is one request the operator prepared on one task, with a brief to copy into any coding agent. It is kept beside the task file and
never inside it.

- **Its own service, not a second workspace.** `runtime/contracts/develop-attempts.ts` (`DevelopAttemptsServiceV0`) holds the task store
  and calls only its `read()`, so nothing in it can write the task file. It also holds the write-once attempt store
  (`storage/develop-attempts.ts`). The `endo attempt` CLI is its operator caller.
- **The launch scope reads, and only reads.** `DevelopWorkspaceServiceV0` takes `{ attempts }`. A launch scope opened from it offers
  `attemptsView()`, the attempts of the task the launch project has selected in the file. No request names the project, task or attempt.
  `cli/workbench.ts` passes the store, and `GET workspace/attempts` (`adapters/pi/workbench-tasks.ts`) serves the view behind the broker's
  grant check. A service built without the option has no such route: it answers 404. The workspace view (`endo.develop-workspace.v1`)
  is unchanged.
- **No lock, no rewrite.** Each record is a file written once: a temporary file, `fsync`, then a hard link to its final name. `link`
  refuses an existing name, so concurrent writers of the same record get exactly one winner. The task store's lock and its code are
  untouched.
- **Nothing reaches an agent.** Preparing or reading a brief starts no process and sends nothing. Handoffs and outcomes are the
  operator's statements (`recordedBy: "operator"`, `via: "cli"`). An outcome is never verification and never moves the task's status.
- **Evidence:** `tests/develop-attempts.test.ts` covers records, crash, race, symlinks, limits, the task file's bytes, staleness, the
  golden brief and its round trip, the route and the page's gate, and the CLI with fake agents on `PATH`.
  `tests/endo-develop-tasks-workbench.test.ts` covers the grant and the Studio canary, and `tests/endo-studio-tasks-browser.test.ts`
  covers the section at 1440 px (Instrument and Field) and 390 px.

## How a later host consumes this

A future local supervisor or native desktop host would be one more caller:

- It constructs `DevelopWorkspaceServiceV0` over the same store root, with the operator's own authority as the CLI does, or opens a launch
  scope for one project with its own host facts as the workbench does.
- It translates its transport (IPC, a native view) the way `workbench-tasks.ts` translates HTTP.
- It decides who may hold the object. Its own authorisation (an OS user, a pairing) is its responsibility and must be designed with it.
  Nothing here pretends to provide it.
- It copies no domain rule, and it does not need a second store, a second approval path or a universal protocol.

## Next slice

The next slice makes a second, real harness host. That means a launch scope opened by a non-Pi attachment that records its own sessions.
It needs three things:

1. An `endo.develop-tasks.v1` that admits a second, closed session source, with an explicit read path for v0 files. They are read as v0
   and written as v1 only by an operator-visible upgrade, never silently.
2. That harness's canonical session-id mapper, owned by its adapter.
3. Tests that a reference from either source is never current under the other.

A supervisor process comes after that, once there are two hosts for it to supervise.
