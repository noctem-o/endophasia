// The workspace host's status (docs/designs/workspace-host.md): what `GET api/v0/workbench/status` answers on a server started by
// `endo workspace open`. It is a different document from the Pi workbench's `endo.workbench-status.v0`, on purpose: a workspace host has no
// harness, no session, no run and no command to offer, so it has none of those fields to report as "disconnected" or "unavailable". A
// page reads `harness: null` as a normal mode of operation, not as a degraded attachment.

export const ENDO_WORKSPACE_HOST_STATUS_SCHEMA_V0 = "endo.workspace-host-status.v0";

export interface EndoWorkspaceHostStatusV0 {
	schemaVersion: typeof ENDO_WORKSPACE_HOST_STATUS_SCHEMA_V0;
	/** The host's own random id for this launch (16 hex). A different id is a different process. */
	launchId: string;
	host: "workspace";
	/** No harness: nothing here runs, prompts, steers or stops an agent. */
	harness: null;
	/** Whether a page holds the grant now (never the token). */
	paired: boolean;
	/** Whether the worktree's changes can be read (`project`, `project/diff`). */
	changes: boolean;
}
