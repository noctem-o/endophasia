// The trajectory-comparison presentation (protocol/cockpit-comparison.ts, cockpit/projections/trajectory-comparison.ts).
//
// Every input is a committed recording: the REAL Pi 1.0.1 lifecycle recordings and cassettes, and the hostile fake-Pi
// recordings (tests/fixtures/trajectory/fake-pi/), loaded into a scratch durable store and projected exactly as
// tests/trajectory.test.ts does. Where a case needs a recording no fixture holds (a failed run, a credential-shaped model name), a
// fixture trajectory is altered and re-sealed, so the comparator still validates it.
//
// What is under test is the PRESENTATION: that the comparator's three states, its separate layers and its uncertainty reach the
// record unchanged, that no judgement is added, and that nothing a browser must not receive is carried.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { importDshSessionBytesV0, projectDshTrajectoryV0 } from "../adapters/dsh-native/index.ts";
import { projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import { trajectoryFromStoreV0 } from "../cli/trajectory.ts";
import { ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0 } from "../cockpit/projections/trajectory-comparison.ts";
import {
	ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0,
	ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0,
	type EndoCockpitTrajectoryComparisonV0,
	validateEndoCockpitTrajectoryComparisonV0,
} from "../protocol/cockpit-comparison.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { ENDO_TRAJECTORY_COMPARISON_RULES_V0, type EndoTrajectoryV0 } from "../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0, sealEndoTrajectoryV0 } from "../runtime/contracts/trajectory.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { OTHER_KEY, projectEndoCockpitTrajectoryComparisonV0 as projectWith, TEST_KEY } from "./cockpit-keyed.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const REAL = "research/pi-conformance/1.0.1/lifecycle";
const CASSETTES = "research/pi-conformance/1.0.1/cassettes";
const FAKE = "tests/fixtures/trajectory/fake-pi";
const STORE_LABEL = "/secret-place/never-published/store";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): EndoEventV0[] {
	return readFileSync(join(REPO, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EndoEventV0);
}

const piSession = (events: readonly EndoEventV0[]): string =>
	(events.find((event) => event.kind === "harness.attached")!.payload as { piSessionId: string }).piSessionId;

/** A committed recording, loaded into a scratch durable store and projected through the CLI's read-only path. */
function trajectory(directory: string, name: string): EndoTrajectoryV0 {
	const events = lines(`${directory}/${name}.events.jsonl`);
	const root = mkdtempSync(join(tmpdir(), "endo-comparison-"));
	dirs.push(root);
	const store = createEndoDurableEventStoreV0(root);
	for (const event of events) store.ingest(event);
	store.close();
	return trajectoryFromStoreV0(root, piSession(events), { label: STORE_LABEL });
}

/** A fixture trajectory altered and re-sealed, so it is still a valid record. */
function altered(source: EndoTrajectoryV0, change: (body: Record<string, any>) => void): EndoTrajectoryV0 {
	const { digest: _digest, ...body } = JSON.parse(JSON.stringify(source)) as Record<string, any>;
	change(body);
	return sealEndoTrajectoryV0(body as Omit<EndoTrajectoryV0, "digest">);
}

const baseline = () => trajectory(FAKE, "baseline");
const project = (a: EndoTrajectoryV0, b: EndoTrajectoryV0, key = TEST_KEY): EndoCockpitTrajectoryComparisonV0 =>
	projectWith(a, b, key);
const text = (value: string) => ({ kind: "text", text: value });

/** Every 64-hex string in a value, so a leak of a plain digest can be searched for. */
const serialized = (value: unknown): string => canonicalEndoJsonV0(value);

describe("the projection of a comparison", () => {
	it("two recordings of the same behaviour: every judged layer EXACT, no flags, zero deltas that are real zeros", () => {
		const result = project(baseline(), trajectory(FAKE, "baseline-again"));
		expect(result.schemaVersion).toBe("endo.cockpit-trajectory-comparison.v0");
		expect(result.comparisonRules).toBe(ENDO_TRAJECTORY_COMPARISON_RULES_V0.version);
		expect(result.flags).toEqual([]);
		expect(result.layers.lifecycle).toMatchObject({ status: "EXACT" });
		expect(result.layers.toolCalls).toEqual({ status: "EXACT", length: 2 });
		expect(result.layers.toolResults).toEqual({ status: "EXACT", length: 2 });
		expect(result.layers.outcome).toMatchObject({ status: "EXACT" });
		expect(result.toolCallsAgainstInputs).toEqual({
			firstDivergentResult: null,
			firstDivergentCall: null,
			callsIdenticalUpToFirstDivergentInput: true,
			reason: "calls-identical",
		});
		// A delta of 0 is a recorded zero; it is DELTA, never UNAVAILABLE.
		const usage = result.layers.usage;
		if (usage.status !== "DELTAS" || usage.totals.status !== "DELTAS") throw new Error("expected usage deltas");
		expect(usage.totals.fields.input).toEqual({ status: "DELTA", value: 0 });
		expect(result.layers.timing.status).toBe("DELTAS");
	});

	it("a lifecycle and outcome divergence in the REAL recordings is located within those layers, and says nothing overall", () => {
		const result = project(trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn"));
		expect(result.layers.lifecycle).toMatchObject({
			status: "DIVERGED",
			index: 3,
			commonPrefix: 3,
			a: { present: true, entry: { kind: "lifecycle.turn-completed", recognized: true } },
			b: { present: true, entry: { kind: "lifecycle.stop-requested", recognized: true } },
		});
		expect(result.layers.outcome).toMatchObject({
			status: "DIVERGED",
			index: 0,
			a: { present: true, entry: { outcome: "completed" } },
			b: { present: true, entry: { outcome: "aborted", stopRequested: true } },
		});
		// The facts of the differing entries are carried as a flat list of scalars, in path order.
		const entry = (result.layers.lifecycle as any).b.entry;
		expect(entry.facts.items).toContainEqual({ path: "runOpen", value: true });
		expect(entry.facts.omitted).toBe(0);
	});

	it("a tool-call divergence stands apart from the tool results", () => {
		const result = project(baseline(), trajectory(FAKE, "tool-args-differ"));
		expect(result.layers.toolCalls).toMatchObject({ status: "DIVERGED", index: 0 });
		const call = result.layers.toolCalls as any;
		// Same tool name, different argument digest: shown as two recorded keyed digests under one key id.
		expect(call.a.entry.name).toEqual({ status: "reported", value: text("read") });
		expect(call.b.entry.name).toEqual(call.a.entry.name);
		expect(call.a.entry.args.status).toBe("reported");
		expect(call.a.entry.args.keyId).toBe("fixture-public");
		expect(call.a.entry.args.value).not.toBe(call.b.entry.args.value);
		// The tool-result layer is judged on its own and is not made to follow.
		const direct = compareEndoTrajectoriesV0(baseline(), trajectory(FAKE, "tool-args-differ"));
		expect(result.layers.toolResults.status).toBe(direct.layers.toolResults.status);
	});

	it("a tool-result divergence is not a changed agent choice, and the ordering is not a cause", () => {
		const result = project(baseline(), trajectory(FAKE, "tool-result-differs"));
		expect(result.layers.toolCalls).toEqual({ status: "EXACT", length: 2 });
		expect(result.layers.toolResults).toMatchObject({ status: "DIVERGED", index: 0 });
		const against = result.toolCallsAgainstInputs;
		expect(against.callsIdenticalUpToFirstDivergentInput).toBe(true);
		expect(against.firstDivergentResult).toMatchObject({ index: 0 });
		expect(against.firstDivergentCall).toBeNull();
		expect(against.reason).toBe("calls-identical");
		// The same status with another result digest: the result entry shows both digests and the same "ok".
		const entries = result.layers.toolResults as any;
		expect(entries.a.entry.status).toEqual(entries.b.entry.status);
		expect(entries.a.entry.result.value).not.toBe(entries.b.entry.result.value);
	});

	it("a position past a side's end is an absent slot, never a null entry, and is told from a content difference", () => {
		const base = baseline();
		const shorter = altered(base, (body) => {
			body.layers.toolCalls.entries.pop();
			body.layers.toolResults.entries.pop();
		});
		const result = project(base, shorter);
		expect(result.layers.toolCalls).toMatchObject({
			status: "DIVERGED",
			index: 1,
			commonPrefix: 1,
			lengths: { a: 2, b: 1 },
			a: { present: true },
			b: { present: false },
		});
		expect((result.layers.toolCalls as any).b).toEqual({ present: false });
		// Mirrored.
		expect(project(shorter, base).layers.toolCalls).toMatchObject({
			a: { present: false },
			b: { present: true },
			lengths: { a: 1, b: 2 },
		});
	});

	it("keeps three states apart: EXACT of length 0, a layer a side did not report, and unverified positions", () => {
		const base = baseline();
		const empty = altered(base, (body) => {
			body.layers.toolCalls = { status: "reported", entries: [] };
		});
		const missing = altered(base, (body) => {
			body.layers.toolCalls = { status: "UNAVAILABLE", reason: "the recorder captured no tool calls" };
		});
		expect(project(empty, empty).layers.toolCalls).toEqual({ status: "EXACT", length: 0 });
		expect(project(missing, empty).layers.toolCalls).toEqual({
			status: "UNAVAILABLE",
			sides: { a: text("the recorder captured no tool calls"), b: null },
			unverified: [],
			lengths: null,
		});
		expect(project(missing, empty).toolCallsAgainstInputs).toMatchObject({
			callsIdenticalUpToFirstDivergentInput: null,
			reason: "calls-unavailable",
		});
		const withoutDigests = altered(base, (body) => {
			for (const entry of body.layers.toolCalls.entries)
				entry.argsDigest = { status: "UNAVAILABLE", reason: "recorded before pi-rpc-mapping.3" };
		});
		expect(project(base, withoutDigests).layers.toolCalls).toEqual({
			status: "UNAVAILABLE",
			sides: { a: null, b: null },
			unverified: [
				{ index: 0, reason: { code: "digest-not-recorded", sides: "one" } },
				{ index: 1, reason: { code: "digest-not-recorded", sides: "one" } },
			],
			lengths: { a: 2, b: 2 },
		});
		expect(project(withoutDigests, withoutDigests).layers.toolCalls).toMatchObject({
			unverified: [
				{ reason: { code: "digest-not-recorded", sides: "both" } },
				{ reason: { code: "digest-not-recorded", sides: "both" } },
			],
		});
		// Matching names with unverifiable arguments are not EXACT.
		expect(project(base, withoutDigests).toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput).toBeNull();
		expect(project(base, withoutDigests).toolCallsAgainstInputs.reason).toBe("calls-unverified");
	});

	it("results that cannot be verified leave the input ordering unlocatable, with a code", () => {
		const base = baseline();
		const noResults = altered(base, (body) => {
			for (const entry of body.layers.toolResults.entries)
				entry.resultDigest = { status: "UNAVAILABLE", reason: "recorded before pi-rpc-mapping.4" };
		});
		const differentCall = trajectory(FAKE, "tool-args-differ");
		const stripped = altered(differentCall, (body) => {
			for (const entry of body.layers.toolResults.entries)
				entry.resultDigest = { status: "UNAVAILABLE", reason: "recorded before pi-rpc-mapping.4" };
		});
		expect(project(base, noResults).layers.toolResults).toMatchObject({
			status: "UNAVAILABLE",
			unverified: [{ reason: { code: "digest-not-recorded" } }, { reason: { code: "digest-not-recorded" } }],
		});
		expect(project(base, stripped).toolCallsAgainstInputs.reason).toBe("results-unavailable-or-unverified");
	});

	it("different digest domains are UNAVAILABLE with the two domains named, flagged, and the docs path is not carried", () => {
		const result = project(baseline(), trajectory(FAKE, "other-digest-domain"));
		const reason = {
			code: "digest-domains-differ",
			domains: [text("fixture-public"), text("fixture-public-alt")],
		};
		expect(result.layers.toolCalls).toMatchObject({
			status: "UNAVAILABLE",
			unverified: [
				{ index: 0, reason },
				{ index: 1, reason },
			],
		});
		expect(result.layers.toolResults.status).toBe("UNAVAILABLE");
		expect(result.flags).toEqual([
			{
				kind: "digest-domain-differs",
				a: { values: [text("fixture-public")] },
				b: { values: [text("fixture-public-alt")] },
			},
		]);
		expect(serialized(result)).not.toContain("docs/trajectory.md");
		// The other layers are judged as usual.
		expect(result.layers.lifecycle.status).toBe("EXACT");
		expect(result.layers.outcome.status).toBe("EXACT");
		// The reason is the same whichever side is a (the comparator sorts the two).
		expect(
			(project(trajectory(FAKE, "other-digest-domain"), baseline()).layers.toolCalls as any).unverified[0].reason,
		).toEqual(reason);
	});

	it("a name difference still diverges across digest domains: only the digest is unverifiable", () => {
		const other = trajectory(FAKE, "other-digest-domain");
		const renamed = altered(other, (body) => {
			body.layers.toolCalls.entries[0].name = { status: "reported", value: "write" };
		});
		expect(project(baseline(), renamed).layers.toolCalls).toMatchObject({ status: "DIVERGED", index: 0 });
	});

	it("mixed runtime, mapping, model and configuration are listed as flags, never rejected, never changing a verdict", () => {
		const result = project(trajectory(REAL, "completes"), trajectory(`${CASSETTES}/completes`, "session"));
		const direct = compareEndoTrajectoriesV0(
			trajectory(REAL, "completes"),
			trajectory(`${CASSETTES}/completes`, "session"),
		);
		expect(result.flags.map((flag) => flag.kind)).toEqual(direct.flags.map((flag) => flag.kind));
		expect(result.flags.map((flag) => flag.kind)).toEqual(
			expect.arrayContaining(["mapping-differs", "digest-domain-differs"]),
		);
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
			expect(result.layers[layer].status).toBe(direct.layers[layer].status);
		const fingerprint = project(baseline(), trajectory(FAKE, "other-fingerprint")).flags;
		expect(fingerprint.map((flag) => flag.kind)).toEqual(["runtime-fingerprint-differs", "runtime-version-differs"]);
		expect(fingerprint[1]).toEqual({
			kind: "runtime-version-differs",
			a: { values: [text("1.0.0")] },
			b: { values: [text("1.0.1")] },
		});
		// A fingerprint is a digest of withheld facts: a keyed token, equal for equal values and never the recorded digest.
		const [fp] = fingerprint as any[];
		const recorded = (t: EndoTrajectoryV0) =>
			t.environment.attachments.map((a) => (a.identityDigest.status === "reported" ? a.identityDigest.value : null));
		expect(fp.a.values).toHaveLength(1);
		expect(fp.a.values[0].kind).toBe("token");
		expect(serialized(fingerprint)).not.toContain(recorded(baseline())[0]);
		expect(fp.a.values[0].token).not.toBe(fp.b.values[0].token);
	});

	it("flags what a recording did not report as null, and a runtime-reported model as text", () => {
		const flags = project(trajectory(REAL, "completes"), baseline()).flags;
		const mapping = flags.find((flag) => flag.kind === "mapping-differs")!;
		expect(mapping.a.values).toEqual([null]);
		expect(mapping.b.values).toEqual([text("pi-rpc-mapping.4")]);
	});

	it("usage and timing keep their bases, direction and sign; a missing side is UNAVAILABLE, a partial total is not 0", () => {
		const result = project(trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn"));
		const forward = compareEndoTrajectoriesV0(trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn"));
		if (result.layers.usage.status !== "DELTAS" || forward.layers.usage.status !== "DELTAS") throw new Error("usage");
		expect(result.layers.usage).toMatchObject({ basis: "runtime-reported", direction: "b-minus-a" });
		for (const [field, value] of Object.entries(forward.layers.usage.totals.tokens)) {
			const shown = (result.layers.usage.totals as any).fields[field];
			expect(shown).toEqual(value === null ? { status: "UNAVAILABLE" } : { status: "DELTA", value });
		}
		if (result.layers.timing.status !== "DELTAS") throw new Error("timing");
		expect(result.layers.timing).toMatchObject({
			basis: "observer-measured",
			clock: "observer",
			direction: "b-minus-a",
		});

		// One side reported no usage at all.
		const noUsage = project(baseline(), trajectory(FAKE, "no-usage"));
		expect(noUsage.layers.usage).toEqual({
			status: "UNAVAILABLE",
			sides: { a: null, b: text("Pi reported no usage on any assistant message of this session") },
		});
		// Both reported the layer, but a run's tokens are not reported on a side: UNAVAILABLE, never an empty or zero delta.
		const base = baseline();
		const hollow = altered(base, (body) => {
			for (const entry of body.layers.usage.entries)
				entry.tokens = { status: "UNAVAILABLE", reason: "no message carried usage" };
		});
		const partial = project(base, hollow);
		if (partial.layers.usage.status !== "DELTAS") throw new Error("usage");
		expect(partial.layers.usage.totals).toEqual({ status: "UNAVAILABLE" });
		expect(partial.layers.usage.runs.every((run) => run.tokens.status === "UNAVAILABLE")).toBe(true);
	});

	it("an interrupted run has no wall time: the delta is UNAVAILABLE, not 0", () => {
		const result = project(trajectory(REAL, "completes"), trajectory(REAL, "killed-and-resumed"));
		if (result.layers.timing.status !== "DELTAS") throw new Error("timing");
		const unavailable = result.layers.timing.runs.filter((run) => run.wallMs.status === "UNAVAILABLE");
		expect(unavailable.length).toBeGreaterThan(0);
		expect(result.layers.outcome.status).toBe("DIVERGED");
	});

	it("is symmetric: project(b, a) is project(a, b) with the sides swapped and the deltas negated", () => {
		const flipQuantity = (value: any): any =>
			value.status === "DELTA" ? { status: "DELTA", value: value.value === 0 ? 0 : -value.value } : value;
		const flipDeltas = (value: any): any =>
			value.status === "DELTAS"
				? {
						status: "DELTAS",
						fields: Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, flipQuantity(v)])),
					}
				: value;
		const swap = (value: any): any => ({ a: value.b, b: value.a });
		const mirror = (r: EndoCockpitTrajectoryComparisonV0): any => {
			const layer = (verdict: any): any =>
				verdict.status === "DIVERGED"
					? { ...verdict, lengths: swap(verdict.lengths), ...swap(verdict) }
					: verdict.status === "UNAVAILABLE"
						? {
								...verdict,
								sides: swap(verdict.sides),
								lengths: verdict.lengths === null ? null : swap(verdict.lengths),
							}
						: verdict;
			const usage: any = r.layers.usage;
			const timing: any = r.layers.timing;
			return {
				...r,
				...swap(r),
				flags: r.flags.map((flag) => ({ ...flag, ...swap(flag) })),
				layers: {
					lifecycle: layer(r.layers.lifecycle),
					toolCalls: layer(r.layers.toolCalls),
					toolResults: layer(r.layers.toolResults),
					outcome: layer(r.layers.outcome),
					usage:
						usage.status === "DELTAS"
							? {
									...usage,
									runs: usage.runs.map((run: any) => ({
										...run,
										present: swap(run.present),
										tokens: flipDeltas(run.tokens),
									})),
									totals: flipDeltas(usage.totals),
								}
							: { ...usage, sides: swap(usage.sides) },
					timing:
						timing.status === "DELTAS"
							? {
									...timing,
									runs: timing.runs.map((run: any) => ({
										...run,
										present: swap(run.present),
										wallMs: flipQuantity(run.wallMs),
									})),
									totals: { wallMs: flipQuantity(timing.totals.wallMs) },
								}
							: { ...timing, sides: swap(timing.sides) },
				},
			};
		};
		const pairs: [EndoTrajectoryV0, EndoTrajectoryV0][] = [
			[trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn")],
			[baseline(), trajectory(FAKE, "tool-args-differ")],
			[baseline(), trajectory(FAKE, "no-usage")],
			[baseline(), trajectory(FAKE, "other-digest-domain")],
			[trajectory(REAL, "completes"), trajectory(REAL, "killed-and-resumed")],
		];
		for (const [a, b] of pairs) {
			const forward = project(a, b);
			const backward = project(b, a);
			const expected = mirror(forward);
			// The comparison token is the digest of another comparison: everything else mirrors.
			expect({ ...backward, comparisonToken: "" }).toEqual({ ...expected, comparisonToken: "" });
			expect(backward.comparisonToken).not.toBe(forward.comparisonToken);
		}
	});

	it("is deterministic, and another key changes only the tokens", () => {
		const a = trajectory(FAKE, "baseline");
		const b = trajectory(FAKE, "other-fingerprint");
		const once = project(a, b);
		expect(serialized(project(a, b))).toBe(serialized(once));
		expect(serialized(project(trajectory(FAKE, "baseline"), trajectory(FAKE, "other-fingerprint")))).toBe(
			serialized(once),
		);
		const other = project(a, b, OTHER_KEY);
		expect(other.keyId).toBe(OTHER_KEY.keyId);
		expect(other.keyId).not.toBe(once.keyId);
		const bare = (r: unknown): string =>
			serialized(r)
				.replace(/[0-9a-f]{64}/g, "T")
				.replace(/"keyId":\s*"[^"]+"/, '"keyId":"K"');
		expect(bare(other)).toBe(bare(once));
		expect(serialized(other)).not.toBe(serialized(once));
		// Equal values give equal tokens under one key: the same trajectory twice has one eventsToken.
		expect(once.a.eventsToken).toBe(project(a, a).a.eventsToken);
		expect(once.a.eventsToken).not.toBe(once.b.eventsToken);
	});

	it("is tied to the comparator's rules version", () => {
		expect(ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0).toBe("cockpit-trajectory-comparison.2");
		expect(project(baseline(), baseline()).comparisonRules).toBe("trajectory-comparison.3");
	});

	it("claims nothing the comparator does not: no overall verdict, no global divergence, no event pairing, no cause", () => {
		const result = project(trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn"));
		expect(Object.keys(result).sort()).toEqual([
			"a",
			"b",
			"comparisonRules",
			"comparisonToken",
			"flags",
			"keyId",
			"layers",
			"projectionVersion",
			"schemaVersion",
			"toolCallsAgainstInputs",
		]);
		expect(Object.keys(result.layers).sort()).toEqual([
			"lifecycle",
			"outcome",
			"timing",
			"toolCalls",
			"toolResults",
			"usage",
		]);
		const names = new Set<string>();
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value !== null && typeof value === "object")
				for (const [key, child] of Object.entries(value)) {
					names.add(key);
					walk(child);
				}
		};
		walk(result);
		// "cause" is the outcome's recorded failure cause (by reference), never an inferred one.
		names.delete("cause");
		for (const key of names)
			expect(key, key).not.toMatch(
				/overall|global|firstDivergence$|correspond|pair|cause[sd]?$|caused|significan|better|improv|equivalen|success|score|confidence|winner/i,
			);
		// The one cause-shaped word is the outcome's recorded failure cause (by reference), never an inferred one.
	});
});

describe("what the projection withholds", () => {
	it("carries no store path, no plain digest of any record, and no comparator wording", () => {
		const a = trajectory(FAKE, "baseline");
		const b = trajectory(FAKE, "other-fingerprint");
		const comparison = compareEndoTrajectoriesV0(a, b);
		expect(JSON.stringify(comparison)).toContain(STORE_LABEL);
		const out = serialized(project(a, b));
		const recordedDigests = [
			a.source.eventsSha256,
			b.source.eventsSha256,
			a.digest,
			b.digest,
			comparison.digest,
			...[a, b]
				.flatMap((t) =>
					t.environment.attachments.flatMap((attachment) => [
						attachment.identityDigest,
						attachment.userConfigurationDigest,
						attachment.projectConfigurationDigest,
					]),
				)
				.flatMap((item) => (item.status === "reported" ? [item.value] : [])),
		];
		expect(recordedDigests.length).toBeGreaterThan(5);
		for (const digest of recordedDigests) expect(out, digest).not.toContain(digest);
		for (const word of [
			STORE_LABEL,
			"secret-place",
			"docs/trajectory.md",
			"share one key",
			"no argument digest was recorded",
		])
			expect(out, word).not.toContain(word);
	});

	it("never publishes a hash that commits to withheld content: an unrecognised payload, a failure cause", () => {
		const file = `${FAKE}/baseline.events.jsonl`;
		const events = lines(file);
		const at = events.findIndex((event) => event.kind === "lifecycle.run-started");
		const future: EndoEventV0 = {
			...events[at]!,
			id: "endo.event.pi-lifecycle.future-kind",
			kind: "lifecycle.run-paused",
			payload: { why: "future" },
		};
		const base = baseline();
		const withFuture = projectPiTrajectoryV0([...events.slice(0, at + 1), future, ...events.slice(at + 1)], {
			store: file,
			session: piSession(events),
		});
		const payloadSha = sha256HexV0(canonicalEndoJsonV0({ why: "future" }));
		const result = project(base, withFuture);
		const lifecycle = result.layers.lifecycle as any;
		expect(lifecycle.status).toBe("DIVERGED");
		// The kind is not one this version defines: shown only as the alias of the kind, and the payload hash as a token.
		expect(lifecycle.b.entry.recognized).toBe(false);
		expect(lifecycle.b.entry.kind).toMatch(/^(?:lifecycle\.run-paused|withheld-[0-9a-f]{32})$/);
		expect(lifecycle.b.entry.facts.items).toEqual([
			{ path: "payloadSha256", value: { kind: "token", token: expect.stringMatching(/^[0-9a-f]{64}$/) } },
		]);
		expect(serialized(result)).not.toContain(payloadSha);

		const failed = altered(base, (body) => {
			body.layers.outcome.entries[0].outcome = "failed";
			body.layers.outcome.entries[0].cause = {
				message: { status: "reported", value: { sha256: "ab".repeat(32), length: 40, classification: "text" } },
				note: "call me at /home/someone/.ssh/id_rsa",
			};
		});
		const withCause = project(base, failed);
		const outcome = (withCause.layers.outcome as any).b.entry;
		expect(outcome.outcome).toBe("failed");
		expect(serialized(withCause)).not.toContain("ab".repeat(32));
		expect(serialized(withCause)).not.toContain(".ssh");
		const paths = outcome.cause.items.map((item: any) => item.path);
		expect(paths).toEqual([
			"message.status",
			"message.value.classification",
			"message.value.length",
			"message.value.sha256",
			"note",
		]);
		expect(outcome.cause.items.find((item: any) => item.path === "note").value.kind).toBe("withheld");
	});

	it("withholds credential-shaped and path-shaped text, but a withheld value that differs stays different", () => {
		const base = baseline();
		const keyOne = altered(base, (body) => {
			body.environment.attachments[0].configuredModel = {
				status: "reported",
				value: "sk-abcdefghijklmnopqrstuvwxyz012345",
			};
		});
		const keyTwo = altered(base, (body) => {
			body.environment.attachments[0].configuredModel = {
				status: "reported",
				value: "sk-zyxwvutsrqponmlkjihgfedcba543210",
			};
		});
		const one = project(base, keyOne);
		const flag = one.flags.find((item) => item.kind === "configured-model-differs")!;
		expect(flag.b.values[0]).toMatchObject({ kind: "withheld", token: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(serialized(one)).not.toContain("sk-abcdefgh");
		const two = project(base, keyTwo);
		const flagTwo = two.flags.find((item) => item.kind === "configured-model-differs")!;
		expect(flagTwo.b.values[0]).not.toEqual(flag.b.values[0]);
		// Equal withheld values are equal.
		expect(project(keyOne, keyOne).flags).toEqual([]);
		const lifecycle = altered(base, (body) => {
			body.layers.lifecycle.entries[0].facts.runtime = "/home/someone/pi";
		});
		const shown = project(base, lifecycle);
		expect(serialized(shown)).not.toContain("/home/someone");
		expect((shown.layers.lifecycle as any).b.entry.facts.items).toContainEqual({
			path: "runtime",
			value: { kind: "withheld", token: expect.stringMatching(/^[0-9a-f]{64}$/) },
		});
	});

	it("shows a keyed digest only with an admitted key id: a credential-shaped one is withheld, as the pair", () => {
		const base = baseline();
		const hostile = "sk-abcdefghijklmnop";
		const odd = altered(base, (body) => {
			body.environment.attachments[0].digestKey = { status: "reported", value: { keyId: hostile, domain: "x" } };
			for (const entry of body.layers.toolCalls.entries) entry.argsDigest.value.keyId = hostile;
			for (const entry of body.layers.toolResults.entries) entry.resultDigest.value.keyId = hostile;
		});
		const result = project(base, odd);
		expect(serialized(result)).not.toContain(hostile);
		// The domains differ, so the entries are unverifiable and the key ids are withheld by token.
		const reason = (result.layers.toolCalls as any).unverified[0].reason;
		expect(reason.code).toBe("digest-domains-differ");
		expect(reason.domains[0]).toEqual(text("fixture-public"));
		expect(reason.domains[1].kind).toBe("withheld");
		const flag = result.flags.find((item) => item.kind === "digest-domain-differs")!;
		expect(flag.b.values[0]!.kind).toBe("withheld");
		// The same hostile id on both sides: the digests are comparable, and shown as withheld, never beside the id.
		const same = project(
			odd,
			altered(odd, (body) => {
				body.layers.toolCalls.entries[0].argsDigest.value.value = "00".repeat(32);
			}),
		);
		const call = (same.layers.toolCalls as any).a.entry;
		expect(same.layers.toolCalls.status).toBe("DIVERGED");
		expect(call.args).toEqual({ status: "withheld", token: expect.stringMatching(/^[0-9a-f]{64}$/) });
		// Two different digests under the withheld key id still read as different.
		expect((same.layers.toolCalls as any).b.entry.args.token).not.toBe(call.args.token);
	});

	it("bounds a free-form fact list and counts what it leaves out", () => {
		const base = baseline();
		const many = altered(base, (body) => {
			const facts: Record<string, number> = {};
			for (let index = 0; index < 40; index += 1) facts[`k${String(index).padStart(2, "0")}`] = index;
			facts["bad key!"] = 1;
			body.layers.lifecycle.entries[1].facts = { ...facts, deep: { a: { b: { c: { d: 1 } } } } };
		});
		const result = project(base, many);
		const facts = (result.layers.lifecycle as any).b.entry.facts;
		expect(facts.items).toHaveLength(ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0);
		expect(facts.omitted).toBeGreaterThanOrEqual(10);
		const paths: string[] = facts.items.map((item: any) => item.path);
		expect([...paths].sort()).toEqual(paths);
	});

	it("reads nothing and writes nothing: no network, no key file, no environment", () => {
		const scratch = mkdtempSync(join(tmpdir(), "endo-comparison-key-"));
		dirs.push(scratch);
		const keyFile = join(scratch, "never-created", "digest-key");
		const before = process.env.ENDO_DIGEST_KEY_FILE;
		process.env.ENDO_DIGEST_KEY_FILE = keyFile;
		const fetched = vi.spyOn(globalThis, "fetch");
		const a = baseline();
		const b = trajectory(FAKE, "tools-reordered");
		const environment = JSON.stringify(process.env);
		try {
			project(a, b);
			project(b, a, OTHER_KEY);
			expect(fetched).not.toHaveBeenCalled();
			expect(() => readFileSync(keyFile)).toThrow(/ENOENT/);
			expect(JSON.stringify(process.env)).toBe(environment);
		} finally {
			fetched.mockRestore();
			if (before === undefined) delete process.env.ENDO_DIGEST_KEY_FILE;
			else process.env.ENDO_DIGEST_KEY_FILE = before;
		}
		const source = readFileSync(join(REPO, "cockpit/projections/trajectory-comparison.ts"), "utf8");
		expect(source).not.toMatch(
			/from "node:(?:fs|os|child_process|net|http|https)|from "(?:\.\.\/)+(?:storage|adapters)\//,
		);
	});
});

describe("hostile producer text in names, digests and omitted facts", () => {
	const base = () => baseline();
	const lifecycleFacts = (facts: Record<string, unknown>): EndoTrajectoryV0 =>
		altered(base(), (body) => {
			body.layers.lifecycle.entries[1].facts = facts;
		});

	it("does not carry a credential-shaped or digest-shaped fact NAME, and counts it as omitted", () => {
		const credential = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
		const hexName = `h${"ab12".repeat(9)}`;
		const t = lifecycleFacts({ [credential]: true, AKIAIOSFODNN7EXAMPLE: { secret: 1 }, [hexName]: 2, fine: 3 });
		const result = project(base(), t);
		const out = serialized(result);
		for (const leak of [credential, "AKIAIOSFODNN7EXAMPLE", hexName]) expect(out, leak).not.toContain(leak);
		const facts = (result.layers.lifecycle as any).b.entry.facts;
		expect(facts.items.map((item: any) => item.path)).toEqual(["fine"]);
		expect(facts.omitted).toBe(3);
		expect(facts.omittedToken).toMatch(/^[0-9a-f]{64}$/);
		expect(validateEndoCockpitTrajectoryComparisonV0(JSON.parse(out))).not.toBeNull();
		// The validator itself refuses such a name arriving on the wire.
		const wire = JSON.parse(out);
		wire.layers.lifecycle.b.entry.facts.items.push({ path: credential, value: true });
		expect(validateEndoCockpitTrajectoryComparisonV0(wire)).toBeNull();
	});

	it.each([
		["uppercase hex", "AB".repeat(32)],
		["a prefixed sha256", `sha256:${"cd".repeat(32)}`],
		["a 40-hex digest", "ef".repeat(20)],
		["a 128-hex digest", "01".repeat(64)],
		["a base64 digest", "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="],
	])("shows %s only as a keyed token, in a fact and in a fingerprint flag", (_name, digest) => {
		const t = altered(base(), (body) => {
			body.layers.outcome.entries[0].cause = { ref: digest };
			body.environment.attachments[0].identityDigest = { status: "reported", value: digest };
		});
		const result = project(base(), t);
		const out = serialized(result);
		expect(out).not.toContain(digest);
		const cause = (result.layers.outcome as any).b.entry.cause.items[0].value;
		expect(cause.kind).toBe("token");
		const flag = result.flags.find((item) => item.kind === "runtime-fingerprint-differs")!;
		expect(flag.b.values[0]!.kind).toBe("token");
	});

	it("a DIVERGED result whose differences are all withheld still shows that the two sides differ", () => {
		const one = lifecycleFacts({ "has space": 1 });
		const two = lifecycleFacts({ "has space": 2 });
		const result = project(one, two);
		const lifecycle = result.layers.lifecycle as any;
		expect(lifecycle.status).toBe("DIVERGED");
		expect(lifecycle.a.entry.facts.omittedToken).not.toBe(lifecycle.b.entry.facts.omittedToken);
		const odd = altered(base(), (body) => {
			body.environment.attachments[0].digestKey = {
				status: "reported",
				value: { keyId: "installation-x", domain: "x" },
			};
			for (const entry of body.layers.toolCalls.entries) entry.argsDigest.value.keyId = "installation-x";
		});
		const other = altered(odd, (body) => {
			body.layers.toolCalls.entries[0].argsDigest.value.value = "11".repeat(32);
		});
		const calls = project(odd, other).layers.toolCalls as any;
		expect(calls.status).toBe("DIVERGED");
		expect(calls.a.entry.args.token).not.toBe(calls.b.entry.args.token);
	});
});

describe("refusals", () => {
	it("refuses a key a cockpit read does not admit, and a trajectory that is not a valid record", () => {
		const a = baseline();
		const unpinned = endoDigestKeyV0(Buffer.alloc(32, 0x07), "sk-abcdefghijklmnop", { public: true });
		expect(() => project(a, a, unpinned)).toThrow(/digest key/);
		const tampered = JSON.parse(JSON.stringify(a)) as EndoTrajectoryV0;
		(tampered.layers.outcome as any).entries[0].outcome = "failed";
		expect(() => project(a, tampered)).toThrow(/digest/);
		expect(() => project(tampered, a)).toThrow(/digest/);
		expect(() => project(a, { ...a, schemaVersion: "endo.trajectory.v2" } as any)).toThrow(/valid/);
	});

	it("pins the comparator's wording: a changed reason makes the projection refuse, never guess", () => {
		const source = readFileSync(join(REPO, "runtime/contracts/trajectory.ts"), "utf8");
		const body = source.slice(source.indexOf("function toolCallsAgainstInputs"), source.indexOf("function judge"));
		const written = [...body.matchAll(/reason:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) =>
			match[1]!.replace(/\\"/g, '"'),
		);
		expect(written.length).toBe(8);
		expect([...written].sort()).toEqual(Object.keys(ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0).sort());
		// The unverified-digest templates are matched by pattern; the comparator's own sentences still produce their codes.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the comparator's source text, searched for literally
		expect(source).toContain('no ${what} digest was recorded on ${both ? "either side" : "one side"}');
		expect(source).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the comparator's source text, searched for literally
			'different digest domains (${[a.value.keyId, b.value.keyId].sort().join(" and ")}); to compare across machines, share one key: ${CROSS_MACHINE_DOC}',
		);
		expect(source).toContain('const CROSS_MACHINE_DOC = "docs/trajectory.md#comparing-across-machines"');
	});

	it("covers the ordering codes the fixtures can reach", () => {
		const reached = new Set<string>();
		const seen = (a: EndoTrajectoryV0, b: EndoTrajectoryV0): void => {
			reached.add(project(a, b).toolCallsAgainstInputs.reason);
		};
		const base = baseline();
		seen(base, trajectory(FAKE, "baseline-again"));
		seen(base, trajectory(FAKE, "tool-args-differ"));
		seen(base, trajectory(FAKE, "other-digest-domain"));
		const unknownTurn = altered(trajectory(FAKE, "tool-args-differ"), (body) => {
			for (const entry of body.layers.toolCalls.entries) entry.turn = null;
			for (const entry of body.layers.toolResults.entries) entry.turn = null;
		});
		seen(
			altered(base, (body) => {
				for (const entry of body.layers.toolCalls.entries) entry.turn = null;
				for (const entry of body.layers.toolResults.entries) entry.turn = null;
			}),
			unknownTurn,
		);
		expect([...reached].sort()).toEqual(
			expect.arrayContaining(["calls-identical", "calls-unverified", "calls-diverged-results-identical"]),
		);
		for (const code of reached) expect(Object.values(ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0)).toContain(code);
	});
});

describe("the contract validator", () => {
	const good = () =>
		JSON.parse(serialized(project(trajectory(REAL, "completes"), trajectory(REAL, "stop-mid-turn")))) as any;
	const reject = (change: (record: any) => void): void => {
		const record = good();
		change(record);
		expect(validateEndoCockpitTrajectoryComparisonV0(record)).toBeNull();
	};

	it("accepts what the projection produces, for every committed pairing", () => {
		const names = [
			"baseline",
			"baseline-again",
			"tools-reordered",
			"tool-args-differ",
			"tool-result-differs",
			"tool-errors",
			"no-usage",
			"other-digest-domain",
			"other-fingerprint",
			"unknown-lifecycle",
		];
		for (const name of names)
			expect(
				validateEndoCockpitTrajectoryComparisonV0(
					JSON.parse(serialized(project(baseline(), trajectory(FAKE, name)))),
				),
				name,
			).not.toBeNull();
		expect(validateEndoCockpitTrajectoryComparisonV0(good())).not.toBeNull();
	});

	it("rejects an unexpected schema, projection or rules version, and any unknown field", () => {
		reject((r) => {
			r.schemaVersion = "endo.cockpit-trajectory-comparison.v1";
		});
		reject((r) => {
			r.projectionVersion = "cockpit-trajectory-comparison.1";
		});
		reject((r) => {
			r.comparisonRules = "trajectory-comparison.4";
		});
		reject((r) => {
			r.provenance = { a: { store: "/x" }, b: { store: "/y" } };
		});
		reject((r) => {
			r.layers.lifecycle.extra = 1;
		});
		reject((r) => {
			r.layers.timing.extra = 1;
		});
		reject((r) => delete r.keyId);
		reject((r) => {
			r.layers.tools = r.layers.toolCalls;
		});
	});

	it("rejects text the policy withholds, a malformed token, a foreign key id and an unknown code", () => {
		reject((r) => {
			r.layers.lifecycle.a.entry.facts.items[0].value = { kind: "text", text: "/home/someone/secret" };
		});
		reject((r) => {
			r.layers.lifecycle.a.entry.facts.items[0].value = { kind: "token", token: "abc" };
		});
		reject((r) => {
			r.a.eventsToken = "G".repeat(64);
		});
		reject((r) => {
			r.keyId = "sk-abcdefghijklmnop";
		});
		reject((r) => {
			r.toolCallsAgainstInputs.reason = "the calls caused it";
		});
		reject((r) => {
			r.a.session = "/etc/passwd";
		});
	});

	it("rejects states that contradict themselves", () => {
		reject((r) => {
			r.layers.lifecycle.commonPrefix = 0;
		});
		reject((r) => {
			r.layers.lifecycle.a = { present: false };
		});
		reject((r) => {
			r.layers.lifecycle.lengths = { a: 1, b: 1 };
		});
		reject((r) => {
			r.layers.toolCalls = {
				status: "UNAVAILABLE",
				sides: { a: null, b: null },
				unverified: [],
				lengths: { a: 1, b: 1 },
			};
		});
		reject((r) => {
			r.layers.toolCalls = {
				status: "UNAVAILABLE",
				sides: { a: null, b: null },
				unverified: [],
				lengths: null,
			};
		});
		reject((r) => {
			r.layers.toolCalls = { status: "EXACT", length: -1 };
		});
		reject((r) => {
			r.layers.usage = {
				status: "DELTAS",
				basis: "observer-measured",
				direction: "b-minus-a",
				runs: [],
				totals: { status: "UNAVAILABLE" },
			};
		});
		reject((r) =>
			r.layers.timing.runs.push({ run: 99, present: { a: true, b: true }, wallMs: { status: "DELTA", value: 0 } }),
		);
		reject((r) => r.flags.push({ kind: "invented-flag", a: { values: [] }, b: { values: [] } }));
	});
	it("rejects fields that contradict each other across the record", () => {
		reject((r) => {
			r.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput = false;
			r.toolCallsAgainstInputs.reason = "calls-identical";
		});
		reject((r) => {
			r.toolCallsAgainstInputs.firstDivergentResult = { index: 9, run: 1, turn: 1 };
		});
		reject((r) => {
			r.layers.toolCalls = {
				status: "UNAVAILABLE",
				sides: { a: null, b: null },
				unverified: [
					{ index: 999, reason: { code: "digest-not-recorded", sides: "one" } },
					{ index: 999, reason: { code: "digest-not-recorded", sides: "one" } },
				],
				lengths: { a: 0, b: 0 },
			};
		});
		reject((r) => {
			r.layers.timing.runs.push({
				run: r.layers.timing.runs.length + 1,
				present: { a: false, b: false },
				wallMs: { status: "UNAVAILABLE" },
			});
		});
		reject((r) => {
			r.layers.usage.totals = { status: "DELTAS", fields: {} };
		});
		reject((r) => {
			r.flags.push({ kind: "mapping-differs", a: { values: [] }, b: { values: [] } });
		});
		reject((r) => {
			r.layers.lifecycle.a.entry.facts.omittedToken = "00".repeat(32);
		});
	});
});

// Review regressions: altered fixtures remain sealed valid trajectories; wire mutations test only what the
// presentation can establish internally, without consulting a store or changing the comparator's verdicts.
describe("comparison review regressions", () => {
	it.each(["sha256=", "SHA256=", "sha256 = ", "sha256:", "sha256-"])(
		"withholds %s digests in facts, identities, models, tool names and reasons",
		(prefix) => {
			const a = baseline();
			const marker = `${prefix}${"ab".repeat(32)}`;
			const b = altered(a, (body) => {
				body.layers.lifecycle.entries[0].facts = { proof: marker };
				body.layers.outcome.entries[0].cause = { proof: marker };
				body.layers.outcome.entries[0].stopReason = { status: "reported", value: marker };
				body.layers.toolCalls.entries[0].name = { status: "reported", value: marker };
				body.environment.reportedModels = [marker];
				body.environment.attachments[0].identityDigest = { status: "reported", value: marker };
				body.environment.attachments[0].userConfigurationDigest = { status: "reported", value: marker };
			});
			const result = project(a, b);
			expect(serialized(result)).not.toContain(marker);
			expect(serialized(result)).not.toContain("ab".repeat(32));
			expect(project(a, b)).toEqual(result);
		},
	);

	it.each([
		[{}, []],
		[{ details: {} }, {}],
		[{ details: {} }, { details: [] }],
		[{ details: [[], {}] }, { details: [{}, []] }],
	])("keeps empty-container differences in lifecycle and outcome facts (%j / %j)", (left, right) => {
		const base = baseline();
		const withFacts = (facts: unknown) =>
			altered(base, (body) => {
				body.layers.lifecycle.entries[0].facts = { data: facts };
				body.layers.outcome.entries[0].cause = facts;
			});
		const a = withFacts(left),
			b = withFacts(right);
		for (const layer of ["lifecycle", "outcome"] as const) {
			const result = project(a, b).layers[layer] as any;
			expect(result.status).toBe("DIVERGED");
			expect(result.a.entry).not.toEqual(result.b.entry);
		}
	});

	it.each([17, 40])("presents all %i distinct model and attachment flag values", (count) => {
		const a = baseline();
		const b = altered(a, (body) => {
			body.environment.reportedModels = Array.from({ length: count }, (_, i) => `model-${i}`);
			const attachment = body.environment.attachments[0];
			body.environment.attachments = Array.from({ length: count }, (_, i) => ({
				...attachment,
				mapping: { status: "reported", value: `mapping-${i}` },
			}));
		});
		const result = project(a, b);
		for (const kind of ["reported-model-differs", "mapping-differs"]) {
			const flag = result.flags.find((flag) => flag.kind === kind) as any;
			expect(flag, kind).toBeDefined();
			expect(flag.b.values).toHaveLength(count);
		}
	});

	it.each(["lifecycle", "toolCalls", "toolResults", "outcome"] as const)(
		"rejects identical presented slots claiming %s divergence, regardless of object-key order",
		(layer) => {
			const a = baseline();
			const b = altered(a, (body) => {
				body.layers.lifecycle.entries[0].facts = { changed: true };
				body.layers.toolCalls.entries[0].name = { status: "reported", value: "other" };
				body.layers.toolResults.entries[0].name = { status: "reported", value: "other" };
				body.layers.outcome.entries[0].turns += 1;
			});
			const result = project(a, b) as any;
			const entry = result.layers[layer].a.entry;
			result.layers[layer].b.entry = Object.fromEntries(Object.entries(entry).reverse());
			expect(validateEndoCockpitTrajectoryComparisonV0(result)).toBeNull();
		},
	);

	it.each(["usage", "timing"] as const)("refuses numeric %s deltas for either missing side", (layer) => {
		for (const missing of ["a", "b"] as const) {
			const result = project(baseline(), baseline()) as any;
			const run = result.layers[layer].runs[0];
			run.present[missing] = false;
			expect(validateEndoCockpitTrajectoryComparisonV0(result)).toBeNull();
			run[layer === "usage" ? "tokens" : "wallMs"] = { status: "UNAVAILABLE" };
			expect(validateEndoCockpitTrajectoryComparisonV0(result)).not.toBeNull();
		}
	});

	function callsDiffer(resultsUnavailable: boolean) {
		const a = baseline();
		const b = altered(a, (body) => {
			body.layers.toolCalls.entries[0].name = { status: "reported", value: "changed" };
			if (resultsUnavailable) body.layers.toolResults = { status: "UNAVAILABLE", reason: "not observed" };
		});
		return project(a, b);
	}
	it.each([false, true])("binds the ordering reason to the actual result verdict (unavailable=%s)", (unavailable) => {
		const result = callsDiffer(unavailable);
		result.toolCallsAgainstInputs.reason = unavailable
			? "calls-diverged-results-identical"
			: "results-unavailable-or-unverified";
		result.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput = unavailable ? false : null;
		expect(validateEndoCockpitTrajectoryComparisonV0(result)).toBeNull();
	});

	function ordered(
		callRun: number | null,
		callTurn: number | null,
		resultRun: number | null,
		resultTurn: number | null,
	) {
		const source = baseline();
		const a = altered(source, (body) => {
			body.layers.toolCalls.entries[0].run = callRun;
			body.layers.toolCalls.entries[0].turn = callTurn;
			body.layers.toolResults.entries[0].run = resultRun;
			body.layers.toolResults.entries[0].turn = resultTurn;
		});
		const b = altered(a, (body) => {
			body.layers.toolCalls.entries[0].name = { status: "reported", value: "other" };
			body.layers.toolResults.entries[0].name = { status: "reported", value: "other" };
		});
		return project(a, b);
	}
	it.each([
		[2, 1, 1, 1, "call-in-later-turn-than-divergent-result"],
		[1, 2, 1, 1, "call-in-later-turn-than-divergent-result"],
		[1, 1, 1, 1, "call-not-after-divergent-result"],
		[1, 1, 2, 1, "call-not-after-divergent-result"],
		[null, 1, 1, 1, "order-unknown"],
		[1, 1, 1, null, "order-unknown"],
	] as const)("validates presented coordinates and ordering for %s/%s vs %s/%s", (cr, ct, rr, rt, reason) => {
		const result = ordered(cr, ct, rr, rt);
		expect(result.toolCallsAgainstInputs.reason).toBe(reason);
		const changed = structuredClone(result);
		changed.toolCallsAgainstInputs.firstDivergentCall!.run = 99;
		expect(validateEndoCockpitTrajectoryComparisonV0(changed)).toBeNull();
		const lie = structuredClone(result);
		lie.toolCallsAgainstInputs.reason =
			reason === "order-unknown" ? "call-not-after-divergent-result" : "order-unknown";
		lie.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput = reason === "order-unknown" ? false : null;
		expect(validateEndoCockpitTrajectoryComparisonV0(lie)).toBeNull();
	});
	it("refuses a coherent ordering lie even if the positions and both entries are changed together", () => {
		const result = ordered(1, 2, 1, 1) as any;
		result.toolCallsAgainstInputs.firstDivergentCall.turn = 1;
		result.layers.toolCalls.a.entry.turn = 1;
		result.layers.toolCalls.b.entry.turn = 1;
		expect(validateEndoCockpitTrajectoryComparisonV0(result)).toBeNull();
	});

	it.each([
		"not-an-endo-id",
		"endo.event.x",
		"endo.session.safe",
		`endo.session.withheld-${"ab".repeat(16)}`,
		"/private/session",
	])("presents valid arbitrary source session %s in the session namespace", (session) => {
		const a = altered(baseline(), (body) => {
			body.source.session = session;
		});
		const result = project(a, a);
		expect(result.a.session).toMatch(/^endo\.session\./);
		expect(result.a.session).toBe(result.b.session);
		expect(project(a, a)).toEqual(result);
		if (session !== "endo.session.safe") expect(result.a.session).not.toBe(session);
	});
	it.each([
		["lifecycle.session-started", false],
		["lifecycle.future", true],
	] as const)(
		"preserves source recognition independently of the presenter's vocabulary: %s/%s",
		(kind, recognized) => {
			const base = baseline();
			const a = altered(base, (body) => {
				body.layers.lifecycle.entries[0] = { kind, recognized, facts: { value: 1 } };
			});
			const b = altered(a, (body) => {
				body.layers.lifecycle.entries[0].facts.value = 2;
			});
			const result = project(a, b).layers.lifecycle as any;
			expect(result.a.entry.recognized).toBe(recognized);
			expect(result.b.entry.recognized).toBe(recognized);
			expect(result.status).toBe("DIVERGED");
		},
	);
});

// The importer remains outside the bridge. Only these tests build shared trajectories from sanitised persisted evidence.
describe("comparison presentation of DSH cold-import trajectories", () => {
	const cases = ["tool-read", "no-key-error", "crash-killed", "crash-resumed", "stub-retry"] as const;
	function dsh(name: string, key = OTHER_KEY) {
		const store = createEndoEventStoreV0();
		const bytes = readFileSync(join(REPO, `research/dsh-native/fixtures/real/${name}.events.jsonl`));
		const report = importDshSessionBytesV0(bytes, store, { digestKey: key, now: () => "2026-10-24T00:00:00Z" });
		expect(report.refusals).toEqual([]);
		return projectDshTrajectoryV0(store.page({ limit: 10000 }).events, { session: "session-1", store: STORE_LABEL });
	}
	it.each(cases)("%s preserves comparator verdicts in every DSH pairing and mixed Pi pairing", (name) => {
		const a = dsh(name);
		for (const b of [...cases.map((other) => dsh(other)), baseline()]) {
			const result = project(a, b);
			const direct = compareEndoTrajectoriesV0(a, b);
			for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
				expect(result.layers[layer].status).toBe(direct.layers[layer].status);
			expect(result.flags.map((flag) => flag.kind)).toEqual(direct.flags.map((flag) => flag.kind));
			expect(serialized(result)).not.toContain(STORE_LABEL);
			for (const t of [a, b]) {
				expect(serialized(result)).not.toContain(t.digest);
				expect(serialized(result)).not.toContain(t.source.eventsSha256);
			}
		}
	});
	it("keeps absent DSH usage/timing, open turns and recovery-written outcomes distinct", () => {
		const killed = dsh("crash-killed"),
			resumed = dsh("crash-resumed");
		const result = project(killed, resumed);
		expect(result.layers.usage.status).toBe("UNAVAILABLE");
		expect(result.layers.timing.status).toBe("UNAVAILABLE");
		expect(result.layers.outcome).toMatchObject({
			status: "DIVERGED",
			a: { entry: { outcome: "open", turns: 1 } },
			b: { entry: { outcome: "unclassified" } },
		});
		const otherDomain = project(
			dsh("tool-read"),
			dsh("tool-read", endoDigestKeyV0(Buffer.alloc(32, 77), "other-dsh-domain")),
		);
		expect(otherDomain.layers.toolCalls.status).toBe("UNAVAILABLE");
		expect(otherDomain.layers.toolResults.status).toBe("UNAVAILABLE");
	});
});
