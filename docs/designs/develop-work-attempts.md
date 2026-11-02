# DEVELOP Slice E: work attempts and handoff briefs

*   **Status:** Implemented in this PR (Elephant draft, three Goldfish reviews, resolution, one intermediate Goldfish review; see [Review](#review))
*   **Date:** 2026-11-02
*   **Scope:** one bounded slice. No coordinator, no dispatch, no agent launch, no verification.

## The problem

An operator writes a task (`endo.task.<id>`, [develop-tasks.md](../develop-tasks.md)) and then asks a coding agent to work on it: Pi in the
paired workbench, or Claude Code, Codex or OMP in a terminal. Two things are missing today:

1. **A brief.** The operator retypes the task into every agent. Nothing renders the task, the operator's objective for this try and its
   limits as one block of text that can be pasted into any of them.
2. **Attribution.** Nothing names *this try*. A later reviewer (a person, or a future verification step) cannot say "the result in front of
   me answers brief X, prepared on revision n of task T, with these exclusions". For Pi and OMP the session transcript holds what was
   typed, but not which of the operator's tries it was or what the operator wanted checked. For Claude Code and Codex Endophasia has no session
   source at all.

The task's status history is the operator's verdict on the *task*; its session references say *which sessions relate to the task*. Neither
says what one try was asked to do.

## Terms

| | What it is | What it is not |
| :-- | :-- | :-- |
| **Task** | What the operator wants done; the only source of truth for status. Unchanged by this slice. | A prompt. |
| **Attempt** | One operator-prepared request on one task: an id, the task's words as they were then, an objective, constraints, what to report back, and later at most one handoff note and one outcome note, both written by the operator. | A process, a session, a lease, a schedule, an approval or a result. |
| **Brief** | Text rendered from the attempt alone, for the operator to copy into an agent. | A dispatch. Rendering, showing or copying it sends nothing. |

## Requirements

1. An attempt belongs to exactly one project and task, both checked against `tasks.json` when it is prepared.
2. Preparing, reading or copying a brief makes no model call, starts no process, and writes nothing outside `develop/attempts/`.
3. No attempt operation writes `develop/tasks.json`. Task status, revision and history are untouched, and a test compares the file's bytes.
4. Everything after preparation is **operator-declared**, and the record says so (`recordedBy: "operator"`, `via: "cli"`). Nothing is
   inferred from a session ending, a message or the word READY. Endophasia never reads an agent's reply.
5. The `endo.develop-tasks.v0` and `.v1` contracts, their validators and the task store's code are not changed.
6. `endo studio` (unpaired) gets no route to attempts. The paired workbench gets one GET route behind the existing grant. The browser gets
   no write action and no way to send the brief to an agent.

## Persistence: write-once files, one directory

`<root>/develop/attempts/`, owner-only (`0700`), beside `tasks.json`. Each attempt is up to three small files, **each written once and
never rewritten**:

| File | Written by | Holds |
| :-- | :-- | :-- |
| `<id>.prepared.json` | `endo attempt prepare` | The attempt: ids, the task's words, objective, constraints, report-back request (`endo.develop-attempt.v0`) |
| `<id>.handoff.json` | `endo attempt handoff` | The operator's note that they handed it over, and to what (`endo.develop-attempt-handoff.v0`) |
| `<id>.outcome.json` | `endo attempt report` or `abandon` | The operator's note of what was reported, or that they stopped (`endo.develop-attempt-outcome.v0`) |

Each file is written the way the task store creates its lock files (not its data file, which is renamed): a uniquely named temporary file
(`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`), written whole, `fsync`ed, then **hard-linked** to its final name, the temporary name removed and the
directory `fsync`ed. `link` refuses an existing name, so:

- **Concurrent writers** cannot both record a handoff, or both record an outcome. The second is refused `already-recorded`, and the first
  stays as written. No lock is needed, and nothing is merged.
- **A crash** leaves the file whole or absent, never partial. A crash's temporary file (`.tmp-<pid>-<hex>`, older than a minute) is
  removed by the next writer.
- **Nothing is ever rewritten**, so a reader never sees a half-replaced record. A malformed, oversize, symbolic-link, non-regular,
  misnamed or unknown-version file is reported as a problem by name (never by content) and left as found. The link count is not checked:
  between `link` and the removal of the temporary name every record briefly has two names.
- **When `link` finds the name taken**, the existing file is read with the same checks. Only a valid record of that kind is
  `already-recorded`; anything else there (a directory, a link, a bad file) is `unreadable`. A temporary file that disappeared (a writer
  stalled for over a minute and the sweep removed it) is a failure to retry, never a success.
- A record whose contents are durable may be visible to a reader a moment before its directory entry is: a crash in that moment can
  remove a record a reader has already shown. Its writer had not yet reported success.

**Why not the obvious alternatives.**

- *A tasks-file v2* needs an operator upgrade and a third task-file validator for a feature that changes nothing about tasks. Builds from
  before it would refuse the whole task file afterwards.
- *One `attempts.json` rewritten whole* (the first draft) needs the task store's lock. That lock is intricate (a numbered-file protocol), so
  it would have to be extracted into a shared module. All three reviewers named that extraction as the riskiest step. A single file also
  hits the 4 MiB cap at about 70 attempts, with no way to remove one.

Write-once files need neither: no lock, no extraction, no rewrite, no change to the task store.

**Stale state.** A handoff or outcome needs no revision, because it never replaces anything. "Recorded against an old view" can only mean
"someone recorded it first", and that is refused `already-recorded`, with the existing record shown. `--revision` does not exist for attempt
commands. The preparation records the task revision it was prepared on.

**Removal and limits.** At most 500 attempts in the directory, and 50 per task, checked when preparing, without a lock (two prepares at
once can pass a cap by one each; the caps bound growth and are not a security boundary; a read never refuses because of them). Each
`prepared` file is at most 80 KiB; handoff and outcome files are at most 16 KiB. When a limit is reached, `prepare` is refused `limit`, and the message names the remedy. **Removing an attempt is
deleting its files** (`develop/attempts/<id>.*`). That is the operator's act, documented, and it touches nothing else. There is no delete
command in this slice.

**Referential integrity.** A handoff or outcome is refused unless a valid prepared record exists. `prepare` reads `tasks.json` through the existing store (a lock-free read of an atomically renamed file, so one
whole revision), requires the task to be in the project, and copies the task's words. Tasks are never deleted (there is no command), so a
task can vanish only if `tasks.json` is removed, replaced or unreadable. Then attempts still list and their briefs still render, because a
brief needs only its own file, and they are shown as *task unavailable*. When `tasks.json` is readable, an attempt whose `taskId` is not in
its `projectId` there is shown as *task not found in this project*, never under another task.

## The records

```ts
// <id>.prepared.json: immutable
interface EndoDevelopAttemptV0 {
	schemaVersion: "endo.develop-attempt.v0";
	id: string;                       // endo.attempt.<32 hex>, random; also the file name's stem
	projectId: string; taskId: string;
	preparedAtMs: number;
	task: { revision: number; projectName: string; title: string; description: string; acceptance: string };  // copied from tasks.json at preparation
	objective: string;                // operator; "text" rule, must not be blank
	constraints: string;              // operator; "text" rule, may be ""
	reportBack: string;               // operator; "text" rule, may be "" (the brief then states a fixed default)
	brief: "endo.develop-brief.v0";   // the renderer version this attempt is shown with
	recordedBy: "operator"; via: "cli";
}
// <id>.handoff.json
interface EndoDevelopAttemptHandoffV0 {
	schemaVersion: "endo.develop-attempt-handoff.v0"; attemptId: string;
	recordedAtMs: number;             // when the operator RECORDED it, not when they pasted
	target: string;                   // a short label the operator chose ("Claude Code"); "name" rule; never interpreted
	note: string | null;              // "note" rule
	recordedBy: "operator"; via: "cli";
}
// <id>.outcome.json
interface EndoDevelopAttemptOutcomeV0 {
	schemaVersion: "endo.develop-attempt-outcome.v0"; attemptId: string;
	recordedAtMs: number;
	kind: "reported" | "abandoned";
	note: string;                     // reported: what the agent or the operator reported ("text" rule, not blank); abandoned: optional reason ("note" rule, may be "")
	recordedBy: "operator"; via: "cli";
}
```

All three use closed validators (unknown keys refused) built on the task protocol's text rules. `checkEndoDevelopTextV0` is used as is,
and the non-blank checks are added in the new module. A handoff or outcome whose `attemptId` does not match its file name is invalid.

**State is derived, not stored.** `prepared` (only the first file exists), `handed-off` (there is a handoff), `reported` or `abandoned`
(there is an outcome, whether or not a handoff was recorded). A handoff can be recorded after an outcome: the operator may record facts in
any order. Each record carries its own `recordedAtMs`. Labels, everywhere they are shown:

| State | Label | It means | It does not mean |
| :-- | :-- | :-- | :-- |
| prepared | **Prepared** | A brief exists. | Anyone has seen it. |
| handed-off | **Handoff recorded** (by you, to *target*) | You said you gave it to *target*. | The agent read or followed it. |
| reported | **Result reported, not verified** | You recorded what was reported. | It is true. Nothing was checked. |
| abandoned | **Abandoned** | You stopped without claiming success. | Failure was shown. |

There is no "done" state, no claim enum, and nothing that moves the task. **Retrying is preparing another attempt.**

**Staleness.** When `tasks.json` is readable and the task's title, description or acceptance differ from the attempt's copy, the view names
the fields that changed ("acceptance changed since this brief was prepared"). A revision change caused only by status or session links is
not reported, because the words did not change.

## The brief

`renderEndoDevelopBriefV0(attempt)` in `protocol/develop-attempts.ts`: a pure function of the prepared record alone. The CLI prints it, and
the route serves its output as text, so both show the same bytes always, including when `tasks.json` is unavailable.

````text
# Work brief endo.attempt.<id>

Prepared by the operator in Endophasia on <ISO date-time, UTC>, for endo.task.<id> (revision <n>).
This brief is the operator's request. It is not an approval: it grants no tools, permissions or access. Endophasia does not read your
reply; the operator records the outcome. The text of each section below is the operator's, quoted exactly.

## Task and project
```text
<title>
<project name>
```

## Objective
```text
<objective>
```

## Task description
(empty)            <- an empty field is said outside any fence

## Acceptance criteria
```text
<acceptance>
```

## Constraints and exclusions
```text
<constraints>
```

## What to report back
```text
<reportBack, or the default: "Tell the operator what you changed (files, commits), what you ran to check it and what it printed, and what
is left undone. The operator checks your report separately; it is not taken as verification.">
```

End of brief endo.attempt.<id>.
````

Each field's fence is longer than the longest run of backticks inside that field (at least three), so in a Markdown rendering operator text
cannot close its fence. That protects **rendering only**: a model reads the words whatever the fences say, and a field that contains
"## Constraints and exclusions" still reads like one to it. What tells the agent whose words these are is the provenance paragraph at the
top. Text is otherwise verbatim: no escaping, no truncation, no rewriting. The title and project name are fenced too, so a title cannot
forge the provenance line. There is no provider-specific wording, hidden text, credential or execution claim.
The renderer version is recorded in the attempt, so a later renderer cannot silently change an old attempt's brief.

## Operator workflow

```sh
endo attempt prepare --root R --project P --task T --objective "…" [--constraints "…"] [--report-back "…"]
#   or --objective-file F / --constraints-file F / --report-back-file F (a regular file, not a link, at most 16 KiB, UTF-8)
#   prints the attempt (JSON) on stdout and the brief's command on stderr
endo attempt brief   --root R --attempt A        # the brief, as plain text on stdout, nothing else
# …paste it into Pi, Claude Code, Codex or OMP yourself…
endo attempt handoff --root R --attempt A --to "Claude Code" [--note "…"]
endo attempt report  --root R --attempt A --note "what was reported"
endo attempt abandon --root R --attempt A [--note "…"]
endo attempt list    --root R --project P [--task T]     # id, task, state, times, objective's first line, staleness
endo attempt show    --root R --attempt A                # the records, the derived state, staleness
```

**In the paired workbench**, the Task view gets an **Attempts** section for the selected task. Each attempt shows its short id, state label,
time, the first line of its objective, the target if one was recorded, and any staleness notice. Opening one (a native
disclosure) shows the brief in a read-only text box, which is focusable and scrolls inside itself, so select-all takes exactly the brief,
with **Copy brief**. Copying writes to the clipboard and nothing else. The composer's unsent text is not touched, and focus stays on the
button. Where the clipboard API is unavailable, the button is not drawn and the box can still be selected. Recording stays in the CLI
this slice, and the section shows the commands with the attempt id and a `--root <store>` placeholder, never the store's path.

## Service, routes, page

- `protocol/develop-attempts.ts`: the three record types, limits, closed validators, the derived state, the brief renderer, and the view
  type `endo.develop-attempts-view.v0`:
  `{ schemaVersion, taskId: string | null, state: "ready" | "no-task" | "unreadable", attempts: AttemptViewV0[] }`. An `AttemptViewV0` has the
  id, state, timestamps, target, notes, objective, `taskWordsChanged: ("title" | "description" | "acceptance")[]`, `taskFound`, and `brief`
  (the rendered text). It carries no session ids, paths or scope digests, because attempts carry none.
- `storage/develop-attempts.ts`: `DevelopAttemptsStoreV0(root, { now?, beforeLink? })` with `read()` (every file, with closed per-file
  problems), `prepare(record)`, `recordHandoff(id, …)`, `recordOutcome(id, …)`. It reuses `writeExactSyncV0` (`storage/log.ts`), and
  nothing of the task store's internals.
- `runtime/contracts/develop-attempts.ts`: `DevelopAttemptsServiceV0(tasks: DevelopTasksStoreV0, attempts: DevelopAttemptsStoreV0)`.
  Operator operations (`prepare`, `handoff`, `report`, `abandon`, `list`, `get`) and `viewFor(projectId)`. The view is for the project's
  **selected** task, chosen from `tasks.json`, never from the request.
- `runtime/contracts/develop-workspace.ts`: `forLaunch(config, host)` is unchanged. The launch scope gains `attemptsView()`, available only
  when the service was constructed with `{ attempts: DevelopAttemptsStoreV0 }`. Otherwise it returns `null`, and the route answers 404.
  Construction sites: `cli/workbench.ts` (the workbench) passes the attempts store. The CLI uses the attempts service directly.
- `adapters/pi/workbench-tasks.ts`: `GET workspace/attempts` with no query and no body (a query is 400, other methods and sub-paths 404).
  It is reached only after the broker's grant check, as every `workspace` route is. A workbench without `--project` answers 404 as today,
  and the page asks only when its workspace view is `ready`, so it never logs a failed request.
- `studio-ui/src/api.ts` gets `fetchAttempts`. A new hook, `studio-ui/src/use-attempts.ts`, composed into `useWorkspace`
  (so nothing is threaded through the components), reads after each good workspace read: the first, the operator's Refresh, and each change
  they make. It uses no timer, runs one read at a time, and is the only caller of `fetchAttempts`. When the page holds a different task
  from the one selected in the file (a read-only launch cannot change the selection), the section says so rather than showing another
  task's attempts. Also new: `model/attempts-wire.ts` (a closed gate that imports the protocol by type only) and `develop/Attempts.tsx`
  (drawn by `Tasks.tsx`, with no `fetch`). When the grant is revoked the section keeps its last-read list, marked like the tasks.
  `tests/endo-studio-ui-source.test.ts`'s file list and pins are updated.
- `cli/develop-attempts.ts` (`ATTEMPT_COMMANDS_V0`, reusing the task commands' exported flag reader), `cli/index.ts` (the `attempt`
  family), `cli/help.ts` (the usage line and a section).

## Authority, unchanged

No new capability, write route or grant. PROMPT, STEER, QUEUE, STOP and the terminal approval are untouched. Endophasia never passes the
brief to a harness. `endo studio` has no workspace routes, and a canary in an attempt is checked against its read routes. A forged request
cannot name a project, task or attempt: the route takes none.

## Risks

- **Copied text leaves the store.** A brief contains private task text, and clipboard managers may keep it. The docs say so.
- **Operators may not record handoffs or outcomes.** That is acceptable. A `prepared` attempt still gives the brief an id, and an
  unrecorded outcome is shown as exactly that.
- **Removing files by hand** can leave a handoff or outcome without its `prepared` file. Such files are listed as problems and never shown as
  attempts.

## Not in this slice

Browser prepare or record actions; a session pointer from an attempt to a task's session reference (the task's own references remain the
place for that); verification records; links to commits or PRs; a delete command; retries, watchdogs, schedulers; a coordinator.

## Phases

1. Protocol, store and their tests. 2. Service, CLI, help and tests. 3. Launch-scope view, route, `cli/workbench.ts` wiring and tests.
4. Page: wire gate, hook, section, source pins, browser tests. 5. Docs, changelog, independent implementation review.

## Testing

**Store:** prepare/read; a restart (a new store object) reads the same meaning; closed validation (unknown version, unknown key, oversize,
control characters, a blank objective, an `attemptId`/file-name mismatch); concurrent handoffs or outcomes from several processes (exactly
one wins, the rest `already-recorded`); a crash before the link (`beforeLink` throws: no record, and the leftover temporary is swept later);
symlinked directory, file and temporary names refused; limits refused as `limit`.

**Service:** the task must be in the project; the words are copied; `tasks.json`'s bytes are identical after every attempt operation, on v0
and v1 files; staleness names changed words only; task unavailable; task in another project.

**Brief:** every field verbatim; fences cannot be closed from inside a field; identical from the CLI and the route; pure (same record, same
bytes).

**Authority:** prepare and brief start no process (a fake `pi`/`omp` first on `PATH` is never run); grant required; query, POST and
sub-paths refused; another project's attempts are never served; a Studio canary.

**Browser:** the wire gate refuses malformed views; Copy keeps the composer draft and focus; staleness and "not verified" labels shown;
layout at 1440 and 390 px.

**Regression:** existing suites unchanged.

## Manual smoke test

In a disposable store, never your real one, and with no agent or model needed:

```sh
S=$(mktemp -d) && mkdir "$S/proj"
P=$(endo project add --root "$S/store" --name Demo --path "$S/proj" | jq -r .project.id)
T=$(endo task add --root "$S/store" --project "$P" --title "Fix parser" --acceptance "npm test passes" | jq -r .task.id)
sha256sum "$S/store/develop/tasks.json"                      # note it
A=$(endo attempt prepare --root "$S/store" --project "$P" --task "$T" --objective "Accept trailing commas" \
      --constraints "Do not touch the lexer" | jq -r .attempt.id)
endo attempt brief --root "$S/store" --attempt "$A"          # the brief; paste it into an agent of your choice, or don't
endo attempt handoff --root "$S/store" --attempt "$A" --to "Claude Code"
endo attempt handoff --root "$S/store" --attempt "$A" --to "Codex"     # refused: already recorded
endo attempt report --root "$S/store" --attempt "$A" --note "agent says tests pass"
endo attempt list --root "$S/store" --project "$P"           # "Result reported, not verified"; task status still open
sha256sum "$S/store/develop/tasks.json"                      # unchanged
```

For the page, start a workbench for that project (`endo harness attach --root "$S/store" --cwd "$S/proj" --control --workbench --project
"$P"`), pair, open **Task**. The attempt is listed with its brief and **Copy brief**. Type a draft in the composer, copy the brief, and
check that the draft is unchanged and nothing was proposed. Then `rm -r "$S"`.

## Review

The design review followed the Elephant–Goldfish Model (github.com/google/elephant-goldfish-model), but **the EGM plugin was not
installed** in this Claude Code environment, and installing one would have changed agent settings. Its upstream reviewer personas and
rubrics (`agents/zoom_out.md`, `design_critic.md`, `implementation_readiness.md`, with their `resources/document_standards/`) were fetched,
and three fresh-context subagents (Claude Code `Agent`, general-purpose, no conversation history) each read one persona, its rubric, this
draft and the source it cites. They ran in parallel, not through EGM's sequential five-stage synthesizer pipeline. There was no separate
Comprehension stage. The intermediate zoom-out was one more fresh reviewer, of the resolved design.

| Finding (reviewer) | Disposition |
| :-- | :-- |
| An attempt record is unproven; ship a stateless `endo task brief` (zoom-out) | **Partly accepted.** The record is cut to what attribution needs: no session pointer, no claim enum, no state machine to drive, and recording is optional. It is kept because the brief needs a stable identity that a later review can cite, and only a record gives one. |
| `evidence` and `claims-done` imply evidence that does not exist (zoom-out, critic) | **Fixed.** The field is now `reportBack` ("What to report back"), the outcome is a note, and the label is "Result reported, not verified". |
| The 200-attempt cap fills permanently; a full single file overflows 4 MiB at about 70 attempts (all three) | **Fixed by the storage change.** Small per-attempt files, removable by deleting them, with a 500-attempt cap. |
| Extracting the task store's lock is the riskiest step (all three) | **Removed.** Write-once files need no lock, and the task store is not touched. |
| Staleness by revision fires on every status move (critic) | **Fixed.** Changed words are compared and named. |
| The brief needs the project name when `tasks.json` is unavailable (critic) | **Fixed.** The name is copied, and the brief is a function of the record alone. |
| Operator text can forge the brief's sections (critic) | **Fixed.** Each field gets a fence longer than any backtick run in it, and the provenance paragraph comes first. |
| The session pointer's relation is underspecified and could show a removed reference as current (critic) | **Removed from the slice.** Deferred. |
| `recordedBy`/`via` missing (zoom-out, critic) | **Fixed** on every record. |
| `handoff.atMs` reads as when it happened; `prepared → reported` impossible (critic) | **Fixed.** `recordedAtMs`, and records may come in any order. |
| The view returns every attempt and its brief for the whole project (critic) | **Fixed.** Only the selected task's attempts are returned. |
| Clipboard needs a secure context; managers may keep copies (critic, readiness) | **Accepted.** A read-only text box that can be selected without the clipboard API, and a warning on the page and in the docs. |
| Hand-edited files could show one task's text under another (critic) | **Fixed.** Cross-checked against `tasks.json`, and shown as not found. |
| `cli/workbench.ts` construction site, view type, page data flow, UI file-list pin, no-project 404, CLI tables, phases missing (readiness) | **Fixed** in the sections above. |
| "Quote the id when you report" invites future parsing of agent output (zoom-out) | **Fixed.** The brief says Endophasia does not read the reply. |
| One-click Copy beside the Pi composer is one paste from sending (zoom-out) | **Accepted risk.** Copy does not touch the composer. Sending stays the operator's act under the existing approval. |
| *Intermediate review:* "linked" must mean symlink; an nlink check would refuse valid records mid-write | **Fixed.** Symlinks and non-regular files are refused; the link count is not checked. |
| *Intermediate:* EEXIST is not proof of an existing record; ENOENT at `link` after a stalled writer's sweep | **Fixed.** The existing name is read and validated; a missing temporary file is a failure. |
| *Intermediate:* caps are lock-free and soft; handoff needs a valid prepared record; visibility before the directory `fsync` | **Fixed** (stated and implemented). |
| *Intermediate:* fences do not stop a model reading a forged heading; an inline title can forge the provenance line; `(none)` is ambiguous | **Fixed.** The claim is limited to rendering, the title and name are fenced, and an empty field is `(empty)` outside a fence. |
| *Intermediate:* the default report-back asks for something that looks like verification | **Fixed.** The default says the report is checked separately and is not verification. |
| *Intermediate:* the page's commands would leak the store path | **Fixed.** A placeholder is shown. |
| *Intermediate:* ship CLI-only and defer the page | **Declined.** The slice asked for a minimal read-only paired view. It is GET-only, behind the grant, scoped to the selected task, and Copy does not touch the composer. |
| *Intermediate:* fold `abandon` into `report`; store the brief's bytes instead of a renderer version | **Declined.** Separate verbs keep "reported" and "abandoned" distinct at the prompt. Storing the bytes would double each record, so the v0 renderer is kept and pinned by a golden test. |
