/**
 * The `endo` command. Runs directly on Node ≥ 22.19 (native TypeScript):
 *
 *   node cli/index.ts <status|events|ingest|ledger|artifacts> <root> ...
 *   node cli/index.ts harness <status|overview|identify|check|study|attach> <root> ...
 *   node cli/index.ts trajectory <show|diff> <store> <session> ...
 *   node cli/index.ts digest-key id
 *   node cli/index.ts proxy <record|replay> ...
 *   node cli/index.ts experiment <run|report> ...
 *   node cli/index.ts replay <store> <session> --pi <path> --timing <as-recorded|immediate> ...
 *
 * The command functions print one canonical-JSON document on success; any throw becomes a one-line error on stderr
 * and exit code 1. The store commands (cli/commands.ts) touch only the host storage layer; the harness commands
 * (cli/harness.ts) attach to a user-installed runtime through its adapter. The trajectory commands
 * (cli/trajectory.ts) read stores only.
 */

import { artifactsCommand, eventsCommand, ingestCommand, ledgerCommand, statusCommand } from "./commands.ts";
import { digestKeyCommand } from "./digest-key.ts";
import { EXPERIMENT_COMMANDS_V0 } from "./experiment.ts";
import { HARNESS_COMMANDS_V0 } from "./harness.ts";
import { PROXY_COMMANDS_V0, replayCommand } from "./replay.ts";
import { TRAJECTORY_COMMANDS_V0 } from "./trajectory.ts";

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
			throw new TypeError("usage: endo harness <status|overview|identify|check|study|attach> <root> ...");
		return dispatch(rest);
	},
	"digest-key": digestKeyCommand,
	proxy: (argv) => {
		const [sub, ...rest] = argv;
		const dispatch = typeof sub === "string" ? PROXY_COMMANDS_V0[sub] : undefined;
		if (dispatch === undefined) throw new TypeError("usage: endo proxy <record|replay> ...");
		return dispatch(rest);
	},
	replay: replayCommand,
	experiment: (argv) => {
		const [sub, ...rest] = argv;
		const dispatch = typeof sub === "string" ? EXPERIMENT_COMMANDS_V0[sub] : undefined;
		if (dispatch === undefined) throw new TypeError("usage: endo experiment <run|report> ...");
		return dispatch(rest);
	},
	trajectory: (argv) => {
		const [sub, ...rest] = argv;
		const dispatch = typeof sub === "string" ? TRAJECTORY_COMMANDS_V0[sub] : undefined;
		if (dispatch === undefined) throw new TypeError("usage: endo trajectory <show|diff> <store> <session> ...");
		return dispatch(rest);
	},
};

const [, , command, ...argv] = process.argv;
const dispatch = typeof command === "string" ? COMMANDS_V0[command] : undefined;
if (dispatch === undefined) {
	console.error(
		"usage: endo <status|events|ingest|ledger|artifacts|harness|trajectory|digest-key|proxy|replay|experiment> ...",
	);
	process.exit(1);
}
try {
	await dispatch(argv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
