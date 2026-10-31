/**
 * The live study's lifecycle-key inspection and the run.identity result it supports (adapters/pi/checks.ts), and what
 * redefining the check does to recorded evidence.
 *
 * Pi 1.1.0 added a documented `aborted` Boolean to `agent_settled` (Pi 1.4.0 docs/json.md). Check version 2 read it as an
 * undocumented key and classified run.identity MISMATCH. Version 3 recognizes it as a termination flag that identifies
 * nothing, and still reports every other key and a mistyped flag. The fake Pi reproduces both event shapes
 * (tests/fixtures/fake-pi/cli.mjs); tests/pi-real-runtime.test.ts exercises an installed Pi.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piAssessmentV0 } from "../adapters/pi/assessment.ts";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import {
	inspectPiLifecycleSurfaceV0,
	PI_CHECK_DEFINITIONS_V0,
	PI_LIVE_STUDY_CHECK,
	runIdentityResultV0,
} from "../adapters/pi/checks.ts";
import {
	derivePiCapabilityStateV0,
	piCheckDefinitionDigestV0,
	piConfigurationDigestV0,
	piDependenciesV0,
	piEvidenceV0,
	piEvidenceValidityV0,
} from "../adapters/pi/evidence.ts";
import type { EndoCapabilityEvidenceV0, EndoHarnessFingerprintRecordV0 } from "../protocol/harness.ts";
import { validateEndoCapabilityEvidenceV0 } from "../protocol/harness.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

function setup(scenario = "", version = "1.0.0") {
	const install = installFakePi(version);
	if (scenario !== "") install.setScenario(scenario);
	const root = mkdtempSync(join(tmpdir(), "endo-pi-surface-"));
	const cwd = mkdtempSync(join(tmpdir(), "endo-pi-surface-cwd-"));
	const agentDir = join(root, "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	cleanup.push(() => {
		install.remove();
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	const env = fakePiEnv({ FAKE_PI_STEP_MS: "15", PI_CODING_AGENT_DIR: agentDir });
	const attach = () => new PiAttachmentV0({ root, cwd, executable: install.bin, env, requestTimeoutMs: 10_000 });
	return { install, root, attach };
}

const entry = (
	state: { capabilities: { capability: string; status: string; classification: string | null; reason: string }[] },
	id: string,
) => state.capabilities.find((e) => e.capability === id)!;

const ev = (type: string, record: Record<string, unknown> = {}) => ({ type, record: { type, ...record } });
const settled = (extra: Record<string, unknown> = {}) => ev("agent_settled", extra);
/** One short run's lifecycle events in Pi 1.0.x shape (agent_settled carries only its type). */
const run = (end: ReturnType<typeof ev> = settled()) => [
	ev("agent_start"),
	ev("turn_start"),
	ev("turn_end", { message: {}, toolResults: [] }),
	ev("agent_end", { messages: [], willRetry: false }),
	end,
];

describe("inspectPiLifecycleSurfaceV0: the documented lifecycle shapes", () => {
	it("accepts Pi 1.0.x: agent_settled with only its type", () => {
		expect(inspectPiLifecycleSurfaceV0(run())).toEqual({ events: 5, undocumented: [], malformed: [], flags: [] });
	});

	it("accepts Pi 1.4.0: agent_settled with aborted false or true, and reports the flag as a flag", () => {
		for (const aborted of [false, true]) {
			const surface = inspectPiLifecycleSurfaceV0(run(settled({ aborted })));
			expect(surface.undocumented).toEqual([]);
			expect(surface.malformed).toEqual([]);
			expect(surface.flags).toEqual([`agent_settled.aborted=${aborted}`]);
		}
	});

	it("rejects an aborted value that is not a Boolean, as malformed, not as accepted and not as an identifier", () => {
		for (const [value, label] of [
			["false", "string"],
			["", "string"],
			[0, "number"],
			[1, "number"],
			[null, "null"],
			[[], "object"],
			[{}, "object"],
			[undefined, "undefined"],
		] as const) {
			const surface = inspectPiLifecycleSurfaceV0(run(settled({ aborted: value })));
			expect(surface.malformed, String(value)).toEqual([`agent_settled.aborted (${label})`]);
			expect(surface.flags, String(value)).toEqual([]);
			expect(surface.undocumented, String(value)).toEqual([]);
		}
	});

	it("still reports an unrelated unexpected key and every identifier-shaped key, on any lifecycle event", () => {
		for (const key of [
			"foo",
			"runId",
			"turnId",
			"id",
			"sessionId",
			"operationId",
			"parentToolCallId",
			"aborted_at",
		]) {
			for (const type of ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled"]) {
				const events = run().map((e) => (e.type === type ? ev(type, { ...e.record, [key]: "x" }) : e));
				expect(inspectPiLifecycleSurfaceV0(events).undocumented, `${type}.${key}`).toEqual([`${type}.${key}`]);
			}
		}
	});

	it("accepts aborted only where Pi documents it: on agent_settled and nowhere else", () => {
		const events = run().map((e) => (e.type === "agent_end" ? ev("agent_end", { ...e.record, aborted: false }) : e));
		const surface = inspectPiLifecycleSurfaceV0(events);
		expect(surface.undocumented).toEqual(["agent_end.aborted"]);
		expect(surface.flags).toEqual([]);
	});

	it("keeps an accepted flag and an unreviewed key apart when both are present", () => {
		const surface = inspectPiLifecycleSurfaceV0(run(settled({ aborted: false, runId: "r1" })));
		expect(surface.flags).toEqual(["agent_settled.aborted=false"]);
		expect(surface.undocumented).toEqual(["agent_settled.runId"]);
	});

	it("ignores event types it does not inspect, including names that are object-prototype members", () => {
		const events = [
			ev("message_update", { usage: {} }),
			ev("constructor", { x: 1 }),
			ev("__proto__", { y: 1 }),
			ev("toString"),
		];
		expect(inspectPiLifecycleSurfaceV0(events)).toEqual({ events: 0, undocumented: [], malformed: [], flags: [] });
		expect(inspectPiLifecycleSurfaceV0([])).toEqual({ events: 0, undocumented: [], malformed: [], flags: [] });
	});

	it("reproduces the original false MISMATCH: the version-2 key table flagged the documented field", () => {
		const version2 = {
			agent_start: ["type"],
			turn_start: ["type"],
			turn_end: ["type", "message", "toolResults"],
			agent_end: ["type", "messages", "willRetry"],
			agent_settled: ["type"],
		} as Record<string, string[]>;
		const old = run(settled({ aborted: false })).flatMap((e) =>
			Object.keys(e.record)
				.filter((k) => !version2[e.type]!.includes(k))
				.map((k) => `${e.type}.${k}`),
		);
		expect(old).toEqual(["agent_settled.aborted"]); // what version 2 called "undocumented keys" on Pi 1.4.0
		expect(inspectPiLifecycleSurfaceV0(run(settled({ aborted: false }))).undocumented).toEqual([]);
	});
});

describe("the live study's run.identity result", () => {
	const study = async (scenario: string, version = "1.0.0") => {
		const { attach } = setup(scenario, version);
		const pi = attach();
		await pi.checkLocal();
		const studied = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		return { pi, ...studied };
	};

	it("is UNAVAILABLE on Pi 1.0.x events (no aborted field)", async () => {
		const { state, pi } = await study("");
		expect(entry(state, "run.identity")).toMatchObject({ status: "unavailable", classification: "UNAVAILABLE" });
		const record = pi.registry
			.list("evidence")
			.find((r) => r.capability === "run.identity" && r.check.name === "pi.live.study")!;
		expect(record.observed).toMatch(/only documented keys: no run or turn identifier$/);
	});

	it("is UNAVAILABLE on Pi 1.4.0 events (agent_settled.aborted), with an observation that names the flag and denies it identity", async () => {
		const { state, pi } = await study("settled-aborted", "1.4.0");
		expect(entry(state, "run.identity")).toMatchObject({ status: "unavailable", classification: "UNAVAILABLE" });
		const record = pi.registry
			.list("evidence")
			.find((r) => r.capability === "run.identity" && r.check.name === "pi.live.study")!;
		// The short prompt of step 1 was not aborted: the observation is that run's flag, not the later STOP step's.
		expect(record.observed).toContain("agent_settled.aborted=false is a documented termination flag");
		expect(record.observed).toContain("identifies no run or turn");
		expect(record.limitations.join(" ")).toMatch(/not an identifier.*not proof that a STOP request ended the run/);
		expect(record.check).toMatchObject({ name: "pi.live.study", version: "3" });
	});

	it("does not change any other live-study result: a settlement flag moves only run.identity's observation", async () => {
		const plain = await study("");
		const flagged = await study("settled-aborted", "1.4.0");
		for (const capability of [
			"lifecycle.trace",
			"steering.stop",
			"steering.steer",
			"steering.follow-up",
			"usage.entries",
			"tool.activity",
			"operation.outcome",
			"session.identity",
		]) {
			const a = entry(plain.state, capability);
			const b = entry(flagged.state, capability);
			expect([capability, b.status, b.classification]).toEqual([capability, a.status, a.classification]);
		}
		expect(entry(flagged.state, "steering.stop")).toMatchObject({ classification: "PARTIAL" });
	});

	it("is MISMATCH, needing review, for a mistyped aborted value", async () => {
		for (const kind of ["string", "number", "null"]) {
			const { state, pi } = await study(`settled-aborted:${kind}`);
			expect(entry(state, "run.identity").status, kind).toBe("mismatch");
			const record = pi.registry
				.list("evidence")
				.find((r) => r.capability === "run.identity" && r.check.name === "pi.live.study")!;
			expect(record.observed, kind).toContain(
				`documented fields of the wrong type (agent_settled.aborted (${kind}))`,
			);
		}
	});

	it("is MISMATCH for an identifier-shaped key beside the flag, and for an unrelated unreviewed key", async () => {
		for (const scenario of [
			"settled-aborted,run-ids",
			"settled-aborted,settled-key:runId",
			"settled-key:somethingNew",
		]) {
			const { state } = await study(scenario);
			expect(entry(state, "run.identity").status, scenario).toBe("mismatch");
		}
	});

	it("is inconclusive, never UNAVAILABLE or MISMATCH, when no settled run was observed", () => {
		const clean = inspectPiLifecycleSurfaceV0(run(settled({ aborted: false })));
		const dirty = inspectPiLifecycleSurfaceV0(run(settled({ aborted: "x", runId: "r" })));
		for (const surface of [clean, dirty, inspectPiLifecycleSurfaceV0([])]) {
			const result = runIdentityResultV0(surface, false);
			expect(result.classification).toBe("inconclusive");
			expect(result.limitations.join(" ")).not.toMatch(/termination flag/);
		}
		expect(runIdentityResultV0(clean, true).classification).toBe("UNAVAILABLE");
		expect(runIdentityResultV0(dirty, true).classification).toBe("MISMATCH");
		// An empty inspection of a settled run (no lifecycle events at all) is still not a claim of anything beyond "no identifier seen".
		expect(runIdentityResultV0(inspectPiLifecycleSurfaceV0([]), true).classification).toBe("UNAVAILABLE");
	});

	it("records nothing when the study cannot complete a step", async () => {
		const { attach } = setup("settled-aborted");
		const pi = attach();
		await pi.checkLocal();
		await expect(pi.studyLive({ authorized: true, stepTimeoutMs: 1 })).rejects.toThrow();
		expect(pi.registry.list("evidence").filter((r) => r.check.name === "pi.live.study")).toEqual([]);
	});
});

describe("redefining pi.live.study (version 2 → 3) and recorded evidence", () => {
	const PROCEDURE_V2 =
		"in a scratch workspace and persistent scratch session: (1) a short prompt, observing the lifecycle event order, the keys each lifecycle event carries, the keys of the prompt response, and the assistant entry's usage; (2) a prompt asking for the read tool on a fixture file, observing tool_execution_start/end correlation; (3) a long prompt with a steer sent after agent_start, checking the marker is consumed by that run; (4) the same with follow_up, checking a later run consumes it; (5) a long prompt aborted after agent_start, checking the run ends; (6) a second process on the same session id, checking the session id and earlier entry ids persist";
	const V2 = { ...PI_LIVE_STUDY_CHECK, version: "2", procedure: PROCEDURE_V2 };
	const AT = "2026-10-03T10:00:00.000Z";
	const fingerprint = {
		id: `endo.evidence.pi-fingerprint.${"1".repeat(64)}`,
		identity: { digest: "2".repeat(64), confidence: "strong" },
	} as EndoHarnessFingerprintRecordV0;
	const record = (
		definition: typeof V2,
		capability: string,
		classification: "UNAVAILABLE" | "MISMATCH" | "QUALIFIED" | "EXACT",
	) =>
		piEvidenceV0({
			attachment: "pi.default",
			capability,
			definition,
			dependencies: piDependenciesV0(fingerprint, piConfigurationDigestV0(definition.kind, {})),
			inputs: {},
			expected: "e",
			observed: "o",
			classification,
			evidence: [],
			limitations: [],
			at: AT,
		});
	const current = {
		fingerprint,
		definitions: PI_CHECK_DEFINITIONS_V0,
		configurationDigest: (kind: "static-surface" | "local-protocol" | "live-study") =>
			piConfigurationDigestV0(kind, {}),
	};

	it("the reconstructed version-2 definition is the one that was recorded (so the tests below use the real digest)", () => {
		const recorded = JSON.parse(
			readFileSync(new URL("../research/pi-conformance/1.0.0/evidence.json", import.meta.url), "utf8"),
		) as EndoCapabilityEvidenceV0[];
		const live = recorded.filter((r) => r.check.name === "pi.live.study");
		expect(live.length).toBeGreaterThan(0);
		for (const r of live) {
			expect(r.check.version).toBe("2");
			expect(r.check.definitionDigest).toBe(piCheckDefinitionDigestV0(V2));
		}
		expect(piCheckDefinitionDigestV0(PI_LIVE_STUDY_CHECK)).not.toBe(piCheckDefinitionDigestV0(V2));
		expect(PI_LIVE_STUDY_CHECK.version).toBe("3");
	});

	it("keeps old live-study evidence readable as history, but not applicable to the revised definition", () => {
		const recorded = JSON.parse(
			readFileSync(new URL("../research/pi-conformance/1.0.0/evidence.json", import.meta.url), "utf8"),
		) as unknown[];
		for (const r of recorded) expect(validateEndoCapabilityEvidenceV0(r)).not.toBeNull();
		const old = record(V2, "run.identity", "MISMATCH");
		expect(validateEndoCapabilityEvidenceV0(old)).not.toBeNull();
		const validity = piEvidenceValidityV0(old, current);
		expect(validity).toMatchObject({ valid: false });
		expect(validity.valid === false && validity.reason).toBe(
			"the check pi.live.study definition changed (recorded under version 2; this build runs version 3)",
		);
	});

	it("invalidates the whole check, not only run.identity, and nothing else", () => {
		const oldLive = [
			"lifecycle.trace",
			"usage.entries",
			"tool.activity",
			"steering.steer",
			"steering.follow-up",
			"steering.stop",
			"run.identity",
			"operation.outcome",
		].map((capability) => record(V2, capability, capability === "usage.entries" ? "EXACT" : "UNAVAILABLE"));
		const local = PI_CHECK_DEFINITIONS_V0.get("pi.local.state")!;
		const oldLocal = record(local as typeof V2, "session.identity", "QUALIFIED");
		const state = derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			...current,
			evidence: [...oldLive, oldLocal],
		});
		for (const e of oldLive) {
			const standing = entry(state, e.capability);
			expect([e.capability, standing.status]).toEqual([e.capability, "unverified"]);
			expect(standing.reason).toMatch(
				/earlier evidence invalid: the check pi\.live\.study definition changed \(recorded under version 2/,
			);
		}
		// Local protocol evidence from an unchanged check is still current.
		expect(entry(state, "session.identity")).toMatchObject({ status: "admitted", classification: "QUALIFIED" });
	});

	it("manufactures nothing: an old MISMATCH does not become UNAVAILABLE (or anything else) without a new observation", () => {
		const state = derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			...current,
			evidence: [record(V2, "run.identity", "MISMATCH")],
		});
		expect(entry(state, "run.identity")).toMatchObject({ status: "unverified", classification: null });
		expect(state.capabilities.filter((c) => c.status !== "unverified")).toEqual([]);
	});

	it("has the assessment say why requalification is needed", async () => {
		const { attach } = setup("settled-aborted", "1.4.0");
		const pi = attach();
		const { fingerprint: print } = await pi.identify();
		const older = piEvidenceV0({
			attachment: pi.attachment,
			capability: "run.identity",
			definition: V2,
			dependencies: piDependenciesV0(print!, piConfigurationDigestV0("live-study", {})),
			inputs: {},
			expected: "e",
			observed:
				"lifecycle events carried undocumented keys (agent_settled.aborted); the adapter does not map them and needs review",
			classification: "MISMATCH",
			evidence: [],
			limitations: [],
			at: AT,
		});
		pi.registry.append("evidence", older);
		// The standing as it was recorded when version 2 was current.
		const asRecorded = derivePiCapabilityStateV0({
			attachment: pi.attachment,
			at: AT,
			fingerprint: print!,
			evidence: [older],
			definitions: new Map([[V2.name, V2]]),
			configurationDigest: (kind) => piConfigurationDigestV0(kind, {}),
		});
		pi.registry.append("state", asRecorded);
		const assessment = piAssessmentV0(pi.registry);
		const run = assessment.capabilities.find((c) => c.capability === "run.identity")!;
		expect(run.recorded).toBe("mismatch");
		expect(run.effective).toBe("unverified");
		expect(run.reason).toContain(
			"the check pi.live.study was redefined (version 2 recorded; this build runs version 3; every capability the check covers needs a fresh run)",
		);
		// run.identity is a capability a documented-surface review or a live study can establish.
		expect(run.reestablish).toBe("release-review-or-live-study");
	});

	it("lets a fresh authorized study record evidence under the revised definition", async () => {
		const { attach } = setup("settled-aborted", "1.4.0");
		const pi = attach();
		await pi.checkLocal();
		const { state } = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		const fresh = pi.registry.list("evidence").filter((r) => r.check.name === "pi.live.study");
		expect(fresh.length).toBe(9);
		for (const r of fresh) {
			expect(r.check.version).toBe("3");
			expect(r.check.definitionDigest).toBe(piCheckDefinitionDigestV0(PI_LIVE_STUDY_CHECK));
		}
		expect(entry(state, "run.identity")).toMatchObject({ status: "unavailable" });
		// Not promoted: a fake-provider run establishes what it exercised and does not verify the release.
		expect(entry(state, "control.model").status).not.toBe("verified");
	});
});
