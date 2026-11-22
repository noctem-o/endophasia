# Staged change sets in protected runs

Status: **implemented, opt-in** (`endo.protected-experiment-spec.v2` offline, `.v3` model-connected). Versions 0 and 1 are unchanged and remain the default; `exportSubmissionV0` still collects every fixed-path task.

## 1. Purpose

`endo experiment protected-run` collected a fixed list of declared files (`adapters/sandbox/submission.ts`). Real coding work changes an arbitrary set of files. This wires the boundary-agnostic collector from `docs/designs/staged-changeset.md` (#163) into the existing protected-run lifecycle, without changing that lifecycle's boundary, termination confirmation, evaluator sandbox or record sealing.

## 2. Opt-in mode and versions

A staged task replaces `submission: string[]` with:

```json
{ "mode": "staged-changeset",
  "limits": { "maxFileBytes": 65536, "maxTotalStagedBytes": 262144, "maxWorkspaceBytes": 1048576,
              "maxWalkedEntries": 256, "maxChangedFiles": 32, "maxDepth": 8 } }
```

Every bound is explicit and at most the collector's default. Its workspace paths must be plain change-set paths (no `.git`) forming a possible tree. Staged tasks exist only in new versions, each read strictly by its own rules (`protocol/protected-experiment.ts`):

| Spec | Run | Trial | Network | Submission |
| :--- | :--- | :--- | :--- | :--- |
| v0 | v0 | v0 | none | fixed paths |
| v1 | v1 | v1 | model relay | fixed paths |
| v2 | v2 | v2 | none | staged change set |
| v3 | v3 | v3 | model relay | staged change set |

A run resumes only as the version it began as, and the report reads each record only as its run's trial version. No v0/v1 shape, digest input or rule changed; historical records read as before.

This is a deliberately small first step: the fixture is the task's own `workspace` (a small, pre-pruned repository that fits the walk limits). There is no ignore policy; a workspace that does not fit its limits refuses the run before any trial.

## 3. Baseline pin (controller-owned)

1. **Before anything runs**, the controller derives the baseline record (`endo.workspace-baseline.v0`) from the spec's workspace bytes in memory (`endoProtectedStagedBaselineV2`): every file non-executable, `rootGitExcluded: false`. The agent never supplies it.
2. **Qualification** materializes the workspace, captures it within the task's limits and requires exactly the pin, else the run is refused.
3. **Per attempt**, the controller writes the same bytes into `baseline/` (pristine, read-only files, never mounted) and `work/` (the agent's workspace, mounted read-write as before).
4. **After the preflight is established and before the relay or agent starts**, both trees are captured again and must each equal the pin. On a mismatch neither the relay nor the agent is started, and the record says `baseline.status: mismatch` (attrition `baseline-mismatch`). Otherwise the pin is written to `baseline.json` before the agent's scope is recorded.

## 4. Collection behind confirmed termination

The existing gate decides: unless `agent.termination === "confirmed"` (the agent's systemd scope confirmed ended), nothing is collected and the record carries `collection: not-collected`; an interrupted attempt finalized on resume never collects. Only then does `collectStagedChangeSetV0(pin, work/, changeset/, limits)` run, unchanged. A collector refusal (link, special file, `.git`, a bound exceeded) is the agent's own failure (`changeset-<reason>`), except `changed-during-collection`, which is attrition as for fixed paths. The collecting path does no verification.

## 5. Verification in the evaluator step

`evaluateStagedChangeSetV2` (`adapters/sandbox/evaluator.ts`) receives the pin record (in memory), the `baseline/` tree, the staging directory and the collector's `changesetSha256`, and calls `verifyStagedChangeSetV0` with two new options:

- `baseline` (the complete record): every `before` state must be the baseline's entry exactly; every `added` path must be absent from it; the summary's baseline and candidate counts must be the trees'; and the candidate tree implied by baseline plus changes must be possible. This closes the gap #163 left: a manifest lists only changed paths, so on its own it cannot reveal an `added` path beneath (or above, or equal to) an unchanged baseline file.
- `baselineTree`: the trusted tree is captured again and must be exactly the record.

New closed failure reasons: `baseline-conflict`, `baseline-mismatch`, `candidate-mismatch`. A change set that does not verify is never evaluated (attrition `changeset-unverified`).

## 6. Fresh evaluation workspace

`reconstructStagedCandidateV0` creates a new `candidate/` directory and writes every unchanged file from `baseline/` and every added, modified or mode-changed file from the staging directory, re-hashing each against the record or manifest as it reads it (a file swapped after verification is refused and nothing is left). Files are `0o444`; executability stays metadata, as in staging. The result is captured again and compared with the expected tree. The evaluator sandbox mounts `candidate/` read-only at `/submission`: the agent's live workspace is never evaluated, and nothing is written to any host checkout.

Qualification takes the same path: the evaluator's reference and negative (complete trees) are collected against the pin, verified, reconstructed and evaluated; the reference must pass and the negative must fail.

## 7. Record version change

Trial v2/v3 replace `submission` with:

```text
changeset.baseline      { status: pinned | mismatch | not-pinned, sha256, files, totalBytes }
changeset.collection    { status: collected | refused | not-collected, changesetSha256, summary, refusals }
changeset.verification  { status: verified | failed | not-run, reason, candidateSha256 }
```

The reader fails closed on contradictions, among them: an agent that ran on an unpinned baseline; a collection without confirmed termination; an evaluation result without a verified change set; a verified change set without a candidate digest; a summary that contradicts its counts or the pinned baseline; a missing staged-invalidating condition. The report re-derives each record's baseline from its spec and re-verifies a verified change set from the attempt's `changeset/` and `baseline/`, and checks the candidate digest; a mismatch is `record-refused`.

Attempt layout additions: `baseline/`, `baseline.json`, `changeset/`, `candidate/`.

## 8. What this does not claim

| Claim | Status |
| :--- | :--- |
| The evaluated tree is the pinned baseline plus the verified difference observed after confirmed termination | **Established**, for the controller's own process on the host it ran on |
| Isolation of the agent | **Not claimed here.** Unchanged from the existing protected-run boundary; this change adds no boundary |
| Who authored any change | **Not claimed.** A difference between two trees is not authorship |
| Permission to apply changes to a host checkout | **Not granted.** Nothing is written back anywhere |
| Protection against a same-uid host writer | **Not claimed.** `baseline/`, `changeset/` and `candidate/` are unsigned files the operator's uid can change; tampering between steps is detected by re-hashing, not prevented |
| Directory races finer than the filesystem timestamp granularity during collection | **Not addressed** (GEO-16, separate) |
