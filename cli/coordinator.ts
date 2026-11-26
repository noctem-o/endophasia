// `endo coordinator status` (docs/designs/coordinator-status.md): the read-only Coordinator status of one store root, as one canonical
// JSON document on stdout ({ "coordinatorStatus": ... }) and the operator text on stderr, like `endo attempt bridge`. It grants nothing:
// no subcommand here writes, moves a task, prompts, launches, attaches or approves.

import { endoCoordinatorStaleAfterV0, readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import { ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0 } from "../protocol/coordinator-model-pool.ts";
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
	const usage =
		"usage: endo coordinator brief [<root> | --root dir] --project <id> [--pool <config.json> [--member <memberId>]] [--quiet]";
	const taken = takeEndoRootV0(argv, 0, new Set(["--project", "--pool", "--member"]));
	let projectId: string | undefined;
	let poolPath: string | undefined;
	let memberId: string | undefined;
	let quiet = false;
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--quiet") quiet = true;
		else if (flag === "--project" && projectId === undefined) {
			projectId = rest.shift();
			if (projectId === undefined || !ENDO_PROJECT_ID_PATTERN_V0.test(projectId))
				throw new TypeError("--project needs one endo.project.<32 hex> id");
		} else if (flag === "--pool" && poolPath === undefined) {
			poolPath = rest.shift();
			if (poolPath === undefined || poolPath.length === 0)
				throw new TypeError("--pool needs a pool configuration file");
		} else if (flag === "--member" && memberId === undefined) {
			memberId = rest.shift();
			if (memberId === undefined || !ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0.test(memberId))
				throw new TypeError(
					"--member needs one memberId from the pool file (lowercase letters, digits, inner hyphens)",
				);
		} else throw new TypeError(usage);
	}
	if (projectId === undefined) throw new TypeError(usage);
	if (memberId !== undefined && poolPath === undefined)
		throw new TypeError("--member selects a member of a pool: give the pool with --pool <config.json>");
	const { readCoordinatorModelPoolFileV0, pooledCoordinatorV0 } = await import(
		"../adapters/coordinator/model-pool.ts"
	);
	const pool = poolPath === undefined ? undefined : readCoordinatorModelPoolFileV0(poolPath);
	if (pool !== undefined && memberId !== undefined && !pool.members.some((m) => m.memberId === memberId))
		throw new TypeError(
			`--member ${memberId} is not in the pool; its members are: ${pool.members.map((m) => m.memberId).join(", ")}`,
		);
	announceEndoRootV0(taken);
	const substrate =
		pool === undefined
			? (await import("../adapters/coordinator/openclaw.ts")).openClawCoordinatorV0(taken.root)
			: pooledCoordinatorV0(taken.root, pool, memberId === undefined ? {} : { memberId });
	const coordinatorBrief = await briefFromCoordinatorSubstrateV0({ projectId }, substrate);
	process.stdout.write(canonicalEndoJsonV0({ coordinatorBrief }));
	if (!quiet) {
		const pooled = coordinatorBrief.modelPool;
		const via =
			pooled === undefined
				? ""
				: pooled.selectedMemberId === null
					? `Model pool: no member selected (${pooled.skippedMembers.map((s) => `${s.memberId}: ${s.reason}`).join("; ") || "none considered"}).\n`
					: `Model pool: member ${pooled.selectedMemberId} (${pooled.selectedModelId}, ${pooled.selectedReadiness}${pooled.fallbackOccurred ? ", after fallback" : ""}).\n`;
		process.stderr.write(
			via +
				(coordinatorBrief.availability === "available"
					? `Coordinator briefing (model interpretation; wording backstop, not a validator):\n${coordinatorBrief.answer.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")}\n`
					: `Coordinator briefing unavailable (${coordinatorBrief.reason}).\n`),
		);
	}
}

/** `endo coordinator pool check`: zero-token observations of the pool's local members; contacts no completion route, reads no store. */
async function pool(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo coordinator pool check [--pool <config.json>] [--quiet]";
	const [sub, ...rest] = argv;
	if (sub !== "check") throw new TypeError(usage);
	let poolPath: string | undefined;
	let quiet = false;
	while (rest.length > 0) {
		const flag = rest.shift();
		if (flag === "--quiet") quiet = true;
		else if (flag === "--pool" && poolPath === undefined) {
			poolPath = rest.shift();
			if (poolPath === undefined || poolPath.length === 0)
				throw new TypeError("--pool needs a pool configuration file");
		} else throw new TypeError(usage);
	}
	const { checkCoordinatorModelPoolV0, ENDO_COORDINATOR_M0_POOL_V0, readCoordinatorModelPoolFileV0 } = await import(
		"../adapters/coordinator/model-pool.ts"
	);
	const coordinatorModelPool = await checkCoordinatorModelPoolV0(
		poolPath === undefined ? ENDO_COORDINATOR_M0_POOL_V0 : readCoordinatorModelPoolFileV0(poolPath),
		poolPath === undefined ? "m0-default" : "file",
	);
	process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify({ coordinatorModelPool })))}\n`);
	if (!quiet) {
		const lines = coordinatorModelPool.members.map((m) =>
			m.observation === null
				? `  ${m.memberId}: not contacted (hosted members are not permitted in M1)`
				: `  ${m.memberId}: ${m.observation.readiness} (${m.observation.detail}; ${m.observation.backend})`,
		);
		const s = coordinatorModelPool.selection;
		lines.push(
			s.ok
				? `A briefing would use ${s.selectedMemberId}${s.fallbackOccurred ? " after fallback" : ""}; capacity ${s.capacityConfirmed ? "observed" : "not confirmed"}.`
				: `A briefing would be unavailable (${s.refusal}).`,
		);
		lines.push("Health observation only: zero inference tokens; it does not promise the next request will succeed.");
		process.stderr.write(`${lines.join("\n")}\n`);
	}
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
	pool,
};
