// The trajectory of one imported DSH session: an existing `endo.trajectory.v1` (protocol/trajectory.ts, unchanged), projected from
// the events the importer stored. Pure: it reads events it is given, nothing else.
//
// Order is by PRODUCER sequence, never by storage order: an import that stopped and resumed interleaves recorded and lifecycle events
// differently from one that did not, and the trajectory must not depend on that.
//
// What the layers claim, and no more:
// - toolCalls are the model's REQUESTS (`dsh.tool-requested`), which is exactly what the layer means ("what the agent chose"); the
//   log says nothing about when, or whether, execution began, so nothing here is a start. toolResults pair by the call id inside the
//   result message.
// - usage reaches the record only when DSH reported all five categories the contract requires on every assistant message of a run;
//   a missing category is UNAVAILABLE, never 0 (the partial counts stay in the recorded events). Real DSH usage lacks cacheWrite.
// - timing is UNAVAILABLE: a DSH time is DSH's own, reported; the import clock is not an observation of the run.
// - the outcome of a run DSH closed after the fact is `unclassified`, with its provenance. It is NOT `interrupted`, which in this
//   record means an interruption Endophasia observed.

import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { type EndoReportedV0, endoReportedV0, endoUnavailableV0 } from "../../protocol/session-lifecycle.ts";
import type {
	EndoTrajectoryAttachmentV0,
	EndoTrajectoryKeyedDigestV0,
	EndoTrajectoryLifecycleEntryV0,
	EndoTrajectoryOutcomeEntryV0,
	EndoTrajectoryOutcomeKindV0,
	EndoTrajectoryTokensV0,
	EndoTrajectoryToolCallEntryV0,
	EndoTrajectoryToolResultEntryV0,
	EndoTrajectoryUsageEntryV0,
	EndoTrajectoryV0,
} from "../../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { ENDO_DIGEST_KEY_ID_PATTERN_V0 } from "../../runtime/contracts/keyed-digest.ts";
import { sealEndoTrajectoryV0 } from "../../runtime/contracts/trajectory.ts";
import {
	DSH_NATIVE_LIFECYCLE_PRODUCER_V0,
	DSH_NATIVE_MAPPING_VERSION_V0,
	DSH_NATIVE_RECORDING_PRODUCER_V0,
	dshEndoSessionIdV0,
	isRecord,
} from "./mapping.ts";

export const DSH_NATIVE_TRAJECTORY_PROJECTION_V0 = "dsh-native-trajectory.1";

export interface DshTrajectoryOptionsV0 {
	/** The DSH session id or its `endo.session.dsh.…` coordinate. */
	session: string;
	/** Where the store is, for `provenance` only (not digested). */
	store: string;
}

const REQUIRED_USAGE = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

const unavailableLayer = (reason: string) => ({ status: "UNAVAILABLE" as const, reason });

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function keyed(value: unknown): EndoTrajectoryKeyedDigestV0 | null {
	if (!isRecord(value) || Object.keys(value).length !== 3) return null;
	const { algorithm, keyId, value: digest } = value;
	return algorithm === "hmac-sha256" &&
		typeof keyId === "string" &&
		ENDO_DIGEST_KEY_ID_PATTERN_V0.test(keyId) &&
		typeof digest === "string" &&
		/^[0-9a-f]{64}$/.test(digest)
		? { algorithm, keyId, value: digest }
		: null;
}

const bySequence = (a: EndoEventV0, b: EndoEventV0): number => a.sequence - b.sequence;

/** Project the trajectory of an imported session from the store's events. Throws when the session was never imported. */
export function projectDshTrajectoryV0(
	events: readonly EndoEventV0[],
	options: DshTrajectoryOptionsV0,
): EndoTrajectoryV0 {
	const session = options.session.startsWith("endo.session.") ? options.session : dshEndoSessionIdV0(options.session);
	const seen = new Set<string>();
	let duplicatesIgnored = 0;
	const recording: EndoEventV0[] = [];
	const lifecycleEvents: EndoEventV0[] = [];
	for (const event of events) {
		if (event.coordinates.sessionId !== session) continue;
		if (event.producer !== DSH_NATIVE_RECORDING_PRODUCER_V0 && event.producer !== DSH_NATIVE_LIFECYCLE_PRODUCER_V0)
			continue;
		if (seen.has(event.id)) {
			duplicatesIgnored += 1;
			continue;
		}
		seen.add(event.id);
		(event.producer === DSH_NATIVE_RECORDING_PRODUCER_V0 ? recording : lifecycleEvents).push(event);
	}
	if (recording.length === 0) throw new TypeError(`no DSH session ${session} was imported`);
	recording.sort(bySequence);
	lifecycleEvents.sort(bySequence);
	const read = [...recording, ...lifecycleEvents];

	// Environment, from the header event and the first recorded request configuration.
	const header = recording.find((event) => event.kind === "dsh.session-imported");
	const headerPayload = header !== undefined && isRecord(header.payload) ? header.payload : {};
	const keyId = text(headerPayload.keyId);
	const configured = recording.find((event) => event.kind === "dsh.request-config-recorded");
	const configuredPayload = configured !== undefined && isRecord(configured.payload) ? configured.payload : {};
	const provider = text(configuredPayload.provider);
	const model = text(configuredPayload.model);
	const attachment: EndoTrajectoryAttachmentV0 = {
		identityDigest: endoUnavailableV0("a DSH Session log carries no runtime identity"),
		version: endoUnavailableV0("a DSH Session log records no writer or runtime version"),
		mapping:
			typeof headerPayload.mapping === "string"
				? endoReportedV0(headerPayload.mapping)
				: endoUnavailableV0("no import header was stored"),
		digestKey:
			keyId !== null && ENDO_DIGEST_KEY_ID_PATTERN_V0.test(keyId)
				? endoReportedV0({ keyId, domain: text(headerPayload.keyDomain) ?? keyId })
				: endoUnavailableV0("the import recorded no digest domain"),
		userConfigurationDigest: endoUnavailableV0("a DSH Session log records no configuration digest"),
		projectConfigurationDigest: endoUnavailableV0("a DSH Session log records no configuration digest"),
		configuredModel:
			provider !== null && model !== null
				? endoReportedV0(`${provider}/${model}`)
				: endoUnavailableV0("no request configuration naming a provider and model was recorded"),
	};

	// Lifecycle layer and outcomes, from the derived lifecycle stream.
	const lifecycle: EndoTrajectoryLifecycleEntryV0[] = [];
	const outcomes: EndoTrajectoryOutcomeEntryV0[] = [];
	let runtimeSessionId: EndoReportedV0<string> = endoUnavailableV0("no session start was derived");
	let runIndex = 0;
	let openRun = false;
	const closeOutcome = (
		payload: Record<string, unknown>,
		outcome: EndoTrajectoryOutcomeKindV0,
		stopReason: EndoReportedV0<string>,
		cause: JsonValueV0,
	): void => {
		outcomes.push({
			run: runIndex,
			outcome,
			turns: num(payload.turns) ?? 0,
			stopReason,
			stopRequested: payload.stopRequested === true,
			cause,
		});
		openRun = false;
	};
	const reportedStop = (value: unknown): EndoReportedV0<string> =>
		isRecord(value) && value.status === "reported" && typeof value.value === "string"
			? endoReportedV0(value.value)
			: endoUnavailableV0(
					isRecord(value) && typeof value.reason === "string" ? value.reason : "DSH reported no stop reason",
				);
	for (const event of lifecycleEvents) {
		const payload = isRecord(event.payload) ? event.payload : {};
		lifecycle.push({ kind: event.kind, recognized: true, facts: payload as { [key: string]: JsonValueV0 } });
		switch (event.kind) {
			case "lifecycle.session-started":
				if (isRecord(payload.runtimeSessionId) && typeof payload.runtimeSessionId.value === "string")
					runtimeSessionId = endoReportedV0(payload.runtimeSessionId.value);
				break;
			case "lifecycle.run-started":
				runIndex += 1;
				openRun = true;
				break;
			case "lifecycle.run-completed":
				closeOutcome(payload, "completed", reportedStop(payload.stopReason), null);
				break;
			case "lifecycle.run-aborted":
				closeOutcome(payload, "aborted", reportedStop(payload.stopReason), {
					abortCause: typeof payload.abortCause === "string" ? payload.abortCause : null,
				});
				break;
			case "lifecycle.run-failed":
				closeOutcome(
					payload,
					"failed",
					endoUnavailableV0("DSH reports a failure as a code and message, not as a stop reason"),
					(payload.cause ?? null) as JsonValueV0,
				);
				break;
			case "lifecycle.run-unclassified":
				closeOutcome(
					payload,
					"unclassified",
					endoUnavailableV0(typeof payload.reason === "string" ? payload.reason : "DSH reported no stop reason"),
					{
						reportedReason: typeof payload.reportedReason === "string" ? payload.reportedReason : null,
						provenance: typeof payload.provenance === "string" ? payload.provenance : null,
					},
				);
				break;
			default:
		}
	}
	if (openRun) {
		outcomes.push({
			run: runIndex,
			outcome: "open",
			turns: 0,
			stopReason: endoUnavailableV0("the imported log ends with this run open"),
			stopRequested: false,
			cause: null,
		});
	}

	// Tool layers and usage, from the recorded rows in producer order.
	const tools: {
		call: EndoTrajectoryToolCallEntryV0;
		callId: string | null;
		result: EndoTrajectoryToolResultEntryV0 | null;
	}[] = [];
	const orphanResults: EndoTrajectoryToolResultEntryV0[] = [];
	const reportedModels = new Set<string>();
	const perRun = new Map<
		number,
		{ messages: number; withUsage: number; usages: Record<string, number>[]; missing: Set<string> }
	>();
	let currentRun = 0;
	for (const event of recording) {
		const payload = isRecord(event.payload) ? event.payload : {};
		switch (event.kind) {
			case "dsh.turn-started":
				currentRun += 1;
				break;
			case "dsh.tool-requested": {
				const digest = keyed(payload.argsDigest);
				const name = text(payload.name);
				tools.push({
					callId: text(payload.callId),
					result: null,
					call: {
						run: currentRun === 0 ? null : currentRun,
						turn: num(payload.step) ?? null,
						name:
							name === null
								? endoUnavailableV0("the request carried no usable tool name")
								: endoReportedV0(name),
						argsDigest:
							digest === null
								? endoUnavailableV0(
										payload.argumentsParsable === false
											? "the model's arguments were not valid JSON, so no digest was made"
											: "the import recorded no argument digest",
									)
								: endoReportedV0(digest),
					},
				});
				break;
			}
			case "dsh.tool-result-recorded": {
				const callId = text(payload.callId);
				const digest = keyed(payload.resultDigest);
				const index = tools.findIndex(
					(tool) => tool.result === null && tool.callId !== null && tool.callId === callId,
				);
				const result: EndoTrajectoryToolResultEntryV0 = {
					run: currentRun === 0 ? null : currentRun,
					turn: num(payload.step) ?? null,
					name:
						index >= 0 ? tools[index]!.call.name : endoUnavailableV0("no request was recorded for this result"),
					status:
						typeof payload.isError === "boolean"
							? endoReportedV0(payload.isError ? "error" : "ok")
							: endoUnavailableV0("the result carried no isError"),
					resultDigest:
						digest === null ? endoUnavailableV0("the import recorded no result digest") : endoReportedV0(digest),
				};
				if (index >= 0) tools[index]!.result = result;
				else orphanResults.push(result);
				break;
			}
			case "dsh.assistant-recorded": {
				const provider = text(payload.provider);
				const model = text(payload.model);
				if (provider !== null && model !== null) reportedModels.add(`${provider}/${model}`);
				const entry = perRun.get(currentRun) ?? {
					messages: 0,
					withUsage: 0,
					usages: [],
					missing: new Set<string>(),
				};
				entry.messages += 1;
				if (isRecord(payload.usage)) {
					entry.withUsage += 1;
					const usage: Record<string, number> = {};
					for (const [field, value] of Object.entries(payload.usage))
						if (num(value) !== null) usage[field] = value as number;
					entry.usages.push(usage);
					for (const field of REQUIRED_USAGE) if (!(field in usage)) entry.missing.add(field);
				} else for (const field of REQUIRED_USAGE) entry.missing.add(field);
				perRun.set(currentRun, entry);
				break;
			}
			default:
		}
	}

	const usage: EndoTrajectoryUsageEntryV0[] = [];
	for (let run = 1; run <= runIndex; run += 1) {
		const entry = perRun.get(run);
		let tokens: EndoReportedV0<EndoTrajectoryTokensV0>;
		if (entry === undefined || entry.messages === 0)
			tokens = endoUnavailableV0("no assistant message was recorded in this run");
		else if (entry.missing.size > 0)
			tokens = endoUnavailableV0(
				`DSH did not report ${[...entry.missing].sort().join(", ")} on every assistant message of this run; a missing category is not 0, so no total is made`,
			);
		else {
			const sum: Record<string, number> = {};
			for (const field of [...REQUIRED_USAGE, "reasoning"]) {
				if (entry.usages.every((item) => field in item))
					sum[field] = entry.usages.reduce((total, item) => total + item[field]!, 0);
			}
			tokens = endoReportedV0(sum as unknown as EndoTrajectoryTokensV0);
		}
		usage.push({
			run,
			assistantMessages: entry?.messages ?? 0,
			withoutUsage: (entry?.messages ?? 0) - (entry?.withUsage ?? 0),
			tokens,
		});
	}
	const anyUsage = usage.some((item) => item.tokens.status === "reported");

	return sealEndoTrajectoryV0({
		schemaVersion: "endo.trajectory.v1",
		projection: DSH_NATIVE_TRAJECTORY_PROJECTION_V0,
		source: {
			session,
			runtime: "dsh",
			runtimeSessionId,
			attachment: "dsh-native-import",
			eventCount: read.length,
			duplicatesIgnored,
			eventsSha256: sha256HexV0(canonicalEndoJsonV0(read)),
		},
		environment: { attachments: [attachment], reportedModels: [...reportedModels].sort() },
		layers: {
			lifecycle: { status: "reported", entries: lifecycle },
			toolCalls: { status: "reported", entries: tools.map((tool) => tool.call) },
			toolResults: {
				status: "reported",
				entries: [
					...tools.map(
						(tool): EndoTrajectoryToolResultEntryV0 =>
							tool.result ?? {
								run: tool.call.run,
								turn: tool.call.turn,
								name: tool.call.name,
								status: endoUnavailableV0("no result was recorded for this request"),
								resultDigest: endoUnavailableV0("no result was recorded for this request"),
							},
					),
					...orphanResults,
				],
			},
			outcome: { status: "reported", entries: outcomes },
			usage: anyUsage
				? { status: "reported", entries: usage }
				: unavailableLayer(
						`DSH did not report all of ${REQUIRED_USAGE.join(", ")} together on the assistant messages of any run (a missing category is not 0); the partial counts are kept in the recorded events`,
					),
			timing: unavailableLayer(
				"DSH times are DSH's own, reported by its log; the import clock is not an observation of the run, so no duration is claimed",
			),
		},
		provenance: { store: options.store },
	});
}

export { DSH_NATIVE_MAPPING_VERSION_V0 };
