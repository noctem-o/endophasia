# DEVELOP: one attempt's evidence, read in one place (WORK-CYCLE-001B)

*   **Status:** Implemented in this PR (read-only; one fresh-context review, see [Review](#review))
*   **Date:** 2026-11-07
*   **Scope:** one read-only CLI reading, `endo attempt evidence`. No new record, no new event, no schema change to any stored file, no
    change to the page, no approval path.

## The question

> Can Endophasia identify the artifact revision associated with a governed work attempt, determine whether its verification evidence
> still applies, and present those facts without inventing authorship, correctness or authority?

**The answer is "partly", and the reading says which part.**

- Endophasia **can** say whether the attempt was authorised and sent, what Pi reported, which checks it observed at which commits,
  whether each still applies to a working tree now, and what the operator decided.
- It **cannot** identify the revision the attempt produced. No record names one, and this slice deliberately does not add one (see
  [the decision](#decision-the-three-approaches)). The reading reports "no record names a candidate", plus the commits the operator
  checked.

## Three kinds of statement

Every section of the reading names its source. The categories are never merged.

| | Statement | Where it comes from | Section |
| :-- | :-- | :-- | :-- |
| **A. Operator declarations** | This attempt was prepared, with these words | the attempt record (`endo attempt prepare`) | `attempt` (`source: "operator"`) |
| | I handed it over / it was reported / I stopped | `<id>.handoff.json`, `<id>.outcome.json` | `attempt.handoff`, `attempt.outcome` |
| | This check belongs to this attempt | the `--attempt` the operator gave to `endo attempt check` (`attempt-link-is-operator-declared`) | `candidate.checkedCommits` |
| | The task is in review / done, with this note | the task's status history | `operator` (`source: "operator"`) |
| **B. Endophasia observations** | This exact attempt was authorised on the workbench terminal and the send was recorded | `<id>.authorized.json`, joined exactly to the session log (`develop-attempt-execution.ts`) | `sent` (`source: "observed"`) |
| | The send state, as the broker recorded it (including Pi's acknowledgement) | the session log | `sent.send` |
| | Pi reported the run ended thus | the session log (Pi's own lifecycle events) | `pi` (`source: "pi-report"`): what Pi *reported* |
| | Git showed commit C, clean, at the start and end of a check, and the command exited with E | a receipt; its link to this attempt is the operator's | `checks.latest[]` (`linkedBy: "operator"`) |
| | The working tree's HEAD is now C', clean or not; each receipt's relation to it | read-only Git, observed once for this reading | `checks.current`, `relation` |
| | A check ended before, overlapped, or started after the authorisation | stamps Endophasia wrote on this machine | `authorization` |
| **C. Not established** | which revision the attempt produced; who wrote any byte; that nothing else wrote the tree; that a pass meets the acceptance criteria; that Pi's report is true; which revision the operator looked at when deciding; that each record was written only by its named writer | nothing | `notEstablished` (always shown) |

## What `endo attempt evidence` shows

```
endo attempt evidence [--root dir] --attempt <id> [--cwd <dir>]
```

It prints canonical JSON (`endo.develop-attempt-evidence.v2`; v1 added the [damaged-record states](#damaged-records-evidence-integrity-001), v2 the verification plan and its ledger, [develop-verification-plans.md](develop-verification-plans.md)) on stdout and a short labelled summary on stderr. It always exits 0
when the attempt exists. It reads, in one process:

- the attempt and its records (`DevelopAttemptsServiceV0.get`, which already includes the execution reading);
- the attempt's receipts, each related to `--cwd` (default: the project's registered path), exactly as `endo attempt receipts` does;
- the task's status and history from the task file.

| Field | Meaning | Does not mean |
| :-- | :-- | :-- |
| `sent.authorizationRecord` | `recorded` (valid), `absent` (no file at its name, in an attempts directory read whole) or `damaged` (a file at exactly its name is not a usable record) | for `damaged`: anything about whether the send was authorised |
| `sent.send` / `sendLabel` | the execution reading's send state (Slice I/J), unchanged | that Pi did anything useful |
| `pi.run` / `runLabel` | the first run of the same Pi process after the send, as Pi reported it (`source: "none"` when nothing was authorised) | that the work is correct, or done |
| `candidate.recorded: false` | always: no record names a candidate revision | that there is none |
| `candidate.checkedCommits` | the distinct commits the operator ran checks at for this attempt, oldest first | what the attempt produced |
| `checks.latest[]` | the latest receipt of each distinct check (one argv in one working tree of one repository). One at the current HEAD outranks any later one at another commit (`endoLatestChecksV0`, shared with the attention overview) | acceptance |
| `relation` | `at-head`, `at-head-changed`, `head-differs` (stale), `other-worktree`, `other-repository`, `unavailable`: the receipt contract's, computed now, never stored | that a pass in another clone stands for this one |
| `authorization` | by the records' own clocks: `before` (the check ended before the authorisation: a baseline), `overlapping`, `after`; null when nothing was authorised | anything about who changed what |
| `operator.status`, `history`, `movedToDone` | the task's status now, its moves, and the note of the last move to `done` | which revision was looked at; who moved it (no actor is recorded) |
| `gaps[]` | facts about missing, unconfirmed, stale or undecided evidence, in a fixed order (below) | a verdict |

### Gaps

| Code | When |
| :-- | :-- |
| `authorization-record-damaged` | a file at this attempt's authorisation record's name is not usable: whether it was authorised is unknown, and nothing in the log is attributed |
| `not-authorized` | no file at the authorisation record's name, in a directory read whole: never sent through the workbench |
| `execution-evidence-incomplete` | the session log was `partial` or `unavailable` |
| `send-not-confirmed` | the send state is anything but `runtime-accepted` |
| `run-not-completed` | the run state is anything but `completed` |
| `brief-changed-since-authorization` | the brief's digest no longer matches the approved one |
| `task-words-changed` | the task's words changed since preparation |
| `operator-statement-damaged` | a file at this attempt's handoff or outcome name is not usable: that statement cannot be read, and is not shown as absent |
| `receipts-unreadable` | the receipts directory could not be read |
| `receipt-files-unusable` | some files in it are not usable receipts (damaged, unreadable): what they recorded, perhaps a failure, is not shown |
| `no-check` | no receipt |
| `no-check-after-authorization` | the send was authorised and every receipt ended before it |
| `current-tree-unavailable` | the working tree could not be observed now |
| `current-tree-changed` | it has uncommitted changes now |
| `no-check-at-current-head` | no receipt at the current HEAD of the same working tree |
| `check-not-passed-at-current-head` | a latest check at the current HEAD failed or was inconclusive |
| `stale-check` | for at least one command, the latest check is at another commit (`head-differs`): that command has not been run at the current HEAD, even if another one has |
| `checked-in-another-tree` | some receipt is from another working tree or repository |
| `task-unavailable` | the task cannot be read now |
| `not-accepted` | the task's status is not `done` |

None of them changes anything. A task can be `done` with gaps left, or have none and not be done. The reading shows both and corrects
neither: the decision is the operator's.

## Decision: the three approaches

| | 1. Read-only projection (**chosen**) | 2. Operator-declared candidate record | 3. Before/after Git observations around the execution |
| :-- | :-- | :-- | :-- |
| What it proves | Exactly what the existing records already prove, read together: authorisation and send, Pi's report, the receipts and their relation to HEAD now, the operator's moves | That the operator, at a time, named commit C as the candidate for attempt X | Git's HEAD, tree and dirty set at the dispatch and at the run's end |
| What it does not prove | A candidate; authorship; acceptance | That C came from the attempt; authorship. It restates what a receipt's `--attempt` link already declares | Authorship: another writer (the operator's editor, a second agent, a hook) can change the tree in the same interval. A file changed and restored between the two observations is invisible |
| Storage or schema | none | a new write-once file per attempt (`<id>.candidate.json`), its validator, its reader on every view, a CLI and page path | new fields on the authorisation record (immutable, so a v1 schema) or new event kinds; the broker must observe Git at dispatch and at the run's end |
| Reproducibility, independent recovery | any later process recomputes it from the store and Git | as for any record | the observations are taken once and cannot be repeated |
| Concurrent writers, TOCTOU | it reads several files at slightly different moments; the HEAD observation is one read; nothing it shows is acted on | the declared commit and the tree that was reviewed can differ (the operator declares C, then commits again). The receipt already binds what was checked to an exact commit | the run-end observation races the next write; "the run ended" is Pi's report, so the second observation may come before Pi's last write lands |
| Stale evidence | the receipt contract's relation, computed on every read | a declared candidate goes stale exactly like a receipt; it needs the same relation logic | the "after" observation is stale as soon as anything commits |
| Other harnesses | harness-neutral: only the execution section is Pi-specific, and it is null for any attempt not sent through the workbench | neutral | needs each harness's broker to observe Git at its own dispatch and end points |
| Improves the operator's decision? | yes: one reading answers what three commands and a 300-line study driver had to assemble (WORK-CYCLE-001A), and lists what is missing | marginally: "which commit am I accepting?" is answered more strongly by checking at the commit, which is what a receipt records | some: "the tree changed during the run" is a useful warning, but it is easily read as authorship |

**Chosen: 1.** It answers every question the operator asked in WORK-CYCLE-001B except "which revision did the attempt produce", and
it says so, rather than half-answering. It adds no authority, no record and no migration.

**Not chosen now:**
- **2** duplicates the receipt's operator-declared link. It should wait until a real review shows an operator needs to name a
  candidate before checking it.
- **3** is the only approach that adds new *observations*. Its value, "the tree changed between dispatch and run end", is real. It
  belongs in a slice that designs the broker's observation points and the wording that keeps it from being read as authorship. It is
  listed for REVIEW-PILOT-001.

**Rejected:** writing an inferred candidate (the latest passing commit, or the HEAD after the run) into any record. The unit tests
check that the reading's `candidate` has exactly its four members, so an inferred one cannot be added unnoticed.

## Guarantees and limits

- **Read-only.** It calls `read()` and Git observation only. It writes, stores and runs nothing. It adds no file under the store.
- **No private model content.** It prints what the existing readers already print: the attempt's objective line, the operator's
  handoff label and recorded report note (often text pasted from an agent, and the operator's own record), status notes, argv, the
  session id and the compared directory's path. It never prints a prompt, a reply, a tool argument or a result.
- **Not one snapshot.** The records are read one after another, not under a lock: the attempt (with one task-file read for its words),
  the receipts, then the task file again for the status. A check or status move that lands mid-read can be absent or present.
  `readAtMs` is when the reading began. A task file that cannot be read leaves the project path unknown, so the tree is reported
  `unavailable` without Git being asked.
- **Clocks.** `authorization` compares wall-clock stamps from the same machine. A clock step between them can mislabel a check. It orders
  records; it never attributes a change.
- **Not on the page.** The workbench's attempts view already shows each attempt's execution and receipts with their relations. This
  reading is the terminal's equivalent plus the gap list. No second page view was added.

## Damaged records (EVIDENCE-INTEGRITY-001)

In v0, a damaged `<id>.authorized.json` read as no authorisation at all. The store reported it as a problem, the attempts service dropped the
problem, and the reader showed `not-authorized`: a lost record became a categorical claim that the operator never approved. v1 keeps
three states apart, and the CLI's JSON, its text and its gap list agree on them:

| State | When | Reading |
| :-- | :-- | :-- |
| known absent | the attempts directory was read whole and has no file at `<id>.authorized.json` | `authorizationRecord: "absent"`, gap `not-authorized`, `sent [observed] No send … was authorised` |
| observed present | a valid record at that name, whose `attemptId` is this attempt's | `recorded`; joined to the session log by exact ids, as before |
| damaged | a file at exactly that name is malformed, invalid, misnamed (another attempt's record), over its bound, a link, a directory, a FIFO, or unreadable; or this attempt's record is found misnamed under another attempt's name | `damaged`, with the store's reason (never the contents); gap `authorization-record-damaged`; `sent [unknown] …`; `pi.source: "unknown"`; no send, run or Pi report attributed |
| unknown, no reading | the attempts directory itself cannot be read | the command refuses (`unreadable`); nothing is claimed |

- **Exact names only, plus a record's own claim.**
  - A damaged file of another attempt, or a stray file merely named like this one's (`….authorized.json.bak`,
    `<id>.x.authorized.json`), is not this attempt's record.
  - A *misnamed* file is different: a valid record whose `attemptId` differs from its file name's. The store now carries the attempt it
    `claims`, and the file counts as damaged for that attempt too. So this attempt's valid authorisation, found under another attempt's
    name, makes both read `damaged`, and the broker refuses to send either one again.
  - One rule (`endoAttemptProblemsOfV0`) is shared by `get`, `handoff`/`report`/`abandon` and the broker's check. Each refuses
    `unreadable`, never `not-found`, when a file at the attempt's names is unusable.
- **Surviving events are counted, not joined.** The log's events do not name an attempt: they carry a keyed digest of the message. Without
  the record there is no exact join. So, for a damaged record and a log read whole, the reading gives `unattributedWorkbenchSends`: the
  number of `workbench.prompt-dispatched` events whose proposal id no readable authorisation record of any attempt accounts for. They
  may be plain workbench prompts, or this attempt's send. None is attributed, and the run is not reported. A partial log gives `null`.
  The count covers the whole log, every session and the time before this attempt existed, and a dispatch without a usable proposal id
  counts. **A count of 0 does not mean "not sent"**: the authorisation may have been recorded with the send then refused.
- **The same for statements.** A damaged handoff or outcome gives `operator-statement-damaged`. A damaged prepared record, or later
  records without one, makes `endo attempt show/evidence` refuse as `unreadable` instead of saying "no such attempt".
- **Nothing is repaired.** The files are left as found. `endo attempt show` also carries `records`, `damaged` and
  `unattributedWorkbenchSends`, and says `execution: unknown` on stderr for a damaged authorisation.
- **Not re-sent.** The broker already refuses to authorise an attempt that has an unusable file at any of its record names
  (`develop-attempt-dispatch.ts`), so a damaged record never opens a second send.
- **Case-insensitive file systems.** Names are compared exactly, as the store writes them. On a case-insensitive file system (macOS by
  default), a file `<id>.AUTHORIZED.json` would block the broker's write but read here as absent. Endophasia's supported host is Linux.
- **`endo attempt list`** carries each attempt's `records` too, so it no longer shows a damaged authorisation as a plain `execution: null`.
- **The page.** The workbench's attempts view (`EndoDevelopAttemptsViewV2`) still has only `execution: null`, so it can offer the send
  button for such an attempt. That offer is advisory, and the broker refuses it. A page view that shows the damaged state would need a
  view schema change, and is not made here.

## Review

One fresh-context review (another model, not another family: the reviewer was Sonnet 5.5; Codex, another family, reviews the PR on push).
It found one material issue (a damaged receipt file vanished from the reading) and ten minor ones and nits. All are fixed or documented. Findings and
resolutions are in [research/work-cycle/WORK-CYCLE-001B.md](../../research/work-cycle/WORK-CYCLE-001B.md) §6.
