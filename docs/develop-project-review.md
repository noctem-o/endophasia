# DEVELOP: project and worktree context, and the Changes review

This is the read-only half of working with a live agent: **where is it working, and what has changed there?** It sits beside the
conversation in the live DEVELOP workbench (`endo harness attach <root> --control --workbench`). It changes nothing, approves nothing, and
says nothing about who made a change. The governed controls (prompt, STEER, QUEUE, STOP) are exactly as [docs/develop-workbench.md](develop-workbench.md)
describes; this feature neither widens nor routes around them.

## 1. What the operator gets

- **A worktree bar**, one line above the run strip: repository, launch subdirectory, branch (or detached HEAD, or unborn branch), the
  short commit, and what changed counted **per area** (`3 staged · 5 unstaged · 2 untracked`; a conflicted count only when above zero).
  The counts are never summed: staged, unstaged and untracked are different comparisons.
- **A Changes view**, a tab beside Conversation: the diff of one file, unified, with its comparison named (HEAD → index, index → working
  tree, or an untracked file shown as all-added), previous and next file, and the way back. The run strip (with STOP) and the composer
  stay docked while it is read, and an unsent draft is not lost.
- **The inventory** in the Context column, grouped Staged / Unstaged / Untracked, one entry per (file, area): a file changed in the index
  and again in the working tree is two entries. Status letters (A M D R C T ? !), line counts where Git gives them, renames as `new ← old`,
  long paths cut with the full path in a tooltip.
- **Other worktrees** of the same repository, folded away, said to be places and not sessions.
- **Keyboard:** `j`/`k` (and `]`/`[`) read the next/previous file while the Changes view is open or focus is in the list; `Esc` returns to
  the conversation and puts focus on its tab; arrow keys move among the rows; Enter reads. None of these sends, approves or changes anything.
- **A layout that fills the window** on a desktop: the conversation scrolls inside its own region with the header above it and the
  composer below it; the page does not scroll. At 1024–1359 px the sessions list is a drawer (a button, closed by choosing or by `Esc`);
  below 1024 px the one-stage-at-a-time model remains.

## 2. Where the facts come from, and what they are not

| Fact | Basis |
|---|---|
| The directory | **Configured**: the working directory the attached process was launched with (`--cwd`, else the process's own). It is not observed from Pi and not a session fact. The page labels it so. |
| Repository, worktree, branch, HEAD, linked worktrees, changed files, counts | **Read from Git** by the broker at a stated time (`capturedAtMs`, the broker's clock). A transient observation: never recorded, never an event. |
| Who changed a file | **Not established.** Git cannot say. The page says so once, beside the list: *Changes in the Git working tree. Git does not show who made them: nothing here attributes them to the agent.* There is no "agent changed" badge, no tool-to-file link and no change timeline, and tests pin the absence. |
| A recorded Pi or DSH session's project | **Unavailable**, as before. The neutral session contract is unchanged; no association is inferred from a name or a time. |

A project is not a session: nothing here is placed in a session row's title, and a worktree is not an agent.

## 3. The routes

Two GETs under the workbench prefix, both behind the **grant** (they carry local paths and source text), served by the broker only when
the host gave it a project source (`WorkbenchOptionsV0.project`):

| Route | Answers |
|---|---|
| `GET project` | `endo.workbench-project.v0` ([protocol/workbench-project.ts](../protocol/workbench-project.ts)): the repository, head, linked worktrees, and the changed-file inventory under a fresh opaque `snapshot` id. Takes no argument. |
| `GET project/diff?snapshot=<16 hex>&file=<n>` | `endo.workbench-diff.v0`: one entry's change. `409 stale-snapshot` when the working tree has moved on; `429 busy`; `400` for any other query shape. |

The page never names a path. It names an **entry of a snapshot**; the server maps that to the path it read from Git itself. Without a
project source, `GET project` answers one constant (`{"available":false,…}`, as the read-only server does for status, so a page can ask
quietly) and the diff route does not exist. `endo studio` is unchanged: it has no workbench, and `project` is not found there.
There is no POST, no write-capable Git operation, no generic Git or shell route, no filesystem browsing, and no browser authorisation.

## 4. How Git is run

A fixed list of reads in the launch directory ([adapters/git/readonly-git.ts](../adapters/git/readonly-git.ts),
[adapters/git/project-inspector.ts](../adapters/git/project-inspector.ts)): `rev-parse`, `config --list`, `status --porcelain=v2`,
`diff-index --cached`, `diff-files`, `worktree list`, `hash-object` of the empty tree. Repository contents are **untrusted**:

- **No program a repository names is run.** `core.fsmonitor`, `core.hooksPath`, `core.pager`, `diff.external` are overridden for every
  read; `filter.<n>.clean|smudge|process`, `diff.<n>.textconv|command`, `pager.*` and similar are found by listing the configuration
  (which runs nothing) and overridden by exact key through `GIT_CONFIG_KEY_n`/`VALUE_n`, so a key containing `=` cannot slip through.
  Tests plant canary programs in every one of these and in hooks, run a plain `git` read to prove the canaries are real, then show none
  runs under the inspector.
- **The repository is not written.** `--no-optional-locks`, and plumbing (`diff-index`, `diff-files`) instead of `git diff`: the porcelain
  command refreshes the index and rewrites it even under `--no-optional-locks` (found by test), which a read-only view must not do. A test
  makes the index stale on purpose and asserts the index bytes and the whole `.git` listing are unchanged.
- **The environment is built from `PATH`, `HOME` and `XDG_CONFIG_HOME` only**; user and system configuration are not read, so a user's
  `diff.external` is not honoured and the diff format does not depend on their settings. Two things of the operator's *are* honoured,
  because they decide what their own Git would not show: their default ignore file (`~/.config/git/ignore`, a file of patterns), and the
  `core.excludesFile` named in their global configuration (one `config --global --get`, which runs nothing, passed on as an override).
  A repository that sets `status.showUntrackedFiles=no` is respected: no untracked file is listed, counted or read, and the page says
  "untracked files hidden by this repository" rather than calling the worktree plainly clean. Otherwise a file the operator's Git
  ignores could be listed, and up to 256 KiB of it read into the page.
- **Scope.** The repository's working tree must contain the launch directory *and* hold its `.git` at that root; a `core.worktree` that
  points elsewhere, or at an ancestor, is refused (`scope-mismatch`), not followed.
- **Bounds.** 10 s per Git process and byte caps on every output; 500 files listed (counts still cover the rest and say when they are lower
  bounds); 256 KiB and 5 000 lines per diff; 2 000 characters per line; untracked files over 256 KiB are not read. One inspection at a time,
  at most one more waiting behind it, then `busy` (429; a busy overview is never served as a worktree, and the page keeps what it had); a
  re-read within 750 ms returns the same snapshot. The page asks for **one diff at a time and the newest wanted file wins**, so holding `j`
  asks the broker for the file the operator stops on, not for every file on the way.
- **Untracked files** are read by the inspector itself with the least trust: the name must stay inside the working tree after symlinks are
  resolved, the file must be a plain file (not a link, directory, pipe or device), opened `O_NOFOLLOW|O_NONBLOCK` and still the file that
  was examined, at most a fixed number of bytes. A file replaced by a link or a pipe after the list was read is stale, not opened.
- **Revalidation.** A diff is returned only if the entry is still the same change in a fresh status (same area, same blobs, same names),
  the working-tree file's size/time/inode stamp is unchanged before and after the read, and the diff's own `index` blobs match the status.
  Otherwise: stale, with nothing of the file in the reply. Whether *other* files changed is reported alongside a good diff.
- **Display safety.** Names, branches and diff lines have control characters, escapes and bidirectional marks replaced and the entry flagged;
  a name that is not valid UTF-8 is listed but cannot be asked for exactly (`path-not-text`).
- **Privacy.** Paths, branch names and source lines are never put in an event, a log or the event store (a test searches the whole store),
  never in a URL (the page uses a snapshot id and a number), and never in browser storage.

A configuration listing that cannot be completed (it grew past the cap, or Git failed) ends the request **before any read that touches the
working tree**: a diff is then "unavailable", never run without the overrides (a test plants a clean-filter canary, breaks the listing, and
asserts no further Git read ran and the canary did not). A file that changes type (a file becomes a link) is two patches for one path; the
comparison is checked from the first patch's source to the last patch's target.

Residual risk, stated plainly: a program-bearing key written into the repository's configuration in the instant between the listing and a
read is not seen. Whoever can write there is the agent itself, which can already run any program; this layer defends against a hostile
repository, not against the attached process. A newer Git that adds a new program-running key would need it added to the list.

## 5. States, and what the page says

The page keeps **the last good read** through failures and marks it (a dashed rule and a chip: *out of date* when Git said it moved on, *unconfirmed* when nothing could check); it never refreshes by itself.
One read happens on its own, when the page first holds a grant for a live launch; everything after is the operator's (Refresh worktree, choosing
a file, next/previous). Nothing polls, nothing reads while the page is hidden or another workspace is shown, nothing repeats a failed read,
and a selection is remembered **by (path, area, nth)**, never by position (`nth` is the place among entries that show the same name in the
same area, because two different names can look identical once control characters are replaced), so a refreshed list cannot show a different file under the same slot
(a file that left the list says so). The state lives in memory only; a reload leaves nothing (no storage, no URL), and a different launch
drops it.

| State | What the operator sees |
|---|---|
| Not paired | "Worktree: pair this page to read it." No Git facts. |
| Not read / reading | "Worktree not read yet." / "Reading the worktree with Git…" (the previous list stays, marked while it is replaced). |
| Clean / dirty | "clean" / per-area counts; "Clean: nothing staged, unstaged or untracked." |
| Unavailable | One sentence per reason (not a repository, bare repository, ownership refused, scope mismatch, Git missing, timeout, too large, busy), in the page's words, never Git's. Neutral, no red. |
| Incomplete | "The change list was cut at a limit, so the counts are at least these" (counts get `≥`); line counts or the worktree list unavailable; "This repository's configuration hides untracked files, so none are listed or counted." |
| Stale | "The worktree changed after HH:MM:SS: this list is out of date and this file was not shown." and a Refresh button; the list is marked **out of date**. |
| Session ended / grant gone | The last confirmed facts stay, marked **unconfirmed** (nothing could check), with "what was last read"; a file cannot be read and the page says so. |
| Unsupported | No Changes tab; "This workbench does not offer worktree reading." |
| Diff not showable | Binary, empty (a mode change, noted), too large, conflicted, not a regular file, name not text, cut at the limit, long lines cut short. |

## 6. Design decision record (Opus design advisory)

Two reviews were done by a separate Opus agent, which was read-only and worked from the code and real browser screenshots of synthetic data.
The first is summarised here; the second (after implementation) is in §7.

| Recommendation | Decision | Why |
|---|---|---|
| The centre column fills the viewport: run strip and STOP pinned top, composer pinned bottom, only the middle scrolls | **Accepted** | The old page grew with its content, so the composer sat wherever the text stopped and new messages landed out of sight. |
| A switchable Conversation \| Changes centre view; inventory in the right column, diff in the centre | **Accepted** | A diff needs 85–130 columns, which the right column cannot give; an overlay would make the page inert and put STOP out of reach. Rejected alternatives: inventory and diff both on the right; a modal drawer; a fourth column. |
| A one-line worktree header above the run strip (not in the top bar or a session title) | **Accepted** | Keeps a project from being read as a session or a Studio-wide fact. |
| Keep the composer editable during a run; gate only the request | **Accepted** | A steer can be drafted while a prompt cannot be sent; the old field was disabled and still looked selected. |
| Trim the Context column to actionable state; fold standing prose away | **Accepted** | About 75 % of it was static or repeated. The capability list is folded into "Source and capabilities"; the Offered block became "Controls". |
| One privacy statement above the conversation instead of a tag under every message | **Accepted** | A tag repeated twenty times stops being read. It is still stated, once, persistently. |
| Diff without green and red: a sign column, a rule and weight | **Accepted** | Colour here is reserved for provenance and condition. The sign is also read by assistive technology. |
| Auto-follow the newest message only when the reader is at the bottom, else "New items below" | **Accepted** | The old page had no scroll-to-newest at all. |
| Sessions as a drawer at 1024–1359 px | **Accepted** | The old layout dropped Context under the conversation at laptop widths. |
| `j`/`k`, `Esc`, arrows; no key for STOP, send, refresh or mode | **Accepted** | Navigation only; nothing consequential is one key away. |
| Worktree read "only on the button" | **Modified** | One automatic read when first paired, then explicit. The brief asks to orient with minimal interaction; the read is of the operator's own repository, grant-gated, and never repeated. |
| Remove the per-row "recorded only" tag and the "as recorded" suffix | **Declined** | The tag is the neutral surface's live/recorded distinction (Journey C). Its layout bug (it stretched across the row) was fixed instead. |
| Split diff; command palette / quick switcher; any authorship signal; automatic worktree refresh; syntax highlighting or word diffs | **Declined (Opus's own "do not build" list)** | Each halves the line width, adds an execution-shaped surface, invents evidence, breaks snapshot semantics or spends colour reserved for provenance. |

## 7. Second review (after implementation), and what was done

The same Opus agent reviewed the built UI from real screenshots at 390, 768, 1024, 1200, 1366, 1440, 1920, 2560 and 3840 px and from the
code, adversarially, and ranked 22 defects. Its verdict: the layout was right, but two defects broke "unknown is never shown as a fact", the
diff got too little height on a laptop, and the session was not named in the centre column. Nothing was skipped silently:

| # | Finding | Impact | Disposition |
|---|---|---|---|
| 1 | A directory that is not a repository said "Nothing is changed in the worktree" beside "Changes: unknown" | High | **Fixed**: the Changes view says "Changes unknown: {reason}"; a test pins it. |
| 2 | With the grant gone but the list kept, choosing a file left "Reading…" on screen forever | High | **Fixed**: the file cannot be read and the page says so ("no longer paired"); a test pins it. |
| 3 | Below 1024 px, Esc while reading a diff ran two handlers and landed on the sessions list | M-H | **Fixed**: the stage handler stands aside while changes are read; tested. |
| 4 | The session was named nowhere in the centre column | M-H | **Fixed**: the run strip starts with the session name. |
| 5 | The sign column (which replaces colour) scrolled away on a sideways scroll | M | **Fixed**: sticky; tested. |
| 6, 10 | Composer 140–160 px tall; STOP's visible sentence cut mid-way | M | **Fixed**: mode descriptions are tooltips, the request button shares the modes row, the hint is one line; STOP is last with the short clause "approve in the terminal" and the whole sentence stays as its description (shown in full when it cancels something or cannot be requested). |
| 7, 8 | j/k lost the selected row; the diff could not be scrolled from the keyboard | M | **Fixed**: the row is kept in view; PageUp/PageDown scroll the diff from anywhere; tested. |
| 9 | No cue that the agent spoke while changes were read | M | **Fixed**: "· new" on the Conversation tab; tested. |
| 11, 12 | Phone: about four diff lines; the Changes view was a dead end with nothing selected | M | **Fixed**: no sticky composer while changes are read, no nested scroll, narrower gutters; with nothing selected the list is shown inside the Changes view. |
| 13 | "not current" meant two things | M | **Fixed**: "out of date" (Git said it moved on) vs "unconfirmed" (nothing could check). |
| 14 | A "Changes 10" total on the tab | M | **Fixed**: removed; the areas are counted in their own headings. |
| 15 | Context repeated the bar and buried the list | M | **Fixed**: Changes first; Worktree reduced to basis and root; Controls folded; Session above them. |
| 16 | The drawer never took focus and a click outside did not close it | L-M | **Fixed**; tested. |
| 17, 18, 20, 22 | Stale said four times; "Refresh session" vs "Refresh sessions"; a doubled "unavailable"; self-overriding CSS | L | **Fixed**: one chip, "Read session" / "Reload list", the reason said once, duplicate rules merged. |
| 21 | Full-width top bar at 3840 px | L | **Fixed** at 2600 px and above. |
| 19 | The crumb's focus box persists | L | **Deferred**: it is the existing narrow crumb's focus treatment, unrelated to this feature. |
| First-review items | Per-row "recorded only" tag; counts in headings; hunk keys (`n`/`p`); clicking the worktree line opens Changes; a spacing scale | — | Counts in headings **done**. The row tag **kept** (it is Journey C's live/recorded distinction; only its layout bug was fixed). The rest **deferred** (§8). |

Opus's own list of what to remove was followed except the session list's "Project: unavailable for every session" line, which is kept: it is
the explicit statement that a recorded session has no project.

Screenshots of the result (synthetic data only; [before](images/develop-before-1440.png) and
[narrow before](images/develop-before-390.png) for comparison):
[conversation 1440](images/develop-project-conversation-1440.png), [diff 1440](images/develop-project-diff-1440.png),
[diff 1366](images/develop-project-diff-1366.png), [diff 2560](images/develop-project-diff-2560.png),
[phone 390](images/develop-project-diff-390.png), [stale](images/develop-project-stale-1440.png),
[not a repository](images/develop-project-not-a-repository-1440.png).

## 8. Not done, deliberately

- Commit or branch comparisons (only HEAD → index, index → working tree, and untracked files are read), ahead/behind, upstream, submodule
  contents, ignored files.
- Hunk-to-hunk keys (`n`/`p`), split diff, intra-line highlighting, clicking the worktree line to open Changes, the existing narrow crumb's focus box.
- Any change to what a recorded session knows about a project (still unavailable), any switching of the active session's worktree, or
  launching a session elsewhere.
- Real Pi acceptance for this feature: the tests use a stand-in session and real Git; nothing here needs a model, and none was run.
