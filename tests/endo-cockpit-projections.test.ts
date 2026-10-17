// The cockpit projections are pure: validated records in, versioned presentation data out. These tests build the inputs
// by hand (a real specimen where one exists, synthetic records where the case needs a disagreement) and check what the
// projections guarantee: determinism, storage order, explicit gaps, provenance, the presentation boundary, and the
// contract validators. The store-to-projection path is in endo-cockpit-reader.test.ts.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { projectEndoCockpitCapabilityStateV0 } from "../cockpit/projections/capability-state.ts";
import type { EndoCockpitRegistryInputV0, EndoCockpitRegistryRecordsV0 } from "../cockpit/projections/common.ts";
import { publicIdV0 } from "../cockpit/projections/common.ts";
import { projectEndoCockpitRuntimeIdentityV0 } from "../cockpit/projections/runtime-identity.ts";
import { projectEndoCockpitSessionTimelineV0 } from "../cockpit/projections/session-timeline.ts";
import {
	ENDO_COCKPIT_VERSIONS_V0,
	type EndoCockpitCapabilityStateV0,
	type EndoCockpitEventLogSourceV0,
	type EndoCockpitRegistrySourceV0,
	type EndoCockpitSessionTimelineV0,
	readEndoCockpitRecordV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_FIELD_SPECS_V0,
	isEndoCockpitPublicIdV0,
	isEndoCockpitSourceIdAdmittedV0,
} from "../protocol/cockpit-fields.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { deepFreezeCopyV0 } from "../runtime/contracts/immutability.ts";
import {
	ATTACHMENT,
	CANARY,
	changeRecord,
	event,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
} from "./cockpit-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const CLEAN = { state: "readable", tornTail: null, sealedAt: null, error: null } as const;

function logSource(length: number, lastEventId: string | null): EndoCockpitEventLogSourceV0 {
	return {
		domain: "event-log",
		condition: { ...CLEAN, state: length === 0 ? "empty" : "readable" },
		watermark: {
			length,
			lastEventId,
			prefixDigest: length === 0 ? null : sha256HexV0(`prefix-${length}`),
		},
	};
}

/** A watermark names its last record by the public form of the identifier, as the reader does. */
const publicOrNull = (id: string | undefined): string | null => (id === undefined ? null : publicIdV0(id));

function registrySource(records: EndoCockpitRegistryRecordsV0 | null): EndoCockpitRegistrySourceV0 {
	const counts = {
		fingerprint: records?.fingerprint.length ?? 0,
		change: records?.change.length ?? 0,
		evidence: records?.evidence.length ?? 0,
		state: records?.state.length ?? 0,
		notification: records?.notification.length ?? 0,
	};
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return {
		domain: "harness-registry",
		attachment: ATTACHMENT,
		condition:
			records === null ? { ...CLEAN, state: "absent" } : { ...CLEAN, state: total === 0 ? "empty" : "readable" },
		watermark: {
			counts,
			lastIds: {
				fingerprint: publicOrNull(records?.fingerprint.at(-1)?.id),
				change: publicOrNull(records?.change.at(-1)?.id),
				evidence: publicOrNull(records?.evidence.at(-1)?.id),
				state: null,
				notification: publicOrNull(records?.notification.at(-1)?.id),
			},
			contentDigest: sha256HexV0(canonicalEndoJsonV0(records ?? {})),
		},
	};
}

function input(records: EndoCockpitRegistryRecordsV0 | null): EndoCockpitRegistryInputV0 {
	return { source: registrySource(records), records };
}

function timeline(events: ReturnType<typeof event>[], afterSequence = 0): EndoCockpitSessionTimelineV0 {
	return projectEndoCockpitSessionTimelineV0({
		source: logSource(events.length + afterSequence, events.at(-1)?.id ?? null),
		afterSequence,
		events: stored(events, afterSequence + 1),
	});
}

describe("determinism and purity", () => {
	it("two independent executions over identical frozen inputs are byte-identical, and the inputs are untouched", () => {
		const records = deepFreezeCopyV0({
			...specimenRecords(),
			change: [changeRecord()],
			notification: [notificationRecord()],
		});
		const events = deepFreezeCopyV0([
			event("lifecycle.session-started", {
				runtime: "pi",
				runtimeSessionId: "s-1",
				instance: "i-1",
				unavailable: [{ field: "run.id", reason: "not reported" }],
			}),
			event("tool.started", {
				toolName: "read",
				toolCallId: "c1",
				argsDigest: { algorithm: "hmac-sha256", keyId: "k", value: "a".repeat(64) },
			}),
		]);
		const run = () =>
			canonicalEndoJsonV0([
				projectEndoCockpitRuntimeIdentityV0(input(records)),
				projectEndoCockpitCapabilityStateV0(input(records)),
				timeline([...events]),
			]);
		const before = canonicalEndoJsonV0({ records, events });
		expect(run()).toBe(run());
		// A frozen input would throw on any write; and its canonical form is unchanged.
		expect(canonicalEndoJsonV0({ records, events })).toBe(before);
	});

	it("the projection definition versions are part of every output", () => {
		const identity = projectEndoCockpitRuntimeIdentityV0(input(specimenRecords()));
		const capabilities = projectEndoCockpitCapabilityStateV0(input(specimenRecords()));
		expect(identity.projectionVersion).toBe("cockpit-runtime-identity.1");
		expect(capabilities.projectionVersion).toBe("cockpit-capability-state.1");
		expect(timeline([event("tool.started")]).projectionVersion).toBe("cockpit-session-timeline.1");
	});
});

describe("session timeline", () => {
	it("follows storage order, not producer sequence or recorded time", () => {
		const a = event("agent.run-started", {}, { sequence: 90, at: "2026-10-03T12:00:09Z" });
		const b = event("agent.turn-started", {}, { sequence: 3, at: "2026-10-03T11:00:00Z" });
		const c = event(
			"lifecycle.run-started",
			{},
			{ sequence: 3, at: "2026-10-03T13:00:00Z", producer: "other-producer" },
		);
		const result = timeline([a, b, c]);
		expect(result.entries.map((entry) => [entry.storageSequence, entry.eventId])).toEqual([
			[1, a.id],
			[2, b.id],
			[3, c.id],
		]);
		expect(result.entries.map((entry) => entry.producerSequence)).toEqual([90, 3, 3]);
		expect(result.entries.map((entry) => entry.recordedAt)).toEqual([a.at, b.at, c.at]);
	});

	it("refuses an input that is not in strictly ascending storage order above the window", () => {
		const [a, b] = [event("tool.started"), event("tool.finished")];
		const project = (events: { storageSequence: number; event: typeof a }[], afterSequence = 0) =>
			projectEndoCockpitSessionTimelineV0({ source: logSource(2, b.id), afterSequence, events });
		expect(() =>
			project([
				{ storageSequence: 2, event: a },
				{ storageSequence: 1, event: b },
			]),
		).toThrow(TypeError);
		expect(() =>
			project([
				{ storageSequence: 1, event: a },
				{ storageSequence: 1, event: b },
			]),
		).toThrow(TypeError);
		expect(() => project([{ storageSequence: 1, event: a }], 1)).toThrow(TypeError);
		expect(() => project([], -1)).toThrow(TypeError);
	});

	it("never synthesizes run ids, turn ids or outcomes, and keeps declared gaps explicit", () => {
		const started = event("lifecycle.session-started", {
			runtime: "pi",
			runtimeSessionId: "pi-s",
			instance: "i1",
			unavailable: [{ field: "run.id", reason: "Pi 1.0.0 lifecycle events carry no run identifier" }],
		});
		const result = timeline([started, event("agent.run-started", { runtimeEvent: "agent_start" })]);
		for (const entry of result.entries) {
			expect(entry.runId).toBeNull();
			expect(entry.experimentId).toBeNull();
		}
		expect(result.entries[0]!.fields["unavailable.run.id"]).toEqual({
			basis: "unavailable",
			reason: "Pi 1.0.0 lifecycle events carry no run identifier",
		});
		expect(JSON.stringify(result)).not.toMatch(/outcome|completed|succeeded/);
	});

	it("derives the observer's counts as derived and the runtime's stop reason as reported", () => {
		const done = event("lifecycle.run-completed", { turns: 2, stopReason: { status: "reported", value: "stop" } });
		const none = event("lifecycle.turn-completed", {
			turn: 1,
			stopReason: { status: "UNAVAILABLE", reason: "the runtime reported none" },
		});
		const [first, second] = timeline([done, none]).entries;
		expect(first!.fields.turns).toEqual({ basis: "derived", value: 2 });
		expect(first!.fields.stopReason).toEqual({ basis: "reported", value: "stop" });
		expect(second!.fields.stopReason).toEqual({ basis: "unavailable", reason: "the runtime reported none" });
		expect(first!.source).toBe("runtime-fact");
	});

	it("carries the event's own source class verbatim", () => {
		const entry = timeline([
			event("lifecycle.run-completed", { turns: 1 }, { source: "interpretation" }),
			event("x.y", {}, { source: "authority-decision" }),
		]).entries;
		expect(entry.map((item) => item.source)).toEqual(["interpretation", "authority-decision"]);
	});

	it("records usage only where recorded, and says so where a kind could carry it and does not", () => {
		const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, costTotal: 0.5 };
		const entries = timeline([
			event("session.entry-observed", {
				entryType: "message",
				recognized: true,
				parentId: null,
				details: { role: "assistant", usage },
			}),
			event("session.entry-observed", {
				entryType: "message",
				recognized: true,
				parentId: null,
				details: { role: "assistant" },
			}),
			event("session.entry-observed", {
				entryType: "message",
				recognized: true,
				parentId: null,
				details: { role: "assistant", usage: { input: "many" } },
			}),
			event("session.entry-observed", {
				entryType: "message",
				recognized: true,
				parentId: null,
				details: { role: "user" },
			}),
			event("session.entry-observed", { entryType: "model_change", recognized: true, parentId: null, details: {} }),
			event("tool.finished", { toolName: "read" }),
		]).entries;
		expect(entries[0]!.usage).toEqual({
			basis: "reported",
			value: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, costTotal: 0.5, reasoning: null },
		});
		expect(entries[1]!.usage).toEqual({ basis: "unavailable", reason: "the event records no usage" });
		expect(entries[2]!.usage).toEqual({
			basis: "unavailable",
			reason: "the recorded usage is not in the expected shape",
		});
		expect(entries[3]!.usage).toBeNull();
		expect(entries[4]!.usage).toBeNull();
		expect(entries[5]!.usage).toBeNull();
	});

	it("flags interruptions, discontinuities, anomalies and unrecognized records, never dropping them", () => {
		const result = timeline([
			event("lifecycle.interrupted", {
				cause: "observer-lost",
				instance: "i1",
				runOpen: true,
				turnOpen: true,
				turns: 1,
				stopRequested: false,
			}),
			event("lifecycle.session-resumed", {
				runtime: "pi",
				runtimeSessionId: "s",
				instance: "i2",
				previousInstance: "i1",
				previousEnd: "interrupted",
			}),
			event("lifecycle.anomaly", { observed: "agent_end", problem: "no run open" }),
			event("lifecycle.something-new", { whatever: 1 }),
			event("vendor.unknown-kind", { whatever: 1 }),
			event("runtime.unrecognized-event", { runtimeEvent: "mystery" }),
			event("harness.store-opened", {
				lifecycleRepaired: 0,
				recovery: { truncated: true, recovered: false, discarded: null, sealed: false },
			}),
		]).entries;
		expect(result.map((entry) => entry.flags)).toEqual([
			["interruption"],
			["discontinuity"],
			["anomaly"],
			["unrecognized"],
			["unrecognized"],
			["unrecognized"],
			["discontinuity"],
		]);
		expect(result[4]!.category).toBe("other");
		expect(result[4]!.fields).toEqual({});
	});

	it("counts duplicate event ids once and reports the repeat, and groups sessions by first appearance", () => {
		const a = event("agent.run-started", {}, { id: "endo.event.dup.1" });
		const again = event("agent.run-started", {}, { id: "endo.event.dup.1" });
		const b = event("agent.turn-started", {}, { session: "endo.session.test.two" });
		const c = event("agent.turn-finished", {}, { session: null });
		const result = timeline([a, again, b, c]);
		expect(result.duplicatesIgnored).toBe(1);
		expect(result.entries.map((entry) => entry.storageSequence)).toEqual([1, 3, 4]);
		expect(result.sessions).toEqual([
			{ sessionId: "endo.session.test.one", firstStorageSequence: 1, lastStorageSequence: 1, entries: 1 },
			{ sessionId: "endo.session.test.two", firstStorageSequence: 3, lastStorageSequence: 3, entries: 1 },
		]);
		expect(result.entries[2]!.sessionId).toBeNull();
	});

	it("reports the window and whether more follows, from the source's own watermark", () => {
		const events = [event("tool.started"), event("tool.finished")];
		const middle = projectEndoCockpitSessionTimelineV0({
			source: logSource(5, "endo.event.test.last"),
			afterSequence: 2,
			events: stored(events, 3),
		});
		expect(middle.window).toEqual({ afterSequence: 2, nextAfterSequence: 4, hasMore: true });
		const empty = projectEndoCockpitSessionTimelineV0({
			source: logSource(4, "endo.event.test.last"),
			afterSequence: 4,
			events: [],
		});
		expect(empty.window).toEqual({ afterSequence: 4, nextAfterSequence: 4, hasMore: false });
	});

	it("presents an unopenable source as a source condition, with no entries, not as an empty log", () => {
		const source: EndoCockpitEventLogSourceV0 = {
			domain: "event-log",
			condition: {
				state: "unopenable",
				tornTail: null,
				sealedAt: null,
				error: { kind: "invalid-store", message: "the store could not be opened" },
			},
			watermark: null,
		};
		const result = projectEndoCockpitSessionTimelineV0({ source, afterSequence: 0, events: [] });
		expect(result.source.condition.state).toBe("unopenable");
		expect(result.window.hasMore).toBeNull();
		expect(result.notes).toEqual([{ code: "source-not-projectable", refs: [] }]);
	});
});

describe("runtime identity", () => {
	it("presents the specimen with its bases and the withheld fields named", () => {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		const result = projectEndoCockpitRuntimeIdentityV0(input(records));
		const { fingerprint } = specimen();
		expect(result.runtime).toMatchObject({ basis: "observed", value: "pi" });
		expect(result.current).toMatchObject({
			id: fingerprint.id,
			version: { basis: "reported", value: "1.0.0" },
			identity: { basis: "derived", value: { confidence: "strong" } },
			entrypoint: { basis: "observed" },
			package: { basis: "observed", value: { version: "1.0.0" } },
		});
		expect(result.current!.withheld).toContain("local.realPath");
		expect(result.lastChange).toMatchObject({ kind: "first-observation", failure: "none" });
		expect(result.lastNotification).toMatchObject({ lineCount: 2, linesWithheld: true });
		expect(result.notes).toEqual([]);
	});

	it("keeps unavailable facts unavailable, with a fixed reason that does not repeat the recorded one", () => {
		const { fingerprint } = specimen();
		const reduced = {
			...fingerprint,
			local: { ...fingerprint.local, entrypoint: null, package: null },
			reported: { versionText: null, version: null },
			gaps: [
				{ fact: "entrypoint" as const, reason: `cannot read /home/${CANARY}/entry` },
				{ fact: "package" as const, reason: "no manifest" },
				{ fact: "version" as const, reason: "no output" },
			],
			identity: { ...fingerprint.identity, confidence: "reduced" as const },
		};
		const result = projectEndoCockpitRuntimeIdentityV0(input({ ...specimenRecords(), fingerprint: [reduced] }));
		expect(result.current!.version.basis).toBe("unavailable");
		expect(result.current!.entrypoint.basis).toBe("unavailable");
		expect(result.current!.package.basis).toBe("unavailable");
		expect(JSON.stringify(result)).not.toContain(CANARY);
	});

	it("reports the latest different observation and a change that does not belong to the latest fingerprint", () => {
		const { fingerprint } = specimen();
		const newer = {
			...fingerprint,
			id: "endo.evidence.test-fingerprint.2",
			identity: { ...fingerprint.identity, digest: "b".repeat(64) },
			reported: { versionText: "pi 1.0.1", version: "1.0.1" },
		};
		const result = projectEndoCockpitRuntimeIdentityV0(
			input({ ...specimenRecords(), fingerprint: [fingerprint, newer], change: [changeRecord()] }),
		);
		expect(result.current!.id).toBe(newer.id);
		expect(result.previousDifferent!.id).toBe(fingerprint.id);
		expect(result.notes.map((note) => note.code)).toEqual(["latest-change-not-for-latest-fingerprint"]);
	});

	it("a failed collection is not a current observation, and its failure text is not presented", () => {
		const failed = changeRecord({
			id: "endo.evidence.test-change.2",
			kind: "collection-failed",
			current: null,
			failure: `cannot run /home/${CANARY}/pi`,
		});
		const result = projectEndoCockpitRuntimeIdentityV0(input({ ...specimenRecords(), change: [failed] }));
		expect(result.lastChange).toMatchObject({ kind: "collection-failed", current: null, failure: "withheld" });
		expect(result.notes.map((note) => note.code)).toEqual(["latest-change-is-collection-failure"]);
		expect(JSON.stringify(result)).not.toContain(CANARY);
	});

	it("notes disagreement, foreign attachments, duplicate ids and a notification whose change is missing", () => {
		const { fingerprint } = specimen();
		const other = { ...fingerprint, id: "endo.evidence.test-fingerprint.3", runtime: "acp" };
		const foreign = { ...fingerprint, id: "endo.evidence.test-fingerprint.4", attachment: "other.default" };
		const records = {
			...specimenRecords(),
			fingerprint: [fingerprint, fingerprint, other, foreign],
			notification: [notificationRecord({ changeId: "endo.evidence.test-change.missing" })],
		};
		const result = projectEndoCockpitRuntimeIdentityV0(input(records));
		expect(result.notes.map((note) => note.code).sort()).toEqual([
			"duplicate-record-id",
			"foreign-attachment-record",
			"notification-change-missing",
			"runtime-disagreement",
		]);
		expect(result.current!.id).toBe(other.id);
		expect(validateEndoCockpitRuntimeIdentityV0(result)).not.toBeNull();
	});

	it("an absent registry is stated as not projectable, not as an empty runtime", () => {
		const result = projectEndoCockpitRuntimeIdentityV0(input(null));
		expect(result.runtime.basis).toBe("unavailable");
		expect(result.current).toBeNull();
		expect(result.notes).toEqual([{ code: "source-not-projectable", refs: [] }]);
	});
});

describe("capability state", () => {
	it("reuses the recorded status and evidence dependencies without recomputing admission", () => {
		const records = specimenRecords();
		const result = projectEndoCockpitCapabilityStateV0(input(records));
		const state = records.state[0]!;
		expect(result.state).toMatchObject({ currency: "current", fingerprintId: state.fingerprintId });
		expect(result.capabilities.map((c) => [c.capability, c.status, c.classification])).toEqual(
			state.capabilities.map((c) => [c.capability, c.status, c.classification]),
		);
		for (const view of result.capabilities) {
			expect(view.limits).toEqual([]);
			if (view.status !== "unverified") {
				expect(view.evidence!.id).toBe(
					state.capabilities.find((c) => c.capability === view.capability)!.evidenceId,
				);
				expect(view.evidence!.dependencies.fingerprintId).toBe(state.fingerprintId);
			}
		}
		expect(result.capabilities.some((c) => c.limitations.length > 0)).toBe(true);
		expect(result.capabilities[0]!.evidence!.withheld).toEqual(["expected", "inputsDigest", "observed"]);
	});

	it("shows unverified capabilities with their reason and no evidence", () => {
		const records = specimenRecords();
		const unverified = {
			...records.state[0]!,
			fingerprintId: null,
			capabilities: [
				{
					capability: "session.identity",
					status: "unverified" as const,
					classification: null,
					evidenceId: null,
					reason: "the runtime is unidentified",
					requires: "local-protocol" as const,
				},
			],
		};
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [unverified] }));
		expect(result.capabilities).toEqual([
			expect.objectContaining({
				status: "unverified",
				classification: null,
				evidence: null,
				reason: "the runtime is unidentified",
				limits: [],
			}),
		]);
		expect(result.state!.currency).toBe("unknown");
	});

	it("says no state is recorded when none is, and keeps an empty list of capabilities distinct from unavailable ones", () => {
		const result = projectEndoCockpitCapabilityStateV0(input({ ...specimenRecords(), state: [] }));
		expect(result.state).toBeNull();
		expect(result.capabilities).toEqual([]);
		expect(result.notes.map((n) => n.code)).toEqual(["no-capability-state-recorded"]);
	});

	it("flags a state derived for an older fingerprint than the latest one recorded", () => {
		const records = specimenRecords();
		const newer = {
			...records.fingerprint[0]!,
			id: "endo.evidence.test-fingerprint.2",
			identity: { ...records.fingerprint[0]!.identity, digest: "c".repeat(64) },
		};
		const result = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [records.fingerprint[0]!, newer] }),
		);
		expect(result.state).toMatchObject({ currency: "stale", latestFingerprintId: newer.id });
		const admitted = result.capabilities.filter((c) => c.status !== "unverified");
		expect(admitted.length).toBeGreaterThan(0);
		for (const view of admitted) expect(view.limits.map((l) => l.code)).toContain("state-not-for-latest-fingerprint");
		// The recorded status itself is not rewritten.
		expect(result.capabilities.map((c) => c.status)).toEqual(records.state[0]!.capabilities.map((c) => c.status));
	});

	it("flags misleading combinations in records that did not pass through the registry", () => {
		const records = specimenRecords();
		const state = structuredClone(records.state[0]!);
		const [a, b, c, d, e] = state.capabilities;
		a!.evidenceId = "endo.evidence.test-missing.1"; // dangling
		b!.classification = "UNAVAILABLE"; // admitted yet classified UNAVAILABLE
		const evidence = structuredClone(records.evidence);
		const edit = (capability: typeof a) => evidence.find((item) => item.id === capability!.evidenceId)!;
		edit(c).capability = "some.other-capability"; // evidence for another capability
		edit(d).dependencies.confidence = "reduced"; // carried across observations on a reduced identity
		edit(d).dependencies.fingerprintId = "endo.evidence.test-fingerprint.9";
		edit(e).dependencies.identityDigest = "f".repeat(64); // recorded against another runtime
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence, state: [state] }));
		const codes = (name: string) => result.capabilities.find((v) => v.capability === name)!.limits.map((l) => l.code);
		expect(codes(a!.capability)).toEqual(["evidence-record-missing"]);
		expect(codes(b!.capability)).toEqual(
			expect.arrayContaining(["status-classification-mismatch", "evidence-classification-differs"]),
		);
		expect(codes(c!.capability)).toEqual(["evidence-capability-differs"]);
		expect(codes(d!.capability)).toEqual(["evidence-confidence-differs", "evidence-reduced-identity"]);
		expect(codes(e!.capability)).toEqual(["evidence-identity-differs"]);
		// The status is carried as recorded in every case.
		expect(result.capabilities.find((v) => v.capability === b!.capability)!.status).toBe(b!.status);
		for (const view of result.capabilities)
			for (const limit of view.limits) expect(limit.refs.length).toBeGreaterThan(0);
	});

	it("evidence carried across observations on an unchanged strong identity raises no limit", () => {
		const records = specimenRecords();
		const first = records.fingerprint[0]!;
		const second = { ...first, id: "endo.evidence.test-fingerprint.2", observedAt: "2026-10-04T10:00:00Z" };
		const state = { ...structuredClone(records.state[0]!), fingerprintId: second.id, at: "2026-10-04T10:00:01Z" };
		const result = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [first, second], state: [records.state[0]!, state] }),
		);
		expect(result.state).toMatchObject({ currency: "current", fingerprintId: second.id });
		expect(result.capabilities.length).toBeGreaterThan(0);
		for (const view of result.capabilities) expect(view.limits).toEqual([]);
		// ... while a state naming a fingerprint nobody recorded is flagged for every capability that rests on evidence.
		const orphan = { ...state, fingerprintId: "endo.evidence.test-fingerprint.404" };
		const flagged = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [orphan] }));
		for (const view of flagged.capabilities.filter((item) => item.status !== "unverified"))
			expect(view.limits.map((l) => l.code)).toContain("state-fingerprint-not-recorded");
	});

	it("a capability listed twice appears once, with the repeat noted", () => {
		const records = specimenRecords();
		const state = structuredClone(records.state[0]!);
		state.capabilities.push(structuredClone(state.capabilities[0]!));
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [state] }));
		expect(result.capabilities).toHaveLength(records.state[0]!.capabilities.length);
		expect(result.notes.map((n) => n.code)).toEqual(["duplicate-capability"]);
	});

	it("a state with no fingerprint recorded is noted and not called current", () => {
		const result = projectEndoCockpitCapabilityStateV0(input({ ...specimenRecords(), fingerprint: [] }));
		expect(result.state!.currency).toBe("unknown");
		expect(result.notes.map((n) => n.code)).toContain("state-without-fingerprint");
	});
});

describe("presentation boundary", () => {
	it("passes no sensitive source field into any projection", () => {
		const records = specimenRecords();
		const fingerprint = structuredClone(records.fingerprint[0]!);
		fingerprint.local = {
			requested: `/home/${CANARY}/requested`,
			resolvedPath: `/home/${CANARY}/resolved`,
			realPath: `/home/${CANARY}/real`,
			entrypoint: fingerprint.local.entrypoint,
			package:
				fingerprint.local.package === null ? null : { ...fingerprint.local.package, root: `/home/${CANARY}/root` },
		};
		fingerprint.reported.versionText = `pi ${CANARY}`;
		const evidence = structuredClone(records.evidence).map((e) => ({
			...e,
			expected: `expected ${CANARY}`,
			observed: `observed ${CANARY}`,
		}));
		const failed = changeRecord({
			id: "endo.evidence.test-change.9",
			kind: "collection-failed",
			current: null,
			failure: CANARY,
		});
		const registry = projectEndoCockpitRuntimeIdentityV0(
			input({
				...records,
				fingerprint: [fingerprint],
				evidence,
				change: [changeRecord(), failed],
				notification: [notificationRecord()],
			}),
		);
		const capabilities = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [fingerprint], evidence }),
		);

		const events = [
			event("harness.attached", {
				instance: "i1",
				fingerprintId: fingerprint.id,
				version: "1.0.0",
				args: ["--session-dir", `/home/${CANARY}/s`],
				digestKey: { keyId: CANARY },
				extra: CANARY,
			}),
			event("tool.started", {
				toolName: "bash",
				toolCallId: "c",
				args: { command: CANARY },
				argsDigest: { algorithm: "hmac-sha256", keyId: "k", value: "d".repeat(64), note: CANARY },
			}),
			event("tool.finished", { toolName: "bash", result: CANARY, isError: false }),
			event("session.entry-observed", {
				entryType: "message",
				recognized: true,
				parentId: null,
				runtimeTimestamp: CANARY,
				details: { role: "assistant", provider: CANARY, model: CANARY, text: CANARY },
			}),
			event("lifecycle.interrupted", {
				cause: "observer-lost",
				instance: "i",
				storeRecovery: { discarded: { preservedAt: `/tmp/${CANARY}` } },
			}),
			event("lifecycle.run-failed", {
				turns: 1,
				cause: { message: { status: "reported", value: { sha256: "e".repeat(64), text: CANARY } } },
			}),
			event("vendor.new-kind", { secret: CANARY }),
			event("harness.process-exited", {
				code: 1,
				signal: null,
				spawnFailed: false,
				expected: false,
				stderr: CANARY,
			}),
			event("lifecycle.turn-completed", {
				turn: 1,
				stopReason: { status: "reported", value: "stop", detail: CANARY },
				prompt: CANARY,
			}),
		];
		const result = timeline(events);
		const text = canonicalEndoJsonV0([registry, capabilities, result]);
		expect(text).not.toContain(CANARY);
		expect(text).not.toContain("/home/");
		// What stays: opaque ids and digests.
		const tool = result.entries[1]!;
		expect(tool.fields.argsDigest).toEqual({ basis: "derived", value: "d".repeat(64) });
		expect(tool.fields.argsDigestKeyId).toEqual({ basis: "derived", value: "k" });
		expect(tool.withheldFields).toBeGreaterThanOrEqual(1);
		expect(result.entries[0]!.withheldFields).toBe(3);
		expect(result.entries[6]!.fields).toEqual({});
	});

	it("withholds an over-long string field whole instead of cutting it", () => {
		const result = timeline([event("harness.protocol-fault", { fault: "x".repeat(10_000) })]);
		expect(result.entries[0]!.fields.fault).toEqual({
			basis: "unavailable",
			reason: "withheld: looks like a path, address or credential",
		});
		expect(JSON.stringify(result).length).toBeLessThan(2000);
		const atBound = timeline([event("harness.protocol-fault", { fault: "x".repeat(256) })]);
		expect(atBound.entries[0]!.fields.fault).toEqual({ basis: "observed", value: "x".repeat(256) });
		const secretPastTheBound = timeline([
			event("harness.protocol-fault", { fault: `${"x".repeat(250)} ghp_${"A".repeat(36)}` }),
		]);
		expect(JSON.stringify(secretPastTheBound)).not.toContain("ghp_");
	});

	it("hostile payload shapes do not break the projection", () => {
		const hostile = [
			event("tool.started", JSON.parse('{"__proto__": {"toolName": "polluted"}, "toolName": 7}')),
			event("session.entry-observed", { details: [], entryType: ["message"] } as never),
			{ ...event("tool.finished"), payload: "just a string" as never },
			{ ...event("tool.finished"), payload: [1, 2] as never },
			{ ...event("tool.finished"), payload: null as never },
		];
		const result = timeline(hostile);
		expect(result.entries).toHaveLength(5);
		expect(({} as Record<string, unknown>).toolName).toBeUndefined();
		expect(result.entries[0]!.fields).toEqual({});
		expect(validateEndoCockpitSessionTimelineV0(result)).not.toBeNull();
	});
});

describe("contract validators", () => {
	function good() {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		const capabilities = projectEndoCockpitCapabilityStateV0(input(records));
		const log = timeline([
			event("lifecycle.run-started", { instance: "i" }),
			event("tool.started", { toolName: "read" }),
		]);
		return {
			identity,
			capabilities,
			log,
			snapshot: {
				schemaVersion: "endo.cockpit-snapshot.v0",
				projectionVersion: "cockpit-snapshot.1",
				consistency: "independent-sources",
				timeline: log,
				runtimes: [{ identity, capabilities }],
			},
		};
	}

	it("accepts what the projections produce, dispatching on the declared version", () => {
		const { identity, capabilities, log, snapshot } = good();
		for (const value of [identity, capabilities, log, snapshot]) {
			const read = readEndoCockpitRecordV0(JSON.parse(JSON.stringify(value)));
			expect(read.ok).toBe(true);
		}
		expect(ENDO_COCKPIT_VERSIONS_V0.versions).toEqual([
			"endo.cockpit-runtime-identity.v0",
			"endo.cockpit-capability-state.v0",
			"endo.cockpit-session-timeline.v0",
			"endo.cockpit-snapshot.v0",
		]);
	});

	it("rejects unknown, missing and mistyped versions distinctly, and never accepts a future one", () => {
		const { log } = good();
		expect(readEndoCockpitRecordV0({ ...log, schemaVersion: "endo.cockpit-session-timeline.v1" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
		expect(readEndoCockpitRecordV0({ ...log, schemaVersion: "endo.cockpit-session-timeline.v999" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
		expect(readEndoCockpitRecordV0({ ...log, schemaVersion: undefined })).toMatchObject({ ok: false });
		const { schemaVersion: _drop, ...bare } = log;
		expect(readEndoCockpitRecordV0(bare)).toMatchObject({ ok: false, kind: "missing-version" });
		expect(readEndoCockpitRecordV0({ ...log, schemaVersion: 0 })).toMatchObject({
			ok: false,
			kind: "version-not-string",
		});
		expect(readEndoCockpitRecordV0([])).toMatchObject({ ok: false, kind: "not-an-object" });
	});

	it("rejects unknown fields at the root and in nested objects", () => {
		const { identity, capabilities, log, snapshot } = good();
		const withExtra = (value: unknown, path: (string | number)[]) => {
			const copy = structuredClone(value) as Record<string, any>;
			let at = copy;
			for (const key of path) at = at[key];
			at.surprise = 1;
			return copy;
		};
		expect(validateEndoCockpitRuntimeIdentityV0(withExtra(identity, []))).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withExtra(identity, ["current", "version"]))).toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(withExtra(identity, ["source", "condition"]))).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(withExtra(capabilities, ["capabilities", 0, "evidence", "dependencies"])),
		).toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(withExtra(log, ["entries", 0]))).toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(withExtra(log, ["window"]))).toBeNull();
		expect(validateEndoCockpitSnapshotV0(withExtra(snapshot, []))).toBeNull();
	});

	it("rejects incoherent provenance and source conditions", () => {
		const { identity, log } = good();
		const bad = structuredClone(identity) as any;
		bad.current.version.basis = "confident";
		expect(validateEndoCockpitRuntimeIdentityV0(bad)).toBeNull();
		const unavailableWithValue = structuredClone(identity) as any;
		unavailableWithValue.runtime = { basis: "unavailable", value: "pi", refs: [] };
		expect(validateEndoCockpitRuntimeIdentityV0(unavailableWithValue)).toBeNull();
		const danglingRef = structuredClone(identity) as any;
		danglingRef.current.ref = { domain: "somewhere-else", id: "x" };
		expect(validateEndoCockpitRuntimeIdentityV0(danglingRef)).toBeNull();
		// A clean state with damage recorded, damage with no state, an unopenable source with a watermark.
		for (const mutate of [
			(v: any) => {
				v.source.condition.tornTail = { bytes: 3, sha256: "a".repeat(64) };
			},
			(v: any) => {
				v.source.condition.state = "degraded";
			},
			(v: any) => {
				v.source.condition = {
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "x", message: "y" },
				};
			},
			(v: any) => {
				v.source.condition.state = "absent";
			},
		]) {
			const copy = structuredClone(log) as any;
			mutate(copy);
			expect(validateEndoCockpitSessionTimelineV0(copy)).toBeNull();
		}
	});

	it("rejects a timeline whose entries leave storage order or the window", () => {
		const { log } = good();
		const reordered = structuredClone(log);
		reordered.entries.reverse();
		expect(validateEndoCockpitSessionTimelineV0(reordered)).toBeNull();
		const outside = structuredClone(log);
		outside.window.nextAfterSequence = 1;
		expect(validateEndoCockpitSessionTimelineV0(outside)).toBeNull();
		const repeated = structuredClone(log);
		repeated.entries[1]!.eventId = repeated.entries[0]!.eventId;
		expect(validateEndoCockpitSessionTimelineV0(repeated)).toBeNull();
	});

	it("rejects a snapshot that mixes attachments, repeats one, or claims atomicity", () => {
		const { snapshot, identity, capabilities } = good();
		const mixed = structuredClone(snapshot);
		mixed.runtimes[0]!.capabilities.source.attachment = "other.default";
		expect(validateEndoCockpitSnapshotV0(mixed)).toBeNull();
		const repeated = structuredClone(snapshot);
		repeated.runtimes.push({ identity, capabilities });
		expect(validateEndoCockpitSnapshotV0(repeated)).toBeNull();
		expect(validateEndoCockpitSnapshotV0({ ...snapshot, consistency: "atomic" })).toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
	});

	it("rejects a capability state that lists a capability twice or capabilities without a state", () => {
		const { capabilities } = good();
		const twice = structuredClone(capabilities) as EndoCockpitCapabilityStateV0;
		twice.capabilities.push(structuredClone(twice.capabilities[0]!));
		expect(validateEndoCockpitCapabilityStateV0(twice)).toBeNull();
		const orphan = structuredClone(capabilities) as EndoCockpitCapabilityStateV0;
		orphan.state = null;
		expect(validateEndoCockpitCapabilityStateV0(orphan)).toBeNull();
	});
});

describe("harness.attached runtime session reference (PR #57 review: ACP session ids)", () => {
	const attached = (payload: Record<string, unknown>) => timeline([event("harness.attached", payload)]).entries[0]!;
	const acpRef = `sha256-${"a".repeat(48)}`;

	it("presents Pi's piSessionId as the runtime session reference, apart from the canonical session", () => {
		const entry = attached({ instance: "i1", mapping: "pi-mapping.1", piSessionId: "endo-pi-default-a33c9b2338da" });
		expect(entry.fields.runtimeSessionId).toEqual({ basis: "reported", value: "endo-pi-default-a33c9b2338da" });
		expect(entry.sessionId).toBe("endo.session.test.one");
		expect(entry.withheldFields).toBe(0);
	});

	it("presents ACP v1 and v2 acpSessionId through the same generic field", () => {
		const v1 = attached({
			mapping: "acp-v1-mapping.3",
			instance: "i1",
			acpSessionId: "0b1f6c1e-3c2a-4e0b-9d1c-5b9c7a2f4e10",
			openedBy: "session/new",
		});
		const v2 = attached({
			mapping: "acp-v2-mapping.0",
			instance: "i1",
			acpSessionId: acpRef,
			openedBy: "session/resume",
			historyReplay: "not-requested",
		});
		expect(v1.fields.runtimeSessionId).toEqual({ basis: "reported", value: "0b1f6c1e-3c2a-4e0b-9d1c-5b9c7a2f4e10" });
		expect(v2.fields.runtimeSessionId).toEqual({ basis: "reported", value: acpRef });
		expect(v1.fields).not.toHaveProperty("acpSessionId");
		expect(v1.sessionId).toBe("endo.session.test.one");
		// openedBy and historyReplay are not allowlisted, so they stay counted as withheld.
		expect(v1.withheldFields).toBe(1);
		expect(v2.withheldFields).toBe(2);
	});

	it("invents nothing when no reference is recorded or the recorded one is not a string", () => {
		for (const payload of [{ instance: "i1" }, { instance: "i1", acpSessionId: 7 }, { acpSessionId: null }]) {
			const entry = attached(payload);
			expect(entry.fields).not.toHaveProperty("runtimeSessionId");
			expect(entry.flags).not.toContain("anomaly");
		}
		expect(attached({ acpSessionId: 7 }).withheldFields).toBe(1);
	});

	it("treats two equal references as one and two different references as a stated conflict", () => {
		const same = attached({ piSessionId: acpRef, acpSessionId: acpRef });
		expect(same.fields.runtimeSessionId).toEqual({ basis: "reported", value: acpRef });
		expect(same.withheldFields).toBe(0);

		const conflict = attached({ piSessionId: acpRef, acpSessionId: "0b1f6c1e-3c2a-4e0b-9d1c-5b9c7a2f4e10" });
		expect(conflict.fields.runtimeSessionId).toMatchObject({ basis: "unavailable" });
		expect(JSON.stringify(conflict)).not.toContain(acpRef);
		expect(JSON.stringify(conflict)).not.toContain("0b1f6c1e");
		expect(conflict.flags).toContain("anomaly");
		expect(conflict.withheldFields).toBe(2);
		expect(
			validateEndoCockpitSessionTimelineV0(
				timeline([event("harness.attached", { piSessionId: "a", acpSessionId: "b" })]),
			),
		).not.toBeNull();
	});
});

describe("recognised kinds versus presented fields (PR #57 review: envelope-only kinds)", () => {
	// Kinds the repository's Pi and ACP producers record, which carry no approved presentation field.
	const KNOWN_ENVELOPE_ONLY = [
		"permission.requested",
		"permission.decided",
		"session.update-observed",
		"session.config-observed",
		"session.listed",
		"session.close-accepted",
		"session.state-conflict",
		"session.info-changed",
		"control.refused",
		"control.unavailable",
		"control.message-refused",
		"agent.prompt-accepted",
		"agent.prompt-refused",
		"agent.prompt-responded",
		"agent.prompt-failed",
		"agent.state-reported",
		"config.thinking-changed",
		"extension.ui-requested",
		"extension.dialog-cancelled",
		"harness.acp-initialized",
		"harness.late-message",
		"harness.prompt-timeout",
		"intervention.proposal",
		"intervention.request",
		"intervention.consequence",
	];

	it("does not flag a known kind that has no approved field, and still withholds its whole payload", () => {
		for (const kind of KNOWN_ENVELOPE_ONLY) {
			const entry = timeline([event(kind, { secret: CANARY, nested: { path: `/home/${CANARY}` } })]).entries[0]!;
			expect(entry.flags, kind).not.toContain("unrecognized");
			expect(entry.fields, kind).toEqual({});
			expect(entry.withheldFields, kind).toBe(2);
			expect(JSON.stringify(entry), kind).not.toContain(CANARY);
		}
	});

	it("keeps genuinely unknown kinds unrecognised, including capability names that are not event kinds", () => {
		for (const kind of [
			"vendor.unknown-kind",
			"control.model",
			"session.identity",
			"session.prompt",
			"session.cancel",
			"session.close",
			"capture.request",
			"permission.subject.command",
		]) {
			const entry = timeline([event(kind, { whatever: 1 })]).entries[0]!;
			expect(entry.flags, kind).toContain("unrecognized");
			expect(entry.fields, kind).toEqual({});
		}
	});
});

describe("capability runtime disagreement (PR #57 review)", () => {
	const admitted = (result: EndoCockpitCapabilityStateV0) =>
		result.capabilities.filter((c) => c.status !== "unverified");

	it("limits every admitted capability whose cited evidence is for another runtime family, without rewriting its status", () => {
		const records = specimenRecords();
		const evidence = structuredClone(records.evidence).map((item) => ({ ...item, runtime: "acp" }));
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence }));
		expect(admitted(result).length).toBeGreaterThan(0);
		for (const view of admitted(result)) {
			const limit = view.limits.find((l) => l.code === "runtime-differs");
			expect(limit, view.capability).toBeDefined();
			expect(limit!.refs).toEqual([view.ref, view.evidence!.ref]);
		}
		expect(result.capabilities.map((c) => c.status)).toEqual(records.state[0]!.capabilities.map((c) => c.status));
		expect(validateEndoCockpitCapabilityStateV0(result)).not.toBeNull();
	});

	it("limits a state whose named or latest fingerprint is another runtime family, with those fingerprints as references", () => {
		const records = specimenRecords();
		const first = records.fingerprint[0]!;
		const foreignNewest = { ...first, id: "endo.evidence.test-fingerprint.2", runtime: "acp" };
		const stale = projectEndoCockpitCapabilityStateV0(input({ ...records, fingerprint: [first, foreignNewest] }));
		for (const view of admitted(stale)) {
			const limit = view.limits.find((l) => l.code === "runtime-differs")!;
			expect(limit.refs.map((ref) => (ref.domain === "harness-registry" ? `${ref.kind}:${ref.id}` : ""))).toEqual([
				"state:null",
				`fingerprint:${foreignNewest.id}`,
			]);
		}
		expect(validateEndoCockpitCapabilityStateV0(stale)).not.toBeNull();

		const named = { ...first, id: "endo.evidence.test-fingerprint.3", runtime: "acp" };
		const state = { ...structuredClone(records.state[0]!), fingerprintId: named.id, at: "2026-10-04T10:00:01Z" };
		const mismatched = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [first, named], state: [records.state[0]!, state] }),
		);
		expect(admitted(mismatched).every((v) => v.limits.some((l) => l.code === "runtime-differs"))).toBe(true);
		expect(validateEndoCockpitCapabilityStateV0(mismatched)).not.toBeNull();
	});

	it("raises nothing for evidence carried across observations of one runtime, and ignores an unverified capability", () => {
		const records = specimenRecords();
		const first = records.fingerprint[0]!;
		const second = { ...first, id: "endo.evidence.test-fingerprint.2", observedAt: "2026-10-04T10:00:00Z" };
		const state = { ...structuredClone(records.state[0]!), fingerprintId: second.id, at: "2026-10-04T10:00:01Z" };
		const result = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [first, second], state: [records.state[0]!, state] }),
		);
		for (const view of result.capabilities) expect(view.limits).toEqual([]);
		const foreign = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [{ ...first, runtime: "acp" }] }),
		);
		for (const view of foreign.capabilities.filter((v) => v.status === "unverified")) expect(view.limits).toEqual([]);
	});
});

describe("contextual reference validation (PR #57 review: wire validation is not store verification)", () => {
	function good() {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		return {
			identity: projectEndoCockpitRuntimeIdentityV0(input(records)),
			capabilities: projectEndoCockpitCapabilityStateV0(input(records)),
		};
	}
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	const other = "endo.evidence.test-other.1";

	it("rejects a runtime identity whose reference is altered in exactly one field", () => {
		const { identity } = good();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const edits: [string, (copy: any) => void][] = [
			[
				"fingerprint ref to another kind",
				(c) => {
					c.current.ref.kind = "evidence";
				},
			],
			[
				"fingerprint ref id differs from the view",
				(c) => {
					c.current.ref.id = other;
				},
			],
			[
				"fingerprint ref attachment",
				(c) => {
					c.current.ref.attachment = "other.default";
				},
			],
			[
				"fingerprint ref index beyond the watermark",
				(c) => {
					c.current.ref.index = 3;
				},
			],
			[
				"fingerprint ref replaced by an event reference",
				(c) => {
					c.current.ref = { domain: "event-log", storageSequence: 1, eventId: "endo.event.test.1" };
				},
			],
			[
				"claim reads from another record",
				(c) => {
					c.current.identity.refs[0].id = other;
				},
			],
			[
				"claim reads from another kind",
				(c) => {
					c.current.version.refs[0].kind = "change";
				},
			],
			[
				"change ref kind",
				(c) => {
					c.lastChange.ref.kind = "notification";
				},
			],
			[
				"change ref id",
				(c) => {
					c.lastChange.ref.id = other;
				},
			],
			[
				"notification ref kind",
				(c) => {
					c.lastNotification.ref.kind = "change";
				},
			],
			[
				"notification ref index",
				(c) => {
					c.lastNotification.ref.index = 1;
				},
			],
			[
				"runtime claim names another record",
				(c) => {
					c.runtime.refs[0] = c.lastChange.ref;
				},
			],
			[
				"runtime claim has no source",
				(c) => {
					c.runtime.refs = [];
				},
			],
			[
				"note points into another attachment",
				(c) =>
					c.notes.push({
						code: "notification-change-missing",
						refs: [{ ...c.lastNotification.ref, attachment: "other.default" }],
					}),
			],
			[
				"note points at the wrong kind of record",
				(c) => c.notes.push({ code: "notification-change-missing", refs: [c.current.ref] }),
			],
			[
				"note carries a reference its code never has",
				(c) => c.notes.push({ code: "no-fingerprint-recorded", refs: [c.current.ref] }),
			],
		];
		for (const [name, edit] of edits)
			expect(validateEndoCockpitRuntimeIdentityV0(mutated(identity, edit)), name).toBeNull();
	});

	it("rejects a capability state whose reference or currency is altered in exactly one field", () => {
		const { capabilities } = good();
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		const first = (c: any) => c.capabilities.find((v: any) => v.evidence !== null);
		const edits: [string, (copy: any) => void][] = [
			[
				"state ref kind",
				(c) => {
					c.state.ref.kind = "fingerprint";
				},
			],
			[
				"state ref given an id",
				(c) => {
					c.state.ref.id = other;
				},
			],
			[
				"state ref index",
				(c) => {
					c.state.ref.index = 1;
				},
			],
			[
				"capability ref differs from the state",
				(c) => {
					first(c).ref.index = 1;
				},
			],
			[
				"evidence ref kind",
				(c) => {
					first(c).evidence.ref.kind = "fingerprint";
				},
			],
			[
				"evidence ref id differs from the view",
				(c) => {
					first(c).evidence.ref.id = other;
				},
			],
			[
				"evidence ref replaced by an event reference",
				(c) => {
					first(c).evidence.ref = { domain: "event-log", storageSequence: 1, eventId: "endo.event.test.1" };
				},
			],
			[
				"currency contradicts the ids",
				(c) => {
					c.state.currency = "stale";
				},
			],
			[
				"limit without the state reference",
				(c) => first(c).limits.push({ code: "evidence-capability-differs", refs: [first(c).evidence.ref] }),
			],
			[
				"limit names a fingerprint the state does not",
				(c) =>
					first(c).limits.push({
						code: "runtime-differs",
						refs: [first(c).ref, { ...c.state.ref, kind: "fingerprint", id: other }],
					}),
			],
			[
				"limit names evidence that is not the cited one",
				(c) =>
					first(c).limits.push({
						code: "evidence-capability-differs",
						refs: [first(c).ref, { ...first(c).evidence.ref, index: 0, id: other }],
					}),
			],
			[
				"limit references a kind its code never has",
				(c) =>
					first(c).limits.push({
						code: "status-classification-mismatch",
						refs: [first(c).ref, first(c).evidence.ref],
					}),
			],
		];
		for (const [name, edit] of edits)
			expect(validateEndoCockpitCapabilityStateV0(mutated(capabilities, edit)), name).toBeNull();
	});

	it("keeps legitimate references to records a presentation does not embed, and does not claim to read the store", () => {
		const { identity, capabilities } = good();
		// A note may name an evidence record or a state that no view embeds.
		const withNote = mutated(identity, (c) =>
			c.notes.push({
				code: "duplicate-record-id",
				refs: [
					{
						domain: "harness-registry",
						attachment: ATTACHMENT,
						kind: "evidence",
						index: 0,
						id: capabilities.capabilities.find((v) => v.evidence)!.evidence!.id,
					},
				],
			}),
		);
		expect(validateEndoCockpitRuntimeIdentityV0(withNote)).not.toBeNull();
		// Wire validation only: with several records of a kind, an id inside the watermark's range cannot be checked
		// against the log without reading it, so a plausible reference is accepted. Disk verification is the reader's job.
		const records = specimenRecords();
		const second = { ...records.fingerprint[0]!, id: "endo.evidence.test-fingerprint.2" };
		const wire = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, fingerprint: [records.fingerprint[0]!, second] }),
		);
		const swapped = mutated(wire, (c) => {
			c.previousDifferent = null;
		});
		expect(validateEndoCockpitRuntimeIdentityV0(swapped)).not.toBeNull();
	});
});

describe("timeline pagination metadata against its watermark (PR #57 review)", () => {
	const ids = (n: number) =>
		Array.from({ length: n }, (_, i) => event("tool.started", {}, { id: `endo.event.page.${i + 1}` }));
	function page(
		length: number,
		afterSequence: number,
		take: number,
		state: "readable" | "empty" | "absent" = "readable",
	) {
		const all = ids(length);
		const events = all.slice(afterSequence, afterSequence + take);
		return projectEndoCockpitSessionTimelineV0({
			source: {
				domain: "event-log",
				condition: { state, tornTail: null, sealedAt: null, error: null },
				watermark: {
					length,
					lastEventId: all.at(-1)?.id ?? null,
					prefixDigest: length === 0 ? null : sha256HexV0(`prefix-${length}`),
				},
			},
			afterSequence,
			events: stored(events, afterSequence + 1),
		});
	}
	const withMore = (value: EndoCockpitSessionTimelineV0, hasMore: boolean | null) =>
		mutated(value, (c) => {
			c.window.hasMore = hasMore;
		});
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};

	it("accepts the beginning, the middle, the exact end, a window past the end, an empty and an absent log", () => {
		const cases: [string, EndoCockpitSessionTimelineV0, boolean][] = [
			["beginning", page(5, 0, 2), true],
			["middle", page(5, 2, 2), true],
			["exact end", page(5, 3, 2), false],
			["exact end, full page", page(4, 0, 4), false],
			["past the end", page(4, 9, 3), false],
			["empty log", page(0, 0, 0, "empty"), false],
			["absent log", page(0, 0, 0, "absent"), false],
		];
		for (const [name, value, hasMore] of cases) {
			expect(value.window.hasMore, name).toBe(hasMore);
			expect(validateEndoCockpitSessionTimelineV0(value), name).not.toBeNull();
			// The opposite claim, or no claim at all, contradicts the watermark.
			expect(validateEndoCockpitSessionTimelineV0(withMore(value, !hasMore)), name).toBeNull();
			expect(validateEndoCockpitSessionTimelineV0(withMore(value, null)), name).toBeNull();
		}
		expect(page(4, 9, 3).entries).toEqual([]);
		expect(page(4, 9, 3).window).toEqual({ afterSequence: 9, nextAfterSequence: 9, hasMore: false });
	});

	it("allows no position claim only when the source has no position", () => {
		const unavailable = projectEndoCockpitSessionTimelineV0({
			source: {
				domain: "event-log",
				condition: {
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "invalid-store", message: "the store could not be opened" },
				},
				watermark: null,
			},
			afterSequence: 0,
			events: [],
		});
		expect(unavailable.window.hasMore).toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(unavailable)).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(withMore(unavailable, false))).toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(withMore(unavailable, true))).toBeNull();
		const entries = mutated(page(2, 0, 2), (c) => {
			c.source.watermark = null;
		});
		expect(validateEndoCockpitSessionTimelineV0(withMore(entries, null))).toBeNull();
	});

	it("rejects entries past the source's length and a cursor that does not stop at the last entry", () => {
		const base = page(5, 0, 3);
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(base, (c) => {
					c.source.watermark.length = 2;
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(base, (c) => {
					c.window.nextAfterSequence = 4;
				}),
			),
		).toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(mutated(base, (c) => c.entries.reverse()))).toBeNull();
		// An ignored duplicate is read but not presented, so the cursor may pass the last presented entry.
		const dup = event("tool.started", {}, { id: "endo.event.page.1" });
		const withDuplicate = projectEndoCockpitSessionTimelineV0({
			source: base.source,
			afterSequence: 0,
			events: stored([ids(5)[0]!, dup], 1),
		});
		expect(withDuplicate.duplicatesIgnored).toBe(1);
		expect(withDuplicate.window.nextAfterSequence).toBe(2);
		expect(validateEndoCockpitSessionTimelineV0(withDuplicate)).not.toBeNull();
		const stuck = structuredClone(withDuplicate);
		stuck.window.nextAfterSequence = 0;
		expect(validateEndoCockpitSessionTimelineV0(stuck)).toBeNull();
		const beyond = structuredClone(withDuplicate);
		beyond.window.nextAfterSequence = 99;
		expect(validateEndoCockpitSessionTimelineV0(beyond)).toBeNull();
	});
});

describe("projection version compatibility (PR #57 review)", () => {
	function good() {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		const capabilities = projectEndoCockpitCapabilityStateV0(input(records));
		const log = timeline([event("tool.started", { toolName: "read" })]);
		const snapshot = {
			schemaVersion: "endo.cockpit-snapshot.v0",
			projectionVersion: "cockpit-snapshot.1",
			consistency: "independent-sources",
			timeline: log,
			runtimes: [{ identity, capabilities }],
		};
		return { identity, capabilities, log, snapshot };
	}
	const BAD = ["cockpit-x.99", "cockpit-runtime-identity.2", "", "cockpit-snapshot.1 ", "cockpit-session-timeline.0"];

	it("pins each record to its declared projection version, and keeps it apart from the schema version", () => {
		const { identity, capabilities, log, snapshot } = good();
		expect(identity.projectionVersion).toBe("cockpit-runtime-identity.1");
		expect(capabilities.projectionVersion).toBe("cockpit-capability-state.1");
		expect(log.projectionVersion).toBe("cockpit-session-timeline.1");
		const validators: [string, unknown, (value: unknown) => unknown][] = [
			["identity", identity, validateEndoCockpitRuntimeIdentityV0],
			["capabilities", capabilities, validateEndoCockpitCapabilityStateV0],
			["timeline", log, validateEndoCockpitSessionTimelineV0],
			["snapshot", snapshot, validateEndoCockpitSnapshotV0],
		];
		for (const [name, value, validate] of validators) {
			expect(validate(value), name).not.toBeNull();
			for (const bad of BAD)
				expect(validate({ ...(value as object), projectionVersion: bad }), `${name} ${bad}`).toBeNull();
			// Another record's valid projection version is not this record's.
			const foreign = name === "timeline" ? "cockpit-snapshot.1" : "cockpit-session-timeline.1";
			expect(validate({ ...(value as object), projectionVersion: foreign }), `${name} foreign`).toBeNull();
		}
	});

	it("rejects an unsupported version nested inside a snapshot, in every slot", () => {
		const { snapshot } = good();
		const bad = (edit: (copy: any) => void) => {
			const copy = structuredClone(snapshot);
			edit(copy);
			return validateEndoCockpitSnapshotV0(copy);
		};
		expect(
			bad((c) => {
				c.timeline.projectionVersion = "cockpit-session-timeline.2";
			}),
		).toBeNull();
		expect(
			bad((c) => {
				c.runtimes[0].identity.projectionVersion = "cockpit-runtime-identity.2";
			}),
		).toBeNull();
		expect(
			bad((c) => {
				c.runtimes[0].capabilities.projectionVersion = "cockpit-capability-state.2";
			}),
		).toBeNull();
		expect(
			bad((c) => {
				c.projectionVersion = "cockpit-snapshot.2";
			}),
		).toBeNull();
		expect(bad(() => {})).not.toBeNull();
	});
});

describe("free-text presentation boundary (PR #57 audit)", () => {
	const WITHHELD = "withheld: looks like a path, address or credential";
	const SENSITIVE = [
		`/home/${CANARY}/project`,
		`see ~/${CANARY}/notes`,
		`C:\\Users\\${CANARY}\\x`,
		`failed at \\\\${CANARY}\\share\\x`,
		`https://user:${CANARY}@example.test/x`,
		`token=${CANARY}-abcdef`,
		`Authorization: Bearer ${CANARY}abcdefgh`,
		`key sk-${CANARY}${"a".repeat(20)}`,
		`ghp_${"A".repeat(30)}`,
		"-----BEGIN OPENSSH PRIVATE KEY-----",
	];

	it("withholds a capability reason, limitation or notice title that embeds a path, address or credential", () => {
		for (const text of SENSITIVE) {
			const records = specimenRecords();
			const state = structuredClone(records.state[0]!);
			state.capabilities[0]!.reason = text;
			const evidence = structuredClone(records.evidence);
			const cited = evidence.find((item) => item.id === state.capabilities[1]!.evidenceId)!;
			cited.limitations = [text, "A plain limitation: input/output only"];
			const capabilities = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence, state: [state] }));
			expect(capabilities.capabilities[0]!.reason, text).toBe(WITHHELD);
			expect(capabilities.capabilities[1]!.limitations, text).toEqual([
				WITHHELD,
				"A plain limitation: input/output only",
			]);
			const identity = projectEndoCockpitRuntimeIdentityV0(
				input({
					...records,
					change: [changeRecord()],
					notification: [notificationRecord({ title: text })],
				}),
			);
			expect(identity.lastNotification!.title, text).toBe(WITHHELD);
			expect(JSON.stringify([capabilities, identity]), text).not.toContain(CANARY);
			expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
			expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		}
	});

	it("keeps the recorded wording of the committed specimen, except text longer than the 256-character bound", () => {
		const records = specimenRecords();
		const result = projectEndoCockpitCapabilityStateV0(input(records));
		const recorded = records.state[0]!.capabilities.map((c) => c.reason);
		// Exactly one recorded reason (283 characters) is over the bound; it is withheld whole, never cut.
		expect(recorded.filter((reason) => reason.length > 256)).toHaveLength(1);
		expect(result.capabilities.map((c) => c.reason)).toEqual(
			recorded.map((reason) => (reason.length > 256 ? WITHHELD : reason)),
		);
		const wanted = records.evidence.flatMap((item) => item.limitations);
		const shown = result.capabilities.flatMap((c) => c.limitations);
		expect(shown.every((text) => wanted.includes(text))).toBe(true);
		expect(shown).not.toContain(WITHHELD);
	});

	it("presents a runtime-written string field as unavailable, and counts it withheld, when it looks sensitive", () => {
		for (const text of SENSITIVE) {
			const entries = timeline([
				event("lifecycle.anomaly", { observed: text, problem: "a plain problem" }),
				event("harness.protocol-fault", { fault: text }),
				event("tool.started", { toolName: text, toolCallId: "call-1", runtimeEvent: "tool_execution_start" }),
				event("lifecycle.run-completed", { turns: 1, stopReason: { status: "reported", value: text } }),
				event("lifecycle.turn-completed", { turn: 1, stopReason: { status: "UNAVAILABLE", reason: text } }),
				event("lifecycle.session-started", {
					runtime: "pi",
					runtimeSessionId: "s1",
					instance: "i1",
					unavailable: [
						{ field: "runId", reason: text },
						{ field: text, reason: "a plain reason" },
					],
				}),
			]).entries;
			expect(entries[0]!.fields.observed, text).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(entries[0]!.fields.problem, text).toEqual({ basis: "derived", value: "a plain problem" });
			expect(entries[0]!.withheldFields, text).toBe(1);
			expect(entries[1]!.fields.fault, text).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(entries[2]!.fields.toolName, text).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(entries[2]!.fields.toolCallId, text).toEqual({ basis: "reported", value: "call-1" });
			expect(entries[3]!.fields.stopReason, text).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(entries[4]!.fields.stopReason, text).toEqual({ basis: "unavailable", reason: WITHHELD });
			// A replaced value is a withheld key, whichever way it was recorded.
			expect(entries[2]!.withheldFields, text).toBe(1);
			expect(entries[3]!.withheldFields, text).toBe(1);
			expect(entries[4]!.withheldFields, text).toBe(1);
			// Results are plain data: two withheld fields never share an object.
			expect(entries[0]!.fields.observed).not.toBe(entries[1]!.fields.fault);
			expect(entries[5]!.fields["unavailable.runId"], text).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(
				Object.keys(entries[5]!.fields).some((key) => key.includes(CANARY)),
				text,
			).toBe(false);
			expect(JSON.stringify(entries), text).not.toContain(CANARY);
		}
	});
});

describe("second review round (PR #57)", () => {
	const WITHHELD = "withheld: looks like a path, address or credential";
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	function good() {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		const capabilities = projectEndoCockpitCapabilityStateV0(input(records));
		const log = timeline([event("tool.started", { toolName: "read" })]);
		return {
			records,
			identity,
			capabilities,
			log,
			snapshot: {
				schemaVersion: "endo.cockpit-snapshot.v0",
				projectionVersion: "cockpit-snapshot.1",
				consistency: "independent-sources",
				timeline: log,
				runtimes: [{ identity, capabilities }],
			},
		};
	}

	it("P1: an opaque producer is withheld unless it has the shape Endophasia's producers use", () => {
		const hostile = [
			`/home/${CANARY}/tool`,
			`https://u:${CANARY}@example.test`,
			`ghp_${"A".repeat(30)}`,
			`token-${CANARY}`,
			`my producer ${CANARY}`,
			"p".repeat(600),
			"UPPER:case",
		];
		for (const producer of hostile) {
			const entry = timeline([event("tool.started", {}, { producer })]).entries[0]!;
			expect(entry.producer, producer).toBe(WITHHELD);
			expect(JSON.stringify(entry), producer).not.toContain(CANARY);
		}
		for (const producer of [
			"pi-rpc-adapter:pi.default",
			"pi-lifecycle:pi.default",
			"test-producer",
			"capture:record",
		]) {
			expect(timeline([event("tool.started", {}, { producer })]).entries[0]!.producer).toBe(producer);
		}
		expect(
			validateEndoCockpitSessionTimelineV0(timeline([event("tool.started", {}, { producer: "/x/y" })])),
		).not.toBeNull();
	});

	it("P1: a runtime session reference is presented only in an admitted shape; others are withheld and counted", () => {
		const hostileRefs = [
			`/home/${CANARY}/session`,
			`ghp_${"A".repeat(30)}${CANARY}`,
			`sess_${CANARY}`,
			"C:\\x\\y",
			"plain-word",
		];
		for (const ref of hostileRefs) {
			for (const key of ["piSessionId", "acpSessionId"]) {
				const entry = timeline([event("harness.attached", { instance: "i1", [key]: ref })]).entries[0]!;
				expect(entry.fields.runtimeSessionId, `${key} ${ref}`).toEqual({ basis: "unavailable", reason: WITHHELD });
				expect(entry.withheldFields, `${key} ${ref}`).toBe(1);
				expect(JSON.stringify(entry), ref).not.toContain(CANARY);
			}
		}
		const admitted = [
			"0b1f6c1e-3c2a-4e0b-9d1c-5b9c7a2f4e10",
			`sha256-${"a".repeat(48)}`,
			"endo-pi-default-a33c9b2338da",
		];
		for (const ref of admitted) {
			const entry = timeline([event("harness.attached", { acpSessionId: ref })]).entries[0]!;
			expect(entry.fields.runtimeSessionId).toEqual({ basis: "reported", value: ref });
		}
	});

	it("P2: identity and capabilities of one runtime view must share one source condition and watermark", () => {
		const { snapshot, records } = good();
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		const stale = projectEndoCockpitCapabilityStateV0(input({ ...records, notification: [] }));
		const spliced = mutated(snapshot, (c) => {
			c.runtimes[0].capabilities = stale;
		});
		expect(stale.source.attachment).toBe(snapshot.runtimes[0]!.identity.source.attachment);
		expect(validateEndoCockpitSnapshotV0(spliced)).toBeNull();
		const otherCondition = mutated(snapshot, (c) => {
			c.runtimes[0].capabilities.source.condition = {
				state: "degraded",
				tornTail: { bytes: 1, sha256: "a".repeat(64) },
				sealedAt: null,
				error: null,
			};
		});
		expect(validateEndoCockpitSnapshotV0(otherCondition)).toBeNull();
	});

	it("P2: session summaries must be exactly what the presented entries give", () => {
		const events = [
			event("tool.started", {}, { session: "endo.session.test.a" }),
			event("tool.finished", {}, { session: "endo.session.test.b" }),
			event("tool.started", {}, { session: "endo.session.test.a" }),
			event("tool.started", {}, { session: null }),
		];
		const log = timeline(events);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		const edits: [string, (copy: any) => void][] = [
			[
				"nonexistent session",
				(c) =>
					c.sessions.push({
						sessionId: "endo.session.test.ghost",
						firstStorageSequence: 1,
						lastStorageSequence: 1,
						entries: 1,
					}),
			],
			["duplicate session", (c) => c.sessions.push(structuredClone(c.sessions[0]))],
			[
				"wrong count",
				(c) => {
					c.sessions[0].entries = 5;
				},
			],
			[
				"wrong range",
				(c) => {
					c.sessions[0].lastStorageSequence = 2;
				},
			],
			["wrong order", (c) => c.sessions.reverse()],
			["missing session", (c) => c.sessions.pop()],
			[
				"summaries with no entries",
				(c) => {
					c.entries = [];
				},
			],
		];
		for (const [name, edit] of edits)
			expect(validateEndoCockpitSessionTimelineV0(mutated(log, edit)), name).toBeNull();
	});

	it("P2: evidence from a cheaper check kind than the capability requires is limited, not re-admitted or rewritten", () => {
		const records = specimenRecords();
		const state = structuredClone(records.state[0]!);
		const target = state.capabilities.find((c) => c.requires === "live-study" && c.status !== "unverified")!;
		const evidence = structuredClone(records.evidence);
		const cited = evidence.find((item) => item.id === target.evidenceId)!;
		cited.check.kind = "static-surface";
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence, state: [state] }));
		const view = result.capabilities.find((c) => c.capability === target.capability)!;
		expect(view.limits.map((l) => l.code)).toEqual(["evidence-check-insufficient"]);
		expect(view.limits[0]!.refs).toEqual([view.ref, view.evidence!.ref]);
		expect(view.status).toBe(target.status);
		expect(validateEndoCockpitCapabilityStateV0(result)).not.toBeNull();
		// The recorded specimen cites live-study evidence for cheaper requirements: that is legitimate and raises nothing.
		for (const item of projectEndoCockpitCapabilityStateV0(input(records)).capabilities)
			expect(item.limits).toEqual([]);
	});

	it("P2: withheldFields counts a fully presented usage object as presented and a partial one as withheld", () => {
		const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costTotal: 0.1, reasoning: 0 };
		const whole = timeline([event("message.completed", { runtimeEvent: "message_end", role: "assistant", usage })])
			.entries[0]!;
		expect(whole.usage).toMatchObject({ basis: "reported" });
		expect(whole.withheldFields).toBe(0);
		const partial = timeline([
			event("message.completed", { role: "assistant", usage: { ...usage, cost: { input: 1 } } }),
		]).entries[0]!;
		expect(partial.usage).toMatchObject({ basis: "reported" });
		expect(partial.withheldFields).toBe(1);
		const malformed = timeline([event("message.completed", { role: "assistant", usage: { input: 1 } })]).entries[0]!;
		expect(malformed.usage).toMatchObject({ basis: "unavailable" });
		expect(malformed.withheldFields).toBe(1);
	});

	it("P2: a zero-length watermark must agree with the source condition", () => {
		const clean = (state: string) => ({ state, tornTail: null, sealedAt: null, error: null });
		const log = (state: string, length = 0) =>
			timeline([]) && {
				...timeline([]),
				source: {
					domain: "event-log",
					condition: clean(state),
					watermark: { length, lastEventId: null, prefixDigest: null },
				},
			};
		for (const state of ["empty", "absent"])
			expect(validateEndoCockpitSessionTimelineV0(log(state)), state).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(log("readable"))).toBeNull();
		const degraded = mutated(log("empty"), (c) => {
			c.source.condition = {
				state: "degraded",
				tornTail: { bytes: 4, sha256: "b".repeat(64) },
				sealedAt: null,
				error: null,
			};
		});
		expect(validateEndoCockpitSessionTimelineV0(degraded)).not.toBeNull();

		const { identity, capabilities } = good();
		const emptyRegistry = projectEndoCockpitRuntimeIdentityV0(
			input({ fingerprint: [], change: [], evidence: [], state: [], notification: [] }),
		);
		expect(emptyRegistry.source.condition.state).toBe("empty");
		expect(validateEndoCockpitRuntimeIdentityV0(emptyRegistry)).not.toBeNull();
		const readableEmpty = mutated(emptyRegistry, (c) => {
			c.source.condition.state = "readable";
		});
		expect(validateEndoCockpitRuntimeIdentityV0(readableEmpty)).toBeNull();
		const emptyWithRecords = mutated(identity, (c) => {
			c.source.condition.state = "empty";
		});
		expect(validateEndoCockpitRuntimeIdentityV0(emptyWithRecords)).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
	});
});

describe("third review round and invariant audit (PR #57)", () => {
	const WITHHELD = "withheld: looks like a path, address or credential";
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	const SENSITIVE = [
		`/home/${CANARY}/pkg`,
		`https://u:${CANARY}@example.test/p`,
		`token=${CANARY}-abcdef`,
		`C:\\Users\\${CANARY}`,
	];
	const pageIds = (n: number) =>
		Array.from({ length: n }, (_, i) => event("tool.started", {}, { id: `endo.event.third.${i + 1}` }));
	function page(length: number, afterSequence: number, take: number) {
		const all = pageIds(length);
		return projectEndoCockpitSessionTimelineV0({
			source: {
				domain: "event-log",
				condition: { state: "readable", tornTail: null, sealedAt: null, error: null },
				watermark: { length, lastEventId: all.at(-1)?.id ?? null, prefixDigest: sha256HexV0(`prefix-${length}`) },
			},
			afterSequence,
			events: stored(all.slice(afterSequence, afterSequence + take), afterSequence + 1),
		});
	}
	function good() {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		return {
			records,
			identity: projectEndoCockpitRuntimeIdentityV0(input(records)),
			capabilities: projectEndoCockpitCapabilityStateV0(input(records)),
		};
	}

	it("P1: fingerprint package, reported version, change observations and evidence labels are withheld when they look sensitive", () => {
		for (const text of SENSITIVE) {
			const records = specimenRecords();
			const fingerprint = structuredClone(records.fingerprint[0]!);
			fingerprint.local.package = { ...fingerprint.local.package!, name: text };
			const second = structuredClone(fingerprint);
			second.id = "endo.evidence.test-fingerprint.2";
			second.reported.version = text;
			second.local.package = { ...second.local.package!, name: "plain", version: text };
			second.identity.digest = "d".repeat(64);
			const change = changeRecord({
				kind: "changed",
				previous: { ...changeRecord().current!, version: text },
				current: { ...changeRecord().current!, version: text, identityDigest: "d".repeat(64) },
				differences: ["version"],
			});
			const identity = projectEndoCockpitRuntimeIdentityV0(
				input({ ...records, fingerprint: [fingerprint, second], change: [change] }),
			);
			expect(identity.previousDifferent!.package, text).toMatchObject({ basis: "unavailable", reason: WITHHELD });
			expect(identity.current!.package, text).toMatchObject({ basis: "unavailable", reason: WITHHELD });
			expect(identity.current!.version, text).toMatchObject({ basis: "unavailable", reason: WITHHELD });
			expect(identity.lastChange!.previous!.version, text).toBe(WITHHELD);
			expect(identity.lastChange!.current!.version, text).toBe(WITHHELD);

			const evidence = structuredClone(records.evidence);
			const item = evidence.find(
				(candidate) =>
					candidate.id === records.state[0]!.capabilities.find((c) => c.evidenceId !== null)!.evidenceId,
			)!;
			item.check.name = text;
			item.check.version = text;
			item.dependencies.adapterVersion = text;
			item.dependencies.mappingVersion = text;
			item.dependencies.suiteVersion = text;
			item.dependencies.extension = { id: text, version: text };
			const capabilities = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence }));
			const view = capabilities.capabilities.find((c) => c.evidence?.id === item.id)!.evidence!;
			expect(
				[
					view.check.name,
					view.check.version,
					view.dependencies.adapterVersion,
					view.dependencies.mappingVersion,
					view.dependencies.suiteVersion,
					view.dependencies.extension!.id,
					view.dependencies.extension!.version,
				],
				text,
			).toEqual(Array(7).fill(WITHHELD));
			expect(JSON.stringify([identity, capabilities]), text).not.toContain(CANARY);
			expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
			expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		}
		// A plain scoped package name and a semver are kept.
		const records = specimenRecords();
		const plain = projectEndoCockpitRuntimeIdentityV0(input(records));
		expect(plain.current!.package).toMatchObject({ basis: "observed" });
		expect(plain.current!.version).toMatchObject({ basis: "reported" });
		const scoped = structuredClone(records.fingerprint[0]!);
		scoped.local.package = {
			...scoped.local.package!,
			name: "@scope/pi-coding-agent",
			version: "1.0.0-rc.1+build.5",
		};
		expect(
			projectEndoCockpitRuntimeIdentityV0(input({ ...records, fingerprint: [scoped] })).current!.package,
		).toMatchObject({ basis: "observed", value: { name: "@scope/pi-coding-agent" } });
	});

	it("P2: a timeline window has no silent gap", () => {
		const log = page(6, 0, 4);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		const gap = mutated(log, (c) => {
			c.entries.splice(1, 1);
		});
		expect(gap.entries.map((e) => e.storageSequence)).toEqual([1, 3, 4]);
		expect(validateEndoCockpitSessionTimelineV0(gap)).toBeNull();
		const short = mutated(log, (c) => {
			c.window.nextAfterSequence = 3;
		});
		expect(validateEndoCockpitSessionTimelineV0(short)).toBeNull();
		const extra = mutated(log, (c) => {
			c.window.nextAfterSequence = 5;
		});
		expect(validateEndoCockpitSessionTimelineV0(extra)).toBeNull();
		// An ignored duplicate fills exactly one position; claiming one where none was read still leaves a gap.
		const withDuplicate = projectEndoCockpitSessionTimelineV0({
			source: log.source,
			afterSequence: 0,
			events: stored([pageIds(6)[0]!, event("tool.started", {}, { id: "endo.event.third.1" }), pageIds(6)[2]!]),
		});
		expect(withDuplicate.duplicatesIgnored).toBe(1);
		expect(validateEndoCockpitSessionTimelineV0(withDuplicate)).not.toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(withDuplicate, (c) => {
					c.duplicatesIgnored = 0;
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(withDuplicate, (c) => {
					c.duplicatesIgnored = 2;
				}),
			),
		).toBeNull();
	});

	it("P2: snapshot runtime views are in code-unit attachment order", () => {
		const records = specimenRecords();
		const view = (attachment: string) => {
			const named = {
				fingerprint: records.fingerprint.map((r) => ({ ...r, attachment })),
				change: [],
				evidence: records.evidence.map((r) => ({ ...r, attachment })),
				state: records.state.map((r) => ({ ...r, attachment })),
				notification: [],
			};
			const source = { ...registrySource(named), attachment };
			return {
				identity: projectEndoCockpitRuntimeIdentityV0({ source, records: named }),
				capabilities: projectEndoCockpitCapabilityStateV0({ source, records: named }),
			};
		};
		const log = timeline([event("tool.started")]);
		const snapshot = (runtimes: unknown[]) => ({
			schemaVersion: "endo.cockpit-snapshot.v0",
			projectionVersion: "cockpit-snapshot.1",
			consistency: "independent-sources",
			timeline: log,
			runtimes,
		});
		expect(validateEndoCockpitSnapshotV0(snapshot([view("acp.default"), view("pi.default")]))).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshot([view("pi.default"), view("acp.default")]))).toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshot([view("pi.default"), view("pi.default")]))).toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshot([]))).not.toBeNull();
	});

	it("P2: only a reported field may arrive in a reported wrapper; observed and derived fields keep their basis", () => {
		const wrapped = (value: unknown) => ({ status: "reported", value });
		const cases: [string, Record<string, unknown>, string][] = [
			["lifecycle.turn-started", { turn: wrapped(3) }, "turn"],
			["lifecycle.run-started", { instance: wrapped("i1") }, "instance"],
			["harness.attached", { fingerprintId: wrapped("endo.evidence.x.1") }, "fingerprintId"],
			["lifecycle.stop-requested", { runOpen: wrapped(true) }, "runOpen"],
			["lifecycle.run-unclassified", { turns: 1, reason: { status: "UNAVAILABLE", reason: "x" } }, "reason"],
		];
		for (const [kind, payload, key] of cases) {
			const entry = timeline([event(kind, payload)]).entries[0]!;
			expect(entry.fields, kind).not.toHaveProperty(key);
			expect(entry.withheldFields, kind).toBeGreaterThanOrEqual(1);
		}
		// A reported field in the wrapper, and the wrapper's own UNAVAILABLE form, are still read as reported / unavailable.
		const ok = timeline([
			event("lifecycle.turn-completed", { turn: 1, stopReason: wrapped("stop") }),
			event("lifecycle.turn-completed", {
				turn: 2,
				stopReason: { status: "UNAVAILABLE", reason: "the runtime did not say" },
			}),
		]).entries;
		expect(ok[0]!.fields.stopReason).toEqual({ basis: "reported", value: "stop" });
		expect(ok[0]!.fields.turn).toEqual({ basis: "derived", value: 1 });
		expect(ok[1]!.fields.stopReason).toEqual({ basis: "unavailable", reason: "the runtime did not say" });
	});

	it("P2: an entry's category and flags follow from its kind and the vocabulary", () => {
		const log = timeline([event("tool.started"), event("lifecycle.interrupted", {})]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		for (const category of ["lifecycle", "other", "agent"]) {
			expect(
				validateEndoCockpitSessionTimelineV0(
					mutated(log, (c) => {
						c.entries[0].category = category;
					}),
				),
				category,
			).toBeNull();
		}
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[0].kind = "vendor.thing";
				}),
			),
		).toBeNull();
		const flagged = timeline([event("lifecycle.interrupted", {}), event("vendor.thing")]);
		expect(flagged.entries[1]!.category).toBe("other");
		expect(validateEndoCockpitSessionTimelineV0(flagged)).not.toBeNull();
		const both = mutated(log, (c) => {
			c.entries[1].flags = ["anomaly", "interruption"];
		});
		expect(validateEndoCockpitSessionTimelineV0(both)).toBeNull();
		const twice = mutated(log, (c) => {
			c.entries[1].flags = ["interruption", "interruption"];
		});
		expect(validateEndoCockpitSessionTimelineV0(twice)).toBeNull();
	});

	it("P2: a window that ends at the end of the log ends at the watermark's last event", () => {
		const end = page(5, 3, 2);
		expect(validateEndoCockpitSessionTimelineV0(end)).not.toBeNull();
		const swapped = mutated(end, (c) => {
			c.entries[1].eventId = "endo.event.third.99";
		});
		expect(validateEndoCockpitSessionTimelineV0(swapped)).toBeNull();
		const lastNamed = mutated(end, (c) => {
			c.source.watermark.lastEventId = "endo.event.third.99";
		});
		expect(validateEndoCockpitSessionTimelineV0(lastNamed)).toBeNull();
		// A page that stops short is not bound to it; an empty page past the end has nothing to bind.
		expect(validateEndoCockpitSessionTimelineV0(page(5, 0, 2))).not.toBeNull();
		expect(validateEndoCockpitSessionTimelineV0(page(5, 9, 2))).not.toBeNull();
		// A trailing ignored duplicate: the last position repeats an earlier id of the window, which must be the last event.
		const dup = projectEndoCockpitSessionTimelineV0({
			source: {
				...end.source,
				watermark: { ...end.source.watermark!, length: 2, lastEventId: "endo.event.third.1" },
			},
			afterSequence: 0,
			events: stored([pageIds(5)[0]!, event("tool.started", {}, { id: "endo.event.third.1" })]),
		});
		expect(dup.duplicatesIgnored).toBe(1);
		expect(validateEndoCockpitSessionTimelineV0(dup)).not.toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(dup, (c) => {
					c.source.watermark.lastEventId = "endo.event.third.2";
				}),
			),
		).toBeNull();
	});

	it("audit: adjacent cross-field invariants of the identity, capability and timeline records", () => {
		const { identity, capabilities, records } = good();
		const identityEdits: [string, (copy: any) => void][] = [
			[
				"a last id of a kind that has ids is missing",
				(c) => {
					c.source.watermark.lastIds.fingerprint = null;
				},
			],
			[
				"a capability state has a last id",
				(c) => {
					c.source.watermark.lastIds.state = "endo.evidence.test-x.1";
				},
			],
			[
				"a change that says unchanged differs in identity",
				(c) => {
					c.lastChange.kind = "unchanged";
					c.lastChange.previous = c.lastChange.current;
					c.lastChange.current = { ...c.lastChange.current, identityDigest: "e".repeat(64) };
				},
			],
			[
				"a first observation with a previous side",
				(c) => {
					c.lastChange.previous = c.lastChange.current;
				},
			],
			[
				"a collection failure that is not withheld",
				(c) => {
					c.lastChange.kind = "collection-failed";
					c.lastChange.current = null;
				},
			],
			[
				"a failure text on a change that did not fail",
				(c) => {
					c.lastChange.failure = "withheld";
				},
			],
			[
				"a changed identity with no difference",
				(c) => {
					c.lastChange.kind = "changed";
					c.lastChange.previous = { ...c.lastChange.current };
				},
			],
			[
				"repeated differences",
				(c) => {
					c.lastChange.differences = ["version", "version"];
				},
			],
			[
				"a previous different identity equal to the current one",
				(c) => {
					c.previousDifferent = structuredClone(c.current);
					c.previousDifferent.ref = { ...c.current.ref, index: 0 };
				},
			],
			[
				"a previous different identity with no current one",
				(c) => {
					c.previousDifferent = structuredClone(c.current);
					c.current = null;
				},
			],
			[
				"a not-projectable source that carries a view",
				(c) => {
					c.source.condition.state = "absent";
					c.source.watermark.counts = { fingerprint: 0, change: 0, evidence: 0, state: 0, notification: 0 };
					c.source.watermark.lastIds = {
						fingerprint: null,
						change: null,
						evidence: null,
						state: null,
						notification: null,
					};
				},
			],
			[
				"a projectable source noted as not projectable",
				(c) => {
					c.notes.push({ code: "source-not-projectable", refs: [] });
				},
			],
		];
		for (const [name, edit] of identityEdits)
			expect(validateEndoCockpitRuntimeIdentityV0(mutated(identity, edit)), name).toBeNull();

		const capabilityEdits: [string, (copy: any) => void][] = [
			[
				"an unverified capability that cites evidence",
				(c) => {
					const v = c.capabilities.find((x: any) => x.status === "unverified") ?? c.capabilities[0];
					v.status = "unverified";
				},
			],
			[
				"a not-projectable source that carries a state",
				(c) => {
					c.source.condition.state = "unopenable";
					c.source.condition.error = { kind: "invalid-store", message: "x" };
					c.source.watermark = null;
				},
			],
		];
		for (const [name, edit] of capabilityEdits)
			expect(validateEndoCockpitCapabilityStateV0(mutated(capabilities, edit)), name).toBeNull();

		const log = timeline([event("tool.started")]);
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.notes.push({ code: "source-not-projectable", refs: [] });
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.source.condition = {
						state: "unopenable",
						tornTail: null,
						sealedAt: null,
						error: { kind: "invalid-store", message: "the store could not be opened" },
					};
					c.source.watermark = null;
					c.entries = [];
				}),
			),
		).toBeNull();

		// The unmodified outputs, and a real absent registry, still validate.
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(projectEndoCockpitRuntimeIdentityV0(input(null)))).not.toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(projectEndoCockpitCapabilityStateV0(input(null)))).not.toBeNull();
		void records;
	});
});

describe("one presentation policy for projection and validator (PR #57 review round 3)", () => {
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	const rejects = (log: unknown) => expect(validateEndoCockpitSessionTimelineV0(log)).toBeNull();
	const UUID = "0b1f6c1e-3c2a-4e0b-9d1c-5b9c7a2f4e10";

	it("closes the drift class: every allowlisted field of every kind, produced from the policy, validates", () => {
		for (const [kind, specs] of Object.entries(ENDO_COCKPIT_FIELD_SPECS_V0)) {
			const payload: Record<string, any> = {};
			for (const [, path, , type] of specs) {
				const value =
					type === "string" ? "a-value" : type === "id" ? "endo.evidence.a-value" : type === "number" ? 3 : true;
				const segments = path.split(".");
				let at = payload;
				for (const segment of segments.slice(0, -1)) at = at[segment] ??= {};
				at[segments.at(-1)!] = value;
			}
			const entry = timeline([event(kind, payload)]);
			const keys = specs.map((spec) => spec[0]);
			expect(Object.keys(entry.entries[0]!.fields).sort(), kind).toEqual([...new Set(keys)].sort());
			expect(validateEndoCockpitSessionTimelineV0(entry), kind).not.toBeNull();
			// The same payload with every value of the wrong type presents nothing, and still validates.
			const wrong: Record<string, any> = {};
			for (const [, path] of specs) {
				const segments = path.split(".");
				let at = wrong;
				for (const segment of segments.slice(0, -1)) at = at[segment] ??= {};
				at[segments.at(-1)!] = [1, 2];
			}
			const bad = timeline([event(kind, wrong)]);
			expect(bad.entries[0]!.fields, kind).toEqual({});
			expect(validateEndoCockpitSessionTimelineV0(bad), kind).not.toBeNull();
		}
	});

	it("rejects a field the policy does not present for the entry's kind", () => {
		const log = timeline([
			event("lifecycle.run-started", { instance: "i1" }),
			event("tool.started", { toolName: "read" }),
			event("vendor.thing", {}),
		]);
		const secret = { basis: "reported", value: "ordinary-looking" };
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.apiKey = secret;
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.toolName = secret;
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[1].fields.instance = { basis: "observed", value: "i1" };
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[2].fields.anything = secret;
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[1].fields.runtimeSessionId = { basis: "reported", value: UUID };
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[1].fields["unavailable.runId"] = { basis: "unavailable", reason: "x" };
			}),
		);
	});

	it("rejects a field relabelled with another basis or carrying a value of another type", () => {
		const log = timeline([
			event("lifecycle.turn-started", { turn: 2 }),
			event("lifecycle.run-started", { instance: "i1" }),
			event("tool.started", { toolName: "read", toolCallId: "c1" }),
			event("harness.process-exited", { code: null, signal: "SIGKILL", spawnFailed: false, expected: false }),
		]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.turn.basis = "observed";
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.turn.basis = "reported";
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[1].fields.instance.basis = "reported";
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[2].fields.toolName.basis = "derived";
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.turn.value = "2";
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[0].fields.turn.value = null;
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[2].fields.toolName.value = 7;
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[3].fields.spawnFailed.value = "no";
			}),
		);
		// A nullable field may be null, and an unavailable form is allowed for any presented field.
		expect(log.entries[3]!.fields.code).toEqual({ basis: "observed", value: null });
		const gap = mutated(log, (c) => {
			c.entries[0].fields.turn = { basis: "unavailable", reason: "not reported" };
		});
		expect(validateEndoCockpitSessionTimelineV0(gap)).not.toBeNull();
	});

	it("admits a runtime session reference and a producer only in the policy's shapes", () => {
		const log = timeline([event("harness.attached", { acpSessionId: UUID })]);
		expect(log.entries[0]!.fields.runtimeSessionId).toEqual({ basis: "reported", value: UUID });
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		for (const value of ["/home/x/secret", `ghp_${"A".repeat(30)}`, "plain"]) {
			rejects(
				mutated(log, (c) => {
					c.entries[0].fields.runtimeSessionId.value = value;
				}),
			);
		}
		for (const producer of ["/home/x", "has space", "UPPER", "p".repeat(300)]) {
			rejects(
				mutated(log, (c) => {
					c.entries[0].producer = producer;
				}),
			);
		}
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[0].producer = "withheld: looks like a path, address or credential";
				}),
			),
		).not.toBeNull();
	});

	it("rejects flags that do not follow from the kind, and usage on a kind that cannot carry it", () => {
		const log = timeline([
			event("tool.started", {}),
			event("lifecycle.interrupted", {}),
			event("vendor.thing", {}),
			event("lifecycle.anomaly", { observed: "x", problem: "y" }),
			event("harness.store-opened", {
				lifecycleRepaired: 0,
				recovery: { truncated: false, recovered: false, sealed: false },
			}),
			event("message.completed", { role: "assistant" }),
		]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		rejects(
			mutated(log, (c) => {
				c.entries[0].flags = ["anomaly"];
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[1].flags = [];
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[2].flags = [];
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[3].flags = ["interruption", "anomaly"];
			}),
		);
		rejects(
			mutated(log, (c) => {
				c.entries[0].usage = { basis: "unavailable", reason: "x" };
			}),
		);
		// A payload-decided flag may be set or not on a store reopened; a message may carry usage.
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[4].flags = ["discontinuity"];
				}),
			),
		).not.toBeNull();
		expect(log.entries[5]!.usage).not.toBeNull();
		rejects(
			mutated(log, (c) => {
				c.entries[1].flags = ["interruption", "discontinuity"];
			}),
		);
	});

	it("requires a conflicting runtime session pair to be flagged, and only then", () => {
		const log = timeline([
			event("harness.attached", { piSessionId: UUID, acpSessionId: `sha256-${"a".repeat(48)}` }),
		]);
		expect(log.entries[0]!.flags).toEqual(["anomaly"]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		rejects(
			mutated(log, (c) => {
				c.entries[0].flags = [];
			}),
		);
	});

	it("requires each fingerprint claim to cite exactly its own fingerprint", () => {
		const records = specimenRecords();
		const second = {
			...structuredClone(records.fingerprint[0]!),
			id: "endo.evidence.test-fingerprint.2",
			observedAt: "2026-10-04T10:00:00Z",
		};
		second.identity.digest = "d".repeat(64);
		const identity = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, fingerprint: [records.fingerprint[0]!, second] }),
		);
		expect(identity.previousDifferent).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		for (const view of ["current", "previousDifferent"] as const) {
			for (const claim of ["identity", "version", "entrypoint", "package"]) {
				const other = view === "current" ? "previousDifferent" : "current";
				const edits: [string, (c: any) => void][] = [
					[
						"emptied",
						(c) => {
							c[view][claim].refs = [];
						},
					],
					[
						"doubled",
						(c) => {
							c[view][claim].refs.push(structuredClone(c[view][claim].refs[0]));
						},
					],
					[
						"another fingerprint's",
						(c) => {
							c[view][claim].refs = [structuredClone(c[other].ref)];
						},
					],
					[
						"plus another",
						(c) => {
							c[view][claim].refs.push(structuredClone(c[other].ref));
						},
					],
				];
				for (const [name, edit] of edits)
					expect(
						validateEndoCockpitRuntimeIdentityV0(mutated(identity, edit)),
						`${view}.${claim} ${name}`,
					).toBeNull();
			}
		}
	});
});

describe("fourth review round (PR #57)", () => {
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	const FLAGGED_TEXT = [
		"ghp_CANARYSECRETCANARYSECRET",
		"/home/CANARYSECRET/x",
		"token=CANARYSECRETabcd",
		"gh​p_CANARYSECRETCANARYSECRET",
	];

	it("P1: a forged timeline field value that the projection would withhold is rejected, as is an over-long one", () => {
		const log = timeline([event("tool.started", { toolName: "read", toolCallId: "c1" })]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		for (const text of [...FLAGGED_TEXT, "x".repeat(257), "", "line\nbreak"]) {
			expect(
				validateEndoCockpitSessionTimelineV0(
					mutated(log, (c) => {
						c.entries[0].fields.toolName.value = text;
					}),
				),
				text,
			).toBeNull();
			expect(
				readEndoCockpitRecordV0(
					mutated(log, (c) => {
						c.entries[0].fields.toolName.value = text;
					}),
				).ok,
				text,
			).toBe(false);
		}
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[0].fields.toolName.value = "x".repeat(256);
				}),
			),
		).not.toBeNull();
		// An unavailable reason is judged the same way, and a declared gap's name is admitted by shape.
		const gap = timeline([
			event("lifecycle.session-started", {
				runtime: "pi",
				runtimeSessionId: "s",
				instance: "i",
				unavailable: [{ field: "runId", reason: "not reported" }],
			}),
		]);
		expect(validateEndoCockpitSessionTimelineV0(gap)).not.toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(gap, (c) => {
					c.entries[0].fields["unavailable.runId"].reason = FLAGGED_TEXT[0];
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(gap, (c) => {
					c.entries[0].fields[`unavailable.${FLAGGED_TEXT[0]}`] = c.entries[0].fields["unavailable.runId"];
				}),
			),
		).toBeNull();
	});

	it("P1: redaction is judged on the whole value before any bound: a secret past the old cut is still withheld", () => {
		const long = `${"x".repeat(240)} ghp_CANARYSECRETCANARYSECRET`;
		const entry = timeline([event("harness.protocol-fault", { fault: long })]).entries[0]!;
		expect(entry.fields.fault).toEqual({
			basis: "unavailable",
			reason: "withheld: looks like a path, address or credential",
		});
		const split = timeline([event("harness.protocol-fault", { fault: "ｇｈｐ＿CANARYSECRETCANARYSECRET" })])
			.entries[0]!;
		expect(JSON.stringify(split)).not.toContain("CANARYSECRET");
	});

	it("P2: a limit that contradicts the capability view is rejected, and so is one missing its derivable precondition", () => {
		const records = specimenRecords();
		const result = projectEndoCockpitCapabilityStateV0(input(records));
		const view = result.capabilities.find((c) => c.status !== "unverified" && c.evidence !== null)!;
		expect(view.limits).toEqual([]);
		const at = result.capabilities.indexOf(view);
		const withLimit = (code: string, refs?: unknown[]) =>
			mutated(result, (c) => {
				c.capabilities[at].limits.push({ code, refs: refs ?? [c.capabilities[at].ref] });
			});
		// "evidence-record-missing" while the evidence is presented.
		expect(validateEndoCockpitCapabilityStateV0(withLimit("evidence-record-missing"))).toBeNull();
		// Fabricated currency and classification contradictions.
		expect(validateEndoCockpitCapabilityStateV0(withLimit("state-not-for-latest-fingerprint"))).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				withLimit("evidence-classification-differs", [view.ref, view.evidence!.ref]),
			),
		).toBeNull();
		expect(validateEndoCockpitCapabilityStateV0(withLimit("status-classification-mismatch"))).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(withLimit("evidence-check-insufficient", [view.ref, view.evidence!.ref])),
		).toBeNull();
		// A limit whose references are not the exact set for its code, or that repeats, or that is out of order.
		expect(validateEndoCockpitCapabilityStateV0(withLimit("evidence-capability-differs"))).toBeNull();
		const right = withLimit("evidence-capability-differs", [view.ref, view.evidence!.ref]);
		expect(validateEndoCockpitCapabilityStateV0(right)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(right, (c) => {
					c.capabilities[at].limits.push(structuredClone(c.capabilities[at].limits[0]));
				}),
			),
		).toBeNull();
		// A limit that is derivable is required: stale currency without its limit is rejected.
		const first = records.fingerprint[0]!;
		const newer = {
			...first,
			id: "endo.evidence.test-fingerprint.2",
			identity: { ...first.identity, digest: "c".repeat(64) },
		};
		const stale = projectEndoCockpitCapabilityStateV0(input({ ...records, fingerprint: [first, newer] }));
		expect(validateEndoCockpitCapabilityStateV0(stale)).not.toBeNull();
		const removed = mutated(stale, (c) => {
			for (const v of c.capabilities)
				v.limits = v.limits.filter((l: any) => l.code !== "state-not-for-latest-fingerprint");
		});
		expect(validateEndoCockpitCapabilityStateV0(removed)).toBeNull();
		// Statuses are what the registry recorded, in every case.
		expect(stale.capabilities.map((c) => c.status)).toEqual(records.state[0]!.capabilities.map((c) => c.status));
	});

	it("P2: evidence whose confidence differs from the fingerprint it names is limited, even on the same fingerprint id", () => {
		const records = specimenRecords();
		const fingerprint = structuredClone(records.fingerprint[0]!);
		fingerprint.identity = { ...fingerprint.identity, confidence: "reduced" };
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, fingerprint: [fingerprint] }));
		const admitted = result.capabilities.filter((c) => c.status !== "unverified" && c.evidence !== null);
		expect(admitted.length).toBeGreaterThan(0);
		for (const view of admitted) {
			const limit = view.limits.find((l) => l.code === "evidence-confidence-differs");
			expect(limit, view.capability).toBeDefined();
			expect(limit!.refs.map((r) => (r.domain === "harness-registry" ? r.kind : r.domain))).toEqual([
				"state",
				"evidence",
				"fingerprint",
			]);
			// The same fingerprint id is not a carry-forward, so the carry-forward limit is not raised.
			expect(view.limits.map((l) => l.code)).not.toContain("evidence-reduced-identity");
		}
		expect(result.capabilities.map((c) => c.status)).toEqual(records.state[0]!.capabilities.map((c) => c.status));
		expect(validateEndoCockpitCapabilityStateV0(result)).not.toBeNull();
		// Legitimate carry-forward at one confidence still raises nothing.
		const second = { ...records.fingerprint[0]!, id: "endo.evidence.test-fingerprint.2" };
		const state = { ...structuredClone(records.state[0]!), fingerprintId: second.id, at: "2026-10-04T10:00:01.000Z" };
		const carried = projectEndoCockpitCapabilityStateV0(
			input({ ...records, fingerprint: [records.fingerprint[0]!, second], state: [records.state[0]!, state] }),
		);
		for (const view of carried.capabilities) expect(view.limits).toEqual([]);
	});

	it("P2: the basis of every identity claim is fixed by what the claim is", () => {
		const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		for (const [claim, basis] of [
			["identity", "derived"],
			["version", "reported"],
			["entrypoint", "observed"],
			["package", "observed"],
		] as const) {
			expect(identity.current![claim].basis).toBe(basis);
			for (const wrong of ["observed", "reported", "derived", "inferred", "unavailable"].filter(
				(b) => b !== basis,
			)) {
				expect(
					validateEndoCockpitRuntimeIdentityV0(
						mutated(identity, (c) => {
							c.current[claim].basis = wrong;
						}),
					),
					`${claim} ${wrong}`,
				).toBeNull();
			}
		}
		for (const wrong of ["derived", "reported", "inferred"]) {
			expect(
				validateEndoCockpitRuntimeIdentityV0(
					mutated(identity, (c) => {
						c.runtime.basis = wrong;
					}),
				),
				`runtime ${wrong}`,
			).toBeNull();
		}
		// A legitimate gap keeps its basis family: unavailable with the projection's reason, and no other reason.
		const gap = structuredClone(records.fingerprint[0]!);
		gap.local.entrypoint = null;
		const withGap = projectEndoCockpitRuntimeIdentityV0(input({ ...records, fingerprint: [gap] }));
		expect(withGap.current!.entrypoint.basis).toBe("unavailable");
		expect(validateEndoCockpitRuntimeIdentityV0(withGap)).not.toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(withGap, (c) => {
					c.current.entrypoint.reason = "some other reason";
				}),
			),
		).toBeNull();
	});

	it("audit: kind-typed values are judged by content as well as grammar", () => {
		// A lowercase credential shape is a valid dotted kind: the runtime family, capability, event kind are still withheld.
		const secret = "sk-canarysecretcanarysecret";
		const records = specimenRecords();
		const fingerprint = { ...structuredClone(records.fingerprint[0]!), runtime: secret };
		const identity = projectEndoCockpitRuntimeIdentityV0(input({ ...records, fingerprint: [fingerprint] }));
		expect(identity.runtime).toMatchObject({
			basis: "unavailable",
			reason: "withheld: looks like a path, address or credential",
		});
		expect(JSON.stringify(identity)).not.toContain(secret);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const state = structuredClone(records.state[0]!);
		state.capabilities[0]!.capability = secret;
		const capabilities = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [state] }));
		expect(capabilities.capabilities[0]!.capability).toMatch(/^withheld-[0-9a-f]{32}$/);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		const entry = timeline([event(`${secret}.step`, { a: 1 })]).entries[0]!;
		expect(entry.kind).toMatch(/^other\.withheld-[0-9a-f]{32}$/);
		expect(entry.category).toBe("other");
		expect(entry.flags).toContain("unrecognized");
		expect(validateEndoCockpitSessionTimelineV0(timeline([event(`${secret}.step`, { a: 1 })]))).not.toBeNull();
	});
});

describe("fifth review round (PR #57)", () => {
	const mutated = <T>(value: T, edit: (copy: any) => void): T => {
		const copy = structuredClone(value);
		edit(copy);
		return copy;
	};
	const WITHHELD = "withheld: looks like a path, address or credential";
	const aliasOf = (id: string) => `${id.split(".").slice(0, 2).join(".")}.withheld-${sha256HexV0(id).slice(0, 32)}`;

	// A registry with several records of every kind, in a legitimate state.
	function busy() {
		const base = specimenRecords();
		const first = base.fingerprint[0]!;
		const second = {
			...structuredClone(first),
			id: "endo.evidence.test-fingerprint.2",
			observedAt: "2026-10-04T10:00:00.000Z",
		};
		second.identity = { ...second.identity, digest: "d".repeat(64) };
		const state2 = { ...structuredClone(base.state[0]!), fingerprintId: second.id, at: "2026-10-04T10:00:01.000Z" };
		const change1 = changeRecord();
		const change2 = changeRecord({
			id: "endo.evidence.test-change.2",
			kind: "changed",
			previous: change1.current,
			current: { ...change1.current!, fingerprintId: second.id, identityDigest: "d".repeat(64) },
			differences: ["version"],
		});
		const note1 = notificationRecord();
		const note2 = notificationRecord({
			id: "endo.evidence.test-notification.2",
			changeId: change2.id,
			kind: "runtime-changed",
		});
		return {
			...base,
			fingerprint: [first, second],
			state: [base.state[0]!, state2],
			change: [change1, change2],
			notification: [note1, note2],
		};
	}

	// ---- 1. alias collisions ------------------------------------------------------------------------------------

	it("1: an identifier equal to another's generated alias is itself aliased, so two distinct sources never collapse", () => {
		expect(isEndoCockpitSourceIdAdmittedV0(`endo.event.withheld-${"a".repeat(32)}`)).toBe(false);
		expect(isEndoCockpitPublicIdV0(`endo.event.withheld-${"a".repeat(32)}`)).toBe(true);
		expect(isEndoCockpitSourceIdAdmittedV0("endo.event.plain.1")).toBe(true);
		const a = "endo.event.Tok_one";
		const b = aliasOf(a);
		const log = timeline([
			event("tool.started", {}, { id: a }),
			event("tool.finished", {}, { id: b }),
			event("agent.settled", {}, { id: "endo.event.plain.3" }),
		]);
		const ids = log.entries.map((e) => e.eventId);
		expect(new Set(ids).size).toBe(3);
		expect(ids[0]).toBe(b); // a's alias is exactly b's raw value ...
		expect(ids[1]).not.toBe(b); // ... so b itself is aliased and cannot collide with it
		expect(ids[1]).toMatch(/^endo\.event\.withheld-[0-9a-f]{32}$/);
		expect(ids[2]).toBe("endo.event.plain.3");
		expect(log.duplicatesIgnored).toBe(0);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		// derivedFrom keeps each relationship apart.
		const derived = timeline([
			event("tool.started", {}, { id: a }),
			event("tool.finished", {}, { id: b }),
			{ ...event("agent.settled", {}, { id: "endo.event.plain.9" }), derivedFrom: [a, b] },
		]).entries.at(-1)!;
		expect(derived.derivedFrom).toEqual([aliasOf(a), aliasOf(b)]);
		expect(new Set(derived.derivedFrom).size).toBe(2);
		// A forged window repeating one public id for two events is rejected.
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[1].eventId = c.entries[0].eventId;
				}),
			),
		).toBeNull();
	});

	it("1: the same holds for registry records, references and capability names", () => {
		const records = specimenRecords();
		const first = records.fingerprint[0]!;
		const f = "endo.evidence.Tok_fp";
		const g = aliasOf(f);
		const a = { ...structuredClone(first), id: f };
		const b = { ...structuredClone(first), id: g, observedAt: "2026-10-04T10:00:00.000Z" };
		b.identity = { ...b.identity, digest: "d".repeat(64) };
		const identity = projectEndoCockpitRuntimeIdentityV0(input({ ...records, fingerprint: [a, b] }));
		expect(identity.current!.id).not.toBe(identity.previousDifferent!.id);
		expect(identity.current!.ref).toMatchObject({ id: identity.current!.id });
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		// Two capabilities whose names are each other's placeholder do not merge.
		const state = structuredClone(records.state[0]!);
		const odd = "sk-canarysecretcanarysecret";
		const placeholder = `withheld-${sha256HexV0(odd).slice(0, 32)}`;
		state.capabilities[0]!.capability = odd;
		state.capabilities[1]!.capability = placeholder;
		const capabilities = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [state] }));
		const names = capabilities.capabilities.map((c) => c.capability);
		expect(new Set(names).size).toBe(names.length);
		expect(names[0]).toBe(placeholder);
		expect(names[1]).not.toBe(placeholder);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		const kinds = timeline([
			event(odd + ".x"),
			event(`other.withheld-${sha256HexV0(`${odd}.x`).slice(0, 32)}`),
		]).entries.map((e) => e.kind);
		expect(new Set(kinds).size).toBe(2);
	});

	// ---- 2. notes and latest-record claims ----------------------------------------------------------------------

	it("2: notes are true of the view beside them; legitimate noted states still validate", () => {
		const records = busy();
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		expect(identity.notes).toEqual([]);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const note = (code: string, refs: unknown[] = []) => ({ code, refs });
		// Contradicted: a fingerprint is recorded, a change is not a failure, and the change is for the latest fingerprint.
		for (const bad of [
			note("no-fingerprint-recorded"),
			note("latest-change-is-collection-failure", [identity.lastChange!.ref]),
			note("latest-change-not-for-latest-fingerprint", [identity.lastChange!.ref, identity.current!.ref]),
			note("notification-change-missing", [identity.lastNotification!.ref]),
			note("runtime-disagreement", [identity.current!.ref]),
		])
			expect(
				validateEndoCockpitRuntimeIdentityV0(
					mutated(identity, (c) => {
						c.notes.push(bad);
					}),
				),
				bad.code,
			).toBeNull();
		// Legitimate noted states, from real projections.
		const stray = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, change: [records.change[0]!], notification: [records.notification[0]!] }),
		);
		expect(stray.notes.map((n) => n.code)).toEqual(["latest-change-not-for-latest-fingerprint"]);
		expect(validateEndoCockpitRuntimeIdentityV0(stray)).not.toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(stray, (c) => {
					c.notes = [];
				}),
			),
		).toBeNull();
		const failed = projectEndoCockpitRuntimeIdentityV0(
			input({
				...records,
				change: [changeRecord({ kind: "collection-failed", current: null, failure: "x" })],
				notification: [records.notification[0]!],
			}),
		);
		expect(failed.notes.map((n) => n.code)).toEqual(["latest-change-is-collection-failure"]);
		expect(validateEndoCockpitRuntimeIdentityV0(failed)).not.toBeNull();
		const missing = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, notification: [notificationRecord({ changeId: "endo.evidence.test-change.404" })] }),
		);
		expect(missing.notes.map((n) => n.code)).toEqual(["notification-change-missing"]);
		expect(validateEndoCockpitRuntimeIdentityV0(missing)).not.toBeNull();
		const none = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, fingerprint: [], change: [], notification: [] }),
		);
		expect(none.notes.map((n) => n.code)).toEqual(["no-fingerprint-recorded"]);
		expect(validateEndoCockpitRuntimeIdentityV0(none)).not.toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(none, (c) => {
					c.notes = [];
				}),
			),
		).toBeNull();
		// Capability state notes.
		const cap = projectEndoCockpitCapabilityStateV0(input(records));
		expect(validateEndoCockpitCapabilityStateV0(cap)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.notes.push(note("no-capability-state-recorded"));
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.notes.push(note("state-without-fingerprint", [c.state.ref]));
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.notes.push(note("duplicate-capability", []));
				}),
			),
		).toBeNull();
		const noState = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [] }));
		expect(noState.notes.map((n) => n.code)).toEqual(["no-capability-state-recorded"]);
		expect(validateEndoCockpitCapabilityStateV0(noState)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(noState, (c) => {
					c.notes = [];
				}),
			),
		).toBeNull();
		const noFingerprint = projectEndoCockpitCapabilityStateV0(input({ ...records, fingerprint: [] }));
		expect(noFingerprint.notes.map((n) => n.code)).toEqual(["state-without-fingerprint"]);
		expect(validateEndoCockpitCapabilityStateV0(noFingerprint)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(noFingerprint, (c) => {
					c.notes = [];
				}),
			),
		).toBeNull();
	});

	it("2: the latest record of every kind is the one the watermark ends at", () => {
		const records = busy();
		const identity = projectEndoCockpitRuntimeIdentityV0(input(records));
		expect(identity.current!.ref).toMatchObject({ kind: "fingerprint", index: 1 });
		expect(identity.previousDifferent!.ref).toMatchObject({ index: 0 });
		expect(identity.lastChange!.ref).toMatchObject({ index: 1 });
		expect(identity.lastNotification!.ref).toMatchObject({ index: 1 });
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		// A stale observation presented as current, or the last change / notice swapped for an earlier one, or no current at all.
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					c.current = structuredClone(c.previousDifferent);
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					c.current = null;
					c.runtime = {
						basis: "unavailable",
						reason: "no runtime family is recorded for this attachment",
						refs: [],
					};
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					c.lastChange.ref.index = 0;
					c.lastChange.ref.id = "endo.evidence.test-change.1";
					c.lastChange.id = "endo.evidence.test-change.1";
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					c.lastNotification.ref.index = 0;
					c.lastNotification.ref.id = "endo.evidence.test-notification.1";
					c.lastNotification.id = "endo.evidence.test-notification.1";
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					c.lastChange = null;
				}),
			),
		).toBeNull();
		// previousDifferent is an EARLIER record than current.
		expect(
			validateEndoCockpitRuntimeIdentityV0(
				mutated(identity, (c) => {
					const t = c.current;
					c.current = c.previousDifferent;
					c.previousDifferent = t;
				}),
			),
		).toBeNull();
		// Capability state: the state is the last one, and its latest fingerprint is the one the watermark ends at.
		const cap = projectEndoCockpitCapabilityStateV0(input(records));
		expect(cap.state!.ref).toMatchObject({ kind: "state", index: 1 });
		expect(cap.state!.latestFingerprintId).toBe(identity.current!.id);
		expect(validateEndoCockpitCapabilityStateV0(cap)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.state.ref.index = 0;
					for (const v of c.capabilities) v.ref.index = 0;
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.state.latestFingerprintId = identity.previousDifferent!.id;
					c.state.currency = "stale";
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(cap, (c) => {
					c.state.latestFingerprintId = null;
					c.state.currency = "unknown";
				}),
			),
		).toBeNull();
		// Records a store would refuse but a caller can pass (a foreign attachment's record last) fall back to the range check.
		const foreign = {
			...structuredClone(records.fingerprint[1]!),
			id: "endo.evidence.test-fingerprint.9",
			attachment: "other.default",
		};
		const withForeign = projectEndoCockpitRuntimeIdentityV0(
			input({ ...records, fingerprint: [...records.fingerprint, foreign] }),
		);
		expect(withForeign.notes.map((n) => n.code)).toEqual(["foreign-attachment-record"]);
		expect(validateEndoCockpitRuntimeIdentityV0(withForeign)).not.toBeNull();
	});

	// ---- 3. usage eligibility -----------------------------------------------------------------------------------

	const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costTotal: 0.1, reasoning: 0 };
	it("3: usage appears exactly where the projector gives it, decided from the presented role and entry type", () => {
		const log = timeline([
			event("message.completed", { role: "assistant", usage }),
			event("message.completed", { role: "assistant" }),
			event("message.completed", { role: "user", usage }),
			event("message.completed", { role: { status: "reported", value: "user" }, usage }),
			event("message.completed", { usage }),
			event("message.completed", { role: { status: "UNAVAILABLE", reason: "not reported" } }),
			event("session.entry-observed", { entryType: "message", details: { role: "assistant", usage } }),
			event("session.entry-observed", { entryType: "message", details: { role: "user", usage } }),
			event("session.entry-observed", { entryType: "message" }),
			event("session.entry-observed", { entryType: "compaction", details: { usage } }),
			event("session.entry-observed", { entryType: "branch_summary", details: {} }),
			event("session.entry-observed", { entryType: "model_change", details: { usage } }),
			event("session.entry-observed", { details: { usage } }),
			event("session.entry-observed", {
				entryType: { status: "reported", value: "compaction" },
				details: { usage },
			}),
			event("tool.started", { usage }),
		]);
		const kinds = log.entries.map((e) => (e.usage === null ? "null" : e.usage.basis));
		expect(kinds).toEqual([
			"reported",
			"unavailable",
			"null",
			"null",
			"reported",
			"unavailable",
			"reported",
			"null",
			"unavailable",
			"reported",
			"unavailable",
			"null",
			"null",
			"reported",
			"null",
		]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		const clear = (at: number) =>
			mutated(log, (c) => {
				c.entries[at].usage = null;
			});
		const give = (at: number) =>
			mutated(log, (c) => {
				c.entries[at].usage = { basis: "unavailable", reason: "the event records no usage" };
			});
		// Eligible but without usage: an assistant message, an unavailable or absent role, a durable entry of a usage type.
		for (const at of [0, 1, 4, 5, 6, 8, 9, 10, 13])
			expect(validateEndoCockpitSessionTimelineV0(clear(at)), `clear ${at}`).toBeNull();
		// Ineligible but with usage: a user message (plain or wrapped), another entry type, none, another kind.
		for (const at of [2, 3, 7, 11, 12, 14])
			expect(validateEndoCockpitSessionTimelineV0(give(at)), `give ${at}`).toBeNull();
		// Reported versus unavailable is not decidable from the wire, and is left as the entry says.
		expect(
			validateEndoCockpitSessionTimelineV0(
				mutated(log, (c) => {
					c.entries[1].usage = {
						basis: "reported",
						value: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							costTotal: null,
							reasoning: null,
						},
					};
				}),
			),
		).not.toBeNull();
	});

	// ---- 4. unverified classification; 256-character rule --------------------------------------------------------

	it("4: an unverified capability carries no classification", () => {
		const result = projectEndoCockpitCapabilityStateV0(input(specimenRecords()));
		const at = result.capabilities.findIndex((c) => c.status === "unverified");
		const records = specimenRecords();
		const state = structuredClone(records.state[0]!);
		state.capabilities[0] = {
			...state.capabilities[0]!,
			status: "unverified",
			classification: null,
			evidenceId: null,
			reason: "no evidence yet",
		};
		const unverified = projectEndoCockpitCapabilityStateV0(input({ ...records, state: [state] }));
		expect(unverified.capabilities[0]).toMatchObject({
			status: "unverified",
			classification: null,
			evidence: null,
			limits: [],
		});
		expect(validateEndoCockpitCapabilityStateV0(unverified)).not.toBeNull();
		for (const classification of ["EXACT", "PARTIAL", "UNAVAILABLE"])
			expect(
				validateEndoCockpitCapabilityStateV0(
					mutated(unverified, (c) => {
						c.capabilities[0].classification = classification;
					}),
				),
				classification,
			).toBeNull();
		void at;
	});

	it("4: free-text reasons and limitations follow the same 256-character whole-value rule in projection and validation", () => {
		const records = specimenRecords();
		const state = structuredClone(records.state[0]!);
		const evidence = structuredClone(records.evidence);
		const cited = evidence.find((item) => item.id === state.capabilities[1]!.evidenceId)!;
		const exact = "r".repeat(256);
		const over = "r".repeat(257);
		state.capabilities[0]!.reason = over;
		state.capabilities[1]!.reason = exact;
		cited.limitations = [over, exact, "a short limitation"];
		const result = projectEndoCockpitCapabilityStateV0(input({ ...records, evidence, state: [state] }));
		expect(result.capabilities[0]!.reason).toBe(WITHHELD);
		expect(result.capabilities[1]!.reason).toBe(exact);
		expect(result.capabilities[1]!.limitations).toEqual([WITHHELD, exact, "a short limitation"]);
		expect(validateEndoCockpitCapabilityStateV0(result)).not.toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(result, (c) => {
					c.capabilities[0].reason = over;
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(result, (c) => {
					c.capabilities[1].limitations[0] = over;
				}),
			),
		).toBeNull();
		expect(
			validateEndoCockpitCapabilityStateV0(
				mutated(result, (c) => {
					c.capabilities[0].reason = "";
				}),
			),
		).toBeNull();
		// Titles, versions and evidence labels share the rule.
		const identity = projectEndoCockpitRuntimeIdentityV0(
			input({
				...records,
				change: [changeRecord()],
				notification: [notificationRecord({ title: "t".repeat(256) })],
			}),
		);
		expect(identity.lastNotification!.title).toHaveLength(256);
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
	});
});
