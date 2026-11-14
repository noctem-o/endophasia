# The Living Instrument: independent reviews

2026-11-14. Two reviews by fresh-context general-purpose Claude subagents with no part in the work, both read-only and instructed to be
adversarial. They are a model's reviews, not a person's.

- **Visual critique**: of the first iteration's screenshots (59 captures, with the "before" set and the rejected direction beside
  them). It opened 40 of them and judged pixels only. It did **not** see the second iteration, the gauge, or the course above the sessions.
- **Technical review**: of the second iteration's source. The tree changed under it while it read (the course moved above the sessions
  and Follow became the default, both on the operator's word, mid-review); it says which findings are against which state. A first
  attempt at this review ended on a rate limit before reporting anything and was run again from the start.

No second round was run on the fixes below. What was fixed is covered by the tests named; what was not is said.

## Visual critique (first iteration)

| # | Severity | Finding | Disposition |
| :-- | :-- | :-- | :-- |
| V1 | HIGH | Phone attempt view: the sticky run line drawn over scrolled text; a request's stations as tall empty ovals; command lines cut | **Fixed** the first two. The run line had lost its background in this change (an existing test also caught it). The ovals were from #148: a task's list items are columns, and #148 gave the stations a border. **Not changed:** the command lines scroll sideways as before |
| V2 | HIGH | Broker not answering: the status clipped mid-word and overprinted by the tag | **Fixed.** The state line wraps; the tag has its own place beside the name. `after-unreachable-1440.png` |
| V3 | HIGH | The course clipped at the foot of the rail in most states, and starving the session list (one and a half sessions at 1366×768) | **Fixed by redesign.** Fitted height: as tall as what it says. A test asserts that nothing in it scrolls when fitted |
| V4 | HIGH | The dots mean nothing without the sentence; two lit at once reads as a fault | **Fixed by redesign.** A lane is a scale with one needle and the state in words beside it; "tool running" and "writing" are words |
| V5 | HIGH | The lit dot was provenance-coloured when calm and attention-coloured when not; blue also on the radio, the reasoning label and links | **Fixed** for the course (needle in the text colour; amber and red the only overrides; provenance only on the mark) and the radio. **Not changed:** the reasoning label's and links' blue, which predate this change |
| V6 | MEDIUM | The current stage's name truncated because bold widened it | **Fixed.** Six equal columns; the current stage is marked by colour and a rule, not weight |
| V7 | MEDIUM | "One ruled sheet" only in the live desktop state | **Accepted as a limit**, stated in DESIGN.md §6 and in the style sheet |
| V8 | MEDIUM | Capitals and tracking not removed consistently | **Partly fixed**: table headers, task and change headings, the reasoning label. **Kept by decision**: the provenance codes (OBS, REP, DER) and all of Field |
| V9 | MEDIUM | Tertiary text too dim and too small | **Partly fixed**: the new and restyled text has a 12 px floor (11.5 px for the row's kind tag) in the second grey; "recorded only" is no longer the fourth grey. **Not measured**: no contrast figures were computed for this change |
| V10 | MEDIUM | A sliver of scrolled text under the run line | **Not changed.** It predates this change; DESIGN.md §6 |
| V11 | MEDIUM | Three head lines (five at 1024 px); the stop button not distinct | **Partly fixed**: the stop control has a stronger outline. The head is unchanged; DESIGN.md §7.1 |
| V12 | MEDIUM | Wide screens wasted; the composer far from its button | **Partly fixed**: the composer is held to the text's measure; type steps up at 2200 px. At 3840 px the sheet is still an island |
| V13 | MEDIUM | The sessions drawer had no edge | **Fixed** by restoring the original drawer (its shadow had been lost when the wrapper was made `display: contents`, which also broke two existing tests) |
| V14 | MEDIUM | The tallest height sliced the filter chips and left the course half empty | **Fixed by redesign**: fitted and tall, each a whole grid row |
| V15 | LOW | An ivory bar across the top of two captures | **Not changed.** It is the skip link taking focus after the test pressed keys |
| V16 | LOW | "Chart" drawn as a link; uneven count wraps; a "paired" page told to pair; mixed button sizes | **Fixed** the first two. The other two predate this change |
| V17, V19 | NOTE | Better than before in the live desktop state; rejecting Folio was right | Recorded |
| V18 | NOTE | "Competent and tidy, not exceptional"; the Instrument is clean, not memorable | **Answered in part** by the gauge. Not re-judged; DESIGN.md §6 |

## Technical review (second iteration)

| # | Severity | Finding | Disposition |
| :-- | :-- | :-- | :-- |
| T1 | HIGH (scope) | Follow on by default arrived mid-review, against the "no polling" rule, and the reviewer could not confirm the decision | **The operator asked for it** in this session, after the review began. It is in the changelog, the workbench document and the design record as a reversal of the recorded opt-in decision. Three tests that pinned the old default were rewritten for the new one, including "switched off, nothing polls" |
| T2 | MEDIUM | Assent said "Not requested" when the broker had the request as sent, bound or refused | **Fixed.** Sent or bound is "unknown, observed: its records are not read yet"; refused is "Requested, and not sent". Tested |
| T3 | MEDIUM | The stages could chart the newest attempt while the request in flight was for another | **Fixed.** `courseAttempt` charts the attempt the open request names, as `nextStep` does. Tested |
| T4 | MEDIUM | Run was "not taken" where the truth was unknown (the log unreadable) or not yet (no send recorded) | **Fixed.** Tested for every send state |
| T5 | MEDIUM | A superseded failed check was a permanent fault; receipts could settle Check against a plan that had not run at HEAD; closed attempts raised attention for ever | **Fixed.** With a plan, Check follows the plan's ledger; without, the newest check; a closed attempt raises nothing. Tested |
| T6 | MEDIUM | Tool calls held before the first held run marker were dropped from the counts | **Fixed.** They belong to a run whose start is not held. Tested, with the two cases that must not invent a run |
| T7 | LOW | "Stands at Send" for ever after a send with no reply | **Fixed.** Tested |
| T8 | LOW | Handed-off and abandoned attempts stood at stages that could never happen | **Fixed.** Tested |
| T9 | LOW | A partly read log and a changed brief were not said; the attempt's session is not compared with the live one | **Fixed** the first two. **Not fixed:** the stages do not name the session an attempt ran in; docs/develop-course.md §6 says so |
| T10 | LOW | "flagged" summed per-flag counts | **Fixed in the wording**: it now says flags |
| T11 | LOW | With the broker not answering, a node was still current for assistive technology and in the chart | **Fixed.** No node is on; the words begin "last reported". Tested |
| T12 | LOW | A run asked to be shown and no longer held left state behind that could move focus later | **Fixed.** Answered once, then cleared |
| T13 | LOW | The station fix was global and lost to Field's own rule | **Fixed.** Scoped to stations inside a task, in both appearances |
| T14 | LOW | Forced colours dropped the current stage and the selected session | **Fixed** in the forced-colours block. Not rendered |
| T15 | LOW | Field with the dock closed hides the course | **Kept, and documented** |
| T16 | NOTE | "Four heights" in three comments and a test title; a rule defined twice; a click on the dialog's padding closes it | **Fixed** the first two. The third is the existing dialog's behaviour, kept |
| T17 | NOTE | "idle" is the broker's derivation from Pi's run events | **Kept** as "reported", which the reviewer found defensible |
| T18 | MEDIUM, suspected | A press on the separator could collapse a fitted course, because snapping used shares of the rail | **Rewritten** to thresholds measured from the course's own top. **Untested**: no pointer test exists |
| T19 | MEDIUM, suspected | The separator's lower half sat under the next panel | **Fixed** by raising the course above its neighbour. Not exercised |
| T20 | MEDIUM, suspected | The first moving request was shown, not the one waiting for the operator | **Fixed.** Tested |
| T21 | LOW, suspected | The composer's measure does not follow the type's step up at 2200 px | **Not fixed** |
| T22 | LOW, suspected | In a window under 540 px tall the separator announces heights that do nothing | **Not fixed** |
| T23 | LOW, suspected | Caveats reordered visually against the DOM | **Kept by decision**; DESIGN.md §3 |

**What the reviewer checked and found correct:** nothing changed under `cli/`, `adapters/`, `protocol/`, `storage/`, `cockpit-http/` or
`runtime/`; the course's two modules contain no fetch, storage, timer or inline style; every send and run state reaches a branch; "tool
running" needs the broker's open run, the newest held run open and a running row; the dialog's focus handling; unique ids; the grid in
every mode; the separator's ARIA.

**What nobody verified:** dragging the separator; forced colours, reduced motion and print as rendered; Firefox and Safari; a screen
reader; the second iteration's look, by anyone but the author; a real Pi and model; a person working in it.
