# The Endophasia-native cockpit

Status: **the observation bridge is implemented** (a library: [below](#the-observation-bridge-implemented)); the local
server and the page are planned. The fork-era browser cockpit was removed with the vendored Pi fork: it was a client of Pi's private
Session-worker services over a fork-only listener and cannot run against a user-installed Pi
([pi-attach-inventory.md](pi-attach-inventory.md) §5). Its replacement is not a port. It is a cockpit over
Endophasia's own records, for any attached harness.

## What it is

A read-mostly operator view served by Endophasia, whose only sources are Endophasia's durable records:

| Panel | Source |
| :--- | :--- |
| Runtime identity and changes | harness registry: current and previous fingerprint, last change, notification |
| Capability state | latest `endo.capability-state.v0`, each capability with its classification, limits and the evidence it rests on |
| Session timeline | `endo.event.v0` stream: lifecycle, tool activity, queue counts, compaction, process exits and reconnects |
| Durable entries | `session.entry-observed` with opaque source references; leaf moves |
| Usage and metrics | per-entry usage and session totals, as reported |
| Evidence | evidence records and their content-addressed transcripts |

## Rules it must keep

- **A projection, never an authority.** It renders recorded state. It holds no runtime connection and no truth of its
  own; reloading it from the store must give the same view.
- **Gaps stay visible.** A capability that is unverified, partial or unavailable is shown as such with its reason; a
  live-event gap between process instances is shown as a gap.
- **Controls only through the attachment.** Steer, follow-up, stop and configuration controls are offered only for
  capabilities the current state admits, and they go through the same attachment service the CLI uses. The cockpit
  shows acceptance and, separately, whatever effects later records show.
- **No harness management.** It never offers to install or update a harness. A runtime change appears as the same
  neutral notice the CLI prints.
- **The live study stays explicit.** Starting one is a deliberate, confirmed action that says it may cost money.
- **Local by default.** Loopback only, an unguessable per-launch URL, a strict content-security policy (the
  properties the removed cockpit host had, which are worth keeping).

## First slice (acceptance)

The projection and store-reader halves of items 2 and 3 exist as a library in the bridge below; the server, the page and the
API-level replay test follow in the next stages.

1. `endo cockpit <root>` serves a static page and a read-only JSON API over the store and registry.
2. The page shows identity, the last change notice, capability state with reasons, and a session timeline that updates
   as events are appended.
3. A test replays a recorded store (`research/pi-conformance/1.0.0` can seed one) and checks that the API output equals
   a projection computed directly from the records.
4. No import of any harness package; the boundary guards cover the new directory.

Controls and multi-attachment views come after the read-only slice has survived real use.

## The observation bridge (implemented)

A harness-neutral, read-only layer that turns existing durable records into deterministic, validated, versioned
presentation data. It is a library; it serves nothing and renders nothing.

```text
canonical records (event log, harness registry)
  -> cockpit/reader.ts            read-only store access, source conditions and watermarks
  -> cockpit/projections/*.ts     pure functions: validated records in, contracts out
  -> protocol/cockpit.ts          versioned contracts and their validators
  -> cockpit/snapshot.ts          the API a transport calls (re-exported by cockpit/index.ts)
```

**Contract ownership.** `protocol/cockpit.ts` owns the wire shapes and imports only the protocol. Projections are derived
data, not evidence: they are never written back, are not in the durable-schema catalogue, and still follow its rule
(`docs/schema-compatibility.md`): a closed record rejects unknown fields and an unknown version is `unsupported-version`,
never partially read.

| Output | From | Contains |
| :--- | :--- | :--- |
| `endo.cockpit-runtime-identity.v0` | one attachment's registry | latest fingerprint, the latest different one, last change, last notice, notes on records that disagree |
| `endo.cockpit-capability-state.v0` | the same registry | the latest recorded state verbatim, the evidence each entry cites, its limitations, derived `limits` where records disagree |
| `endo.cockpit-session-timeline.v0` | the event log | a bounded window in storage order, flags for interruptions, discontinuities, anomalies and unrecognized records |
| `endo.cockpit-snapshot.v0` | all of the above | the timeline window and one runtime view per attachment, `consistency: "independent-sources"` |

Every top-level record names its `source` (domain, condition, watermark) and carries a `projectionVersion`. The same
validated inputs under the same projection version give byte-identical canonical JSON: no clock, random id, root path or
host detail enters a result.

**Read-only guarantees.** The reader opens the event store and each registry only with `{ readOnly: true }`: it creates
no directory, cuts no torn tail, writes nothing, and never reparses a frame file itself. It probes the path first,
because the stores' own read-only open reads an absent or unreadable log as empty. A source is exactly one of:

| Condition | Meaning |
| :--- | :--- |
| `absent` | nothing there (a registry may legitimately not exist; reading never creates it) |
| `empty` | the log exists with no frames |
| `readable` | every frame verified and validated |
| `degraded` | the verified prefix is served; a torn tail (length and sha256 reported) or a frame that failed verification (`sealedAt`) follows |
| `unopenable` | it exists but cannot be opened (invalid record, unknown version, unreadable or dangling path); the bounded error is reported and nothing is projected |

A torn tail is also what a live writer's append in flight looks like to a reader. It is reported as `degraded`, not
guessed to be a crash, and a later read may find it complete. Every read reopens and validates the whole log, so cost is
proportional to the log; the page bounds what is returned.

**Independent histories.** The event log (storage-order sequence), each attachment's registry (an append-only record
history with no cursor) and the cognition graph (its own revisions; not read by this bridge) share no sequence and no
atomic boundary. Sources are read one after another: the event log first, then registries in code-unit order. A snapshot
says so (`consistency`) and carries each source's own watermark:

- event log: `{ length, lastEventId, prefixDigest }` (the digest is over the event ids in storage order). `storageSequence` is the 1-based append position and the only ordering of the
  timeline; producer `sequence` and recorded `at` are shown and order nothing.
- registry: per-kind counts, last ids and a `contentDigest` of the records. There is no incremental cursor, so any
  difference means re-reading that attachment.

`checkEndoCockpitSourceFreshnessV0(root, heldSource)` tells a consumer, per source, `unchanged`, `advanced` (event log:
more events and the events it held are still the first ones, by id and order, so page on from `afterSequence = old
length`), `changed` (re-read), `diverged` or `shrunk` (event log rewritten or shorter: discard and take a fresh snapshot),
or `unavailable`. The prefix check is by event id; frame integrity is the log's own digest check, reported as `degraded`.
A registry update never moves the event log's watermark, and an event append never moves a registry's.

**Provenance.** Presented values are claims with a basis: `observed` (collected by Endophasia from the local
installation or process), `reported` (stated by the runtime), `derived` (computed by Endophasia from recorded facts,
including derivations the record declares), `unavailable` (with a reason). `inferred` is in the vocabulary and reserved:
no v0 projection infers missing evidence. An event's own source class (`runtime-fact`, `interpretation`, ...) is carried
verbatim next to these, not mapped into them. Every claim and record carries a reference (`event-log` storage sequence
and id, or `harness-registry` attachment, kind, index and id) to what it was read from. The projections do not recompute
capability admission: the recorded status is carried as written, and `limits` only name disagreements between records
(a state for an older fingerprint than the latest recorded, or for one nobody recorded; a cited evidence record that is
missing, names another capability or classifies differently; evidence recorded under a different runtime identity than
the one the state names; evidence carried across observations on a reduced-confidence identity; a status that does not
follow from its classification). Evidence legitimately outlives the observation it was recorded against while the
identity digest is unchanged, so the observation id is not compared, only the identity. A state recorded for an older
observation (for example, after `identify` but before the next check) is reported `stale`, as `endo doctor` does.

**Sensitive-data boundary.** Projections copy an allowlist, not records. Opaque ids and digests (event, evidence and
entry ids, identity and keyed argument/result digests) are kept. Withheld, and counted or named as withheld: local paths
in fingerprints and changes, the version command's raw output, a collection failure's text, a notification's lines (they
embed paths and failure text), evidence `expected`/`observed` text, `harness.attached` arguments, failure and recovery
details, tool arguments and results, and every payload field of a kind the projection does not list. A kind that is not
listed appears by its envelope alone and is flagged `unrecognized`. Presented strings are cut at 256 characters and a
producer name at 512, so any valid stored record fits the contract. A future explicit evidence-inspection endpoint can
extend this safely only by being a separate, deliberate request for one referenced record: addressed by the `ref` a
projection already carries, gated and logged by the transport, serving one record's approved body or reporting that none
is approved, and never widening the allowlists of the default projections.

**Not in the bridge.** No server, no watcher, no polling, no SSE, no renderer. The session overview reducer
(`reduceEndoSessionOverviewV0`) is not applied: it needs the whole log, not a window. Usage is shown per event where
recorded and is not summed (the same call can be recorded by more than one event). The cognition graph is not read.

**For the next stage (local HTTP).** A server needs only `cockpit/index.ts`: `readEndoCockpitSnapshotV0`,
`readEndoCockpitTimelineV0(root, { afterSequence, limit })`, `readEndoCockpitRuntimeV0(root, attachment)`,
`checkEndoCockpitSourceFreshnessV0`, and `readEndoCockpitRecordV0` to validate what it forwards. Bodies are the contracts
unchanged; pagination is the timeline `window`.
