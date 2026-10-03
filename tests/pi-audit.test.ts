/**
 * Adversarial tests of the Pi boundary and evidence invalidation (docs/pi-attach-audit.md). Each test states an attack
 * or failure mode and checks that Endophasia does not admit, keep or record anything it cannot stand behind.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0, PiCapabilityNotAdmittedErrorV0, PiStoreLockedErrorV0 } from "../adapters/pi/attachment.ts";
import { PI_CHECK_DEFINITIONS_V0, PI_LIVE_STUDY_CHECK, PI_LOCAL_STATE_CHECK } from "../adapters/pi/checks.ts";
import { piUserConfigurationDigestV0 } from "../adapters/pi/configuration.ts";
import {
	derivePiCapabilityStateV0,
	piCheckDefinitionDigestV0,
	piConfigurationDigestV0,
	piDependenciesV0,
	piEvidenceV0,
} from "../adapters/pi/evidence.ts";
import type { EndoConformanceClassificationV0 } from "../protocol/evaluation.ts";
import type { EndoHarnessFingerprintV0 } from "../protocol/harness.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

function setup(scenario = "", extraEnv: Record<string, string> = {}) {
	const install = installFakePi("1.0.0");
	if (scenario !== "") install.setScenario(scenario);
	const root = mkdtempSync(join(tmpdir(), "endo-pi-audit-"));
	const cwd = mkdtempSync(join(tmpdir(), "endo-pi-audit-cwd-"));
	const agentDir = join(root, "pi-agent");
	mkdirSync(agentDir, { recursive: true });
	cleanup.push(() => {
		install.remove();
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	const env = fakePiEnv({ FAKE_PI_STEP_MS: "15", PI_CODING_AGENT_DIR: agentDir, ...extraEnv });
	const attach = (extra: Record<string, unknown> = {}) =>
		new PiAttachmentV0({ root, cwd, executable: install.bin, env, requestTimeoutMs: 10_000, ...extra });
	return { install, root, cwd, agentDir, env, attach };
}

const statusOf = (state: { capabilities: { capability: string; status: string }[] }, id: string) =>
	state.capabilities.find((entry) => entry.capability === id)?.status;

describe("evidence combination: a scoped live study cannot silently supersede protocol evidence", () => {
	const AT = "2026-10-03T10:00:00.000Z";
	const fingerprint = {
		id: `endo.evidence.pi-fingerprint.${"1".repeat(64)}`,
		identity: { digest: "2".repeat(64), confidence: "strong" },
	} as EndoHarnessFingerprintV0;
	const digest = (kind: "static-surface" | "local-protocol" | "live-study") => piConfigurationDigestV0(kind, {});
	const record = (
		definition: typeof PI_LOCAL_STATE_CHECK,
		capability: string,
		classification: EndoConformanceClassificationV0,
		at = AT,
	) =>
		piEvidenceV0({
			attachment: "pi.default",
			capability,
			definition,
			dependencies: piDependenciesV0(fingerprint, digest(definition.kind)),
			inputs: {},
			expected: "e",
			observed: "o",
			classification,
			evidence: [],
			limitations: [],
			at,
		});
	const derive = (evidence: ReturnType<typeof record>[], definitions = PI_CHECK_DEFINITIONS_V0) =>
		derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			fingerprint,
			evidence,
			definitions,
			configurationDigest: digest,
		});
	const controls = PI_CHECK_DEFINITIONS_V0.get("pi.local.controls")!;
	const surface = PI_CHECK_DEFINITIONS_V0.get("pi.baseline.surface-review")!;

	it("a later live EXACT does not upgrade a local MISMATCH it does not declare it supersedes", () => {
		const fakeLive = { ...PI_LIVE_STUDY_CHECK, capabilities: [...PI_LIVE_STUDY_CHECK.capabilities, "control.model"] };
		const definitions = new Map(PI_CHECK_DEFINITIONS_V0).set(fakeLive.name, fakeLive);
		const state = derive(
			[
				record(controls, "control.model", "MISMATCH"),
				record(fakeLive, "control.model", "EXACT", "2026-10-03T11:00:00.000Z"),
			],
			definitions,
		);
		expect(statusOf(state, "control.model")).toBe("mismatch");
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.reason).toMatch(
			/most conservative of pi\.live\.study=EXACT/,
		);
	});

	it("contradicting results combine to the more conservative one (live MISMATCH beats the surface review)", () => {
		const state = derive([
			record(surface, "run.identity", "UNAVAILABLE"),
			record(PI_LIVE_STUDY_CHECK, "run.identity", "MISMATCH"),
		]);
		expect(statusOf(state, "run.identity")).toBe("mismatch");
	});

	it("an explicitly declared supersession applies only to its capability", () => {
		const state = derive([
			record(PI_LOCAL_STATE_CHECK, "session.identity", "QUALIFIED"),
			record(PI_LIVE_STUDY_CHECK, "session.identity", "EXACT"),
		]);
		expect(state.capabilities.find((entry) => entry.capability === "session.identity")?.classification).toBe("EXACT");
		const overview = derive([
			record(PI_LOCAL_STATE_CHECK, "session.overview", "PARTIAL"),
			record({ ...PI_LIVE_STUDY_CHECK, capabilities: ["session.overview"] }, "session.overview", "EXACT"),
		]);
		expect(overview.capabilities.find((entry) => entry.capability === "session.overview")?.classification).toBe(
			"PARTIAL",
		);
	});

	it("a superseding check whose evidence is invalid supersedes nothing", () => {
		const stale = { ...record(PI_LIVE_STUDY_CHECK, "session.identity", "EXACT") };
		stale.dependencies = { ...stale.dependencies, suiteVersion: "old" };
		const state = derive([record(PI_LOCAL_STATE_CHECK, "session.identity", "QUALIFIED"), stale]);
		expect(state.capabilities.find((entry) => entry.capability === "session.identity")?.classification).toBe(
			"QUALIFIED",
		);
	});

	it("declaring a supersession is part of the check's identity", () => {
		const { supersedes: _, ...without } = PI_LIVE_STUDY_CHECK;
		expect(piCheckDefinitionDigestV0(without)).not.toBe(piCheckDefinitionDigestV0(PI_LIVE_STUDY_CHECK));
	});

	it("a re-run of the same check replaces that check's earlier result instead of being combined with it", () => {
		const state = derive([
			record(controls, "control.model", "MISMATCH", "2026-10-03T09:00:00.000Z"),
			record(controls, "control.model", "EXACT", "2026-10-03T11:00:00.000Z"),
		]);
		expect(statusOf(state, "control.model")).toBe("admitted");
	});
});

describe("Pi boundary: the runtime and its configuration", () => {
	it("discards check results when the runtime changes while the checks run, and records the change", async () => {
		const { attach } = setup("mutate-on:get_available_models");
		const pi = attach();
		const result = await pi.checkLocal();
		expect(result.ran).toBe(true);
		expect(result.recorded).toBe(false);
		expect(pi.registry.list("evidence")).toHaveLength(0);
		expect(pi.registry.last("change")?.kind).toBe("changed");
		expect(pi.registry.last("change")?.current?.version).toBe("9.9.9");
		expect(result.state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
	});

	it("a change to Pi's user configuration invalidates evidence recorded under the old one", async () => {
		const { attach, agentDir } = setup();
		await attach().checkLocal();
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
		const pi = attach();
		await pi.identify();
		const state = pi.state();
		expect(statusOf(state, "control.model")).toBe("unverified");
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.reason).toMatch(
			/configuration changed/,
		);
	});

	it("the configuration digest ignores credentials and secrets but sees extensions and PI_ switches", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-pi-config-"));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const env = { PI_CODING_AGENT_DIR: dir };
		const base = piUserConfigurationDigestV0(env);
		writeFileSync(join(dir, "auth.json"), "{}");
		expect(piUserConfigurationDigestV0({ ...env, PI_API_KEY: "secret", PI_OFFLINE: "1" })).toBe(base);
		mkdirSync(join(dir, "extensions"));
		writeFileSync(join(dir, "extensions", "x.ts"), "export default () => {}");
		const withExtension = piUserConfigurationDigestV0(env);
		expect(withExtension).not.toBe(base);
		expect(piUserConfigurationDigestV0({ ...env, PI_CACHE_RETENTION: "long" })).not.toBe(withExtension);
	});

	it("launches the file it hashed, not the symlink that pointed at it", async () => {
		const { attach, install } = setup();
		const pi = attach();
		const { fingerprint } = await pi.identify();
		expect(pi.launchPath(fingerprint!)).toBe(fingerprint!.local.realPath);
		expect(fingerprint!.local.realPath).not.toBe(install.bin);
	});

	it("a runtime replaced while disconnected is re-identified on reconnect; old admissions are withdrawn", async () => {
		const { attach, install, root } = setup();
		const pi = attach();
		await pi.checkLocal();
		const session = await pi.openSession();
		expect(statusOf(session.capabilityState, "control.thinking")).toBe("admitted");
		process.kill(session.pid!, "SIGKILL");
		await session.exited();
		install.setVersion("1.0.1");
		await session.reconnect();
		expect(session.fingerprint.reported.version).toBe("1.0.1");
		expect(statusOf(session.capabilityState, "control.thinking")).toBe("unverified");
		await expect(session.setThinkingLevel("low")).rejects.toBeInstanceOf(PiCapabilityNotAdmittedErrorV0);
		await session.close();
		const store = createEndoDurableEventStoreV0(root);
		const kinds = store.page({ limit: 10_000 }).events.map((event) => event.kind);
		store.close();
		expect(kinds).toContain("harness.runtime-changed");
		expect(pi.registry.last("notification")?.title).toBe("Pi runtime changed");
	});

	it("refuses a second concurrent writer on the same store root, and replaces a dead writer's lock", async () => {
		const { attach, root } = setup();
		const first = await attach().openSession();
		await expect(attach().openSession()).rejects.toBeInstanceOf(PiStoreLockedErrorV0);
		await first.close();
		writeFileSync(
			join(root, "events", "session-attachment.lock"),
			JSON.stringify({ pid: 2_147_483_000, attachment: "pi.default", at: "2026-10-03T00:00:00.000Z" }),
		);
		const second = await attach().openSession();
		await second.close();
	});

	it("an extension dialog that blocks Pi does not hang the local checks or the session", async () => {
		const { attach } = setup("dialog-on-start");
		const pi = attach({ requestTimeoutMs: 5_000 });
		const { recorded, state } = await pi.checkLocal();
		expect(recorded).toBe(true);
		expect(statusOf(state, "session.entries-cursor")).toBe("admitted");
		const session = await pi.openSession();
		await session.close();
	});

	it("an undocumented run id on lifecycle events is a mismatch needing review, not silently used", async () => {
		const { attach } = setup("run-ids");
		const pi = attach();
		await pi.checkLocal();
		const { state } = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		expect(statusOf(state, "run.identity")).toBe("mismatch");
	});

	it("operation.outcome and run.identity are established on a non-baseline release by observation alone", async () => {
		const { attach, install } = setup();
		install.setVersion("1.2.0");
		const pi = attach();
		await pi.checkLocal();
		expect(statusOf(pi.state(), "operation.outcome")).toBe("unverified");
		const { state } = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		expect(statusOf(state, "operation.outcome")).toBe("unavailable");
		expect(statusOf(state, "run.identity")).toBe("unavailable");
		// The release is not the baseline, and capabilities are admitted on evidence regardless.
		expect(statusOf(state, "control.model")).toBe("admitted");
	});
});
