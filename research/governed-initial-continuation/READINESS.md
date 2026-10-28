# Historical real same-session continuation readiness: GATED

This readiness snapshot predates the separately approved real-model attempt. The subsequent
[acceptance result](REAL-ACCEPTANCE.md) records its independently verified two-turn PASS.

On 28 October 2026, the source-tree continuation API was audited against `main` at
`2bf189110fdbda29042631acd93ee662e92d0f80`. No real-model continuation was attempted. The earlier
Pi 1.0.4/Nanbeige initial-child source and replay were re-read with their private key: the checkpoint
was `qualified`, both prepared siblings were `verified-pristine`, and a continuation preflight was
`ready` using the prior private Pi 1.0.4 executable and the explicit prior loopback origin. Preflight
does not contact that origin. A local socket inspection found no listener at the prior model endpoint;
its current model and server identity therefore remain unverified. No approval for either live turn
has been given for a current attempt.

The missing prerequisites are an operator-selected, running loopback model endpoint with its identity
checked, followed by a fresh exact-plan approval for the first turn and a separate approval of the
displayed first-turn boundary. Do not start or reconfigure a service as part of this procedure.
If the source, replay, siblings, Pi binary or endpoint has changed, requalify it before considering an
attempt. The archived initial-child pilot is evidence for its own turns, not for continuation.

## Audit observations

- The preflight checks source/replay/branch lineage, the executable, required launch flags, model,
  prompts and limits before any RPC session or completion request. The existing checks are retained.
- The installed Pi 1.0.4 RPC implementation and its bundled documentation distinguish prompt
  acceptance from `agent_settled`; the implementation observes settlement before reading the
  boundary. The [current RPC documentation](https://pi.dev/docs/latest/rpc) also makes this distinction,
  but is not a substitute for inspecting the selected version.
- In a disposable test using real Pi 1.0.4 and a **fake** local endpoint, one Pi process reached a
  first boundary, accepted a second approval, sent two complete exchanges in the same session, and
  produced a `verified` continuation receipt. The fake second request retained the first response,
  including synthetic `reasoning_content`. The genuine source/replay were read-only and a newly
  prepared test pair remained pristine. This is compatibility evidence, not real-model acceptance.
- The retained real initial-child response contained string `reasoning_content` streaming deltas.
  Pi 1.0.4 carries such text into the next assistant message. The continuation reader now accepts
  that specific bounded field and requires exact retention in the next captured request; malformed
  values and changed reasoning are refused. Other reasoning formats remain unsupported.
- Pi 1.0.4 also records one leading structured system message in a fresh session. The reader accepts
  that one prefix only with a corresponding single leading system message in the captured request;
  it rejects duplicate or later system entries. It binds the observed request context and entry
  order, but does not independently compare the private contents of Pi's system entry to the request.
- The first boundary is checked against captured request, response and trajectory evidence before
  approval. It remains provisional until the final reader independently checks its committed log
  prefixes. The second approval binds that boundary and the second prompt commitment. The proxy
  consumes a permit before forwarding and refuses an unapproved, changed or extra request.
- Offline controls cover absent and stale approvals, cancellation, an unrelated process surviving
  owned-group cleanup, a closed proxy, session and model changes, malformed reasoning, a disconnected
  upstream, incomplete evidence and receipt tampering. A terminal-driven fake-endpoint check sent
  zero requests when the first approval was declined, one when the second was declined, and two when
  both were approved. The first-only and completed receipts verified in their respective cases.

These observations do not establish endpoint availability, real-model compatibility, historical
process or KV-cache restoration, general fork execution, external-effect isolation or determinism.
The no-tools profile is not an operating-system sandbox. A post-dispatch timeout or disconnect can
leave the upstream outcome unknown; do not automatically retry it.

## Bounded operator procedure

1. Re-read the [continuation contract](../../docs/initial-continuation.md), verify the current source,
   replay and both sibling states, and identify an existing local model server without changing it.
   Confirm the selected Pi binary and version, model alias, endpoint and any independently available
   server identity. Metadata reported by the server is not independent verification of its weights,
   GPU state or defaults.
2. Create an owner-only configuration outside Git, using the fields in the continuation contract.
   Choose two harmless synthetic prompts: the second should refer to an item in the first response
   without repeating that item. Record the code commit and check the working tree. Select limits
   appropriate for the existing API: at most 120 seconds overall, at most 60 seconds awaiting the
   second approval, a 1 MiB request-wire limit, a 2 MiB RPC-output limit and an explicit aggregate
   transfer limit of at most 16 MiB. Each response is bounded by that same aggregate limit; there is
   no smaller independent per-response setting.
3. Run `node research/governed-initial-continuation/run.ts --preflight-only /absolute/private-config.json`
   to inspect a no-request preflight. It creates a new attempt commitment each time; do not approve
   this preview for a later invocation. Store its output privately.
4. In a terminal, run the same command without `--preflight-only`. Inspect the freshly displayed plan,
   both prompts, endpoint, executable and limits. Decline unless the exact first turn is authorized.
   If approved, the runner sends at most one request and waits for Pi settlement and the checked
   provisional boundary. Review that boundary and its deadline, then separately approve or decline
   the continuation. A disconnected operator or expired deadline is not an approval.
5. Require exactly two ordered, complete captured responses, stable process/session identity, the
   captured first response in the second request, no tool or policy violations, unchanged source and
   siblings, and `verifyInitialContinuationEvidenceV0` returning `verified`. Keep private artifacts
   and the key outside Git. Report an incomplete, uncertain or unverifiable attempt as such and do
   not retry without a newly justified approval.
