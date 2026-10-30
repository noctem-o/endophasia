# The DEVELOP session surface (`endo.develop-session-surface.v0`)

DEVELOP shows sessions from several kinds of source: a harness Endophasia owns (Pi), an imported recording (DSH), and, in future,
sessions another host owns or a meta-harness coordinates. The surface is the one neutral shape in which DEVELOP *presents* any of
them. Code: [`protocol/develop-session.ts`](../protocol/develop-session.ts) (types and validator),
[`studio-ui/src/model/develop-session.ts`](../studio-ui/src/model/develop-session.ts) (pure projections),
[`studio-ui/src/develop/Surface.tsx`](../studio-ui/src/develop/Surface.tsx) (the drawing).

It is a **presentation contract**. It is not durable evidence, it is written nowhere, and it authorises nothing. No server route,
response or event record changed; the browser builds it from records it has already validated.

## What it says, and what it will not say

| Field | Meaning | If not established |
| :-- | :-- | :-- |
| `identity.source` + `key` | The integration that presents the session, and the key it gave, with its **scope** (`source`: stable; `launch`: this launch; `generation`: this verified log read). | `key: unavailable` with a reason |
| `identity.alias` | Display label only. Never a key, never compared for identity. | `null` |
| `integration.type` | `harness`, `meta-harness` or `external-host`. | (required) |
| `runtime`, `ownership` | A value with its **basis** (`observed` / `reported` / `recorded`) and who said it. Ownership: `direct`, `external`, `imported`. | `unavailable` + reason (unknown) |
| `observation` + `connection` | `live`, `recorded` or `unavailable`; connected, disconnected, unknown, or not applicable (a recording). `connection` is Endophasia's own read path to the source's feed (for Pi, the broker's admitted connection), not the source's claim about itself. | a reason, always, unless connected |
| `status` | Claims, **at most one per basis**. Reported and observed are never merged; a recorded claim exists only for a recording. | empty list |
| `capabilities` | `observe`, `control`, `coordinate`: a closed set of actions each. Every action must be present. | `unsupported` / `unavailable` + reason |
| `evidence` | The projections the entry was built from, each held only by a session of the source that produced it. | empty list |
| `relations` (surface) | Parent/child edges, each with a basis and the party that claimed it. | no edge |

An absent field is never an affirmative: a capability map missing an action is a rejected record (and a compile error in the
projections), and `supported` must name the path that serves it.

### Validation rules

The validator returns the first failure and is pure.

1. Closed shape and versions; no unknown member.
2. Keys are unique: the same source, scope and id twice is refused.
3. An alias shared by two sessions of one source is refused (a reader could merge them).
4. Control is `supported` only for a session that is **live and directly owned**. A recording, an unreachable session and a session some
   other process owns have none. Coordination describes what a coordinator offers; it confers no control, and a child's capabilities are
   read from the child alone.
5. A governed control path belongs to one source: `pi-workbench-broker` is admitted only on `pi-live`, so no other session can name another
   integration's broker as its path, whatever it claims about its ownership.
6. An edge names two sessions of the surface, is not a self-edge or a duplicate, and does not close a cycle. A session has at most one parent
   (two parents are conflicting claims; the surface is refused, not resolved).
7. An edge is claimed by one of its ends (`reported`) or by `endophasia` (`observed`).
8. Synthetic (test-only) sessions are refused unless the caller says it is validating a fixture.

## Examples

**Real integrations**

1. *An owned live Pi session* (`pi-live`): the workbench status, projected. Abridged:

   ```json
   { "identity": { "source": "pi-live", "key": { "status": "established", "id": "endo.session.pi.live", "scope": "source" }, "alias": "pi.live" },
     "ownership": { "status": "established", "value": "direct", "basis": "observed", "by": "endophasia" },
     "observation": { "mode": "live", "reason": null },
     "status": [{ "state": "idle", "basis": "reported", "by": "pi", "at": null }],
     "capabilities": { "control": {
       "prompt": { "status": "supported", "via": "pi-workbench-broker", "reason": null },
       "steer":  { "status": "unavailable", "via": null, "reason": "No run is open." },
       "resume": { "status": "unsupported", "via": null, "reason": "Endophasia does not resume sessions." } } } }
   ```

   Run state is what Pi *reported* through the broker; the connection is what Endophasia *observed*. If the workbench reports no
   connection, the entry is `unavailable` with no status and every control action `unavailable`: offers left in the last status are
   not offers once the connection is gone. An unreachable workbench is `connection: unknown`, not "ended".
2. *A recorded DSH session* (`dsh-recorded`): ownership `imported` (`recorded`), observation `recorded`, connection not applicable, one
   `recorded` status claim at the recording's last clock reading, `lifecycle` and `activity` supported through the Develop read model,
   every control action `unsupported` ("Endophasia has no control path to DSH"). Recorded Pi is the same under `pi-recorded`. A
   recorded `running` state means a run was open at the last recorded event, never that a process exists; it stays read-only. A
   recording that could not be qualified has no key, no status and its observation actions `unavailable` with the reason.

**Test-only shapes** (`tests/develop-session-fixtures.ts`; `synthetic: true`, every source id begins `test-`; not integrations, never
connected, refused by a production validation, and a test fails if any production module imports them)

3. *An externally owned read-only session*: `external-host`, ownership `external` (reported by the host), live feed supported, no
   transcript feed, all control `unsupported`. It carries a **reported** `active` and an independently **observed** `idle`; both stay.
4. *A meta-harness job with two children*: a coordinator (`meta-harness`, reports itself `ended`, offers `coordinate.*`), child alpha
   (reported `active`, one `reported` edge claimed by the coordinator and not by alpha) and child beta (no status, observation
   unavailable, alias `job-1-beta`, **no edge**: a name or a start time links nothing). The coordinator ending says nothing of alpha;
   no session in the job can be controlled through Endophasia; child evidence stays attributed to the child's own source.

## The distinctions

- **Source identity versus alias.** The key (with its scope) identifies; the alias labels. A recording's key is the generation-bound
  selector, because that is all the read model gives out; the surface says so rather than building a stable id from the alias. A live
  session and its recording are two entries, never joined by alias.
- **Observed versus reported.** `observed` is Endophasia's own measurement; `reported` is a source's statement; `recorded` is what a
  recording holds. They are separate claims, and nothing here chooses between them.
- **Recorded versus live.** A recording is never proof of a live process. Only a connected broker makes an entry `live`.
- **Capability advertisement versus authorisation.** A capability describes what a source offers. It does not enable a control. The
  composer and the stop control keep reading the broker's own `offers` (a source test fails if they read the surface), and at dispatch
  the broker's admission, the pairing grant and the operator's terminal approval decide. The browser cannot authorise.
- **Runtime acceptance versus proven consequence.** Unchanged from the workbench: acceptance is not consumption, completion or effect.
- **Integration neutrality versus equal coverage.** The shape fits Pi, DSH, an external host and a coordinator; their functions do not
  match. Pi has a governed control path; DSH has none; the fixtures have none. (The fixtures' `connected` models a hypothetical feed; they connect to nothing.) The surface does not manufacture parity.

## Limits

- Real sources today: the live Pi workbench, recorded Pi, recorded DSH. No OMP, Codex, GooeyPi, ThinkRail, OpenRig or Agent
  Orchestrator integration exists; the two fixtures show only that their shapes can be represented.
- Relations are validated and tested but no real source produces one yet, so DEVELOP draws none.
- The surface is built in the browser and validated in tests; the browser imports the protocol as types only, so it does not validate
  at run time. A server-side projection is a later step if an integration needs one.
- No live Pi or model run was made for this change; the live entry was exercised against the fake-session broker only.

## Risks from the STEER/QUEUE/STOP slice

This change did not touch them. The first two were remediated afterwards, as
[develop-workbench.md §14](develop-workbench.md#14-stop-priority-and-bounded-evidence-checks) describes: a STOP now supersedes an
unapproved steer or queue, and the evidence check is bounded and cooperative. Steer and queue text is still stored under
`<root>/interventions/` before approval, so declined text is retained there.
