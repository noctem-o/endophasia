import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0,
	preflightOpenClawCoordinatorV0,
} from "../adapters/coordinator/openclaw.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0 } from "../adapters/coordinator/wire.ts";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	readEndoAdvisoryProjectionV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import { parseEndoCoordinatorModelPoolV0 } from "../protocol/coordinator-model-pool.ts";
import {
	briefFromCoordinatorSubstrateV0,
	ENDO_COORDINATOR_GROUNDING_FAILURE_DIAGNOSTIC_SCHEMA_V1,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	type EndoCoordinatorBriefDiagnosticsV1,
	overrideCoordinatorDiagnosticsOnRefusalV1,
	validateEndoCoordinatorGroundingFailureDiagnosticV1,
} from "../runtime/contracts/coordinator-brief.ts";
import { DevelopAdvisoryStoreV0 } from "../storage/develop-advisory.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { buildCoordinatorStoreV0, cleanCoordinatorFixturesV0 } from "./coordinator-status-fixture.ts";

const dirs: string[] = [];
const scratch = (prefix = "endo-consolidation-") => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	cleanCoordinatorFixturesV0();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const validToolBody = (extra: Record<string, unknown> = {}) =>
	Buffer.from(
		JSON.stringify({
			model: "local-test-model",
			messages: [{ role: "user", content: "status" }],
			tools: [{ type: "function", function: ENDO_COORDINATOR_TOOL_DEFINITION_V0 }],
			stream: true,
			...COORDINATOR_INFERENCE_V0,
			...extra,
		}),
		"utf8",
	);

const sseWire = (chunks: readonly unknown[]) =>
	Buffer.from(
		`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
		"utf8",
	);

describe("COORDINATOR-CONSOLIDATION-001: extracted production hardening & diagnostics", () => {
	it("supports verified OpenClaw 2026.11.7 and 2026.11.10 in deterministic non-inference preflight", () => {
		expect(ENDO_COORDINATOR_SUPPORTED_OPENCLAW_VERSIONS_V0).toEqual(["2026.11.7", "2026.11.10"]);
		const dir = scratch();
		const runtimeDir = join(dir, "xdg");
		mkdirSync(runtimeDir, { mode: 0o700 });
		chmodSync(runtimeDir, 0o700);
		const prevXdg = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = runtimeDir;
		try {
			const projectId = "endo.project.0123456789abcdef0123456789abcdef";
			const pkgOk = join(dir, "oc-ok");
			mkdirSync(pkgOk);
			writeFileSync(join(pkgOk, "package.json"), JSON.stringify({ version: "2026.11.10" }));
			writeFileSync(join(pkgOk, "openclaw.mjs"), "// ok\n");
			const ok = preflightOpenClawCoordinatorV0(
				dir,
				{ projectId },
				{ openclaw: join(pkgOk, "openclaw.mjs"), origin: "http://127.0.0.1:8091" },
			);
			expect(ok).toEqual({ ok: true, harness: "OpenClaw 2026.11.10" });

			const pkgBad = join(dir, "oc-bad");
			mkdirSync(pkgBad);
			writeFileSync(join(pkgBad, "package.json"), JSON.stringify({ version: "2099.1.1" }));
			writeFileSync(join(pkgBad, "openclaw.mjs"), "// bad\n");
			const bad = preflightOpenClawCoordinatorV0(
				dir,
				{ projectId },
				{ openclaw: join(pkgBad, "openclaw.mjs"), origin: "http://127.0.0.1:8091" },
			);
			expect(bad).toMatchObject({ ok: false, reason: "runtime-unavailable" });
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = prevXdg;
		}
	});

	it("enforces closed wire request allowlist (F3) and records bounded reasoning counters without raw reasoning text (F9)", () => {
		const projectId = "endo.project.0123456789abcdef";
		const bearer = "test-secret-token";
		const headers: [string, string][] = [["Authorization", `Bearer ${bearer}`]];

		// Reject undeclared smuggling keys fail-closed.
		for (const smuggled of [
			{ reasoning_format: "raw" },
			{ chat_template_kwargs: { enable_thinking: true } },
			{ ignore_eos: true },
			{ n_predict: 99999 },
			{ max_completion_tokens: 99999 },
			{ store: true },
			{ tool_choice: "none" },
			{ stream_options: { include_usage: true, extra: 1 } },
		]) {
			const w = coordinatorWireV0(projectId, "{}", bearer);
			expect(w.request({ body: validToolBody(smuggled), headers })).toBe(false);
			expect(w.trace.refusal).toBe("model-unavailable");
		}

		// Accept valid request and capture bounded reasoning/visible counts with sanitized finishReason and zero raw reasoning text.
		const wire = coordinatorWireV0(projectId, "{}", bearer);
		expect(
			wire.request({ body: validToolBody({ stream_options: { include_usage: true }, store: false }), headers }),
		).toBe(true);
		const secretThinking = "SECRET_PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_BE_STORED";
		expect(
			wire.response({
				status: 200,
				wire: sseWire([
					{
						choices: [{ index: 0, delta: { reasoning_content: secretThinking }, finish_reason: null }],
					},
					{
						choices: [{ index: 0, delta: {}, finish_reason: "length" }],
						usage: {
							prompt_tokens: 120,
							completion_tokens: 2048,
							completion_tokens_details: { reasoning_tokens: 2048 },
						},
					},
				]),
			}),
		).toBe(true);
		const resp = wire.trace.responses[0]!;
		expect(resp.finish).toBe("length");
		expect(resp.sawReasoning).toBe(true);
		expect(resp.reasoningChars).toBe(secretThinking.length);
		expect(resp.sawVisibleContent).toBe(false);
		expect(resp.visibleChars).toBe(0);
		expect(resp.reasoningTokens).toBe(2048);
		expect(JSON.stringify(wire.trace)).not.toContain(secretThinking);

		// Sanitize adversarial finish_reason strings.
		const wireWeird = coordinatorWireV0(projectId, "{}", bearer);
		expect(wireWeird.request({ body: validToolBody(), headers })).toBe(true);
		expect(
			wireWeird.response({
				status: 200,
				wire: sseWire([
					{ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "bad\nreason<script>" }] },
				]),
			}),
		).toBe(true);
		expect(wireWeird.trace.responses[0]!.finish).toBe("other");
	});

	it("validates bounded grounding-failure diagnostics (A3) and rejects raw text or unknown fields", () => {
		const valid = validateEndoCoordinatorGroundingFailureDiagnosticV1({
			schemaVersion: ENDO_COORDINATOR_GROUNDING_FAILURE_DIAGNOSTIC_SCHEMA_V1,
			stage: "claim-verify",
			ruleCode: "claim-predicate-unsupported",
			claimIndex: 2,
			subjectKind: "task",
			predicateCategory: "verification",
			refResolution: "resolved",
			recommendationCode: "none",
			rawModelTextStored: false,
		});
		expect(valid.rawModelTextStored).toBe(false);
		expect(valid.stage).toBe("claim-verify");

		// Reject extra fields (e.g., raw model text smuggling).
		expect(() =>
			validateEndoCoordinatorGroundingFailureDiagnosticV1({
				...valid,
				rawText: "model output",
			}),
		).toThrow();
		// Reject rawModelTextStored !== false.
		expect(() =>
			validateEndoCoordinatorGroundingFailureDiagnosticV1({
				...valid,
				rawModelTextStored: true,
			}),
		).toThrow();
		// Reject out-of-range claimIndex.
		expect(() =>
			validateEndoCoordinatorGroundingFailureDiagnosticV1({
				...valid,
				claimIndex: 999,
			}),
		).toThrow();
	});

	it("overrides diagnostics terminationClass when briefFromCoordinatorSubstrateV0 refuses a malformed available result", async () => {
		const initialDiag: EndoCoordinatorBriefDiagnosticsV1 = {
			schemaVersion: "endo.coordinator-brief-diagnostics.v1",
			terminationClass: "completed-published",
			stagesReached: [
				"preflight",
				"status-read",
				"relay-started",
				"exchange-1",
				"tool-dispatched",
				"exchange-2",
				"validated",
			],
			openclawExitOk: true,
			exchanges: [],
			effectiveMaxOutputTokens: 2048,
			reasoningControlMode: "unchanged",
			rawReasoningStored: false,
		};
		const overridden = overrideCoordinatorDiagnosticsOnRefusalV1(initialDiag, "ungrounded");
		expect(overridden?.terminationClass).toBe("grounding-refused");
		expect(overridden?.stagesReached).not.toContain("validated");

		const refused = await briefFromCoordinatorSubstrateV0(
			{ projectId: "endo.project.0123456789abcdef" },
			{
				brief: async () => ({
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: "endo.project.0123456789abcdef",
					runtime: { harness: "OpenClaw 2026.11.10", provider: "test", model: "m" },
					diagnostics: initialDiag,
					availability: "available",
					answer: "   ",
					evidence: { readAtMs: 1000, projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
					toolSurface: ["endophasia_status"],
				}),
			},
		);
		expect(refused.availability).toBe("unavailable");
		if (refused.availability === "unavailable") {
			expect(refused.reason).toBe("ungrounded");
			expect(refused.diagnostics?.terminationClass).toBe("grounding-refused");
			expect(refused.diagnostics?.stagesReached).not.toContain("validated");
		}
	});

	it("S2 Phase D.5 preflight fails closed as not-dispatched with zero token charge and releases idle leases immediately", async () => {
		const { root, projectId } = await buildCoordinatorStoreV0();
		const tasks = new DevelopTasksStoreV0(root).read();
		expect(tasks.ok).toBe(true);
		const clock = 1_700_000_000_000;
		const now = () => clock;

		// Idle tick (no schedules) acquires & releases lease immediately inside Phase A.
		const idle = await runEndoAdvisoryTickV0({ root, now });
		expect(idle.ok).toBe(true);
		const leaseAfterIdle = new DevelopAdvisoryStoreV0(root).readLease();
		expect(leaseAfterIdle.ok && leaseAfterIdle.exists && leaseAfterIdle.value.releasedAtMs !== null).toBe(true);

		// Add, enable, and authorize one advisory schedule.
		const pool = parseEndoCoordinatorModelPoolV0({
			schemaVersion: "endo.coordinator-model-pool.v0",
			selection: { fallback: "none", unconfirmedModel: "refuse" },
			members: [
				{
					memberId: "m1",
					kind: "local-openai-compat",
					endpoint: "http://127.0.0.1:18099",
					modelId: "test-model",
					priority: 1,
					maxPromptBytes: 8192,
					maxOutputTokens: 2048,
					timeoutMs: 60_000,
					advisoryOnly: true,
				},
			],
		});
		const added = addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-preflight",
				label: "Preflight test",
				projectId,
				actionKind: "generate-advisory-brief",
				wake: "on-change",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 60_000, anchorMs: clock },
			},
			now,
		);
		expect(added.ok).toBe(true);
		const enabled = setEndoAdvisoryScheduleEnabledV0(root, "sched-preflight", true, 1, now);
		expect(enabled.ok).toBe(true);
		const auth = authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "sched-preflight",
				scheduleRevision: 2,
				pool,
				policy: {
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 60_000,
					permitCapacityUnknown: true,
					permitModelUnconfirmed: false,
					permitPartialObservation: true,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 4,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: 16_384,
					maxTurnWallClockMs: 60_000,
				},
				lifetimeMs: 3_600_000,
			},
			now,
		);
		expect(auth.ok).toBe(true);

		let runCalled = false;
		const tick = await runEndoAdvisoryTickV0({
			root,
			now,
			observeMember: async (m) => ({
				memberId: m.memberId,
				endpoint: m.endpoint,
				modelId: m.modelId,
				basis: "controller-observed",
				observedAtMs: now(),
				elapsedMs: 5,
				readiness: "ready",
				detail: "slot-idle",
				backend: "llama.cpp-single",
				build: null,
				requests: [{ path: "/health", status: 200 }],
				inferenceTokens: 0,
			}),
			preflight: () => ({ ok: false, reason: "runtime-unavailable", detail: "simulated OpenClaw mismatch" }),
			run: async () => {
				runCalled = true;
				throw new Error("should never run after failed preflight");
			},
		});
		expect(tick.ok).toBe(true);
		if (tick.ok) {
			expect(tick.inferenceDispatched).toBe(false);
		}
		expect(runCalled).toBe(false);

		const proj = readEndoAdvisoryProjectionV0(root, { now });
		expect(proj.briefings).toHaveLength(1);
		expect(proj.briefings[0]).toMatchObject({
			availability: "not-dispatched",
			refusal: "runtime-preflight-failed",
			accounting: {
				admittedExchanges: 0,
				chargedCompletionRequests: 0,
				chargedGeneratedTokens: 0,
			},
		});
		expect(proj.schedules[0]?.budget?.turnsCharged).toBe(0);
		expect(proj.schedules[0]?.budget?.generatedTokensCharged).toBe(0);
	});
});
