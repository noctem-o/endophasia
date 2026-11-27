# CI-RELIABILITY-001 — Rollout, Monitoring, and Rollback Plan

## 1. Rollout Strategy

1. **Draft PR validation (`#197`):**
   - Branch `feat/ci-reliability-001` is open as Draft PR `#197` targeting `main` (not merged; branch protection untouched).
   - Hosted GitHub Actions runs validate all 12 CI job definitions (15 job executions: 8 specialist jobs, `test-fast`, `test-browser`, 4 `test-process` shards with `--strict-accounting`, and the fail-closed `CI verification` aggregate gate).
2. **Operator review and promotion order:**
   - Intended promotion order: **`#197` (CI reliability) -> `#195` (Coordinator consolidation) -> `#196` (Deterministic Coordinator Studio)**.
   - Do not merge any PR automatically; wait for operator review.
3. **Statistical honesty on reliability evidence (F7):**
   - Distinguish clearly between:
     1. *Confirmed defect remediation* (root-cause fixes + deterministic regressions + local G1/G3 trials).
     2. *Observed candidate success* (initial hosted PR `#197` runs).
     3. *Early operational reliability* (naturally occurring 20–30 post-merge runs).
     4. *Statistical evidence of long-term reliability*.
   - Under an idealized independent Bernoulli model with zero failures in `n` runs, the one-sided exact 95% lower confidence bound is `p_lower = 0.05 ** (1 / n)`:
     - `n = 20`: **86.1%** (useful early signal, **not** proof of 99%)
     - `n = 30`: **90.5%** (still well below 99%)
     - `n = 100`: **97.0%**
     - `n = 299`: **99.0%**
   - Real CI runs are also non-i.i.d. (runner images update, test suites grow, and host load fluctuates). Treat `>= 99%` first-attempt reliability as an ongoing operational objective observed through natural post-merge development activity rather than artificial rerun inflation.
4. **Pinned historical research branches (Section 9 — DO NOT MODIFY):**
   - **PR `#192`** (`research/s2-live-001`, head `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`)
   - **PR `#193`** (`feat/coordinator-grounding-002`, head `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`)
   - **PR `#194`** (`research/coordinator-reasoning-001`, head `3c22f1a91da2e64f0c0488fae767ceb70c653995`)
   - **Do not rebase, amend, force-push, or modify these branches.** They are pinned historical experimental identities preserving their exact source revisions, environmental limitations, and negative CI results. Future research should incorporate the hardened CI infrastructure on fresh descendant/successor branches after `#197` merges.
5. **Production PR integration plans (`#195` and `#196`):**
   - Exact narrow integration plans for PR `#195` and PR `#196` (applied only after `#197` is reviewed and promoted by the operator) are documented in `FOLLOW-UP-REVIEW.md` §7.

## 2. Required-Check Migration Plan (F4)

Verified via authorized read-only `gh api` on 2026-11-27:
- `branches/main/protection`: **HTTP 404 (not protected)**
- `rulesets`: **`[]`**
- `rules/branches/main`: **`[]`**

Because `main` currently enforces zero required status checks:
- Merging `#197` will **not** leave legacy `Test (shard 1/3..3/3)` checks permanently pending.
- `.github/workflows/ci.yml` now provides a durable, fail-closed **`CI verification`** aggregate job (`if: always()`, failing non-zero unless all 11 upstream job IDs report `result === "success"`).
- **Optional operator step after `#197` merges:** If enabling branch protection or a ruleset on `main`, require **`CI verification`** (GitHub Actions). Because `CI verification` aggregates every general partition and all 8 specialist jobs without ever skipping on failure, future internal shard adjustments will not break the merge gate.

## 3. Ongoing Monitoring and Duration Hint Maintenance

- **Reliability & compute tracking:** Run `npm run ci:analyze -- --live --limit=40` periodically to track first-attempt success rate, failure-to-pass rerun rate, median/p95 elapsed time, shard imbalance, and **actual deduplicated runner-minutes** (noting that 15 parallel job executions consume ~4–5 more raw runner-minutes per single attempt than the legacy 11-job layout in exchange for ~25–30% faster wall-clock feedback and fewer reruns).
- **Refreshing duration hints (`tests/test-durations.json`):**
  - New test files work automatically without editing `tests/test-durations.json` (defaulting safely to `process` with `5000 ms` LPT weight, or `browser` for Chromium suites).
  - Periodically refresh `tests/test-durations.json` from uploaded `ci-diagnostics-*.json` artifacts on a passing `main` run to keep LPT shard balance tight and promote newly added pure unit tests into `fast`.

## 4. Rollback Plan

Every layer is independently revertible without disturbing the others:

1. **Workflow sharding / aggregate gate rollback:** Reverting `.github/workflows/ci.yml` (and the `ci.yml` cross-check in `scripts/test-inventory.mjs`) restores the original 3-shard `npm test -- --shard=k/3` job immediately while preserving all Phase B & follow-up fixture/lifecycle/build fixes and local developer scripts. If branch protection was enabled on `CI verification`, update required checks to the restored job names before merging the revert.
2. **Individual defect-fix rollback:** Each remediation (atomic barriers, ACP per-request `closeSession({ timeoutMs })`, AA zombie/FD inspection, browser button wait, immutable Studio UI artifacts + writer-locked `build-studio-ui.mjs`, strict execution reconciliation) is self-contained and revertible without weakening specialist jobs.
