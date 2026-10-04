# Post-merge audit of #29 and #31

Date: 2026-10-04. Subject: `main` at `2f2ed95` (the merge of #31), which contains the steering protocol and its study
(#29) and the path-sensitivity study (#31). Method: an adversarial read of the new authority-bearing code, asking of each
step what a hostile or merely careless caller could make it say or do, and a reproduction test for every defect found,
written and run against the unmodified code before it was fixed. A finding marked **fixed** is in the PR that adds this
document. Everything else is an accepted limitation, stated as such.

## Coverage, honestly

**Read line by line:**
- `protocol/intervention.ts`, `runtime/contracts/intervention.ts` (the gate, the authority, the consumption finder);
- `adapters/pi/intervention.ts` (the desk) and `cli/intervention-capture.ts`;
- `cli/control.ts` and `cli/steer.ts` (the control endpoint and its client);
- the `prompt-intervene` recording and replay paths in `cli/cassette-session.ts`;
- the intervention wiring and `gatherControlEvidence` in `cli/experiment.ts`.

**Pattern-searched only,** for swallowed errors, defaults that fill gaps and platform assumptions: the rest of
`cli/experiment.ts`, the parts of `adapters/pi/attachment.ts` outside the methods #29 added, the two studies' analysis
scripts beyond their consumption and compliance logic, and the tests.

**Not examined:** concurrency fuzzing of the control socket, behaviour on Windows (the socket is Unix-only by design), and
anything in the Deadbolt contract proposal, which is a document.

**Baseline.** CI was green on #31's head, and the last full local run before this audit was 2,662 passed and 46 skipped
(Node 26 and Node 22). This is not a fresh clean-install baseline.

## Findings

### Medium

**M1. A repeated message text was reported as consumed. (Fixed.)**
- **Where:** `endoFindConsumptionV0`, `runtime/contracts/intervention.ts`.
- **What happened:** consumption was "a captured request, from the exchange after the one the intervention was sent in,
  that carries a user message with the message's keyed digest". Every request resends the whole conversation. If the
  operator steered with words already in the history (the words of the original prompt, or of an earlier steer), every
  later request carried them whether or not Pi delivered the steer, and the desk recorded `intervention.consumed`. That
  is a false verification claim: "the model was sent the message" asserted from text that was always there.
- **Reproduced by** (red on the unmodified code): "a steer whose text repeats an earlier message is consumed only when the
  text appears one more time" (`expected 2 to be 3`), and "the desk does not report consumption for a repeated text that
  was never delivered" (`expected 'observed' to be 'not-observed'`, on the timestamp path as well).
- **Fix:** consumption is an **increase**: the first request, from that exchange on, that carries the message one more
  time than the last request before it. A second proposal repeating an earlier steer's text is covered the same way.
  `docs/steering.md` states the new definition.
- **The published results are not affected.** `scripts/verify-consumption.ts` re-checks every recorded
  `intervention.consumed` in the committed raw data against the new rule, from each store's own proxy capture. Over the
  steering study's pilot, main run and two post-hoc runs, and the path-sensitivity study's pilot and main run, it found
  **364 interventions, all consumed, and the new rule gives the recorded exchange in all 364** (the old rule did too). No
  published consumption, and nothing that rests on it (P4, the delivery results), changes.
- **What it still is:** consumption by content. Pi gives a queued message no identity, so an increase in the occurrences
  of the message's text is the strongest evidence the proxy can show.

**M2. A pending STOP blocked the control endpoint, and a close could outrun it. (Fixed.)**
- **Where:** `cli/control.ts` (the message queue), `PiInterventionDeskV0.finish`.
- **What happened (a):** every control message ran through one serial queue, and Pi answers `abort` only once the run is
  idle. While a STOP waited, `status`, `close` and any further proposal waited behind it: the operator lost sight of the
  session in the one case where they are watching it. Reproduced: with a STOP pending, `status` answered after the
  `apply` (`['apply', 'status']`, expected `['status', 'apply']`).
- **What happened (b):** `finish` (called by `close`, and directly by the attached process on SIGINT) recorded the
  consequences without waiting for an apply still waiting for Pi. The consequence then said the request was refused for
  "no reply recorded", which was false, and Pi's acceptance was recorded after it. Reproduced: with a STOP pending, the
  events were `consequence, accepted` (expected `accepted, consequence`). Through the control queue `close` happened to
  wait behind the apply, so that path passed on `main`; the SIGINT path did not.
- **Fix:** an `apply` is started in arrival order but no longer waited for by the queue. `finish` first waits for the
  applies in flight (`settled`, at most 30 seconds), then records. A request whose reply is still missing then gets the
  honest acceptance `pending`, and the late acceptance is recorded after it. `finish` is now asynchronous and awaited by
  its callers (the recorder, `attach --control`, the control server).
- **Additive schema change:** the consequence's `acceptance` gains `pending`. No committed data contains it.

**M3. An authorization never expired. (Fixed.)**
- **Where:** `endoInterventionGateV0` and the desk.
- **What happened:** an authorization was bound to its proposal's digest, session and attachment, but not to a time. A Pi
  session is persistent, so an authorization recorded days earlier remained usable for as long as the session lived and a
  run was active. An authorization is for a decision made now; a standing, forgotten permission is the "stale evidence
  inheritance" the roadmap's hardening item names.
- **Reproduced by** (red on the unmodified code): "an authorization expires" (an apply 16 minutes after the
  authorization succeeded).
- **Fix:** the desk refuses an authorization older than its `authorizationMaxAgeMs` (15 minutes by default, by the
  authorization's recording time, on an injectable clock) or dated more than a minute in the future, with the new refusal
  reason `authorization-expired`. Nothing is sent. The studies' scenarios authorize immediately before applying, so none
  is affected.
- **Additive schema change:** `authorization-expired` joins the closed v0 list of refusal reasons. No committed data
  contains it.

## Accepted limitations

These are properties of the design, stated so that nobody mistakes them for guarantees.

1. **The local operator's confirmation is not authentication.** `endo steer authorize --confirm <digest>` binds an
   intent to one exact proposal and makes a reused or mistyped authorization fail. The digest is printed by `propose`, so
   anything that can reach the control socket can propose, confirm and apply. The socket is mode 0600 in a 0700
   directory, checked on both sides, so that is "anything running as the same user". A stronger authority is the
   external-authority seam ([the Deadbolt contract proposal](../deadbolt-intervention-contract.md)).
2. **An authorization record names no operator,** only the kind of authority.
3. **The store is trusted.** The desk rebuilds its state from the session store. Anyone who can write the store can forge
   proposal, authorization and request events. The store is single-writer by lock, and defending it from its owner is out
   of scope.
4. **At most once, not exactly once.** The request is recorded before it is sent, and a duplicate apply never resends. A
   crash between the record and the RPC leaves a request that reads `pending` and cannot be re-applied; the operator
   proposes again.
5. **Unknown or malformed control messages each record a `control.message-refused` event,** so a same-user client can grow
   the store. Same-user trust, as in (1).
6. **`endo steer propose --steer <text>` cannot take a text that begins with `--`,** because the argument parser reads it
   as a flag.
7. **Two proposals with the same text applied close together** cannot be told apart by content: the second consumption is
   attributed to whichever request first shows an increase.
8. **Pi's `abort` is untargeted,** so a STOP cannot be confined to the run the operator observed (already recorded on
   the capability).

## What held up

The gate's refusal order and each reason, an authorization reused for another proposal or session, a tampered proposal
and a tampered message blob, an apply after the session ended, concurrent and repeated applies (one request, one
acceptance), the socket and directory permission checks on both sides, stale-socket cleanup, the socket-path length
limit, the refusal of an unknown control message, and replay re-issuing an intervention under the same proposal digest.

## Tests added

All in `tests/intervention.test.ts`, each red on the unmodified code, except where noted:
- "a steer whose text repeats an earlier message is consumed only when the text appears one more time";
- "the desk does not report consumption for a repeated text that was never delivered (with and without a delivery point)";
- "status answers while a STOP is pending";
- "a finish called while a STOP is pending (the SIGINT path) records the acceptance first, and the consequence says accepted";
- "close during a pending STOP records Pi's acceptance before the consequence" (green on `main` by accident of the queue,
  kept so the fix cannot regress it);
- "an authorization expires" (on an injected clock, so it cannot flake on a slow runner).

The older "consumption is found only by the message's keyed digest" test encoded the old presence rule (a message that is
in request 1, absent from request 2 and back in request 3). Real requests never behave that way, so its bodies were made
realistic and it now asserts the increase rule.

`scripts/verify-consumption.ts` is the re-runnable check over the committed raw data.
