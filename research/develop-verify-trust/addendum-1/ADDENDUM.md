# DEVELOP-VERIFY-TRUST-001, addendum 1: adversarial review and trust-boundary qualification

**Version 1, 2026-11-12.** This addendum reviews the study recorded at `5d508223f`. It does not change the protocol, the
preregistered expectations, the recorded runs or their records. [REPORT.md](../REPORT.md) and its decision stay as the historical
result. Each correction below names the claim it qualifies. Everything here is **exploratory and post hoc**: none of it was
preregistered, and none of it enters R1 to R6.

**Outcome in one paragraph.** The recorded study holds up. The chronology, the evidence, the reproduction and the 21 classifications
check out, and a third full run with the corrected verifier gives the same 21 rows. The review found two material defects in the
research verifier, both fixed here:
- a candidate repository could make "commit X" export a different tree;
- it could also run a command inside the controller.

It also demonstrated three ways a same-user process gets a PASS for wrong code that every reader accepts. Two of them need no
forgery of a record and no change to the verifier. The preregistered READY therefore stands only as a statement of **mechanism
feasibility**. Evidence authenticity is **not established**. Product integration is **not ready** for agents that run as the
operator's user. The recommendation changes from *integrate the controlled tier* to *one more trust-boundary experiment*: a verifier
under a separate principal (§7).

## 1. Audit of the recorded artifact

| Claim | Checked how | Result |
| :-- | :-- | :-- |
| Protocol and frozen oracle precede the trials | `dd18db78d` (07:04:06Z) holds `PROTOCOL.md` with the pin. `git show dd18db78d:…/oracle/manifest.json \| sha256sum` equals the pin. `git diff dd18db78d HEAD -- oracle fixtures` shows only the exploratory C2 being added (in `9c8b6ff79`). | **holds** |
| Runner committed before the recorded runs | `9c8b6ff79` at 07:15:10Z. Run 1's workspace was created at 07:15:19Z and its log closed at 07:17:28Z; run 2's at 07:17:49Z and 07:20:00Z (file times in the raw data). `verify.ts`, `run.sh` and `study.ts` are byte-identical between `9c8b6ff79` and `5d508223f`. | **holds**. The times are local commit dates and file mtimes. Nothing outside this host attests them: the branch was first pushed with this addendum. |
| Run 2 from a fresh clone | `checkout-run-2` (raw data) is a `git clone --no-local` of the research worktree, at `9c8b6ff79`. | **holds** |
| Results derive from committed evidence | `table.ts results/run-1` regenerates `results/cases.json` byte-identically: 0 re-read mismatches, now with the corrected reader. The test suite re-reads every record. | **holds** |
| The two runs agree | `study.ts compare` compares only `id` and `observed`: identical, 21 of 21. Independently, after sorting the ordinary receipts by argv and dropping durations, the full `results.json` files differ only in row 9a's `killedAtMs`. | **holds**, with a precision: REPORT §2's "classification and detail identical" is true up to receipt order and timestamps. The compare tool alone does not check details. |
| Every case exists | 21 rows in both `results.json`. 35 committed record files: 29 sealed run records, 5 damaged 9c variants (one, `9c-truncated`, is deliberately not JSON) and the resealed 9d forgery. 30 journals: 29 beside a record, plus 9a's, which has no record by design. Ablation: 4 files. | **holds** |
| Hygiene | No inherited variable values; records list `environmentNames` only (`DBUS_SESSION_BUS_ADDRESS, HOME, LANG, PATH, XDG_RUNTIME_DIR`). No host-user paths: the only `/home/` strings are the sandbox's `/home/agent`. The largest file is 80 KB. `truth-E.txt` is cut, as disclosed. | **holds** |
| No production code changed | `git diff --name-only origin/main...HEAD` lists only `research/develop-verify-trust/**` and `tests/develop-verify-trust.test.ts`. | **holds** |

**Committed versus raw.**
- **Committed:** both runs' `results.json` and `study.log`; run 1's 35 records, 30 journals, ordinary-path evidence, truth outputs and ablation.
- **Raw only** (`~/projects/endophasia-research/develop-verify-trust-001/raw/`, 9.6 MB, kept):
  - run 2's individual records and journals;
  - both runs' candidate repositories and DEVELOP stores;
  - the uncut `truth-E.txt`.

So run 2's agreement rests on its committed `results.json`, which holds each record's reader class and detail, not on committed copies of its records. Nothing claimed in REPORT.md is missing from the raw data.

## 2. Review findings

Severity is impact on the study's claims, not on a product. The reproducers are in [review.ts](review.ts). Results:
[results/results.json](results/results.json) and [results/review.txt](results/review.txt), with key records in `results/records/`.

`results/review-first-attempt.txt` is the harness's first full attempt, kept for the denominator. It is identical except R4, which
then had only the crude edit (now R4a).

| # | Severity | Finding | Reproducer | Impact on claims | Disposition |
| :-- | :-- | :-- | :-- | :-- | :-- |
| R1 | **High** | **A replace ref substitutes the exported commit.** `exportCommit` read Git without `GIT_NO_REPLACE_OBJECTS`. With `git replace B' A'` in the candidate's repository, the frozen verifier exported A's tree for commit B'. It recorded `candidate.commit = B'` with A's tree id, gave **PASS**, and every reader, even one bound to the commit, read PASS. Each blob id was recomputed, but the tree listing came from the replacement. | `review.ts` R1; `records/R1-frozen-sandbox.json` | Overturns REPORT §6's "the candidate read from the named commit's objects" as a general property, and §5's "0 false passes under the launcher" outside the matrix. The recorded runs are unaffected: none of their repositories had replace refs (checked). | **Fixed (C1)** in `verify.ts`; corrected verifier: FAIL. Test: `exports the commit's own tree when a replace ref names another`. |
| R2 | **High** | **The candidate's repository runs a command in the controller.** A partial clone missing one blob, whose promisor remote names `remote.origin.uploadpack`, made `git cat-file` lazily fetch. The fetch ran the repository's command in the **host PID namespace** as the verifying user, before any sandbox existed. The frozen verifier then went on to a verdict. | R2; `records/R2-frozen-sandbox.json` (marker: `ranInHostPidNamespace: true`) | The candidate's repository is input to the trusted controller, and it could execute code there. The command could edit the staged export (R3) or the record (9d) during an otherwise honest run. Not exercised in the recorded runs: no promisor remote. | **Fixed (C1):** `GIT_NO_LAZY_FETCH=1`, plus `GIT_OPTIONAL_LOCKS=0`, as `adapters/git/readonly-git.ts` does. Corrected verifier: BLOCKED `object-unreadable`, and the command did not run. Test: `never runs a promisor remote's command`. |
| R3 | **High** (unfixed by design) | **A same-user process changes what an honest verifier runs.** The staged export (`<out>.work/candidate`) is mode 0700 and 0444, but owned by the user. A concurrent same-user process replaced `roman.mjs` with A's after the export was checked. Both the frozen and corrected verifiers, unmodified and launched through `run.sh`, recorded commit B, with B's file digests, as **PASS**. | R3; `records/R3-*-sandbox.json` | A record can be genuine (written by the real verifier) and false. Integrity of the verifier's code and signing would not catch this. The verifier's **working state** must be out of the agent's reach, not just its code. | **Documented, not fixed.** A post-run re-digest would catch only a swap that is not reverted. The fix is the principal boundary (§7). |
| R4 | **High** (as predicted by REPORT §6.1) | **Source digests are self-attested.** R4a, an edited verifier that substitutes the expected output in *every* phase, was refused: `qualification-failed`, because the negative passed. R4b substitutes only in the candidate phase. It passes qualification and gives B **PASS**. Its record lists the 22 source digests of the *frozen* verifier, equal to the committed `2-sandbox.json`'s, and every reader reads PASS. | R4a/R4b; `records/R4*-modified-sandbox.json` | Confirms REPORT §6.1 concretely. Qualification catches a crude compromise only. Comparing `controller.sources` with a pin detects accidental drift, never an adversary. Corrects the impression from 4c: the reader caught a *naive* hook, and a targeted one is undetectable (as 9d already showed for records). | **Documented.** No reader check can fix it. |
| R5 | Medium | **Replay.** A genuine PASS for A read PASS when presented as the record for B: the reader had no notion of which commit was asked about. | R5; test `binds a record to the commit it is read for` | Any consumer that looks a record up by name or path, not by content, can be misled without any forgery. | **Fixed for honest consumers (C2):** `readRecord(…, { commit })` and `read --commit`, giving `candidate-mismatch`. A forger can still rewrite the commit and reseal (9d). |
| R6 | Low (evidence precision) | **What 9a observed.** 46 scope names were in the journal: 1 preflight, 44 cases that each recorded `termination: confirmed` (bubblewrap seen inside the scope and the scope's end confirmed by the user manager), and the killed case. For the killed case, the only evidence was `LoadState=not-found` three seconds later. That does not distinguish a scope that ended from one that never existed. | R6, a new live observation: `records/R6-corrected-sandbox.journal` | REPORT §3.6 is accurate but weaker than it reads. R6 adds direct evidence: before the kill, the scope was `loaded/active` with 3 processes (`bwrap`, `bwrap`, `node`). Three seconds after the SIGKILL, none of those pid and start-time identities was alive, the scope's cgroup directory was gone, the scope was `not-found`, and no host process had the candidate's command line. The sandbox's `--die-with-parent` and its PID namespace end everything inside it. This is still not universal cleanup: processes outside that cgroup are not covered. | **Documented**; claim refined. |
| R7 | Medium (interpretation) | **S reports environment incompatibility as FAIL.** Correct programs that write to their working directory (X1: `EROFS`), run `/bin/sh` (X2: `ENOENT`), call `os.userInfo()` (X5: no passwd entry) or write 20 MiB to `os.tmpdir()` (X6: `ENOSPC`, 16 MiB tmpfs) pass on the host and under F, but **FAIL** under S on all 15 cases. Uncommitted `node_modules` fails under F and S alike (X3). 300 committed files are refused, BLOCKED `unsupported-tree-size` (X7). Committed dependencies (X4) and worker threads (X8) pass. | X1-X8 | REPORT §5's "False refusals: none" holds for the matrix, where P passed. But an S FAIL means "did not produce the expected output *in this environment*", not "is incorrect". REPORT's out-of-class list missed `/bin/sh` and other host executables, the passwd database and the tmpfs size, and did not say that these surface as FAIL rather than BLOCKED. | **Documented.** A product tier would need to tell incompatibility from incorrectness, or state it. |
| R8 | Low (hygiene) | Under F, a record's `stderrHead` holds the candidate's own error text, which can include host paths (X3's names the workspace). No committed record of the original study contains one. | X3-filtered (raw data only, not committed) | None on the claims. A product record would need the same care. | **Documented.** That record stays in the raw data. |
| R9 | Info | The pin covers `oracle/manifest.json` only. The reference and negative programs it names are read unpinned from the oracle's directory. Replacing them can only make qualification fail, or let a weaker reference qualify. It cannot change the candidate's verdict. | code reading | None on the recorded results. | **Documented.** |

Checked and **not** found to be defects:
- **Interpreter start-up.** Node 26.13.1 does not load `node.config.json`, or any hook from a nearby `package.json`, without a flag. `run.sh`'s `env -i` start leaves `process.execArgv` empty.
- **Unhashed dependencies.** The verifier's 22 hashed sources are its whole import closure: no bare specifiers, so nothing from `node_modules`.
- **Same-user `ptrace`.** Yama `ptrace_scope` is 1 on this host, so another same-user process cannot attach to the verifier. On a host with 0 it could; that was not tested.

## 3. What the isolation parts enforce, and what they do not

- **Bubblewrap.** It gives the candidate new namespaces for mounts, PIDs, network, IPC, UTS, cgroups and users, with `--clearenv`,
  `--die-with-parent` and `--new-session`. The candidate sees only the runtime closure, `/submission` (read-only), a private `/tmp`
  and `HOME`, its own `/proc` and `/dev`, and no network. It **protects the oracle and the host from the candidate.** That is why
  C2 found nothing under S: its search heuristic did not lose, the oracle simply is not in its namespace (the preflight's
  `oracle-directory` probe).
- **The systemd user scope.** It groups each sandbox's processes so that their end can be confirmed, and bounds their number. It does
  not confine files or the network, and a same-user process can stop or kill it. That gives INCOMPLETE or BLOCKED, never PASS.
- **Neither part protects the controller, its working files, its inputs or its records from anything outside the sandbox.** Every
  same-user false PASS above (R1, R2, R3, R4b, 9d) happens there.

## 4. Row 6, row 6x and the ablation

Independently confirmed from the code and the records:
- **Row 6 under F.** C reads its parent's arguments. Under F, its parent is `runCheckV0`'s keeper, `node -e KEEPER`, whose arguments
  hold no `.json` path. Its upward search from the case directory meets no `oracle/manifest.json`: the oracle is at
  `<workspace>/verifier/oracle/`, not on that path. F's FAIL for C is therefore topology. It is not evidence of a boundary, and REPORT
  says so.
- **Row 6x under F.** C2 walks up to 16 ancestors, so it reaches the verifier's command line (same user, host `/proc`), finds
  `--oracle …/manifest.json` and reads it. The ablation renamed the file to `manifest.oracle`, and C2 failed. F's outcome was decided
  by whether the candidate's heuristic matched the oracle's name.
- **Under S.** The same search has no verifier ancestor to read, and no oracle path exists inside the namespace. The separation follows
  from the isolation, not from a heuristic.

Row 6 remains a failed preregistered prediction, and 6x remains exploratory. Neither is promoted here.

## 5. Confirmation run with the corrected verifier

The full study was run a third time from `50bb49a63`, which carries the corrections, into a new workspace:
`raw/run-3-corrected`, with its sanitised `results.json` and log in `results/run-3-corrected/`.
- **Classifications.** `study.ts compare` against run 1 reports `{"identical":true,"rows":21}`.
- **Acceptance.** The same as before: R1, R2, R3 and R5 hold, R6 does not, R6x holds.
- **Detail.** After the same normalisation as §1, the full results differ from run 1 only in `repositoryHead` and row 9a's
  `killedAtMs`.
- **Wall time.** 131 s.

So C1 and C2 change no recorded outcome. This is a confirmation of the correction, not a third preregistered run.

## 6. Signatures, and the dedicated binary

**What a signature would address.** A record changed after the verifier wrote it, or made without the verifier, by a party that
cannot use the key (9d, and R5 if the commit is in the signed payload).
- **Who controls the key decides everything.** A key the user's account can read is a key the agent can use: 9d is unchanged.
- **When it means something.** Only a key held by a principal the agent cannot act as: another user's service, hardware bound to that
  service, or a remote one.
- **What it leaves unresolved, even then:**
  - a modified verifier that signs its false result (R4b);
  - an honest verifier that signs false content (R3);
  - substituted inputs (R1, R2 before C1);
  - the oracle's correctness;
  - who asked for the check;
  - replay without binding.

Signing is downstream of the principal boundary, and adding it under a same-user verifier would make records look stronger than
they are. None was added.

**Would Endophasia's future standalone binary materially simplify or strengthen controlled verification?** It would simplify it;
on its own, it would not strengthen it.

| | 1. Today: `/usr/bin/node` + `verify.ts` + 21 modules | 2. Packaged native executable | 3. Verifier under a separate principal |
| :-- | :-- | :-- | :-- |
| Executable identity | root-owned `node` pinned by digest; the 22 sources come from an agent-writable checkout and are self-reported | one file to pin; identity is only as strong as who can write it | root-owned code run by a dedicated uid; the agent can neither write nor `ptrace` it |
| Runtime dependencies | the module closure; type stripping | none beyond libc (static) or the embedded runtime | as 1 or 2, but root-owned |
| Inherited environment | `run.sh` builds it; an agent can edit `run.sh` | a Go or Rust binary ignores `NODE_OPTIONS`; a Node single-executable still embeds Node's runtime, whose option handling would need checking | started by the service manager with a fixed environment; the caller's never reaches it |
| Dynamic libraries | `LD_*` cleared by `env -i`; the `ldd` closure root-owned | a static binary ignores `LD_PRELOAD` | as 2 |
| Writable paths (code, staging, records) | all same-user (R3, R4b, 9d) | **unchanged** if it runs as the user | service-owned state directory; the user can read records, not write them |
| Candidate repository as input (R1, R2) | needs C1 | **unchanged**: shelling out to `git`, or using a Git library, has its own replace and promisor semantics to switch off | **unchanged**: it still reads untrusted Git; better to receive a bundle and verify object ids |
| Updates | `git pull` of the checkout | a user-level self-updater is an agent-writable trust root; a package-manager install is not | through the system's package manager |
| Records | user files, unsigned | **unchanged** | written by the service; signing becomes meaningful, with the key readable only by its uid |
| Requester identity | none | none | `SO_PEERCRED` gives the uid, and agent and operator share it: still not authentication |
| Cost | none | build and release work | a privileged, one-time install (a uid and a system unit); host-specific |

**Packaging simplicity versus security.**
- **What a binary buys:** one artifact to pin, no module closure and no interpreter option surface.
- **Where integrity comes from:** who can write the file, not whether it is native. A root-owned install of the existing TypeScript
  under `/usr/lib` with the root-owned `node` would give the same code integrity as a root-owned binary.
- **What only option 3 changes:** the boundary the review found missing, which is working state, records and the
  candidate-repository inputs as well as code.
- **No Rust rewrite.** Nothing here shows TypeScript failing a specific requirement. Every gap found is about principals and file
  ownership, not the language.

## 7. Reassessment: three separate claims

| Claim | Verdict | Basis |
| :-- | :-- | :-- |
| **A. Mechanism feasibility:** can a protected evaluator check this narrow Node program class under the stated isolation assumptions? | **Supported, qualified** | R1-R5 held in the recorded runs and again in the corrected run (§5). The candidate never reached the oracle (preflight; 6x under S). Qualification refused a crude verifier compromise (R4a). Qualified by C1, which a production version needs, and by R7's compatibility limits: an S FAIL can mean "incompatible", not "incorrect". |
| **B. Evidence authenticity:** can Endophasia establish that a recorded outcome came from the claimed trusted verifier rather than an attacker with equivalent host permissions? | **Not established** | With the same permissions, a PASS for wrong code that every reader accepts was produced four ways: 9d (forged record), R4b (edited verifier reporting the frozen digests), R3 (honest verifier, concurrent tampering with its working files) and, before C1, R1 (repository metadata). C2 helps honest consumers only. |
| **C. Product integration readiness:** can it be introduced into DEVELOP without misleading users about what it verifies? | **Not ready**, for agents that run as the operator's user | FOLLOW-UP.md's own condition was that the verifier be out of the agent's reach. R3 widens it to the verifier's working state and records. Nothing in the reviewed code puts a DEVELOP agent under another user or in the protected sandbox. A "controlled" tier on such a host would read as independent while being forgeable by the party it checks. |

**The preregistered decision**, READY FOR A BOUNDED INTEGRATION, is retained as the historical result of the preregistered rule. It
still follows from that rule: R1 to R5 hold. The reviewed evidence **qualifies** it. READY is supported as claim A only. The REPORT's
recommendation to integrate option C is **withdrawn** in favour of further research. FOLLOW-UP.md's slice stays as a design note for
after that research, not as a next step.

**Recommendation: one more trust-boundary experiment (DEVELOP-VERIFY-TRUST-002), not integration.** Its question would be whether a
verifier under a separate principal can close R3, R4b and 9d on this host at acceptable cost. That verifier:
- runs as a dedicated uid with root-owned code;
- keeps a service-owned state directory for staging and records;
- receives the candidate as a Git bundle or reads it under C1;
- binds every record to its commit (C2).

Its matrix would be this study's rows plus R1-R5 run as attacks from the operator's uid. It needs a privileged one-time install,
which needs separate authorisation. That experiment was **not** started.

**Independently of it**, and without any claim of independence, two small changes would make F1's accidental form visible on the
ordinary path. They are REPORT §9's follow-ups:
- a receipt limitation for hostile variables (`NODE_OPTIONS` and the like);
- a receipt limitation for an executable outside root-owned system directories.

## 8. Corrections, versioned

| Version | Where | Correction |
| :-- | :-- | :-- |
| A1.1 | REPORT §6 "Establishes", second item | The candidate is read from the commit's objects **only when Git ignores replace refs and fetches nothing** (C1). The frozen verifier did not ensure this; the recorded runs met it by construction. |
| A1.2 | REPORT §5, "False passes … 0 under the launcher" | True for the 21-row matrix. Outside it, under the launcher: R1 with the frozen verifier, and R3 with either verifier. |
| A1.3 | REPORT §5, "False refusals" and the out-of-class list | Add host executables such as `/bin/sh`, the passwd database (`os.userInfo`), more than 16 MiB of temporary files and more than 256 committed files. The first four surface as **FAIL**, not BLOCKED (R7). |
| A1.4 | REPORT §3.6 and §6.5 | For the killed case, the user manager's `not-found` alone does not show that the scope ran or ended. R6 observed both directly in a new run (R6). |
| A1.5 | REPORT §3.9, 4c | The reader caught a naive in-process hook. A targeted change to the verifier is not caught, and reports the original source digests (R4b). |
| A1.6 | REPORT §6.1 | Out of the agent's reach must include the verifier's **working state and records**, not only its code (R3). |
| A1.7 | REPORT §5, recommendation; decision paragraph | Integration of option C is withdrawn; READY is read as claim A (mechanism feasibility) only (§7). |
| A1.8 | REPORT §2 | "Identical in both … classification and detail": identical up to receipt order and timestamps; `compare` checks classifications only (§1). |
