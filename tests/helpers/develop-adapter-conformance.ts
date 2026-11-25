// Reusable conformance test suite for any `EndoDevelopLiveAdapterV0` implementation.
//
// Intended to be reused by Pi (reference integration), the Codex conformance specimen, and the forthcoming
// live Codex adapter (`DEVELOP-CODEX-LIVE-001`). Every test runs at the actual operational boundary (`admitOperation`,
// `dispatch`, `handleNativeApproval`, `subscribeObservations`), not merely on presentation projections.

import { describe, expect, it } from "vitest";
import {
	type EndoDevelopAuthorityProofV0,
	type EndoDevelopObservationV0,
	type EndoDevelopOperationRequestV0,
	endoAdapterSessionKeyV0,
	endoDevelopAdapterDescriptorProblemV0,
	endoDevelopObservationProblemV0,
} from "../../protocol/develop-adapter.ts";
import {
	type EndoDevelopLiveAdapterV0,
	endoDevelopOperationPayloadDigestV0,
} from "../../runtime/contracts/develop-adapter.ts";

export interface DevelopAdapterConformanceDriverV0 {
	readonly name: string;
	readonly mode: "production" | "fixture";
	/** Create a fresh, connected, directly owned adapter ready for a baseline prompt. */
	createReady(): Promise<{
		adapter: EndoDevelopLiveAdapterV0;
		nowMs(): number;
		/** Build a valid operator authority proof for the adapter's current state and request. */
		authorize(
			request: EndoDevelopOperationRequestV0,
			overrides?: Partial<EndoDevelopAuthorityProofV0>,
		): EndoDevelopAuthorityProofV0;
		/** Rotate attachment/connection instance (simulates reconnect / process restart). */
		rotateInstance(): string;
		/** Disconnect transport without terminating the underlying process/session. */
		disconnect(reason?: string): void;
		/** Mark capability evidence stale (e.g. config or fingerprint change). */
		invalidateEvidence(reason: string): void;
		/** Inject a raw observation into the adapter's guarded stream. */
		injectObservation(obs: EndoDevelopObservationV0): void;
		/** Cleanup resources created for this test case. */
		cleanup(): Promise<void>;
	}>;
}

/** Standard helper to build an operator authority proof for an adapter's current descriptor. */
export function buildOperatorProofV0(args: {
	adapter: EndoDevelopLiveAdapterV0;
	request: EndoDevelopOperationRequestV0;
	nowMs: number;
	overrides?: Partial<EndoDevelopAuthorityProofV0>;
}): EndoDevelopAuthorityProofV0 {
	const d = args.adapter.describe();
	const sessionKey = endoAdapterSessionKeyV0(d.session);
	if (sessionKey === null) throw new Error("cannot build proof without an established sessionKey");
	if (d.controlPath === null) throw new Error("cannot build proof without a controlPath");
	return {
		authorizationId: "endo.evidence.conformance-auth-0001",
		operation: args.request.kind,
		source: d.session.source,
		sessionKey,
		attachmentId: d.attachment.attachmentId,
		launchId: d.attachment.launchId,
		instanceId: d.attachment.instanceId,
		controlPath: d.controlPath,
		projectScope: d.attachment.projectScope,
		payloadDigest: endoDevelopOperationPayloadDigestV0(args.request),
		mechanism: "terminal-phrase",
		sessionGrantId: null,
		authorizedAtMs: args.nowMs,
		expiresAtMs: args.nowMs + 60_000,
		...args.overrides,
	};
}

/**
 * Run the shared operational conformance suite against any adapter implementing `EndoDevelopLiveAdapterV0`.
 * Future live adapters (such as `DEVELOP-CODEX-LIVE-001`) call this directly in their own Vitest suite.
 */
export function runDevelopAdapterConformanceSuiteV0(driver: DevelopAdapterConformanceDriverV0): void {
	describe(`develop-adapter conformance: ${driver.name}`, () => {
		it("publishes a valid closed descriptor and keeps display alias distinct from identity key", async () => {
			const ctx = await driver.createReady();
			try {
				const d = ctx.adapter.describe();
				expect(endoDevelopAdapterDescriptorProblemV0(d, { allowSynthetic: driver.mode === "fixture" })).toBeNull();
				const key = endoAdapterSessionKeyV0(d.session);
				expect(key).not.toBeNull();
				// Attempting to authorize using display alias (instead of source-qualified sessionKey) must fail closed.
				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hello" };
				const aliasAsKey = d.session.alias ?? "alias-not-key";
				expect(aliasAsKey).not.toBe(key);
				const proof = ctx.authorize(req, { sessionKey: aliasAsKey });
				const decision = ctx.adapter.admitOperation(req, proof, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(decision).toMatchObject({ admitted: false, code: "cross-session-control" });
			} finally {
				await ctx.cleanup();
			}
		});

		it("separates admitted capability from operator authorization (missing proof always fails closed)", async () => {
			const ctx = await driver.createReady();
			try {
				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "run task" };
				expect(ctx.adapter.describe().operations.prompt.capability.standing).toMatch(/^admitted/);
				const decision = ctx.adapter.admitOperation(req, null, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(decision).toMatchObject({ admitted: false, code: "missing-authority" });
				const outcome = await ctx.adapter.dispatch(req, null, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(outcome).toMatchObject({ status: "refused", stage: "admission", code: "missing-authority" });
			} finally {
				await ctx.cleanup();
			}
		});

		it("enforces source, session, attachment instance, project scope, payload digest, and expiry boundaries", async () => {
			const ctx = await driver.createReady();
			try {
				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "authorized prompt" };
				const now = ctx.nowMs();

				// Negative control: exact matching proof IS admitted.
				expect(ctx.adapter.admitOperation(req, ctx.authorize(req), { mode: driver.mode, nowMs: now })).toEqual({
					admitted: true,
				});

				// Cross-source control attempt.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { source: "other-harness" }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "cross-source-control" });

				// Control-path mismatch.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { controlPath: "foreign-broker" }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "control-path-mismatch" });

				// Cross-session control attempt.
				expect(
					ctx.adapter.admitOperation(
						req,
						ctx.authorize(req, {
							sessionKey: `${ctx.adapter.describe().session.source}:persistent:other-session`,
						}),
						{ mode: driver.mode, nowMs: now },
					),
				).toMatchObject({ admitted: false, code: "cross-session-control" });

				// Mismatched project scope.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { projectScope: "/workspace/different-project" }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "project-scope-mismatch" });

				// Tampered payload digest.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { payloadDigest: "0".repeat(64) }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "authority-payload-mismatch" });

				// Wrong operation.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { operation: "stop" }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "authority-operation-mismatch" });

				// Expired authorization.
				expect(
					ctx.adapter.admitOperation(req, ctx.authorize(req, { expiresAtMs: now - 1 }), {
						mode: driver.mode,
						nowMs: now,
					}),
				).toMatchObject({ admitted: false, code: "authority-expired" });
			} finally {
				await ctx.cleanup();
			}
		});

		it("invalidates prior attachment authority on reconnect / instance rotation (TOCTOU)", async () => {
			const ctx = await driver.createReady();
			try {
				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "before reconnect" };
				const earlierProof = ctx.authorize(req);
				expect(ctx.adapter.admitOperation(req, earlierProof, { mode: driver.mode, nowMs: ctx.nowMs() })).toEqual({
					admitted: true,
				});

				// Rotate connection instance: earlier proof must now fail closed.
				ctx.rotateInstance();
				const after = await ctx.adapter.dispatch(req, earlierProof, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(after).toMatchObject({ status: "refused", stage: "admission", code: "stale-attachment" });
			} finally {
				await ctx.cleanup();
			}
		});

		it("distinguishes connection loss from process termination and refuses dispatch while disconnected", async () => {
			const ctx = await driver.createReady();
			try {
				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "while offline" };
				const proof = ctx.authorize(req);
				ctx.disconnect("simulated transport disconnect");

				const snap = ctx.adapter.snapshot();
				expect(snap.connection.state).toBe("disconnected");
				// Connection loss alone must NEVER report confirmed process termination.
				expect(snap.processCleanup.result).not.toBe("confirmed");
				expect(snap.stateClaims).toEqual([]);

				const outcome = await ctx.adapter.dispatch(req, proof, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(outcome).toMatchObject({ status: "refused", stage: "admission", code: "not-connected" });
			} finally {
				await ctx.cleanup();
			}
		});

		it("never silently converts unsupported native commands (e.g. /voice on) into ordinary prompt text", async () => {
			const ctx = await driver.createReady();
			try {
				const d = ctx.adapter.describe();
				expect(d.operations.nativeCommand.allowsArbitraryShell).toBe(false);
				if (d.operations.nativeCommand.transport === "unsupported") {
					const req: EndoDevelopOperationRequestV0 = {
						kind: "native-command",
						command: "/voice",
						args: ["on"],
					};
					const proof = ctx.authorize(req);
					const outcome = await ctx.adapter.dispatch(req, proof, { mode: driver.mode, nowMs: ctx.nowMs() });
					expect(outcome).toMatchObject({
						status: "refused",
						stage: "admission",
						code: "native-command-unsupported",
					});
				}
			} finally {
				await ctx.cleanup();
			}
		});

		it("never treats dispatch acceptance as proven consequence and validates observation ordering/dedup/stale-instance guards", async () => {
			const ctx = await driver.createReady();
			try {
				const seen: EndoDevelopObservationV0[] = [];
				const stopSub = ctx.adapter.subscribeObservations((obs) => seen.push(obs));

				const req: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "hello conformance" };
				const proof = ctx.authorize(req);
				const outcome = await ctx.adapter.dispatch(req, proof, { mode: driver.mode, nowMs: ctx.nowMs() });
				expect(outcome.status).toBe("accepted");
				if (outcome.status === "accepted") {
					// Acceptance is NEVER proof of consumption or completion.
					expect(outcome.consequenceObserved).toBe(false);
				}

				// Inject a valid observation, then a duplicate, then an out-of-order one, then a late event from a stale instance.
				const d = ctx.adapter.describe();
				const baseObs: EndoDevelopObservationV0 = {
					schemaVersion: "endo.develop-adapter-observation.v0",
					observationId: "conformance-obs-10",
					source: d.session.source,
					sessionKey: endoAdapterSessionKeyV0(d.session),
					attachmentId: d.attachment.attachmentId,
					instanceId: d.attachment.instanceId,
					sequence: 100,
					observedAt: new Date(ctx.nowMs()).toISOString(),
					basis: "runtime-reported",
					nativeIds: { sessionId: null, turnId: null, itemId: null, entryId: null },
					body: {
						kind: "usage",
						usage: { status: "unavailable", reason: "usage omitted by runtime in test" },
					},
				};
				expect(endoDevelopObservationProblemV0(baseObs)).toBeNull();
				ctx.injectObservation(baseObs);
				// Duplicate id -> flagged as duplicate-event gap, not delivered twice as accepted.
				ctx.injectObservation(baseObs);
				// Out-of-order sequence -> delivered with explicit out-of-order-event gap.
				ctx.injectObservation({ ...baseObs, observationId: "conformance-obs-11", sequence: 99 });
				// Late event from an earlier connection instance -> rejected with explicit late-event-from-prior-attachment gap.
				ctx.injectObservation({
					...baseObs,
					observationId: "conformance-obs-stale",
					instanceId: "earlier-instance-0000",
					sequence: 101,
				});

				const gaps = seen
					.filter((o) => o.body.kind === "evidence-gap")
					.map((o) => (o.body.kind === "evidence-gap" ? o.body.gap : ""));
				expect(gaps).toContain("duplicate-event");
				expect(gaps).toContain("out-of-order-event");
				expect(gaps).toContain("late-event-from-prior-attachment");
				expect(seen.filter((o) => o.observationId === "conformance-obs-10")).toHaveLength(1);
				expect(seen.filter((o) => o.observationId === "conformance-obs-stale")).toHaveLength(0);

				stopSub();
			} finally {
				await ctx.cleanup();
			}
		});

		it("fails closed on native approval requests with no decision or unknown kind", async () => {
			const ctx = await driver.createReady();
			try {
				const d = ctx.adapter.describe();
				const sessionKey = endoAdapterSessionKeyV0(d.session)!;
				const unknownReq = {
					requestId: "native-req-unknown-1",
					source: d.session.source,
					sessionKey,
					instanceId: d.attachment.instanceId,
					turnId: null,
					itemId: "item-1",
					approvalKind: "unknown" as const,
					nativeMethod: "item/futureUnknown/requestApproval",
					requestedScope: "once" as const,
					summary: "unknown native approval",
				};
				const res = ctx.adapter.handleNativeApproval(unknownReq, null, { nowMs: ctx.nowMs() });
				expect(res.resolution).not.toBe("accepted");
				expect(res.grantsEndophasiaAuthority).toBe(false);
			} finally {
				await ctx.cleanup();
			}
		});

		it("refuses previously admissible operations with capability-stale when evidence becomes stale", async () => {
			const ctx = await driver.createReady();
			try {
				ctx.invalidateEvidence("runtime configuration digest changed");
				const d = ctx.adapter.describe();
				expect(d.evidenceFreshness.status).toBe("stale");
				// Even baseline prompt must fail closed with `capability-stale` once evidence/runtime is stale.
				const promptReq: EndoDevelopOperationRequestV0 = { kind: "prompt", message: "after runtime drift" };
				const promptDecision = ctx.adapter.admitOperation(promptReq, ctx.authorize(promptReq), {
					mode: driver.mode,
					nowMs: ctx.nowMs(),
				});
				expect(promptDecision).toMatchObject({ admitted: false, code: "capability-stale" });

				const stopReq: EndoDevelopOperationRequestV0 = { kind: "stop" };
				const stopDecision = ctx.adapter.admitOperation(stopReq, ctx.authorize(stopReq), {
					mode: driver.mode,
					nowMs: ctx.nowMs(),
				});
				expect(stopDecision).toMatchObject({ admitted: false, code: "capability-stale" });
			} finally {
				await ctx.cleanup();
			}
		});
	});
}
