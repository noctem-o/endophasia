// `endo coordinator status` (docs/designs/coordinator-status.md): the read-only Coordinator status of one store root, as one canonical
// JSON document on stdout ({ "coordinatorStatus": ... }) and the operator text on stderr, like `endo attempt bridge`. It grants nothing:
// no subcommand here writes, moves a task, prompts, launches, attaches or approves.

import { endoCoordinatorStaleAfterV0, readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { renderEndoCoordinatorStatusV0 } from "../runtime/contracts/coordinator-status.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";

const USAGE =
	"usage: endo coordinator status [<root> | --root dir] [--project <id>]... [--stale-after <seconds>] [--quiet]";

async function status(argv: readonly string[]): Promise<void> {
	const taken = takeEndoRootV0(argv, 0, new Set(["--project", "--stale-after"]));
	const projects: string[] = [];
	let staleAfterMs: number | undefined;
	let quiet = false;
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift() as string;
		if (flag === "--quiet") {
			quiet = true;
			continue;
		}
		if (flag !== "--project" && flag !== "--stale-after") throw new TypeError(USAGE);
		const value = rest.shift();
		if (value === undefined || value.length === 0) throw new TypeError(`the flag ${flag} needs a value`);
		if (flag === "--project") projects.push(value);
		else if (staleAfterMs !== undefined) throw new TypeError("--stale-after was given more than once");
		else staleAfterMs = endoCoordinatorStaleAfterV0(value);
	}
	announceEndoRootV0(taken);
	const coordinatorStatus = await readEndoCoordinatorStatusV0({
		root: taken.root,
		projects: projects.length === 0 ? null : projects,
		...(staleAfterMs === undefined ? {} : { staleAfterMs }),
	});
	process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorStatus })))}\n`);
	if (!quiet) process.stderr.write(renderEndoCoordinatorStatusV0(coordinatorStatus));
}

export const COORDINATOR_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = { status };
