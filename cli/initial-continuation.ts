// Bounded same-process continuation for a trusted local operator. Never reconnects or retries.
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { harnessSurfacesOfCaptureV0 } from "../adapters/openai-proxy/harness-surface.ts";
import { endoRequestDigestV0 } from "../adapters/openai-proxy/http.ts";
import { Http1ParserV0, validGovernedHttp1HeadV0 } from "../adapters/openai-proxy/http1.ts";
import { piProjectConfigurationDigestV0, piUserConfigurationDigestV0 } from "../adapters/pi/configuration.ts";
import { fingerprintPiRuntimeV0 } from "../adapters/pi/identity.ts";
import { projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import {
	type ContinuationTurnApprovalV0,
	ENDO_INITIAL_CONTINUATION_MAX_BYTES_V0,
	ENDO_INITIAL_CONTINUATION_VERSION_V0,
	type InitialContinuationApprovalV0,
	type InitialContinuationBoundaryV0,
	type InitialContinuationDispatchV0,
	type InitialContinuationPlanV0,
	type InitialContinuationReceiptV0,
	isContinuationTurnApprovalV0,
	isInitialContinuationApprovalV0,
	isInitialContinuationBoundaryV0,
	isInitialContinuationPlanV0,
	readInitialContinuationReceiptV0,
} from "../protocol/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { archiveEndoWorkspaceV0 } from "../storage/workspace-snapshot.ts";
import { piCassetteEnvV0 } from "./cassette-session.ts";
import {
	captureGenerationV0,
	completeEvidenceStore,
	readVerifiedCheckpointCandidateV0,
} from "./checkpoint-candidate.ts";
import { readVerifiedInitialBranchSetV0 } from "./initial-branch-set.ts";
import {
	INITIAL_EXECUTION_REQUIRED_FLAGS_V0,
	type InitialChildExecutionOptionsV0,
	type InitialRuntimeContextV0,
	initialExecutionPlanDigestV0,
	initialExecutionPrivateFileV0,
	initialExecutionPromptDigestV0,
	initialExecutionPromptTextV0,
	preflightInitialChildExecutionV0,
	publishInitialExecutionReceiptV0,
	sameInitialExecutionValueV0 as same,
	sameInitialStartupRuntimeV0,
	startInitialRuntimeV0,
	verifyInitialExecutionLineageV0,
	withinInitialExecutionDeadlineV0 as withinDeadline,
} from "./initial-child-execution.ts";
import { readEndoStoreEventsV0, trajectoryFromStoreV0 } from "./trajectory.ts";

export interface InitialContinuationOptionsV0 extends InitialChildExecutionOptionsV0 {
	continuationPrompt: string;
	maxApprovalIdleMs: number;
}
const digest = (key: EndoDigestKeyV0, purpose: string, value: unknown) => key.digest({ purpose, value });
const planDigest = (key: EndoDigestKeyV0, value: Omit<InitialContinuationPlanV0, "commitment">) =>
	digest(key, "endo.initial-continuation.plan.v0", value);
const boundaryDigest = (key: EndoDigestKeyV0, value: Omit<InitialContinuationBoundaryV0, "commitment">) =>
	digest(key, "endo.initial-continuation.boundary.v0", value);
const dispatchDigest = (key: EndoDigestKeyV0, value: Omit<InitialContinuationDispatchV0, "commitment">) =>
	digest(key, "endo.initial-continuation.dispatch.v0", value);
const receiptDigest = (key: EndoDigestKeyV0, value: Omit<InitialContinuationReceiptV0, "commitment">) =>
	digest(key, "endo.initial-continuation.receipt.v0", value);
const secondPromptDigest = (key: EndoDigestKeyV0, prompt: string) =>
	digest(key, "endo.initial-continuation.prompt.v0", prompt);
const approvalDigest = (key: EndoDigestKeyV0, approval: InitialContinuationApprovalV0 | ContinuationTurnApprovalV0) =>
	digest(key, "endo.initial-continuation.approval.v0", approval);
const seal = (
	key: EndoDigestKeyV0,
	r: Omit<InitialContinuationReceiptV0, "commitment">,
): InitialContinuationReceiptV0 => {
	const { commitment: _old, ...body } = r as InitialContinuationReceiptV0;
	return { ...body, commitment: receiptDigest(key, body) };
};

/** Preflight creates no session and sends no request. Both prompt commitments are fixed in the plan. */
export async function preflightInitialContinuationV0(
	options: InitialContinuationOptionsV0,
	key: EndoDigestKeyV0,
): Promise<{ status: "ready"; plan: InitialContinuationPlanV0 } | { status: "refused"; reason: string }> {
	try {
		if (
			!Number.isSafeInteger(options.maxApprovalIdleMs) ||
			options.maxApprovalIdleMs < 1000 ||
			options.maxApprovalIdleMs > 60000 ||
			options.maxApprovalIdleMs > options.wallTimeoutMs ||
			Buffer.byteLength(options.continuationPrompt) < 1 ||
			Buffer.byteLength(options.continuationPrompt) > 4096
		)
			throw new Error("invalid continuation bounds or prompt");
		const initial = await preflightInitialChildExecutionV0(options, key);
		if (initial.status !== "ready") throw new Error(initial.reason);
		const parent = readVerifiedCheckpointCandidateV0(options.source, options.replay, key);
		if (parent.status !== "qualified") throw new Error("parent checkpoint unavailable");
		const body = {
			initial: initial.plan,
			continuationPromptCommitment: secondPromptDigest(key, options.continuationPrompt),
			sourceCapture: parent.candidate.evidence.sourceCapture,
			replayCapture: parent.candidate.evidence.replayCapture,
			maxApprovalIdleMs: options.maxApprovalIdleMs,
			maxRpcOutputBytes: 2 * 1024 * 1024,
		};
		return { status: "ready", plan: { ...body, commitment: planDigest(key, body) } };
	} catch (error) {
		return { status: "refused", reason: (error as Error).message.slice(0, 128) };
	}
}

export function approveInitialContinuationV0(
	plan: InitialContinuationPlanV0,
	exactCommitment: EndoKeyedDigestV0,
	confirmation: "approve first tool-free turn",
): InitialContinuationApprovalV0 {
	if (
		!isInitialContinuationPlanV0(plan) ||
		confirmation !== "approve first tool-free turn" ||
		!same(plan.commitment, exactCommitment)
	)
		throw new TypeError("exact initial plan approval required");
	return {
		attemptId: plan.initial.attemptId,
		planCommitment: structuredClone(plan.commitment),
		confirmedAt: new Date().toISOString(),
		method: "local-explicit",
	};
}
export function approveContinuationTurnV0(
	boundary: InitialContinuationBoundaryV0,
	exactCommitment: EndoKeyedDigestV0,
	confirmation: "approve continuation turn",
): ContinuationTurnApprovalV0 {
	if (
		!isInitialContinuationBoundaryV0(boundary, exactCommitment.keyId) ||
		confirmation !== "approve continuation turn" ||
		!same(boundary.commitment, exactCommitment) ||
		Date.now() > Date.parse(boundary.approvalDeadlineAt)
	)
		throw new TypeError("current exact boundary approval required");
	return {
		attemptId: boundary.attemptId,
		boundaryCommitment: structuredClone(boundary.commitment),
		confirmedAt: new Date().toISOString(),
		method: "local-explicit",
	};
}

/** Decode only the bounded OpenAI streaming shape this profile knows how to verify. */
function responseText(bytes: Uint8Array, model: string): string {
	let headStatus = 0,
		ends = 0;
	const body: Buffer[] = [];
	const parser = new Http1ParserV0(
		"response",
		{
			head(h) {
				if (!validGovernedHttp1HeadV0(h)) throw new Error("response framing invalid");
				headStatus = h.status ?? 0;
			},
			body(b) {
				body.push(Buffer.from(b));
			},
			end() {
				ends += 1;
			},
		},
		{ strictChunks: true },
	);
	parser.pendingMethods.push("POST");
	parser.push(Buffer.from(bytes));
	if (!parser.close() || ends !== 1 || headStatus !== 200) throw new Error("response framing incomplete");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(body));
	let answer = "",
		finished = false,
		done = false;
	for (const line of text.split(/\r?\n/)) {
		if (line === "" || line.startsWith(":")) continue;
		if (!line.startsWith("data:")) throw new Error("unsupported response event");
		const data = line.slice(5).trimStart();
		if (data === "[DONE]") {
			if (done) throw new Error("duplicate response end");
			done = true;
			continue;
		}
		if (done) throw new Error("response after end");
		let value: { model?: unknown; choices?: unknown };
		try {
			value = JSON.parse(data);
		} catch {
			throw new Error("malformed response JSON");
		}
		if (value.model !== undefined && value.model !== model) throw new Error("response model mismatch");
		if (!Array.isArray(value.choices)) throw new Error("malformed response choices");
		if (value.choices.length === 0) continue;
		if (finished || value.choices.length !== 1) throw new Error("unexpected response choices");
		const choice = value.choices[0] as {
			index?: unknown;
			delta?: Record<string, unknown>;
			finish_reason?: unknown;
			message?: unknown;
		};
		if (
			!choice ||
			typeof choice !== "object" ||
			choice.index !== 0 ||
			choice.message !== undefined ||
			!choice.delta ||
			typeof choice.delta !== "object" ||
			Array.isArray(choice.delta) ||
			Object.keys(choice.delta).some((field) => !["role", "content", "refusal"].includes(field)) ||
			(choice.delta.refusal !== undefined && choice.delta.refusal !== null) ||
			(choice.delta.role !== undefined && choice.delta.role !== "assistant") ||
			(choice.delta.content !== undefined &&
				choice.delta.content !== null &&
				typeof choice.delta.content !== "string")
		)
			throw new Error("unsupported response or tool call");
		if (typeof choice.delta.content === "string") answer += choice.delta.content;
		if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
			if (choice.finish_reason !== "stop" || finished) throw new Error("response did not settle normally");
			finished = true;
		}
	}
	if (!done || !finished) throw new Error("response settlement unavailable");
	return answer;
}

function requestMessages(bytes: Uint8Array, model: string): Record<string, unknown>[] {
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("malformed request JSON");
	}
	if (
		!body ||
		typeof body !== "object" ||
		body.model !== model ||
		body.stream !== true ||
		!Array.isArray(body.messages) ||
		(body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) ||
		body.functions !== undefined ||
		body.function_call !== undefined ||
		body.tool_choice !== undefined
	)
		throw new Error("model or tool surface mismatch");
	if (!body.messages.every((m) => m && typeof m === "object" && !Array.isArray(m)))
		throw new Error("malformed messages");
	return body.messages as Record<string, unknown>[];
}
function checkRequest(
	messages: Record<string, unknown>[],
	plan: InitialContinuationPlanV0,
	key: EndoDigestKeyV0,
	first?: { messages: Record<string, unknown>[]; response: string },
): void {
	if (first === undefined) {
		if (
			messages.length < 1 ||
			messages.at(-1)?.role !== "user" ||
			messages.slice(0, -1).some((m) => !["system", "developer"].includes(String(m.role)))
		)
			throw new Error("unexpected initial conversation");
		const text = initialExecutionPromptTextV0(messages.at(-1)?.content);
		if (text === null || !same(initialExecutionPromptDigestV0(key, text), plan.initial.promptCommitment))
			throw new Error("initial prompt mismatch");
	} else {
		if (
			messages.length !== first.messages.length + 2 ||
			!same(messages.slice(0, first.messages.length), first.messages)
		)
			throw new Error("first conversation was not retained");
		const assistant = messages.at(-2)!;
		if (
			assistant.role !== "assistant" ||
			assistant.tool_calls !== undefined ||
			assistant.function_call !== undefined ||
			initialExecutionPromptTextV0(assistant.content) !== first.response
		)
			throw new Error("first response not retained");
		const user = messages.at(-1)!;
		const text = initialExecutionPromptTextV0(user.content);
		if (
			user.role !== "user" ||
			text === null ||
			!same(secondPromptDigest(key, text), plan.continuationPromptCommitment)
		)
			throw new Error("continuation prompt mismatch");
	}
}

type Runtime = NonNullable<InitialContinuationReceiptV0["runtime"]>;
function inspectEvidence(plan: InitialContinuationPlanV0, runtime: Runtime, key: EndoDigestKeyV0, count: 1 | 2) {
	const store = runtime.store;
	if (!completeEvidenceStore(store) || !completeEvidenceStore(endoCaptureRootV0(store)))
		throw new Error("evidence log damaged");
	const capture = readEndoCaptureEventsV0(store);
	if (capture.some((event) => event.kind === "capture.unparsed")) throw new Error("unparsed capture");
	const started = capture.filter((e) => e.kind === "capture.started" && e.producer === "capture:record");
	if (
		started.length !== 1 ||
		(started[0]!.payload as { upstream?: unknown }).upstream !== plan.initial.upstream ||
		(started[0]!.payload as { listen?: unknown }).listen !== runtime.proxyOrigin
	)
		throw new Error("proxy identity mismatch");
	const cassette = loadEndoCassetteV0(store, key);
	const requests = capture.filter((e) => e.kind === "capture.request" && e.producer === "capture:record");
	const responses = capture.filter((e) => e.kind === "capture.response" && e.producer === "capture:record");
	const endings = capture.filter((e) => e.kind === "capture.exchange-ended" && e.producer === "capture:record");
	if (
		requests.length !== count ||
		responses.length !== count ||
		endings.length !== count ||
		cassette.exchanges.length !== count
	)
		throw new Error("unexpected request or response count");
	const surface = harnessSurfacesOfCaptureV0(store, key);
	if (surface.length !== count) throw new Error("request surface unavailable");
	const blobs = createEndoBlobStoreV0(endoCaptureRootV0(store), key, { readOnly: true });
	let first: { messages: Record<string, unknown>[]; response: string } | undefined;
	const responseDigests: EndoKeyedDigestV0[] = [];
	const requestDigests: EndoKeyedDigestV0[] = [];
	for (let index = 0; index < count; index += 1) {
		const exchange = cassette.exchanges[index]!;
		const event = requests[index]!;
		const payload = event.payload as unknown as { requestDigest: EndoKeyedDigestV0; exchange: number };
		const responseEvent = responses[index]!;
		const ending = endings[index]!;
		if (
			(responseEvent.payload as { exchange?: unknown }).exchange !== index + 1 ||
			(ending.payload as { exchange?: unknown }).exchange !== index + 1 ||
			capture.indexOf(event) >= capture.indexOf(responseEvent) ||
			capture.indexOf(responseEvent) >= capture.indexOf(ending) ||
			(index > 0 && capture.indexOf(endings[index - 1]!) >= capture.indexOf(event))
		)
			throw new Error("capture event order mismatch");
		const observed = surface[index]!;
		if (
			exchange.exchange !== index + 1 ||
			payload.exchange !== exchange.exchange ||
			exchange.method !== "POST" ||
			exchange.path !== "/v1/chat/completions" ||
			exchange.attempt !== 1 ||
			exchange.truncated !== null ||
			exchange.response?.outcome !== "complete" ||
			exchange.response.status !== 200 ||
			!same(payload.requestDigest, exchange.requestDigest)
		)
			throw new Error("captured exchange incomplete or out of order");
		if (
			observed.components.status !== "reported" ||
			observed.components.value.model.status !== "reported" ||
			observed.components.value.model.value !== plan.initial.model ||
			observed.components.value.tools.count !== 0 ||
			observed.source.target.path !== "/v1/chat/completions" ||
			observed.source.target.query !== "absent"
		)
			throw new Error("captured model or tool policy mismatch");
		const body = blobs.get(exchange.requestBody.digest);
		if (
			body.length !== exchange.requestBody.bytes ||
			!same(endoRequestDigestV0(key, exchange.method, exchange.path, body), exchange.requestDigest)
		)
			throw new Error("captured request mismatch");
		const messages = requestMessages(body, plan.initial.model);
		checkRequest(messages, plan, key, first);
		const wire = blobs.get(exchange.response.wire.digest);
		if (wire.length !== exchange.response.wire.bytes) throw new Error("captured response length mismatch");
		const response = responseText(wire, plan.initial.model);
		if (index === 0) first = { messages, response };
		requestDigests.push(exchange.requestDigest);
		responseDigests.push(exchange.response.wire.digest);
	}
	const events = readEndoStoreEventsV0(store);
	const attached = events.filter((e) => e.kind === "harness.attached");
	if (attached.length !== 1) throw new Error("Pi attachment count mismatch");
	const attachment = attached[0]!.payload as unknown as {
		identityDigest?: string;
		version?: string;
		piSessionId?: string;
		requestedSessionId?: string;
		args?: string[];
		userConfigurationDigest?: string;
		projectConfigurationDigest?: string;
	};
	const args = attachment.args;
	if (
		attachment.identityDigest !== plan.initial.piIdentity ||
		attachment.version !== plan.initial.piVersion ||
		attachment.piSessionId !== runtime.sessionId ||
		attachment.requestedSessionId !== runtime.sessionId ||
		!Array.isArray(args) ||
		!INITIAL_EXECUTION_REQUIRED_FLAGS_V0.every((flag) => args.includes(flag)) ||
		args[args.indexOf("--provider") + 1] !== plan.initial.provider ||
		args[args.indexOf("--model") + 1] !== plan.initial.model ||
		args[args.indexOf("--session-id") + 1] !== runtime.sessionId ||
		args[args.indexOf("--session-dir") + 1] !== join(store, "pi-sessions", "pi.initial-child") ||
		attachment.userConfigurationDigest !== piUserConfigurationDigestV0(piCassetteEnvV0(runtime.root)) ||
		attachment.projectConfigurationDigest !== piProjectConfigurationDigestV0(runtime.workingDirectory)
	)
		throw new Error("Pi identity or startup policy mismatch");
	const forbidden = new Set([
		"tool.started",
		"tool.finished",
		"harness.output-limit-exceeded",
		"harness.session-mismatch",
		"harness.runtime-changed",
		"harness.protocol-fault",
		"lifecycle.anomaly",
		"lifecycle.interrupted",
		"lifecycle.session-resumed",
		"compaction.started",
		"compaction.finished",
		"retry.started",
		"retry.finished",
		"config.thinking-changed",
		"extension.ui-requested",
	]);
	if (events.some((e) => forbidden.has(e.kind) || e.kind.startsWith("intervention.")))
		throw new Error("unexpected runtime event or intervention");
	const requested = events.filter((e) => e.kind === "control.requested");
	const accepted = events.filter((e) => e.kind === "control.accepted");
	if (
		requested.length !== count ||
		accepted.length !== count ||
		events.some((e) => e.kind === "control.refused") ||
		[...requested, ...accepted].some((e) => (e.payload as { action?: unknown }).action !== "prompt") ||
		accepted.some((e) => (e.payload as { disposition?: unknown }).disposition !== "started") ||
		events.some(
			(e) =>
				e.kind === "queue.changed" &&
				((e.payload as { steering?: unknown }).steering !== 0 ||
					(e.payload as { followUp?: unknown }).followUp !== 0),
		)
	)
		throw new Error("unexpected control or prompt count");
	const entries = events.filter((e) => e.kind === "session.entry-observed");
	let parent: string | null = null;
	let sawMessage = false;
	let settingsEntries = 0;
	let modelEntries = 0;
	const entryIds = new Set<string>();
	for (const entry of entries) {
		const value = entry.payload as unknown as {
			entryType: string;
			recognized?: boolean;
			parentId: string | null;
			source?: { sessionId?: string; entryId?: string };
			details?: { role?: string; thinkingLevel?: string; provider?: string; model?: string; modelId?: string };
		};
		if (
			value.source?.sessionId !== runtime.sessionId ||
			typeof value.source.entryId !== "string" ||
			value.source.entryId.length === 0 ||
			entryIds.has(value.source.entryId) ||
			value.parentId !== parent
		)
			throw new Error("session entry lineage mismatch");
		parent = value.source.entryId;
		entryIds.add(parent);
		if (value.recognized !== true) throw new Error("unexpected session entry");
		if (value.entryType === "model_change") {
			modelEntries += 1;
			if (
				sawMessage ||
				settingsEntries !== 0 ||
				modelEntries !== 1 ||
				value.details?.provider !== plan.initial.provider ||
				value.details.modelId !== plan.initial.model
			)
				throw new Error("unexpected session model selection");
		} else if (value.entryType === "thinking_level_change") {
			settingsEntries += 1;
			if (sawMessage || settingsEntries > 1 || value.details?.thinkingLevel !== "off")
				throw new Error("unexpected session setting");
		} else if (value.entryType === "message") {
			sawMessage = true;
			if (
				(value.details?.role === "assistant" &&
					(value.details.provider !== plan.initial.provider || value.details.model !== plan.initial.model)) ||
				(value.details?.provider !== undefined && value.details.provider !== plan.initial.provider) ||
				(value.details?.model !== undefined && value.details.model !== plan.initial.model)
			)
				throw new Error("session entry model mismatch");
		} else throw new Error("unexpected session entry");
	}
	const roles = entries
		.filter((e) => (e.payload as { entryType?: unknown }).entryType === "message")
		.map((e) => (e.payload as { details?: { role?: unknown } }).details?.role);
	if (!same(roles, count === 1 ? ["user", "assistant"] : ["user", "assistant", "user", "assistant"]))
		throw new Error("unexpected session message ordering");
	const trajectory = trajectoryFromStoreV0(store, `endo.session.pi.${runtime.sessionId}`);
	if (
		!trajectory.environment.reportedModels.includes(`${plan.initial.provider}/${plan.initial.model}`) ||
		trajectory.layers.toolCalls.status !== "reported" ||
		trajectory.layers.toolCalls.entries.length !== 0 ||
		trajectory.layers.toolResults.status !== "reported" ||
		trajectory.layers.toolResults.entries.length !== 0 ||
		trajectory.layers.outcome.status !== "reported" ||
		trajectory.layers.outcome.entries.length !== count ||
		trajectory.layers.outcome.entries.some((entry) => entry.outcome !== "completed")
	)
		throw new Error("trajectory incomplete or tool call observed");
	return { capture, events, requests, requestDigests, responseDigests, trajectory, first: first! };
}

function writeDispatch(area: string, marker: InitialContinuationDispatchV0): void {
	const file = join(area, `dispatch-${marker.turn}.json`);
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(marker));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const dir = openSync(area, "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}
function markerFor(
	key: EndoDigestKeyV0,
	plan: InitialContinuationPlanV0,
	runtime: Runtime,
	turn: 1 | 2,
	approval: InitialContinuationApprovalV0 | ContinuationTurnApprovalV0,
	boundary: InitialContinuationBoundaryV0 | null,
): InitialContinuationDispatchV0 {
	const body = {
		turn,
		attemptId: plan.initial.attemptId,
		planCommitment: plan.commitment,
		sessionId: runtime.sessionId,
		adaptedArchive: runtime.adaptedArchive,
		boundaryCommitment: boundary?.commitment ?? null,
		approvalCommitment: approvalDigest(key, approval),
		at: new Date().toISOString(),
	};
	return { ...body, commitment: dispatchDigest(key, body) };
}
function assertCurrentPlan(plan: InitialContinuationPlanV0, key: EndoDigestKeyV0): void {
	const { commitment, ...body } = plan;
	const { commitment: initialCommitment, ...initialBody } = plan.initial;
	if (
		!same(planDigest(key, body), commitment) ||
		!same(initialExecutionPlanDigestV0(key, initialBody), initialCommitment)
	)
		throw new Error("plan commitment mismatch");
	const parent = readVerifiedCheckpointCandidateV0(plan.initial.source, plan.initial.replay, key);
	if (
		parent.status !== "qualified" ||
		!same(parent.candidate.evidence.sourceCapture, plan.sourceCapture) ||
		!same(parent.candidate.evidence.replayCapture, plan.replayCapture)
	)
		throw new Error("parent evidence changed");
	const child = readVerifiedInitialBranchSetV0(
		plan.initial.source,
		plan.initial.replay,
		key,
		plan.initial.outputParent,
		plan.initial.preparation,
	);
	if (child.status !== "verified-pristine") throw new Error("prepared child changed");
}

export type InitialContinuationResultV0 =
	| { status: InitialContinuationReceiptV0["status"]; area: string; reason: string | null }
	| { status: "refused"; reason: string };

/**
 * One owned session, with a separate local approval callback after a provisional first-turn boundary.
 * The callback receives no session handle. Its wait is bounded by both the idle limit and the overall deadline.
 */
export async function executeInitialContinuationV0(
	inputPlan: InitialContinuationPlanV0,
	inputApproval: InitialContinuationApprovalV0 | null,
	firstPrompt: string,
	secondPrompt: string,
	key: EndoDigestKeyV0,
	requestContinuationApproval: (boundary: InitialContinuationBoundaryV0) => Promise<ContinuationTurnApprovalV0 | null>,
	signal?: AbortSignal,
): Promise<InitialContinuationResultV0> {
	let plan: InitialContinuationPlanV0;
	let approval: InitialContinuationApprovalV0;
	try {
		if (!isInitialContinuationPlanV0(inputPlan) || !isInitialContinuationApprovalV0(inputApproval, key.keyId))
			throw new Error("missing exact initial approval");
		plan = structuredClone(inputPlan);
		approval = structuredClone(inputApproval);
		if (
			approval.attemptId !== plan.initial.attemptId ||
			!same(approval.planCommitment, plan.commitment) ||
			!same(initialExecutionPromptDigestV0(key, firstPrompt), plan.initial.promptCommitment) ||
			!same(secondPromptDigest(key, secondPrompt), plan.continuationPromptCommitment)
		)
			throw new Error("initial approval or prompts changed");
		const age = Date.now() - Date.parse(approval.confirmedAt);
		if (!Number.isFinite(age) || age < 0 || age > 300000) throw new Error("initial approval stale");
		assertCurrentPlan(plan, key);
		const fresh = await preflightInitialChildExecutionV0({ ...plan.initial, prompt: firstPrompt }, key);
		if (
			fresh.status !== "ready" ||
			!same({ ...fresh.plan, attemptId: plan.initial.attemptId, commitment: plan.initial.commitment }, plan.initial)
		)
			throw new Error("execution plan or Pi identity changed");
		if (signal?.aborted) throw new Error("cancelled before dispatch");
	} catch (error) {
		return { status: "refused", reason: (error as Error).message.slice(0, 128) };
	}
	const area = join(plan.initial.outputParent, plan.initial.attemptId);
	try {
		mkdirSync(area, { mode: 0o700 });
	} catch {
		return { status: "refused", reason: "attempt already exists or output unavailable" };
	}
	const owned = lstatSync(area, { bigint: true });
	const deadline = Date.now() + plan.initial.wallTimeoutMs;
	// One monotonic watchdog covers startup, both turns, approval and finalisation, even if the wall clock moves.
	const monotonicDeadline = performance.now() + plan.initial.wallTimeoutMs;
	const timeoutAbort = new AbortController();
	const overallTimer = setTimeout(() => timeoutAbort.abort(), plan.initial.wallTimeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, timeoutAbort.signal]) : timeoutAbort.signal;
	const context: InitialRuntimeContextV0 = { session: null, proxy: null, log: null };
	let receipt = seal(key, {
		schemaVersion: ENDO_INITIAL_CONTINUATION_VERSION_V0,
		plan,
		firstApproval: approval,
		status: "approved-not-dispatched",
		runtime: null,
		dispatch1: null,
		boundary: null,
		secondApproval: null,
		dispatch2: null,
		observed: null,
		reason: null,
	});
	let grant: 1 | 2 | null = null;
	let grantDeadline = monotonicDeadline;
	let firstConversation: { messages: Record<string, unknown>[]; response: string } | undefined;
	let firstSettled = false;
	let secondSettled = false;
	const publish = () => publishInitialExecutionReceiptV0(area, receipt, owned);
	const admitRequest = (request: { method: string; path: string; body: Uint8Array }) => {
		const turn = grant;
		grant = null; // one-shot even when the request is malformed
		if (
			turn === null ||
			operationSignal.aborted ||
			performance.now() >= grantDeadline ||
			request.method !== "POST" ||
			request.path !== "/v1/chat/completions"
		)
			return false;
		try {
			const messages = requestMessages(request.body, plan.initial.model);
			if (turn === 2 && firstConversation === undefined) return false;
			checkRequest(messages, plan, key, turn === 1 ? undefined : firstConversation);
			return !operationSignal.aborted && performance.now() < grantDeadline;
		} catch {
			return false;
		}
	};
	const admitResponse = (response: { status: number; wire: Uint8Array }) => {
		try {
			if (response.status !== 200 || operationSignal.aborted || performance.now() >= monotonicDeadline) return false;
			responseText(response.wire, plan.initial.model);
			return !operationSignal.aborted && performance.now() < monotonicDeadline;
		} catch {
			return false;
		}
	};
	try {
		publish();
		const started = await startInitialRuntimeV0(
			plan.initial,
			key,
			area,
			deadline,
			operationSignal,
			context,
			(runtime) => {
				receipt = seal(key, { ...receipt, runtime });
				publish();
			},
			admitRequest,
			admitResponse,
		);
		const { session, proxy, log, runtime, store, adaptedBytes } = started;
		if (operationSignal.aborted || performance.now() >= monotonicDeadline)
			throw new Error(signal?.aborted ? "cancelled" : "timeout");
		const firstApprovalAge = Date.now() - Date.parse(approval.confirmedAt);
		if (
			!session.live ||
			session.pid === undefined ||
			proxy.refusedRequests !== 0 ||
			proxy.refusedResponses !== 0 ||
			firstApprovalAge < 0 ||
			firstApprovalAge > 300000
		)
			throw new Error("fresh session unavailable or initial approval stale");
		let marker = markerFor(key, plan, receipt.runtime!, 1, approval, null);
		writeDispatch(area, marker);
		receipt = seal(key, { ...receipt, dispatch1: marker, status: "initial-dispatched" });
		publish();
		if (operationSignal.aborted || performance.now() >= monotonicDeadline)
			throw new Error(signal?.aborted ? "cancelled" : "timeout");
		grant = 1;
		const initialAbort = new AbortController();
		const initialSettled = session.waitForSettled(Math.max(1, deadline - Date.now()), initialAbort.signal);
		void initialSettled.catch(() => {});
		try {
			if (
				(await withinDeadline(session.prompt(firstPrompt), deadline, operationSignal)) !== "started" ||
				!(await withinDeadline(initialSettled, deadline, operationSignal))
			)
				throw new Error("initial turn did not settle");
		} finally {
			initialAbort.abort();
		}
		firstSettled = true;
		await withinDeadline(proxy.flush(), deadline, operationSignal);
		if (
			!session.live ||
			session.outputLimitExceeded ||
			proxy.open !== 0 ||
			proxy.recordingFailures !== 0 ||
			proxy.transferLimitExceeded ||
			proxy.refusedRequests !== 0 ||
			proxy.refusedResponses !== 0
		)
			throw new Error("first-turn evidence incomplete");
		const state = await withinDeadline(session.rpcState(), deadline, operationSignal);
		if (
			state.sessionId !== receipt.runtime!.sessionId ||
			state.model?.provider !== plan.initial.provider ||
			state.model.id !== plan.initial.model ||
			state.messageCount !== 2 ||
			state.pendingMessageCount !== 0 ||
			state.isStreaming ||
			state.isCompacting ||
			state.thinkingLevel !== "off"
		)
			throw new Error("first-turn session boundary mismatch");
		const observed = inspectEvidence(plan, receipt.runtime!, key, 1);
		if (observed.events.some((event) => event.kind === "harness.process-exited"))
			throw new Error("Pi exited before continuation boundary");
		const boundaryBytes = archiveEndoWorkspaceV0(runtime).bytes;
		if (boundaryBytes.length > 16 * 1024 * 1024 || !sameInitialStartupRuntimeV0(adaptedBytes, boundaryBytes))
			throw new Error("runtime changed during first turn");
		const boundaryArchive = createEndoBlobStoreV0(store, key).put(boundaryBytes).digest;
		const observedAt = Date.now();
		const idleDeadline = Math.min(monotonicDeadline, performance.now() + plan.maxApprovalIdleMs);
		const boundaryBody = {
			attemptId: plan.initial.attemptId,
			planCommitment: plan.commitment,
			sessionId: receipt.runtime!.sessionId,
			pid: session.pid!,
			provider: plan.initial.provider,
			model: plan.initial.model,
			toolPolicy: "none" as const,
			continuationPromptCommitment: plan.continuationPromptCommitment,
			adaptedArchive: receipt.runtime!.adaptedArchive,
			boundaryArchive,
			firstRequestEventId: observed.requests[0]!.id,
			firstRequestDigest: observed.requestDigests[0]!,
			firstResponseDigest: observed.responseDigests[0]!,
			firstTrajectoryIdentity: observed.trajectory.digest,
			capturePrefixCount: observed.capture.length,
			capturePrefixCommitment: captureGenerationV0(observed.capture, key),
			storePrefixCount: observed.events.length,
			storePrefixCommitment: key.digest(observed.events),
			observedAt: new Date(observedAt).toISOString(),
			deadlineAt: new Date(deadline).toISOString(),
			approvalDeadlineAt: new Date(Math.min(deadline, observedAt + plan.maxApprovalIdleMs)).toISOString(),
			remainingTransferredBytes: Math.max(0, plan.initial.maxTransferredBytes - proxy.transferredBytes),
			remainingRpcOutputBytes: Math.max(0, plan.maxRpcOutputBytes - session.outputBytes),
		};
		const boundary: InitialContinuationBoundaryV0 = {
			...boundaryBody,
			commitment: boundaryDigest(key, boundaryBody),
		};
		firstConversation = observed.first;
		receipt = seal(key, { ...receipt, boundary, status: "awaiting-approval" });
		publish();
		let nextApproval: ContinuationTurnApprovalV0 | null = null;
		const idleAbort = new AbortController();
		const idleTimer = setTimeout(() => idleAbort.abort(), Math.max(0, idleDeadline - performance.now()));
		try {
			nextApproval = await withinDeadline(
				Promise.resolve().then(() => requestContinuationApproval(structuredClone(boundary))),
				Date.parse(boundary.approvalDeadlineAt),
				AbortSignal.any([operationSignal, idleAbort.signal]),
			);
		} catch (error) {
			if (operationSignal.aborted) throw error;
		} finally {
			clearTimeout(idleTimer);
		}
		if (
			!isContinuationTurnApprovalV0(nextApproval, key.keyId) ||
			nextApproval.attemptId !== plan.initial.attemptId ||
			!same(nextApproval.boundaryCommitment, boundary.commitment) ||
			Date.parse(nextApproval.confirmedAt) < observedAt ||
			Date.parse(nextApproval.confirmedAt) > Date.parse(boundary.approvalDeadlineAt) ||
			Date.now() > Date.parse(boundary.approvalDeadlineAt) ||
			performance.now() >= idleDeadline
		)
			throw new Error("continuation approval unavailable or stale");
		nextApproval = structuredClone(nextApproval);
		receipt = seal(key, { ...receipt, secondApproval: nextApproval, status: "continuation-approved-not-dispatched" });
		publish();
		if (!session.live || session.pid !== boundary.pid || session.piSessionId !== boundary.sessionId)
			throw new Error("same Pi process is no longer live");
		const nextState = await withinDeadline(session.rpcState(), deadline, operationSignal);
		if (
			!session.live ||
			session.pid !== boundary.pid ||
			nextState.sessionId !== boundary.sessionId ||
			nextState.model?.provider !== boundary.provider ||
			nextState.model.id !== boundary.model ||
			nextState.messageCount !== 2 ||
			nextState.pendingMessageCount !== 0 ||
			nextState.isStreaming ||
			nextState.isCompacting ||
			nextState.thinkingLevel !== "off"
		)
			throw new Error("same session state changed");
		await withinDeadline(proxy.flush(), deadline, operationSignal);
		const current = inspectEvidence(plan, receipt.runtime!, key, 1);
		if (
			proxy.open !== 0 ||
			proxy.refusedRequests !== 0 ||
			proxy.refusedResponses !== 0 ||
			proxy.recordingFailures !== 0 ||
			proxy.transferLimitExceeded ||
			!same(key.digest(current.events.slice(0, boundary.storePrefixCount)), boundary.storePrefixCommitment) ||
			!same(
				captureGenerationV0(current.capture.slice(0, boundary.capturePrefixCount), key),
				boundary.capturePrefixCommitment,
			) ||
			current.trajectory.digest !== boundary.firstTrajectoryIdentity ||
			current.events.some((event) => event.kind === "harness.process-exited") ||
			!sameInitialStartupRuntimeV0(boundaryBytes, archiveEndoWorkspaceV0(runtime).bytes)
		)
			throw new Error("first-turn boundary changed");
		assertCurrentPlan(plan, key);
		const refreshed = await withinDeadline(
			preflightInitialChildExecutionV0({ ...plan.initial, prompt: firstPrompt }, key),
			deadline,
			operationSignal,
		);
		if (
			refreshed.status !== "ready" ||
			!same(
				{ ...refreshed.plan, attemptId: plan.initial.attemptId, commitment: plan.initial.commitment },
				plan.initial,
			)
		)
			throw new Error("lineage or Pi identity changed before continuation");
		const finalState = await withinDeadline(session.rpcState(), deadline, operationSignal);
		await withinDeadline(proxy.flush(), deadline, operationSignal);
		const finalBoundary = inspectEvidence(plan, receipt.runtime!, key, 1);
		assertCurrentPlan(plan, key);
		if (
			Date.now() > Date.parse(boundary.approvalDeadlineAt) ||
			operationSignal.aborted ||
			performance.now() >= idleDeadline ||
			boundary.remainingTransferredBytes === 0 ||
			boundary.remainingRpcOutputBytes === 0 ||
			!session.live ||
			session.outputLimitExceeded ||
			session.pid !== boundary.pid ||
			finalState.sessionId !== boundary.sessionId ||
			finalState.model?.provider !== boundary.provider ||
			finalState.model.id !== boundary.model ||
			finalState.messageCount !== 2 ||
			finalState.pendingMessageCount !== 0 ||
			finalState.isStreaming ||
			finalState.isCompacting ||
			finalState.thinkingLevel !== "off" ||
			proxy.refusedRequests !== 0 ||
			proxy.refusedResponses !== 0 ||
			proxy.open !== 0 ||
			proxy.recordingFailures !== 0 ||
			proxy.transferLimitExceeded ||
			!sameInitialStartupRuntimeV0(boundaryBytes, archiveEndoWorkspaceV0(runtime).bytes) ||
			finalBoundary.trajectory.digest !== boundary.firstTrajectoryIdentity ||
			!same(key.digest(finalBoundary.events.slice(0, boundary.storePrefixCount)), boundary.storePrefixCommitment) ||
			!same(
				captureGenerationV0(finalBoundary.capture.slice(0, boundary.capturePrefixCount), key),
				boundary.capturePrefixCommitment,
			)
		)
			throw new Error(signal?.aborted ? "cancelled" : "continuation approval stale or boundary changed");
		marker = markerFor(key, plan, receipt.runtime!, 2, nextApproval, boundary);
		writeDispatch(area, marker);
		receipt = seal(key, {
			...receipt,
			secondApproval: nextApproval,
			dispatch2: marker,
			status: "continuation-dispatched",
		});
		publish();
		if (operationSignal.aborted || performance.now() >= monotonicDeadline || performance.now() >= idleDeadline)
			throw new Error(signal?.aborted ? "cancelled" : "continuation approval expired before dispatch");
		grantDeadline = idleDeadline;
		grant = 2;
		const secondAbort = new AbortController();
		const settled = session.waitForSettled(Math.max(1, deadline - Date.now()), secondAbort.signal);
		void settled.catch(() => {});
		try {
			if (
				(await withinDeadline(session.prompt(secondPrompt), deadline, operationSignal)) !== "started" ||
				!(await withinDeadline(settled, deadline, operationSignal))
			)
				throw new Error("continuation did not settle");
		} finally {
			secondAbort.abort();
		}
		secondSettled = true;
		await withinDeadline(session.close(), deadline, operationSignal);
		if (session.outputLimitExceeded) throw new Error("runtime stdout limit exceeded");
		context.session = null;
		await withinDeadline(proxy.flush(), deadline, operationSignal);
		if (
			proxy.open !== 0 ||
			proxy.recordingFailures !== 0 ||
			proxy.transferLimitExceeded ||
			proxy.refusedRequests !== 0 ||
			proxy.refusedResponses !== 0
		)
			throw new Error("final capture incomplete");
		await withinDeadline(proxy.close(), deadline, operationSignal);
		context.proxy = null;
		log.close();
		context.log = null;
		const postBytes = archiveEndoWorkspaceV0(runtime).bytes;
		if (postBytes.length > 16 * 1024 * 1024 || !sameInitialStartupRuntimeV0(adaptedBytes, postBytes))
			throw new Error("runtime changed during continuation");
		const post = createEndoBlobStoreV0(store, key).put(postBytes);
		const runtimeReceipt = { ...receipt.runtime!, postExecutionArchive: post.digest };
		const final = inspectEvidence(plan, runtimeReceipt, key, 2);
		const finalObserved = {
			requestEventIds: final.requests.map((event) => event.id),
			requestDigests: final.requestDigests,
			responseDigests: final.responseDigests,
			trajectoryIdentity: final.trajectory.digest,
			captureGeneration: captureGenerationV0(final.capture, key),
			storeGeneration: key.digest(final.events),
		};
		receipt = seal(key, {
			...receipt,
			status: "completed",
			runtime: runtimeReceipt,
			observed: finalObserved,
			reason: null,
		});
		publish();
		const verified = await withinDeadline(
			verifyInitialContinuationEvidenceV0(plan.initial.source, plan.initial.replay, key, join(area, "receipt.json")),
			deadline,
			operationSignal,
		);
		if (verified.status !== "verified")
			throw new Error(`final evidence ${verified.status === "unverified" ? verified.reason : "incomplete"}`);
		return { status: "completed", area, reason: null };
	} catch (error) {
		const reason =
			!signal?.aborted && timeoutAbort.signal.aborted ? "timeout" : (error as Error).message.slice(0, 128);
		grant = null;
		let stopped = true;
		try {
			await context.session?.terminate();
		} catch {
			stopped = false;
		}
		try {
			await context.proxy?.close();
		} catch {
			stopped = false;
		}
		try {
			context.log?.close();
		} catch {
			stopped = false;
		}
		let status: InitialContinuationReceiptV0["status"] =
			reason === "cancelled" && stopped
				? "cancelled"
				: receipt.dispatch2 !== null
					? "outcome-unknown"
					: receipt.boundary !== null
						? receipt.secondApproval === null
							? "first-completed-not-approved"
							: "failed"
						: receipt.dispatch1 !== null
							? "outcome-unknown"
							: "failed";
		// Settlement alone is not a successful response. Only an observed second completed lifecycle can be
		// classified as completed-but-unverifiable when later evidence checks fail.
		if (secondSettled && receipt.runtime !== null) {
			try {
				const events = readEndoStoreEventsV0(receipt.runtime.store);
				if (
					events.filter((event) => event.kind === "lifecycle.run-completed").length === 2 &&
					!events.some((event) =>
						["lifecycle.run-failed", "lifecycle.run-aborted", "lifecycle.run-unclassified"].includes(event.kind),
					)
				)
					status = "completed-unverifiable";
			} catch {
				/* Incomplete evidence cannot establish successful settlement. */
			}
		}
		let runtime = receipt.runtime;
		let observed = receipt.observed;
		try {
			if (firstSettled && receipt.dispatch2 === null && runtime !== null && stopped) {
				const post = archiveEndoWorkspaceV0(runtime.root).bytes;
				const adapted = createEndoBlobStoreV0(runtime.store, key, { readOnly: true }).get(runtime.adaptedArchive);
				if (post.length <= 16 * 1024 * 1024 && sameInitialStartupRuntimeV0(adapted, post)) {
					runtime = {
						...runtime,
						postExecutionArchive: createEndoBlobStoreV0(runtime.store, key).put(post).digest,
					};
					const seen = inspectEvidence(plan, runtime, key, 1);
					observed = {
						requestEventIds: seen.requests.map((e) => e.id),
						requestDigests: seen.requestDigests,
						responseDigests: seen.responseDigests,
						trajectoryIdentity: seen.trajectory.digest,
						captureGeneration: captureGenerationV0(seen.capture, key),
						storeGeneration: key.digest(seen.events),
					};
				}
			}
		} catch {
			/* Preserve the failure even if no final first-turn observation can be recovered. */
		}
		try {
			receipt = seal(key, { ...receipt, status, runtime, observed, reason });
			publish();
		} catch {
			/* The last durable state remains conservative. */
		}
		return { status, area, reason };
	} finally {
		clearTimeout(overallTimer);
	}
}

export type InitialContinuationEvidenceReadV0 =
	| { status: "verified"; attemptId: string }
	| { status: "first-turn-verified"; attemptId: string; outcome: string }
	| { status: "unverified"; reason: string; outcome: string };

/** Independently re-read the durable receipt, dispatch files, lineage, capture and Pi trajectory. */
export async function verifyInitialContinuationEvidenceV0(
	source: string,
	replay: string,
	key: EndoDigestKeyV0,
	file: string,
): Promise<InitialContinuationEvidenceReadV0> {
	let outcome = "unreadable";
	try {
		const text = initialExecutionPrivateFileV0(file, ENDO_INITIAL_CONTINUATION_MAX_BYTES_V0);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("receipt JSON malformed");
		}
		if (text !== canonicalEndoJsonV0(parsed)) throw new Error("receipt encoding invalid");
		const r = readInitialContinuationReceiptV0(parsed);
		if (r === null) throw new Error("receipt schema invalid");
		outcome = r.status;
		if (
			file !== join(r.plan.initial.outputParent, r.plan.initial.attemptId, "receipt.json") ||
			basename(file) !== "receipt.json" ||
			basename(dirname(file)) !== r.plan.initial.attemptId ||
			r.plan.initial.source !== source ||
			r.plan.initial.replay !== replay
		)
			throw new Error("receipt path or source mismatch");
		const { commitment, ...body } = r;
		if (!same(receiptDigest(key, body), commitment)) throw new Error("receipt commitment mismatch");
		const markerExists = (turn: number) => {
			try {
				lstatSync(join(dirname(file), `dispatch-${turn}.json`));
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		};
		if ((r.dispatch1 === null && markerExists(1)) || (r.dispatch2 === null && markerExists(2))) {
			outcome = "outcome-unknown";
			throw new Error("a dispatch marker exists beyond the last published receipt");
		}
		assertCurrentPlan(r.plan, key);
		if (
			r.firstApproval.attemptId !== r.plan.initial.attemptId ||
			!same(r.firstApproval.planCommitment, r.plan.commitment)
		)
			throw new Error("first approval mismatch");
		if (
			!["completed", "first-completed-not-approved", "failed", "cancelled"].includes(r.status) ||
			(r.status !== "completed" && r.dispatch2 !== null)
		)
			throw new Error("attempt not completed");
		if (!r.runtime || !r.runtime.postExecutionArchive || !r.boundary || !r.dispatch1 || !r.observed)
			throw new Error("closed evidence unavailable");
		const runtime = r.runtime,
			boundary = r.boundary;
		verifyInitialExecutionLineageV0(source, replay, key, r.plan.initial, runtime);
		const adapted = createEndoBlobStoreV0(runtime.store, key, { readOnly: true }).get(runtime.adaptedArchive);
		const post = createEndoBlobStoreV0(runtime.store, key, { readOnly: true }).get(runtime.postExecutionArchive!);
		const middle = createEndoBlobStoreV0(runtime.store, key, { readOnly: true }).get(boundary.boundaryArchive);
		if (!sameInitialStartupRuntimeV0(adapted, middle) || !sameInitialStartupRuntimeV0(adapted, post))
			throw new Error("unexpected runtime mutation");
		const { commitment: boundaryCommitment, ...boundaryBody } = boundary;
		if (
			!same(boundaryDigest(key, boundaryBody), boundaryCommitment) ||
			boundary.attemptId !== r.plan.initial.attemptId ||
			!same(boundary.planCommitment, r.plan.commitment) ||
			boundary.sessionId !== runtime.sessionId ||
			!same(boundary.adaptedArchive, runtime.adaptedArchive) ||
			!same(boundary.continuationPromptCommitment, r.plan.continuationPromptCommitment) ||
			boundary.provider !== r.plan.initial.provider ||
			boundary.model !== r.plan.initial.model ||
			boundary.remainingTransferredBytes > r.plan.initial.maxTransferredBytes ||
			boundary.remainingRpcOutputBytes > r.plan.maxRpcOutputBytes
		)
			throw new Error("boundary commitment mismatch");
		const checkMarker = (
			marker: InitialContinuationDispatchV0,
			turn: 1 | 2,
			approval: InitialContinuationApprovalV0 | ContinuationTurnApprovalV0,
		) => {
			const markerText = initialExecutionPrivateFileV0(join(dirname(file), `dispatch-${turn}.json`), 8192);
			if (
				markerText !== canonicalEndoJsonV0(marker) ||
				marker.turn !== turn ||
				marker.attemptId !== r.plan.initial.attemptId ||
				marker.sessionId !== runtime.sessionId ||
				!same(marker.planCommitment, r.plan.commitment) ||
				!same(marker.adaptedArchive, runtime.adaptedArchive) ||
				!same(marker.approvalCommitment, approvalDigest(key, approval))
			)
				throw new Error("dispatch marker mismatch");
			const { commitment: markerCommitment, ...markerBody } = marker;
			if (
				!same(dispatchDigest(key, markerBody), markerCommitment) ||
				(turn === 1 ? marker.boundaryCommitment !== null : !same(marker.boundaryCommitment, boundary.commitment))
			)
				throw new Error("dispatch marker commitment mismatch");
		};
		checkMarker(r.dispatch1, 1, r.firstApproval);
		const firstAt = Date.parse(r.dispatch1.at),
			firstApprovedAt = Date.parse(r.firstApproval.confirmedAt),
			boundaryAt = Date.parse(boundary.observedAt),
			deadline = Date.parse(boundary.deadlineAt),
			approvalDeadline = Date.parse(boundary.approvalDeadlineAt);
		if (
			firstAt < firstApprovedAt ||
			firstAt - firstApprovedAt > 300000 ||
			boundaryAt < firstAt ||
			deadline < boundaryAt ||
			deadline - firstAt > r.plan.initial.wallTimeoutMs ||
			approvalDeadline < boundaryAt ||
			approvalDeadline > deadline ||
			approvalDeadline - boundaryAt > r.plan.maxApprovalIdleMs
		)
			throw new Error("invalid authorization or deadline order");
		const count = r.status === "completed" ? 2 : 1;
		if (count === 2) {
			if (
				!r.secondApproval ||
				!r.dispatch2 ||
				r.secondApproval.attemptId !== r.plan.initial.attemptId ||
				!same(r.secondApproval.boundaryCommitment, boundary.commitment)
			)
				throw new Error("second approval missing");
			checkMarker(r.dispatch2, 2, r.secondApproval);
			const approvedAt = Date.parse(r.secondApproval.confirmedAt),
				secondAt = Date.parse(r.dispatch2.at);
			if (
				approvedAt < boundaryAt ||
				approvedAt > approvalDeadline ||
				secondAt < approvedAt ||
				secondAt > approvalDeadline ||
				secondAt > deadline
			)
				throw new Error("second approval expired or out of order");
		} else {
			if (r.dispatch2 !== null || (r.status === "first-completed-not-approved" && r.secondApproval !== null))
				throw new Error("unexpected continuation authority");
			if (r.secondApproval !== null) {
				const approvedAt = Date.parse(r.secondApproval.confirmedAt);
				if (
					r.secondApproval.attemptId !== r.plan.initial.attemptId ||
					!same(r.secondApproval.boundaryCommitment, boundary.commitment) ||
					approvedAt < boundaryAt ||
					approvedAt > approvalDeadline
				)
					throw new Error("second approval mismatch");
			}
		}
		const fingerprint = await fingerprintPiRuntimeV0({
			attachment: "pi.initial-child",
			executable: r.plan.initial.piExecutable,
			cwd: r.plan.initial.outputParent,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: r.plan.initial.outputParent,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		});
		if (
			fingerprint.identity.digest !== r.plan.initial.piIdentity ||
			fingerprint.reported.version !== r.plan.initial.piVersion
		)
			throw new Error("Pi binary identity changed");
		const seen = inspectEvidence(r.plan, runtime, key, count);
		if (
			!same(
				seen.requests.map((e) => e.id),
				r.observed.requestEventIds,
			) ||
			!same(seen.requestDigests, r.observed.requestDigests) ||
			!same(seen.responseDigests, r.observed.responseDigests) ||
			seen.trajectory.digest !== r.observed.trajectoryIdentity ||
			!same(captureGenerationV0(seen.capture, key), r.observed.captureGeneration) ||
			!same(key.digest(seen.events), r.observed.storeGeneration)
		)
			throw new Error("final evidence changed");
		if (
			boundary.capturePrefixCount > seen.capture.length ||
			boundary.storePrefixCount > seen.events.length ||
			!same(
				captureGenerationV0(seen.capture.slice(0, boundary.capturePrefixCount), key),
				boundary.capturePrefixCommitment,
			) ||
			!same(key.digest(seen.events.slice(0, boundary.storePrefixCount)), boundary.storePrefixCommitment)
		)
			throw new Error("first-turn boundary evidence changed");
		const prefixCapture = seen.capture.slice(0, boundary.capturePrefixCount);
		const prefixStore = seen.events.slice(0, boundary.storePrefixCount);
		const firstRequests = prefixCapture.filter(
			(e) => e.kind === "capture.request" && e.producer === "capture:record",
		);
		const firstEnds = prefixCapture.filter(
			(e) => e.kind === "capture.exchange-ended" && e.producer === "capture:record",
		);
		const prefixTrajectory = projectPiTrajectoryV0(prefixStore, {
			store: runtime.store,
			session: `endo.session.pi.${runtime.sessionId}`,
		});
		if (
			firstRequests.length !== 1 ||
			firstEnds.length !== 1 ||
			firstRequests[0]!.id !== boundary.firstRequestEventId ||
			!same(seen.requestDigests[0], boundary.firstRequestDigest) ||
			!same(seen.responseDigests[0], boundary.firstResponseDigest) ||
			prefixTrajectory.digest !== boundary.firstTrajectoryIdentity ||
			prefixStore.some((e) => e.kind === "harness.process-exited")
		)
			throw new Error("first-turn observation mismatch");
		const exits = seen.events.filter((e) => e.kind === "harness.process-exited");
		if (exits.length !== 1 || (exits[0]!.payload as { expected?: unknown }).expected !== true)
			throw new Error("closed Pi process evidence unavailable");
		return count === 2
			? { status: "verified", attemptId: r.plan.initial.attemptId }
			: { status: "first-turn-verified", attemptId: r.plan.initial.attemptId, outcome: r.status };
	} catch (error) {
		return { status: "unverified", reason: (error as Error).message.slice(0, 128), outcome };
	}
}
