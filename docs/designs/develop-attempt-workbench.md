# DEVELOP Slice J: requesting an attempt from the workbench page

Status: implemented. It builds on [Slice I](develop-attempt-execution.md), which sends a prepared attempt to Pi from the workbench's
terminal.

From the paired live Pi workbench page, the operator can now:

1. open the selected task's prepared attempt and read its brief;
2. **ask** to send it to the attached Pi session;
3. approve it **on the attached terminal**, with the attempt's own `APPROVE ATTEMPT` phrase, as before;
4. follow the conversation, then read the attempt's execution evidence from the records, as in Slice I.

The page asks and the terminal approves. A grant still cannot approve anything. Studio and `endo workspace open` gain nothing.

## 1. Audit: what already existed

| Question | Finding in the code |
| :-- | :-- |
| How the Conversation, Changes and Task views are put together | `LiveConversation` (`studio-ui/src/develop/Live.tsx`) is one panel with three tabs. Above the tabs: the worktree bar with the task cluster, and the run strip with STOP. Below them: the pairing form or the composer. The Composer is outside the tab panels, so it stays mounted and in view in every tab. Beside the panel are the context column (`LiveContext`) and the sessions rail. In the Field appearance, the context column is a dock with a **Focus** toggle (`DevelopWorkspace.tsx`). |
| What happens to focus and drafts when switching views | The draft and the composer mode live in `useWorkbench`, not in the composer, so they survive unmounting. `LiveScroll` keeps the scroll position and whether to follow the newest item while the view is hidden. The Conversation tab shows "· new" when something arrived while another view was shown. Arrow keys, Home and End move between tabs. The view is never switched for the operator. **Already sound; nothing to fix.** |
| How grants and terminal approval work | A one-time code, shown only on the terminal, buys one grant. The grant is held in the page's memory only, expires after an hour, and is replaced by the next pairing. It lets the page read and request. Each request is recorded as `workbench.prompt-proposed`. The terminal asks one question at a time, for an exact phrase that carries the operation and a 16-hex digest. At the moment of sending, the broker checks again: the approval window, the session, the grant (for a page request), and whether a run is open. |
| What Slice I added | `requestAttempt` for the terminal's `attempt <id>` only. The brief is rendered from the record and shown whole under `APPROVE ATTEMPT`. After approval and the gate, the attempt is checked again and its write-once `<id>.authorized.json` is written **before** `workbench.prompt-dispatched`. The read side joins that record to the log by exact ids (`send` and `run` states). |
| Can a page request reuse the proposal and approval chain? | **Yes, with no new path.** `#open(grant, message, attempt)` already takes a grant. `#run` already re-checks a non-null grant at the gate, after approval and before binding. A page route only has to call the same code with the page's grant and nothing from the page except the attempt's id. |
| How an attempt is linked to its execution evidence | The attempts view (`workspace/attempts`) is the selected task's attempts, from the store, each with its `execution` reading. The broker's command view now carries `attempt.attemptId` from its own checked candidate, never from the page. The live request is linked to the attempt by that id. The durable link is the authorisation record. |
| Can the attention projection show the link without guessing? | Not today: the attention view summarises attempts and receipts, and has no `execution` field. Adding one is a server and wire change of its own. **Deferred** (§9). This slice shows the selected task's link in the next-step strip and in Task. |
| UI changes possible without a redesign | A request control inside the opened attempt. An attempt-aware request card in the conversation. One next-step line under the run strip, visible in all three views. Nothing else in the layout moves. |

## 2. Approaches compared

| Approach | Verdict |
| :-- | :-- |
| **A. A separate route, `POST attempt/propose {attemptId}`**, behind the grant, calling the same `#requestAttempt` as the terminal. | **Chosen.** The body is closed to one key. A failed attempt request cannot become a prompt, because no message ever travels. Every refusal has a closed name. |
| B. Overload `POST prompt/propose` with `{attemptId}`, as Slice I §10 sketched. | Rejected. `prompt/propose` carries text. One route meaning either "send this text" or "send that attempt" is where a refused attempt could fall through to a typed prompt, which the brief forbids. Slice I's tests also pin that `prompt/propose` refuses an `attemptId`, and they still pass. |
| C. A composer mode that fills the composer with the brief. | Rejected. The brief would come back from the browser, an edit would silently become an ordinary prompt, and the attempt binding would rest on text the page supplied. |
| D. A route on `endo workspace open`. | Rejected. That host is agent-free by design, and its import closure is pinned. |
| E. A side-by-side Conversation and Task layout on wide screens. | Deferred. It needs a new grid and focus model. The tabs already keep the draft and scroll position, and the next-step strip shows the attempt's state in every view. |

## 3. Authority and evidence boundaries

```
page (grant)                    broker (attached process)                      terminal (operator)
POST attempt/propose {id}  ──▶  check(id): project, launch dir, task, words,
                                outcome, handoff, already authorised, brief
                                record workbench.prompt-proposed (digest only)
                           ◀──  202 view {state: awaiting-approval,
                                attempt: {attemptId, taskId, bound: false}}
                                                                    ──▶  "requested from the paired page"
                                                                         attempt id, task revision, the WHOLE brief
                                                                         Type APPROVE ATTEMPT <16 hex> …
                                                                    ◀──  the phrase (anything else declines)
                                gate: window, session, the page's grant
                                still held, no run open → check again →
                                write <id>.authorized.json (once) →
                                record prompt-dispatched → prompt(brief)
GET prompt/<id>            ◀──  accepted | unknown | refused (+ bound, refusal)
```

- **A pairing grant is permission to ask, never to approve.** The grant is checked when asking and again at the moment of sending. A page
  that pairs again (a new grant) before the operator approves gets `not-authorized`, and nothing is bound or sent. Tested.
- **The brief is never taken from the page.** The route's body must be exactly `{attemptId}`. Any other key, or a non-string, gets 400.
- **The terminal is told where the request came from** (`requested from the paired page` or `on this terminal`). It is still shown the
  whole brief and needs its own phrase. The durable record still says `via: "workbench-terminal"`, which remains true: the approval was
  typed there.
- **One attempt, one send.** The write-once record, the `already-authorized` check and the single request slot are unchanged. A page that
  asks again gets `409 attempt-already-authorized`.
- **A withdrawn, declined or timed-out request does not use up the attempt.** Nothing is bound before approval and the gate. A refusal
  after approval but before binding (task changed, run opened, session changed, grant gone) also leaves the attempt sendable. Only a
  request that wrote the authorisation spends the attempt, as in Slice I.
- **No silent fallback.** An attempt request that fails is answered with a closed code (`attempt-<reason>`, `not-offered`, `not-found`,
  `not-recording`, `bad-request`). There is no message for it to fall back to.
- **Unchanged:** Studio has no workbench. `endo workspace open` still answers 404 to `attempt/propose`, its other agent routes and
  `prompt/*`. Its static import closure is still pinned. Neither host renders the request control: only `Live.tsx` imports it (source pin).
- **Later messages are not the attempt.** The conversation's request card says that later prompts, steers and queues are the operator's
  own and not part of the attempt. Slice I's run window, which ends at the next dispatch to the session, keeps them out of its reading.
- **No transcript in canonical evidence.** The brief appears in the event log only as a keyed digest, as before.

### Request states: brief terms and what the code reports

| Brief term | What the page reads | Is the attempt still sendable? |
| :-- | :-- | :-- |
| Prepared, not requested | no command for it; `offers.attempt` | yes |
| Refused when asked | `409 attempt-<reason>` / `not-offered` (nothing recorded) | depends on the reason |
| Waiting for approval | `awaiting-approval`, `bound: false` | yes, once settled |
| Withdrawn or declined | `refused`, `not-authorized` or `authorization-denied`, `bound: false` | yes |
| Approved, not sent | `approved: true`, `refused`, `bound: false`. A gate reason (`run-active`, `session-ended`, `not-authorized`, `authorization-expired`) or a passing storage fault (`attempt.refusal` `tasks-unreadable`, `unreadable`, `storage-failed`) leaves the attempt sendable. A lasting `attempt.refusal` (`already-authorized`, `handed-off`, `outcome-recorded`, `task-done`, `task-words-changed`, …) means it cannot be sent as it stands, and the page says so | depends on the reason |
| Approved, bound, send not recorded | `refused`, `session-ended`, `bound: true` | no (Slice I: "not sent", by the log) |
| Recorded as sent, reply unknown | `unknown`, `bound: true` (Pi's reply was not seen or not recognised) | no, never retried |
| Pi acknowledged it | `accepted` (disposition) | no |
| Pi refused it | `refused`, `runtime-refused` | no |
| Execution observed | the attempt's `execution.run` (Slice I) | no |
| Verified | the attempt's receipts (separate act) | n/a |
| Operator accepted | the task's status (untouched) | n/a |

## 4. Wire changes

All of these are additive in the broker. The page and broker ship in one package, and the page's closed gates were updated with them.

- `GET status`: `offers.attempt` (`{offered, reason}`). It is offered when a prompt would be and the workbench was started with
  `--project`.
- `POST attempt/propose {attemptId}`: 202 with the prompt view. Refusals: 400 `bad-request`, 401 `grant-required`, 404 `not-found`
  (no `--project`), 409 `not-offered`, 409 `attempt-<reason>` (the closed `DevelopAttemptDispatchRefusalV0` list), 503 `not-recording`.
- The prompt view gains `attempt: {attemptId, taskId, bound, refusal} | null`. It is null for a typed prompt. `GET status` needs no grant, so
  without one it reports `attempt: null`: which attempt and task are in flight is told only to the paired page.
- `WorkbenchApprovalRequestV0.requestedFrom: "terminal" | "page"`, shown on the terminal.

A page older than this broker refuses the new status (its gate is closed). The two are never mixed, because the CLI serves its own built
page.

## 5. The page

- **Task → the attempt**: under the brief there is one button, **Request sending ‹id› to Pi**. Its description says what happens: the
  terminal is asked, it is sent once as recorded, it may cost money, and it is never retried. Unpaired, not offered, or not eligible: the
  button is disabled and says why. While the request is open: its steps (requested, approved in the terminal, authorisation recorded,
  sent, Pi replied) and **Withdraw**. When it ends without binding the attempt, the outcome is shown and the button returns.
- **Conversation**: the existing request card, made attempt-aware. It shows the attempt chip, the same steps, and the note that later
  messages are not the attempt.
- **Next-step line**, under the run strip, in every view. It is read from the broker's request and the selected task's attempt records:
  waiting for terminal approval, being sent, run open, no run recorded yet, "the run ended as Pi reported, no check recorded, the task's
  status is yours", checks that could not all be read (unknown, never "none"), checks recorded and the decision is yours, or
  prepared and not sent. It never quotes model text, and it never says done.
- When a request for an attempt settles, the attempts are read again, so the execution reading appears without a manual refresh. The
  run's end is read when the operator refreshes the tasks. Nothing polls the store.

Unchanged: the composer, its modes and its draft; Changes; the context column; Focus (Field only); keyboard navigation between tabs.

**Later (REVIEW-PILOT-001, run 1): a terminal command typed into the composer.** An operator typed `attempt <id>` into the composer. The
page asked for it as a prompt, the terminal's request differed only by `prompt`/`PROMPT`, and the operator approved it. Pi got one line of
chat, and the attempt was never sent (its records said so correctly). Now:

- **The composer** does not ask for a message whose whole text is the terminal's `attempt` or `pair` command. It says where the command
  goes instead. Ordinary words that start the same way ("attempt it again") are still messages.
- **The terminal**, asked to approve a prompt, steer or queue whose text is such a command, says before the phrase that approving sends
  it to Pi as chat and does not send any attempt.
- **A bare `attempt`** at the terminal says it takes one attempt id, and where ids are listed.

One rule decides what counts as a command (`endoWorkbenchTerminalCommandInV0`). The page keeps a copy, and a test keeps the two equal.

**One existing bug fixed.** When the page learns there is no worktree to read (a late `absent` answer from the project route), it used to
reset the whole project state, including the view the operator had chosen. Someone reading Task could be moved back to the conversation.
The view is now kept; only Changes, which is not offered then, falls back to the conversation. The browser tests found this under load,
and it has a model test (`tests/endo-studio-project-model.test.ts`).

## 6. Operator walkthrough

```
endo project add --name demo --path ~/src/demo
endo task add --project P --title "Say hello" --acceptance "a greeting"
endo attempt prepare --project P --task T --objective "Say hello in one short sentence."
endo harness attach <root> --cwd ~/src/demo --control --workbench --project P
#   open the printed address, type the pairing code shown on the terminal
#   Task → pick the task → open the attempt → read the brief → "Request sending ‹id› to Pi"
#   the terminal shows: requested from the paired page, the attempt, the task revision, the whole brief, and
#   Type APPROVE ATTEMPT 1153af27… to send exactly this brief
#   type it there (anything else declines; the attempt stays sendable)
#   the page: "Recorded as sent, once. Pi replied: started", then Conversation to follow the run, Task to read what was recorded
endo attempt show --attempt A          # later, from the files alone
endo attempt check --attempt A -- npm test    # a separate act: a receipt, not acceptance
endo task status --project P --task T --to done    # the operator's own decision
```

Screenshots from the real-Pi run (synthetic fixtures) are attached to the PR.

## 7. Tests

The table maps each brief scenario to the tests that ran it.

| # | Scenario | Where |
| :-- | :-- | :-- |
| 1 | An eligible attempt requested through the paired page | broker: `tests/endo-workbench-attempts.test.ts` ("the paired page requests…"); browser: `tests/endo-studio-attempt-request-browser.test.ts`; end to end: `tests/endo-workbench-attempt-page.test.ts` |
| 2 | Terminal approval sends the exact frozen brief once | all three: `promptCalls === [brief]`, `already-authorized` afterwards, from the page and from the terminal |
| 3 | A wrong phrase or a refusal sends nothing | broker (deny), browser (narrow width: deny), Slice I's PTY test (wrong operation's phrase) |
| 4 | Withdrawn while awaiting approval | broker; browser (withdraw, then a fresh request) |
| 5 | A duplicate request or an already-authorised attempt is refused | broker (`not-offered` while one waits; `attempt-already-authorized`); end to end (terminal refuses after the page's send) |
| 6 | A stale or changed task, brief or project is refused | broker: handed off (`attempt-handed-off`), unknown id, malformed id, task words changed between request and approval (`attempt-changed`, `refusal: task-words-changed`); Slice I's dispatch tests cover the project, launch directory, done and substituted session |
| 7 | A disconnected session or an open run | broker: run active and no session both give `not-offered` with nothing recorded; a session swapped before approval gives `session-ended` (Slice I) |
| 8 | A lost Pi acknowledgement is shown as uncertainty | broker: `unknown`, `bound: true`, never asked again; model: "not a failure, and not a success" |
| 9 | The workspace and Studio hosts still reject execution | `tests/endo-workspace-host.test.ts` (`attempt/propose` → 404, unchanged); source pin: only `Live.tsx` renders the control |
| 10 | Ordinary Prompt, Steer, Queue and Stop are unchanged | broker: a typed prompt is unchanged (no attempt, `APPROVE PROMPT`); all existing workbench, intervention and browser suites pass |
| 11 | Drafts and focus across views | browser: the draft survives Task → Conversation → approval; the composer cannot send while the attempt waits |
| 12 | Narrow width, keyboard, accessibility | browser at 390×844: no horizontal overflow; the control is a button with an `aria-describedby` effect sentence, focused and pressed with Enter |
| 13 | Durable evidence is readable after shutdown | end to end: Ctrl-C, then a new `endo attempt show` process reads `runtime-accepted` and `brief: matches` |
| 14 | Task status is unchanged by agent completion or a receipt | broker, browser and end to end: status `open` after the run and after `endo attempt check` |

Model: `tests/endo-studio-attempt-request-model.test.ts` covers the words and the next step, never "done", never "send again". Source pin:
`tests/endo-studio-ui-source.test.ts`.

### Real Pi

`ENDO_PI_EXECUTABLE=$(which pi) npx vitest --run tests/endo-workbench-attempt-page.test.ts` was run with Pi 1.5.0. It used a scratch
HOME, `PI_OFFLINE=1`, and the local fake OpenAI-compatible endpoint as the only provider, so it needed no credentials and cost nothing.
Asked from the page and approved on the PTY: `send: runtime-accepted`, `run: completed`, `brief: matches`. The page said "Recorded as sent, once. Pi replied: started", then "Pi reported the run completed. Not verified". The task stayed `open`.

## 8. Limitations

- **Untested:** an operator closing the page while a request waits. The request then waits on the terminal until it is answered or
  expires, and the grant is unaffected. No browser test closes the tab mid-request.
- **Approval is still a local confirmation**, not proof of identity, and not an operating-system sandbox. Pi runs with its own tools.
- **The durable record does not say where the request came from.** It says the approval was typed on the terminal.
- **Attention overview**: no execution column yet (§1). The next-step line covers only the selected task's newest attempt.
- **The end of the run** appears when the tasks are read again (on settle, or Refresh tasks). Nothing polls the store.
- **Focus mode** is still Field-only. Instrument keeps its three columns at desktop widths.
- One request at a time per workbench, as before. There is no queue of attempts and no parallel attempts.

## 9. Independent review

A fresh-context reviewer read `git diff main...HEAD` adversarially. It found **no material defects**. It found sound: authority (the
body is exactly `{attemptId}`, the grant is re-checked at the gate, the page has no path to approve), no duplicate dispatch (a single slot
set synchronously; `authorize` re-checks and writes once), identity (only from the broker's candidate), the wire gate's limits, and privacy
(the brief is only a digest in the log). All of its minor findings and nits were fixed, each with a regression test:

| Finding | Severity | Resolution |
| :-- | :-- | :-- |
| After approval, a binding refusal for a lasting reason (for example `already-authorized` by another writer, or `handed-off`) still said "it can be requested again" | minor | **Fixed.** The wording depends on the refusal, and only passing faults say "requested again". Model test. |
| Every failed request said "Nothing was recorded or sent", including a timeout or a malformed 202 that may have reached the broker | minor | **Fixed.** That sentence is shown only for the broker's own refusals. Otherwise the page says the request may still have been made and reads the workbench again. Model test. |
| With the attempts read before the send, the next-step line said "Prepared and not sent" while the request card said it was sent | minor | **Fixed.** A bound or sent request for that attempt reads as awaiting evidence, never ready. Model test. |
| The first step said "requested from this page" even for a request typed on the terminal | minor | **Fixed.** It now says "requested". |
| A request refused for a lasting reason disappeared from Task once the attempts were read again | minor | **Fixed.** The outcome stays shown above the "cannot be sent" line. |
| Focus fell to the page body when the request button or Withdraw was replaced | minor | **Fixed.** A labelled live region stays mounted and takes focus. Browser test: Enter, then focus on the region, then Tab to Withdraw; Withdraw, then focus on the region. |
| An unpaired `GET status` showed which attempt and task were in flight | minor | **Fixed.** Without the grant, `command.attempt` is null. Broker test. |
| The terminal said nothing about how a page-requested attempt ended | minor | **Fixed.** After the phrase is answered, the terminal prints the same account as for `attempt <id>`. End-to-end assertion. |
| The card said steers and queues are "not recorded as part of" the attempt, but Slice I's run reading includes the run they change | minor | **Fixed.** The wording now separates later prompts from steers or queues that change the attempt's run. |
| Words for `dispatching` before binding can never be shown | nit | **Kept**, marked as defensive. |
| "Sent once" overstated a send whose reply was lost, or came in a form this version does not recognise | nit | **Fixed.** It now says "Recorded as sent, once", and "not seen or not recognised". |
| A stale problem message could reappear after a later request | nit | **Fixed.** It is cleared when a request for the attempt appears. |
| Codex (PR review): the next-step line said "No check is recorded" when the receipts directory was unreadable or receipt files were rejected, so existing checks could be hidden | minor | **Fixed.** An empty list counts as no check only when every receipt was read; otherwise the line says whether a check is recorded is unknown. Model test. |

## 10. Next

1. An `execution` summary per attempt in the attention overview, from the same reading.
2. An operator decision record that ties an attempt's execution to its receipts when the task is closed. It sends nothing.
3. Focus mode in the Instrument appearance, if operators ask for it.
