# One bounded submission, one operator decision

Base: main at 8e505339caadacdd8568d96111094ec1e0cd1ee5. The merged pilot is in
`research/develop-isolate-004/{README.md,pilot.ts}` at this SHA (the brief's
missing-path assumption is stale). It is a research condition for
`cli/experiment-protected.ts`, not a writable Everyday grant. No #158 code.

`docs/develop-tasks.md` and `research/work-cycle/driver.ts` distinguish a
registered project, operator task, prepared attempt referencing the task, and
explicit session references. The operator's status move is a decision, not a
receipt for particular bytes. Protected experiments instead identify a run by
spec ID, canonical spec digest and seed; task, condition, trial, position and
attempt/retry are explicit fields. Reusing the same spec can repeat all of
these coordinates. There is no justified join across the two identity spaces.

Use a fresh run ID in an operator-pinned single-trial spec. Its literal
workspace replaces admission from a Git checkout (no need to call
admitWorkspaceV0 or inspectWorkspaceGitV0). The existing controller checks
the bwrap profile from inside before launch, observes the scope and process
exit, and validates relay exchanges against the recording. Pi tool events
remain provider statements. After confirmed termination, exportSubmissionV0
copies only declared regular files into attempt-N/submission and hashes the
sorted manifest. The evaluator mounts that copy read-only, pins its definition
and driver, and scores outputs outside the sandbox. It does not authenticate
the JS function as the writer of the driver's output, or prove more than the
finite cases. Qualification checks a reference and negative before launch.

New boundary: a read-only one-attempt research projection, given the operator's
spec pin, which checks existing run/trial records, collection bytes and case
counts before recommending manual review. No second ledger and no state move.
The historical evaluation is linked by controller data flow, not a signed
receipt from a separate identity. Retain the exact source bytes for replay.

Arrangement C restricts the launched agent, not other host processes owned
by its uid. A fresh grading namespace cannot protect same-uid records, code,
or an operator-held pin from a hostile host writer. H0 for a separate-principal
claim is absent (docker/libvirt/wheel membership observed; no sockets tested).
See develop-verify-trust-002/{FOLLOW-UP,THREAT-MODEL,RESULTS,INSTALL-PLAN}.md.
Do not run submitted code on the host or certify a PASS, even on full agreement.
