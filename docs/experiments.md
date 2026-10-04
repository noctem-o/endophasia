# Experiments

`endo experiment run` runs a task set under several conditions, N trials each. Every trial is a live Pi session
recorded through the capture proxy, so every trial is also a replayable cassette ([replay.md](replay.md)).
`endo experiment report` aggregates the trials with the trajectory comparison ([trajectory.md](trajectory.md)).

```sh
endo experiment run <spec.json> --out <dir> [--max-trials n] [--fixture-experiment]
endo experiment report <dir>
```

## The spec (`endo.experiment-spec.v0`, `protocol/experiment-spec.ts`)

| Field | Meaning |
| :--- | :--- |
| `id` | an `endo.experiment.*` identifier |
| `trials` | N, the number of trials per (task, condition) |
| `seed` | the ordering seed (unsigned 32-bit), or `null` to draw one at the first run. Either way it is recorded. |
| `pi`, `upstream`, `provider`, `model` | the Pi executable, the OpenAI-compatible upstream origin, and the provider and model named in Pi's `models.json` |
| `digestDomain` | `installation` (normal use) or `fixture` (the committed public key; synthetic experiments only, and only in explicit fixture-experiment mode: `--fixture-experiment`. A fixture spec without the flag is refused, and so is the flag with an installation spec, as for the fixture recorder.) |
| `timeoutMs` | the per-step timeout |
| `tasks[]` | `id`, `prompts[]` (sent in order, each run to `agent_settled`), `workspace` (relative path to content), optional `check` |
| `conditions[]` | `id`, `description`, optional `modelEntry` (fields merged into the `models.json` model entry), `settings` (Pi's `settings.json`), `extensions` (modules for Pi's agent directory's `extensions/`), `environment` (a pinned environment, below) and `interventions` (an operator intervention per task, below) |

**A condition changes only Pi's documented configuration.** The proxy is pass-through. A condition the configuration
cannot express is reported as such; requests are never altered in flight.

**A pinned environment** (`environment`) changes what Pi's tools observe, not Pi's configuration:
- `variables`: added to Pi's session environment, which every tool inherits. Only `TZ`, `LC_ALL`, `LANG` and
  `NODE_OPTIONS` are allowed. `{root}` in a value stands for the scratch root.
- `files`: written under `<root>/env/`, outside the workspace (for example, a `node:test` reporter that prints no
  durations, named in `NODE_OPTIONS`).
- `fileTime`: an ISO-8601 UTC time (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) given to every entry under the scratch root, and to
  the root, after setup and before the snapshot and Pi's start. `ls -la` then prints the same times in every trial.

Pi's identity probe (`pi --version`) keeps its own minimal environment, so the fingerprint does not depend on the
pinning. The success check runs in the runner's environment, unpinned. Each trial's capture records the environment
(`capture.environment`, see [replay.md](replay.md)), and the report lists it per cell under `servingInputs.environment`.
The clock is never faked: files written during the session get the time they were written.

**An intervention** (`interventions`, per task id) applies one operator STEER, QUEUE or STOP during the task's first
prompt ([steering.md](steering.md)): `{ operation, message?, after: { exchange, chunks } }`, applied once the recording
proxy has relayed `chunks` chunks of exchange `exchange` (counted from 1 within the trial).
- The proposal and its authorization are the scenario's, recorded before the prompt.
- Controls are offered only for admitted capabilities, so the runner runs **one live capability study per run session
  per distinct Pi configuration** before any trial. The study's model traffic goes through the same proxy into its own
  capture log in the run's `evidence/` directory, apart from every trial's. Each trial copies the evidence.
- The runner refuses to go on when a required capability is not admitted, and removes its scratch if it stops
  before a trial.
- A resumed run starts a new session, and a new study.

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

- **Per judged layer** (lifecycle, tool calls, tool results, outcome; the report is `endo.experiment-report.v1`),
  three numbers:
  - **The headline: modal agreement.** The share of completed trials whose layer equals the most common one, with a
    95% Wilson interval. Trials are independent, so the interval means what it says.
  - **Distinct trajectories:** how many different layers the trials produced.
  - **The pairwise exact-match rate:** EXACT / (EXACT + DIVERGED) over all unordered pairs, with UNAVAILABLE pairs
    counted separately. Its 95% interval is a **percentile bootstrap that resamples trials, not pairs**. The
    n(n−1)/2 pairs of one sample share trials, so treating them as independent (a Wilson interval over pairs) would
    claim far more precision than n trials hold. Resampling trials keeps that dependence. Details: 10 000 resamples,
    seeded from the spec sha256, the cell and the layer, so the report is deterministic. Two draws of the same trial
    are not a pair, because a self-pair is trivially exact.
- **Calls against inputs:** over the pairs, how many had tool calls identical up to the first divergent input,
  how many did not, and how many were undecidable.
- **First divergence:** per layer, how often each index was the first differing position; and per pair, which set of
  layers diverged.
- **Outcomes:** the outcome kinds, and the success-check pass rate (Wilson) when the task has a check.
- **Final workspaces:** how many distinct ones the trials left.
- **Usage** (Pi-reported tokens) **and timing** (observer clock): median and interquartile range (type 7 quartiles).
  Never judged.
- **Serving inputs:**
  - the distinct request parameters seen;
  - which sampling fields were checked for and which Pi actually sent (`samplingFieldsSent`). `none sent` means the
    server's defaults applied, and their values are UNAVAILABLE;
  - the condition's configuration.

  For Pi 1.0.1, see the conformance finding
  [`research/pi-conformance/1.0.1/sampling-control/`](../research/pi-conformance/1.0.1/sampling-control/README.md).
  Pi sends no sampling field. No documented configuration field sets one. A documented `before_provider_request`
  extension can.
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
| `endo.evaluation-profile.v1` | per cell, with `cognitionPolicy: "none"`. No Endophasia cognition policy is applied to these trials: Pi runs with its default behaviour. v1 adds `none` to v0's `work` and `dream`; v0 records stay valid. |
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
