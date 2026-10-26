# Verified sibling preparation and lineage (source-tree PR C)

`cli/initial-branch-set.ts` exports two programmatic operations:

```ts
prepareVerifiedInitialBranchPairV0(sourceStore, replayStore, digestKey, outputParent, baseline, alternative)
readVerifiedInitialBranchSetV0(sourceStore, replayStore, digestKey, outputParent, preparation)
```

The first returns a typed refusal or `status: "prepared"`, kind `verified-initial-sibling-preparation`, a unique preparation identity, two unique child identities and local directory references, and the private lineage artifact location. The reader accepts the returned **relative preparation name**, and returns `verified-pristine` or `children-changed` with separate baseline/alternative states: `pristine`, `modified`, `missing`, `substituted`, or `unverifiable`. Invalid parent evidence, a stale parent identity, and malformed/unverifiable lineage are bounded refusals. A missing/incomplete manifest is unverifiable lineage. A failure to inspect a child is never pristine. Results expose no condition specifications. Directory and artifact references are private local operator references; they must not be copied into public logs, UI projections or summaries.

## Evidence and contract

Both operations call `readVerifiedCheckpointCandidateV0` against current source and replay evidence. Preparation calls the existing `materializeVerifiedInitialCheckpointV0` twice, producing independently mutable trees from the keyed `endo.workspace-archive.v1` bytes. Each materialization restores and canonically rearchives the complete initial scratch root. Preparation verifies both trees again, revalidates the parent before publication, and runs the independent reader before returning success. It creates no metadata inside either scratch tree, changes no archived paths/configuration, and writes nothing to either evidence store or the original scratch root.

The closed `endo.initial-branch-set.v0` contract in `protocol/initial-branch-set.ts` is retained at:

```text
<private-output-parent>/endo-initial-branches-<random>/
  branch-set.json                         # 0600, canonical JSON + newline
  endo-initial-scratch-<random>/            # baseline initial scratch, private root
  endo-initial-scratch-<different-random>/  # alternative initial scratch, private root
```

The manifest embeds the **complete qualified candidate**, including session, class/boundary, archive digest/domain/length/version, source/replay capture generations, both trajectory identities, comparison identity, environment commitments, qualification and limits. A domain-separated keyed parent reference commits to the entire candidate; both children reference it. Equal archive bytes do not identify a recording session or replay generation. The checkpoint-candidate contract is unchanged.

Set and child UUIDs distinguish preparations independently of parent content or free-form labels. The manifest binds the relative preparation/child locations and directory device, inode and filesystem creation time. Creation time prevents ordinary inode reuse after deletion from preserving apparent identity; filesystems without a supported positive creation time are refused. The strict reader verifies the intended private parent and preparation area, the current child directory identities and both current canonical rearchives against the current keyed source blob. Pristine regular files must also have link count one: archive bytes omit hardlink relationships, so shared files are unverifiable even if their contents and times match. A child edited after preparation loses pristine status; its sibling can still verify independently. Inspection is read-only and performs no recovery.

The single private manifest also retains full bounded `EndoExperimentConditionV0` declarations (at most 64 KiB of canonical JSON each) using the existing experiment condition validator and slug conventions. IDs must differ. Existing model-entry, settings, extension, environment and intervention declarations are supported as **plans only**. Without an experiment task set, intervention task references are validated as slugs; no task existence or runtime capability is claimed. The change category is derived from differing configuration sections (`modelEntry`, `settings`, `extensions`, `environment`, `interventions`, `composite`, or `declared-noop`). Descriptions/IDs alone do not count as applied configuration changes.

Condition commitments and a commitment covering all other manifest fields use the provided comparison-domain key, with separate JSON purpose tags for parent, condition and manifest. The reader recomputes all commitments, checks domains, and compares the embedded parent with a newly qualified candidate. These are keyed integrity commitments, **not digital signatures, identity authentication or execution credentials**. A party holding the key can create commitments; provenance has the same local trust boundary as the underlying evidence. Public fixture keys offer no confidentiality and are for synthetic fixtures only. There is no private sidecar or additional schema family. The manifest is limited to 256 KiB, refuses unknown fields/versions, and must be canonical UTF-8 JSON plus one newline. A pinned synthetic example is in `tests/fixtures/schema-compat/endo.initial-branch-set.v0/minimal.json`; it demonstrates the schema, not runnable evidence or a real filesystem identity.

## Publication, filesystem safety and interruption

The output parent must satisfy the materializer's existing canonical POSIX path, ownership, private-permission and protected-source checks **before staging is allocated**. It cannot lie inside the recording, replay or original scratch root (including physical aliases). Each operation allocates a fresh private preparation directory with `mkdtemp`; both children are allocated independently inside it. Existing destinations are never overwritten. All filesystem restoration, archive resource bounds, path validation, internal-link handling and metadata verification remain the materializer's implementations.

`branch-set.json` is the publication marker. Preparation writes a private exclusive temporary file, fsyncs it, atomically links it to the final name without replacing an existing file, removes the temporary name, and fsyncs the preparation and output directories. The children, parent and lineage must verify before publication; a final independent read must pass before the API returns success. A final-pass refusal triggers cleanup. A complete published manifest remains subject to independent verification whenever it is read.

Failures remove only the operation-created area when its parent/area identities still match and every remaining top-level entry belongs to the operation with its expected identity. Substitution or an unexpected entry prevents recursive cleanup. The refusal discloses retained local paths for inspection; it never follows a substituted root or deletes a caller-owned target. A process interruption can leave an area containing one child, two children or a temporary file. An area without the final manifest is uncommitted and the reader refuses it. There is no automatic orphan recovery. Publication is an atomic **manifest operation**, not a crash-atomic transaction over multiple directories or a guarantee that every workspace byte has been flushed to stable storage. Readers reverify any surviving tree.

As in PR B, synchronous Node filesystem operations do not provide descriptor-relative `openat` tree traversal. Private operator-owned paths protect against other local users under ordinary POSIX permissions. They do not provide a race-free guarantee against a malicious process using the same UID, privileged mutation or a hostile filesystem; such concurrent writers must be excluded by the operator. The reader observes each tree during its archive pass and checks parent/area/child identities again. It cannot freeze both mutable trees at one instant or guarantee they remain pristine after return. Check again before later use. Existing archive limits apply; unreadable or unsupported child state is unverifiable, never equivalent.

## Meaning and next slice

A successful verified read establishes current filesystem reconstruction of one recorded pre-execution Pi scratch boundary and a private declaration of the intended sibling contrast. It verifies contents, relative paths, directory structure, executable flags, internal links and recorded entry/root modification times represented by the archive. Full POSIX permissions, owners, external services/effects, model memory, live processes and arbitrary mid-run state remain outside that representation.

`preparation: "completed"`, `execution: "not-started"`, `continuationAuthority: "none"`, `outcomes: "not-observed"`, and child `manipulation: "planned-not-applied"` are fixed preparation statements. They record that this API has performed no execution or treatment. The reader is not an execution monitor and cannot prove that an unrelated process has never executed a file or subsequently undone its changes. Any modified child is reported by its current state; historical preparation does not confer current equivalence.

Preparation and verification start no Pi process, model, tool, listener, scheduler or network service. Neither the manifest nor its commitments grant authority to do so. Recorded proxy endpoints and absolute scratch references remain in the restored bytes; the new paths are not immediately executable replay environments. Cassette replay separately exercises a fresh Pi at the original absolute scratch path. Continuation and effectful forking remain unavailable. Planned `protocol/continuity.ts` and `protocol/control.ts` are not used.

The next execution-oriented slice must independently establish **current operator authority**, a bounded runtime/tool/network/effect policy, validated runtime/model/configuration identity, explicit path/proxy handling, verified treatment application, and new child execution/trajectory evidence linked to this preparation. A historical lineage artifact is insufficient authority, and planned conditions are insufficient evidence that a manipulation occurred.

This is source-tree functionality only. Published npm `0.1.0-alpha.1` and `0.1.0-alpha.2` do not contain these APIs.
