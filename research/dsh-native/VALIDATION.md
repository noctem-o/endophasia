# PR #70 repair validation — 2026-10-23

This is a repair of the study at `1c7f8bf003738a7e13105d47c20c097f9486aaa4`, not a runtime adapter. The initial
checkout was clean on downstream `dsh-native-importer` (`a37fdc68c7d8dc30bcd538bc3a912171f4ad3118`); work switched to the
existing `dsh-native-attachment-study` branch. The published parent head matched the local branch, and its CI run 39764385872
was successful. PR #71's reader move was inspected; its branch and commits were not changed.

The provenance pin remains `687f282e8625c6b8d11ff58211a90524be2e4317`, `dsh-v0.2.1-rc.2`. The source checkout was clean,
including untracked files, before and after experiments. Execution now checks the complete recorded provenance and refuses a
dirty checkout before spawning DSH. Dependency installation contents are not covered by Git cleanliness or source hashes.

## Disposition of the thirteen findings

All were verified as defects and corrected. Regressions are in `tests/dsh-native-repair.test.ts` unless stated otherwise.

| # | Finding | Correction and evidence |
| --- | --- | --- |
| 1 | Damaged captures rewritten clean | Builder requires a header, clean physical tail, no read problems and no checker errors. Late-case torn row, torn frame, bad JSON and sequence failures leave the previous directory byte-identical. The reader still returns complete recoverable prefixes with damage status. |
| 2 | Observer accumulation | Owned scratch root cleanup removes the scenario directory and its raw directory; crash removes both killed/resumed outputs. Whitelist, ownership marker, canonical root and symlink-ancestor preflight precede deletion. Synthetic cleanup tests and two real stub runs in the same output root. |
| 3 | Unknown ignorable surface event | Only known log-only types enforce absence of `surfaceOp`. Generic and plugin ignorable surface events are accepted; unknown required events remain refused. |
| 4 | Assumed SIGKILL | Requires `child.kill` success AND close signal SIGKILL AND null exit code. Natural completion and failed-delivery races tested; real crash passed. |
| 5 | UTF-8 replacement | Fatal UTF-8 for complete raw rows and every decompressed frame, also raw observer/stream inputs to the builder. Invalid bytes in a complete quoted string are refused in both physical formats. An unfinished raw row is never decoded or accepted as evidence, including a cut inside a codepoint; its complete prefix and torn-row status remain available. |
| 6 | Short magic | All 1–3 byte prefixes of Zstandard magic classify as compressed torn frames with no complete bytes. |
| 7 | Cumulative decoded bound | Post-decode length check enforces remaining capacity even at zero, before retention. Empty frames at an exact bound remain valid; one-byte frames beyond it fail. |
| 8 | Duplicate result overwrites | Second result is an error and cannot replace the first sequence/outcome. Regression uses conflicting error outcomes. |
| 9 | Username canary false positives | Builder/tests use absolute home path and explicit capture markers, never a bare account name. Home-path detection also covers macOS paths and home roots without trailing slash. Common-name regressions, plus existing secret/path scanner over every output. |
| 10 | Resume failure ignored | Requires resume exit 0, no signal, valid capture, unchanged killed prefix, ordered interrupted closer/end-seed/completed new turn. Nonzero exit and absent recovery evidence regressions; real resume passed. |
| 11 | Dirty provenance accepted | Opt-in test compares all DSH metadata; harness enforces clean complete provenance before execution. Disposable Git checkout regression changes an unaudited tracked file at the same HEAD with identical audited hashes. |
| 12 | Raw directory disagreement | Historical default is consistently `dsh-native/run-final/raw/<case>`. Builder accepts explicit input and output directories. Documented commands rebuild historical data separately and create new disposable roots for new runs. All eleven historical outputs rebuilt byte-identically. |
| 13 | Partial fixture publication | Generate and validate all outputs in memory, then write a sibling staging directory; publish with directory renames and synchronous rollback. Late failures in missing data, log damage, privacy scan, observer syntax and invalid UTF-8 leave the prior complete set intact. Abrupt-death/concurrency limits below. |

The extra raw-JSONL size defect reported for #71 is repaired here: input bytes are bounded before copying, decoding or splitting.
The regression accepts exactly the byte limit and refuses one byte beyond it, using the same unreadable-size result as zstd.
No reader export or result shape changed.

Independent advisor review found an additional path leak through raw stream type/phase labels in `comparison.json`. Per-case
sanitisation and the final privacy gate now cover comparison output as well. A synthetic phase-path regression exercises it.
Missing observer data remains unknown (`null`), including transient frame counts; malformed JSON/UTF-8 is refused rather than
silently converted into an empty observation.

## Real-runtime observations

The sequence ran the real pinned source via tsx, with a fresh scratch `DSH_HOME`, `HOME`, workspace and capture directory,
a minimal child environment, read-only permission mode, disabled telemetry and the existing disabled provider/tool/plugin rows.
No active DSH home, profile, credentials, sessions or locks were read or mutated. No existing service was signalled or reconfigured.

The provider passes `baseURL` unchanged to the OpenAI client and calls `chat.completions.create`. `/v1/models` advertised
`qwen38-local`; a one-output-token POST to `/chat/completions` returned HTTP 200. The experiments therefore used
`http://127.0.0.1:8080`, without assuming `/v1` is needed.

| Scenario | New persisted events | Observation |
| --- | ---: | --- |
| stub-retry, first run | 19 | Real failed attempt, retry decision, restart, completed message; live events JSON-equal to persisted events. |
| stub-retry, same output root again | 19 | Exactly 19 live events, equal to this run's persisted log; no observer accumulation. |
| tool-read | 21 | Two steps, one paired `read`, completed turn; live/persisted equality. |
| no-key-error | 16 | Expected CLI exit **1**, structured failed turn and one attempt, no assistant message; live/persisted equality. Initial general zero-exit guard rejected this expected outcome, then was corrected to require both exit 1 and recorded failure. |
| crash-killed | 13 | Signal delivery succeeded and child closed on SIGKILL; turn/step open, no committed assistant message; 41 transient chunk frames. Physical tail clean: this was not a torn-write experiment. |
| crash-resumed | 25 | Exit 0; killed prefix preserved; DSH appended interrupted step/turn closers and untagged end-seed. Observer first seq 16, with 9 events exactly equal to the remaining persisted suffix. |

All new captures were built into a separate sanitised directory; committed runtime fixtures were not replaced. Original
`run-final/raw` was available, clean and readable: rebuilding it yielded byte-identical results for all eleven committed files,
including `comparison.json`. These original fixtures also pass secret, absolute-path, UUID, response-id and home-path scans.

Fresh event counts, order, pairing and lifecycle summaries match the original evidence. Stub retry, no-key error and killed-log
rows differ only in timing after sanitisation. Tool-read varies in model reasoning, stream chunks, usage and timing. The fresh
resume replied `ok`; the original resume continued the earlier integer task despite the new prompt. This is a meaningful difference
in model compliance, with matching persisted recovery structure, not a reason to rewrite either observation. Original resume
reported 2318 output tokens; fresh resume reported 264. These are source-reported counts, not independent token measurements.

`strace -f -e trace=connect,openat` covered the fresh sequence. Observed IPv4/IPv6 connects went only to loopback port 8080
(four calls across the model runs); no opens were seen under the active DSH home or sensitive home configuration directories.
The only `.env` probes were missing files inside scratch homes/workspaces. This is measured syscall evidence for these runs,
not an OS egress or filesystem sandbox guarantee. No private trace or raw captures are committed.

The pre-existing llama.cpp and DSH service PIDs and start times remained unchanged after the sequence, with their existing
listeners still present. We deliberately did not inspect the active session files to obtain mtime comparisons. Those services
can independently change their own state; process continuity and our child traces bound the non-disturbance claim.

## Verification

- Targeted study and repair suite with `ENDO_DSH_CHECKOUT` enabled: 77 passed, including real stub reproduction; also passes on
  supported Node 22.19.0. Without the checkout the two opt-in tests remain explicitly skipped.
- Typecheck: passed. Lint: passed with the existing unused-parameter warning in `endo-cockpit-eighteenth-review.test.ts`.
- Build and package smoke (isolated install and real browser checks): passed.
- Final repair full suite with `ENDO_REQUIRE_BROWSER=1`: 166 files passed, 3 skipped; **4593 passed, 49 skipped** (248.35 s).
  The targeted suite also passed on Node 22.19.0.
- Independent advisor reviewed evidence integrity, privacy, parser/process safety and #71 compatibility; no remaining blocking
  findings after the comparison-output fix. Advisor tests and review are independent of the maker's runtime observations, not
  approval of all experiment claims.

## Limits and #71 handoff

The study still does not establish real torn-write recovery, compaction, forks/subagents, approval/cancellation behaviour or
real-provider retry. Those remain source-derived/upstream/synthetic as originally labelled. Local model behaviour and timing are
nondeterministic. Read-only permission mode does not confine arbitrary reads at the OS level; only fixed benign prompts were used.

Fixture publication is failure-safe for validation, staging and synchronous rename failures, not crash-atomic across its two
renames. A process/host death between renames can leave the previous complete set under a `.real-stage-*/previous/` sibling;
recover it manually before retrying. Concurrent builders for one destination are unsupported. Scratch cleanup similarly assumes
no adversarial concurrent replacement of its directories between preflight and deletion.

For #71, merge the repaired parent branch into `dsh-native-importer` and preserve the parent changes through Git's rename from
`research/dsh-native/log.ts` to `adapters/dsh-native/log.ts`. Update the new repair test's reader import and the harness's new
reader import to that adapter location, as #71 already does for existing study utilities. Run importer/recovery/study/repair
suites together. Public reader signatures stay unchanged; all parser fixes, including the raw size bound, belong in the promoted
reader. Keep the fixture bytes unchanged.

The four currently unresolved #71 findings remain downstream: complete header-shape validation (especially boolean `isSeeded`),
unambiguous raw-ID versus Endophasia-coordinate selection, actual observed turn count in an open run, and commitment to the
stored fork cut when resuming a header-only partial import. They were inspected for dependency impact but not modified here.

## Current-main integration and CI

Repair commit `133c8f9e5e450af538eb8874b78e5f0aa4fb070e` passed the complete local suite above. CI run 39921301890 tested
GitHub's merge `a0592db0a87cbb049def1c5372847729062b1ae0` against newly advanced main
`6a8c85feb64e741ea94068dbbc359756bc78d34a`. Four jobs passed (both package jobs, clean-install acceptance, reference exchange).
The test job had exactly one failure: release-readiness rejected “not yet published” in README text introduced by that new main.
This was reproduced from the CI merge contents; neither phrase existed in the repair branch's README. The DSH suites passed.

The branch then integrated those two existing main documentation commits, retaining their changes and correcting only three
README release-status phrases to version-relative source wording. No runtime or Studio implementation changed. This is a branch
integration, not a merge of either pull request. The release-readiness test remains strict and unchanged. Post-integration
verification and final CI status are posted in the PR conversation so results remain tied to the actual tested head.

A final capture-boundary check found that per-chunk Buffer-to-string concatenation could alter a multibyte character split
across pipe chunks. Process capture now collects original Buffer bytes for stdout/stderr, preserving both valid split UTF-8
and invalid bytes for the builder's strict decoder. A synthetic pipe regression proves byte identity; this is not a new runtime
observation. Session-id parsing strictly decodes only the first JSON line after raw capture has been retained.

After main integration, the full Node 22.19.0 run with `ENDO_DSH_CHECKOUT` and `ENDO_REQUIRE_BROWSER=1` passed **4595 tests,
47 skipped** (246.48 s). After the capture-byte fix, release/study/repair tests passed **89/89** on Node 22.19.0; typecheck and lint
passed. Real pinned-source stub retry and crash/resume were rerun in a separate disposable output root with byte-preserving
capture and passed. Original raw captures, committed fixtures and the previous fresh observations were retained.

## Fresh Codex review — five further findings

The next review of `bedf02704eaee2a1df5c0ad5b219b569e711fef3` reported five additional P2 findings. All five reproduced on
isolated synthetic inputs: thirteen new cases failed before repair (with one zero-offset control already passing), and two
further failing cases exposed source-symlink variants of the publication hazard. No historical capture was used as a mutation
target. Sixteen regression cases were added in total.

| Finding | Repair and evidence |
| --- | --- |
| A JSON row spanning valid zstd frames became clean | Refuse a non-final, nonempty complete frame that does not end with a newline, before concatenation. Tests split a row into independently valid frames, with and without an empty intervening frame. The existing final unfinished-row case still returns complete prefix rows with explicit torn-row status; it is never clean fixture evidence. |
| Empty physical rows disappeared | Empty complete rows now stop parsing with a read problem. Tests cover before the header, between rows and after the final event, raw and compressed. The expected empty split element after a single terminating newline is not a physical row and remains valid. |
| Duplicate open step starts inflated counts | A second start for the already-open turn/step emits `step-started-twice` and does not increment the summary again. Regression duplicates a real fixture's step start while keeping contiguous sequence numbers. |
| Output overlapping raw evidence could delete it | Before staging, canonical overlap checks protect the raw root, each case directory and actual source-file targets, including source symlinks and destination aliases/ancestors. Reject overlap in either direction, including a future destination inside raw. Seven synthetic overlap cases preserve source bytes. Raw paths are canonicalised, also making the documented relative input path sanitise consistently. |
| Late attachment hid live-only events | Determine the observed overlap using the first DSH seq, verify byte-equivalent JSON correspondence and contiguous observed seqs, then report the trailing live-only types. Mismatch means `null` (unknown), not an empty list. Tests cover seq 0, a mid-log attach, attachment exactly at the persisted end, and a mismatched overlap. |

All eleven original fixture outputs still reproduce byte-for-byte into a separate directory, including comparison.json. No
committed runtime fixture, provenance pin or #71 code changed. No new model behaviour is claimed: this round exercises malformed
inputs synthetically and the pinned real-runtime stub through the opt-in tests. Full local results and fresh CI are recorded in
the PR conversation after completion. Public reader types/exports are unchanged; #71 must carry these further reader fixes
through its move along with the earlier repairs. Publication still assumes no concurrent adversarial path replacement.

The same blank-row normalisation was present in the observer/headless capture line helper. A follow-up applies strict complete
record parsing there too: empty complete records or a final JSON record lacking its newline fail the builder, preserving the
prior output. Two parameterised regressions each exercise blank and unterminated records in these two capture streams. Original
historical streams and comparisons still reproduce identically. This extends the physical-row finding across capture inputs;
it does not claim full semantic schema validation of observer/headless rows.
