# ACP v1 slice

`adapters/acp` attaches Endophasia to an agent over the Agent Client Protocol (ACP), **version 1 only**, using the
official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) (pinned, exact version in
`package.json`). It is the first of a planned sequence (this slice; v1 semantic coverage and explicit loss accounting;
experimental v2; a cross-surface study). Nothing later is implemented here.

ACP is an **adapter surface, not a source of truth**. ACP types stop at `adapters/acp`; `protocol/` and `runtime/` do not
know ACP exists (`tests/acp-boundary.test.ts` enforces this, forbids the SDK's `experimental/*` entries, and checks the
pin). No core schema was changed. The adapter emits ordinary `endo.event.v0` events, using the Pi adapter's recorded
kinds where the meaning is the same and the canonical `lifecycle.*` kinds (`protocol/session-lifecycle.ts`) for the
lifecycle.

## First real specimen

OMP's built-in `omp acp` (ACP over stdio) is the first real agent. The adapter does not know it: it launches any
configured command (`AcpLaunchV0`: command, args, absolute cwd, and the child's complete environment). Nothing is
inferred from the executable's name; what the agent can do is what its `initialize` response said and what was
observed. The independent `omp-acp` package is not used: it would put an OMP-RPC to ACP adapter between Endophasia and
OMP.

## What it does

- Launches the command in an owned process group (`adapters/rpc-jsonl/process-group.ts`, the runtime-neutral primitive;
  not the JSONL RPC connection). `close()` is idempotent and bounded: stdin closes, a grace period, SIGTERM, a second
  grace, then the whole group is SIGKILLed, so no descendant survives. The child gets exactly the environment it is
  given; stderr is never read. On Windows there are no process groups: only the command itself is
  ended, and descendants are not (the descendant tests are skipped there).
- ACP framing, request correlation and validation are the SDK's (`ndJsonStream`, `client().onRequest().connect()`).
- `initialize` with the literal protocol version 1; any other negotiated version closes the child and fails with
  `AcpProtocolErrorV0`. The reported `agentInfo`, `agentCapabilities` and auth method ids are recorded as the agent's own
  report (`harness.acp-initialized`), not as a verified identity.
- `session/new` with an explicit absolute cwd, then one `session/prompt` at a time with a text prompt, and
  `session/cancel`.
- Records evidence: `harness.acp-initialized`, `harness.attached`, `control.requested`, `session.update-observed`,
  `agent.prompt-responded`, `permission.requested`, `permission.decided`, `harness.process-exited`, and the derived
  `lifecycle.session-started`, `run-started`, `run-completed` / `run-aborted` / `run-unclassified` / `run-failed`,
  `stop-requested`, `interrupted`, `detached`.
- What ACP v1 does not report is declared UNAVAILABLE on session start (run id, turn id and count, operation outcome,
  stop target, lanes). The run start is the client's own `session/prompt`, said so in the event (`basis`), because ACP v1
  sends no run-start notification. A `stopReason` of `end_turn` is a completion, `cancelled` an abort (the cancel
  request is recorded apart and not inferred to be the cause), and `max_tokens`, `max_turn_requests` and `refusal` are
  `run-unclassified`, never a failure the agent did not report. A stop reason outside ACP v1's set is a protocol fault.
- No prompt text, agent text, tool title, tool input or output, or permission label enters an event. Streaming chunks
  are counted. A JSON-RPC error is recorded by code only.

### Permissions fail closed

`session/request_permission` is answered with the agent's own `reject_once` option when it offered one, else
`cancelled`. A caller may supply an explicit `permissionHandler`; its answer is honored only if it selects an option the
agent offered, and anything else (an unknown option, a throw, a malformed answer) becomes `cancelled`. A request with no open turn, during a cancel, or naming a session other than the open one is
`cancelled` without consulting the handler. Options sharing an id are ambiguous and are `cancelled`; the handler gets a copy of the request and is bounded by a snapshot of what was offered. A closing attachment approves nothing. The handler's answer is also discarded (`cancelled`) if its turn ended or was cancelled while it decided. Pending requests are cancelled when `cancel()` is called. Each decision is recorded as an `authority-decision` event; `decidedBy: "handler"` only when the handler's own valid answer is the one returned (`handlerConsulted` says whether it was asked at all). Only a well-formed JSON-RPC 2.0 notification is taken as a `session/update`. File system and
terminal methods are not advertised and not served.

### Unknown `session/update` variants are kept

The SDK's client app installs a router that parses every `session/update` with a closed union and throws on a variant it
does not know; the update is logged to the console and dropped before any handler runs. The adapter therefore takes
`session/update` notifications off the SDK stream as raw values and passes everything else through. An update it does not
translate becomes `runtime.unrecognized-event` (by name only) and `lifecycle.unrecognized-runtime-event`; a recognized variant missing a field ACP v1 requires of it (or an update with no variant) becomes
`runtime.malformed-event` and is not counted as update activity. The session coordinate is
`endo.session.acp.<process instance>.<session id>`: ACP session ids are agent-local, so two launches would otherwise merge. Translated in this slice: tool call, tool call update, plan, available commands, mode,
config option, session info and usage updates (as counts, identifiers and statuses).

Known limits:

- Requests are raced against the agent process's exit, because a descendant can keep the agent's stdout open after the
  agent ended. If the agent answers and exits at nearly the same moment, the exit can be seen first and the turn is
  recorded as interrupted; that is the conservative reading.
- A closed ACP stream under a living agent makes the attachment unusable at once (no prompt, cancel or approval), then
  a fault is recorded and the group ended.

- A line that is not JSON is answered by the SDK with a JSON-RPC parse error and never reaches the adapter, so it is not
  recorded as a fault by itself.
- `promptTimeoutMs` only stops the caller waiting (`harness.prompt-timeout`). The turn stays open: if the agent answers
  later (for example after `cancel()`), that answer is recorded as the agent's report. An agent that never answers is
  ended by `close()`, which records `lifecycle.interrupted` once the process is gone; `close()` during an awaited turn
  does not blame the agent (`AcpClosedErrorV0`, no fault event).

### Deviations from the declared lifecycle shapes

The existing session-overview reducer (`runtime/contracts/session-overview.ts`) reads the ACP events without anomalies,
but the declared shapes in `protocol/session-lifecycle.ts` are Pi-shaped, and ACP v1 does not fit them everywhere. None
of this changed a core schema; each is stated here instead:

- `lifecycle.*` payloads omit `turns` and `turnOpen`: ACP v1 reports no turn count. The overview therefore shows 0 turns
  (the reducer's fallback), which is declared in the session start's `unavailable` list as `turns`, not a count.
- `lifecycle.run-failed.cause` is `{ source: "jsonrpc-error", code }`, outside `EndoReportedCauseV0`'s two sources
  (assistant message, retry loop).
- Extra fields: `basis` on `run-started`; `stopRequested` and `stopReason` on the run ends; `reason` and `stopReason` on
  `run-unclassified` for `max_tokens`, `max_turn_requests` and `refusal`.
- `runtime: "acp"` on `lifecycle.session-started` names the protocol surface, not the agent. The agent's own claim is in
  `harness.acp-initialized.agentInfo`.

## Not supported here

ACP v2 and any fallback to it, `session/list`, `load`, `resume`, `fork`, config options and model switching,
`authenticate` (an agent that requires it will refuse `session/new`; the refusal is reported), usage normalization,
loss accounting (EXACT / QUALIFIED / LOSSY / UNREPRESENTABLE), cross-surface comparison, a durable store, and any change
to the cockpit.

## Tests

- `npm test` runs the deterministic suite (`tests/acp-adapter.test.ts`, fake agent `tests/fixtures/fake-acp-agent.ts`
  built on the SDK): no OMP, network, model or credentials.
- Real OMP is opt-in: `ENDO_OMP_EXECUTABLE=/path/to/omp npm run test:acp-omp-real`. The child receives only `PATH` and
  `HOME` plus any variable names listed in `ENDO_OMP_ENV_PASSTHROUGH` (comma-separated), so OMP finds the operator's
  existing configuration; values are never printed. It may use the operator's configured model and cost money. It skips,
  with the reason, when `omp` is missing or has no `acp` command, when `session/new` or `session/prompt` is refused, or
  when the prompt completes with no message, thought or tool-call update (OMP
  sends bootstrap updates after `session/new` regardless of the model) (OMP ends a failed model call with `end_turn`, so an unconfigured
  model looks like that). A wrong protocol version, a hang, or a surviving child fails.
