# Coordinator Mission Board

The board reads `endo.coordinator-status.v0`, the same projection as `endo coordinator status`. It doesn't persist status or decide what a task's phase, receipt outcome, association or session state means. Project and phase selectors only filter the report already returned to this browser.

## Launch boundary

`GET ./api/v0/workbench/workspace/coordinator` is available only on the paired `endo workspace open` host. It takes no query, body, file path or project selector. The server first checks the per-launch capability, then the workspace host checks its existing grant. The host supplies the registered project bound to its launch directory and checks scope and grant again before returning. No agent, control endpoint or experiment runner is contacted. Ordinary `endo studio`, the development launcher and live workbench don't gain a new read grant.

The shared storage adapter reads the same inputs and calls the same projection as the CLI. The board opts into a 4 MiB event log cap, 512 attempt directory entries and 8 MiB attempt records, and 256 receipt records and 4 MiB of receipt bytes. Each receipt directory enumeration is also bounded by its remaining record allowance, including temporary entries in the enumeration. The existing task-file cap still applies. At a limit, the board shows the projection's unavailable or incomplete evidence and its reasons; the server refuses if the complete JSON would exceed 2 MiB. Only one read per workspace host can run at a time. The board withholds check command arguments, which can contain secrets; check receipts remain distinguishable by ID and attempt. No raw event payload, transcript, hidden evaluation data or command output is sent.

## Reading the board

Counts reflect operator declarations. Completed is not verified. A failed receipt at a different HEAD is history; one surviving passing receipt doesn't establish complete history. Session activity names the evidence basis, and active refers to fresh recorded activity at the time shown, not liveness now. Explicit links come only from records; sessions with no known association aren't exposed by the project-scoped host. The board doesn't offer mutation or execution controls. It refreshes on demand and withdraws the reading on loss of pairing or scope.

> **Later additions (dated annotation, 28 November 2026):** E2 (#186) added read-only Lanes and Graph views, and Studio F1 (#196)
> added deterministic Attention, Resources, Schedules and Advisory views under the same launch boundary. See
> [coordinator-studio-f1-002.md](coordinator-studio-f1-002.md) and the [Studio guide](../studio.md#coordinator-mission-board-paired-workspace-read-only).
