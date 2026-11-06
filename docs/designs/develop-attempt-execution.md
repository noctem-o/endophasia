# DEVELOP Slice I: governed attempt execution

*   **Status:** implemented on `feat/attempt-execution`.
*   **Builds on:** work attempts ([develop-work-attempts.md](develop-work-attempts.md)), verification receipts
    ([develop-verification-receipts.md](develop-verification-receipts.md)), the attention overview ([develop-attention.md](develop-attention.md)),
    the workspace host ([workspace-host.md](workspace-host.md)) and the live Pi workbench ([../develop-workbench.md](../develop-workbench.md)).
*   **Scope:** one path from a prepared attempt to one real Pi execution, and a durable, independently readable relation between them. No
    coordinator, queue, daemon, retry, multi-agent dispatch, automatic verification or automatic acceptance.

**Question.** Can a prepared work attempt be executed through native Pi, under the existing authority, and can its relation to what actually
happened be recovered later by a reader that is not the process that sent it?

**Answer.** Yes. In a live workbench started with `--project`, the operator types `attempt <id>` **on the attached terminal**. The broker
renders the brief from the attempt's own record and shows it whole, under its own phrase (`APPROVE ATTEMPT <16 hex>`). Once approved and
gated, the broker writes one write-once record, `<attempt>.authorized.json`, and only then records the send and sends the brief as a new
prompt, on the existing prompt chain. Every reader (`endo attempt show`, the workbench page, `endo workspace open`) joins that record to the
session's own event log by exact identifiers and shows what was recorded: sent or not, Pi's reply, and how the run after it ended.

## 1. Audit: what already existed

| Capability | Where | Finding |
| :-- | :-- | :-- |
| Prepared attempt and frozen brief | `protocol/develop-attempts.ts`, `storage/develop-attempts.ts` | Write-once files, a pure brief renderer, a recorded renderer version. **Reused unchanged.** |
| A governed new-prompt chain | `adapters/pi/workbench.ts`, `protocol/workbench.ts` | `proposed → authorized → dispatched → accepted | refused`, bound to the exact proposal digest (which covers a keyed digest of the text, the session and the attachment), approved by a phrase typed on the attached process's **controlling** terminal (`cli/workbench.ts` refuses pipes, files and other terminals), re-gated at the moment of sending, never retried. **Reused.** |
| Dispatch evidence | the durable event store | Every append is framed and `fsync`ed before `ingest` returns, and the broker records `workbench.prompt-dispatched` before it calls Pi. So a log that does not hold the dispatch proves no send was made, as of that read. **Reused.** |
| What Pi did after | `adapters/pi/lifecycle.ts` | `lifecycle.run-started` (with the Pi process instance) and the run's end as Pi reported it (`completed`, `failed`, `aborted`, `unclassified`), or `interrupted` / `detached` when the process ended. Pi reports **no run id**. **Reused.** |
| Task ↔ session references | `tasks.json`, `linkCurrentSession` | Says "this session relates to this task". It does not say which attempt was sent, or that anything was sent. **Not reused for this**, see Q3. |
| Independent verification | `endo attempt check` (receipts) | Runs the operator's command in a clean, committed tree and records what was observed. **Unchanged.** |
| Hosts | `endo studio` (read-only), `endo workspace open` (no agent) | Neither has any command route. **Unchanged.** Both read the new relation; neither can write it. |

### The six questions

1. **Can an attempt be bound to a live Pi execution without a new durable schema?** No. Nothing durable names an attempt and a prompt
   request together. The prompt chain names a session and a keyed digest of the text; the attempt names a task. Matching the brief's text to
   the digest would be exactly the inference by matching text that is not allowed, and it needs the digest key. One small record is needed:
   `endo.develop-attempt-authorization.v0`. The chain and the lifecycle stay as they are.
2. **Does the existing Pi path already provide authorisation, identity and dispatch evidence?** Yes, for a *prompt*: the terminal phrase is
   bound to the proposal digest, the session and attachment come from the broker's own attachment, the dispatch is recorded before the send,
   and Pi's disposition is recorded as acceptance. What it lacked was the attempt. The binding record carries the proposal id, its digest, the
   authorisation event id and the message digest, so a reader can check each join (§4).
3. **Can the task/session relationship represent this truthfully?** No. A session reference is the operator's statement that a session
   relates to a task. It is made from the page, can be removed, and says nothing about a brief, an approval or a send. Writing one
   automatically would also write `tasks.json`, which no attempt operation does. The relation belongs to the attempt, in its own directory.
4. **How are dispatch, Pi's acceptance, Pi's run and the operator's acceptance told apart?** Each comes from a different record (§3).
   *Authorised*: the attempt's record exists. *Dispatched*: `workbench.prompt-dispatched` is in the log. *Accepted by Pi*:
   `workbench.prompt-accepted` with Pi's disposition, a reply and never completion. *Run observed*: the lifecycle's run and its end, as Pi
   reported it, never a verdict. *Verified*: a receipt, from a separate command. *Accepted by the operator*: the task's status, set only by
   the operator. None is inferred from another.
5. **What if the process crashes in between?** See §5. The record is written after the approval and before the dispatch, so a crash after it
   is never read as "not authorised", and a crash after the dispatch is never read as "not sent". Nothing is retried.
6. **What is the smallest safe entry point?** A line typed on the attached workbench's own terminal. It adds no route, no grant and no
   process. The page and both independent hosts can only read the result.

## 2. Decision

**Chosen: B, the live Pi workbench, with the request made on its controlling terminal.**

| Alternative | Why not |
| :-- | :-- |
| **A. A dedicated foreground command** (`endo attempt run`), launching its own Pi and prompting it after a terminal confirmation | It would be a second entry point that starts Pi and sends a prompt. It would duplicate the attach lifecycle, the controlling-terminal check, the prompt chain (whose `origin` is `operator-workbench`) and the evidence, and leave the operator without the live transcript, STEER, QUEUE or STOP for the run it started. The terminal boundary it needs already exists in the workbench. |
| **B as a page button** (`POST prompt/propose {attemptId}`) | Safe in principle, because the terminal still approves. But it is a new request surface for the page, it needs its own browser state and tests, and the gain over typing an id is small. It is the natural next slice (§9). |
| **Reusing the task's session reference** | See Q3. |
| **A broader job record** (queued, running, done) | That would be a coordinator: a state machine to drive, and a status the record could not truthfully keep. The state is derived from records that each say one thing. |
| **Writing the binding when the request is made** | A declined or mistyped approval would then use up the attempt. Writing it after the approval means a decline leaves the attempt prepared and sendable, which is unambiguous, because nothing could have been sent. |
| **Writing the binding after the dispatch** | A crash between the send and the write would leave an execution with no attempt. A mutation test shows two tests fail if the order is reversed. |

## 3. Authority and evidence boundaries

```
 attached terminal (controlling tty)            broker (adapters/pi/workbench.ts)                 files
 ───────────────────────────────────            ─────────────────────────────────                 ─────
 operator types: attempt <id>  ───────────▶  check(id): project, launch dir, task, words,      reads develop/tasks.json, attempts/
                                              outcome or handoff, not yet authorised, size, characters
                                              record workbench.prompt-proposed  ──────────────▶ events.log (fsync)
 brief shown whole, APPROVE ATTEMPT <hex> ◀──  ask (one question at a time)
 operator types the phrase  ──────────────▶  record workbench.prompt-authorized (allow) ─────▶ events.log (fsync)
                                              gate: not expired, same session, run idle
                                              check(id) again; brief byte-identical
                                              write <id>.authorized.json  (link: once) ──────▶ attempts/ (fsync)
                                              record workbench.prompt-dispatched ────────────▶ events.log (fsync)
                                              Pi RPC prompt(brief)  ──▶ Pi (its own loop, tools and permissions)
                                              record workbench.prompt-accepted | refused ─────▶ events.log
                                              Pi's run → lifecycle.run-started … run-completed ▶ events.log
```

| Who | May | May not |
| :-- | :-- | :-- |
| The operator at the attached terminal | ask to send an attempt (`attempt <id>`); approve it by typing its exact phrase | approve one attempt with another's phrase, or with a prompt's (`APPROVE PROMPT …` declines it) |
| The paired page (workbench) | read the attempt's execution; withdraw a request still awaiting approval (as for any prompt) | request an attempt (no route takes one: `prompt/propose` with `attemptId` is 400; every `attempt/*` path is 404) |
| `endo workspace open` | read the execution, read-only | send anything; its import closure does not contain the dispatcher (`runtime/contracts/develop-attempt-dispatch.ts`), and a test pins it |
| `endo studio` | nothing new: it has no workspace routes | anything; it still refuses every POST |
| The pairing grant | nothing new | a terminal request needs no grant, and a grant cannot make one |

**Not a sandbox.** Approval decides *whether* this brief is sent to this session. Pi then runs with its own tools and permissions in the
launch directory. The approval text says so.

**Privacy.** The brief is never written to the event log: the proposal holds its keyed digest and length, as for any prompt. The authorisation
record holds the brief's sha256. The brief's text is already in the prepared record in the same directory, so this adds nothing to what the
store holds. It lets any reader check that the attempt still renders the approved text. A test checks that the events file does not contain
the objective. Pi keeps its own session file (`<root>/pi-sessions/`), as it always has.

## 4. The record and the reading

`<root>/develop/attempts/<id>.authorized.json`, `endo.develop-attempt-authorization.v0`, written once by the protocol every attempt record
uses (exclusive temporary file, `fsync`, `link`, directory `fsync`):

```ts
{ schemaVersion, attemptId, recordedAtMs,
  briefSha256,                 // sha256 of the exact brief shown and approved
  taskRevision,                // the task file's revision at the final check
  harness: "pi", session,      // endo.session.pi.<Pi's id>, from the broker's own attachment
  attachment, launchId,
  proposalId, proposalDigest, authorizationEventId,   // the workbench prompt request and its approval
  message: { digest: hmac-sha256, bytes },            // as the proposal recorded it
  approvedBy: "operator", via: "workbench-terminal" }
```

Its existence means **"authorised; a send may follow"**, and nothing more. A build that predates it lists the file as an `unknown-file`
problem and still shows the attempt.

**The reading** (`runtime/contracts/develop-attempt-execution.ts`) is a pure function of the record and the log. It uses exact joins only:

- the proposal: same id, session, attachment, origin and message, and its digest **recomputed** from its recorded content;
- the authorisation: the named event, an `allow`, for that proposal, derived from it;
- the dispatch: derived from that authorisation, and its acceptance or refusal;
- the run: the first `lifecycle.run-started` **in the same session and Pi process instance, after the dispatch in log order and before
  any later dispatch to that session**, and that run's end. A process ending first, a run of a later process that resumed the session, a
  run that starts after another prompt was sent, and any run after Pi refused the attempt are never attributed.

| `send` | Means |
| :-- | :-- |
| `no-send-recorded` | Authorised; the log holds no dispatch. The broker records the dispatch before sending, so it was not sent as of this read |
| `not-sent` | A refusal was recorded after the approval and before any dispatch (with its reason) |
| `sent-no-reply` | Dispatched; Pi's reply is not recorded. Work may have started; the outcome is unknown; never retried |
| `runtime-accepted` | Pi's disposition (`started`). A reply, not completion |
| `refused-by-runtime` | Pi refused it |
| `not-attributable` | The log does not hold the request as recorded (another session, a recomputed digest that differs, a deny, two proposals with one id) |
| `evidence-unavailable` | The log is absent or unopenable, or only a prefix was readable and what was needed is not in it |

`run` is `not-observed`, `open`, `completed`, `failed`, `aborted`, `unclassified` (as Pi reported), `interrupted`, or `process-ended`. Every
label, on the CLI and the page, says what it does not mean ("Not verified", "a reply, not completion").

**Where it is shown.** `endo attempt show` (the record, the reading and its labels, plus a stderr line saying it is not verification) and
`endo attempt list` (one line). On the page, in the existing Attempts section of the Task view (workbench and workspace desk alike): a chip
("Authorised for Pi" / "Sent to Pi") and a short block. The attempts view is now `endo.develop-attempts-view.v2`. The page's closed gate
refuses an execution whose parts disagree (a disposition without acceptance, a run without a send, an answer from an unreadable log). The
block says it is a reading of records and does not reach the session. It never offers to resend.

## 5. Failure and recovery

| The process stops… | The files say | The reading |
| :-- | :-- | :-- |
| before the approval | a proposal, maybe a refusal; no record | the attempt is **prepared**, and can be sent again (nothing could have been sent) |
| after the approval, before the final checks pass | a refusal (`attempt-changed`, `duplicate`, `session-ended`, `run-active`, …) | **prepared**; the terminal says why |
| after the record, before the dispatch | the record; no dispatch | `no-send-recorded`. The attempt is used: retrying is a new attempt |
| after the dispatch, before Pi's reply | the record, the dispatch | `sent-no-reply`; work may have started |
| after Pi's reply, during the run | + acceptance, `run-started` | `runtime-accepted`, run `open` (or `interrupted` once the next attach records it) |
| after the run ended | + the run's end | `runtime-accepted`, run as Pi reported |

A torn tail (an append in progress in another process, or damage) is read as `partial`. Absence then decides nothing. Ambiguous work is
never retried. `attempt <id>` on a bound attempt is refused `already-authorized`, in any process, because `link` refuses the name.

## 6. Operator walkthrough

```sh
endo project add --root S --name Demo --path ~/src/demo                    # once
endo task add    --root S --project P --title "Fix parser" --acceptance "npm test passes"
endo attempt prepare --root S --project P --task T --objective "Accept trailing commas"
endo attempt brief   --root S --attempt A                                   # read the frozen brief; sends nothing

endo harness attach S --cwd ~/src/demo --control --workbench --project P   # the live workbench; Pi starts here
#   on THAT terminal:   attempt A
#   it shows the attempt, the task revision, the whole brief, and:  Type APPROVE ATTEMPT 3232fe8e93b971e8 to send exactly this brief
#   type the phrase (anything else declines; the attempt stays prepared)
#   → "attempt A was sent and Pi accepted it (started). That is not completion; …"
#   follow the run on the page (transcript, steer, queue, stop) as for any prompt; Ctrl-C to end the workbench

endo attempt show  --root S --attempt A        # later, from any process: the record and what the session recorded
endo workspace open --root S --project P       # or read it on the page, with no agent running
endo attempt check --root S --attempt A -- npm test                         # independent verification: a receipt
endo task status   --root S --project P --task T --to review --revision N  # your decision, separately
```

## 7. Tests

| Risk | Test |
| :-- | :-- |
| Successful execution, recovered later by another reader | `tests/endo-workbench-attempts.test.ts` (real attachment to the fake Pi, real event store; `attemptsView()` as `endo workspace open` serves it); `tests/endo-workbench-attempts-cli.test.ts` (the whole path as real processes under a real pseudo-terminal) |
| Refusal or cancellation before dispatch, no model request | decline, withdraw from the page, timeout, session ending, a prompt's phrase typed for an attempt (PTY): no record, no `prompt` call |
| Interruption before and after the dispatch boundary | the broker failing to record the dispatch after binding (bound, nothing sent, not sendable again); a lost reply (`unknown`, sent once, no retry); Pi never answering (`hang-on:prompt`) and Pi exiting on the prompt (`exit-on:prompt`), read after the process is gone; a real log cut just before and just after the dispatch |
| Restart and recovery | new store objects and a read-only log open, after the attached process ended (unit, fake Pi and PTY) |
| Stale or altered context | task words changed (status moves are not staleness), task done, outcome recorded, another project, Pi launched outside the registered directory, a change **between the request and the approval**, a candidate whose brief differs, a prepared record edited after sending (`brief: differs`) |
| Invalid, substituted or ambiguous identity | the session changed before sending; a record naming another session; a proposal in another session's coordinates, with a recomputed digest that differs, another message, a deny, an authorisation not derived from it, a duplicate proposal id; a run of another session, a run before the dispatch, a run of a later process |
| Duplicates and concurrent writers | six processes race to authorise one attempt: exactly one `created`; a second workbench binding it while the first waits for approval (`duplicate`, its record byte for byte); `attempt <id>` again (`already-authorized`) |
| Unavailable or malformed records | absent, unopenable and partial logs; an unreadable file at an attempt's name blocks sending; closed validation of the record |
| Agent success ≠ verification ≠ acceptance | the attempt's state stays `prepared`; labels never claim success (contract test); the PTY test runs `endo attempt check` (a receipt) and shows the task still `open` |
| No implicit authority | page routes refused (broker test); workspace host refuses every attempt-send shape and its import closure excludes the dispatcher; Studio unchanged |
| Ordering | mutation: binding after the dispatch fails 2 tests; removing the re-check at authorisation fails 2 tests |

### Real Pi

`tests/endo-workbench-attempts-cli.test.ts`, opt-in with `ENDO_PI_EXECUTABLE`, runs the same operator path against an installed Pi with the
local fake OpenAI-compatible endpoint as its only provider, in a scratch `HOME` and `PI_CODING_AGENT_DIR`. It is not part of `npm test`.
It was run on this branch against **Pi 1.5.0** (`/usr/bin/pi`). Results:

- **Send:** `runtime-accepted`, with `disposition: started`.
- **Run:** `completed`.
- **Evidence:** `evidence: complete`, `brief: matches`.
- **Model requests:** exactly one to the fake endpoint.
- **Attempt state:** still `prepared`.
- **Verification:** a passing receipt from `endo attempt check`.
- **Task:** still `open`.

```sh
ENDO_PI_EXECUTABLE=$(command -v pi) [ENDO_ATTEMPT_EVIDENCE_DIR=dir] npx vitest --run tests/endo-workbench-attempts-cli.test.ts
```

## 8. Limitations

- **Pi has no run id.** The run is attributed by log order within one session and one Pi process, after the dispatch. The broker sends only
  while idle, but `--prompt` on the same `attach` line, or a run Pi starts by itself, could in principle start first. Do not combine
  `--prompt` with sending attempts.
- **The request is typed, not clicked.** The page cannot ask. That is deliberate in this slice, but it is less convenient.
- **A handoff and a send do not mix in one direction only.** An attempt with a recorded handoff cannot be sent (`handed-off`), but
  `endo attempt handoff` is not refused after a send. Handoffs are the operator's own statements, and that path is unchanged.
- **A declined approval is attributed to the session's prompt chain only**, not to the attempt: the attempt stays prepared.
- **One send per attempt.** A brief over 16 KiB (a workbench prompt) is refused, not cut.
- **The reading opens the whole event log** for each view that includes an authorised attempt. That is linear in the log, as the
  cockpit's reads are.
- **The broker names the session `endo.session.pi.<Pi's id>`**, as the prompt chain always has. For a Pi id outside the canonical pattern
  (Pi's ids are UUIDs), the lifecycle names it by hash, and the reading would say `not-attributable` rather than guess.
- **Not tested:** STEER, QUEUE or STOP during an attempt's run against real Pi (they are the existing chains, unchanged); real Pi with a real
  provider (the fake endpoint only); macOS (the workbench needs Linux `/proc` to verify the controlling terminal).

## 9. Independent review

A fresh-context subagent reviewed the commit adversarially. It did not write the code. It ran the targeted suites and wrote its own probe
scripts. This was **not** the Elephant–Goldfish plugin, which is not installed here.

| Finding | Severity | Resolution |
| :-- | :-- | :-- |
| The run search had no end. When Pi refused the attempt, or its reply was lost, a later prompt's run was attributed to the attempt. The reviewer reproduced this with probe scripts. | material | **Fixed.** The window ends at the next dispatch to that session, and an attempt Pi refused gets no run. Regression test. Removing the bound makes it fail. |
| A refusal reason this build does not know made the page's gate refuse the whole Attempts section | minor | **Fixed.** It reads as `not-sent` with an unknown reason. Gate test. |
| "Brief differs" said the record changed "after it was sent", even when no send was recorded | minor | **Fixed.** It now says "after it was authorised". |
| On a partial log, states after the dispatch were stated without a caveat on the CLI | minor | **Fixed.** `attempt show` says so, as the page already did. The state values are unchanged, because a dispatch was observed. |
| An attempt handed off to another agent could also be sent to Pi | minor | **Fixed** in that direction: `handed-off`. The reverse is recorded in §8. |
| `authorize` throwing would leave the request holding the approval slot | nit | **Fixed.** It settles as `attempt-not-recorded`. Regression test. |
| An empty brief is reported as `brief-too-large` | nit | **Kept.** It cannot happen, because a brief always names its attempt. |

It found these sound:

- Only the terminal reaches `requestAttempt`. Phrases do not cross between attempts and prompts.
- There is no await between the final gate, the binding and the recorded dispatch.
- Write-once and `EEXIST` are handled correctly, and problem files block sending.
- The reading's joins are exact and the proposal digest is recomputed.
- No brief text appears in the event log.
- Studio and the workspace host are unchanged.

## 10. Next

**A page request for an attempt.** Implemented in Slice J ([develop-attempt-workbench.md](develop-attempt-workbench.md)) on its own route,
`POST attempt/propose {attemptId}`, rather than on `prompt/propose`: a route that carries text never carries an attempt. The terminal
approves under the same `APPROVE ATTEMPT` phrase. Since then, the terminal is no longer the only caller of the attempt request; it is still
the only place an attempt is approved. Still to do: show the attempt's execution in the attention overview.
