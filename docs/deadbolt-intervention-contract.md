# Deadbolt as the authority for an Endophasia intervention: the lease contract Endophasia would require

**Status: a contract proposal. Nothing in either repository implements it.** It is written for Deadbolt's maintainer to
take to the Deadbolt repository. Endophasia has no Deadbolt provider, and this document does not add one.

Deadbolt facts below come from Deadbolt's source as of commit
[`e2651b4`](https://github.com/noctem-o/deadbolt/tree/e2651b4792fe83eba9d5ff335377437c98f6d822) of `main`
(2026-08-19), mostly `crates/cog-leases/src/lib.rs`, and from its `docs/capability-leases.md` and
`docs/implementation-status.md`. They were read, not run. Anything marked **proposed** does not exist in Deadbolt.

## 1. Why this document, and why no code

Endophasia's steering protocol ([steering.md](steering.md)) has a seam for an external authority:
`EndoInterventionAuthorityProviderV0`. Deadbolt is the natural candidate ("The model may suggest. Authority stays
outside the model."). But Deadbolt cannot authorize an Endophasia intervention today:

- **Its leases come from a closed set.** `CapabilityName` and `CapabilityAction` are closed Rust enums, every lease
  struct has `deny_unknown_fields`, and each real route has its own template (`lease issue --template …`). None names
  an Endophasia intervention.
- **A new template is Deadbolt work,** done under Deadbolt's own design, pre-review and hostile-review process, in its
  own repository.
- **A provider written here could only be tested against a stub.** That is the "library-only, exercised only by unit
  tests" surface the README roadmap says not to grow before the contracts have survived a real agent.

So this document fixes the contract instead: exactly what Endophasia would require of a Deadbolt lease, expressed in
Deadbolt's own vocabulary, so that the Deadbolt side can decide whether and how to provide it.

## 2. What Endophasia needs from an authority

A proposal (`intervention.proposal`) names one operation (`steer`, `queue` or `stop`), a message by keyed digest, a
session and an attachment, and carries its own sha256 digest. An authorization (`intervention.authorization`) is bound
to that exact proposal id and digest, the session and the attachment. The gate refuses an intervention without an
`allow` that matches all of them. Nothing is allowed by default.

An external authority therefore has to be able to say, about **one exact proposal**: "this operator may do this
operation to this session, now". It must be bound to the proposal's digest, so it cannot be reused for another message,
another session or another operation, and it must expire.

## 3. What Deadbolt has today

**The request** (`CapabilityRequest`, `phase9a-capability-request-v1`):

| Field | Meaning |
| :--- | :--- |
| `request_schema`, `request_id` | the schema, and an id the caller chooses |
| `subject`, `audience` | who is asking, and for which audience (`fixture-agent` and `cogitator-harness-local` are the local constants) |
| `action` | a `CapabilityAction` (closed enum) |
| `target` | an optional string, **the exact thing the action is for** |
| `dry_run` | whether this is a dry run |
| `requested_capabilities` | `CapabilityName`s (closed enum), at least one |
| `read_paths`, `write_paths` | the paths the operation touches |
| `network_required`, `live_authority_required` | whether it needs the network, or authority over a live system |

**The decision** (`CapabilityDecisionReport`, `phase9a-capability-decision-v1`): `status` (`authorized` or `refused`),
`lease_id`, `request_id`, `subject`, `audience`, `evaluated_at_unix`, and the booleans `signature_verified`,
`temporal_valid` and `constraints_satisfied`, plus a list of `issues` (each with a `code`, a `message` and the `field`).

**How a request is checked** (`check_request`): the lease's signature and time window; the request's schema, subject and
audience against the lease; the dry-run and live-authority constraints; no network; at least one requested capability,
none forbidden by the lease; the action; then, per requested capability, that a grant exists, that its actions contain the
request's action, and that the request's target is allowed by the grant's targets.

**How a real route is bound.** The newest real mutation route, `mutation.hyprland.border_size.set_three`, is the model
to follow. Its target is exactly `hyprland.border_size.general_border_size:{run_id}:{dry_run_plan_hash}`: three
colon-separated parts, a fixed prefix, and a non-empty run id and plan hash, with a `…_target_well_formed` function so a
malformed prefix-only target cannot be reported as satisfied. Its lease template sets one grant (one capability, one
action, one exact target), `dry_run_only: false`, `allow_live_authority: true`, `allow_network: false`, read and write
roots limited to the run directory, and a forbidden list of every other live capability. Wildcard targets (`*`) are
refused.

**Deadbolt's own limits, which carry over.** A lease "authorizes the attempt only"; a verifier checks internal
consistency, "not independent proof that consent … occurred"; its keys are development-local; and it is "not a production
trust system".

## 4. The gap

| Needed | In Deadbolt today |
| :--- | :--- |
| A capability and an action for each operation | none; the enums are closed |
| A target format that binds a session and a proposal digest | none |
| A lease template, a request builder and a `…_well_formed` check | none |
| `lease issue --template …` entries, clean and hostile fixtures, a design doc and a hostile review | none |

**Proposed** additions in Deadbolt, following the border-size route (Phase 31J) as the pattern:

- `CapabilityName` and `CapabilityAction` variants, one per operation: `mutation.endophasia.intervention.steer`,
  `.queue` and `.stop`. (The `mutation.` class is one option; see the open questions.)
- A lease template and request builder per operation, a `…_target_well_formed` function, and a forbidden-capabilities
  list that excludes only the granted one.
- Fixtures for the exact-target case and for the refusals (wrong session, wrong digest, wrong operation, wildcard,
  expired, wrong subject or audience).

## 5. The proposed binding

Deadbolt's `<prefix>:{run_id}:{dry_run_plan_hash}` maps onto Endophasia directly:

| Deadbolt slot | Endophasia value |
| :--- | :--- |
| prefix | `endophasia.intervention.<operation>` |
| `run_id` | the session: `endo.session.pi.<id>` (no `:` can occur in it) |
| `dry_run_plan_hash` | the proposal's sha256 digest (64 hex characters): the exact plan |

**Proposed target:** `endophasia.intervention.steer:endo.session.pi.<id>:<proposal digest>`, and likewise for `queue` and
`stop`. It has exactly three parts, like Deadbolt's existing targets. The proposal digest covers the operation, the
message's keyed digest, the session, the attachment and a nonce, so one lease authorizes one proposal and nothing else.

**Proposed constraints:** `dry_run: false` and `live_authority_required: true` (the effect is on a live agent);
`network_required: false`; `read_paths` and `write_paths` limited to the Endophasia store root (the logical run
directory); no wildcard target; a short expiry (the lease is for one decision, so minutes).

**Proposed request** (the shape follows `CapabilityRequest`; the action, capability and target values are the proposed
ones):

```json
{
  "request_schema": "phase9a-capability-request-v1",
  "request_id": "endophasia-intervention-<first 16 hex characters of the proposal digest>",
  "subject": "<the operator's identity>",
  "audience": "<the audience Deadbolt assigns to Endophasia>",
  "action": "mutation.endophasia.intervention.steer",
  "target": "endophasia.intervention.steer:endo.session.pi.<id>:<proposal digest>",
  "dry_run": false,
  "requested_capabilities": ["mutation.endophasia.intervention.steer"],
  "read_paths": ["<the Endophasia store root>"],
  "write_paths": ["<the Endophasia store root>"],
  "network_required": false,
  "live_authority_required": true
}
```

The `request_id` is derived from the proposal digest, so a decision report for one proposal cannot be presented for
another.

## 6. How Endophasia would use it (not built)

1. The operator proposes (`endo steer propose …`). Endophasia records the proposal and prints its digest.
2. The operator asks Deadbolt for a lease for exactly that target (`lease issue --template …`, Deadbolt's step and
   Deadbolt's key). Endophasia never signs, never holds a key, and never verifies a signature itself: that stays in
   Deadbolt.
3. Endophasia builds the request above from the proposal, and asks Deadbolt to check it (`lease check`, which returns a
   non-zero status when refused).
4. The authorization record is an `allow` **only if every one of these holds**, and a `deny` (fail closed) otherwise,
   including when Deadbolt is missing, exits non-zero, or prints something that does not parse strictly:
   - the decision's `decision_schema` is `phase9a-capability-decision-v1` and its `status` is `authorized`;
   - `signature_verified`, `temporal_valid` and `constraints_satisfied` are all true, and `issues` is empty;
   - `request_id`, `subject` and `audience` equal what Endophasia sent;
   - `lease_id` is present;
   - `evaluated_at_unix` is within a small skew of Endophasia's clock.
5. The rest is unchanged: the gate still checks the digest, the session, the attachment, capability admission, that the
   session is live and that a run is active, before anything is sent to Pi.

**What Endophasia's types would need first** (small, and not done):
- `EndoInterventionAuthorityV0`'s external variant carries only a `provider` name. It would also carry the lease id, the
  decision report's digest and `evaluated_at_unix`, so an authorization can be audited against Deadbolt's own records.
- `EndoInterventionAuthorityProviderV0.decide` is synchronous. Calling Deadbolt as a subprocess fits (`spawnSync`), but
  the choice between that and a pre-obtained decision report supplied by the operator is a design decision for whoever
  implements it.
- **A mismatch to resolve first.** The existing mirrors in `adapters/deadbolt` (`DeadboltLeaseInputV0`: `route`,
  `capability`, `boundTo`, `signer`, `leaseDigest`) are a conceptual mirror, not Deadbolt's real structs. A real lease has
  `lease_id`, `issuer`, `subject`, `audience`, `not_before_unix`, `not_after_unix`, `capabilities[]` (grants with
  `targets`, `read_paths`, `write_paths` and `dry_run_only`), `constraints` and `notes`, inside a signed envelope
  (`key_id`, `signature_algorithm`, `canonicalization_profile`, `signature`). The mapping would not accept a real
  Deadbolt lease as it stands.

## 7. What this would and would not establish

- **Would:** that a holder of Deadbolt's signing key authorized one exact proposal, for this session and this operation,
  inside a time window, and that Endophasia refused everything else.
- **Would not:** that the steer is wise, that its effect is as intended, or that consent happened beyond what Deadbolt
  verifies. Deadbolt says as much about itself. A valid lease authorizes the attempt only.
- **Does not change** the three-way separation in the steering protocol: acceptance (Pi's reply), consumption (the proxy
  shows the message in a later request) and effect (the trajectory after).
- **Replay** is unaffected: a replay re-issues a recorded intervention under the scenario's authority, and no Deadbolt
  decision is consulted or needed to replay a recording.

## 8. Open questions for Deadbolt

1. **Is steering a "mutation"?** Deadbolt's doctrine is that "rollback belongs in the design of the operation". A stop
   cannot be undone, and a steer or a queued message cannot be once Pi has consumed it. (Pi's documented `clear_queue`
   can remove a message that is still queued; Endophasia does not use it.) Either Deadbolt grows a class for controls
   that are irreversible by nature, with a stronger confirmation instead of a rollback, or the receipt for these
   records the outcome as `committed` or `refused` with no rollback. That is Deadbolt's decision, and it decides the
   capability names.
2. **`live_authority_required`.** Is authority over a running agent "live authority" in Deadbolt's sense? It is proposed
   as true here, which is the stricter reading.
3. **Subject and audience.** Deadbolt's local constants are `fixture-agent` and `cogitator-harness-local`. What should an
   Endophasia operator and audience be?
4. **The clock.** `lease check` takes `--at-unix`. Endophasia would pass its own clock. Is that acceptable, or should
   Deadbolt supply the time?
5. **Receipts.** Endophasia already maps Deadbolt receipts (`endo.receipt.v0`). After an intervention, would Deadbolt
   expect a receipt for the lease, and from whom?
6. **Scope of STOP.** Pi's abort is untargeted (it aborts whatever is current), so a lease cannot confine a STOP to the
   run the operator observed. Should STOP get its own, stricter template, or be left out?

## 9. Not done, and when it would be

No code in either repository, and no change to Deadbolt. This is deferred, not rejected: it becomes worth building when
Deadbolt has a matching template, so that the provider can be tested against the real `lease check` and not a stub.
Until then the seam in `runtime/contracts/intervention.ts` stays as it is, and the local operator remains the only
authority.
