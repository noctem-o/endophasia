# Post-merge audit of #14

Date: 2026-10-03. Subject: `main` at `dec3364` (merge `3b90b97` of #14, plus two README commits). Method: a clean
install, the repository's own checks, an import-graph pass over every production module, and a read of `storage/`,
`cli/`, `adapters/pi/{attachment (identify and evidence paths), configuration, evidence (rules), version, identity
(fingerprint)}`, `evolution/policies/`, and the README. `adapters/pi/{checks,mapping,rpc}.ts` and
`adapters/rpc-jsonl/` were checked only by pattern search: for swallowed errors, defaults that fill gaps, and
platform assumptions. They were not read line by line. A finding marked **fixed** is in the PR that adds this document.
Everything else is a proposed ticket.

## Baseline on `main` (before any change)

| Check | Command | Result |
| :--- | :--- | :--- |
| Install | `npm ci` | 76 packages, exit 0 |
| Typecheck | `tsc --noEmit -p tsconfig.json` | exit 0, no errors |
| Lint | `biome check .` | exit 0, 218 files checked |
| Tests | `vitest --run` | 4 files failed, 68 passed, 1 skipped (73); **8 tests failed**, 2322 passed, 3 skipped (2333); 176.6 s |

All 8 failures are environmental. None is in the Pi path.

- **6 tests need `mv --exchange`** (GNU coreutils ≥ 9.5). This machine has coreutils 9.4. Three are in
  `conformance-lab`. Three are in `prime-097-conformance` ("ACP publication adversaries") and `prime-097-review5`
  (two tests). They fail either directly or through a child process.
- **2 tests need commit `45adf6b`**, which is in the donor repository and not in this one:
  - `conformance-prime-specimen` › "pins the complete 28-member bundle…"
  - `prime-097-conformance` › "binds the historical instrument…"

**There is no CI.** The repository has no `.github/` directory. Nothing ran these checks on #14 before it merged.

## Findings, by severity

### High

**H1. A damaged length prefix can delete everything after it. (Fixed.)**
- **Where:** `storage/log.ts:111-122` (read classification); truncation at `storage/harness-registry.ts:83`,
  `storage/event-store.ts:83` and `storage/ledger.ts:156`.
- **What happens:** suppose one bit flips in a complete frame's length so that the length runs past the end of the
  file. The reader cannot tell this from a torn append. Every open path then calls `truncateTo(valid)` and reports
  `recovered`, so all later frames are destroyed silently. Reproduced: one flipped bit in frame 2 of 5 left 1 frame.
- **The module header overclaims:** it says a byte flipped "in the length" is always detected. It is detected only
  when the bad length still fits inside the file.
- **Fix in this PR:** `truncateTo` now writes the bytes it cuts to `<log>.discarded-<sha256 prefix>` and fsyncs them
  before it replaces the file. It returns that path. Covered by "truncateTo preserves the bytes it cuts…" in
  `tests/endo-storage.test.ts`, which fails without the fix.
- **Follow-up (ticket T1):** report the discarded path in each store's `recovery()`. Also consider sealing instead of
  truncating when the torn region is larger than any single append could leave.

**H2. Symlinked Pi configuration was not followed, so evidence stayed valid after the configuration changed. (Fixed.)**
- **Where:** `adapters/pi/configuration.ts:62-66` (old lines).
- **What happened:** the configuration digest recorded a link's target string but not what the link points to. Dotfile
  managers (stow, chezmoi, home-manager) usually install `~/.pi/agent/settings.json`, `models.json` or an
  `extensions/<name>` directory as symlinks. Editing the linked file did not change the digest, so evidence rule 6 (the
  configuration dependency) silently passed for a configuration that had changed.
- **Fix in this PR:** links are followed, within the same entry and byte limits. Each real path is digested once, so a
  link cycle ends. The link text is still digested too.
- **Side effect:** evidence recorded under a symlinked configuration is invalidated once, which is correct. Nothing
  else changes.
- Covered by "the configuration digest follows symlinked configuration…" in `tests/pi-audit.test.ts`, which fails
  without the fix.

**H3. The `rrsi` policy is not RRSI. (Renamed. Alignment is ticket T2.)** See [RRSI](#rrsi-rename-or-align) below.

**H4. `npm test` is red on a fresh clone with coreutils < 9.5, and nothing enforces the suite on `main`.** These are
the 8 failures above.
- `research/conformance/reference.ts:146` and `research/prime-conformance/reference-swap.ts:29` call
  `/usr/bin/mv --exchange`. The tests gate on `process.platform === "linux"`, not on whether `--exchange` is
  available.
- `tests/conformance-prime-specimen.test.ts:31` asserts a source digest at a commit this repository does not
  contain. It cannot pass here.

Proposed tickets:
- **T3:** gate the publication tests on a probe of `mv --exchange`, so they report as skipped with a reason instead of
  failing. Make `publishReference` refuse with an "exchange unavailable" error before staging, not partway through.
- **T4:** decide what the donor-commit assertions should do. Either import the donor history (a pack or a submodule), or
  keep the assertion as an opt-in test that reports UNAVAILABLE when the commit is absent.
- **T5:** add a CI workflow that runs typecheck, lint and tests on Node 22.19 or later, on a runner with coreutils
  ≥ 9.5.

This is not code in this PR, because each option changes what the suite claims.

### Medium

**M1. Read-only commands modify the store, and can race with a live writer.**
- **Where:** `cli/commands.ts:46,85` (`status`, `events`) and `cli/harness.ts:92` (`harness status`, documented as
  "registry only; starts nothing").
- **What happens:** each of these opens a store through the recovering constructor, which truncates a torn tail and
  creates directories. During `endo harness attach` (which holds the writer lock), an `endo status` run that reads the
  log while an append is landing can classify that frame as torn. It then truncates the log with a rename. The
  writer's frame goes to the replaced inode and is lost.
- **Not reproduced:** this depends on a reader seeing a partially written append. With H1 fixed, the cut bytes are at
  least kept in the sidecar file.
- **Ticket T6:** add a read-only open mode for the four stores (no truncation, no mkdir; report `truncated` instead) and
  use it in every read-only command.

**M2. `harness identify`, `check` and `study` write the registry without the writer lock.**
- **Where:** `adapters/pi/attachment.ts:116`. Only session attachment takes `events/session-attachment.lock`.
- **What happens:** two concurrent `endo harness check` runs on one root each append fingerprints, changes, evidence and
  states from their own in-memory view. `last("state")` and duplicate detection diverge between them. Frames are not
  torn, because the log re-reads on any size change.
- Accepted limitation #5 in `docs/pi-attach-audit.md` assumes the other writers are short. `check` is not short: it runs
  Pi.
- **Ticket T7:** take a registry lock per attachment for the duration of each command.

**M3. The noise condition passes when the noise band is unknown.**
- **Where:** `evolution/policies/rrsi-inspired.ts:180`. If the band cannot be computed, or the parent has no score,
  `noise-pruner` is set to met.
- **Why it matters:** this fills a gap instead of reporting it. Upstream RRSI will not run without a band
  (`rrsi/loop.py`: "no noise band: set cfg.delta or run `calibrate`").
- **Resolved (D2):** an unknown band or an unscored parent now makes the decision inconclusive.

**M4. The GEPA policy is not GEPA, and it selects on the held-out set.**
- **Where:** `evolution/policies/gepa.ts:17,151-157`.
- **What it does:** picks a Pareto front over (evolve mean, held-out mean), then the best held-out score within it.
- **Two problems:**
  - It uses held-out evidence as a selection objective. That contradicts the README's "separation between adaptation
    evidence and promotion evidence".
  - GEPA's Pareto selection is over per-instance scores on its own validation tasks. That description is from the GEPA
    paper; the upstream repository was not checked in this audit.
- The RRSI-inspired policy's `held-out-critic` and `held-out-present` conditions also read the held-out set, but only as
  a screen.
- **Ticket T8:** rename to `gepa-inspired`, with a mechanism table like the one in `rrsi-inspired.ts`.
- **Decision D3:** may any in-tree policy read held-out results?

**M5. `endo ingest` during a live attach makes the attach session's view of the event log wrong.** `ingest` takes no
lock. The session's in-memory storage sequence then no longer matches the file, so the pages and cursors it hands out
point at the wrong events. Covered by T6/T7 (lock, or refuse `ingest` while the lock is held).

**M6. Modules no production code imports.**
- **Imported by nothing:**
  - `adapters/pi/index.ts`, `adapters/prime/shapes.ts`
  - `graph/index.ts`, `lab/index.ts`, `storage/index.ts`, `trust/index.ts`, `visualization/index.ts`
  - `runtime/contracts/index.ts`
  - `protocol/{continuity,control,runtime-profile,session-overview}.ts`
- The four protocol schemas lost their only consumers when #14 removed the fork-era services
  (`docs/pi-attach-inventory.md` §5).
- **Imported only by tests:**
  - the Codex, Cogitator, Deadbolt, Magpie, Prime and REEF mapping and shape adapters
  - `adapters/prime/transport/*`, `adapters/provider/{fetch-transport,openai}.ts`
  - `collab/room-report.ts`, `evolution/index.ts` and the gepa/rrsi-inspired policies
  - `models/{concurrency-policy,orchestration,routing-policy}.ts`, `runtime/admission.ts`
  - `research/conformance/{order,reference,repository}.ts`
- The CLI reaches 39 of 140 production modules.
- **Effect:** the README presented these as implemented. That is corrected in this PR (see below).
- **Ticket T9:** for each one, either delete it, wire it in when its roadmap item lands, or mark it as a library
  without a caller.
  - The four orphaned protocol schemas are the clearest candidates for deletion.
  - Their names overlap the #16–#18 lifecycle, steering and replay work, so decide before that work starts (D4).

### Low

| # | Where | Finding | Fix |
| :- | :--- | :--- | :--- |
| L1 | 39 files, e.g. `evolution/policies/ports.ts:1` | Comments cite `README "## Phase N — …"` sections that no longer exist (the README has no Phase sections) | Point them at `docs/migration-ledger.md` sections, or drop the citations |
| L2 | `adapters/pi/attachment.ts:229` | `state()` appends a capability-state record on every call, and `identify()` appends a fingerprint on every observation. The registry grows without bound | Append a state only when it differs from the last one. Keep fingerprints, since they are needed for reduced identities (evidence rule 3) |
| L3 | `storage/log.ts:151` | `writeSync`'s byte count is ignored. A short write is reported as success, though the next append detects it | Compare the count with `frame.length` and throw |
| L4 | `cli/harness.ts:151` | `--wait ""` parses as 0 | Reject an empty value |
| L5 | `cli/harness.ts:92` | `harness status --attachment typo` creates `harness/typo/` | Use the read-only open from T6 |
| L6 | `storage/event-store.ts:83` | A torn tail is truncated before the remaining frames are validated, so an unopenable store has still been modified | Validate first, then truncate (or open read-only, per T6) |

### Checked, nothing found

- **Pi boundary:** no path installs, updates or patches Pi, or spawns it through a shell. This rests on
  `tests/endo-pi-boundary.test.ts` and a grep for `npm`, `exec` and `shell: true`.
- **Gap-filling in `adapters/pi`:** the `?? ""` and `catch {}` sites in `adapters/pi` and `adapters/rpc-jsonl` each
  record a gap or end a process group. None turns a missing fact into a positive classification.
- **Tests needing network or API keys:** none. The deterministic suites use a loopback fake endpoint. The one test
  that sets `OPENAI_API_KEY` uses a fake value to check that it does not leak.
- **Tautological tests:** a pattern search (`expect(true)`, mock-only suites) found none. Not every assertion was read,
  so this is "none found", not "none exist".
- **Evidence-rule implementation** (`adapters/pi/evidence.ts`): rules 1–7 and the conservative combination match
  the header comment.

## RRSI: rename or align

Upstream (`google-research/rrsi` at `be50316`, 2026-09-23; `rrsi/schedule.py`, `selection.py`, `calibrate.py`,
`config.py`) compared with what was on `main`:

| Mechanism | Upstream | `main` |
| :--- | :--- | :--- |
| Edit budget | cosine over rounds: `b_t = ceil(b_min + (b_max-b_min)/2 (1 + cos(πt/T)))`, b ∈ [1,4], enforced on the proposer | `max(1, ceil(4·0.5^depth))` over parent depth, checked after the fact |
| Noise band δ | fixed per instance (0.017 / 0.004 / 0.020) or calibrated as `z·sd(null ΔS)` from repeated base evaluations or a trial bootstrap; required | mean (max − min) trial spread over the candidates in the context; condition met when unknown |
| Floor | `S' ≥ S* − δ` against the best score so far | gain over the parent > band |
| Cost rule | if ΔS > δ: relative ΔC ≤ β0 + β1·ΔS; inside the band a shaped rule `w_s ΔS − w_c ΔC + w_n ν > 0` | none |
| Critic | leakage screen (regex denylist + LLM review) before evaluation | evolve gain with held-out loss |
| Pruning | components with recent yield ≤ 0 offered for removal | not modelled |

**Recommendation: rename now, and align later as a measured ticket.** The PR does the rename: the file, the constant
and the recorded identity become `rrsi-inspired`, and the header documents every difference listed above.

Aligning properly needs three things the policy context does not carry today:
- token cost per trial, for the cost rule;
- a calibration record for δ, from repeated base evaluations;
- the best score so far, S*, across rounds.

Building those belongs in the evaluation lab (#20). Doing it inside a cleanup PR would be guesswork.

**Ticket T2:** `endo.selection-policy` `rrsi` revision v1. Add cost and calibration to the context, implement
Algorithm 2 as pure functions, and test against upstream's own `selection.py` cases.

**Decision D1:** confirm the rename. Renaming changes the identity name recorded on new decisions. No stored decision
records exist in the repository, so nothing needs migrating.

## README "Current state" against `main`

| README said | `main` does | In this PR |
| :--- | :--- | :--- |
| "Implemented and tested": the cognition graph, evolution and promotion records, trust mappings for Cogitator, Magpie and Deadbolt, orchestration and collaboration records | Present and unit-tested, but reachable only from tests (M6). Nothing in the CLI or the attachment uses them | Moved to a new "Implemented as libraries, exercised only by unit tests" list |
| "live provider integrations beyond the OpenAI-compatible adapter" | The OpenAI-compatible adapter is not wired into any command | Now says no live provider integration is wired into a command. The adapter is listed with the libraries |
| "RRSI/GEPA can provide reference policies"; roadmap 11 "the existing RRSI, GEPA … policies" | The in-tree policies are invented rule sets (H3, M4) | Now says "RRSI- and GEPA-inspired rule sets, not ports", with what a faithful RRSI policy needs |
| `npm test` — "deterministic suite (no Pi, no network)" | True, but 8 tests fail on coreutils < 9.5 or without donor history (H4) | Known failures stated, with a link to this audit |
| Pi attachment claims (fingerprints, checks, live study, recording, replay, crash recovery) | Match the code and tests | Unchanged |

## PRs #2–#13

The heads of #2–#13 are all ancestors of `main`, so every commit from the phase stack is in `main`. For each PR,
every file it added or modified is still on `main`, except the 16 #13 files listed below.

| PR | Phase | Note |
| :- | :--- | :--- |
| #2 | 1 — protocol and identity | Superseded; all 10 files on `main` |
| #3 | 2 — event and evidence substrate | Superseded; all 9 files on `main` |
| #4 | 3 — cognition graph | Superseded; all 15 files on `main` (wired to nothing, M6) |
| #5 | 4 — visual cognition | Superseded; all 15 files on `main` (`visualization/index.ts` has no importer) |
| #6 | 5 — evaluation and conformance lab | Superseded; all 15 files on `main`. Its publication tests are the `mv --exchange` failures (H4) |
| #7 | 6 — evolution substrate | Superseded; all 14 files on `main` |
| #8 | 7 — RRSI + REEF provider seams | Superseded; all 8 files on `main` |
| #9 | 8 — trust integrations | Superseded; all 19 files on `main` |
| #10 | 9 — runtime expansion | Superseded; all 14 files on `main` |
| #11 | 10 — model and runtime orchestration | Superseded; all 10 files on `main` |
| #12 | 11 — collaboration | Superseded; all 11 files on `main` |
| #13 | 12 — operational substrate | Superseded; 51 of 67 files on `main`. #14 deliberately removed 16 fork-era files, each listed in `docs/pi-attach-inventory.md` §5 (see below) |

The 16 #13 files removed by #14:
- `adapters/pi/ports.ts`
- `runtime/{ports,session-worker}.ts`
- `runtime/contracts/{continuity-facet,inspector}.ts`
- `scripts/check-browser-smoke.mjs`
- 4 test files and 6 session-worker fixtures

What #13 lost is the continuity, inspector, session-overview and usage services that ran inside Pi's fork-only Session
worker. They cannot run against an installed Pi. Their protocol schemas remain on `main` with no consumer (M6). Nothing
else was lost.

## Decisions

Answered by the maintainer after the audit was written. Each entry gives the answer, then where it is carried out.

- **D1: rename accepted.** The policy stays `rrsi-inspired`. Faithful RRSI (T2) waits until the experiment substrate
  exposes the calibration, cost and history the method needs. Done in this PR.
- **D2: missing noise evidence is never a pass.** `noise-pruner` is now unmet, and the decision inconclusive, when the
  band cannot be computed. The same applies when the gain cannot be computed because the best candidate has no scored
  parent. Done in this PR. New tests: "is inconclusive when the noise band cannot be measured…" and "…has no scored
  parent…".
- **D3: selection may read validation evidence; a promotion holdout must stay untouched.** The partition vocabulary is
  renamed so that validation-for-selection is distinct from the promotion holdout. That is a separate PR, stacked on
  this one.
- **D4: keep the four schemas, marked unwired.** Each header now states that it is an unwired, planned protocol
  surface with no producer. The README lists them separately. Done in this PR.
- **D5: no donor history in the core repository.** The default tests become self-contained, historical-provenance
  checks become optional, and CI is added. That is a separate PR (T3, T4, T5).
