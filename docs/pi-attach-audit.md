# Pi attachment audit: boundary and evidence invalidation

Date: 2026-10-03. Scope: `adapters/pi/`, `adapters/rpc-jsonl/`, `storage/harness-registry.ts`, `protocol/harness.ts`,
`cli/harness.ts`. Question asked of every path: can Endophasia end up admitting, keeping or recording something the
current runtime has not been shown to do?

Method: read each path as an attacker or as an unlucky operator (a runtime replaced mid-check, a second writer, a
hostile extension, a newer Pi that adds fields), write the failing test first where the path was exploitable, fix,
then mutation-check. Every fixed finding below except #6 is covered by `tests/pi-audit.test.ts`. Fixes 1, 2, 3, 5 and 8
were mutation-checked (each fix reverted in turn; its test failed every time). The others are covered by tests written
against the fixed behaviour but were not separately mutation-checked.

## Fixed

| # | Finding | Impact before | Fix | Test |
| :- | :--- | :--- | :--- | :--- |
| 1 | Evidence precedence ranked check kinds (live › local › static) | a scoped live study (one provider, one model) replaced broader or contradicting protocol evidence, e.g. a live EXACT hid a local MISMATCH | latest record per check; supersession only where a check's definition declares it (one declaration: live study over the local state check, `session.identity` only); otherwise the most conservative classification decides | "evidence combination" block (6 tests) |
| 2 | Evidence ignored Pi's user configuration | editing `models.json`, `settings.json`, MCP servers, system prompts or installing an extension left evidence valid for a runtime that now behaves differently | configuration digest (`configuration.ts`) is a dependency of every check kind; credentials and secrets excluded | "a change to Pi's user configuration…", "the configuration digest ignores credentials…" |
| 3 | Runtime replaced while a check ran | evidence recorded against fingerprint A described (partly) runtime B | fingerprint again after every check; on a difference nothing is recorded and the change is recorded | "discards check results when the runtime changes…" |
| 4 | Launch through the symlink that was resolved, not the file that was hashed | retargeting `bin/pi` between fingerprint and launch ran an unhashed file | launch by the hashed real path when executable | "launches the file it hashed…" |
| 5 | Reconnect reused the session's original fingerprint and admissions | after the operator updated Pi and the process restarted, controls admitted for the old runtime were offered for the new one | `reconnect()` re-identifies, records `harness.runtime-changed` and the change notice, re-derives capabilities; an unidentifiable runtime is not launched | "a runtime replaced while disconnected…" |
| 6 | Records from a superseded process | buffered records flushed by an exited process after a reconnect were attributed to the new instance | events and diagnostics accepted only from the process currently owned | code path; not deterministically reproducible (see accepted #4) |
| 7 | Two session attachments on one store root | both extended the event log from different in-memory views (sequence and dedupe divergence) | exclusive writer lock per root; a lock left by a dead process is replaced; an unreadable lock is never stolen | "refuses a second concurrent writer…" |
| 8 | Extension dialogs blocked local checks | a user extension opening a dialog at startup stalled every check until timeouts | the check recorder answers blocking dialogs `cancelled` and notes it | "an extension dialog that blocks Pi…" |
| 9 | Undocumented identifiers would go unnoticed | a Pi that starts sending `runId` would still be recorded as having no run identity | the live study compares lifecycle-event and prompt-response keys with the documented ones; extra keys are MISMATCH (review needed) and combine conservatively with the baseline review | "an undocumented run id…" |
| 10 | Baseline acted as a whitelist | the static classification ran only for "tested" versions; other releases could not establish those capabilities at all | version standing is informational; the documented-surface review is scoped to the reviewed release; the live study observes the same absences on any release | "operation.outcome and run.identity are established on a non-baseline release…" |
| 11 | Live-study configuration dependency named the session's tools | evidence was keyed to a tool setting the study never used | the dependency records the tool set the study ran with | covered by #2's tests |

Adapter and suite versions were bumped (`pi-rpc-adapter.2`, `pi-rpc-suite.2`), so all evidence recorded before these
fixes is invalid by rule 4 and the baseline was re-recorded.

## Accepted, with reasons

| # | Limitation | Why accepted now | What would change it |
| :- | :--- | :--- | :--- |
| 1 | The fingerprint hashes one file; what it loads (node_modules, the Node binary) is not covered | hashing a dependency closure is install-method-specific; the package manifest and version are recorded alongside | per-install-method closure hashing, if a real failure needs it |
| 2 | The registry and event log are append-only frames with digests but no authentication | anyone who can write the root can write records; the threat model is a single local operator | signed records (Cogitator witnesses) |
| 3 | Project configuration (`.pi/` in a session's working directory) is not in evidence | checks run in scratch directories; a project's extensions can change behaviour in sessions there. The digest is recorded on `harness.attached` so it is visible per session | checks in the project directory, with explicit consent |
| 4 | The superseded-process race (#6) is fixed in code but not reproduced in a test | it needs a process that has exited but whose pipe has not drained, which the harness cannot schedule deterministically | a transport-level test seam for delayed drain |
| 5 | The writer lock covers session attachments only | other writers (`endo ingest`) are short, operator-initiated commands; the frame log still refuses to append past damage | a storage-level lock if more long-running writers appear |
| 6 | The live study's `read` tool is Pi's own and is not confined to the scratch workspace | the prompts are Endophasia's and ask only for the fixture file; the study runs only on explicit authorization | an extension or Pi option that confines tools |
| 7 | Environment inheritance: Pi gets the operator's environment by default | that is what running `pi` yourself does; Pi needs its credentials | an explicit environment allowlist option |
| 8 | Evidence validity is computed by this process, from records it trusts | see #2 | — |

## Not found

No path was found by which Endophasia installs, updates, downgrades, patches or rebuilds Pi; spawns through a shell;
imports a Pi package; invents a run, turn or operation identifier; stores message, tool or queued text; or creates a
runtime-admission, promotion or permission record from conformance evidence. The architecture guards in
`tests/endo-pi-boundary.test.ts` keep the first three from returning unnoticed.
