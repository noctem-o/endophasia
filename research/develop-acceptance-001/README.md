# Experimental acceptance: strictly positive counts

**Recommend manual review of the 83-byte Pi candidate. Nothing was accepted.**
This is a different task from the merge-intervals pilot. In a second,
deterministic process run the reference produced identical submission bytes;
the unchanged fixture printed PASS and exited zero but missed two cases.

| Evidence class on this Arch host | Case | Observed result |
| --- | --- | --- |
| Model-connected | Pi 1.5.2, local Ornith, read/edit launcher | Three recorded HTTP 200 exchanges. Pi reported read and edit. Controller observed established preflight, scope and termination; offline evaluator scored 5/5. |
| Real isolated process | Reference writer; unchanged writer | 5/5 vs 3/5. Only the reference shared the model run's manifest digest. Qualification independently required a passing reference and failing negative before each attempt. |
| Fixture replay | Change the staged bytes after a successful read | Refused: staged bytes mismatch. |
| Fixture replay | Another invocation's pin, missing or malformed final record, edited case count, missing model recording/key | Refused, not replaced by a prior or plausible result. These are reader tests, not attacks on a live process. |
| Real isolated process | Time out the fixture | SIGKILL, scope ended confirmed. The evaluator still scored residual bytes 3/5; the recommendation was **incomplete**, not a completed attempt. A separate existing detached-child control observed its sandbox init gone and its heartbeat stopped. |
| Real isolated process | Existing forged-test/result-file fixture | Fake PASS in the workspace didn't pass the evaluator; exiting the grading process without a frame gave no-result. No attempt to tamper with host services. |
| Threat analysis (not a test result) | Host writer with the operator uid | Can replace a record and recompute its unkeyed seal. The reporter cannot establish independent authority against that writer; it never issues a verified PASS. |

## Read one attempt

In `evidence/pi/`, `protected-run.json` embeds the pinned workspace, argv,
policy, evaluator pin, qualification and trial plan. `record.json` is the
original sealed attempt (including probe observations and requested mounts);
`count.mjs` is the exact staged file, not a reconstruction from Pi's messages.
`report.json` is the derived projection. Equivalent offline snapshots live in
`reference/` and `unchanged/`; `timeout.json` is the timeout projection.

The operator spec pin was
`48de9faa2770c4e5cc9482a4baa85bf865303c959242567f75d9afda8c5be71e`.
The protected controller called the evaluator with the freshly exported directory
in this same attempt; the reader compared the retained file with its manifest.
Manifest SHA-256: `956accd4ddde96bff16a056a343175562f7cbdfb96a8a54ece18a45e6b84fda2`.
The evaluator identity is **the existing driver digest**, with the separately
pinned case definition in `checks/evaluator.json`. The record retains counts
and an output digest, not the raw evaluator output or individual case verdicts.

From the repo root, without executing either submission:

```sh
d=research/develop-acceptance-001/evidence
sha256sum "$d"/{pi,reference,unchanged}/count.mjs
cmp "$d/pi/count.mjs" "$d/reference/count.mjs"
jq '{run,trial,submission,evaluation,invalidating}' "$d/pi/record.json"
```

The raw model recording and its private digest key are deliberately not in
Git. George can rederive the historical report on this device; a public reader
can inspect provenance and rerun but cannot independently validate those three
historical exchanges from the PR alone:

```sh
node research/develop-acceptance-001/report.ts "$HOME/.capy/work/endo7/private" \
  48de9faa2770c4e5cc9482a4baa85bf865303c959242567f75d9afda8c5be71e | cmp - "$d/pi/report.json"
```

## Reproduce a fresh attempt

Requires the supported unprivileged bwrap/user-manager host. Only `pi` needs
trusted stock Pi and the approved credential-free loopback server. Choose
`reference`, `unchanged`, or `timeout` instead for deterministic process
controls. From the repository root:

```sh
set -eu
umask 077
r=$(mktemp -d)
h=research/develop-acceptance-001
pin=$(node "$h/prepare.ts" "$r/once" pi)
cat "$r/once/spec.json" "$h/checks/evaluator.json"   # inspect before launch
printf '%s  %s\n' "$pin" "$r/once/spec.json" | sha256sum -c -
HOME="$r/once/home" node cli/index.ts experiment protected-run "$r/once/spec.json" --out "$r/once/result"
node "$h/report.ts" "$r/once/result" "$pin"
```

Use a new spec per invocation; never replay the same prepared spec as a new
run. The UUID names the request, not a non-replayable host identity. Spec
paths, run IDs and scope names will vary. The model is not deterministic.
The reference should recommend review, unchanged rejection, timeout incomplete
(exit 1); a missing host prerequisite must refuse, not trigger a fallback.
Rollback: remove only the new private directory `"$r"` after review. No service
or checkout needs restoring.

## Security review and limits

The evaluator has its own offline namespace; only the inputs, driver and
submitted file enter it, read-only. Host code compares outputs against expected
values. Submitted JS still runs in the driver's JS process: matching a finite
vector is not proof of who produced it or of general correctness. The read/edit
setting is a launcher configuration, not proof of per-call enforcement. Host
preflight and scope observations are not lifetime attestation for all possible
descendants, nor proof of in-flight revocation. The relay proves observed
exchanges, not authenticated per-tool authorship or model weights.

The reader assumes a **quiescent, private, controller-owned run directory** and
a trusted copy of the pre-launch pin. It is not an archive importer for
attacker-controlled directory trees. It neither authenticates historical
records against same-uid resealing nor excludes a transient same-uid change
between collection, grading and later reread. Evidence classes describe the
collection setting, not an authenticity property of a schema. No privileged
socket was opened, no verifier principal installed, no workspace promoted,
and there is no receipt linking this experiment to a DEVELOP task status.

Recommendation: keep this as an arrangement-C research reader. A production
authority claim would need a separately approved principal/host design and
H0; enabling a writable production agent would also need the remaining
isolation gates. Decide only whether to retain this experimental slice.

## Validation

- `npm run typecheck`, `npm run lint`, `npm run build`: successful. Biome
  reported one pre-existing unused-parameter warning at
  `tests/endo-cockpit-eighteenth-review.test.ts:674`.
- `npm test -- tests/develop-acceptance.test.ts tests/protected-{records,model-records}.test.ts`:
  43 passed, zero skipped (9 fixture reader tests plus 34 existing record and
  local relay controls, no real model in those suites).
- `ENDO_REQUIRE_ISOLATION=1 npm test -- tests/protected-isolation.test.ts -t 'has the required real sandbox host|kills a timed-out agent|fails a submission that forges'`:
  3 passed, 45 excluded by name. Those 45 in `tests/protected-isolation.test.ts`
  include refusal of unsafe submissions, evaluator/profile identity, lifetime
  of scopes and resumed attempts, and sealed-record integrity. The unfiltered
  workstation run executed all 48 in that file: 48 passed, zero skipped.
- Full workstation suite: `ENDO_REQUIRE_ISOLATION=1 npm test -- --maxWorkers=4`
  in a disposable HOME and clean environment with the user manager available.
  **6,962 passed, 97 skipped, zero failed** across 278 passing and 11 skipped
  files in 645.31 s. Skips elsewhere are not evidence for the skipped behavior.
- During development the spec validator refused two generator drafts (ID
  prefix; v1-only fields in v0). Neither refusal launched that condition.
  One fixture mutation initially failed on a read-only test copy; writing
  the disposable fixture with normal test permissions fixed the setup.
