/**
 * Manipulation checks for an experiment (the spec's `manipulation`): did each condition change Pi's requests exactly as
 * declared, and nothing else? Computed from what the trials recorded: the request bodies (capture blobs), Pi's
 * reported cache reads (session events), and the server's cache counters in the recorded responses.
 *
 *   M1  injected fields: every request of a declared condition carries its injected fields with their values; every
 *       request of any other condition carries none of the watched sampling and cache fields.
 *   M2  nothing else changes: (a) per task, the first request of every trial, without the condition's injected
 *       fields, is identical (canonical JSON) across all trials and conditions; (b) in every request, the system
 *       message, the tools and the set of top-level fields (without injected fields) equal the baseline's.
 *   M3  cache off: a condition declared `zeroCacheReads` has zero cache reads in every assistant message Pi reported
 *       and in every recorded response counter (`cached_tokens`, `cache_n`).
 *   M4  identical: for each declared pair, per task, first requests are identical across both conditions' trials, and
 *       every request's system message, tools and top-level fields match.
 *
 * A condition that fails a check that concerns it is invalid. Nothing is reinterpreted.
 */

import { join } from "node:path";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import type { EndoExperimentManipulationV0 } from "../protocol/experiment-spec.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { type PiCassetteKeySourceV0, piCassetteKeyV0 } from "./cassette-session.ts";
import { readEndoStoreEventsV0 } from "./trajectory.ts";

/** Fields M1 watches in conditions that inject nothing. */
export const ENDO_MANIPULATION_WATCHED_FIELDS_V0 = [
	"temperature",
	"seed",
	"cache_prompt",
	"top_p",
	"top_k",
	"min_p",
	"typical_p",
	"presence_penalty",
	"frequency_penalty",
	"repeat_penalty",
];

/** What one trial recorded, for the checks. */
export interface EndoTrialRequestsV0 {
	task: string;
	condition: string;
	trial: number;
	requests: Record<string, JsonValueV0>[];
	/** cacheRead of every assistant message Pi reported. */
	piCacheReads: number[];
	/** Every `cached_tokens` / `cache_n` value in the recorded responses. */
	responseCacheCounters: number[];
}

/** Read a trial's requests and cache counters from its store. */
export function loadEndoTrialRequestsV0(
	store: string,
	key: { task: string; condition: string; trial: number },
	keySource: PiCassetteKeySourceV0,
): EndoTrialRequestsV0 {
	const blobs = createEndoBlobStoreV0(join(store, "capture"), piCassetteKeyV0(keySource), { readOnly: true });
	const requests: Record<string, JsonValueV0>[] = [];
	const responseCacheCounters: number[] = [];
	for (const event of readEndoCaptureEventsV0(store)) {
		if (event.producer !== "capture:record") continue;
		const payload = event.payload as { body?: { digest: EndoKeyedDigestV0 }; wire?: { digest: EndoKeyedDigestV0 } };
		if (event.kind === "capture.request" && payload.body)
			requests.push(JSON.parse(Buffer.from(blobs.get(payload.body.digest)).toString("utf8")));
		if (event.kind === "capture.exchange-ended" && payload.wire) {
			const wire = Buffer.from(blobs.get(payload.wire.digest)).toString("utf8");
			for (const match of wire.matchAll(/"(?:cached_tokens|cache_n)"\s*:\s*(\d+)/g))
				responseCacheCounters.push(Number(match[1]));
		}
	}
	const piCacheReads: number[] = [];
	for (const event of readEndoStoreEventsV0(store)) {
		const payload = event.payload as { role?: unknown; usage?: { cacheRead?: unknown } };
		if (
			event.kind === "message.completed" &&
			payload.role === "assistant" &&
			typeof payload.usage?.cacheRead === "number"
		)
			piCacheReads.push(payload.usage.cacheRead);
	}
	return { ...key, requests, piCacheReads, responseCacheCounters };
}

export type EndoCheckStatusV0 = "PASS" | "FAIL" | "NOT-APPLICABLE";

export interface EndoCheckResultV0 {
	status: EndoCheckStatusV0;
	/** What was checked, in counts. */
	checked: number;
	/** The first failures (at most 20), each naming the trial and request. */
	failures: string[];
	failureCount: number;
	/** The conditions a failure makes invalid. */
	invalidates: string[];
}

function result(
	checked: number,
	failures: { detail: string; condition: string }[],
	applicable = true,
): EndoCheckResultV0 {
	return {
		status: !applicable ? "NOT-APPLICABLE" : failures.length === 0 ? "PASS" : "FAIL",
		checked,
		failures: failures.slice(0, 20).map((failure) => failure.detail),
		failureCount: failures.length,
		invalidates: [...new Set(failures.map((failure) => failure.condition))].sort(),
	};
}

/** Equal as canonical JSON; a missing value (undefined) equals only another missing value. */
const same = (a: unknown, b: unknown) =>
	a === undefined || b === undefined ? a === b : canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);

function strip(
	request: Record<string, JsonValueV0>,
	injected: Record<string, JsonValueV0>,
): Record<string, JsonValueV0> {
	return Object.fromEntries(Object.entries(request).filter(([field]) => !(field in injected)));
}

/** The structural parts M2b and M4 compare: system message, tools, top-level field names. */
function structure(request: Record<string, JsonValueV0>): JsonValueV0 {
	const messages = Array.isArray(request.messages) ? request.messages : [];
	return { system: messages[0] ?? null, tools: request.tools ?? null, fields: Object.keys(request).sort() };
}

const label = (trial: EndoTrialRequestsV0, index?: number) =>
	`${trial.task}/${trial.condition}/#${trial.trial}${index === undefined ? "" : ` request ${index + 1}`}`;

/** Run M1 to M4 over the trials. */
export function endoManipulationChecksV0(
	manipulation: EndoExperimentManipulationV0,
	trials: readonly EndoTrialRequestsV0[],
): {
	M1: EndoCheckResultV0;
	M2a: EndoCheckResultV0;
	M2b: EndoCheckResultV0;
	M3: EndoCheckResultV0;
	M4: EndoCheckResultV0;
	validity: Record<string, "valid" | "invalid" | "no trials">;
} {
	const injectedOf = (condition: string) => manipulation.conditions[condition]?.injected ?? {};
	// M1
	const m1: { detail: string; condition: string }[] = [];
	let m1Checked = 0;
	for (const trial of trials) {
		const injected = injectedOf(trial.condition);
		trial.requests.forEach((request, index) => {
			m1Checked += 1;
			if (Object.keys(injected).length > 0) {
				for (const [field, value] of Object.entries(injected))
					if (!same(request[field], value))
						m1.push({
							condition: trial.condition,
							detail: `${label(trial, index)}: ${field} is ${JSON.stringify(request[field] ?? null)}, expected ${JSON.stringify(value)}`,
						});
			} else {
				for (const field of ENDO_MANIPULATION_WATCHED_FIELDS_V0)
					if (field in request)
						m1.push({
							condition: trial.condition,
							detail: `${label(trial, index)}: carries ${field} = ${JSON.stringify(request[field])}`,
						});
			}
		});
	}
	// M2
	const tasks = [...new Set(trials.map((trial) => trial.task))].sort();
	const m2a: { detail: string; condition: string }[] = [];
	const m2b: { detail: string; condition: string }[] = [];
	let m2aChecked = 0;
	let m2bChecked = 0;
	for (const task of tasks) {
		const taskTrials = trials.filter((trial) => trial.task === task && trial.requests.length > 0);
		const reference = taskTrials.find((trial) => trial.condition === manipulation.baseline);
		if (reference === undefined) {
			m2a.push({
				condition: manipulation.baseline,
				detail: `${task}: no baseline (${manipulation.baseline}) trial with a request to compare with`,
			});
			continue;
		}
		const firstRef = strip(reference.requests[0]!, injectedOf(reference.condition));
		const structureRef = structure(firstRef);
		for (const trial of taskTrials) {
			const injected = injectedOf(trial.condition);
			m2aChecked += 1;
			if (!same(strip(trial.requests[0]!, injected), firstRef))
				m2a.push({
					condition: trial.condition,
					detail: `${label(trial, 0)}: the first request (without injected fields) differs from ${label(reference, 0)}`,
				});
			trial.requests.forEach((request, index) => {
				m2bChecked += 1;
				if (!same(structure(strip(request, injected)), structureRef))
					m2b.push({
						condition: trial.condition,
						detail: `${label(trial, index)}: system message, tools or top-level fields differ from the baseline's`,
					});
			});
		}
	}
	// M3
	const m3: { detail: string; condition: string }[] = [];
	let m3Checked = 0;
	const zeroConditions = Object.entries(manipulation.conditions)
		.filter(([, entry]) => entry.zeroCacheReads === true)
		.map(([id]) => id);
	for (const trial of trials.filter((candidate) => zeroConditions.includes(candidate.condition))) {
		m3Checked += 1;
		if (trial.piCacheReads.length === 0)
			m3.push({ condition: trial.condition, detail: `${label(trial)}: Pi reported no usage to check` });
		const piReads = trial.piCacheReads.filter((value) => value !== 0);
		const serverReads = trial.responseCacheCounters.filter((value) => value !== 0);
		if (piReads.length > 0)
			m3.push({
				condition: trial.condition,
				detail: `${label(trial)}: Pi reported cacheRead ${piReads.join(", ")}`,
			});
		if (serverReads.length > 0)
			m3.push({
				condition: trial.condition,
				detail: `${label(trial)}: the server reported cached tokens ${serverReads.join(", ")}`,
			});
	}
	// M4
	const m4: { detail: string; condition: string }[] = [];
	let m4Checked = 0;
	let m4Applicable = false;
	for (const [x, y] of manipulation.identical ?? []) {
		for (const task of tasks) {
			const pair = trials.filter(
				(trial) =>
					trial.task === task && (trial.condition === x || trial.condition === y) && trial.requests.length > 0,
			);
			if (!pair.some((trial) => trial.condition === x) || !pair.some((trial) => trial.condition === y)) continue;
			m4Applicable = true;
			const reference = pair[0]!;
			for (const trial of pair) {
				m4Checked += 1;
				if (!same(trial.requests[0], reference.requests[0]))
					m4.push({
						condition: trial.condition,
						detail: `${label(trial, 0)}: the first request differs from ${label(reference, 0)}`,
					});
				trial.requests.forEach((request, index) => {
					if (!same(structure(request), structure(reference.requests[0]!)))
						m4.push({
							condition: trial.condition,
							detail: `${label(trial, index)}: system message, tools or top-level fields differ from ${label(reference, 0)}`,
						});
				});
			}
		}
	}
	const checks = {
		M1: result(m1Checked, m1),
		M2a: result(m2aChecked, m2a),
		M2b: result(m2bChecked, m2b),
		M3: result(m3Checked, m3, zeroConditions.length > 0 && m3Checked > 0),
		M4: result(m4Checked, m4, m4Applicable),
	};
	// M4 failures invalidate both members of the pair: which side changed cannot be told apart.
	const invalid = new Set<string>([
		...checks.M1.invalidates,
		...checks.M2a.invalidates,
		...checks.M2b.invalidates,
		...checks.M3.invalidates,
	]);
	if (checks.M4.status === "FAIL")
		for (const pair of manipulation.identical ?? []) for (const id of pair) invalid.add(id);
	const conditions = [
		...new Set([
			...trials.map((trial) => trial.condition),
			manipulation.baseline,
			...Object.keys(manipulation.conditions),
			...(manipulation.identical ?? []).flat(),
		]),
	].sort();
	const validity = Object.fromEntries(
		conditions.map((condition) => [
			condition,
			!trials.some((trial) => trial.condition === condition)
				? ("no trials" as const)
				: invalid.has(condition)
					? ("invalid" as const)
					: ("valid" as const),
		]),
	);
	return { ...checks, validity };
}
