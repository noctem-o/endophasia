// Pure deterministic scheduling, observation freshness, M1 recorded-observer seam, and systemd unit template rendering
// for S1 (`COORDINATOR-AUTOMATION-S1`, docs/designs/coordinator-automation-s1-implementation.md).
//
// Zero filesystem I/O, zero network I/O, zero subprocesses, zero LLM calls.

import {
	ENDO_DEVELOP_AUTOMATION_LIMITS_V0,
	type EndoAllowanceStandingV0,
	type EndoCalendarSpecV0,
	type EndoDevelopResourceObservationV0,
	type EndoDevelopScheduleV0,
	type EndoObservedLocalEndpointV0,
	type EndoProviderAllowanceObservationV0,
	type EndoScheduleTriggerV0,
	isValidEndoIanaTimezoneV0,
	validateEndoScheduleTriggerV0,
} from "../../protocol/develop-automation.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import type { EndoCoordinatorMemberObservationV0, EndoCoordinatorMemberObserverV0 } from "./coordinator-model-pool.ts";

// ---- Canonical Trigger Cursor & Idempotency Key ------------------------------------------------------------------------------------

const WEEKDAY_NAMES_V0 = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Canonical, unambiguous string fingerprint of a validated schedule trigger. */
export function endoScheduleTriggerCursorV0(trigger: EndoScheduleTriggerV0): string {
	if (trigger.kind === "once") return `once:${trigger.atMs}`;
	if (trigger.kind === "interval") return `interval:${trigger.everyMs}:${trigger.anchorMs}`;
	const s = trigger.schedule;
	const spec =
		s.cadence === "hourly"
			? `hourly:${pad2(s.minute)}`
			: s.cadence === "daily"
				? `daily:${pad2(s.hour)}:${pad2(s.minute)}`
				: `weekly:${WEEKDAY_NAMES_V0[s.weekday]}@${pad2(s.hour)}:${pad2(s.minute)}`;
	return `calendar:${trigger.timezone}:${spec}:${trigger.dstPolicy}`;
}

/**
 * Unambiguous canonical idempotency key for one scheduled window:
 * `sha256(canonicalJson({ schema: "endo.schedule-fire-key.v0", scheduleId, windowStartMs, triggerCursor }))`.
 * Returns a 64-char lowercase hex string safe as a write-once filename prefix.
 */
export function endoScheduleFireIdempotencyKeyV0(args: {
	readonly scheduleId: string;
	readonly windowStartMs: number;
	readonly triggerCursor: string;
}): string {
	return sha256HexV0(
		canonicalEndoJsonV0({
			schema: "endo.schedule-fire-key.v0",
			scheduleId: args.scheduleId,
			windowStartMs: args.windowStartMs,
			triggerCursor: args.triggerCursor,
		}),
	);
}

// ---- Strict CLI Input Parsers ------------------------------------------------------------------------------------------------------

const STRICT_ISO_WITH_TZ =
	/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/** Parse an explicit ISO-8601 timestamp with mandatory UTC (`Z`) or numeric offset (`±HH:MM`). Refuses ambiguous local times. */
export function parseEndoStrictIsoTimestampMsV0(text: string): number {
	const m = STRICT_ISO_WITH_TZ.exec(text);
	if (m === null)
		throw new TypeError(
			`timestamp ${JSON.stringify(text)} must be ISO-8601 with explicit timezone (e.g. 2026-11-26T18:00:00Z or +00:00)`,
		);
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	const tz = m[8]!;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
		throw new TypeError(`timestamp ${JSON.stringify(text)} has an out-of-range calendar field`);
	// Reject impossible calendar dates like 2026-02-30 that Date.parse would silently roll over.
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
		throw new TypeError(`timestamp ${JSON.stringify(text)} is not a real calendar date`);
	if (tz !== "Z") {
		const tzHour = Number(tz.slice(1, 3));
		const tzMin = Number(tz.slice(4, 6));
		if (tzHour > 23 || tzMin > 59) throw new TypeError(`timestamp ${JSON.stringify(text)} has an invalid offset`);
	}
	const parsed = Date.parse(text);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8.64e15)
		throw new TypeError(`timestamp ${JSON.stringify(text)} is out of supported epoch range`);
	return parsed;
}

/** Parse a bounded interval duration such as `30s`, `5m`, `2h`, `1d`. */
export function parseEndoDurationMsV0(text: string): number {
	const match = /^([1-9][0-9]{0,7})(s|m|h|d)$/.exec(text);
	if (match === null)
		throw new TypeError(`duration ${JSON.stringify(text)} must be a positive integer followed by s, m, h, or d`);
	const value = Number(match[1]);
	const unit = match[2] as "s" | "m" | "h" | "d";
	const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = value * factor;
	if (
		!Number.isSafeInteger(ms) ||
		ms < ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minIntervalMs ||
		ms > ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxIntervalMs
	)
		throw new TypeError(
			`duration must be between ${ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minIntervalMs} ms and ${ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxIntervalMs} ms`,
		);
	return ms;
}

/**
 * Parse a deliberately limited, unambiguous calendar specification:
 * - `hourly:MM` (e.g. `hourly:15`)
 * - `daily:HH:MM` (e.g. `daily:09:30`)
 * - `weekly:<sun|mon|tue|wed|thu|fri|sat>@HH:MM` (e.g. `weekly:mon@08:00`)
 */
export function parseEndoCalendarSpecV0(text: string): EndoCalendarSpecV0 {
	const hourly = /^hourly:([0-5][0-9])$/.exec(text);
	if (hourly !== null) return Object.freeze({ cadence: "hourly", minute: Number(hourly[1]) });
	const daily = /^daily:([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
	if (daily !== null) return Object.freeze({ cadence: "daily", hour: Number(daily[1]), minute: Number(daily[2]) });
	const weekly = /^weekly:(sun|mon|tue|wed|thu|fri|sat)@([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text);
	if (weekly !== null) {
		const weekday = WEEKDAY_NAMES_V0.indexOf(weekly[1] as (typeof WEEKDAY_NAMES_V0)[number]);
		return Object.freeze({ cadence: "weekly", weekday, hour: Number(weekly[2]), minute: Number(weekly[3]) });
	}
	throw new TypeError(
		`calendar spec ${JSON.stringify(text)} must be "hourly:MM", "daily:HH:MM", or "weekly:<sun..sat>@HH:MM"`,
	);
}

// ---- Timezone & DST Calendar Resolution (Zero External Dependencies, O(1)-Bounded) -------------------------------------------------

interface LocalWallParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly weekday: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(timezone: string): Intl.DateTimeFormat {
	let fmt = formatterCache.get(timezone);
	if (fmt === undefined) {
		fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
		if (formatterCache.size < 128) formatterCache.set(timezone, fmt);
	}
	return fmt;
}

const SHORT_WEEKDAY_TO_INDEX: Readonly<Record<string, number>> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

function utcToLocalParts(timezone: string, utcMs: number): LocalWallParts {
	const parts = tzFormatter(timezone).formatToParts(new Date(utcMs));
	let year = 0;
	let month = 1;
	let day = 1;
	let weekday = 0;
	let hour = 0;
	let minute = 0;
	let second = 0;
	for (const p of parts) {
		if (p.type === "year") year = Number(p.value);
		else if (p.type === "month") month = Number(p.value);
		else if (p.type === "day") day = Number(p.value);
		else if (p.type === "weekday") weekday = SHORT_WEEKDAY_TO_INDEX[p.value] ?? 0;
		else if (p.type === "hour") hour = Number(p.value) % 24;
		else if (p.type === "minute") minute = Number(p.value);
		else if (p.type === "second") second = Number(p.value);
	}
	return { year, month, day, weekday, hour, minute, second };
}

function tzOffsetMsAt(timezone: string, utcMs: number): number {
	const p = utcToLocalParts(timezone, utcMs);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
	const alignedUtc = Math.floor(utcMs / 1000) * 1000;
	return asUtc - alignedUtc;
}

/**
 * Resolve one local wall-clock `(year, month, day, hour, minute)` in `timezone` to an exact UTC epoch ms
 * under `skip-nonexistent-first-ambiguous`:
 * - Nonexistent spring-forward wall-time -> `null` (skipped).
 * - Unambiguous wall-time -> exact UTC epoch ms.
 * - Ambiguous fall-back fold -> the earlier (first chronological) UTC instant.
 */
export function resolveEndoLocalWallTimeUtcMsV0(
	timezone: string,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): number | null {
	if (!isValidEndoIanaTimezoneV0(timezone)) throw new TypeError(`invalid IANA timezone ${JSON.stringify(timezone)}`);
	const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
	if (timezone === "UTC" || timezone === "Etc/UTC") return utcGuess;
	const approx = utcGuess - tzOffsetMsAt(timezone, utcGuess);
	const probeOffsets = [
		tzOffsetMsAt(timezone, approx - 3 * 3_600_000),
		tzOffsetMsAt(timezone, approx),
		tzOffsetMsAt(timezone, approx + 3 * 3_600_000),
	];
	const candidates = [...new Set(probeOffsets.map((off) => utcGuess - off))].sort((a, b) => a - b);
	for (const candidate of candidates) {
		const check = utcToLocalParts(timezone, candidate);
		if (
			check.year === year &&
			check.month === month &&
			check.day === day &&
			check.hour === hour &&
			check.minute === minute &&
			check.second === 0
		) {
			return candidate;
		}
	}
	return null;
}

function addCalendarDays(
	year: number,
	month: number,
	day: number,
	deltaDays: number,
): { year: number; month: number; day: number } | null {
	const ms = Date.UTC(year, month - 1, day + deltaDays);
	if (!Number.isFinite(ms) || ms < 1 || ms > 8.64e15 - 86_400_000) return null;
	const d = new Date(ms);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addCalendarHours(
	year: number,
	month: number,
	day: number,
	hour: number,
	deltaHours: number,
): { year: number; month: number; day: number; hour: number } | null {
	const ms = Date.UTC(year, month - 1, day, hour + deltaHours);
	if (!Number.isFinite(ms) || ms < 1 || ms > 8.64e15 - 86_400_000) return null;
	const d = new Date(ms);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}

/**
 * Find the latest calendar occurrence `<= nowMs`, the immediately preceding occurrence before it,
 * and the next calendar occurrence `> nowMs` in strictly bounded O(1) steps.
 */
function bracketCalendarWindows(
	timezone: string,
	spec: EndoCalendarSpecV0,
	nowMs: number,
): { latestW: number; prevW: number; nextW: number; nominalPeriodMs: number } {
	const local = utcToLocalParts(timezone, nowMs);
	const found: number[] = [];

	if (spec.cadence === "hourly") {
		// Check local hours [-4 .. +4] around current local wall-clock hour (covers any DST gap/fold cleanly).
		for (let dh = -4; dh <= 4; dh += 1) {
			const slot = addCalendarHours(local.year, local.month, local.day, local.hour, dh);
			if (slot === null) continue;
			const resolved = resolveEndoLocalWallTimeUtcMsV0(
				timezone,
				slot.year,
				slot.month,
				slot.day,
				slot.hour,
				spec.minute,
			);
			if (resolved !== null) found.push(resolved);
		}
	} else if (spec.cadence === "daily") {
		for (let dd = -3; dd <= 3; dd += 1) {
			const slot = addCalendarDays(local.year, local.month, local.day, dd);
			if (slot === null) continue;
			const resolved = resolveEndoLocalWallTimeUtcMsV0(
				timezone,
				slot.year,
				slot.month,
				slot.day,
				spec.hour,
				spec.minute,
			);
			if (resolved !== null) found.push(resolved);
		}
	} else {
		const daysSinceTarget = (local.weekday - spec.weekday + 7) % 7;
		for (let dw = -3; dw <= 3; dw += 1) {
			const slot = addCalendarDays(local.year, local.month, local.day, -daysSinceTarget + dw * 7);
			if (slot === null) continue;
			const resolved = resolveEndoLocalWallTimeUtcMsV0(
				timezone,
				slot.year,
				slot.month,
				slot.day,
				spec.hour,
				spec.minute,
			);
			if (resolved !== null) found.push(resolved);
		}
	}

	const sorted = [...new Set(found)].sort((a, b) => a - b);
	let latestIdx = -1;
	for (let i = 0; i < sorted.length; i += 1) {
		if (sorted[i]! <= nowMs) latestIdx = i;
	}
	const nominalPeriodMs =
		spec.cadence === "hourly" ? 3_600_000 : spec.cadence === "daily" ? 86_400_000 : 7 * 86_400_000;
	const latestW = latestIdx >= 0 ? sorted[latestIdx]! : sorted[0]!;
	const prevW = latestIdx >= 1 ? sorted[latestIdx - 1]! : latestW - nominalPeriodMs;
	const nextW = latestIdx + 1 < sorted.length ? sorted[latestIdx + 1]! : latestW + nominalPeriodMs;
	return { latestW, prevW, nextW, nominalPeriodMs };
}

/**
 * Count calendar occurrences strictly in `(afterMs, upToMs]` in strictly bounded work:
 * exact when nominal span <= 32 periods, O(1) bounded estimate when offline for longer periods.
 */
function countCalendarOccurrencesBetween(
	timezone: string,
	spec: EndoCalendarSpecV0,
	afterMs: number,
	upToMs: number,
	nominalPeriodMs: number,
): number {
	if (upToMs <= afterMs) return 0;
	const roughSteps = Math.ceil((upToMs - afterMs) / nominalPeriodMs);
	if (roughSteps > 32) {
		return Math.max(1, Math.round((upToMs - afterMs) / nominalPeriodMs));
	}
	const endLocal = utcToLocalParts(timezone, upToMs);
	const hits = new Set<number>();
	const maxBack = roughSteps + 3;
	if (spec.cadence === "hourly") {
		for (let dh = 0; dh <= maxBack; dh += 1) {
			const slot = addCalendarHours(endLocal.year, endLocal.month, endLocal.day, endLocal.hour, -dh);
			if (slot === null) continue;
			const t = resolveEndoLocalWallTimeUtcMsV0(timezone, slot.year, slot.month, slot.day, slot.hour, spec.minute);
			if (t !== null && t > afterMs && t <= upToMs) hits.add(t);
		}
	} else if (spec.cadence === "daily") {
		for (let dd = 0; dd <= maxBack; dd += 1) {
			const slot = addCalendarDays(endLocal.year, endLocal.month, endLocal.day, -dd);
			if (slot === null) continue;
			const t = resolveEndoLocalWallTimeUtcMsV0(timezone, slot.year, slot.month, slot.day, spec.hour, spec.minute);
			if (t !== null && t > afterMs && t <= upToMs) hits.add(t);
		}
	} else {
		const daysSinceTarget = (endLocal.weekday - spec.weekday + 7) % 7;
		for (let dw = 0; dw <= maxBack; dw += 1) {
			const slot = addCalendarDays(endLocal.year, endLocal.month, endLocal.day, -daysSinceTarget - dw * 7);
			if (slot === null) continue;
			const t = resolveEndoLocalWallTimeUtcMsV0(timezone, slot.year, slot.month, slot.day, spec.hour, spec.minute);
			if (t !== null && t > afterMs && t <= upToMs) hits.add(t);
		}
	}
	return Math.max(1, hits.size);
}

// ---- Deterministic Schedule Due-Window Evaluation ----------------------------------------------------------------------------------

export type EndoScheduleEvaluationV0 =
	| { readonly kind: "disabled" }
	| { readonly kind: "completed-once" }
	| { readonly kind: "clock-behind-cursor"; readonly lastConsumedWindowStartMs: number; readonly nowMs: number }
	| { readonly kind: "not-due"; readonly nextWindowStartMs: number | null }
	| {
			readonly kind: "due-fire";
			readonly windowStartMs: number;
			/** Count of strictly earlier missed windows skipped/coalesced before this due window. */
			readonly missedWindowsBefore: number;
			/** If `missedWindowsBefore > 0`, the timestamp of the immediately preceding missed window for audit recording. */
			readonly latestMissedBeforeWindowStartMs: number | null;
			readonly nextWindowStartMs: number | null;
	  }
	| {
			readonly kind: "missed-skip";
			readonly latestMissedWindowStartMs: number;
			readonly missedWindowCount: number;
			readonly nextWindowStartMs: number | null;
	  };

export interface EvaluateEndoScheduleOptionsV0 {
	readonly onTimeGraceMs?: number;
}

/**
 * Pure, deterministic, O(1)-bounded evaluation of a validated schedule against `nowMs`.
 *
 * Semantics:
 * - Disabled schedules never fire.
 * - Backward wall-clock jumps (`nowMs < cursor.lastConsumedWindowStartMs`) return `clock-behind-cursor` and never replay.
 * - `once` schedules fire at most once (when `nowMs >= atMs`); past `onTimeGraceMs`, `skip-and-report` emits `missed-skip`
 *   and `coalesce-once` executes once.
 * - `interval` schedules anchor strictly to `anchorMs + k * everyMs` (no drift, O(1) math even after years offline).
 * - `calendar` schedules evaluate IANA timezone rules under `skip-nonexistent-first-ambiguous` (bounded O(1) lookup).
 * - For recurring schedules, a window `latestW` is on-time if `nowMs - latestW <= min(onTimeGraceMs, period - 1)`.
 *   When the latest window is past grace: `skip-and-report` emits one `missed-skip` covering all missed windows (0 catch-up fires),
 *   and `coalesce-once` emits at most one `due-fire` for `latestW`.
 */
export function evaluateEndoScheduleDueV0(
	schedule: EndoDevelopScheduleV0,
	nowMs: number,
	options: EvaluateEndoScheduleOptionsV0 = {},
): EndoScheduleEvaluationV0 {
	if (!Number.isSafeInteger(nowMs) || nowMs < 1 || nowMs > 8.64e15)
		throw new TypeError("evaluation clock nowMs must be a positive epoch millisecond integer");
	if (!schedule.enabled) return { kind: "disabled" };

	const onTimeGraceMs = options.onTimeGraceMs ?? ENDO_DEVELOP_AUTOMATION_LIMITS_V0.defaultOnTimeGraceMs;
	const lastConsumed = schedule.cursor.lastConsumedWindowStartMs;
	if (lastConsumed !== null && nowMs < lastConsumed) {
		return { kind: "clock-behind-cursor", lastConsumedWindowStartMs: lastConsumed, nowMs };
	}

	const trigger = validateEndoScheduleTriggerV0(schedule.trigger);

	if (trigger.kind === "once") {
		if (schedule.cursor.completedOnce || (lastConsumed !== null && lastConsumed >= trigger.atMs)) {
			return { kind: "completed-once" };
		}
		if (nowMs < trigger.atMs) return { kind: "not-due", nextWindowStartMs: trigger.atMs };
		const lateByMs = nowMs - trigger.atMs;
		if (lateByMs <= onTimeGraceMs || schedule.missedRunPolicy === "coalesce-once") {
			return {
				kind: "due-fire",
				windowStartMs: trigger.atMs,
				missedWindowsBefore: 0,
				latestMissedBeforeWindowStartMs: null,
				nextWindowStartMs: null,
			};
		}
		return {
			kind: "missed-skip",
			latestMissedWindowStartMs: trigger.atMs,
			missedWindowCount: 1,
			nextWindowStartMs: null,
		};
	}

	if (trigger.kind === "interval") {
		const { everyMs, anchorMs } = trigger;
		if (nowMs < anchorMs) return { kind: "not-due", nextWindowStartMs: anchorMs };
		const latestK = Math.floor((nowMs - anchorMs) / everyMs);
		const latestW = anchorMs + latestK * everyMs;
		const nextW = anchorMs + (latestK + 1) * everyMs;
		if (lastConsumed !== null && lastConsumed >= latestW) {
			return { kind: "not-due", nextWindowStartMs: nextW };
		}
		const firstUnconsumedK =
			lastConsumed === null ? 0 : Math.max(0, Math.floor((lastConsumed - anchorMs) / everyMs) + 1);
		const unconsumedCount = Math.max(1, latestK - firstUnconsumedK + 1);
		const effectiveGraceMs = Math.min(onTimeGraceMs, Math.floor(everyMs / 4));
		const onTime = nowMs - latestW <= effectiveGraceMs;

		if (!onTime && schedule.missedRunPolicy === "skip-and-report") {
			return {
				kind: "missed-skip",
				latestMissedWindowStartMs: latestW,
				missedWindowCount: unconsumedCount,
				nextWindowStartMs: nextW,
			};
		}
		const missedBefore = unconsumedCount - 1;
		return {
			kind: "due-fire",
			windowStartMs: latestW,
			missedWindowsBefore: missedBefore,
			latestMissedBeforeWindowStartMs: missedBefore > 0 ? anchorMs + (latestK - 1) * everyMs : null,
			nextWindowStartMs: nextW,
		};
	}

	// Calendar trigger
	const { latestW, prevW, nextW, nominalPeriodMs } = bracketCalendarWindows(trigger.timezone, trigger.schedule, nowMs);
	// A newly created calendar schedule without prior consumption does not retroactively catch up windows prior to its creation.
	const floorMs = lastConsumed !== null ? lastConsumed : schedule.createdAtMs - 1;
	if (latestW <= floorMs) {
		return { kind: "not-due", nextWindowStartMs: nextW };
	}
	const unconsumedCount = countCalendarOccurrencesBetween(
		trigger.timezone,
		trigger.schedule,
		floorMs,
		latestW,
		nominalPeriodMs,
	);
	const effectiveGraceMs = Math.min(onTimeGraceMs, Math.floor(nominalPeriodMs / 4));
	const onTime = nowMs - latestW <= effectiveGraceMs;

	if (!onTime && schedule.missedRunPolicy === "skip-and-report") {
		return {
			kind: "missed-skip",
			latestMissedWindowStartMs: latestW,
			missedWindowCount: unconsumedCount,
			nextWindowStartMs: nextW,
		};
	}
	const missedBefore = Math.max(0, unconsumedCount - 1);
	return {
		kind: "due-fire",
		windowStartMs: latestW,
		missedWindowsBefore: missedBefore,
		latestMissedBeforeWindowStartMs: missedBefore > 0 ? prevW : null,
		nextWindowStartMs: nextW,
	};
}

// ---- Observation Freshness & Uncertainty Rules -------------------------------------------------------------------------------------

export type EndoObservationFreshnessV0 = "fresh" | "stale" | "clock-skew";

const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function endoObservationFreshnessV0(
	observedAtMs: number,
	staleAfterMs: number,
	nowMs: number,
): EndoObservationFreshnessV0 {
	if (observedAtMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) return "clock-skew";
	if (nowMs - observedAtMs > staleAfterMs) return "stale";
	return "fresh";
}

export interface EndoEffectiveProviderAllowanceV0 {
	readonly providerId: string;
	readonly freshness: EndoObservationFreshnessV0;
	readonly effectiveStanding: EndoAllowanceStandingV0;
	readonly availabilityConfirmed: boolean;
	readonly resetPassedUnverified: boolean;
	readonly originalStanding: EndoAllowanceStandingV0;
	readonly basis: EndoProviderAllowanceObservationV0["basis"];
}

/**
 * Evaluate a persisted provider allowance observation against `nowMs`.
 *
 * Non-negotiable uncertainty rules (S1-E / S1-AT12):
 * - A stale or clock-skewed observation NEVER continues to imply `available`; it degrades to `unknown`.
 * - An operator-declared reset window whose `resetAtMs <= nowMs` NEVER turns into confirmed `available`:
 *   it downgrades to `unknown` with `resetPassedUnverified: true` and `availabilityConfirmed: false`.
 */
export function endoEffectiveProviderAllowanceV0(
	provider: EndoProviderAllowanceObservationV0,
	nowMs: number,
): EndoEffectiveProviderAllowanceV0 {
	const freshness = endoObservationFreshnessV0(provider.observedAtMs, provider.staleAfterMs, nowMs);
	const resetPassedUnverified = provider.windows.some(
		(w) => w.resetAtMs !== null && w.resetAtMs <= nowMs && !w.availabilityConfirmed,
	);
	if (freshness !== "fresh") {
		return {
			providerId: provider.providerId,
			freshness,
			effectiveStanding: "unknown",
			availabilityConfirmed: false,
			resetPassedUnverified,
			originalStanding: provider.standing,
			basis: provider.basis,
		};
	}

	// Preserve any independently active (unexpired) per-window restriction even when another window's reset has elapsed (Codex P2 #3).
	const anyActiveExhausted = provider.windows.some(
		(w) => w.standing === "exhausted-until-reset" && (w.resetAtMs === null || w.resetAtMs > nowMs),
	);
	const anyActiveApproaching = provider.windows.some(
		(w) => w.standing === "approaching-limit" && (w.resetAtMs === null || w.resetAtMs > nowMs),
	);

	let effectiveStanding: EndoAllowanceStandingV0 = provider.standing;
	if (anyActiveExhausted) {
		effectiveStanding = "exhausted-until-reset";
	} else if (provider.standing === "exhausted-until-reset" && resetPassedUnverified) {
		effectiveStanding = anyActiveApproaching ? "approaching-limit" : "unknown";
	} else if (provider.standing === "approaching-limit" && resetPassedUnverified && !anyActiveApproaching) {
		effectiveStanding = "unknown";
	}

	const availabilityConfirmed =
		effectiveStanding === "available" &&
		provider.basis === "authoritative-api" &&
		provider.windows.every((w) => w.resetAtMs === null || w.availabilityConfirmed);
	return {
		providerId: provider.providerId,
		freshness,
		effectiveStanding,
		availabilityConfirmed,
		resetPassedUnverified,
		originalStanding: provider.standing,
		basis: provider.basis,
	};
}

// ---- S2 Seam: Recorded-Observation Observer for M1 Model Pool ----------------------------------------------------------------------

export type EndoRecordedPoolObservationLookupV0 =
	| {
			readonly fresh: true;
			readonly leaseEpoch: number;
			readonly poolSha256: string;
			readonly observation: EndoCoordinatorMemberObservationV0;
	  }
	| {
			readonly fresh: false;
			readonly reason: "pool-mismatch" | "missing-member" | "endpoint-or-model-mismatch" | "stale" | "clock-skew";
	  };

function toM1Observation(ep: EndoObservedLocalEndpointV0): EndoCoordinatorMemberObservationV0 {
	return Object.freeze({
		memberId: ep.memberId,
		endpoint: ep.endpoint,
		modelId: ep.modelId,
		basis: ep.basis,
		observedAtMs: ep.observedAtMs,
		elapsedMs: ep.elapsedMs,
		readiness: ep.readiness,
		detail: ep.detail,
		backend: ep.backend,
		build: ep.build,
		requests: ep.requests,
		inferenceTokens: 0,
	});
}

/**
 * Look up a fresh, pool-pinned M1 observation from a persisted S1 `resources.json` snapshot.
 * Preserves exact `poolSha256`, `leaseEpoch`, and freshness boundaries so S2 can feed M1's
 * `selectCoordinatorModelV0` without redundant network probes.
 */
export function evaluateRecordedPoolObservationV0(args: {
	readonly snapshot: EndoDevelopResourceObservationV0;
	readonly expectedPoolSha256: string;
	readonly member: { readonly memberId: string; readonly endpoint: string; readonly modelId: string };
	readonly nowMs: number;
	readonly maxAgeMs?: number;
}): EndoRecordedPoolObservationLookupV0 {
	if (args.snapshot.modelPool.poolSha256 !== args.expectedPoolSha256) {
		return { fresh: false, reason: "pool-mismatch" };
	}
	const match = args.snapshot.modelPool.localEndpoints.find((e) => e.memberId === args.member.memberId);
	if (match === undefined) return { fresh: false, reason: "missing-member" };
	if (match.endpoint !== args.member.endpoint || match.modelId !== args.member.modelId) {
		return { fresh: false, reason: "endpoint-or-model-mismatch" };
	}
	if (args.maxAgeMs !== undefined && (!Number.isSafeInteger(args.maxAgeMs) || args.maxAgeMs < 0)) {
		throw new TypeError("maxAgeMs must be a non-negative integer");
	}
	const effectiveStaleAfter =
		args.maxAgeMs === undefined ? match.staleAfterMs : Math.min(match.staleAfterMs, args.maxAgeMs);
	const freshness = endoObservationFreshnessV0(match.observedAtMs, effectiveStaleAfter, args.nowMs);
	if (freshness === "clock-skew") return { fresh: false, reason: "clock-skew" };
	if (freshness === "stale") return { fresh: false, reason: "stale" };
	return {
		fresh: true,
		leaseEpoch: args.snapshot.leaseEpoch,
		poolSha256: args.expectedPoolSha256,
		observation: toM1Observation(match),
	};
}

/**
 * S2 integration seam: build an M1 `EndoCoordinatorMemberObserverV0` backed by fresh S1 observations,
 * optionally falling back to a live observer when the recorded observation is missing, stale, or for a different pool.
 */
export function createRecordedCoordinatorModelObserverV0(args: {
	readonly snapshot: EndoDevelopResourceObservationV0 | null;
	readonly expectedPoolSha256: string;
	readonly now?: () => number;
	readonly maxAgeMs?: number;
	readonly fallback?: EndoCoordinatorMemberObserverV0;
}): EndoCoordinatorMemberObserverV0 {
	const now = args.now ?? Date.now;
	return async (member) => {
		const nowMs = now();
		if (args.snapshot !== null) {
			const lookup = evaluateRecordedPoolObservationV0({
				snapshot: args.snapshot,
				expectedPoolSha256: args.expectedPoolSha256,
				member,
				nowMs,
				...(args.maxAgeMs === undefined ? {} : { maxAgeMs: args.maxAgeMs }),
			});
			if (lookup.fresh) return lookup.observation;
		}
		if (args.fallback !== undefined) return args.fallback(member);
		// No live probe was attempted: report unavailable cleanly (ineligible under every pool policy) rather than faking a timeout.
		return Object.freeze({
			memberId: member.memberId,
			endpoint: member.endpoint,
			modelId: member.modelId,
			basis: "controller-observed",
			observedAtMs: nowMs,
			elapsedMs: 0,
			readiness: "unreachable",
			detail: "cancelled",
			backend: "unknown",
			build: null,
			requests: Object.freeze([]),
			inferenceTokens: 0,
		});
	};
}

// ---- Opt-In Systemd User Unit Template Rendering (Stdout-Only, Never Installs/Activates) -------------------------------------------

export const ENDO_SYSTEMD_UNIT_NAME_PATTERN_V0 = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_ON_CALENDAR_PATTERN = /^[A-Za-z0-9*:,./~ -]{1,64}$/;

/**
 * Escape one argument for systemd `ExecStart=` according to systemd.syntax(7):
 * - Rejects NUL and ASCII control characters (including CR/LF).
 * - Escapes `%` -> `%%` (prevents systemd specifier expansion).
 * - Escapes `$` -> `$$` (prevents systemd environment-variable expansion).
 * - Escapes `\` -> `\\` and `"` -> `\"` and wraps in double quotes whenever needed.
 */
export function escapeEndoSystemdExecArgV0(arg: string): string {
	if (arg.length === 0) return '""';
	if (/[\u0000-\u001f\u007f-\u009f]/.test(arg))
		throw new TypeError("systemd argument cannot contain control characters or newlines");
	const escaped = arg
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/%/g, "%%")
		.replace(/\$/g, () => "$$");
	if (/^[@:+!-]/.test(arg) || /[\s"'\\;$%&|<>`!#*?[\]{}()]/.test(arg)) return `"${escaped}"`;
	return escaped;
}

export interface RenderEndoSystemdUnitsOptionsV0 {
	readonly endoBin: string;
	readonly storeRoot: string;
	readonly nodeBin?: string;
	readonly poolPath?: string;
	readonly unitName?: string;
	readonly onCalendar?: string;
}

export interface RenderedEndoSystemdUnitsV0 {
	readonly schemaVersion: "endo.scheduler-systemd-units.v0";
	readonly unitName: string;
	readonly serviceName: string;
	readonly timerName: string;
	readonly installed: false;
	readonly activated: false;
	readonly execStart: string;
	readonly serviceContent: string;
	readonly timerContent: string;
	readonly manualInstructions: string;
}

function assertAbsoluteSafePath(value: string, label: string): void {
	if (!value.startsWith("/") || value.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(value))
		throw new TypeError(`${label} must be an absolute path without control characters`);
}

/**
 * Render example `systemd --user` `.service` and `.timer` unit files to print on stdout.
 * Never touches host systemd directories, never invokes `systemctl`, and never modifies linger settings.
 */
export function renderEndoSystemdUnitsV0(options: RenderEndoSystemdUnitsOptionsV0): RenderedEndoSystemdUnitsV0 {
	const unitName = options.unitName ?? "endo-scheduler-tick";
	if (!ENDO_SYSTEMD_UNIT_NAME_PATTERN_V0.test(unitName))
		throw new TypeError(`unitName ${JSON.stringify(unitName)} must match ${ENDO_SYSTEMD_UNIT_NAME_PATTERN_V0}`);
	const onCalendar = options.onCalendar ?? "*:0/5";
	if (!SAFE_ON_CALENDAR_PATTERN.test(onCalendar))
		throw new TypeError(`onCalendar ${JSON.stringify(onCalendar)} contains unsupported characters`);
	assertAbsoluteSafePath(options.endoBin, "endoBin");
	assertAbsoluteSafePath(options.storeRoot, "storeRoot");
	if (options.nodeBin !== undefined) assertAbsoluteSafePath(options.nodeBin, "nodeBin");
	if (options.poolPath !== undefined) assertAbsoluteSafePath(options.poolPath, "poolPath");

	const argv: string[] = [];
	if (options.nodeBin !== undefined) argv.push(options.nodeBin);
	argv.push(options.endoBin, "scheduler", "tick", "--root", options.storeRoot);
	if (options.poolPath !== undefined) argv.push("--pool", options.poolPath);
	argv.push("--quiet");
	const execStart = argv.map(escapeEndoSystemdExecArgV0).join(" ");

	const serviceName = `${unitName}.service`;
	const timerName = `${unitName}.timer`;

	const serviceContent = [
		"# Endophasia S1 deterministic observation tick (example user unit; stdout-only, NOT installed automatically).",
		"# Executes zero LLM inference, dispatches zero agents, and holds zero execution authority.",
		"# Systemd is a wake driver only; Endophasia's store-local schedule ledger and lease remain authoritative.",
		"[Unit]",
		"Description=Endophasia deterministic Coordinator observation tick (S1, zero-LLM)",
		"After=network.target",
		"",
		"[Service]",
		"Type=oneshot",
		`ExecStart=${execStart}`,
		"TimeoutStartSec=90s",
		"NoNewPrivileges=yes",
		...(options.storeRoot.startsWith("/tmp/")
			? ["# PrivateTmp omitted because storeRoot lies under /tmp/"]
			: ["PrivateTmp=yes"]),
		"MemoryMax=512M",
		"TasksMax=32",
		"",
	].join("\n");

	const timerContent = [
		"# Endophasia S1 wake timer (example user unit; stdout-only, NOT installed or enabled automatically).",
		"# Upstream systemd.timer(5) semantics:",
		"# - Systemd will not start a second instance while the service is still active.",
		"# - Persistent=true applies to OnCalendar= timers and may coalesce missed wakeups on boot/resume.",
		"# - A user service manager is not necessarily running while logged out unless lingering is enabled separately.",
		"[Unit]",
		"Description=Periodic wake driver for Endophasia S1 deterministic observation ticks",
		"",
		"[Timer]",
		`OnCalendar=${onCalendar}`,
		"Persistent=true",
		"RandomizedDelaySec=15s",
		"AccuracySec=30s",
		`Unit=${serviceName}`,
		"",
		"[Install]",
		"WantedBy=timers.target",
		"",
	].join("\n");

	const manualInstructions = [
		"# Manual opt-in setup (run only if you explicitly choose to enable background ticks):",
		"mkdir -p ~/.config/systemd/user",
		`# Save the [Unit]/[Service] block above to ~/.config/systemd/user/${serviceName}`,
		`# Save the [Unit]/[Timer]/[Install] block above to ~/.config/systemd/user/${timerName}`,
		"systemctl --user daemon-reload",
		`systemctl --user enable --now ${timerName}`,
		`systemctl --user status ${timerName}`,
		"# Note: without loginctl enable-linger, user timers run only while your login session is active.",
		"",
		"# Manual removal:",
		`systemctl --user disable --now ${timerName}`,
		`rm -f ~/.config/systemd/user/${timerName} ~/.config/systemd/user/${serviceName}`,
		"systemctl --user daemon-reload",
		"",
	].join("\n");

	return Object.freeze({
		schemaVersion: "endo.scheduler-systemd-units.v0",
		unitName,
		serviceName,
		timerName,
		installed: false,
		activated: false,
		execStart,
		serviceContent,
		timerContent,
		manualInstructions,
	});
}
