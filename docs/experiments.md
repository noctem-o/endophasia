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

## The run directory's files and their versions

The runner reads back what it wrote (resume, report) and so do the research analysis scripts. These four are the
source of truth. Each declares its schema, and each is read **only** through the reader for the version it declares:
an unknown version, a missing or non-string version, an unknown field in a closed record, or a field of the wrong
shape is refused, naming the file. Nothing is migrated, defaulted or rewritten on read
([policy](schema-compatibility.md)).

| File | Schema | Contract |
| :--- | :--- | :--- |
| the spec you pass to `endo experiment run` | `endo.experiment-spec.v0` | [`protocol/experiment-spec.ts`](../protocol/experiment-spec.ts) |
| `experiment.json` | `endo.experiment-run.v0` | [`protocol/experiment-artifacts.ts`](../protocol/experiment-artifacts.ts) |
| `plan.json` | `endo.experiment-plan.v0` | the same module: `seed`, `ordering` and `order`, every entry exactly `{ position, task, condition, trial }` |
| `trials/<task>/<condition>/<k>/result.json` | `endo.experiment-trial.v1` written now; `endo.experiment-trial.v0` read as history | the same module |

- `experiment.json` embeds the spec and the `endo.experiment.v0` record. **The run record names which versions it
  embeds** (exactly `endo.experiment-spec.v0` and `endo.experiment.v0`): a later spec version is not valid inside a
  v0 run record merely because the spec family learned it.
- The files are checked against each other where the runner guarantees it: `specSha256` is the digest of the embedded
  spec; the plan's seed and ordering are the run record's and its entries are exactly the spec's (task, condition,
  trial) cells; a result is that of the plan entry whose directory holds it; a trial's `status` is `completed` exactly
  when its `error` is `null`; a check's `passed` is exit code 0 without a timeout.
- A task or condition id in `plan.json` or `result.json` is a slug and a trial's `store` is a relative path inside the
  run directory, because the runner builds paths from them.
- The spec's maps (workspace files, model entry, settings, extensions, a pinned environment's variables and files,
  injected fields) and a trial's recorded request parameter values are open data, not schema fields.
- **Trial versions.** `endo.experiment-trial.v1` is what the runner writes. It replaces v0's `requestParameters` with
  `harness`, the [effective harness surface](#the-effective-harness-surface) of the trial. Every committed study
  (variance, pinned environment, steering, path sensitivity, discriminating tasks, completion cap) holds v0 trials. They
  are read exactly as before (`requestParameters` and nothing else), are never rewritten, and are not re-derived: a v0
  trial's harness surface is UNAVAILABLE ("predates the surface"), because the report cannot know what the model
  server received beyond what that record kept. A run directory begun before this version and resumed after it holds
  both; the report consumes both, and a cell mixing them reports the v1 trials' surfaces and counts the v0 trials as
  predating it, never as differing. Neither version is converted to the other. A version this reader does not know is
  refused.

## The effective harness surface

README "Evidence closure": record what the model actually experiences, not only which executable ran. Each trial's
`harness` is derived from the trial's own capture log (the recording proxy's `capture.request` events and the request
bodies in the keyed blob store), by `adapters/openai-proxy/harness-surface.ts`. The same derivation produces the
request parameters the report has always listed (`requestParametersOfTrialV0`): there is one parser, and the parameters
are a view of the surface. Contract: [`protocol/harness-surface.ts`](../protocol/harness-surface.ts) (`endo.harness-surface.v0`).

Per captured request, the surface records:

- **source**: the capture version the log declared, the exchange, the capture event, method and path, and the request
  digest; and one **digest key** for every digest of the record;
- **dialect**: `openai.chat-completions` when the request is a POST to a chat-completions endpoint and its body has that
  shape, and otherwise UNAVAILABLE with the reason. A JSON object that merely resembles a chat request on another path
  is not recognized, and an unrecognized request has no components at all;
- **model**: the model the request names; UNAVAILABLE when it names none. The configured model is a different fact
  (below) and is never substituted;
- **streaming**: the request's `stream` flag; UNAVAILABLE when the request carries none (what the server does then is
  not observed, so `false` is not assumed);
- **instructions**: every `system` and `developer` message in wire order, as role, position, keyed digest and length;
- **tools**: every tool definition in wire order as a keyed digest and, when it is a plain identifier, the tool's name;
  an **ordered digest** (the model-facing fact: tool order has changed behaviour in these studies) and a
  **membership digest** over the sorted component digests (duplicates kept). "Same tools, other order" therefore shows
  as a change of `tool-order` only, and a changed definition as `tool-definitions`;
- **parameters**: every other top-level field the request carried (`model` and `stream` are recorded once, above).
  Short values are recorded verbatim (at most 1024 bytes of compact JSON, one measure shared by the recorder and the validator), longer ones by digest. A parameter the
  request did not send is **absent**; absent never means the server's default (`temperature` absent is not
  `temperature = 1`), and the server's resulting defaults are explicitly UNAVAILABLE;
- **identity**: the keyed digest of one exported basis (`endoHarnessSurfaceIdentityBasisV0`): the dialect, the request target
  (path and query as sent, since a route or query parameter may select other server behavior), the model,
  the streaming flag, the ordered instruction digest, the ordered tool digest and presence, the parameters digest and the headers.

What is **not** in the surface: the user's messages, the assistant's and tool results (task input is not harness
surface, so a different prompt, history or tool output leaves the identity unchanged); system or developer text and
tool definitions as text (only their keyed digests; the request itself stays in the blob store, outside canonical
evidence); and any reconstructed prompt "template". If a harness puts its working directory into the system message, the
on-wire instruction digest is the digest of what the model received, and it changes with the directory. The directory
is not parsed out of the text; it is recorded separately, from the runner, as a **contribution**:

| contribution | source | meaning |
| :--- | :--- | :--- |
| `workingDirectory` | the runner | the directory Pi was started in (`<scratch root>/work`) |
| `invocationMode` | the runner | `pi --mode rpc`, how the runner drives Pi (not the wire's `stream` flag) |
| `configuredModel` | the spec (`source: "spec"`; the other two are `"runner"`) | `provider/model` as configured; compare with the model the wire names, do not merge them |

A body that is not valid UTF-8, or holds a value with no canonical form (such as an overflowing number), is UNAVAILABLE, as the request digest already treats it as opaque. A v1 trial lists no surface that none of its requests used, and each listed surface is the first observation of a request that names it.

Request **headers** are part of the surface, without judging which of them change server behavior. Every recorded header
except the transport ones (Host, Content-Length, Connection, Transfer-Encoding and the like, which differ per connection
without asking the server for anything else) is recorded by lowercase name with the keyed digest of its value, sorted,
so wire order does not matter. A header whose value the capture redacted (Authorization) is recorded as present with no
digest: the value is unknown, never guessed. A capture that recorded no header list gives headers UNAVAILABLE, not an
empty list. A difference in any header is named as the `headers` coordinate.

**Digest domains.** All digests of a record are under one key. Surfaces under different keys are in different domains:
the comparison answers "not comparable", never "different". Component digests cover the canonical JSON of the parsed
value, under a per-purpose basis literal, so number formatting, key order and duplicate object keys in the body do not
separate two surfaces while any changed value does, and a component digest equals no other keyed digest in the store.

**In the report** (`endo.experiment-report.v2`, which adds `cells[].harnessSurface`; v1 reports stay as they are): per
cell, the number of v1 and predating trials, the digest keys, request counts (recognized and not), the **distinct
surfaces** with their identity and how many trials and requests showed each, `matched` (every trial showed the modal
set of identities), the trials that differ from the modal set, the major coordinates that differ (`model`,
`streaming`, `instructions`, `tool-definitions`, `tool-order`, `parameters` with the parameter names) and not their
content, surfaces that change inside one trial, and the distinct contributions. `summary.md` lists one line per cell. A cell
is expected to hold one surface, and a cell that shows more says so; the report does not call the experiment invalid
for it (only the declared manipulation checks do that). The manipulation checks themselves are unchanged: they keep
their own pre-registered reading of the request bodies.
- **`plan.json` of an older run has no `schemaVersion`.** It is read, when it declares none, as exactly
  `{ seed, ordering, order }` with the same entries (the shape runs wrote before the plan was versioned), reported as
  the legacy form and never rewritten, so those runs still resume and report. Any other root or entry field is
  refused, and a plan that declares a version is the version table's alone.
- `journal.jsonl`, `environment/session-<n>.json`, `evidence/` and `report/` are **not** covered
  ([limits](schema-compatibility.md#known-limitations)).

## The report (`endo.experiment-report.v2`)

For each task and condition, over the completed trials:

- **Per judged layer** (lifecycle, tool calls, tool results, outcome),
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
- **Effective harness surface** (v2): see [above](#the-effective-harness-surface).
- **Serving inputs:**
  - the distinct request parameters seen (model and stream included, as before);
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
