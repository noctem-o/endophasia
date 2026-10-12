// The cockpit projections are pure: validated records in, versioned presentation data out. These tests build the inputs
// by hand (a real specimen where one exists, synthetic records where the case needs a disagreement) and check what the
// projections guarantee: determinism, storage order, explicit gaps, provenance, the presentation boundary, and the
// contract validators. The store-to-projection path is in endo-cockpit-reader.test.ts.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { projectEndoCockpitCapabilityStateV0 } from "../cockpit/projections/capability-state.ts";
import type { EndoCockpitRegistryInputV0, EndoCockpitRegistryRecordsV0 } from "../cockpit/projections/common.ts";
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
			lastIds: { fingerprint: null, change: null, evidence: null, state: null, notification: null },
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
				error: { kind: "invalid-store", message: "duplicate event id" },
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
		expect(codes(d!.capability)).toEqual(["evidence-reduced-identity"]);
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

	it("truncates an over-long string field instead of passing it on", () => {
		const result = timeline([event("harness.protocol-fault", { fault: "x".repeat(10_000) })]);
		expect((result.entries[0]!.fields.fault as { value: string }).value).toHaveLength(256);
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
