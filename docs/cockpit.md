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

- event log: `{ length, lastEventId, prefixDigest }`. The digest binds the **complete contents** of the events read, in
  storage order: the sha256 over one line per event, each line the lowercase hex sha256 of the event's canonical JSON
  (`runtime/contracts/canonical-json.ts`) followed by `"\n"`. Every line has the same width and alphabet, so the framing
  is unambiguous and any language can recompute it; an event replaced under the same id with another kind, coordinates,
  payload or time changes its line. `storageSequence` is the 1-based append position and the only ordering of the
  timeline; producer `sequence` and recorded `at` are shown and order nothing.
- registry: per-kind counts, last ids and a `contentDigest` of the records. There is no incremental cursor, so any
  difference means re-reading that attachment.

Two facts the wire alone decides are enforced by the validators. `sealedAt` is the first frame that failed verification,
so it is exactly the one after the verified prefix: `watermark.length + 1` for an event log, the sum of the registry
counts `+ 1` for a registry (a torn tail is a different condition and carries no position). A registry with no records
has fully known content, so its `contentDigest` is fixed: the sha256 of the canonical JSON `{}` when it is absent, and
of the five empty record lists when it was opened (empty, or degraded before any verified record). A capability has a
classification exactly when its status is not `unverified`; its limitations are the cited evidence's own, so there are
none without evidence; a notification view has at least one line (`lineCount >= 1`). A reported or unavailable wrapper
carrying a member beside `status` and `value`/`reason` still shows the value or reason, but its key counts as withheld; so does a declared gap (`unavailable`) with a member beside `field` and `reason`, or whose reason was withheld. A log is never both torn and sealed (the reader stops at the first corrupt frame), and a torn tail is at least one byte.

`checkEndoCockpitSourceFreshnessV0(root, heldSource)` tells a consumer, per source, `unchanged`, `advanced` (event log:
more events and the events it held are still the first ones, by complete contents and order, so page on from
`afterSequence = old length`), `changed` (re-read), `diverged` or `shrunk` (event log rewritten, repaired with different
events, or shorter: discard and take a fresh snapshot), or `unavailable` (the source cannot be opened now, or the held source had no position, such as an earlier `unopenable` read: take a fresh read as the new baseline). The event log is opened once per check, so the
length, the held prefix and the condition are one observation, and the log is traversed once. Frame integrity is the
log's own digest check, reported as `degraded`.
A registry update never moves the event log's watermark, and an event append never moves a registry's.

**Pagination.** The timeline `window` is `{ afterSequence, nextAfterSequence, hasMore }`. Entries satisfy
`afterSequence < storageSequence <= nextAfterSequence`, ascending and never beyond `watermark.length`. `hasMore` is
`watermark.length > nextAfterSequence` and is `null` exactly when the source has no position (`unopenable`, `watermark:
null`, which also has no entries). A cursor past the end of the log is a valid empty window, as the event store answers
it: `nextAfterSequence` stays at `afterSequence` and `hasMore` is `false`. Without ignored duplicates the cursor is
exactly the last entry's position; an ignored duplicate is read but not presented, so it may move the cursor past it
(`duplicatesIgnored > 0`). `sessions` is exactly what the presented entries give, in first-appearance order, and a zero-length watermark must agree with the condition (`empty` or `absent`, or `degraded`; never `readable`), as must a registry with no records. A snapshot's identity and capabilities for one attachment must carry identical sources. Every position in the window is either a presented entry or an ignored duplicate (`entries + duplicatesIgnored == nextAfterSequence - afterSequence`), so a window has no silent gap; a duplicate is unreachable through the canonical store, which refuses a repeated event id on open, and exists only for input that did not come from it. A window that ends at the end of the log ends at the event the watermark names last. An entry's `category` is defined by its `kind`, and its flags are listed once each in the vocabulary's order. A snapshot lists its runtime views in code-unit order of attachment. The validator rejects metadata that contradicts the watermark.

**Wire validation is not store verification.** `validateEndoCockpit*V0` and `readEndoCockpitRecordV0` prove that a
serialized record is well formed and consistent with itself: each view's `ref` is a registry reference of the right kind
with the view's own id, for the projection's attachment, inside the record count the source's watermark states (the last
position naming the watermark's last id); capability references equal the state's; limit and note references have the
kinds their code allows and name the fingerprints and evidence the state names; an event reference is never a registry
reference; `projectionVersion` equals the version declared for the record in `ENDO_COCKPIT_PROJECTION_VERSIONS_V0`
(exact match, nested projections included; `schemaVersion` stays the record's own, separate version). They do **not**
open the store: that the referenced record exists and says what the view says is only established by re-reading the
source through the reader. Usage is present exactly where the projection gives it, decided from the entry's presented fields: a `message.completed` that is not a user message, and a `session.entry-observed` of type message (not a user message), compaction, branch summary or usage; a value that is unavailable or withheld is never the word `user`. An unverified capability carries no evidence, no limits and no classification. A transport that must prove it re-reads; a consumer must not read "validated" as "verified on
disk".

**Provenance.** Presented values are claims with a basis: `observed` (collected by Endophasia from the local
installation or process), `reported` (stated by the runtime), `derived` (computed by Endophasia from recorded facts,
including derivations the record declares), `unavailable` (with a reason). `inferred` is in the vocabulary and reserved:
no v0 projection infers missing evidence. An event's own source class (`runtime-fact`, `interpretation`, ...) is carried
verbatim next to these, not mapped into them. Every claim and record carries a reference (`event-log` storage sequence
and id, or `harness-registry` attachment, kind, index and id) to what it was read from. The projections do not recompute
capability admission: the recorded status is carried as written, and `limits` only name disagreements between records
(a state for an older fingerprint than the latest recorded, or for one nobody recorded; a cited evidence record that is
missing, names another capability or classifies differently; evidence recorded under a different runtime identity than
the one the state names; the state, its cited evidence, the fingerprint it names or the latest fingerprint recording
a cheaper kind of check than the capability requires (`evidence-check-insufficient`; evidence from a costlier kind, such as a live study standing for a local check, is legitimate and raises nothing), different runtime families (`runtime-differs`, with those records as references: each record is valid alone, the
registry checks attachment, not family); evidence whose confidence differs from the identity record it names (`evidence-confidence-differs`, also when it names the same fingerprint id); evidence carried across observations on a reduced-confidence identity; a status that does not
follow from its classification). Limits are listed once each in one canonical order. Those whose precondition the wire itself decides (a stale state, no cited evidence, a classification that differs, a status that does not follow its classification, evidence from a cheaper check kind) appear exactly when it holds; the others can only be checked for a possible precondition and their exact references, because deciding them needs the registry: a forged limit of that kind with correct references is not detectable from the wire, which is the store-verification boundary and not a gap in the validator. Evidence legitimately outlives the observation it was recorded against while the
identity digest is unchanged, so the observation id is not compared, only the identity. A state recorded for an older
observation (for example, after `identify` but before the next check) is reported `stale`, as `endo doctor` does.

**Sensitive-data boundary.** Projections copy an allowlist, not records. Opaque ids and digests (event, evidence and
entry ids, identity and keyed argument/result digests) are kept. Withheld, and counted or named as withheld: local paths
in fingerprints and changes, the version command's raw output, a collection failure's text, a notification's lines (they
embed paths and failure text), evidence `expected`/`observed` text, `harness.attached` arguments, failure and recovery
details, tool arguments and results, permission and configuration contents, and every payload field the projection does
not list. Two tables decide what a timeline entry shows: the set of **recognised** kinds (every kind the Pi and ACP
producers, the lifecycle and intervention vocabularies record in the event log; a kind outside it is flagged
`unrecognized`) and, separately, the **allowlist of fields** per kind (a recognised kind with none appears by its envelope
alone, unflagged, its payload counted as withheld). The `harness.attached` runtime session reference is presented as
`runtimeSessionId` whether the producer recorded it as `piSessionId` or `acpSessionId`; if both are recorded and differ,
neither is chosen: the field is `unavailable`, the entry is flagged `anomaly`, and both keys count as withheld. It is
never the canonical session id. A `{ status: "reported" }` wrapper is read only for a field whose basis is `reported`; around an observed or derived field it is malformed and the field is omitted (counted as withheld), so a payload cannot change what a field claims to be. The reference is the runtime's own opaque string, so it is admitted only as a UUID, the `sha256-` digest form the ACP recorder writes, or the `endo-<attachment>-<12 hex>` id Endophasia generates for Pi; any other value is withheld whole (`unavailable`, counted as withheld) rather than judged by a content filter. The same applies to the event `producer` name: it is presented only in the shape Endophasia's producers use (a lowercase prefix, optionally `:` and an attachment-like name), else as the fixed withheld text. Free text a record author wrote (a capability reason, an evidence limitation, a notice
title, a fingerprint's package name and version, a reported version, the versions in a change's observations, an evidence record's check and dependency labels, and every presented string of a timeline entry) is bounded and passes a deterministic filter: text that looks like
it embeds a local path, a network address or a credential is replaced whole by a fixed withheld text
(`ENDO_COCKPIT_WITHHELD_TEXT_V0`; for a timeline field the field becomes `unavailable` with that text and its key counts
as withheld). The filter is a heuristic: it withholds, it does not certify what it passes, so a free-text value is also bounded and is **withheld whole when longer than 256 characters, never cut** (this includes a capability's recorded reason and an evidence record's limitations: the committed Pi specimen has one 283-character reason, which is therefore withheld) (a cut can split a secret so that neither half is recognised), judged on the whole value, after Unicode normalisation (NFKC) and with zero-width, bidirectional and control characters treated as unsafe. Values whose shape is known are admitted by shape instead, and by the same content check: identifiers, digests, the producer name, the runtime session reference, the names of declared gaps. Dotted kinds (a runtime family, a capability, an event kind, an attachment name) are valid whatever they say, so they pass the content check too; one it flags is shown as a placeholder (a withheld runtime family, `withheld-<hash>` for a capability, `other.withheld-<hash>` for an event kind) and an attachment so named is not listed (reading it by name is refused). The bases a v0 record may carry exclude `inferred`, and the basis of each identity claim is fixed by what it is (identity derived, version reported, entrypoint and package observed, or unavailable with the projection's own reason).

**Identifiers and aliases.** An identifier is presented as it is when its opaque local part is lowercase letters, digits and hyphens in dot-separated segments of at most 64 characters and the content check passes it; real identifiers (digests, counters, attachment-derived names) are of that shape. Any other identifier is presented as a deterministic alias in the same namespace, `endo.<kind>.withheld-` and 32 hex digits of its sha256, the same everywhere it appears, so every reference relationship (a derived event and its source, a state and its fingerprint, the watermark's last event and the entry) holds, while the underlying identity protocol is unchanged. The alias is one-way, and a reference stays addressable by position (`storageSequence` or `index`), which the alias does not touch. The alias namespace is reserved: any identifier or dotted kind with a segment beginning `withheld-` is never presented as it is, only aliased, so a generated alias can never equal a value a source wrote and two distinct sources never share a public value (source admission and public validation are separate: a wire record may carry an alias, a source may not pass one through). Residuals, stated rather than claimed away: a lowercase hexadecimal credential is indistinguishable from the digests identifiers legitimately carry; a low-entropy secret can be confirmed against its alias.

**Notes and latest records.** A derived note is present exactly when its condition holds, once, with exactly its references, wherever the wire decides it (no fingerprint, a failed or unrelated latest change, no capability state, a state without a fingerprint); a note that needs the whole record list (a notice whose change is missing, a runtime family disagreement) is checked for a possible precondition and its references. `current`, the last change, the last notice, the capability state and the state's latest fingerprint are the records the watermark ends at (present exactly when there are any, at the last position, carrying the last id), and the previous different observation is an earlier one. When a record was set aside as foreign or repeated (a store never produces either) the latest is the latest KEPT record, which the watermark does not locate, and the check falls back to the range.

**Public errors.** A source's `error` is one of a closed set of categories (`ENDO_COCKPIT_SOURCE_ERRORS_V0`), each with ONE fixed message, and the validator requires exactly that pair. Nothing a store, an operating-system error or a record said is public: an Error message can quote an identifier, a path or the record's own text, so the category is chosen from the typed error or the store's own fixed phrase and the message is the category's sentence. A future explicit evidence-inspection endpoint can
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
