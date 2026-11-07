# WORK-CYCLE-001B: human-governed validation and artifact evidence

**Question.** Can Endophasia identify the artifact revision associated with a governed work attempt, determine whether its verification
evidence still applies, and present those facts without inventing authorship, correctness or authority?

**Answer.**

- **It can say what it observed and what was declared, and now it says so in one reading:** `endo attempt evidence`
  ([design and decision record](../../docs/designs/develop-attempt-evidence.md)).
- **It cannot identify the revision the attempt produced, and the reading says that instead of guessing.** No record names a candidate.
  The commits shown are the ones the operator checked, linked to the attempt by the operator.
- **The human-governed run was NOT EXECUTED.** The operator was away. The procedure is unchanged and ready (§2).

Starting point: `main` at `e10caf9b0` (PR #128 merged).

## 1. Audit (on `e10caf9b0`)

| Question an operator asks | Answered before this PR by | Gap |
| :-- | :-- | :-- |
| Which attempt was sent? | `endo attempt show` (`execution.send`, joined exactly to the authorisation record) | none |
| What did Pi report? | `endo attempt show` (`execution.run`: the first run of the same Pi process after the send) | none |
| Which candidate revision, identified by whom? | nothing. Receipts name the commit each check ran at; their link to the attempt is operator-declared | **by design, no record**. Now said explicitly |
| Which checks were observed? | `endo attempt receipts` | spread over every receipt; no "latest per check" in the terminal (the attention overview has one, per task) |
| Do they still apply to the current Git state? | `endo attempt receipts` (`relation`, per receipt) | the reader had to work out which receipt is current |
| What is missing, stale, declared or inconclusive? | nothing | **missing**: WORK-CYCLE-001A's driver had about 300 lines (`reconstruct`) to assemble it |
| Has the operator accepted the task? | `endo task show` (`status`, `history`; added in 001A) | a separate command |
| The same, on the page | the workbench's attempts view: each attempt's execution and receipts with relations; the task's status | no gap list. Not changed: a second view was not justified |

**Git observations.** Read-only Git (`adapters/git/revision-observer.ts`) is called only by receipts (before and after each check) and by
readers (HEAD now). No event and no record holds Git state at the dispatch or at the run's end.

**Records.**
- The attempt, its handoff and its outcome are the operator's, and write-once.
- The authorisation record is the broker's, written after the operator's terminal approval and before the send, and write-once.
- Receipts are Endophasia's observations, and write-once.
- The task's status and history are the operator's.

None of them is changed by this PR.

## 2. The human-governed run: NOT EXECUTED

| | |
| :-- | :-- |
| Host checked | Pi **1.5.0** (`/usr/bin/pi` → `@earendil-works/pi-coding-agent`); llama.cpp router **b11429-d812350493** at 127.0.0.1:8081, `models_autoload: false`; `Muse-Glimmer-30B-Abliterated-Q4_K_M` present, found **unloaded**; Ponytail **5.3.3**; no `~/.config/ponytail` |
| What happened | The operator was away, so no person could type the approval. |
| Then | The operator then asked the agent to do it if it could. An agent-typed approval would not have been a human-governed run, and would have repeated 001A's test-substitute runs. It would have exercised `driver.ts run`, which has never run. The agent's attempt to start it was **refused by the session's permission classifier** before anything was created, and it was not worked around. |
| Model state | Glimmer was loaded for that attempt and unloaded straight away: the router is back as found |
| The seven post-run questions | **not answered for a human run.** All seven are answered for the test-substitute and real-Pi runs below (§4). |

To run it, unchanged from [README §3](README.md#3-procedures), with `--runs` set so 001A's outputs are not touched:

```sh
curl -X POST http://127.0.0.1:8081/models/load -H 'content-type: application/json' -d '{"model":"Muse-Glimmer-30B-Abliterated-Q4_K_M"}'
PONYTAIL_DEFAULT_MODE=off node research/work-cycle/driver.ts run --pi "$(command -v pi)" --expect-pi-version 1.5.0 \
  --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M --runs ~/projects/endophasia-research/work-cycle-001b
# on that terminal: attempt <id> → read the brief → type the APPROVE ATTEMPT phrase yourself → Ctrl-C when the run ends → answer the commit question
node cli/index.ts attempt evidence --root <run>/store --attempt <id>    # with ENDO_DIGEST_KEY_FILE=<run>/digest-key
curl -X POST http://127.0.0.1:8081/models/unload -H 'content-type: application/json' -d '{"model":"Muse-Glimmer-30B-Abliterated-Q4_K_M"}'
```

## 3. What changed

- **`endo attempt evidence --attempt <id> [--cwd <dir>]`** ([design](../../docs/designs/develop-attempt-evidence.md)).
  - A read-only reading, built from records that already exist:
    - the attempt and the operator's statements;
    - the send and Pi's report;
    - "no record names a candidate", with the commits that were checked;
    - the latest receipt of each check and its relation to the tree now;
    - the operator's status moves;
    - a fixed list of gaps;
    - what no record establishes.
  - Every section names its source (`observed`, `operator` or `none`).
  - The code is a pure function in `runtime/contracts/develop-attempt-evidence.ts`, a CLI wrapper, and a line in `endo help`.
  - It reuses `endoLatestChecksV0`, the attention overview's "latest per check, current HEAD first".
- **No record, event, schema, page or approval path changed.**
- Tests:
  - `tests/develop-attempt-evidence.test.ts`: the pure reading, case by case.
  - Tier 1 of `tests/work-cycle-001a.test.ts`, which runs in CI: the reading at four points of the real fake-Pi cycle, and one attempt that was never authorised.
  - A new opt-in real-Pi block: a lost model connection, and Pi killed mid-tool.

## 4. Results (2026-11-07)

### Cases

| Case | Where | Observed |
| :-- | :-- | :-- |
| Normal human-governed run | — | **NOT EXECUTED** (§2) |
| Normal run, test-substitute approval, fake Pi | tier 1 (CI) | after the check at the operator's commit: `send runtime-accepted`, `run completed`, the latest check `passed` / `at-head`, with 1 earlier failure; the only gap is `not-accepted`. After the operator's `review → done`: no gaps |
| Prepared, never authorised | tier 1; unit | `send: null`, `run: null`; gaps `not-authorized`, `no-check`, `not-accepted` |
| Authorised, send not confirmed (`no-send-recorded`, `sent-no-reply`) | unit (states come from the execution reading, already covered with fake Pi in `tests/endo-workbench-attempts.test.ts`) | `send-not-confirmed`, `run-not-completed` |
| **Real Pi 1.5.0 loses its model connection mid-answer** | opt-in, disposable fake endpoint (`disconnectAfterFirstChunk`) | Pi retried: **4** requests in the one run kept (the test asserts only "more than 0"). It then reported the run **`failed`**. Gaps: `run-not-completed`; `no-check-after-authorization` and `check-not-passed-at-current-head` (the only check is the failed baseline); `not-accepted`. No process of the run left |
| **Real Pi 1.5.0 killed (SIGKILL) while its `bash` tool runs `sleep 20`** | opt-in, disposable fake endpoint | `send runtime-accepted`, run **`interrupted`**; gap `run-not-completed`. **Pi's tool process (`sleep 20`) outlived Pi and the workbench's exit**: it is outside the process group the attachment's launcher stops. Pinned by the test, then stopped by it (§5) |
| Failed / inconclusive check at HEAD | unit | `check-not-passed-at-current-head`, with the receipt's reasons. A pass recorded later at an older commit does not hide a failure at HEAD |
| No check | unit; tier 1 (the unauthorised attempt) | `no-check` |
| Checked revision differs from the tree now | tier 1; unit | uncommitted changes on top: `current-tree-changed`, `no-check-at-current-head` and (after the later commit) `stale-check`. Another working tree: `checked-in-another-tree` |
| Clean but different HEAD after a pass | tier 1 (CI); unit | the pass reads `head-differs` ("Stale…"); the gaps are `no-check-at-current-head` and `stale-check`; the task stays `done` |
| One command stale while another passed at HEAD | unit | `stale-check`: a trivial command at HEAD does not hide that the real one was not rerun |
| A damaged receipt file | tier 1 (CI); unit | gap `receipt-files-unusable`, and a line in the text: a failure it might have recorded is never silently dropped |
| Dirty tree: the receipt contract refuses | every tier (unchanged since 001A) | exit 2, nothing ran, nothing recorded |
| Reader reopened after Pi and the proxy exit | every tier; the kept 001A Glimmer run (below) | every reading is a new `endo` process after the workbench exited |
| Operator decision independent of run and check | unit; tier 1 | `done` with a failed run and a failed check: both shown, neither corrected. All passed but `review`: `not-accepted` |

### Reconstruction example: the kept WORK-CYCLE-001A Glimmer run 2, read now

A new process, no agent, `--cwd` at the kept copy:

```
attempt endo.attempt.7d9372ea… : Fix slugify in src/slug.mjs so that `node --test` passes: …
  sent      [observed] Sent to Pi, and Pi acknowledged it. That is a reply, not completion.
  run       [Pi's report] Pi reported the run completed. Not verified.
  candidate [none] no record names one; checked at: 334ca4fad31e, 4e8f676652b8
  tree now  [observed] 4e8f676652b8, clean (…/work-cycle-001a/tier3-run2/run/project)
  check     [observed; linked to this attempt by the operator] node --test: Observed check passed at 4e8f676652b8; Recorded in a different repository; not compared
  decision  [operator] status open
  gap       No check was recorded at the working tree's current HEAD: the current revision is unchecked.
  gap       Some checks ran in another working tree or repository; they are not compared with this one.
  gap       The task's status is not done: the operator has not recorded accepting it.
  not established by any record: (seven lines)
```

The copy has the same commit but a different repository (its `.git` moved). So the reading does **not** carry the pass over, as the receipt
contract requires. This is the revision-substitution case on real data.

### Mutation evidence

Each property was broken in turn in `develop-attempt-evidence.ts`, and the unit tests (13) were run. The file was restored byte for byte
after each mutation.

| Mutation | Tests failed |
| :-- | :-- |
| a stale (`head-differs`) receipt counted as at HEAD | 1 |
| acceptance inferred from a pass (`not-accepted` dropped when a check passed) | 5 |
| "latest check" by time alone, ignoring the current HEAD | 6 |
| an inferred candidate added to `candidate` | 0 in the first round; the test was tightened to the exact members; then 1 |
| uncommitted changes not reported | 1 |
| an unconfirmed send not reported | 1 |
| a damaged receipt file not a gap (review finding 1) | 1 |
| `stale-check` removed (finding 2) | 2 |
| the run line labelled `[verified]` instead of `[Pi's report]` (finding 7) | 1 |
| the check line's "linked to this attempt by the operator" dropped | 1 |
| "before the authorisation" by start time only (finding 5) | 1 |
| the first move to done shown instead of the last | 1 |
| the `task-words-changed` gap removed | 1 |

### Ponytail (tier 2, rerun)

Pi 1.5.0, `PONYTAIL_DEFAULT_MODE=off`. Ponytail was observed **off** in all requests, and the positive control was **full**, as in 001A.

Evidence is kept outside the repository, under `~/projects/endophasia-research/work-cycle-001b/`:

- `<time>-real-pi-negative/`: `lost-connection.json`, `killed.json`, `tier2.json`;
- `<time>-reconstruction-run2/`, and `<time>-reconstruction-run2-after-review/` (the example above).

001A's outputs were not touched.

## 5. Limitations, and what is left (for REVIEW-PILOT-001)

1. **The human-governed run.** No person has approved an attempt on the terminal in any study yet.
2. **Orphaned tool processes.** When Pi is killed abruptly, a tool process it started (its `bash` tool) survives the workbench's exit. The
   attachment's launcher stops its own process group; Pi's tool child is not in it. This is not fixed here: Endophasia does not own Pi's
   children, and reaching them is a process-ownership design question (a cgroup or a subreaper, for example). The test pins the current
   behaviour, so a fix will show.
3. **A candidate revision.**
   - No record names one.
   - An operator-declared candidate (approach 2) waits for a real review that needs it.
   - Before/after Git observations at the dispatch and the run's end (approach 3) are the next *observation* worth designing. They need
     wording that cannot be read as authorship, and a decision on where the broker observes.
4. **Which revision the operator reviewed when deciding.** The status history records neither a revision nor an actor.
5. **Constraint compliance** ("do not run git") is still unobservable from canonical evidence: tool arguments are digests.
6. **Configuration provenance.** Ponytail's mode and the served model's identity are still not in any Endophasia record (001A §7).
7. **The page.** The workbench shows executions and receipts per attempt, but not the gap list. Whether it should is a design question
   for the review pilot, not a second view added here.
8. **A clock step** can mislabel a check's `authorization` (before, overlapping or after).

## 6. Independent review

A fresh-context subagent on Sonnet 5.5 reviewed `e440136c5` adversarially. That is another model but not another family. Codex, another
family, reviews the PR on push. The reviewer:

- ran the real-Pi block (17 passed, 1 skipped), and the two new tests 3 more times;
- ran its own probe stores and 18 mutations;
- checked that the command writes nothing: the store, project and `.git` read the same before and after.

| # | Finding | Severity | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | A damaged or unreadable receipt file disappeared from the reading. With the failed-at-HEAD receipt corrupted, the reading looked like a clean pass; only `checks.problems: 1` in the JSON said otherwise | material | **Fixed.** Gap `receipt-files-unusable` and a text line. Unit and tier-1 tests write a damaged file; the mutation fails them |
| 2 | "Stale" was a gap only when no check at all was at HEAD, so a trivial command passing at HEAD hid that the real test was not rerun | minor | **Fixed.** Gap `stale-check` when any command's latest check is `head-differs` |
| 3 | With no authorisation, the text said `run [Pi's report] No run: nothing was sent`. That is not Pi's report, and the brief may have been handed over by hand. The operator's handoff and report were not shown | minor | **Fixed.** `[none]`, with "no send through the workbench was authorised". `handoff` and `outcome` lines are labelled `[operator]` |
| 4 | Provenance labels were coarser than the data: Pi's report sat under `sent.source: "observed"`; the check line did not say its link to the attempt is the operator's; `accepted` named an actor that the history does not record | minor | **Fixed.** A separate `pi` section (`source: "pi-report"`), `checks.linkedBy: "operator"` and a label on every check line, and `movedToDone`. Not-established also says the records are unsigned local files |
| 5 | "Before the authorisation" used only the check's start, so a check that ran through the send counted as before, and the gap text overclaimed | minor | **Fixed.** `authorization: before / overlapping / after`, from start and end. The gap fires only when every check *ended* before. The text is softened |
| 6 | The kill test could kill the workbench or the PTY instead of Pi when `ENDO_PI_EXECUTABLE` is the real `cli.js` path (reproduced) | minor | **Fixed.** Those are excluded by what they are, and exactly one Pi must be found. Rerun with the `cli.js` path: passes, no survivors |
| 7 | The text labels were not pinned; the `task-words-changed` gap, a two-`done` history and the `<` boundary were untested | minor | **Fixed.** The first ten lines of one fixture are asserted exactly, and there are new cases for each. The mutations are in §4 |
| 8 | "4 requests" was unasserted | nit | **Documented.** It was observed in one kept run, and the test asserts only "more than 0" |
| 9 | The CLI header did not list `evidence` | nit | **Fixed** |
| 10 | The records are not read as one snapshot; `readAtMs` was taken last; with an unreadable task file the tree reads unavailable without Git being asked | nit | **`readAtMs` is now taken first; the rest is documented** in the design's guarantees |
| 11 | The "no private content" bullet left out the operator's recorded report note, argv, session id and paths | nit | **Documented.** These are the same fields the existing readers print |
