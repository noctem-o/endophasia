// PR #57 review round 30: the freshness check admits every key it is given before it compares contexts.
//
// `checkEndoCockpitSourceFreshnessV0` compared the held source's key id before admitting the key, so an unadmitted public key
// of another label (or a malformed key object) was answered `digest-context-differs` while the same key under the held label
// threw: two answers for one kind of caller input. The order is now: no key beside a held position is `digest-context-differs`
// (deliberate: there is no context to compare in); every supplied key is admitted first, so an unadmitted one is a TypeError
// and never a different context; an admitted key of another context is `digest-context-differs`; otherwise the source is read.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { checkEndoCockpitSourceFreshnessV0 as check } from "../cockpit/reader.ts";
import { type EndoDigestKeyV0, endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { ATTACHMENT, event, ingestAll, removeTempRoots, seedRegistry, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { OTHER_KEY, readEndoCockpitEventLogV0, readEndoCockpitRegistryV0, TEST_KEY } from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const fixturePublic = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0("fixture-public"));
const anotherPrivate = endoDigestKeyV0(Buffer.alloc(32, 0x44), "installation");
const unpinnedOtherLabel = endoDigestKeyV0(Buffer.alloc(32, 0x32), "fixture-same", { public: true });
const impersonator = endoDigestKeyV0(Buffer.alloc(32, 0x77), "cockpit-fixture", { public: true }); // TEST_KEY's label, other bytes
const credentialShaped = endoDigestKeyV0(Buffer.alloc(32, 0x31), "sk-abcdefghijklmnop", { public: true });
const malformed: [string, unknown][] = [
	["an object with only a key id", { keyId: TEST_KEY.keyId }],
	["a key whose digest is gone", { ...TEST_KEY, digest: undefined }],
	["a key whose fingerprint is not a fingerprint", { ...TEST_KEY, fingerprint: "zz" }],
	["a key marked neither public nor private", { ...TEST_KEY, public: undefined }],
	["a string", "cockpit-fixture"],
	["an empty string", ""],
	["a number", 0],
];

interface Held {
	label: string;
	root: string;
	source:
		| ReturnType<typeof readEndoCockpitEventLogV0>["source"]
		| ReturnType<typeof readEndoCockpitRegistryV0>["source"];
}

/** Held sources of each kind and condition, each read under `key`: an absent and a nonempty event log, an empty and a nonempty registry. */
function heldUnder(key: EndoDigestKeyV0): Held[] {
	const absentLog = tempRoot();
	const logged = tempRoot();
	ingestAll(logged, [event("agent.prompt-accepted"), event("agent.prompt-accepted")]);
	const emptyRegistry = tempRoot();
	openEndoHarnessRegistryV0(emptyRegistry, ATTACHMENT);
	const seeded = tempRoot();
	seedRegistry(seeded);
	return [
		{
			label: "event log, absent",
			root: absentLog,
			source: readEndoCockpitEventLogV0(absentLog, { digestKey: key }).source,
		},
		{
			label: "event log, nonempty",
			root: logged,
			source: readEndoCockpitEventLogV0(logged, { digestKey: key }).source,
		},
		{
			label: "registry, empty",
			root: emptyRegistry,
			source: readEndoCockpitRegistryV0(emptyRegistry, ATTACHMENT, key).source,
		},
		{ label: "registry, nonempty", root: seeded, source: readEndoCockpitRegistryV0(seeded, ATTACHMENT, key).source },
	];
}

/** The error a call throws, or null; it must be a TypeError that does not name `label`. */
function refusal(call: () => unknown, label?: string): void {
	let thrown: unknown = null;
	try {
		call();
	} catch (error) {
		thrown = error;
	}
	expect(thrown, "the call returned").toBeInstanceOf(TypeError);
	if (label !== undefined)
		expect(String((thrown as Error).message).includes(label), "the error names the label").toBe(false);
}

describe("an admitted key gets the ordinary freshness answer", () => {
	it("a matching key, private or pinned public, compares the source: unchanged", () => {
		for (const key of [OTHER_KEY, anotherPrivate, TEST_KEY, fixturePublic])
			for (const { label, root, source } of heldUnder(key))
				expect(check(root, source, key), `${label} under ${key.keyId}`).toBe("unchanged");
	});

	it("another admitted key, private or pinned public, is a different context, before the source is read", () => {
		const pairs: [EndoDigestKeyV0, EndoDigestKeyV0][] = [
			[OTHER_KEY, anotherPrivate],
			[anotherPrivate, OTHER_KEY],
			[OTHER_KEY, TEST_KEY],
			[TEST_KEY, OTHER_KEY],
			[TEST_KEY, fixturePublic],
			[fixturePublic, TEST_KEY],
		];
		for (const [heldKey, nowKey] of pairs)
			for (const { label, root, source } of heldUnder(heldKey)) {
				const before = treeHash(root);
				expect(check(root, source, nowKey), `${label}: ${heldKey.keyId} then ${nowKey.keyId}`).toBe(
					"digest-context-differs",
				);
				expect(treeHash(root)).toBe(before);
			}
	});
});

describe("a supplied key that is not admitted is a usage error, whatever its label (P2 tv33Z)", () => {
	it("an unpinned public key of another label: the finding", () => {
		for (const { label, root, source } of heldUnder(TEST_KEY)) {
			const before = treeHash(root);
			refusal(() => check(root, source, unpinnedOtherLabel), unpinnedOtherLabel.keyId);
			expect(treeHash(root), `${label}: a refused key changed the store`).toBe(before);
		}
	});

	it("an unpinned public key impersonating an admitted label: refused, as before", () => {
		for (const { root, source } of heldUnder(TEST_KEY)) refusal(() => check(root, source, impersonator));
	});

	it("a credential-shaped public label: refused, and the error does not carry it", () => {
		for (const { root, source } of heldUnder(TEST_KEY))
			refusal(() => check(root, source, credentialShaped), credentialShaped.keyId);
		for (const { root, source } of heldUnder(OTHER_KEY))
			refusal(() => check(root, source, credentialShaped), credentialShaped.keyId);
	});

	it("a malformed key object is refused, beside a held position as well: never a different context", () => {
		for (const [what, key] of malformed)
			for (const { label, root, source } of heldUnder(TEST_KEY)) {
				const before = treeHash(root);
				refusal(() => check(root, source, key as never));
				expect(treeHash(root), `${what}, ${label}`).toBe(before);
			}
	});

	it("the refusal comes before the source is read: a nonexistent root never gives `absent` or `unavailable`", () => {
		const nowhere = "/definitely/not/a/store";
		for (const { source } of heldUnder(TEST_KEY)) {
			for (const key of [unpinnedOtherLabel, impersonator, credentialShaped, ...malformed.map(([, value]) => value)])
				refusal(() => check(nowhere, source, key as never));
			// ... while an admitted key of another context is answered without the root being read either.
			expect(check(nowhere, source, OTHER_KEY)).toBe("digest-context-differs");
		}
	});
});

describe("no key is the documented special case, and is not a supplied key", () => {
	it("no key beside a held position is `digest-context-differs`: there is no context to compare in", () => {
		for (const { label, root, source } of heldUnder(TEST_KEY)) {
			const before = treeHash(root);
			expect(check(root, source, undefined as never), label).toBe("digest-context-differs");
			expect(check(root, source, null as never), label).toBe("digest-context-differs");
			expect(treeHash(root)).toBe(before);
		}
	});

	it("no key with no held position is a usage error, and a held position that could not be read compares nothing", () => {
		const unreadable = [
			{
				domain: "event-log",
				condition: {
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "invalid-store", message: "x" },
				},
				watermark: null,
			},
			{
				domain: "harness-registry",
				attachment: ATTACHMENT,
				condition: {
					state: "unopenable",
					tornTail: null,
					sealedAt: null,
					error: { kind: "invalid-store", message: "x" },
				},
				watermark: null,
			},
		] as never[];
		const root = tempRoot();
		seedRegistry(root);
		for (const source of unreadable) {
			refusal(() => check(root, source, undefined as never));
			refusal(() => check(root, source, null as never));
			refusal(() => check(root, source, unpinnedOtherLabel), unpinnedOtherLabel.keyId);
			refusal(() => check(root, source, malformed[0]![1] as never));
			// An admitted key reads, and a consumer that holds no position starts from a fresh read.
			expect(check(root, source, TEST_KEY)).toBe("unavailable");
		}
	});
});
