// The Coordinator Model Pool on the host (M1): reading an operator's pool file, `endo coordinator pool check`, and the pooled briefing
// substrate that selects one member by zero-token observation and then runs the unchanged M0 briefing against that member alone.
//
// Selection and inference are separate steps. A healthy observation does not promise the inference request will succeed, and an
// inference failure never moves the briefing to another member: the conversation is not replayed, a refusal is not retried elsewhere,
// and the result is the selected member's result or unavailable. Nothing here writes to the store or any other durable state.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
	ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0,
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	type EndoCoordinatorModelPoolV0,
	orderedCoordinatorPoolMembersV0,
	parseEndoCoordinatorModelPoolV0,
} from "../../protocol/coordinator-model-pool.ts";
import type {
	EndoCoordinatorBriefRequestV0,
	EndoCoordinatorBriefResultV0,
	EndoCoordinatorBriefSubstrateV0,
} from "../../runtime/contracts/coordinator-brief.ts";
import {
	coordinatorModelPoolSha256V0,
	type EndoCoordinatorMemberObservationV0,
	type EndoCoordinatorMemberObserverV0,
	type EndoCoordinatorModelPoolCheckV0,
	type EndoCoordinatorModelPoolProvenanceV0,
	type EndoCoordinatorPoolMeasurementsV0,
	selectCoordinatorModelV0,
} from "../../runtime/contracts/coordinator-model-pool.ts";
import { probeLocalEndpointV0 } from "./model-pool-probe.ts";
import { coordinatorTargetFromMemberV0, ENDO_COORDINATOR_M0_TARGET_V0 } from "./model-relay.ts";
import type { OpenClawCoordinatorTrialV0, runOpenClawCoordinatorV0 } from "./openclaw.ts";

/** M0's single endpoint as a pool, for `pool check` without `--pool`. `brief` without `--pool` keeps the M0 path itself. */
export const ENDO_COORDINATOR_M0_POOL_V0: EndoCoordinatorModelPoolV0 = parseEndoCoordinatorModelPoolV0({
	schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	selection: { fallback: "none", unconfirmedModel: "permit" },
	members: [
		{
			memberId: "m0-default",
			kind: "local-openai-compat",
			endpoint: ENDO_COORDINATOR_M0_TARGET_V0.origin,
			modelId: ENDO_COORDINATOR_M0_TARGET_V0.model,
			priority: 0,
			maxPromptBytes: ENDO_COORDINATOR_M0_TARGET_V0.maxPromptBytes,
			maxOutputTokens: ENDO_COORDINATOR_M0_TARGET_V0.maxOutputTokens,
			timeoutMs: ENDO_COORDINATOR_M0_TARGET_V0.timeoutMs,
			advisoryOnly: true,
		},
	],
});

/** Whether any object in a JSON text repeats a key (after escapes are decoded). The text is known to parse. */
function jsonKeysRepeat(text: string): boolean {
	const stack: (Set<string> | null)[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const keys = stack.at(-1);
			if (keys) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k] as string)) k++;
				if (text[k] === ":") {
					const key = JSON.parse(text.slice(i, j + 1)) as string;
					if (keys.has(key)) return true;
					keys.add(key);
				}
			}
			i = j;
		} else if (ch === "{") stack.push(new Set());
		else if (ch === "[") stack.push(null);
		else if (ch === "}" || ch === "]") stack.pop();
	}
	return false;
}

/**
 * Read and validate a pool file: a regular file (its final component not a symbolic link), at most 64 KiB of UTF-8 JSON, no repeated
 * keys, and the closed `endo.coordinator-model-pool.v0` schema. Throws a TypeError naming the file and the first problem; never
 * contacts an endpoint.
 */
export function readCoordinatorModelPoolFileV0(path: string): EndoCoordinatorModelPoolV0 {
	const refuse = (detail: string): never => {
		throw new TypeError(`pool file ${JSON.stringify(path)}: ${detail}`);
	};
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		return refuse(`cannot be opened (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	let text: string;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) refuse("is not a regular file");
		if (stat.size > ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.fileBytes) refuse("is larger than 64 KiB");
		const buffer = Buffer.alloc(ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.fileBytes + 1);
		let length = 0;
		for (;;) {
			const n = readSync(fd, buffer, length, buffer.length - length, null);
			if (n === 0) break;
			length += n;
			if (length > ENDO_COORDINATOR_MODEL_POOL_LIMITS_V0.fileBytes) refuse("is larger than 64 KiB");
		}
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith("pool file")) throw error;
		return refuse("is not readable UTF-8");
	} finally {
		closeSync(fd);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return refuse("is not JSON");
	}
	if (jsonKeysRepeat(text)) refuse("repeats a key, which is ambiguous");
	try {
		return parseEndoCoordinatorModelPoolV0(value);
	} catch (error) {
		return refuse((error as Error).message);
	}
}

/** `endo coordinator pool check`: observe every local member (zero tokens), and say what a briefing would select now. */
export async function checkCoordinatorModelPoolV0(
	pool: EndoCoordinatorModelPoolV0,
	source: "file" | "m0-default",
	observe: EndoCoordinatorMemberObserverV0 = (member) => probeLocalEndpointV0(member),
): Promise<EndoCoordinatorModelPoolCheckV0> {
	const observed = new Map<string, EndoCoordinatorMemberObservationV0>();
	const members: EndoCoordinatorModelPoolCheckV0["members"][number][] = [];
	for (const member of orderedCoordinatorPoolMembersV0(pool)) {
		if (member.kind !== "local-openai-compat") {
			members.push({
				memberId: member.memberId,
				kind: "hosted-relay",
				observation: null,
				reason: "hosted-not-permitted",
			});
			continue;
		}
		const observation = await observe(member);
		observed.set(member.memberId, observation);
		members.push({ memberId: member.memberId, kind: "local-openai-compat", observation });
	}
	const selection = await selectCoordinatorModelV0(pool, {}, async (member) => {
		const observation = observed.get(member.memberId);
		if (observation === undefined) throw new TypeError("pool check observed every local member");
		return observation;
	});
	return {
		schemaVersion: "endo.coordinator-model-pool-check.v0",
		source,
		poolSha256: coordinatorModelPoolSha256V0(pool),
		inferenceTokens: 0,
		members,
		selection: selection.ok
			? {
					ok: true,
					selectedMemberId: selection.member.memberId,
					capacityConfirmed: selection.observation.readiness === "ready",
					fallbackOccurred: selection.fallbackOccurred,
					skippedMembers: selection.skippedMembers,
				}
			: { ok: false, refusal: selection.refusal, skippedMembers: selection.skippedMembers },
	};
}

const count = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function usage(
	trial: OpenClawCoordinatorTrialV0 | null,
): Pick<EndoCoordinatorPoolMeasurementsV0, "promptTokens" | "completionTokens"> {
	let prompt: number | null = null;
	let completion: number | null = null;
	for (const response of trial?.wire.responses ?? []) {
		const u = response.usage as Record<string, unknown> | null;
		if (u === null || typeof u !== "object") continue;
		const p = count(u.prompt_tokens);
		const c = count(u.completion_tokens);
		if (p !== null) prompt = (prompt ?? 0) + p;
		if (c !== null) completion = (completion ?? 0) + c;
	}
	return { promptTokens: prompt, completionTokens: completion };
}

const providerLabel = (observation: EndoCoordinatorMemberObservationV0) =>
	observation.backend === "llama.cpp-router" || observation.backend === "llama.cpp-single"
		? `llama.cpp ${observation.build ?? "(unidentified)"}`
		: "openai-compatible (unidentified)";

/**
 * The pooled briefing substrate. `run` is the M0 runner (injected for tests); it receives the selected member's frozen target and
 * nothing else that could pick another member.
 */
export function pooledCoordinatorV0(
	root: string,
	pool: EndoCoordinatorModelPoolV0,
	options: {
		readonly memberId?: string;
		readonly observe?: EndoCoordinatorMemberObserverV0;
		readonly run?: typeof runOpenClawCoordinatorV0;
		readonly signal?: AbortSignal;
	} = {},
): EndoCoordinatorBriefSubstrateV0 {
	const poolSha256 = coordinatorModelPoolSha256V0(pool);
	const observe = options.observe ?? ((member) => probeLocalEndpointV0(member, { signal: options.signal }));
	return {
		async brief(request: EndoCoordinatorBriefRequestV0): Promise<EndoCoordinatorBriefResultV0> {
			const started = performance.now();
			const selection = await selectCoordinatorModelV0(
				pool,
				options.memberId === undefined ? {} : { memberId: options.memberId },
				observe,
			);
			const observationElapsedMs = Math.round(performance.now() - started);
			const provenance = (
				measurements: Omit<EndoCoordinatorPoolMeasurementsV0, "observationElapsedMs">,
			): EndoCoordinatorModelPoolProvenanceV0 => ({
				schemaVersion: "endo.coordinator-model-pool-provenance.v0",
				poolSha256,
				selectionMode: selection.mode,
				requestedMemberId: selection.requestedMemberId,
				selectedMemberId: selection.ok ? selection.member.memberId : null,
				selectedModelId: selection.ok ? selection.member.modelId : null,
				selectedEndpoint: selection.ok ? selection.member.endpoint : null,
				selectedReadiness: selection.ok ? selection.observation.readiness : null,
				capacityConfirmed: selection.ok && selection.observation.readiness === "ready",
				fallbackOccurred: selection.ok && selection.fallbackOccurred,
				skippedMembers: selection.skippedMembers,
				inferenceFailover: "never",
				measurements: { observationElapsedMs, ...measurements },
			});
			if (!selection.ok)
				return {
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: request.projectId,
					runtime: {
						harness: (await import("./openclaw.ts")).ENDO_COORDINATOR_HARNESS_V0,
						provider: "none",
						model: "none",
					},
					modelPool: provenance({
						inferenceElapsedMs: null,
						promptTokens: null,
						completionTokens: null,
						exchanges: null,
						failureCategory: selection.refusal,
					}),
					availability: "unavailable",
					reason: selection.refusal,
				};
			const target = coordinatorTargetFromMemberV0(selection.member);
			const run = options.run ?? (await import("./openclaw.ts")).runOpenClawCoordinatorV0;
			let trial: OpenClawCoordinatorTrialV0 | null = null;
			const result = await run(root, request, {
				target,
				provider: providerLabel(selection.observation),
				...(options.signal === undefined ? {} : { signal: options.signal }),
				trial: (t) => {
					trial = t;
				},
			});
			const observedTrial = trial as OpenClawCoordinatorTrialV0 | null;
			const modelPool = provenance({
				inferenceElapsedMs: observedTrial?.inferenceElapsedMs ?? null,
				...usage(observedTrial),
				exchanges: observedTrial === null ? null : observedTrial.wire.responses.length,
				failureCategory: result.availability === "unavailable" ? result.reason : null,
			});
			if (result.runtime.model !== selection.member.modelId)
				return {
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: request.projectId,
					runtime: result.runtime,
					modelPool: {
						...modelPool,
						measurements: { ...modelPool.measurements, failureCategory: "model-identity-mismatch" },
					},
					availability: "unavailable",
					reason: "model-identity-mismatch",
				};
			return { ...result, modelPool };
		},
	};
}
