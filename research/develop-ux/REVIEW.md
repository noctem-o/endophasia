# DEVELOP-UX-001: independent review

One round, on 2026-11-14, by a fresh-context reviewer (a general-purpose Claude subagent with no part in the work, instructed to be
adversarial, read-only on the worktree). It reviewed the uncommitted change and the first draft of
[DEVELOP-UX-001.md](DEVELOP-UX-001.md). It is a model's review, not a human's, and it viewed nothing in a browser. A second round on
the fixes was **not** run.

**Its summary:** no change to the approver, broker, pairing, protocol or storage; one real bug in the alias; several claims in the
document not true of the code.

| # | Severity | Finding | Disposition |
| :-- | :-- | :-- | :-- |
| 1 | HIGH | `endo develop` appended `--control --workbench` to the argument list and tested for them with `includes`. `endo develop <root> --control --prompt` therefore became `attach --control --prompt "--workbench"`: no workbench, no terminal check, and the text `--workbench` sent to the model. Not a new capability (`attach --control --prompt x` does the same), but it falsified "the same command" | **Fixed.** The switches are added to what was parsed, never to the arguments. Seven malformed spellings are tested, each with a Pi path that does not exist; each fails before Pi is looked for and before a store exists |
| 2 | MEDIUM | `endo develop --prompt "…"` sent a prompt with no phrase, while the help and README said every prompt is approved | **Fixed, by removing it.** `endo develop` refuses `--prompt`; `harness attach --prompt` is unchanged. The help, README, changelog and workbench document say so |
| 3 | MEDIUM | §2.2's "drawn as" column described marks the Task view does not have; "reported" means reported by the runtime; a fifth class, `inferred`, was omitted | **Fixed in the document.** The table is now a proposed vocabulary with a "today" column |
| 4 | MEDIUM | §6 and D1 overstated the gain of a terminal-typed prompt (the round trip remains) and omitted its costs: no read-back, one line, the shared `>` line | **Accepted.** D1's costs are listed, its column was removed from §6, and the recommendation is now "design it, beside a shorter confirmation", not "do it next" |
| 5 | MEDIUM | The hint prints whatever a valid task file says, and the agent can write that file as the same user: the tool could steer the operator to a project the agent registered | **Fixed.** The line now says "the task file registers…" and tells the operator to check with `endo project list`; the risk row says the file is writable by the agent |
| 6 | MEDIUM | New placeholder colour at about 3.7:1, for an instructional sentence | **Fixed.** Placeholders use `--fg-3` |
| 7 | LOW | Field's top bar lost its own hairline to the new `border-image`; the `backdrop-filter` blurred nothing | **Fixed.** Field resets the border image; the filter was removed |
| 8 | LOW | Field inherited the chain's fills, the mode's wash and the card's lift | **Fixed** for those three. Field still inherits the button's inset highlight and the pill shapes, deliberately |
| 9 | LOW | The new transitions were not under the reduced-motion query; the button's hover could not ease over a gradient | **Fixed** |
| 10 | LOW | Wrong figures: "5 flags" (4, or 3 in the directory), "31 characters" for every phrase (29 to 31; 307 in all), "8 lines", missing images, an uncited operator decision | **Fixed.** The decision is now attributed to the author's session notes, which is where it is |
| 11 | LOW | §3.1 cited a test of Studio's served page that does not exist | **Fixed in the wording.** No such test was added |
| 12 | LOW | Tests: the refusal comparison could not see finding 1; a regression would have started the host's real Pi; the empty transcript was never shown to discriminate; `yes` is a weak wrong answer; the hint has no negative cases | **Mostly fixed.** Not done: negative cases for the hint (a project named, no registration, two registrations, an unreadable file). That the code prints only for exactly one match and swallows a failed read is known by reading it, not by test |
| 13 | NOTE | Stale text: `docs/develop-tasks.md` ("choose Develop"), two comments naming one setter of `data-start`; the page says "No project is registered for this launch" while the terminal says the directory is registered; `endo develop --help` prints "unknown flag" | **Fixed** for the document and the comments. **Not changed:** the page's sentence (it is about the launch, and true), and `--help` (the same as `harness attach --help`) |
| 14 | NOTE | `start: "develop"` adds a launch failure for a frontend build whose root element is not the build's | **Accepted**, and added to the residual risks |
| 15 | NOTE | Rule 2 on "verified" was checked for the page only; a shorter terminal confirmation was never considered; `realpathSync` per registered project could stall on a hung mount | **Document corrected** for the first two. The third is accepted: at most eight projects, once, at start |

**What the reviewer checked and found correct:** the diff touches only the listed files; the hint's `else` binds as intended and its
read is read-only, bounded and guarded; the source test's rules hold; the contrast figures reproduce; focus visibility is untouched;
the pairing code, the approval window, Follow, the `--cwd` default, the id lengths and the tour's ten commands are as stated.

**What nobody verified:** the page under forced colours or in print; the redesign with a person using it; any of it against a real
Pi and model.
