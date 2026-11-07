# WORK-CYCLE-001A: one real DEVELOP work cycle, independently inspectable

**Question.** Can an independent reader reconstruct a real agent-assisted coding task from preparation through execution, artifact
inspection, verification and the operator's decision, from the stored evidence and without trusting the agent's final answer?

**Answer, as far as this study goes.** Yes, for one small task on one machine, with two named limits. Endophasia's existing commands
already carry the whole cycle. Each step leaves its own record, and a new process with no agent running can read every record back.

The two limits are:

1. **The link from the attempt to the commit is the operator's say-so.** No record establishes which bytes Pi wrote. Each receipt
   says so in its limitations.
2. **The operator's decision was not readable from the terminal.** It had a record, but only the workbench page showed it. This was
   the one gap the journey found, and it is fixed here: `endo task show` now prints the task's acceptance criteria and its status
   history.

The real-model runs used **Pi 1.5.0** and **Muse-Glimmer-30B-Abliterated-Q4_K_M**. In each, the terminal approval was typed by a test
script (a *test substitute*, labelled as such everywhere). **The operator-governed run, with a person typing the approval, is NOT
TESTED.** The procedure for it is below.

## 1. Capability inventory (audited on `main` at `e99f68ebd`)

| | Capability | Where |
| :-- | :-- | :-- |
| **Already supported** | Projects, tasks, revisions, operator-only status moves (`done` only from `review`) | `endo project`, `endo task`, `storage/develop-tasks.ts` |
| | One frozen, write-once attempt and its brief | `endo attempt prepare/brief`, `docs/designs/develop-work-attempts.md` |
| | Send one attempt to the Pi child the attachment launched and owns, after `APPROVE ATTEMPT <hex>` is typed on its controlling terminal; the write-once authorisation record is written before the recorded dispatch | `attempt <id>` on the workbench terminal, or the page's request, which the terminal still approves (Slices I and J) |
| | A reading of the send and the run, joined by exact ids, from any later process | `endo attempt show`, `runtime/contracts/develop-attempt-execution.ts` |
| | A check run by Endophasia at a clean commit, recorded as a receipt with its limitations, and related to HEAD on every read (stale when HEAD moves) | `endo attempt check/receipts/receipt` |
| | Readers that run no agent | `endo attempt show`, `endo workspace open`, `endo events`, `endo harness overview` |
| | Tool activity in canonical events (name, error flag, keyed digests; no arguments or results) | `adapters/pi/mapping.ts` |
| | A pass-through recording proxy for model requests | `endo proxy record` |
| | Fake Pi, a fake OpenAI-compatible endpoint, a PTY operator test, and an opt-in real-Pi test | `tests/fixtures/`, `tests/endo-workbench-attempts-cli.test.ts` |
| **Partially supported** | Real Pi 1.5.0: before this study, only a tool-free greeting brief against a fake endpoint had been run | `docs/designs/develop-attempt-execution.md` §7 |
| | The candidate artifact: shown live in the workbench's Changes view and in Git, never recorded | by design |
| | The operator's decision: in `tasks.json` and on the page, but **not printed by any terminal reader** | **fixed here** (`endo task show`) |
| | Pi's configuration: digested (agent directory, `PI_*` variables), but `PONYTAIL_*` variables are not part of the digest, and an extension's effective mode is not recorded | `adapters/pi/configuration.ts` |
| **Genuinely missing** | A repeatable driver and feature map for one whole cycle, and a report rebuilt from the stored evidence | **added here** |
| | An observation of the Ponytail mode the child actually used | **added here** (in the driver, not in the store) |
| | A record linking an attempt to the commit its work produced | not added: the receipt contract keeps that operator-declared |

## 2. Feature map: Launch → Doctor → Drive → Evidence → Cleanup

Every step is a public `endo` command or plain Git, run in a new process. `research/work-cycle/driver.ts` composes them.

The driver also reads two things directly, for the study only, and reports neither verbatim:

- the recording proxy's captured request bodies, from which it reports only a Ponytail classification;
- Pi's session files, from which it reports only a count of `ponytail-mode` entries.

| Phase | What happens | Command(s) | What it leaves |
| :-- | :-- | :-- | :-- |
| Launch | A new run directory: a store, the [fixture](fixture/) copied into a new Git repository and committed, a digest key for this run only, and (for real Pi) a scratch `HOME` and Pi agent directory. A non-empty directory is refused. | `launchRun()` | `run/` |
| Doctor | Node and `script(1)`; the Pi executable, its real path and version (checked against `--expect-pi-version` when given); the endpoint's `/v1/models` and whether the model is loaded; the Ponytail package; the declared `PONYTAIL_DEFAULT_MODE`. A `fail` stops the run before anything starts. | `doctor()`, `driver.ts doctor [--expect-pi-version x.y.z]` | `evidence/doctor.json` |
| Drive 1 | Register the project, write the task with its acceptance criteria, and prepare the attempt. Run the **baseline check** at the fixture commit: it **fails**, and that is recorded. | `endo project add`, `task add`, `attempt prepare`, `attempt check -- node --test` | `tasks.json`, the attempt, receipt 1 (failed) |
| Drive 2 | The live workbench starts its own Pi child. The operator types `attempt <id>`, reads the whole brief, and types the `APPROVE ATTEMPT` phrase. Pi works with its own tools. Ctrl-C ends the workbench. | `endo harness attach <store> --pi … --cwd <project> --control --workbench --project <id>` | the authorisation record, events, Pi's session file, the capture log (real model) |
| Evidence | The candidate is shown: `git status`, plus the diff from the fixture commit with new files included (intent-to-add). A commit made during the run is warned about. A check of the dirty tree is refused (exit 2) and nothing runs. Only on the operator's `yes` does the driver commit exactly what was shown, then run the check. The run is reconstructed in new processes, with no agent alive. | `git diff`, `endo attempt check`, `reconstruct()` (`task show`, `attempt show`, `attempt receipts/receipt`, `events`, `git log/diff`) | receipt 2, `evidence/reconstruction-<time>.{json,md}`; each read adds one, none is overwritten |
| Decision | The operator's own status moves, each against the revision it saw. | `endo task status --to in-progress / review / done --note …` | history entries |
| Cleanup | Processes whose command line or working directory names the run are looked for and reported. The run directory is kept. | `processesOfRun()` | `evidence/cleanup.json` |

The reconstruction keeps three answers apart, and says where each came from:

- **Pi:** the send and the run, as Pi reported them. Not verification, and not acceptance.
- **Check:** the newest receipt at the current HEAD, as `endo attempt check` observed it. Not acceptance.
- **Operator:** the task's status and the history entry that moved it.

It also lists what it cannot establish: which bytes Pi wrote, the served model's weights, and an uncommitted tree.

## 3. Procedures

### Operator-governed run (NOT TESTED in this PR: it needs a person at the terminal)

```sh
# Load the model in the router first if `doctor` says it is not loaded (the router runs with --no-models-autoload):
curl -X POST http://127.0.0.1:8081/models/load -H 'content-type: application/json' -d '{"model":"Muse-Glimmer-30B-Abliterated-Q4_K_M"}'
node research/work-cycle/driver.ts doctor --pi "$(command -v pi)" --expect-pi-version 1.5.0 --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M
PONYTAIL_DEFAULT_MODE=off node research/work-cycle/driver.ts run \
  --pi "$(command -v pi)" --expect-pi-version 1.5.0 --endpoint http://127.0.0.1:8081/v1 --model Muse-Glimmer-30B-Abliterated-Q4_K_M
#   on that terminal: attempt <id>  → read the brief → type the APPROVE ATTEMPT phrase (or anything else to decline) → Ctrl-C when the run ends
#   the driver shows the status and the diff (new files included) and asks whether to commit exactly that; then it checks and reconstructs
#   the status moves are yours; the driver prints the commands; afterwards: node research/work-cycle/driver.ts reconstruct --run <dir>
```

Runs go to `~/projects/endophasia-research/work-cycle-001a/<timestamp>/` by default, outside the repository. The driver starts
`endo harness attach` with the terminal inherited and never writes to it. Its only question is whether to commit. The
recording proxy is stopped whatever happens, including a failure or a Ctrl-C before the workbench starts.

### Automated tiers (`tests/work-cycle-001a.test.ts`)

| Tier | Runs when | Pi / model | Approval |
| :-- | :-- | :-- | :-- |
| no terminal | always | none | none. The Ponytail classifier, `doctor`'s version check, `task show` |
| 1 | always on Linux with `script(1)` (CI) | fake Pi, which runs no tools, so **the test makes the candidate edit itself** | test substitute, in a real PTY |
| 2 | `ENDO_PI_EXECUTABLE` | the installed Pi with **its own tools**, against the fake endpoint, scripted to `read`, then send a malformed `edit`, then a valid `edit` | test substitute |
| 3 | also `ENDO_WORK_CYCLE_ENDPOINT` and `ENDO_WORK_CYCLE_MODEL` | the installed Pi and a real local model, through `endo proxy record` | test substitute. The model's success is recorded, not asserted |

```sh
npx vitest --run tests/work-cycle-001a.test.ts                                     # no-terminal + tier 1
ENDO_PI_EXECUTABLE=$(command -v pi) npx vitest --run tests/work-cycle-001a.test.ts # + tier 2
ENDO_PI_EXECUTABLE=$(command -v pi) ENDO_WORK_CYCLE_ENDPOINT=http://127.0.0.1:8081/v1 \
  ENDO_WORK_CYCLE_MODEL=Muse-Glimmer-30B-Abliterated-Q4_K_M ENDO_WORK_CYCLE_EVIDENCE_DIR=<dir outside the repo> \
  npx vitest --run tests/work-cycle-001a.test.ts -t "tier 3"
```

No tier touches the user's store, key, Pi configuration or projects. Every run has its own temporary root, its own
`ENDO_DIGEST_KEY_FILE`, and a scratch `HOME` and `PI_CODING_AGENT_DIR`.

## 4. The configuration that was actually used (2026-11-07, one machine)

| | Observed | How |
| :-- | :-- | :-- |
| Host | Arch Linux, RTX 4090 24 GB | |
| Pi | **1.5.0**, `/usr/bin/pi` → `/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | `pi --version`, `realpath` |
| Model server | llama.cpp router, build `b11429-d812350493`, `models_autoload: false`, at `127.0.0.1:8081` | `GET /props` |
| Model | `Muse-Glimmer-30B-Abliterated-Q4_K_M`, from `/home/noctem/models/glimmer/Muse-Glimmer-30B-Abliterated-Q4_K_M.gguf`; ctx 65536, temperature 1.0, top-k 64, top-p 0.95, `--jinja`. Found **unloaded**; loaded for this study with `POST /models/load`, and unloaded afterwards | `GET /v1/models` (the id is the router's alias; the weights were not hashed) |
| Pi agent directory | **Scratch, not the user's.** `models.json`: one `openai-completions` provider pointing at the recording proxy. `settings.json`: that provider and model, and `packages: [<absolute path of the installed Ponytail>]`. Nothing else: the user's other packages (pi-subagents, pi-web-access, pi-mcp-adapter) and extensions were not loaded | `writePiAgentDir()` |
| Ponytail | `@dietrichgebert/ponytail` **5.3.3**, the only copy on the machine (`~/.pi/agent/npm/node_modules/…`), loaded by path. No `~/.config/ponytail/config.json` exists, so without the variable its default would be `full` | `find /`, its `hooks/ponytail-config.js` |
| Ponytail mode declared | `PONYTAIL_DEFAULT_MODE=off` in the Pi child's environment. The attachment passes a copy of its own environment to the session child (`adapters/pi/attachment.ts`, `piSessionEnvironmentV0`); only the fingerprint uses a reduced environment | source |
| Ponytail mode **observed** | **off**, in every model request of every real-Pi run (§5) | its own instruction text (lite, full, ultra, review) searched for in each request's system text |
| Global Pi and Ponytail settings | unchanged; `/ponytail` was never sent | |

**Why a scratch agent directory.** The user's `~/.pi/agent` loads five packages and several extensions. Some of them reach other
programs or the network. A cycle run there would not be reproducible, and its evidence would cover a configuration nobody declared.
Loading only the installed Ponytail, by its path, keeps the one extension this study is about and leaves the user's files alone.

**A cycle run in the user's full configuration is NOT TESTED.**

## 5. Results

### Tier 2: Pi 1.5.0 with its own tools, against the scripted fake endpoint

The cycle completed. Pi read and edited the fixture, and the check passed at the operator's commit. Pi 1.5.0's tool-argument
validation was observed directly, from the tool results Pi sent back to the model:

| Scripted call | Pi 1.5.0 answered |
| :-- | :-- |
| `read {path, limit: "20"}` (a numeric string) | coerced; the file was read |
| `edit {edits: [...]}` without `path` | refused before running: `Validation failed for tool "edit":` / `- path: missing`. That is pi-schema's message format (TypeBox's, before 1.5.0, read `must have required properties path`). The event log records it as a tool execution with `isError: true` |
| `edit {path, edits: {oldText, newText}}` (one object, not an array) | wrapped into an array and applied: `Successfully replaced 1 block(s)` |

These are what tier 2 asserts, so a later Pi that behaves differently fails it by name.

**Ponytail.** With `PONYTAIL_DEFAULT_MODE=off`, Ponytail's skills were listed in the system text, and none of its lite, full, ultra or
review instruction blocks appeared in any of the 4 requests: **off**, matching the declaration. Strictly, "off" means "loaded (mentioned)
and injecting none of its four instruction blocks". The real-model runs were classified the same way; the positive control below is
what shows the classifier can see a block when one is there.

**Positive control.** The same Pi, the same agent directory and package, and one print-mode prompt with the mode set to `full`. The
`full` block was found in all 4 requests. So "absent" really is absence, not a detector that cannot see.

### Tier 3: Pi 1.5.0 and Glimmer (test-substitute approval)

Two runs. Run 2's whole run directory was kept with its evidence.

| | Run 1 | Run 2 |
| :-- | :-- | :-- |
| Send / run | `runtime-accepted` / `completed` | `runtime-accepted` / `completed` |
| Model requests (through the recording proxy) | 13 | 13 |
| Tool calls in the attempt's window (name × count, errors) | bash × 7, read × 4, edit × 1; no errors | bash × 7 (1 returned an error), read × 4, write × 1 |
| Run time | 87 s | 82 s |
| Candidate | `src/slug.mjs` only; `test/` unchanged | `src/slug.mjs` only; `test/` unchanged |
| Dirty-tree check | refused (exit 2), nothing ran | refused (exit 2), nothing ran |
| Check at the operator's commit | **passed** (exit 0) | **passed** (exit 0) |
| Ponytail observed | off in 13/13 requests (declared off) | off in 13/13 requests (declared off) |
| `ponytail-mode` session entries | not counted (added after run 1) | 0 |
| Task status after Pi completed and the check passed | `open` (unchanged) | `open` (unchanged) |
| Processes of the run left alive | 0 | 0 |

Run 1's candidate is the expected fix (`.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")`). The brief said not to run `git`. Pi ran
`bash` seven times, and **the canonical evidence cannot say whether any of those were `git`**: tool arguments are kept only as keyed
digests. Only Pi's own session file, which is private, has the commands. So constraint compliance is not observable from the evidence
(§7). For run 2, whose run directory was kept, that file was checked locally. None of its 7 `bash` commands invoked `git`, and none
wrote under `test/`. Only that yes or no is reported here. Run 1's directory was not kept, so for run 1 it is unknown.

Run 2 replaced the whole file with `write` instead of using `edit`, and added a `typeof` guard. It is a different candidate from run 1's, and
it also passes the check. Both candidates' diffs and reconstructions are kept, outside the repository, under
`~/projects/endophasia-research/work-cycle-001a/`. Only run 2's whole run directory is kept there. Re-read there with the corrected reader (§8), it gives the same tool counts.
Its receipts now read "no check at the current HEAD", because the copy is another working tree, which receipts do not compare.

### Negative cases

| Case | Covered by | Observed |
| :-- | :-- | :-- |
| The verification command fails | the baseline check in every tier | `failed`, exit 3, at the fixture commit; it stays beside the later pass |
| A check of an uncommitted candidate | every tier | refused, exit 2, nothing ran |
| Pi exits, never answers, or its reply is lost | existing CI tests in `tests/endo-workbench-attempts.test.ts`: "Pi exits on the prompt…", "Pi never answers the prompt…", "a lost reply after the send…", "once bound, a failure to record the send or a lost reply…" | `sent-no-reply` or `process-ended`, never "not sent", never retried. Not repeated against real Pi: **NOT TESTED with real Pi** |
| The Git revision changes after a receipt | tier 1 | the passing receipt reads `head-differs`, and the reconstruction says "no check at the current HEAD" |
| The reader is reopened with no live agent | every tier | each reconstruction runs in new processes after the workbench exited, with 0 processes of the run alive |
| The status stays the operator's | tier 1 (then every tier at `open`) | Pi completing and the check passing changed nothing. `done` came only from the operator's own `review → done` with a note |
| The child Pi's version, or its tool schema, is incompatible | the no-terminal tier: `doctor` reports a version other than the one given with `--expect-pi-version` as `fail`. Tier 2 pins 1.5.0's validation behaviour | The workbench itself admits by evidence, not by version (`adapters/pi/version.ts`), and was not changed |
| Ponytail's mode is unknown, or does not match the declaration | the no-terminal tier (`unknown`, `mixed`, `not-loaded`, a mismatch) and tier 2's positive control | real runs: `off`, matching |

## 6. What changed

- `endo task show` also prints `description`, `acceptance`, `createdAtMs` and `history`. The terminal had no way to show the
  operator's decision, so a cycle could not be reconstructed without the page. The regression test (`endo task show` gives a terminal
  reader…) fails without the change. No stored data, schema or route changed. `endo task list` is unchanged.
- `tests/fixtures/fake-openai-server.ts` gains `toolScript`: one scripted tool call per turn, sent verbatim, so real Pi runs its own
  tools against it. Existing behaviour is unchanged.
- This directory (the driver, the fixture, this report) and `tests/work-cycle-001a.test.ts`.

## 7. Limitations, and what is left for WORK-CYCLE-001B

- **The operator-governed run is NOT TESTED.** Every real run here was approved by a test script typing into a real PTY.
- **No real-Pi negative run**: Pi killed mid-run, or a lost connection to the model, against Pi 1.5.0. Fake-Pi coverage only.
- **Provenance.** Nothing records which revision an attempt produced. The receipt names the attempt because the operator said so
  (`attempt-link-is-operator-declared`). In a driver run, the driver runs the checks and writes a commit message naming the attempt, on
  the operator's yes, so the declaration is the operator's answer, carried out by the script. The reconstruction reports a diff between two receipts' commits, never "Pi wrote this".
- **Constraint compliance is not observable** from canonical evidence ("do not run git" against seven `bash` calls). Showing it needs
  the private Pi session, or a decision to record more. That is a schema question for 001B, not something to add casually.
- **Ponytail's mode is not part of any Endophasia record.** The configuration digest covers `PI_*` variables and the agent
  directory, not `PONYTAIL_*`. The observation here comes from the driver's capture, not from the store.
- **The model's identity is the router's alias.** The weights were not hashed, and the router's sampling settings come from its
  `/v1/models` listing, not from anything Endophasia records.
- **The user's full Pi configuration** (all five packages) was not exercised.
- **The run-window tool summary is this report's.** It follows the window `runAfter` uses: the dispatch derived from the
  authorisation, then the first run of the same Pi process, then that run's events to its end. Where the end it finds disagrees with
  `attempt show`'s `run`, the reconstruction lists that as an unknown. The summary is not part of `attempt show`, and the attention
  overview still does not show executions.
- **The task history records no actor.** A status move came from `endo task status` or the paired page. The reconstruction says so and
  does not name a person.
- **One task, one machine, one model**, two real-model runs. Nothing here estimates how often Glimmer succeeds.

## 8. Independent review

A fresh-context subagent on another model (Sonnet 5.5) reviewed the first commit adversarially. It ran the suites and its own probe
scripts against the kept run 2. It did not run the opt-in real-Pi or real-model tiers. It found no boundary violation.

| Finding | Severity | Resolution |
| :-- | :-- | :-- |
| `allEvents` paged with an event's per-stream `sequence` instead of the store's `nextAfterSequence`. Past 500 events, it re-read events and double-counted tools. The reviewer reproduced this on run 2's store with small pages. | material (latent: no run here passed 500 events) | **Fixed.** Tier 1 now compares a 7-event-page reading with a single-page one. With the old cursor the test does not pass: it hangs re-reading pages until killed. |
| The tool window did not follow `runAfter`: it had no instance check, matched the dispatch by proposal id only, and treated any later dispatch as the end | minor | **Fixed** to the same joins and window. A disagreement with `attempt show` is reported |
| The operator was shown `git diff`, but `git add -A` also committed untracked files the diff did not show. A commit made by Pi went unnoticed | minor (material for the operator run) | **Fixed.** The driver shows the status and an intent-to-add diff from the fixture commit, warns when HEAD moved, and commits exactly what was shown. `--no-renames` everywhere |
| Ponytail's `review` mode would read as "off" | minor | **Fixed.** Review mode is detected; unit test |
| The version check had no command-line flag | minor | **Fixed.** `--expect-pi-version` on `doctor` and `run` |
| `reconstruct --run` was labelled read-only but overwrote the earlier report | minor | **Fixed.** Each read adds a time-stamped file, created exclusively |
| The provenance and decision wording overstated who acted | minor | **Fixed** (§7) |
| The proxy could outlive a failed run; a spawn error could hang the wait | minor | **Fixed.** `finally` stops the proxy; a spawn `error` settles the wait |
| `processesOfRun` counted wrapper processes (a shell, `npx`, `timeout`), and matched on a bare prefix | minor | **Fixed.** This process's ancestors are excluded, and only path arguments or a working directory inside the run match |
| `capturedChatBodies` changed `process.env` and could create a key | nit | **Fixed.** The key path is passed explicitly and must exist |
| A non-`/v1` endpoint path was dropped silently | nit | **Fixed.** Refused |
| (Codex, on PR #128) A Ctrl-C while the detached proxy was still starting, or a startup timeout, left the proxy running | minor | **Fixed.** The interrupt handler is installed before the proxy is spawned. Every failed startup (interrupted, exited, timed out) stops the proxy and waits for it before throwing. A unit test checks that none survives; it fails when the stop is removed |
| Tier 2 skips its Ponytail assertions silently when Ponytail is not installed; the tier-3 evidence directory is not checked to be outside the repository | nit | **Kept.** Both are opt-in tiers. This README says where the evidence goes |

