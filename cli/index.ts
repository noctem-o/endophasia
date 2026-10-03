/**
 * Phase 12 — the `endo` command (README "## Phase 12 — Operational substrate & integration",
 * work item: "cli/"). Runs directly on Node ≥ 22.19 (native TypeScript):
 *
 *   node cli/index.ts <status|events|ingest|ledger|artifacts> <root> ...
 *
 * The command functions in cli/commands.ts print one canonical-JSON document on success;
 * any throw becomes a one-line error on stderr and exit code 1. No flag parsing beyond the
 * command's own argv handling lives here.
 */

import { artifactsCommand, eventsCommand, ingestCommand, ledgerCommand, statusCommand } from "./commands.ts";

/** The closed command table: name to command function. */
const COMMANDS_V0: Record<string, (argv: readonly string[]) => void> = {
	status: statusCommand,
	events: eventsCommand,
	ingest: ingestCommand,
	ledger: ledgerCommand,
	artifacts: artifactsCommand,
};

const [, , command, ...argv] = process.argv;
const dispatch = typeof command === "string" ? COMMANDS_V0[command] : undefined;
if (dispatch === undefined) {
	console.error("usage: endo <status|events|ingest|ledger|artifacts> <root> ...");
	process.exit(1);
}
try {
	dispatch(argv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
