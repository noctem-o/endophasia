# COORDINATOR-RUNTIME-001: a local, read-only Coordinator briefing

*   **Status:** experimental `endo coordinator brief`. OpenClaw 2026.11.7 and one local llama.cpp model are the first substrate.
*   **Builds on:** the [Coordinator status projection](coordinator-status.md), its OpenClaw plugin's trimmed view, and the existing [bounded model relay](../protected-model-access.md).
*   **Scope:** one project, one read-only tool, one briefing. No Gateway integration, approval, execution, scheduling, or session control.

## 1. Interface and standing

```text
endo coordinator brief [<root> | --root dir] --project <endo.project.id> [--quiet]
```

Stdout contains one canonical JSON document, `{ "coordinatorBrief": … }`. Stderr contains operator text unless `--quiet` is set.
An available result identifies the project, OpenClaw, the llama.cpp build, the exact model, the observed tool surface, and the evidence: `readAtMs`, SHA-256 of
the canonical validated status projection, and SHA-256 of the narrower view submitted to the model. An unavailable result has a
closed reason and no answer. The brief doesn't persist anything to the store. Keep the canonical projection for decisions; a
briefing is a model interpretation, not acceptance, authorization, or a new source of truth.

The briefing covers the operator's task status and review queue, things needing attention, controller-observed failures at HEAD,
incomplete evidence, recent recorded session activity and its basis, what can't be known, and one suggested next action. Completion
doesn't prove correctness; a pass doesn't prove complete verification; a historical failure isn't a current failure; activity isn't liveness.
The default trimmed plugin view omits task titles, attempt prose, paths, commands, and identifying session details. Additionally, if a
projection says `no-checks` but cannot positively establish that it read the receipt inventory, the brief view says
`receipt-coverage-not-established` and marks verification unavailable/incomplete. That avoids relaying the pre-GEO-26 absence ambiguity
as evidence. A newer validator and worker must come from the same Endophasia build. This does not upgrade a surviving pass into proof
of complete receipt history.

## 2. Substrate boundary

`runtime/contracts/coordinator-brief.ts` declares the request, result, evidence and tool shape. Any replacement substrate must
enforce that surface at dispatch, refuse foreign selectors, and bind an available answer to the validated status it supplied to the
model. The caller also refuses an available result with the wrong scope, an expanded tool surface, or missing evidence fields. That
shape check cannot attest to a replacement substrate's actual wire behavior; each substrate must demonstrate enforcement in its own tests.

1.  The host reads the registered project path and uses Endophasia's hardened, read-only Git observer to obtain HEAD and the
    repository identity needed to compare receipts. A second read runs the canonical projection worker in bubblewrap with a fixed,
    validated observation argument; it checks the read still names the registered path. It binds the status code and the store's
    `develop/` and `events/` only, plus runtime libraries; it doesn't bind the project or its Git directory. Linked worktrees and
    overlapping project/code/store mounts are refused. Use a CLI installation outside the project being briefed.
2.  OpenClaw runs separately in bubblewrap, with an empty scratch HOME, config, workspace, installed OpenClaw code, and an empty
    network namespace except its loopback relay bridge. It sees neither the project nor the store. The scratch tool presents the
    validated, one-project status snapshot only when invoked. It cannot run a fresh command. The config explicitly disables Tool
    Search and inherited skills/plugins and defines only the local provider. No live Gateway is started or contacted.
3.  The host relay admits only the exact Chat Completions route and model with a per-turn synthetic bearer. At the outgoing
    request it checks the exact single `endophasia_status` definition and inference parameters; at the incoming response it
    checks the structured call and selector before giving OpenClaw a response it could dispatch. It requires the following
    request to carry the exact validated tool result with the paired call ID, allowing only OpenClaw's observed ID normalization.
    The tool itself has an additional dispatch check. No tool, extra tool, wrong project, fabricated result, or truncated final
    answer can yield an available brief. A plausible answer without a status call is `ungrounded`.

## 3. Threat model

The model, its output, and fixture records are untrusted. The operator's selected store, the installed Endophasia/OpenClaw/Node/Git
and bubblewrap code, the Linux kernel, and the existing loopback model server are trusted. This doesn't protect against compromised
installed code, a hostile host/root user, or another process running as the operator. There is no general-purpose shell, web,
filesystem, or messaging tool; the sandbox still contains system binaries. Model output is unverified prose even after a correct
dispatch. The answer filter withholds observed forms of unsupported absence claims and suggestions to grant shell authority. It's a
narrow wording check, not a language validator. It may miss paraphrases or withhold a correct answer that quotes a prohibited claim.

The status reader is read-only, has an output/deadline bound and uses existing bounded source reads. The model relay bounds body
size, bytes, connections, generation (one choice), and the number of upstream exchanges; the embedded process has a deadline.
Connections to the external model service are fixed to `127.0.0.1:8091`; failure doesn't switch providers. Incomplete scratch state
or a refused request cannot turn into a result. Scratch HOME, OpenClaw state, recording and the relay socket are removed on normal
success or failure. Controller death during bubblewrap's launch window isn't attested, and abrupt death may leave private scratch files.
The launcher neither installs plugins nor reads
the operator's OpenClaw or Pi credentials. A prompt and the trimmed status are disclosed to the operator's local llama.cpp service.

**Pathname sockets are a residual, not confinement.** The normal Endophasia control endpoint is `<store>/control/endpoint.sock`
(read from code). It sits outside the status reader's `develop/` and `events/` binds. On Arch Linux, a disposable probe in
the same mount profile got `ENOENT` for a control-path canary. With a read-only project bind added, the project pathname canary
was reachable; without it the probe got `ENOENT`. A second canary in `events/` remained reachable in both cases, even as writes
returned `EROFS`. Removing project roots is worthwhile and is the default for the brief. It doesn't remove sockets under the
remaining mounts. The standalone OpenClaw status plugin keeps its older, separately documented project mount behavior.

## 4. Compatibility and verification on Arch Linux

The measured host had OpenClaw **2026.11.7 (e31bbf0)**, bubblewrap **0.13.1**, and Node **26.13.1**. Installed help reported
`agent --local`, `--agent`, `--model`, `--thinking`, `--json`, `--message-file` and the global isolated `--profile`/`--dev`
switches. Running `config file` under both switches with a fresh HOME also returned the expected scratch profile paths. The runner
uses explicit scratch paths instead of either named profile. The user manager reported `degraded`; the
embedded runs use no systemd unit, so this didn't prevent the runs.

| Context | Evidence |
| :--- | :--- |
| Operator shell | Scratch `plugins build --entry ./dist/index.js --check`, `plugins validate`, `plugins lint`, and `plugins inspect endophasia-status --runtime --json` passed for the original plugin with its pinned TypeBox 1.3.34. Lint warned about TypeBox runtime code generation; inspection loaded one optional tool and returned an SDK deprecation advisory. The peer range adds only 2026.11.7, not intervening releases. |
| Embedded agent | The configured allowlist by itself initially projected `dispatch_action`, `tool_describe`, and `tool_search`; the relay forwarded none of that request. Explicit `tools.toolSearch: false` restored direct tools. With a deterministic provider, a valid call reached the tool; an added `read` definition was refused before model dispatch, and a generated `exec` call was refused before tool dispatch. No-call text was withheld as `ungrounded`; a provider 503 returned `model-unavailable` without a second request. A separate probe from the same bubblewrap profile got `ENETUNREACH` for a nonlocal address and did not inherit a synthetic credential. |
| Disposable systemd service context | Not run. Even a disposable `systemd-run` creates a transient unit, which the scope forbade. Running with a clean environment does not prove this case. |
| Live production Gateway | Not run. Gateway PID and invocation ID, systemd user configuration and timer inventory, and the OpenClaw installation's metadata fingerprint matched across the trial window. The full `~/.openclaw` metadata fingerprint changed: surviving new stamps were in `state/` and `logs/`, with the top-level config's timestamp predating the trials. No live writes, installs, restarts, or messages were issued by this runner. The difference is unexplained; the measurement doesn't establish schedule or messaging state, or byte identity for credential-bearing files. |

`GET /v1/models` identified **Inkling-2-Mini-Uncensored-AD-Q4_K** (initially unloaded; first request autoloaded it). `GET /props`
reported router **b12622-19bc41dbb**, one instance and autoload enabled. The loaded worker reported a 131072-token context despite the
catalog's larger advertised context, Jinja template present, default temperature 1, top-k 0, top-p 1, min-p 0, and random seed sentinel.
The runner admits exact observed request values instead: temperature 0, top-k 1, top-p 1, min-p 0 and seed 101. The initial smoke
used 1024 tokens; the current cap is 2048 per completion. The smoke confirmed structured Chat Completions SSE `tool_calls` followed
by a matching tool result; its final text hit the generation limit and was withheld. This does not establish which constraints the
server applies internally or guarantee deterministic output.

## 5. Model trials

The [trial records](coordinator-runtime-trials.jsonl) contain the 22 local agent turns (44 Chat Completions requests) on 24 November
2026: one cold smoke, twelve scenarios, then nine targeted retests under stricter wording. They retain the exact tool definitions,
validated tool outcome, prompt and runtime identity, fixture expectation and prohibited claims, latency, usage, model answer,
and the observed shortcomings. All 22 turns used exactly one tool and submitted its result. All synthetic project and store
manifests matched; the relay and scratch directories were gone after the run. The smoke's canonical projection digest wasn't
recorded; its model-view digest was reconstructed from the captured tool result. It had no retained operator briefing.

The first twelve scenarios completed a grounded turn, but nine answers contained claims or advice the release wording filter
would withhold on replay. Most turned an incomplete read into a claim that no receipt or event was recorded. One recommended
granting a shell after correctly refusing to run a command. The stricter wording improved those retests: eight of nine pass the
release filter on replay; the stale-session case still overstates absence of a current failure. Three clean scenarios were not
repeated with the new wording. The other-project request did not read the other project. The malicious fixture's raw text
was omitted by projection; that tests the disclosure boundary, not the model's ability to resist raw injected instructions.

The deterministic suite creates twelve standalone Git scenarios and fingerprints all project and store files recursively before
and after reads. The opt-in installed-harness cases use an in-process disposable provider:

```sh
npm test -- tests/coordinator-brief.test.ts
ENDO_COORDINATOR_OPENCLAW="$HOME/.local/bin/openclaw" npm test -- tests/coordinator-brief.test.ts
node tests/coordinator-brief-live.ts "$HOME/.capy/work/brief-evidence" review
```

The last command uses the local model; it runs only the named synthetic fixtures and writes evidence to a new scratch directory.
The unmodified baseline and first full suite exercised the repository's pre-existing transient-scope tests; they were not
Coordinator or Gateway tests. To run the repository suite without transient scopes, remove the user-bus environment:
`env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS npm test`. The real systemd isolation cases are unavailable under that invocation.
