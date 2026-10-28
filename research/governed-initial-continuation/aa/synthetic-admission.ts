// Synthetic plumbing only: this is not an observer or evidence of a real server.
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContinuationAdmissionHookV0 } from "../../../cli/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import type { SlotStart } from "./reader.ts";

export interface SyntheticIdentityProvider {
	prepare(turn: 1 | 2, signal: AbortSignal): Promise<{ identity: string; observationId: string }>;
	recheck(identity: string, turn: 1 | 2): boolean;
}
export interface SyntheticAdmissionRecord {
	version: "endo.research.aa.synthetic-admission.0";
	studyCommitment: EndoKeyedDigestV0;
	startCommitment: EndoKeyedDigestV0;
	position: number;
	attemptId: string;
	turn: 1 | 2;
	upstream: string;
	requestDigest: EndoKeyedDigestV0;
	dispatchCommitment: EndoKeyedDigestV0;
	approvalCommitment: EndoKeyedDigestV0;
	identity: string;
	observationId: string;
	result: "admitted";
	refusalReason: null;
	preparedAt: string;
	admittedAt: string;
	commitment: EndoKeyedDigestV0;
}
export const admissionPath = (area: string, turn: 1 | 2) => join(area, `synthetic-admission-${turn}.json`);
export const sealAdmission = (key: EndoDigestKeyV0, body: Omit<SyntheticAdmissionRecord, "commitment">) => ({
	...body,
	commitment: key.digest({ purpose: "endo.research.aa.synthetic-admission.0", body }),
});

/** The only mutation is an exclusive private sidecar, published before the proxy opens its upstream hop. */
export function syntheticAdmissionHook(
	key: EndoDigestKeyV0,
	start: SlotStart,
	expectedIdentity: string,
	provider: SyntheticIdentityProvider,
	priorObservationIds: readonly string[],
): ContinuationAdmissionHookV0 {
	let next: 1 | 2 | 3 = 1;
	const used = new Set(priorObservationIds);
	return {
		binding: { studyCommitment: start.studyCommitment, slotCommitment: start.commitment, position: start.position },
		async prepare({ turn, marker }, signal) {
			if (signal.aborted || turn !== next || marker.attemptId !== start.plan.initial.attemptId)
				throw new Error("admission order");
			const value = await provider.prepare(turn, signal);
			if (
				signal.aborted ||
				typeof value.identity !== "string" ||
				value.identity.length < 1 ||
				value.identity.length > 256 ||
				typeof value.observationId !== "string" ||
				!/^[a-f0-9]{32}$/.test(value.observationId) ||
				used.has(value.observationId)
			)
				throw new Error("synthetic observation unavailable");
			used.add(value.observationId);
			return {
				identity: value.identity,
				observationId: value.observationId,
				preparedAt: new Date().toISOString(),
				turn,
				marker: marker.commitment,
			};
		},
		admit({ turn, marker, area, upstream, requestDigest, prepared, signal }) {
			const p = prepared as {
				identity?: unknown;
				observationId?: unknown;
				preparedAt?: unknown;
				turn?: unknown;
				marker?: unknown;
			} | null;
			if (
				!p ||
				turn !== next ||
				p.turn !== turn ||
				typeof p.identity !== "string" ||
				p.identity !== expectedIdentity ||
				typeof p.observationId !== "string" ||
				!used.has(p.observationId) ||
				typeof p.preparedAt !== "string" ||
				canonicalEndoJsonV0(p.marker) !== canonicalEndoJsonV0(marker.commitment) ||
				marker.attemptId !== start.plan.initial.attemptId ||
				upstream !== start.plan.initial.upstream ||
				provider.recheck(p.identity, turn) !== true ||
				signal.aborted
			)
				return { accepted: false, reason: "synthetic identity, order, binding or cancellation refused" };
			const body = {
				version: "endo.research.aa.synthetic-admission.0" as const,
				studyCommitment: start.studyCommitment,
				startCommitment: start.commitment,
				position: start.position,
				attemptId: marker.attemptId,
				turn,
				upstream,
				requestDigest,
				dispatchCommitment: marker.commitment,
				approvalCommitment: marker.approvalCommitment,
				identity: p.identity,
				observationId: p.observationId,
				result: "admitted" as const,
				refusalReason: null,
				preparedAt: p.preparedAt,
				admittedAt: new Date().toISOString(),
			};
			const fd = openSync(
				admissionPath(area, turn),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeFileSync(fd, canonicalEndoJsonV0(sealAdmission(key, body)));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			const dir = openSync(area, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
			next++;
			return { accepted: true, reason: null };
		},
	};
}
