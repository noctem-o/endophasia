# ACP v1 adapter

`adapters/acp` attaches Endophasia to an agent over the Agent Client Protocol (ACP), **version 1 only**, using the
official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) (pinned, exact version in
`package.json`). The sequence is: **ACP v1 slice** (PR #37) → **ACP v1 semantic coverage and loss accounting** (this
document's second half) → experimental ACP v2 (not started; a separately pinned, draft protocol study, not stable) →
a cross-surface conformance study.

ACP is an **adapter surface, not a source of truth**. ACP types stop at `adapters/acp`; `protocol/` and `runtime/` do not
know ACP exists (`tests/acp-boundary.test.ts` enforces this, forbids the SDK's `experimental/*` entries and private
paths, confines the schema validator, and checks both pins). No core schema was changed. The adapter emits ordinary
`endo.event.v0` events, using the Pi adapter's recorded kinds where the meaning is the same and the canonical
`lifecycle.*` kinds (`protocol/session-lifecycle.ts`) for the lifecycle.

The claim is narrow: this pinned ACP v1 adapter validates the wire semantics it recognizes, preserves unknown update
variants, records explicit loss for its Endophasia projections, and has been exercised against the stated real OMP
specimen. It is not a claim of general ACP compliance.

## Revisions this document is about

| | |
| --- | --- |
| Mapping version | `acp-v1-mapping.2` (`.1` was the PR #37 slice; the emitted evidence changed, so it was bumped) |
| Loss accounting | `endo.acp-loss-accounting.v0`, tied to the mapping and to the schema below |
| SDK | `@agentclientprotocol/sdk` 1.7.0 |
| Schema | the SDK's public `@agentclientprotocol/sdk/schema/schema.json`, sha256 `6449a87a3b3c42aa0abd30033fc9bd3236cd785078ad084ce3675766be09109e` |
| Validator | `ajv` 8.20.0 (`ajv/dist/2020.js`), a dev dependency used only under `adapters/acp` |

## First real specimen

OMP's built-in `omp acp` (ACP over stdio) is the first real agent. The adapter does not know it: it launches any
configured command (`AcpLaunchV0`: command, args, absolute cwd, and the child's complete environment). Nothing is
inferred from the executable's name; what the agent can do is what its `initialize` response said and what was
observed. The independent `omp-acp` package is not used: it would put an OMP-RPC to ACP adapter between Endophasia and
OMP.

## The PR #37 slice

- Launches the command in an owned process group (`adapters/rpc-jsonl/process-group.ts`, the runtime-neutral primitive;
  not the JSONL RPC connection). `close()` is idempotent and bounded: stdin closes, a grace period, SIGTERM, a second
  grace, then the whole group is SIGKILLed, so no descendant survives. The child gets exactly the environment it is
  given; stderr is never read. **On Windows** the shared `ProcessGroupV0` has no job-object containment: only the
  command itself is ended, and descendants are not (the descendant tests are skipped there). This tranche does not change
  that; it is stated in the loss accounting (`process.containment`). Job objects belong in the shared primitive, as
  follow-up.
- ACP framing and request correlation are the SDK's (`ndJsonStream`, `client().onRequest().connect()`).
- `initialize` with the literal protocol version 1; any other negotiated version closes the child and fails with
  `AcpProtocolErrorV0`. The reported `agentInfo`, `agentCapabilities` and auth method ids are recorded as the agent's own
  report (`harness.acp-initialized`), not as a verified identity.
- `session/new` with an explicit absolute cwd, then one `session/prompt` at a time with a text prompt, and
  `session/cancel`.
- What ACP v1 does not report is declared UNAVAILABLE on session start (run id, turn id and count, operation outcome,
  stop target, per-message usage, lanes). The run start is the client's own `session/prompt`, said so in the event
  (`basis`), because ACP v1 sends no run-start notification. A `stopReason` of `end_turn` is a completion, `cancelled` an
  abort (the cancel request is recorded apart and not inferred to be the cause), and `max_tokens`, `max_turn_requests`
  and `refusal` are `run-unclassified`, never a failure the agent did not report. `end_turn` alone is not proof of
  provider work: the real smoke additionally requires prompt-attributable output. A stop reason outside ACP v1's set is a
  protocol fault.
- No prompt text, agent or thought text, tool title, tool input or output, plan text, or permission label enters an
  event. Streaming chunks are counted. A JSON-RPC error is recorded by code only.

### Permissions fail closed

`session/request_permission` is answered with the agent's own `reject_once` option when it offered one, else
`cancelled`. A caller may supply an explicit `permissionHandler`; its answer is honored only if it selects an option the
agent offered, and anything else (an unknown option, a throw, a malformed answer) becomes `cancelled`. A request with no
open turn, during a cancel, or naming a session other than the open one is `cancelled` without consulting the handler.
Options sharing an id are ambiguous and are `cancelled`; the handler gets a copy of the request and is bounded by a
snapshot of what was offered. The handler's answer is also discarded (`cancelled`) if its turn ended or was cancelled
while it decided. Pending requests are cancelled when `cancel()` (or `closeSession()`) is called. Each decision is
recorded as an `authority-decision` event; `decidedBy: "handler"` only when the handler's own valid answer is the one
returned (`handlerConsulted` says whether it was asked at all). File system and terminal methods are not advertised and
not served.

**After the session is over there is no authority event.** A `session/request_permission` that arrives after the agent
process has exited, after the ACP stream closed, after `close()` began, or after the agent accepted `session/close`
creates no `permission.requested` or `permission.decided`, does not consult the handler, and is answered `cancelled`. It
is recorded only as `harness.late-message` (`after`: `exit`, `stream-closed`, `close` or `session-close`) — the same
rule as a late `session/update`. The exit case is exercised with a descendant that holds the agent's stdout and stdin
open (`permission-after-exit` in the fake agent): the test asserts no `permission.*` event, no handler call, and the
`cancelled` answer that went over the wire. The session-close case is exercised too (`late-after-close`: the agent
answers `session/close`, then sends an update and a permission request). The stream-closed and `close()` branches are
defense in depth: the SDK connection is already closed when they hold, so no message can be delivered to exercise them;
they share the one guard that the other tests remove-and-fail.

## ACP v1 semantic coverage

### The exact schema used for validation

Recognized stable ACP v1 wire structures are validated against the JSON Schema the pinned SDK publishes through its
public `./schema/schema.json` export (`adapters/acp/schema.ts`). The SDK's generated zod validators are not public
exports and are not imported. The file is read from the installed package, hashed, and must equal the digest above
before any validator is built; an SDK bump that changes it fails loudly. `tests/acp-schema.test.ts` binds the digest, the
installed SDK version and the manifest pin together. `schema/v2/` is not read.

```
recognized ACP v1 message -> exact pinned v1 schema validation -> translation
```

- **Which messages.** Every stable `session/update` variant (`user_message_chunk`, `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`,
  `config_option_update`, `session_info_update`, `usage_update`), validated against that variant's own branch of
  `SessionUpdate`. And the responses the SDK does not check on the client side: `InitializeResponse`,
  `NewSessionResponse`, `ResumeSessionResponse`, `ListSessionsResponse`, `CloseSessionResponse`, `PromptResponse`.
  *SDK-validated, not adapter-validated:* the agent's `session/request_permission` request (the SDK parses it with its
  own zod schema before the handler runs).
- **Never a closed union.** The `session/update` router in the SDK drops variants it does not know, so updates are taken
  off the stream as raw values (see below) and dispatched on `sessionUpdate`. A variant the adapter does not translate
  is never run through `SessionUpdate`'s `oneOf`.
- **A known variant that fails the schema** is `runtime.malformed-event` (`problem: "schema-invalid"`), never counted.
  This covers nested values: a select option record that is `{}`, a group with no options, a boolean option with a string,
  a cost without a currency, a negative or fractional token count, a tool location without a path.
- **Strict is stricter than the reference.** The schema marks many optional fields `x-deserialize-default-on-error` and
  arrays `x-deserialize-skip-invalid-items`: the reference Rust deserializer treats a bad optional field as absent and
  skips a bad array item. Here a bad optional field or item makes the whole update malformed; nothing is "repaired" into
  evidence. That is a deliberate, stated divergence. The validator runs with Ajv strict mode on; the `x-*` annotations
  and `discriminator` are registered by name, so a keyword a later schema revision adds is a compile error. The numeric
  formats (`uint16/32/64`, `int32/64`, `double`) carry real range checks; `uint64`/`int64` are checked as JS numbers.
  `format: uri` is checked for a scheme prefix only.
- **UNSTABLE variants.** The pinned schema also lists `plan_update`, `plan_removed`, `notice`, `compaction_update`,
  `compaction_summary_chunk`, `subagent_update`, `session_message` and `session_message_chunk`, each described as
  "UNSTABLE: not part of the spec yet". They are not translated: they are observed as `runtime.unrecognized-event`
  (`schemaStatus: "unstable"`), not malformed. A test partitions the schema's variants into the stable and unstable lists
  and checks the schema's own `UNSTABLE` marking, so a new variant cannot slip into either unexamined.

### Unknown `session/update` variants are kept

The SDK's client app installs a router that parses every `session/update` with a closed union and throws on a variant it
does not know; the update is logged to the console and dropped before any handler runs. The adapter therefore takes
`session/update` notifications off the SDK stream as raw values (only a well-formed JSON-RPC 2.0 notification counts)
and passes everything else through. A variant it does not translate becomes `runtime.unrecognized-event` (name and
`schemaStatus` only: `unknown` or `unstable`) and `lifecycle.unrecognized-runtime-event`. It is counted as activity and
is not malformed merely because this adapter predates it. The session coordinate is
`endo.session.acp.<process instance>.<session id>`: ACP session ids are agent-local, so two launches would otherwise
merge.

### Update mapping

| Update | Recorded as | Kept | Never kept |
| --- | --- | --- | --- |
| `*_message_chunk`, `agent_thought_chunk` | an update count only | that a chunk occurred | text, content types |
| `tool_call`, `tool_call_update` | `session.update-observed` | id reference, name, kind, status, content/location counts, `rawInputPresent` / `rawOutputPresent` when the property is carried, `null` included | title, content, locations, raw input/output, any digest |
| `plan` | `session.update-observed` | entry count, counts by status | text, priorities |
| `available_commands_update` | `session.update-observed` | command count | names, descriptions |
| `current_mode_update` | `session.update-observed` | mode id reference | |
| `config_option_update` | `session.config-observed` | see below | labels, descriptions, value names |
| `session_info_update` | `session.update-observed` | `titled` (true when a title was set, false when cleared, absent when not mentioned) | title, time |
| `usage_update` | `session.update-observed` | `contextTokensUsed`, `contextWindowSize`, `cost {amount, currency}` when reported | |

### Tool activity

ACP exposes an agent-chosen id, an optional name, a kind, a status, and optional raw input and output values, with no
guarantee of a start/finish boundary (a `tool_call` can arrive already `completed`) and no keyed digest of arguments or
results. That is not the Pi `tool.started` / `tool.finished` contract, which needs keyed digests; the adapter does not
fabricate them. The observation is kept at `session.update-observed` (LOSSY), and the Pi-contract conversion is
UNREPRESENTABLE (`tool.contract`). A `tool_call_update` is partial: an absent field means "unchanged", never empty or
false (so `rawInputPresent` is only ever `true`).

### Usage

ACP's `usage_update` reports session context-window state — `used` tokens in context, `size` of the window — and an
optional *cumulative* session `cost`. That is not Endophasia's per-message input/output/cache/reasoning ledger, and it
is not converted into one: no category is split or synthesized and no `endophasia.usage.v0` event is produced
(`usage.ledger` is UNREPRESENTABLE; `lifecycle.session-started` declares `usage` UNAVAILABLE with that reason).
The pinned schema does define a per-turn `usage` object on the `session/prompt` response (input, output, thought, cached
read/write and total tokens), but marks it **UNSTABLE**. It is validated as part of `PromptResponse` and **not read**; a
test lists the schema properties the adapter reads and requires none to be UNSTABLE. Real OMP 18.6.1 does send it
(`{inputTokens, outputTokens, totalTokens}` on a `end_turn` response), so taking it is an open decision about reading
unstable fields, not something this tranche does. A cost
travels only with its currency (without a printable currency it is dropped and `costOmitted` says so); `cost: null` or
no cost is no cost field, never `0`.

### Configuration and model state

The `configOptions` of `session/new` and `session/resume`, the legacy session mode state, and later
`config_option_update`s are recorded as `session.config-observed` with an `origin`: option ids, `type`, `category`, the
current value id (or boolean) the agent reported, and the number of selectable values. These are the agent's own report
of its session configuration. They are **not a verified model identity**: nothing says which weights served a request
(`config.model-identity` is UNREPRESENTABLE). This tranche is observation-only: `session/set_config_option` and
`session/set_mode` are not implemented, so no request/effect pair exists. When a control path is added it must be
bounded to an advertised option and value, recorded as a request, and followed by observed state; an RPC response is
acceptance, not proof of effect.

### Optional session methods are capability-gated

`session/list`, `session/resume` and `session/close` are called only if `agentCapabilities.sessionCapabilities.<name>`
is a non-null object at `initialize` (`{}` is support; absent or `null` is not). Which were advertised is recorded in
`harness.acp-initialized.sessionMethodsAdvertised`. A call to an unadvertised method sends nothing, records
`control.unavailable`, and throws `AcpUnavailableErrorV0`; absence means UNAVAILABLE, not "probably supported". Not
advertising is a capability fact, kept apart from conversion loss in the accounting (`availability` vs `verdict`).

- `listSessions({cwd?, cursor?})` returns the agent's page to the caller. Session ids are opaque and agent-local (never
  assumed unique, UUID-shaped or a path). The record keeps only `count` and `hasNextCursor` (`session.listed`): no ids,
  directories or titles.
- `AcpClientV0.connect(options, { cwd, resume: { sessionId } })` opens the attachment's session with `session/resume`
  instead of `session/new`. It reattaches **without** a claim that history was replayed to the client (that is
  `session/load`, not implemented): `harness.attached` carries `openedBy: "session/resume"` and
  `historyReplay: "not-requested"` (nothing is claimed about what the agent did). The new process instance has a new coordinate and `lifecycle.session-started`, not
  `lifecycle.session-resumed`: Endophasia has no record of an earlier attachment under that coordinate, so
  `previousInstance`/`previousEnd` would be invented. The same agent-local id on two instances stays two coordinates.
- `closeSession()` sends `session/close`. ACP requires the agent to cancel the session's work first, so an open turn is
  treated as a cancellation (`lifecycle.stop-requested`, pending permissions answered `cancelled`). The response is
  recorded as `session.close-accepted`: the agent's acceptance, not proof that anything was freed. It does not end the
  process (`close()` does), and after it prompts are refused and late traffic is `harness.late-message`.

## Loss accounting

Machine-readable and versioned: `ACP_LOSS_ACCOUNTING_V0` (`adapters/acp/loss.ts`), schema version
`endo.acp-loss-accounting.v0`, carrying the mapping version and the pinned schema identity. Verdicts, and only these:

- **EXACT** — the Endophasia target preserves every semantic fact that target contract needs.
- **QUALIFIED** — the same concept is representable, but its evidence basis or scope differs; the qualification travels
  with it.
- **LOSSY** — a valid projection exists, but known source information is intentionally omitted or collapsed.
- **UNREPRESENTABLE** — mapping it would invent semantics or claim more than the source supports; nothing is projected
  and only the honest ACP observation is kept.

Availability is a different fact and has its own field: `baseline` (ACP v1 requires it), `capability-gated` (the agent
must have advertised it), `agent-initiated` (the agent chooses to send it), `adapter-observed` (the adapter's own
observation). "The agent did not advertise it" and "ACP cannot represent this Endophasia concept" are not confused.

Two rules keep the lists honest. **Free-form strings the agent chooses** (agent name and version, auth method ids, tool
names, option ids and categories, mode and tool-call ids) are projected *by reference*: verbatim when short and printable
ASCII, otherwise a `sha256-…` digest, so a valid value is never turned into "absent". (A currency is the exception: a
digest would destroy its meaning, so a cost with an unrepresentable currency is dropped and flagged `costOmitted`.) And
each entry names the schema properties it carries (`projects`); every other property of those definitions is listed in its
`lost` as `Definition.property`, derived from the pinned schema, so a field the schema defines cannot go unaccounted for.

Tests (`tests/acp-loss-accounting.test.ts`) require: a verdict for every stable update variant (the module fails to load
without one), every event kind the adapter source can emit to appear in some entry's `emits` (and the reverse), every
optional method to carry its capability gate, non-EXACT entries to say what they lose or qualify, UNREPRESENTABLE entries
to emit nothing, the Windows qualification to remain, the table to be tied to the mapping and schema digest, and every
entry id and verdict to appear in this document.

The important non-EXACT cases: tool activity vs the Pi contract (UNREPRESENTABLE), usage vs the per-message ledger
(UNREPRESENTABLE), model identity from configuration (UNREPRESENTABLE), thought content as reasoning evidence
(UNREPRESENTABLE), session identity (QUALIFIED: instance-scoped), prompt end (QUALIFIED: `end_turn` is not proof of work),
cancel (QUALIFIED: a notification with no acknowledgement), resume and close (QUALIFIED), message/thought chunks, plans,
commands and permission requests (LOSSY: content omitted by design), and Windows process containment (QUALIFIED).

| Entry | Verdict | Availability | Target | Lost / qualification |
| --- | --- | --- | --- | --- |
| `session.identity` | QUALIFIED | baseline | endo.session.acp.<instance>.<id> coordinate | — an ACP session id is unique to nothing but the agent that issued it: the coordinate carries the launched process instance, and two instances (or two agents) can issue the same id. No relation between coordinates is asserted. |
| `session.open.new` | QUALIFIED | baseline | harness.attached, lifecycle.session-started | lost: working directory; mcp server list ACP v1 reports no run id, turn id or turn count; they are declared UNAVAILABLE on lifecycle.session-started, never zero. |
| `session.open.resume` | QUALIFIED | gated: `sessionCapabilities.resume` | harness.attached, lifecycle.session-started | lost: working directory; the relation to the earlier attachment resume reattaches without the agent replaying history to the client (that is session/load, not implemented). The new process instance gets a new coordinate and lifecycle.session-started, not lifecycle.session-resumed: Endophasia holds no record of the earlier attachment under this coordinate, so previousInstance/previousEnd would be invented. |
| `session.list` | LOSSY | gated: `sessionCapabilities.list` | session.listed | lost: session ids; working directories; titles; update times; the cursor; SessionInfo.additionalDirectories the caller receives the full agent-reported page; the record keeps counts only. |
| `session.close` | QUALIFIED | gated: `sessionCapabilities.close` | control.requested, session.close-accepted | — a JSON-RPC response is the agent's acceptance, not proof that work was cancelled or resources freed. No lifecycle end is derived; the process end is recorded separately. |
| `capability.advertisement` | QUALIFIED | baseline | harness.acp-initialized | lost: auth method names; capability fields over the size bound; Implementation.title; AuthMethodAgent.name; AuthMethodAgent.description agentInfo is the agent's own claim, not a verified identity of the executable. |
| `capability.unavailable` | EXACT | adapter-observed | control.unavailable | — |
| `prompt.request` | QUALIFIED | baseline | control.requested, lifecycle.run-started | lost: the prompt text, by design ACP v1 has no run-start notification and no run or turn id: the run start is the client's own request (basis: client-sent-session-prompt). |
| `prompt.response` | QUALIFIED | baseline | agent.prompt-responded, lifecycle.run-completed \| run-aborted \| run-unclassified | — end_turn is the agent's report that the turn ended, not proof that provider work happened; max_tokens, max_turn_requests and refusal are run-unclassified, not failures; a cancelled stop reason is the agent's report, and whether the operator's request caused it is not inferred. |
| `prompt.error` | LOSSY | agent-initiated | agent.prompt-failed, lifecycle.run-failed | lost: the error message and data cause is { source: jsonrpc-error, code }, not the Pi-shaped assistant-message cause. |
| `prompt.timeout` | EXACT | adapter-observed | harness.prompt-timeout | — |
| `cancel` | QUALIFIED | baseline | control.requested, lifecycle.stop-requested | — a notification: ACP gives no acknowledgement, and it names the session, not one turn (stop.target is UNAVAILABLE). |
| `permission.request` | LOSSY | agent-initiated | permission.requested | lost: option ids and names; the tool call title and content; raw input; ToolCallUpdate.kind; ToolCallUpdate.status; ToolCallUpdate.title; ToolCallUpdate.name; ToolCallUpdate.content; ToolCallUpdate.locations; ToolCallUpdate.rawInput; ToolCallUpdate.rawOutput; PermissionOption.name |
| `permission.decision` | LOSSY | adapter-observed | permission.decided (authority-decision) | lost: the selected option id fail-closed: absent a valid handler selection of an offered option the answer is the agent's reject_once, else cancelled. Traffic after exit, close or session close creates no authority event (see message.late). |
| `update.user_message_chunk` | LOSSY | agent-initiated | an update count (no event) | lost: the content; content block types; message ids; ContentChunk.content; ContentChunk.messageId text is never stored. |
| `update.agent_message_chunk` | LOSSY | agent-initiated | an update count (no event) | lost: the content; content block types; message ids; ContentChunk.content; ContentChunk.messageId text is never stored. |
| `update.agent_thought_chunk` | LOSSY | agent-initiated | an update count (no event) | lost: the content; content block types; message ids; ContentChunk.content; ContentChunk.messageId text is never stored. |
| `update.tool_call` | LOSSY | agent-initiated | session.update-observed | lost: title; content; locations; raw input and output values; ToolCall.title agent-reported; a tool_call_update is a partial update, so an absent field means unchanged, not empty. |
| `update.tool_call_update` | LOSSY | agent-initiated | session.update-observed | lost: title; content; locations; raw input and output values; ToolCallUpdate.title agent-reported; a tool_call_update is a partial update, so an absent field means unchanged, not empty. |
| `update.plan` | LOSSY | agent-initiated | session.update-observed | lost: entry text; priorities; PlanEntry.content; PlanEntry.priority |
| `update.available_commands_update` | LOSSY | agent-initiated | session.update-observed | lost: command names, descriptions and input hints; AvailableCommand.name; AvailableCommand.description; AvailableCommand.input |
| `update.current_mode_update` | QUALIFIED | agent-initiated | session.update-observed | — the agent's report of its own mode; its meaning is the agent's. |
| `update.config_option_update` | QUALIFIED | agent-initiated | session.config-observed | lost: see config.observation observed state after the agent changed its configuration; not evidence of effect on later requests. |
| `update.session_info_update` | LOSSY | agent-initiated | session.update-observed | lost: the title; the update time; SessionInfoUpdate.updatedAt |
| `update.usage_update` | QUALIFIED | agent-initiated | session.update-observed | — see usage.ledger for what it is not. |
| `update.unstable` | LOSSY | agent-initiated | runtime.unrecognized-event, lifecycle.unrecognized-runtime-event | lost: every field not translated: the schema says they may be removed or changed at any point. |
| `update.unknown` | LOSSY | agent-initiated | runtime.unrecognized-event, lifecycle.unrecognized-runtime-event | lost: every field not malformed merely because this adapter predates it. |
| `update.malformed` | LOSSY | agent-initiated | runtime.malformed-event | lost: every field never counted as update activity. |
| `protocol.fault` | LOSSY | adapter-observed | harness.protocol-fault, lifecycle.run-unclassified | lost: the offending message and its fields a rejected initialize, session/new or session/resume response fails the attachment. |
| `message.late` | LOSSY | adapter-observed | harness.late-message | lost: everything the message carried never counted, never decided: no update count, no permission.requested/decided, no handler call, no approval. |
| `config.observation` | QUALIFIED | agent-initiated | session.config-observed | lost: option names, descriptions and value labels; the values themselves; options past the 32nd; SessionConfigOption.name; SessionConfigOption.description; SessionConfigSelectGroup.group; SessionConfigSelectGroup.name; SessionMode.id; SessionMode.name; SessionMode.description; SessionConfigSelectOption.value; SessionConfigSelectOption.name; SessionConfigSelectOption.description agent-reported session configuration: what the agent advertised and what it says is current. Not a verified model identity. |
| `config.model-identity` | UNREPRESENTABLE | agent-initiated | verified model or weights identity | — an agent's claim about a setting does not establish which weights served a request. No request to change an option is implemented (session/set_config_option is out of scope), so no request/effect pair exists either. |
| `usage.context-window` | QUALIFIED | agent-initiated | session.update-observed (contextTokensUsed, contextWindowSize) | — session/context-window state, not a count of tokens a turn consumed. |
| `usage.cost` | QUALIFIED | agent-initiated | session.update-observed (cost) | lost: a cost whose currency is not short printable ASCII: neither amount nor currency is carried (costOmitted: true) cumulative cost for the session, not per message; an amount travels only with its currency; absent cost is absent, not zero. |
| `usage.ledger` | UNREPRESENTABLE | agent-initiated | endophasia.usage.v0 per-message input/output/cache/reasoning ledger | — the stable ACP v1 surface reports no per-message token categories. The pinned schema also defines a per-turn `usage` object on the session/prompt response (input, output, thought, cached read/write, total tokens) but marks it UNSTABLE: it is validated as part of PromptResponse and not read, so nothing is split, summed or synthesized from it. lifecycle.session-started declares usage UNAVAILABLE. Taking that field would be a separate decision about unstable fields. |
| `tool.contract` | UNREPRESENTABLE | agent-initiated | Pi tool.started / tool.finished (keyed argument and result digests) | — ACP exposes an agent-chosen id, optional name, kind, status, and optional raw input/output values, with no start/finish boundary guarantee (a tool_call may arrive already completed) and no keyed digest. Digests are not fabricated from values ACP did not provide in that form; what is observed is kept at the session.update-observed level above. |
| `reasoning.content` | UNREPRESENTABLE | agent-initiated | reasoning evidence or reasoning-token accounting | — thought chunks are agent-selected display content, not a reasoning-token ledger and not a verified chain of thought. Only their occurrence is counted. |
| `transport.closed` | QUALIFIED | adapter-observed | harness.protocol-fault (connection-closed), teardown | lost: why it ended the attachment is unusable from that moment, before the diagnostic wait. |
| `process.exit` | EXACT | adapter-observed | harness.process-exited, lifecycle.detached \| lifecycle.interrupted | — |
| `process.containment` | QUALIFIED | adapter-observed | owned process-group teardown at close() | — on Windows the shared ProcessGroupV0 has no job-object containment: only the launched command is ended and descendants are not. This tranche does not change that. |

What is **not implemented** (unsupported, not lossy; nothing is projected or called): `session/load`, `fork`, `delete`,
`session/set_config_option`, `session/set_mode`, `authenticate` / `logout`, `fs/*` and `terminal/*` (not advertised, not
served), UNSTABLE `session/update` variants beyond their name, and ACP v2.

## Known limits

- Requests are raced against the agent process's exit, because a descendant can keep the agent's stdout open after the
  agent ended. If the agent answers and exits at nearly the same moment, the exit can be seen first and the turn is
  recorded as interrupted; that is the conservative reading.
- A message from a process the adapter has declared gone (a descendant holding stdout), or arriving after the stream
  closed, `close()` began or the session was closed, is recorded as `harness.late-message` and never counted, decided
  or approved.
- A closed ACP stream under a living agent makes the attachment unusable at once (no prompt, cancel or approval), then
  a fault is recorded and the group ended.
- A line that is not JSON is answered by the SDK with a JSON-RPC parse error and never reaches the adapter, so it is not
  recorded as a fault by itself.
- `promptTimeoutMs` only stops the caller waiting (`harness.prompt-timeout`). The turn stays open: if the agent answers
  later (for example after `cancel()`), that answer is recorded as the agent's report. An agent that never answers is
  ended by `close()`, which records `lifecycle.interrupted` once the process is gone; `close()` during an awaited turn
  does not blame the agent (`AcpClosedErrorV0`, no fault event).
- Strict validation can reject an agent the reference deserializer would tolerate (see above). A rejected `initialize`,
  `session/new` or `session/resume` response fails the attachment; a rejected update is recorded as malformed.
- Windows: no descendant containment (see above).

### Deviations from the declared lifecycle shapes

The existing session-overview reducer (`runtime/contracts/session-overview.ts`) reads the ACP events without anomalies,
but the declared shapes in `protocol/session-lifecycle.ts` are Pi-shaped, and ACP v1 does not fit them everywhere. None
of this changed a core schema; each is stated here instead:

- `lifecycle.*` payloads omit `turns` and `turnOpen`: ACP v1 reports no turn count. The overview therefore shows 0 turns
  (the reducer's fallback), which is declared in the session start's `unavailable` list as `turns`, not a count.
- `lifecycle.run-failed.cause` is `{ source: "jsonrpc-error", code }`, outside `EndoReportedCauseV0`'s two sources
  (assistant message, retry loop).
- Extra fields: `basis` on `run-started`; `stopRequested` and `stopReason` on the run ends; `reason` and `stopReason` on
  `run-unclassified` for `max_tokens`, `max_turn_requests` and `refusal`; `openedBy` on `session-started`.
- `runtime: "acp"` on `lifecycle.session-started` names the protocol surface, not the agent. The agent's own claim is in
  `harness.acp-initialized.agentInfo`.

## Tests, and what was exercised against what

- `npm test` runs the deterministic suite — `tests/acp-adapter.test.ts`, `tests/acp-semantics.test.ts`,
  `tests/acp-schema.test.ts`, `tests/acp-loss-accounting.test.ts`, `tests/acp-boundary.test.ts` — against a fake agent
  (`tests/fixtures/fake-acp-agent.ts`, built on the SDK): no OMP, network, model or credentials. **Everything above is
  exercised there.** It is the acceptance gate.
- Real OMP is opt-in: `ENDO_OMP_EXECUTABLE=/path/to/omp npm run test:acp-omp-real`. The child receives only `PATH` and
  `HOME` plus any variable names listed in `ENDO_OMP_ENV_PASSTHROUGH` (comma-separated), so OMP finds the operator's
  existing configuration; values are never printed. It may use the operator's configured model and cost money. It skips,
  with the reason, when `omp` is missing or has no `acp` command, when `session/new` or `session/prompt` is refused, or
  when the prompt completes with no message, thought or tool-call update (OMP ends a failed model call with `end_turn`,
  so an unconfigured model looks like that). A wrong protocol version, a hang, a surviving child, a malformed update or a
  protocol fault fails. It then exercises `session/list`, `session/resume` (a second process instance) and
  `session/close` **only if OMP advertised them**, and prints an `[acp-omp-report]` line: executable version, negotiated
  version, agent capabilities, which optional methods were advertised and exercised, the update variants observed, the
  event kinds seen and the loss verdicts of the entries involved.
- **Real OMP 18.6.1** (`~/.bun/bin/omp acp`, run once for this tranche): negotiated ACP 1; advertised `list`, `fork`,
  `resume` and `close`; `list`, `resume` (second process) and `close` were all exercised and accepted. Observed update
  variants: `agent_message_chunk`, `available_commands_update`, `config_option_update`, `session_info_update`,
  `usage_update`, all passing strict schema validation (no malformed update, no protocol fault). Not exercised against
  OMP: tool calls, thoughts, plans, mode updates, cost, permission requests, cancel, anything unstable. Those are
  covered by the fake agent only. This is one prompt of one OMP build, not a conformance result and not an admission of
  any capability beyond the surface it touched.
