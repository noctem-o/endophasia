# DEVELOP workbench: design for a governed live Pi session

Status: **slices A and B are implemented; later slices are design.** This document fixes the authority boundary, the privacy rules and the
slicing of the live DEVELOP workbench. Implemented in slice A (see section 8): the opt-in broker, pairing and the grant, terminal
approval, the live status, the memory-only transcript, the **prompt** command and its record chain, and the workbench interface.
Implemented in slice B (section 13): **STEER / QUEUE / STOP** through the broker onto the existing intervention chain, behind the same
terminal approval for every one. Not implemented: the OMP adapter, streaming, Git changes, any terminal surface, any weaker approval
mode. Read [studio.md](studio.md) (the read-only Studio and today's recorded-session DEVELOP), [steering.md](steering.md)
(the intervention chain) and [pi-attach-inventory.md](pi-attach-inventory.md) first.

Product split this design keeps explicit:

| Workspace | Is for | Authority |
| :--- | :--- | :--- |
| **DEVELOP** | working with an agent: read its conversation, follow its run, give it an authorised instruction, review what it did | read, plus a **separate, opt-in** command boundary (below) |
| **OBSERVE** | the forensic instrument: recorded events, evidence, provenance and limits | read only |
| **COMPARE** | differences across recordings | read only |

## 1. What exists today, and what that rules out

- `endo studio` is a **read-only** server (`cockpit-http/`): loopback, per-launch capability, GET only, no CORS, a CSP with
  `connect-src 'self'`. Its recorded-session DEVELOP lists **recordings**, never live sessions.
- Canonical events **withhold message text, tool arguments and results** (`adapters/pi/mapping.ts`): only keyed digests. The
  mapping returns runtime-written failure text beside the event for the caller to keep *outside* evidence. So a recorded session can
  show a *structural* transcript (turns, tool names, outcomes, usage) but not what was said.
- Message text first exists in **live Pi events** received by the attached process (`PiSessionAttachmentV0.#onEvent`,
  `adapters/pi/attachment.ts`). That process already owns the Pi child, the store's single writer lock and, with
  `endo harness attach <root> --control`, the intervention desk served on a `0700`/`0600` Unix socket (`cli/control.ts`).
- Control today is `propose → authorize → apply` for **STEER / QUEUE / STOP** (`docs/steering.md`); the local authority "allows
  a proposal only when given its exact digest" and the audit states plainly that this confirmation is **not authentication**. There is
  no control message for a new **prompt**: `--prompt` sends one at attach time, and `RpcClient.prompt` exists.
- "Currently attached" has **no recorded source**. A recorded `running` is never evidence of a live process.

Consequences: (a) live control and live text can only come from the attached process; (b) the existing read-only Studio must not
become the thing that holds that authority; (c) the existing digest-confirmation is not safe to expose to a browser unchanged.

## 2. The smallest auditable boundary: a workbench broker in the attached process

```
endo harness attach <root> --control --workbench        (explicit opt-in; absent by default)
        |
        |  owns: Pi child, store writer lock, intervention desk, live Pi events
        v
 workbench broker  ── its own loopback listener, its own per-launch capabilities
        ├─ GET  page + assets          (the same closed frontend bundle, served from memory)
        ├─ GET  read API               (the same cockpit read routes, over the same store, read-only)
        └─ POST command routes         (a closed list; see section 4)

endo studio <root>     unchanged: read-only, no command route exists in that server, ever.
```

**Decision (recommended, for the operator to confirm): the broker serves the workbench page itself.** The frontend's CSP is
`connect-src 'self'`, so a page served by Studio cannot call a second origin, and Studio forwarding commands would make the
read-only server hold execution authority. With the broker serving the page, Studio keeps zero command surface and the broker is
the only writable boundary, small enough to audit on its own. The broker reuses the existing server module through one optional,
host-supplied route provider (absent for Studio; tests pin that Studio's behaviour is byte-identical without it).

What the broker refuses to be: a shell, a PTY, a raw Pi RPC passthrough, a generic job runner, or a way to attach to a Pi that
**another tool** started. It controls only the Pi child *this* attach process launched, so nothing is silently taken over.

## 3. Browser-to-operator authorisation contract

Threats and how the contract answers each:

| Threat | Control |
| :--- | :--- |
| Loopback request attack, DNS rebinding | Host must be exactly the broker's loopback authority; Origin **required and equal** on every POST (not merely "not foreign"); `Sec-Fetch-Site: same-origin`; no CORS, ever. |
| Cross-origin / CSRF | POST only; `Content-Type: application/json` exactly; a custom header carrying the grant (so a cross-origin form cannot send it and a cross-origin fetch needs a preflight the broker never allows); no cookies, no ambient credentials. |
| The read capability is not authority | The page URL capability only **reads**. Commands need a separate **operator grant** that is never in a URL. |
| Pairing / session fixation | The grant is obtained by typing a one-time pairing code shown **only on the attached process's controlling terminal**; the code is single use, expires in 5 minutes, is rate-limited, and is bound to the Origin and to this launch. A grant is held **in page memory only** (CSP forbids storage), expires with the session, and is revoked on disconnect. |
| Browser compromise / script confirming its own request | **The browser can request but cannot authorise.** Each command is a *proposal* whose exact digest the operator confirms by typing a phrase on the **controlling terminal** of the attached process (the model of the terminal-governed A/A operator). A page script cannot type there. A later, explicitly weaker "browser-confirmed" mode is out of scope and must be separately designed. |
| Stale attachment, substitution | Authorisation is bound to the exact payload digest, the session alias, the attachment and the broker's launch id; the existing gate refuses another session, another attachment, a tampered proposal and an expired authorisation (15 minutes maximum; single use). |
| Replay | Proposal ids are derived from the digest; an authorisation is consumed once; `apply` is idempotent (the existing desk returns the recorded request and sends nothing). |
| Concurrent or duplicate actions | One command in flight per kind; duplicates return the recorded outcome; a second prompt while a run is open is refused (not queued silently). |
| Operator disconnect during an action | The action's record chain continues in the attached process regardless of the browser; reconnect shows the recorded state, never "failed" by inference. |
| Disposal | On close, SIGINT or SIGTERM the broker stops accepting commands, waits (bounded) for in-flight applies as `close` does today, clears the transcript, revokes grants and closes the listener. |
| Accidental disclosure | The grant, pairing code, access capability and transcript text never appear in logs, errors, canonical evidence, the read API or exported records. Responses are `no-store`. |

If any of this proves too large for one reviewable change, the first slice ships the broker **read-only for the live view**
(connection state and conversation) and adds the single command afterwards; the contract above does not change.

## 4. Commands: a closed list, with different semantics kept apart

| Command | Kind | Semantics | Record chain |
| :--- | :--- | :--- | :--- |
| `prompt` | **new user message** (not an intervention) | accepted only when the session is idle; Pi's disposition is *acceptance*, never completion | new broker chain: requested → authorised → dispatched → accepted/refused; the existing `control.requested/accepted` events remain the runtime-fact record of the send |
| `steer` | intervention | after the current turn's tool calls, before the next model call | the **existing** chain (proposal → authorization → request → acceptance → consumption → consequence) |
| `queue` | intervention | only when the agent has no more tool calls or steering | existing chain |
| `stop` | intervention | `abort`; Pi answers once idle | existing chain |
| `status` | read | live connection and run state | none |

Five states are never merged in the UI or the API: **requested**, **authorised**, **dispatched**, **runtime-accepted**,
**observed-consumed/completed**. HTTP acceptance of a request means *requested* only. Disabled commands say why (no admitted
capability, session ended, no active run, authorisation expired, operator has not approved).

Slice A implemented `prompt` and the read-only live view. Slice B implements STEER, QUEUE and STOP on the existing chain behind the same
terminal approval (section 13).

## 5. Presence and state (never inferred from recordings)

Live state comes from the attached process, not the log. The broker reports a closed set: **connected / run active / waiting
(idle) / disconnected / unknown**, plus per-command **pending / failed**. A page that cannot reach the broker says
*unreachable*, which is **not** "ended" (an unreachable broker could be a network or process failure). Recorded sessions keep their
"as recorded" wording and are labelled recorded-only.

## 6. Transcript privacy

- A live transcript is built from live Pi events **inside the attached process**, held **in memory only**, bounded (messages and
  bytes), and served only to a grant holder over the broker. It is **cleared when the session ends**, on close and on crash
  (nothing is written to disk by this feature).
- It is **never** written into canonical evidence, the runtime-text side store, logs, errors, exports, or the read-only Studio API.
- Missing text is never reconstructed from digests or tool names. A recorded-only session shows the structural transcript with text
  marked *withheld by design*; a live session shows text only for messages the live events actually carried, and says when a message
  arrived before the broker started and so has no text.
- Tool arguments and results are folded and are shown, if at all, only in the live view under an explicit reveal; they are not
  copied anywhere.

## 7. Updates and performance

No streaming transport in the first slice. The page polls **only on explicit action or a bounded, operator-enabled interval** the
broker itself serves from memory: a cursor over the in-memory transcript (watermark = message sequence number), size-capped, with no
whole-store read per update. The existing cockpit reader remains explicit-refresh only. Streaming (SSE) is deferred until
ownership, backpressure, reconnection and its security semantics can be implemented and tested.

## 8. Slicing

| Change | Contents |
| :--- | :--- |
| **A (implemented)** | broker boundary (`--workbench`), pairing and grant, terminal approval, live status, in-memory transcript, the **prompt** command with its record chain, the workbench UI (conversation, composer gated by capability and grant, run state), security and integration tests: unit, HTTP, a real fake-Pi process, a real pseudo-terminal, and a real browser. |
| **B (implemented)** | STEER / QUEUE / STOP through the broker onto the existing chain; accepted-versus-consumed display. See section 13. |
| **C** | OMP adapter behind the same typed command/event boundary; richer transcript; Git changes; optional terminal surface. |

## 9. OMP compatibility assessment (from the public RPC page; nothing was installed or run)

Source: <https://omp.sh/docs/rpc>. This is a documentation review, not an execution result.

| Concern | OMP `--mode rpc` as documented | Fit for the Endophasia boundary |
| :--- | :--- | :--- |
| Transport | NDJSON over stdin/stdout; stdout is protocol only, diagnostics on stderr | Same shape as Pi (`adapters/rpc-jsonl`); stderr must not be merged |
| Startup | wait for `ready` (`protocolVersion`, `supportedProtocolVersions`, `maxFrameBytes`, `maxReassembledFrameBytes`) | a typed ready negotiation; the page does not say `ready` is always first |
| Frame limits | v1: one object per line, ≤ `maxFrameBytes` (currently 1 MiB); v2 (opt-in via `negotiate_protocol`): `rpc_chunk` frames with `chunkId`, `index`, `count`, `byteLength`, base64 `data`, reassembled ≤ 64 MiB, strict UTF-8 | adapter must enforce both limits and the chunk rules; v1 oversize becomes an error or `rpc_frame_error`; an oversized `agent_end` may omit messages |
| Version negotiation | `negotiate_protocol` → still a v1 response, then v2 framing | failure behaviour is **not documented**: treat any non-success as v1 |
| Prompt | `prompt` acknowledges *scheduling*, not completion; run complete at `agent_end` (`isTerminal` not `false`); `agentInvoked: false` for local-only handling | maps cleanly to requested → accepted → observed-completed; correlate by `id` (responses and events may interleave) |
| Steering / queue / cancel | `steer`, `follow_up`, `abort`, `abort_and_prompt`; behaviour of `steer`/`follow_up` with no active run **not documented** | capability must be admitted by evidence, as for Pi; never assumed |
| Message / tool events | `agent_start/end`, `turn_*`, `message_*` (`assistantMessageEvent`: `text_*`, `thinking_*`, `toolcall_*`), `tool_execution_*` | transcript source; thinking text is sensitive and must stay out of evidence |
| Usage | `usage` on assistant messages (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`); `get_session_stats` | maps to existing usage vocabulary, reported never summed |
| Sessions | persisted in OMP's normal store unless `--no-session`; `get_state` exposes `sessionId`/`sessionFile`; `switch_session`, `new_session`, `branch` | discovery and location **not documented** on this page; adapter must not guess paths |
| Subagents | `set_subagent_subscription` (`off`/`progress`/`events`), `subagent_lifecycle`, `subagent_progress`, `subagent_event`, `get_subagent_messages` (`fromByte`, `reset`) | needs a nested-activity notion the Pi adapter lacks; default `off` |
| Extension UI | `extension_ui_request` (`select`, `confirm`, `input`, `editor`, `notify`, …); host must reply to the first four; a host that ignores callbacks **can deadlock** the run | same policy as Pi today: answer `cancelled`, record it; never forward to the browser in the first slice |
| Host tools / URIs | `set_host_tools`, `set_host_uri_schemes` (the host executes tools and URI I/O) | **refused**: would let the host expose execution; not admitted |
| Shell | `bash`, `abort_bash` | **refused**: generic shell, outside the closed command list |
| Unknown events | ignore or log; new optional fields and events can appear without a version change | unknown must be recorded as unrecognised, never dropped or interpreted |
| Shutdown | close stdin: pending callbacks rejected, accepted commands drained, exit 0; broken stdout = transport failure with unknown completion | map to the same disconnect/unknown states; never claim completion |
| Authentication, sandboxing | **not described** | assume none: the boundary is the broker, not OMP |

**Recommended adapter boundary.** A harness-neutral `LiveHarnessV0` interface in the attached process with: an event source that
yields typed, size-bounded frames; a closed command set (`prompt`, `steer`, `queue`, `stop`, `status`); a declared capability set
each command must be admitted against; and a transcript sink that is memory-only. The browser, the broker routes and the UI depend
only on this interface and the shared presentation records, never on Pi or OMP frame names. OMP-specific facts (chunking, `ready`,
`agentInvoked`, subagent frames) live in its adapter. Not built in this change.

## 10. Tern and terminal strategy (recommendation only)

Source: <https://docs.stencil.so/tern/protocol/>. The Tern Surface Protocol (TSP) lets a program running in a Tern terminal pane
describe its UI as a semantic tree sent **in-band in the pane's pty output**; Tern lays it out, draws and animates it, and events
flow back (`ack`, `change`, `action`, `gone`, `toggle`). It is a **rendering protocol between a program and Tern**, not a control
API for agents or harnesses, and the page says nothing about web embedding, licensing or package names.

Recommendation: keep the browser conversation **React-native and semantic**; keep control through **typed adapters**; keep evidence
in Endophasia's validated substrate. Do **not** emulate TSP, depend on Tern, or add a generic PTY server or multiplexer. If a
terminal surface is wanted later, add it as a **separate, optional, explicitly authorised read-mostly surface** over a PTY the
broker itself launched (never one it did not), with its own threat model (a PTY is arbitrary execution), and treat a Tern companion
as a possible *native* presentation of the same typed conversation model rather than a transport for it.

## 11. Workbench interface (Opus design advisory, initial pass)

Accepted into the design, with the reconciliations below. The workbench is where one *works*; Observe stays the instrument.

**Critique of today's DEVELOP.** The centre is the canonical event table, the inspector is evidence tables, there is no conversation
shape (user, assistant, tool and notice rows are not told apart; turns and tools exist only as counts), the withheld/position/clock
caveats repeat in three panels, and the top bar's "Read-only" chip would become false beside a composer. The narrow-screen Escape handler
pops the stage without checking focus, so inside a composer it would leave the stage mid-draft (to fix with the same input guard the
`r` shortcut has).

**Composition.** Left *Sessions* (groups **Connected**, from the broker's current admission, and **Recorded**, from the store; one alias
may appear in both and is linked by text). Centre *Conversation*: a **run strip** directly above a structured transcript, the
**composer** docked below it only when an admitted input path exists. Right *Context*: concise runtime identity, capabilities, usage
per run, notices, interventions and a link to Observe, at most six facts per block. At 1024-1359 px Context becomes an inset drawer
opened from the run strip; at 768 px and below one stage at a time with a sticky run strip and composer. STOP lives in the run strip
(a control on the run, not a message). The top-bar chip changes from "Read-only" to the real state ("Controls: off" or "on for 1
session").

**Transcript rows.** One row per item: role gutter, body, right-aligned meta (outcome, usage, an *Evidence ›* link into Observe, a small
basis mark). Tool calls are named from the reported `toolName` field and always folded; runs of three or more collapse to "5 tool calls
(1 error)"; errors, refusals and interventions are never folded. A **recorded-only** session draws its structure with a hatched
"text not recorded · structure only" body (fixed width, no shimmer, never a skeleton). **Live text** carries the tag "live · private,
cleared at session end" and is rendered as plain `textContent` with `white-space: pre-wrap` (no markdown or HTML, so the CSP and
Trusted Types are untouched). Live and recorded material are never mixed in one row without the tag. A settled turn has a solid left
rule, the open turn a dashed one with "turn open (as of last read)"; no row spinner.

**Wording by state (never implying more than known).**

| State | Wording |
| :--- | :--- |
| connected row | "connected · admitted by the broker at HH:MM (browser clock)" |
| unreachable | "connection unknown: the broker did not answer" (never "ended") |
| disconnected | "disconnected: no admitted connection now" |
| recorded-only / unknown | no composer, no controls: "No input path: this session has no admitted connection. Recorded sessions can be read, not driven." |
| connected, capability not admitted | disabled control with the reason ("steering.steer is not admitted by conformance evidence for this runtime") |
| run state | "run active · turn k", "idle", "run ended: completed / aborted / failed (reported by Pi)"; "waiting" only when the runtime reports it |
| action failed | "Failed: reason. Nothing was sent." or "Failed after dispatch: the runtime's reply is unknown." |

**Reconciliations with the authority design (this section governs).**
- The advisory sketched an in-browser **[Authorise]** button. **Rejected for the first slice**: authorisation is typed on the
  controlling terminal (section 3). The browser shows the proposal, its short digest and "Waiting for operator approval in the attached
  terminal. Expires by HH:MM. Single use. A local confirmation, not proof of identity." There is no browser button that grants authority.
- The advisory listed Steer/Queue/Stop in the composer. In slice A only **Prompt** existed. Slice B adds Steer and Queue as modes of the
  composer (a mode is never switched for the operator) and puts **Stop in the run strip**, since it is a control on the run and not a
  message; all three are behind the same terminal approval.
- "Start Studio with control authority" is wrong: control authority is the broker's `--workbench`, never Studio.
- The earlier read-only advisory's rejection of attach/resume/stop affordances still holds for recorded-only, disconnected and unknown
  sessions; it lifts only for a session currently admitted by the broker, per admitted capability.
- Liveness has its own mark family (notched pentagons: solid connected, hollow disconnected, dashed unknown) and never borrows the
  recorded-lifecycle squares or the provenance hues. Mode labels and capabilities come from the broker's advertised capabilities, not
  from hard-coded Pi verbs, so OMP and Codex map onto the same slots or show "not offered by this harness".

**Components.** `DevelopShell`, `SessionRail`, `RunStrip`, `Transcript` (`TurnRow`, `ToolRow`, `NoticeRow`, `InterventionCard`,
`WithheldBody`), `Composer`, `ContextPanel`. Reuse `Panel`, `.btn`, `.chip`, `.note`, `FactsView`, `.caprow`, the dialog pattern and
small `ProvGlyph` marks. Do **not** reuse `EventView`, the `.events` table, the position/coverage lines, the category chips or a
`ConditionTag` headline in the main column.

**Accessibility.** The transcript is an `<ol aria-label="Conversation">` of articles, **not** `role="log"` (it would announce every
row). One polite live line in the run strip, throttled to one announcement per 5 s, carries state changes only; chain steps use a second
throttled region. The composer is a `<form>` with a mode `<fieldset>`, a `<textarea>` described by the delivery-semantics hint and any
disabled reason, **Ctrl/Cmd+Enter** to send (ignored while composing; plain Enter is a newline; nothing sends under a default mode).
Escape inside the composer stays in the composer. Shortcuts (`j`/`k`, `o`, `.`, `r`) never fire inside inputs or an open dialog. Focus
stays in the composer after a send. No drafts or live text are persisted (no storage).

**Stays exclusive to Observe:** the canonical event table, `EventView` and record JSON, the swimlane overview, full source-condition and
watermark facts, flags and anomaly lists, capability conformance detail, raw digests beyond a short prefix, the category and flag
filters. DEVELOP links to them and never re-renders them.

**Rejected:** a terminal or PTY, colour-only status dots, PWA/push notifications, any raw-RPC "advanced" field, streaming through
unbounded buffers, new dependencies (virtual lists, markdown renderers), persisted drafts, and auto-following by default (following is
opt-in, bounded and pausable).

## 12. Decisions taken, and what slice A actually does

The operator approved (1) the broker serves the workbench page itself, (2) terminal-only approval for the first slice, (3) a separate
`prompt` record chain, and (4) slice A as scoped. Facts that came out of building it:

- **Pi retains the conversation itself.** A persistent Pi session writes its own session file under the store root
  (`<root>/pi-sessions/`), as it always has. That is **Pi's** retention, outside Endophasia's evidence, and the workbench cannot
  remove it. What Endophasia writes (events, registries, runtime-text and artifact stores) never holds the prompt or reply text; a
  test scans for it. The workbench's own transcript is separate, in memory, bounded (400 items, 1 MiB, 32 KiB per message) and
  cleared when the session ends or the broker is disposed.
- **Tool arguments and results are not kept at all** in v0, not even in memory: the transcript holds a tool's name and outcome only.
  Reasoning ("thinking") text is never kept.
- **The prompt text is shown in full on the operator's terminal** for approval (it is their own terminal and they must see exactly what
  they authorise); control characters are refused so a prompt cannot drive the terminal. Terminal scrollback is the operator's.
- **Unreachable is not ended.** If the page cannot reach the broker it says *connection unknown*; the broker closing with the process
  is indistinguishable from a network failure to the page.
- **One constant answer on the read-only server.** `endo studio` has no workbench; so the page can ask quietly (a 404 would be logged by
  every browser as a failed request), the read-only server answers `GET api/v0/workbench/status` with the constant
  `{"available":false,…}` and nothing else under that prefix exists there. Every POST is still refused (405).
- **Follow is opt-in and bounded.** The page reads the broker's memory every 3 s only if the operator switches Follow on, and every
  1.5 s only while a prompt waits for approval; never while the tab is hidden, never both in flight. The cockpit store reader remains
  explicit-refresh only.
- **A real model run is not part of the automated tests.** They use the fake Pi (a real child process speaking Pi's RPC) and a stand-in
  model endpoint. A run against a real Pi and model needs the operator's explicit approval and may cost money.

## 13. Slice B: STEER, QUEUE and STOP through the broker

Implemented in `adapters/pi/workbench-interventions.ts`. It adds **no competing control path**: the broker drives the existing
`PiInterventionDeskV0` and its chain (`proposal → authorization → request → acceptance | refusal → consumption → consequence`, see
[steering.md](steering.md)), with the existing gate, authority provider, capability admission and idempotent `apply`. A new prompt keeps its
own chain; the two never share a record.

**Authority is unchanged.** The page may *request*; the operator approves by typing a phrase on the attached process's controlling terminal.
The phrase names the operation and the proposal's digest (`APPROVE STEER <16 hex>`, `APPROVE QUEUE …`, `APPROVE STOP …`), so another
operation's phrase, or another request's, declines. The approval is recorded as the desk's authorization, bound to the proposal digest, the
session and the attachment, with the new confirmation value `terminal-phrase` (a shorter act than `endo steer authorize`, which carries the
whole digest, and recorded as such). Proposals gain the origin `operator-workbench`, and the launch id is part of the nonce the digest
covers. There is no browser route to authorise or apply, no raw RPC and no browser-supplied proposal id that reaches the desk: the broker
applies only the requests it made in this launch.

| Route (under `api/v0/workbench/`) | Meaning |
| :--- | :--- |
| `POST intervention/propose {operation, message?}` | request a STEER, QUEUE or STOP; `202` means requested, nothing sent |
| `GET intervention/<id>` | the request's state |
| `POST intervention/discard {proposalId}` | withdraw it before it is approved |
| `POST intervention/check {proposalId}` | an explicit operator action: read the recording proxy's capture for consumption |

Status gains `offers.{steer,queue,stop}` (each `{offered, reason}`) and `interventions` (the last 40 requests, memory only).

**What is offered.** Only for the live session this broker serves, only while a run is open, only for a capability admitted for the observed
runtime identity (`steering.steer`, `steering.follow-up`, `steering.stop`), and only when the terminal is free. A recording's last known
`running` state never offers a live control (the recorded views have none, and a test pins it). Otherwise the reason is shown.

**Concurrency.** The terminal is one readline, so **one approval waits at a time** across the prompt and the interventions; a second
request is refused (409) before the desk records anything. A request that was approved and is waiting for Pi does not hold that slot. At
most one STOP is in flight; a duplicate returns it, and steer and queue are withheld while it is pending. Pending Pi replies are held by the
broker, so a late reply is recorded and shown after the page went away, and status reads are never held behind an `abort` Pi answers only
once idle. A pending steer approval blocks a STOP until it is withdrawn on the page or declined in the terminal (press Enter).

**Teardown.** The desk's closing `finish({ final: true })` records consequences, so the desk first tells the broker (`onFinishing`, which also
covers the control socket's `close`): it refuses new requests and withdraws what waits for the terminal. A mid-session `finish` (the control
socket's `finish` message) does not: the workbench keeps working. A request cannot be approved after the chains close.
`dispose()` waits at most two seconds for a request still waiting for Pi.

**States, never merged.** requested, approved, sent, runtime-accepted, observed-consumed, run-ended:

| State | Page wording | Evidence |
| :--- | :--- | :--- |
| `awaiting-approval` | Requested. Waiting for you to approve it in the attached terminal | the proposal record |
| `dispatching` / `sent` | Approved in the terminal. Being sent / Sent to Pi. Waiting for its reply | the request record exists |
| `accepted` | Pi accepted it. That is a reply, not proof the message was used (STOP: Pi acknowledged the stop request) | `intervention.accepted` |
| `refused` | Not sent (with the reason), or Pi refused it | the gate's or Pi's refusal |
| `unknown` | Outcome unknown: it was sent, and Pi's reply was not seen. It may have taken effect | a request with no usable reply |

A timeout or lost connection after the request was written is **unknown**, not refused, whatever the desk's `runtime-failed` record says.

**Consumption** is the established rule (`endoFindConsumptionV0`): a later captured model request carries the message **one more time**.
It reads the capture, so it is checked only when the operator presses *Check evidence* (or when the session closes), never per poll, and
it is *not established* when the store holds no proxy capture. Text appearing in the conversation, or a successful RPC reply, is never
treated as consumption. **The run's end** on a card is what Pi reported (`aborted`, `failed` or `completed`, from the last assistant
message at `agent_settled`) and is never presented as caused by the request; a STOP that races a natural completion reads *completed*.
The desk's **consequence** record is written at session close, and the card says so.

**Privacy.** The message of a STEER or QUEUE is written to the desk's keyed blob store (`<root>/interventions/`) **before approval**, exactly
as `endo steer` does, because the gate re-verifies it at the moment of sending. It is therefore retained even when the operator declines or
withdraws it, unlike a prompt. It never enters canonical evidence; the composer says so beside Steer and Queue. The page keeps the text it
sent in memory only, to show it on the card.

**Not covered.** The operator exercised slice A (prompts) by hand against a real Pi. STEER, QUEUE and STOP were tested only against the fake Pi
and a real pseudo-terminal; no real Pi or model run was made for them, and `npm run test:acceptance` (`--real-pi`) was not run.

How a session from any source (this broker, a recording, or one another host owns) is presented, and why a described capability is not an authorisation: [develop-session-surface.md](develop-session-surface.md).
