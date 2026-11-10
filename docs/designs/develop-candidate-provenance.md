# DEVELOP-PROVENANCE-001: what the working tree was around an attempt

*   **Status:** implemented on `feat/develop-candidate` (this PR). Not merged.
*   **Builds on:** attempt execution ([develop-attempt-execution.md](develop-attempt-execution.md)), verification receipts
    ([develop-verification-receipts.md](develop-verification-receipts.md)), verification plans ([develop-verification-plans.md](develop-verification-plans.md)).
*   **Scope:** observe the Git working tree at defined moments around an attempt, record each observation once, and relate them to the tree
    now and to the commits checks ran at. No new execution path, no authorship claim, no acceptance.

**Question.** An attempt was sent and a check passed. *Which code was that?* What did the working tree look like just before the agent
was sent off, what did it look like when its run ended, and is the commit that was checked the code that was there when it ended, or
something else?

**Answer.** DEVELOP now records **observations**: what Git reports about the launch directory at a moment (HEAD, branch, and for every
staged, unstaged, untracked or conflicted path the Git blob id and mode the working tree holds, never the content). The live workbench makes
one **just before it sends an approved attempt** and one **when the run that followed settles**; the operator can make one at any time with
`endo attempt observe` (for an attempt handed to another agent, or after the workbench stopped first). Each read of an attempt compares, by
blob id, the start of the frame with its end, the end with the tree **now**, and the end with **every commit a receipt ran at**. The page
shows that under the acceptance ledger, as "Working tree around this attempt".

The comparison that matters most: *the commit you checked holds the same content as the tree observed when the run ended* (or: it differs,
at these paths). That is a content fact Git can establish. It is not authorship.

## 1. What the words mean, and what they never mean

| Concept | Record | What it establishes | What it does not |
| :-- | :-- | :-- | :-- |
| Authorised attempt | `<attempt>.authorized.json` (existing) | The operator approved sending this brief to this session | That anything was sent |
| Observed execution | session log (existing) | What Pi reported: sent, accepted, run ended | That the agent did the work it reported |
| Observed state | an observation (new) | What Git showed of the tree at that moment | Who made it so |
| Change between states | derived on every read (new) | Which paths hold different content at two moments | Who changed them; that nothing else changed in between |
| Declared candidate | — (not built; see §8) | — | — |
| Checked revision | a receipt (existing) | The operator's command ran at this clean commit and exited so | That the criteria hold |
| Same content as observed | derived on every read (new) | The checked commit's tree equals the observed state, path by path | That the agent wrote that content |
| Accepted revision | the task's status (existing) | The operator's decision | Anything else |

None of these is collapsed into a single "candidate". The page never says "the agent changed", and a source test pins that.

## 2. Audit: what already existed

| Capability | Where | Finding |
| :-- | :-- | :-- |
| Hardened, read-only Git observation of one directory | `adapters/git/revision-observer.ts` | HEAD, tree, branch, "dirty" flags, reflogs, ignore-rule stamps; no repository programs, no locks, bounded. **Reused** and extended (§3). |
| A status parser with areas | `adapters/git/readonly-git.ts` | `parseStatusV2` already splits staged/unstaged/untracked/conflicted. **Reused.** |
| Write-once records under the store | `storage/write-once.ts`, the receipts store | **Reused**: the observations store is the receipts store's layout and protocol. |
| A send boundary with a binding | the workbench broker, `DevelopAttemptDispatchV0` | Authorisation is written after approval and before the send is recorded. **Reused**: the observation is taken between the gate and the binding, and bound to the same proposal and authorisation event. |
| The run's end | Pi's `agent_start` / `agent_settled` on the broker's live feed | Pi reports no run id; the first run after the send is the send's run (the existing execution reading uses the same rule). **Reused.** |
| "Current HEAD" for receipts | `endoReceiptCurrentV0` | A second, separate Git read. **Replaced**, where observations are read, by the same observation (§6). |

## 3. The observation

`<root>/develop/observations/<attempt>/<id>.json`, `endo.develop-observation.v0`, written once:

```ts
{ schemaVersion, id, attemptId, projectId,
  point: "before-send" | "after-run" | "operator",
  trigger: "send-approved" | "run-settled" | "workbench-closing" | "operator-command",
  recordedBy: "workbench" | "cli",
  binding: { proposalId, authorizationEventId } | null,     // the workbench's points: the send it was made for
  observer: { tool: "endo", version }, startedAtMs, endedAtMs,
  result: { state: "observed", repository, revision: { commit, tree, branch }, flaggedEntries, submodule,
            changes: [{ path, areas: [...], content: { kind: "file", mode, oid } | { kind: "absent" } | { kind: "not-read", why } }],
            truncated, complete, digest }
        | { state: "unavailable", reason } }
```

*   **A state** is HEAD's commit overlaid with what the working tree holds at each path Git lists as changed. The working tree's content
    wins over the index's (a path staged and then edited again is what is on disk). Ignored files are not part of it.
*   **Blob ids** are computed by this process from the bytes it reads (`sha1`/`sha256("blob <n>\0" + bytes)`, matching the repository's
    object format), so the record can be compared with any commit's tree without storing a copy, and without asking Git to write an object.
    A test checks them against `git hash-object`. A link's blob is its target name; a link is never followed.
*   **Never half-read.** A file over 16 MiB, past the 256 MiB budget, unreadable, not a regular file, or changing while read (its stamp
    differs before and after) is `not-read`, and the state is then **incomplete**. So is one with hidden index entries (assume-unchanged,
    skip-worktree) or a submodule, or with more than 1 000 changed paths. An incomplete state is shown, and never compared.
*   **Derived facts are re-derived.** `complete` and `digest` must follow from the state, or the file is invalid (as receipts' verdicts are).
*   **No contents.** Paths, modes and blob ids only. A test checks that a distinctive line written to the tree is not in the store.

## 4. When the tree is observed

| Point | Who | When exactly | If it fails |
| :-- | :-- | :-- | :-- |
| `before-send` | the workbench broker | after the operator's approval and the gate, **before** the authorisation is written and the send is recorded. The gate is checked again after it (a run that started meanwhile refuses the send; nothing is bound) | recorded as `unavailable` with Git's reason, or as `timed-out` (15 s). **The send is never refused because of it** |
| `after-run` | the broker | the first run that starts after the send, when Pi reports it settled (a turn of the loop later, so the settle is recorded first). Or, if the workbench closes with that run still open, `workbench-closing` | as above. A send Pi refused gets none |
| `operator` | `endo attempt observe` | whenever the operator runs it | refused with a reason; nothing written |

The observation runs Git only in the launch directory (the broker's) or the operator's chosen directory, under the revision observer's
fixed reads. It reads files; it runs nothing. It is **not** verification and is never triggered by an agent's request: the agent's run
ending only makes the broker *look*.

**Harness neutrality.** The two workbench points depend on what the Pi adapter observes (an approval boundary and a settle event). A
harness without them, or an attempt handed to another agent, uses the operator's observations; the reading says so (§5, basis `operator`)
instead of pretending to know when the work happened.

## 5. The reading

`endoAttemptProvenanceV0` (runtime/contracts/develop-observations.ts) picks the **frame** and says which:

| Basis | Start | End |
| :-- | :-- | :-- |
| `send-and-run` | the before-send observation bound to **this attempt's** authorisation | the after-run one bound to it |
| `send-and-operator` | before-send | the operator's latest observation after it (the workbench made none after the run) |
| `send-only` | before-send | none |
| `run-only` | none (an older build sent it, or it failed) | after-run |
| `operator` | the operator's first | the operator's latest. "They say nothing about when the work happened" |

Observations bound to another send are listed and never used. Then, by blob id: **between** (start → end, with HEAD's move and ancestry),
**now** (end → the reader's tree), **checked** (end → each commit a receipt of this attempt ran at, newest four), and **overlaps** (other
attempts of the project with an observation in the same working tree inside this frame). Every comparison is `same`, `different` (paths
and kinds: added, deleted, modified, mode), or `not-compared` with its reason. Git is run **only in the reader's own directory**, and only
when it holds the same repository; a test spies on it.

**What the operator reads** (CLI `endo attempt provenance`, and the page):

```
provenance: what Git showed of the working tree around this attempt; not who changed it
  start   2026-11-09T23:08:50Z  Just before the brief was sent: HEAD d7c24a3aa142 (refs/heads/main), no changes
  end     2026-11-09T23:14:02Z  When the run had ended: HEAD d7c24a3aa142 (refs/heads/main), 2 changed paths
  frame   just before the brief was sent, and when the run had ended
  between HEAD stayed at d7c24a3aa142
  between 2 paths differ: M a.txt, A b.txt
  now     read 2026-11-09T23:20:11Z; HEAD moved from d7c24a3aa142 to a59f004f1d07, 1 commit on from it; against the end: 1 path differs: A c.txt
  checked a59f004f1d07 (1 receipt) against the end: same content
  limit   Git's view at one moment: who or what changed the tree (the agent, you, an editor, a hook, another process) is not known.
  ...
```

## 6. A finding: two readings of "now" on one page

The brief asked whether a dirty Context panel beside "passed at HEAD" was a real inconsistency. **It is, in legibility, and it is
reproducible.** The Context panel's change list is one Git read with its own time ("read 21:35:53"). The attempts view is another, made
when the Task tab refreshes. In the merged screenshots the operator had committed in between: Context still showed HEAD `ee470f5` with ten
changes (its earlier read) while the ledger said "Passed at HEAD" for a receipt at `ff7ea3b`, the new HEAD, and did not say which HEAD it
meant. Each panel was right about its own read; the page did not make the two sources visible.

Fix, in this PR:

*   The attempts view (`endo.develop-attempts-view.v4`) carries **`head`: the commit, clean or not, and the read time** of the one reading
    every relation, ledger state and provenance "now" in it used. The page names it above the attempts: "Compared with HEAD ff7ea3ba6456 of
    this working tree, with nothing uncommitted, read 21:36 UTC. The Context panel is read separately." The ledger's clause says "against
    the HEAD named above".
*   Where observations are read, the receipts are compared with **the same observation** as the provenance's "now" (no second Git read).
*   The page's gate now **checks every receipt's relation against that HEAD** (`at-head` only at that commit and clean, `head-differs` only
    at another, `unavailable` only when nothing was read) and that provenance "now" is the same commit. A view that disagrees with itself
    is refused whole.
*   Reproduction: the browser test commits after the Context panel's read and refreshes only the Task tab; it asserts the named HEAD is the
    new commit. Before the fix the page named none.

The Context panel is deliberately not re-read with the attempts: it is the operator's own Refresh, and the time beside each says which is
which.

**And the narrow-screen overlap** (seen in #139's screenshots): at one column the run strip is `position: sticky`, and a later rule set its
background to `none` in Instrument, so the page scrolled visibly under it. It now has the panel's own ground; a browser test checks the
computed style at 390 px. One CSS rule.

## 7. Trust boundaries

| Boundary | Status |
| :-- | :-- |
| Execution authority | **Unchanged.** Nothing new runs a command. Observation reads files and runs fixed Git reads (no repository programs: `readonly-git.ts`). |
| The send | **Unchanged in authority.** The approval, the phrase, the binding and the dispatch order are as before; the observation sits between the gate and the binding and cannot refuse the send. If time passed, the gate is checked again (except the approval's expiry, which concerned the operator's latency, not ours). |
| Agent-triggered work | An agent's run ending makes the broker *observe*, read-only. It never triggers a check. |
| Paths from records | Never used to choose where to read: Git runs in the reader's directory, and a record's worktree is only compared. |
| Untrusted names | Paths are stored as Git printed them (validated: relative, no `..`, no NUL, well-formed) and shown with control and direction characters replaced (CLI and page; a test). |
| Privacy | No file content is stored; paths and blob ids are. A blob id of a short secret file could be brute-forced by someone with the store; the store is the operator's own, beside receipts that already name paths and commits. |
| Records are local, unsigned files | As for receipts: evidence for the operator, not an attestation. |

## 8. Alternatives considered

| Alternative | Why not (now) |
| :-- | :-- |
| **A "candidate" record the reading declares** (one revision named as the attempt's result) | It would collapse "observed at the end", "checked" and "accepted" into one claim the records cannot support. The reading relates them instead. A *declared* candidate (the operator names a commit) is a sensible later step if review needs a name; it would be one more labelled fact, not a merger. |
| **Snapshotting the tree as a Git object** (`git stash create`, a temporary index + `write-tree`) | Writes objects into the operator's repository and runs Git paths that consult more configuration. Blob ids computed here give the same comparison without writing anything. |
| **Storing diffs or file contents** | Sensitive, large, and not needed to answer "same or different, where". The page links to the existing Changes view for content. |
| **Continuous watching (inotify) during the run** | Would narrow "unchanged at two points" but not establish authorship, needs a daemon, and is platform-specific. The limitation is stated instead. |
| **Observing in the agent's sandbox or via the harness** | Harness-specific; Pi has no such hook. The observation is the broker's, about the launch directory it already owns. |
| **Blocking the send when the before-observation fails** | Provenance is evidence; making it a gate would let a slow or odd repository stop an approved send. |

## 9. Tests

`tests/develop-provenance.test.ts` (22), real Git throughout:

| Risk | Test |
| :-- | :-- |
| Blob ids wrong, areas merged wrongly, links followed, ignored files read | every area at once, a link, an executable, an ignored file: ids equal `git hash-object`; the link's target name; `debug.log` absent |
| A partial read passed off as a state | too-large (sparse 16 MiB + 1), a nested repository, assume-unchanged, an unreadable file: `not-read` / incomplete |
| The key claim is wrong | an uncommitted state equals the commit made from it; one more file is `different` at that path; a mode change alone is `mode` |
| Claiming when it cannot | incomplete, another repository, a commit Git lacks: `not-compared` with the reason |
| Forged records | closed keys; digest, completeness, order, oid length, relative paths, point/trigger/binding shapes |
| Service bounds | another repository refused; unknown attempt; per-attempt bound; a damaged file is a problem; a hung reader times out to `unavailable` |
| Frame selection | each basis; another send's observations ignored and noted; authorised with no before; unreadable; none |
| Git in a record's directory | a spy: only the reader's directory, and none at all for another repository or an unobservable now |
| Overlapping work | another attempt observed inside the frame is named; outside it is not |
| The broker | before-send bound to the authorisation event; a settle without a start is not the run; once only; a failed observation still sends; a run that starts during the observation refuses the send and binds nothing; a Pi refusal gets no after-run; closing with the run open records `workbench-closing` |
| The page | words equal to the protocol's; ten forgeries refused; relations checked against the view's HEAD; path display |

Browser (`tests/endo-studio-tasks-browser.test.ts`, "the working tree around an attempt"; Instrument and Field at 1440, Instrument at
390): the real built page over a live broker and real Git: an operator-framed attempt shows the two paths that differ; after a commit, a
receipt and one more edit, the checked commit reads "the same content as your latest observation" and now "1 path differs"; nothing on
the page says who changed anything, and nothing was sent.

**Screenshots** (synthetic fixtures from that browser test, the real built page): two operator observations and the paths that differ
between them ([1440](../images/develop-provenance-observed-1440.png)); after a commit, a receipt and one more edit, the checked commit has
the same content as the latest observation and now one path differs ([1440](../images/develop-provenance-now-differs-1440.png),
[390](../images/develop-provenance-now-differs-390.png), [Field 1440](../images/develop-provenance-field-1440.png)); every observation, with
what it does not establish ([1440](../images/develop-provenance-details-1440.png)). At 390 the run strip no longer draws over the content.

**Full suite** on the branch before push: 262 files, 6 697 tests passed, 73 skipped, 0 failed; `npm run typecheck` and `biome check` clean
(one pre-existing warning in `tests/endo-cockpit-eighteenth-review.test.ts`).

## 10. Limitations

*   **Not authorship, not continuity.** Two equal observations do not mean nothing happened between them.
*   **Ignored files** (dependencies, build output, `.env`) are not part of a state.
*   **Raw bytes.** Git's line-ending conversion, clean filters and `core.fileMode=false` are not applied: in such a repository an identical
    commit can read as `different` (never the reverse).
*   **Pi's settle is the run's end.** Pi reports no run id; the first run after the send is taken as its run, as the execution reading does.
*   **The before-send observation adds up to 15 s** between approval and send for a very large tree (typically well under a second).
*   **An older build reading a newer store** shows no provenance; it does not read `develop/observations/`.
*   **Not an atomic snapshot.** Status is read first, then each listed file. A path that is clean when status runs and changes before
    it is read is taken from HEAD; a same-size rewrite within one file-timestamp tick can pass the before/after stamp check. Both are
    narrow; neither can be closed without a filesystem snapshot.
*   **Records are not authenticated.** The validator re-derives `complete` and `digest`, but `truncated`, the flags and the changes are as
    written: anyone who can write the store can write a convincing observation (as for receipts).
*   **Not exercised against real Pi** in this PR (the fake Pi and the stand-in session only); the observation does not depend on what Pi
    does beyond the two events it already reports.

## 11. Next

1.  Behavioural checks: a planned check that compares a command's actual output with an expected output the operator froze before the
    attempt was sent (the next PR, stacked on this one).
2.  `endo attempt evidence` v3 with the provenance section (the CLI has `endo attempt provenance` for now).
3.  A declared candidate (the operator names the commit under review), shown beside the observed and checked ones, never merged with them.

## 12. Independent review

A fresh-context subagent (Claude Code `Agent`, general-purpose, read-only, no conversation history) reviewed this PR adversarially after
it was opened. It wrote real-Git reproductions for its two strongest findings. Dispositions:

| Finding (its severity) | Disposition |
| :-- | :-- |
| A path that is not UTF-8 is decoded lossily in `diff-tree`/`ls-tree` output; the decoded name matches nothing in either commit, so two commits that differ there read **`same`** (high) | **Fixed.** Each path's bytes must survive the decode; otherwise the comparison is `not-compared` with the new reason `path-not-text`. Test: a `caf\xe9.txt` changed between two commits. |
| A parent directory replaced by a link made the observer read a file **outside** the working tree and record its blob id (medium) | **Fixed.** Every parent is `lstat`ed before and after the read: a link or non-directory parent means the path is `absent` (Git does not follow it); a parent that changed during the read means `not-read`. Test: `dir -> outside`. |
| A send whose answer was unknown (a timeout) left the run watch armed, so a later, unrelated run could be recorded as this attempt's `after-run` (medium) | **Fixed.** Every send replaces the watch (an ordinary prompt clears an attempt's), and an unknown answer drops a watch whose run has not started. Test: unknown answer, then another run. |
| "The same content" on the page did not say ignored files are left out (low-medium) | **Fixed.** Each "same content" phrase says "(ignored files are not compared)". |
| An observation over its 512 KiB file bound failed to write and vanished (low) | **Fixed.** The observer budgets the record's paths; past it the state is truncated (incomplete, recorded and shown). |
| A same-size rewrite within a timestamp tick; the snapshot is not atomic (low) | **Documented** in §10; not closable without a filesystem snapshot. |
| The validator does not authenticate `truncated`/flags; the digest comment overclaimed (low) | **Documented** in §10 (as for receipts: an unsigned local record); the comment now says what the digest covers and that comparisons never use it. |

Each of the three fixes' tests was run against the unfixed sources: all three failed, and pass with the fixes.

### Codex review on the PR

Codex reviewed both pushes (7 findings; the lossy-path one duplicated the subagent's, already fixed). All six others were reproduced
from the code and fixed in one push:

| Finding (Codex's priority) | Fix |
| :-- | :-- |
| A withdrawal from the page while the before-send observation was running was answered 200, and the brief was still sent (P1) | Once the operator approved on the terminal, `prompt/discard` answers 409 `not-withdrawable`; the gate checked after the observation also refuses any aborted request. Test: hold the observation, withdraw (409), release (sent once). It fails on the unfixed broker (200). The window was new in this PR: before it, nothing awaited between approval and dispatch. |
| A commit between the observer's HEAD read and its status read gave the old commit with the new (empty) change list, recorded as complete (P2) | HEAD is read again after the changes; if it moved the observation is `unavailable` (`head-moved`). A move and a move back is not seen. |
| A single operator observation was named "the observation just before the send" (P2) | The page names the latest observation by its own point and trigger. |
| A `workbench-closing` observation framed as "when the run had ended" (P2) | The note `run-end-not-observed`, and the frame's words now say "after the run that followed (when it ended, or as the workbench closed)". |
| The workspace read receipts twice; a check finishing in between put a commit in `checked` that the listed receipts lacked, and the page refused the whole answer (P2) | Provenance uses only the receipts the view already lists. (No dedicated test: the fix is the one filter.) |
| Two operator observations made at once produced a frame the page's gate refuses (P2) | The end is the latest operator observation that began after the first ended, or none. Test. |
