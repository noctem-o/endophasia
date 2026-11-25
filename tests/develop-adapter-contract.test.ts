// Operational adapter contract conformance tests (`endo.develop-adapter.v0`).
//
// Exercises:
// 1. The reusable conformance suite (`tests/helpers/develop-adapter-conformance.ts`) against BOTH:
//    - Pi reference production adapter (`PiDevelopAdapterV0` over `PiSessionAttachmentV0` / fake Pi child process)
//    - Non-Pi Codex-shaped conformance specimen (`CodexAdapterSpecimenV0`, `synthetic: true`)
// 2. Identity & evidence invalidation (collisions, aliases, launch-scoped reattachment, fingerprint/config changes,
//    reduced-confidence fingerprints, stale evidence, malformed/unknown capability claims).
// 3. Operational semantics (Pi vs Codex steering/queue/stop differences, disconnect mid-request, partial results,
//    late responses after instance rotation, reasoning-summary vs raw-thinking, unavailable usage never zero).
// 4. Authority & native approvals (cross-source/session/scope, external/imported refusal, synthetic refused in
//    production, Pi Everyday session-grant never generalized to Codex, native approvals never inheriting prompt
//    authority, unknown approval kinds, scope-broadening refusal, TOCTOU prerequisite changes).
// 5. Production Pi `WorkbenchBrokerV0` integration (verifying the live broker enforces the new adapter boundary).
// 6. Source boundary & negative controls (no production module imports `codex-adapter-specimen`, removing guards fails).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PiDevelopAdapterV0 } from "../adapters/pi/develop-adapter.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import {
	type EndoDevelopNativeApprovalDecisionV0,
	type EndoDevelopObservationV0,
	type EndoDevelopOperationRequestV0,
	endoAdapterSessionKeyV0,
	endoDevelopAdapterDescriptorProblemV0,
	endoDevelopObservationProblemV0,
} from "../protocol/develop-adapter.ts";
import {
	endoHarnessIdentityBasisV1,
	endoHarnessIdentityConfidenceV1,
	validateEndoCapabilityStateV0,
	validateEndoHarnessFingerprintV1,
} from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	EndoObservationGuardV0,
	endoDevelopCapabilityFromStateV0,
	endoDevelopOperationPayloadDigestV0,
	endoEvaluateDevelopAdmissionV0,
	endoEvaluateNativeApprovalV0,
} from "../runtime/contracts/develop-adapter.ts";
import type { EndoExecutionProtectionV0 } from "../runtime/contracts/execution-protection.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import {
	CodexAdapterSpecimenV0,
	makeSyntheticCodexCapabilityStateV0,
	makeSyntheticCodexFingerprintV0,
} from "./fixtures/codex-adapter-specimen.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { buildOperatorProofV0, runDevelopAdapterConformanceSuiteV0 } from "./helpers/develop-adapter-conformance.ts";
import { Approval, FakeSession, settle } from "./workbench-fixtures.ts";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function makeStrongPiFingerprint(version = "1.5.2", sha = "1".repeat(64), contentSha = "2".repeat(64)) {
	const local = {
		requested: "pi",
		resolvedPath: "/usr/bin/pi",
		realPath: "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
		entrypoint: { sha256: sha, bytes: 160 },
		package: {
			name: "@earendil-works/pi-coding-agent",
			version,
			root: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
		},
		runtimeContent: {
			scheme: "endo.runtime-content.v1" as const,
			scope: "dist/bundle",
			files: 3,
			bytes: 1200,
			sha256: contentSha,
		},
	};
	const reported = { versionText: version, version };
	const body = {
		schemaVersion: "endo.harness-fingerprint.v1" as const,
		attachment: "pi.default",
		runtime: "pi",
		observedAt: "2026-11-24T11:00:00.000Z",
		methods: [
			"path-search" as const,
			"realpath" as const,
			"entrypoint-sha256" as const,
			"package-manifest" as const,
			"version-command" as const,
			"runtime-content-sha256" as const,
		],
		local,
		reported,
		gaps: [],
		identity: {
			basis: "runtime-content.v1" as const,
			digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV1({ runtime: "pi", local, reported }))),
			confidence: endoHarnessIdentityConfidenceV1({ local, reported }),
		},
	};
	const validated = validateEndoHarnessFingerprintV1({
		...body,
		id: `endo.evidence.pi-fp.${sha256HexV0(canonicalEndoJsonV0(body))}`,
	});
	if (validated === null) throw new Error("invalid pi fingerprint fixture");
	return validated;
}

function makePiCapabilityState(
	fingerprintId: string,
	admitted: readonly string[] = ["steering.steer", "steering.follow-up", "steering.stop"],
) {
	const evId = `endo.evidence.pi-ev.${"a".repeat(64)}`;
	const state = validateEndoCapabilityStateV0({
		schemaVersion: "endo.capability-state.v0",
		attachment: "pi.default",
		runtime: "pi",
		at: "2026-11-24T11:05:00.000Z",
		fingerprintId,
		capabilities: ["steering.steer", "steering.follow-up", "steering.stop"].map((cap) =>
			admitted.includes(cap)
				? {
						capability: cap,
						status: "admitted-partial",
						classification: "PARTIAL",
						evidenceId: evId,
						reason: "partial receipt semantics",
						requires: "live-study",
					}
				: {
						capability: cap,
						status: "unverified",
						classification: null,
						evidenceId: null,
						reason: "needs live study",
						requires: "live-study",
					},
		),
	});
	if (state === null) throw new Error("invalid pi capability state fixture");
	return state;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Reusable conformance suite executed against BOTH Pi (real production adapter) and Codex specimen
// ---------------------------------------------------------------------------------------------------------------

runDevelopAdapterConformanceSuiteV0({
	name: "Pi reference production adapter (PiDevelopAdapterV0 + FakeSession)",
	mode: "production",
	async createReady() {
		const fp = makeStrongPiFingerprint();
		const session = new FakeSession();
		let staleReason: string | null = null;
		const piSession = Object.assign(session, {
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
			steer: async () => "queued",
			followUp: async () => "queued",
			stop: async () => {},
		});
		const adapter = new PiDevelopAdapterV0({
			session: piSession,
			attachmentId: "pi.default",
			launchId: "0123456789abcdef",
			projectScope: "/workspace/demo",
			now: () => NOW,
			staleEvidenceReason: () => staleReason,
		});
		return {
			adapter,
			nowMs: () => NOW,
			authorize: (request, overrides) => buildOperatorProofV0({ adapter, request, nowMs: NOW, overrides }),
			rotateInstance: () => adapter.rotateInstance(),
			disconnect: (reason) => {
				piSession.live = false;
				adapter.markDisconnected(reason ?? "disconnected");
			},
			invalidateEvidence: (reason) => {
				staleReason = reason;
			},
			injectObservation: (obs) => adapter.ingestObservation(obs),
			cleanup: async () => {
				await adapter.close();
			},
		};
	},
});

runDevelopAdapterConformanceSuiteV0({
	name: "Codex non-Pi conformance specimen (CodexAdapterSpecimenV0, synthetic)",
	mode: "fixture",
	async createReady() {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		return {
			adapter: specimen,
			nowMs: () => NOW,
			authorize: (request, overrides) => buildOperatorProofV0({ adapter: specimen, request, nowMs: NOW, overrides }),
			rotateInstance: () => specimen.reconnect(),
			disconnect: (reason) => specimen.simulateDisconnect(reason),
			invalidateEvidence: (reason) => specimen.markEvidenceStale(reason),
			injectObservation: (obs) => specimen.ingestRawObservation(obs),
			cleanup: async () => {
				await specimen.close();
			},
		};
	},
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Identity, capability evidence, and invalidation conformance
// ---------------------------------------------------------------------------------------------------------------

describe("identity and capability evidence invariants", () => {
	it("prevents source-qualified identity collisions even when two runtimes share the same local session id", () => {
		const fp = makeStrongPiFingerprint();
		const piSession = Object.assign(new FakeSession(), {
			piSessionId: "shared-local-id",
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
		});
		const pi = new PiDevelopAdapterV0({
			session: piSession,
			attachmentId: "pi.default",
			launchId: "aaaa1111bbbb2222",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const codex = new CodexAdapterSpecimenV0({
			threadId: "shared-local-id",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		codex.initialize();

		const piKey = endoAdapterSessionKeyV0(pi.describe().session);
		const codexKey = endoAdapterSessionKeyV0(codex.describe().session);
		expect(piKey).not.toBe(codexKey);
		expect(piKey).toContain("pi-live:");
		expect(codexKey).toContain("test-codex-specimen:");

		// A proof minted for Pi cannot control the Codex specimen even with the same local id.
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "cross check" };
		const piProof = buildOperatorProofV0({ adapter: pi, request: req, nowMs: NOW });
		expect(codex.admitOperation(req, piProof, { mode: "fixture", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "cross-source-control",
		});
	});

	it("prevents launch-scoped identity reuse after reattachment", () => {
		const fp = makeStrongPiFingerprint();
		const session = Object.assign(new FakeSession(), {
			piSessionId: null, // Before Pi reports its persistent id, the key is launch-scoped.
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
		});
		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "launch-0001",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const d1 = adapter.describe();
		expect(d1.session.key).toEqual({ status: "established", id: "launch-0001", scope: "launch" });

		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "early" };
		const launchProof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });
		expect(adapter.admitOperation(req, launchProof, { mode: "production", nowMs: NOW })).toEqual({ admitted: true });

		// Reattach: instance rotates (and even if launchId stayed, or persistent id arrived, earlier proof is stale).
		adapter.rotateInstance();
		expect(adapter.admitOperation(req, launchProof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "stale-attachment",
		});
	});

	it("invalidates capability standing on runtime fingerprint change, reduced-confidence carry-over, and malformed claims", () => {
		const fp1 = makeSyntheticCodexFingerprintV0({
			version: "0.171.0",
			sha: "1".repeat(64),
			runtimeContentSha: "2".repeat(64),
		});
		const fp2 = makeSyntheticCodexFingerprintV0({
			version: "0.172.0",
			sha: "3".repeat(64),
			runtimeContentSha: "4".repeat(64),
		});
		const stateForFp1 = makeSyntheticCodexCapabilityStateV0({ fingerprint: fp1 });

		// Fingerprint change invalidates prior evidence.
		const afterUpgrade = endoDevelopCapabilityFromStateV0({
			state: stateForFp1,
			capabilityId: "codex.turn.start",
			expectedRuntime: "codex",
			expectedAttachment: "codex.specimen",
			currentFingerprint: fp2,
		});
		expect(afterUpgrade.standing).toBe("unverified");

		// Reduced-confidence fingerprint cannot carry evidence across observations.
		const reducedObs1 = makeSyntheticCodexFingerprintV0({
			version: "0.171.0",
			sha: "5".repeat(64),
			runtimeContentSha: null,
			at: "2026-11-24T10:00:00.000Z",
		});
		const reducedObs2 = makeSyntheticCodexFingerprintV0({
			version: "0.171.0",
			sha: "5".repeat(64),
			runtimeContentSha: null,
			at: "2026-11-24T11:00:00.000Z",
		});
		expect(reducedObs1.identity.confidence).toBe("reduced");
		expect(reducedObs2.identity.confidence).toBe("reduced");
		expect(reducedObs1.identity.digest).toBe(reducedObs2.identity.digest);
		expect(reducedObs1.id).not.toBe(reducedObs2.id);

		const stateForReduced1 = makeSyntheticCodexCapabilityStateV0({ fingerprint: reducedObs1 });
		const carriedReduced = endoDevelopCapabilityFromStateV0({
			state: stateForReduced1,
			capabilityId: "codex.turn.start",
			expectedRuntime: "codex",
			expectedAttachment: "codex.specimen",
			currentFingerprint: reducedObs2,
			evidenceFingerprintConfidence: "reduced",
		});
		expect(carriedReduced.standing).toBe("unverified");
		expect(carriedReduced.reason).toMatch(/reduced-confidence/);

		// Malformed capability state and unknown capabilities fail closed.
		expect(
			endoDevelopCapabilityFromStateV0({
				state: {
					schemaVersion: "endo.capability-state.v0",
					capabilities: [{ capability: "codex.turn.start", status: "admitted" }],
				},
				capabilityId: "codex.turn.start",
				expectedRuntime: "codex",
				expectedAttachment: "codex.specimen",
				currentFingerprint: fp1,
			}).standing,
		).toBe("unverified");

		expect(
			endoDevelopCapabilityFromStateV0({
				state: stateForFp1,
				capabilityId: "codex.nonexistent.capability",
				expectedRuntime: "codex",
				expectedAttachment: "codex.specimen",
				currentFingerprint: fp1,
			}).standing,
		).toBe("unverified");
	});

	it("never admits documented-only, observed-only, or tested-only capabilities for dispatch", async () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "test standing" };

		for (const standing of ["documented-only", "observed-only", "tested-only", "unverified", "mismatch"] as const) {
			specimen.setCapabilityOverride("prompt", {
				standing,
				evidenceCapability: "codex.turn.start",
				evidenceId: null,
				reason: `only ${standing}`,
			});
			const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });
			const out = await specimen.dispatch(req, proof, { mode: "fixture", nowMs: NOW });
			expect(out, standing).toMatchObject({
				status: "refused",
				stage: "admission",
				code: "capability-not-admitted",
			});
		}
		expect(specimen.calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Codex-specific operational semantics, faults, and native approval boundaries
// ---------------------------------------------------------------------------------------------------------------

describe("Codex non-Pi specimen: explicit turn semantics, faults, reasoning/usage honesty, and native approvals", () => {
	it("preserves explicit thread/turn identities, expectedTurnId steer precondition, targeted interrupt, and unsupported queue", async () => {
		const specimen = new CodexAdapterSpecimenV0({
			parentSessionKey: "test-coordinator:persistent:root-job",
			now: () => NOW,
		});
		specimen.initialize();
		const desc = specimen.describe();

		// Semantic differences explicitly preserved against Pi:
		expect(desc.operations.prompt.yieldsTurnId).toBe(true);
		expect(desc.operations.steer.requiresTargetTurnId).toBe(true);
		expect(desc.operations.stop.targeting).toBe("targeted-turn-interrupt");
		expect(desc.operations.stop.requiresTargetTurnId).toBe(true);
		expect(desc.operations.queue.capability.standing).toBe("unsupported");
		expect(desc.operations.attachments.supported).toBe(true);
		expect(desc.operations.attachments.allowsArbitraryPathRead).toBe(false);
		expect(desc.operations.coordination.canDiscoverChildren).toBe(true);
		expect(desc.operations.coordination.delegationSupported).toBe(false);

		// 1. Start a turn: yields explicit UUIDv7 turnId, consequenceObserved is false.
		const promptReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "implement feature" };
		const started = await specimen.dispatch(
			promptReq,
			buildOperatorProofV0({ adapter: specimen, request: promptReq, nowMs: NOW }),
			{ mode: "fixture", nowMs: NOW },
		);
		expect(started.status).toBe("accepted");
		if (started.status !== "accepted") throw new Error("expected accepted");
		expect(started.turnId).toMatch(/^019a0000-/);
		expect(started.consequenceObserved).toBe(false);
		const turnId = started.turnId!;

		// 2. Steer without targetTurnId -> refused (`target-turn-required`).
		const untargetedSteer: EndoDevelopOperationRequestV0 = { kind: "steer", message: "focus on tests" };
		expect(
			await specimen.dispatch(
				untargetedSteer,
				buildOperatorProofV0({ adapter: specimen, request: untargetedSteer, nowMs: NOW }),
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ status: "refused", stage: "admission", code: "target-turn-required" });

		// 3. Steer with WRONG targetTurnId -> refused (`target-turn-mismatch`).
		const wrongSteer: EndoDevelopOperationRequestV0 = {
			kind: "steer",
			message: "focus on tests",
			targetTurnId: "019a0000-0000-7000-8000-999999999999",
		};
		expect(
			await specimen.dispatch(
				wrongSteer,
				buildOperatorProofV0({ adapter: specimen, request: wrongSteer, nowMs: NOW }),
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ status: "refused", stage: "admission", code: "target-turn-mismatch" });

		// 4. Steer with exact active turnId -> accepted with receipt.
		const goodSteer: EndoDevelopOperationRequestV0 = {
			kind: "steer",
			message: "focus on tests",
			targetTurnId: turnId,
		};
		expect(
			await specimen.dispatch(
				goodSteer,
				buildOperatorProofV0({ adapter: specimen, request: goodSteer, nowMs: NOW }),
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ status: "accepted", turnId, consequenceObserved: false });

		// 5. Pi-style `queue` is explicitly unsupported on Codex (no manufactured parity).
		const queueReq: EndoDevelopOperationRequestV0 = { kind: "queue", message: "next task" };
		expect(
			await specimen.dispatch(queueReq, buildOperatorProofV0({ adapter: specimen, request: queueReq, nowMs: NOW }), {
				mode: "fixture",
				nowMs: NOW,
			}),
		).toMatchObject({ status: "refused", stage: "admission", code: "operation-unsupported" });

		// 6. Untargeted `stop` is refused on Codex; targeted `stop` with active turnId is accepted.
		const untargetedStop: EndoDevelopOperationRequestV0 = { kind: "stop" };
		expect(
			await specimen.dispatch(
				untargetedStop,
				buildOperatorProofV0({ adapter: specimen, request: untargetedStop, nowMs: NOW }),
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ status: "refused", stage: "admission", code: "target-turn-required" });

		const targetedStop: EndoDevelopOperationRequestV0 = { kind: "stop", targetTurnId: turnId };
		expect(
			await specimen.dispatch(
				targetedStop,
				buildOperatorProofV0({ adapter: specimen, request: targetedStop, nowMs: NOW }),
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ status: "accepted", disposition: "interrupt-accepted", turnId, consequenceObserved: false });
	});

	it("handles disconnect mid-request and partial responses as unknown (never refused or completed)", async () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const observations: EndoDevelopObservationV0[] = [];
		specimen.subscribeObservations((o) => observations.push(o));

		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "risky send" };
		specimen.setNextFault("partial-result");
		const partial = await specimen.dispatch(
			req,
			buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW }),
			{ mode: "fixture", nowMs: NOW },
		);
		expect(partial).toMatchObject({ status: "unknown", dispatched: true });

		specimen.setNextFault("disconnect-mid-request");
		const dropped = await specimen.dispatch(
			req,
			buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW }),
			{ mode: "fixture", nowMs: NOW },
		);
		expect(dropped).toMatchObject({ status: "unknown", dispatched: true });
		expect(specimen.snapshot().connection.state).toBe("disconnected");

		const gapKinds = observations
			.filter((o) => o.body.kind === "evidence-gap")
			.map((o) => (o.body.kind === "evidence-gap" ? o.body.gap : ""));
		expect(gapKinds).toContain("partial-operation-result");
		expect(gapKinds).toContain("disconnected-mid-request");
	});

	it("preserves reasoning-summary provenance and unavailable usage (never 0, never relabelled as raw thinking)", () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const observations: EndoDevelopObservationV0[] = [];
		specimen.subscribeObservations((o) => observations.push(o));

		specimen.emitReasoningSummary("Summary of plan steps.");
		specimen.emitTokenUsage(null);
		specimen.emitTokenUsage({ input: 100, output: 50, cached: 20, reasoning: 15, total: 150 });

		const reasoning = observations.find((o) => o.body.kind === "transcript" && o.body.contentKind === "reasoning");
		expect(reasoning?.body).toMatchObject({
			kind: "transcript",
			contentKind: "reasoning",
			reasoningKind: "reasoning-summary",
		});
		expect(reasoning?.body.kind === "transcript" && reasoning.body.reasoningKind).not.toBe("raw-thinking");

		const usages = observations.filter((o) => o.body.kind === "usage");
		expect(usages[0]?.body).toMatchObject({ kind: "usage", usage: { status: "unavailable" } });
		expect(usages[1]?.body).toMatchObject({
			kind: "usage",
			usage: { status: "reported", value: { totalTokens: 150, reasoningTokens: 15, costUsd: null } },
		});
	});

	it("enforces strict native approval boundaries: no prompt inheritance, fail-closed unknown, no scope broadening, no cross-turn reuse, single-use", async () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();

		// Start a turn with valid prompt authorization.
		const promptReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "run build" };
		const started = await specimen.dispatch(
			promptReq,
			buildOperatorProofV0({ adapter: specimen, request: promptReq, nowMs: NOW }),
			{ mode: "fixture", nowMs: NOW },
		);
		expect(started.status).toBe("accepted");
		const turnId = started.status === "accepted" ? started.turnId! : "";

		const emitCmdApproval = (id: string) =>
			specimen.emitNativeApprovalRequest({
				requestId: id,
				approvalKind: "command-execution",
				nativeMethod: "item/commandExecution/requestApproval",
				itemId: `item-${id}`,
				requestedScope: "once",
				summary: "npm test",
			});

		// 1. Missing operator decision fails closed (never inherits prior prompt authorization!) and consumes the request.
		const req1 = emitCmdApproval("approval-cmd-1");
		expect(specimen.snapshot().pendingNativeApprovalCount).toBe(1);
		expect(specimen.snapshot().stateClaims[0]?.state).toBe("waiting-approval");
		expect(specimen.handleNativeApproval(req1, null, { nowMs: NOW })).toMatchObject({
			resolution: "declined",
			code: "no-operator-decision",
			grantsEndophasiaAuthority: false,
		});
		expect(specimen.snapshot().pendingNativeApprovalCount).toBe(0);

		// 2. Trying to pass a prompt-derived basis fails closed.
		const req2 = emitCmdApproval("approval-cmd-2");
		const forgedBasis = {
			requestId: req2.requestId,
			source: req2.source,
			sessionKey: req2.sessionKey,
			instanceId: req2.instanceId,
			turnId: req2.turnId,
			itemId: req2.itemId,
			decision: "accept" as const,
			approvedScope: "once" as const,
			basis: "inherited-from-prompt" as unknown as "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		expect(specimen.handleNativeApproval(req2, forgedBasis, { nowMs: NOW })).toMatchObject({
			resolution: "declined",
			code: "prompt-authority-not-inheritable",
			grantsEndophasiaAuthority: false,
		});

		// 3. Scope broadening (`once` -> `session` or `policy-amendment`) fails closed.
		const req3 = emitCmdApproval("approval-cmd-3");
		const broadened: EndoDevelopNativeApprovalDecisionV0 = {
			requestId: req3.requestId,
			source: req3.source,
			sessionKey: req3.sessionKey,
			instanceId: req3.instanceId,
			turnId: req3.turnId,
			itemId: req3.itemId,
			decision: "accept",
			approvedScope: "session",
			basis: "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		expect(specimen.handleNativeApproval(req3, broadened, { nowMs: NOW })).toMatchObject({
			resolution: "declined",
			code: "scope-broadening-refused",
			grantsEndophasiaAuthority: false,
		});

		// 4. Reusing a decision for another turn fails closed.
		const req4 = emitCmdApproval("approval-cmd-4");
		const wrongTurn: EndoDevelopNativeApprovalDecisionV0 = {
			requestId: req4.requestId,
			source: req4.source,
			sessionKey: req4.sessionKey,
			instanceId: req4.instanceId,
			turnId: "019a0000-0000-7000-8000-otherturn999",
			itemId: req4.itemId,
			decision: "accept",
			approvedScope: "once",
			basis: "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		expect(specimen.handleNativeApproval(req4, wrongTurn, { nowMs: NOW })).toMatchObject({
			resolution: "declined",
			code: "binding-mismatch",
		});

		// 5. Unknown native approval kind fails closed even WITH an explicit accept decision.
		const unknownReq = specimen.emitNativeApprovalRequest({
			requestId: "approval-unknown-5",
			approvalKind: "unknown",
			nativeMethod: "item/futureCapability/requestApproval",
			itemId: "item-x-5",
			requestedScope: "once",
			summary: "unknown future action",
		});
		const acceptUnknown: EndoDevelopNativeApprovalDecisionV0 = {
			requestId: unknownReq.requestId,
			source: unknownReq.source,
			sessionKey: unknownReq.sessionKey,
			instanceId: unknownReq.instanceId,
			turnId: unknownReq.turnId,
			itemId: unknownReq.itemId,
			decision: "accept",
			approvedScope: "once",
			basis: "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		expect(specimen.handleNativeApproval(unknownReq, acceptUnknown, { nowMs: NOW })).toMatchObject({
			resolution: "declined",
			code: "unknown-approval-kind",
			grantsEndophasiaAuthority: false,
		});

		// 6. Negative control: exact matching one-time explicit operator decision succeeds AND still grants NO Endophasia authority.
		const req6 = emitCmdApproval("approval-cmd-6");
		const exactAccept: EndoDevelopNativeApprovalDecisionV0 = {
			requestId: req6.requestId,
			source: req6.source,
			sessionKey: req6.sessionKey,
			instanceId: req6.instanceId,
			turnId,
			itemId: req6.itemId,
			decision: "accept",
			approvedScope: "once",
			basis: "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		expect(specimen.handleNativeApproval(req6, exactAccept, { nowMs: NOW })).toEqual({
			resolution: "accepted",
			requestId: req6.requestId,
			scope: "once",
			grantsEndophasiaAuthority: false,
		});

		// 7. Replaying the same consumed approval request fails closed (single-use).
		expect(specimen.handleNativeApproval(req6, exactAccept, { nowMs: NOW })).toMatchObject({
			resolution: "cancelled",
			code: "binding-mismatch",
			grantsEndophasiaAuthority: false,
		});

		// 8. Pure evaluator fail-closed checks: unknown decision value, unknown approvedScope, NaN/Infinity expiry, disconnected, ended turn.
		const req8 = emitCmdApproval("approval-cmd-8");
		const baseAccept: EndoDevelopNativeApprovalDecisionV0 = {
			requestId: req8.requestId,
			source: req8.source,
			sessionKey: req8.sessionKey,
			instanceId: req8.instanceId,
			turnId,
			itemId: req8.itemId,
			decision: "accept",
			approvedScope: "once",
			basis: "explicit-operator-native-approval",
			decidedAtMs: NOW,
			expiresAtMs: NOW + 60_000,
		};
		const currentCtx = {
			source: req8.source,
			sessionKey: req8.sessionKey,
			instanceId: req8.instanceId,
			connected: true,
			activeTurnId: turnId,
			knownKinds: ["command-execution"] as const,
			mode: "server-initiated-requests" as const,
			nowMs: NOW,
		};
		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: { ...baseAccept, decision: "deny" as unknown as "decline" },
				current: currentCtx,
			}),
		).toMatchObject({ resolution: "declined", code: "operator-declined" });

		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: { ...baseAccept, approvedScope: "forever" as unknown as "once" },
				current: { ...currentCtx, allowSessionOrPolicyScope: true },
			}),
		).toMatchObject({ resolution: "declined", code: "scope-broadening-refused" });

		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: { ...baseAccept, expiresAtMs: Number.NaN },
				current: currentCtx,
			}),
		).toMatchObject({ resolution: "declined", code: "decision-expired" });

		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: { ...baseAccept, expiresAtMs: Number.POSITIVE_INFINITY },
				current: currentCtx,
			}),
		).toMatchObject({ resolution: "declined", code: "decision-expired" });

		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: baseAccept,
				current: { ...currentCtx, connected: false },
			}),
		).toMatchObject({ resolution: "cancelled", code: "stale-attachment" });

		expect(
			endoEvaluateNativeApprovalV0({
				request: req8,
				decision: baseAccept,
				current: { ...currentCtx, activeTurnId: null },
			}),
		).toMatchObject({ resolution: "cancelled", code: "binding-mismatch" });

		// Disconnecting specimen cancels pending approval cleanly.
		specimen.simulateDisconnect("connection-lost");
		expect(specimen.handleNativeApproval(req8, baseAccept, { nowMs: NOW })).toMatchObject({
			resolution: "cancelled",
			code: "stale-attachment",
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Authority hardening & negative controls
// ---------------------------------------------------------------------------------------------------------------

describe("authority boundaries and negative controls", () => {
	it("refuses synthetic adapters in production mode (with fixture-mode negative control)", async () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "synthetic check" };
		const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });

		// Production mode MUST refuse synthetic adapters unconditionally.
		expect(specimen.admitOperation(req, proof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "synthetic-not-admitted",
		});
		expect(endoDevelopAdapterDescriptorProblemV0(specimen.describe())).toMatch(/synthetic/);

		// Negative control: same request and proof succeed ONLY when explicitly in fixture mode.
		expect(specimen.admitOperation(req, proof, { mode: "fixture", nowMs: NOW })).toEqual({ admitted: true });
	});

	it("refuses external and imported sessions from dispatching control operations", () => {
		for (const ownership of ["external", "imported"] as const) {
			const specimen = new CodexAdapterSpecimenV0({ ownership, now: () => NOW });
			specimen.initialize();
			const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hijack" };
			const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });
			expect(specimen.admitOperation(req, proof, { mode: "fixture", nowMs: NOW })).toMatchObject({
				admitted: false,
				code: "not-directly-owned",
			});
		}
	});

	it("refuses non-Pi adapters claiming the Pi workbench broker control path", () => {
		const specimen = new CodexAdapterSpecimenV0({ controlPath: "pi-workbench-broker", now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "borrow pi broker" };
		const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });
		expect(specimen.admitOperation(req, proof, { mode: "fixture", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "cross-source-control",
		});
	});

	it("never generalizes Pi Everyday session-grant eligibility to Codex or non-Pi runtimes", () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "grant bypass" };
		const sessionKey = endoAdapterSessionKeyV0(specimen.describe().session)!;
		const enforcedProtection: EndoExecutionProtectionV0 = {
			observe: () => ({
				state: "enforced",
				level: "workspace",
				mechanism: "test-sandbox.v0",
				session: sessionKey,
				workspaceRoot: "/workspace/demo",
				limitations: [],
			}),
		};
		const grantProof = buildOperatorProofV0({
			adapter: specimen,
			request: req,
			nowMs: NOW,
			overrides: {
				mechanism: "session-grant",
				sessionGrantId: "endo.evidence.workbench-session-grant-00000000000000000000000000000001",
			},
		});
		// Even with an enforced workspace boundary, Codex MUST NOT inherit Pi Everyday session-grant eligibility.
		expect(
			specimen.admitOperation(req, grantProof, {
				mode: "fixture",
				nowMs: NOW,
				protection: enforcedProtection,
			}),
		).toMatchObject({ admitted: false, code: "session-grant-not-permitted" });

		// Even if a descriptor tries to forge everydayGrantEligible: true on a codex harness, schema validation rejects it.
		const forged = { ...specimen.describe(), everydayGrantEligible: true };
		expect(endoDevelopAdapterDescriptorProblemV0(forged, { allowSynthetic: true })).toMatch(/everydayGrantEligible/);
	});

	it("enforces Pi session-grant only when workspace execution protection is actually observed as enforced", () => {
		const fp = makeStrongPiFingerprint();
		const session = Object.assign(new FakeSession(), {
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
		});
		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "1111222233334444",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "with grant" };
		const grantProof = buildOperatorProofV0({
			adapter,
			request: req,
			nowMs: NOW,
			overrides: {
				mechanism: "session-grant",
				sessionGrantId: "endo.evidence.workbench-session-grant-00000000000000000000000000000002",
			},
		});

		// Without enforced protection -> refused.
		expect(adapter.admitOperation(req, grantProof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "protection-not-enforced",
		});

		// With enforced protection for exact Pi session and workspace -> admitted (negative control).
		const piProtection: EndoExecutionProtectionV0 = {
			observe: () => ({
				state: "enforced",
				level: "workspace",
				mechanism: "pi-workspace.v0",
				session: "endo.session.pi.fake-session-1",
				workspaceRoot: "/workspace/demo",
				limitations: [],
			}),
		};
		expect(
			adapter.admitOperation(req, grantProof, { mode: "production", nowMs: NOW, protection: piProtection }),
		).toEqual({ admitted: true });
	});

	it("re-checks TOCTOU prerequisites when a run becomes active between authorization and dispatch", async () => {
		const fp = makeStrongPiFingerprint();
		const session = Object.assign(new FakeSession(), {
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
		});
		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "5555666677778888",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "toctou check" };
		const proof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });

		// Initially idle: admitted.
		expect(adapter.admitOperation(req, proof, { mode: "production", nowMs: NOW })).toEqual({ admitted: true });

		// Prerequisite changes before dispatch: a run opens.
		session.runActive = true;
		const out = await adapter.dispatch(req, proof, { mode: "production", nowMs: NOW });
		expect(out).toMatchObject({ status: "refused", stage: "admission", code: "run-active" });
		expect(session.promptCalls).toEqual([]);
	});

	it("rejects tampered descriptor passed directly to endoEvaluateDevelopAdmissionV0", () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "tamper" };
		const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });
		const badDescriptor = { ...specimen.describe(), extraUnauthorizedField: true } as unknown as ReturnType<
			CodexAdapterSpecimenV0["describe"]
		>;
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: badDescriptor,
				snapshot: specimen.snapshot(),
				request: req,
				authority: proof,
				options: { mode: "fixture", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "invalid-request" });
	});

	it("validates authority timestamps, mechanism, unknown request kinds, and attachment paths (fail-closed)", () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hello" };
		const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });

		// Non-finite authority timestamps fail closed.
		expect(
			specimen.admitOperation(req, { ...proof, expiresAtMs: Number.NaN }, { mode: "fixture", nowMs: NOW }),
		).toMatchObject({ admitted: false, code: "authority-expired" });
		expect(
			specimen.admitOperation(
				req,
				{ ...proof, expiresAtMs: Number.POSITIVE_INFINITY },
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ admitted: false, code: "authority-expired" });
		expect(
			specimen.admitOperation(req, { ...proof, authorizedAtMs: Number.NaN }, { mode: "fixture", nowMs: NOW }),
		).toMatchObject({ admitted: false, code: "authority-expired" });

		// Forged authority mechanism fails closed.
		expect(
			specimen.admitOperation(
				req,
				{ ...proof, mechanism: "auto-approved" as unknown as "terminal-code" },
				{ mode: "fixture", nowMs: NOW },
			),
		).toMatchObject({ admitted: false, code: "missing-authority" });

		// Unknown request kind returns explicit refusal (never undefined).
		const unknownReq = { kind: "eval-shell", command: "id" } as unknown as EndoDevelopOperationRequestV0;
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: specimen.describe(),
				snapshot: specimen.snapshot(),
				request: unknownReq,
				authority: proof,
				options: { mode: "fixture", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "invalid-request" });

		// Unsafe attachment references (absolute paths, parent traversal) fail closed.
		for (const badAtt of [
			{
				kind: "local-image" as const,
				delivery: "reference" as const,
				reference: "/etc/shadow",
				mediaType: null,
				bytes: 10,
			},
			{
				kind: "local-image" as const,
				delivery: "reference" as const,
				reference: "../secret.png",
				mediaType: null,
				bytes: 10,
			},
		]) {
			const attReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hi", attachments: [badAtt] };
			const attProof = buildOperatorProofV0({ adapter: specimen, request: attReq, nowMs: NOW });
			expect(specimen.admitOperation(attReq, attProof, { mode: "fixture", nowMs: NOW })).toMatchObject({
				admitted: false,
				code: "invalid-request",
			});
		}

		// Non-finite attachment bytes fail closed cleanly without throwing.
		const nanBytesReq: EndoDevelopOperationRequestV0 = {
			kind: "prompt",
			message: "hi",
			attachments: [
				{
					kind: "local-image",
					delivery: "reference",
					reference: "assets/shot.png",
					mediaType: null,
					bytes: Number.NaN,
				},
			],
		};
		expect(specimen.admitOperation(nanBytesReq, proof, { mode: "fixture", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "invalid-request",
		});

		// Valid workspace-relative attachment succeeds (negative control).
		const okAttReq: EndoDevelopOperationRequestV0 = {
			kind: "prompt",
			message: "hi",
			attachments: [
				{
					kind: "local-image",
					delivery: "reference",
					reference: "assets/shot.png",
					mediaType: "image/png",
					bytes: 42,
				},
			],
		};
		const okAttProof = buildOperatorProofV0({ adapter: specimen, request: okAttReq, nowMs: NOW });
		expect(specimen.admitOperation(okAttReq, okAttProof, { mode: "fixture", nowMs: NOW })).toEqual({
			admitted: true,
		});
	});

	it("enforces evidence cross-checking, stale baseline prompt refusal, non-Pi evidence requirement, and control-path registry", () => {
		const specimen = new CodexAdapterSpecimenV0({ now: () => NOW });
		specimen.initialize();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "check" };
		const proof = buildOperatorProofV0({ adapter: specimen, request: req, nowMs: NOW });

		// Non-Pi descriptor claiming admitted prompt with `evidenceCapability: null` fails closed.
		const noEvidenceDesc = {
			...specimen.describe(),
			operations: {
				...specimen.describe().operations,
				prompt: {
					...specimen.describe().operations.prompt,
					capability: { ...specimen.describe().operations.prompt.capability, evidenceCapability: null },
				},
			},
		};
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: noEvidenceDesc,
				snapshot: specimen.snapshot(),
				request: req,
				authority: proof,
				options: { mode: "fixture", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "capability-not-admitted" });

		// Forged descriptor claiming `admitted` while capabilityState says `unverified` fails closed.
		const unverifiedState = makeSyntheticCodexCapabilityStateV0({
			fingerprint: makeSyntheticCodexFingerprintV0({ attachment: "codex.specimen" }),
			attachment: "codex.specimen",
			admitted: [],
		});
		const curFp = specimen.describe().runtimeFingerprint;
		const fpId = curFp.status === "identified" ? curFp.fingerprintId : null;
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: {
					...specimen.describe(),
					capabilityState: { ...unverifiedState, fingerprintId: fpId },
				},
				snapshot: specimen.snapshot(),
				request: req,
				authority: proof,
				options: { mode: "fixture", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "capability-not-admitted" });

		// Non-Pi harness spoofing BOTH `session.source: "pi-live"` and `controlPath: "pi-workbench-broker"` fails closed.
		const spoofed = {
			...specimen.describe(),
			synthetic: false,
			session: { ...specimen.describe().session, source: "pi-live" },
			controlPath: "pi-workbench-broker",
			everydayGrantEligible: false,
		};
		const spoofedSessionKey = endoAdapterSessionKeyV0(spoofed.session)!;
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: spoofed,
				snapshot: { ...specimen.snapshot(), sessionKey: spoofedSessionKey },
				request: req,
				authority: {
					...proof,
					source: "pi-live",
					sessionKey: spoofedSessionKey,
					controlPath: "pi-workbench-broker",
				},
				options: { mode: "production", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "cross-source-control" });

		// Unregistered production controlPath fails closed in production mode.
		const fp = makeStrongPiFingerprint();
		const session = Object.assign(new FakeSession(), {
			fingerprint: fp,
			capabilityState: makePiCapabilityState(fp.id),
		});
		const piAdapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "ctrl-path-0001",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const piDesc = {
			...piAdapter.describe(),
			controlPath: "unregistered-control-path",
			everydayGrantEligible: false,
		};
		const piReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "prod check" };
		const piProof = buildOperatorProofV0({
			adapter: piAdapter,
			request: piReq,
			nowMs: NOW,
			overrides: { controlPath: "unregistered-control-path" },
		});
		expect(
			endoEvaluateDevelopAdmissionV0({
				descriptor: piDesc,
				snapshot: piAdapter.snapshot(),
				request: piReq,
				authority: piProof,
				options: { mode: "production", nowMs: NOW },
			}),
		).toMatchObject({ admitted: false, code: "control-path-mismatch" });

		// Stale capability evidence refuses even Pi baseline `prompt` with `capability-stale`.
		const staleFp = makeStrongPiFingerprint("1.6.0", "c".repeat(64), "d".repeat(64));
		session.fingerprint = staleFp;
		const staleProof = buildOperatorProofV0({ adapter: piAdapter, request: piReq, nowMs: NOW });
		expect(piAdapter.admitOperation(piReq, staleProof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "capability-stale",
		});
	});

	it("refuses unidentified Pi runtime unconditionally in production (no bypass)", () => {
		const session = new FakeSession();
		session.fingerprint = undefined;
		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "unidentified-0001",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "no fingerprint" };
		const proof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });
		expect(adapter.admitOperation(req, proof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "runtime-unidentified",
		});
	});

	it("validates observation body fields and rejects spoofed observation metadata with strictly monotonic gap sequences", () => {
		const baseObs: EndoDevelopObservationV0 = {
			schemaVersion: "endo.develop-adapter-observation.v0",
			observationId: "obs-1",
			source: "pi-live",
			attachmentId: "pi.default",
			instanceId: "inst-1",
			sessionKey: "endo.session.pi.fake-session-1",
			sequence: 1,
			observedAt: "2026-11-24T12:00:00.000Z",
			basis: "runtime-reported",
			nativeIds: { sessionId: null, turnId: null, itemId: null, entryId: null },
			body: {
				kind: "usage",
				usage: {
					status: "reported",
					value: {
						inputTokens: Number.NaN,
						outputTokens: 10,
						cachedInputTokens: null,
						cacheWriteTokens: null,
						reasoningTokens: null,
						totalTokens: 10,
						costUsd: null,
					},
				},
			},
		};
		expect(endoDevelopObservationProblemV0(baseObs)).toMatch(/token counts/);

		expect(
			endoDevelopObservationProblemV0({
				...baseObs,
				body: {
					kind: "lifecycle",
					event: "bogus-event" as unknown as "turn-started",
					sessionState: "active",
					turnState: "in-progress",
					detail: null,
				},
			}),
		).toMatch(/lifecycle\.event/);

		expect(
			endoDevelopObservationProblemV0({
				...baseObs,
				body: {
					kind: "transcript",
					role: "assistant",
					contentKind: "reasoning",
					text: "should be null when redacted",
					reasoningKind: "redacted",
					truncated: false,
					stopReason: null,
				},
			}),
		).toMatch(/redacted/);

		expect(
			endoDevelopObservationProblemV0({
				...baseObs,
				body: {
					kind: "native-approval",
					phase: "requested",
					requestId: "req-1",
					approvalKind: "command-execution",
					resolution: "accepted",
				},
			}),
		).toMatch(/resolution/);

		// EndoObservationGuardV0 rejects spoofed source/attachmentId/sessionKey and keeps gap sequences strictly monotonic.
		const guard = new EndoObservationGuardV0({
			source: "pi-live",
			attachmentId: "pi.default",
			instanceId: "inst-1",
			sessionKey: "endo.session.pi.fake-session-1",
		});
		const valid1: EndoDevelopObservationV0 = {
			...baseObs,
			observationId: "obs-v1",
			sequence: 1,
			body: {
				kind: "lifecycle",
				event: "turn-started",
				sessionState: "active",
				turnState: "in-progress",
				detail: null,
			},
		};
		const valid2: EndoDevelopObservationV0 = { ...valid1, observationId: "obs-v2", sequence: 5 };
		const spoofedSource: EndoDevelopObservationV0 = {
			...valid1,
			observationId: "obs-spoof",
			sequence: 6,
			source: "codex-live",
		};
		const outOfOrder: EndoDevelopObservationV0 = { ...valid1, observationId: "obs-ooo", sequence: 2 };
		const duplicate: EndoDevelopObservationV0 = { ...valid1, observationId: "obs-v2", sequence: 7 };

		expect(guard.ingest(valid1).accepted).not.toBeNull();
		expect(guard.ingest(valid2).accepted).not.toBeNull();
		const spoofedRes = guard.ingest(spoofedSource);
		expect(spoofedRes.accepted).toBeNull();
		expect(spoofedRes.gaps).toEqual([]);
		const oooRes = guard.ingest(outOfOrder);
		expect(oooRes.accepted).not.toBeNull();
		expect(oooRes.gaps[0]?.body).toMatchObject({ kind: "evidence-gap", gap: "out-of-order-event" });
		const dupRes = guard.ingest(duplicate);
		expect(dupRes.accepted).toBeNull();
		expect(dupRes.gaps[0]?.body).toMatchObject({ kind: "evidence-gap", gap: "duplicate-event" });
		// Emitted gap sequence numbers must be strictly increasing and never collide with previously seen sequences.
		expect(oooRes.gaps[0]!.sequence).toBe(6);
		expect(dupRes.gaps[0]!.sequence).toBe(7);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Real production Pi integration (WorkbenchBrokerV0 + real fake-Pi child process via PiAttachmentV0)
// ---------------------------------------------------------------------------------------------------------------

describe("production Pi integration: WorkbenchBrokerV0 and real PiSessionAttachmentV0", () => {
	it("WorkbenchBrokerV0 wires PiDevelopAdapterV0 into live observations and rejects prompts if attachment instance rotates before dispatch", async () => {
		const session = new FakeSession();
		const approval = new Approval();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: approval.approver,
			now: () => NOW,
		});

		const observed: EndoDevelopObservationV0[] = [];
		broker.adapter.subscribeObservations((o) => observed.push(o));

		// Pair the page.
		const code = broker.issuePairingCode().code;
		const paired = await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } });
		expect(paired.status).toBe(200);
		const grant = (paired.body as { grant: string }).grant;

		// Live Pi events flow through the production broker into `broker.adapter` observations.
		session.live_({ type: "agent_start", record: {} });
		session.live_({
			type: "message_end",
			record: {
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "done" },
					],
				},
			},
		});
		session.live_({ type: "agent_settled", record: {} });

		expect(observed.some((o) => o.body.kind === "lifecycle" && o.body.event === "turn-started")).toBe(true);
		expect(
			observed.some(
				(o) =>
					o.body.kind === "transcript" &&
					o.body.contentKind === "reasoning" &&
					o.body.reasoningKind === "raw-thinking",
			),
		).toBe(true);
		// Missing usage on message_end is recorded explicitly as unavailable, never 0.
		expect(observed.some((o) => o.body.kind === "usage" && o.body.usage.status === "unavailable")).toBe(true);

		// Propose a prompt, then rotate the adapter instance while awaiting terminal approval -> refused as session-ended!
		const proposed = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "hello pi" },
		});
		expect(proposed.status).toBe(202);
		await approval.waitForRequest();
		broker.adapter.rotateInstance();
		approval.answer("allow");
		await settle();

		const pid = (proposed.body as { proposalId: string }).proposalId;
		const view = await broker.handle({ method: "GET", route: ["prompt", pid], query: "", grant, body: null });
		expect(view.body).toMatchObject({ state: "refused", reason: "session-ended" });
		expect(session.promptCalls).toEqual([]);

		// Broker dispose() disconnects the adapter even if the underlying session object remains live.
		expect(broker.adapter.snapshot().connection.state).toBe("connected");
		await broker.dispose();
		expect(broker.adapter.snapshot().connection.state).toBe("disconnected");
		expect(broker.adapter.snapshot().connection.reason).toMatch(/disposed/);
	});

	it("auto-rotates instanceId on Pi connectionInstance reconnect, ignores stale-instance events, sanitizes tool names, and supports long Pi session IDs", async () => {
		const longPiSessionId = "s".repeat(160);
		const session = new FakeSession();
		session.piSessionId = longPiSessionId;
		let connInstance = "conn-1";
		Object.defineProperty(session, "connectionInstance", {
			get: () => connInstance,
			configurable: true,
		});

		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "pi-long-0001",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});

		// Long 160-char Pi session ID validates cleanly and passes admission.
		const d1 = adapter.describe();
		const s1 = adapter.snapshot();
		expect(endoDevelopAdapterDescriptorProblemV0(d1)).toBeNull();
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "long session id" };
		const proof1 = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });
		expect(adapter.admitOperation(req, proof1, { mode: "production", nowMs: NOW })).toEqual({ admitted: true });

		// Simulate PiSessionAttachmentV0.reconnect() rotating connectionInstance without manual rotateInstance().
		connInstance = "conn-2";
		const s2 = adapter.snapshot();
		expect(s2.attachment.instanceId).not.toBe(s1.attachment.instanceId);
		expect(adapter.admitOperation(req, proof1, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "stale-attachment",
		});

		// Stale-instance `auto_retry_end` must NOT corrupt active state on the new instance.
		const observations: EndoDevelopObservationV0[] = [];
		adapter.subscribeObservations((o) => observations.push(o));
		adapter.observePiLiveEvent(
			{ type: "auto_retry_end", record: { success: false, finalError: "stale error" } },
			s1.attachment.instanceId,
		);
		expect(
			observations.some((o) => o.body.kind === "evidence-gap" && o.body.gap === "late-event-from-prior-attachment"),
		).toBe(true);
		// Subsequent normal turn settlement on the new instance must report `turn-completed` (not `turn-failed`).
		adapter.observePiLiveEvent({ type: "agent_settled", record: {} });
		expect(observations.some((o) => o.body.kind === "lifecycle" && o.body.event === "turn-completed")).toBe(true);
		expect(observations.some((o) => o.body.kind === "lifecycle" && o.body.event === "turn-failed")).toBe(false);

		// Control characters in tool names are sanitized and `compaction_end` distinguishes success vs abort/failure.
		adapter.observePiLiveEvent({
			type: "tool_execution_start",
			record: { toolName: "bash\u001b[31m\nrm", toolCallId: "tc-1" },
		});
		adapter.observePiLiveEvent({
			type: "compaction_end",
			record: { reason: "threshold", result: { firstKeptEntryId: "e9", tokensBefore: 10 }, aborted: false },
		});
		adapter.observePiLiveEvent({
			type: "compaction_end",
			record: { reason: "overflow", aborted: true },
		});
		adapter.observePiLiveEvent({
			type: "compaction_end",
			record: { reason: "overflow", errorMessage: "summary failed" },
		});
		const toolObs = observations.find((o) => o.body.kind === "tool-activity");
		expect(toolObs?.body.kind === "tool-activity" && toolObs.body.name).toBe("bash [31m rm");
		const compactions = observations.filter(
			(o) =>
				o.body.kind === "lifecycle" &&
				(o.body.event === "context-compacted" || o.body.event === "context-compaction-failed"),
		);
		expect(compactions.map((o) => (o.body.kind === "lifecycle" ? [o.body.event, o.body.detail] : null))).toEqual([
			["context-compacted", "threshold"],
			["context-compaction-failed", "aborted"],
			["context-compaction-failed", "failed"],
		]);

		// Reconnect BEFORE calling any adapter getter: the first forwarded event (omitting sourceInstanceId)
		// must adopt the new connectionInstance instead of being falsely dropped as a late event.
		connInstance = "conn-3";
		const postReconnect: EndoDevelopObservationV0[] = [];
		adapter.subscribeObservations((o) => postReconnect.push(o));
		adapter.observePiLiveEvent({ type: "agent_start", record: {} });
		expect(postReconnect).toHaveLength(1);
		expect(postReconnect[0]?.instanceId).toBe("conn-3");
		expect(postReconnect[0]?.body).toMatchObject({ kind: "lifecycle", event: "turn-started" });
	});

	it("refreshes fingerprint baseline on reconnect while still enforcing capabilityState match and mid-connection staleness", () => {
		const fp1 = makeStrongPiFingerprint("1.5.2", "1".repeat(64), "2".repeat(64));
		const fp2 = makeStrongPiFingerprint("1.5.2", "3".repeat(64), "4".repeat(64));
		const session = Object.assign(new FakeSession(), {
			fingerprint: fp1,
			capabilityState: makePiCapabilityState(fp1.id),
		});
		let connInstance = "conn-a";
		Object.defineProperty(session, "connectionInstance", { get: () => connInstance, configurable: true });

		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "pi-reconnect-fp-0001",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "after reconnect" };
		const oldProof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });

		// Simulate PiSessionAttachmentV0.reconnect(): new fingerprint observation + matching capabilityState + new connectionInstance.
		session.fingerprint = fp2;
		session.capabilityState = makePiCapabilityState(fp2.id);
		connInstance = "conn-b";

		// Old proof bound to conn-a is refused, while fresh proof on conn-b is admitted (NOT stuck stale).
		expect(adapter.admitOperation(req, oldProof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "stale-attachment",
		});
		const newProof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });
		expect(adapter.describe().evidenceFreshness.status).toBe("current");
		expect(adapter.admitOperation(req, newProof, { mode: "production", nowMs: NOW })).toEqual({ admitted: true });

		// Reconnect where capabilityState was NOT refreshed for the new fingerprint still refuses as stale.
		const fp3 = makeStrongPiFingerprint("1.6.0", "5".repeat(64), "6".repeat(64));
		session.fingerprint = fp3;
		connInstance = "conn-c";
		const staleProof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });
		expect(adapter.describe().evidenceFreshness.status).toBe("stale");
		expect(adapter.admitOperation(req, staleProof, { mode: "production", nowMs: NOW })).toMatchObject({
			admitted: false,
			code: "capability-stale",
		});
	});

	it("conservatively aggregates processCleanup across reconnected processes (never masks earlier incomplete or unverified teardown)", async () => {
		const sessionIncomplete = Object.assign(new FakeSession(), {
			processCleanup: async () => [
				{ boundary: "scope" as const, unit: "endo-pi-old.scope", result: "incomplete" as const, remaining: 2 },
				{ boundary: "scope" as const, unit: "endo-pi-new.scope", result: "confirmed" as const },
			],
		});
		const adapter1 = new PiDevelopAdapterV0({
			session: sessionIncomplete,
			attachmentId: "pi.default",
			launchId: "pi-cleanup-1",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const closed1 = await adapter1.close();
		expect(closed1.cleanup).toEqual({
			boundary: "scope",
			result: "incomplete",
			remainingProcesses: 2,
			scopeName: "endo-pi-old.scope",
		});

		const sessionUnverified = Object.assign(new FakeSession(), {
			processCleanup: async () => [
				{ boundary: "process-group" as const, result: "unverified" as const },
				{ boundary: "scope" as const, unit: "endo-pi-new.scope", result: "confirmed" as const },
			],
		});
		const adapter2 = new PiDevelopAdapterV0({
			session: sessionUnverified,
			attachmentId: "pi.default",
			launchId: "pi-cleanup-2",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const closed2 = await adapter2.close();
		expect(closed2.cleanup).toEqual({
			boundary: "process-group",
			result: "unverified",
			remainingProcesses: null,
			scopeName: null,
		});
	});

	it("normalizes string message content, keeps extension_ui_request pending until cancellation succeeds, and coordinates gap sequence numbers", () => {
		const session = new FakeSession();
		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "pi-obs-codex-fixes",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const observations: EndoDevelopObservationV0[] = [];
		adapter.subscribeObservations((o) => observations.push(o));

		// 1. Normal user message with string-valued content is normalized to text transcript (not dropped).
		adapter.observePiLiveEvent({
			type: "message_end",
			record: { message: { role: "user", content: "string prompt content" } },
		});
		// 2. Stale-instance event emits a gap at sequence 2.
		adapter.observePiLiveEvent({ type: "agent_start", record: {} }, "superseded-instance-id");
		// 3. Next normal event MUST receive sequence 3 (never colliding with gap sequence 2!).
		adapter.observePiLiveEvent({
			type: "extension_ui_request",
			record: { id: "dlg-1", method: "confirm" },
		});
		expect(adapter.snapshot().pendingNativeApprovalCount).toBe(1);
		// 4. Non-dialog UI notification emits nothing (not a false approval resolution).
		adapter.observePiLiveEvent({
			type: "extension_ui_request",
			record: { id: "note-1", method: "notify" },
		});
		expect(adapter.snapshot().pendingNativeApprovalCount).toBe(1);
		// 5. Unknown UI method emits pending `unknown` (never falsely cancelled) and increments snapshot pending count.
		adapter.observePiLiveEvent({
			type: "extension_ui_request",
			record: { id: "unk-1", method: "future_modal" },
		});
		expect(adapter.snapshot().pendingNativeApprovalCount).toBe(2);
		// 6. Only after attachment confirms dialog cancellation does `resolved` / `cancelled` emit and decrement count.
		adapter.observePiDialogCancelled({ id: "dlg-1", method: "confirm" });
		expect(adapter.snapshot().pendingNativeApprovalCount).toBe(1);
		// Rotating connection instance clears superseded pending approvals.
		adapter.rotateInstance();
		expect(adapter.snapshot().pendingNativeApprovalCount).toBe(0);

		expect(observations.map((o) => o.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(observations[0]?.body).toMatchObject({
			kind: "transcript",
			role: "user",
			contentKind: "text",
			text: "string prompt content",
		});
		expect(observations[1]?.body).toMatchObject({
			kind: "evidence-gap",
			gap: "late-event-from-prior-attachment",
		});
		expect(observations[2]?.body).toEqual({
			kind: "native-approval",
			phase: "requested",
			requestId: "dlg-1",
			approvalKind: "extension-dialog",
			resolution: "pending",
		});
		expect(observations[3]?.body).toEqual({
			kind: "native-approval",
			phase: "requested",
			requestId: "unk-1",
			approvalKind: "unknown",
			resolution: "pending",
		});
		expect(observations[4]?.body).toEqual({
			kind: "native-approval",
			phase: "resolved",
			requestId: "dlg-1",
			approvalKind: "extension-dialog",
			resolution: "cancelled",
		});
	});

	it("returns unknown when session connectionInstance rotates while dispatch is awaiting its reply", async () => {
		let connInstance = "conn-before";
		let resolvePrompt: ((disposition: string) => void) | null = null;
		const session = new FakeSession();
		Object.defineProperty(session, "connectionInstance", { get: () => connInstance, configurable: true });
		session.prompt = () =>
			new Promise<string>((resolve) => {
				resolvePrompt = resolve;
			});

		const adapter = new PiDevelopAdapterV0({
			session,
			attachmentId: "pi.default",
			launchId: "pi-dispatch-sync",
			projectScope: "/workspace/demo",
			now: () => NOW,
		});
		const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "in-flight" };
		const proof = buildOperatorProofV0({ adapter, request: req, nowMs: NOW });

		const pending = adapter.dispatch(req, proof, { mode: "production", nowMs: NOW });
		// Rotate connectionInstance mid-flight WITHOUT calling any getter or live event on adapter first.
		connInstance = "conn-after";
		resolvePrompt!("started");

		expect(await pending).toMatchObject({
			status: "unknown",
			operation: "prompt",
			instanceId: "conn-before",
			dispatched: true,
		});
	});

	it("wraps a real PiSessionAttachmentV0 talking to the deterministic fake Pi child process", async () => {
		const fakePi = installFakePi("1.5.2");
		const root = mkdtempSync(join(tmpdir(), "endo-adapter-pi-real-"));
		const workDir = mkdtempSync(join(tmpdir(), "endo-adapter-pi-cwd-"));
		try {
			const attachment = new PiAttachmentV0({
				root,
				attachment: "pi.default",
				executable: fakePi.bin,
				cwd: workDir,
				env: fakePiEnv(),
			});
			const id = await attachment.identify();
			expect(id.fingerprint).not.toBeNull();
			await attachment.checkLocal();

			const session = await attachment.openSession();
			try {
				const adapter = new PiDevelopAdapterV0({
					session,
					attachmentId: "pi.default",
					launchId: "real-fake-pi-0001",
					projectScope: workDir,
				});
				const d = adapter.describe();
				expect(endoDevelopAdapterDescriptorProblemV0(d)).toBeNull();
				expect(d.synthetic).toBe(false);
				expect(d.harness).toEqual({ family: "pi", observedVersion: "1.5.2" });
				expect(d.runtimeFingerprint.status).toBe("identified");
				expect(d.ownership).toMatchObject({ status: "established", value: "direct" });
				// Without a live study, steering capabilities remain unverified and fail closed at dispatch.
				expect(d.operations.steer.capability.standing).toBe("unverified");
				const steerReq: EndoDevelopOperationRequestV0 = { kind: "steer", message: "steer unverified" };
				const steerProof = buildOperatorProofV0({ adapter, request: steerReq, nowMs: Date.now() });
				expect(await adapter.dispatch(steerReq, steerProof)).toMatchObject({
					status: "refused",
					stage: "admission",
					code: "capability-not-admitted",
				});

				// Authorized prompt dispatches cleanly to the fake Pi child process.
				const promptReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hello fake pi" };
				const promptProof = buildOperatorProofV0({ adapter, request: promptReq, nowMs: Date.now() });
				const outcome = await adapter.dispatch(promptReq, promptProof);
				expect(outcome).toMatchObject({
					status: "accepted",
					operation: "prompt",
					turnId: null,
					receiptId: null,
					consequenceObserved: false,
				});

				const closed = await adapter.close();
				expect(closed.closed).toBe(true);
				expect(["unverified", "confirmed"]).toContain(closed.cleanup.result);
			} finally {
				await session.close();
			}
		} finally {
			fakePi.remove();
			rmSync(root, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Source boundary guard: synthetic specimen never enters production
// ---------------------------------------------------------------------------------------------------------------

describe("source guards", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const walk = (dir: string): string[] => {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
			return /\.(ts|tsx|mjs)$/.test(entry.name) ? [full] : [];
		});
	};

	const importSpecifiers = (file: string): string[] => {
		const source = readFileSync(file, "utf8");
		const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
		const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
		return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((m) => m[1]!);
	};

	it("no production module imports codex-adapter-specimen or develop-adapter-conformance", () => {
		const productionDirs = [
			"protocol",
			"runtime",
			"adapters",
			"storage",
			"cockpit",
			"cockpit-http",
			"cli",
			"studio-ui",
		];
		const leaks = productionDirs
			.flatMap((dir) => walk(join(repoRoot, dir)))
			.filter((file) =>
				importSpecifiers(file).some((spec) => /codex-adapter-specimen|develop-adapter-conformance/.test(spec)),
			)
			.map((file) => relative(repoRoot, file));
		expect(leaks).toEqual([]);
	});

	it("runtime/contracts/develop-adapter.ts imports no adapter, storage, or presentation surface", () => {
		const specs = importSpecifiers(join(repoRoot, "runtime/contracts/develop-adapter.ts"));
		expect(specs.filter((s) => /adapters\/|storage\/|develop-session\.ts/.test(s))).toEqual([]);
	});

	it("protocol/develop-adapter.ts imports only sibling protocol modules", () => {
		const specs = importSpecifiers(join(repoRoot, "protocol/develop-adapter.ts"));
		expect(specs.every((s) => /^\.\/[a-z-]+\.ts$/.test(s))).toBe(true);
	});

	it("payload digest changes deterministically if request payload changes (negative control)", () => {
		const a = endoDevelopOperationPayloadDigestV0({ kind: "prompt", message: "hello" });
		const b = endoDevelopOperationPayloadDigestV0({ kind: "prompt", message: "hello!" });
		const c = endoDevelopOperationPayloadDigestV0({ kind: "steer", message: "hello" });
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});
});
