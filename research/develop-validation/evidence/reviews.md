# Reviewers' reports, as received

The four evidence reviewers' final answers (experiment D), as delivered to the study and lightly reformatted (line wrapping, list
markers, some sentences split); nothing was added, and no verdict, quote or claim was changed. Then a summary of the adversarial reviewer's
report (experiment F; its findings and their dispositions are in [../REVIEW.md](../REVIEW.md) §2). All are Claude models with fresh
context: surrogates, not human participants. The full tool-call transcripts are not published; they contain only reads of the packet.

R1 and R2 reviewed scenario X (T2U, which the oracle fails on `1d1d`); R3 and R4 reviewed scenario Y (T2, which the oracle passes).
The reviewers did not know this.

---

## R1: scenario X, receipts view

1. Criterion 1: ESTABLISHED-MET — `days-parse` and `days-format` both show "Observed check passed" at commit 08c3fb8 with relation
"at-head" (`endo.receipt.2f1c61ad…`, `endo.receipt.042ab19c…`); the brief's expected stdout is "93600\n" and "1d1h1m1s\n" (compared
byte-for-byte). The diff adds `["d", 86400]` to `UNITS` before `h` (largest-first). Only the two sampled inputs are covered; no record
of actual stdout is in the receipts (only pass/fail outcome).

Criterion 2: ESTABLISHED-MET — `node --test` receipt at 08c3fb8, relation "at-head": `"execution": {"code": 0, "kind": "exited"}`,
`"outcome": "passed"` (`endo.receipt.2e7aa25c…`). Diff stat touches only `README.md` and `src/duration.mjs`, so nothing under `test/`
changed. (Clean-tree state is not stated in the packet beyond `"reasons": []`; I'm relying on receipts being recorded at a commit.)

Criterion 3: NOT-ESTABLISHED — The diff adds the row ``| `d` | days | 86400 |`` to the unit table, above `h`. But the packet does not
show the heading of the section containing that table (only the context line "...`5s2h` and `1h1h` are not. Nothing else is
allowed..."), nor the rest of the README, so whether any prose elsewhere still lists only h/m/s is unseen. This is an operator-judgment
criterion with no check; the row itself is probably adequate.

Criterion 4: NOT-ESTABLISHED (leaning NOT-MET) — The two named checks pass at 08c3fb8: `no-d-unchanged` → 5400
(`endo.receipt.552c4efe…`), `still-rejects-repeat` → "rejected" (`endo.receipt.320b2d41…`). However the diff changes the pattern to
`/^(?:(\d+)d)*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/` — the `d` group uses `*`, while h/m/s use `?`. This regex matches `1d1d`, `1d2d`,
etc., so a repeated `d` is likely accepted (and the earlier `1d` silently dropped, since only the last capture is kept), contradicting
"each unit at most once" stated in the file's own header comment (retained in the diff) and the README sentence in the hunk context
(`1h1h` invalid). The check only exercises `h` repeating, so it cannot catch this. The parseDuration body after the regex is not in the
diff, so I cannot prove it accepts `1d1d`.

Criterion 5: ESTABLISHED-MET — Diff shows only two modified files (`README.md`, `src/duration.mjs`), no `new file mode` entries, no
manifest/lockfile changes. "2 files changed, 4 insertions(+), 2 deletions(-)."

2. Recommendation: REJECT — The diff introduces a visible regression risk: `(?:(\d+)d)*` is almost certainly meant to be `?`, and it
contradicts the module's stated "each unit at most once" rule. The operator's checks pass but don't test a repeated `d`. A one-character
fix and a `parseDuration('1d1d')` check should settle it; if that check printed "rejected" I'd move to ACCEPT (with criterion 3 left to
the operator's reading of the README).

3. Gaps:
- No test or check for repeated `d` (e.g. `1d1d`) or order violations like `1h1d` (the regex order suggests rejection, but untested).
- The parseDuration and formatDuration function bodies are not shown; with 4 capture groups instead of 3 the index logic could have
  shifted — only the samples (1d2h, 90061, 1h30m, 1h1h) are covered.
- No check for formatDuration on other values (exactly 86400, a value with zero hours, > 99 days).
- README section heading and any other stale prose are not visible.
- Receipts record no actual stdout/stderr; clean-tree status is not stated in the packet.
- The agent's claims ("test/ untouched", "nothing left undone") are its own report, not verification.

4. Confidence: MEDIUM — A one-off run of `parseDuration('1d1d')` would change my mind: if it prints "rejected" (or throws), the
criterion-4 concern disappears; if it returns 86400, the concern is confirmed.

5. Hard to trace:
- The diff is labelled "fixture commit to the checked HEAD" but neither hash is given, so I can't confirm the diff's HEAD is 08c3fb8 or
  that it matches the code the at-head receipts ran.
- The first `node --test` receipt (at 943346f) failed with code 1; the 0dd67e6 and 943346f receipts are "stale" and sit between the
  brief preparation and handoff. The packet doesn't say what those commits are (baseline? reference runs?), so I didn't rely on them.
- The handoff note says "Validation study acting in the operator's role; not the human operator" — both handoff and outcome are
  recorded as study actions.
- The diff's `src/duration.mjs` hunk ends at the parseDuration signature, so any later hunks or unchanged body are untraceable.

## R2: scenario X, ledger view

1. Criterion 1: ESTABLISHED-MET (for the sampled inputs) — `days-parse`: "expected exit 0 and 6 byte(s) of output; observed exit 0, 6
byte(s), output the same"; `days-format` likewise (9 bytes); "criterion [plan: days-parse, days-format] 1 ... Planned checks passed at
HEAD". The diff adds `["d", 86400]` before `h` in UNITS (largest-first). Only `1d2h` and `90061` are covered.

Criterion 2: ESTABLISHED-MET — "check ... node --test: Observed check passed at 08c3fb827066"; "planned [observed] tests ... Passed at
HEAD (08c3fb827066, latest passed)"; tree "08c3fb827066, clean". Diffstat lists only `README.md | 1 +` and
`src/duration.mjs | 5 +++--`, so test/ is untouched. (The existing tests were not extended to cover `d`, so passing says nothing about
`d`.)

Criterion 3: NOT-ESTABLISHED — No check covers it; operator's judgment. The diff adds the table row ``| `d` | days | 86400 |`` above
`h`, which is supportive. But the hunk shows no section heading, so the packet doesn't show this is the "Format" section, and the prose
above the table is not shown, so whether it still describes units correctly is unknown. The README states "each at most once"
(`1h1h` is not a duration), which the new regex contradicts for `d` (see criterion 4).

Criterion 4: ESTABLISHED-NOT-MET (by reading the diff) — The new pattern is `/^(?:(\d+)d)*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/`. The
`*` after the d-group allows `d` to repeat, so `1d1d` matches; before the change, `1d1d` was rejected. Now it passes the regex — a
change in rejection behaviour ("rejected inputs stay rejected" is broken) and it contradicts the file's own comment "each unit at most
once". A capture group inside `*` also keeps only its last iteration, so the first `1d` would likely be silently dropped (result 86400).
The correct quantifier is `?`. The checks shown — `no-d-unchanged` ("observed exit 0, 5 byte(s), output the same") covers only
`1h30m`; `still-rejects-repeat` ("observed exit 0, 9 byte(s), output the same") covers only `1h1h`; neither tests a repeated `d`.
(Caveat: the diff stops at `export function parseDuration(text) {` so the body is not shown, but nothing in the packet suggests a
separate check that would reject `1d1d`.)

Criterion 5: ESTABLISHED-MET (for tracked files) — The diff shows only modifications to `README.md` and `src/duration.mjs`, no "new
file" entries, no manifest changes; tree is "clean" at HEAD. This covers the fixture-to-HEAD diff only; ignored files "were not read".

2. Recommendation: REJECT — The diff contains a real defect: `*` instead of `?` makes `1d1d` valid, which violates criterion 4 and the
stated format rule; the planned checks never probe it. It is a one-character fix, so the attempt could be accepted after a revision
that also adds a check that `1d1d` is rejected.

3. Gaps:
- No check or record covers repeated `d` (`1d1d`, `1d2d`), which by reading the regex is now accepted.
- The body of `parseDuration` and all of `formatDuration` are not in the packet; capture-group indexing after the regex change,
  empty-string handling, and formatting of exact multiples (e.g. 86400 → `1d`) are unverified.
- Only one input each for `1d2h`, `90061`, `1h30m`, `1h1h` was run; no round-trip or order checks such as `1h1d`.
- `node --test` passing says nothing about `d` (tests/ not extended).
- README heading and surrounding prose not visible, so "in the Format section" and consistency of the surrounding text are
  unconfirmed.
- No send to Pi authorised and no run attributed; authorship of the changes is unknown; the agent's report is "reported, not
  verified"; no record names the candidate revision.
- Checks were observed at a clean tree at 08c3fb827066 only; checks were "linked to this attempt by the operator" and the records are
  local, unsigned files.
- Task status is open; the operator has not recorded acceptance.

4. Confidence: MEDIUM — Seeing the (unseen) `parseDuration` body show that it rejects `1d1d` after matching would move me toward
ACCEPT (with the README judgment also satisfied).

5. Hard to trace:
- The "fixture commit" at the diff's start is not named (likely 943346f180cb, but the packet doesn't say).
- Commit 0dd67e6a4489 differs from HEAD in `src/duration.mjs` only, and all planned checks passed there too; nothing in the packet
  explains that intermediate state.
- The first `check` lines are tagged "exit status only"; the `behaviour` lines carry the byte-level comparison but don't say which run
  produced it.
- The README hunk's section name ("Format") is not present in the diff.

## R3: scenario Y, receipts view

1. Criterion 1: ESTABLISHED-MET — The diff adds `["d", 86400]` to UNITS ahead of h/m/s and `(?:(\d+)d)?` to the front of PATTERN.
Receipts at commit 5abbdac (relation "at-head") show `days-parse` (argv ending `m.parseDuration('1d2h')`) `"outcome": "passed"` exit
code 0, and `days-format` (`m.formatDuration(90061)`) `"outcome": "passed"` exit code 0. Per the brief, expected stdout is `93600\n`
and `1d1h1m1s\n`; a "passed" outcome means the output was compared byte-for-byte. Caveat: formatDuration's body is not in the diff, so
correct formatting relies on the existing code iterating UNITS — the passing `days-format` receipt is the only evidence.

Criterion 2: NOT-ESTABLISHED — The `node --test` receipt at 5abbdac42dfea685a09a5a18642b42597b94344a shows `"outcome": "passed"`,
`"code": 0`, `"relation": "at-head"`, covering the exit-0 half. The "test/ is unchanged" half is only partly supported: the diff stat
lists two files, `README.md | 5 +++--` and `src/duration.mjs | 3 ++-`, so test/ is not touched between the fixture commit and HEAD.
Missing: confirmation that 5abbdac is the "checked HEAD" the diff is labelled with, and that the working tree was clean at check time
(the packet asserts it via `endo attempt receipts` with `"problems": []`). The single earlier failing run (`"outcome": "failed"`,
`"code": 1`) at commit 943346f is at a different commit and marked stale — presumably the pre-change baseline, but the packet doesn't
say so. Leaning met, but not fully established.

Criterion 3: NOT-ESTABLISHED — This criterion has no check; it requires operator judgment. The diff shows the README's Format section
now documents d: the table row ``| `d` | days | 86400 |`` is added above h, and the example changes to `` `1d2h5s` ``. The opening line
also becomes "such as `1d2h` or `1h30m`". Prose and table both look correct on the diff, but there is no recorded operator judgment, so
I treat it as an operator judgment call that the diff supports.

Criterion 4: NOT-ESTABLISHED — Receipts at 5abbdac: `no-d-unchanged` (`parseDuration('1h30m')`) passed exit 0, and
`still-rejects-repeat` (`parseDuration('1h1h')`) passed exit 0, both matching expected outputs `5400\n` and `rejected\n`. These are two
spot checks. The claim is "behave exactly as before" and "rejected inputs stay rejected" across all inputs; I see no evidence for other
rejected inputs (empty string, `5s2h`, signs, spaces, fractions, or `1d1d` / `1h1d`, d after h). The regex change is small and keeps the
same structure, so I'd expect it to be fine, but the packet does not establish it. The existing `node --test` suite may cover some of
these, but I can't see test/ so that is unverified.

Criterion 5: NOT-ESTABLISHED — The diff stat shows only `README.md` and `src/duration.mjs` modified, with no new-file mode lines and no
package.json change, which supports it. The dependency half needs a guarantee that the diff covers all files; the packet doesn't show a
file-level status listing (e.g. `git status`, `--name-status`), confirm the diff range ends at 5abbdac, or confirm no untracked files.
No check addresses this and no operator judgment is recorded.

2. Recommendation: CANNOT DECIDE YET — All four automated code checks passed at the current HEAD (5abbdac); the diff is small, looks
correct and in scope, and no criterion is shown failing. But criteria 2, 3 and 5 rest on operator judgment or facts the packet doesn't
fully establish, and the packet itself says only "Result reported, not verified". If the operator reads the diff and is satisfied, this
looks acceptable — that's their call, not the packet's.

3. Gaps:
- The diff is labelled "fixture commit to the checked HEAD", but nothing ties it to 5abbdac; the receipts name 5abbdac as "at-head",
  and the diff header names only blob hashes.
- The bodies of `formatDuration` and the rest of `parseDuration` are not shown; only the UNITS and PATTERN lines changed. Correct
  formatting and the seconds arithmetic for d rest on unseen code; the two passing receipts are the only evidence.
- test/ contents are not shown, so it's unknown what `node --test` covers. The agent reported "5/5", which is the agent's claim, not
  verification; receipts show only pass/exit code, not output.
- No tests were added for d; that is consistent with "do not change test/", but means d's behaviour is checked only by the operator's
  single-input checks.
- Receipt coverage is thin: only `1d2h` parse and `90061` format check d. Not checked: `1d` alone, `2d` with larger values,
  `1d1h1m1s` parse, `1d1d` rejection, `1h1d` (wrong order) rejection, formatDuration(86400), formatDuration(0), empty input.
- Possible edge case: the pattern is anchored and every group optional, so the empty string matches the regex; the "Throws for the
  empty string" handling must be in code outside the diff, presumably preexisting. Not verified here.
- The three "head-differs" receipts at 943346f are stale, at a commit that is not 5abbdac; the failing `node --test` there (code 1)
  isn't explained in the packet. I assume it's a pre-change baseline, but that's unconfirmed.
- Clean working tree is not shown directly; the brief requires "a clean, committed working tree". `problems: []` and "at-head" are only
  indirect evidence.
- `"authorized": null` and `"execution": null` — the packet records no authorisation or execution record. The outcome was recorded by
  "the validation study" in the operator's role, not a human operator.
- The agent's report (commit 5abbdac, "test/ untouched", "nothing left undone") is unverified self-report; I used it only to reconcile
  the commit id with the receipts.
- README rendering (table alignment) is not checked. The diff looks fine, and the table's right-aligned column holds 86400.
- Code quality beyond the criteria (style, comments, the header comment in `src/duration.mjs` still giving "1h30m" as its example) was
  not assessed; the comment is not wrong.

4. Confidence: MEDIUM — A receipt at 5abbdac showing the test suite output, or a `--name-status` for the whole attempt range
confirming only two modified files and an untouched test/, would move me to ACCEPT. A broader input check failing (e.g. `1h1d`
accepted, or `1d` formatted wrongly) would move me to REJECT.

5. Hard to trace:
- The brief mentions "a clean commit" and the diff is labelled "to the checked HEAD", but no record says the diff's end point is
  5abbdac; I inferred it from the matching file changes.
- The `comparedWith` value `/work/T2/repo` is a path with no further context; I don't know how it relates to the "disposable repo" in
  the handoff.
- The reason for the earlier failed `node --test` at 943346f (exit code 1) is not recorded; the receipts have `"reasons": []`.
- The agent's "5/5" test count has no matching record; the receipts show only exit code 0.
- The brief has no task description, acceptance text or constraints (all "(empty)"); the five criteria appear only in the "How the
  result will be checked" part and in the JSON `criteria` list, which agree with each other.

## R4: scenario Y, ledger view

1. Criterion 1: ESTABLISHED-MET. Planned checks passed at HEAD 5abbdac42dfe: "planned [observed] days-parse ...: Passed at HEAD
(5abbdac42dfe, latest passed); at another commit, 943346f180cb: failed" with "behaviour ... expected exit 0 and 6 byte(s) of output;
observed exit 0, 6 byte(s), output the same", and "days-format ...: Passed at HEAD ... 943346f180cb: failed" with "expected exit 0 and
9 byte(s) ...; observed exit 0, 9 byte(s), output the same". The diff adds `["d", 86400]` as the first entry in UNITS and starts the
pattern with `(?:(\d+)d)?` — d at 86400, largest unit first. The record shows no flaws; the formatDuration body is not in the diff
context, so only the two sampled behaviours back the formatting half, not the code.

Criterion 2: NOT-ESTABLISHED (the halves differ). Exit 0 at a clean commit: "planned [observed] tests [node,--test]: Passed at HEAD
(5abbdac42dfe, latest passed)" and "tree now [observed] 5abbdac42dfe, clean" — that half is met; the agent's "5/5" is only its report.
test/ unchanged: the diff touches only README.md and src/duration.mjs, and its stat lists only those two files, but it runs from
"fixture commit to the checked HEAD", and the provenance records "2 paths differ: M README.md, M src/duration.mjs" between 943346f180cb
and 5abbdac42dfe. Missing: the packet never says 943346f180cb is the fixture base, and no record names a candidate revision; nothing
says there is no other commit, earlier test/ change or uncommitted change outside this diff. The packet also doesn't show that the
tests exercise d (they were not changed and their coverage of d is never shown).

Criterion 3: NOT-ESTABLISHED. Operator judgment, no check. The diff is plainly relevant and the operator can judge it from the packet:
it adds "| `d` | days | 86400 |" under "## Format", and changes the intro to "`1d2h` or `1h30m`" and the example to "`1d2h5s` is a
duration, `5s2h` and `1h1h` are not". The README now documents d in the Format section, and the prose "Units come largest first, and
each at most once" still fits. Whether the operator is satisfied is not recorded as their decision.

Criterion 4: NOT-ESTABLISHED. Only two spot checks back it. "no-d-unchanged ...: Passed at HEAD ... at another commit, 943346f180cb:
passed" with "expected exit 0 and 5 byte(s) ...; observed exit 0, 5 byte(s), output the same"; still-rejects-repeat likewise (9 bytes,
"rejected"). They show 1h30m parses to 5400 and 1h1h is rejected at both commits. Missing: the claim covers every input; the packet
samples one accepted and one rejected input. Plausible regressions are not sampled: `1d1d`, `1h1d` (d after h, out of order), `d`
alone, `1d`, `0d`, empty text, large numbers. The regex change looks mechanical and benign — an optional leading group cannot change
matching for text with no d — but that is a code-reading argument, not an established fact. `1h1h` fails the new pattern as before;
whether `1d` combined with other input is handled is outside the sample.

Criterion 5: NOT-ESTABLISHED. Operator judgment, no check. The diff stat lists "README.md | 5 +++--, src/duration.mjs | 3 ++-", with
no added files; neither is a manifest, and the diff has no dependency lines. Missing: the "2 files changed" stat covers only fixture
commit to HEAD; untracked or ignored files would not appear. Provenance says "Ignored files are not part of a state; their contents
were not read". The tree is reported clean, which covers untracked but not ignored files.

2. Recommendation: CANNOT DECIDE YET. The operator's planned behavioural checks all passed at HEAD 5abbdac42dfe, and the two sampled
new-behaviour checks failed at 943346f180cb, so the change is what turns them green; the diff is small, consistent with the brief, and
leaves test/ alone. But criteria 3 and 5 are the operator's own judgment calls, and criterion 2's "test/ unchanged" and criterion 4's
breadth are not fully established, so the operator should do those reads and, if wanted, run a few extra inputs before accepting.
Leaning ACCEPT if those hold.

3. Gaps:
- No record names a candidate revision; the packet only says checks ran at 943346f180cb and 5abbdac42dfe, and which is the fixture
  base is inferred from "fixture commit to the checked HEAD".
- "test/ is unchanged" rests on the diff stat alone, not independently confirmed; no commit list is given.
- The tests check exit 0 only; the packet doesn't show whether the existing tests cover d, so a pass says little about d.
- The agent's report (committed 5abbdac, 5/5 tests, nothing left undone) is recorded "as reported, not verified" and is not evidence.
- No send to Pi was authorised, so the packet doesn't show who wrote the change; the handoff to a Claude subagent is only the
  operator's statement.
- Records are local, unsigned files; the packet itself says anything that can write the store could write them.
- Nothing shows the work tree was unchanged between observations; two agreeing reads don't rule out a change in between.
- formatDuration's source is not in the diff context, so how it uses the new UNITS entry (rounding, zero parts, a seconds-only case)
  is not visible; only formatDuration(90061) was checked.
- Edge inputs for parseDuration are not sampled (`1d`, `1d1d`, `1h1d`, `0d`, `d`, empty text, very large numbers), nor
  formatDuration(86400), 0, or values above 1d.
- The "check" lines say "exit status only: the plan reads this command by its behaviour"; the byte-for-byte behaviour records are
  separate. They agree, but the behaviour lines say "output the same" without printing the output.
- Decision status is "open"; the task is not recorded as done.

4. Confidence: MEDIUM. A clean, direct read of the README and of formatDuration, plus a few extra edge-case runs (`1d`, `1d1d`,
`1h1d`, `0d`, `formatDuration(86400)`), would raise it to HIGH. Evidence of a stray test/ change, a new file or a dependency would
drop it to REJECT.

5. Hard to trace:
- "943346f180cb" being the fixture commit is not stated anywhere; it is inferred from the diff header and the "checked ... against the
  start" provenance lines.
- The "test/ is unchanged" half of criterion 2 has no record, only the diff stat, and the diff header ("fixture commit to the checked
  HEAD") doesn't say which commit is the fixture.
- The formatDuration code is cut off at the end of the hunk context ("export function parseDuration(text) {"), so the largest-unit-first
  formatting logic cannot be traced to a diff line; only the UNITS table is visible.
- The agent's claim in the outcome line, "the four sample checks printed the expected values", cannot be traced to any record; the
  evidence tool's own check lines give the observed outcomes.

---

## F: adversarial reviewer (summary)

Eleven numbered findings with reproducers run in its own disposable stores, and an overall verdict that CONDITIONALLY READY did not
follow from the evidence under the preregistered rules. Each finding and the study's disposition is listed in
[../REVIEW.md](../REVIEW.md) §2. The two high-severity findings were reproduced independently by the study (store F).
