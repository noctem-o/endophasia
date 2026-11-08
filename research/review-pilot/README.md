# REVIEW-PILOT-001: can the operator decide from the evidence alone?

**Status: prepared, NOT RUN.** The run needs a person at the terminal. An approval typed by an agent is not a review.

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
# 1. Load the model (the router does not autoload), then check the host:
curl -X POST http://127.0.0.1:8081/models/load -H 'content-type: application/json' -d '{"model":"Muse-Glimmer-30B-Abliterated-Q4_K_M"}'
node research/work-cycle/driver.ts doctor --pi "$(command -v pi)" --expect-pi-version 1.5.0 \
  --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M

# 2. The run. Runs go to ~/projects/endophasia-research/rp001/<stamp>/; that name is short because of the control socket's path limit.
PONYTAIL_DEFAULT_MODE=off node research/work-cycle/driver.ts run --study review-pilot-001 \
  --pi "$(command -v pi)" --expect-pi-version 1.5.0 --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M
```

On the workbench terminal:

1. Type `attempt <id>` and read the whole brief.
2. Type the full `APPROVE ATTEMPT <16-hex code>` phrase, or anything else to decline.
3. Press Ctrl-C when the run has ended.

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

## Results

Not run yet. After the run, this section gets the filled worksheet (summarised, not the raw run), the decision, and the
findings. The run directory stays in `~/projects/endophasia-research/rp001/` and is not committed.
