# DEVELOP-VERIFY-TRUST-001: the smallest follow-up

> **Addendum 1 (2026-11-12):** this slice is **not** the recommended next step. The review ([addendum-1/ADDENDUM.md](addendum-1/ADDENDUM.md) §7)
> found that the condition below, "the controlled runner is trusted code", also has to cover the runner's working files, its records
> and its Git inputs (R1-R3). No same-user arrangement meets it. The slice stays as a design note for after a separate-principal
> experiment. Any version of it needs C1 (hardened Git reads) and C2 (records bound to their commit).

A design note, not an implementation. Nothing here is built, and READY is not authorisation for general integration. The slice exists to
test one claim inside the product: an operator can ask for a **controlled check** of one planned behavioural check. They get an
observation that the inherited environment, `PATH`, the live worktree and the candidate's view of the host could not decide. It is
shown as its own tier, never merged with ordinary checks.

## The slice

**One command, chosen by the operator, never automatic:**

```
endo attempt check --attempt <id> --controlled -- node roman.mjs 1994
```

- **The class.** The argv must be a planned check of the attempt, and that check must declare `expect`, an exit code and standard
  output. `argv[0]` must be `node`, which is mapped to the pinned runtime (`/usr/bin/node`, root-owned, by digest), never looked up on
  `PATH`. Any other argv is refused, and nothing is run or recorded. These checks are the only ones whose reading needs no new rule:
  the ledger already reads them by exit code and output digest.
- **The source.** The clean HEAD the ordinary check would use, read from Git objects at that commit, with each object id recomputed.
  Only regular files within bounds. The sandbox's working directory is the read-only export, not the worktree.
- **The run.** One sandbox per check, built by `buildSandboxProfileV0` and run by `runSandboxV0` in a systemd user scope. The
  environment is `HOME`, `PATH` and `TMPDIR` only; there is no network. The expected output never enters the sandbox.
- **Qualification, per invocation.** The preflight from inside the same profile must be `established`. A built-in canary must give its
  known output, and a built-in wrong canary must not. This qualifies the mechanism, not the plan: DEVELOP has no reference
  implementation, so a wrong expectation in the plan is still the operator's (B2).
- **Unsupported states are explicit.** A host without user namespaces, bubblewrap, a user manager or cgroup v2, an untrusted runtime,
  a candidate tree with links or submodules, a non-`node` argv, an argv without `expect`, a hostile variable in the controller's own
  environment, or a failed preflight is refused before anything runs, naming the prerequisite, and nothing is recorded. This is the
  refusal pattern `attempt check` already uses ("Nothing was run and nothing was recorded"). An interrupted or unconfirmed run is
  recorded and reads *inconclusive*, never *passed*.

## Where it lands (the production seams, to be changed by that PR, not this one)

| Seam | Change |
| :-- | :-- |
| `protocol/develop-receipts.ts` | A new version, `endo.develop-receipt.v2`, which adds `tier: "ordinary" \| "controlled"`. Controlled receipts record the runtime digest, the isolation (bubblewrap and containment versions, the profile digest), the preflight status, `source: "git-objects"` with the export digest, and the source digests of the controlled runner. Their limitations drop `environment-not-recorded`, `concurrent-writers-not-excluded`, `changes-reverted-during-check-not-detected` and `processes-leaving-group-not-tracked`. They keep `command-defines-the-check`, `unsigned-local-record` and `attempt-link-is-operator-declared`, and add `verifier-code-trusted`. v0 and v1 receipts keep their meaning and read as `ordinary`. |
| `storage/develop-receipts.ts` | Read and write v2 beside v0 and v1, through the existing version table. |
| `runtime/contracts/develop-receipts.ts` | `DevelopReceiptsServiceV0` gains a controlled plan and run. The sandbox runner and the Git-object export are injected, as `observe` and `run` are now. The existing `plan`/`run` path is unchanged. |
| `adapters/develop/` (new file) | The controlled runner: the export, the preflight and qualification, and per-case `runSandboxV0`. It is the study's `verify.ts`, minus the oracle file and the reader. |
| `runtime/contracts/develop-verification.ts` | `endoAcceptanceLedgerV0` computes each planned check's state per tier. A controlled pass never satisfies an ordinary reading, and an ordinary pass never satisfies a controlled one. A criterion shows both. |
| `runtime/contracts/develop-attempt-evidence.ts`, `runtime/contracts/develop-attention.ts`, `protocol/develop-attention.ts` | The evidence's "not established" list and the attention triage name the tier. A controlled failure is attention like any failure. A controlled pass does not hide an ordinary failure (DEVELOP-ATTENTION-002's rule, per tier). |
| `cli/develop-attempts.ts`, `cli/help.ts` | `--controlled`; the refusal messages; a printed statement of what the tier does not establish. |
| `docs/designs/develop-verification-receipts.md`, `docs/designs/develop-behavioural-checks.md` | The tier, its class and its residual trust. |

Out of the slice: the Studio page (it shows the tier only once the ledger has it); hidden cases (an operator-held oracle outside the
brief); other runtimes; any change to ordinary checks' meaning; signing.

## Conditions the slice must state, not solve

- **The controlled runner is trusted code.** In this study, a hook loaded into the verifier forged a PASS (4c). A same-user agent that
  ran unsandboxed could edit the `endo` installation itself. The slice records the runner's source digests. It must say that the tier
  means what it says only when those files were out of the agent's reach: an agent in the protected sandbox or under another user, or
  an installation the user cannot write. The slice cannot establish that.
- **`requestedBy` is still not authentication,** and the receipt is still an unsigned local file (9d).
- **Visible expectations can be gamed.** Candidate C passed every visible planned check. The slice verifies what the plan declares,
  no more. A criterion still reads *Planned checks passed* only for what its checks sample.

## The acceptance test for the slice

Re-run this study's rows 3, 5, 6x, 7a-7e, 9a and 10 through `endo attempt check --controlled`, and the ordinary rows through
`endo attempt check`:

- the ordinary tier's false passes (3, 5, 6x) remain, and are labelled ordinary;
- the controlled tier fails B and C2 and passes A and P;
- every refused prerequisite is refused with its name, and nothing is recorded;
- a SIGKILL mid-check reads inconclusive.

Also run DEVELOP-VALIDATION-002's twelve attention cases, unchanged, to show that ordinary semantics did not move.
