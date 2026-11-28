# Architecture — B–D

This is the implementation update to the A1 architecture and consumer inventory. Paths under the root:

| Path | Role |
| --- | --- |
| `events/events.log` | Original stream, frozen under E4. No moves, re-encoding, or shared append order. |
| `events/session-attachment.lock` | Original PID lock on legacy; permanent format sentinel on E4. |
| `events/attachments/FORMAT` | Write-once witness. |
| `events/attachments/<id>/attachment.lock`, `events.log` | Attachment lock and log. |
| `harness/<id>/records.log` | Existing registry; a write on an E4 root requires the attachment's lock. Opening an empty registry no longer makes a directory. |
| `develop/` | Unchanged root-wide governance and attempt reservation. |

## Storage

`attachEndoEventStoreWriterV0` is the storage admission entry for E. It returns a writer and its lifetime; the attachment variant carries a process-local lock handle backed by the lock's disk identity. There is at most one writable event store per handle. A forged, released or wrong-root handle cannot open or append. Legacy callers use the existing store and the legacy PID lock. Ingest and DSH now participate in that lock; DSH snapshots log identity before preflight and validates it again after acquiring, before appending. Unsupported writable explicit log paths cannot bypass the format guard.

The D4a order for E is outermost first: store-format/init, `capture.lock`, `attachment.lock`, `coordination.lock.<n>`, `records.lock.<n>`. A holder of the attachment lock may take the numbered registry lock; a holder of the registry lock never takes the attachment lock. Never hold `coordination.lock.<n>` and `tasks.lock.<n>` together or take two attachment locks. B–D validates the attachment lock before an E4 registry write but does not introduce the numbered registry lock. Frame format, decoding, fsync per append, and preservation of cut bytes on torn-tail recovery are reused. Artifact and blob puts use independent exclusively created temp names.

## Reads

`readEndoEventStoreV0` reports stream-local events, standing, verified prefix, diagnostics, freshness and watermark. Keep `evidenceLength` separate from diagnostic frames. A read pays for the same bytes it hashes for seal verification; the legacy log is not read outside the shared budget. An over-budget stream is unread, not empty; an oversized member does not spend its bytes and narrower siblings may fit. A read that started but failed reserves its observed size conservatively. Attachment directory discovery is capped and can return omissions; its order under truncation is filesystem enumeration order, not a stable global inventory. A selected-stream read deliberately does not claim complete store discovery.

Within each stream the writer's order is append order. `pageEndoEventStreamV0` binds sequence to stream identity and the canonical prefix hash. Different streams' positions are incomparable. No global cursor or global sequence exists in this tranche. A read is not a multi-file atomic snapshot. Aggregation retains per-stream state and takes the weakest standing over the queried scope; absence claims require complete discovery. Contradictions are kept as findings without deduplication. Derivation accepts only parents in the same stream. Bind positions, evidence and freshness to their stream; do not treat future-dated or quarantined events as recency evidence.

The legacy bridge serves the existing `cli/develop-service.ts` projection only when the root is legacy-only. It maps sealed or torn logs to `partial` with their verified prefix and unavailable or over-budget logs to `unavailable`. Other consumers, including the descriptor-pinned Coordinator runtime, stay in their original single-stream mode until F. The resume helper returns separate legacy and own segments, along with legacy standing and seen ids. It does not authorize a cross-stream causal join.
