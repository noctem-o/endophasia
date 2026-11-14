# DEVELOP-UX-001: making DEVELOP pleasant for everyday coding

**Status: audit and design complete; one narrow slice implemented in this PR.** The slice removes start-up friction and redraws the
interface. It changes no authorisation: every prompt, steer, queue, stop and attempt is still approved by its typed phrase on the
controlling terminal. The largest remaining cost (that typed phrase, once per message) is a security boundary, so it is described and
measured here, and what to do about it is left as a decision for the operator (§5.3).

- **Base:** `main` at `0732805b3` (PR #147 merged). Host: Linux, Node 26.13.1, Git, Chromium, Pi 1.5.2 installed.
- **Read first:** [develop-workbench.md](../../docs/develop-workbench.md), [develop-tasks.md](../../docs/develop-tasks.md),
  [REVIEW-PILOT-001](../review-pilot/README.md), [DEVELOP-VALIDATION-001](../develop-validation/DEVELOP-VALIDATION-001.md) and
  [-002](../develop-validation/DEVELOP-VALIDATION-002.md), [DEVELOP-VERIFY-TRUST-002](../develop-verify-trust-002/FOLLOW-UP.md).
- **What was run:** the README's no-agent tour, end to end, in a throwaway store (§7); the workbench under a real pseudo-terminal
  against the fake Pi (the new test); the built page in Chromium in 38 states, before and after. **No real model run was made**, and
  no approval was typed by the author on a real Pi session: an approval typed by an agent is not an operator's approval.

## 1. Current-state friction audit

The journey audited: open a project, start or resume a session, write prompts, steer, review the diff, run checks, finish. Counts are
from the code and the documented procedure on `main`, checked against the pseudo-terminal test and the tour run in §7.

### 1.1 Findings

| # | Friction | Where it comes from | Cost today | Kind |
| :-- | :-- | :-- | :-- | :-- |
| F1 | **Starting takes a long command.** `endo harness attach --cwd <dir> --control --workbench --project endo.project.<32 hex>` | `cli/harness.ts`: three flags that only make sense together, plus an id nobody remembers | 1 command, 4 flags, a 45-character id (so usually `endo project list` first: 2 commands) | accidental |
| F2 | **Registration looks mandatory.** The README's live procedure registers a project first, and the tour needs a project, a task and an attempt before anything is recorded | documentation order; the code already allows a workbench with no project | 1 to 3 commands and up to 3 ids before the first prompt | accidental (docs) |
| F3 | **The workbench page opens on Observe.** The operator came to work and must choose Develop first | `cli/workbench.ts` did not say `start: "develop"`; the workspace host does | 1 click per launch | accidental |
| F4 | **Pairing.** Read a code on the terminal, type it into the page | the grant must not be in a URL (develop-workbench §3) | 9 characters, 1 click, 2 context switches, once per launch (and again after a reload: the page keeps no storage) | deliberate boundary |
| F5 | **Every message is approved by typing a phrase.** `APPROVE PROMPT <16 hex>` on the terminal, for each prompt, steer, queue and stop | the page may ask, only the terminal authorises (develop-workbench §3) | 29 to 31 characters (`APPROVE STOP`, `STEER`, `PROMPT` and 16 hex) and 2 context switches per message | deliberate boundary |
| F6 | **The reply does not appear by itself.** After an approval the page stops reading; the operator presses *Read session* or switches *Follow* on, and Follow is off again after a reload | Follow is opt-in by design (develop-workbench §12) | 1 click per launch, or 1 per look | deliberate default |
| F7 | **A recorded check needs the whole formal chain.** `endo attempt check` needs an attempt, which needs a task, which needs a project; and a clean, committed tree | receipts are attached to attempts | 3 commands and 3 pasted ids before the first receipt | structural |
| F8 | **Ids are carried by hand.** Each command prints the id the next one needs, 42 to 45 characters, inside a JSON document | CLI contract: one canonical-JSON document per command | 9 id pastes in the tour (§7) | structural |
| F9 | **Reading evidence in the terminal is JSON.** The operator stopped REVIEW-PILOT-001 part-way for this reason | same contract | the pilot was not completed | structural |
| F10 | **The page was dense and flat.** Three boxed columns of equal weight, 11 px labels, standing prose in every panel, the request waiting for approval not visually distinct from history | `studio-ui/src/studio.css` | reading cost, not a count | presentation |
| F11 | **Two terminals' worth of attention.** The conversation is in the browser, the authority in the terminal; a request waiting there is easy to miss | the same boundary as F5 | a request nobody answers expires after 5 minutes, unsent | consequence of F5 |

"Accidental" means nothing depends on it. "Deliberate" means a documented decision protects something. "Structural" means it follows
from how records are attached to each other.

### 1.2 What the audit supports

- **F1, F2, F3 and F10 can be fixed without touching any boundary**, and are (§5).
- **F4, F5 and F11 are the authorisation contract.** They are the dominant cost of a real session (§6: 20 context switches and 307
  typed characters for ten messages), and they are also the only thing between a page script and the agent. This PR does not change
  them. §5.3 sets out what could reduce them without moving authority off the terminal, with its costs, as a decision for the operator.
- **F6 is a small, safe change in mechanism but a recorded decision** ("following is opt-in, bounded and pausable"). It is proposed,
  not made (§5.3).
- **F7, F8 and F9 are the formal layer.** The proposal is not to shorten that layer but to make it optional (§2): everyday work should
  not need it, and when the operator does need it, the readable surface is the page, not the terminal.

## 2. The proposed everyday interaction model

One sentence: **the operator works with Pi through the workbench as they would with any agent; Endophasia records what its own
process observes; tasks, attempts, plans and stronger verification are added only when the operator asks for them.**

### 2.1 Four levels, each optional beyond the first

| Level | The operator does | Endophasia records | Needs |
| :-- | :-- | :-- | :-- |
| **0. Session** (everyday) | `endo develop` in the project directory; pair; talk to Pi; read the diff in *Changes* | the canonical event log of the session (structure, keyed digests, usage; never the text), each request's chain (proposed, authorised, dispatched, accepted or refused), runtime identity and capability evidence | nothing registered |
| **1. Project and tasks** | names the project once (`endo project add`), starts with `--project`; writes tasks on the page | the operator's own metadata: tasks, statuses, notes, explicit session links | a registered project |
| **2. Attempts, plans and receipts** | prepares an attempt with a plan; runs `endo attempt check` | briefs, receipts (what Endophasia observed of the operator's command at a clean commit), Git observations around a send | level 1, and a committed tree |
| **3. Independent verification** | *(not available)* | *(nothing: no separate-principal verifier is installed; DEVELOP-VERIFY-TRUST-002 found this host fails its H0 precondition)* | a host and an installation the operator has not approved |

Level 0 already exists in the code: a workbench without `--project` shows "No project" and works. What was missing was a short way to
start it and documentation that leads with it. Nothing at a higher level is required by a lower one, and nothing is inferred upward:
a session does not become a task, a passing command does not become acceptance, and a receipt does not become independent.

### 2.2 The four words, and what each may be used for

The page and the documents must keep four kinds of statement apart. This table is a **proposal for the vocabulary**, with what the
interface does today in the fourth column. It is not a description of marks that all exist: the interface's basis marks (observed,
reported, derived, inferred, unavailable; `studio-ui/src/model/labels.ts`) are used in Observe and Compare and on the ledger, and its
"reported" means *reported by the runtime*. The operator's own declarations in the Task view carry no mark; they are worded.

| Word | Meaning | Examples in DEVELOP | Today | Never described as |
| :-- | :-- | :-- | :-- | :-- |
| **Observed** | Endophasia's own process saw it happen | a live Pi event it received; the exit status and output digest of a check it ran; what Git showed when it read the tree | the observed mark (teal, disc) on events and receipts | verified, confirmed, correct, authored by the agent |
| **Declared** | someone said so, and Endophasia kept the statement | Pi's disposition and its report of how a run ended; the operator's task status, handoff, reported result and plan | a runtime's report: the reported mark (blue, half disc). The operator's statement: no mark, said in words ("recorded by you", "Result reported, not verified") | observed, or true |
| **Independently checked** | a principal the agent cannot influence re-derived it | **nothing today** | (no mark exists; none is added) | — |
| **Unknown** | not established | a reply that was not seen; a check not run at HEAD; a damaged record; the environment a check ran in | the unavailable mark (slate, dashed ring) where a value is marked; otherwise a sentence naming the gap | absent, failed, or fine |

Derived statements (violet, diamond) stay what they are: something computed from the others, such as a criterion read from its
checks; "inferred" likewise. Whether the operator's declarations should carry a mark of their own is a design question this slice
does not answer. Two rules follow, and §4 makes them testable:

1. A receipt made by `endo attempt check` is **observed**, by a process running as the operator, in an environment it did not record.
   It is not independently checked (DEVELOP-VALIDATION-002, F1).
2. Until a separate-principal verifier exists, the page does not say "verified" about a candidate, a receipt or a run. In
   `studio-ui/src` the word appears for Endophasia's own validated reads of its store ("verified store", "verified inventory", "last
   verified position"), for what is *not* verified ("Result reported, not verified", "Not independently verified", "could not be
   verified") and in the names of the plan and receipt records. Only the page was read for this; the CLI's wording was not audited.

### 2.3 The everyday session, step by step

1. `cd` to the project and run `endo develop`. *(new: one word; it is `endo harness attach --control --workbench`, without
   `--prompt`.)*
2. Open the printed address. The page is on **Develop**. *(new)* Type the pairing code from the terminal.
3. Write a prompt; press **Request prompt**; approve it on the terminal with its phrase. *(unchanged)*
4. Switch **Follow** on once, or press **Read session**. *(unchanged; §5.3)*
5. While a run is open: **Steer**, **Queue** or **Request stop**, each approved on the terminal. *(unchanged)*
6. Read the diff in **Changes**. Run your tests in your own shell as you always do. *(unchanged; at level 0 this is not recorded,
   and the page does not say it was)*
7. Ctrl-C on the terminal. The session's record is in the store; `endo studio` reads it later.

When a piece of work deserves a record of what was asked and what was checked, the operator moves up: registers the project (the
terminal now says how, when the directory is already registered), writes a task, prepares an attempt.

### 2.4 Compatibility with future harness adapters

Nothing here names Pi in a new place. `endo develop` is the attach command's alias and inherits whatever harness selection that
command gains; the page still reads capabilities from the broker (`offers`), and the session surface
(`endo.develop-session-surface.v0`) is untouched. No second runtime and no second ledger: the slice adds no record kind, no store
file and no route.

## 3. Security boundaries and residual risks

### 3.1 Boundaries, each unchanged by this PR

| Boundary | State | How this PR is known not to move it |
| :-- | :-- | :-- |
| Only the controlling terminal authorises a prompt, steer, queue, stop or attempt | unchanged, and stricter under the new name | `endo develop` runs the attach with the two switches added to what was parsed (never to the argument list), and refuses `--prompt`, which on `harness attach` sends at launch with no phrase. No broker, approver or phrase code was edited. The test types the right phrase with a trailing space (nothing sent, transcript empty), then the exact phrase (accepted, transcript not empty) |
| The terminal must be the process's controlling terminal | unchanged | `endo develop` without a terminal fails with the same status and the same bytes on stderr as the attach, before a store exists; seven malformed spellings (a switch as a value, a flag without one) all fail before Pi is looked for (tested; see the review, finding 1) |
| Pairing: a one-time code from the terminal; the grant lives in page memory | unchanged | a request without a grant is refused 401 (tested); no storage was added to the page |
| The page keeps no storage; live text is memory-only and never reaches evidence | unchanged | no script change beyond one decorative SVG; the page policy and Trusted Types are as before (browser suites) |
| `endo studio` is read-only and its page is served byte for byte | unchanged | only the workbench launch passes `start`; `cli/studio.ts` passes none. (No test fetches Studio's served page for this; the existing test checks the built file carries no `data-start`.) |
| A project is named by the operator, never inferred | unchanged | the new terminal line is a **hint**: it selects nothing. The launch still has no project and the workspace route still answers its constant (tested) |
| Colour grammar: hue carries provenance and attention; ivory is selection and focus only | unchanged | the token names, the "ivory is no other token" test and every mark are kept; the new ground glow and washes are hueless |
| No animation except the spinner and Field's horizon | unchanged | the redesign uses transitions only; the source test's exact list of animations still passes |

### 3.2 Residual risks

| Risk | Why it remains | Mitigation or owner |
| :-- | :-- | :-- |
| **A shorter command lowers the cost of starting an unsandboxed agent.** | `endo develop` is easier to type than the attach it stands for; Pi's tools still run with the operator's permissions | the terminal's banner and the approval text say so each time, as before; isolation of Endophasia-launched agents is DEVELOP-VERIFY-TRUST-002's arrangement C, not designed here |
| **The hint reads the task file in a launch that named no project.** | to say "this directory is registered as …" it reads `develop/tasks.json` once, read-only | it prints what a valid task file says, on the operator's own terminal; an unreadable or absent file prints nothing, and control characters cannot pass the file's validator. **The file is writable by anything running as the operator, including the agent**, so the name and id are not proof the operator registered them: the line says "the task file registers…" and tells the operator to check with `endo project list` before using the id. Compared by resolved path equality, the rule the workspace already uses |
| **A stale or hand-edited frontend build now stops the workbench at launch.** | opening on Develop marks the page's root element and refuses a page whose root is not the one the build writes | fail closed, as the workspace host does; rebuild with `npm run build:studio-ui` |
| **Level 0 leaves ordinary test runs unrecorded.** | a check is recorded only through an attempt (F7) | stated in §2.3 and in the acceptance criteria; the page claims nothing about it |
| **Receipts remain same-user observations (F1).** | no separate principal exists | §2.2 rule 1; no wording changed toward "verified" |
| **Approval fatigue.** About thirty typed characters per message invites approving without reading | the boundary's own cost (F5) | the terminal shows the exact text first; §5.3 proposes a terminal-entered prompt, which removes the fatigue for the common case without giving the page any authority |
| **A prettier page can read as more trustworthy.** | polish is persuasive | no claim was strengthened: every label, basis mark and limitation sentence is the one on `main` |
| **Visual regressions outside the states captured.** | 38 states were compared; Observe and Compare were checked by their browser suites, not screenshot by screenshot | the suites pin behaviour and layout; §8 lists what was looked at |

### 3.3 Changes considered and rejected because they would weaken a boundary

- **Showing the approval phrase on the page with a Copy button.** It would turn 31 typed characters into a paste, and it would break
  the property that makes the phrase worth anything: today the operator can only get the phrase by looking at the terminal, where the
  exact text to be sent is printed above it. A page that supplies the phrase lets a compromised page show one text and have another
  approved by an operator who never read the terminal. Rejected.
- **An Approve button in the browser,** in any form. Already rejected in develop-workbench §11; nothing here reopens it.
- **Remembering the grant across reloads** (storage, a cookie, the URL). The grant is authority to ask and to read private text; the
  page keeps no storage by policy. Rejected.
- **Choosing the project from the working directory.** Convenient, and exactly the inference develop-tasks.md forbids. The hint is the
  most that is safe.
- **Recording a level-0 shell command automatically** (wrapping the shell, watching the tree). A second runtime in all but name.

## 4. Usability acceptance criteria

Measurable, and checked for this slice where marked.

| # | Criterion | Measure | This PR |
| :-- | :-- | :-- | :-- |
| U1 | A first prompt can be requested with no project, task or attempt registered | commands before the address is printed: **1**; ids typed: **0** | met (test: `endo develop <root> --pi … --cwd …`, no `project`) |
| U2 | Starting needs no flag the operator must remember | flags on the everyday command: **0** (in the project directory, default store) | met |
| U3 | The page opens where the work is | clicks from address to the pairing field: **0** | met (test: `data-start="develop"`) |
| U4 | Approvals are not weakened | every request is refused or waits until its exact phrase is typed on the controlling terminal; a wrong answer sends nothing | met (test), unchanged code |
| U5 | The optional layers are discoverable, not imposed | when the task file registers the directory and no project was named, the terminal says so once, with the id and how to check it; it selects nothing | met (test; no negative cases for two registrations or an unreadable file) |
| U6 | Recording is never called verification | no string on the page applies "verified" to a candidate, a receipt or a run (§2.2 rule 2) | holds on `main` and after, for the page; checked by reading every occurrence in `studio-ui/src`. Not automated, and the CLI was not audited |
| U7 | A request waiting on the terminal is the most visible thing on the page | at 1440 px it is the only plate with an attention rule and a lifted surface in the conversation, and its chain reads as stations | met by inspection of the captures (§8); not a measured study |
| U8 | Nothing is harder to read than before | body text at least 13 px; label contrast at least 4.5:1 on its ground; no horizontal overflow at 390 px | met: tokens computed (§8); the existing 390 px browser tests pass |
| U9 | Per-message cost | context switches per message: **2**; typed approval characters: **29 to 31** | **not improved** (§5.3) |
| U10 | A human finds it pleasant | a supervised session by the operator | **not established**: no human pilot was run |

## 5. The implementation slice

### 5.1 What this PR changes

| Change | Files | Friction |
| :-- | :-- | :-- |
| `endo develop [...]`: `endo harness attach [...] --control --workbench`, refusing `--prompt` | `cli/harness.ts`, `cli/index.ts`, `cli/help.ts` | F1, F2 |
| The workbench's page opens on Develop | `cli/workbench.ts` (one option, already supported by the host) | F3 |
| A hint when the launch directory is a registered project and none was named | `cli/workbench.ts` | F2 |
| The interface is redrawn (§8) | `studio-ui/src/studio.css`, one SVG in `studio-ui/src/App.tsx` | F10, F11 |
| The README's live procedure leads with `endo develop` and says tasks are optional | `README.md`, `docs/develop-workbench.md`, `CHANGELOG.md` | F2 |
| Tests | `tests/develop-ux-001.test.ts` | |

No protocol, storage, broker, route, schema or approval code is touched. No dependency is added.

### 5.2 What it deliberately does not change

F4, F5, F6, F7, F8, F9: see §1.2.

### 5.3 Decisions for the operator (not made here)

**D1. A prompt typed on the terminal itself.** The largest cost is the round trip: write in the page, approve on the terminal. The
terminal is already the authority, and `endo harness attach --prompt "…"` already sends a prompt on the strength of the operator
having typed it there, with no phrase. A `say <text>` line at the workbench's `>` prompt would be the same act during a session. It
is **not** in this PR because it is a new authorisation act, not a presentation change, and its costs are real:

- **The read-back disappears.** Today an approval is bound to the digest of text the terminal displayed back. A typed line is sent
  as typed: a typo, or a paste the operator did not read, goes to the model.
- **It is one line.** The page's composer is multi-line; readline is not, and a pasted block must not send itself line by line.
- **The same `>` line answers approvals,** where anything but the phrase declines. A `say` typed just as a page request arrives
  would decline that request; a phrase typed late would be a stray line.
- **It saves less than it seems.** The prompt is written on the terminal and still read in the page, so the round trip remains; what
  goes is the phrase and the *Request* click.
- The authorisation record needs a new confirmation value (as `terminal-phrase` was added for slice B), and it interacts with STOP's
  preemption.

A smaller alternative that keeps the read-back was not studied and should be: a shorter confirmation on the terminal (for example
the first four characters of the digest, or Enter on an empty line within a few seconds of the text being shown). That changes how
much is typed, not where authority sits, but it weakens the binding between the phrase and one request and needs its own analysis.
**Recommendation: design D1 and the shorter confirmation together, as DEVELOP-UX-002, and decide between them there.** Neither is
recommended for building on the strength of this document.

**D2. Follow after your own request.** Switching Follow on when a request made from this page is accepted, and off when the run ends,
would remove F6. The read is the paired page reading the broker's memory, as Follow does now. It contradicts a recorded decision
(following is opt-in), so it needs the operator's word. **Recommendation: accept, bounded to the run the page itself started.** Of
the options here it is the one with a clear gain and no authority question.

**D3. A readable evidence page instead of terminal JSON (F9).** Not proposed. The operator said in an earlier working session
(2026-11-11; the author's session notes, not a record in this repository) that they did not want a one-page review view built, and
this document does not reopen that.

**D4. Receipts without the formal chain (F7).** A "quick check" attached to the session rather than to an attempt would make level 0
record tests. It is a new record relationship and would blur what a receipt is evidence *for*. **Recommendation: do not, until a
pilot shows operators want it.**

**D5. Recording a Pi session the operator ran in Pi's own interface.** A read-only observer of Pi's saved sessions, as exists for Oh
My Pi, would let the operator use Pi with no workbench at all and still see structure afterwards, all of it *declared by Pi's file*.
It is adapter work with its own conformance question. **Recommendation: after D1.**

## 6. Existing and proposed, in counts

One session: start, ten messages (eight prompts, one steer, one stop), read the diff, finish. The project is in its directory and the
default store is used. "Existing" is the README's procedure on `main`.

| | Existing | Proposed (this PR) | With D2 (not built) |
| :-- | :-- | :-- | :-- |
| Commands before the address is printed | 2 (`project list` for the id, `harness attach …`); 3 the first time (`project add`) | **1** (`endo develop`) | 1 |
| Flags and ids typed to start | 3 flags and one 45-character id (4 flags with `--cwd`, as the README wrote it) | **0** | 0 |
| Clicks from the address to the pairing field | 1 (choose Develop) | **0** | 0 |
| Pairing | 9 characters, 1 click, 2 context switches | the same | the same |
| **Approvals required** | **10, one per message** | **10, one per message** | 10, one per message |
| Typed approval characters | 307 (8 × 31, 30, 29) | 307 | 307 |
| Context switches for ten messages | 20 | 20 | 20 |
| Clicks to see replies | 1 (Follow) per launch, or 1 per look | the same | 0 |
| Clicks to read one file's diff | 2 | 2 | 2 |
| To finish | Ctrl-C | Ctrl-C | Ctrl-C |
| Records made | the session's events and request chains | the same | the same |

D1 is left out of the table on purpose: an earlier draft claimed it would cut the switches to four, and the review showed that was
wrong (the prompt is typed in one window and read in the other either way). Its saving is the phrase, roughly 250 characters here,
bought with the costs listed in §5.3.

The slice removes every interaction that protected nothing (the start goes from 2 commands, 3 or 4 flags, an id and a click to one
word). It removes none that protects something, so the per-message cost, which dominates, is exactly what it was.

## 7. A realistic workflow, run

**The README tour, as written, in a throwaway store and repository** (Calculator, operator precedence; the author played the agent,
as the tour says to). Every command succeeded. Counted:

- 10 `endo` commands for one fix: `project add`, `task add`, `attempt prepare`, `attempt check` twice, `attempt evidence` twice,
  `attempt observe`, `attempt provenance`, `workspace open`.
- 3 ids to carry (45, 42 and 45 characters), pasted 9 times.
- Each command printed a JSON document; the two lines an operator needs from `attempt check` (the `recorded:` and `plan:` lines) come
  after it.
- The first check, at the buggy commit, printed **"Observed check passed"** (exit status 0, exit code 0) and then the plan line
  saying the run does **not** match the declared output. Both are correct and both are labelled (this is B1, resolved for the
  terminal in DEVELOP-VALIDATION-002), but a reader skimming sees "passed" first.

**The live path** was exercised as `endo develop` under a real pseudo-terminal against the fake Pi (`tests/develop-ux-001.test.ts`):
start, the hint, the page's start marker, an unpaired request refused, pairing, a request declined by its own phrase with a trailing space and nothing
sent, a request approved by its exact phrase and accepted, a clean exit on Ctrl-C.

**Limitations, stated plainly.**

- No real Pi and no model were run. The fake Pi is a real child process speaking Pi's RPC, not Pi.
- The approvals in the test were typed by a test script. That is the established way these tests run; it is not an operator's
  approval and says nothing about how the phrase feels to type ten times.
- The counts in §6 are derived from the code and the procedure, not timed with a person. No human used the redesigned page.
- The tour is the no-agent path. The live path with a task, an attempt and a behavioural plan was not run (it needs the operator at
  the terminal; DEVELOP-VALIDATION-002 §6 lists the same gap).

## 8. The redesign

**Scope, honestly.** The visual system was rebuilt at its foundation (the tokens every rule reads, the frame, panels, controls,
inputs, labels) and the live workbench's components were redrawn (conversation, the operator's turns, requests and their chains, the
composer, the session rail). The component tree, every id, class, label and sentence, and every behaviour are as on `main`: it is a
new drawing of the same instrument, not a rewrite of the application, and it is one pass, not a finished design system (the Task view, Compare and the Observe
inspector were restyled only through the shared foundation). Field is kept as the second appearance. It inherits the foundation
(ground, radii, pills, type) and keeps its own top bar, cards, chain and modes without the Instrument's fills and lifts.

**The idea: a nocturne.** The specimen cabinet, read by lamplight.

- **Ground.** Ink rather than graphite (`#08090c`), with one faint, hueless glow fixed above the work, so the page has a light source
  and depth without spending a hue.
- **Plates, not boxes.** Panels, cards and the composer are soft-cornered plates (10 px) with a hairline of light on the upper edge
  and a close shadow; controls on them are 6 px; states, chips and modes are pills. Borders inside a plate are hairlines.
- **Type.** Section and role labels move to mono, smaller and wider-spaced, so labels read as the instrument's voice and sentences as
  the operator's and the agent's. Body text is unchanged in size; the composer's is a step larger.
- **The operator's words** sit on a wash under the ivory selection rule; the agent's are set on the page.
- **A request waiting for the terminal** is a lifted plate with the attention rule, and its chain is a row of stations: reached ones
  filled, the rest outlined, never merged.
- **The frame.** The top bar is translucent over the glow and its rule fades toward both ends; the name gains a sigil (a word held
  inside a ring: inner speech).
- **Movement.** Colour, border and background ease over 130 ms on what the pointer or focus is on. Nothing animates by itself; the
  source test's closed list of animations is unchanged, and under reduced motion the new transitions are off.
- **Colour grammar.** Unchanged: hue is provenance and attention, ivory is selection and focus. The provenance hues were lifted
  slightly for the darker ground.

**Contrast on the new ground** (WCAG relative luminance, text on `--surface-1`): `--fg-1` 15.6:1, `--fg-2` 9.6:1, `--fg-3` 6.4:1
(5.6:1 on the lightest plate, `--surface-3`). `--fg-4` (3.5:1) is not used for anything that is read: placeholders are `--fg-3` (the first draft set them in `--fg-4`; the review caught it).
Not checked: forced-colours mode, where the top bar's gradient rule may not be replaced, and print.

**Captures** (real browser, real broker, synthetic conversation and repository; nothing here is a model's output):
[before](images/before-approval-pending-1440.png) ·
[after, a steer waiting for the terminal](images/after-approval-pending-1440.png) ·
[after, reading a diff](images/after-diff-1440.png) ·
[after, Field](images/after-field-approval-1440.png) ·
[after, phone](images/after-phone-390.png) ·
[after, Observe](images/after-observe-1440.png).
The 38 states compared before and after are the ones `tests/endo-studio-field-shots.test.ts` writes; only these six are committed.

**Options.** *Instrument | Field* remains the appearance switch on Develop. Tasks, attempts, plans and receipts are options by
construction (§2.1). No setting was added.

## 9. Independent review

See [REVIEW.md](REVIEW.md).
