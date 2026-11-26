/**
 * S1 CLI commands (`COORDINATOR-AUTOMATION-S1`, docs/designs/coordinator-automation.md Appendix B,
 * docs/designs/coordinator-automation-s1-implementation.md):
 *
 *   endo schedule <add|list|enable|disable|remove> [<root> | --root dir] ...
 *   endo scheduler <tick|print-systemd-unit> [<root> | --root dir] ...
 *   endo resource <declare-window|list> [<root> | --root dir] ...
 *
 * Invariants:
 * - Schedule mutations require explicit operator CLI invocation.
 * - `endo scheduler tick` executes strictly read-only deterministic observations (`tokensConsumed: 0`).
 * - `endo scheduler print-systemd-unit` prints example units to stdout ONLY; it NEVER installs, enables,
 *   starts, or modifies host systemd units or linger settings.
 * - `endo resource declare-window` writes only `<root>/develop/automation/declarations.json` and NEVER
 *   reads or modifies provider credential stores.
 */

import { isAbsolute, resolve } from "node:path";
import { runEndoSchedulerTickV0 } from "../adapters/develop/scheduler-tick.ts";
import {
	ENDO_ALLOWANCE_WINDOW_KINDS_V0,
	ENDO_DEVELOP_AUTOMATION_LIMITS_V0,
	ENDO_OPERATOR_DECLARABLE_STANDINGS_V0,
	ENDO_PROVIDER_SURFACE_KINDS_V0,
	ENDO_SCHEDULE_ACTION_KINDS_V0,
	ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0,
	type EndoAllowanceWindowKindV0,
	type EndoOperatorDeclarableStandingV0,
	type EndoProviderSurfaceKindV0,
	type EndoScheduleActionKindV0,
	type EndoScheduleMissedRunPolicyV0,
	type EndoScheduleTriggerV0,
	isValidEndoIanaTimezoneV0,
} from "../protocol/develop-automation.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	parseEndoCalendarSpecV0,
	parseEndoDurationMsV0,
	parseEndoStrictIsoTimestampMsV0,
	renderEndoSystemdUnitsV0,
} from "../runtime/contracts/develop-automation.ts";
import { DevelopAutomationStoreV0, readEndoAutomationProjectionV0 } from "../storage/develop-automation.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";

const SCHEDULE_ADD_USAGE =
	"usage: endo schedule add [<root> | --root dir] --id <scheduleId> --action <observe-health|refresh-projection> (--once <iso> | --every <duration> [--anchor <iso>] | --calendar <spec> [--tz <iana>]) [--missed-run <skip-and-report|coalesce-once>] [--label <text>] [--disabled] [--revision <n>] [--quiet]";
const SCHEDULE_LIST_USAGE = "usage: endo schedule list [<root> | --root dir] [--include-fires] [--quiet]";
const SCHEDULE_TOGGLE_USAGE =
	"usage: endo schedule <enable|disable|remove> [<root> | --root dir] --id <scheduleId> [--revision <n>] [--quiet]";
const SCHEDULER_TICK_USAGE =
	"usage: endo scheduler tick [<root> | --root dir] [--pool <config.json>] [--lease-ttl <seconds>] [--budget <seconds>] [--quiet]";
const SCHEDULER_PRINT_UNIT_USAGE =
	"usage: endo scheduler print-systemd-unit [<root> | --root dir] [--endo-bin <abs-path>] [--pool <abs-path>] [--cadence <on-calendar>] [--unit-name <name>] [--json]";
const RESOURCE_DECLARE_USAGE =
	"usage: endo resource declare-window [<root> | --root dir] --provider <id> --reset-at <iso> [--window <rolling-5h|weekly|rpm|tpm|rpd|credit-balance|local-vram|custom>] [--surface <subscription-window|api-rate-limit|local-compute|unknown>] [--quota-pool <id>] [--standing <exhausted-until-reset|approaching-limit|unknown>] [--note <text>] [--quiet]";
const RESOURCE_LIST_USAGE = "usage: endo resource list [<root> | --root dir] [--quiet]";

export const SCHEDULE_USAGE_V0 = "usage: endo schedule <add|list|enable|disable|remove> [<root> | --root dir] ...";
export const SCHEDULER_USAGE_V0 = "usage: endo scheduler <tick|print-systemd-unit> [<root> | --root dir] ...";
export const RESOURCE_USAGE_V0 = "usage: endo resource <declare-window|list> [<root> | --root dir] ...";

export const printJson = (value: unknown): void => {
	process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify(value)) as never)}\n`);
};

export function parseFlags(
	argv: readonly string[],
	valueFlags: readonly string[],
	boolFlags: readonly string[],
	usage: string,
): { root: string; defaultNote: string | null; values: Map<string, string>; bools: Set<string> } {
	const taken = takeEndoRootV0(argv, 0, new Set(valueFlags));
	const values = new Map<string, string>();
	const bools = new Set<string>();
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift() as string;
		if (boolFlags.includes(flag)) {
			if (bools.has(flag)) throw new TypeError(`${flag} was given more than once`);
			bools.add(flag);
			continue;
		}
		if (!valueFlags.includes(flag)) throw new TypeError(usage);
		const val = rest.shift();
		if (val === undefined || val.length === 0) throw new TypeError(`the flag ${flag} needs a value`);
		if (values.has(flag)) throw new TypeError(`${flag} was given more than once`);
		values.set(flag, val);
	}
	return { root: taken.root, defaultNote: taken.defaultNote, values, bools };
}

export function parseNonNegIntFlag(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(`${flag} must be a non-negative integer`);
	const n = Number(raw);
	if (!Number.isSafeInteger(n)) throw new TypeError(`${flag} is out of range`);
	return n;
}

function parsePositiveSecondsFlag(
	raw: string | undefined,
	flag: string,
	minMs: number,
	maxMs: number,
): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^[1-9][0-9]*$/.test(raw)) throw new TypeError(`${flag} must be a whole number of seconds`);
	const ms = Number(raw) * 1000;
	if (!Number.isSafeInteger(ms) || ms < minMs || ms > maxMs)
		throw new TypeError(`${flag} must be between ${minMs / 1000}s and ${maxMs / 1000}s`);
	return ms;
}

export function parseEnum<T extends string>(raw: string, allowed: readonly T[], flag: string): T {
	if (!(allowed as readonly string[]).includes(raw)) {
		throw new TypeError(`${flag} must be one of ${allowed.join(", ")}`);
	}
	return raw as T;
}

export function refuseMutation(code: string, detail?: string): never {
	printJson({ refusal: { code, ...(detail === undefined ? {} : { detail }) } });
	throw new Error(`${code}${detail === undefined ? "" : `: ${detail}`}`);
}

// ---- `endo schedule ...` -----------------------------------------------------------------------------------------------------------

function scheduleAdd(argv: readonly string[]): void {
	const parsed = parseFlags(
		argv,
		[
			"--id",
			"--action",
			"--once",
			"--every",
			"--anchor",
			"--calendar",
			"--tz",
			"--missed-run",
			"--label",
			"--revision",
		],
		["--disabled", "--quiet"],
		SCHEDULE_ADD_USAGE,
	);
	const scheduleId = parsed.values.get("--id");
	const actionRaw = parsed.values.get("--action");
	if (scheduleId === undefined || actionRaw === undefined) throw new TypeError(SCHEDULE_ADD_USAGE);
	const actionKind = parseEnum<EndoScheduleActionKindV0>(actionRaw, ENDO_SCHEDULE_ACTION_KINDS_V0, "--action");

	const onceRaw = parsed.values.get("--once");
	const everyRaw = parsed.values.get("--every");
	const calendarRaw = parsed.values.get("--calendar");
	const triggerCount = [onceRaw, everyRaw, calendarRaw].filter((v) => v !== undefined).length;
	if (triggerCount !== 1) {
		throw new TypeError("specify exactly one trigger: --once <iso>, --every <duration>, or --calendar <spec>");
	}

	if (parsed.values.has("--anchor") && everyRaw === undefined) {
		throw new TypeError("--anchor can only be used with --every");
	}
	if (parsed.values.has("--tz") && calendarRaw === undefined) {
		throw new TypeError("--tz can only be used with --calendar");
	}

	const nowMs = Date.now();
	let trigger: EndoScheduleTriggerV0;
	if (onceRaw !== undefined) {
		trigger = { kind: "once", atMs: parseEndoStrictIsoTimestampMsV0(onceRaw) };
	} else if (everyRaw !== undefined) {
		const everyMs = parseEndoDurationMsV0(everyRaw);
		const anchorRaw = parsed.values.get("--anchor");
		const anchorMs = anchorRaw === undefined ? nowMs + everyMs : parseEndoStrictIsoTimestampMsV0(anchorRaw);
		trigger = { kind: "interval", everyMs, anchorMs };
	} else {
		const timezone = parsed.values.get("--tz") ?? "UTC";
		if (!isValidEndoIanaTimezoneV0(timezone))
			throw new TypeError(`--tz ${JSON.stringify(timezone)} is not a valid IANA timezone`);
		trigger = {
			kind: "calendar",
			timezone,
			schedule: parseEndoCalendarSpecV0(calendarRaw!),
			dstPolicy: "skip-nonexistent-first-ambiguous",
		};
	}

	const missedRunPolicy =
		parsed.values.get("--missed-run") === undefined
			? "skip-and-report"
			: parseEnum<EndoScheduleMissedRunPolicyV0>(
					parsed.values.get("--missed-run")!,
					ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0,
					"--missed-run",
				);
	const expectedRevision = parseNonNegIntFlag(parsed.values.get("--revision"), "--revision");
	const label = parsed.values.get("--label") ?? null;
	const enabled = !parsed.bools.has("--disabled");
	const quiet = parsed.bools.has("--quiet");

	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const store = new DevelopAutomationStoreV0(parsed.root, { now: () => nowMs });
	const result = store.addSchedule({
		scheduleId,
		actionKind,
		trigger,
		missedRunPolicy,
		label,
		enabled,
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	});
	if (!result.ok) refuseMutation(result.code, result.detail);
	printJson({
		schedule: result.value.schedule,
		revision: result.value.file.revision,
		commit: result.commit,
	});
	if (!quiet) {
		process.stderr.write(
			`schedule ${scheduleId} added (${actionKind}, ${trigger.kind}, ${enabled ? "enabled" : "disabled"}); zero background service started.\n`,
		);
	}
}

function scheduleList(argv: readonly string[]): void {
	const parsed = parseFlags(argv, [], ["--include-fires", "--quiet"], SCHEDULE_LIST_USAGE);
	const includeFires = parsed.bools.has("--include-fires");
	const quiet = parsed.bools.has("--quiet");
	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const automation = readEndoAutomationProjectionV0(parsed.root, { includeFires });
	printJson({ automation });
	if (!quiet) {
		const count = automation.schedules.state === "ready" ? automation.schedules.file.schedules.length : 0;
		const leaseState =
			automation.lease.state === "ready"
				? `epoch ${automation.lease.lease.epoch} (${automation.lease.active ? "active" : "idle"})`
				: automation.lease.state;
		process.stderr.write(`schedules: ${count} (${automation.schedules.state}); lease: ${leaseState}.\n`);
	}
}

function scheduleToggle(kind: "enable" | "disable" | "remove", argv: readonly string[]): void {
	const parsed = parseFlags(argv, ["--id", "--revision"], ["--quiet"], SCHEDULE_TOGGLE_USAGE);
	const scheduleId = parsed.values.get("--id");
	if (scheduleId === undefined) throw new TypeError(SCHEDULE_TOGGLE_USAGE);
	const expectedRevision = parseNonNegIntFlag(parsed.values.get("--revision"), "--revision");
	const quiet = parsed.bools.has("--quiet");

	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const store = new DevelopAutomationStoreV0(parsed.root);
	if (kind === "remove") {
		const result = store.removeSchedule(scheduleId, expectedRevision);
		if (!result.ok) refuseMutation(result.code, result.detail);
		printJson({
			removed: result.value.removed,
			revision: result.value.file.revision,
			commit: result.commit,
		});
		if (!quiet) process.stderr.write(`schedule ${scheduleId} removed (retired cursor preserved).\n`);
		return;
	}
	const result = store.setScheduleEnabled(scheduleId, kind === "enable", expectedRevision);
	if (!result.ok) refuseMutation(result.code, result.detail);
	printJson({
		schedule: result.value.schedule,
		revision: result.value.file.revision,
		commit: result.commit,
	});
	if (!quiet) process.stderr.write(`schedule ${scheduleId} ${kind === "enable" ? "enabled" : "disabled"}.\n`);
}

// ---- `endo scheduler ...` ----------------------------------------------------------------------------------------------------------

async function schedulerTick(argv: readonly string[]): Promise<void> {
	const parsed = parseFlags(argv, ["--pool", "--lease-ttl", "--budget"], ["--quiet"], SCHEDULER_TICK_USAGE);
	const poolPath = parsed.values.get("--pool");
	const leaseTtlMs = parsePositiveSecondsFlag(
		parsed.values.get("--lease-ttl"),
		"--lease-ttl",
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minLeaseTtlMs,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxLeaseTtlMs,
	);
	const tickBudgetMs = parsePositiveSecondsFlag(
		parsed.values.get("--budget"),
		"--budget",
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minTickBudgetMs,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxTickBudgetMs,
	);
	const quiet = parsed.bools.has("--quiet");

	let pool = null;
	if (poolPath !== undefined) {
		const { readCoordinatorModelPoolFileV0 } = await import("../adapters/coordinator/model-pool.ts");
		pool = readCoordinatorModelPoolFileV0(poolPath);
	}

	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const schedulerTick = await runEndoSchedulerTickV0({
		root: parsed.root,
		pool,
		poolSource: pool === null ? "none" : "file",
		...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
		...(tickBudgetMs === undefined ? {} : { tickBudgetMs }),
	});
	printJson({ schedulerTick });
	if (!schedulerTick.ok) {
		throw new Error(`${schedulerTick.refusal}: ${schedulerTick.detail}`);
	}
	if (!quiet) {
		process.stderr.write(
			`scheduler tick epoch ${schedulerTick.leaseEpoch}: claimed=${schedulerTick.claimed.length}, missedSkipped=${schedulerTick.missedSkipped.length}, outcomes=${schedulerTick.outcomes.length}, tokensConsumed=0.\n`,
		);
	}
}

function schedulerPrintSystemdUnit(argv: readonly string[]): void {
	const parsed = parseFlags(
		argv,
		["--endo-bin", "--pool", "--cadence", "--unit-name"],
		["--json"],
		SCHEDULER_PRINT_UNIT_USAGE,
	);
	const explicitBin = parsed.values.get("--endo-bin");
	const poolPath = parsed.values.get("--pool");
	const onCalendar = parsed.values.get("--cadence");
	const unitName = parsed.values.get("--unit-name");
	const asJson = parsed.bools.has("--json");

	if (explicitBin !== undefined && !isAbsolute(explicitBin)) {
		throw new TypeError("--endo-bin must be an explicit absolute path");
	}
	if (poolPath !== undefined && !isAbsolute(poolPath)) {
		throw new TypeError("--pool must be an explicit absolute path");
	}

	const storeRoot = resolve(parsed.root);
	const endoBin = explicitBin ?? resolve(process.argv[1] ?? "cli/index.ts");
	const nodeBin = explicitBin === undefined ? resolve(process.execPath) : undefined;

	const units = renderEndoSystemdUnitsV0({
		endoBin,
		storeRoot,
		...(nodeBin === undefined ? {} : { nodeBin }),
		...(poolPath === undefined ? {} : { poolPath }),
		...(onCalendar === undefined ? {} : { onCalendar }),
		...(unitName === undefined ? {} : { unitName }),
	});

	if (asJson) {
		printJson({ systemdUnits: units });
		return;
	}
	process.stdout.write(
		[
			`# === ${units.serviceName} ===`,
			units.serviceContent,
			`# === ${units.timerName} ===`,
			units.timerContent,
			units.manualInstructions,
		].join("\n"),
	);
}

// ---- `endo resource ...` -----------------------------------------------------------------------------------------------------------

function resourceDeclareWindow(argv: readonly string[]): void {
	const parsed = parseFlags(
		argv,
		["--provider", "--reset-at", "--window", "--surface", "--quota-pool", "--standing", "--note"],
		["--quiet"],
		RESOURCE_DECLARE_USAGE,
	);
	const providerId = parsed.values.get("--provider");
	const resetAtRaw = parsed.values.get("--reset-at");
	if (providerId === undefined || resetAtRaw === undefined) throw new TypeError(RESOURCE_DECLARE_USAGE);
	const resetAtMs = parseEndoStrictIsoTimestampMsV0(resetAtRaw);

	const windowKind =
		parsed.values.get("--window") === undefined
			? "rolling-5h"
			: parseEnum<EndoAllowanceWindowKindV0>(
					parsed.values.get("--window")!,
					ENDO_ALLOWANCE_WINDOW_KINDS_V0,
					"--window",
				);
	const surfaceKind =
		parsed.values.get("--surface") === undefined
			? "subscription-window"
			: parseEnum<EndoProviderSurfaceKindV0>(
					parsed.values.get("--surface")!,
					ENDO_PROVIDER_SURFACE_KINDS_V0,
					"--surface",
				);
	const standing =
		parsed.values.get("--standing") === undefined
			? "exhausted-until-reset"
			: parseEnum<EndoOperatorDeclarableStandingV0>(
					parsed.values.get("--standing")!,
					ENDO_OPERATOR_DECLARABLE_STANDINGS_V0,
					"--standing",
				);
	const quotaPoolId = parsed.values.get("--quota-pool") ?? null;
	const note = parsed.values.get("--note") ?? null;
	const quiet = parsed.bools.has("--quiet");

	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const store = new DevelopAutomationStoreV0(parsed.root);
	const result = store.declareResourceWindow({
		providerId,
		resetAtMs,
		surfaceKind,
		quotaPoolId,
		windowKind,
		standing,
		note,
	});
	if (!result.ok) refuseMutation(result.code, result.detail);
	printJson({
		declaration: result.value.declaration,
		revision: result.value.file.revision,
		commit: result.commit,
	});
	if (!quiet) {
		process.stderr.write(
			`recorded operator-declared ${windowKind} window for ${providerId} (reset at ${new Date(resetAtMs).toISOString()}); no provider credential store was touched.\n`,
		);
	}
}

function resourceList(argv: readonly string[]): void {
	const parsed = parseFlags(argv, [], ["--quiet"], RESOURCE_LIST_USAGE);
	const quiet = parsed.bools.has("--quiet");
	announceEndoRootV0({ root: parsed.root, defaultNote: parsed.defaultNote, rest: [] });
	const projection = readEndoAutomationProjectionV0(parsed.root, { includeFires: false });
	printJson({
		observedAtMs: projection.observedAtMs,
		resources: projection.resources,
		declarations: projection.declarations,
	});
	if (!quiet) {
		const freshness =
			projection.resources.state === "ready" ? projection.resources.freshness : projection.resources.state;
		const declCount =
			projection.declarations.state === "ready" ? projection.declarations.file.declarations.length : 0;
		process.stderr.write(`resources: ${freshness}; operator declarations: ${declCount}.\n`);
	}
}

export const SCHEDULE_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	add: scheduleAdd,
	list: scheduleList,
	enable: (argv) => scheduleToggle("enable", argv),
	disable: (argv) => scheduleToggle("disable", argv),
	remove: (argv) => scheduleToggle("remove", argv),
};

export const SCHEDULER_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	tick: schedulerTick,
	"print-systemd-unit": schedulerPrintSystemdUnit,
};

export const RESOURCE_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	"declare-window": resourceDeclareWindow,
	list: resourceList,
};
