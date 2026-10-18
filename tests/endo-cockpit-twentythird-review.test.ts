// PR #57 review round 23: the reserved `withheld-` namespace belongs to the presentation layer. A value on the wire is an
// admitted SOURCE value or the exact shape of what the generator emits in its place (cockpitAliasesV0): an identifier alias
// `endo.<namespace>.withheld-<32 hex>`, a bare kind alias `withheld-<32 hex>`, and a timeline event kind `other.<kind alias>`.
// Shape is not authentication: a token of the right shape that no key made cannot be told from one that it did.
//
// The third finding (unavailable claims for identifier fields) is NOT implemented: the projector emits that claim for an
// identifier of another namespace or one too long to present, from sources the durable store accepts, so refusing it would
// refuse canonical output. The tests below pin that, with a real store.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cockpitAliasesV0 } from "../cockpit/projections/common.ts";
import {
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitCategoryOfV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0,
	endoCockpitUnavailableAdmittedV0,
	isEndoCockpitGeneratedIdAliasV0,
	isEndoCockpitGeneratedKindAliasV0,
	isEndoCockpitPublicEventKindV0,
	isEndoCockpitPublicIdV0,
	isEndoCockpitPublicKindV0,
	isEndoCockpitSourceIdAdmittedV0,
	isEndoCockpitSourceKindAdmittedV0,
} from "../protocol/cockpit-fields.ts";
import { ENDO_IDENTIFIER_KINDS_V0, parseEndoIdentifierV0 } from "../protocol/identity.ts";
import { event, ingestAll, removeTempRoots, specimenRecords, tempRoot } from "./cockpit-fixtures.ts";
import { OTHER_KEY, readEndoCockpitSnapshotV0, readEndoCockpitTimelineV0, TEST_KEY } from "./cockpit-keyed.ts";
import { capabilitiesOf, identityOf, mutated, timelineOf } from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const HEX = "0123456789abcdef0123456789abcdef";
const alias = cockpitAliasesV0(TEST_KEY);
const valid = {
	timeline: (value: unknown) => validateEndoCockpitSessionTimelineV0(value) !== null,
	snapshot: (value: unknown) => validateEndoCockpitSnapshotV0(value) !== null,
	identity: (value: unknown) => validateEndoCockpitRuntimeIdentityV0(value) !== null,
	capabilities: (value: unknown) => validateEndoCockpitCapabilityStateV0(value) !== null,
};
/** Every occurrence of a string in a projection, replaced: so a rejection cannot be a mismatch between two copies of one id. */
const renamed = <T>(value: T, from: string, to: string): T =>
	JSON.parse(JSON.stringify(value).split(JSON.stringify(from)).join(JSON.stringify(to)));

// ---------------------------------------------------------------------------------------------------------------
// 1. Identifiers
// ---------------------------------------------------------------------------------------------------------------

describe("a reserved identifier segment is a generated alias in its exact form, or it is refused (P2)", () => {
	it("admits the canonical alias in every identifier namespace, and ordinary source identifiers", () => {
		for (const namespace of ENDO_IDENTIFIER_KINDS_V0) {
			const generated = `endo.${namespace}.withheld-${HEX}`;
			expect(isEndoCockpitPublicIdV0(generated, namespace), generated).toBe(true);
			expect(isEndoCockpitGeneratedIdAliasV0(generated, namespace), generated).toBe(true);
			// ... and it is never a SOURCE value: nothing a source wrote passes through as an alias.
			expect(isEndoCockpitSourceIdAdmittedV0(generated, namespace), generated).toBe(false);
			expect(isEndoCockpitPublicIdV0(`endo.${namespace}.pi-entry.1`, namespace)).toBe(true);
			expect(isEndoCockpitSourceIdAdmittedV0(`endo.${namespace}.pi-entry.1`, namespace)).toBe(true);
			expect(isEndoCockpitGeneratedIdAliasV0(`endo.${namespace}.pi-entry.1`, namespace)).toBe(false);
		}
		// The namespace is checked, as before.
		expect(isEndoCockpitPublicIdV0(`endo.session.withheld-${HEX}`, "event")).toBe(false);
		expect(isEndoCockpitPublicIdV0(`endo.session.withheld-${HEX}`)).toBe(true);
	});

	const refused: [string, string][] = [
		["a reserved segment that is no token (the finding's example)", "endo.session.withheld-not-a-token"],
		["31 hex digits", `endo.session.withheld-${HEX.slice(1)}`],
		["33 hex digits", `endo.session.withheld-${HEX}0`],
		["64 hex digits (a whole keyed token)", `endo.session.withheld-${HEX}${HEX}`],
		["uppercase hex", `endo.session.withheld-${HEX.toUpperCase()}`],
		["a non-hex character", `endo.session.withheld-${HEX.replace("0", "g")}`],
		["an empty token", "endo.session.withheld-"],
		["a segment before the alias", `endo.session.x.withheld-${HEX}`],
		["a segment after the alias", `endo.session.withheld-${HEX}.x`],
		["two aliases", `endo.session.withheld-${HEX}.withheld-${HEX}`],
		["a second reserved segment that is no token", `endo.session.withheld-${HEX}.withheld-x`],
		["a prefix on the reserved segment's token", `endo.session.withheld-x-${HEX}`],
	];
	for (const [label, value] of refused)
		it(`refuses ${label}`, () => {
			expect(isEndoCockpitPublicIdV0(value, "session"), value).toBe(false);
			expect(isEndoCockpitGeneratedIdAliasV0(value, "session"), value).toBe(false);
			expect(isEndoCockpitSourceIdAdmittedV0(value, "session"), value).toBe(false);
		});

	it("admits reserved-looking strings that are not in the namespace", () => {
		for (const local of [
			"xwithheld-abc",
			"withheld",
			"withheldx",
			"x-withheld-abc",
			"a.withheld",
			"withheld-abc".replace("-", ""),
		])
			expect(isEndoCockpitPublicIdV0(`endo.session.${local}`, "session"), local).toBe(true);
	});

	it("refuses an alias-shaped content-addressed id and text the policy flags, as before", () => {
		expect(isEndoCockpitPublicIdV0(`endo.evidence.pi-fingerprint.${"a".repeat(64)}`)).toBe(false);
		expect(isEndoCockpitPublicIdV0(`endo.evidence.sk-canarysecretcanarysecret`)).toBe(false);
		expect(isEndoCockpitPublicIdV0(`endo.evidence.${"a".repeat(65)}`)).toBe(false);
	});

	it("rejects the finding's counterexample on a timeline: both the entry's and the summary's session id", () => {
		const base = timelineOf(event("agent.prompt-accepted"));
		const from = base.entries[0]!.sessionId!;
		const control = renamed(base, from, "endo.session.renamed.1");
		expect(valid.timeline(control)).toBe(true); // any other rename holds, so the next rejections are the alias policy's
		expect(valid.timeline(renamed(base, from, `endo.session.withheld-${HEX}`))).toBe(true);
		expect(valid.timeline(renamed(base, from, "endo.session.withheld-not-a-token"))).toBe(false);
		for (const [label, value] of refused) expect(valid.timeline(renamed(base, from, value)), label).toBe(false);
	});

	it("refuses a malformed reserved segment in every identifier a timeline carries", () => {
		const log = timelineOf({
			...event("tool.finished", {}, { id: "endo.event.plain.2", session: "endo.session.s.1" }),
			coordinates: { sessionId: "endo.session.s.1", runId: "endo.run.r.1", experimentId: "endo.experiment.e.1" },
			derivedFrom: ["endo.event.plain.1"],
		});
		const entry = log.entries[0]!;
		expect([entry.eventId, entry.sessionId, entry.runId, entry.experimentId, ...entry.derivedFrom]).toEqual([
			"endo.event.plain.2",
			"endo.session.s.1",
			"endo.run.r.1",
			"endo.experiment.e.1",
			"endo.event.plain.1",
		]);
		expect(valid.timeline(log)).toBe(true);
		for (const [from, namespace] of [
			[entry.runId!, "run"],
			[entry.experimentId!, "experiment"],
			[entry.derivedFrom[0]!, "event"],
		] as const) {
			expect(valid.timeline(renamed(log, from, `endo.${namespace}.withheld-${HEX}`)), from).toBe(true);
			expect(valid.timeline(renamed(log, from, `endo.${namespace}.withheld-not-a-token`)), from).toBe(false);
		}
		// (The event id is also the watermark's last id and the summaries': every copy is renamed together.)
		expect(valid.timeline(renamed(log, entry.eventId, `endo.event.withheld-${HEX}`))).toBe(true);
		expect(valid.timeline(renamed(log, entry.eventId, "endo.event.withheld-not-a-token"))).toBe(false);
	});

	it("refuses a malformed reserved segment in registry identifiers, wherever the id is repeated", () => {
		const identity = identityOf(specimenRecords());
		const id = identity.current!.id;
		expect(id).toMatch(/^endo\.evidence\.withheld-[0-9a-f]{32}$/); // the specimen's id is content-addressed: it is presented as an alias
		expect(valid.identity(renamed(identity, id, "endo.evidence.renamed.1"))).toBe(true);
		expect(valid.identity(renamed(identity, id, `endo.evidence.withheld-${"f".repeat(32)}`))).toBe(true);
		for (const [label, value] of refused)
			expect(valid.identity(renamed(identity, id, value.replace("endo.session.", "endo.evidence."))), label).toBe(
				false,
			);
		const capabilities = capabilitiesOf(specimenRecords());
		const evidenceId = capabilities.capabilities.find((c) => c.evidence !== null)!.evidence!.id;
		expect(valid.capabilities(renamed(capabilities, evidenceId, "endo.evidence.withheld-not-a-token"))).toBe(false);
		expect(valid.capabilities(renamed(capabilities, evidenceId, `endo.evidence.withheld-${"e".repeat(32)}`))).toBe(
			true,
		);
	});

	it("re-aliases a source identifier in the namespace, identically everywhere it is repeated, and the result validates", () => {
		const source = "endo.session.withheld-not-a-token";
		const log = timelineOf(
			event("agent.prompt-accepted", {}, { session: source }),
			event("agent.settled", {}, { session: source }),
		);
		const expected = alias.id(source);
		expect(expected).toMatch(/^endo\.session\.withheld-[0-9a-f]{32}$/);
		expect(expected).not.toBe(source);
		expect(log.entries.map((entry) => entry.sessionId)).toEqual([expected, expected]);
		expect(log.sessions.map((session) => session.sessionId)).toEqual([expected]);
		expect(valid.timeline(log)).toBe(true);
		// Deterministic under one key, another under another; the source value itself never appears.
		expect(JSON.stringify(timelineOf(event("agent.prompt-accepted", {}, { session: source })))).not.toContain(source);
		expect(cockpitAliasesV0(OTHER_KEY).id(source)).not.toBe(expected);
		// A source identifier that already looks like a generated alias is aliased too: no source value is ever a generated one.
		const lookalike = `endo.session.withheld-${HEX}`;
		expect(alias.id(lookalike)).not.toBe(lookalike);
		expect(timelineOf(event("agent.prompt-accepted", {}, { session: lookalike })).entries[0]!.sessionId).toBe(
			alias.id(lookalike),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Kinds
// ---------------------------------------------------------------------------------------------------------------

describe("a reserved kind segment is a generated alias in its context's exact form, or it is refused (P2)", () => {
	it("tells the three contexts apart", () => {
		const bare = `withheld-${HEX}`;
		const wrapped = `other.${bare}`;
		// A bare label (runtime family, capability name): admitted as written or the bare alias.
		expect(isEndoCockpitPublicKindV0("pi")).toBe(true);
		expect(isEndoCockpitPublicKindV0("filesystem.read")).toBe(true);
		expect(isEndoCockpitPublicKindV0(bare)).toBe(true);
		expect(isEndoCockpitPublicKindV0(wrapped)).toBe(false);
		// A timeline event kind: admitted as written, or `other.` and the alias; never the bare alias.
		expect(isEndoCockpitPublicEventKindV0("agent.prompt-accepted")).toBe(true);
		expect(isEndoCockpitPublicEventKindV0("something.new")).toBe(true);
		expect(isEndoCockpitPublicEventKindV0(wrapped)).toBe(true);
		expect(isEndoCockpitPublicEventKindV0(bare)).toBe(false);
		// A source kind is never an alias, whichever form it takes.
		for (const kind of [bare, wrapped]) expect(isEndoCockpitSourceKindAdmittedV0(kind), kind).toBe(false);
		expect(isEndoCockpitGeneratedKindAliasV0(bare)).toBe(true);
		expect(isEndoCockpitGeneratedKindAliasV0(wrapped)).toBe(false);
	});

	const labels: [string, string][] = [
		["a token that is no token", "withheld-not-a-token"],
		["a dotted prefix before the alias", `foo.withheld-${HEX}`],
		["a dotted prefix before a malformed one (the finding's example)", "foo.withheld-not-a-token"],
		["a segment after the alias", `withheld-${HEX}.foo`],
		["two aliases", `withheld-${HEX}.withheld-${HEX}`],
		["31 hex digits", `withheld-${HEX.slice(1)}`],
		["33 hex digits", `withheld-${HEX}0`],
		["uppercase hex", `withheld-${HEX.toUpperCase()}`],
		["a non-hex character", `withheld-${HEX.replace("0", "g")}`],
		["the event form, in a bare label's place", `other.withheld-${HEX}`],
	];
	for (const [label, value] of labels)
		it(`refuses ${label} as a runtime family and as a capability name`, () => {
			const identity = identityOf(specimenRecords());
			expect(valid.identity(identity)).toBe(true);
			const family = mutated(identity, (copy) => {
				copy.runtime = { ...copy.runtime, value };
			});
			expect(valid.identity(family), `family ${value}`).toBe(false);
			const capabilities = capabilitiesOf(specimenRecords());
			const name = mutated(capabilities, (copy) => {
				copy.capabilities[0].capability = value;
			});
			expect(valid.capabilities(name), `capability ${value}`).toBe(false);
			expect(isEndoCockpitPublicKindV0(value), value).toBe(false);
		});

	it("admits ordinary and aliased runtime families and capability names", () => {
		const identity = identityOf(specimenRecords());
		for (const family of ["pi", "acp.omp", `withheld-${HEX}`, "xwithheld-a"]) {
			const named = mutated(identity, (copy) => {
				copy.runtime = { ...copy.runtime, value: family };
			});
			expect(valid.identity(named), family).toBe(true);
		}
		const capabilities = capabilitiesOf(specimenRecords());
		for (const name of ["filesystem.read", `withheld-${HEX}`, "a.xwithheld-b"])
			expect(
				valid.capabilities(
					mutated(capabilities, (copy) => {
						copy.capabilities[0].capability = name;
					}),
				),
				name,
			).toBe(true);
	});

	const eventKinds: [string, string][] = [
		["a token that is no token", "other.withheld-not-a-token"],
		["a prefix that is not `other`", `foo.withheld-${HEX}`],
		["a prefix that is a category", `agent.withheld-${HEX}`],
		["a segment after the alias", `other.withheld-${HEX}.x`],
		["two aliases", `other.withheld-${HEX}.withheld-${HEX}`],
		["`other` twice", `other.other.withheld-${HEX}`],
		["31 hex digits", `other.withheld-${HEX.slice(1)}`],
		["uppercase hex", `other.withheld-${HEX.toUpperCase()}`],
		["the bare alias", `withheld-${HEX}`],
	];
	for (const [label, value] of eventKinds)
		it(`refuses ${label} as a timeline event kind`, () => {
			// A base the projector made for a kind it had to alias: category "other", flagged unrecognized.
			const base = timelineOf(event("sk-canarysecretcanarysecret.step", { a: 1 }));
			expect(base.entries[0]!.kind).toMatch(/^other\.withheld-[0-9a-f]{32}$/);
			expect(valid.timeline(base)).toBe(true);
			const forged = mutated(base, (copy) => {
				copy.entries[0].kind = value;
				copy.entries[0].category = endoCockpitCategoryOfV0(value);
			});
			expect(valid.timeline(forged), value).toBe(false);
			expect(isEndoCockpitPublicEventKindV0(value), value).toBe(false);
		});

	it("keeps recognized and unrecognized event kinds, their categories and flags", () => {
		const log = timelineOf(
			event("agent.prompt-accepted"),
			event("brand.new-kind", { a: 1 }),
			event("sk-canarysecretcanarysecret.step", { a: 1 }),
			event("Not.A.Kind"),
		);
		expect(log.entries.map((entry) => [entry.kind.replace(/[0-9a-f]{32}$/, "<alias>"), entry.category])).toEqual([
			["agent.prompt-accepted", "agent"],
			["brand.new-kind", "other"],
			["other.withheld-<alias>", "other"],
			["other.withheld-<alias>", "other"],
		]);
		expect(log.entries.map((entry) => entry.flags.includes("unrecognized"))).toEqual([false, true, true, true]);
		expect(valid.timeline(log)).toBe(true);
	});

	it("an attachment is never aliased: a bare alias is refused as one, in a source and in a reference", () => {
		const identity = identityOf(specimenRecords());
		const name = `withheld-${HEX}`;
		const sourced = renamed(identity, identity.source.attachment, name);
		expect(valid.identity(sourced)).toBe(false);
		expect(valid.identity(renamed(identity, identity.source.attachment, "pi.renamed"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The generator and the predicates agree
// ---------------------------------------------------------------------------------------------------------------

describe("what the generator emits is exactly what the wire admits", () => {
	const hostileIds = [
		"endo.event.plain.1",
		"endo.event.Tok_one",
		"endo.event.withheld-abc",
		`endo.event.withheld-${HEX}`,
		`endo.session.a.withheld-${HEX}.b`,
		`endo.evidence.pi-fingerprint.${"a".repeat(64)}`,
		"endo.evidence.sk-canarysecretcanarysecret",
		`endo.tool.${"a".repeat(65)}`,
		`endo.model.${"a".repeat(256)}`,
		"endo.node.UPPER",
		"endo.node.unicode-é",
		"endo.node.a..b",
		"endo.unknown.x",
		"not-an-id",
		"",
		"endo.",
		"endo.run.",
	];
	const hostileKinds = [
		"pi",
		"acp.omp",
		"filesystem.read",
		"withheld-abc",
		`withheld-${HEX}`,
		`a.withheld-${HEX}`,
		`other.withheld-${HEX}`,
		"sk-canarysecretcanarysecret",
		"Not.A.Kind",
		"a..b",
		"",
		"x".repeat(129),
		"/home/alice/pi",
		"lifecycle.session-started",
		"brand.new-kind",
	];

	it("every identifier alias is a public identifier of the generated form; an identifier passes through exactly when admitted", () => {
		for (const id of hostileIds) {
			const shown = alias.id(id);
			expect(isEndoCockpitPublicIdV0(shown), `${id} -> ${shown}`).toBe(true);
			expect(shown === id, id).toBe(isEndoCockpitSourceIdAdmittedV0(id));
			if (shown !== id) {
				expect(isEndoCockpitGeneratedIdAliasV0(shown), shown).toBe(true);
				expect(shown).toMatch(/^endo\.[a-z]+\.withheld-[0-9a-f]{32}$/);
				expect(parseEndoIdentifierV0(shown)!.kind).toBe(parseEndoIdentifierV0(id)?.kind ?? "evidence");
			}
			expect(isEndoCockpitPublicIdV0(shown, parseEndoIdentifierV0(shown)!.kind)).toBe(true);
			expect(cockpitAliasesV0(TEST_KEY).id(id)).toBe(shown);
		}
	});

	it("every kind alias is a public kind, and its event form a public event kind; a kind passes through exactly when admitted", () => {
		for (const kind of hostileKinds) {
			const shown = alias.kind(kind);
			expect(isEndoCockpitPublicKindV0(shown), `${kind} -> ${shown}`).toBe(true);
			expect(shown === kind, kind).toBe(isEndoCockpitSourceKindAdmittedV0(kind));
			if (shown !== kind) expect(shown).toMatch(/^withheld-[0-9a-f]{32}$/);
			// What the timeline projector does with an event kind: any the store could hold, malformed ones included (an event
			// kind has two segments or more, so a one-segment kind admitted as written is no event's and is not offered).
			if (kind.includes(".") || !isEndoCockpitSourceKindAdmittedV0(kind)) {
				const entry = timelineOf(event(kind.length === 0 ? "x.y" : kind, {})).entries[0]!;
				expect(isEndoCockpitPublicEventKindV0(entry.kind), `${kind} -> ${entry.kind}`).toBe(true);
			}
		}
	});

	it("canonical projector output passes every public validator", () => {
		const log = timelineOf(
			event("agent.prompt-accepted", {}, { session: "endo.session.withheld-not-a-token", id: "endo.event.Tok_one" }),
			event("sk-canarysecretcanarysecret.step", { a: 1 }, { session: "endo.session.withheld-not-a-token" }),
		);
		expect(valid.timeline(log)).toBe(true);
		expect(valid.identity(identityOf(specimenRecords()))).toBe(true);
		expect(valid.capabilities(capabilitiesOf(specimenRecords()))).toBe(true);
		const records = specimenRecords();
		const odd = { ...structuredClone(records.state[0]!) };
		odd.capabilities[0]!.capability = "sk-canarysecretcanarysecret";
		expect(valid.capabilities(capabilitiesOf({ ...records, state: [odd] }))).toBe(true);
		const family = { ...structuredClone(records.fingerprint[0]!), runtime: `acp.withheld-${HEX}` };
		expect(valid.identity(identityOf({ ...records, fingerprint: [family] }))).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. An independent model of the grammar, over every combination of a small pool
// ---------------------------------------------------------------------------------------------------------------

describe("the predicates agree with an independent restatement of the grammar", () => {
	// Restated from the documented grammar, not from the implementation: a segment is lowercase alphanumerics with single
	// inner hyphens, at most 64 characters; the reserved ones begin `withheld-`; the generated one is `withheld-` + 32 hex.
	const pool = [
		"a",
		"b1",
		"x-y",
		"withheld",
		"xwithheld-a",
		"withheld-a",
		"withheld-not-a-token",
		`withheld-${HEX}`,
		`withheld-${HEX.slice(1)}`,
		`withheld-${HEX}0`,
		`withheld-${HEX.toUpperCase()}`,
		`withheld-${HEX.replace("0", "g")}`,
		"withheld-",
		"Upper",
		"",
	];
	const shapeOk = (segment: string) => segment.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment);
	const reserved = (segment: string) => segment.startsWith("withheld-");
	const generated = (segment: string) => /^withheld-[0-9a-f]{32}$/.test(segment);

	function combos(max: number): string[][] {
		const out: string[][] = [];
		const grow = (prefix: string[]) => {
			if (prefix.length > 0) out.push(prefix);
			if (prefix.length < max) for (const segment of pool) grow([...prefix, segment]);
		};
		grow([]);
		return out;
	}
	const all = combos(3);

	it("identifiers: every 1 to 3 segment local part, in every namespace", () => {
		expect(all.length).toBe(15 + 15 ** 2 + 15 ** 3);
		for (const namespace of ENDO_IDENTIFIER_KINDS_V0) {
			for (const segments of all) {
				const value = `endo.${namespace}.${segments.join(".")}`;
				const shaped = segments.every(shapeOk);
				const anyReserved = segments.some(reserved);
				const exactlyGenerated = segments.length === 1 && generated(segments[0]!);
				const wantSource = shaped && !anyReserved;
				const wantGenerated = shaped && exactlyGenerated;
				expect(isEndoCockpitSourceIdAdmittedV0(value, namespace), value).toBe(wantSource);
				expect(isEndoCockpitGeneratedIdAliasV0(value, namespace), value).toBe(wantGenerated);
				expect(isEndoCockpitPublicIdV0(value, namespace), value).toBe(wantSource || wantGenerated);
				// Exclusive: nothing is both a source value and a generated one.
				expect(
					isEndoCockpitSourceIdAdmittedV0(value, namespace) && isEndoCockpitGeneratedIdAliasV0(value, namespace),
				).toBe(false);
			}
		}
	});

	it("kinds: every 1 to 3 segment dotted string, as a bare label and as an event kind", () => {
		const kindShape = (segment: string) => /^[a-z][a-z0-9-]*$/.test(segment);
		for (const segments of all) {
			const value = segments.join(".");
			const shaped = value.length <= 128 && segments.every(kindShape);
			const anyReserved = segments.some(reserved);
			const wantSource = shaped && !anyReserved;
			const wantBare = wantSource || (segments.length === 1 && generated(segments[0]!) && shaped);
			expect(isEndoCockpitSourceKindAdmittedV0(value), value).toBe(wantSource);
			expect(isEndoCockpitPublicKindV0(value), value).toBe(wantBare);
			const wantEvent =
				shaped &&
				segments.length >= 2 &&
				(!anyReserved || (segments.length === 2 && segments[0] === "other" && generated(segments[1]!)));
			expect(isEndoCockpitPublicEventKindV0(value), value).toBe(wantEvent);
		}
		// `other` is not in the pool; the wrapped form is checked directly over the same segments.
		for (const segments of all.filter((item) => item.length === 1)) {
			const value = `other.${segments[0]}`;
			const shaped = /^[a-z][a-z0-9-]*$/.test(segments[0]!);
			expect(isEndoCockpitPublicEventKindV0(value), value).toBe(
				shaped && (!reserved(segments[0]!) || generated(segments[0]!)),
			);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Identifier fields: the unavailable claim is NOT refused (the finding's premise does not hold)
// ---------------------------------------------------------------------------------------------------------------

describe("an identifier field may be withheld whole, as the projector does (finding 3, not implemented)", () => {
	const WITHHELD = ENDO_COCKPIT_WITHHELD_TEXT_V0;
	const overlong = `endo.evidence.${["a", "b", "c", "d"].map((letter) => letter.repeat(60)).join(".")}`;
	const present = (log: ReturnType<typeof timelineOf>, key: string) => log.entries[0]!.fields[key];

	it("a valid evidence identifier is presented as it is, a content-addressed one as its keyed alias, a malformed one is omitted", () => {
		const plain = timelineOf(
			event("harness.attached", { fingerprintId: "endo.evidence.pi-fingerprint.one", instance: "i" }),
		);
		expect(present(plain, "fingerprintId")).toEqual({ basis: "observed", value: "endo.evidence.pi-fingerprint.one" });
		expect(plain.entries[0]!.withheldFields).toBe(0);
		const content = timelineOf(
			event("harness.attached", { fingerprintId: `endo.evidence.pi-fingerprint.${"a".repeat(64)}`, instance: "i" }),
		);
		expect(present(content, "fingerprintId")).toEqual({
			basis: "observed",
			value: alias.id(`endo.evidence.pi-fingerprint.${"a".repeat(64)}`),
		});
		expect(content.entries[0]!.withheldFields).toBe(0);
		for (const value of ["not an identifier", 7, true]) {
			const omitted = timelineOf(event("harness.attached", { fingerprintId: value, instance: "i" }));
			expect(present(omitted, "fingerprintId"), String(value)).toBeUndefined();
			expect(omitted.entries[0]!.withheldFields).toBe(1);
			expect(valid.timeline(omitted)).toBe(true);
		}
		// None of the three identifier fields is nullable: a null is omitted too.
		expect(
			present(timelineOf(event("harness.attached", { fingerprintId: null, instance: "i" })), "fingerprintId"),
		).toBeUndefined();
	});

	it("an identifier of another namespace, or too long to present, is withheld whole; the counter says one key", () => {
		for (const value of ["endo.session.abc", `endo.event.x.${"a".repeat(64)}`, overlong]) {
			const log = timelineOf(event("harness.attached", { fingerprintId: value, instance: "i" }));
			expect(present(log, "fingerprintId"), value).toEqual({ basis: "unavailable", reason: WITHHELD });
			expect(log.entries[0]!.withheldFields, value).toBe(1);
			expect(valid.timeline(log), value).toBe(true);
		}
	});

	it("is reachable from the durable store: the store accepts the payload, the read does not throw, and the snapshot validates", () => {
		const root = tempRoot();
		ingestAll(root, [
			event("harness.attached", { fingerprintId: "endo.session.abc", instance: "i1" }),
			event("harness.runtime-changed", { previousFingerprintId: overlong, currentFingerprintId: "endo.event.x.1" }),
		]);
		const read = readEndoCockpitTimelineV0(root);
		expect(read.source.condition.state).toBe("readable");
		expect(
			read.entries
				.flatMap((entry) => Object.entries(entry.fields).map(([key, field]) => [key, field]))
				.filter(([key]) => /FingerprintId$|^fingerprintId$/.test(key as string)),
		).toEqual([
			["fingerprintId", { basis: "unavailable", reason: WITHHELD }],
			["previousFingerprintId", { basis: "unavailable", reason: WITHHELD }],
			["currentFingerprintId", { basis: "unavailable", reason: WITHHELD }],
		]);
		expect(valid.timeline(read)).toBe(true);
		expect(valid.snapshot(readEndoCockpitSnapshotV0(root, { attachments: [] }))).toBe(true);
	});

	it("the unavailable form is the fixed text only, for these observed fields; no other reason is invented", () => {
		for (const [kind, key] of [
			["harness.attached", "fingerprintId"],
			["harness.runtime-changed", "previousFingerprintId"],
			["harness.runtime-changed", "currentFingerprintId"],
		] as const) {
			expect(endoCockpitUnavailableAdmittedV0(kind, key, WITHHELD), key).toBe(true);
			expect(endoCockpitUnavailableAdmittedV0(kind, key, "the runtime did not say"), key).toBe(false);
			expect(endoCockpitUnavailableAdmittedV0(kind, key, ""), key).toBe(false);
		}
		const log = timelineOf(
			event("harness.attached", { fingerprintId: "endo.evidence.pi-fingerprint.one", instance: "i" }),
		);
		const invented = mutated(log, (copy) => {
			copy.entries[0].fields.fingerprintId = { basis: "unavailable", reason: "the runtime did not say" };
			copy.entries[0].withheldFields += 1;
		});
		expect(valid.timeline(invented)).toBe(false);
	});

	it("documents the limit: a withheld claim for an identifier cannot be told from the projector's own, so it is not refused", () => {
		// What the claim hides (a value of another namespace, an overlong one) is not on the wire. The same bytes are canonical
		// output (above), so refusing them would refuse the projector; the wire proves no more than the accounting is consistent.
		const log = timelineOf(
			event("harness.attached", { fingerprintId: "endo.evidence.pi-fingerprint.one", instance: "i" }),
		);
		const replaced = mutated(log, (copy) => {
			copy.entries[0].fields.fingerprintId = { basis: "unavailable", reason: WITHHELD };
			copy.entries[0].withheldFields += 1;
		});
		const canonical = timelineOf(event("harness.attached", { fingerprintId: "endo.session.abc", instance: "i" }));
		expect(JSON.stringify(replaced.entries[0]!.fields)).toBe(JSON.stringify(canonical.entries[0]!.fields));
		expect(replaced.entries[0]!.withheldFields).toBe(canonical.entries[0]!.withheldFields);
		expect(valid.timeline(replaced)).toBe(true);
		// The accounting is still enforced: the replaced key cannot be left uncounted.
		const uncounted = mutated(replaced, (copy) => {
			copy.entries[0].withheldFields = 0;
		});
		expect(valid.timeline(uncounted)).toBe(false);
	});

	it("keeps every other unavailable rule: strings, declared gaps, the session conflict, numbers and keyed digests", () => {
		// An ordinary string may be withheld whole.
		expect(endoCockpitUnavailableAdmittedV0("harness.attached", "instance", WITHHELD)).toBe(true);
		// A derived or observed number or boolean is omitted, never withheld.
		expect(endoCockpitUnavailableAdmittedV0("harness.process-exited", "code", WITHHELD)).toBe(false);
		expect(endoCockpitUnavailableAdmittedV0("harness.process-exited", "spawnFailed", WITHHELD)).toBe(false);
		// A reported field may carry the reason the runtime gave; a declared gap likewise.
		expect(endoCockpitUnavailableAdmittedV0("agent.turn-finished", "stopReason", "the runtime did not say")).toBe(
			true,
		);
		expect(
			endoCockpitUnavailableAdmittedV0(
				"lifecycle.session-started",
				"unavailable.runId",
				"not reported by the runtime",
			),
		).toBe(true);
		// The runtime-session conflict of `harness.attached`, and no other reason there.
		expect(
			endoCockpitUnavailableAdmittedV0(
				"harness.attached",
				"runtimeSessionId",
				ENDO_COCKPIT_RUNTIME_SESSION_CONFLICT_V0,
			),
		).toBe(true);
		expect(endoCockpitUnavailableAdmittedV0("harness.attached", "runtimeSessionId", "some reason")).toBe(false);
		// A member of a keyed digest has no unavailable form.
		for (const key of ["argsDigest", "argsDigestKeyId"])
			expect(endoCockpitUnavailableAdmittedV0("tool.started", key, WITHHELD), key).toBe(false);
		for (const key of ["resultDigest", "resultDigestKeyId"])
			expect(endoCockpitUnavailableAdmittedV0("tool.finished", key, WITHHELD), key).toBe(false);
		// An unknown field has none either.
		expect(endoCockpitUnavailableAdmittedV0("harness.attached", "notAField", WITHHELD)).toBe(false);
	});
});
