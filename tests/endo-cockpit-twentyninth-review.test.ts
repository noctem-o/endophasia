// PR #57 review round 29: four findings.
//
//  A. (tvU7b) Two PUBLIC digest keys can share a label, and so a key id, with different bytes: nothing outside the loader ties a
//     public label to its bytes. The cockpit therefore admits only a private key (whose id is derived from its own fingerprint) or
//     a public key whose label is pinned to the fingerprint of the bytes it stands for (the committed fixture keys, and the
//     synthetic key these tests read under). For an admitted key an equal key id means equal bytes, so every comparison of key ids
//     is a comparison of contexts: freshness on an absent, empty or nonempty source, projection under the key a source was read
//     under, and the key ids a snapshot's views name. No wire field is added.
//  B. (tvU7d) A caller-chosen public label that looks like a credential (`sk-...`) reached every watermark as `keyId`. An unpinned
//     label names no bytes, so it is refused, whatever it looks like: before any file is read, by every projector, and by the
//     wire validators.
//  C. (tvU7Z) A relative path of two segments or more with a hidden or traversal segment or a file extension is withheld whole.
//  D. (tvU7g) The notes of a projection must be in the order its projector emits them: cleaning notes by kind and then position,
//     then the derived notes in the projector's order.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_PUBLIC_DIGEST_KEYS_V0,
	endoCockpitDigestKeyAdmittedV0,
	endoCockpitPresentableTextV0,
	endoCockpitTextPresentableV0,
	endoCockpitTextUnsafeV0,
	isEndoCockpitDigestKeyIdV0,
} from "../protocol/cockpit-fields.ts";
import { ENDO_FIXTURE_DIGEST_KEYS_V0 } from "../protocol/keyed-digest-shape.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import {
	endoFixtureDigestKeyPathV0,
	ENDO_FIXTURE_DIGEST_KEYS_V0 as FROM_STORAGE,
	loadEndoFixtureDigestKeyV0,
} from "../storage/digest-key.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import {
	ATTACHMENT,
	changeRecord,
	event,
	ingestAll,
	notificationRecord,
	removeTempRoots,
	seedRegistry,
	specimenRecords,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import {
	checkEndoCockpitSourceFreshnessV0,
	OTHER_KEY,
	projectEndoCockpitCapabilityStateV0,
	projectEndoCockpitRuntimeIdentityV0,
	projectEndoCockpitSessionTimelineV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
	TEST_KEY,
} from "./cockpit-keyed.ts";
import {
	capabilitiesOf,
	fingerprintAt,
	foreign,
	identityOf,
	mutated,
	snapshotFrom,
	timelineOf,
} from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const WITHHELD = ENDO_COCKPIT_WITHHELD_TEXT_V0;
const base = specimenRecords();

// ---------------------------------------------------------------------------------------------------------------
// A and B. The key a read is made under
// ---------------------------------------------------------------------------------------------------------------

describe("a digest key's id identifies its bytes, or the key is not admitted (P2 tvU7b, tvU7d)", () => {
	/** The same public label as TEST_KEY, other bytes: the finding's case. */
	const impostor = endoDigestKeyV0(Buffer.alloc(32, 0x77), "cockpit-fixture", { public: true });
	const credential = endoDigestKeyV0(Buffer.alloc(32, 0x31), "sk-abcdefghijklmnop", { public: true });
	const unpinned = endoDigestKeyV0(Buffer.alloc(32, 0x32), "fixture-same", { public: true });
	const longest = endoDigestKeyV0(Buffer.alloc(32, 0x33), `a${"b".repeat(62)}`, { public: true });
	const fixturePublic = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0("fixture-public"));
	const fixtureAlt = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0("fixture-public-alt"));
	const refused = [impostor, credential, unpinned, longest];
	const admitted = [
		TEST_KEY,
		OTHER_KEY,
		fixturePublic,
		fixtureAlt,
		endoDigestKeyV0(Buffer.alloc(32, 0x44), "installation"),
	];

	it("reproduces the finding: one label, two byte sequences, one key id and two fingerprints", () => {
		expect(impostor.keyId).toBe(TEST_KEY.keyId);
		expect(impostor.fingerprint).not.toBe(TEST_KEY.fingerprint);
	});

	it("admits a private key and a pinned public key, and refuses every other", () => {
		for (const key of admitted) expect(endoCockpitDigestKeyAdmittedV0(key), key.keyId).toBe(true);
		for (const key of refused) expect(endoCockpitDigestKeyAdmittedV0(key), key.keyId).toBe(false);
		// Objects that are not keys, or claim what no key has.
		const fake = (patch: Record<string, unknown>) => ({ ...TEST_KEY, ...patch });
		for (const bad of [
			null,
			undefined,
			"cockpit-fixture",
			{},
			fake({ digest: undefined }),
			fake({ fingerprint: "not-hex" }),
			fake({ fingerprint: OTHER_KEY.fingerprint }), // a pinned label with another key's fingerprint
			fake({ public: undefined }),
			fake({ public: false }), // a pinned label claimed by a private key: its id is not derived from its fingerprint
			{ ...OTHER_KEY, fingerprint: TEST_KEY.fingerprint },
		])
			expect(endoCockpitDigestKeyAdmittedV0(bad)).toBe(false);
	});

	it("an admitted key's id says its bytes: equal ids exactly when equal fingerprints, over every pair", () => {
		for (const x of admitted)
			for (const y of admitted)
				expect(x.keyId === y.keyId, `${x.keyId} ${y.keyId}`).toBe(x.fingerprint === y.fingerprint);
	});

	it("the pins are the bytes they name: recomputed, loaded from the committed files, and re-exported unchanged", () => {
		expect(endoDigestKeyV0(Buffer.alloc(32, 0x5a), "cockpit-fixture", { public: true }).fingerprint).toBe(
			ENDO_COCKPIT_PUBLIC_DIGEST_KEYS_V0["cockpit-fixture"],
		);
		for (const [label, fingerprint] of Object.entries(ENDO_FIXTURE_DIGEST_KEYS_V0)) {
			expect(ENDO_COCKPIT_PUBLIC_DIGEST_KEYS_V0[label]).toBe(fingerprint);
			expect(loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0(label)).fingerprint).toBe(fingerprint);
		}
		expect(FROM_STORAGE).toBe(ENDO_FIXTURE_DIGEST_KEYS_V0);
		for (const label of Object.keys(ENDO_COCKPIT_PUBLIC_DIGEST_KEYS_V0)) {
			expect(/^[a-z][a-z0-9-]{0,62}$/.test(label), label).toBe(true);
			expect(endoCockpitTextUnsafeV0(label), label).toBe(false); // no pinned label is itself withheld by the text policy
		}
	});

	it("a key id on the wire is a private key's or a pinned label, whatever the grammar admits", () => {
		for (const id of [TEST_KEY.keyId, OTHER_KEY.keyId, "fixture-public", "fixture-public-alt", "cockpit-fixture"])
			expect(isEndoCockpitDigestKeyIdV0(id), id).toBe(true);
		for (const id of [
			"sk-abcdefghijklmnop",
			"fixture-same",
			`a${"b".repeat(62)}`,
			"xoxb-12345678",
			"endo.digest-key.xyz",
			"",
			5,
		])
			expect(isEndoCockpitDigestKeyIdV0(id), String(id)).toBe(false);
	});

	it("every read refuses an unadmitted key before any file is read: a usage error, not an absent source", () => {
		for (const key of refused) {
			const nowhere = "/definitely/not/a/store";
			expect(() => readEndoCockpitEventLogV0(nowhere, { digestKey: key }), key.keyId).toThrow(TypeError);
			expect(() => readEndoCockpitTimelineV0(nowhere, { digestKey: key })).toThrow(TypeError);
			expect(() => readEndoCockpitRegistryV0(nowhere, ATTACHMENT, key)).toThrow(TypeError);
			expect(() => readEndoCockpitRuntimeV0(nowhere, ATTACHMENT, key)).toThrow(TypeError);
			expect(() => readEndoCockpitSnapshotV0(nowhere, { digestKey: key })).toThrow(TypeError);
		}
	});

	it("freshness never reports `unchanged` under a key of the same label and other bytes, on any kind of source", () => {
		const absent = tempRoot();
		const logged = tempRoot();
		ingestAll(logged, [event("agent.prompt-accepted"), event("agent.prompt-accepted")]);
		const emptyRegistry = tempRoot();
		openEndoHarnessRegistryV0(emptyRegistry, ATTACHMENT);
		const seeded = tempRoot();
		seedRegistry(seeded);
		const held = [
			{ root: absent, source: readEndoCockpitEventLogV0(absent).source },
			{ root: logged, source: readEndoCockpitEventLogV0(logged).source },
			{ root: emptyRegistry, source: readEndoCockpitRegistryV0(emptyRegistry, ATTACHMENT).source },
			{ root: seeded, source: readEndoCockpitRegistryV0(seeded, ATTACHMENT).source },
		];
		for (const { root, source } of held) {
			const before = treeHash(root);
			// The same key still says `unchanged` for an unchanged source; another label says the context differs; the same label
			// with other bytes is refused, never compared.
			expect(
				checkEndoCockpitSourceFreshnessV0(root, source, TEST_KEY),
				`${source.domain} ${source.condition.state}`,
			).toBe("unchanged");
			expect(checkEndoCockpitSourceFreshnessV0(root, source, OTHER_KEY)).toBe("digest-context-differs");
			expect(() => checkEndoCockpitSourceFreshnessV0(root, source, impostor)).toThrow(TypeError);
			expect(treeHash(root), "a refused check changed the store").toBe(before);
		}
	});

	it("every projector refuses an unadmitted key, even for an empty or absent source it could once project", () => {
		const emptyRegistry = tempRoot();
		openEndoHarnessRegistryV0(emptyRegistry, ATTACHMENT);
		const input = readEndoCockpitRegistryV0(emptyRegistry, ATTACHMENT);
		const log = readEndoCockpitEventLogV0(tempRoot());
		for (const key of refused) {
			expect(() => projectEndoCockpitRuntimeIdentityV0(input, key), key.keyId).toThrow(TypeError);
			expect(() => projectEndoCockpitCapabilityStateV0(input, key)).toThrow(TypeError);
			expect(() =>
				projectEndoCockpitSessionTimelineV0({ source: log.source, afterSequence: 0, events: [] } as never, key),
			).toThrow(TypeError);
		}
		// ... and the admitted key still projects them.
		expect(() => projectEndoCockpitRuntimeIdentityV0(input, TEST_KEY)).not.toThrow();
	});

	it("a credential-shaped or unpinned label reaches no watermark, no snapshot and no error", () => {
		const root = tempRoot();
		seedRegistry(root);
		ingestAll(root, [event("agent.prompt-accepted")]);
		const before = treeHash(root);
		for (const key of [credential, unpinned]) {
			try {
				readEndoCockpitSnapshotV0(root, { digestKey: key, attachments: [ATTACHMENT] });
				throw new Error("a read under an unadmitted key returned");
			} catch (error) {
				expect(error).toBeInstanceOf(TypeError);
				expect(String((error as Error).message).includes(key.keyId), "the error names the label").toBe(false);
			}
		}
		expect(treeHash(root), "a refused read changed the store").toBe(before);
		// The wire refuses such a label too, wherever a watermark carries it.
		const snapshot = readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] });
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		for (const label of ["sk-abcdefghijklmnop", "fixture-same", "xoxb-12345678"]) {
			const inTimeline = mutated(snapshot, (copy) => {
				copy.timeline.source.watermark.keyId = label;
			});
			const inRegistry = mutated(snapshot, (copy) => {
				for (const view of [copy.runtimes[0].identity, copy.runtimes[0].capabilities])
					view.source.watermark.keyId = label;
			});
			expect(validateEndoCockpitSnapshotV0(inTimeline), `timeline ${label}`).toBeNull();
			expect(validateEndoCockpitSnapshotV0(inRegistry), `registry ${label}`).toBeNull();
		}
	});

	it("views of two contexts do not make one snapshot: a pinned label beside a private id is refused", () => {
		const root = tempRoot();
		seedRegistry(root);
		ingestAll(root, [event("agent.prompt-accepted")]);
		const publicRead = readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] });
		const privateRead = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, attachments: [ATTACHMENT] });
		expect(validateEndoCockpitSnapshotV0(publicRead)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(privateRead)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0({ ...privateRead, timeline: publicRead.timeline })).toBeNull();
		// Private-key reads are unaffected and deterministic.
		expect(JSON.stringify(readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, attachments: [ATTACHMENT] }))).toBe(
			JSON.stringify(privateRead),
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// C. Relative paths
// ---------------------------------------------------------------------------------------------------------------

describe("a relative path with a hidden segment or a file extension is withheld whole (P2 tvU7Z)", () => {
	const withheld = (text: string) => {
		expect(endoCockpitTextUnsafeV0(text), JSON.stringify(text)).toBe(true);
		expect(endoCockpitTextPresentableV0(text), JSON.stringify(text)).toBe(false);
		expect(endoCockpitPresentableTextV0(text), JSON.stringify(text)).toBe(WITHHELD);
	};
	const presented = (text: string) => {
		expect(endoCockpitTextUnsafeV0(text), JSON.stringify(text)).toBe(false);
		expect(endoCockpitPresentableTextV0(text), JSON.stringify(text)).toBe(text);
	};

	it("the finding's two values, and the forms of the same kind, in sentences, punctuation and compatibility forms", () => {
		for (const text of [
			"failed reading config/secrets.json",
			"could not open workspace/.env",
			"src/index.ts",
			"packages/core/config.yaml",
			"config\\secrets.json",
			"workspace\\.env",
			"my-pkg/some_file-name.json",
			"see docs/README.md.",
			"(src/index.ts)",
			"path='src/index.ts'",
			"config/secrets.json:12",
			"read config/secrets.json, then stop",
			"a/../b",
			"src/..",
			"../..",
			"a/b/..",
			"see src/..",
			".github/workflows",
			"a/b/.hidden/c",
			"ｃｏｎｆｉｇ／ｓｅｃｒｅｔｓ．ｊｓｏｎ",
			"ｃｏｎｆｉｇ＼ｓｅｃｒｅｔｓ．ｊｓｏｎ",
		])
			withheld(text);
	});

	it("a slash alone is not a path: MIME types, ratios, repository and package ids, versions and model ids are presented", () => {
		for (const text of [
			"application/json",
			"image/png",
			"image/svg+xml",
			"application/vnd.api+json",
			"application/vnd.ms-excel",
			"text/plain; charset=utf-8",
			"1/2",
			"yes/no",
			"TCP/IP",
			"C/C++",
			"24/7",
			"I/O",
			"km/h",
			"and/or",
			"and/or.", // a sentence's full stop after a word is not a traversal
			"foo/.",
			"secrets.json.",
			"read/write",
			"owner/repo",
			"@scope/pkg",
			"node:fs/promises",
			"2026/10/19",
			"api/v1.2",
			"releases/1.2.3",
			"1.5/2.5",
			"meta-llama/Llama-3.1-8B",
			"Qwen/Qwen2.5-7B",
			"anthropic/claude-3.5-sonnet",
			"Salesforce/blip2-opt-2.7b",
			"openai/gpt-4.1",
			"a\\nb",
			"version 1.2.3",
			"Qwen3.8-27B",
			"retry count: 3",
			"status: 200",
		])
			presented(text);
	});

	it("documented residuals and deliberate fail-closed choices", () => {
		// Not recognised: no extension and no hidden segment, a bare file name (a dotted kind), a space inside the path.
		for (const text of [
			"packages/core",
			"docker/Dockerfile",
			"secrets.json",
			"My Documents/file name.txt",
			"∕etc∕passwd",
		])
			expect(endoCockpitTextUnsafeV0(text), `not claimed: ${text}`).toBe(false);
		// Withheld on purpose, with no exception list: a dotted last segment is an extension whatever it names.
		for (const text of [
			"Node.js/Express.js",
			"Java/.NET",
			"application/vnd.apple.mpegurl",
			"docs/cockpit.md",
			"e.g/i.e",
		])
			withheld(text);
	});

	it("the existing rules stand: absolute paths, URLs, credentials, addresses and control characters", () => {
		for (const text of [
			"/home/someone/.config",
			"~/notes/x.md",
			"./a/b",
			"C:\\Users\\someone",
			"https://example.test/x",
			"sk-abcdefghijklmnopqrstuvwxyz",
			"failed connecting to 10.0.0.5:8080",
			"host db.internal:5432",
			"dead:beef:cafe:babe:dead:beef:cafe:face",
			"a\u0000b",
		])
			withheld(text);
	});

	const secret = "config/secrets.json";
	const records = () => {
		const record = specimenRecords();
		return {
			...record,
			state: record.state.map((state) =>
				mutated(state, (copy) => {
					copy.capabilities[0].reason = `failed reading ${secret}`;
				}),
			),
			evidence: record.evidence.map((item) =>
				mutated(item, (copy) => {
					copy.limitations = [`could not open workspace/.env`, ...copy.limitations];
					copy.check.version = `${secret}`;
				}),
			),
			change: [changeRecord()],
			notification: [notificationRecord({ title: `moved to ${secret}` })],
		};
	};
	const LEAKS = [secret, "secrets.json", "workspace/.env", "workspace", ".env"];
	const leaks = (value: unknown) => LEAKS.filter((leak) => JSON.stringify(value).includes(leak));

	it("through the projectors: a reason, a limitation, a notice title and a version are withheld whole, the source untouched", () => {
		const input = records();
		const before = structuredClone(input);
		const capabilities = capabilitiesOf(input);
		const identity = identityOf(input);
		expect(capabilities.capabilities[0]!.reason).toBe(WITHHELD);
		const cited = capabilities.capabilities.filter((entry) => entry.evidence !== null);
		expect(cited.length).toBeGreaterThan(0);
		for (const entry of cited) {
			expect(entry.limitations[0], entry.capability).toBe(WITHHELD);
			expect(entry.evidence!.check.version, entry.capability).toBe(WITHHELD);
		}
		expect(identity.lastNotification!.title).toBe(WITHHELD);
		const snapshot = snapshotFrom(identity, capabilities);
		for (const value of [capabilities, identity, snapshot]) expect(leaks(value)).toEqual([]);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		expect(input).toEqual(before);
		expect(JSON.stringify(capabilitiesOf(input))).toBe(JSON.stringify(capabilities));
		// The raw path put back is refused by the wire validators.
		const forgedReason = mutated(capabilities, (copy) => {
			copy.capabilities[0].reason = `failed reading ${secret}`;
		});
		expect(validateEndoCockpitCapabilityStateV0(forgedReason)).toBeNull();
		const forgedTitle = mutated(identity, (copy) => {
			copy.lastNotification.title = secret;
		});
		expect(validateEndoCockpitRuntimeIdentityV0(forgedTitle)).toBeNull();
	});

	it("through a timeline: a declared-unavailable reason and a string field are withheld whole", () => {
		const fingerprintId = "endo.evidence.pi-fingerprint.one";
		const log = timelineOf(
			event("lifecycle.session-started", {
				runtime: "pi",
				instance: "i-1",
				unavailable: [{ field: "config", reason: `could not open ${secret}` }],
			}),
			event("harness.attached", { fingerprintId, instance: "workspace/.env" }),
			event("harness.attached", { fingerprintId, instance: "i-2" }),
		);
		expect(log.entries[0]!.fields["unavailable.config"]).toEqual({ basis: "unavailable", reason: WITHHELD });
		expect(log.entries[1]!.fields.instance).toEqual({ basis: "unavailable", reason: WITHHELD });
		expect(log.entries[2]!.fields.instance).toMatchObject({ value: "i-2" }); // the control: an ordinary value is presented
		expect(leaks(log)).toEqual([]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		const forged = mutated(log, (copy) => {
			copy.entries[2].fields.instance.value = "workspace/.env";
		});
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});

	it("hostile slash-heavy and backslash-heavy text costs time linear in its length", () => {
		const generators: Record<string, (n: number) => string> = {
			"one-letter segments": (n) => "a/".repeat(n / 2),
			"backslash segments": (n) => "a\\".repeat(n / 2),
			"dotted segments": (n) => "a.b/".repeat(n / 4),
			"hidden segments": (n) => ".a/".repeat(n / 3),
			"parent segments": (n) => "../".repeat(n / 3),
			"trailing dots": (n) => `a/${".".repeat(n)}`,
			"separators only": (n) => "/".repeat(n),
			"mixed separators": (n) => "a/\\".repeat(n / 3),
			"extension at the very end": (n) => `${"a/".repeat(n / 2)}b.c`,
			"long segments": (n) => `${"a".repeat(n)}/${"b".repeat(n)}`,
			"words and slashes": (n) => "word/word ".repeat(n / 10),
		};
		const best = (text: string) => {
			let least = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run += 1) {
				const started = performance.now();
				endoCockpitTextUnsafeV0(text);
				least = Math.min(least, performance.now() - started);
			}
			return least;
		};
		for (const [name, make] of Object.entries(generators)) {
			const small = best(make(32_768));
			const large = best(make(524_288));
			expect(large, `${name}: ${small.toFixed(1)} ms at 32K, ${large.toFixed(1)} ms at 512K`).toBeLessThan(
				Math.max(64 * small, 100),
			);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// D. The order of the notes
// ---------------------------------------------------------------------------------------------------------------

describe("the notes of a projection are in the order its projector emits them (P2 tvU7g)", () => {
	interface Spec {
		/** Fingerprints by runtime family; `-` is foreign, `=` repeats the id of the record before it. */
		fingerprints?: string;
		/** Changes by runtime family; `-` is foreign. */
		changes?: string;
		/** A notice naming a change no change carries. */
		notify?: boolean;
		/** Notices by position: `-` is foreign. */
		notices?: string;
		/** The state's capabilities: whether to repeat the first. */
		duplicateCapability?: boolean;
		state?: "kept" | "none" | "foreign";
	}
	function build(spec: Spec) {
		const fingerprint: ReturnType<typeof fingerprintAt>[] = [];
		for (const [at, letter] of [...(spec.fingerprints ?? "")].entries()) {
			if (letter === "-") fingerprint.push(foreign(fingerprintAt(`/p/away/${at}`, "away")));
			else if (letter === "=")
				fingerprint.push({ ...fingerprintAt(`/p/same/${at}`, "same"), id: fingerprint[at - 1]!.id });
			else fingerprint.push(fingerprintAt(`/p/${letter}/${at}`, letter));
		}
		const kept = fingerprint.filter((item) => item.attachment === base.fingerprint[0]!.attachment);
		const currentId = kept.at(-1)?.id ?? base.fingerprint[0]!.id;
		const change = [...(spec.changes ?? "")].map((letter, at) => {
			const record = changeRecord({
				id: `endo.evidence.test-change.${at + 1}`,
				runtime: letter === "-" ? "away" : letter,
				current: { ...changeRecord().current!, fingerprintId: currentId },
			});
			return letter === "-" ? foreign(record) : record;
		});
		const notification = [...(spec.notices ?? (spec.notify ? "n" : ""))].map((letter, at) => {
			const record = notificationRecord({
				id: `endo.evidence.test-notification.${at + 1}`,
				changeId: "endo.evidence.test-change.99",
			});
			return letter === "-" ? foreign(record) : record;
		});
		const state =
			spec.state === "none"
				? []
				: base.state.map((item) =>
						mutated(item, (copy) => {
							if (spec.duplicateCapability) copy.capabilities.push(structuredClone(copy.capabilities[0]));
						}),
					);
		return {
			...base,
			fingerprint,
			change,
			notification,
			state: spec.state === "foreign" ? [...state, foreign(base.state[0]!)] : state,
		};
	}
	const codes = (value: { notes: { code: string }[] }) => value.notes.map((note) => note.code);
	const swapNotes = <T extends { notes: unknown[] }>(value: T, a: number, b: number): T =>
		mutated(value, (copy) => {
			[copy.notes[a], copy.notes[b]] = [copy.notes[b], copy.notes[a]];
		});
	const validIdentity = (value: unknown) => validateEndoCockpitRuntimeIdentityV0(value) !== null;
	const validCapabilities = (value: unknown) => validateEndoCockpitCapabilityStateV0(value) !== null;

	it("the finding's case: a foreign fingerprint and nothing kept, then `no-fingerprint-recorded`", () => {
		const identity = identityOf(build({ fingerprints: "-" }));
		expect(codes(identity)).toEqual(["foreign-attachment-record", "no-fingerprint-recorded"]);
		expect(validIdentity(identity)).toBe(true);
		expect(validIdentity(swapNotes(identity, 0, 1))).toBe(false);
	});

	it("cleaning notes: two of one kind swapped, two kinds swapped, and foreign beside repeated ids in position order", () => {
		const twice = identityOf(build({ fingerprints: "a--" }));
		expect(codes(twice)).toEqual(["foreign-attachment-record", "foreign-attachment-record"]);
		expect(validIdentity(twice)).toBe(true);
		expect(validIdentity(swapNotes(twice, 0, 1))).toBe(false);
		const kinds = identityOf(build({ fingerprints: "a-", changes: "a-" }));
		expect(kinds.notes.map((note) => (note.refs[0] as { kind: string }).kind)).toEqual(["fingerprint", "change"]);
		expect(validIdentity(kinds)).toBe(true);
		expect(validIdentity(swapNotes(kinds, 0, 1))).toBe(false);
		// Foreign and repeated ids interleave in the order of their positions: foreign, a, repeat, foreign. (A repeat of a FOREIGN
		// record's id is no repeat: a foreign id never enters the cleaner's ledger.)
		const mixed = identityOf(build({ fingerprints: "-a=-" }));
		expect(codes(mixed)).toEqual(["foreign-attachment-record", "duplicate-record-id", "foreign-attachment-record"]);
		expect(validIdentity(mixed)).toBe(true);
		for (const [a, b] of [
			[0, 1],
			[1, 2],
			[0, 2],
		] as const)
			expect(validIdentity(swapNotes(mixed, a, b)), `swap ${a} ${b}`).toBe(false);
	});

	it("derived notes follow every cleaning note, in the projector's order", () => {
		// A foreign fingerprint, a foreign change, two kept families and a notice naming no change.
		const identity = identityOf(build({ fingerprints: "-ab", changes: "-a", notify: true }));
		expect(codes(identity)).toEqual([
			"foreign-attachment-record",
			"foreign-attachment-record",
			"notification-change-missing",
			"runtime-disagreement",
		]);
		expect(validIdentity(identity)).toBe(true);
		// Every pair of distinct notes swapped, and a cleaning note moved after the derived ones.
		for (let a = 0; a < identity.notes.length; a += 1)
			for (let b = a + 1; b < identity.notes.length; b += 1)
				expect(validIdentity(swapNotes(identity, a, b)), `swap ${a} ${b}`).toBe(false);
		const late = mutated(identity, (copy) => {
			copy.notes.push(copy.notes.shift());
		});
		expect(validIdentity(late)).toBe(false);
	});

	it("a note of the other branch of an exclusive pair keeps its place, and the notices' cleaning follows the changes'", () => {
		const failed = identityOf({
			...build({ fingerprints: "a", changes: "-" }),
			change: [
				foreign(changeRecord()),
				changeRecord({
					id: "endo.evidence.test-change.2",
					kind: "collection-failed",
					current: null,
					failure: "x",
				} as never),
			],
		});
		expect(codes(failed)).toContain("latest-change-is-collection-failure");
		expect(validIdentity(failed)).toBe(true);
		const notices = identityOf(build({ fingerprints: "a-", changes: "-", notices: "-n-" }));
		expect(notices.notes.map((note) => (note.refs[0] as { kind: string }).kind).slice(0, 4)).toEqual([
			"fingerprint",
			"change",
			"notification",
			"notification",
		]);
		expect(validIdentity(notices)).toBe(true);
		expect(validIdentity(swapNotes(notices, 0, 2))).toBe(false);
	});

	it("a capability state: cleaning by kind, then the missing-state or no-fingerprint note, then duplicate capabilities", () => {
		const none = capabilitiesOf(build({ fingerprints: "-", state: "none" }));
		expect(codes(none)).toEqual(["foreign-attachment-record", "no-capability-state-recorded"]);
		expect(validCapabilities(none)).toBe(true);
		expect(validCapabilities(swapNotes(none, 0, 1))).toBe(false);
		const foreignState = capabilitiesOf(build({ fingerprints: "-", state: "foreign" }));
		expect(codes(foreignState)).toEqual([
			"foreign-attachment-record",
			"foreign-attachment-record",
			"state-without-fingerprint",
		]);
		expect(validCapabilities(foreignState)).toBe(true);
		for (const [a, b] of [
			[0, 1],
			[1, 2],
			[0, 2],
		] as const)
			expect(validCapabilities(swapNotes(foreignState, a, b)), `swap ${a} ${b}`).toBe(false);
		const duplicated = capabilitiesOf(build({ fingerprints: "-", duplicateCapability: true }));
		expect(codes(duplicated)).toEqual([
			"foreign-attachment-record",
			"state-without-fingerprint",
			"duplicate-capability",
		]);
		expect(validCapabilities(duplicated)).toBe(true);
		expect(validCapabilities(swapNotes(duplicated, 1, 2))).toBe(false);
		expect(validCapabilities(swapNotes(duplicated, 0, 2))).toBe(false);
		// A projection that did not read its source has its one note, outside the order.
		const unopenable = {
			source: {
				domain: "harness-registry",
				attachment: "pi.default",
				condition: {
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "invalid-store", message: "the store could not be opened" },
				},
				watermark: null,
			},
			records: null,
		} as never;
		const unreadableIdentity = projectEndoCockpitRuntimeIdentityV0(unopenable, TEST_KEY);
		const unreadableCapabilities = projectEndoCockpitCapabilityStateV0(unopenable, TEST_KEY);
		expect(codes(unreadableIdentity)).toEqual(["source-not-projectable"]);
		expect(codes(unreadableCapabilities)).toEqual(["source-not-projectable"]);
		expect(validIdentity(unreadableIdentity)).toBe(true);
		expect(validCapabilities(unreadableCapabilities)).toBe(true);
	});

	it("a large sparse watermark with few notes costs the notes: nothing is walked between positions", () => {
		const identity = identityOf(build({ fingerprints: "-ab" }));
		const declaring = (count: number) => {
			const text = JSON.stringify(identity)
				.split('"kind":"fingerprint","index":2')
				.join(`"kind":"fingerprint","index":${count - 1}`);
			const out = JSON.parse(text);
			out.source.watermark.counts.fingerprint = count;
			return out;
		};
		for (const count of [3, 1_000_000, Number.MAX_SAFE_INTEGER]) {
			const canonical = declaring(count);
			expect(validIdentity(canonical), `canonical ${count}`).toBe(true);
			expect(validIdentity(swapNotes(canonical, 0, 1)), `reordered ${count}`).toBe(false);
		}
	});

	it("every small registry against an order restated from the registry alone", () => {
		let projections = 0;
		let swapped = 0;
		const letters = ["a", "b", "-", "="];
		const each = (alphabet: string[], length: number): string[] =>
			length === 0
				? [""]
				: each(alphabet, length - 1).flatMap((prefix) => alphabet.map((letter) => prefix + letter));
		for (const fingerprints of [...each(letters, 1), ...each(letters, 2), ...each(letters, 3)].filter(
			(history) => history[0] !== "=",
		)) {
			for (const changes of ["", "a", "-", "b-", "-a"]) {
				for (const notices of ["", "n", "-n"]) {
					const spec = { fingerprints, changes, notices };
					const identity = identityOf(build(spec)); // (the projector checks its own output and throws on a refusal)
					projections += 1;
					// The order, restated from the registry alone: the cleaner runs once per kind (fingerprints, changes, notices) and notes
					// each discarded record at its position: a foreign one, or one whose id an earlier KEPT record of the registry carries
					// (a foreign record's id never enters the ledger). Then the first derived note.
					const expected: string[] = [];
					const ledger = new Set<number>();
					const idOf: number[] = [];
					let keptFingerprints = 0;
					for (const [at, letter] of [...fingerprints].entries()) {
						idOf[at] = letter === "=" ? idOf[at - 1]! : at;
						if (letter === "-") expected.push(`foreign-attachment-record:fingerprint:${at}`);
						else if (ledger.has(idOf[at]!)) expected.push(`duplicate-record-id:fingerprint:${at}`);
						else {
							ledger.add(idOf[at]!);
							keptFingerprints += 1;
						}
					}
					for (const [at, letter] of [...changes].entries())
						if (letter === "-") expected.push(`foreign-attachment-record:change:${at}`);
					for (const [at, letter] of [...notices].entries())
						if (letter === "-") expected.push(`foreign-attachment-record:notification:${at}`);
					if (keptFingerprints === 0) expected.push("no-fingerprint-recorded::");
					const cleaningCount = expected.length;
					// By code, kind and index: a foreign fingerprint before a foreign change is not a foreign change before a fingerprint.
					const described = identity.notes.map((note) => {
						const ref = note.refs[0] as { kind: string; index: number } | undefined;
						return `${note.code}:${ref?.kind ?? ""}:${ref?.index ?? ""}`;
					});
					expect(described.slice(0, cleaningCount), JSON.stringify(spec)).toEqual(expected);
					// Every swap of two notes that differ is refused; two equal notes swapped are the same value.
					for (let a = 0; a < identity.notes.length; a += 1)
						for (let b = a + 1; b < identity.notes.length; b += 1) {
							if (JSON.stringify(identity.notes[a]) === JSON.stringify(identity.notes[b])) continue;
							swapped += 1;
							expect(validIdentity(swapNotes(identity, a, b)), `${JSON.stringify(spec)} swap ${a} ${b}`).toBe(
								false,
							);
						}
				}
			}
		}
		expect(projections).toBeGreaterThan(300);
		expect(swapped).toBeGreaterThan(200);
	}, 120_000);
});
