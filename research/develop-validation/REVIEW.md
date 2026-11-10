# DEVELOP-VALIDATION-001: independent review report

Two kinds of review: four **evidence reviewers** reading frozen packets (experiment D), and one **adversarial reviewer** challenging
this study's findings (experiment F). All are fresh-context Claude models (Sonnet for D; see §2 for F). **They are surrogates, not
human participants,** and their disagreements are kept, not resolved by the study.

## 1. Evidence reviewers (D)

**Design.** Two scenarios, each in two presentations, one reviewer per cell, identical [instructions](evidence/D-reviewer-instructions.md),
and no expected verdict given. Every packet contains the brief (with the plan) and the candidate diff. The receipts view adds
`attempt show` and `attempt receipts`; the ledger view adds `attempt evidence` and `attempt provenance`. Packets were checked for leaks
("planted", "regression", "oracle") before release.

- **X = T2U:** the planted regression nothing samples. Oracle: criterion 4 fails (`1d1d` accepted); criteria 1, 2, 3 and 5 hold.
- **Y = T2:** the agent's candidate. Oracle: every criterion holds.

### Scores against the oracle

| | R1: X receipts | R2: X ledger | R3: Y receipts | R4: Y ledger |
| :-- | :-- | :-- | :-- | :-- |
| Recommendation | REJECT | REJECT | CANNOT DECIDE YET (leaning accept) | CANNOT DECIDE YET (leaning accept) |
| Correct, or safe | correct | correct | safe | safe |
| Erroneous acceptance | no | no | no | no |
| Found the uncovered defect (`1d1d`) | yes, from the diff | yes, from the diff | n/a | n/a |
| Kept criteria 3 and 5 as judgment | 3 yes; 5 called MET from the diff | 3 yes; 5 called MET from the diff | yes | yes |
| Called criterion 4 sampled, not established | yes (and NOT-MET) | yes (NOT-MET) | yes | yes |
| Factual error about the records | **yes**: *"compared byte for byte"* for a receipt's `passed` | no | **yes**: *"a 'passed' outcome means the output was compared byte for byte"* | no |
| Flagged that no record names the candidate or base revision | yes | yes | yes | yes |
| Confidence | MEDIUM | MEDIUM | MEDIUM | MEDIUM |

### Reading

- **No presentation led to a wrong decision.** For X, both reviewers rejected on the diff (the `*` quantifier), not on any record.
- **The receipt view caused the same factual error in both of its reviewers.** In `attempt receipts`, a receipt's `outcome` is exit
  status. The packet does not say that next to each receipt, and both receipt-view reviewers assumed a byte comparison. In the X packet
  the fixture's `days-parse` receipt reads *Observed check passed* although its behaviour failed; R1 did not rely on it. The ledger
  states behaviour separately (*behaviour … output the same*), and neither ledger reviewer erred. The page shows the missing line
  (*The label above is its exit status*); the CLI list does not (finding U2).
- **One gap in every packet:** no record names the candidate revision or the base. All four inferred it from the diff and the
  receipts' `at-head` relation. This repeats WORK-CYCLE-001B item 3 and REVIEW-PILOT-001's B1/B2.
- **Reviewers asked for more inputs on their own** (`1d`, `1h1d`, `1d1d`, `formatDuration(86400)`). The ledger cannot prompt for
  that; B2's limit is visible to a careful reader, but only from the diff and the criterion's wording.
- **Disagreement kept:** R1 and R2 judged criterion 5 MET from the diff stat; R3 and R4 called it NOT-ESTABLISHED for lack of a
  `--name-status` listing or proof that the diff covers every file. Both are defensible from the packet.

**H9 (ledger more explicit than receipts): weakly supported.** The same decisions, but 2 of 2 factual misreadings with receipts against
0 of 2 with the ledger. With n = 4 model reviewers this is a signal to check with a human, not a measurement.

## 2. Adversarial review (F)

A fresh-context reviewer (Claude, the session's default model) read the draft, the evidence and the source, and reproduced cases in its
own disposable stores. It changed nothing in the worktree. Its findings, and what the study did with each. "Reproduced" means the study
re-ran it independently.

| # | Finding (reviewer's severity) | Disposition |
| :-- | :-- | :-- |
| 1 | A genuine receipt records a pass for wrong code when the check's environment is altered (`NODE_OPTIONS` hook outside the repo); an unsandboxed agent can run `attempt check` itself, and receipts say `requestedBy: operator` (high) | **Accepted, reproduced** (store F). Now F1, folded into H5, Q2 and the pilot procedure |
| 2 | U1 refutes H2 under the preregistered rule; the draft filed it under H7, and T2U meets the early-stop clause (high) | **Accepted.** The decision now follows the rule (NOT READY); the early stop is recorded as deviation 8 |
| 3 | U1 is broader: the overview also raises false alarms (a correct exit-2 refusal flagged) and misses contradictions at HEAD (medium-high) | **Accepted.** False alarm reproduced (store F); the contradiction case is cited from the reviewer, not reproduced |
| 4 | B2 also covers criterion 2 (a trivial test file passes); criterion numbering is inconsistent across protocol, plan and oracle (medium) | **Accepted** on reasoning (no check reads `test/`), citing the reviewer's reproducer; numbering is deviation 7 |
| 5 | `experiment protected-run` is not a DEVELOP path, and "keep the store out of reach" cannot be enforced for a same-user agent (medium) | **Accepted.** Both removed as mitigations; the residual risk is stated |
| 6 | A digest-only edit is rejected when kept text exists; without `--keep-output` it is undetectable (low, supports the study) | **Accepted**, added under C8 |
| 7 | No experiment or procedure covers time of check against time of use (medium) | **Accepted** as a coverage gap and a pilot-procedure step; not tested |
| 8 | Self-evaluation bias: oracles not in the preregistration commit, every role is a Claude model, packets name the study and favour caution, transcripts unpublished, no organic failure (medium) | **Accepted.** H8 and H9 are downgraded to model readers only; deviation 6 added; the reviewers' reports are published in [evidence/reviews.md](evidence/reviews.md) |
| 9 | The draft overstated: "held under every transition", "identical ledger", README "fixed" while uncommitted, a placeholder §2 (low-medium) | **Accepted, corrected.** The README fix was committed (`2797a5cd9`) after the reviewer read the worktree |
| 10 | README: the edit is accurate; the opening claims ("is the code you are reading the code that was checked? Endophasia answers from records") outrun the records; step 6 does not warn about U1; a 121-character line (low) | **Partly accepted.** The line is re-wrapped. The opening claims are recorded as finding A5, not changed: the README is the owner's voice, and the right fix depends on U1 |
| 11 | Coverage gaps: freshness states on the page, linked worktrees, timeouts, PATH shadowing, agent-run checks (low) | **Accepted**, listed in §5 of the report |

**The reviewer's overall verdict:** CONDITIONALLY READY did not follow from the evidence as stated. By the letter of the protocol, the
decision is NOT READY. A closely watched pilot would be defensible once U1's full scope is fixed and the procedure is written. The
study agrees and has adopted that decision.
