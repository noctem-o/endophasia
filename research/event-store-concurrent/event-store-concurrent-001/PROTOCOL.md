# Store-format protocol — implemented B–D

This is the implementation update to the A2 protocol. The closed, fixture-pinned sentinel carries `schemaVersion: "endo.store-format.v0"`, `format: "per-attachment-v1"`, `createdAt`, `attachment` (operator-readable), `origin` and `legacy`. There is no `pid` or `token`. Created roots use `legacy: null`. Migrated roots use a seal of `{bytes, frames, sha256, prefixDigest}` or `{logPresent: false}`. Both digests in a present-log seal are lowercase SHA-256 hex. The prefix digest hashes newline-terminated, canonical per-event hashes, so a present empty log uses the SHA-256 of empty input rather than null.

| Classification | Writes | Reads |
| --- | --- | --- |
| `absent` | The new attach API creates E4. No legacy file is created. | No store; no negative activity claim. |
| `initialising` | The init owner holds a PID lock; another attacher waits for a bounded period, or recovers a dead owner through #182. | Diagnostics only. |
| `legacy-uninitialised` | Legacy lock and path remain valid. No implicit migration. | No legacy event log yet. |
| `legacy-only` | One PID-locked writer via the attach entry. | Legacy frames and original recovery semantics. |
| `mixed` / `e4-sentinel-only` | Only attachment streams, each under its lock. | Retain originally sealed legacy history and individual streams. |
| `legacy-seal-drift` | Legacy writes refused. Attachment writers do not wait, refuse, or prompt. | Uncertainty is confined to legacy. On growth with a proven intact prefix, present the original sealed prefix as evidence; the suffix is diagnostics only. |
| `format-barrier-broken` | All event and registry writers refuse. Never recreate or remove format artefacts. | Diagnostics only, no complete or absent activity claim. |

Initialisation stages a **complete PID lock and its containing directory** next to the root, after read-only classification, then publishes the `events/` directory by rename. That avoids a visible bare `events/` between mkdir and lock publication: a bare directory is a real legacy-uninitialised root, and cannot be treated as absent by a racing attacher. Under the lock the winner rechecks the root, syncs and renames the sentinel over its own lock, then syncs the directory and publishes the witness. The loser re-detects, and after publication both can open their own streams. The first attacher announces creation once. Explicit CLI initialisation shares the protocol and reports the same creation line.

An intact sentinel and a valid witness that differ only on the seal produce drift, not a write lockout. A broken barrier is separate (exit 2 in status; drift exits 0). Growth with an intact hash of the sealed prefix, growth with a rewritten prefix, truncation, deletion, appearance, and same-size rewrite are different report kinds. A read with insufficient bytes to verify the legacy seal does not claim it verified. A local append or read failure in one attachment does not seal siblings.

Discovery and duplicate examination establish what this read saw, not a shared clock. A later *enumerated* conflicting copy is marked; a proven outside-seal legacy copy is quarantined to legacy instead. Neither identical nor conflicting duplicates disappear from the diagnostic arrays. `derivedFrom` across streams is a finding; a missing parent is never resolved from another file as valid authority.
