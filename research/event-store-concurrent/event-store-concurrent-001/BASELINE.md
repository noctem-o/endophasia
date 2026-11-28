# Baseline — B–D

Re-fetched `origin/main` before creating `feat/event-store-concurrent-001`. It was unchanged at `8306e1224c1199d2a4a7e7322d31938a14894c26` (merge of #198). The distinct worktree was clean and on that commit. Device: Arch Linux, Node v26.13.1, npm v12.2.3. No runtime credential or operator store was needed.

A1 inventoried the legacy single-stream consumers and recommended per-attachment framed logs. A2 traced the shared writer lock to #182 (`7db2a9852`, fix `df104c3e8`), and showed why the sentinel cannot fence pre-floor or unlocked writers. Neither reconnaissance run was a live acceptance run. This branch preserves frame bytes and existing governance, adds the lock and format protocol, and introduces a stream-aware read model. The branch's tests are mechanism and CLI conformance on isolated temporary roots; production adapter/consumer conformance is a separate phase.
