# Migration — explicit and irreversible in place

This is the implementation update to the A2 migration handoff. Read the [ADR](../../../docs/designs/event-store-concurrent.md) for the operator preconditions and the #182 version floor.

`endo store status [--root <dir>]` changes nothing. `endo store migrate --root <dir> --to per-attachment-v1` is a dry run. Only `--commit` acquires the legacy PID lock and installs a sentinel. `endo store init --root <dir> --format per-attachment-v1` creates only a fresh store (or resumes its interrupted initialisation). The mutating commands require a named root and never resolve the default. The CLI accepts only the one known format.

Under the lock, migration refuses a torn, sealed or schema-invalid legacy log. It reads and hashes a clean log without allowing recovery or truncation, records the count and digests, and checks its hash again before commit. A pre-session legacy root seals `{ "logPresent": false }`. It never creates an empty legacy log as a stand-in. It refuses .recover residue rather than trying to take it over. The sentinel replaces **only the migrator's own verified PID lock** by atomic rename. That is the irreversible step. Neither normal release nor stale recovery recognizes the PID-less sentinel as removable.

A crash before the sentinel rename leaves a PID lock subject to #182 recovery; a .recover left inside stale recovery needs human inspection. A crash after rename leaves a valid sentinel, even if the witness was not yet installed. Writers can complete a missing witness atomically. A surviving witness with no sentinel is a damaged barrier; there is no automatic rewrite. Stopped writers and no unsupported checkout are operational preconditions, not claims the program can verify.

No in-place rollback and no re-seal: restore or read a pre-migration backup at a separate path. The legacy bytes are not repaired in response to drift. Retire unlocked pre-E4 ingest/DSH and script entry points before touching a migrated root. A normal B–D-supported deployment should continue to use legacy roots until E/F ship.
