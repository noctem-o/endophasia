# DEVELOP-VALIDATION-001: evidence index

All stores and repositories were disposable, created under the session's scratch directory, and removed after these excerpts were
frozen. Paths below are shown as `/work/...`. Commit ids are of the disposable repositories, so they are meaningful only within these
excerpts. Endophasia built from `main` at `07f8945a9`.

| Id | Scenario | Attempt | Revisions (in order) | Oracle | Excerpt |
| :-- | :-- | :-- | :-- | :-- | :-- |
| A | README tour, no Git identity | `endo.attempt.71839c9f…` | none (commit failed) | n/a | [A1 log](evidence/A1-tour-no-git-identity.txt) |
| A2 | README tour, identity set | `endo.attempt.99e75772…` | `750667c` wrong → `0135707` fixed | 2+3\*4 = 14 | [A2 log](evidence/A2-tour-with-identity.txt) |
| A3 | Steps 4-5 re-run with `attempt observe` (README fix check) | (fresh) | `4306811` fixed, `d637bcd` wrong | as A2 | §3 A3 in the report |
| T1 | Roman numerals; seeded additive (exit 0, wrong) → agent | `endo.attempt.23cfe545…` | `4ca5d19` seeded → `67c2ed4` agent | [roman.sh](oracles/roman.sh): FAIL → PASS | [T1](evidence/T1-evidence.txt) |
| T2 | Durations, add `d`; fixture → agent | `endo.attempt.4dece081…` | `943346f` fixture → `5abbdac` agent | [duration.mjs](oracles/duration.mjs): FAIL → PASS | [T2](evidence/T2-evidence.txt) |
| T2R | Planted: any unit order accepted (tests sample it) | `endo.attempt.1056c902…` | `943346f` → `d9a67f7` | FAIL (`5s2h`, `2h1d`) | [T2R](evidence/T2R-evidence.txt) |
| T2U | Planted: a repeated `d` accepted (nothing samples it) | `endo.attempt.d42ce0c6…` | `943346f` → `0dd67e6` → `08c3fb8` (comment removed) | FAIL (`1d1d`) | [T2U](evidence/T2U-evidence.txt) |
| C | Freshness and integrity cases C1-C7 | `endo.attempt.b7593b3a…` | `d278ca1` → `6d941ba` | by construction | [C](evidence/C-evidence.txt) |
| C8 | C's store copied, receipts forged consistently | same | same | by construction | [C8](evidence/C8-forged-evidence.txt) |
| F | Adversarial cases, re-run by the study: an environment-dependent pass (F1) and the overview's false alarm (U1) | (see files) | seeded only | FAIL | [F](evidence/F-evidence.txt), [page overview](evidence/F-page-overview.txt), [page task](evidence/F-page-task.txt), [CLI](evidence/F-cli-evidence.txt), [hook](fixtures/env-hook.mjs) |
| U | Roman seeded, one check, for the overview | `endo.attempt.53d19fbe…` | `f3969fd` | FAIL | [U](evidence/U-evidence.txt), [page overview](evidence/U1-page-overview.txt), [page task](evidence/U1-page-task.txt), [CLI](evidence/U1-cli-evidence.txt) |

## Commands run (per scenario)

`project add`, `task add`, `attempt prepare --plan-file`, `attempt brief`, then for each planned check
`attempt check --keep-output -- <argv>` (C4 without `--keep-output`), then `attempt evidence`, `attempt receipts`, `attempt show`,
`attempt observe` and `attempt provenance`. T1, T2 and T2U also have `attempt handoff` and `attempt report`, made by the study in the
operator's role and labelled so in their notes. No task status was moved.

## Review packets

The four packets given to the model reviewers, exactly as given:
[X receipts](evidence/D-X-receipts-view.txt) · [X ledger](evidence/D-X-ledger-view.txt) ·
[Y receipts](evidence/D-Y-receipts-view.txt) · [Y ledger](evidence/D-Y-ledger-view.txt) ·
[instructions](evidence/D-reviewer-instructions.md). X is T2U; Y is T2.

## Screenshots

- [U1-overview-1440.png](images/U1-overview-1440.png): store U, the overview, *Needs your attention (0)*. The context panel (local
  paths) is redacted.
- [T2U-task-1440.png](images/T2U-task-1440.png): store T2U, the overview with the task picker open. The context panel is redacted.

## What is not published

The agents' and reviewers' full transcripts, the disposable stores themselves, and machine paths. The reviewers' substantive answers
are summarised in [REVIEW.md](REVIEW.md), with direct quotes where they matter.
