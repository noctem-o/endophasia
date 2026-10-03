/**
 * The `endo` command. Runs directly on Node ≥ 22.19 (native TypeScript):
 *
 *   node cli/index.ts <status|events|ingest|ledger|artifacts> <root> ...
 *   node cli/index.ts harness <status|identify|check|study|attach> <root> ...
 *
 * The command functions print one canonical-JSON document on success; any throw becomes a one-line error on stderr
 * and exit code 1. The store commands (cli/commands.ts) touch only the host storage layer; the harness commands
 * (cli/harness.ts) attach to a user-installed runtime through its adapter.
 */

import { artifactsCommand, eventsCommand, ingestCommand, ledgerCommand, statusCommand } from "./commands.ts";
import { HARNESS_COMMANDS_V0 } from "./harness.ts";

/** The closed command table: name to command function. */
const COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	status: statusCommand,
	events: eventsCommand,
	ingest: ingestCommand,
	ledger: ledgerCommand,
	artifacts: artifactsCommand,
	harness: (argv) => {
		const [sub, ...rest] = argv;
		const dispatch = typeof sub === "string" ? HARNESS_COMMANDS_V0[sub] : undefined;
		if (dispatch === undefined)
			throw new TypeError("usage: endo harness <status|identify|check|study|attach> <root> ...");
		return dispatch(rest);
	},
};

const [, , command, ...argv] = process.argv;
const dispatch = typeof command === "string" ? COMMANDS_V0[command] : undefined;
if (dispatch === undefined) {
	console.error("usage: endo <status|events|ingest|ledger|artifacts|harness> <root> ...");
	process.exit(1);
}
try {
	await dispatch(argv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
