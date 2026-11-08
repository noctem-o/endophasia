# REVIEW-PILOT-001: can the operator decide from the evidence alone?

**Status: RUN on 2026-11-08 (two runs, one a deviation); the operator's review and decision are PENDING.** An approval, a review or a
decision typed by an agent is not this pilot, so none was.

**Question.** For one task whose check does not settle it, can the operator make the accept-or-reject decision from Endophasia's
records and the candidate diff alone? And where they could not, which missing record would have answered it?

WORK-CYCLE-001B (`research/work-cycle/WORK-CYCLE-001B.md` §5) left several items waiting for a real review that needs them:

- the candidate revision (item 3);
- the revision the operator decided on (item 4);
- constraint compliance (item 5);
- the gap list on the page (item 7);
- the approval code's usability (item 1).

This pilot is that review. It decides which of those items to build, and in what order, from what a reviewer actually missed rather
than from guesses.

## Why this task

In 001A/B the check was the whole acceptance criterion: once `node --test` passed, nothing was left to judge. Here the
[fixture](fixture/) is a small duration parser, and the task is to add days (`d`). Its four acceptance criteria are:

| # | Criterion | Covered by the check? |
| :-- | :-- | :-- |
| 1 | `node --test` exits 0 at a clean commit; `test/` unchanged | **yes** (and `test/` by the reconstruction) |
| 2 | README.md's Format section documents `d` | **no**: read the diff |
| 3 | inputs without `d` behave exactly as before, and rejected inputs stay rejected | **partly**: the tests sample it; the reviewer judges the rest |
| 4 | no new files, no new dependencies | **no**: read the diff and the status |

At the fixture commit the check **fails** (3 tests pass, 2 about days fail), and that is recorded as the baseline, as in 001A.

The fixture stays a fixture, not one of your real projects. Pi runs unsandboxed with `bash`, so a disposable copy is the safe place
for it, and the same task can be run again.

## Procedure

Use the same host setup as 001B: Pi 1.5.0, Glimmer on the llama.cpp router (`models_autoload: false`), and Ponytail declared off.

```sh
# 1. Load the model (the router does not autoload). The load request answers {"success":true} at once while the model is still
#    loading, and the driver's doctor refuses "loading", so wait for "loaded":
curl -s -X POST http://127.0.0.1:8081/models/load -H 'content-type: application/json' -d '{"model":"Muse-Glimmer-30B-Abliterated-Q4_K_M"}'; echo
until curl -s http://127.0.0.1:8081/models | grep -q '"id":"Muse-Glimmer-30B-Abliterated-Q4_K_M".*"value":"loaded"'; do printf .; sleep 3; done; echo " loaded"

# 2. The run. Runs go to ~/projects/endophasia-research/rp001/<stamp>/; that name is short because of the control socket's path limit.
PONYTAIL_DEFAULT_MODE=off node research/work-cycle/driver.ts run --study review-pilot-001 \
  --pi "$(command -v pi)" --expect-pi-version 1.5.0 --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M
```

The driver prints the attempt's id. Then, **at the workbench's own `>` prompt in the same terminal**:

1. Type `attempt endo.attempt.<the id printed>`. That is a workbench command: not a shell command, and not something to type into
   the page. Read the whole brief.
2. The request must say `approve this attempt?` and ask for `APPROVE ATTEMPT <16-hex code>`. Type that whole phrase, or anything else
   to decline. If it asks for `APPROVE PROMPT`, it is a chat message to Pi, not the attempt: decline it.
3. Do not pair the page for this run. Unpaired it is read-only. Paired, its composer sends chat messages to Pi (run 1 below).
4. Press Ctrl-C when the run has ended.

After the workbench exits:

4. The driver shows the candidate diff and asks whether to commit exactly that. If you say yes, it runs the check and writes the
   reconstruction and **`evidence/review-worksheet.md`**.
5. **Review.** Use the commands printed in the worksheet, and fill in the worksheet *before* you decide. Record every source you
   used, including ones outside Endophasia's records (opening files, Pi's session, memory).
6. **Decide** with your own status moves: `in-progress → review → done`, or stop short of `done`. Put the reason in the note.
7. Run `node research/work-cycle/driver.ts reconstruct --run <dir>` again, so the reconstruction after the decision is kept too.

The agent (Claude) watches only read-only (`endo attempt show`) and types nothing on the workbench terminal.

## What counts as "the evidence was enough"

A criterion was **decidable from the evidence** if you answered it from `endo` output and the candidate diff, without:

- opening Pi's session;
- relying on memory of something you saw during the run;
- asking anyone.

Opening a file at the candidate commit counts as the diff.

Every other source in a worksheet answer is a finding: the record that would have replaced it is a candidate for the next PR.

## What the results decide

| If the worksheet shows… | Then the next step is… |
| :-- | :-- |
| the candidate could not be tied to the run from the records (B1) | before/after Git observations at the dispatch and at the run's end (001B item 3, approach 3) |
| the decided-on commit appears in no record (B2) | a revision on the `done` status move (item 4) |
| the constraints could not be checked from records (B3) | a design note on observing constraint compliance without exposing tool arguments (item 5) |
| the gap list mattered and the page lacked it (B5) | the gap list on the workbench page (item 7) |
| every criterion was decidable from the evidence | nothing new to build for review; the next study can move to a real project |

## Results (2026-11-08)

Same host as 001B: Pi 1.5.0, Glimmer on the llama.cpp router (b11429), Ponytail 5.3.3 declared off and observed off. The operator
approved every send on the workbench terminal. The agent (Claude) typed nothing there, and watched read-only with `endo attempt show`.
Run directories are under `~/projects/endophasia-research/rp001/` and are not committed.

| Run | What happened | The attempt's records |
| :-- | :-- | :-- |
| `20261108T163227Z` (false start) | `doctor` saw the model `loading` (the load request had just answered) and refused. Nothing was started | none (only `doctor.json`) |
| `20261108T163601Z`: run 1 (**deviation**) | The operator typed a bare `attempt` at the workbench (it printed its help), then typed `attempt endo.attempt.588db035…` into the **paired page's composer**. The page sent those 53 bytes to Pi as a chat message; the terminal asked `approve this prompt?` / `APPROVE PROMPT …`, and the operator approved it. Pi, given only that line, worked from the repository and the failing tests: 32 turns, run `completed`. The operator committed the candidate; the check passed | **not authorised**, no send, no execution: correct, since the brief was never sent. The commit and the passing receipt are linked to the attempt only by the driver's commit and check |
| `20261108T171344Z`: run 2 | The operator typed `attempt endo.attempt.0c87322c…` at the workbench's `>` prompt, read the 1794-byte brief, and typed `APPROVE ATTEMPT …`. One send, `runtime-accepted`, brief `matches`; run `completed` after about 3 minutes (32 model turns; tools: `bash` ×23 with 1 error, `read` ×8, `edit` ×2). Changed: `README.md` and `src/duration.mjs`; `test/` unchanged. The operator committed `54d40e4`; the check passed at HEAD. 0 processes left | authorised, sent, run completed; the only gap is `not-accepted` (the task is `open`) |

The candidate diffs of runs 1 and 2 are byte-identical (same blob ids for both files).

**The review and decision of run 2 are pending.** The operator was away from a terminal for some days. The worksheet
is blank, and the task is `open`. Its results will be added here, by the operator's answers, in a later change.

### Findings so far (from running it, before any review)

1. **A workbench command typed into the page becomes a prompt to the agent.** The page's composer sent `attempt <id>` to Pi as chat.
   The only difference the operator saw at approval was one word: `prompt` instead of `attempt`, and `PROMPT` instead of `ATTEMPT`.
   The records stayed honest (the attempt shows no send), but the operator ran an unattributed task by accident.
2. **"Type `attempt <id>`" was ambiguous.** The operator tried it in the shell (both bare and in backquotes), and then typed a bare
   `attempt` at the workbench. The workbench's help names `attempt <id>` without saying where the id comes from.
3. **The model's load request answers before the model is loaded.** `doctor` then fails on `loading`. The procedure now waits.

Findings 2 and 3 are fixed in the procedure above. Findings 1 and 2 are product problems, and are fixed in the workbench
separately.
