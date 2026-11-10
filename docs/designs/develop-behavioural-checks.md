# DEVELOP-BEHAVIOUR-001: behavioural checks

*   **Status:** implemented on `feat/develop-behaviour` (stacked on DEVELOP-PROVENANCE-001, #140). Not merged.
*   **Date:** 2026-11-10
*   **Builds on:** verification receipts ([develop-verification-receipts.md](develop-verification-receipts.md)), verification plans
    ([develop-verification-plans.md](develop-verification-plans.md)).
*   **Scope:** a planned check may declare what its command should *do* (exit code and exact standard output). Endophasia records a digest
    of every check's output, keeps the output itself only when asked, and reads a behavioural check's receipts by what the command did.
    No new way to run anything.

## 1. The problem

A receipt says *"`node calc.mjs 2+3*4` exited 0 at 2a8855e"*. For a CLI that is almost no evidence: a calculator that evaluates left to
right exits 0 and prints `20`. The ledger then showed **"Passed at HEAD"** for a criterion ("multiplication binds tighter than addition")
that the program plainly violates. Exit code zero was standing in for correct behaviour, which is what the brief asked us not to do.

What the operator actually wants to know for a behavioural criterion is: *did the real program, run by Endophasia at this commit, produce
the output I said it should?*

## 2. Decision

**The expectation is part of the plan; the comparison is derived; the output is evidence only when the operator keeps it.**

| Piece | Where | What it holds |
| :-- | :-- | :-- |
| Expected behaviour | the plan, in the prepared attempt (`expect: {exitCode, stdout}` on a planned check) | The operator's oracle, frozen before the attempt is sent and rendered into the brief the operator approves |
| Observed output digest | every receipt, `endo.develop-receipt.v1` `output.stdout.sha256` | SHA-256 of every byte of standard output that was read (null when not read whole, and then the receipt is inconclusive) |
| Observed output text | the receipt, only with `endo attempt check --keep-output` | Its first 8 KiB as UTF-8, cut at a character boundary; `not-text` when the bytes are not UTF-8 |
| Behavioural outcome | derived on every read, `endoBehaviourOutcomeV0` | `passed` iff exit code = expected and digest = SHA-256(expected); `inconclusive` if the receipt is, or no digest; else `failed` |
| Where it differs | derived for display, `endoFirstDifferenceV0` | The first differing line of expected vs. kept text. Points; never decides (the digest decides) |

For a behavioural check, the ledger's existing machinery (latest at HEAD, `mixed` when runs at HEAD disagree, `stale`, `tree-changed`,
`otherCommit`) runs unchanged over the behavioural outcome instead of the exit status. So everything DEVELOP-VERIFY-001 established about
re-running until green, staleness and unknown-is-not-failure holds for behaviour too.

### Why this and not something else

| Alternative | Why not |
| :-- | :-- |
| **`endo attempt check --expect-stdout FILE`** (expectation given at check time, verdict stored in the receipt) | The oracle could be written after seeing the output, which is exactly the fitting the brief warns about. And it duplicates the plan: the operator already declares per-check intent there. Keeping the comparison derived also means a forged "matched" flag cannot exist: there is no flag. |
| **Always keep output** | Output can hold secrets (tokens printed by a misbehaving CLI, `.env` contents). A digest compares without storing; the operator opts in to storing, per run, and the CLI says what will be stored before it runs. |
| **A general evidence-artifact store** (files, screenshots, traces beside receipts) | No consumer yet beyond stdout. Kept output fits inside the write-once receipt (its bound grew from 64 to 128 KiB), so integrity, retention and association with one check come for free. A separate artifact store is the right step when a second evidence type (a screenshot, an HTTP trace) arrives. |
| **Normalising output** (trim, CRLF, whitespace) | Any normalisation is a policy someone has to trust. Byte-exact comparison is simple and auditable. An expected output may not contain `\r`, so CRLF-printing programs cannot be declared yet (stated in §7). |
| **Running planned checks from the plan by name** | Still cut, for DEVELOP-VERIFY-001's reason (§4). |
| **Comparing stderr too** | Stderr is where diagnostics, warnings and timings go: comparing it makes checks brittle for no gain in the first slice. Its byte count is still recorded. |

### Why a CLI first

The repository's receipts already run one process under supervision and observe Git around it. A CLI's stdout is the cheapest behaviour
to make deterministic and inspectable with that machinery: no server lifecycle, no browser, no ports. A parser or formatter check is the
same shape (`node bin/parse.mjs 'f(a, b,)'` printing a tree). An API or browser behaviour needs a new process shape (a server that is
started, probed and stopped) and a new evidence type; that is a later slice, and it would be the first consumer that justifies an
artifact store.

## 3. What is new, and what was already there

| Already there (reused unchanged) | New |
| :-- | :-- |
| `endo attempt check -- <argv>`: operator-typed argv, no shell, PATH resolution skipping the tree, process group with keeper, timeouts, interruption, escaped-process detection, Git observed before and after | `--keep-output` (a flag before `--`; nothing after `--` is ever read as a flag) |
| Receipt verdict from exit status, re-derived by the validator | v1 `output.stdout`; validator checks kept text against byte counts and bounds; the store checks kept text against its digest |
| Plan in the prepared attempt, rendered into the brief, covered by the approval's digest | `expect` on a planned check, and the brief's "What the operator expects it to do" lines |
| Ledger states and the criterion rule | The behaviour rule feeding them for behavioural checks |
| The page's closed gate re-deriving the ledger | The gate re-derives behavioural outcomes from each listed receipt's exit code and digest |

## 4. Execution authority and trust boundaries

| Question | Answer |
| :-- | :-- |
| Who selects the executable and arguments? | The operator, typing them after `--`. Unchanged. Nothing is run from the plan, the expectation, a receipt, the brief or an agent. |
| Who authorises execution? | The operator, by running `endo attempt check` in their terminal. No page, event, agent completion or run end triggers a check. |
| What can change the expectation? | Anyone who can write the store (as for every DEVELOP record). The expectation sits in the prepared attempt; an authorised attempt whose plan was edited after approval reads "brief differs" through the existing digest check. It detects edits; it does not resist someone who can rewrite both. |
| What capabilities does the checked code get? | Unchanged from receipts: the operator's permissions and environment (minus Git redirection variables), its own process group, a time limit, an output limit. The risk notice says so before it runs. |
| Containment and cleanup | Unchanged: `ProcessGroupV0` (a keeper leads the group and kills it if `endo` dies), SIGTERM then SIGKILL, stray and escaped processes recorded. The digest is null and the receipt inconclusive when a process outside the group held the pipe. |
| Concurrent activity | Unchanged: the clean, committed binding and the second Git observation. A behaviour observed in a tree that changed during the check is inconclusive, never passed or failed. |
| Sensitive output | Hashed by default, stored only with `--keep-output`, which the CLI announces (`WILL BE STORED`) before the command runs. The page tells the operator to leave it out for a command that can print a secret. Kept text is made display-safe on the page (control, separator and direction characters become U+FFFD). |
| Is the oracle ground truth? | No. Every surface says "you declared": the expectation is the operator's statement of what the program should print. A wrong expectation produces a confident wrong verdict; the plan's "That a check addresses a criterion is your plan's statement" sentence still stands. |

## 5. The demonstration (real, reproducible)

`tests/develop-behaviour.test.ts`, "end to end", through the real CLI in a real Git repository; set `ENDO_DEMO_DIR` to keep the outputs.
A tiny calculator, `calc.mjs`, and a plan with two behavioural checks and one criterion left to judgment:

```json
{"checks":[
  {"name":"precedence","argv":["node","calc.mjs","2+3*4"],"shows":"2+3*4 is 14: multiplication first",
   "expect":{"exitCode":0,"stdout":"14\n"}},
  {"name":"rejects-garbage","argv":["node","calc.mjs","2+"],"shows":"an incomplete expression is refused, with nothing on stdout",
   "expect":{"exitCode":2,"stdout":""}}],
 "criteria":[
  {"text":"Multiplication binds tighter than addition","checks":["precedence"]},
  {"text":"Malformed input is still refused","checks":["rejects-garbage"]},
  {"text":"The change is small and readable","checks":[]}]}
```

**Negative control.** The committed calculator evaluates left to right. `endo attempt check --keep-output -- node calc.mjs 2+3*4` prints
`20`, **exits 0**, and its receipt says so (`Observed check passed`, `output.stdout = {keep: "text", text: "20\n", sha256: 5378…7aa3}`).
The ledger does not:

```
  check     [observed; linked to this attempt by the operator] node calc.mjs 2+3*4: Observed check passed at 12333c7c0d46; Recorded at this working tree's current HEAD (exit status only: the plan reads this command by its behaviour, below)
  planned   [observed] precedence ["node","calc.mjs","2+3*4"]: Failed at HEAD (12333c7c0d46, latest failed)
  behaviour [plan: expected; observed] expected exit 0 and 3 byte(s) of output; observed exit 0, 3 byte(s), output different; first difference at line 1: expected "14", observed "20"
  planned   [observed] rejects-garbage ["node","calc.mjs","2+"]: Passed at HEAD (12333c7c0d46, latest passed)
  behaviour [plan: expected; observed] expected exit 2 and 0 byte(s) of output; observed exit 2, 0 byte(s), output the same
  criterion [plan: precedence] 1. Multiplication binds tighter than addition: A planned check failed at HEAD
  criterion [plan: rejects-garbage] 2. Malformed input is still refused: Planned checks passed at HEAD
  criterion [plan: your judgment] 3. The change is small and readable: Your judgment
  gap       At least one planned check has no passing result at the current HEAD of this clean working tree (...)
```

**The fix.** Commit a calculator that respects precedence, run the same two commands (no `--keep-output`):

```
  planned   [observed] precedence ["node","calc.mjs","2+3*4"]: Passed at HEAD (b67987d08396, latest passed); at another commit, 12333c7c0d46: failed
  behaviour [plan: expected; observed] expected exit 0 and 3 byte(s) of output; observed exit 0, 3 byte(s), output the same
  criterion [plan: precedence] 1. Multiplication binds tighter than addition: Planned checks passed at HEAD
  criterion [plan: rejects-garbage] 2. Malformed input is still refused: Planned checks passed at HEAD
  criterion [plan: your judgment] 3. The change is small and readable: Your judgment
```

The `rejects-garbage` receipt "failed" (it exited 2), and that is not a gap: its behaviour is the declared one. A mutation that makes the
ledger ignore expectations (read every receipt by exit status) fails this test.

## 6. The page

Each behavioural check in "Checks Endophasia observed" shows, under the existing planned-check row:

*   **"You declared it should:** exit 0 and print exactly 20 bytes on standard output (compared byte for byte; standard error is not
    compared)", with the expected output one disclosure away.
*   **"Observed at <commit>:** exit 0, 29 bytes; the output differs from the one declared", and, when output was kept, the first differing
    line (`line 2: expected "  args: a, b", observed "  args: a, b, <empty>"`) and the kept output one disclosure away. Without kept
    output: "run the check again with --keep-output to see where it differs".
*   The command to copy includes `--keep-output`, with one sentence on what it stores.
*   In "Every check recorded", a receipt of a behavioural command keeps its exit-status label and adds "For the planned check `cli`: its
    exit code or output is not the one declared. The label above is its exit status."

Screenshots (synthetic receipts over the real built page, `tests/endo-studio-tasks-browser.test.ts`, "a behavioural check"): the negative
control at [1440](../images/develop-behaviour-instrument-failed-1440.png) and [390](../images/develop-behaviour-instrument-failed-390.png);
output not kept ([1440](../images/develop-behaviour-instrument-not-kept-1440.png)); the fix
([1440](../images/develop-behaviour-instrument-passed-1440.png), [Field 1440](../images/develop-behaviour-field-passed-1440.png)).

## 7. Limitations

*   **The oracle is declared.** A wrong expectation gives a wrong verdict, confidently. The page and brief call it the operator's.
*   **The agent sees the expectation** (it is in the brief, as DEVELOP-VERIFY-001 decided for checks). An agent can special-case
    `2+3*4`. Several examples per criterion make that harder; withholding a check from the brief remains a listed follow-up.
*   **One process, stdout only.** Inputs are the argv (and an empty stdin). No stdin fixture, no files the program writes, no stderr, no
    server, no browser.
*   **No `\r` in an expectation**, so a program that prints CRLF cannot be declared yet; byte-exact means locale, colour and timing in
    output make a check flaky (and then `mixed`, which is visible).
*   **Kept output is at most 8 KiB.** The digest covers everything; the pointer to the first difference may fall past the kept part
    ("the kept output is cut").
*   **The attention overview reads exit status.** Its cross-task list of failed or inconclusive checks does not read plans, so a
    behavioural check that exits 0 with the wrong output shows there as an observed pass (labelled, as everywhere, "Observed check
    passed"). The Task view and `endo attempt evidence` read behaviour. Making attention plan-aware is a follow-up.
*   **An older build** refuses a plan with `expect` (closed keys) and a v1 receipt; it reports them as invalid files, never as passes.

## 8. Tests

`tests/develop-behaviour.test.ts` (14): the plan's expectation invariants and their refusals; the brief's wording; v1 receipt invariants
(and v0 still read); the store refusing kept text whose digest is not the recorded one; UTF-8 cut at a character boundary and `not-text`;
the runner's digest across chunks, the kept bound, no digest past the output limit; the behaviour rule's table, with the page's copy held
equal over every combination; the first-difference pointer and its page copy; end to end through the real CLI as in §5, with six forged
views each refused by the page's gate. `tests/endo-studio-tasks-browser.test.ts` ("a behavioural check", Instrument and Field at 1440,
Instrument at 390): the real built page shows the negative control as failed while the receipt says it exited 0, the not-kept state, and
the fix.

## 9. Next

1.  A second behaviour shape, chosen when needed: a stdin fixture (operator-supplied file, digested into the receipt), or a server probe
    (start, request, stop), which is where a separate evidence-artifact store starts to pay.
2.  Plan-aware attention (§7).
3.  Running a planned check by name from a page request with terminal approval (the follow-up DEVELOP-VERIFY-001 named), now worth more
    because the expectation travels with it.
