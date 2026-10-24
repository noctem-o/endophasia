#!/usr/bin/env node
/**
 * The `endo` command. Runs directly on Node ≥ 22.19 (native TypeScript):
 *
 *   node cli/index.ts --help | --version
 *   node cli/index.ts <status|events|ingest|ledger|artifacts> <root> ...
 *   node cli/index.ts harness <status|overview|identify|check|study|attach> <root> ...
 *   node cli/index.ts trajectory <show|diff> <store> <session> ...
 *   node cli/index.ts digest-key id
 *   node cli/index.ts dsh <import|loss-accounting> ...
 *   node cli/index.ts studio [<root>] [--root dir] [--port n] [--key-file path]
 *   node cli/index.ts proxy <record|replay> ...
 *   node cli/index.ts experiment <run|report> ...
 *   node cli/index.ts replay <store> <session> --pi <path> --timing <as-recorded|immediate> ...
 *
 * The command functions print one canonical-JSON document on success; any throw becomes a one-line error on stderr
 * and exit code 1. The exception is `studio` (cli/studio.ts): a long-running command that prints one human line (the access
 * address) and returns, with status 0, when interrupted; it is loaded only when it is asked for. The store commands (cli/commands.ts) touch only the host storage layer; the harness commands
 * (cli/harness.ts) attach to a user-installed runtime through its adapter. The trajectory commands
 * (cli/trajectory.ts) read stores only.
 */

import { artifactsCommand, eventsCommand, ingestCommand, ledgerCommand, statusCommand } from "./commands.ts";
import { digestKeyCommand } from "./digest-key.ts";
import { doctorCommand } from "./doctor.ts";
import { DSH_COMMANDS_V0 } from "./dsh.ts";
import { EXPERIMENT_COMMANDS_V0 } from "./experiment.ts";
import { HARNESS_COMMANDS_V0 } from "./harness.ts";
import { ENDO_USAGE_LINE_V0, endoHelpV0, endoVersionV0 } from "./help.ts";
import { PROXY_COMMANDS_V0, replayCommand } from "./replay.ts";
import { STEER_COMMANDS_V0 } from "./steer.ts";
import { TRAJECTORY_COMMANDS_V0 } from "./trajectory.ts";

/** A command family: its subcommand table is read by own property only, so inherited names ("constructor") are usage errors. */
function family(
	table: Record<string, (argv: readonly string[]) => void | Promise<void>>,
	usage: string,
): (argv: readonly string[]) => void | Promise<void> {
	return (argv) => {
		const [sub, ...rest] = argv;
		const dispatch = typeof sub === "string" && Object.hasOwn(table, sub) ? table[sub] : undefined;
		if (dispatch === undefined) throw new TypeError(usage);
		return dispatch(rest);
	};
}

/** The closed command table: name to command function. */
const COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	status: statusCommand,
	events: eventsCommand,
	ingest: ingestCommand,
	ledger: ledgerCommand,
	artifacts: artifactsCommand,
	harness: family(HARNESS_COMMANDS_V0, "usage: endo harness <status|overview|identify|check|study|attach> <root> ..."),
	"digest-key": digestKeyCommand,
	dsh: family(DSH_COMMANDS_V0, "usage: endo dsh <import|loss-accounting> ..."),
	studio: (argv) => import("./studio.ts").then((module) => module.studioCommand(argv)),
	doctor: doctorCommand,
	proxy: family(PROXY_COMMANDS_V0, "usage: endo proxy <record|replay> ..."),
	replay: replayCommand,
	steer: family(STEER_COMMANDS_V0, "usage: endo steer <propose|authorize|apply|status|close> <root> ..."),
	experiment: family(EXPERIMENT_COMMANDS_V0, "usage: endo experiment <run|report> ..."),
	trajectory: family(TRAJECTORY_COMMANDS_V0, "usage: endo trajectory <show|diff> <store> <session> ..."),
};

const [, , command, ...argv] = process.argv;
if (command === "--help" || command === "-h" || command === "help") {
	process.stdout.write(endoHelpV0());
	process.exit(0);
}
if (command === "--version" || command === "-V") {
	process.stdout.write(`${endoVersionV0()}\n`);
	process.exit(0);
}
const dispatch = typeof command === "string" && Object.hasOwn(COMMANDS_V0, command) ? COMMANDS_V0[command] : undefined;
if (dispatch === undefined) {
	console.error(
		`${command === undefined ? "missing command" : `unknown command: ${command}`}\n${ENDO_USAGE_LINE_V0}\nrun "endo --help" for details`,
	);
	process.exit(2);
}
try {
	await dispatch(argv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
