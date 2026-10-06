# Schema compatibility

Endophasia records evidence that must stay readable. This document states what the project promises to read, how a
reader chooses how to read it, and what makes a change to a representation a new version.

Scope: **durable and imported records** only. A string named `schemaVersion` appears on many objects; most of them make
no durability promise. [The inventory](#inventory) separates the two.

## The rule

A durable record declares its schema in `schemaVersion`. The reader:

1. checks the input is a plain JSON object with an own `schemaVersion` that is a string;
2. looks that exact string up in the family's version table (a `Map`, never an object property lookup);
3. validates the whole record under that one version's rules, unknown fields included;
4. returns the record unchanged, or fails.

It never tries today's shape and accepts whatever fits. The primitive is `protocol/versioned.ts`
(`defineEndoVersionTableV0`, `readEndoVersionedV0`, `parseEndoVersionedV0`). It does not migrate, default or upgrade, and
it is not a registry of every family: each family owns its table next to its validators.

Four failures stay distinguishable, because a caller must be able to tell them apart:

| kind                  | meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `not-an-object`       | not a plain JSON object (an array, a class instance, `null`, bad bytes)  |
| `missing-version`     | no own `schemaVersion`                                                   |
| `version-not-string`  | `schemaVersion` is not a string (or is an accessor)                      |
| `unsupported-version` | a string this reader does not know; rejected before any validator runs   |
| `invalid`             | a known version, but the record does not satisfy that exact version      |

The throwing form is `EndoSchemaVersionErrorV0`, a `TypeError` carrying `kind` and, for the last two, the version. A
message never contains the record and bounds and quotes an attacker-controlled version string.

## What makes a new version

A version changes when accepting the new representation under the old decoder would change the old contract: adding a
field to a closed durable object, changing required/optional, changing a field's meaning, widening a closed enum, or
changing which nested versions a parent embeds.

- **Old versions stay old.** They are read under their original contract and are never rewritten.
- **Unknown fields are rejected** in closed durable records. Ignoring one turns "the producer supplied information this
  reader does not understand" into "the reader accepted complete evidence", which is the wrong claim for evidence.
  Intentionally open containers (an event's `payload`, a trial's `raw`/`derived`) are strict JSON whose interpretation
  belongs to their kind; they are not unknown fields of the envelope.
- **Unknown versions are rejected.** A typed durable reader never partially interprets one. (Carrying opaque bytes to a
  place that can read them is a separate design if it is ever wanted.)
- **Nothing migrates implicitly.** Reading and migration are different operations. A v0 → v1 transformation, if useful,
  is an explicit function with its own tests.
- **Writers emit the current version.** A writer emits an older version only when it intentionally implements that
  contract; it never "downgrades" a current object by deleting fields.
- **Nested versions are the parent's contract.** `endo.evaluation-result.v0` embeds `endo.evaluation-profile.v0` or `.v1`;
  the profile declares its own version and is dispatched independently, but the set a result may embed is the result's
  (`ENDO_EVALUATION_RESULT_PROFILE_VERSIONS_V0`). A future profile `v2` is not legal inside a v0 result because the
  profile family learned it.
- **Schema, canonical form and digests are different guarantees.** Validation asks whether the representation is valid;
  canonical JSON gives equivalent data one byte form (workspace archives still require it); a digest verifies specific
  bytes; version dispatch selects which schema applies.

## Permanent fixtures

`protocol/schema-compat.ts` is a metadata-only catalogue: one entry per durable schema version, with its family, its
status (`current`: a writer emits or may emit it; `legacy`: read-only), the boundary that reads it, any intentionally open
containers, and its fixtures. Fixtures are tiny
synthetic canonical records under `tests/fixtures/schema-compat/<schemaVersion>/`. Each is pinned in the catalogue by
SHA-256, so editing a historical fixture shows up in review.

`tests/schema-compat.test.ts` derives its checks from that one structure and from each family's own table:

- every catalogue entry has fixtures, each fixture's declared version equals its entry, and its bytes match the pin;
- every fixture file on disk is catalogued, and every catalogued version is in its family's table, and every version the
  table reads is catalogued; so removing an old reader, adding a reader without a fixture, or deleting a fixture while
  the reader remains fails;
- every fixture is accepted by the current reader, under its original version;
- for each fixture: a plausible future field is rejected at the root and at every nested object present in the fixture that is not
  an intentionally open container (`openPaths` in the catalogue; an optional object a minimal fixture omits is not probed), a v999 is `unsupported-version`, a missing version is `missing-version`, and a malformed record of a known
  version is `invalid`, never a fall-back to another version.

**To add a version:** write its validator, add its table entry, commit its fixture, add its catalogue entry. Do not
remove the previous version or its fixture. If the family's writer moves, mark the old version `legacy`; do not edit the old fixture.

## Inventory

Classified from the tree; a `schemaVersion` string is not by itself a durability promise.

**A. Durable or imported contracts (covered here).** Each is read from disk or imported, and has fixtures.

| family                                            | versions read | written now | boundary                                    |
| ------------------------------------------------- | ------------- | ----------- | ------------------------------------------- |
| `endo.event`                                      | v0            | v0          | event-store frames (`storage/event-store`)  |
| 25 evidence kinds (`endo.evaluation-result`, …)   | v0 each       | v0          | ledger frames (`storage/ledger`)            |
| `endo.evidence-ledger`                            | v0            | v0          | ledger snapshot                             |
| `endo.experiment`                                 | v0            | v0          | ledger meta                                 |
| `endo.evaluation-profile`                         | v0, v1        | v0 (Reef adapter), v1 (experiment runner) | nested in results |
| `endo.workspace-archive`                          | v0, v1        | **v1 only** | blob store, cassette replay                 |
| `endo.digest-key`                                 | v0            | v0          | key file                                    |
| harness registry: fingerprint, change, capability evidence, capability state, notification | v0 each | v0 | `storage/harness-registry` frames |

Evaluation profiles have two active writers by design (v1 only widens the cognition policies with `none`); the archive
is the family with a single current write version. The ledger meta/snapshot envelopes and the registry frame are
unversioned closed envelopes: they reject unknown keys and have no version to dispatch.

**B. Runtime-local / ephemeral.** Carry `schemaVersion` but live inside one process or connection: provider
request/response/stream/health/capabilities, runtime admission checks, runtime facts, steering receipts and lanes, model
routing/concurrency/scheduler objects (derived views; serialization is defined but nothing reads it back from disk).

**C. Derived views.** Rebuilt from canonical evidence: graph snapshots/projections, visualization scenes, DREAM and
engineering views, session overviews, trajectories and trajectory comparisons (projections an adapter produces
read-only from a store), replay reports, collab room reports, mission traces.

**D. Unwired, planned.** `protocol/control.ts`, `protocol/continuity.ts`, `protocol/runtime-profile.ts` state that
nothing produces or consumes them. No reader was manufactured.

**E. External.** ACP wire types have their own pinned schema machinery (`adapters/acp/schema.ts`) and are not in this
catalogue.

### Known limitations

- Not covered: the experiment runner's run-directory files (`cli/experiment.ts`: run record, plan, trial results, the
  report). They are written and read by the same CLI through unchecked `JSON.parse(...) as T`. The report moved from
  `endo.experiment-report.v0` to `v1` without a reader for either; that history is not recovered here.
- Not catalogued: the operator-authored experiment spec file read by `endo experiment run` (`endo.experiment-spec.v0`,
  `cli/experiment.ts`). Its validator is already strict and it has one version, but it has no table or fixture yet.
- Not covered: Pi attachment state files (`adapters/pi/attachment.ts`), the capture-log layout, and research artifacts
  that scripts read (`research/**`); the study data they read is read through the covered readers above.
- This is a discipline for the covered families, not a claim about every `schemaVersion` string, arbitrary future
  versions, automatic migration or general protocol compatibility.
