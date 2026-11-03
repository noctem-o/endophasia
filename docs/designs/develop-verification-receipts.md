# DEVELOP Slice F: verification receipts

*   **Status:** Implemented in this PR (draft, three fresh-context design reviews, resolution; see [Review](#review))
*   **Date:** 2026-11-03
*   **Scope:** one bounded slice. An operator-triggered check, observed by Endophasia, recorded once against an attempt. No gate, no
    acceptance, no supervisor, no automatic runs.

## The problem

Slice E ([develop-work-attempts.md](develop-work-attempts.md)) records three things:
- what the operator *asked* (an attempt);
- that they *handed it over* (a handoff);
- what was *reported* (an outcome, explicitly not verified).

Nothing records what Endophasia itself *saw*. After an agent says "tests pass", the operator's question is:

> What did Endophasia actually observe, against which code revision, and does that evidence still apply?

## Terms and authority

| Information | Authority | Where it lives |
| :-- | :-- | :-- |
| The agent says the tests passed | A reported claim | Nowhere in Endophasia, until the operator writes it down |
| The operator records that statement | Operator-declared outcome | `<attempt>.outcome.json` (Slice E) |
| Endophasia runs the operator's command and sees exit 0 | Independently observed check result | `develop/receipts/<attempt>/<receipt>.json` |
| HEAD has moved since | The prior observation may be stale | Computed when read; never stored |
| The operator accepts the work | Explicit operator decision | The task's status (`endo task status`), unchanged by this slice |

**A receipt is not acceptance.** Nothing in this slice changes:
- a task's status;
- an attempt's state;
- a PR;
- an approval;
- a grant.

## Options

- **A. Git observation only.** Record "HEAD of this worktree was C (tree T), clean". It answers *which revision*, not *what was observed
  of it*. On its own it cannot answer the question above.
- **B. Git observation plus one operator-triggered command.** A, plus one process:
  - the operator names it on the command line, after `--`;
  - it is run directly, with no shell;
  - it is bounded in time and output;
  - it runs in a process group Endophasia owns;
  - Git is observed before and after it.
- **C. A verification framework** (named checks in configuration, policies, steps, artefacts, attestations). **Rejected.** It is a
  workflow DSL and a policy engine, both excluded. It would also move the decision of *what runs* into a file an agent can edit.
- **Isolated checkout** (`git worktree add --detach`, or `git archive` into a temporary directory, then run there). **Rejected for
  this slice.**
  - It would remove two gaps: ignored inputs and concurrent writers.
  - But `worktree add` writes into the repository's `.git`.
  - And a fresh export has no dependencies (`node_modules/`), so most real checks could not run in it at all.
  - It is the natural next increment if the ignored-input gap matters more than the cost of installing dependencies per check.

**Chosen: B, narrowly.** The review found that a sound B needs process supervision the repository already has. `ProcessGroupV0`
(`adapters/rpc-jsonl/process-group.ts`, used by the RPC and ACP clients) is reused unchanged:
- A keeper process leads the group, so a group signal never reaches a reused group ID.
- The keeper kills the group if `endo` dies.

The fallback, A alone, was not needed.

Three outside tools were read for ideas; none is a dependency:
- `didrun`: record what ran and its exit status as a receipt.
- `zti-cli`: bind a result to an exact revision; a dirty tree is not that revision.
- `attesthook`: hook-time attestation. Rejected, because it runs on events, and checks here never run on events.

## What a receipt claims, exactly

A `passed` receipt says this, and only this:

> Endophasia spawned *executable* with *argv*, at the top of working tree *W* of the repository whose common Git directory is *G*.
> - Before it started and after its process group was gone, Git reported HEAD at commit *C* (tree *T*).
> - Both times, Git reported no staged, unstaged, untracked or conflicted change, no index entry flagged assume-unchanged or
>   skip-worktree, and no submodule. Ignored files were not examined.
> - No ref update was **logged** in HEAD's (or the branch's) reflog in between.
> - The configuration and ignore rules read the same both times: the configuration listing, the operator's ignore file (the configured
>   one, or Git's default `~/.config/git/ignore`), `info/exclude`, and every `.gitignore` in the tree that is itself ignored.
> - The process exited by itself, with code 0, within its time limit.

What it does **not** establish is recorded in every receipt (`limitations`, a closed list the validator re-derives) and shown wherever
the receipt is shown:

| Limitation | Meaning |
| :-- | :-- |
| `command-defines-the-check` | Exit 0 from `npm test` says `npm test` exited 0: nothing about acceptance criteria or correctness. |
| `ignored-files-not-examined` | `node_modules/`, build output and `.env` were inputs; their contents were not recorded or compared. For a typical Node project they are most of what a check reads. |
| `environment-not-recorded` | Variables, tool versions, network and home directory were inherited and not recorded. |
| `changes-reverted-during-check-not-detected` | A file edited and restored between the two observations is not seen; nothing watches files. |
| `concurrent-writers-not-excluded` | An agent still working, or an editor, could write the tree during the check. The CLI says to stop them first. |
| `clean-is-gits-stat-based-view` | "Clean" is Git's answer under the repository's settings and its index stamps. |
| `processes-leaving-group-not-tracked` | A process that leaves the group (`setsid`, a daemon) is outside it. If it still holds the output, the receipt is inconclusive. |
| `attempt-link-is-operator-declared` | The operator chose the attempt. Endophasia does not know which revision the attempt's work produced. |
| `unsigned-local-record` | Anyone who can write the store can write a receipt. It is evidence for the operator, not an attestation. |
| `reflog-unavailable` (when so) | Git had no reflog for HEAD, or for the branch HEAD names. A ref that moved and came back cannot be told. |
| `stray-processes-stopped` (when so) | Members of the group were still running when the command exited. They were killed before the second observation. |
| `executable-in-worktree` (when so) | The executable is inside the checked tree: the repository supplied it. |
| `stray-processes-not-observable` (when so) | Where `/proc` is missing (macOS), leftover processes cannot be seen. "Unknown" is recorded (`strayProcesses: null`), never "none". Any leftovers are still killed with the group. |

The user-facing phrase is "**observed check passed** *in this working tree at C*", never "C passed", "verified" or "task done".

## Revision binding

Only a **clean, committed** state is supported. Before anything runs, the working tree is observed. The observer is
`adapters/git/revision-observer.ts`, on the hardened read-only Git layer in `adapters/git/readonly-git.ts`:
- no repository programs, no global or system configuration, no lazy fetch, no locks;
- bounded time and output;
- `core.checkStat=default`, `core.trustctime=true`, and no untracked cache.

The program-key and partial-clone checks are now one shared function, `repositoryOverridesV0`, used by both the project inspector and
this observer.

| Observation | Refused (nothing runs, nothing recorded) when |
| :-- | :-- |
| `--cwd` (default: the project's registered path) is the TOP of a non-bare working tree, Git finds the same Git directory from it, and a `.git` is there | not a directory or repository; bare; a subdirectory; `core.worktree` or a nested repository pointing elsewhere |
| Its common Git directory is the one the attempt's project's registered path is in | another repository (`other-repository`): a receipt is only taken in the attempt's own project's repository (its main tree or a linked one) |
| The configuration listing | a program-bearing key Git cannot be told to switch off; a partial clone on a Git without `GIT_NO_LAZY_FETCH` |
| `rev-parse HEAD^{commit} HEAD^{tree}` | unborn branch |
| `status --porcelain=v2 -z --untracked-files=all` | any staged, unstaged, untracked or conflicted entry |
| `ls-files --stage -v -z` | an entry flagged assume-unchanged or skip-worktree (status would hide its changes); a gitlink (submodule) |
| HEAD's and the branch's reflog, read **through Git** (`rev-list --walk-reflogs --count` and the newest entry; any ref backend) | never refused; none, or one with no entries, gives `reflog-unavailable` |
| A digest of the rules "clean" is judged under: the configuration listing (with values, never stored); the stamps (of the path and, through a link, of its target) of the operator's ignore file (the configured one, or Git's default), of `info/exclude`, and of every ignored `.gitignore` in the tree (`ls-files --others --ignored --exclude-standard -- ':(glob)**/.gitignore'`) | never refused; only compared, so a check cannot add a file and hide it from the second observation by changing the rules |

**Detached HEAD** is supported: the commit is what is bound. A **linked worktree** of the project's repository is supported. Its receipt
records `linked: true`, and it relates only to that worktree.

After the process group is gone, the same observation is made again. The receipt is `passed` or `failed` only when all of these hold:
- the second observation names the same worktree, common directory, commit and tree;
- the tree is still clean;
- the reflogs and the rules read the same.

Otherwise it is `inconclusive`, with every reason that applies.

## Execution boundary

- **Only `endo attempt check ... -- <executable> [args...]`.**
  - The argv is exactly what follows `--` on the operator's command line.
  - The service has no other way to obtain one.
  - Nothing is read from a task, an attempt, a brief, an outcome note, a receipt, an agent message or a model output. There is no
    re-run command.
  - Nothing runs on any event: not when a task, attempt or session changes.
- **No shell.** The executable is resolved before anything runs:
  - A name containing `/` is taken relative to the worktree.
  - A bare name is looked up along `PATH`, skipping entries that are **empty, relative, or inside the working tree**. Each of those
    would let a repository file shadow the operator's `npm`.
  - It must be an executable regular file.
  - The PATH-resolved path is what is spawned, without following links, so a multi-call tool (`cargo` under rustup, version-manager
    shims) still sees its own name. Its real path is recorded beside it.
- **The risk is stated, every time.** Before running, the CLI prints:
  - the command runs with the operator's permissions and environment;
  - whatever it invokes from the repository is the repository's code, which an agent may have written;
  - Endophasia cannot tell whether anything else writes the tree meanwhile.
  - Then it prints the argv, the spawned path, the tree and the commit.
- **Environment.** Inherited, not recorded. Variables that would point the check's own Git elsewhere are removed: `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object directories, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, and the
  `GIT_CONFIG*` overrides.
- **Process group.** `ProcessGroupV0`, unchanged.
  - A keeper leads the group.
  - On timeout or interruption the group gets SIGTERM, then SIGKILL after 5 s.
  - When the command exits by itself, remaining members (seen in `/proc`) are noted as `strayProcesses` and the group is killed.
  - If `endo` dies, the keeper sees its control socket close and kills the group.
- **Pipes.** Once the group is gone, the output pipes must close within 2 s. If they do not, a process outside the group holds them:
  they are closed from this side, and the receipt is `inconclusive` (`escaped-process`). The wait is bounded on every path.
- **Input and output.**
  - stdin is an empty pipe, closed at once.
  - Output is passed through to the operator's terminal (stderr) as it comes, with backpressure while the check runs, and never
    buffered whole. Once the group is gone, what is left in the pipes is drained without backpressure, so a slow terminal is never
    taken for an escaped process.
  - If the terminal or pipe goes away during a check, writing to it stops. The check is still observed, counted and recorded.
  - Byte counts are recorded. Contents and digests are not: nothing could check a digest of output that is not kept.
  - At 64 MiB in total the check is stopped (`output-limit`).
- **Time.** `--timeout <seconds>`, 1 to 7200, default 600.
- **Interruption.** While a check runs, SIGINT, SIGTERM and SIGHUP to `endo` stop the group as a timeout does.
  - The receipt is written as `interrupted`, and `endo` exits 130.
  - A second signal skips the grace period.
  - Ctrl-Z stops `endo` but not the check, which is in its own session, so the timer pauses with `endo`. This is documented, not
    handled.
- **POSIX only.** On Windows, `check` is refused.
- **What is recorded.**
  - The argv **is** recorded, since it is what was checked. It is bounded: at most 64 arguments and 8 KiB, no NUL, well-formed text.
  - A receipt that could not be recorded, whatever the check's end, is refused before anything runs (`unrecordable`). For example, it
    could exceed its 64 KiB bound, or a branch name could be over its bound. The projected receipt is validated, not only measured.
  - Do not put secrets on the command line: the argv is stored and shown on the paired page.

## Outcome

`outcome`, `reasons` and `limitations` are derived from the recorded facts by one pure function, `endoReceiptVerdictV0`. The validator
**re-derives all three**: a file whose verdict does not follow from its own facts is invalid, and is not shown.

| Outcome | Label | When |
| :-- | :-- | :-- |
| `passed` | **Observed check passed** | exited by itself with 0, and no reason below |
| `failed` | **Observed check failed** | exited by itself with another code, and no reason below |
| `inconclusive` | **Inconclusive** | any of `timed-out`, `interrupted`, `signaled`, `output-limit`, `spawn-failed`, `escaped-process`, `after-unavailable`, `repository-changed`, `head-moved`, `tree-changed`, `reflog-changed`, `rules-changed` |

A failure while the tree changed is `inconclusive`, not `failed`; its exit code is still recorded and shown. A signal Endophasia did
not send (a crash, the OOM killer) is `signaled`: the command did not exit by itself. An executable that cannot be started is
`spawn-failed`, for example a bad interpreter line. It is recorded, because something was attempted. A missing executable is refused
before anything runs.

## Staleness

Never stored. A receipt is compared with **a working tree the reader chose**:
- the CLI's `--cwd` (default: the project's registered path);
- in the workbench, the launch directory.

A path written in a receipt is compared, never used to decide what to read.

| Relation | Label |
| :-- | :-- |
| `at-head` | Recorded at this working tree's current HEAD |
| `at-head-changed` | Recorded at the current HEAD, but the working tree has changed since |
| `head-differs` | **Stale:** this working tree's HEAD is now a different commit |
| `other-worktree` | Recorded in a different working tree; not compared |
| `other-repository` | Recorded in a different repository; not compared |
| `unavailable` | Current revision unavailable; not compared |

A receipt is never carried forward to a new commit, including one with the same tree (an amended message).

## Persistence

`<root>/develop/receipts/<attempt id>/<receipt id>.json`, owner-only, beside `develop/attempts/`. One directory per attempt:
- reading one attempt's receipts reads only that directory;
- removing them is deleting it, which is the operator's act (there is no command).

Each receipt is written once by Slice E's protocol:
- an exclusive temporary file, `fsync`, a hard link to the final name, a directory `fsync`;
- a temporary file left by a crash is swept a minute later.

Changes to the shared storage code:
- The protocol's helpers are extracted from `storage/develop-attempts.ts` into `storage/write-once.ts`, and both stores use them.
- Making a directory is now safe when two processes create it at once. The receipts' concurrency test found this. It applied to the
  attempts store too, which had the same code.

Failed receipts stay beside the passing ones that follow them. At most 100 receipts per attempt are kept, checked before a check starts.

A problem file is reported by name and left as found. The kinds are:
- malformed, invalid (including a verdict that does not follow), or oversize;
- symlinked or not a regular file;
- misnamed (the id does not match the name, or the receipt belongs to another attempt);
- unknown.

A symlinked receipts directory is refused. Task and attempt files are never written.

## The record

`protocol/develop-receipts.ts`, `endo.develop-receipt.v0`, closed:

```ts
{
	schemaVersion, id /* endo.receipt.<32 hex> */, attemptId, projectId,
	requestedBy: "operator", via: "cli", observer: { tool: "endo", version },
	startedAtMs, endedAtMs, durationMs /* monotonic */,
	repository: { worktree, commonDir, linked }, revision: { commit, tree, branch /* refs/heads/… | null */ },
	reflog: "compared" | "unavailable",
	check: { argv, executable /* spawned */, realExecutable, timeoutMs },
	execution: { kind: "exited", code } | { kind: "signaled", signal } | { kind: "timed-out" | "interrupted" | "output-limit" | "spawn-failed" },
	output: { stdoutBytes, stderrBytes }, strayProcesses, escapedProcess,
	after: { state: "observed", sameRepository, commit, tree, clean, reflogsUnchanged, rulesUnchanged } | { state: "unavailable" },
	outcome, reasons, limitations   // re-derived by the validator
}
```

## CLI

```sh
endo attempt check    --root R --attempt A [--cwd DIR] [--timeout SEC] -- <executable> [args...]
endo attempt receipts --root R --attempt A [--cwd DIR]    # every receipt, oldest first, related to HEAD of DIR
endo attempt receipt  --root R --receipt E [--cwd DIR]    # one, in full, with its limitations in words
```

`check` prints the receipt (JSON) on stdout. On stderr it prints the risk notice, the check's own output, and what was recorded.

| Exit | Meaning |
| :-- | :-- |
| 0 | recorded: observed check passed |
| 3 | recorded: observed check failed |
| 4 | recorded: inconclusive |
| 130 | the check was stopped by an interruption; recorded as inconclusive (`interrupted`). A signal that arrives after the check ended does not change the exit code. |
| 2 | refused before running: nothing ran, nothing was recorded (the reason on stderr) |
| 5 | the check ran but its receipt could not be written: **nothing was recorded** (what was observed is printed on stderr) |
| 1 | a usage error, or an internal fault |

## Studio

The paired workbench's attempts view (`GET workspace/attempts`, unchanged route, behind the grant) becomes
`endo.develop-attempts-view.v1`. Each attempt gains `receipts: { state, list, problems }`.

What each receipt in the view carries:
- id and times;
- argv, made display-safe on the server: control, bidirectional and separator characters become U+FFFD, and each argument is cut at
  400 characters;
- commit and branch;
- how it ended;
- outcome, reasons and limitations;
- its relation to the launch directory's HEAD, observed at that read.

What the view does not carry, and cannot do:
- No path.
- The broker's tasks routes are synchronous. The attempts read is served by a new async `route` method of `WorkbenchTasksV0`, and
  every other route is unchanged.
- No new route, no write, no execution, and no lookup by anything the request names. A query is still 400. POST and sub-paths are
  404.

The page's closed gate:
- checks each receipt's shape;
- requires its outcome to follow from its execution and reasons;
- refuses a body that claims more.

The Task view shows the newest receipt in each attempt's summary line, for example "Inconclusive · stale". The attempt body lists every
receipt. Each shows:
- its outcome label;
- its commit and argv;
- a sentence on how it ended;
- its relation label;
- its limitations under a "What this does not show" disclosure.

It also shows the `check`/`receipts` commands with a `<store>` placeholder. `endo studio` (unpaired) gains nothing; a canary test
covers that.

## Not in this slice

- observation-only receipts;
- checks on dirty trees;
- isolated checkouts;
- named or configured checks;
- re-running;
- automatic checks;
- CI or GitHub status;
- signing;
- output capture;
- acceptance;
- policy;
- supervisors;
- a delete command.

## Testing

`tests/develop-receipts.test.ts` (49 tests). Real Git and real processes in temporary directories. Fake `pi`, `omp`, `claude` and
`codex` are first on PATH for the whole file, and are checked never to run.

| Brief case | Test |
| :-- | :-- |
| Pass at a clean commit, then HEAD changes | "a passing check at a clean commit, then a commit": `at-head`, `at-head-changed`, then `head-differs` after an amend with the same tree |
| Failure preserved | "a failing check is recorded as failed and kept when a passing one follows" |
| Multiple and concurrent receipts | the same; "two checks at once on one attempt"; six writer processes at once (store) |
| Dirty, untracked, detached, linked worktrees | the observer suite (changes; assume-unchanged, skip-worktree, gitlink; detached; linked); the refusal test; "checks a linked worktree" |
| Repository changes during a running check | a tracked edit, an untracked file, a commit, HEAD moved and back (reflog only), and three ways to hide a new file (an `info/exclude` rule, a self-ignoring nested `.gitignore`, Git's default user ignore file): each inconclusive with its reason |
| Timeout, signal, missing executable, interruption, malformed output | the runner suite (binary output; stdin; SIGTERM-ignoring check; output limit; signal; missing and bad-interpreter executable; interrupt; stray and escaped processes; a failing sink; a sink that never drains); the service suite; CLI SIGINT gives exit 130 and an `interrupted` receipt; an unrecordable receipt is refused before running |
| Missing, corrupt, oversize, misnamed, symlinked receipt files | the store suite: each reported by name and left byte for byte; symlinked directories refused |
| Restart, atomic writes, crash recovery | a new store reads the same; `beforeLink` crash; a leftover temporary file skipped, then swept when old |
| Another project's attempts, invalid ids | `other-repository` refusal; another repository's relation; malformed and unknown ids (service and CLI) |
| Browser visibility without execution authority | the workbench suite: no path in the body; no check or receipt route (POST and GET); a query is refused; the gate refuses forged outcomes and paths; the Studio canary (`tests/endo-develop-tasks-workbench.test.ts`) |
| Task and attempt files unchanged | byte comparisons around the real-Git and CLI tests |
| No accidental execution | fake agents on PATH; an attempt objective containing commands is never run; `check` without `--`, or with nothing after it, refused |
| Real Git integration | every service, workbench and CLI test commits, amends or checks out in a real repository |

Also covered:
- `tests/endo-studio-tasks-browser.test.ts`: three receipts at 1440 px (Instrument, Field) and 390 px. It checks stale, failed and
  timed-out wording, "not the task's acceptance", no "verified" or "succeeded", no path, and no overflow.
- `tests/endo-studio-ui-source.test.ts`: the page has no receipt or check route.
- The existing attempts tests run against the `v1` view.

Sixteen deliberate mutations were reintroduced one at a time, and each made at least one test fail:
- the verdict ignoring a changed tree;
- the observer ignoring flagged entries;
- PATH resolution not skipping in-tree entries;
- the relation ignoring repository identity;
- the service not checking the repository;
- the runner never reporting an escaped process;
- the rules comparison removed;
- the page's coherence check removed;
- the ignored-`.gitignore` stamps removed from the rules digest;
- the default user ignore file removed from it;
- the sink error listener removed;
- backpressure kept while draining;
- the projected receipt not validated;
- an ignore file's link target not stamped;
- an empty reflog counted as compared;
- a branch name not made display-safe for the page.

One more mutation, skipping writes to a sink that has already failed, made no test fail. That line only avoids pointless writes once
the error listener has done its work. The listener is what keeps the run alive, and removing it is caught.

## Manual smoke test

In a disposable store and repository, never your real ones, with no agent or model needed:

```sh
S=$(mktemp -d) && mkdir "$S/proj" && cd "$S/proj" && git init -q && echo 'exit 0' > test.sh && git add . && git commit -qm init && cd -
P=$(endo project add --root "$S/store" --name Demo --path "$S/proj" | jq -r .project.id)
T=$(endo task add --root "$S/store" --project "$P" --title Fix | jq -r .task.id)
A=$(endo attempt prepare --root "$S/store" --project "$P" --task "$T" --objective "do it" | jq -r .attempt.id)
sha256sum "$S/store/develop/tasks.json" "$S/store/develop/attempts/"*            # note them
endo attempt check --root "$S/store" --attempt "$A" -- sh test.sh; echo $?       # 0, "Observed check passed"
echo junk > "$S/proj/x"; endo attempt check --root "$S/store" --attempt "$A" -- sh test.sh; echo $?   # 2, refused, nothing ran
rm "$S/proj/x"
(cd "$S/proj" && echo 'exit 1' > test.sh && git commit -qam fail)
endo attempt check --root "$S/store" --attempt "$A" -- sh test.sh; echo $?       # 3, "Observed check failed"
endo attempt check --root "$S/store" --attempt "$A" -- sh -c 'echo z > made'; echo $?   # 4, inconclusive: the tree changed
rm "$S/proj/made"
endo attempt check --root "$S/store" --attempt "$A" --timeout 1 -- sleep 5; echo $?     # 4, inconclusive: timed out
endo attempt receipts --root "$S/store" --attempt "$A" | jq -c '.receipts[] | [.label, .relationLabel]'
#   the first pass is "Stale: this working tree's HEAD is now a different commit"
sha256sum -c   # the task and attempt files are unchanged; endo task list shows the task still open
```

For the page, start a workbench for that project (`endo harness attach --root "$S/store" --cwd "$S/proj" --control --workbench --project
"$P"`), pair, and open **Task**. Under the attempt, each check shows its outcome, how it ended and its relation to HEAD, and nothing on
the page can run one. Then `rm -r "$S"`.

## Review

The design review followed the Elephant–Goldfish Model's personas (github.com/google/elephant-goldfish-model), but **the EGM plugin was
not installed** in this Claude Code environment, and installing one would have changed agent settings.
- Its upstream reviewer personas and rubrics (`zoom_out`, `design_critic`, `implementation_readiness`, fetched for Slice E) were each
  given to a fresh-context subagent: a Claude Code `Agent`, general-purpose, with no conversation history and read-only.
- Each read the draft and the code it cites. The design critic also ran Git and Node experiments in a scratch directory.
- They ran in parallel, not through EGM's sequential synthesizer pipeline, and there was no separate Comprehension stage.
- There was no intermediate review of the resolved design. The fresh-context implementation review below covers the built result
  instead.

| Finding (reviewer) | Disposition |
| :-- | :-- |
| The draft rebuilt process-group supervision by hand, and worse than the repository's own: `kill(-pgid)` after the leader is reaped can hit a reused group; "endo killed leaves the group running" (zoom-out, critic) | **Fixed.** `ProcessGroupV0` is reused unchanged: a keeper leads the group and kills it if `endo` dies. The hand-written supervision was deleted. |
| Spawning the real path breaks multi-call tools: `cargo` under rustup would run `rustup test` and record "failed" for a check that never ran (critic; verified by experiment) | **Fixed.** The PATH-resolved path is spawned, not its real path. Both are recorded. |
| The escaped-process wait was unbounded when the leader exits and the group is already empty, because a daemon holds the pipes (critic; verified) | **Fixed.** A bounded wait on every path, then `escaped-process`. |
| `--cwd` was not tied to the attempt's project (critic, readiness) | **Fixed.** The common Git directory must be the project's (`other-repository`). |
| "Stale: HEAD has moved" was false across worktrees and repositories; "at current HEAD" was read as current while the tree was dirty (all three) | **Fixed.** Repository and worktree identity are compared first (`other-worktree`, `other-repository`, "not compared"). A changed tree is its own relation. |
| The reflog was read as a raw file: no reftable support, no `O_NOFOLLOW`, a branch reflog in the wrong directory (zoom-out, critic; verified) | **Fixed.** Read through Git, for any backend. The wording says "logged". |
| The concurrent agent was not named (zoom-out, critic) | **Fixed.** A limitation, and the CLI's notice tells the operator to stop it first. |
| The attempt link is the operator's say-so (zoom-out) | **Fixed.** A fixed limitation. The commit is shown beside every outcome. |
| Output hashes prove nothing when output is not kept (zoom-out) | **Fixed.** Removed; byte counts only. |
| The LFS claim was false: filtered files read as clean when stat-clean (critic; verified) | **Fixed.** The claim was removed. "Clean is Git's stat-based view" is a limitation, and `checkStat`/`trustctime` are forced for these reads. |
| Ignore rules could change during the check (critic; verified) | **Fixed.** A digest of the configuration listing and the ignore-file stamps (`rules-changed`). |
| The child inherited `GIT_DIR` and friends (critic) | **Fixed.** Removed from its environment. |
| In-tree absolute PATH entries (direnv) could shadow tools (critic, readiness) | **Fixed.** Skipped. `executable-in-worktree` is noted when one is used explicitly. |
| Exit codes conflicted with the dispatcher; "ran but not recorded" was undefined (readiness, critic) | **Fixed.** The table above: refusals are 2, set by the command and not thrown; not recorded is 5. |
| Workbench staleness had no construction path; the route was synchronous (readiness) | **Fixed.** `receipts: { store, current }` on the workspace service, wired in `cli/workbench.ts` with the observer. An async `route` serves the attempts read only. |
| No limitation identifiers, no verdict table, a receipt that could exceed its bound (readiness) | **Fixed.** Closed lists; a pure function the validator re-derives; a projected-size refusal before running. |
| Git safety checks private to the inspector (readiness) | **Fixed.** Extracted to `repositoryOverridesV0`; the inspector's tests pass unchanged. |
| Timings must be injectable (readiness) | **Fixed.** `graceMs` and `pipeWaitMs`; tests run in seconds. |
| No test plan, phases or file list (readiness) | **Fixed.** See [Testing](#testing). |
| A receipt store that only grows; a heavy view read (critic) | **Partly.** Directories are per attempt, so a read touches only the selected task's attempts and removal is one directory. The cap is per attempt. There is no delete command. |
| An isolated checkout was not evaluated (critic) | **Fixed.** See [Options](#options). |
| Ctrl-Z stops `endo` but not the check (critic) | **Documented**, not handled. |
| Refuse a check when a live Pi session is known in that worktree (critic, optional) | **Declined.** The CLI does not know the workbench's sessions, and the limitation says it plainly. |

## Implementation review

After the build, a fresh-context reviewer (a Claude Code `Agent` subagent with no conversation history, not an EGM persona) reviewed the
commit. It focused on process execution, file-system safety, provenance and overstatement. It read the diff and ran the receipts,
attempts, inspector and reader suites. It also ran real `endo attempt check` experiments against disposable stores in a scratch
directory. It found no blocker.

| Finding | Disposition |
| :-- | :-- |
| **Major:** a check could add an untracked file and hide it with a self-ignoring nested `.gitignore`, or with Git's default `~/.config/git/ignore` when no `core.excludesFile` is set. It was then recorded as passed (reproduced) | **Fixed.** Both are in the rules digest: the default user ignore file is stamped, and so is every ignored `.gitignore` in the tree. Tested both ways; each gives `rules-changed`. |
| **Major:** if `endo`'s stderr went away during a check (a closed terminal, an exited pipe reader), `endo` crashed with no receipt and exit 1 (reproduced with a FIFO) | **Fixed.** The runner listens for sink errors, stops writing, and keeps observing. The CLI also ignores later stderr and stdout errors. Tested with a sink that fails every write. |
| **Major:** `plan` only measured the projected receipt, so a branch name over the validator's bound let the check run and then record nothing (exit 5; reproduced) | **Fixed.** The projected receipt is validated before anything runs (`unrecordable`). Tested with a 1 200-character branch. |
| A slow sink kept a stream paused, so a check fully inside its group was recorded as `escaped-process` (reproduced) | **Fixed.** Once the group is gone, the pipes are drained without backpressure. Tested with a sink that never drains. |
| Exit 130 whenever a signal arrived during `run`, even after the check had ended | **Fixed.** 130 only when the receipt's execution is `interrupted`. |
| SIGTERM and SIGHUP were worded as "the operator interrupted it" | **Fixed.** "endo was interrupted while it ran (Ctrl-C, a hangup or a termination signal)". |
| Without `/proc`, stray processes were recorded as none | **Fixed.** `strayProcesses: null` means unknown, with the limitation `stray-processes-not-observable`. |
| `reflog: "compared"` when HEAD's reflog existed but the branch's did not | **Fixed.** `unavailable` unless every reflog that could have logged a movement was there. |
| An output-limit stop during the final drain could arm a grace timer and relabel a check that had already exited | **Fixed.** Nothing is stopped once the command has exited. |
| Each workbench read of the attempts runs about ten read-only Git processes | **Accepted.** The read is behind the grant and happens only after a workspace read (no polling), and the observation is the point of the relation. A cache would make "at current HEAD" less true. |
| Confirmed sound: argv provenance; no shell; PATH skips; Git variables stripped; keeper reuse (it killed the group when `endo` crashed); write-once equivalence; `repositoryOverridesV0` equivalence (one fewer cache of `git --version`); store reads; the relation; the workbench route | No change. |

The full suite also caught a race in the escaped-process test under load: the shell could exit before `setsid` had left the group. The
test now waits for the escaped child to report.

### Codex review on the PR

The repository's automated Codex review left three findings on the PR. All three were reproduced by tests and fixed:

| Finding | Disposition |
| :-- | :-- |
| An ignore file that is a symbolic link was stamped as the link, but Git reads its target. A check could append to the target and hide a new file. | **Fixed.** A stamp covers the path and, followed, its target. Tested with a symlinked `core.excludesFile`. |
| A repository that writes no reflog returns count 0 and empty output, which were hashed as if compared. | **Fixed.** No entries means no reflog: `reflog: "unavailable"`, with its limitation. Tested in the observer and end to end. |
| A branch name Git accepts with a bidirectional control was copied to the page, whose gate then refused the whole attempts view. | **Fixed.** The branch is made display-safe in the view, as argv is. The receipt file keeps it exactly. Tested with U+202E. |

