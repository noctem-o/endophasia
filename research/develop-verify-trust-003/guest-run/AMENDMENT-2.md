# Amendment 2: retention and coverage

The original manifest lists 92 files, but the tree at `c330fded6` contained only 83. Nine original logs were present on the device and excluded by the repository's `*.log` rule. Each matched its original manifest digest **before** inclusion; none was regenerated. Commit `fc6951067` force-added just those nine. Verification from a fresh `git archive` now checks all 92, unlike the original working-tree check. The historical manifest and its existing members were not rewritten.

The probe, matrix and reader digests in RESULTS.md identify **historical versions only**. No revised driver or reader has run in a guest. The driver regressions exercise shell control flow with stand-ins for system services. Its new idle invocation performs only a passive process census: no idle mutation attempts, so a future run will not reproduce that historical coverage. A successful strace unit launch is not evidence of attachment; the trace must independently contain the expected measurements. A probe exit status does not establish a particular refusal either.

The device has exercised the corrected grader under two distinct mapped identities, including the root-stager branch. It has not exercised privileged Git acquisition against a live guest agent or the installed service stack. A separately approved guest rerun would be the first to exercise together:

1. The revised pin and first-stop checks, passive idle census, measurement-error handling, poll budget and invocation-scoped completion checks against real guest systemd, journal and PAM sessions.
2. A protected pre-read archive of the live records **and Git objects**, acquisition as the configured agent rather than root, authoritative rereads and object binding against that same installed run.
3. Independent grading of those bound buffers as the guest grader with the installed runtime, including its real permissions and termination behavior, followed by a comparison against post-read evidence.

This does not authorize a workstation or guest run. The unchanged 16-export result remains conditional on the archived records and the old root reader as described in Amendment 1.
