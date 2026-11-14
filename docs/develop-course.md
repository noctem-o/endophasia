# DEVELOP: the course

The course is the upper region of DEVELOP's session rail, above the sessions. It says what the selected session is doing and, when the selected task has a
prepared attempt, where that attempt stands. It is a **picture of state the page already holds**. It is not a workflow engine, and it is
not a verification.

Source: `studio-ui/src/model/course.ts` (pure adapter), `studio-ui/src/develop/Course.tsx` (drawing). Design record:
[research/develop-living-instrument](../research/develop-living-instrument/DESIGN.md).

## 1. Three things that are not the same

| | What it is | In this change |
| :-- | :-- | :-- |
| A chart that **visualises** state | Draws what the broker reported and what the records hold | Yes: this is the course |
| A machine that **governs** transitions | Decides what may happen next and makes it happen | No. The broker (`adapters/pi/workbench.ts`) and the terminal still decide everything, exactly as before |
| A system that **verifies** evidence | Establishes, independently, that a result is true | No. Nothing here checks anything |

A lane is drawn as a gauge: a scale with one tick for each state a session can be in, and a needle on the one it is at. The scale
does not record where the session has been, and it does not move it.

## 2. What it draws

**A live session** (a workbench with Pi attached): two lanes.

- **Run**: disconnected, idle, run open. What is happening inside an open run (a tool call with no result yet, a message being
  written) is said in words beside the scale, not drawn as a second state: one needle on each scale.
- **Request**: none, awaits terminal, sending, sent with the reply pending. A request and a run are separate lanes because they are
  separate facts: a steer can wait for the terminal while a run is open.

Beside each scale is the state in words and the mark of how it is known. A calm lane is that one line. A lane that waits for the
operator, is interrupted or is not known also shows its sentence; every lane's sentence is in the chart and is read by assistive
technology. Then the counts of what the page holds: runs, tool calls, tool calls reported as errors, and items dropped to stay within
the page's limit.

The needle is drawn in the text colour, amber when the lane waits for the operator, red when it is interrupted. Hue for provenance is
only on the small mark beside the words.

**An ordinary conversation needs no task.** With no managed attempt the course draws no stages, and the chart says so in one line.

**A prepared attempt** (a workbench or workspace host started with a project, a task selected, an attempt prepared): six stages, each read
from its own record. They lead the course when present.

| Stage | Read from | Never means |
| :-- | :-- | :-- |
| Brief | the attempt's prepared record | the brief is good |
| Assent | the attempt's recorded authorisation, or the broker's open request for this attempt | the work is approved |
| Send | the session's log (`execution.send`) | Pi did anything with it |
| Run | the session's log (`execution.run`): what Pi reported | the work is right ("completed" is Pi's word) |
| Check | the plan's ledger at HEAD, or with no plan the newest check Endophasia ran | the task's acceptance; a result holds for the commit it ran at |
| Judge | the operator's recorded outcome | anything but the operator's own statement |

These are the stages the records have. There is no Fix or Build stage because nothing records one; inventing them would be inventing
state. A stage's name is where the work is. Its status (happened, now, waiting, failed, interrupted, unknown, not yet, not taken) and its
basis are stated beside it.

**A recording**: its recorded lifecycle state (never a statement about a process now), its counts, the last run's reported outcome, and a
strip of the loaded events in storage order on four rows (run, message, tool, other). The strip is the activity table drawn small: a mark's
hue is the same provenance class the table shows, a brighter mark is flagged, the selected event is ivory, and a click on a mark selects
that event in the table. The keyboard path to an event is the table.

**Anything else** (nothing selected, a recording that is not inspectable, an Oh My Pi saved session, a host with no attempt): a short
sentence saying why nothing is drawn. No capability is assumed for a source that has not reported one.

## 3. How each statement is known

| Word | Mark | Meaning |
| :-- | :-- | :-- |
| observed | filled disc | Endophasia did or read it itself: the broker's own bookkeeping, a check it ran, a log it read |
| reported | half disc | The runtime said so. Nothing checked it |
| declared | ring signed with a line | The operator recorded it. Not evidence, so it takes no hue |
| derived | diamond | Computed on the page from the above, by a rule the text states |
| unknown | dashed ring | Nothing the page holds establishes it |

When the broker does not answer, no state is marked as where the session is: the scales are drawn dashed with no needle, the basis is
"unknown", and the words begin "last reported".

The live course is drawn from the broker's last status and the private transcript the page holds. That transcript is live text, not
recorded evidence, and the chart says so. What was recorded about a session is in Observe.

## 4. Where it sits, and how it is sized

| Width | Sessions | Course |
| :-- | :-- | :-- |
| 1360 px and wider, Instrument | left rail, lower | left rail, upper |
| 1024 to 1359 px, and Field at any width | a drawer | above the Context column, so it stays in view while the drawer is closed |
| below 1024 px | their own stage | at the head of the sessions stage, and at the head of the Context stage |

Where DEVELOP fills the window the course has three heights: closed, fitted (as tall as what it says, to a limit, so nothing in it is
cut and the sessions keep the rest) and tall. The separator on its lower edge is a keyboard-operable
splitter (`role="separator"`): Down makes it taller and Up shorter, Home closes, End is tall, Enter folds and unfolds. Dragging snaps:
pulled up to its head it closes, pulled past the middle of the rail it is tall, between them it is fitted. The heights are steps so that
nothing is set as an inline style (the page's policy allows none) and nothing needs storing; like every other choice on this page the
height is kept in memory only. In Field, closing the dock for a focused reading width closes the course with it.

Closed, the course keeps one line for assistive technology saying where the session stands, and shows "waits for you" when a request is
waiting for the terminal.

**Chart** opens the same content larger in a dialog: every state named, every stage with its sentence, the runs the page holds with
"Show in conversation" for each, and the legend above. Escape closes it and returns focus to the button.

## 5. What it does not do

- It sends nothing. Opening, resizing, folding and charting make no request.
- It approves nothing and offers no control over a session. Requests, withdrawals and the stop control are where they were.
- It stores nothing and adds no record, schema or route.
- It does not move, pulse or animate while idle. The page knows a session as of its last read; a mark that breathed would claim more.

## 6. Limits

- A run is counted from the "run started" marker the page holds. Runs from before the workbench started, before the page was paired, or
  dropped to stay within the page's limit are not counted, and the course says how many items were dropped.
- "tool running" is said only when the broker reports the run open and the newest held run has a tool call with no result. It is as old as
  the last read: a few seconds with Follow on (the default), and as old as the last press of Read session with it off.
- The attempt drawn is the one the broker's open request names, else the newest attempt of the **selected** task. Other tasks' attempts
  are in Task. The stages do not say which session an attempt ran in; Task does.
- Check follows the verification plan's ledger at HEAD when the attempt has a plan. Without one it follows the newest check Endophasia
  ran, which holds for the commit it ran at; how that relates to HEAD is in Task.
- A closed attempt (an outcome is recorded) no longer raises "look", whatever its run did.
- There is no orchestration engine behind the stages. If one is built, it is a separate project with its own design and review.
