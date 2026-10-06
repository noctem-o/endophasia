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
  given; stderr is never read.
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
agent offered, and anything else (an unknown option, a throw, a malformed answer) becomes `cancelled`. Pending requests
are cancelled when `cancel()` is called. Each decision is recorded as an `authority-decision` event. File system and
terminal methods are not advertised and not served.

### Unknown `session/update` variants are kept

The SDK's client app installs a router that parses every `session/update` with a closed union and throws on a variant it
does not know; the update is logged to the console and dropped before any handler runs. The adapter therefore takes
`session/update` notifications off the SDK stream as raw values and passes everything else through. An update it does not
translate becomes `runtime.unrecognized-event` (by name only) and `lifecycle.unrecognized-runtime-event`; a malformed one
becomes `runtime.malformed-event`. Translated in this slice: tool call, tool call update, plan, available commands, mode,
config option, session info and usage updates (as counts, identifiers and statuses).

Known limit: a line that is not JSON is answered by the SDK with a JSON-RPC parse error and never reaches the adapter, so
it is not recorded as a fault by itself. A turn that never completes is bounded by `promptTimeoutMs`, and an agent that
dies is recorded from its exit.

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
  when the prompt completes with no `session/update` (OMP ends a failed model call with `end_turn`, so an unconfigured
  model looks like that). A wrong protocol version, a hang, or a surviving child fails.
