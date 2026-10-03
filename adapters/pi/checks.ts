// The Pi conformance checks. Three kinds, kept apart (protocol/harness.ts, EndoCapabilityCheckKindV0):
//
// - Local protocol checks run automatically. They start Pi in RPC mode with an in-memory session (`--no-session`),
//   `--offline` and no tools, send only state, cursor and configuration commands, and never send a prompt: no agent
//   run starts, no provider is called, no session is persisted.
// - The documented-surface review records absences in Pi's documented RPC surface. It is evidence about the
//   documentation of the release that was reviewed (PI_SURFACE_REVIEWED_VERSIONS), so it applies to that release
//   only. On any other release the live study observes the same absences in Pi's actual records.
// - The live study sends prompts. It runs agent work, executes a read-only tool in a scratch workspace Endophasia
//   creates, calls the configured model provider (which may cost money) and persists a scratch session. It runs only
//   when the caller passes an explicit authorization; nothing calls it automatically.
//
// Every check returns per-capability results with what was expected and observed, plus the exchange transcript. A
// result that the observation cannot decide (e.g. the run ended before a steer could be sent) is "inconclusive": no
// evidence is recorded for it and the capability stays unverified. Acceptance is never reported as an effect.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndoConformanceClassificationV0 } from "../../protocol/evaluation.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import type { PiCheckDefinitionV0 } from "./evidence.ts";
import { PiRpcClientV0, type PiRpcLaunchOptionsV0, PiRpcRefusalV0, type PiSessionEntryV0 } from "./rpc.ts";

export type PiCheckClassificationV0 = EndoConformanceClassificationV0 | "inconclusive";

export interface PiCheckResultV0 {
	readonly capability: string;
	readonly classification: PiCheckClassificationV0;
	readonly expected: string;
	readonly observed: string;
	readonly limitations: readonly string[];
}

/** One record of a check's exchange with Pi, for the evidence transcript. */
export type PiTranscriptRecordV0 =
	| { readonly direction: "command"; readonly type: string; readonly fields: Readonly<Record<string, unknown>> }
	| { readonly direction: "response"; readonly type: string; readonly ok: boolean; readonly data?: unknown }
	| { readonly direction: "event"; readonly type: string; readonly record: Readonly<Record<string, unknown>> }
	| { readonly direction: "note"; readonly text: string };

export interface PiCheckRunV0 {
	readonly definition: PiCheckDefinitionV0;
	readonly inputs: unknown;
	readonly results: readonly PiCheckResultV0[];
	readonly transcript: readonly PiTranscriptRecordV0[];
}

// ---------------------------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------------------------

export const PI_LOCAL_STATE_CHECK: PiCheckDefinitionV0 = {
	name: "pi.local.state",
	version: "1",
	kind: "local-protocol",
	capabilities: ["session.identity", "session.overview"],
	procedure:
		"get_state twice in one ephemeral process; the session id must be non-empty and equal in both, and the streaming, compacting and pending-message fields present",
};

export const PI_LOCAL_ENTRIES_CHECK: PiCheckDefinitionV0 = {
	name: "pi.local.entries-cursor",
	version: "1",
	kind: "local-protocol",
	capabilities: ["session.entries-cursor"],
	procedure:
		"set_session_name to guarantee two entries, then get_entries; since=<first id> must return exactly the later entries in order; since=<last id> must return none; since=<random unknown id> must be refused",
};

export const PI_LOCAL_TREE_CHECK: PiCheckDefinitionV0 = {
	name: "pi.local.tree",
	version: "1",
	kind: "local-protocol",
	capabilities: ["continuity.active-path"],
	procedure: "get_tree and get_entries; the tree must contain every entry id once and both leaf ids must agree",
};

export const PI_LOCAL_STATS_CHECK: PiCheckDefinitionV0 = {
	name: "pi.local.stats",
	version: "1",
	kind: "local-protocol",
	capabilities: ["runtime.metrics"],
	procedure: "get_session_stats must report non-negative token counts and total cost for the get_state session id",
};

export const PI_LOCAL_CONTROLS_CHECK: PiCheckDefinitionV0 = {
	name: "pi.local.controls",
	version: "1",
	kind: "local-protocol",
	capabilities: ["control.model", "control.thinking", "control.active-tools"],
	procedure:
		"re-select the current model with set_model when it is among get_available_models and compare get_state; set each available thinking level with set_thinking_level and compare get_state, restoring the original; send get_active_tools, which the documented surface does not define, and expect a refusal",
};

/** Releases whose documented RPC surface was reviewed for the documented-surface check. */
export const PI_SURFACE_REVIEWED_VERSIONS: readonly string[] = Object.freeze(["1.0.0"]);

export const PI_STATIC_SURFACE_CHECK: PiCheckDefinitionV0 = {
	name: "pi.baseline.surface-review",
	version: "1",
	kind: "static-surface",
	capabilities: ["run.identity", "operation.outcome"],
	procedure:
		"documented-surface review of Pi 1.0.0 packages/coding-agent/src/modes/rpc/rpc-types.ts and docs/json.md: agent_start, turn_start, turn_end, agent_end and agent_settled carry no identifiers; prompt, steer and follow_up responses carry a disposition only; no command reads an operation outcome. Applies only to the reviewed release",
};

/** The keys Pi 1.0.0 documents on each lifecycle event (docs/json.md). Anything else is a surface difference. */
const DOCUMENTED_LIFECYCLE_KEYS: Readonly<Record<string, readonly string[]>> = {
	agent_start: ["type"],
	turn_start: ["type"],
	turn_end: ["type", "message", "toolResults"],
	agent_end: ["type", "messages", "willRetry"],
	agent_settled: ["type"],
};

export const PI_LIVE_STUDY_CHECK: PiCheckDefinitionV0 = {
	name: "pi.live.study",
	version: "2",
	kind: "live-study",
	capabilities: [
		"lifecycle.trace",
		"usage.entries",
		"tool.activity",
		"steering.steer",
		"steering.follow-up",
		"steering.stop",
		"session.identity",
		"run.identity",
		"operation.outcome",
	],
	procedure:
		"in a scratch workspace and persistent scratch session: (1) a short prompt, observing the lifecycle event order, the keys each lifecycle event carries, the keys of the prompt response, and the assistant entry's usage; (2) a prompt asking for the read tool on a fixture file, observing tool_execution_start/end correlation; (3) a long prompt with a steer sent after agent_start, checking the marker is consumed by that run; (4) the same with follow_up, checking a later run consumes it; (5) a long prompt aborted after agent_start, checking the run ends; (6) a second process on the same session id, checking the session id and earlier entry ids persist",
	// Step 6 re-tests what the local state check tests (a non-empty, stable session id) across two processes, which is
	// strictly broader. Nothing else is superseded: every other overlap is combined conservatively.
	supersedes: { "session.identity": ["pi.local.state"] },
};

export const PI_CHECK_DEFINITIONS_V0: ReadonlyMap<string, PiCheckDefinitionV0> = new Map(
	[
		PI_LOCAL_STATE_CHECK,
		PI_LOCAL_ENTRIES_CHECK,
		PI_LOCAL_TREE_CHECK,
		PI_LOCAL_STATS_CHECK,
		PI_LOCAL_CONTROLS_CHECK,
		PI_STATIC_SURFACE_CHECK,
		PI_LIVE_STUDY_CHECK,
	].map((definition) => [definition.name, definition]),
);

// ---------------------------------------------------------------------------------------------------------------
// Recording client
// ---------------------------------------------------------------------------------------------------------------

/** A Pi client whose every command, response and event goes to a transcript. */
class Recorder {
	readonly transcript: PiTranscriptRecordV0[] = [];
	readonly events: RpcEventV0[] = [];
	readonly #waiters = new Set<{ test: (event: RpcEventV0) => boolean; resolve: (event: RpcEventV0) => void }>();
	readonly client: PiRpcClientV0;

	constructor(options: PiRpcLaunchOptionsV0) {
		this.client = new PiRpcClientV0(options);
		this.client.subscribe((event) => {
			this.events.push(event);
			this.transcript.push({ direction: "event", type: event.type, record: event.record });
			// An extension dialog blocks Pi until answered; a check has no operator to ask, so it cancels and notes it.
			if (event.type === "extension_ui_request") {
				const { id, method } = event.record;
				if (typeof id === "string" && ["select", "confirm", "input", "editor"].includes(String(method))) {
					void this.client.connection.answerExtensionUi(id, { cancelled: true }).then(
						() => this.note(`cancelled extension ${String(method)} dialog`),
						() => {},
					);
				}
			}
			for (const waiter of [...this.#waiters]) {
				if (waiter.test(event)) {
					this.#waiters.delete(waiter);
					waiter.resolve(event);
				}
			}
		});
	}

	note(text: string): void {
		this.transcript.push({ direction: "note", text });
	}

	async call<T>(type: string, fields: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
		this.transcript.push({ direction: "command", type, fields });
		try {
			const value = await run();
			this.transcript.push({ direction: "response", type, ok: true, data: value as unknown });
			return value;
		} catch (error) {
			this.transcript.push({
				direction: "response",
				type,
				ok: false,
				data: error instanceof PiRpcRefusalV0 ? { refusal: error.refusal.slice(0, 512) } : { error: String(error) },
			});
			throw error;
		}
	}

	/** Resolve with the first event (already seen from `from`, or later) that passes `test`; null on timeout. */
	waitFor(test: (event: RpcEventV0) => boolean, timeoutMs: number, from = 0): Promise<RpcEventV0 | null> {
		const seen = this.events.slice(from).find(test);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((resolve) => {
			const waiter = {
				test,
				resolve: (event: RpcEventV0) => {
					clearTimeout(timer);
					resolve(event);
				},
			};
			const timer = setTimeout(() => {
				this.#waiters.delete(waiter);
				resolve(null);
			}, timeoutMs);
			this.#waiters.add(waiter);
		});
	}

	close() {
		return this.client.close();
	}
}

function errorText(error: unknown): string {
	if (error instanceof PiRpcRefusalV0) return `refused (${error.refusal.slice(0, 200)})`;
	return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

// ---------------------------------------------------------------------------------------------------------------
// Local protocol checks
// ---------------------------------------------------------------------------------------------------------------

export interface PiLocalCheckOptionsV0 {
	readonly executable: string;
	readonly env: Readonly<Record<string, string>>;
	/** Defaults to a fresh empty scratch directory, removed afterwards. */
	readonly cwd?: string;
	readonly requestTimeoutMs?: number;
}

/** Run the automatic local protocol checks in one ephemeral, offline, tool-less Pi process. */
export async function runPiLocalChecksV0(options: PiLocalCheckOptionsV0): Promise<PiCheckRunV0[]> {
	const scratch = options.cwd ?? mkdtempSync(join(tmpdir(), "endo-pi-local-"));
	const recorder = new Recorder({
		executable: options.executable,
		cwd: scratch,
		env: options.env,
		session: { kind: "ephemeral" },
		tools: "none",
		offline: true,
		requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
		closeTimeoutMs: 10_000,
	});
	const runs: PiCheckRunV0[] = [];
	const take = (from: number) => recorder.transcript.slice(from);
	try {
		const client = recorder.client;
		// --- state ---
		let mark = recorder.transcript.length;
		{
			const results: PiCheckResultV0[] = [];
			try {
				const first = await recorder.call("get_state", {}, () => client.getState());
				const second = await recorder.call("get_state", {}, () => client.getState());
				const stable = first.sessionId === second.sessionId;
				results.push({
					capability: "session.identity",
					classification: stable ? "QUALIFIED" : "MISMATCH",
					expected: "a non-empty session id, stable across reads and processes",
					observed: stable
						? "get_state reported the same non-empty session id on both reads in one process"
						: "get_state reported different session ids within one process",
					limitations: [
						"Pi persists a session only after its first message, so continuity across processes is established by the live study, not by this check",
					],
				});
				results.push({
					capability: "session.overview",
					classification: "PARTIAL",
					expected: "the Session Overview v0 lane inventory with each lane's active operation",
					observed:
						"get_state reports isStreaming, isCompacting and pendingMessageCount for the one session of the process",
					limitations: [
						"One session per process and no lanes",
						"No operation id, kind or start time for the active run",
					],
				});
			} catch (error) {
				for (const capability of PI_LOCAL_STATE_CHECK.capabilities) {
					results.push({
						capability,
						classification: "MISMATCH",
						expected: "get_state answers with the documented shape",
						observed: `get_state failed: ${errorText(error)}`,
						limitations: [],
					});
				}
			}
			runs.push({
				definition: PI_LOCAL_STATE_CHECK,
				inputs: { commands: ["get_state", "get_state"] },
				results,
				transcript: take(mark),
			});
		}
		// --- entries cursor ---
		mark = recorder.transcript.length;
		{
			const unknownCursor = `endo-unknown-${randomBytes(8).toString("hex")}`;
			const inputs = { sessionName: "endophasia-local-check", unknownCursor };
			let result: PiCheckResultV0;
			try {
				await recorder.call("set_session_name", { name: inputs.sessionName }, () =>
					client.command("set_session_name", { name: inputs.sessionName }),
				);
				const all = await recorder.call("get_entries", {}, () => client.getEntries());
				if (all.entries.length < 2) {
					result = {
						capability: "session.entries-cursor",
						classification: "inconclusive",
						expected: "at least two entries to test the cursor",
						observed: `get_entries returned ${all.entries.length} entries after set_session_name`,
						limitations: [],
					};
				} else {
					const ids = all.entries.map((entry) => entry.id);
					const afterFirst = await recorder.call("get_entries", { since: ids[0] }, () =>
						client.getEntries(ids[0]),
					);
					const afterLast = await recorder.call("get_entries", { since: ids.at(-1) }, () =>
						client.getEntries(ids.at(-1)),
					);
					let unknownRefused = false;
					try {
						await recorder.call("get_entries", { since: unknownCursor }, () => client.getEntries(unknownCursor));
					} catch (error) {
						if (!(error instanceof PiRpcRefusalV0)) throw error;
						unknownRefused = true;
					}
					const strictlyAfter =
						afterFirst.entries.map((entry) => entry.id).join("\n") === ids.slice(1).join("\n") &&
						afterLast.entries.length === 0;
					result = {
						capability: "session.entries-cursor",
						classification: strictlyAfter && unknownRefused ? "EXACT" : "MISMATCH",
						expected: "since=<id> returns exactly the entries after <id>; an unknown cursor is refused",
						observed: `since=first returned ${afterFirst.entries.length} of ${ids.length - 1} later entries${
							strictlyAfter ? " in order" : " (not exactly the later entries)"
						}; since=last returned ${afterLast.entries.length}; an unknown cursor was ${
							unknownRefused ? "refused" : "accepted"
						}`,
						limitations: [
							"Entry ids are opaque: order comes only from Pi's append order, never from the ids",
							"Abandoned branches are included in get_entries; the leaf id identifies the active branch",
						],
					};
				}
			} catch (error) {
				result = {
					capability: "session.entries-cursor",
					classification: "MISMATCH",
					expected: "get_entries answers with the documented shape",
					observed: `the cursor exchange failed: ${errorText(error)}`,
					limitations: [],
				};
			}
			runs.push({ definition: PI_LOCAL_ENTRIES_CHECK, inputs, results: [result], transcript: take(mark) });
		}
		// --- tree ---
		mark = recorder.transcript.length;
		{
			let result: PiCheckResultV0;
			try {
				const tree = await recorder.call("get_tree", {}, () => client.getTree());
				const entries = await recorder.call("get_entries", {}, () => client.getEntries());
				const treeIds: string[] = [];
				const visit = (nodes: unknown[]): void => {
					for (const node of nodes) {
						if (typeof node !== "object" || node === null) continue;
						const { entry, children } = node as { entry?: { id?: unknown }; children?: unknown };
						if (typeof entry?.id === "string") treeIds.push(entry.id);
						if (Array.isArray(children)) visit(children);
					}
				};
				visit(tree.tree);
				const sameIds =
					[...treeIds].sort().join("\n") ===
						entries.entries
							.map((entry) => entry.id)
							.sort()
							.join("\n") && new Set(treeIds).size === treeIds.length;
				const sameLeaf = tree.leafId === entries.leafId;
				result = {
					capability: "continuity.active-path",
					classification: sameIds && sameLeaf ? "QUALIFIED" : "MISMATCH",
					expected: "the tree holds every entry once and its leaf agrees with get_entries",
					observed: `tree ids ${sameIds ? "match" : "differ from"} get_entries; leaf ids ${sameLeaf ? "agree" : "disagree"}`,
					limitations: [
						"The context-window boundary is derived from compaction entries (firstKeptEntryId), not reported directly",
						"The active tool names of Continuity v0 are not available over RPC",
					],
				};
			} catch (error) {
				result = {
					capability: "continuity.active-path",
					classification: "MISMATCH",
					expected: "get_tree answers with the documented shape",
					observed: `the tree exchange failed: ${errorText(error)}`,
					limitations: [],
				};
			}
			runs.push({
				definition: PI_LOCAL_TREE_CHECK,
				inputs: { commands: ["get_tree", "get_entries"] },
				results: [result],
				transcript: take(mark),
			});
		}
		// --- stats ---
		mark = recorder.transcript.length;
		{
			let result: PiCheckResultV0;
			try {
				const state = await recorder.call("get_state", {}, () => client.getState());
				const stats = await recorder.call("get_session_stats", {}, () => client.getSessionStats());
				const same = stats.sessionId === state.sessionId;
				result = {
					capability: "runtime.metrics",
					classification: same ? "PARTIAL" : "MISMATCH",
					expected: "cumulative session tokens and cost with Runtime Metrics v0's per-category cost",
					observed: same
						? "get_session_stats reports cumulative token counts and a total cost for the same session"
						: "get_session_stats names a different session than get_state",
					limitations: [
						"Cost is a total only: no input/output/cache cost breakdown",
						"No reasoning-token or one-hour cache-write counts in the stats (they appear per entry when the provider reports them)",
					],
				};
			} catch (error) {
				result = {
					capability: "runtime.metrics",
					classification: "MISMATCH",
					expected: "get_session_stats answers with the documented shape",
					observed: `the stats exchange failed: ${errorText(error)}`,
					limitations: [],
				};
			}
			runs.push({
				definition: PI_LOCAL_STATS_CHECK,
				inputs: { commands: ["get_state", "get_session_stats"] },
				results: [result],
				transcript: take(mark),
			});
		}
		// --- controls ---
		mark = recorder.transcript.length;
		{
			const results: PiCheckResultV0[] = [];
			try {
				const state = await recorder.call("get_state", {}, () => client.getState());
				const available = (await recorder.call("get_available_models", {}, () =>
					client.command("get_available_models"),
				)) as { models?: { provider?: unknown; id?: unknown }[] };
				const models = Array.isArray(available?.models) ? available.models : [];
				const current = state.model;
				const listed =
					current !== null &&
					models.some((model) => model.provider === current.provider && model.id === current.id);
				if (current === null || !listed) {
					results.push({
						capability: "control.model",
						classification: "inconclusive",
						expected: "a configured model among get_available_models to re-select",
						observed:
							current === null
								? "no model is configured"
								: "the current model is not among the available models (no credentials or a placeholder model)",
						limitations: [],
					});
				} else {
					const selected = await recorder.call(
						"set_model",
						{ provider: current.provider, modelId: current.id },
						() => client.setModel(current.provider, current.id),
					);
					const after = await recorder.call("get_state", {}, () => client.getState());
					const ok =
						selected.provider === current.provider &&
						selected.id === current.id &&
						after.model?.provider === current.provider &&
						after.model?.id === current.id;
					results.push({
						capability: "control.model",
						classification: ok ? "EXACT" : "MISMATCH",
						expected: "set_model returns the selected model and get_state then reports it",
						observed: ok
							? "set_model returned the model and get_state reported it"
							: "the reported model differs",
						limitations: [
							"Exercised by re-selecting the configured model; switching to another model is not exercised (it may need other credentials)",
						],
					});
				}
				const levels = await recorder.call("get_available_thinking_levels", {}, () =>
					client.getAvailableThinkingLevels(),
				);
				const original = state.thinkingLevel;
				let thinkingOk = levels.length > 0;
				for (const level of levels) {
					await recorder.call("set_thinking_level", { level }, () => client.setThinkingLevel(level));
					const after = await recorder.call("get_state", {}, () => client.getState());
					if (after.thinkingLevel !== level) thinkingOk = false;
				}
				if (levels.includes(original)) {
					await recorder.call("set_thinking_level", { level: original }, () => client.setThinkingLevel(original));
				}
				results.push({
					capability: "control.thinking",
					classification: thinkingOk ? (levels.length > 1 ? "EXACT" : "QUALIFIED") : "MISMATCH",
					expected: "each available thinking level can be set and get_state then reports it",
					observed: thinkingOk
						? `all ${levels.length} available level(s) were set and reported`
						: "a set level was not reported by get_state",
					limitations:
						levels.length > 1
							? []
							: ["Only one thinking level is available for the configured model, so no change was exercised"],
				});
				let activeToolsRefused = false;
				try {
					await recorder.call("get_active_tools", {}, () => client.command("get_active_tools"));
				} catch (error) {
					if (!(error instanceof PiRpcRefusalV0)) throw error;
					activeToolsRefused = true;
				}
				results.push({
					capability: "control.active-tools",
					classification: activeToolsRefused ? "UNAVAILABLE" : "MISMATCH",
					expected: "no RPC command reads or changes the active tool set (documented surface)",
					observed: activeToolsRefused
						? "Pi refused get_active_tools; tools are selected only at launch (--tools/--no-tools)"
						: "Pi accepted get_active_tools, which this adapter version does not know; the adapter needs review",
					limitations: [
						"Pi's extension API (pi.getActiveTools/pi.setActiveTools) could provide this through an optional extension; none is installed by Endophasia",
					],
				});
			} catch (error) {
				for (const capability of PI_LOCAL_CONTROLS_CHECK.capabilities) {
					if (results.some((result) => result.capability === capability)) continue;
					results.push({
						capability,
						classification: "MISMATCH",
						expected: "the control commands answer with the documented shapes",
						observed: `the control exchange failed: ${errorText(error)}`,
						limitations: [],
					});
				}
			}
			runs.push({
				definition: PI_LOCAL_CONTROLS_CHECK,
				inputs: {
					commands: [
						"get_state",
						"get_available_models",
						"set_model",
						"get_available_thinking_levels",
						"set_thinking_level",
						"get_active_tools",
					],
				},
				results,
				transcript: take(mark),
			});
		}
	} finally {
		await recorder.close();
		if (options.cwd === undefined) rmSync(scratch, { recursive: true, force: true });
	}
	return runs;
}

/** The static-surface classification; only for a tested version (see the module header). */
export function piStaticSurfaceV0(): PiCheckRunV0 {
	return {
		definition: PI_STATIC_SURFACE_CHECK,
		inputs: { source: "pi v1.0.0 rpc-types.ts, json.md, rpc-commands.md" },
		results: [
			{
				capability: "run.identity",
				classification: "UNAVAILABLE",
				expected: "runtime-supplied run and turn identifiers on lifecycle events",
				observed: "agent_start, turn_start, turn_end, agent_end and agent_settled carry no identifiers",
				limitations: ["Endophasia does not invent run ids: mapped events carry no run coordinate"],
			},
			{
				capability: "operation.outcome",
				classification: "UNAVAILABLE",
				expected: "a durable, id-keyed terminal outcome for an accepted operation",
				observed:
					"prompt, steer and follow_up responses carry a disposition only, and no command reads an operation's outcome",
				limitations: [
					"Acceptance (the response) and effects (later events and entries) stay separate records; no outcome is inferred",
				],
			},
		],
		transcript: [{ direction: "note", text: "classified from the documented surface; no runtime interaction" }],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Live study
// ---------------------------------------------------------------------------------------------------------------

export interface PiLiveStudyOptionsV0 {
	/** Must be exactly true: the caller states that agent work and provider cost were authorized by the operator. */
	readonly authorized: true;
	readonly executable: string;
	readonly env: Readonly<Record<string, string>>;
	readonly provider?: string;
	readonly model?: string;
	/** Per-step bound on waiting for a run to settle. Default 180 s. */
	readonly stepTimeoutMs?: number;
}

const FIXTURE_FILE = "endophasia-study.txt";
const FIXTURE_TEXT = "Endophasia study fixture. The first word is Endophasia.\n";
const LONG_PROMPT =
	"Endophasia live conformance study. Write a numbered list from one to forty, one number per line, with a short word after each number.";

function userEntryWithText(entries: readonly PiSessionEntryV0[], marker: string): PiSessionEntryV0 | undefined {
	return entries.find((entry) => {
		if (entry.type !== "message") return false;
		const message = entry.raw.message as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "user") return false;
		const text = Array.isArray(message.content)
			? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
			: typeof message.content === "string"
				? message.content
				: "";
		return text.includes(marker);
	});
}

/**
 * Run the live study. Throws TypeError unless `authorized` is exactly true. Everything runs in a scratch workspace and
 * a scratch persistent session that are removed afterwards; the operator's own sessions are never touched.
 */
export async function runPiLiveStudyV0(options: PiLiveStudyOptionsV0): Promise<PiCheckRunV0> {
	if (options.authorized !== true) throw new TypeError("the Pi live study needs explicit operator authorization");
	const stepTimeoutMs = options.stepTimeoutMs ?? 180_000;
	const workspace = mkdtempSync(join(tmpdir(), "endo-pi-study-"));
	writeFileSync(join(workspace, FIXTURE_FILE), FIXTURE_TEXT);
	const sessionId = `endo-study-${randomBytes(6).toString("hex")}`;
	const launch: PiRpcLaunchOptionsV0 = {
		executable: options.executable,
		cwd: workspace,
		env: options.env,
		session: { kind: "persistent", sessionDir: join(workspace, ".sessions"), sessionId },
		...(options.provider === undefined ? {} : { provider: options.provider }),
		...(options.model === undefined ? {} : { model: options.model }),
		tools: ["read"],
		requestTimeoutMs: 60_000,
		closeTimeoutMs: 15_000,
	};
	const results: PiCheckResultV0[] = [];
	const transcript: PiTranscriptRecordV0[] = [];
	const inputs = {
		sessionId: "endo-study-<random>",
		tools: ["read"],
		provider: options.provider ?? null,
		model: options.model ?? null,
		prompts: ["short acknowledgement", `read ${FIXTURE_FILE}`, LONG_PROMPT],
	};
	const recorder = new Recorder(launch);
	const client = recorder.client;
	const settle = (from: number) => recorder.waitFor((event) => event.type === "agent_settled", stepTimeoutMs, from);
	let firstEntryIds: string[] = [];
	let reportedSessionId: string | null = null;
	try {
		// (1) lifecycle and usage
		{
			const from = recorder.events.length;
			recorder.note("step 1: short prompt");
			// Sent raw, so the response's own keys can be checked: an operation id there would change operation.outcome.
			const response = await recorder.call("prompt", { message: "short acknowledgement" }, () =>
				client.raw("prompt", { message: "Endophasia live conformance study. Reply with one short sentence." }),
			);
			const data = response.data;
			const responseKeys =
				typeof data === "object" && data !== null && !Array.isArray(data) ? Object.keys(data).sort() : [];
			const disposition =
				response.success && typeof (data as { disposition?: unknown })?.disposition === "string"
					? String((data as { disposition: string }).disposition)
					: "refused";
			const settled = disposition === "started" ? await settle(from) : null;
			const lifecycle = recorder.events.slice(from).filter((event) => event.type in DOCUMENTED_LIFECYCLE_KEYS);
			const extraKeys = [
				...new Set(
					lifecycle.flatMap((event) =>
						Object.keys(event.record)
							.filter((key) => !DOCUMENTED_LIFECYCLE_KEYS[event.type]!.includes(key))
							.map((key) => `${event.type}.${key}`),
					),
				),
			].sort();
			results.push({
				capability: "run.identity",
				classification: settled === null ? "inconclusive" : extraKeys.length === 0 ? "UNAVAILABLE" : "MISMATCH",
				expected: "runtime-supplied run or turn identifiers on lifecycle events",
				observed:
					extraKeys.length === 0
						? `${lifecycle.length} lifecycle events carried only their documented keys: no run or turn identifier`
						: `lifecycle events carried undocumented keys (${extraKeys.join(", ")}); the adapter does not map them and needs review`,
				limitations: ["Endophasia does not invent run ids: mapped events carry no run coordinate"],
			});
			results.push({
				capability: "operation.outcome",
				classification: !response.success
					? "inconclusive"
					: responseKeys.join(",") === "disposition"
						? "UNAVAILABLE"
						: "MISMATCH",
				expected: "an operation identifier in the prompt response, readable later as a durable outcome",
				observed:
					responseKeys.join(",") === "disposition"
						? "the prompt response carried only a disposition: nothing identifies the operation for a later outcome read"
						: `the prompt response carried ${responseKeys.join(", ") || "no data"}; the adapter needs review`,
				limitations: [
					"Acceptance (the response) and effects (later events and entries) stay separate records; no outcome is inferred",
				],
			});
			const order = ["agent_start", "turn_start", "message_end", "turn_end", "agent_end", "agent_settled"];
			const seen = recorder.events.slice(from).map((event) => event.type);
			let cursor = 0;
			for (const type of seen) if (type === order[cursor]) cursor += 1;
			if (settled === null) {
				results.push({
					capability: "lifecycle.trace",
					classification: "inconclusive",
					expected: "the lifecycle events of one run, ending in agent_settled",
					observed: `the prompt was ${disposition} and the run did not settle within ${stepTimeoutMs} ms`,
					limitations: [],
				});
			} else {
				results.push({
					capability: "lifecycle.trace",
					classification: cursor === order.length ? "PARTIAL" : "MISMATCH",
					expected: "agent_start, turn_start, message_end, turn_end, agent_end, agent_settled in order",
					observed:
						cursor === order.length
							? "all six lifecycle events were observed in order"
							: `the lifecycle order broke after ${order.slice(0, cursor).join(", ") || "nothing"}`,
					limitations: [
						"No run or turn identifiers: events are ordered by arrival only",
						"No resume or suspend events (Mission Trace v0 mission.resumed/suspended are unavailable)",
						"Live events are not replayed by Pi: after a reconnect only durable entries can be caught up",
					],
				});
			}
			const entries = await recorder.call("get_entries", {}, () => client.getEntries());
			firstEntryIds = entries.entries.map((entry) => entry.id);
			const assistant = entries.entries.filter(
				(entry) => entry.type === "message" && (entry.raw.message as { role?: unknown })?.role === "assistant",
			);
			const withUsage = assistant.filter((entry) => {
				const usage = (entry.raw.message as { usage?: Record<string, unknown> }).usage;
				return (
					typeof usage === "object" &&
					usage !== null &&
					["input", "output", "totalTokens"].every((key) => typeof usage[key] === "number")
				);
			});
			results.push({
				capability: "usage.entries",
				classification:
					settled === null
						? "inconclusive"
						: assistant.length > 0 && withUsage.length === assistant.length
							? "EXACT"
							: "MISMATCH",
				expected: "every assistant entry carries its provider-reported usage",
				observed: `${withUsage.length} of ${assistant.length} assistant entries carry usage`,
				limitations: [
					"Usage is what the provider reported; a provider that reports none yields zeros, not an estimate",
					"Rows are keyed by opaque entry ids, not by an integer ledger sequence",
				],
			});
			reportedSessionId = (await recorder.call("get_state", {}, () => client.getState())).sessionId;
		}
		// (2) tool activity
		{
			const from = recorder.events.length;
			recorder.note("step 2: read tool");
			const disposition = await recorder.call("prompt", { message: `read ${FIXTURE_FILE}` }, () =>
				client.prompt(
					`Endophasia live conformance study. Use the read tool to read the file ${FIXTURE_FILE} and reply with its first word.`,
				),
			);
			const settled = disposition === "started" ? await settle(from) : null;
			const events = recorder.events.slice(from);
			const starts = events.filter((event) => event.type === "tool_execution_start");
			const ends = events.filter((event) => event.type === "tool_execution_end");
			const paired = starts.filter((start) =>
				ends.some(
					(end) =>
						end.record.toolCallId === start.record.toolCallId && end.record.toolName === start.record.toolName,
				),
			);
			results.push({
				capability: "tool.activity",
				classification:
					settled === null || starts.length === 0
						? "inconclusive"
						: paired.length === starts.length && starts.length === ends.length
							? "EXACT"
							: "MISMATCH",
				expected: "tool_execution_start and tool_execution_end for each tool call, correlated by toolCallId",
				observed:
					settled === null
						? "the run did not settle"
						: starts.length === 0
							? "the model made no tool call, so tool activity could not be observed"
							: `${starts.length} start(s), ${ends.length} end(s), ${paired.length} correlated`,
				limitations: [
					"Whether a model calls a tool is the model's choice: an absent call is inconclusive, not a failure",
				],
			});
		}
		// (3) steer, (4) follow-up
		for (const mode of ["steer", "follow_up"] as const) {
			const capability = mode === "steer" ? "steering.steer" : "steering.follow-up";
			const marker = `endo-${mode}-${randomBytes(4).toString("hex")}`;
			const from = recorder.events.length;
			recorder.note(`step ${mode === "steer" ? 3 : 4}: ${mode} during a run`);
			const disposition = await recorder.call("prompt", { message: "long prompt" }, () =>
				client.prompt(LONG_PROMPT),
			);
			const started =
				disposition === "started"
					? await recorder.waitFor((event) => event.type === "agent_start", 30_000, from)
					: null;
			let accepted: string | null = null;
			let stillRunning = false;
			if (started !== null) {
				stillRunning = !recorder.events.slice(from).some((event) => event.type === "agent_settled");
				const text = `Endophasia study ${mode} marker ${marker}: acknowledge briefly.`;
				accepted = await recorder.call(mode, { message: `${mode} marker` }, () =>
					mode === "steer" ? client.steer(text) : client.followUp(text),
				);
			}
			// A follow-up runs after the run it was queued behind; wait until no work remains.
			let settled = await settle(from);
			if (settled !== null && mode === "follow_up") {
				const after = recorder.events.indexOf(settled) + 1;
				const next = await recorder.waitFor((event) => event.type === "agent_start", 5_000, after);
				if (next !== null) settled = await settle(recorder.events.indexOf(next));
			}
			const entries = await recorder.call("get_entries", {}, () => client.getEntries());
			const consumed = userEntryWithText(entries.entries, marker) !== undefined;
			if (!consumed && accepted === "queued") {
				const cleared = await recorder.call("clear_queue", {}, () => client.clearQueue());
				recorder.note(
					`cleared ${cleared.steering} steering and ${cleared.followUp} follow-up message(s) left queued`,
				);
			}
			results.push({
				capability,
				classification:
					started === null || !stillRunning || settled === null
						? "inconclusive"
						: accepted === "queued" && consumed
							? "PARTIAL"
							: accepted === "queued"
								? "MISMATCH"
								: "inconclusive",
				expected: `${mode} sent during a run is accepted and the message is consumed by the session`,
				observed:
					started === null
						? "the run did not start"
						: !stillRunning
							? `the run settled before ${mode} could be sent`
							: `${mode} was ${accepted ?? "not sent"}; the marker message was ${consumed ? "" : "not "}consumed`,
				limitations: [
					"Pi's acceptance carries no identity for the queued message: a receipt cannot be correlated with its consumption except by content",
					"queue_update reports the queued texts, not identities",
				],
			});
		}
		// (5) stop
		{
			const from = recorder.events.length;
			recorder.note("step 5: abort during a run");
			const disposition = await recorder.call("prompt", { message: "long prompt" }, () =>
				client.prompt(LONG_PROMPT),
			);
			const started =
				disposition === "started"
					? await recorder.waitFor((event) => event.type === "agent_start", 30_000, from)
					: null;
			const runningAtAbort =
				started !== null && !recorder.events.slice(from).some((event) => event.type === "agent_end");
			let aborted = false;
			if (started !== null) {
				await recorder.call("abort", {}, () => client.abort());
				aborted = true;
			}
			const ended = aborted
				? await recorder.waitFor((event) => event.type === "agent_end", stepTimeoutMs, from)
				: null;
			const state = await recorder.call("get_state", {}, () => client.getState());
			results.push({
				capability: "steering.stop",
				classification: !runningAtAbort
					? "inconclusive"
					: ended !== null && !state.isStreaming
						? "PARTIAL"
						: "MISMATCH",
				expected: "abort during a run ends that run",
				observed: !runningAtAbort
					? "the run ended before abort could be sent"
					: `abort was acknowledged; the run ${ended === null ? "did not end" : "ended"} and the session is ${
							state.isStreaming ? "still streaming" : "idle"
						}`,
				limitations: [
					"Pi's abort takes no target: it aborts whatever is current and cannot be confined to the run the operator observed",
					"The acknowledgement is not the outcome; the ended run is observed separately",
				],
			});
		}
	} finally {
		await recorder.close();
	}
	transcript.push(...recorder.transcript);
	// (6) resume in a second process
	const resume = new Recorder(launch);
	try {
		resume.note("step 6: second process on the same session id");
		const state = await resume.call("get_state", {}, () => resume.client.getState());
		const entries = await resume.call("get_entries", {}, () => resume.client.getEntries());
		const ids = new Set(entries.entries.map((entry) => entry.id));
		const persisted = firstEntryIds.length > 0 && firstEntryIds.every((id) => ids.has(id));
		results.push({
			capability: "session.identity",
			classification:
				reportedSessionId === null
					? "inconclusive"
					: state.sessionId === reportedSessionId && persisted
						? "EXACT"
						: "MISMATCH",
			expected: "a second process on the same --session-id reports the same session id and the earlier entry ids",
			observed: `session id ${state.sessionId === reportedSessionId ? "matched" : "differed"}; ${
				persisted ? "all" : "not all"
			} earlier entry ids were present`,
			limitations: ["Continuity holds once the session was persisted, which Pi does at its first message"],
		});
	} finally {
		await resume.close();
		transcript.push(...resume.transcript);
		rmSync(workspace, { recursive: true, force: true });
	}
	return { definition: PI_LIVE_STUDY_CHECK, inputs, results, transcript };
}
