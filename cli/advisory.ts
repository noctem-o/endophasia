/**
 * S2 CLI (COORDINATOR-AUTOMATION-S2, docs/designs/coordinator-automation-s2-implementation.md):
 *
 *   endo advisory <add|enable|disable|remove|authorize|revoke|tick|list|fires|briefings|proposals|ack|dismiss> [<root> | --root dir] ...
 *
 * - Every mutation is an explicit operator act. A schedule is added DISABLED and unauthorized; it can run a turn only after
 *   "enable" and then "authorize --revision <the enabled revision>" with explicit ceilings.
 * - "tick" is the only command that can contact a model, and only through an authorised, budgeted, fenced turn. It installs
 *   nothing and starts no service; run it from a timer the operator owns.
 * - "ack" and "dismiss" change the advisory queue only. No command here dispatches a harness, mutates a task, assignment,
 *   route, worktree or candidate, or accepts or merges anything.
 */

import { readCoordinatorModelPoolFileV0 } from "../adapters/coordinator/model-pool.ts";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	decideEndoAdvisoryProposalV0,
	type EndoAdvisoryMutationResultV0,
	readEndoAdvisoryProjectionV0,
	removeEndoAdvisoryScheduleV0,
	revokeEndoAdvisoryAuthorizationV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import {
	ENDO_ADVISORY_ACTION_KINDS_V0,
	ENDO_ADVISORY_OBSERVATION_SOURCES_V0,
	ENDO_ADVISORY_WAKE_POLICIES_V0,
	type EndoAdvisoryActionKindV0,
	type EndoAdvisoryObservationSourceV0,
	type EndoAdvisoryWakePolicyV0,
	validateEndoAdvisoryBudgetV0,
	validateEndoAdvisoryPolicyV0,
} from "../protocol/develop-advisory.ts";
import {
	ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0,
	type EndoScheduleMissedRunPolicyV0,
	type EndoScheduleTriggerV0,
	isValidEndoIanaTimezoneV0,
} from "../protocol/develop-automation.ts";
import {
	parseEndoCalendarSpecV0,
	parseEndoDurationMsV0,
	parseEndoStrictIsoTimestampMsV0,
} from "../runtime/contracts/develop-automation.ts";
import { announceEndoRootV0 } from "./root-args.ts";
import { parseEnum, parseFlags, parseNonNegIntFlag, printJson, refuseMutation } from "./scheduler.ts";

export const ADVISORY_USAGE_V0 =
	"usage: endo advisory <add|enable|disable|remove|authorize|revoke|tick|list|fires|briefings|proposals|ack|dismiss> [<root> | --root dir] ...";
const ADD_USAGE =
	"usage: endo advisory add [<root> | --root dir] --id <scheduleId> --project <projectId> --action <generate-advisory-brief|emit-operator-proposal> --wake <on-change|digest-window> (--once <iso> | --every <duration> [--anchor <iso>] | --calendar <spec> [--tz <iana>]) [--missed-run <skip-and-report|coalesce-once>] [--label <text>] [--quiet]";
const TOGGLE_USAGE =
	"usage: endo advisory <enable|disable|remove> [<root> | --root dir] --id <scheduleId> [--revision <n>] [--quiet]";
const AUTHORIZE_USAGE =
	"usage: endo advisory authorize [<root> | --root dir] --id <scheduleId> --revision <n> --pool <pool.json> --period <duration> --max-turns <n> --max-output-tokens <n> --max-generated-tokens <n> --turn-timeout <seconds> --expires-in <duration> [--observation <recorded-only|recorded-or-passive-probe>] [--observation-max-age <duration>] [--permit-capacity-unknown] [--permit-model-unconfirmed] [--permit-partial-observation] [--quiet]";
const REVOKE_USAGE = "usage: endo advisory revoke [<root> | --root dir] --id <scheduleId> [--quiet]";
const TICK_USAGE = "usage: endo advisory tick [<root> | --root dir] [--quiet]";
const READ_USAGE =
	"usage: endo advisory <list|fires|briefings|proposals> [<root> | --root dir] [--limit <n>] [--all] [--quiet]";
const DECIDE_USAGE =
	"usage: endo advisory <ack|dismiss> [<root> | --root dir] --proposal <proposalId> [--note <text>] [--quiet]";

function unwrap<T>(result: EndoAdvisoryMutationResultV0<T>): T {
	if (!result.ok) refuseMutation(result.code, result.detail);
	return result.value;
}

function parseTrigger(values: Map<string, string>, nowMs: number): EndoScheduleTriggerV0 {
	const once = values.get("--once");
	const every = values.get("--every");
	const calendar = values.get("--calendar");
	if ([once, every, calendar].filter((v) => v !== undefined).length !== 1)
		throw new TypeError("specify exactly one trigger: --once <iso>, --every <duration>, or --calendar <spec>");
	if (values.has("--anchor") && every === undefined) throw new TypeError("--anchor can only be used with --every");
	if (values.has("--tz") && calendar === undefined) throw new TypeError("--tz can only be used with --calendar");
	if (once !== undefined) return { kind: "once", atMs: parseEndoStrictIsoTimestampMsV0(once) };
	if (every !== undefined) {
		const everyMs = parseEndoDurationMsV0(every);
		const anchor = values.get("--anchor");
		return {
			kind: "interval",
			everyMs,
			anchorMs: anchor === undefined ? nowMs + everyMs : parseEndoStrictIsoTimestampMsV0(anchor),
		};
	}
	const timezone = values.get("--tz") ?? "UTC";
	if (!isValidEndoIanaTimezoneV0(timezone))
		throw new TypeError(`--tz ${JSON.stringify(timezone)} is not a valid IANA timezone`);
	return {
		kind: "calendar",
		timezone,
		schedule: parseEndoCalendarSpecV0(calendar as string),
		dstPolicy: "skip-nonexistent-first-ambiguous",
	};
}

function required(values: Map<string, string>, flag: string, usage: string): string {
	const v = values.get(flag);
	if (v === undefined) throw new TypeError(`${flag} is required\n${usage}`);
	return v;
}

function requiredInt(values: Map<string, string>, flag: string, usage: string): number {
	return parseNonNegIntFlag(required(values, flag, usage), flag) as number;
}

function add(argv: readonly string[]): void {
	const p = parseFlags(
		argv,
		[
			"--id",
			"--project",
			"--action",
			"--wake",
			"--once",
			"--every",
			"--anchor",
			"--calendar",
			"--tz",
			"--missed-run",
			"--label",
		],
		["--quiet"],
		ADD_USAGE,
	);
	const nowMs = Date.now();
	const input = {
		scheduleId: required(p.values, "--id", ADD_USAGE),
		projectId: required(p.values, "--project", ADD_USAGE),
		actionKind: parseEnum<EndoAdvisoryActionKindV0>(
			required(p.values, "--action", ADD_USAGE),
			ENDO_ADVISORY_ACTION_KINDS_V0,
			"--action",
		),
		wake: parseEnum<EndoAdvisoryWakePolicyV0>(
			required(p.values, "--wake", ADD_USAGE),
			ENDO_ADVISORY_WAKE_POLICIES_V0,
			"--wake",
		),
		missedRunPolicy: parseEnum<EndoScheduleMissedRunPolicyV0>(
			p.values.get("--missed-run") ?? "skip-and-report",
			ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0,
			"--missed-run",
		),
		label: p.values.get("--label") ?? null,
		trigger: parseTrigger(p.values, nowMs),
	};
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	const schedule = unwrap(addEndoAdvisoryScheduleV0(p.root, input, () => nowMs));
	printJson({ schedule });
	if (!p.bools.has("--quiet"))
		process.stderr.write(
			`advisory schedule ${schedule.scheduleId} added at revision ${schedule.revision}, DISABLED and unauthorized; no model was contacted.\n`,
		);
}

function toggle(kind: "enable" | "disable" | "remove", argv: readonly string[]): void {
	const p = parseFlags(argv, ["--id", "--revision"], ["--quiet"], TOGGLE_USAGE);
	const id = required(p.values, "--id", TOGGLE_USAGE);
	const expected = parseNonNegIntFlag(p.values.get("--revision"), "--revision");
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	if (kind === "remove") {
		const value = unwrap(removeEndoAdvisoryScheduleV0(p.root, id, expected));
		printJson(value);
		if (!p.bools.has("--quiet"))
			process.stderr.write(`advisory schedule ${id} removed; its authorization no longer stands.\n`);
		return;
	}
	const value = unwrap(setEndoAdvisoryScheduleEnabledV0(p.root, id, kind === "enable", expected));
	printJson(value);
	if (!p.bools.has("--quiet"))
		process.stderr.write(
			kind === "enable"
				? `advisory schedule ${id} enabled at revision ${value.schedule.revision}; it runs nothing until revision ${value.schedule.revision} is authorized.\n`
				: `advisory schedule ${id} disabled at revision ${value.schedule.revision}; ${value.supersededAuthorizations} authorization(s) superseded.\n`,
		);
}

function authorize(argv: readonly string[]): void {
	const p = parseFlags(
		argv,
		[
			"--id",
			"--revision",
			"--pool",
			"--period",
			"--max-turns",
			"--max-output-tokens",
			"--max-generated-tokens",
			"--turn-timeout",
			"--expires-in",
			"--observation",
			"--observation-max-age",
		],
		["--permit-capacity-unknown", "--permit-model-unconfirmed", "--permit-partial-observation", "--quiet"],
		AUTHORIZE_USAGE,
	);
	const pool = readCoordinatorModelPoolFileV0(required(p.values, "--pool", AUTHORIZE_USAGE));
	const policy = validateEndoAdvisoryPolicyV0({
		permitCapacityUnknown: p.bools.has("--permit-capacity-unknown"),
		permitModelUnconfirmed: p.bools.has("--permit-model-unconfirmed"),
		permitPartialObservation: p.bools.has("--permit-partial-observation"),
		observationSource: parseEnum<EndoAdvisoryObservationSourceV0>(
			p.values.get("--observation") ?? "recorded-only",
			ENDO_ADVISORY_OBSERVATION_SOURCES_V0,
			"--observation",
		),
		recordedObservationMaxAgeMs: parseEndoDurationMsV0(p.values.get("--observation-max-age") ?? "10m"),
	});
	const budget = validateEndoAdvisoryBudgetV0({
		periodMs: parseEndoDurationMsV0(required(p.values, "--period", AUTHORIZE_USAGE)),
		maxTurnsPerPeriod: requiredInt(p.values, "--max-turns", AUTHORIZE_USAGE),
		completionRequestsPerTurn: 2,
		maxOutputTokensPerRequest: requiredInt(p.values, "--max-output-tokens", AUTHORIZE_USAGE),
		maxGeneratedTokensPerPeriod: requiredInt(p.values, "--max-generated-tokens", AUTHORIZE_USAGE),
		maxTurnWallClockMs: requiredInt(p.values, "--turn-timeout", AUTHORIZE_USAGE) * 1000,
	});
	const lifetimeMs = parseEndoDurationMsV0(required(p.values, "--expires-in", AUTHORIZE_USAGE));
	const scheduleId = required(p.values, "--id", AUTHORIZE_USAGE);
	const scheduleRevision = requiredInt(p.values, "--revision", AUTHORIZE_USAGE);
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	const authorization = unwrap(
		authorizeEndoAdvisoryScheduleV0(p.root, { scheduleId, scheduleRevision, pool, policy, budget, lifetimeMs }),
	);
	printJson({ authorization });
	if (!p.bools.has("--quiet"))
		process.stderr.write(
			`authorized ${scheduleId} revision ${scheduleRevision} (${authorization.actionKind}, project ${authorization.projectId}) until ${new Date(authorization.expiresAtMs).toISOString()}: at most ${budget.maxTurnsPerPeriod} turn(s) and ${budget.maxGeneratedTokensPerPeriod} generated tokens per ${budget.periodMs / 1000}s. Proposals it produces grant nothing.\n`,
		);
}

function revoke(argv: readonly string[]): void {
	const p = parseFlags(argv, ["--id"], ["--quiet"], REVOKE_USAGE);
	const id = required(p.values, "--id", REVOKE_USAGE);
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	printJson(unwrap(revokeEndoAdvisoryAuthorizationV0(p.root, id)));
	if (!p.bools.has("--quiet"))
		process.stderr.write(
			`revoked ${id}. A turn not yet past its dispatch record will not dispatch; an in-flight result will be withheld.\n`,
		);
}

async function tick(argv: readonly string[]): Promise<void> {
	const p = parseFlags(argv, [], ["--quiet"], TICK_USAGE);
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	const result = await runEndoAdvisoryTickV0({ root: p.root });
	printJson({ tick: result });
	if (!result.ok) throw new Error(`advisory tick refused: ${result.refusal}: ${result.detail}`);
	if (!p.bools.has("--quiet")) {
		const statuses = result.outcomes.map((o) => `${o.scheduleId}:${o.status}`).join(", ") || "nothing due";
		process.stderr.write(
			`advisory tick epoch ${result.leaseEpoch}: ${statuses}; inference ${result.inferenceDispatched ? "dispatched" : "not dispatched"}.\n`,
		);
	}
}

function read(kind: "list" | "fires" | "briefings" | "proposals", argv: readonly string[]): void {
	const p = parseFlags(argv, ["--limit"], ["--all", "--quiet"], READ_USAGE);
	const limit = parseNonNegIntFlag(p.values.get("--limit"), "--limit");
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	const projection = readEndoAdvisoryProjectionV0(p.root, limit === undefined ? {} : { limit });
	const all = p.bools.has("--all");
	if (kind === "list")
		printJson({ advisory: { ...projection, fires: undefined, briefings: undefined, proposals: undefined } });
	if (kind === "fires")
		printJson({ readAtMs: projection.readAtMs, problems: projection.problems, fires: projection.fires });
	if (kind === "briefings")
		printJson({
			readAtMs: projection.readAtMs,
			standing: projection.standing,
			problems: projection.problems,
			briefings: projection.briefings,
		});
	if (kind === "proposals")
		printJson({
			readAtMs: projection.readAtMs,
			standing: projection.standing,
			problems: projection.problems,
			proposals: all ? projection.proposals : projection.proposals.filter((v) => v.queueState === "pending"),
		});
	if (!p.bools.has("--quiet")) {
		const pending = projection.proposals.filter((v) => v.queueState === "pending");
		process.stderr.write(
			`advisory: ${projection.schedules.length} schedule(s); ${pending.length} pending proposal(s) (${pending.filter((v) => v.currency === "stale").length} stale); every briefing and proposal is untrusted model interpretation.\n`,
		);
	}
}

function decide(disposition: "acknowledged" | "dismissed", argv: readonly string[]): void {
	const p = parseFlags(argv, ["--proposal", "--note"], ["--quiet"], DECIDE_USAGE);
	const proposalId = required(p.values, "--proposal", DECIDE_USAGE);
	announceEndoRootV0({ root: p.root, defaultNote: p.defaultNote, rest: [] });
	printJson({
		state: unwrap(decideEndoAdvisoryProposalV0(p.root, proposalId, disposition, p.values.get("--note") ?? null)),
	});
	if (!p.bools.has("--quiet"))
		process.stderr.write(`proposal ${proposalId} ${disposition}; only the advisory queue changed.\n`);
}

export const ADVISORY_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	add,
	enable: (argv) => toggle("enable", argv),
	disable: (argv) => toggle("disable", argv),
	remove: (argv) => toggle("remove", argv),
	authorize,
	revoke,
	tick,
	list: (argv) => read("list", argv),
	fires: (argv) => read("fires", argv),
	briefings: (argv) => read("briefings", argv),
	proposals: (argv) => read("proposals", argv),
	ack: (argv) => decide("acknowledged", argv),
	dismiss: (argv) => decide("dismissed", argv),
};
