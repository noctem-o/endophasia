// Explicit loss accounting for the DSH native import (DSH_NATIVE_MAPPING_VERSION_V0), as data, in the style of adapters/acp/loss.ts.
// One entry per row of the study's fidelity matrix (research/dsh-native/matrix.json), which covers each of the 62 persisted DSH event
// types exactly once; tests tie the two together, and the table to the pinned vocabulary.
//
// Verdicts (the whole vocabulary, as in the ACP table; the verdict is about the Endophasia target, not about DSH):
//   EXACT            the target preserves every semantic fact it needs.
//   QUALIFIED        representable, but with a different evidence basis or scope; the qualification travels with the record.
//   LOSSY            a valid projection exists; known source information is intentionally omitted or collapsed.
//   UNREPRESENTABLE  mapping it would invent semantics or claim more than the source supports; nothing is emitted.
//
// `status` says what this importer does: "implemented" (mapped as described), "recorded-only" (the event is kept as a structural
// `dsh.record` with its family and a keyed digest, and not interpreted) or "not-importable" (a cold reader cannot see it).

import { DSH_NATIVE_MAPPING_VERSION_V0 } from "./mapping-version.ts";

export const DSH_NATIVE_LOSS_VERDICTS_V0 = ["EXACT", "QUALIFIED", "LOSSY", "UNREPRESENTABLE"] as const;
export type DshNativeLossVerdictV0 = (typeof DSH_NATIVE_LOSS_VERDICTS_V0)[number];

export const DSH_NATIVE_LOSS_ACCOUNTING_VERSION_V0 = "endo.dsh-native-loss-accounting.v0";

export type DshNativeLossStatusV0 = "implemented" | "recorded-only" | "not-importable";

export interface DshNativeLossEntryV0 {
	/** The id of the matrix row this entry accounts for. */
	readonly id: string;
	/** The DSH persisted event types the row covers (empty for a cross-cutting capability). */
	readonly dshEventTypes: readonly string[];
	/** The Endophasia events or contracts the semantic is projected into. */
	readonly target: string;
	readonly verdict: DshNativeLossVerdictV0;
	readonly status: DshNativeLossStatusV0;
	/** What is not carried, and every qualification on what is. */
	readonly unprojected: string;
}

export const DSH_NATIVE_LOSS_ENTRIES_V0: readonly DshNativeLossEntryV0[] = Object.freeze([
	{
		id: "run-structure",
		dshEventTypes: ["turn/start", "turn/end"],
		target:
			"dsh.turn-started / dsh.turn-ended → lifecycle.run-started / run-completed / run-failed / run-aborted / run-unclassified",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"A DSH turn is mapped to an Endophasia RUN (qualified, not identity). completed → run-completed; aborted → run-aborted (cause kind kept, stopRequested only for a user cause); error → run-failed (code, status, keyed message digest); blocked, max-tokens → run-unclassified naming the reported kind; interrupted, forked → run-unclassified with provenance dsh-written-closer, never lifecycle.interrupted. Not carried: the time the prompt was submitted.",
	},
	{
		id: "step-structure",
		dshEventTypes: ["step/start", "step/end"],
		target: "dsh.step-started / dsh.step-ended → lifecycle.turn-started / turn-completed",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"A DSH step is mapped to an Endophasia TURN. stopReason is the provider stop reason of the step's assistant message, else UNAVAILABLE. A final step/end waits for the next row; one followed by an interrupted/forked turn end may be recovery-written and produces no turn-completed. The closing run records the final step's committed output; a genuine end with the same shape is deliberately under-claimed.",
	},
	{
		id: "user-system-messages",
		dshEventTypes: ["user/message", "developer/message", "system/message"],
		target: "dsh.message-recorded (role, source kind, part count, text byte count)",
		verdict: "LOSSY",
		status: "implemented",
		unprojected: "All text. Only structure and a byte count survive; the row's keyed digest commits to the rest.",
	},
	{
		id: "assistant-message",
		dshEventTypes: ["assistant/message"],
		target:
			"dsh.assistant-recorded (provider, model, stop reason, block kinds, usage categories reported, interrupted marker); trajectory usage layer",
		verdict: "LOSSY",
		status: "implemented",
		unprojected:
			"Reasoning and message text, the provider response id, chunk timing and the embedded stream. Usage reaches the trajectory only when input, output, cacheRead, cacheWrite and totalTokens were all reported on every assistant message of a run; otherwise UNAVAILABLE naming the missing categories (the partial counts stay in the recorded event).",
	},
	{
		id: "attempts-retries",
		dshEventTypes: ["assistant/attempt", "llm/retry", "llm/retry-started"],
		target: "dsh.attempt-recorded / dsh.retry-recorded / dsh.retry-started",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"The failed attempt's stream and its failure message (digest and length only). DSH-specific kinds are used on purpose: the Pi retry.* kinds carry Pi's auto-retry semantics. Attempt usage is not recorded by DSH.",
	},
	{
		id: "tools",
		dshEventTypes: ["tool/call", "tool/result", "tool/ptc-dispatch", "tool/ptc-dispatch-start"],
		target: "dsh.tool-requested / dsh.tool-result-recorded → trajectory toolCalls and toolResults",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"Tool START and duration (DSH records none); arguments and results (keyed digests only); tool-private meta (presence flag only). A request is NOT tool.started.",
	},
	{
		id: "request-config",
		dshEventTypes: [
			"request/header",
			"request/context",
			"model/selection",
			"agent-preset/selected",
			"subagent/model-selection-policy",
		],
		target:
			"dsh.request-config-recorded / dsh.request-route-recorded; model/selection, agent-preset/selected and subagent/model-selection-policy as dsh.record",
		verdict: "LOSSY",
		status: "implemented",
		unprojected:
			"Tool schemas and call configuration beyond provider, model, tool count and tool names (their keyed digest is kept).",
	},
	{
		id: "authority",
		dshEventTypes: ["approval/asked", "approval/decided", "approval/policy", "permission/preset", "sandbox/mode"],
		target: "dsh.authority-recorded (source class runtime-fact)",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"The approval reason text (length only). These are DSH's records of ITS authority state, never an Endophasia decision.",
	},
	{
		id: "ancestry",
		dshEventTypes: ["session/end-seed", "subagent/descriptor", "subagent/catalog"],
		target: "dsh.session-imported (parent coordinate, cut, depth, origin) and dsh.seed-boundary",
		verdict: "LOSSY",
		status: "implemented",
		unprojected: "The inherited prefix (not copied) and any cross-session order.",
	},
	{
		id: "compaction",
		dshEventTypes: ["compaction/start", "compaction/summary", "compaction/end", "compaction/prune", "image/offload"],
		target: "dsh.record (family and keyed digest of the payload)",
		verdict: "LOSSY",
		status: "recorded-only",
		unprojected:
			"Everything about the compaction: shadowed seqs, summary and its model. Deliberately NOT mapped to lifecycle.compacted (the DSH fields do not fit its firstKeptEntryId/tokensBefore honestly).",
	},
	{
		id: "orchestration",
		dshEventTypes: [
			"team/member",
			"team/task",
			"team/message/queued",
			"team/message/delivered",
			"tool-workflow/run-start",
			"tool-workflow/run-end",
			"tool-workflow/agent-start",
			"tool-workflow/agent-end",
			"job/registered",
			"job/settled",
			"hook/invoked",
			"hook/result",
		],
		target: "dsh.record (family and keyed digest of the payload)",
		verdict: "LOSSY",
		status: "recorded-only",
		unprojected: "Teams, workflows, jobs and hooks are counted and named, never interpreted.",
	},
	{
		id: "interaction",
		dshEventTypes: [
			"command/run",
			"command/done",
			"agent/inbox/spliced",
			"goal/change",
			"plan/mode",
			"todo/write",
			"schedule/change",
			"feedback/message-put",
			"feedback/message-delete",
			"feedback/record",
		],
		target: "dsh.record (family and keyed digest of the payload)",
		verdict: "LOSSY",
		status: "recorded-only",
		unprojected: "Commands, goals, plans, todos, feedback: their existence and order only.",
	},
	{
		id: "workspace",
		dshEventTypes: ["working-directory/change", "workspace/changes", "deliverables/presented"],
		target: "dsh.record (family and keyed digest of the payload)",
		verdict: "LOSSY",
		status: "recorded-only",
		unprojected: "Paths and diffs.",
	},
	{
		id: "auxiliary",
		dshEventTypes: [
			"session/title",
			"session/title-llm-request",
			"web/deepseek-search-llm-request",
			"session-log-deepseek/delivery-accepted",
		],
		target: "dsh.record (family and keyed digest of the payload)",
		verdict: "LOSSY",
		status: "recorded-only",
		unprojected:
			"Titles and auxiliary-call records are not interpreted; a record that DSH uploaded a log suffix is kept as a record.",
	},
	{
		id: "envelope",
		dshEventTypes: [],
		target: "payload.source {dshSeq, type, reportedTimeMs}; producer sequence is the importer's own",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected: "DSH time is carried as reported; it is not Endophasia's observation time (at is the import time).",
	},
	{
		id: "live-only",
		dshEventTypes: [],
		target: "none (a cold reader cannot see transient frames, agent/error or waterfall hooks)",
		verdict: "UNREPRESENTABLE",
		status: "not-importable",
		unprojected: "Everything live-only.",
	},
	{
		id: "restored-history",
		dshEventTypes: [],
		target: "rows are read from the log whole; DSH-written closers are flagged",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected: "Whether a row was announced live (irrelevant to a cold reader).",
	},
	{
		id: "durability",
		dshEventTypes: [],
		target: "tail reporting (torn frame, torn row); never repaired",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected: "Anything not yet flushed; a torn tail's rows are dropped and reported.",
	},
	{
		id: "configuration-changes",
		dshEventTypes: [],
		target: "none beyond request-config snapshots",
		verdict: "LOSSY",
		status: "not-importable",
		unprojected: "Plugin composition, versions and configuration.",
	},
	{
		id: "provider-identity",
		dshEventTypes: [],
		target: "dsh.assistant-recorded provider and model; trajectory reportedModels",
		verdict: "QUALIFIED",
		status: "implemented",
		unprojected:
			"The provider response id and the identity behind a model alias; provider and model are reported, never verified.",
	},
] as const);

export const DSH_NATIVE_LOSS_ACCOUNTING_V0 = Object.freeze({
	version: DSH_NATIVE_LOSS_ACCOUNTING_VERSION_V0,
	mapping: DSH_NATIVE_MAPPING_VERSION_V0,
	entries: DSH_NATIVE_LOSS_ENTRIES_V0,
});

export function dshNativeLossEntryV0(id: string): DshNativeLossEntryV0 | undefined {
	return DSH_NATIVE_LOSS_ENTRIES_V0.find((entry) => entry.id === id);
}

const FAMILY_BY_TYPE = new Map<string, string>(
	DSH_NATIVE_LOSS_ENTRIES_V0.flatMap((entry) => entry.dshEventTypes.map((type) => [type, entry.id] as const)),
);

/** The accounting row (family) of a DSH event type, or undefined for a type outside the pinned vocabulary. */
export function dshFamilyOfEventTypeV0(type: string): string | undefined {
	return FAMILY_BY_TYPE.get(type);
}
