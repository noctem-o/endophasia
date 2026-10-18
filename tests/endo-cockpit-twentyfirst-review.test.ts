// PR #57 review round 21: validation cost is bounded by the supplied representation, not by the cardinalities it declares
// (P1), a fingerprint's confidence agrees with the facts its view shows (P2), and a keyed digest is never presented beside a
// withheld key id (P2).

import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import {
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitUnavailableAdmittedV0,
} from "../protocol/cockpit-fields.ts";
import { endoHarnessIdentityBasisV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import {
	ATTACHMENT,
	changeRecord,
	completeLogSource,
	event,
	ingestAll,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	stored,
	tempRoot,
} from "./cockpit-fixtures.ts";
import {
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	TEST_KEY,
} from "./cockpit-keyed.ts";
import { aliasOf, capabilitiesOf, identityOf, mutated, snapshotFrom } from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------------------------------------------
// 1. P1: no work proportional to a declared record count
// ---------------------------------------------------------------------------------------------------------------

describe("a duplicate note is validated without walking the positions a watermark declares (P1)", () => {
	const OWNER = aliasOf("endo.evidence.model-owner");
	const records = { ...specimenRecords(), change: [changeRecord()], notification: [notificationRecord()] };
	const identity: any = identityOf(records);
	const capabilities: any = capabilitiesOf(records);

	type Counts = { fingerprint?: number; change?: number; notification?: number };

	/** The same projection declaring other record counts: its latest positions move to the end, its tails stay. */
	function declare<T>(view: T, counts: Counts): T {
		let text = JSON.stringify(view);
		for (const kind of ["fingerprint", "change", "notification"] as const)
			if (counts[kind] !== undefined)
				text = text.split(`"kind":"${kind}","index":0`).join(`"kind":"${kind}","index":${counts[kind]! - 1}`);
		const out: any = JSON.parse(text);
		Object.assign(out.source.watermark.counts, counts);
		return out;
	}
	const dup = (view: any, kind: string, index: number, id: string) =>
		mutated(view, (x) => {
			x.notes.push({
				code: "duplicate-record-id",
				refs: [{ domain: "harness-registry", attachment: x.source.attachment, kind, index, id }],
			});
		});
	const missingNote = (view: any) =>
		mutated(view, (x) => {
			x.notes.push({ code: "notification-change-missing", refs: [structuredClone(x.lastNotification.ref)] });
		});
	const ownedBy = (view: any, id: string) =>
		mutated(view, (x) => {
			x.lastNotification.changeId = id;
		});
	/** Runs `validate` three times: the same verdict each time, and well inside a bound a count-sized walk would exceed. */
	function verdict(validate: () => unknown, label: string): boolean {
		const answers: boolean[] = [];
		for (let run = 0; run < 3; run += 1) {
			const started = performance.now();
			answers.push(validate() !== null);
			expect(performance.now() - started, label).toBeLessThan(300);
		}
		expect(new Set(answers).size, label).toBe(1);
		return answers[0]!;
	}
	const viaIdentity = (view: any, label: string) => verdict(() => validateEndoCockpitRuntimeIdentityV0(view), label);
	const viaSnapshot = (view: any, label: string, counts: Counts) =>
		verdict(() => validateEndoCockpitSnapshotV0(snapshotFrom(view, declare(capabilities, counts))), label);

	const COUNTS = [1, 10, 1_000_000, 1_000_000_000, MAX_SAFE];

	it("accepts the canonical projection at any declared count", () => {
		for (const n of COUNTS) {
			const counts = { fingerprint: n, change: n, notification: n };
			expect(viaIdentity(declare(identity, counts), `identity ${n}`), `identity ${n}`).toBe(true);
			expect(viaSnapshot(declare(identity, counts), `snapshot ${n}`, counts), `snapshot ${n}`).toBe(true);
		}
	});

	it("a duplicate near the beginning: valid exactly when an unshown earlier position can own it, at every scale", () => {
		for (const n of COUNTS) {
			// The first of three changes repeats an id; the fingerprints before it are n, the last of them shown.
			const counts = { fingerprint: n, change: 3 };
			const view = dup(declare(identity, counts), "change", 0, OWNER);
			// n = 1: the one fingerprint is shown with another id, nothing else is earlier: no owner can exist.
			const expected = n >= 2;
			expect(viaIdentity(view, `identity begin ${n}`), `identity ${n}`).toBe(expected);
			expect(viaSnapshot(view, `snapshot begin ${n}`, counts), `snapshot ${n}`).toBe(expected);
		}
	});

	it("a duplicate in the middle of the declared records", () => {
		for (const n of COUNTS.filter((count) => count >= 10)) {
			const view = dup(declare(identity, { change: n, notification: n }), "notification", Math.floor(n / 2), OWNER);
			expect(viaIdentity(view, `middle ${n}`), `middle ${n}`).toBe(true);
			expect(viaSnapshot(view, `snapshot middle ${n}`, { change: n, notification: n }), `snapshot ${n}`).toBe(true);
		}
	});

	it("a duplicate at the last declared position: its id is the watermark's tail, which is then no shown record", () => {
		for (const n of COUNTS.filter((count) => count >= 10)) {
			const counts = { change: n, notification: n };
			// The latest KEPT notice sits one position before; the repeat at the end owns the tail id.
			const base = mutated(declare(identity, counts), (x) => {
				x.lastNotification.ref.index = n - 2;
				x.source.watermark.lastIds.notification = OWNER;
			});
			const view = dup(base, "notification", n - 1, OWNER);
			expect(viaIdentity(view, `end ${n}`), `end ${n}`).toBe(true);
			// An id that is not the tail cannot sit at the last position.
			expect(viaIdentity(dup(base, "notification", n - 1, aliasOf("endo.evidence.model-other")), `end ${n}`)).toBe(
				false,
			);
		}
	});

	it("impossible at every scale: nothing earlier, and a later kind's record carrying the repeated id", () => {
		for (const n of COUNTS.filter((count) => count >= 10)) {
			const counts = { fingerprint: n, change: n, notification: n };
			const base = declare(identity, counts);
			// The first fingerprint has nothing before it.
			expect(viaIdentity(dup(base, "fingerprint", 0, OWNER), `first ${n}`), `first ${n}`).toBe(false);
			// The repeated id is the shown notice's: a notice sits after every change, so it cannot be the owner of a change's repeat.
			const noticeId = base.lastNotification.id;
			expect(viaIdentity(dup(base, "change", 0, noticeId), `later ${n}`), `later ${n}`).toBe(false);
			// ... while the same note with an unrelated id is possible.
			expect(viaIdentity(dup(base, "change", 0, OWNER), `control ${n}`), `control ${n}`).toBe(true);
		}
	});

	it("the owner's kind, once the candidates are one kind, still decides the missing-change note at every scale", () => {
		for (const n of COUNTS.filter((count) => count >= 10)) {
			const counts = { fingerprint: n, change: 3 };
			// The first of three changes repeats the id the notice names; only the (declared) fingerprints precede it.
			const base = ownedBy(dup(declare(identity, counts), "change", 0, OWNER), OWNER);
			expect(viaIdentity(base, `no note ${n}`), `no note ${n}`).toBe(false);
			expect(viaIdentity(missingNote(base), `with note ${n}`), `with note ${n}`).toBe(true);
		}
	});

	it("a duplicate of a kind with no declared record, or at a position the watermark does not declare, is refused", () => {
		const base = declare(identity, { change: 10 });
		expect(viaIdentity(dup(base, "change", 10, OWNER), "past the end")).toBe(false);
		expect(viaIdentity(dup(base, "change", MAX_SAFE, OWNER), "far past the end")).toBe(false);
		const empty = declare(identity, {});
		empty.source.watermark.counts.notification = 0;
		expect(viaIdentity(dup(empty, "notification", 0, OWNER), "none declared")).toBe(false);
	});

	it("the capability view and a snapshot do the same, with the declared fingerprints and a repeated evidence record", () => {
		const presented = capabilities.capabilities.length;
		expect(presented).toBeGreaterThan(0);
		const cited = new Set(
			capabilities.capabilities.flatMap((c: any) => (c.evidence === null ? [] : [c.evidence.ref.index])),
		);
		const unshown = [...Array(capabilities.source.watermark.counts.evidence - 1).keys()].find(
			(at) => !cited.has(at),
		)!;
		for (const n of COUNTS.filter((count) => count >= 10)) {
			const view = dup(declare(capabilities, { fingerprint: n }), "evidence", unshown, OWNER);
			expect(
				verdict(() => validateEndoCockpitCapabilityStateV0(view), `capability ${n}`),
				`capability ${n}`,
			).toBe(true);
			const identityAtN = declare(identity, { fingerprint: n });
			const snapshot = snapshotFrom(identityAtN, view);
			expect(
				verdict(() => validateEndoCockpitSnapshotV0(snapshot), `snapshot ${n}`),
				`snapshot ${n}`,
			).toBe(true);
		}
	});

	it("a tiny projection declaring millions of records validates in milliseconds (this took seconds, and memory, before)", () => {
		const n = 3_000_000;
		const view = dup(declare(identity, { change: n, notification: n }), "notification", Math.floor(n / 2), OWNER);
		const started = performance.now();
		expect(validateEndoCockpitRuntimeIdentityV0(view)).not.toBeNull();
		expect(performance.now() - started).toBeLessThan(300);
		expect(JSON.stringify(view).length).toBeLessThan(6000);
	});

	it("keeps bounded memory: repeated validation at the safe-integer limit allocates nothing in proportion to the count", () => {
		const view = dup(
			declare(identity, { change: MAX_SAFE, notification: MAX_SAFE }),
			"notification",
			MAX_SAFE - 2,
			OWNER,
		);
		const before = process.memoryUsage().heapUsed;
		for (let run = 0; run < 300; run += 1) expect(validateEndoCockpitRuntimeIdentityV0(view)).not.toBeNull();
		// 300 validations of a ~3 KB projection: a count-sized structure would be gigabytes; allow generous noise.
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(150 * 1024 * 1024);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The other count-dependent work: supplied sizes only, and linear
// ---------------------------------------------------------------------------------------------------------------

describe("validation work grows with the supplied representation, linearly (resource audit)", () => {
	const base = specimenRecords();
	const first = base.state[0]!;

	/** n capabilities, each citing its own evidence record, through the real projectors. */
	function manyCapabilities(n: number) {
		const entry = first.capabilities[0]!;
		const template = base.evidence.find((item) => item.id === entry.evidenceId)!;
		const entries = Array.from({ length: n }, (_, at) => ({
			...entry,
			capability: `bench.c${at}`,
			evidenceId: `endo.evidence.bench-capability.${at}`,
		}));
		const evidence = entries.map((item) => ({ ...template, id: item.evidenceId, capability: item.capability }));
		const records: any = { ...base, evidence, state: [{ ...first, capabilities: entries }] };
		return { identity: identityOf(records), capabilities: capabilitiesOf(records) };
	}

	it("validates 1200 capabilities, each with its own evidence, in well under the seconds a pairwise comparison took", () => {
		const { identity, capabilities } = manyCapabilities(1200);
		const started = performance.now();
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshotFrom(identity, capabilities))).not.toBeNull();
		// Measured about 0.2 s here; the pairwise version took about 13 s per validator at this size (quadratic, with the full
		// reference grammar re-run for every pair).
		expect(performance.now() - started).toBeLessThan(4000);
	}, 60000);

	it("still refuses two different evidence records that carry one id, and accepts capabilities that share one record", () => {
		const { identity, capabilities } = manyCapabilities(40);
		expect(validateEndoCockpitSnapshotV0(snapshotFrom(identity, capabilities))).not.toBeNull();
		const twin = mutated(capabilities, (x) => {
			x.capabilities[7].evidence.id = x.capabilities[3].evidence.id;
		});
		expect(validateEndoCockpitCapabilityStateV0(twin)).toBeNull();
		// Two entries citing one record: one view of it, twice (the projector's own output).
		const entry = first.capabilities[0]!;
		const template = base.evidence.find((item) => item.id === entry.evidenceId)!;
		const entries = Array.from({ length: 12 }, (_, at) => ({
			...entry,
			capability: `bench.c${at}`,
			evidenceId: `endo.evidence.bench-capability.${at === 9 ? 3 : at}`,
		}));
		const evidence = entries
			.map((item) => ({ ...template, id: item.evidenceId, capability: "bench.c3" }))
			.filter((item, at, list) => list.findIndex((other) => other.id === item.id) === at);
		const records: any = { ...base, evidence, state: [{ ...first, capabilities: entries }] };
		const shared: any = capabilitiesOf(records);
		expect(shared.capabilities[9].evidence.ref).toEqual(shared.capabilities[3].evidence.ref);
		expect(validateEndoCockpitCapabilityStateV0(shared)).not.toBeNull();
		// Citing one record with two different views is refused.
		const split = mutated(shared, (x) => {
			x.capabilities[9].evidence.check.name = "another.check";
		});
		expect(validateEndoCockpitCapabilityStateV0(split)).toBeNull();
	});

	it("validates a disagreement note citing thousands of records, with the same positions refused when one repeats", () => {
		const records = { ...base, change: [changeRecord()], notification: [notificationRecord()] };
		const identity: any = identityOf(records);
		const n = 6000;
		const big = mutated(identity, (x) => {
			x.source.watermark.counts.change = n + 5;
			x.lastChange.ref.index = n + 4;
			x.notes.push({
				code: "runtime-disagreement",
				refs: [
					structuredClone(x.current.ref),
					...Array.from({ length: n }, (_, at) => ({
						domain: "harness-registry",
						attachment: x.source.attachment,
						kind: "change",
						index: at,
						id: aliasOf(`endo.evidence.bench-change.${at}`),
					})),
				],
			});
		});
		const started = performance.now();
		expect(validateEndoCockpitRuntimeIdentityV0(big)).not.toBeNull();
		expect(performance.now() - started).toBeLessThan(3000);
		// One position cited twice (under another id) is no second family.
		const twice = mutated(big, (x) => {
			const note = x.notes.find((item: { code: string }) => item.code === "runtime-disagreement");
			note.refs[n] = { ...note.refs[1], id: note.refs[n].id };
		});
		expect(validateEndoCockpitRuntimeIdentityV0(twice)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. P2: a fingerprint's confidence follows the facts its view shows
// ---------------------------------------------------------------------------------------------------------------

describe("a fingerprint's confidence agrees with its entrypoint and version claims (P2)", () => {
	const GAP = ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0;

	/** A durable fingerprint with these facts, as the registry holds it: its confidence, gaps and id follow from them. */
	function fingerprint(options: { entrypoint?: boolean; version?: string | null } = {}) {
		const base = specimen().fingerprint;
		const entrypoint = options.entrypoint ?? true;
		const version = options.version === undefined ? base.reported.version : options.version;
		const local = { ...base.local, entrypoint: entrypoint ? base.local.entrypoint : null };
		const reported = version === null ? { versionText: null, version: null } : { versionText: version, version };
		const gaps = [
			...base.gaps.filter((gap) => gap.fact !== "entrypoint" && gap.fact !== "version"),
			...(entrypoint ? [] : [{ fact: "entrypoint" as const, reason: "no entrypoint" }]),
			...(version === null ? [{ fact: "version" as const, reason: "no version" }] : []),
		];
		const confidence = entrypoint && version !== null ? "strong" : "reduced";
		const identity = {
			digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV0({ runtime: "pi", local, reported }))),
			confidence,
		};
		const { id: _id, ...rest } = base;
		const body = { ...rest, local, reported, gaps, identity };
		return { ...body, id: `endo.evidence.pi-fingerprint.${sha256HexV0(canonicalEndoJsonV0(body))}` };
	}
	const VARIANTS = {
		strong: fingerprint(),
		"reduced, no version": fingerprint({ version: null }),
		"reduced, no entrypoint": fingerprint({ entrypoint: false }),
		"reduced, neither": fingerprint({ entrypoint: false, version: null }),
		"strong, version withheld by privacy": fingerprint({ version: "1.0.0 at /usr/local/bin/pi" }),
		"reduced, version withheld, no entrypoint": fingerprint({
			entrypoint: false,
			version: "1.0.0 at /usr/local/bin/pi",
		}),
	} as const;
	const identityFor = (...list: unknown[]): any => identityOf({ ...specimenRecords(), fingerprint: list });
	const accepted = (value: unknown) => validateEndoCockpitRuntimeIdentityV0(value) !== null;
	const withClaim = (view: any, field: string, claim: unknown) =>
		mutated(view, (x) => {
			x.current[field] = claim;
		});
	const gapClaim = (view: any) => ({
		basis: "unavailable",
		reason: GAP,
		refs: structuredClone(view.current.ref ? [view.current.ref] : []),
	});
	const withConfidence = (view: any, confidence: string) =>
		mutated(view, (x) => {
			x.current.identity.value.confidence = confidence;
		});

	it("accepts what the projectors produce for every combination of present, missing and withheld facts", () => {
		for (const [label, record] of Object.entries(VARIANTS)) {
			const view = identityFor(record);
			expect(accepted(view), label).toBe(true);
			expect(view.current.identity.value.confidence, label).toBe(record.identity.confidence);
		}
		// The withheld version is a recorded one: unavailable for the privacy reason, not the recorded-gap reason.
		const withheld = identityFor(VARIANTS["strong, version withheld by privacy"]);
		expect(withheld.current.version).toMatchObject({ basis: "unavailable", reason: ENDO_COCKPIT_WITHHELD_TEXT_V0 });
		expect(withheld.current.identity.value.confidence).toBe("strong");
		const missing = identityFor(VARIANTS["reduced, no version"]);
		expect(missing.current.version).toMatchObject({ basis: "unavailable", reason: GAP });
	});

	it("refuses strong confidence with a missing version or entrypoint, and reduced confidence with both present", () => {
		const strong = identityFor(VARIANTS.strong);
		expect(accepted(withClaim(strong, "version", gapClaim(strong)))).toBe(false);
		expect(accepted(withClaim(strong, "entrypoint", gapClaim(strong)))).toBe(false);
		expect(accepted(withConfidence(strong, "reduced"))).toBe(false);
		// The converse: a reduced identity cannot be restored to strong by claiming the missing fact present.
		for (const label of ["reduced, no version", "reduced, no entrypoint", "reduced, neither"] as const) {
			const reduced = identityFor(VARIANTS[label]);
			expect(accepted(withConfidence(reduced, "strong")), label).toBe(false);
		}
		const noVersion = identityFor(VARIANTS["reduced, no version"]);
		expect(
			accepted(
				withClaim(noVersion, "version", { basis: "reported", value: "1.0.0", refs: [noVersion.current.ref] }),
			),
		).toBe(false);
		const noEntrypoint = identityFor(VARIANTS["reduced, no entrypoint"]);
		expect(
			accepted(
				withClaim(noEntrypoint, "entrypoint", {
					basis: "observed",
					value: { sha256: "a".repeat(64), bytes: 1 },
					refs: [noEntrypoint.current.ref],
				}),
			),
		).toBe(false);
	});

	it("does not confuse a withheld value with a missing one", () => {
		const strong = identityFor(VARIANTS["strong, version withheld by privacy"]);
		expect(accepted(strong)).toBe(true);
		// Reduced beside a version that exists (withheld) and an entrypoint that exists: contradicted by the shown facts.
		expect(accepted(withConfidence(strong, "reduced"))).toBe(false);
		// With the entrypoint missing the same withheld version is beside a reduced identity, and only that.
		const reduced = identityFor(VARIANTS["reduced, version withheld, no entrypoint"]);
		expect(accepted(reduced)).toBe(true);
		expect(accepted(withConfidence(reduced, "strong"))).toBe(false);
	});

	it("applies to the previous different fingerprint too", () => {
		const view = identityFor(fingerprint({ version: null }), fingerprint({ entrypoint: false }));
		expect(view.previousDifferent).not.toBeNull();
		expect(accepted(view)).toBe(true);
		const forged = mutated(view, (x) => {
			x.previousDifferent.identity.value.confidence = "strong";
		});
		expect(accepted(forged)).toBe(false);
		const both = mutated(view, (x) => {
			x.current.identity.value.confidence = "strong";
		});
		expect(accepted(both)).toBe(false);
	});

	it("keeps every other restriction on these claims: bases, reasons and references", () => {
		const reduced = identityFor(VARIANTS["reduced, no entrypoint"]);
		// An entrypoint cannot be withheld (only a recorded gap makes it unavailable); a version has two reasons only.
		expect(
			accepted(
				withClaim(reduced, "entrypoint", {
					basis: "unavailable",
					reason: ENDO_COCKPIT_WITHHELD_TEXT_V0,
					refs: [reduced.current.ref],
				}),
			),
		).toBe(false);
		const strong = identityFor(VARIANTS.strong);
		expect(
			accepted(
				withClaim(strong, "version", {
					basis: "unavailable",
					reason: "some other reason",
					refs: [strong.current.ref],
				}),
			),
		).toBe(false);
		expect(
			accepted(
				mutated(strong, (x) => {
					x.current.identity.basis = "observed";
				}),
			),
		).toBe(false);
		expect(accepted(withClaim(reduced, "entrypoint", { basis: "unavailable", reason: GAP, refs: [] }))).toBe(false);
	});

	it("round-trips valid durable fingerprints read from a real registry", () => {
		for (const [label, record] of Object.entries(VARIANTS)) {
			const root = tempRoot();
			ingestAll(root, [event("agent.prompt-accepted")]);
			const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
			registry.append("fingerprint", record as never);
			const { identity } = readEndoCockpitRuntimeV0(root, ATTACHMENT, TEST_KEY);
			expect(identity.current?.identity.basis, label).toBe("derived");
			expect(accepted(identity), label).toBe(true);
			const snapshot = readEndoCockpitSnapshotV0(root, { limit: 100, attachments: [ATTACHMENT] });
			expect(validateEndoCockpitSnapshotV0(snapshot), label).not.toBeNull();
		}
	});

	it("is a validator rule: no durable fingerprint disagrees, and the projector's own output always agrees", () => {
		// Exhaustive over the four combinations of the two facts, with the version either plain or withheld.
		for (const entrypoint of [true, false])
			for (const version of [null, "1.0.0", "1.0.0 at /usr/local/bin/pi"]) {
				const record = fingerprint({ entrypoint, version });
				const view = identityFor(record);
				const strong = entrypoint && version !== null;
				expect(view.current.identity.value.confidence, `${entrypoint} ${version}`).toBe(
					strong ? "strong" : "reduced",
				);
				expect(accepted(view), `${entrypoint} ${version}`).toBe(true);
				expect(accepted(withConfidence(view, strong ? "reduced" : "strong")), `${entrypoint} ${version}`).toBe(
					false,
				);
			}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. P2: a keyed digest is never presented beside a withheld key id
// ---------------------------------------------------------------------------------------------------------------

describe("a presented keyed digest is accompanied by its presented key id (P2)", () => {
	const KEY_IDS = {
		private: "endo.digest-key.0123456789abcdef0123456789abcdef",
		public: "cockpit-fixture",
		"public, short": "a",
	};
	const digest = (keyId: string, value = "ab".repeat(32)) => ({ algorithm: "hmac-sha256", keyId, value });
	const timelineOf = (...events: ReturnType<typeof event>[]) =>
		projectEndoCockpitSessionTimelineV0(
			{ source: completeLogSource(events, TEST_KEY), afterSequence: 0, events: stored(events) } as never,
			TEST_KEY,
		);
	const started = (parent: unknown) =>
		event("tool.started", { toolName: "read", toolCallId: "c1", argsDigest: parent });
	const finished = (parent: unknown) =>
		event("tool.finished", { toolName: "read", toolCallId: "c1", isError: false, resultDigest: parent });
	const accepted = (value: unknown) => validateEndoCockpitSessionTimelineV0(value) !== null;
	const edit = (log: unknown, change: (fields: any) => void) =>
		mutated(log, (x) => {
			change(x.entries[0].fields);
		});
	const UNAVAILABLE = { basis: "unavailable", reason: ENDO_COCKPIT_WITHHELD_TEXT_V0 };

	it("presents a well-formed digest with its key id, for every grammar-valid key id the policy accepts", () => {
		for (const [label, keyId] of Object.entries(KEY_IDS)) {
			const log = timelineOf(started(digest(keyId)), finished(digest(keyId)));
			const [args, result] = log.entries.map((entry) => entry.fields as any);
			expect(args.argsDigest, label).toMatchObject({ basis: "derived" });
			expect(args.argsDigestKeyId, label).toEqual({ basis: "derived", value: keyId });
			expect(result.resultDigest, label).toMatchObject({ basis: "derived" });
			expect(result.resultDigestKeyId, label).toEqual({ basis: "derived", value: keyId });
			expect(accepted(log), label).toBe(true);
		}
	});

	it("refuses a presented digest whose key id is unavailable, and a presented key id whose digest is, for both pairs", () => {
		const log = timelineOf(started(digest(KEY_IDS.public)));
		const result = timelineOf(finished(digest(KEY_IDS.public)));
		expect(accepted(log)).toBe(true);
		expect(accepted(result)).toBe(true);
		for (const [view, digestKey, keyIdKey] of [
			[log, "argsDigest", "argsDigestKeyId"],
			[result, "resultDigest", "resultDigestKeyId"],
		] as const) {
			expect(
				accepted(
					edit(view, (f) => {
						f[keyIdKey] = { ...UNAVAILABLE };
					}),
				),
				keyIdKey,
			).toBe(false);
			expect(
				accepted(
					edit(view, (f) => {
						f[digestKey] = { ...UNAVAILABLE };
					}),
				),
				digestKey,
			).toBe(false);
			// Neither member present is the omitted pair, which is fine; so is any other single-member removal being refused.
			expect(
				accepted(
					edit(view, (f) => {
						delete f[keyIdKey];
					}),
				),
				`no ${keyIdKey}`,
			).toBe(false);
			expect(
				accepted(
					edit(view, (f) => {
						delete f[digestKey];
					}),
				),
				`no ${digestKey}`,
			).toBe(false);
			expect(
				accepted(
					edit(view, (f) => {
						delete f[keyIdKey];
						delete f[digestKey];
					}),
				),
				"neither",
			).toBe(true);
			// A key id outside the grammar is refused wherever it is presented.
			for (const bad of ["Bad Key", "UPPER", "", "endo.digest-key.xyz", `${"a".repeat(64)}`])
				expect(
					accepted(
						edit(view, (f) => {
							f[keyIdKey] = { basis: "derived", value: bad };
						}),
					),
					`${keyIdKey}=${bad}`,
				).toBe(false);
		}
	});

	it("omits both members of a malformed parent rather than presenting one", () => {
		for (const parent of [
			digest("Bad Key"),
			digest(KEY_IDS.public, "ab".repeat(31)),
			digest(KEY_IDS.public, "AB".repeat(32)),
			{ keyId: KEY_IDS.public, value: "ab".repeat(32) },
			{ ...digest(KEY_IDS.public), extra: 1 },
		]) {
			const log = timelineOf(started(parent));
			const fields = Object.keys(log.entries[0]!.fields);
			expect(fields).not.toContain("argsDigest");
			expect(fields).not.toContain("argsDigestKeyId");
			expect(log.entries[0]!.withheldFields).toBeGreaterThanOrEqual(1);
			expect(accepted(log)).toBe(true);
		}
	});

	it("omits the pair when a member is grammar-valid but flagged by the text policy, and never presents it beside a withheld one", () => {
		// A public key's name is any lowercase slug, and some read like credentials to the text policy.
		for (const keyId of ["sk-canarysecretcanarysecret", "xoxb-12345678abcd", "pk-abcdefghijklmnopqr"]) {
			for (const log of [timelineOf(started(digest(keyId))), timelineOf(finished(digest(keyId)))]) {
				const fields = Object.keys(log.entries[0]!.fields);
				expect(
					fields.filter((key) => /Digest/.test(key)),
					keyId,
				).toEqual([]);
				expect(accepted(log), keyId).toBe(true);
				expect(JSON.stringify(log)).not.toContain(keyId);
			}
		}
		// The key ids a private key and the committed public keys carry are never flagged: they are presented.
		for (const keyId of Object.values(KEY_IDS)) {
			const fields = Object.keys(timelineOf(started(digest(keyId))).entries[0]!.fields);
			expect(fields).toContain("argsDigestKeyId");
		}
	});

	it("is a rule of the shared field policy, and leaves unrelated unavailable forms alone", () => {
		for (const [kind, key] of [
			["tool.started", "argsDigest"],
			["tool.started", "argsDigestKeyId"],
			["tool.finished", "resultDigest"],
			["tool.finished", "resultDigestKeyId"],
		] as const) {
			expect(endoCockpitUnavailableAdmittedV0(kind, key, ENDO_COCKPIT_WITHHELD_TEXT_V0), `${kind} ${key}`).toBe(
				false,
			);
			expect(endoCockpitUnavailableAdmittedV0(kind, key, "not reported"), `${kind} ${key}`).toBe(false);
		}
		// A field the runtime reports may still be unavailable, for the reason it gave or withheld by the boundary.
		expect(endoCockpitUnavailableAdmittedV0("tool.started", "toolName", "not reported")).toBe(true);
		expect(endoCockpitUnavailableAdmittedV0("tool.started", "toolName", ENDO_COCKPIT_WITHHELD_TEXT_V0)).toBe(true);
		expect(endoCockpitUnavailableAdmittedV0("tool.finished", "toolCallId", "not reported")).toBe(true);
		const log = timelineOf(
			event("tool.started", { toolCallId: "c1", toolName: { status: "UNAVAILABLE", reason: "not reported" } }),
		);
		expect((log.entries[0]!.fields as any).toolName).toEqual({ basis: "unavailable", reason: "not reported" });
		expect(accepted(log)).toBe(true);
	});

	it("round-trips tool events through a real store", () => {
		const root = tempRoot();
		ingestAll(root, [started(digest(KEY_IDS.private)), finished(digest(KEY_IDS.public))]);
		const timeline = readEndoCockpitSnapshotV0(root, { limit: 100 }).timeline;
		const [args, result] = timeline.entries.map((entry) => entry.fields as any);
		expect(args.argsDigestKeyId.value).toBe(KEY_IDS.private);
		expect(result.resultDigestKeyId.value).toBe(KEY_IDS.public);
		expect(accepted(timeline)).toBe(true);
	});
});
