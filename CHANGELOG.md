# Changelog

## Unreleased

### Fixed
- At one column, the docked run strip had no background, so scrolled Task content showed through it.
- **EVIDENCE-INTEGRITY-001: a damaged authorisation record no longer reads as "never authorised".**
  - Before: `endo attempt evidence` read a malformed, invalid, misnamed, oversized, linked or unreadable `<id>.authorized.json` as no
    authorisation (`not-authorized`).
  - Now it says `authorizationRecord: "damaged"`, gives the gap `authorization-record-damaged` and the text `[unknown]`, and attributes
    no send or run. It counts the workbench sends in the log that no readable authorisation accounts for, and joins none of them.
  - The schema is now `endo.develop-attempt-evidence.v1`.
  - A damaged handoff or outcome is reported as damaged, not absent.
  - A damaged prepared record makes `attempt show/evidence` refuse as unreadable instead of saying "no such attempt".
  - `endo attempt show` carries the same record states. Damaged files are left as found.

### Added
- **DEVELOP-BEHAVIOUR-001: behavioural checks** ([design](docs/designs/develop-behavioural-checks.md)).
  - A planned check may declare what its command should DO: `"expect": {"exitCode": 0, "stdout": "14\n"}` in the plan file. The brief
    states it; the ledger then reads each receipt of that command by its exit code and its output's SHA-256 against the declaration, so
    a command that exits 0 with the wrong output **fails** the check, and one expected to exit 2 can pass it.
  - Receipts are now `endo.develop-receipt.v1`: every check records its standard output's SHA-256; `endo attempt check --keep-output`
    also stores its first 8 KiB, so the page and `endo attempt evidence` can show the first line where it differs. v0 receipts are still
    read (their output reads "not recorded").
  - `endo.develop-attempts-view.v5` and `endo.develop-attempt-evidence.v3` carry the expectation and what was observed. Execution is
    unchanged: a check still runs only from the argv typed after `--`.
- **DEVELOP-PROVENANCE-001: what the working tree was around an attempt** ([design](docs/designs/develop-candidate-provenance.md)).
  - Observations (`endo.develop-observation.v0`, `develop/observations/`) record HEAD and, for each changed path, the Git blob id and
    mode the working tree held, never contents. The live workbench records one just before it sends an approved attempt and one when
    the run that followed settles; `endo attempt observe` records one whenever you ask.
  - Each read compares them by content: what changed between them, whether the tree now holds the same content as the last one, and
    whether each commit a check ran at holds exactly what was observed. `endo attempt provenance` reads it; the Task view shows "Working
    tree around this attempt". It never says who changed anything.
  - `endo.develop-attempts-view.v4` names the HEAD (and its read time) every relation in it was compared with, and the page's gate
    checks every receipt's relation against it. The Context panel's changes are a separate read; the page now says so.

- **DEVELOP-VERIFY-001: verification plans and the acceptance ledger** ([design](docs/designs/develop-verification-plans.md)).
  - `endo attempt prepare --plan-file plan.json` writes the plan into the attempt (`endo.develop-attempt.v1`). The plan names checks (an
    exact argv and what the operator says it shows) and the criteria each addresses, or none ("your judgment"). The brief (`v1`) tells
    the agent how its work will be checked. Attempts without a plan are unchanged (`v0`).
  - The acceptance ledger is derived from the receipts already recorded, never stored. Per planned check it gives the result at the
    current HEAD: passed, failed, inconclusive, `mixed` (runs at this commit disagree), tree changed since, stale, elsewhere, not run, or
    not compared. Per criterion it follows one rule, and never says "met".
  - The Task view opens an attempt on its acceptance ledger and planned checks, each with the exact command that would run it, and
    folds the brief once there is evidence. `endo.develop-attempts-view.v3`; the page's gate re-derives the ledger.
  - `endo attempt evidence` (`endo.develop-attempt-evidence.v2`) carries the ledger and one new gap,
    `planned-check-not-passed-at-current-head`.
  - Nothing new runs anything: checks are still run only from the argv typed after `endo attempt check … --`.

- **EVAL-ISO-002: model access for a protected sandbox, through a narrow recording relay** (mechanism; not yet in
  `endo experiment protected-run`).
  - A sandbox's only way out is one Unix socket, bind-mounted alone (`socket` mount kind, `network: "model-relay"`). Behind it, the
    recording proxy's governed admission admits only `POST /v1/chat/completions`, measured from Pi 1.5.0, for the declared model, within
    size, transfer and connection bounds. It refuses the model server's administration endpoints and everything else before any upstream
    connection. Every admitted exchange is recorded as a verifiable cassette.
  - Optional `MemoryMax`/`CPUQuota` limits on a sandbox's scope, with an OOM kill reported as `oom-kill`.
  - Real Pi ran inside the sandbox against a fake and a real local model. A research driver
    (`research/protected-eval/model-connected/trial.ts`) keeps a sealed trial record and verifies it independently.
  - Fixed: a refused request in a governed recording no longer leaves a gap in exchange numbers. Before, one refused GET made the recording
    unreadable as a cassette.
  - See [docs/protected-model-access.md](docs/protected-model-access.md).
- **LIVE-PROCESS-CONTAINMENT-001: a live Pi session's processes are owned, and their cleanup is reported, never assumed.**
  - `endo harness attach` (and the workbench) runs Pi in a transient systemd user scope of its own where a user manager is reachable,
    reusing EVAL-ISO-001's containment. A process Pi's bash tool starts detached is in the scope too.
  - When the session ends, the scope is stopped and its cgroup confirmed empty, and stderr says so. Otherwise it says `CLEANUP INCOMPLETE`
    (with what is left and the command that ends it), or `UNVERIFIED` where there is no user manager (with a note before the session).
  - If `endo` is killed, Pi's keeper has the scope stopped. If both are killed, the next attach names the orphaned scope.
  - A deliberate background process started from Pi now ends with the session. No event, record or schema changed.
  - The work-cycle driver passes `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` to the attach (`DRIVER_VERSION` `review-pilot-001.2`).
  - See [docs/live-process-containment.md](docs/live-process-containment.md).
- **`endo attempt evidence --attempt <id> [--cwd <dir>]` (WORK-CYCLE-001B).** One attempt's records, read together and read-only. It
  shows what was sent and what Pi reported, the latest check of each command with its relation to the working tree now, the operator's
  status moves, a fixed list of gaps (missing, unconfirmed, stale or undecided), and what no record establishes. Every section names its
  source: observed, operator-declared, or none. It never names a revision as the attempt's result, because no record does. No record,
  event, schema or page changed. Real-Pi negative runs (lost model connection, Pi killed mid-tool) found that a tool process Pi started can
  outlive the workbench; this is documented, not fixed. The first human-governed run was executed:
  - the operator approved on the workbench terminal, after one recorded decline;
  - one dispatch was recorded, and the run completed;
  - the check passed at the operator's commit;
  - after the operator's `done`, the reading reports no gaps.

  That run found two bugs, both fixed:
  - the work-cycle driver now refuses a run directory too deep for the workbench's control socket;
  - `endo harness attach --control` no longer says "no prompt was sent" after a workbench send.

  See
  [docs/designs/develop-attempt-evidence.md](docs/designs/develop-attempt-evidence.md) and
  [research/work-cycle/WORK-CYCLE-001B.md](research/work-cycle/WORK-CYCLE-001B.md).
- **WORK-CYCLE-001A: one DEVELOP work cycle, reconstructed from the stored evidence.** `research/work-cycle/driver.ts` drives one
  small coding task through the existing public commands: register, task, attempt, a failing baseline check, the live workbench (the
  operator approves on its terminal), the candidate diff, a commit the operator chooses to make, `endo attempt check`, and a report a
  new process rebuilds with no agent running. The report keeps Pi's run, the check and the operator's decision apart, and lists what it
  cannot establish. It ran against Pi 1.5.0, with its own tools, against a scripted endpoint (which pins 1.5.0's tool-argument
  validation), and twice with Muse Glimmer 30B under a test-substitute approval. The Ponytail mode is read from the child's actual
  model requests, with a positive control. The operator-governed run itself is not tested. See
  [research/work-cycle/README.md](research/work-cycle/README.md).
- `endo task show` also prints the task's description, acceptance criteria and status history, so a terminal reader can see when and
  how the operator moved the status.
- **EVAL-ISO-001: protected experiment execution and an independent evaluator (offline).** `endo experiment protected-run <spec>
  --out <dir>` plans trials with the same blocked randomization as `endo experiment run`. Each attempt runs as an untrusted process in a
  Bubblewrap sandbox: new user, mount, PID, network, IPC, UTS and cgroup namespaces; an empty read-only root holding only the declared
  runtime files (each root-owned and digested), a read-only agent directory and the attempt's own workspace; private tmpfs; a cleared
  environment; no network. Before each attempt a probe checks from inside that the host's home, the repository, the archives, other trials,
  the evaluator, host sockets, loopback services and the network are unreachable, and the agent starts only if every probe passes. The
  submission is collected after the sandbox's PID namespace is confirmed empty: declared regular files only, with links, hard links, special
  files, traversal, oversize and changes during reading refused. It is judged in a second sandbox by a trusted driver from the cases'
  inputs, while the expected results stay with the controller; the evaluator is qualified first against a reference and a negative. Each
  attempt leaves a sealed `endo.protected-trial.v0` record with a strict, digest-checked reader. Interrupted attempts stay visible, a retry
  names the attempt it retries, and a resume with a changed spec, isolation, agent or evaluator is refused. `endo experiment
  protected-report <dir>` accounts for every planned trial. Missing isolation is a refusal, never an unprotected fallback. Model-connected
  studies (a narrow relay to the capture proxy, Pi in the sandbox) are EVAL-ISO-002. See
  [docs/protected-experiments.md](docs/protected-experiments.md).
- **MEM-000: what the recorded evidence permits us to learn, before any memory selector is built.** `node
  research/evidence-eligibility/report.ts --out <dir>` reads every experiment run and an optional DEVELOP store, read-only, through the
  existing version-directed readers. It reports, per decision, which learning objectives (descriptive, symptom, lesson, causal policy)
  the record may serve, with closed reasons for each it may not. The reasons include duplicates, interrupted executions, missing outcomes
  (never failures), unverified or digest-only content, study exclusions and invalid arms (cited from the studies' committed analyses),
  operator-only assignment, and receipts' limits. It checks a small hand-written set of lesson candidates against those examples, and
  judges MEM-001's evidence, lesson and evaluator readiness separately. The output is deterministic and holds no absolute path, prompt or
  tool text. Over the local archives: 143 examples are usable for causal policy (one study). Reasoning on, there are 11 specific failures,
  10 of them one rule of one task. One candidate is usable. MEM-001 is NOT READY, and the recommendation is to reconsider the objective.
  Research-only; no production contract changes. See [research/evidence-eligibility/RESULTS.md](research/evidence-eligibility/RESULTS.md).
- **Request a prepared attempt from the paired workbench page, and see where it stands from any view.** In the live workbench (`endo
  harness attach --control --workbench --project <id>`), Task → an attempt → **Request sending ‹id› to Pi** asks the attached terminal to
  approve sending that attempt's brief. It uses a new grant-gated route, `POST attempt/propose {attemptId}`, which names the attempt and
  nothing else: the broker reads the brief from the attempt's record, runs Slice I's checks, and the terminal shows the whole brief,
  marked "requested from the paired page". It is sent only after the attempt's own `APPROVE ATTEMPT` phrase is typed there. The pairing
  grant lets the page ask, never approve, and it must still be held when the brief is sent. A withdrawn, declined or refused-before-binding
  request leaves the attempt sendable. A bound attempt is never sent again, and a lost reply is shown as unknown, not failure. The
  request card in the conversation now names its attempt and the steps it reached (approved, authorisation recorded, sent, Pi replied).
  A one-line **next step** under the run strip, in every view, reads the request and the selected task's records: waiting for terminal
  approval, run open, run ended with no check recorded, checks recorded and the decision is yours. Status gains `offers.attempt`, the
  prompt view gains `attempt`, and the terminal question gains `requestedFrom`. Studio and `endo workspace open` are unchanged and cannot
  ask. Tested in a real browser over a real attachment to the fake Pi; end to end under a pseudo-terminal with the real CLI and browser;
  and opt-in against an installed Pi (1.5.0) with a fake model endpoint. See
  [docs/designs/develop-attempt-workbench.md](docs/designs/develop-attempt-workbench.md).
- **Send a prepared work attempt to Pi from the live workbench, and read later what happened.** In `endo harness attach --control
  --workbench --project <id>`, type `attempt <id>` on the attached terminal. The brief is rendered from the attempt's own record, shown
  whole, and sent as a new prompt on the existing prompt chain only after you type its own phrase (`APPROVE ATTEMPT <16 hex>`). After the
  approval and the final checks (same project, Pi launched in its registered directory, task words unchanged, not done, no outcome, not
  sent before), the broker writes one write-once record, `develop/attempts/<id>.authorized.json` (`endo.develop-attempt-authorization.v0`),
  **before** it records the send. An attempt is sent at most once and never retried. `endo attempt show`, the workbench page and `endo
  workspace open` join that record to the session's event log by exact ids. They show whether the brief was sent, Pi's reply, and how the
  run after it ended as Pi reported it, with an outcome-unknown state for a send with no recorded reply. None of this is verification or
  acceptance: the attempt's own state and the task's status do not move. The page cannot request a send, and Studio and the workspace host
  cannot write one. The attempts view is now `endo.develop-attempts-view.v2`, and the prompt chain gains two refusal reasons
  (`attempt-changed`, `attempt-not-recorded`). A build that predates this lists the new file as an unknown file and still shows the
  attempt. Tested against the fake Pi under a real pseudo-terminal, and opt-in against an installed Pi (1.5.0) with a fake model endpoint.
  See [docs/designs/develop-attempt-execution.md](docs/designs/develop-attempt-execution.md).
- **`endo workspace open --project <id>`: DEVELOP without a running agent.** A foreground host on 127.0.0.1 serves the same page and the
  same task routes as the live workbench, behind its own pairing code, with **no harness**: no Pi, model or provider is needed or started.
  A paired page sees the attention overview, each task's attempts, briefs and verification receipts, and the worktree's changes. It
  creates and edits tasks and sets statuses by the store's own rules and revisions. It cannot prompt, steer, queue or stop an agent, link
  a session, run a command, or choose a path, store or project. The terminal issues codes (`pair`), ends the grant (`revoke`) and stops
  it (Ctrl-C). The page shows a **Workspace** desk instead of a live session, and nothing on it says "disconnected". Returning from a task
  to the overview now focuses the row you came from and keeps "Show all" and "Done" as you left them. Pairing and the task and project
  routes moved to `cockpit-http/` (`pairing.ts`, `workspace-routes.ts`) and are shared with the Pi workbench unchanged; the broker's
  worktree reads now also re-check the grant after reading Git. See [docs/designs/workspace-host.md](docs/designs/workspace-host.md).

### Fixed
- **A late "no worktree" answer no longer moves the operator out of the view they chose.** On a workbench with no Git context, the page's
  project read reset the whole project state, including the Conversation, Changes or Task view, so someone reading Task could be moved
  back to the conversation. The view is now kept (Changes, which is not offered then, falls back to the conversation).
- **A browser test's stand-in servers close their keep-alive connections first.** `close()` alone waited for Chromium's idle connections,
  which on a loaded CI runner outlasted the 10 s hook limit (`tests/endo-studio-observe-browser.test.ts`).
- **A Ctrl-C at the very end of Studio's shutdown no longer kills it by the default signal action.** Studio keeps its SIGINT and SIGTERM
  listeners until the end, but Node removes them while it tears the process down after the event loop drains, so a signal landing in that
  instant ended the process with `signal: SIGINT` instead of status 0 (a slow CI runner hit this with the repeated-signal test). Studio
  now exits at the moment the loop drains (`beforeExit`), which still never happens while something leaked holds the loop, so a leak
  remains visible as a Studio that does not end.

### Changed
- **`endo doctor` labels a recorded capability list that describes another identity.** When the installed Pi's identity differs
  from the recorded one, or is on another identity basis and so cannot be compared, the listed capabilities are headed "as
  RECORDED for the earlier identity above, not established for the installed Pi" and a next step says to run `endo harness check`.
  Previously the list appeared under a plain heading, and the next step was missing after a basis change. New
  `evidence.capabilitiesDescribeOtherIdentity` in the JSON report.
- **Live-study `run.identity` no longer mistakes Pi's documented `agent_settled.aborted` for an unreviewed key.** Since Pi 1.1.0
  `agent_settled` carries `aborted: boolean`; the version-2 check classified Pi 1.4.0 as a `run.identity` MISMATCH. Version 3 of
  `pi.live.study` accepts exactly that field (a Boolean, on `agent_settled`), still reports any other key and any mistyped flag, treats
  an unsettled study as inconclusive, and records UNAVAILABLE (Pi still supplies no run or turn identifier) with an observation that
  names the flag as a termination flag. The definition digest changes, so evidence recorded under version 2 stops applying for all
  nine capabilities the check covers; run `endo harness study --authorize-live-study` again. Adapter, mapping and suite versions are
  unchanged; Pi 1.4.0 is not added to the verified baseline. See [docs/pi-1.4.0-upgrade.md](docs/pi-1.4.0-upgrade.md#correction-agent_settledaborted-check-version-3).
- **Pi runtime identity now covers the runtime's own files, not only the launcher.** Pi's npm entrypoint
  `dist/bundle/cli.js` is a ~160-byte launcher that is byte-identical across 1.0.1, 1.0.4 and 1.4.0, so the old identity could not see
  a same-version change to the code behind it. New fingerprints (`endo.harness-fingerprint.v1`, basis `runtime-content.v1`) add a
  deterministic digest over every regular file in the directory the entrypoint sits in (`dist/bundle`): path, size and SHA-256,
  sorted, domain-separated, bounded, never following symbolic links, and recorded as a gap, never as a partial digest, when
  coverage is incomplete (unsupported layout, unreadable file, link out of scope, limit exceeded, or a change while reading). An
  identity without that digest is `reduced`. Old `v0` records are not rewritten and keep their meaning; digests on different bases
  are never compared, so the first identification after upgrading records an `identityBasis` change (`endo.harness-change.v1`), and
  capabilities qualified on the old basis are unverified until `endo harness check` records evidence for the new identity. `endo
  doctor`, `endo harness status` and the assessment say which basis each identity is on and what it covers. This verifies local
  content; it does not authenticate the publisher, and Node, imported packages and user configuration remain outside it. See
  [docs/attachment.md](docs/attachment.md#what-the-fingerprint-covers) and
  [docs/harness-upgrades.md](docs/harness-upgrades.md#changing-the-identity-basis).

### Added
- **DEVELOP attention overview.** The workbench's **Task** tab now opens on an overview of the project. It answers "what needs me,
  and why?" from your statuses and from the checks Endophasia observed, with no model or score. **Needs your attention** lists tasks in
  review (a decision is yours) and tasks where the latest observed run of a command failed or was inconclusive. Each row says why, and
  says where each check was recorded relative to HEAD now, in that relation's own words. Then come **In progress or blocked**, **Open**,
  and **Done** (folded away; finished work is never urgent). A line in the bar ("3 need attention") leads there. Opening a row chooses
  the task, as the picker does, and opens the receipt it is about; it changes no status and sends nothing.

  The overview reads one new route, `GET workspace/attention` (`endo.develop-attention-view.v0`), behind the grant. It is a bounded,
  read-only projection of the existing attempt and receipt stores: one Git observation per read, at most 1,000 receipt files (8 MiB), and done
  tasks not read. `endo studio` does not serve it. The broker now re-checks the grant after a read that waited, so a pairing revoked
  during the read gets a refusal, not data. This also applies to `GET workspace/attempts`. See
  [docs/designs/develop-attention.md](docs/designs/develop-attention.md).
- **DEVELOP verification receipts** (`endo attempt check|receipts|receipt`). `check` runs the command you give after `--` (no shell, in a
  process group Endophasia owns, bounded in time and output). It runs at the top of a clean, committed working tree of the attempt's
  project. Endophasia observes the tree with read-only Git before and after, and records what it saw once, under
  `develop/receipts/<attempt>/`:
  - which command and commit;
  - how the process ended;
  - whether HEAD, the tree, the reflog and the ignore rules held still;
  - an outcome derived from those facts: **Observed check passed**, **Observed check failed** or **Inconclusive**;
  - the limitations (ignored files and the environment are not examined).

  A receipt is not acceptance: no task status moves. Receipts are never carried forward, and read **Stale** once HEAD moves. The paired
  workbench shows them read-only under each attempt (`endo.develop-attempts-view.v1`). There is no route to run a check, and `endo
  studio` serves none of it. See [docs/designs/develop-verification-receipts.md](docs/designs/develop-verification-receipts.md).
- **DEVELOP work attempts and handoff briefs** (`endo attempt prepare|brief|handoff|report|abandon|list|show`). An attempt is one
  request you prepare on a task. It records an objective, constraints, what to report back, and the task's words as they were. Its brief is
  harness-neutral plain text for you to paste into any coding agent. Preparing, printing or copying a brief sends nothing and starts no
  process. Handoffs and outcomes are your own statements, recorded once each and labelled as such ("Result reported, not verified"). No
  attempt operation writes `develop/tasks.json` or changes a task's status. Attempts are write-once files in `develop/attempts/`
  (`endo.develop-attempt.v0`, `-handoff.v0`, `-outcome.v0`), so there is no lock and no migration; the task file's versions are unchanged.
  The paired workbench's Task view lists the selected task's attempts read-only, with **Copy brief** (`GET workspace/attempts`, behind
  the grant), and `endo studio` has no route to them. Design and its Elephant–Goldfish review:
  [docs/designs/develop-work-attempts.md](docs/designs/develop-work-attempts.md).
- **Source-aware task links: a task can reference an Oh My Pi saved session** (`endo task link --source omp-saved --session <omp-id>
  --omp-sessions <dir>`). The command reads the named directory with the existing read-only observer and links only when exactly one
  readable format-3 file there carries that id and every file there was read; a duplicate, an unread file, a Studio selector or a bare
  id is refused. The reference records OMP's own session id, a scope (a digest of the resolved directory, never the path), the format
  observed and the operator's attribution (`via: "cli"`). It has no launch, attachment or connection, is shown as **OMP · saved
  reference** and never as current, and grants no control; OMP is not run and its files are only read. `endo task show
  [--omp-sessions <dir>]` lists a task's references and, with the directory, whether each OMP session is still found there;
  `endo task unlink` removes one. Live Pi references are unchanged and are still made only by the workbench that serves the session.
  See [docs/develop-tasks.md](docs/develop-tasks.md#session-references).
- **`endo.develop-tasks.v1`, with an explicit upgrade.** v1 is v0 with one change: a session reference is a closed union of `pi-live`
  (byte for byte the v0 record) and `omp-saved`. This build reads both; a v0 file is never rewritten by a read and keeps being written as
  v0 for every change v0 can record, so existing workbench and CLI workflows are unaffected. `endo task upgrade` is a dry run that
  reports the file's version and contents; `endo task upgrade --apply` rewrites it once, atomically, as v1 (task revisions kept, file
  revision +1). Linking an OMP session on a v0 file answers `upgrade-required`. A new store is created as v1. Builds from before v1 refuse a
  v1 file as `unsupported-version` and never write over it; keep a copy of `develop/tasks.json` if you may go back to one. The workbench's
  read model is now `endo.develop-workspace.v1` (source-aware references; the page refuses a v0 body). `endo project list` prints the
  file's `format`. See [docs/develop-tasks.md](docs/develop-tasks.md#versions-and-the-upgrade).
- **Oh My Pi saved sessions in DEVELOP** (`endo studio --omp-sessions <dir>`). This is the first real non-Pi session source. Studio reads
  OMP's saved JSONL sessions (format 3, title slot v1, checked against the local files of the installed OMP 18.14.1, which record 18.13.3 and 18.14.1) from the directory the operator names,
  and shows them in DEVELOP as the neutral surface's `omp-saved` source. Every entry is externally owned and recorded, with no control
  action and no claim that OMP is running.
  - **Allowlist, not blocklist.** Shown: counts, entry kinds, OMP's built-in tool names, plain model names (never a path or a model file), OMP's own exit records and recorded lineage. Never
    shown: any text, title, path, prompt or digest.
  - **No tail offset.** Every read is a whole fresh read of a stable file, so a rewrite or replacement can never splice generations.
  - **Fails visibly.** Unknown formats, partial lines, links, FIFOs and duplicate ids each get their own state.
  - **No writes.** Nothing is written to OMP's directory, verified by a full manifest.
  - **No new authority.** The task store and the session contract are unchanged, and an OMP host cannot link a session to a task.

  See [docs/develop-omp-observer.md](docs/develop-omp-observer.md).
- **One workspace service for DEVELOP projects and tasks** (`runtime/contracts/develop-workspace.ts`). The `endo project`/`endo task` commands and
  the workbench's task routes now call one implementation. The service owns registration, the read model, the writable gate and session
  references. It has an operator scope (the CLI) and a launch scope for one project and one launch (the workbench). The broker is given
  only the launch scope, never the store. A session reference is built from the host's own facts and is current only for the same launch,
  the same source and the connected session; a host of a source the file does not know can link nothing. The file format, the read model,
  the CLI output and the routes are unchanged. The service is usable as a library without Pi, a server or a browser, which a non-Pi consumer
  test process demonstrates. It is not a daemon, a network service or a coordinator. See
  [docs/develop-workspace-service.md](docs/develop-workspace-service.md).
- **DEVELOP projects and tasks: a persistent workspace beside the live conversation.** The operator registers a project (`endo project add
  --name <n> --path <dir>`: an explicit statement that this directory is this project; nothing is opened or run), names it for a launch
  (`endo harness attach … --control --workbench --project <id>`), and writes **tasks** under it: a title, an optional description and
  acceptance criteria, and a status the operator alone moves (`open → in-progress → review → done`, with `blocked` and an explicit
  reopening; an agent finishing a run never changes it). The workbench gains a project/task cluster in the worktree bar, a task picker
  (`T`), and a **Task** view beside Conversation and Changes with the run strip, STOP and the unsent draft docked under all three.
  `endo task list|add|status` read and change tasks without a workbench. Tasks live in `<root>/develop/tasks.json` (`endo.develop-tasks.v0`),
  separate from the evidence: written atomically under a lock with per-task revisions (a stale edit is refused, never merged), bounded,
  owner-only, and unreadable (reported, never overwritten) when malformed or reached through a link. A **session reference** is explicit,
  built by the broker from its own state, scoped to its launch, and historical after a restart. The routes are inside the existing broker
  behind the pairing grant (`GET workspace`, `POST workspace/tasks/…`), add no command, and are absent from `endo studio`. A launch in a directory
  other than the registered one shows the tasks read-only. See [docs/develop-tasks.md](docs/develop-tasks.md). Tested against the fake Pi and fake session
  fixtures, plus one local smoke with the installed Pi 1.4.0 (a task created and the session linked; no prompt, no model, no approval); not a conformance claim.
- **Upstream-change assessment in `endo harness status`:** after a harness changes, status explains it from the recorded
  registry, read-only and without examining the executable: the previous and current runtime, which identity facts differ,
  each capability's standing before and now with every dependency that changed (identity, confidence, adapter, mapping,
  suite, check definition, configuration), what re-establishes it (offline check, authorised live study, or a release
  review), and a ladder of claims that keeps "protocol checked" and "capability qualified" apart from "behaviour compared"
  and "reproducibility established", which no check reaches. A standing is never reported stronger than recorded; evidence
  this Endophasia build no longer accepts is shown as unverified, and `endo doctor` now marks such capabilities stale. The
  logic is runtime-neutral (`runtime/contracts/harness-assessment.ts`); no record type was added. `harness check` now
  reports inconclusive local results instead of leaving them silent. See [docs/harness-upgrades.md](docs/harness-upgrades.md),
  the [Pi 1.0.4 → 1.4.0 case study](docs/pi-1.4.0-upgrade.md) and [docs/upstream-boundaries.md](docs/upstream-boundaries.md).
- **Model-provided reasoning in the DEVELOP live workbench:** where Pi supplies reasoning as structured `thinking` blocks (for a local
  model behind llama.cpp, its `reasoning_content`), the conversation shows it in the runtime's order, labelled *Model-provided
  reasoning*, folded by default, with a **Folded | Shown** display preference (memory only; it never changes the model's thinking
  setting) and per-trace opening. The message being written is shown as of the last read and replaced by the completed message.
  Redacted reasoning is shown as withheld; `<think>` tags in ordinary text are never treated as reasoning. Memory only, bounded per
  block, message, page and in all, served only to the paired page, cleared with the session, never in evidence or logs (a test scans
  the store with a real Pi). Wire: `endo.workbench-transcript.v1`; the session surface gains a harness-neutral `live-reasoning`
  action. See [docs/develop-reasoning.md](docs/develop-reasoning.md).
- **Field, second iteration (the night survey):** a near-black ground for OLED screens, the contour field in phosphor-like ink (the
  reported hue only while a reported run is re-read, amber high ground while the terminal is waited on), a dark clearing for the
  conversation, a horizon line under the run strip carrying the field's state, sessions in a drawer and a closable changes/context
  dock (**Focus**) during a live session, and a wider measure on large screens. See [docs/develop-field.md](docs/develop-field.md).
- **Field, an optional appearance for DEVELOP:** an **Instrument | Field** switch in the top bar (DEVELOP only; Instrument stays the
  default). Field draws the same workspace, state and controls as a survey sheet: a slow contour field in text behind the work (Canvas 2D,
  loaded on demand, GPU not needed), a reading surface with a measure, and, where there is nothing to read yet, a ledger of what is
  **known**, **not known**, **possible here** and **yours**, each line with its provenance mark. The field's motion comes from typed state
  only (`model/field.ts`): a run Pi reports open flows only while the page is re-reading it; a recording never moves; an unreachable broker is
  drawn broken, not ended; a request awaiting terminal approval holds the field and shows a text beacon that names the terminal; reading
  changes stills it. A legend says what the field shows; it pauses on request, under reduced motion, and while the page is hidden. Nothing is
  persisted (the page has no storage), no route, hook or dependency was added, and the one animation-frame loop is confined to the renderer
  by a source test. See [docs/develop-field.md](docs/develop-field.md).
- **Project and worktree context, and a read-only Changes review, in the DEVELOP live workbench:** a worktree bar (repository, branch or
  detached/unborn HEAD, short commit, per-area counts) above the run strip; a Conversation | Changes switch in the centre with unified
  diffs of staged (HEAD → index), unstaged (index → working tree) and untracked files, previous/next file, and `j`/`k`/`Esc`; the changed-file
  inventory and the repository's other worktrees (places, not sessions) in the context column. The directory is the one Pi was launched in
  (configured, then read with Git): a recorded Pi or DSH session still has no project, and nothing says who changed a file. Two GET routes
  behind the workbench grant (`project`, `project/diff`) with a fixed query shape and no browser-supplied path; Git is run with a fixed list
  of reads that run no program a repository names (fsmonitor, filters, textconv, external diff, hooks, pagers), take no lock and write nothing
  (plumbing, not `git diff`, which rewrites the index), under timeouts and output caps, with symlink and scope checks, display-safe names, and
  a revalidation that refuses a diff once the working tree has moved on. Nothing is polled; the last confirmed facts stay, marked out of
  date or unconfirmed. The live view now fills the window (the conversation scrolls between a pinned header and a docked composer), the composer stays
  editable during a run, the sessions list is a drawer at laptop widths, and the privacy of live text is stated once instead of under every
  message. See [docs/develop-project-review.md](docs/develop-project-review.md).
- **Neutral DEVELOP session surface (`endo.develop-session-surface.v0`):** one presentation contract for a session whatever produced it, with a
  source-qualified key and its scope kept apart from the display alias, ownership, observed/reported/recorded status claims that are never
  merged, live/recorded/unavailable observation, separate observe/control/coordinate capabilities (every action present, a reason for each
  that is not supported) and independently qualified parent/child edges. The live Pi workbench, recorded Pi and recorded DSH sessions are
  projected into it in the browser, with no change to any server response, and DEVELOP now shows a live-or-recorded tag per row and a
  source, ownership and offers block per session. Offers are descriptions: the composer and STOP still follow the broker's own offers and
  its admission. Two test-only shapes (an externally owned session; a meta-harness job with two children) show external and hierarchical
  sessions can be represented without inventing observations or authority. See [docs/develop-session-surface.md](docs/develop-session-surface.md).
- **STEER, QUEUE and STOP from the DEVELOP workbench:** the composer gains Steer and Queue modes (never switched for the operator,
  each showing its delivery semantics) and STOP sits in the run strip. They drive the existing intervention desk and chain, behind the
  same terminal approval for every one: the page only requests, the operator types `APPROVE STEER|QUEUE|STOP <digest prefix>` on the
  attached terminal (recorded as `confirmation: "terminal-phrase"`, origin `operator-workbench`). Offered only for an open run on the
  live session and an admitted capability, with the reason when not. Cards in the conversation keep requested, approved, sent, Pi's reply,
  consumption and the run's end apart: acceptance is not consumption, consumption is checked only on request against the proxy capture
  (and is not established without one), and a run's end is what Pi reported, never attributed to the request. A lost reply is "outcome
  unknown", not refused. One approval waits at a time; a duplicate STOP returns the pending one; the desk tells the broker before it
  records consequences, so nothing is approved after they are written. Steer and queue text is kept in `<root>/interventions/` before
  approval, as `endo steer` does. See [docs/develop-workbench.md](docs/develop-workbench.md#13-slice-b-steer-queue-and-stop-through-the-broker).
- **DEVELOP live workbench for one governed Pi session (opt-in):** `endo harness attach <root> --control --workbench` serves the Studio
  page on its own loopback address behind a small command broker. The page shows the live connection and run state the broker
  reports, a private in-memory conversation (never written to evidence or any read route; Pi keeps its own session file), and can
  request one new prompt, which is sent only after the operator types its exact phrase on the attached terminal. The prompt has its own
  record chain (`workbench.prompt-*`, by keyed digest only). Pairing by a one-time terminal code, a single in-memory grant, exact
  same-origin guards, closed routes, no shell, no PTY, no raw RPC. `endo studio` remains read-only (its server gains only a constant
  "no workbench" status answer). OMP and streaming are not built. See
  [docs/develop-workbench.md](docs/develop-workbench.md).
- **Develop workspace (read-only session desk) in Endophasia Web:** browse the recorded Pi and DSH sessions in a store, group them by
  source, select one and read its recorded lifecycle state (as recorded, never as a live process), counts, positions, per-run usage as
  reported, and its events in storage order with provenance marks, with explicit paging, client-side filters that say they cover only
  what is loaded, and hand-offs to Observe and Compare. Two new GET routes (`develop/sessions`, `develop/session/<selector>`) with
  versioned, validated presentations (`endo.cockpit-develop-sessions.v0`, `endo.cockpit-develop-session.v0`), selectors and cursors bound to
  their own purpose and to the verified log generation, and the timeline's own withholding of arguments, results, prompts and paths. No
  write path, polling, project inference or execution authority. See [docs/studio.md](docs/studio.md#develop-workspace-read-only-session-desk).
- **AA-LIVE-001 result (research):** the first real matched two-turn A/A ran once against the pinned llama.cpp build and
  model: `COMPLETE-UNDER-DECLARED-ASSUMPTIONS`, 4 of 4 slots, 8 of 8 requests bound, server binary `MATCH`, cleanup
  confirmed. Redacted summary and limits in
  [research/governed-initial-continuation/aa/RESULTS.md](research/governed-initial-continuation/aa/RESULTS.md). Harness
  validation only: not model parity, not attestation, no noise floor.

### Fixed
- **DEVELOP: a STOP no longer waits behind an unapproved steer or queue, and the evidence check no longer holds the workbench:** requesting a
  STOP while a STEER or QUEUE awaits terminal approval now supersedes it. The STOP's proposal is recorded first (if that fails nothing is
  disturbed), the pending request is cancelled with a recorded `not-authorized` refusal whose detail says it was superseded, its terminal
  question is released before the STOP asks its own, and anything typed for the cancelled request is discarded. The STOP still needs its own
  exact `APPROVE STOP` phrase, and every gate is checked at dispatch; a request already approved and waiting for Pi is never touched.
  *Check evidence* now returns at once and runs as a bounded, resumable scan in slices that yield to the event loop, with limits per slice,
  per check, per request (one at a time, a cooldown) and overall; an incomplete check (a limit, an unreadable body, a closing session)
  establishes nothing, and `intervention.consumed` is still written only when the capture shows the message one more time, once. The close-time
  check still reads the whole capture; a body it cannot read is now reported rather than skipped. A pending prompt approval still blocks STOP,
  and a cancelled steer's text stays in `<root>/interventions/`. See
  [docs/develop-workbench.md](docs/develop-workbench.md#14-stop-priority-and-bounded-evidence-checks).
- **Task-owned launcher now waits for the model mapping (research):** a real llama.cpp server listens before it loads its
  model, but the launcher inspected the process the moment the listener appeared and required the model to be mapped, so
  it refused a real server. It now waits, inside its startup deadline and under the same cancellation, for the first
  model mapping and then runs the unchanged inspection; a server that exits, never maps, or times out is ended. Found by
  the first real launch attempt (refused before any request). AA-LIVE-001 revision 3 records it.

### Added
- **AA-LIVE-001 preflight (research; read-only):** pre-registration, local environment qualification, recovery and
  dependency identity of the historical pinned llama.cpp build (build 11518, commit `1f8fa5231`), `--fit off` profile
  assessment and go/no-go for the first real matched A/A, in
  [research/governed-initial-continuation/aa/LIVE-PREFLIGHT-001.md](research/governed-initial-continuation/aa/LIVE-PREFLIGHT-001.md).
  The operator's printed outcome now states the server-binary status, so a study with an unpinned executable is not
  presented as a pinned one. No server or inference was run.
- **Terminal-governed A/A operator (research; fakes only):** `research/governed-initial-continuation/aa/operate.ts --inspect|--run <config>` (a research script, not an `endo` subcommand) connects the
  task-owned server lifecycle, a bounded read-only `GET /health` readiness gate, the governed two-turn A/A study with real
  procfs admission, and fresh-process verification behind typed terminal approvals (one for the server, one per turn). `--run`
  refuses unless stdin and stdout are the controlling terminal; there is no approval flag, environment variable or unattended
  path. SIGINT/SIGTERM/SIGHUP, EOF and every failure path stop the owned server exactly once and report `cleanup-unconfirmed`
  rather than success when that cannot be confirmed. Exercised only with a fake relay, Pi and endpoint through a real
  pseudo-terminal; no llama.cpp server or real inference. See
  [research/governed-initial-continuation/aa/OPERATOR.md](research/governed-initial-continuation/aa/OPERATOR.md).
- **Task-owned server provenance v0 (research; plumbing only):** a keyed `endo.research.aa.task-owned-provenance.0` record,
  an approval-gated launch/stop lifecycle function for a loopback server the launcher owns, a real-observation continuation
  admission hook with per-turn sidecars bound to the request-body digest and dispatch marker, and an offline fresh-process
  reader that reports record validity, observed process consistency, declared trust assumptions, unavailable host facts and
  study admission separately. `OWNERSHIP_UNVERIFIED` is never upgraded. Tested with fake executables, Pi and endpoint only:
  no real server or inference, no operator command. See
  [research/governed-initial-continuation/aa/TASK-OWNED-PROVENANCE.md](research/governed-initial-continuation/aa/TASK-OWNED-PROVENANCE.md).
- **React Compare workspace (source builds and tested tarballs):** discover eligible Pi/DSH recordings, explicitly select
  A/B through opaque generation-bound selectors, load bounded candidate pages, and inspect authoritative per-layer verdicts,
  divergent entries, qualifications, ordering assessment and B-minus-A deltas. Unknown/malformed responses, invalid selections,
  cancellation, pacing and stale request completions fail closed. Observe state and its single initial snapshot request are
  preserved; navigation triggers no extra Observe read. Native keyboard controls, evidence disclosures and narrow layouts
  retain the Studio security and accessibility model. No new comparator, backend API or runtime control is added.
- **Merged Compare presentation and APIs (PRs #69 and #73):** `endo.cockpit-trajectory-comparison.v0`
  (`protocol/cockpit-comparison.ts`) and `projectEndoCockpitTrajectoryComparisonV0` preserve the existing comparator's
  `EXACT` / `DIVERGED` / `UNAVAILABLE` verdicts per layer, keep tool calls apart from tool results, avoid cross-layer
  divergence or event pairing, leave unavailable deltas unset, and withhold store paths and content-committing digests as
  keyed tokens. The projection is registered and served through guarded read-only comparison APIs. See
  [docs/cockpit.md](docs/cockpit.md#the-trajectory-comparison-presentation-implemented-and-served).
- **Merged Compare candidate discovery (PR #74):** a validated, bounded and paginated candidate presentation reports eligibility
  and supplies generation-bound opaque selectors for selected comparisons. Selectors become invalid when the verified
  store generation changes; candidate rows use privacy-safe display identities. The React Compare workspace consumes this contract.
  See [docs/cockpit.md](docs/cockpit.md#compare-candidate-discovery) and
  [docs/studio.md](docs/studio.md#compare-workspace).
- **Merged DSH study, importer and CLI (PRs #70–72):** the version-pinned native conformance study covers a fidelity matrix over
  all 62 persisted event types and five retained sanitised captures from DSH `dsh-v0.2.1-rc.2`. This is version-pinned
  evidence, not general-version conformance. `adapters/dsh-native/` reads one persisted Session format-4 directory into
  the event store with verified append-only re-import, keyed digests, qualified lifecycle/tool mapping, an
  `endo.trajectory.v1` projection and `endo.dsh-native-loss-accounting.v0`. PR #72 exposes this offline, read-only path as
  `endo dsh import` and `endo dsh loss-accounting`. It does not drive, resume, attach to or sync DSH;
  DSH tool requests do not establish execution, and DSH-written crash closers are not `lifecycle.interrupted`.
  See [docs/dsh-native-attachment.md](docs/dsh-native-attachment.md) and
  [docs/dsh-native-importer.md](docs/dsh-native-importer.md).
- These source-tree additions, along with the newer React Observe frontend, are absent from the npm registry artifacts
  for `endophasia@0.1.0-alpha.1` and `endophasia@0.1.0-alpha.2`; alpha.2 contains the earlier browser page.
- The Studio frontend: a React/TypeScript application bundled by `esbuild` into `dist/studio-ui/` (content-hashed files and a manifest
  that the host checks, file for file and byte for byte, before anything starts), served through the same hardened server. Its
  **Observe workspace** reads the one recorded snapshot and shows an overview of the recorded window, the runtime, the capability state
  with its limits, the timeline in storage order with an evidence-first inspector, and the condition of each source, each on its own;
  loading, empty, absent, degraded, unopenable, withheld, unsupported-version, failed and paced reads are each said differently, and a
  window is never presented as the whole log. It makes one read at open and one per explicit action, and polls nothing. Responsive, with a
  modal inspector below 1024 px that carries the source warnings with it. Capabilities and Evolve remain marked as unavailable and show nothing. See [docs/studio-ui-architecture.md](docs/studio-ui-architecture.md) and
  [docs/cockpit-ui.md](docs/cockpit-ui.md).
- `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (build-time only; their licence notices are packed in `dist/licenses/`).

### Changed
- Studio, Observe: a selection bar above the table with **Show in table** (reveals the open event's row in the table's own scroller, with no
  read) and, when filters hide the open event, **Clear filters that hide it** (clears only the filters that exclude it); the pager says why a
  move is not available; the inspector is a short invitation with the reference as collapsible sections (a closed *Reading guide* beside a
  selected event); long identifiers open in place and displayed identifiers can be copied; the left rail and right panel are more readable
  and the three-column layout starts at 1360 px.
- The licence is now the **Apache License 2.0** (it was MIT). `0.1.0-alpha.1` and `0.1.0-alpha.2` were published under MIT and remain available under it; the
  Apache License applies from this change onward.
- `endo studio` now serves the Studio frontend. The earlier page (`cockpit-ui/`, `dist/cockpit-ui/`) is retired in the same change, with
  its browser, source and model tests moved onto the new frontend and not dropped. The command's arguments, address line, exit codes
  and key handling are unchanged. `npm run cockpit` serves the same frontend; `build:cockpit-ui` is replaced by `build:studio-ui`.
- The page policy gains `font-src 'self'` and the server can serve `.woff2` files, so a bundled typeface can load; no remote or
  `data:` font is admitted.
- The host reads one kind of frontend and checks it against its manifest; names are held to the server's 64-character limit and sizes
  are checked before a file is read.

## 0.1.0-alpha.2

The **Studio alpha**. It adds a read-only browser interface, `endo studio`, to the operator alpha, together with the observation
bridge and local server beneath it. `0.1.0-alpha.1` does not contain Studio. Scope, evidence, limits and the publication procedure:
[docs/release-0.1.0-alpha.2.md](docs/release-0.1.0-alpha.2.md) in the repository.

### Added
- `endo studio [<root>] [--root dir] [--port n] [--key-file path]`: Endophasia Studio, a read-only browser interface over a recorded
  store, served by the installed package on `127.0.0.1` only behind a private per-launch address printed once. Today it shows one
  observation page: the recorded runtime identity and its changes, the capability states with their reasons and limits, the event
  timeline in storage order, and the condition and provenance of each source, with filtering, paging and an explicit refresh. It
  writes nothing to the store, starts and steers nothing, does not poll, and reads no private model reasoning. The page is built into
  the package (`dist/cockpit-ui/`), so no checkout, build step or network is needed. The first launch creates its own digest key
  (`cockpit-digest-key`, mode 0600, beside the installation key) and says so. Stop it with Ctrl-C (SIGINT) or SIGTERM: exit 0. Exit 1
  means it could not start; exit 2 an invalid invocation, which it refuses before creating or starting anything. See
  [docs/studio.md](docs/studio.md).
- The observation bridge (`cockpit/`): read-only contracts and deterministic projections over the recorded evidence, a library
  with no command of its own ([docs/cockpit.md](docs/cockpit.md)).
- The package smoke test (`npm run test:package`) can be pointed at an exact artifact, `--package <tarball|name@version>`, with
  `--expect-integrity <sha512>`, so the file an owner publishes is the file that was tested. It now also runs the installed Studio
  (page, assets, API, refusals, shutdown, a taken port, SIGKILL, the store unchanged), the installed `trajectory diff`, loads
  `replay` and `proxy`, packs twice to compare, and scans the installed files for private keys and builder paths.
  `ENDO_REQUIRE_BROWSER=1` makes a missing Chromium a failure; CI sets it.

### Changed
- **A log file that exists but cannot be read now raises an error** (`EndoLogUnreadableErrorV0`) instead of being read as empty. An
  inaccessible store was previously indistinguishable from a valid empty one (`0.1.0-alpha.1` printed `endo status` and `harness
  overview` for it as an empty store, exit 0), and a writer could append to a log it had never seen. Studio shows such a store as
  *unopenable*; the commands that read the event log (`endo status`, `harness overview`, ...) fail with "the log cannot be read
  (EACCES)" and exit 1. A log that does not exist is unchanged.
- The keyed-digest shape rules and the public fixture-key table moved to `protocol/keyed-digest-shape` so the bridge's validators
  can share them. The values are unchanged and both modules re-export them.
- `package.json` publishes under the `alpha` dist-tag by default (`publishConfig.tag`), so a prerelease cannot move `latest` by
  omission.
- CI: the `package` and `acceptance` jobs fail rather than skip when Chromium is missing, and a `package-floor` job builds, packs and
  installs on the lowest supported Node (22.19.0).

### Documentation
- The README is now an introduction (what Endophasia is, Studio, a quick start, what works today with the evidence behind each row,
  one architecture diagram, the research direction and an index). The long design and research material it carried moved,
  unchanged except for relative links, heading levels, a status banner and the corrections each page states (`docs/status.md` lists its own), to [docs/vision.md](docs/vision.md), [docs/attachment.md](docs/attachment.md),
  [docs/observe.md](docs/observe.md), [docs/evolve.md](docs/evolve.md), [docs/roadmap.md](docs/roadmap.md) and
  [research/epistemic-alignment-experiment.md](research/epistemic-alignment-experiment.md).
- Corrected: the install instructions no longer imply that the published `0.1.0-alpha.1` contains `endo studio`. It does not; the
  source tree carried the same version string until this version was prepared.

### Verified
- On the CI image (Ubuntu 24.04), as an installed npm tarball: the packaged CLI and Studio under plain Node with TypeScript stripping
  disabled, on the newest Node 22.x and on the 22.19.0 floor, against a fake Pi; the operator loop against a real Pi 1.0.0 with a
  local fake model endpoint (no provider, no credentials) on the newest Node 22.x; and the installed page loaded in Chromium over
  each recorded store.

### Not claimed
- Any Pi version other than 1.0.0, any other runtime (ACP agents, OMP, OpenClaw) or platform; behaviour against a live model
  provider; model-internal observation; any Studio mode other than the one observation page; live updates; forkable checkpoints. A
  full `endo replay` round trip from the installed package is covered from source only.

## [0.1.0-alpha.1](https://github.com/noctem-o/endophasia/releases/tag/v0.1.0-alpha.1) (released 2026-10-08)

The first alpha of Endophasia: an **experimental research instrument**, not a stable product. It attaches to a
user-installed agent harness (Pi) and records what it observes in a durable store. It does not install, upgrade or patch
Pi. See [docs/install.md](docs/install.md) and [docs/release-alpha.md](docs/release-alpha.md).

### Added
- A distributable `endo` CLI: compiled JavaScript, no runtime npm dependencies, `--help` and `--version`.
- `endo doctor [--root dir] [--pi path] [--attachment a] [--json]`: a read-only first-run diagnosis (Node, Pi
  discovery, store and key locations, recorded identity and capability evidence copied as recorded). It installs
  nothing, starts no session, calls no provider and writes nothing.
- A default store root (`ENDO_STORE_ROOT`, else `$XDG_DATA_HOME/endophasia/store`, else
  `~/.local/share/endophasia/store`), accepted as `--root dir`, the positional `<root>`, or neither by `status`,
  `events`, `ingest`, `ledger`, `artifacts`, `harness *`, `steer *` and `trajectory show`. `trajectory diff`, `replay`,
  `proxy` and `experiment` still take explicit stores.
- The installed Pi loop: `doctor` → `harness check` → `harness attach` → `harness status`/`overview` →
  `trajectory show`. `attach` reports whether Pi accepted a prompt and whether the run was seen to settle, the Pi
  session id as reported, and the next read-only commands.
- Acceptance from the installed tarball: against a fake Pi and fake model endpoint (CI `package`), and against a real
  Pi 1.0.0 with a fake model endpoint (CI `acceptance`). No credentials and no provider are involved.

### Verified
- Pi 1.0.0 (the verified baseline) on the CI image (Ubuntu, Node 22).

### Not claimed
- Any other Pi version, runtime or platform; stable multi-runtime support; behaviour against a live model provider
  (live studies need `--authorize-live-study` and may incur cost); model-internal observation; a cockpit.

### Changed
- `endo status`, `events`, `ledger`, `artifacts`, `harness *`, `steer *` and `trajectory show` use the default store
  when given no root. Naming the root twice is a usage error. A single argument to `trajectory show` is a session id.
