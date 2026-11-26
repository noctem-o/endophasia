// `endo coordinator status` (docs/designs/coordinator-status.md): the read-only Coordinator status of one store root, as one canonical
// JSON document on stdout ({ "coordinatorStatus": ... }) and the operator text on stderr, like `endo attempt bridge`. It grants nothing:
// no subcommand here writes, moves a task, prompts, launches, attaches or approves.

import { endoCoordinatorStaleAfterV0, readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { briefFromCoordinatorSubstrateV0 } from "../runtime/contracts/coordinator-brief.ts";
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

async function brief(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo coordinator brief [<root> | --root dir] --project <id> [--quiet]";
	const taken = takeEndoRootV0(argv, 0, new Set(["--project"]));
	let projectId: string | undefined;
	let quiet = false;
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--quiet") quiet = true;
		else if (flag === "--project" && projectId === undefined) {
			projectId = rest.shift();
			if (projectId === undefined || !ENDO_PROJECT_ID_PATTERN_V0.test(projectId))
				throw new TypeError("--project needs one endo.project.<32 hex> id");
		} else throw new TypeError(usage);
	}
	if (projectId === undefined) throw new TypeError(usage);
	announceEndoRootV0(taken);
	const { openClawCoordinatorV0 } = await import("../adapters/coordinator/openclaw.ts");
	const coordinatorBrief = await briefFromCoordinatorSubstrateV0({ projectId }, openClawCoordinatorV0(taken.root));
	process.stdout.write(canonicalEndoJsonV0({ coordinatorBrief }));
	if (!quiet)
		process.stderr.write(
			coordinatorBrief.availability === "available"
				? `Coordinator briefing (model interpretation; wording backstop, not a validator):\n${coordinatorBrief.answer.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")}\n`
				: `Coordinator briefing unavailable (${coordinatorBrief.reason}).\n`,
		);
}

/** `endo coordinator coordination`: the companion projection, read on the host (Git re-verification on). Writes nothing. */
async function coordination(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo coordinator coordination [<root> | --root dir] --project <id>... [--quiet]";
	const taken = takeEndoRootV0(argv, 0, new Set(["--project"]));
	const projects: string[] = [];
	let quiet = false;
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--quiet") quiet = true;
		else if (flag === "--project") {
			const value = rest.shift();
			if (value === undefined || !ENDO_PROJECT_ID_PATTERN_V0.test(value))
				throw new TypeError("--project needs one endo.project.<32 hex> id");
			projects.push(value);
		} else throw new TypeError(usage);
	}
	if (projects.length === 0) throw new TypeError(usage);
	announceEndoRootV0(taken);
	const { hostProjection } = await import("./develop-coordination.ts");
	const coordinatorCoordination = await hostProjection(taken.root, projects);
	process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorCoordination })))}\n`);
	if (!quiet)
		process.stderr.write(
			`coordination source: ${coordinatorCoordination.source.state}; gaps: ${coordinatorCoordination.gaps.join(", ") || "none"}.\nRead-only projection: liveness is not observed, readiness is not permission, an assignment is not an authorisation.\n`,
		);
}

export const COORDINATOR_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	status,
	brief,
	coordination,
};
