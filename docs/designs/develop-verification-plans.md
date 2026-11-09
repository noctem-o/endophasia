# DEVELOP-VERIFY-001: verification plans and the acceptance ledger

*   **Status:** implemented on `feat/develop-verify` (one fresh-context adversarial design review, resolved before the build; see
    [Review](#review))
*   **Date:** 2026-11-09
*   **Builds on:** work attempts ([develop-work-attempts.md](develop-work-attempts.md)), verification receipts
    ([develop-verification-receipts.md](develop-verification-receipts.md)), attempt execution
    ([develop-attempt-execution.md](develop-attempt-execution.md)), attempt evidence ([develop-attempt-evidence.md](develop-attempt-evidence.md))
*   **Scope:** one vertical slice. When preparing an attempt, the operator states which acceptance criteria will be checked by which
    command and which are left to their judgment. The agent receives that in the brief. Endophasia then reads the receipts it already
    records against that plan and shows, per criterion, what has been observed at the current HEAD and what has not. No new way to run
    anything, no automatic check, no gate, no acceptance.

## 1. The problem, from the operator's side

DEVELOP already answers *"what did Endophasia observe when I ran a check, at which commit, and does it still apply?"* (receipts), and
*"was this attempt sent, and what did the agent's runtime report?"* (execution). WORK-CYCLE-001B and the REVIEW-PILOT-001 run left a
different question unanswered:

> Of this task's acceptance criteria, which has something observed behind it at the commit I am about to accept, and which rests on
> my judgment alone?

In REVIEW-PILOT-001 the task had four criteria. One (`node --test` exits 0) is decided by a check. Three are not: documentation, "inputs
without `d` behave as before", and "no new files or dependencies". Nothing in Endophasia recorded that split. A receipt says *"`node --test`
exited 0 at 7054efe"*, and the page then showed "Observed check passed" in the observed colour near the top of the attempt. The three
criteria no check covers were visible only by re-reading the acceptance text inside the brief. The evidence was correct; its *coverage*
was invisible, so a passing check read as more than it shows.

Two smaller frictions point the same way:

- The agent was never told how its work would be checked. pstack's first rule ("state the finish condition up front") was absent: the
  brief carried acceptance prose, not the commands that would judge it.
- Within an attempt, the page ordered information by record type (execution, brief, commands, receipts), not by the operator's question.
  The receipts, which are the evidence, sat below a 14-row brief.

Whether the pilot's operator would have *asked* for this is the pilot's open question (its review is still pending). This slice adds no
authority and no new observation, and leaves every existing record's meaning unchanged, so it can be judged in that review and dropped
without migration if it does not help.

## 2. What exists and is reused unchanged

| Mechanism | Reused for |
| :-- | :-- |
| Receipts (`endo attempt check -- <argv>`): supervised process group, clean-committed binding, before/after observation, closed limitations, write-once storage | **Every observation in this slice.** No new runner and no new kind of check record. A planned check produces an ordinary receipt, run by the operator with the argv typed after `--`, as before. |
| The receipt relation (`at-head`, `at-head-changed`, `head-differs`, `other-worktree`, `other-repository`, `unavailable`) | Whether a check's result applies to the tree being read now. |
| Check identity from `endoLatestChecksV0`: one argv, in one worktree, of one repository, and the same "latest receipt" order (`endoReceiptLaterV0`, now exported and shared) | Matching receipts to a planned check. The plan gives an argv a *name*; it never widens what counts as the same check. |
| The prepared attempt: write-once, frozen task words, brief a pure function of the record | Carrying the plan. Because the brief renders the plan, a workbench authorisation's `briefSha256` covers it, and the existing "brief differs" reading notices a plan edited after approval. |
| `endo attempt evidence` and its gap list | The terminal reading of the ledger. |
| The page's closed wire gate with re-derived verdicts | The ledger's gate (§5). |

## 3. Decision

**A verification plan is part of the prepared attempt** (`endo.develop-attempt.v1`, brief `endo.develop-brief.v1`). It is a short list
of named checks, each an exact argv plus the operator's sentence of what it shows, and the attempt's acceptance criteria, each naming the
checks that address it, or none ("your judgment").

**The acceptance ledger is derived, never stored.** It is a pure function (`endoAcceptanceLedgerV0`) of the plan, the attempt's receipts
and the working tree being read. For each planned check it gives the result at the current HEAD, or why there is none, plus the latest
result at another commit. For each criterion it gives a state that follows from its checks by one rule (`endoCriterionStateV0`).

**Execution is unchanged.** A check still runs only from the argv the operator types after `--`. The page shows, for each planned check
that has not passed here, the exact command to copy, quoted for a POSIX shell.

### Alternatives considered

| Option | Why not (now) |
| :-- | :-- |
| **`endo attempt check --check <name>`** (run a planned argv by name) | Drafted, then **cut after review** (§Review B1). It reads an argv from a store record, which reverses the receipts rule that nothing is run from a record (develop-verification-receipts.md, "Execution boundary"). Most attempts (CLI handoffs) have no tamper binding at all. Even a workbench authorisation's `briefSha256` sits in the same writable store, so it detects accidental edits and does not resist anyone with store access. Copying the shown command gives the same exact argv without that reversal. |
| **A repository manifest** (`.endophasia/verify.json`, a `verify` script, package.json scripts) as the source of checks | The change being verified could rewrite the checks that judge it. A repository's commands are still *run* (`npm test` executes repository code, and the receipt says so), but *which* command decides a criterion stays the operator's statement, outside the tree. |
| **A project-level check registry plus a mutable per-task mapping** | Reuse across attempts, at the cost of a mutable record whose history must be versioned and related to each receipt, and a plan the agent never sees unless the brief reads a second file. A plan file can be reused by passing it again. |
| **`--plan-from <attempt>`** | Drafted, then cut after review (M3). Criteria are task-specific, and copying from a record copies whatever someone wrote there. |
| **Parsing the task's acceptance text into criteria** | Inference over prose: a bullet split would decide what a criterion is. The operator decides. |
| **Recording "criterion met"** (by Endophasia) | Nothing observed establishes that a command addresses a criterion; the plan *declares* it. The ledger never says "met": its best state is "planned checks passed at HEAD". |
| **A verification workflow DSL** (steps, conditions, policies, automatic runs) | Rejected by the receipts slice for the same reasons: it moves *what runs and when* into configuration. |
| **Running planned checks automatically when the run ends** | New execution authority triggered by an agent's lifecycle. Out of scope; see §8. |
| **Asking a second model to judge the criteria** | A model reading the diff and the agent's report is another opinion, not an observation. It may be worth having as a labelled opinion (§8), never inside the ledger. |

## 4. The plan

```ts
// in endo.develop-attempt.v1, beside the v0 fields; brief: "endo.develop-brief.v1"
verification: {
	checks: { name: string; argv: string[]; shows: string }[];   // 0–8
	criteria: { text: string; checks: string[] }[];               // 1–12; [] = the operator's judgment
}
```

Invariants (`validateEndoVerificationPlanV0`; anything else is refused, so an invalid plan cannot be written or read):

- a check `name` matches `^[a-z][a-z0-9-]{0,31}$` and is unique;
- an `argv` follows the receipt's own rule (`checkEndoReceiptArgvV0`: 1–64 arguments, ≤ 8 KiB, well-formed, no NUL), so any planned
  check can be recorded. Each argument is also at most 400 characters and contains no character the page would replace (C0/C1 controls,
  line and paragraph separators, bidirectional marks). Nor may it hold U+FFFD or U+2026, the two characters the page's display-safe form puts into a receipt's argv, so a listed receipt's argv equals a planned argv only when it *is* that argv, and the page can count a check's receipts itself. So every argv is shown exactly wherever it appears, and two planned checks can
  never look alike. No two checks share an argv: identity is the argv, and two names for one check would be ambiguous;
- every check is named by at least one criterion; every name a criterion gives is a check of the plan, at most once;
- `text` and `shows` are one trimmed, non-blank line of at most 280 characters (the task protocol's `note` rule);
- the plan, as JSON, is at most 16 KiB. The prepared record's bound grows from 80 to 112 KiB so that the largest v1 record fits. A test
  writes one.

**Version boundary.** `schemaVersion` v1, `brief: "endo.develop-brief.v1"` and `verification` always come together, and every other mix is
refused (tested). An attempt prepared without a plan is still `endo.develop-attempt.v0` with brief `v0`, byte for byte as before, so no
existing record, brief, digest or authorisation changes meaning. The authorisation record's schema is unchanged.

### The brief

A v1 brief is the v0 brief with one more section, before "What to report back":

```
## How the result will be checked
The operator's verification plan. After your work, the operator may run these checks through Endophasia, in a clean, committed
working tree, and judges the criteria that no check addresses. Your own report of running them is not taken as their result.

Check `unit`, the command as an argument list:
```text
["node","--test"]
```
What the operator says it shows:
```text
the unit tests pass
```

Criterion 1:
```text
node --test exits 0 at a clean commit
```
Checked by: `unit`.
```

Endophasia's words are outside the fences; the operator's are inside, as everywhere in a brief. Check names are validated identifiers.

**Telling the agent the check is a choice with a cost** (review M4). An agent that knows `node --test` decides a criterion can work toward
the command rather than the criterion: delete a test, weaken an assertion, or make a script exit 0. Receipts already say that "the
command decides what is checked". The plan does not make that worse for a determined agent, which can read the repository's CI anyway.
It does make the target explicit, which is also what lets an honest agent check its own work against the operator's finish condition.
The defence is the one the ledger is built for: criteria that need judgment stay visibly the operator's, and the diff remains the thing
to read. An option to keep a check out of the brief is listed in §8.

### CLI

```sh
endo attempt prepare … --plan-file plan.json   # {"checks":[{"name","argv","shows"}],"criteria":[{"text","checks"}]}
endo attempt check --attempt A -- node --test  # unchanged: the receipt of this argv is the planned check `unit`
endo attempt evidence --attempt A              # now with the plan and the ledger
```

`--plan-file` takes a regular file of at most 16 KiB (the same reader as `--objective-file`). It is parsed as JSON and validated whole,
and refused with the validator's reason before anything is written.

## 5. The ledger

Only the attempt's own receipts count: a receipt is linked to an attempt by the operator who ran it (`attempt-link-is-operator-declared`).
For each planned check, *here* means its receipts with exactly its argv, in the working tree being read (any other worktree or repository
is a different check):

| Check state | When |
| :-- | :-- |
| `passed` / `failed` / `inconclusive` | its latest receipt is at the current HEAD, the tree is clean now, and **every** receipt of it at this commit had that outcome |
| `mixed` | its receipts at the current HEAD, the tree clean now, do not all agree. The latest is shown and the rest counted (`atHead`), so re-running a flaky check until it passes cannot read as a clean pass (review M1) |
| `tree-changed` | its latest receipt is at the current HEAD, but the tree has uncommitted changes now. Its outcome is shown ("It failed at this HEAD; the working tree has changed since, so it is not counted"), never counted |
| `stale` | its receipts here are only at other commits: not run at the current HEAD |
| `elsewhere` | it has receipts only in another worktree or repository, never compared |
| `not-run` | no receipt has its argv |
| `unavailable` | the tree being read could not be observed, **or the attempt's receipts could not be read**. An unreadable directory is never "not run" |

Each check also carries `otherCommit`: the latest receipt *here* at a commit other than the current HEAD. It is not necessarily earlier
in time, and not necessarily an ancestor. The page says only "at another commit its latest run failed; what accounts for the difference
is not observed". The change between the commits, flakiness, the inherited environment or ignored files could each explain it (review m1).
The draft's clock-based "before the authorisation" flag was dropped: it depends on wall clocks, which 001B §5 item 8 already records as
able to mislabel.

Each criterion's state follows from its checks, in this order (`endoCriterionStateV0`):

| Criterion state | Label | When |
| :-- | :-- | :-- |
| `judgment` | Your judgment | it names no check |
| `failed` | A planned check failed at HEAD | any check `failed` |
| `inconclusive` | A planned check was inconclusive at HEAD | any `inconclusive` or `mixed` |
| `passed` | Planned checks passed at HEAD | every check `passed` |
| `unavailable` | Not compared | any `unavailable` |
| `not-shown` | Not shown at HEAD | otherwise: a check not run here at this commit, stale, elsewhere, or the tree changed since |

No label or sentence says "met", "verified", "satisfied" or "done"; a test pins that. Every criterion row carries the sentence "That a
check addresses a criterion is your plan's statement; nothing observed establishes it." Receipts whose argv matches no planned check are
counted as `unplanned` and listed with every other receipt.

A damaged receipt file is not a receipt, so the ledger cannot count it. Where one exists, the acceptance block says that a later result
of a planned check may be among the files that could not be read. The evidence reading already has the gap `receipt-files-unusable`.

### Where it is read

- **The page** (the live workbench and `endo workspace open`): `endo.develop-attempts-view.v3` adds `verification` to each attempt,
  holding the plan and the ledger, or null without a plan. The page's gate (`verificationCoherent`) re-derives each criterion's state with
  its own copy of the rule; a contract test holds the copy equal to the protocol's over all 820 combinations of up to three check states.
  The gate also requires the following, and refuses the body whole otherwise:
  - each check's `current` receipt to be in this attempt's list, by id, with the same argv, commit, outcome and times, at the relation its
    state needs (`at-head` for a result or `mixed`, `at-head-changed` for `tree-changed`);
  - `otherCommit` to be a listed `head-differs` receipt;
  - the counts at HEAD, each check's `runs` and the `unplanned` count to equal what the gate itself counts from the listed receipts
    (Codex, #139), and to agree with the state: a single outcome for a result, a disagreement for `mixed`;
  - `stale`, `elsewhere`, `not-run` and `unavailable` to name no receipt at HEAD;
  - all checks or none to be `unavailable`;
  - names to be unique and resolved, and argv to be distinct and showable.
- **`endo attempt evidence`** (`endo.develop-attempt-evidence.v2`): `verification` (`source: "operator-plan"`), one line per planned
  check and per criterion in the text reading, and one new gap, `planned-check-not-passed-at-current-head`. "Criteria left to judgment" is
  not a gap; it is how the plan was written (review r3). An attempt without a plan reads `plan [none]` and gains no gap, so the readings of
  earlier attempts keep their gap lists.

## 6. The page

The attempt is reorganised around the operator's questions, in this order, with the rest one disclosure away:

1. **Summary line** (closed): state, objective, sent chip, and, with a plan, the criteria counted by state:
   `4 criteria at HEAD: inconclusive 1 · not shown 1 · checks passed 1 · your judgment 1`. These are counts of the plan's own criteria,
   ordered by urgency; nothing is summed into a score. Without a plan, the newest receipt is shown, as before.
2. **Acceptance** (with a plan): one row per criterion, with its words, its state and, for each of its checks, the check's state at HEAD.
   A coloured rule marks failed (fault), inconclusive or not shown (attention) and passed (observed). Judgment and unavailable get no
   rule. When the task's acceptance words have changed since the plan was written, it says so. Without a plan: one sentence saying none was
   declared, so which criteria a check addresses is not recorded.
3. **Checks Endophasia observed**: each planned check with its exact argv (as a JSON list), the operator's sentence, its state, any
   disagreement at this commit, its result at another commit, and, unless it passed here, the command that runs it, wrapped so it can be
   read and selected. Then every receipt, as before, under "Every check recorded for this attempt (N) · M not in the plan". Without a
   plan, the receipts are shown open, as before.
4. **What happened**: the execution, the handoff and the outcome, unchanged, and the request control on the live workbench.
5. **Brief**, under a disclosure: open while the attempt is only prepared and has no checks (the operator's next act is to copy it),
   folded once there is evidence to read. It is unchanged, still copyable and still what was approved.

Colour stays reserved for condition (docs/develop-project-review.md §6). In Field the chips are quiet, as all chips there are, and the
left rule carries the state.

## 7. Trust boundaries

| Concern | Position |
| :-- | :-- |
| Who decides what runs | Unchanged. The operator types the argv after `--`. Nothing is run from a plan, a record, the repository, an agent message or model output. The plan is matched against receipts after the fact. |
| The agent can write the store (it runs unsandboxed, as the operator) | As for every DEVELOP record (`unsigned-local-record`), the plan is a local file. An authorised attempt whose plan was edited after approval reads "brief differs" through the existing digest check. That detects edits; it does not resist anyone who can write the store, who could rewrite both. The page shows each planned check's exact argv beside its result, so a planned `true` is visible as `true`. |
| The command is repository code (`npm test`) | Unchanged from receipts: stated in the risk notice and the receipt's limitations. A plan does not make a check trustworthy; it records what the operator meant it to show. |
| Coverage is declared, not observed | Said on every acceptance block and in the brief. The ledger never upgrades a declaration into a result. |
| Re-running until it passes | `mixed`, counted; never `passed` while a disagreement at this commit is recorded. |
| A stale result | Never carried to a new commit, including one with the same tree. `tree-changed` is not counted as passed or failed. |
| Unknown is not failure | `unavailable` and `not-run` are their own states, never `failed` or `passed`. Unreadable receipts are `unavailable`, never "not run". |
| Read-only surfaces | No new route, no write, no execution. The attempts view gains a field. The page still cannot run, re-run or request a check. `endo studio` gains nothing. |

## 8. Not in this slice, and why

- **Running planned checks from the page, or when a run ends.** It is the obvious next step and the most consequential: execution
  authority triggered by a browser or an agent lifecycle. The candidate model is attempt dispatch's: the page *asks*, and the attached
  terminal shows the exact argv and approves it with a phrase. That keeps argv provenance with the operator without a new route that runs
  anything.
- **Output as evidence.** Receipts keep byte counts, not output. For behavioural checks, such as a CLI's real output, the output *is* the
  artefact an operator wants to inspect. Keeping it needs a privacy rule (it can hold secrets) and a bound.
- **Withholding a check from the brief** (review M4): a per-check flag. Wait for a review that wants it.
- **Recording the operator's per-criterion judgment, bound to a commit.** It would answer 001B item 4 ("which revision did the operator
  decide on") per criterion. It is a new operator record with its own staleness.
- **Before/after observation of the execution window** (001B approach 3). Still worth designing. The ledger's `otherCommit` already gives
  the before/after *check* comparison an operator most needs for a criterion.
- **An independent model review**, as a labelled opinion beside the ledger, never inside it.

## 9. Testing

`tests/develop-verification.test.ts` (27 tests):

- **The plan:** each invariant refused, including bidirectional, separator and newline characters, a 401-character argument, an unnamed
  check, a duplicate argv and a 16 KiB overflow.
- **The record:** v0 unchanged (no `verification` key on disk, no plan section); v1 round-trips, and its brief carries the plan in place
  with exact fences; a changed plan gives a different brief digest; every version, renderer and plan mix is refused; an invalid plan writes
  nothing; the largest v1 record fits its bound.
- **The ledger:** every check and criterion state; exact-argv identity (four near misses, all unplanned); a later run at another commit
  never hides HEAD; another worktree and another repository; a changed tree with a pass and with a failure; an unobservable tree;
  unreadable receipts, in the view and in the evidence reading; unplanned receipts.
- **The contract:** the page's rule equals the protocol's over 820 combinations; labels and sentences are equal, and none says met,
  verified, satisfied, done or succeeded.
- **The gate:** seven real views in every state are accepted; twenty forgeries are refused, each starting from a view the gate
  accepts.
- **End to end, real Git and the real CLI:**
  - `--plan-file` refusals (not JSON, a check named by no criterion, an argv that cannot be shown exactly), with nothing written;
  - a baseline failure, a fix commit, a pass at HEAD with the failure shown at the other commit, an unplanned receipt, then the second
    check;
  - the evidence JSON and text, and the workbench view through the page's gate;
  - after a new commit, every planned check `stale` and nothing carried forward;
  - the task file and every attempt record byte-identical throughout.

`tests/endo-studio-tasks-browser.test.ts`, "an attempt with a verification plan": the real built page, the live broker over a fake Pi
session, the real stores and a real Git repository, at 1440 px (Instrument and Field) and 390 px (Instrument). First, a tree with
uncommitted changes: the results are shown and not counted. Then a clean commit: a pass with a failure at the other commit, a
disagreement at HEAD, a check not run, and a criterion left to judgment. The test also checks:

- the exact summary text, the criterion and check states, and the exact copyable commands, shell-quoted;
- no "met"/"verified" wording, no store or working-tree path, no horizontal overflow;
- no agent traffic, no request that could run a check, and no status change;
- the brief folded once evidence exists.

The existing attempts, receipts, evidence, attention, workspace and browser suites pass, after only their schema strings changed to v3/v2
and two fixtures followed the larger bound and the extra text line.

**Mutations.** Nineteen deliberate defects were reintroduced one at a time against the new suite (a script in the PR description), and
each made at least one test fail:

| Area | Defects reintroduced |
| :-- | :-- |
| Ledger | a disagreement at HEAD ignored; argv matched by its joined text; another worktree counted as here; a changed tree counted as a result; a run at another commit winning over HEAD |
| Criterion rule | mixed not decisive; an unrun check counted with passes; the page's copy drifting from the protocol |
| Gate | the relation not required for a result; criterion states not re-derived; named receipts not resolved; coherence not called |
| Plan | an unsafe argument, an unreferenced check, or a duplicate argv accepted |
| Readings | the view or the evidence reading treating unreadable receipts as none |
| Record and brief | the plan not rendered in the brief; prepare dropping the plan and writing v0 |

The first run missed two, so tests were added for them: a pass claimed from a changed tree, and the evidence reading over unreadable
receipts.

**Not verified here:** a human operator using the ledger in a real review (REVIEW-PILOT-001's question), and a real agent receiving a v1
brief. No model was run for this slice.

### Screenshots (synthetic fixtures only)

The ledger at a clean commit ([1440](../images/develop-verify-ledger-1440.png), [Field 1440](../images/develop-verify-ledger-field-1440.png),
[390](../images/develop-verify-ledger-390.png)); the planned checks ([1440](../images/develop-verify-checks-1440.png),
[390](../images/develop-verify-checks-390.png)); the closed summary line ([1440](../images/develop-verify-summary-1440.png)); a tree with
uncommitted changes, where nothing counts ([1440](../images/develop-verify-tree-changed-1440.png)).

One defect seen in the 390 px screenshots is **not** from this slice and not fixed here. When the Task view is scrolled, the docked run
strip ("connected · run active · Request stop") draws over the content beneath it. The existing receipts screenshot at 390 px shows the
same overlap, and the run strip's CSS is untouched by this change.

## Review

A fresh-context subagent (a Claude Code `Agent`, general-purpose, read-only, no conversation history) reviewed the draft of this
document and the code it cites, adversarially, before the build. The repository's EGM substitute ([develop-verification-receipts.md](develop-verification-receipts.md#review))
used three personas; this slice used one combined zoom-out and adversarial brief. Codex reviews the PR on push.

| Finding (severity) | Disposition |
| :-- | :-- |
| **B1** `--check` runs an argv read from a writable store record, reversing the receipts rule; most attempts have no binding; "shown before it runs" meant printed, not confirmed | **Accepted; `--check` cut.** The page shows the exact command to copy instead. |
| **M1** "Latest at HEAD" hides earlier failures at the same HEAD (re-run until it passes) | **Fixed.** Per-check counts at HEAD and the `mixed` state; a criterion with a `mixed` check is `inconclusive`. |
| **M2** Plan criteria are a restatement, not tied to the task's acceptance text | **Partly.** The acceptance block is titled "criteria as listed in your plan" and flags changed acceptance words. The frozen task text stays in the brief (one disclosure away) rather than duplicated beside the ledger. |
| **M3** `--plan-from` copies task-specific criteria across tasks, and possibly tampered plans | **Accepted; cut.** |
| **M4** Telling the agent the judging command invites Goodharting | **Documented** (§4), with a possible per-check withholding flag in §8. |
| **M5** The slice runs ahead of the pending pilot; split the page into a second PR; drop the clock-based flag | **Clock flag dropped.** The split was **declined**: the assignment asks for vertical slices, and the page is the consumer that justifies the ledger. The PR's commits are ordered so the page change reads separately. |
| **m1** "earlier" overstates time and causality | **Fixed.** Renamed `otherCommit`; the page says the cause is not observed. |
| **m2/m3** Lookalike argv on display; bidi and separators accepted in a planned argv | **Fixed.** Planned arguments must be showable exactly (≤ 400 characters, no replaced character), so the page shows the argv itself, and the gate matches by receipt id and exact argv. |
| **m4** A failure in a changed tree reads only as "not shown" | **Fixed.** The check row says it failed at this HEAD and that the tree changed since. |
| **m5** Summary said "checks" while counting criteria | **Fixed.** "4 criteria at HEAD: …". |
| **m6** The receipt limitation "says nothing about acceptance criteria" sits oddly beside a ledger | **Fixed in wording.** Each acceptance block says the coverage is the plan's statement and a pass is an exit 0 at a commit. |
| **m7** The v0/v1 boundary was underspecified | **Fixed.** §4 states it; tests pin every mix. |
| **r1/r2** The ledger and gate were underspecified | **Fixed.** §5 states the rules the gate checks; tests cover each. |
| **r3** "Criteria left to judgment" is not a gap | **Accepted.** Neither it nor "no plan" is a gap. |
| Nits: "Status: implemented" while a draft; the digest exists only for workbench dispatch; the brief invites the agent to run `endo attempt check` | Status fixed; §2 and §7 say "a workbench authorisation's". Agent-run receipts would still be genuine observations, linked by whoever ran them; the brief says the operator runs the checks. |

### Codex review on the PR

The repository's automated Codex review of `219db6f27` left three findings. All three were reproduced by tests that fail without the fix
and pass with it, and all three were fixed in one push.

| Finding | Disposition |
| :-- | :-- |
| Opening a receipt from the attention overview opened only the attempt's first disclosure; with a plan, the receipt sits inside the nested "every check recorded" disclosure, so it was focused while hidden | **Fixed.** Every disclosure around the receipt is opened. One attention fixture attempt now carries a plan, so the existing overview-focus browser test covers it (it fails without the fix). |
| The gate compared a check's `atHead` counts only with each other: a body could drop a failure from the counts, rewrite the check and its criteria as passed, and be accepted beside the failing receipt | **Fixed.** The gate counts at-HEAD outcomes, `runs` and `unplanned` from the listed receipts and requires equality. Exact counting needed one more plan invariant: no U+FFFD or U+2026 in a planned argument (§4). The forgery test now re-derives every criterion consistently, as the reported payload did; it is accepted without the fix and refused with it. |
| The page's 64 000-character brief bound predates plans; fence expansion lets a valid v1 brief exceed it, and the page then refused the whole attempts view | **Fixed.** The bound is 160 000, with its derivation beside it. A test renders a worst-case v1 brief (every text a run of backticks, a plan of 15 898 bytes) over 64 000 characters and has the page accept it. |
