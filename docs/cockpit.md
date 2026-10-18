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
| `degraded` | the verified prefix is served; a torn tail (length and a keyed token of its bytes reported) or a frame that failed verification (`sealedAt`) follows |
| `unopenable` | it exists but cannot be opened (invalid record, unknown version, unreadable or dangling path); the bounded error is reported and nothing is projected |

A torn tail is also what a live writer's append in flight looks like to a reader. It is reported as `degraded`, not
guessed to be a crash, and a later read may find it complete. Every read reopens and validates the whole log, so cost is
proportional to the log; the page bounds what is returned.

**Independent histories.** The event log (storage-order sequence), each attachment's registry (an append-only record
history with no cursor) and the cognition graph (its own revisions; not read by this bridge) share no sequence and no
atomic boundary. Sources are read one after another: the event log first, then registries in code-unit order. A snapshot
says so (`consistency`) and carries each source's own watermark:

- event log: `{ length, lastEventId, prefixDigest, keyId }`. The digest binds the **complete contents** of the events read,
  in storage order. Internally a chain is computed (the sha256 over one line per event, each line the lowercase hex sha256
  of the event's canonical JSON followed by `"\n"`); the chain commits to content the timeline withholds, so it is never
  published. What is published is `HMAC-SHA256(key, canonical JSON of { purpose: "endo.cockpit.event-prefix.v0", length,
  chain })`; an event replaced under the same id with another kind, coordinates, payload or time changes the chain and so
  the token. `storageSequence` is the 1-based append position and the only ordering of the timeline; producer `sequence`
  and recorded `at` are shown and order nothing.
- registry: per-kind counts, last ids and a `contentDigest` of the records, plus `keyId`. There is no incremental cursor,
  so any difference means re-reading that attachment. A registry with records is committed to by `HMAC(key,
  { purpose: "endo.cockpit.registry-content.v0", content })`; a registry with none commits to nothing, so its digest is
  the fixed unkeyed constant (below).

**The digest key (a contract of this version).** A plain hash of data the cockpit withholds is a confirmation oracle: a
reader who knows the surrounding envelope can enumerate guesses for a low-entropy hidden value until the hash matches, and
a second unkeyed hash or a public salt does not change that. So every value the bridge publishes that is derived from
withheld bytes is a keyed token under a key the **caller supplies explicitly**: `digestKey` on every read, a second
argument on every projector and on the freshness check. The library creates no key, loads none, reads no environment and
writes nothing (`loadOrCreateEndoDigestKeyV0` and `endoDigestKeyFromEnvironmentV0` are not reachable from `cockpit/`; a
test pins that); a host loads an existing key at its own boundary and should use one dedicated to the cockpit, not the
evidence-comparison key (tokens are domain-separated by `purpose`, but a dedicated key keeps the two apart). A public
fixture key (`endoDigestKeyV0(..., { public: true })`) may be supplied for synthetic data; it offers no secrecy, and its id
is its name, so a reader of any source sees that. Key material is never serialized: sources record only `keyId`. The
keyed tokens are: the event prefix digest, the registry content digest (when it has records), a torn tail's `digest`
(`purpose: "endo.cockpit.torn-tail.v0"`, over its length and plain hash), identifier and kind aliases
(`endo.cockpit.id-alias.v0`, `endo.cockpit.kind-alias.v0`), and the stored identity digest (which covers the real path),
configuration digest (the user's configuration) and supporting transcript digests where they are presented
(`endo.cockpit.identity-digest.v0`, `-configuration-digest.v0`, `-supporting-digest.v0`); equal stored digests give equal
tokens under one key, so every comparison between views holds, and the stored evidence is unchanged. Digests of data that
is itself shown or public stay as they are (the entrypoint file's sha256, an ACP session reference, keyed tool-argument
digests that are already HMACs). Determinism: the same source data, projection versions and key give byte-identical
output; another key gives other tokens and aliases. A read without a usable key throws a `TypeError` before touching the
disk (it is a usage error, not a source condition); a projection under a key other than the one in the source's
watermark is refused. `checkEndoCockpitSourceFreshnessV0` compares the key context first: another key, or none, yields
`digest-context-differs` and never `unchanged`, `shrunk` or `diverged`. A snapshot's sources share one `keyId`.
Residuals, stated rather than claimed away: an empty registry commits to nothing, so its digest is an unkeyed constant; a
key holder can still confirm a guess (the key is the secret); a public key's id is its name, so two public keys of one
name and different bytes look like one context (the repository's loader pins public names to bytes); tool-argument
digests under a public fixture key are confirmable (producer policy keeps public keys to fixtures, and the `keyId`
shows it); the entrypoint file's sha256 is kept (it hashes a public artifact whose size is shown beside it).

**What changed in `.2`.** `watermark.keyId` is new on both source kinds; `tornTail.sha256` is `tornTail.digest` (keyed);
`prefixDigest`, `contentDigest` (with records), identifier and kind aliases and the stored identity, configuration and
supporting digests are keyed tokens; `digestKey` is required on every read (`readEndoCockpitEventLogV0`,
`readEndoCockpitRegistryV0`, the timeline, runtime and snapshot reads) and is a required argument of the three projectors
and of `checkEndoCockpitSourceFreshnessV0`, which gains the outcome `digest-context-differs`; every projection version is
`cockpit-*.2`, so a held `.1` record fails the exact match. These are changes to a contract not yet released.

**What changed in `.3`.** A content-addressed evidence id (`endo.evidence.<name>.<64 hex>`: a runtime fingerprint, a change, a
notification, a capability check, an intervention) is the sha256 of a body that can contain withheld facts (a fingerprint's
real path, the identity and configuration digests, a check's expected and observed values), so it is a commitment to them
and, like the identity digest, a confirmation oracle for a guessed body. It is therefore never presented as it is: wherever
it occurs (a reference, a watermark's last id, a state's fingerprint, an evidence dependency, a change observation, a
`derivedFrom`, a `harness.attached` or `harness.runtime-changed` field) it is presented as its keyed alias
`endo.evidence.withheld-<32 hex>`, the same value for the same id everywhere under one key. `harness.attached.identityDigest`
is presented as the same keyed `identity` token the registry views carry (a malformed value is withheld, not shown). The
public-id grammar of the wire refuses a raw content-addressed id, so a serialized page carrying one is rejected; as with
every keyed value, the wire cannot prove a token was made under a particular key, only that no raw commitment is present.
Event ids (a hash of the runtime's own session and entry identifiers, themselves runtime-chosen opaque values) are not in this family: ids the runtime chose (event, entry, tool-call ids) are admitted by shape and content only, which is a stated residual, not a guarantee.
Every projection version is now `cockpit-*.3`; a held `.2` value or watermark fails the exact match, and its fingerprint ids
would read as changed, which is the safe direction. Also tightened in `.3`: ids are unique across all five record kinds,
a timeline window's first consumed position is always presented, a `foreign-attachment-record` or `duplicate-record-id` note
names exactly one record, and `usage` on an ineligible message counts as withheld.

Three more relationships between public values are decided by the wire (no output changes, so no version change):
`withheldFields` is at least what the presented fields prove was left out (a field read from a nested payload path, or a
value replaced by the withheld text, leaves its top-level key unpresented; distinct keys only; it is a lower bound, since an
absent `usage` or a payload key the entry never mentions proves nothing); a registry watermark names no id as the last of
two kinds (ids are unique across kinds, and keyed presentation keeps equal ids equal); and a `foreign-attachment-record` or
`duplicate-record-id` note never names, by its complete reference, a record the same projection presents as a view (the
current fingerprint, previous different fingerprint, last change, last notice, the state, or a cited evidence record). The
wire does not decide whether a discarded record was really foreign or repeated; that needs the records. A direct projector
given records whose watermark repeats one id as the last of two kinds (a source no registry can produce) throws a
`TypeError` rather than return a projection its own validator refuses; no replacement id is invented. A repeat that is not
the last record of its kind still yields the note.

Four more relationships the presented values decide, again with no output change and so no version change (validators only).
A notice with `counts.change === 0` requires exactly one `notification-change-missing` note (with changes recorded, whether
the named one is among them is not decidable from the view, and the note is not demanded). An admitted capability whose
state names a fingerprint, with `counts.fingerprint === 0`, requires `state-fingerprint-not-recorded` (in a nonempty history
an older record may exist, so it is not demanded). The latest record of a kind is the latest *kept*: the highest position
the foreign/duplicate notes do not name (none, when all are named), and, when that is the watermark's last position, it
carries the last id; a discarded tail relaxes only that. Capabilities citing one evidence record show the same evidence view
and the same limitations; their `limits` agree where the record or the state decides them and may differ where the entry does (round 17). None of this verifies the records.

Five more, validators and one projector input (no output change, so still `.3`): an entry observation whose usage claim
is anything but "no entry details" proves its `details` object and so counts it in `withheldFields`; two presented records
of different references never carry one id (and no cited evidence id equals a fingerprint id the state names; one evidence
reference shown by several capabilities is one appearance); a cleaning note names each discarded position once, under one
code; a timeline page whose cursor lies before a known tail must advance (the direct projector throws on a window that
consumes nothing there, rather than invent progress); and a recorded runtime family in the reserved `withheld-` namespace is
presented as its keyed kind alias, like any other kind (the value changes only for a source that wrote that namespace, which
no producer does, so the projection version is not bumped: `.3` already reserved that namespace, so passing such a source value through was never valid). A lifecycle `runtime` field in that namespace is likewise withheld whole, and the snapshot validator applies the distinct-ids rule across an attachment's identity and capability views.

Four more, validators only (no producer or wire change, so still `.3`): a `harness.attached` runtime session reference replaced by the fixed withheld text proves at least one omitted `piSessionId`/`acpSessionId` key (counted once; a conflict between the two proves both omitted); the identity and capability views of one snapshot attachment must set aside the same fingerprint records for the same reasons (complete reference plus code, order-insensitive; other diagnostics are each view's own), and a capability state's `latestFingerprintId` must be the identity's current fingerprint id (null with none), while `fingerprintId` stays a possibly historical reference that is not compared; a state with any admitted capability must name a `fingerprintId`; a `runtime-disagreement` note cites at least two records at distinct positions; and one position of one kind carries one id wherever a view or snapshot names it (so a position cannot be both presented and discarded under two ids) (that their runtime families differ remains the source's to show).

Seven more (still `.3`: no producer output or wire shape changes; the projector now refuses an input its source does not describe, which is a precondition, not an output): a message's malformed `usage` counts its top-level key in `withheldFields`; with exactly one change kept a notice naming another change requires `notification-change-missing`, and with exactly one fingerprint kept a state naming another id requires `state-fingerprint-not-recorded` (several kept leave both undecidable unless a presented record of another kind owns the id, see round 16; "kept" is the watermark count less the positions the cleaning notes discard); a `duplicate-record-id` note follows the cleaner's id ledger (round 16) and `duplicate-capability` cannot appear with no capability presented; and when a snapshot's state names a fingerprint its identity view embeds (current, or the latest with another identity), the evidence limits `evidence-identity-differs`, `evidence-confidence-differs` and `evidence-reduced-identity` are required or refused by the same predicate the projector uses (a historical fingerprint the snapshot does not embed is never reasoned about); likewise `state-fingerprint-not-recorded` is refused when the state names an embedded fingerprint and required when every kept fingerprint is embedded and none is named. Both registry projectors now admit their input through one check (`admitRegistryInputV0`): the supplied records of ALL five kinds must be those the source's watermark advertises (counts, last ids, content digest, built by the reader's own `registryWatermarkV0`) under a condition that can hold them, or the projector throws `TypeError`; foreign and repeated records stay admissible and are cleaned and noted. A direct caller builds the advertised position with the exported `registryWatermarkV0`, the same construction the reader uses.

Round 16, validators only (`.3`: nothing a projector emits changes; five older tests asserted input no projector can produce and were rewritten). Ids are unique across all kinds of a registry, and the cleaner keeps one id ledger over the kinds in `ENDO_COCKPIT_REGISTRY_KINDS_V0` order, to which only KEPT records of an earlier kind (or earlier in their own kind) belong: foreign records and repeats never enter it, a state has no id. So: a notice naming the id of the presented current or previous-different fingerprint, or of the notice itself, names no change and requires `notification-change-missing` however many changes are kept (in a snapshot also an id cited as evidence); a state naming the id of a cited evidence record names no fingerprint and every admitted capability requires `state-fingerprint-not-recorded` (in a snapshot also the id of the presented last change or notice); a `duplicate-record-id` note is impossible when no earlier kept record can exist, must carry one of the earlier ids when every earlier kept id is exposed by the projection (presented views, the latest kept fingerprint a state names, the watermark tail of a kind the view cleans, and from round 19 every kept reference, presented or not), and cannot carry the id of a kept record presented after it; in a snapshot the two views' notes are checked together as the full ledger. A shown `details.*` field refutes the usage reason "the event records no entry details". An absent or unopenable registry carries only `source-not-projectable`: failing to observe records is not observing their absence. A `runtime-disagreement` note cites no discarded position and always the current fingerprint (the last kept fingerprint is its family's representative). Not decided from the wire, by design: ids of kept records the projection does not present, whether families actually differ, whether a historical fingerprint exists, and whether a notice's change is among several kept changes when no presented record owns its id.

Round 17, validators only (`.3`: nothing a projector emits changes; three test helpers that removed a state-level limit from a single capability were made uniform, since that is exactly the mutation now refused). Registry ids are unique across all kinds, so within a projection, and across both views of a snapshot attachment, one non-null id is one position: every reference outside the cleaning notes points at a kept record, and the latest kept fingerprint and the kept tails of the cleaned kinds are pinned (a disagreement note citing one id at two positions, or a limit citing the latest fingerprint at another position, is refused). Limits come from three places. Those of the state and its retained fingerprint history alone (`state-fingerprint-not-recorded`, the fingerprint references of `runtime-differs`, and the currency limits) are the same for every admitted capability, and a state whose named fingerprint is unrecorded cannot also cite it. Those of an evidence record and the state (`evidence-identity-differs`, `evidence-confidence-differs`, `evidence-reduced-identity`, `runtime-differs`) are the same for the admitted capabilities citing one record. Those of the entry (status, `requires`, classification, `evidence-record-missing`, `evidence-capability-differs`) may differ: the evidence view does not say which capability the record names, so at most one capability citing it may omit `evidence-capability-differs`, and any number may carry it. Unverified entries carry no limits and are not counted. Not decided from the wire: which capability a shared record names, whether runtime families differ, whether a historical fingerprint exists, and where an unexposed older kept fingerprint sits.

Round 18, validators and the source boundary (`.3`: nothing a projector emits changes; the one observable change is that the reader refuses to read, and no longer lists, an attachment whose name contains a reserved `withheld-` segment, a namespace `.3` already reserved for generated aliases, so such a name was never a valid output). Three notions are kept apart: a position a cleaning note discards, a record a kept reference establishes (existence and kind, never attributes), and a fact only the canonical source holds. No reference outside the cleaning notes may name a discarded position (this subsumes the earlier rules for presented views and disagreement notes, and covers the limit references of a capability). A kept reference of kind K with id X establishes that a kept K record owns X and that no other kind does, from either view in a snapshot: a notice naming an id a kept non-change record owns requires `notification-change-missing` (one a kept change owns forbids it); a state naming an id a non-fingerprint record owns requires `state-fingerprint-not-recorded` on every admitted capability; and a state naming an id a kept fingerprint owns (a limit or, in a snapshot, a disagreement note cites it by complete reference) forbids that limit and requires `evidence-reduced-identity` for every admitted capability whose cited evidence is carried from another fingerprint and reduced, because that is decided by the evidence side alone. The named fingerprint's own digest, confidence and runtime remain unknown unless its view is embedded. Inferences from a validated claim only add obligations or refusals, never discharge one. Attachment names are never aliased: the reader (reads and discovery), `admitRegistryInputV0` and the wire validator all refuse a name with a reserved segment. Not decided from the wire: a named fingerprint's attributes when it is not embedded, the kind of a duplicate note's owner when its candidates span kinds (round 19 decides it when they share one), which capability a shared record names, and whether runtime families differ. Deferred: the producer name admitted after a colon may itself begin `withheld-`.

Round 19. A runtime family, a capability name and an event kind are dotted kinds in the protocol's kind grammar (lowercase segments, at most 128 characters), and `fingerprintId`, `previousFingerprintId` and `currentFingerprintId` of a timeline entry are evidence identifiers (`endo.evidence.*`): the registry validators of `protocol/harness.ts` already require both (`isWellFormedKindV0` for a record's runtime, an evidence id for a fingerprint), every producer writes them (`pi`, `acp`; `endo.evidence.pi-fingerprint.*`), and the timeline policy now says so. The projector now withholds (or, for a kind, aliases) a source value outside that contract instead of presenting it, and the validator applies the same field policy; the durable event store validates the envelope, not the kind-specific payload, so such values could be stored. `.3` is kept as a judgment call: a conforming source's output is byte-identical, and what changes is the output for a stored payload outside that existing contract (a lifecycle runtime that is not a kind, a fingerprint reference of another namespace), which is now withheld, as with the reserved runtime family of round 13. Direct projector input also changes in one way: an event kind, capability name or runtime outside the grammar is presented as its keyed alias where it used to be presented raw and refused by the projector's own validator (a TypeError); the durable store's envelope check keeps such a kind off the durable path. Duplicate notes: a valid `duplicate-record-id` note says an earlier KEPT record owns its id; when every record that could be that owner (by the cleaner's kind order, with discarded positions removed, and every position of a kind the view does not clean) has the same kind, that kind owns the id, which feeds the same cross-kind rules as a kept reference (a state naming it is a recorded fingerprint, or not one; a notice naming it names a change, or not). No position and no attribute is inferred, and a note that fails the ledger scan contributes nothing. Kept references at unpresented positions now also count as evidence for the ledger rule, so a duplicate cannot be contradicted by a kept record of another kind that carries its id. Not decided from the wire: the owner's position, and its kind when the candidates span kinds.

Round 20 (`.3` kept, as a judgment call: a conforming reader's output is byte-identical; what changes is which direct projector input is accepted and, in the snapshot validator, which already-unproducible snapshots are refused). Source commitment: when the timeline projector is given the whole prefix of the log (it begins at the start and reaches the source's declared length) it recomputes the prefix digest from the ORIGINAL stored events under the caller's key and refuses input whose source advertises another (a `TypeError`, as every other input contradiction). The construction is the reader's own and is shared (`eventLogPrefixDigestV0`, exported from `cockpit/`): one line per event in storage order, every event of the window framed, a repeated id included (the lowercase hex sha256 of its canonical JSON and a newline), the sha256 of the lines, and the keyed token of `{ length, chain }` under the event-prefix purpose; the reader streams the same lines into one hash. A window that begins later, or stops short of the declared length, lacks events the digest covers, cannot be checked and is not refused; the serialized timeline and snapshot contracts hold only privacy-reduced entries and stay shape-only on the digest. A caller that supplied a complete window with a made-up digest was accepted and is now refused (the one observable change; the test fixtures that did so now model a reader), and so is a complete window holding an event canonical JSON cannot serialize, which the reader could not have digested. Duplicate owners: the candidates for the owner of a `duplicate-record-id` note are the earlier kept positions (the cleaner's kind order, discarded positions removed, every position of a kind the view does not clean) whose id is not shown to be another; the validity of a note is unchanged, and the candidate kinds can only shrink, so a kind-only owner is established more often and only ever adds obligations or refusals (the owner's position, and its kind when candidates still span kinds, stay open). Runtime families: the state and its evidence present no runtime, so the snapshot decides only a relation between the fingerprint the state names (H) and the latest one (L), from the identity's `runtime-disagreement` note, which cites one fingerprint per distinct family (the latest kept of each; no note means one family). The note citing both H and L says their families differ, so the state's single runtime differs from at least one of them and every admitted capability carries a `runtime-differs` citing a fingerprint, H or L, which one is not on the wire, and a limit citing only the evidence record does not count. H a kept fingerprint the note does not cite, with no cited fingerprint besides L possibly after it, has L's family (its representative is a later cited fingerprint): the limit cites H and L together or neither. Anything else establishes nothing, and two different ids never do. No raw family is inferred. Not enforced: that relation when no kept reference shows H (nothing then shows it exists or where it sits), and when a cited fingerprint other than L may come after an uncited H; the models show the note's reference order, which records the order in which families first appear, would decide some of those cells. Not decided from the wire: the facts listed in earlier rounds. These are checked by bounded exhaustive models (`tests/endo-cockpit-twentieth-model.test.ts`): histories against mutations of content, order, key and token; small registries against the owner kinds the wire leaves open; and every assignment of hidden runtime families to small registries, where each snapshot the real projectors produce is accepted and what no assignment produces is refused except in declared cells.

Round 21, validators and one producer rule (`.3` kept, as a judgment call: nothing a conforming source produces changes, with the one exception below). Cost: a validator's work is bounded by the representation it is given, never by the cardinalities that representation declares. A watermark's record counts are untrusted (a few bytes can state a count near `Number.MAX_SAFE_INTEGER`), so no validator walks, allocates or names a position that is not itself supplied. The duplicate-record scan is therefore sparse (`protocol/cockpit-ledger.ts`, internal and not re-exported): per call it sorts the supplied discarded positions and the supplied shown positions of each kind and records, per id and kind, the lowest non-discarded and highest shown position carrying it; per note it visits the four kinds that carry an id in the cleaner's order, up to the note's own, and counts the candidate predecessors of a kind by subtraction, `upto - discarded below - shown below` (two disjoint subsets of `[0, upto)`, so nothing is subtracted twice and every term stays a safe integer), plus the positions shown with the repeated id. Time is O((D + E) log (D + E)) to build and O(kinds log (D + E)) per note, space O(D + E), for D discarded and E shown positions; nothing depends on a count. The old enumerating scan is kept in the tests as the specification and agrees with it exhaustively for small counts, on seeded random registries with defensive entries, and at any larger count. The same audit found three paths that were quadratic in the number of supplied items (every pair of presented views compared with the full reference grammar re-run for each pair, a scan of the earlier capabilities for each cited evidence record, and a pairwise check of the references of one disagreement note); they are now linear (2000 capabilities took 37 s and take 0.15 s). Checked and linear: the timeline's session summaries (10,000 entries in 10,000 sessions take 0.13 s; 200,000 summaries beside one entry, 0.54 s), the freshness check (it digests at most the events of the real store), and validators fed deeply nested or very long replacement values at every path of a canonical view (no exception, no stall). Deliberately not changed, with the measurement: the URL-scheme pattern of the shared text policy is quadratic in the length of ONE string, and every caller bounds the string first (256 characters for a presentable label, 128 for a kind, the identifier grammar for an id, all ASCII). Its worst case is a label of 256 compatibility characters such as U+2167, which fold under NFKC to 1,024 scheme characters: 0.83 ms (0.11 ms for 256 ASCII letters), so about 3 s for a megabyte of such labels, linear in what is supplied. Producer rule: the two members of a tool event's keyed digest are shown together or not at all, and not only when the parent is a well-formed digest but when both members are presentable text, so a key id the text policy flags (a public key's name is any lowercase slug, and `sk-` followed by sixteen characters is one) omits the pair where it used to show the digest beside an unavailable key id. The shared field policy then refuses an unavailable form for any member of a keyed digest, so a validated entry cannot hide the comparison domain of a digest it shows; this is the one observable change in producer output, and only for such key ids. Three changes to what is accepted or produced, for the owner to weigh against keeping `.3`: the producer omits a keyed-digest pair whose key id the text policy flags (it showed the digest beside an unavailable key id); the validator refuses an unavailable member of a keyed digest; and direct projector input whose fingerprint confidence contradicts its facts is refused by the projector's own validation (a `TypeError`), where a registry cannot hold such a record. A fingerprint view's confidence must agree with the facts it shows: `strong` exactly when the entrypoint and the reported version are both recorded (the durable rule), where a claim unavailable for the recorded-gap reason is a missing fact and a version withheld by the privacy policy is a recorded one; a change observation's confidence is not tied to its version by the protocol and is not checked. Not decided from the wire: the facts listed in earlier rounds.

Two facts the wire alone decides are enforced by the validators. `sealedAt` is the first frame that failed verification,
so it is exactly the one after the verified prefix: `watermark.length + 1` for an event log, the sum of the registry
counts `+ 1` for a registry (a torn tail is a different condition and carries no position). A registry with no records
has fully known content, so its `contentDigest` is fixed: the sha256 of the canonical JSON `{}` when it is absent, and
of the five empty record lists when it was opened (empty, or degraded before any verified record). A capability has a
classification exactly when its status is not `unverified`; its limitations are the cited evidence's own, so there are
none without evidence; a notification view has at least one line (`lineCount >= 1`). A reported or unavailable wrapper
carrying a member beside `status` and `value`/`reason` still shows the value or reason, but its key counts as withheld; so does a declared gap (`unavailable`) with a member beside `field` and `reason`, or whose reason was withheld. A log is never both torn and sealed (the reader stops at the first corrupt frame), and a torn tail is at least one byte.

The runtime's session reference is admitted by shape (UUID, `sha256-` digest, Endophasia's generated id) wherever it is
recorded, including `lifecycle.session-started` and `-resumed`; any other value is withheld whole. An `unavailable` field
is valid only where the projection produces one: for a runtime-reported field (the reason the runtime gave, as text that
passes the text policy) and a declared gap likewise, for a string the boundary withheld (the fixed text), and for the
conflicting references of `harness.attached`; never for a derived or observed number or boolean. The `discontinuity` flag
of `harness.store-opened` is set exactly when a shown recovery value is true: a flag with none shown true has no cause and is refused, and all three shown
false forbids it (a value not shown is not read as false, so an entry showing none is unflagged). A usage-unavailable reason is one the kind can produce (`the event records no entry
details` only for `session.entry-observed`). A timeline page spans at most `ENDO_COCKPIT_PAGE_MAX_LIMIT_V0` positions, and
the note of an unopenable timeline cites nothing. A runtime identity's withheld family needs a current fingerprint or last
change to have named it, its previous different observation is another record (another id) than the current one, and a
capability whose state names the latest fingerprint, citing evidence recorded against another fingerprint on a reduced
identity, carries `evidence-reduced-identity`. The 256-character rule is unchanged: the Pi specimen's 283-character
reason stays withheld (its limitations are recorded separately in evidence).

`checkEndoCockpitSourceFreshnessV0(root, heldSource, digestKey)` tells a consumer, per source, `unchanged`, `advanced` (event log:
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

**Identifiers and aliases.** (Content-addressed evidence ids are the exception to the next sentence, and are always aliased: see "What changed in `.3`".) An identifier is presented as it is when its opaque local part is lowercase letters, digits and hyphens in dot-separated segments of at most 64 characters and the content check passes it; real identifiers (digests, counters, attachment-derived names) are of that shape. Any other identifier is presented as a deterministic alias in the same namespace, `endo.<kind>.withheld-` and 32 hex digits of a keyed token of the identifier (above), the same everywhere under one key it appears, so every reference relationship (a derived event and its source, a state and its fingerprint, the watermark's last event and the entry) holds, while the underlying identity protocol is unchanged. The alias is one-way, and a reference stays addressable by position (`storageSequence` or `index`), which the alias does not touch. The alias namespace is reserved: any identifier or dotted kind with a segment beginning `withheld-` is never presented as it is, only aliased, so a generated alias can never equal a value a source wrote and two distinct sources never share a public value (source admission and public validation are separate: a wire record may carry an alias, a source may not pass one through). Residuals, stated rather than claimed away: a lowercase hexadecimal credential is indistinguishable from the digests identifiers legitimately carry; a low-entropy secret can no longer be confirmed against its alias without the key, but a key holder can.

**Notes and latest records.** A derived note is present exactly when its condition holds, once, with exactly its references, wherever the wire decides it (no fingerprint, a failed or unrelated latest change, no capability state, a state without a fingerprint); a note that needs the whole record list (a notice whose change is missing, a runtime family disagreement) is checked for a possible precondition and its references. `current`, the last change, the last notice, the capability state and the state's latest fingerprint are the records the watermark ends at (present exactly when there are any, at the last position, carrying the last id), and the previous different observation is an earlier one. When a record was set aside as foreign or repeated (a store never produces either) the latest is the latest KEPT record, which the watermark does not locate, and the check falls back to the range. Each registry projection carries only the notes its own projector emits (identity: no fingerprint, the two latest-change notes, a notice whose change is missing, a runtime disagreement; capability state: a duplicate capability, a state without a fingerprint, no state recorded; both: a source that is not projectable and the foreign/repeated-record notes, for the kinds each projection cleans), so a code of the other projection is refused.

**Declared gaps, digests and positions.** A session start or resume considers at most `ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0` (32) items of its `unavailable` list and presents at most that many `unavailable.<name>` fields (the validator enforces the same bound); a name declared twice keeps its last item and the array then counts once as withheld, as does an array with a lost, malformed or extra-member item. A tool event's `argsDigest`/`resultDigest` members are shown only when the whole parent object is an exact keyed digest (`hmac-sha256`, the key-id grammar, 64 lowercase hex; shape only, not the HMAC or the key's secrecy), together or not at all. The exported timeline projector requires its input positions to be contiguous from `afterSequence + 1` (a duplicate event consumes its position and is counted), so its result always accounts for the whole window.


**Public errors.** A source's `error` is one of a closed set of categories (`ENDO_COCKPIT_SOURCE_ERRORS_V0`), each with ONE fixed message, and the validator requires exactly that pair. Nothing a store, an operating-system error or a record said is public: an Error message can quote an identifier, a path or the record's own text, so the category is chosen from the typed error or the store's own fixed phrase and the message is the category's sentence. A future explicit evidence-inspection endpoint can
extend this safely only by being a separate, deliberate request for one referenced record: addressed by the `ref` a
projection already carries, gated and logged by the transport, serving one record's approved body or reporting that none
is approved, and never widening the allowlists of the default projections.

**Not in the bridge.** No server, no watcher, no polling, no SSE, no renderer. The session overview reducer
(`reduceEndoSessionOverviewV0`) is not applied: it needs the whole log, not a window. Usage is shown per event where
recorded and is not summed (the same call can be recorded by more than one event). The cognition graph is not read.

**For the next stage (local HTTP).** A server needs only `cockpit/index.ts` and one digest key that the host loads from
an existing key (never created, defaulted or persisted by the bridge) and passes explicitly to every call:

```ts
import {
  checkEndoCockpitSourceFreshnessV0,
  type EndoDigestKeyV0,
  readEndoCockpitRecordV0,
  readEndoCockpitRuntimeV0,
  readEndoCockpitSnapshotV0,
  readEndoCockpitTimelineV0,
} from "./cockpit/index.ts";

declare const digestKey: EndoDigestKeyV0; // host-managed, private; a public fixture key is for synthetic data only

const timeline = readEndoCockpitTimelineV0(root, { afterSequence, limit, digestKey });
const runtime = readEndoCockpitRuntimeV0(root, attachment, digestKey);
const snapshot = readEndoCockpitSnapshotV0(root, { limit, attachments, digestKey });
const verdict = checkEndoCockpitSourceFreshnessV0(root, heldSource, digestKey); // may be "digest-context-differs"
const record = readEndoCockpitRecordV0(body); // validates what the server forwards
```

Bodies are the contracts unchanged; pagination is the timeline `window`. A server validates a client's `afterSequence` and
`limit` itself against the exported bounds (`ENDO_COCKPIT_PAGE_MAX_LIMIT_V0`), so any `TypeError` from the bridge is a host
or internal defect, not a client error: a read without a usable key throws one before touching the disk, a projection
under another key than its source's throws one, and the projectors throw one for input that breaks their contract or
results that would fail their validators. `checkEndoCockpitSourceFreshnessV0` with another key, or none, answers
`digest-context-differs` for a source that holds a position instead of throwing.
