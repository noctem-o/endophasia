/**
 * The upstream-change assessment (runtime/contracts/harness-assessment.ts) and its Pi projection: built from records
 * made by the real evidence functions, then judged on the cases that could make an upgrade report misleading. Plus
 * `harness status` (read-only, deterministic, writes nothing) and `harness check` reporting inconclusive results,
 * against the fake Pi. The fake Pi is never evidence about a real release.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_BUILD_V0, piAssessmentV0, renderPiAssessmentV0 } from "../adapters/pi/assessment.ts";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PI_CAPABILITIES_V0 } from "../adapters/pi/capabilities.ts";
import { PI_CHECK_DEFINITIONS_V0, PI_LOCAL_CONTROLS_CHECK, PI_LOCAL_STATE_CHECK } from "../adapters/pi/checks.ts";
import {
	derivePiCapabilityStateV0,
	piChangeV0,
	piConfigurationDigestV0,
	piDependenciesV0,
	piEvidenceV0,
} from "../adapters/pi/evidence.ts";
import { harnessStatusCommand } from "../cli/harness.ts";
import type { EndoConformanceClassificationV0 } from "../protocol/evaluation.ts";
import {
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateV0,
	type EndoHarnessChangeRecordV0,
	type EndoHarnessFingerprintV0,
	endoHarnessIdentityBasisV0,
	endoHarnessIdentityConfidenceV0,
	validateEndoCapabilityEvidenceV0,
	validateEndoCapabilityStateV0,
	validateEndoHarnessFingerprintV0,
} from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	assessEndoHarnessUpgradeV0,
	type EndoHarnessAssessmentV0,
	endoEvidenceDependencyDiffV0,
} from "../runtime/contracts/harness-assessment.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

function fingerprint(
	overrides: { version?: string | null; sha?: string | null; at?: string; realPath?: string } = {},
): EndoHarnessFingerprintV0 {
	const version = overrides.version === undefined ? "1.0.4" : overrides.version;
	const sha = overrides.sha === undefined ? "a".repeat(64) : overrides.sha;
	const local = {
		requested: "pi",
		resolvedPath: "/usr/bin/pi",
		realPath: overrides.realPath ?? "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
		entrypoint: sha === null ? null : { sha256: sha, bytes: 100 },
		package: { name: "@earendil-works/pi-coding-agent", version: version ?? "0.0.0-local", root: "/usr/lib/x" },
	};
	const reported = { versionText: version, version };
	const gaps = [
		...(sha === null ? [{ fact: "entrypoint" as const, reason: "unreadable" }] : []),
		...(version === null ? [{ fact: "version" as const, reason: "--version failed (exit 3)" }] : []),
	];
	const body = {
		schemaVersion: "endo.harness-fingerprint.v0" as const,
		attachment: "pi.default",
		runtime: "pi",
		observedAt: overrides.at ?? "2026-10-20T10:00:00.000Z",
		methods: ["path-search" as const, "realpath" as const, "version-command" as const],
		local,
		reported,
		gaps,
		identity: {
			digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported }))),
			confidence: endoHarnessIdentityConfidenceV0({ local, reported }),
		},
	};
	const record = { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
	const validated = validateEndoHarnessFingerprintV0(record);
	if (validated === null) throw new Error("fixture fingerprint invalid");
	return validated;
}

const CONFIG_A = piConfigurationDigestV0("local-protocol", { piConfiguration: "a".repeat(64) });
const CONFIG_B = piConfigurationDigestV0("local-protocol", { piConfiguration: "b".repeat(64) });

/** The local checks' evidence for one fingerprint, as the attachment records it. */
function localEvidence(
	print: EndoHarnessFingerprintV0,
	at: string,
	configuration = CONFIG_A,
	classification: EndoConformanceClassificationV0 = "EXACT",
): EndoCapabilityEvidenceV0[] {
	return [PI_LOCAL_STATE_CHECK, PI_LOCAL_CONTROLS_CHECK].flatMap((definition) =>
		definition.capabilities.map((capability) =>
			piEvidenceV0({
				attachment: "pi.default",
				capability,
				definition,
				dependencies: piDependenciesV0(print, configuration),
				inputs: { capability },
				expected: "documented behaviour",
				observed: "as documented",
				classification,
				evidence: ["c".repeat(64)],
				limitations: [],
				at,
			}),
		),
	);
}

function stateOf(
	print: EndoHarnessFingerprintV0 | null,
	evidence: readonly EndoCapabilityEvidenceV0[],
	at: string,
	configuration = CONFIG_A,
): EndoCapabilityStateV0 {
	return derivePiCapabilityStateV0({
		attachment: "pi.default",
		at,
		fingerprint: print,
		evidence,
		definitions: PI_CHECK_DEFINITIONS_V0,
		configurationDigest: () => configuration,
	});
}

interface History {
	fingerprints: EndoHarnessFingerprintV0[];
	changes: EndoHarnessChangeRecordV0[];
	evidence: EndoCapabilityEvidenceV0[];
	states: EndoCapabilityStateV0[];
}

/** Identify (fingerprint + change), then optionally check (evidence) and derive (state), as the attachment does. */
function observe(
	history: History,
	print: EndoHarnessFingerprintV0,
	options: { check?: boolean; derive?: boolean; configuration?: string } = {},
): History {
	const configuration = options.configuration ?? CONFIG_A;
	const change = piChangeV0({
		attachment: "pi.default",
		previous: history.fingerprints.at(-1) ?? null,
		current: print,
		at: print.observedAt,
	});
	const next: History = {
		fingerprints: [...history.fingerprints, print],
		changes: [...history.changes, change],
		evidence: history.evidence,
		states: history.states,
	};
	if (options.derive !== false)
		next.states = [...next.states, stateOf(print, next.evidence, print.observedAt, configuration)];
	if (options.check === true) {
		next.evidence = [...next.evidence, ...localEvidence(print, print.observedAt, configuration)];
		next.states = [...next.states, stateOf(print, next.evidence, print.observedAt, configuration)];
	}
	return next;
}

const EMPTY: History = { fingerprints: [], changes: [], evidence: [], states: [] };

function assess(history: History, build = PI_BUILD_V0): EndoHarnessAssessmentV0 {
	return assessEndoHarnessUpgradeV0({ attachment: "pi.default", capabilities: PI_CAPABILITIES_V0, build, ...history });
}

function entry(assessment: EndoHarnessAssessmentV0, capability: string) {
	const found = assessment.capabilities.find((c) => c.capability === capability);
	if (found === undefined) throw new Error(`no ${capability}`);
	return found;
}

const NEVER_STRONGER = (assessment: EndoHarnessAssessmentV0) => {
	for (const c of assessment.capabilities) {
		if (c.recorded === null) expect(c.effective).toBe("not-derived");
		else expect([c.recorded, "unverified"]).toContain(c.effective);
	}
};

const v104 = fingerprint({ version: "1.0.4", sha: "1".repeat(64), at: "2026-10-20T10:00:00.000Z" });
const v140 = fingerprint({ version: "1.4.0", sha: "4".repeat(64), at: "2026-10-22T10:00:00.000Z" });

describe("the upstream-change assessment", () => {
	it("reports no change for the same runtime and configuration observed twice", () => {
		const again = fingerprint({ version: "1.0.4", sha: "1".repeat(64), at: "2026-10-21T10:00:00.000Z" });
		const history = observe(observe(EMPTY, v104, { check: true }), again);
		const a = assess(history);
		expect(a.previous).toBeNull();
		expect(a.change).toBeNull();
		expect(a.comparisons.constrained).toBe(false);
		expect(entry(a, "session.identity")).toMatchObject({ recorded: "admitted", effective: "admitted", changed: [] });
		expect(a.capabilities.every((c) => c.changed.length === 0)).toBe(true);
		expect(renderPiAssessmentV0(a).join("\n")).not.toContain("standing differs");
		NEVER_STRONGER(a);
	});

	it("does not carry evidence across a version change, and says what to run", () => {
		const history = observe(observe(EMPTY, v104, { check: true }), v140);
		const a = assess(history);
		expect(a.previous?.version).toBe("1.0.4");
		expect(a.current?.version).toBe("1.4.0");
		expect(a.change).toMatchObject({ versionOrder: "higher" });
		expect(a.change?.differences).toEqual(expect.arrayContaining(["entrypoint", "version", "package"]));
		const identity = entry(a, "session.identity");
		expect(identity).toMatchObject({ previous: "admitted", recorded: "unverified", effective: "unverified" });
		expect(identity.changed).toContain("identity");
		expect(identity.reestablish).toBe("offline-check");
		expect(entry(a, "steering.stop").reestablish).toBe("live-study-with-consent");
		expect(a.comparisons.constrained).toBe(true);
		expect(a.levels.find((l) => l.level === "protocol-checked")?.reached).toBe(false);
		NEVER_STRONGER(a);
	});

	it("after re-checking the new runtime, names every dependency that differs, not only the first", () => {
		// The upgrade came with a configuration change: a validity rule stops at "different fingerprint".
		const history = observe(observe(EMPTY, v104, { check: true }), v140, { check: true, configuration: CONFIG_B });
		const a = assess(history);
		const identity = entry(a, "session.identity");
		expect(identity).toMatchObject({ previous: "admitted", effective: "admitted", reestablish: null });
		expect(identity.changed).toEqual(["identity", "configuration"]);
	});

	it("detects the same version with different entrypoint bytes", () => {
		const rebuilt = fingerprint({ version: "1.0.4", sha: "2".repeat(64), at: "2026-10-21T10:00:00.000Z" });
		const a = assess(observe(observe(EMPTY, v104, { check: true }), rebuilt));
		expect(a.change).toMatchObject({ differences: ["entrypoint"], versionOrder: "equal" });
		expect(entry(a, "session.identity").effective).toBe("unverified");
	});

	it("treats a downgrade like any other change", () => {
		const a = assess(
			observe(
				observe(EMPTY, v140, { check: true }),
				fingerprint({ version: "1.0.4", sha: "1".repeat(64), at: "2026-10-23T10:00:00.000Z" }),
			),
		);
		expect(a.change?.versionOrder).toBe("lower");
		expect(entry(a, "session.identity")).toMatchObject({ previous: "admitted", effective: "unverified" });
		expect(renderPiAssessmentV0(a).join("\n")).toContain("a lower version is not assumed safer");
	});

	it("invalidates evidence recorded under an older adapter, mapping or suite, and never strengthens a standing", () => {
		const history = observe(EMPTY, v104, { check: true });
		for (const bump of [
			{ adapterVersion: "pi-rpc-adapter.99" },
			{ mappingVersion: "pi-rpc-mapping.99" },
			{ suiteVersion: "pi-rpc-suite.99" },
		]) {
			const a = assess(history, { ...PI_BUILD_V0, ...bump });
			const identity = entry(a, "session.identity");
			expect(identity).toMatchObject({
				recorded: "admitted",
				effective: "unverified",
				reestablish: "offline-check",
			});
			expect(identity.reason).toContain("this build does not accept that evidence");
			expect(identity.reason).toContain(Object.values(bump)[0]);
			NEVER_STRONGER(a);
		}
	});

	it("invalidates only the evidence of a check whose definition changed", () => {
		const history = observe(EMPTY, v104, { check: true });
		const a = assess(history, {
			...PI_BUILD_V0,
			definitionDigest: (name) =>
				name === "pi.local.controls" ? "f".repeat(64) : PI_BUILD_V0.definitionDigest(name),
		});
		expect(entry(a, "control.thinking")).toMatchObject({ effective: "unverified" });
		expect(entry(a, "control.thinking").reason).toContain("pi.local.controls was redefined");
		expect(entry(a, "session.identity")).toMatchObject({ effective: "admitted" });
		const retired = assess(history, { ...PI_BUILD_V0, definitionDigest: () => null });
		expect(entry(retired, "session.identity").reason).toContain("no longer exists");
	});

	it("names a configuration-only change between two evidence records", () => {
		const [a] = localEvidence(v104, "2026-10-20T10:00:00.000Z", CONFIG_A);
		const [b] = localEvidence(v104, "2026-10-21T10:00:00.000Z", CONFIG_B);
		expect(endoEvidenceDependencyDiffV0(a!, b!)).toEqual(["configuration"]);
		expect(endoEvidenceDependencyDiffV0(a!, a!)).toEqual([]);
	});

	it("does not carry a reduced identity's evidence to a later observation", () => {
		const first = fingerprint({ version: "1.0.4", sha: null, at: "2026-10-20T10:00:00.000Z" });
		const second = fingerprint({ version: "1.0.4", sha: null, at: "2026-10-21T10:00:00.000Z" });
		expect(first.identity.digest).toBe(second.identity.digest);
		const a = assess(observe(observe(EMPTY, first, { check: true }), second, { derive: false }));
		expect(a.current?.confidence).toBe("reduced");
		// Nothing derived for the second observation: not reported as the first one's standing.
		expect(entry(a, "session.identity")).toMatchObject({ recorded: null, effective: "not-derived" });
		expect(a.limitations.join(" ")).toContain("reduced-confidence");
	});

	it("asserts nothing about an unknown or prerelease version", () => {
		for (const version of [null, "1.5.0-rc.1"]) {
			const print = fingerprint({ version, sha: "9".repeat(64), at: "2026-10-24T10:00:00.000Z" });
			const a = assess(observe(observe(EMPTY, v104, { check: true }), print));
			expect(a.capabilities.filter((c) => c.effective === "admitted")).toEqual([]);
			expect(a.levels.find((l) => l.level === "behaviour-compared")?.reached).toBe(false);
			expect(renderPiAssessmentV0(a).join("\n")).toContain(
				version === null ? "version unknown (unknown)" : "unverified-prerelease",
			);
		}
	});

	it("reports an interrupted observation (identified, never derived) as not derived, not as unverified", () => {
		const a = assess(observe(observe(EMPTY, v104, { check: true }), v140, { derive: false }));
		expect(entry(a, "session.identity")).toMatchObject({
			previous: "admitted",
			recorded: null,
			effective: "not-derived",
		});
		expect(entry(a, "session.identity").reason).toContain("no capability state has been derived");
	});

	it("honours a failed identification after a successful check, until the runtime is identified again", () => {
		const checked = observe(EMPTY, v104, { check: true });
		const failure = piChangeV0({
			attachment: "pi.default",
			previous: v104,
			current: null,
			failure: "the Pi executable /usr/bin/pi was not found",
			at: "2026-10-21T10:00:00.000Z",
		});
		const failed: History = {
			...checked,
			changes: [...checked.changes, failure],
			states: [...checked.states, stateOf(null, checked.evidence, "2026-10-21T10:00:00.000Z")],
		};
		const a = assess(failed);
		expect(a.current).toBeNull();
		expect(a.unidentified).toEqual({
			at: "2026-10-21T10:00:00.000Z",
			failure: "the Pi executable /usr/bin/pi was not found",
		});
		expect(a.previous?.version).toBe("1.0.4");
		for (const c of a.capabilities) {
			expect(c.effective).toBe("unverified");
			expect(c.reestablish).toBe("identify-runtime");
		}
		expect(entry(a, "session.identity")).toMatchObject({ previous: "admitted", recorded: "unverified" });
		expect(a.levels.find((l) => l.level === "identity-observed")?.reached).toBe(false);
		expect(a.comparisons.constrained).toBe(true);
		const text = renderPiAssessmentV0(a).join("\n");
		expect(text).toContain("UNIDENTIFIED since 2026-10-21T10:00:00.000Z");
		expect(text).toContain("session.identity: admitted -> unverified");
		expect(text).not.toContain("Changes:");
		NEVER_STRONGER({ ...a, capabilities: a.capabilities.filter((c) => c.recorded !== null) });
		// Identified again (same runtime, strong identity): the evidence applies again.
		const back = fingerprint({ version: "1.0.4", sha: "1".repeat(64), at: "2026-10-22T10:00:00.000Z" });
		const recovered = observe(failed, back);
		const b = assess(recovered);
		expect(b.unidentified).toBeNull();
		expect(entry(b, "session.identity")).toMatchObject({ effective: "admitted", reestablish: null });
	});

	it("does not stand on evidence a state names but the registry lacks", () => {
		const history = observe(EMPTY, v104, { check: true });
		const a = assess({ ...history, evidence: [] });
		expect(entry(a, "session.identity")).toMatchObject({ recorded: "admitted", effective: "unverified" });
	});

	it("never reaches behaviour comparison or reproducibility, whatever evidence exists", () => {
		const a = assess(observe(observe(EMPTY, v104, { check: true }), v140, { check: true }));
		expect(a.levels.map((l) => [l.level, l.reached])).toEqual([
			["identity-observed", true],
			["protocol-checked", true],
			["capability-qualified", true],
			["behaviour-compared", false],
			["reproducibility-established", false],
		]);
		expect(a.basis).toBe("recorded");
		expect(renderPiAssessmentV0(a).join("\n")).toContain("the installed Pi was not examined");
	});

	it("reads the immutable Pi 1.0.0 specimen without accepting its mapping.1 evidence", () => {
		const dir = join(import.meta.dirname, "..", "research", "pi-conformance", "1.0.0");
		const read = (name: string) => readFileSync(join(dir, name));
		const before = ["fingerprint.json", "evidence.json", "capability-state.json"].map((name) =>
			createHash("sha256").update(read(name)).digest("hex"),
		);
		const print = validateEndoHarnessFingerprintV0(JSON.parse(read("fingerprint.json").toString()));
		const evidence = (JSON.parse(read("evidence.json").toString()) as unknown[]).map(
			validateEndoCapabilityEvidenceV0,
		);
		const state = validateEndoCapabilityStateV0(JSON.parse(read("capability-state.json").toString()));
		expect(print).not.toBeNull();
		expect(evidence.every((record) => record !== null)).toBe(true);
		const a = assessEndoHarnessUpgradeV0({
			attachment: print!.attachment,
			capabilities: PI_CAPABILITIES_V0,
			build: PI_BUILD_V0,
			fingerprints: [print!],
			changes: [],
			evidence: evidence as EndoCapabilityEvidenceV0[],
			states: [state!],
		});
		const admitted = a.capabilities.filter((c) => c.recorded === "admitted");
		expect(admitted.length).toBeGreaterThan(0);
		for (const c of admitted) expect(c.reason).toContain("mapping pi-rpc-mapping.1");
		NEVER_STRONGER(a);
		expect(
			["fingerprint.json", "evidence.json", "capability-state.json"].map((name) =>
				createHash("sha256").update(read(name)).digest("hex"),
			),
		).toEqual(before);
	});

	it("is deterministic", () => {
		const history = observe(observe(EMPTY, v104, { check: true }), v140, { check: true, configuration: CONFIG_B });
		expect(canonicalEndoJsonV0(JSON.parse(JSON.stringify(assess(history))))).toBe(
			canonicalEndoJsonV0(JSON.parse(JSON.stringify(assess(history)))),
		);
	});
});

describe("harness status and check against the fake Pi", () => {
	const cleanup: (() => void)[] = [];
	afterEach(() => {
		for (const done of cleanup.splice(0)) done();
		vi.restoreAllMocks();
	});

	function setup(version: string) {
		const install = installFakePi(version);
		const root = mkdtempSync(join(tmpdir(), "endo-assess-"));
		cleanup.push(() => {
			install.remove();
			rmSync(root, { recursive: true, force: true });
		});
		return { install, root };
	}

	async function status(argv: string[]): Promise<{ stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		vi.spyOn(console, "log").mockImplementation((text: string) => {
			stdout += `${text}\n`;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => {
			stderr += String(text);
			return true;
		});
		try {
			await harnessStatusCommand(argv);
		} finally {
			vi.restoreAllMocks();
		}
		return { stdout, stderr };
	}

	it("reports inconclusive local results instead of hiding them, and records nothing for them", async () => {
		const { install, root } = setup("1.0.4");
		install.setScenario("no-available-models");
		const pi = new PiAttachmentV0({ root, executable: install.bin, env: fakePiEnv(), requestTimeoutMs: 10_000 });
		await pi.identify();
		const checked = await pi.checkLocal();
		expect(checked.inconclusive).toEqual([expect.stringMatching(/^control\.model: /)]);
		expect(checked.evidence.some((e) => e.capability === "control.model")).toBe(false);
		expect(checked.state.capabilities.find((c) => c.capability === "control.model")?.status).toBe("unverified");
	});

	it("assesses an upgrade from recorded state, twice, byte for byte, without writing", async () => {
		const { install, root } = setup("1.0.4");
		const first = new PiAttachmentV0({ root, executable: install.bin, env: fakePiEnv(), requestTimeoutMs: 10_000 });
		await first.identify();
		await first.checkLocal();
		install.setVersion("1.4.0");
		const second = new PiAttachmentV0({ root, executable: install.bin, env: fakePiEnv(), requestTimeoutMs: 10_000 });
		await second.identify();
		second.state();
		const log = join(root, "harness", "pi.default", "records.log");
		const bytes = readFileSync(log);
		const one = await status([root]);
		const two = await status([root]);
		expect(readFileSync(log).equals(bytes)).toBe(true);
		expect(one).toEqual(two);
		const assessment = (JSON.parse(one.stdout) as { assessment: EndoHarnessAssessmentV0 }).assessment;
		expect(assessment).toMatchObject({
			basis: "recorded",
			previous: { version: "1.0.4" },
			current: { version: "1.4.0" },
		});
		expect(assessment.capabilities.find((c) => c.capability === "session.identity")).toMatchObject({
			previous: "admitted",
			effective: "unverified",
			reestablish: "offline-check",
		});
		expect(one.stderr).toContain("from recorded state; the installed Pi was not examined");
		expect(one.stderr).toContain("session.identity: admitted -> unverified (changed: identity)");
	});

	it("reports an executable that disappeared after a check as unidentified, not with its old standings", async () => {
		const { install, root } = setup("1.0.4");
		const first = new PiAttachmentV0({ root, executable: install.bin, env: fakePiEnv(), requestTimeoutMs: 10_000 });
		await first.identify();
		await first.checkLocal();
		const gone = new PiAttachmentV0({
			root,
			executable: join(root, "no-such-pi"),
			env: fakePiEnv(),
			requestTimeoutMs: 10_000,
		});
		await gone.identify();
		await gone.checkLocal();
		const out = await status([root]);
		const assessment = (JSON.parse(out.stdout) as { assessment: EndoHarnessAssessmentV0 }).assessment;
		expect(assessment.current).toBeNull();
		expect(assessment.unidentified).not.toBeNull();
		expect(assessment.capabilities.filter((c) => c.effective !== "unverified")).toEqual([]);
		expect(out.stderr).toContain("UNIDENTIFIED since");
	});

	it("creates nothing for an attachment with no records", async () => {
		const root = mkdtempSync(join(tmpdir(), "endo-assess-empty-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const out = await status([root, "--attachment", "pi.other"]);
		expect(existsSync(join(root, "harness"))).toBe(false);
		const assessment = (JSON.parse(out.stdout) as { assessment: EndoHarnessAssessmentV0 }).assessment;
		expect(assessment.current).toBeNull();
		expect(assessment.capabilities.every((c) => c.effective === "not-derived")).toBe(true);
	});

	it("keeps the registry's validators: a malformed record makes the registry unopenable rather than assessed", () => {
		const root = mkdtempSync(join(tmpdir(), "endo-assess-bad-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const registry = openEndoHarnessRegistryV0(root, "pi.default");
		const bad = { ...v104, identity: { ...v104.identity, confidence: "reduced" as const } };
		expect(() => registry.append("fingerprint", bad)).toThrow(TypeError);
		expect(piAssessmentV0(registry).current).toBeNull();
	});
});
