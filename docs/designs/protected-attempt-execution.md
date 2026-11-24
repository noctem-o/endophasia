# DEVELOP-PROTECTED-ATTEMPT-001: terminal-authorised protected attempt execution and the attempt-to-candidate binding

*   **Status:** implemented on `feat/develop-protected-attempt-001` (draft PR). Experimental and non-authoritative. Workstation H0 remains **BLOCKED**.
*   **Builds on:** the evidence bridge and its proposal for this record ([develop-evidence-bridge.md](develop-evidence-bridge.md) §1), attempt execution ([develop-attempt-execution.md](develop-attempt-execution.md)), the protected staged change set ([protected-staged-changeset.md](protected-staged-changeset.md)) and the protected runner (`cli/experiment-protected.ts`).
*   **Scope:** one launcher command (`endo attempt protected-run`), two write-once records (a launch record and the candidate binding), and the bridge's reading of them (`endo.develop-evidence-bridge.v1`). No new store, coordinator, harness, listener or authority mechanism; no task status change; no candidate application; no unprotected fallback.

## 1. What this adds

The bridge found one missing relation: nothing linked a DEVELOP attempt (`endo.attempt.<32 hex>`) to the protected-experiment trial that ran it and the candidate that trial produced. This PR adds the smallest launcher that can establish that relation because it *made* the run, and a reader that re-verifies it every time it is read.

```mermaid
sequenceDiagram
  participant O as Operator (controlling terminal)
  participant L as endo attempt protected-run
  participant S as <root>/develop/protected-attempts
  participant R as protected runner (bwrap + systemd scope)
  O->>L: --attempt --template --out
  L->>L: plan (read-only): dispatch checks, template checks, build operation, digest
  L-->>O: the whole operation + "APPROVE PROTECTED ATTEMPT <16 hex>"
  O->>L: types the phrase (or anything else: declined, nothing written)
  L->>L: plan again; digest must be identical
  L->>S: <id>.launch.json (write-once; a second launcher stops here)
  L->>R: build /agent (template + prompt.txt = brief), write spec.json, run once
  R-->>L: run directory (sealed trial record, baseline/, changeset/)
  L->>L: read back independently (the bridge's own reading); every check must pass
  L->>S: <id>.candidate.json (write-once, boundBy=controller) only if all pass
```

## 2. The bounded configuration (the only one)

*   The attempt is **prepared**, passes the same checks a workbench send makes (`DevelopAttemptDispatchV0.check`: task open, words unchanged, brief recomputes), has **no workbench authorisation** and **no protected launch** yet.
*   The operator supplies a **template spec**: `endo.protected-experiment-spec.v2` (offline), with **exactly one task in `staged-changeset` mode, one condition, `trials: 1`**. Anything else is `template-unsupported`, including a model-connected `.v3` template: the operation and record vocabulary can describe v3 (model access is part of the operation digest), but the launcher refuses it until a model-connected launch has been exercised.
*   The launcher constructs the spec from the template: run id `endo.experiment.attempt-<32 hex>` (the attempt's own), and the condition's agent directory replaced by `<out>/agent`: a bounded copy of the template's agent directory (no links, no special files; entries, bytes and depth bounded) whose `prompt.txt` is the attempt's frozen brief, byte for byte. The agent reads `/agent/prompt.txt`.
*   `--out` must not exist, its parent must, and the path must be one the protected runner admits. The launcher writes `<out>/agent/`, `<out>/spec.json` and `<out>/run/`; nothing else outside the two records.

## 3. Authority semantics

*   **The operation** (`endo.develop-protected-attempt-operation.v0`) holds every identity the run depends on: attempt, project, task and revision, brief digest and size, run directory, run id, spec version and spec digest, trial coordinates, agent directory with its template-tree, built-tree and prompt digests, evaluator definition digest, and model access (v3 only). Its digest is sha256 of its canonical JSON.
*   **Approval** is the phrase `APPROVE PROTECTED ATTEMPT <first 16 hex of the operation digest>`, typed as one line on the process's **controlling terminal** (stdin and stderr must both be the TTY; `requireWorkbenchTerminalV0`). No flag, environment variable, pipe, file, default, browser, Coordinator or agent message can supply it. `endoProtectedAttemptAuthorityV0` allows only an exact match; every other input (empty, the workbench's phrase, another operation's phrase, the bare digest, the phrase with extra words) is `declined` and nothing is written.
*   **Time-of-check/time-of-use:** after approval the plan is rebuilt; if its digest differs (template, agent directory, task words, attempt state changed while the operator read) the launch is refused with `changed-during-approval` and nothing is written. The built agent tree is re-hashed against the approved digest before the run.
*   **Once (and one route only):** before writing either `<id>.launch.json` (protected route) or `<id>.authorized.json` (ordinary workbench route), both routes atomically claim a shared write-once reservation `<root>/develop/attempt-routes/<id>.route.json` (`endo.develop-attempt-route.v0`) via an exclusive hard link (`storage/write-once.ts`). Of any sequential or concurrent workbench and protected-attempt dispatchers racing on the same attempt, POSIX `link(2)` admits at most one winner; every other dispatcher stops before writing its route record or executing anything. The launch record `<id>.launch.json` is also write-once (`already-launched`), the run is never retried, and there is no other way of running it. A crash after claiming `.route.json` and before writing `.launch.json`/`.authorized.json` safely leaves the attempt consumed rather than double-executable.
*   **What approval grants:** one run of exactly that operation through the protected runner. It grants nothing else: no task status change, no candidate application, no merge, no acceptance. The approval is not reused by any other command.

## 4. Records

Both live in `<root>/develop/protected-attempts/`, 0600 files in a 0700 directory, created by an exclusive hard link from a temporary file (never replaced), bounded reads (64 KiB), validators with closed key sets.

*   `<id>.launch.json` (`endo.develop-protected-attempt-launch.v0`): the operation, its digest, `approvedBy: "operator"`, `via: "controlling-terminal-phrase"`, time.
*   `<id>.candidate.json` (`endo.develop-attempt-candidate-binding.v0`): attempt, project, task, brief digest, `boundBy`, `via`, a fixed `standing` table, the authorisation (operation digest and launch-record digest), the target (run directory, run id and version, spec digest, trial coordinates, sealed record digest, agent tree and prompt digests, and the candidate: baseline, change set and candidate digests), `integrity: "unkeyed-sha256-integrity-evidence-not-signature"`, and `bindingSha256` (a seal that detects accidents, not forgery).
*   **`boundBy: "controller"`** is written only by the launcher, only after: the run's trial record is sealed and verified; preflight is established; the agent's systemd scope is **confirmed ended**; the retained `/agent` copy re-hashes to the approved tree and its `prompt.txt` to the brief; the candidate re-verifies from its baseline and change-set bytes; and every identity matches the launch record.
*   **`boundBy: "operator"`** is a valid form with strictly weaker standing (`operator-declared`, no authorisation, no agent facts). The validator accepts only the exact standing table for each `boundBy`, so an operator binding can never present itself as controller-established. **No command writes it** in this PR.

## 5. Reading: one closed set of association states

`readProtectedAttemptV0` (used by `endo attempt bridge`) writes nothing, creates nothing and runs nothing. It re-reads the prepared attempt (recomputing the brief), the launch record (recomputing the operation digest), the binding (checking its seal), the run directory (`inspectProtectedRunForBridgeV0`: sealed record, termination, baseline and change-set bytes) and the retained agent copy, and reports 15 named checks and exactly one state:

| State | When | Bridge |
| :--- | :--- | :--- |
| `not-supplied` | no launch, no binding, no run given | unchanged from before |
| `unestablished` | no launch, no binding, a run given with `--protected-run` | unchanged: `missingRecord: develop-attempt-protected-candidate-binding` |
| `established` | a controller binding, every check passes now | transition `established; controller-observed` |
| `operator-declared` | an operator binding whose digests re-verify | transition `partial; operator-declared`, never upgraded |
| `invalid` | a launch or binding that is unreadable, mis-sealed, misnamed, a link, oversized, or contradicts anything re-read; or the attempt was also sent through the workbench | `blocked-contradictory-or-tampered` |
| `incomplete-execution` | a launch record without a binding (runner refused, interrupted, crashed, termination unconfirmed, never sealed) | `incomplete-evidence`; never a result |
| `candidate-integrity-failure` | the run's candidate bytes do not verify against the sealed record | `blocked-contradictory-or-tampered` |

A binding is never admitted on timestamps, filenames, similarity, text or agent statements: only on digest equality with what is re-read now. An established association whose evaluation failed reads `do-not-accept-verification-failed`; a passed one is never `ready-for-operator-review` on its own and never an authoritative PASS.

## 6. Threat model

*   **Same-uid writer.** Every record is an unsigned local file. A process running as the operator can rewrite any record and recompute any unkeyed seal. What it cannot do undetected is make a binding that disagrees with the files it points at: the reader recomputes the brief, the operation, the spec digest, the sealed trial record, the agent copy and the candidate bytes. Tests forge resealed bindings (wrong attempt, brief, operation, spec, candidate digest; operator-as-controller) and substitute runs and records; each reads `invalid` or `candidate-integrity-failure`. A writer that rewrites *all* of them consistently (a fully fabricated run) is not detectable by digests; that is the stated limit, and why this is integrity evidence, not proof of origin.
*   **The agent.** Runs inside the existing protected runner: bubblewrap, no network (v2), read-only root, private `/tmp` and PID namespace, systemd user scope with confirmed termination, the evaluator and hidden material invisible. This PR changes none of that and adds no fallback: if the runner refuses, the launch is `incomplete-execution`.
*   **Filesystem tricks.** Links in the records directory, in the record path, in the agent template or in the retained agent copy are refused, not followed. Reads are bounded (record bytes, template bytes, agent entries, bytes and depth, prompt bytes). Temporary files left by a crash are never taken for records.
*   **Authority confusion.** The approval phrase differs from the workbench's (`APPROVE ATTEMPT …`), both routes enforce mutual exclusion atomically via `<root>/develop/attempt-routes/<id>.route.json` (and preflight checks on both `develop/attempts/` and `develop/protected-attempts/`), and if a same-uid writer manually plants both records, the bridge reads the binding `invalid` (`single-execution-route`).

## 7. Operator usage

```text
$ endo attempt prepare --root ~/endo --project <p> --task <t> --objective-file objective.md
$ endo attempt protected-run --root ~/endo --attempt endo.attempt.<id> --template template.json --out ~/runs/<new dir>
  (the whole operation is printed with its digest)
Type APPROVE PROTECTED ATTEMPT cb9ee79a05dd282e to run exactly this once; anything else declines:
> APPROVE PROTECTED ATTEMPT cb9ee79a05dd282e
  (stdout: {"protectedAttempt": {...}}; exit 0 only when status is "bound")
$ endo attempt bridge --root ~/endo --attempt endo.attempt.<id>
```

Statuses: `refused` (nothing written), `declined` (nothing written), `launch-not-recorded`, `run-failed` / `not-bound` (launch record written, no binding: the attempt is used), `bound`.

## 8. Deviations from the bridge proposal (and why)

1.  **Directory.** Records live in `develop/protected-attempts/`, not beside `<id>.prepared.json` in `develop/attempts/`: that store's closed reader treats any unknown file as a problem, which would block workbench sends and break existing readers for every attempt in the store.
2.  **A launch record.** The proposal had one record. A second, written after approval and before the run, is what makes "launched once" exclusive and lets a reader tell an interrupted launch (`incomplete-execution`) from no launch at all.
3.  **The brief reaches the agent as a file** (`/agent/prompt.txt`) so it can be re-hashed from the run's own agent copy, rather than trusted from the spec.
4.  **The agent-tree digest is file evidence, not a sealed fact.** The v2/v3 trial record's mounts carry a digest only for read-only files; the `/agent` tree is committed only inside the profile digest. The reader compares the launch record's pre-run tree digest with the run's retained copy (`<run>/.agents/<condition>`) re-hashed, which the runner itself checked against the same digest before mounting it. It does not recompute the profile digest.
5.  **Authority restated, not reused.** The rule is `localOperatorAuthorityV0`'s (exact phrase on the controlling terminal, everything else denied), restated for a launch operation because the intervention proposal type is bound to a Pi session and its operations (steer/queue/stop) and cannot carry a protected launch.
6.  **Bridge schema `v0 → v1`.** The protected section gains a `binding` object and `agentTreeSha256`, and `attemptAssociation` widens from two states to seven. Legacy attempts read as before apart from the version string.
7.  **Operator acceptance is not bound to the candidate.** Binding a task's `done` to a candidate digest would be a second authority mechanism (who may accept, against what). Documented in the bridge's `Verification -> Operator Decision` row and left unimplemented.

## 9. Limitations

*   Integrity evidence over unsigned same-uid files; not a signature, proof of origin, or host authority. Workstation H0 stays BLOCKED.
*   Cross-route exclusivity (`develop/attempt-routes/<id>.route.json`) prevents accidental sequential and concurrent dual dispatch across workbench and protected routes under cooperative Endophasia processes; a same-uid process with direct filesystem access can still remove or rewrite unsigned local files, and a crash between claiming `.route.json` and writing `.launch.json`/`.authorized.json` burns the attempt without executing either route.
*   One task, one condition, one trial, staged change set, offline v2 only. A model-connected (v3) launch is refused.
*   No operator-binding writer, no Studio exposure, no acceptance binding.

## 10. Verification

*   `tests/develop-protected-attempt.test.ts`: the deterministic suite runs the launcher with a fake runner that writes a correctly sealed staged run, covering a correct binding, wrong attempt id, changed brief and brief digest, wrong/absent authorisation, wrong spec pin, substituted run and trial record, modified baseline and change-set bytes, candidate digest mismatch, interrupted and refused runs, unconfirmed termination, duplicate launch, a crash before the binding is linked, six concurrent launcher processes, authority escalation, a planted link, legacy attempts, and the CLI bridge writing nothing (recursive manifests) and spawning nothing.
*   One test runs the **real** protected runner (bubblewrap, systemd user scope, offline v2, a deterministic node agent that reads `/agent/prompt.txt`). It is skipped, with the reason on stderr, where the host cannot isolate. Deterministic tests are not kernel-isolation evidence.
