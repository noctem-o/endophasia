# DEVELOP: projects and tasks

The live workbench ([develop-workbench.md](develop-workbench.md)) is good inside one Pi session. This adds what lasts **between** sessions: a
project you registered and the tasks you wrote under it, kept in the store root, shown beside the conversation and the Git changes. It is
operator metadata. It is not evidence, it is not a plan an agent follows, and it authorises nothing.

Four things stay apart, in the code and on the page:

| | What it is | Who owns it |
| :-- | :-- | :-- |
| **Project** | A directory you registered, with a name (`endo.project.<id>`). | You, by `endo project add`. |
| **Task** | What you intend to get done: a title, optional description and acceptance criteria, and a status (`endo.task.<id>`). | You. |
| **Worktree** | A Git working tree the broker reads, read-only ([develop-project-review.md](develop-project-review.md)). | Git. |
| **Session** | A Pi session the attached process owns (the neutral surface, [develop-session-surface.md](develop-session-surface.md)), or an Oh My Pi saved session ([develop-omp-observer.md](develop-omp-observer.md)). | The attached process; OMP. |

A project is not a session. A task is not a prompt. A worktree is not an agent. **An agent finishing is not a task done**: no run ending, final
answer, disconnect or STOP changes a task, and only your button or your `endo task status` command changes a status.

## The operator's journey

```sh
# Once per project: an explicit statement that this directory is this project. Nothing is opened or run.
endo project add --root ./recordings --name "Parser work" --path /path/to/project     # prints the project id

# Each working session: name the project. --project sets no directory; --cwd (or the process's own) does.
endo harness attach ./recordings --cwd /path/to/project --control --workbench --project endo.project.<id>
```

1. Open the workbench address (the page opens on **Develop**) and pair. The bar above the run strip names the **project** and whether its directory matches
   (`✓ matches`, or `⚠ other directory`, `⚠ path missing`, `⚠ other worktree`).
2. Press **T** or open the **Task** picker in the bar, choose **+ New task…** (or open the **Task** tab), write a title and, optionally, a
   description and acceptance criteria, and **Create task**. Creating a task selects it. It sends nothing.
3. Work in the same conversation. The bar keeps the current task and its status; **Conversation | Changes | Task** are three views of one
   session, with the run strip (and STOP) and the composer docked under all of them. Choosing a task never sends a prompt, changes the
   attached session or the worktree, grants anything, discards your unsent draft or changes a status.
4. Review the changes in **Changes**, as before.
5. In **Task**, record progress yourself: **Start work**, **Ready for review**, **Mark done** (with an optional note), **Mark blocked**,
   **Back to open**, **Reopen**. **Link the current session** records a reference from the task to the session this workbench is connected to.
6. Close the workbench. The tasks are in `<root>/develop/tasks.json`. `endo task list --project <id>` reads them with no workbench; the next
   workbench started with the same `--project` shows them, with the task you last chose selected. `endo task show --task <id>` also prints
   one task's description, acceptance criteria and status history (each move, when, and your note), as the page's Task view does.

Status moves are small and reversible: `open → in-progress | blocked`, `in-progress → review | blocked | open`, `blocked → open | in-progress`,
`review → done | in-progress | blocked`, `done → open` (an explicit reopening). `done` is reachable only from `review`.

## The project and its three facts

A project is **never inferred** from a remote URL, a branch name, an alias or a path you happened to be in. It exists only because you registered
it, and what the page shows is three separate facts:

- **Registered** (configured): the directory you named, as the system spells it with links resolved at that moment. `observedGitRoot` is what
  Git said the worktree root there was at registration (or none).
- **Launch**: whether the directory this workbench was launched in is **the same place**, a different one, or the registered one is gone.
  Equality is exact: launching from a *subdirectory* of the registered path is a different directory. Register the subdirectory if that is
  where you work.
- **Git, now**: what the broker's read-only Git inspection of the launch directory reports (the existing worktree bar), compared on the
  page with the root recorded at registration.

A mismatch or a missing directory makes the workspace **read-only**: the tasks are shown (they are yours), nothing is changed, and the page and
the terminal say why. A registered path grants no access to anything: it is compared and displayed, never opened, listed or run, and a task's text
is never used to pick a file, a tool or a command.

## One implementation, two callers

The CLI and the workbench's routes are both thin translations around one shared workspace service,
[`runtime/contracts/develop-workspace.ts`](../runtime/contracts/develop-workspace.ts). It owns registration, the read model, the writable gate and session
references, and it reaches the file only through the store described below. Its trusted-caller boundary, who authorises what, and what it
leaves for later are in [develop-workspace-service.md](develop-workspace-service.md).

## Where it lives, and what is in it

`<root>/develop/tasks.json` (`endo.develop-tasks.v0` or `.v1`, see [Versions](#versions-and-the-upgrade)), beside the evidence and never inside it: it is not an event, is never appended to the event
log, and no existing store file is read, migrated or rewritten. Deleting `develop/` loses tasks and nothing else.

| Stored | Not stored here |
| :-- | :-- |
| Projects you registered (name, path, observed Git root) | Live transcripts, model-provided reasoning, prompts |
| Tasks: title, description, acceptance criteria, status, timestamps, revision | Pairing codes, grants, approval phrases |
| Your status changes: when, from, to, an optional short note (the newest 50) | Provider credentials |
| Which task you last chose | Tool arguments or results, diffs, file contents |
| Session references you asked for (below) | |

**Privacy.** Task text is plain text in an owner-only file (`0600`, in a `0700` directory). It is shown to a **paired** workbench page and to `endo
task` in your terminal, and to nothing else: `endo studio` (the read-only server) has no route for it, and a test puts a canary in a task and
fetches each Studio read route family (the snapshot, the session list and one recorded session, the Compare candidates, and the workbench probes). **Do not put secrets in a task**: Endophasia does not scan it. **Retention:** tasks stay until you remove `develop/`
(there is no delete command in this slice); text can be cleared by editing it, which replaces it in the file. Nothing is sent anywhere.

## Persistence rules

- One small file, rewritten whole, at most 4 MiB: 8 projects, 300 tasks; a title of 120 characters; 4 000 characters each for description and
  acceptance criteria; notes of 280. Text is closed: no control characters except newline and tab, no line separators, no bidirectional overrides.
- Every change is: take the writer lock (`develop/tasks.lock.<n>`: the highest number is the lock, created exclusively, naming its pid; a lock of a dead process is superseded by the next number, never removed from under a writer that has just taken it), **read the file again
  from disk**, validate, apply **one** change to that copy, validate the result, write a uniquely named temporary file (mode `0600`, created
  exclusively and never through a link), `fsync`, rename over the file, `fsync` the directory. A crash leaves the old file or the new one.
  Temporary files a crash left are removed by the next writer. A change that finds nothing to do (choosing what is already chosen, linking a session
  already linked in this launch) writes nothing.
- Two processes write it (the workbench and the CLI). A **per-task revision** means an edit made against an old view is refused
  (`stale-revision`), never merged. The page sends only the fields you changed; after a refusal it reads again, a field you did not touch takes the
  new words, and a field **both** you and someone else changed keeps your words, shows the other version beside them, and is replaced only when you
  save again.
- A file that is malformed, of an unknown version, over the limit, invalid, or reached through a link is **unreadable**: it is reported with a closed
  reason, no write is ever made over it, and it is left byte for byte as found. The directory and the file are checked with `lstat` and opened with
  `O_NOFOLLOW`; a symbolic link is refused, not followed.

## Authority

The routes are served by `runtime/contracts/workspace-routes.ts`, a translation layer over the shared service, behind either host of `api/v0/workbench/*`:
the live workbench broker (`endo harness attach --workbench`) or the workspace host (`endo workspace open`, which runs no agent; see
[designs/workspace-host.md](designs/workspace-host.md)). Either way they pass every guard the server applies there: Host,
Origin and Fetch Metadata, an exact same-origin `Origin`, `application/json` and the 40 KiB body bound for a `POST`, and the **grant** from the pairing
code. There is no new route family and no new capability:

| Route (under `api/v0/workbench/`) | |
| :-- | :-- |
| `GET workspace` | the registered project, its tasks, references; or one constant when no project was named |
| `POST workspace/tasks/create`, `update`, `status`, `select`, `link-session`, `unlink-session` | closed bodies, a task id and the revision it saw |
| `GET workspace/attempts` | the selected task's work attempts, their briefs and their verification receipts, read-only (no query; nothing prepares or records one, and nothing runs a check) |
| `GET workspace/attention` | every open task's attempt count and the latest check of each command, for the overview, read-only (no query; nothing is decided, written or run) |

None of them sends a prompt, steers, queues or stops, starts, resumes or selects a session, runs Git or a shell, opens or writes any file but
`develop/tasks.json`, reads the transcript, or approves anything. The terminal approval, the pairing grant, capability admission and STOP are unchanged,
and metadata is **not** a second approval mechanism. Without a grant (an unpaired browser, a page after its session ended) nothing is read or changed.
`endo studio` has no workbench: the routes are not found there and a `POST` is refused.

When the workbench's session ends the broker revokes the grant (as it always has, so no private text outlives it). The page then keeps the tasks it
last read, marked *last read*, with every change disabled and the sentence "a disconnected agent has not necessarily finished its work". There is no
second, longer-lived grant for metadata: `endo task` is the way to read and edit without a live workbench.

## Session references

A task may carry **explicit** references to a session, from a closed set of two sources. Each records who decided, how, and what was
established, and none of them is a handle to the session.

| | Live Pi (`pi-live`) | Oh My Pi saved (`omp-saved`, needs a v1 file) |
| :-- | :-- | :-- |
| Made by | Your **Link the current session** button, in the paired workbench | `endo task link --source omp-saved`, in your terminal |
| Identity | The evidence store's id of the Pi session, from the broker's own state | OMP's own session id, from the saved file's header |
| Scope | The workbench launch that made it (`launchId`) | The OMP sessions directory you named, as a digest (`scope`) |
| Provenance | The launch's attachment | The format the read-only observer validated (`observedFormat: 3`) |
| Attribution | `linkedBy: "operator"`, `via: "workbench"` | `linkedBy: "operator"`, `via: "cli"` |
| On the page | **Pi · current** or **Pi · earlier launch** | **OMP · saved reference**, never current |
| Idempotence key | source, session id, launch | source, scope, session id |

Repeating a link for the same association writes nothing. A Pi and an OMP reference never share a key, whatever their ids say, and the same
OMP id in two directories is two references. Removing a reference (**Remove link**, or `endo task unlink --link <id>`) and linking again makes
a new one.

### Live Pi references

A live reference is made only by your **Link the current session** button, and the broker builds it from its own state, never from anything the
page sends:

```json
{ "linkId": "…", "source": "pi-live", "sessionId": "endo.session.pi.…", "attachment": "pi.default",
  "launchId": "…", "linkedAtMs": 0, "linkedBy": "operator", "via": "workbench" }
```

It records one claim: *at that time you asked this workbench, in that launch, to link this task to the session it served.* The page is given the
cockpit's alias (a label, never a key) and a **relation**:

- `current`: made in **this** launch, to the session connected now.
- `historical`: made in another launch (or the session is not connected). Even if a later launch serves a Pi session with the very same id, it is
  historical: launch-scoped identity is not reused, and the page says "whether that session is still the one attached cannot be verified".

Nothing links a task to a session by an alias, a name, a time, a directory or proximity, a recorded Pi or DSH session is never associated
automatically, and a reference gives a task no control over a session: no resume, no selection, no prompt. The neutral surface
(`endo.develop-session-surface.v0`) is unchanged and has no task field.

### Oh My Pi saved references

```sh
endo task link --root ./recordings --project endo.project.<id> --task endo.task.<id> \
  --source omp-saved --session <OMP session id> --omp-sessions ~/.omp/agent/sessions
endo task show --root ./recordings --project endo.project.<id> --task endo.task.<id> --omp-sessions ~/.omp/agent/sessions
endo task unlink --root ./recordings --project endo.project.<id> --task endo.task.<id> --link <linkId>
```

The session id is the one OMP wrote: OMP's `/session info` prints it, and Studio's OMP inspector shows it as the session's key. `endo task link`
does not take it on trust. It reads the directory you named with the same read-only observer Studio uses, and links only when:

- exactly one readable file there, of OMP's format 3, carries that id in its header (two files carrying it are a copy: neither is the session);
- every entry there was read: a file over the bounds, unreadable, changing while read or of another format, a link (never followed), a special
  file, or a directory below the observer's three levels might carry it too, so the answer is "uncertain" and nothing is linked. Name OMP's
  sessions directory itself (`~/.omp/agent/sessions`), not `~/.omp`;
- the id is OMP's, not a Studio selector (`o1-…`, which names a file in one Studio launch and is refused with that explanation);
- the store and the OMP directory do not overlap, and the task revision is the one read (or the one you gave with `--revision`).

```json
{ "linkId": "…", "source": "omp-saved", "sessionId": "019a…", "scope": "omp-dir.<32 hex>", "observedFormat": 3,
  "linkedAtMs": 0, "linkedBy": "operator", "via": "cli" }
```

It records one claim: *at that time you linked this task to the OMP session with this id, which Endophasia found exactly once in the directory
whose scope this is.* The session is OMP's. The reference has no launch, attachment or connection; it is **never current**, and nothing reads
it to resume, prompt, steer, queue, stop or select anything. A `session_exit` in the file says nothing about the task, and neither does a recent
write. OMP is not run, nothing is sent to it, and its files are only read (a test compares a manifest of the directory and puts a fake `omp`
first on `PATH`).

**Scope is the directory you named**, as `omp-dir.` and a SHA-256 of a purpose label and the resolved path. The path itself is never stored.
Two profiles or two copies of a store are two scopes, so their references are never merged. The same file reached through two different
named directories (the whole sessions directory once, one project group another time) is also two scopes: name the same directory each
time. A digest of a path is a label, not a secret: someone who can guess the path can compute it.

**The workbench does not look for OMP files**: the broker has no OMP directory and is given none. The page shows the reference as saved, with
its label (`omp` and the id's last 8 characters) and the scope's first 8 hexadecimal characters, and says that whether the file is still there
is not checked here. `endo task show --omp-sessions <dir>` checks, read-only, and reports each OMP reference as `established`, `not-found`,
`duplicate`, `uncertain` or `other-directory`. A reference whose file has gone stays, as your record; it is removed only by you.

Two different linked OMP ids that end in the same 8 characters get no label on the page, so a label never stands for two sessions. The paired
workbench's **Remove link** removes an OMP reference like any other: it is your record, and removing it touches no session.

There is **no browser link action** for OMP sessions. Studio, where OMP sessions are browsed, is the read-only, unpaired server and has no task
route; the paired workbench has no OMP observer. Adding either would be a new control channel, so linking stays in the terminal.

## Work attempts and handoff briefs

A **work attempt** is one request you prepare on a task: an objective, constraints, and what to report back, together with the task's
words as they were then. Its **brief** is plain text for you to paste into Pi, Claude Code, Codex, OMP or any other agent yourself.
Preparing or copying a brief sends nothing. The full design and its review are in
[designs/develop-work-attempts.md](designs/develop-work-attempts.md).

```sh
endo attempt prepare --root ./recordings --project endo.project.<id> --task endo.task.<id> --objective "…" [--constraints "…"]
endo attempt brief   --root ./recordings --attempt endo.attempt.<id>          # plain text: pipe it to your clipboard tool
endo attempt handoff --root ./recordings --attempt endo.attempt.<id> --to "Claude Code"
endo attempt report  --root ./recordings --attempt endo.attempt.<id> --note "what the agent said it did"
endo attempt abandon --root ./recordings --attempt endo.attempt.<id>
endo attempt list    --root ./recordings --project endo.project.<id> [--task endo.task.<id>]
```

- Attempts live in `develop/attempts/`, one write-once file per record, and **never change `tasks.json`**. Every attempt command leaves
  that file byte for byte as it was.
- **Prepared** means a brief exists. **Handoff recorded** means you said you handed it over, not that the agent read it. **Result
  reported, not verified** means you recorded a claim. **Abandoned** means you stopped. None of these changes the task's status: that
  stays your `endo task status` or the page's buttons.
- A handoff and an outcome are each recorded once. A second is refused `already-recorded`, and the first is kept. To try again, prepare
  a new attempt.
- In the paired workbench, the **Task** view lists the selected task's attempts read-only. It shows the brief in a read-only box with
  **Copy brief**, and says when the task's words changed since the brief was prepared. Copying never touches your unsent draft.
  `endo studio` has no route to attempts.
- A copied brief carries your private task text to the clipboard, where a clipboard manager may keep it. To remove an attempt, delete its
  files (`develop/attempts/<id>.*`); nothing else is affected.

## Verification receipts

A **verification receipt** records what Endophasia itself observed when you asked it to run a check against an attempt: which command,
in which working tree, at which commit, how the process ended, and whether the tree held still. It is evidence, not acceptance. Design,
trust boundary and review record: [designs/develop-verification-receipts.md](designs/develop-verification-receipts.md).

```sh
endo attempt check    --root ./recordings --attempt endo.attempt.<id> [--cwd <worktree>] [--timeout <s>] -- npm test
endo attempt receipts --root ./recordings --attempt endo.attempt.<id> [--cwd <worktree>]
endo attempt receipt  --root ./recordings --receipt endo.receipt.<id>
```

- `check` runs **your** command, exactly what follows `--`, with no shell. It runs at the top of a clean, committed working tree of the
  attempt's project (default: the registered path). A dirty, untracked, sparse or submodule tree is refused, and nothing runs. Nothing
  runs a check for you: not a task, an attempt, a brief, an agent or the page.
- It runs with your permissions and environment, and whatever it invokes from the repository is the repository's code, which an agent
  may have written. Stop anything else that writes the tree (an agent still working) first: Endophasia cannot tell.
- **Observed check passed** means the command exited 0 and Git saw the same commit and a clean tree before and after. **Observed check
  failed** means another exit code under the same conditions. **Inconclusive** means anything else: a timeout, an interruption, a
  signal, too much output, a process that escaped, or the tree, HEAD or ignore rules changing. Every receipt lists what it does not show:
  ignored files (`node_modules/`, build output) and the environment are not recorded.
- Exit codes: 0 passed, 3 failed, 4 inconclusive, 130 interrupted (recorded), 2 refused (nothing ran), 5 ran but could not be recorded.
- A receipt is never carried forward. When HEAD moves, it reads **Stale**. A receipt from another worktree or repository is "not
  compared". Nothing changes the task's status: accepting the work is still your `endo task status`.
- Receipts live in `develop/receipts/<attempt id>/`, one write-once file each. A failed receipt stays beside the pass that followed it.
  The paired workbench shows them under each attempt, read-only, without paths. To remove an attempt's receipts, delete that directory.

## One attempt's evidence, in one reading

```sh
endo attempt evidence --root ./recordings --attempt endo.attempt.<id> [--cwd <worktree>]
```

It answers, from the records that already exist and without writing anything: was this attempt sent, and what did Pi report? Which
checks did Endophasia observe, and does the latest of each still apply to the tree now? What did you decide? What is missing? Each line
says whose statement it is: `[observed]` (Endophasia's records), `[Pi's report]`, `[operator]` (yours), or `[none]`. It never names a
revision as the attempt's result, because no record does: the commits it lists are the ones you checked. Every gap it reports is a
fact about the records, not a verdict, and none changes the task. Design: [designs/develop-attempt-evidence.md](designs/develop-attempt-evidence.md).

## The overview: what needs you, and why

The **Task** tab opens on an overview of the project's tasks (design: [designs/develop-attention.md](designs/develop-attention.md)). When
any task needs you, a line in the bar ("3 need attention") leads there. The overview has four sections:

- **Needs your attention**: tasks you marked ready for review (a decision is yours), and tasks where the latest observed run of some
  command failed or was inconclusive. A review task whose passing check is not at the current, clean HEAD says **Recheck**.
- **In progress or blocked**: your statuses. A blocked task may be waiting on someone else.
- **Open**: not started.
- **Done**: folded away. Finished tasks are never urgent, and their old checks are not read.

Each row says why it is there in words, with each check related to this worktree's HEAD ("at an earlier commit", "in a different
working tree; not compared"). Opening a row chooses its task as the picker does, and opens the check the row is about. Nothing on the
overview changes a status, runs a check or sends anything. What could not be read is said, never taken as "nothing to see". The
overview is read when the tasks are, so press **Refresh** after a commit.

## Versions and the upgrade

| File | Meaning | Read by this build | Written by this build |
| :-- | :-- | :-- | :-- |
| `endo.develop-tasks.v0` | Live Pi references only | Yes, never rewritten by a read | As v0, for every change v0 can record |
| `endo.develop-tasks.v1` | v0 plus `omp-saved` references | Yes | As v1, always |
| anything else | | Refused whole (`unsupported-version`), never written over | Never |

- v1 differs from v0 only in the references: a v0 reference is, byte for byte, a v1 `pi-live` reference with the same meaning. The v0 validator
  was not loosened; v1 has its own closed validator in the version table.
- **You can keep using a v0 file.** The workbench and `endo task add | status | unlink` work on it as before and keep it v0. Only linking an OMP
  session needs v1: it answers `upgrade-required` and tells you how.
- **The upgrade is your act.** `endo task upgrade` is a dry run: it prints the version, the revision, and the counts of projects, tasks and
  references, and writes nothing. `endo task upgrade --apply [--revision n]` takes the writer lock, reads the file again, applies the pure
  v0 → v1 projection (every project, task, status, history, selection and Pi reference kept exactly; task revisions unchanged), validates, and
  replaces the file atomically; the file revision increases by one. A crash leaves the v0 file or the v1 file, never a mixture. A second upgrade,
  or one of a v1 or missing file, writes nothing. `--revision` binds it to the file revision you inspected (`stale-revision` otherwise).
- A new store is created as v1.
- **Going back.** A build from before v1 refuses a v1 file as `unsupported-version` and never writes over it. No v0 copy is kept for you (it
  would be a second copy of private text with no owner); copy `develop/tasks.json` before `--apply` if you may go back to such a build.
- The workbench's read model is `endo.develop-workspace.v1`: v0's, with source-aware references (`relation` is `current` or `historical` for
  Pi and always `saved` for OMP). The page refuses a body of any other version, and refuses an OMP reference that claims `current`, a launch or
  an attachment.

## Limitations, and what is deferred

- One project per workbench launch, named with `--project`; no project launcher, no automatic start of Pi, no worktree creation or checkout.
- No task deletion, archive, search, tags, dependencies, priorities, due dates, or assignment; no agent selection, scheduling, retries or plans.
- The Git association is by exact launch directory; a subdirectory launch is read-only.
- `endo task` can list, show, add, change status, link an OMP saved session and unlink; editing words and linking a live Pi session are in the
  workbench page. There is no browser action to link an OMP session (see above).
- Whether an OMP reference's file still exists is checked only by `endo task show --omp-sessions`; the page does not say "source unavailable".
- Real-source evidence for the OMP link is one local smoke (see [develop-workspace-service.md](develop-workspace-service.md#source-aware-references-slice-d)), not conformance.
- A registered path or task text is not scanned for secrets.
- The store has no cross-machine sync. Moving a project to another path means registering it again.
- Locks: the lock is a series of numbered files and the highest number holds it (see the header of `storage/develop-tasks.ts`). A writer takes it by
  creating the next number (a hard link of a finished file, so only one contender can create it); a lock whose process is gone is simply
  superseded by the next number; nothing is removed or rewritten to take a lock from another writer, and the highest number is never deleted (a
  release marks it released), so a number is never reused. One `tasks.lock.<n>` file therefore remains at rest; it is harmless. What is left: a
  lock naming a pid the system has since reused makes writes answer `busy` until `develop/tasks.lock.<n>` is removed by hand. This is a stricter
  pattern than the attachment's writer lock, which this slice does not touch.
- Real-runtime evidence is one local smoke, not conformance: the installed **Pi 1.4.0** launched once from the registered directory with the workbench
  and `--project`; a page paired, created a task, linked the session (Pi's own session id fit the reference format; relation `current`) and moved its
  status. **No prompt was proposed, no model or provider was selected, no terminal approval was asked**, and the store was a throwaway directory deleted
  afterwards. Everything else is tested against the fake Pi and fake session fixtures.

## Design review (Opus, read-only)

An independent Opus advisor reviewed the design before it was built and the built interface from real screenshots. Dispositions:

| Finding | Disposition |
| :-- | :-- |
| Keep the grant revocation at session end; show last-read tasks marked, changes disabled; the CLI is the edit path | **Accepted** |
| The session reference is built from the broker's state; the body carries only a task id and revision; same Pi id after a restart stays historical | **Accepted** (tested) |
| A lock file and a per-task revision; re-read on every operation; unique temporary files | **Accepted** (multi-process test) |
| A retry after a stale edit would write back a stale field | **Fixed**: edits send only changed fields and rebase; both-changed fields are flagged |
| Remember the chosen task on the server, not in the browser | **Accepted** (the page keeps no storage) |
| Merging the cluster into the worktree bar avoids a new row | **Accepted, with a cost**: at 1440 px (three columns) the bar wraps to three lines; one at wide windows |
| Remove "Task details" (duplicates the tab); association as glyph and a word; absent state is "No project" | **Fixed** |
| Task view: title first; read time and Refresh at the foot; fewer standing sentences; forward move primary | **Fixed** |
| `T` only where nobody is typing and only in DEVELOP; no autofocus unless the operator asked for a new task | **Fixed** (browser tests) |
| `over()` in writable gave a false "mismatch" | **Fixed** (removed) |
| A no-op write for an unchanged selection or link | **Fixed** (nothing is written) |
| Real-runtime coverage | **Scoped**: one local Pi 1.4.0 smoke with no prompt (see Limitations); everything else fake Pi; no conformance claim |
| A delete or archive command; a longer-lived metadata grant; a task-to-session lookup by alias | **Declined** for this slice |

## Screenshots

Real browser renders of **synthetic** fixtures (fake Pi session, a synthetic Git repository, no private text, no model run):
[Instrument, no task yet](images/develop-tasks-instrument-empty-1440.png) ·
[Instrument, Task view](images/develop-tasks-instrument-task-1440.png) ·
[Instrument, picker at 1280 px](images/develop-tasks-instrument-picker-1280.png) ·
[Field, Task view](images/develop-tasks-field-task-1440.png) ·
[Field, Focus](images/develop-tasks-field-focus-1440.png) ·
[a launch in another directory: read-only](images/develop-tasks-instrument-mismatch-1440.png) ·
[the session disconnected: tasks as last read](images/develop-tasks-instrument-disconnected-1440.png) ·
[phone, 390 px](images/develop-tasks-instrument-task-390.png).
