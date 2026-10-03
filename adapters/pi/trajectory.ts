// The Pi trajectory projection: one recorded Pi session in, one `endo.trajectory.v0` out (protocol/trajectory.ts).
//
// A pure, read-only reduction of the events one attachment recorded for one session, in store order. The same events
// always give the same trajectory, byte for byte. What each layer reads:
//
// | Layer     | Read from                                                                                         |
// | :---      | :---                                                                                              |
// | lifecycle | the stored `lifecycle.*` stream (adapters/pi/lifecycle.ts), reduced to kind and run facts         |
// | tools     | live `tool.started` / `tool.finished`, paired by Pi's toolCallId (the id itself is not kept)      |
// | outcome   | the lifecycle stream's run endings and interruptions                                               |
// | usage     | live assistant `message.completed` usage, summed per run (what Pi reported)                       |
// | timing    | wall time per run from the lifecycle events' `at`: the observer's clock, not Pi's                 |
//
// Usage and tools come from Pi's live stream only, never from the durable entries a catch-up re-reads: a catch-up
// after a reconnect re-observes entries whose usage the live stream already reported, so counting entries would count
// a message twice. The cost is that a message completed while no observer was attached has no usage in the trajectory;
// the interruption that caused the gap is in the lifecycle layer.
//
// Excluded on purpose, because they describe the recording rather than the run: event ids, process instances, Pi's
// session and entry ids, tool call ids, timestamps, paths and store recovery reports.

import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	type EndoReportedV0,
	endoReportedV0,
	endoUnavailableV0,
	isEndoLifecycleKindV0,
} from "../../protocol/session-lifecycle.ts";
import type {
	EndoTrajectoryAttachmentV0,
	EndoTrajectoryKeyedDigestV0,
	EndoTrajectoryLifecycleEntryV0,
	EndoTrajectoryOutcomeEntryV0,
	EndoTrajectoryOutcomeKindV0,
	EndoTrajectoryTimingEntryV0,
	EndoTrajectoryTokensV0,
	EndoTrajectoryToolEntryV0,
	EndoTrajectoryUsageEntryV0,
	EndoTrajectoryV0,
} from "../../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { ENDO_DIGEST_KEY_ID_PATTERN_V0 } from "../../runtime/contracts/keyed-digest.ts";
import { sealEndoTrajectoryV0 } from "../../runtime/contracts/trajectory.ts";
import { PI_LIFECYCLE_PRODUCER_PREFIX_V0, PI_RECORDING_PRODUCER_PREFIX_V0 } from "./lifecycle.ts";
import { piEndoSessionIdV0 } from "./mapping.ts";

/** The projector's version: bump it when what a layer reads or keeps changes. */
export const PI_TRAJECTORY_PROJECTION_V0 = "pi-trajectory.1";

export interface PiTrajectoryOptionsV0 {
	/** The store as the caller names it (recorded in `source.store`). */
	readonly store: string;
	/** An endo session coordinate (`endo.session.pi.…`) or the Pi session id. */
	readonly session: string;
	/** The attachment whose recording to read; required only when several recorded the session. */
	readonly attachment?: string;
}

/** The endo session coordinate a `<session>` argument names: itself when it is one, else the Pi session id's. */
export function piTrajectorySessionV0(session: string): string {
	return session.startsWith("endo.session.") ? session : piEndoSessionIdV0(session);
}

/** The attachments that recorded events for `session` (an endo session coordinate), sorted. */
export function piTrajectoryAttachmentsV0(events: readonly EndoEventV0[], session: string): string[] {
	const found = new Set<string>();
	for (const event of events) {
		if (event.coordinates.sessionId !== session) continue;
		if (event.producer.startsWith(PI_RECORDING_PRODUCER_PREFIX_V0))
			found.add(event.producer.slice(PI_RECORDING_PRODUCER_PREFIX_V0.length));
	}
	return [...found].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A recorded EndoReportedV0<string>, or UNAVAILABLE saying the recording's value was malformed or missing. */
function reportedString(value: unknown): EndoReportedV0<string> {
	if (isRecord(value)) {
		if (value.status === "reported" && typeof value.value === "string") return endoReportedV0(value.value);
		if (value.status === "UNAVAILABLE" && typeof value.reason === "string") return endoUnavailableV0(value.reason);
	}
	return endoUnavailableV0("the recorded lifecycle event carried no well-formed stop reason");
}

function recordedString(value: unknown, missing: string): EndoReportedV0<string> {
	const found = text(value);
	return found === null ? endoUnavailableV0(missing) : endoReportedV0(found);
}

/** The exit facts of an interruption or detach: code, signal, expected. */
function exitFacts(value: unknown): JsonValueV0 {
	if (!isRecord(value)) return null;
	return {
		code: typeof value.code === "number" ? value.code : null,
		signal: typeof value.signal === "string" ? value.signal : null,
		expected: value.expected === true,
	};
}

/** The configured `provider/model` from the attachment's Pi arguments. */
function configuredModel(args: unknown): EndoReportedV0<string> {
	const list = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
	const after = (flag: string): string | null => {
		const index = list.indexOf(flag);
		return index >= 0 && index + 1 < list.length ? list[index + 1]! : null;
	};
	const provider = after("--provider");
	const model = after("--model");
	if (provider === null || model === null)
		return endoUnavailableV0(
			"the attachment passed Pi no --provider and --model; Pi used its own configured default",
		);
	return endoReportedV0(`${provider}/${model}`);
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

/** A recorded usage object (adapters/pi/mapping.ts piUsageV0), or null. */
function usageOf(value: unknown): Record<string, number> | null {
	if (!isRecord(value)) return null;
	const out: Record<string, number> = {};
	for (const field of [...TOKEN_FIELDS, "reasoning", "costTotal"]) {
		const item = value[field];
		if (typeof item === "number" && Number.isFinite(item)) out[field] = item;
	}
	return TOKEN_FIELDS.every((field) => field in out) ? out : null;
}

interface RunState {
	index: number;
	startedAt: string;
	stopRequested: boolean;
	assistantMessages: number;
	usages: Record<string, number>[];
}

const ARGS_NOT_RECORDED =
	"this recording's tool.started carries no keyed argument digest (pi-rpc-mapping.2 and earlier record none, and an attachment without a digest key records none)";

/** A recorded keyed digest (adapters/pi/mapping.ts piToolArgsDigestV0), or null. */
function keyedDigest(value: unknown): EndoTrajectoryKeyedDigestV0 | null {
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

/** A recorded digest-domain record ({ keyId, domain }) from harness.attached, or UNAVAILABLE. */
function digestKeyOf(value: unknown): EndoReportedV0<{ keyId: string; domain: string }> {
	if (
		isRecord(value) &&
		typeof value.keyId === "string" &&
		ENDO_DIGEST_KEY_ID_PATTERN_V0.test(value.keyId) &&
		typeof value.domain === "string"
	)
		return endoReportedV0({ keyId: value.keyId, domain: value.domain });
	return endoUnavailableV0("the attachment recorded no digest domain (recorded before keyed argument digests)");
}

/**
 * Project the trajectory of one recorded session. `events` is the store's content in store order (any other session or
 * producer is skipped); an event id seen twice is read once and counted in `duplicatesIgnored`.
 */
export function projectPiTrajectoryV0(
	events: readonly EndoEventV0[],
	options: PiTrajectoryOptionsV0,
): EndoTrajectoryV0 {
	const session = piTrajectorySessionV0(options.session);
	const attachments = piTrajectoryAttachmentsV0(events, session);
	let attachment = options.attachment;
	if (attachment === undefined) {
		if (attachments.length === 0) throw new TypeError(`no Pi attachment recorded the session ${session}`);
		if (attachments.length > 1)
			throw new TypeError(`several attachments recorded ${session} (${attachments.join(", ")}); name one`);
		attachment = attachments[0]!;
	}
	const recording = `${PI_RECORDING_PRODUCER_PREFIX_V0}${attachment}`;
	const lifecycleProducer = `${PI_LIFECYCLE_PRODUCER_PREFIX_V0}${attachment}`;

	const seen = new Set<string>();
	let duplicatesIgnored = 0;
	const read: EndoEventV0[] = [];
	for (const event of events) {
		if (event.coordinates.sessionId !== session) continue;
		if (event.producer !== recording && event.producer !== lifecycleProducer) continue;
		if (seen.has(event.id)) {
			duplicatesIgnored += 1;
			continue;
		}
		seen.add(event.id);
		read.push(event);
	}
	if (read.length === 0) throw new TypeError(`the attachment ${attachment} recorded nothing for ${session}`);

	const lifecycle: EndoTrajectoryLifecycleEntryV0[] = [];
	const tools: EndoTrajectoryToolEntryV0[] = [];
	const outcomes: EndoTrajectoryOutcomeEntryV0[] = [];
	const usage: EndoTrajectoryUsageEntryV0[] = [];
	const timing: EndoTrajectoryTimingEntryV0[] = [];
	const environment: EndoTrajectoryAttachmentV0[] = [];
	const reportedModels = new Set<string>();
	const pendingTools = new Map<string, number>();
	let runtimeSessionId: EndoReportedV0<string> = endoUnavailableV0("no attachment to a Pi session was recorded");
	let runs = 0;
	let run: RunState | null = null;
	let currentTurn: number | null = null;

	const closeRun = (
		outcome: EndoTrajectoryOutcomeKindV0,
		payload: Record<string, unknown>,
		stopReason: EndoReportedV0<string>,
		cause: JsonValueV0,
		endedAt: string | null,
	): void => {
		if (run === null) return;
		outcomes.push({
			run: run.index,
			outcome,
			turns: count(payload.turns) ?? currentTurn ?? 0,
			stopReason,
			stopRequested: payload.stopRequested === true || run.stopRequested,
			cause,
		});
		const withUsage = run.usages.length;
		let tokens: EndoReportedV0<EndoTrajectoryTokensV0>;
		if (run.assistantMessages === 0) tokens = endoUnavailableV0("no assistant message completed in this run");
		else if (withUsage === 0) tokens = endoUnavailableV0("Pi reported no usage on this run's assistant messages");
		else {
			const sum: Record<string, number> = {};
			for (const field of [...TOKEN_FIELDS, "reasoning", "costTotal"]) {
				if (run.usages.every((item) => field in item))
					sum[field] = run.usages.reduce((total, item) => total + item[field]!, 0);
			}
			tokens = endoReportedV0(sum as unknown as EndoTrajectoryTokensV0);
		}
		usage.push({
			run: run.index,
			assistantMessages: run.assistantMessages,
			withoutUsage: run.assistantMessages - withUsage,
			tokens,
		});
		timing.push({
			run: run.index,
			clock: "observer",
			wallMs:
				endedAt === null
					? endoUnavailableV0(
							outcome === "open"
								? "the recording ends with this run open"
								: "the run was interrupted; no end of it was observed",
						)
					: endoReportedV0(Date.parse(endedAt) - Date.parse(run.startedAt)),
		});
		run = null;
		currentTurn = null;
	};

	for (const event of read) {
		const payload = isRecord(event.payload) ? event.payload : {};
		if (event.producer === lifecycleProducer) {
			const kind = event.kind;
			const entry = (facts: Record<string, JsonValueV0>): void => {
				lifecycle.push({ kind, recognized: true, facts });
			};
			if (!isEndoLifecycleKindV0(kind)) {
				lifecycle.push({
					kind,
					recognized: false,
					facts: { payloadSha256: sha256HexV0(canonicalEndoJsonV0(event.payload)) },
				});
				continue;
			}
			switch (kind) {
				case "lifecycle.session-started":
				case "lifecycle.session-resumed": {
					const id = text(payload.runtimeSessionId);
					if (id !== null) runtimeSessionId = endoReportedV0(id);
					entry({
						runtime: text(payload.runtime),
						...(kind === "lifecycle.session-resumed" ? { previousEnd: text(payload.previousEnd) } : {}),
					});
					break;
				}
				case "lifecycle.run-started":
					entry({});
					runs += 1;
					run = {
						index: runs,
						startedAt: event.at,
						stopRequested: false,
						assistantMessages: 0,
						usages: [],
					};
					currentTurn = null;
					break;
				case "lifecycle.turn-started":
					currentTurn = count(payload.turn);
					entry({ turn: currentTurn });
					break;
				case "lifecycle.turn-completed":
					entry({ turn: count(payload.turn), stopReason: reportedString(payload.stopReason) as JsonValueV0 });
					break;
				case "lifecycle.run-completed": {
					const stopReason = reportedString(payload.stopReason);
					entry({ turns: count(payload.turns), stopReason: stopReason as JsonValueV0 });
					closeRun("completed", payload, stopReason, null, event.at);
					break;
				}
				case "lifecycle.run-failed": {
					const stopReason = reportedString(payload.stopReason);
					const cause = isRecord(payload.cause) ? payload.cause : {};
					const message = isRecord(cause.message) ? cause.message : {};
					const ref = isRecord(message.value) ? message.value : {};
					entry({
						turns: count(payload.turns),
						stopReason: stopReason as JsonValueV0,
						cause: {
							source: text(cause.source),
							classification: message.status === "reported" ? text(ref.classification) : null,
						},
					});
					closeRun("failed", payload, stopReason, (payload.cause ?? null) as JsonValueV0, event.at);
					break;
				}
				case "lifecycle.run-aborted": {
					const stopReason = reportedString(payload.stopReason);
					entry({
						turns: count(payload.turns),
						stopReason: stopReason as JsonValueV0,
						stopRequested: payload.stopRequested === true,
					});
					closeRun("aborted", payload, stopReason, null, event.at);
					break;
				}
				case "lifecycle.run-unclassified":
					entry({ turns: count(payload.turns), reason: text(payload.reason) });
					closeRun(
						"unclassified",
						payload,
						endoUnavailableV0("no assistant stop reason was observed in this run"),
						null,
						event.at,
					);
					break;
				case "lifecycle.stop-requested":
					if (run !== null) (run as RunState).stopRequested = true;
					entry({ runOpen: payload.runOpen === true });
					break;
				case "lifecycle.stop-accepted":
				case "lifecycle.stop-refused":
					entry({ runOpen: payload.runOpen === true });
					break;
				case "lifecycle.interrupted": {
					const cause = text(payload.cause);
					const exit = exitFacts(payload.exit);
					entry({
						cause,
						runOpen: payload.runOpen === true,
						turnOpen: payload.turnOpen === true,
						turns: count(payload.turns),
						stopRequested: payload.stopRequested === true,
						...(exit === null ? {} : { exit }),
					});
					closeRun(
						"interrupted",
						payload,
						endoUnavailableV0("the run was interrupted; Pi reported no outcome"),
						{ cause, ...(exit === null ? {} : { exit }) },
						null,
					);
					break;
				}
				case "lifecycle.detached":
					entry({ expected: payload.expected === true, exit: exitFacts(payload.exit) });
					break;
				case "lifecycle.compacted":
					entry({ reason: text(payload.reason) });
					break;
				case "lifecycle.anomaly":
					entry({ observed: text(payload.observed), problem: text(payload.problem) });
					break;
				case "lifecycle.unrecognized-runtime-event":
					entry({ runtimeEvent: text(payload.runtimeEvent) });
					break;
			}
			continue;
		}

		// The attachment's own recording.
		switch (event.kind) {
			case "harness.attached": {
				const id = text(payload.piSessionId);
				if (id !== null && runtimeSessionId.status === "UNAVAILABLE") runtimeSessionId = endoReportedV0(id);
				environment.push({
					identityDigest: recordedString(payload.identityDigest, "the attachment recorded no identity digest"),
					version: recordedString(payload.version, "Pi reported no version"),
					mapping: recordedString(
						payload.mapping,
						"the attachment recorded no mapping version (pi-rpc-mapping.2 and earlier do not)",
					),
					userConfigurationDigest: recordedString(
						payload.userConfigurationDigest,
						"the attachment recorded no user configuration digest",
					),
					projectConfigurationDigest: recordedString(
						payload.projectConfigurationDigest,
						"the attachment recorded no project configuration digest",
					),
					digestKey: digestKeyOf(payload.digestKey),
					configuredModel: configuredModel(payload.args),
				});
				break;
			}
			case "tool.started": {
				const callId = text(payload.toolCallId);
				const argsDigest = keyedDigest(payload.argsDigest);
				tools.push({
					run: run === null ? null : (run as RunState).index,
					turn: run === null ? null : currentTurn,
					name: recordedString(payload.toolName, "Pi's tool_execution_start carried no tool name"),
					argsDigest: argsDigest === null ? endoUnavailableV0(ARGS_NOT_RECORDED) : endoReportedV0(argsDigest),
					result: endoUnavailableV0("no tool_execution_end was recorded for this call"),
				});
				if (callId !== null) pendingTools.set(callId, tools.length - 1);
				break;
			}
			case "tool.finished": {
				const callId = text(payload.toolCallId);
				const result: EndoReportedV0<"ok" | "error"> =
					typeof payload.isError === "boolean"
						? endoReportedV0(payload.isError ? "error" : "ok")
						: endoUnavailableV0("Pi's tool_execution_end carried no isError");
				const index = callId === null ? undefined : pendingTools.get(callId);
				if (index !== undefined) {
					tools[index] = { ...tools[index]!, result };
					pendingTools.delete(callId!);
				} else {
					tools.push({
						run: run === null ? null : (run as RunState).index,
						turn: run === null ? null : currentTurn,
						name: recordedString(payload.toolName, "Pi's tool_execution_end carried no tool name"),
						argsDigest: endoUnavailableV0("no tool_execution_start was recorded for this call"),
						result,
					});
				}
				break;
			}
			case "message.completed":
				if (run !== null && payload.role === "assistant") {
					const current = run as RunState;
					current.assistantMessages += 1;
					const found = usageOf(payload.usage);
					if (found !== null) current.usages.push(found);
				}
				break;
			case "session.entry-observed": {
				const details = isRecord(payload.details) ? payload.details : {};
				if (payload.entryType === "message" && details.role === "assistant") {
					const provider = text(details.provider);
					const model = text(details.model);
					if (provider !== null && model !== null) reportedModels.add(`${provider}/${model}`);
				}
				break;
			}
		}
	}
	if (run !== null) {
		closeRun("open", {}, endoUnavailableV0("the recording ends with this run open"), null, null);
	}

	const lifecycleRecorded = lifecycle.length > 0;
	const noLifecycle =
		"no lifecycle events were recorded for this session (recorded before the lifecycle fold, or by another attachment)";
	const anyUsage = usage.some((entry) => entry.tokens.status === "reported");
	return sealEndoTrajectoryV0({
		schemaVersion: "endo.trajectory.v0",
		projection: PI_TRAJECTORY_PROJECTION_V0,
		source: {
			session,
			runtime: "pi",
			runtimeSessionId,
			attachment,
			eventCount: read.length,
			duplicatesIgnored,
			eventsSha256: sha256HexV0(canonicalEndoJsonV0(read)),
		},
		environment: { attachments: environment, reportedModels: [...reportedModels].sort() },
		layers: {
			lifecycle: lifecycleRecorded ? { status: "reported", entries: lifecycle } : endoLayerUnavailable(noLifecycle),
			tools:
				environment.length > 0
					? { status: "reported", entries: tools }
					: endoLayerUnavailable("no attachment to the session was recorded, so no tool call was observed"),
			outcome: lifecycleRecorded ? { status: "reported", entries: outcomes } : endoLayerUnavailable(noLifecycle),
			usage: !lifecycleRecorded
				? endoLayerUnavailable(noLifecycle)
				: usage.length > 0 && !anyUsage
					? endoLayerUnavailable("Pi reported no usage on any assistant message of this session")
					: { status: "reported", entries: usage },
			timing: lifecycleRecorded ? { status: "reported", entries: timing } : endoLayerUnavailable(noLifecycle),
		},
		provenance: { store: options.store },
	});
}

function endoLayerUnavailable(reason: string): { status: "UNAVAILABLE"; reason: string } {
	return { status: "UNAVAILABLE", reason };
}
