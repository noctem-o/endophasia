// Analysis for the steering study (DESIGN.md §6, §7, §9a, §10), beside `endo experiment report` (which computes §8 and
// M1 to M3):
//
//   node research/steering/1.0.1/analyze.ts estimate <run dir>                  mean wall time per cell and T(N)
//   node research/steering/1.0.1/analyze.ts manipulation <run dir>              M5, M6 (E3's) and I1, I2
//   node research/steering/1.0.1/analyze.ts checks <run dir>                    P1 to P5, per task and arm, per trial
//   node research/steering/1.0.1/analyze.ts spotcheck <run dir> --pi <p> [--trials t/c/#n,...]
//   node research/steering/1.0.1/analyze.ts replays <cassette dir> --pi <p>     each steered cassette 5 times
//   node research/steering/1.0.1/analyze.ts replication <original run dir> --against <replication run dir>   (post-hoc)
//   node research/steering/1.0.1/analyze.ts sensitivity <run dir>
//
// Each prints one JSON document on stdout. M5, M6, the estimate, the spot check and the sensitivity scan are E3's,
// imported unchanged.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializePiCassetteFixtureV0 } from "../../../cli/cassette-fixture.ts";
import { type PiCassetteKeySourceV0, replayPiCassetteSessionV0 } from "../../../cli/cassette-session.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentRunRecordFileV0,
	readEndoExperimentTrialResultFileV0,
} from "../../../cli/experiment-artifacts.ts";
import { loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import { readEndoStoreEventsV0, trajectoryFromStoreV0 } from "../../../cli/trajectory.ts";
import type { EndoEventV0 } from "../../../protocol/event.ts";
import type { EndoExperimentRunRecordV0, EndoExperimentTrialResultV0 } from "../../../protocol/experiment-artifacts.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { mulberry32V0, shuffleV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";
import {
	manipulation as environmentManipulation,
	estimate,
	normalizeToolCallIds,
} from "../../pinned-environment/1.0.1/analyze.ts";
import { sensitivity } from "../../variance/1.0.1/analyze.ts";
import { MESSAGES, STEER_POINT } from "./make-spec.ts";

export { estimate, sensitivity };

const FIXTURE = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
const canonical = (value: unknown) => canonicalEndoJsonV0(value);

function trials(dir: string): EndoExperimentTrialResultV0[] {
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		// A trial that never ran has no result; one that has a result the reader refuses is an error, not a gap.
		const file = join(dir, "trials", entry.task, entry.condition, String(entry.trial), "result.json");
		return existsSync(file) ? [readEndoExperimentTrialResultFileV0(file)] : [];
	});
}
const label = (trial: EndoExperimentTrialResultV0) => `${trial.task}/${trial.condition}/#${trial.trial}`;

/** The intervention records of a session store, in order. */
function interventionRecords(store: string): EndoEventV0[] {
	return readEndoStoreEventsV0(store).filter((event) => event.kind.startsWith("intervention."));
}

/** The chain every steered trial records (DESIGN §6, I1). */
export const CHAIN_KINDS_V0 = [
	"intervention.proposal",
	"intervention.authorization",
	"intervention.request",
	"intervention.accepted",
	"intervention.consumed",
	"intervention.consequence",
] as const;

const CAPABILITY: Record<string, string> = { steer: "steering.steer", queue: "steering.follow-up" };

/**
 * I1: each steered trial records exactly one chain, linked by derivedFrom, with the right origin, message digest,
 * authority and delivery point; each baseline trial records no intervention record.
 * I2: each run session's capability study admitted the capabilities before the session's first trial.
 */
export function interventionManipulation(
	dir: string,
	key: EndoDigestKeyV0 = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0()),
) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const i1: Record<string, { trials: number; failures: string[] }> = {};
	for (const trial of trials(dir).filter((entry) => entry.status === "completed")) {
		const condition = run.spec.conditions.find((entry) => entry.id === trial.condition)!;
		const intervention = condition.interventions?.[trial.task];
		const records = interventionRecords(join(dir, trial.store));
		const failures: string[] = [];
		if (intervention === undefined) {
			if (records.length > 0) failures.push(`${records.length} intervention records in a baseline trial`);
		} else {
			if (records.map((event) => event.kind).join() !== CHAIN_KINDS_V0.join())
				failures.push(`chain is ${records.map((event) => event.kind).join(",")}`);
			else {
				const [proposal, authorization, request, accepted, consumed, consequence] = records.map(
					(event) => event.payload as Record<string, unknown>,
				);
				// The links: authorization <- proposal, request <- authorization, accepted <- request, consumed <- request,
				// and the consequence <- request, accepted and consumed (it weighs acceptance against consumption).
				const [pId, aId, rId, accId, conId] = records.map((event) => event.id);
				const parents: [number, string[]][] = [
					[1, [pId!]],
					[2, [aId!]],
					[3, [rId!]],
					[4, [rId!]],
					[5, [rId!, accId!, conId!]],
				];
				for (const [index, expected] of parents)
					if (canonical([...records[index]!.derivedFrom].sort()) !== canonical([...expected].sort()))
						failures.push(
							`${records[index]!.kind} does not derive from exactly ${expected.length} predecessor(s) as designed`,
						);
				if (proposal!.origin !== "operator-scenario") failures.push(`origin ${String(proposal!.origin)}`);
				if (proposal!.operation !== intervention.operation)
					failures.push(`operation ${String(proposal!.operation)}`);
				// DESIGN §6: the proposal's message digest equals the keyed digest of the task's message.
				const messageDigest = (proposal!.message as { digest: { keyId: string; value: string } }).digest;
				const expectedDigest = key.digestBytes(Buffer.from(intervention.message ?? "", "utf8"));
				if (messageDigest.keyId !== expectedDigest.keyId || messageDigest.value !== expectedDigest.value)
					failures.push("the proposal's message digest is not the keyed digest of the spec's message");
				const auth = authorization as {
					decision: string;
					authority: { kind: string; confirmation: string };
					proposalDigest: string;
				};
				if (auth.decision !== "allow") failures.push(`decision ${auth.decision}`);
				if (auth.authority.kind !== "local-operator" || auth.authority.confirmation !== "scenario")
					failures.push(`authority ${canonical(auth.authority)}`);
				if (auth.proposalDigest !== proposal!.proposalDigest)
					failures.push("the authorization names another digest");
				const point = request!.at as { exchange: number; chunks: number } | null;
				if (
					point === null ||
					point.exchange !== intervention.after.exchange ||
					point.chunks < intervention.after.chunks
				)
					failures.push(`delivery point ${canonical(point)}`);
				if (request!.capability !== CAPABILITY[intervention.operation])
					failures.push(`capability ${String(request!.capability)}`);
				if ((accepted as { disposition: unknown }).disposition !== "queued")
					failures.push(`disposition ${String((accepted as { disposition: unknown }).disposition)}`);
				if ((consumed as { exchange: unknown }).exchange === undefined) failures.push("no consumed exchange");
				if ((consequence as { requestId: unknown }).requestId !== request!.requestId)
					failures.push("the consequence names another request");
			}
		}
		i1[trial.condition] ??= { trials: 0, failures: [] };
		const cell = i1[trial.condition]!;
		cell.trials += 1;
		cell.failures.push(...failures.map((failure) => `${label(trial)}: ${failure}`));
	}
	// I2, from the journal and each study's summary.
	const journal = readFileSync(join(dir, "journal.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					event: string;
					session?: number;
					at: string;
					summary?: { capability: string; status: string }[];
				},
		);
	const i2: { session: number; admitted: string[]; failures: string[] }[] = [];
	for (const start of journal.filter((entry) => entry.event === "run-session-started")) {
		const session = start.session!;
		const firstTrial = journal.find((entry) => entry.event === "trial-started" && entry.session === session);
		const study = journal.find((entry) => entry.event === "capability-study" && entry.session === session);
		const failures: string[] = [];
		if (firstTrial !== undefined && (study === undefined || study.at > firstTrial.at))
			failures.push("no capability study before the session's first trial");
		const needed = new Set(
			run.spec.conditions.flatMap((condition) =>
				Object.values(condition.interventions ?? {}).map((entry) => CAPABILITY[entry.operation]!),
			),
		);
		for (const capability of needed) {
			const status = study?.summary?.find((entry) => entry.capability === capability)?.status;
			if (status !== "admitted" && status !== "admitted-partial") failures.push(`${capability}: ${String(status)}`);
		}
		i2.push({
			session,
			admitted: (study?.summary ?? []).map((entry) => `${entry.capability}: ${entry.status}`),
			failures,
		});
	}
	return {
		I1: {
			status: Object.values(i1).every((cell) => cell.failures.length === 0) ? "PASS" : "FAIL",
			byCondition: i1,
		},
		I2: { status: i2.every((entry) => entry.failures.length === 0) ? "PASS" : "FAIL", bySession: i2 },
	};
}

/** M5 and M6 (E3's) and I1 and I2. */
export function manipulation(dir: string) {
	return { ...environmentManipulation(dir), ...interventionManipulation(dir) };
}

/**
 * One recorded trial replayed from its cassette, with what a steered trial must show: each intervention re-issued at its
 * recorded point (the spec's), with the recorded proposal digest, and accepted; a baseline trial reports none.
 */
export async function replayOneTrial(
	run: EndoExperimentRunRecordV0,
	dir: string,
	trial: EndoExperimentTrialResultV0,
	pi: string,
	keySource: PiCassetteKeySourceV0 = FIXTURE,
) {
	const scratch = mkdtempSync(join(tmpdir(), "endo-spotcheck-"));
	try {
		const report = await replayPiCassetteSessionV0({
			store: join(dir, trial.store),
			out: join(scratch, "replay"),
			pi,
			timing: "immediate",
			keySource,
			timeoutMs: 600_000,
		});
		const layers = report.comparison.layers;
		const intervention = run.spec.conditions.find((entry) => entry.id === trial.condition)?.interventions?.[
			trial.task
		];
		const reissued = report.interventions;
		return {
			trial: label(trial),
			lifecycle: layers.lifecycle.status,
			toolCalls: layers.toolCalls.status,
			toolResults: layers.toolResults.status,
			outcome: layers.outcome.status,
			served: report.served,
			misses: report.misses,
			unserved: report.unserved,
			interventions: reissued,
			interventionAsRequired:
				intervention === undefined
					? reissued.length === 0
					: reissued.length === 1 &&
						reissued[0]!.operation === intervention.operation &&
						canonical(reissued[0]!.recordedAt) === canonical(intervention.after) &&
						canonical(reissued[0]!.reissuedAt) === canonical(intervention.after) &&
						reissued[0]!.proposalDigestMatches &&
						reissued[0]!.result === "accepted",
			flags: report.comparison.flags.map((flag) => flag.kind),
			notes: report.notes,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * §10, the seeded spot check: three trials chosen by the run's ordering seed (mulberry32 and Fisher-Yates over the
 * completed trials in plan order), or the named ones, replayed from their cassettes. E3's spot check, plus what a steered
 * trial must show: each intervention re-issued at its recorded point, with the same proposal digest, and accepted.
 */
export async function steeredSpotcheck(dir: string, pi: string, named: string[] = []) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const completed = trials(dir).filter((trial) => trial.status === "completed" && trial.session !== null);
	const chosen =
		named.length > 0
			? named.map((name) => {
					const found = completed.find((trial) => label(trial) === name);
					if (found === undefined) throw new TypeError(`no completed trial ${name}`);
					return found;
				})
			: shuffleV0(completed, mulberry32V0(run.seed)).slice(0, 3);
	const out = [];
	for (const trial of chosen) out.push(await replayOneTrial(run, dir, trial, pi));
	return {
		seed: run.seed,
		selection:
			named.length > 0
				? "named trials"
				: "mulberry32(ordering seed), Fisher-Yates over completed trials in plan order, first three",
		replays: out,
	};
}

interface Loaded {
	trial: EndoExperimentTrialResultV0;
	requests: Record<string, unknown>[];
	layers: Record<string, string>;
	outcome: string;
	records: EndoEventV0[];
}

function load(dir: string, trial: EndoExperimentTrialResultV0, keySource: PiCassetteKeySourceV0): Loaded {
	const store = join(dir, trial.store);
	const { requests } = loadEndoTrialRequestsV0(store, trial, keySource);
	const trajectory = trajectoryFromStoreV0(store, trial.session!, { label: trial.store });
	const layers = Object.fromEntries(
		(["lifecycle", "toolCalls", "toolResults", "outcome"] as const).map((name) => [
			name,
			canonical(trajectory.layers[name]),
		]),
	);
	const outcomeLayer = trajectory.layers.outcome;
	const outcome =
		outcomeLayer.status === "reported" ? outcomeLayer.entries.map((entry) => entry.outcome).join("+") : "UNAVAILABLE";
	return { trial, requests: normalizeToolCallIds(requests), layers, outcome, records: interventionRecords(store) };
}

/** The 1-based index of the first request that differs, or null when the shorter is a prefix of an equal-length one. */
export function firstDivergence(a: readonly unknown[], b: readonly unknown[]): number | null {
	const shared = Math.min(a.length, b.length);
	for (let index = 0; index < shared; index += 1) if (canonical(a[index]) !== canonical(b[index])) return index + 1;
	return a.length === b.length ? null : shared + 1;
}

const textOf = (message: Record<string, unknown>): string =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? (message.content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

/**
 * Compliance (DESIGN §7, P5): after the user message carrying the task's message, some assistant message carries a
 * `bash` tool call whose `command` argument, trimmed, is the task's command. Read from the last request, which holds
 * the whole conversation.
 */
export function complied(requests: readonly Record<string, unknown>[], task: string): boolean {
	const spec = MESSAGES[task];
	const last = requests.at(-1);
	if (spec === undefined || last === undefined) return false;
	const messages = (last.messages ?? []) as Record<string, unknown>[];
	const at = messages.findIndex((message) => message.role === "user" && textOf(message) === spec.text);
	if (at === -1) return false;
	return messages.slice(at + 1).some((message) =>
		((message.tool_calls ?? []) as { function: { name: string; arguments: string } }[]).some((call) => {
			if (call.function.name !== "bash") return false;
			try {
				return (
					String((JSON.parse(call.function.arguments) as { command?: unknown }).command ?? "").trim() ===
					spec.command
				);
			} catch {
				return false;
			}
		}),
	);
}

/**
 * P2 to P4 for one steered trial (DESIGN §7), against the baseline's requests (identical across baseline trials, by P1):
 *   P2  requests 1 to `point` equal the baseline's: nothing differs before the point;
 *   P3  the first divergence is request point + 1 for a steer, and request n + 1 (n = the baseline's request count)
 *       with requests 1 to n all equal for a queue;
 *   P4  the proxy showed the consumption, and it is in exactly the exchange of the first divergence.
 */
export function judgeSteeredTrial(input: {
	arm: "steer" | "queue";
	point: number;
	baseRequests: readonly unknown[];
	requests: readonly unknown[];
	consumedExchange: number | null;
	consumptionObserved: boolean;
}): { first: number | null; expectedFirst: number; p2: boolean; p3: boolean; p4: boolean } {
	const { arm, point, baseRequests, requests } = input;
	const n = baseRequests.length;
	const first = n === 0 ? null : firstDivergence(baseRequests, requests);
	const expectedFirst = arm === "steer" ? point + 1 : n + 1;
	const p2 = n > 0 && canonical(baseRequests.slice(0, point)) === canonical(requests.slice(0, point));
	const p3 =
		first === expectedFirst && (arm === "steer" || canonical(baseRequests) === canonical(requests.slice(0, n)));
	const p4 = input.consumedExchange !== null && input.consumedExchange === first && input.consumptionObserved;
	return { first, expectedFirst, p2, p3, p4 };
}

/** P1 to P5 (DESIGN §7), per task and arm, with every trial's evidence. */
export function checks(dir: string, keySource: PiCassetteKeySourceV0 = FIXTURE) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const loaded = trials(dir)
		.filter((entry) => entry.status === "completed" && entry.session !== null)
		.map((entry) => load(dir, entry, keySource));
	const out: Record<string, unknown> = {};
	let violations = 0;
	for (const task of run.spec.tasks.map((entry) => entry.id)) {
		const base = loaded.filter((entry) => entry.trial.task === task && entry.trial.condition === "base");
		const reference = base[0];
		const baseRequestsEqual = base.every((entry) => canonical(entry.requests) === canonical(reference?.requests));
		const baseLayersEqual = base.every((entry) =>
			Object.keys(entry.layers).every((name) => entry.layers[name] === reference?.layers[name]),
		);
		const n = reference?.requests.length ?? 0;
		const p1 = {
			status: base.length > 0 && baseRequestsEqual && baseLayersEqual ? "PASS" : "FAIL",
			trials: base.length,
			requestsEqual: baseRequestsEqual,
			layersEqual: baseLayersEqual,
			n,
		};
		if (p1.status === "FAIL") violations += 1;
		const arms: Record<string, unknown> = {};
		for (const arm of ["steer", "queue"] as const) {
			const members = loaded.filter((entry) => entry.trial.task === task && entry.trial.condition === arm);
			const intervention = run.spec.conditions.find((entry) => entry.id === arm)?.interventions?.[task];
			const point = intervention?.after.exchange ?? STEER_POINT.exchange;
			const perTrial = members.map((entry) => {
				const consumed = entry.records.find((event) => event.kind === "intervention.consumed")?.payload as
					| { exchange?: number }
					| undefined;
				const consequence = entry.records.find((event) => event.kind === "intervention.consequence")?.payload as
					| { consumption: { status: string }; effect: unknown }
					| undefined;
				const { first, expectedFirst, p2, p3, p4 } = judgeSteeredTrial({
					arm,
					point,
					baseRequests: reference?.requests ?? [],
					requests: entry.requests,
					consumedExchange: consumed?.exchange ?? null,
					consumptionObserved: consequence?.consumption.status === "observed",
				});
				if (!p2 || !p3 || !p4) violations += 1;
				return {
					trial: label(entry.trial),
					requests: entry.requests.length,
					firstDivergence: first,
					expectedFirstDivergence: expectedFirst,
					P2: p2 ? "PASS" : "FAIL (bug: diverged before the point)",
					P3: p3 ? "PASS" : "FAIL",
					P4: p4 ? "PASS" : "FAIL (manipulation failure)",
					consumedExchange: consumed?.exchange ?? null,
					complied: complied(entry.requests, task),
					success: entry.trial.check.ran ? entry.trial.check.passed : null,
					outcome: entry.outcome,
					layersAgainstBase: Object.fromEntries(
						Object.keys(entry.layers).map((name) => [
							name,
							entry.layers[name] === reference?.layers[name] ? "EXACT" : "DIVERGED",
						]),
					),
					effect: consequence?.effect ?? null,
				};
			});
			const count = (predicate: (entry: (typeof perTrial)[number]) => boolean) => perTrial.filter(predicate).length;
			const modal = (name: string) => {
				const counts = new Map<string, number>();
				for (const entry of members) counts.set(entry.layers[name]!, (counts.get(entry.layers[name]!) ?? 0) + 1);
				return wilson95V0(Math.max(0, ...counts.values()), members.length);
			};
			arms[arm] = {
				trials: members.length,
				P2: { passed: count((entry) => entry.P2 === "PASS"), of: perTrial.length },
				P3: { passed: count((entry) => entry.P3 === "PASS"), of: perTrial.length },
				P4: { passed: count((entry) => entry.P4 === "PASS"), of: perTrial.length },
				P5: {
					compliance: wilson95V0(
						count((entry) => entry.complied),
						perTrial.length,
					),
					success: wilson95V0(
						count((entry) => entry.success === true),
						perTrial.length,
					),
					outcomes: Object.fromEntries(
						[...new Set(perTrial.map((entry) => entry.outcome))].map((kind) => [
							kind,
							count((entry) => entry.outcome === kind),
						]),
					),
					layersExactAgainstBase: Object.fromEntries(
						["lifecycle", "toolCalls", "toolResults", "outcome"].map((name) => [
							name,
							count((entry) => (entry.layersAgainstBase as Record<string, string>)[name] === "EXACT"),
						]),
					),
					withinArmModalAgreement: Object.fromEntries(
						["lifecycle", "toolCalls", "toolResults", "outcome"].map((name) => [name, modal(name)]),
					),
				},
				perTrial,
			};
		}
		const baseSuccess = wilson95V0(
			base.filter((entry) => entry.trial.check.ran && entry.trial.check.passed).length,
			base.length,
		);
		out[task] = {
			P1: p1,
			base: {
				trials: base.length,
				P5: { success: baseSuccess, outcomes: [...new Set(base.map((entry) => entry.outcome))] },
			},
			...arms,
		};
	}
	return {
		study:
			violations === 0
				? "HOLDS (P1 to P4 hold in every trial)"
				: `DOES NOT HOLD: ${violations} violation(s), reported per trial`,
		violations,
		tasks: out,
	};
}

/**
 * POST-HOC (not pre-registered; RESULTS.md, "the path"): a replication run is compared with an original run of the same
 * spec, trial by trial: whether each trial's requests (tool-call ids normalized) are equal to the original's, and
 * whether the steered trials complied. A replication of the same spec runs at the same scratch-root path, so equal
 * requests show that the trajectory is a reproducible function of the whole prompt, the path included.
 */
export function replication(original: string, replicate: string, keySource: PiCassetteKeySourceV0 = FIXTURE) {
	const run = readEndoExperimentRunRecordFileV0(replicate);
	const originalRun = readEndoExperimentRunRecordFileV0(original);
	const cells: Record<string, unknown> = {};
	for (const trial of trials(replicate).filter((entry) => entry.status === "completed" && entry.session !== null)) {
		const originalTrial = trials(original).find(
			(entry) =>
				entry.task === trial.task &&
				entry.condition === trial.condition &&
				entry.trial === trial.trial &&
				entry.status === "completed",
		);
		const mine = load(replicate, trial, keySource);
		const theirs = originalTrial === undefined ? null : load(original, originalTrial, keySource);
		const key = `${trial.task}/${trial.condition}`;
		cells[key] ??= { trials: 0, requestsEqualToOriginal: 0, complied: 0, originalComplied: 0 };
		const cell = cells[key] as Record<string, number>;
		cell.trials! += 1;
		if (theirs !== null && canonical(mine.requests) === canonical(theirs.requests))
			cell.requestsEqualToOriginal! += 1;
		if (complied(mine.requests, trial.task)) cell.complied! += 1;
		if (theirs !== null && complied(theirs.requests, trial.task)) cell.originalComplied! += 1;
	}
	return {
		postHoc: "not pre-registered",
		original: {
			dir: "the original run of the same spec",
			scratchRoot: originalRun.scratchRoot,
			seed: originalRun.seed,
		},
		replicate: { scratchRoot: run.scratchRoot, seed: run.seed },
		cells,
	};
}

/** §10: each steered cassette replayed `times` times (3 immediate, the rest as-recorded), each baseline once. */
export async function replays(cassettes: string, pi: string, steeredTimes = 5) {
	const out: Record<string, unknown> = {};
	for (const name of readdirSync(cassettes)
		.filter((entry) => statSync(join(cassettes, entry)).isDirectory())
		.sort()) {
		const steered = !name.endsWith("--base");
		const runs = [];
		const timings: ("immediate" | "as-recorded")[] = steered
			? (["immediate", "immediate", "immediate", "as-recorded", "as-recorded"].slice(0, steeredTimes) as (
					| "immediate"
					| "as-recorded"
				)[])
			: ["immediate"];
		for (const timing of timings) {
			const scratch = mkdtempSync(join(tmpdir(), "endo-steering-replay-"));
			try {
				const store = materializePiCassetteFixtureV0(join(cassettes, name), join(scratch, "store"));
				const report = await replayPiCassetteSessionV0({
					store,
					out: join(scratch, "replay"),
					pi,
					timing,
					keySource: FIXTURE,
					timeoutMs: 600_000,
				});
				const layers = report.comparison.layers;
				runs.push({
					timing,
					lifecycle: layers.lifecycle.status,
					toolCalls: layers.toolCalls.status,
					toolResults: layers.toolResults.status,
					outcome: layers.outcome.status,
					served: report.served,
					misses: report.misses,
					unserved: report.unserved,
					interventions: report.interventions,
					flags: report.comparison.flags.map((flag) => flag.kind),
				});
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		}
		const exact = runs.every(
			(entry) =>
				entry.lifecycle === "EXACT" &&
				entry.toolCalls === "EXACT" &&
				entry.toolResults === "EXACT" &&
				entry.outcome === "EXACT" &&
				entry.misses === 0 &&
				entry.unserved === 0,
		);
		out[name] = { replays: runs.length, allExact: exact, runs };
	}
	return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, dir] = process.argv.slice(2);
	const option = (name: string) => {
		const index = process.argv.indexOf(name);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const run = async () => {
		if (command === "estimate") return estimate(dir!);
		if (command === "manipulation") return manipulation(dir!);
		if (command === "checks") return checks(dir!);
		if (command === "spotcheck") return steeredSpotcheck(dir!, option("--pi")!, option("--trials")?.split(",") ?? []);
		if (command === "replays") return replays(dir!, option("--pi")!);
		if (command === "replication") return replication(dir!, option("--against")!);
		if (command === "sensitivity") return sensitivity(dir!);
		throw new TypeError(
			"usage: analyze.ts estimate|manipulation|checks|spotcheck|replays|sensitivity <dir> [--pi path]",
		);
	};
	run().then(
		(value) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`),
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
