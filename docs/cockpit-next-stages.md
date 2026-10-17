# Cockpit: architecture and sequencing after PR A

A handoff, not a plan of record. It states the constraints the observation bridge (PR A, `docs/cockpit.md`) was built to
keep, and a recommended order for what follows. Nothing here is authorized work.

## Layers and who owns what

1. **Harness attachments** own runtime interaction and native semantics (Pi, ACP).
2. **Canonical records** (the event log, the attachment registries) own durable evidence, integrity and replay.
3. **The observation bridge** owns read-only projections and the presentation contracts. Its output is disposable
   presentation data, never evidence: it can always be rebuilt from the records.
4. **HTTP and browser layers** consume those contracts. They invent no capability truth, no status and no limit.
5. **Commands** (future) follow a separate authority path that rechecks authorization and current state at execution time.

All of this stays inside the one TypeScript application and its durable storage; no service decomposition is needed.

## Guarantees to keep while extending

- Wire validity, internal consistency and source-backed reproduction are three different guarantees; a transport must not
  present one as another.
- Independent histories (event log, each registry) are never presented as one atomic snapshot.
- Every public commitment to withheld content is a keyed token under an explicitly injected digest key; the bridge never
  creates, loads, defaults or persists a key.
- Reads stay read-only: no repair, truncation or directory creation. Public errors are fixed categories, never source or
  OS messages.
- A stored capability status is carried as recorded; limits and disagreements stay explicit.

## Recommended sequence

- **After PR A (optional, separately reviewed, behaviour-preserving):** consolidate duplicated invariants. Discriminated
  unions and constructors would reduce invalid state combinations; shared pure functions could hold the usage,
  recovery-flag and capability-limit rules that the projectors and validators now state twice. Weigh the benefit against
  touching validated code; do it only if it pays for its own review.
- **PR B, local HTTP:** a thin transport. The host loads an existing digest key (`readEndoDigestKeyV0`, which reads and never creates; `loadOrCreateEndoDigestKeyV0` writes and does not belong on a read path) and injects it into every call. Bound
  request sizes, control local access, and classify errors: a malformed client request (4xx), an unavailable source (a
  source condition, not a failure of the request) and an internal projection defect (5xx) are different things. The
  server validates `afterSequence` and `limit` itself, so any `TypeError` from the bridge (a missing key, a projection
  defect) is a 5xx, never an automatic 400.
- **PR C, browser cockpit:** render authentic identity, capability evidence, limits, recorded runs and explicit epistemic
  gaps (`unavailable`, `withheld`). Keep the renderer replaceable; it consumes the contracts only.
- **PR D, live updates:** measure full-log validation and hashing under realistic histories first (every timeline read
  hashes the whole log). Bound and coalesce refreshes. Add a rebuildable cache only if measurements justify it, publish
  complete validated generations, and keep content-rewrite detection (`diverged`, `changed`).
- **Controls (later):** observation is not authorization. A displayed capability or evaluation result never grants
  permission to execute. Keep command acceptance and the observed outcome as separate records, and recheck both
  authorization and current state when the command runs.
