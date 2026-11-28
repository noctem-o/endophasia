# EVENT-STORE-CONCURRENT-001 — Per-attachment event streams

**Decision accepted 2026-11-28.** This change is the storage and read substrate (tranches B–D). Adapter adoption (E), consumer adoption (F), and live acceptance are separate. Do not run the migration on an operator store with this substrate-only build: its normal writers and most existing readers do not use the new attachment API yet.

## Decision

Keep the checksummed append-only frame log as the authoritative record. Keep one independent log and one writer lock per validated attachment id. Preserve the legacy log byte for byte at its existing path. Keep all governance, including attempt routes and reservations, in one `develop/` domain per store root.

A multiprocessing service or a short lock on one shared log serialises writers and makes one process or damaged log everybody's problem. SQLite WAL commits transactions atomically, but would replace recoverable per-file frame evidence with a shared failure domain, break legacy readers, and change how read-only sandbox pinning works. A derived, rebuildable index is allowed; none is needed for this tranche.

## Amendments to Coordinator Assignment §6.4

| Earlier design | Decision and reason |
| --- | --- |
| Adapter locks decide the format and remove a dead lock before installing the sentinel. | The storage layer classifies and guards writes, including old-path ingest and DSH. A migrator takes the same #182 PID lock, verifies ownership, then renames a fully written and synced sentinel **over its own lock**. It does not overwrite another process's lock or use the pre-#182 stale unlink protocol. There is no gap at commit. |
| Bidirectional exclusion against the historical baseline is universal. | It is conditional on a same-host, cooperative local POSIX filesystem and the **#182 floor** (`7db2a9852`, with stale recovery fix `df104c3e8`). Older lock-taking binaries can delete a replacement in a stale-recovery race. No pre-E4 unlocked entry point, including ingest or DSH, is fenced by a file it never reads. Version strings don't prove the floor. |
| Upgrade is implicit when an attachment first opens. | Existing legacy stores retain their single writer; a second concurrent writer is refused, with the migration command. Migration is explicit, dry-run by default, and never mutates legacy bytes. An actually absent root can be created as E4 on first attach via the storage attach API. Governed or harness-only pre-E4 roots with no legacy log are legitimate `legacy-uninitialised` stores, not automatically upgraded or treated as damage. |
| A bare `legacy` string identifies a stream. | Stream ids are tagged. The legacy stream and a real attachment named `legacy` have distinct identities, locks, cursors and directories. |
| One valid sentinel is enough; the initial sketch carried only format and a label. | A closed, versioned, non-PID, non-token sentinel records origin and the legacy seal. Its write-once witness is `events/attachments/FORMAT`. A missing, malformed or unsupported barrier fails closed; an intact barrier with changed legacy bytes only degrades the legacy stream. Truncation, growth and same-size rewrite are separately visible. |
| Every cross-stream duplicate is a store-wide tamper finding; same-attachment resume seeds only from legacy. | A reader preserves both copies. Equal bytes give a diagnostic; a conflict degrades the later *enumerated* copy (or the out-of-seal legacy copy when identified). Enumeration is not chronology. Same-attachment resume combines producer-owned legacy records and its own stream, without copying legacy events into that stream. |
| A healthy session stays complete regardless of its possible locations, and `unattributedWorkbenchSends` stays exact. | Only a view whose scope actually excludes a damaged or unread stream is unaffected. A whole-store count from incomplete inputs is an `atLeast` lower bound with the uncertain streams, not an exact count. Coordinator status will carry per-stream standing in v1 when F lands; this tranche does not emit that schema. |
| A writer's session lock guards the registry; one endpoint and one capture log are ancillary. | An attachment writer must claim its attachment before any registry write. E owns the short numbered registry lock for standalone checks, the attachment-scoped control endpoint, importer routing (`endo.ingest` / `dsh.import`), and a root-wide capture writer lock. Those are not shipped here. |
| Store-wide `afterSequence` and one readable projection. | Keep legacy cursors tied to the legacy stream and future Studio routes tied to one named stream. Consumers must not flatten positional joins or resolve `derivedFrom` across attachments. A merged display may use producer clock only if labelled presentation order. |
| The initial sequential heterogeneous experiment must precede implementation. | It remains step zero of live validation against a legacy store, not a gate on implementing this substrate. Descriptor-pinned mounting, project disclosure and the shared governance reservation must still pass on the adopted system. |

## Operator workflow after adoption

1. Back up the whole root with every process stopped. Back up the installation digest key separately; do not put it in shared artefacts. Stop every writer and ensure every entry point resolves to an E4-aware checkout. The installed version may follow a checkout rather than a package version.
2. Inspect with `endo store status --root <dir>`. `endo store migrate --root <dir> --to per-attachment-v1` proposes a seal without writing. Inspect it before repeating with `--commit`. `endo store init --root <dir> --format per-attachment-v1` creates a fresh store instead.
3. Never delete a valid sentinel. There is no in-place downgrade or re-seal. Rollback means opening the pre-migration backup at another path; post-migration events are only in the upgraded store. Do not send legacy binaries to the upgraded path.

Changed legacy bytes do not establish their order relative to attachment streams, even if producer timestamps look plausible. Legacy drift exits 0 in `store status`; a broken barrier exits 2. A barrier failure provides diagnostics, not evidence of absence.

See the [protocol](../../research/event-store-concurrent/event-store-concurrent-001/PROTOCOL.md), [migration notes](../../research/event-store-concurrent/event-store-concurrent-001/MIGRATION.md) and [limitations](../../research/event-store-concurrent/event-store-concurrent-001/LIMITATIONS.md) for the implemented boundary.
