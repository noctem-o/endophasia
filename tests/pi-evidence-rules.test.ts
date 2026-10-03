/**
 * The pure rules behind the Pi attachment: the harness protocol validators, the deterministic runtime comparison,
 * the evidence validity rules (one dependency at a time), state derivation and precedence, notification wording,
 * version policy, and the RPC-to-endo.* mapping's identity and payload rules. No processes.
 */
import { describe, expect, it } from "vitest";
import { PI_CAPABILITY_IDS_V0 } from "../adapters/pi/capabilities.ts";
import { PI_CHECK_DEFINITIONS_V0, PI_LIVE_STUDY_CHECK, PI_LOCAL_CONTROLS_CHECK } from "../adapters/pi/checks.ts";
import {
	derivePiCapabilityStateV0,
	piChangeV0,
	piConfigurationDigestV0,
	piDependenciesV0,
	piEvidenceV0,
	piEvidenceValidityV0,
	piNotificationV0,
} from "../adapters/pi/evidence.ts";
import {
	mapPiEntryV0,
	mapPiLiveEventV0,
	type PiMappingContextV0,
	piEndoSessionIdV0,
	piEntryEventIdV0,
} from "../adapters/pi/mapping.ts";
import {
	compareSemverV0,
	PI_ADAPTER_VERSION,
	parsePiVersionOutputV0,
	parseSemverV0,
	piVersionPolicyV0,
} from "../adapters/pi/version.ts";
import type { EndoConformanceClassificationV0 } from "../protocol/evaluation.ts";
import {
	type EndoHarnessFingerprintV0,
	endoHarnessIdentityBasisV0,
	endoHarnessIdentityConfidenceV0,
	validateEndoCapabilityStateV0,
	validateEndoHarnessChangeV0,
	validateEndoHarnessFingerprintV0,
	validateEndoSourceEntryRefV0,
} from "../protocol/harness.ts";
import { isIso8601UtcV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

function fingerprint(
	overrides: { version?: string | null; sha?: string | null; realPath?: string; at?: string } = {},
): EndoHarnessFingerprintV0 {
	const version = overrides.version === undefined ? "1.0.0" : overrides.version;
	const sha = overrides.sha === undefined ? "a".repeat(64) : overrides.sha;
	const local = {
		requested: "pi",
		resolvedPath: "/usr/local/bin/pi",
		realPath: overrides.realPath ?? "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
		entrypoint: sha === null ? null : { sha256: sha, bytes: 100 },
		package: { name: "@earendil-works/pi-coding-agent", version: version ?? "1.0.0", root: "/usr/local/lib/x" },
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
		observedAt: overrides.at ?? "2026-10-03T10:00:00.000Z",
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

const AT = "2026-10-03T10:00:01.000Z";

function evidenceFor(
	print: EndoHarnessFingerprintV0,
	capability = "control.model",
	classification: EndoConformanceClassificationV0 = "EXACT",
) {
	return piEvidenceV0({
		attachment: "pi.default",
		capability,
		definition: PI_LOCAL_CONTROLS_CHECK,
		dependencies: piDependenciesV0(print, piConfigurationDigestV0("local-protocol", {})),
		inputs: { commands: ["set_model"] },
		expected: "x",
		observed: "y",
		classification,
		evidence: ["b".repeat(64)],
		limitations: [],
		at: AT,
	});
}

const current = (print: EndoHarnessFingerprintV0 | null) => ({
	fingerprint: print,
	definitions: PI_CHECK_DEFINITIONS_V0,
	configurationDigest: (kind: "static-surface" | "local-protocol" | "live-study") => piConfigurationDigestV0(kind, {}),
});

describe("harness protocol validators", () => {
	it("accepts a consistent fingerprint and rejects gap lists that disagree with the facts", () => {
		const print = fingerprint();
		expect(validateEndoHarnessFingerprintV0(print)).not.toBeNull();
		expect(validateEndoHarnessFingerprintV0({ ...print, gaps: [{ fact: "version", reason: "x" }] })).toBeNull();
		const missing = fingerprint({ version: null });
		expect(validateEndoHarnessFingerprintV0({ ...missing, gaps: [] })).toBeNull();
		expect(
			validateEndoHarnessFingerprintV0({ ...print, identity: { ...print.identity, confidence: "reduced" } }),
		).toBeNull();
		expect(validateEndoHarnessFingerprintV0({ ...print, observedAt: "2026-02-30T00:00:00Z" })).toBeNull();
		expect(validateEndoHarnessFingerprintV0({ ...print, extra: 1 })).toBeNull();
	});

	it("validates ISO-8601 UTC strictly", () => {
		expect(isIso8601UtcV0("2026-10-03T10:00:00Z")).toBe(true);
		expect(isIso8601UtcV0("2026-10-03T10:00:00.123456Z")).toBe(true);
		for (const bad of [
			"2026-10-03",
			"2026-10-03T10:00:00+02:00",
			"2026-13-01T00:00:00Z",
			"2026-10-03T24:00:00Z",
			"yesterday",
		])
			expect(isIso8601UtcV0(bad)).toBe(false);
	});

	it("enforces each change kind's doors", () => {
		const a = fingerprint();
		const b = fingerprint({ version: "1.0.1" });
		const changed = piChangeV0({ attachment: "pi.default", previous: a, current: b, at: AT });
		expect(validateEndoHarnessChangeV0({ ...changed, differences: [] })).toBeNull();
		const unchanged = piChangeV0({ attachment: "pi.default", previous: a, current: a, at: AT });
		expect(validateEndoHarnessChangeV0({ ...unchanged, kind: "changed" })).toBeNull();
		const failed = piChangeV0({ attachment: "pi.default", previous: a, current: null, failure: "gone", at: AT });
		expect(validateEndoHarnessChangeV0({ ...failed, failure: undefined })).toBeNull();
	});

	it("keeps source entry references opaque but bounded", () => {
		expect(
			validateEndoSourceEntryRefV0({
				schemaVersion: "endo.source-entry-ref.v0",
				runtime: "pi",
				sessionId: "s",
				entryId: "9d29d14f",
			}),
		).not.toBeNull();
		expect(
			validateEndoSourceEntryRefV0({
				schemaVersion: "endo.source-entry-ref.v0",
				runtime: "pi",
				sessionId: "s",
				entryId: "",
			}),
		).toBeNull();
		expect(
			validateEndoSourceEntryRefV0({
				schemaVersion: "endo.source-entry-ref.v0",
				runtime: "pi",
				sessionId: "s",
				entryId: 7,
			}),
		).toBeNull();
	});

	it("rejects a state that admits anything for an unidentified runtime", () => {
		const print = fingerprint();
		const state = derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			evidence: [evidenceFor(print)],
			...current(print),
		});
		expect(validateEndoCapabilityStateV0({ ...state, fingerprintId: null })).toBeNull();
	});
});

describe("runtime comparison is deterministic", () => {
	it("first, unchanged, changed and failed comparisons, with content-addressed ids", () => {
		const a = fingerprint();
		const first = piChangeV0({ attachment: "pi.default", previous: null, current: a, at: AT });
		expect(first.kind).toBe("first-observation");
		const same = piChangeV0({
			attachment: "pi.default",
			previous: a,
			current: fingerprint({ at: "2026-10-03T11:00:00Z" }),
			at: AT,
		});
		expect(same.kind).toBe("unchanged");
		const again = piChangeV0({
			attachment: "pi.default",
			previous: a,
			current: fingerprint({ at: "2026-10-03T11:00:00Z" }),
			at: AT,
		});
		expect(again.id).toBe(same.id);
		const down = piChangeV0({
			attachment: "pi.default",
			previous: a,
			current: fingerprint({ version: "0.99.2" }),
			at: AT,
		});
		expect(down).toMatchObject({ kind: "changed", versionOrder: "lower", differences: ["package", "version"] });
		const pre = piChangeV0({
			attachment: "pi.default",
			previous: a,
			current: fingerprint({ version: "1.1.0-beta.1" }),
			at: AT,
		});
		expect(pre.versionOrder).toBe("higher");
		const odd = piChangeV0({
			attachment: "pi.default",
			previous: a,
			current: fingerprint({ version: null }),
			at: AT,
		});
		expect(odd).toMatchObject({ kind: "changed", versionOrder: "unknown" });
		expect(odd.differences).toEqual(["version", "confidence"]);
	});

	it("never words a change as an available update", () => {
		const a = fingerprint();
		for (const next of [
			fingerprint({ version: "1.0.1" }),
			fingerprint({ version: "0.9.0" }),
			fingerprint({ sha: "c".repeat(64) }),
		]) {
			const notice = piNotificationV0(piChangeV0({ attachment: "pi.default", previous: a, current: next, at: AT }));
			const text = `${notice?.title}\n${notice?.lines.join("\n")}`;
			expect(text).toMatch(/Pi runtime changed/);
			expect(text).toMatch(/will not install, update, downgrade or replace Pi/);
			expect(text).not.toMatch(/update (is )?available|new version available|please (update|upgrade)/i);
		}
		expect(piNotificationV0(piChangeV0({ attachment: "pi.default", previous: a, current: a, at: AT }))).toBeNull();
	});
});

describe("evidence validity, one dependency at a time", () => {
	const print = fingerprint();
	const record = evidenceFor(print);

	it("applies to the same strong identity in a later observation", () => {
		expect(piEvidenceValidityV0(record, current(fingerprint({ at: "2026-10-04T00:00:00Z" })))).toEqual({
			valid: true,
		});
	});

	it("does not apply to a different runtime, a missing runtime, or across reduced identities", () => {
		expect(piEvidenceValidityV0(record, current(fingerprint({ version: "1.0.1" })))).toMatchObject({ valid: false });
		expect(piEvidenceValidityV0(record, current(null))).toMatchObject({
			valid: false,
			reason: "the current runtime is unidentified",
		});
		const reduced = fingerprint({ sha: null });
		const reducedRecord = evidenceFor(reduced);
		expect(piEvidenceValidityV0(reducedRecord, current(reduced))).toEqual({ valid: true });
		expect(
			piEvidenceValidityV0(reducedRecord, current(fingerprint({ sha: null, at: "2026-10-04T00:00:00Z" }))),
		).toMatchObject({
			valid: false,
			reason: "a reduced-confidence identity cannot carry evidence across observations",
		});
	});

	it.each([
		["adapterVersion", "adapter version changed"],
		["mappingVersion", "mapping version changed"],
		["suiteVersion", "conformance suite changed"],
	] as const)("is invalidated by a changed %s even with the same runtime version", (key, reason) => {
		const stale = { ...record, dependencies: { ...record.dependencies, [key]: "old" } };
		expect(piEvidenceValidityV0(stale, current(print))).toEqual({ valid: false, reason });
	});

	it("is invalidated by a changed check definition, configuration or extension dependency", () => {
		const changedDefinition = new Map(PI_CHECK_DEFINITIONS_V0);
		changedDefinition.set(PI_LOCAL_CONTROLS_CHECK.name, { ...PI_LOCAL_CONTROLS_CHECK, version: "2" });
		expect(piEvidenceValidityV0(record, { ...current(print), definitions: changedDefinition })).toMatchObject({
			valid: false,
			reason: "the check pi.local.controls definition changed",
		});
		expect(
			piEvidenceValidityV0(record, { ...current(print), configurationDigest: () => "f".repeat(64) }),
		).toMatchObject({ valid: false, reason: "the relevant configuration changed" });
		const withExtension = {
			...record,
			dependencies: { ...record.dependencies, extension: { id: "x", version: "1" } },
		};
		expect(piEvidenceValidityV0(withExtension, current(print))).toMatchObject({ valid: false });
	});

	it("a changed check invalidates only that check's evidence", () => {
		const stateRecord = piEvidenceV0({
			attachment: "pi.default",
			capability: "session.identity",
			definition: PI_CHECK_DEFINITIONS_V0.get("pi.local.state")!,
			dependencies: piDependenciesV0(print, piConfigurationDigestV0("local-protocol", {})),
			inputs: {},
			expected: "x",
			observed: "y",
			classification: "QUALIFIED",
			evidence: [],
			limitations: [],
			at: AT,
		});
		const changedDefinition = new Map(PI_CHECK_DEFINITIONS_V0);
		changedDefinition.set(PI_LOCAL_CONTROLS_CHECK.name, { ...PI_LOCAL_CONTROLS_CHECK, procedure: "reworded" });
		const state = derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			evidence: [record, stateRecord],
			...current(print),
			definitions: changedDefinition,
		});
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe("unverified");
		expect(state.capabilities.find((entry) => entry.capability === "session.identity")?.status).toBe("admitted");
	});
});

describe("state derivation", () => {
	const print = fingerprint();

	it("covers every catalogued capability and admits nothing without evidence", () => {
		const state = derivePiCapabilityStateV0({ attachment: "pi.default", at: AT, evidence: [], ...current(print) });
		expect(state.capabilities.map((entry) => entry.capability)).toEqual(PI_CAPABILITY_IDS_V0);
		expect(state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		const live = state.capabilities.find((entry) => entry.capability === "steering.stop");
		expect(live?.reason).toMatch(/explicit operator request/);
	});

	it("maps the five canonical classifications to statuses, and prefers a live study over a later local check", () => {
		for (const [classification, status] of [
			["EXACT", "admitted"],
			["QUALIFIED", "admitted"],
			["PARTIAL", "admitted-partial"],
			["UNAVAILABLE", "unavailable"],
			["MISMATCH", "mismatch"],
		] as const) {
			const state = derivePiCapabilityStateV0({
				attachment: "pi.default",
				at: AT,
				evidence: [evidenceFor(print, "control.model", classification)],
				...current(print),
			});
			expect(state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe(status);
		}
		const live = piEvidenceV0({
			attachment: "pi.default",
			capability: "session.identity",
			definition: PI_LIVE_STUDY_CHECK,
			dependencies: piDependenciesV0(print, piConfigurationDigestV0("live-study", {})),
			inputs: {},
			expected: "x",
			observed: "y",
			classification: "EXACT",
			evidence: [],
			limitations: [],
			at: AT,
		});
		const local = piEvidenceV0({
			attachment: "pi.default",
			capability: "session.identity",
			definition: PI_CHECK_DEFINITIONS_V0.get("pi.local.state")!,
			dependencies: piDependenciesV0(print, piConfigurationDigestV0("local-protocol", {})),
			inputs: {},
			expected: "x",
			observed: "y",
			classification: "QUALIFIED",
			evidence: [],
			limitations: [],
			at: "2026-10-03T12:00:00Z",
		});
		const state = derivePiCapabilityStateV0({
			attachment: "pi.default",
			at: AT,
			evidence: [live, local],
			...current(print),
		});
		expect(state.capabilities.find((entry) => entry.capability === "session.identity")?.classification).toBe("EXACT");
	});

	it("the adapter version is part of every evidence record", () => {
		expect(evidenceFor(print).dependencies.adapterVersion).toBe(PI_ADAPTER_VERSION);
	});
});

describe("version policy", () => {
	it("parses Pi's version output and orders semver strictly", () => {
		expect(parsePiVersionOutputV0("1.0.0\n")).toBe("1.0.0");
		expect(parsePiVersionOutputV0("v1.0.0")).toBe("1.0.0");
		expect(parsePiVersionOutputV0("pi build from source")).toBeNull();
		expect(compareSemverV0(parseSemverV0("1.0.0-beta.2")!, parseSemverV0("1.0.0")!)).toBeLessThan(0);
		expect(compareSemverV0(parseSemverV0("1.0.0-beta.11")!, parseSemverV0("1.0.0-beta.2")!)).toBeGreaterThan(0);
	});

	it("only exactly tested releases are 'tested'; the major version alone proves nothing", () => {
		expect(piVersionPolicyV0("1.0.0")).toBe("tested");
		expect(piVersionPolicyV0("1.0.1")).toBe("untested");
		expect(piVersionPolicyV0("0.99.2")).toBe("untested");
		expect(piVersionPolicyV0("1.1.0-rc.1")).toBe("prerelease");
		expect(piVersionPolicyV0(null)).toBe("unknown");
		expect(piVersionPolicyV0("main")).toBe("unknown");
	});
});

describe("mapping", () => {
	let sequence = 0;
	let live = 0;
	const context: PiMappingContextV0 = {
		attachment: "pi.default",
		piSessionId: "01a10115-346a-7597-afcb-578bbfab9643",
		instance: "abc123",
		producer: "pi-rpc-adapter:pi.default",
		nextSequence: () => ++sequence,
		nextLive: () => ++live,
		now: () => AT,
	};

	it("maps an entry to a deterministic id, an opaque source ref and no content", () => {
		const entry = {
			type: "message",
			id: "11029855",
			parentId: "32aa77fb",
			timestamp: "2026-10-03T09:25:29.391Z",
			raw: {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "secret reply" }],
					usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { total: 0 } },
					stopReason: "stop",
				},
			},
		};
		const first = mapPiEntryV0(context, entry);
		const second = mapPiEntryV0(context, entry);
		expect(first.id).toBe(second.id);
		expect(first.id).toBe(piEntryEventIdV0(context.piSessionId!, "11029855"));
		expect(second.sequence).toBe(first.sequence + 1);
		expect(first.coordinates).toEqual({ sessionId: piEndoSessionIdV0(context.piSessionId!) });
		expect(first.payload).toMatchObject({
			source: { schemaVersion: "endo.source-entry-ref.v0", runtime: "pi", entryId: "11029855" },
			entryType: "message",
			details: {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 11, output: 2, totalTokens: 13, costTotal: 0 },
			},
		});
		expect(JSON.stringify(first)).not.toContain("secret reply");
	});

	it("counts deltas, keeps unknown and malformed events visible by name only, and never stores tool data", () => {
		expect(mapPiLiveEventV0(context, "message_update", {}).kind).toBe("delta");
		const unknown = mapPiLiveEventV0(context, "brand_new_event", { secret: "x" });
		expect(unknown.kind === "event" && unknown.event.kind).toBe("runtime.unrecognized-event");
		expect(unknown.kind === "event" && unknown.event.payload).toEqual({ runtimeEvent: "brand_new_event" });
		const malformed = mapPiLiveEventV0(context, "entry_appended", { entry: { type: "custom" } });
		expect(malformed.kind === "event" && malformed.event.kind).toBe("runtime.malformed-event");
		const tool = mapPiLiveEventV0(context, "tool_execution_end", {
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "cat secret" },
			result: { content: [{ type: "text", text: "secret output" }] },
			isError: false,
		});
		expect(tool.kind === "event" && tool.event.payload).toEqual({
			runtimeEvent: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			isError: false,
		});
		const queue = mapPiLiveEventV0(context, "queue_update", { steering: ["private text"], followUp: [] });
		expect(queue.kind === "event" && queue.event.payload).toEqual({
			runtimeEvent: "queue_update",
			steering: 1,
			followUp: 0,
		});
	});

	it("never mints a run id: lifecycle events carry only the session coordinate", () => {
		const start = mapPiLiveEventV0(context, "agent_start", {});
		expect(start.kind === "event" && start.event.coordinates).toEqual({
			sessionId: piEndoSessionIdV0(context.piSessionId!),
		});
	});
});
