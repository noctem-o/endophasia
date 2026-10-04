# Steering: STEER, QUEUE and STOP as authorized, verified interventions

An intervention changes a session while it runs. v0 has three, all through Pi's documented RPC only (`steer`,
`follow_up` and `abort`, through the attachment's gated controls):

| Operation | Pi's command | Pi's documented delivery |
| :--- | :--- | :--- |
| STEER | `steer` | after the current assistant turn finishes executing its tool calls, before the next model call |
| QUEUE | `follow_up` | only when the agent has no more tool calls or steering messages |
| STOP | `abort` | Pi answers once the session is idle; the run's end is Pi's own `aborted` |

## The chain

Each step is its own record (`protocol/intervention.ts`, `endo.intervention.v0`): an `endo.event.v0` with its own
source class, linked to the steps it derives from by `derivedFrom`.

```
observation? → interpretation? → proposal → authorization → request → acceptance | refusal
                                                                   → consumption → consequence
```

| Record | Source class | What it is |
| :--- | :--- | :--- |
| `intervention.observation`, `.interpretation` | runtime fact, interpretation | optional: what the operator points at, and the operator's reading of it |
| `intervention.proposal` | policy conclusion | an operation, its message (by keyed digest) and the session and attachment it is for; its id is derived from its sha256 digest |
| `intervention.authorization` | authority decision | allow or deny, **bound to the exact proposal id and digest, the session and the attachment** |
| `intervention.request` | runtime fact | Endophasia sent the operation, with the recording proxy's delivery point when there is one |
| `intervention.accepted` / `.refused` | runtime fact | Pi's reply (a disposition), or the gate's or the runtime's refusal with its reason |
| `intervention.consumed` | runtime fact | the message appeared in a later model request the recording proxy captured |
| `intervention.consequence` | evaluation result | acceptance, consumption and effect, kept apart |

**Three things are never conflated.** *Acceptance* is Pi's reply: a disposition, which says nothing about whether the
message was used. *Consumption* is proxy evidence: the message's keyed digest equals that of a user message in a
captured request, so it is recorded only when the capture shows it, and otherwise the consequence says it was not
observed and why. *Effect* is what the trajectory did after the request: the runs that ended and how, the turns and
tool calls. It is never a judgement that the intervention helped.

The message text is kept in a keyed blob store beside the session store (`<root>/interventions/`), never in canonical
evidence.

## Who may propose, and who authorizes

- **v0 proposals come only from the operator**: `origin: "operator-cli"`, or `"operator-scenario"` when a scenario the
  operator wrote (an experiment condition) carries it. **There are no model-originated proposals yet.**
- **Authorization is the local operator confirming the exact proposal digest.** The local operator authority
  (`runtime/contracts/intervention.ts`) allows a proposal only when it is given that proposal's digest. Anything else,
  including no confirmation, is a deny. Nothing is allowed by default.
- **The seam for an external authority** (for example Deadbolt, see the trust records) is
  `EndoInterventionAuthorityProviderV0`: a provider that decides on a proposal. Nothing wires one yet.

## The gate

`endoInterventionGateV0` runs before anything is sent, and refuses, in this order, with a recorded reason:
`not-authorized`, `authorization-denied`, `authorization-for-another-proposal`, `proposal-tampered` (the content, or the
stored message, no longer matches the digest), `authorization-for-another-session`, `proposal-for-another-session`,
`authorization-for-another-attachment`, `capability-unavailable`, `session-ended` and `no-active-run`.

**An operation is offered only if Pi's capability for it is admitted by conformance evidence** (`steering.steer`,
`steering.follow-up`, `steering.stop`); otherwise it is UNAVAILABLE with the reason. `apply` is idempotent: applying a
proposal again, even concurrently, returns the recorded request and sends nothing.

## The control endpoint

`endo harness attach <root> --control` keeps the session open and serves the intervention desk on a Unix socket
(`<root>/control/endpoint.sock`). The directory is mode 0700 and the socket 0600, and both sides refuse an endpoint
that is not owned by the user or is open to anyone else. `endo steer` talks to it (the attached process records
every step, never the client):

```sh
endo steer propose   <root> --steer "text" | --queue "text" | --stop
endo steer authorize <root> <proposalId> --confirm <proposal digest>
endo steer apply     <root> <proposalId> --authorization <authorizationId>
endo steer status    <root>
endo steer close     <root>
```

An unknown or malformed control message is answered with an error and recorded (`control.message-refused`).

## In scenarios, experiments and replay

- **A scenario step** `prompt-intervene` applies one intervention once the recording proxy has relayed N chunks of a
  given exchange (`cli/cassette-session.ts`). The proposal and its authorization (`confirmation: "scenario"`) are
  recorded before the prompt; only the apply is timed by the delivery point.
- **An experiment condition** can carry `interventions` per task ([experiments.md](experiments.md)).
- **A replay re-issues the intervention at the recorded point**, as STOP is ([replay.md](replay.md)), and reports it.

## What is not built

Model-originated proposals; an external authority provider; observation and interpretation records are in the schema
and the desk's proposals can name them, but no command creates them; an operator view beyond the CLI.

## Evidence

[The steering study](../research/steering/1.0.1/RESULTS.md): under temperature 0, a fixed seed, the cache off and the
environment pinned, 120 trials of a STEER and a QUEUE at a fixed point against a baseline. Delivery was where Pi
documents it in all 80 steered trials; the effect on what the agent did, which differed by task and arm, is reported as
measured, with its limits.
