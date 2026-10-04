# Experiments

`endo experiment run` runs a task set under several conditions, N trials each. Every trial is a live Pi session
recorded through the capture proxy, so every trial is also a replayable cassette ([replay.md](replay.md)).
`endo experiment report` aggregates the trials with the trajectory comparison ([trajectory.md](trajectory.md)).

```sh
endo experiment run <spec.json> --out <dir> [--max-trials n]
endo experiment report <dir>
```

## The spec (`endo.experiment-spec.v0`, `protocol/experiment-spec.ts`)

| Field | Meaning |
| :--- | :--- |
| `id` | an `endo.experiment.*` identifier |
| `trials` | N, the number of trials per (task, condition) |
| `seed` | the ordering seed (unsigned 32-bit), or `null` to draw one at the first run. Either way it is recorded. |
| `pi`, `upstream`, `provider`, `model` | the Pi executable, the OpenAI-compatible upstream origin, and the provider and model named in Pi's `models.json` |
| `digestDomain` | `installation` (normal use) or `fixture` (the committed public key; synthetic experiments only) |
| `timeoutMs` | the per-step timeout |
| `tasks[]` | `id`, `prompts[]` (sent in order, each run to `agent_settled`), `workspace` (relative path to content), optional `check` |
| `conditions[]` | `id`, `description`, optional `modelEntry` (fields merged into the `models.json` model entry) and `settings` (Pi's `settings.json`) |

**A condition changes only Pi's documented configuration.** The proxy is pass-through. A condition the configuration
cannot express is reported as such; requests are never altered in flight.

**A success check** is a command (`argv`, run without a shell) executed in the workspace after the session; exit code
0 passes. Its output is kept beside the trial (`check.txt`) and only digested in the result.

## Running

**One fresh setup per trial.** Every trial gets a fresh scratch root, a fresh store, a fresh Pi process and a fresh
session. The scratch root is always at the **same path**: Pi puts the working directory in its system prompt, so a
per-trial path would itself be a difference between trials.

**Order: blocked randomization.** For each trial index k, every (task, condition) cell runs once, in an order
shuffled by mulberry32(seed) with Fisher-Yates. Conditions are interleaved in every block, so drift over the run (time
of day, thermals, server cache state) is spread across conditions rather than confounded with one. `plan.json`
records the order; the same spec and seed always give the same plan.

**Resumable.** A trial counts once its `result.json` exists (written atomically, last). A rerun:
- skips counted trials;
- moves a trial that a killed session left unfinished to `interrupted/`, where it is kept but never counted;
- runs that trial again from scratch;
- removes the killed session's scratch root (the scratch parent is marked as belonging to this run);
- refuses a changed spec (sha256 check).

**Recorded per run session** (`environment/session-<n>.json`):
- the endpoint;
- the model ids and metadata from `GET /v1/models`;
- the Pi fingerprint;
- the digest key id.

The server's default sampling settings are UNAVAILABLE: reading them needs a server-settings endpoint, which the
runner does not call.

**Recorded per trial** (`result.json`):
- every top-level request field except `messages` and `tools`, exactly as Pi sent it;
- the check's result;
- the keyed digest of the workspace as the agent left it;
- the session coordinate;
- notes.

## The report (`endo.experiment-report.v0`)

For each task and condition, over the completed trials:

- **Per judged layer** (lifecycle, tools, outcome):
  - the EXACT, DIVERGED and UNAVAILABLE counts over all unordered pairs;
  - the pairwise exact-match rate (EXACT / (EXACT + DIVERGED)) with a 95% Wilson interval;
  - the number of distinct trajectories;
  - the **modal agreement**: the share of trials whose layer equals the most common one, with a Wilson interval.

  Pairs share trials, so they are not independent, and the pairwise interval is optimistic. Modal agreement is over
  independent trials.
- **First divergence:** per layer, how often each index was the first differing position; and per pair, which set of
  layers diverged.
- **Outcomes:** the outcome kinds, and the success-check pass rate (Wilson) when the task has a check.
- **Final workspaces:** how many distinct ones the trials left.
- **Usage** (Pi-reported tokens) **and timing** (observer clock): median and interquartile range (type 7 quartiles).
  Never judged.
- **Serving inputs:** the distinct request parameters seen, the sampling parameters Pi sent (`none sent` means the
  server's defaults applied, and their values are UNAVAILABLE), and the condition's configuration.
- **Bundle:** an `endo.experiment-bundle.v0` built with the lab's trial discipline (`lab/trials.ts`,
  `lab/experiment-bundle.ts`): the `endo.evaluation-profile.v0`, one `endo.trial-result.v0` per trial (raw: session,
  store, outcome; derived: check, final workspace, trajectory digest; partition `live-traffic`), and the bundle digest.

The report is deterministic over the run directory (it carries its own digest). `summary.md` is a short table.

## Protocol records used, and left unwired

**Used:**

| Record | How |
| :--- | :--- |
| `endo.experiment.v0` | in `experiment.json`: the environment profile, the model, a budget, the provenance |
| `endo.environment-profile.v0` | `simulated: false` |
| `endo.evaluation-profile.v0` | per cell. `cognitionPolicy` is `work`: the trials are task work. |
| `endo.trial.v0` coordinates and `endo.trial-result.v0` | per trial |
| `endo.evaluation-result.v0` and `endo.experiment-bundle.v0` | per cell |

**Left unwired:**
- the experiment lifecycle transitions (`endo.experiment-transition.v0`), because nothing here moves an experiment
  between states;
- candidates, mutations, selection and promotion, because nothing is selected or promoted;
- the conformance study and suite;
- `endo.replay-comparison.v0`, whose graph and visual-state layers do not apply. The trajectory comparison is used
  instead.

`endo.trial.v0`'s `runId` is not set: Pi supplies no run identity, so none is invented.

## Limits

- Only `prompt` steps. STOP and kill scenarios need capability evidence per condition, which the runner does not
  gather.
- Trials run one at a time. With a shared server they are not independent of each other's cache state. The order is
  randomized for that reason, and the cache use Pi reports is recorded in the usage.
- An endpoint that needs an API key is not supported (as with cassette recording).
