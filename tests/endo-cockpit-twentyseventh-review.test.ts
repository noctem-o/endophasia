// PR #57 review round 27: the text policy withholds a network address with no URI scheme.
//
// The policy flagged `scheme://host` only, so `failed connecting to 10.0.0.5:8080` and `host db.internal:5432` were presented
// whole in a capability reason, a notice title, a version or a timeline string. Evidence that text is an address is a port or an
// IP-literal shape, never a dot alone (the same predicate gates kinds, producers, identifiers and versions, whose grammars are
// dotted): IPv4 with or without a port; `localhost` or a dotted name ending in a letter label, with a port; IPv6 literals, bare or
// bracketed. A flagged value is withheld WHOLE. The scheme pattern is also rewritten to a form that scans each run once: it was
// quadratic in the length of a token of scheme characters, on text checked before any length bound.
//
// A heuristic: single-label `host:port`, a bare dotted name, unusual IPv4 spellings and obfuscated forms are NOT detected
// (the `documented residuals` test pins that, so a later change is deliberate).

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
	ENDO_COCKPIT_MAX_FIELD_TEXT_V0,
	endoCockpitPresentableTextV0,
	endoCockpitTextPresentableV0,
	endoCockpitTextUnsafeV0,
} from "../protocol/cockpit-fields.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import {
	ATTACHMENT,
	changeRecord,
	event,
	ingestAll,
	notificationRecord,
	removeTempRoots,
	specimen,
	specimenRecords,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import { readEndoCockpitSnapshotV0 } from "./cockpit-keyed.ts";
import {
	capabilitiesOf,
	identityOf,
	mutated,
	snapshotFrom,
	snapshotOf,
	timelineOf,
} from "./cockpit-registry-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const WITHHELD = ENDO_COCKPIT_WITHHELD_TEXT_V0;
// Synthetic and distinctive: nothing of these may appear anywhere in a projection that read them.
const IP = "10.66.77.88";
const IP_PORT = "47123";
const HOST = "db.canary-internal";
const HOST_PORT = "47124";
const LEAKS = [IP, IP_PORT, HOST, HOST_PORT, "canary-internal"];

/** Every text must be unsafe, not presentable, and replaced by the one fixed text. */
const withheld = (text: string) => {
	expect(endoCockpitTextUnsafeV0(text), `unsafe ${JSON.stringify(text)}`).toBe(true);
	expect(endoCockpitTextPresentableV0(text), `presentable ${JSON.stringify(text)}`).toBe(false);
	expect(endoCockpitPresentableTextV0(text), `replaced ${JSON.stringify(text)}`).toBe(WITHHELD);
};
const presented = (text: string) => {
	expect(endoCockpitTextUnsafeV0(text), `unsafe ${JSON.stringify(text)}`).toBe(false);
	expect(endoCockpitTextPresentableV0(text), `presentable ${JSON.stringify(text)}`).toBe(true);
	expect(endoCockpitPresentableTextV0(text), `as written ${JSON.stringify(text)}`).toBe(text);
};

describe("the finding's two examples (P2)", () => {
	for (const text of ["failed connecting to 10.0.0.5:8080", "host db.internal:5432"])
		it(`${JSON.stringify(text)} is withheld whole`, () => {
			withheld(text);
			// Whole, never partly rewritten: nothing of the sentence, the host or the port is in what replaces it.
			const shown = endoCockpitPresentableTextV0(text);
			expect(shown).toBe(WITHHELD);
			for (const part of ["failed", "connecting", "host", "10.0.0.5", "8080", "db.internal", "5432"])
				expect(shown.includes(part), part).toBe(false);
		});
});

describe("the address forms that are withheld", () => {
	const forms: [string, string[]][] = [
		[
			"IPv4, bare or with a port, private, loopback, link-local and public",
			[
				"192.168.1.100",
				"127.0.0.1:8000",
				"10.20.30.40:443",
				"169.254.10.20",
				"172.16.0.1:22",
				"8.8.8.8",
				"0.0.0.0:0",
				"255.255.255.255:65535",
			],
		],
		[
			"IPv4 inside a sentence and punctuation",
			[
				"connect to 10.0.0.5.",
				"(10.0.0.5)",
				"peer=10.0.0.5,",
				"[10.0.0.5]:9",
				'"10.0.0.5"',
				"ip-10.0.0.5",
				"user@10.0.0.5:22",
				"retry 3 times: 10.0.0.5:8080 refused",
			],
		],
		[
			"a dotted name with a port, and localhost",
			[
				"localhost:3000",
				"LOCALHOST:3000",
				"db.internal:5432",
				"api.example.org:8443",
				"a.b:1",
				"db-1.us-east-1.rds.internal:5432",
				"my_db.internal:5432",
				"db.my_corp.internal:5432",
				"user@db.internal:5432",
				"(db.internal:5432)",
				"host=db.internal:5432,",
				"via 'cache.corp:6379'",
				"x.example.test:65535",
			],
		],
		[
			"IPv6, bracketed with a port and bare",
			[
				"[::1]:8080",
				"[fe80::1]:9000",
				"::1",
				"fe80::1",
				"fe80::1%eth0",
				"2001:db8::8a2e:370:7334",
				"2001:0db8:0000:0000:0000:ff00:0042:8329",
				"1::",
				"::ffff:10.0.0.5",
				"connect to [2001:db8::1]:443 failed",
			],
		],
	];
	for (const [label, texts] of forms)
		it(label, () => {
			for (const text of texts) withheld(text);
		});

	it("is judged on the NFKC form as well as the text as written", () => {
		for (const text of [
			"１０．０．０．５：８０８０", // fullwidth digits, full stop and colon
			"ｄｂ．ｉｎｔｅｒｎａｌ：５４３２",
			"𝟏𝟎.𝟎.𝟎.𝟓:𝟖𝟎𝟖𝟎", // mathematical bold digits
			"ｌｏｃａｌｈｏｓｔ:3000",
			"ｆｅ８０::１",
		])
			withheld(text);
		// An address split by an invisible character is seen too: the character itself is already unsafe, and so is the rest.
		withheld("10.0.0.\u200b5:8080");
		withheld("db.in\u2060ternal:5432");
	});

	it("keeps the existing protections: URLs, paths, credentials, control characters and the length bound", () => {
		for (const text of [
			"https://example.test/x",
			"postgres://u:p@host/db",
			"ftp://x",
			"1+2.x://y",
			"/home/someone/.config",
			"C:\\Users\\someone",
			"\\\\server\\share\\x",
			"sk-abcdefghijklmnopqrstuvwxyz",
			"Bearer abcdefgh12345678",
			"api_key=abcd1234",
			"a\u0000b",
			"a\u202eb",
		])
			withheld(text);
		expect(endoCockpitTextPresentableV0("x".repeat(ENDO_COCKPIT_MAX_FIELD_TEXT_V0))).toBe(true);
		expect(endoCockpitTextPresentableV0("x".repeat(ENDO_COCKPIT_MAX_FIELD_TEXT_V0 + 1))).toBe(false);
		expect(endoCockpitPresentableTextV0("x".repeat(ENDO_COCKPIT_MAX_FIELD_TEXT_V0 + 1))).toBe(WITHHELD);
		// The whole value is judged before the bound: an address past the bound is not what makes it long, but is seen all the same.
		expect(endoCockpitTextUnsafeV0(`${"x ".repeat(5000)}10.0.0.5:80`)).toBe(true);
		// The fixed text itself is presentable and is not an address.
		expect(endoCockpitTextUnsafeV0(WITHHELD)).toBe(false);
	});
});

describe("ordinary technical text stays presentable", () => {
	it("versions, counters, durations, model names, timestamps and code notation", () => {
		for (const text of [
			"version 1.2.3",
			"release 2.4.0",
			"1.0.0",
			"0.1.0-alpha.1",
			"pi-rpc-adapter.2",
			"retry count: 3",
			"status: 200",
			"status:200",
			"duration: 12ms",
			"model Qwen3.8-27B",
			"llama3.1:8b",
			"qwen2.5:7",
			"gpt-4o:latest",
			// A dotted model id ending in `:0` is not an endpoint: port 0 is not evidence (an IPv4 address with it is still withheld).
			"anthropic.claude-3-5-sonnet-20241022-v2:0",
			"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			"meta.llama3-70b-instruct-v1:0",
			"localhost:0",
			"12:30:45",
			"2026-10-18T19:45:46Z",
			"std::vector",
			"Base64::decode2",
			"Vec::new",
			"1.2.3.4.5",
			"v1.2.3.4",
			"endo.x.1.2.3.4",
			"10.0.0.256",
			"256.1.1.1",
			"01.02.03.04",
			"1.2.3",
			"3.14159",
			"a::b",
			"::",
			"pi:attach-name",
			"live-study check pi.live.study; supersedes pi.local.state",
			"Continuity holds once the session was persisted, which Pi does at its first message",
			"the runtime did not say",
		])
			presented(text);
	});

	it("names of the kinds the protocol itself admits are not touched", () => {
		for (const kind of [
			"session.identity",
			"session.entries-cursor",
			"harness.attached",
			"lifecycle.session-started",
		])
			expect(endoCockpitTextUnsafeV0(kind), kind).toBe(false);
	});

	it("a four-part dotted number with octets of at most 255 IS withheld, a deliberate conservative choice", () => {
		// `1.2.3.4` is a valid address and a possible four-part version: with no context the policy fails closed. A three-part or a
		// five-part version, or an octet over 255, is not an address and is presented.
		withheld("1.2.3.4");
		withheld("build 10.0.0.5");
		presented("1.2.3");
		presented("1.2.3.4.5");
	});

	it("a source reference such as server.ts:42 IS withheld: it has the shape of a dotted host and a port", () => {
		// No extension list is kept: telling `server.ts:42` from `db.ts:5432` needs one, and a list is a bypass to maintain. A
		// withheld error text is the safe failure. (A path with a directory is withheld by the path rule in any case.)
		for (const text of ["server.ts:42", "at agent-session.ts:14776", "config.yaml:3:7", "README.md:1"])
			withheld(text);
		presented("an error in the server module");
	});

	it("a dotted model id ending in :1 or :2 IS withheld: the same shape as a host and a port", () => {
		withheld("anthropic.claude-v2:1");
		withheld("0.0.0.0:0"); // an IPv4 address is withheld whatever follows it, port 0 included
	});

	it("documented residuals: forms the policy does not claim to catch", () => {
		for (const text of [
			"db:5432", // single-label host and port: the shape of key:value
			"redis:6379",
			"db.internal", // a dotted name with no port: the shape of a kind or a package
			"api.example.org",
			"addr:fe80::1", // an IPv6 literal glued to a word by a colon
			"aa:bb:cc:dd:ee:ff", // a MAC address
			"ip-10-0-0-5", // dashed
			"167772165", // integer, hex and octal spellings
			"0x0a000005",
			"10[.]0[.]0[.]5", // obfuscated
			"10。0。0。5", // an ideographic full stop is not folded to a dot by NFKC
			"user@db.internal",
			"127.1", // a shortened IPv4 spelling
			"db.internal.:5432", // a trailing-dot name
			"db.internal:08080", // a leading-zero port
			":::8080",
			"١٠.٠.٠.٥:٨٠٨٠", // Arabic-Indic digits, which NFKC does not fold to ASCII
		])
			expect(endoCockpitTextUnsafeV0(text), `not claimed: ${text}`).toBe(false);
	});
});

describe("the scheme pattern keeps its meaning and no longer costs the square of a token", () => {
	// The pattern as it was before this round, as an oracle: a letter, scheme characters, `://`, something.
	const before = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S/;
	const alphabet = ["a", "Z", "1", "+", ".", "-", ":", "/", " "];
	it("agrees with the previous pattern on every string of up to 6 characters over its alphabet", () => {
		let count = 0;
		let positives = 0;
		const grow = (prefix: string) => {
			count += 1;
			const was = before.test(prefix);
			const now = endoCockpitTextUnsafeV0(prefix);
			// The policy also has other patterns; here only a string the old pattern matched must stay unsafe, and a string no pattern
			// of the policy but the scheme one could match must stay presentable.
			if (was) {
				positives += 1;
				expect(now, JSON.stringify(prefix)).toBe(true);
			}
			if (prefix.length === 6) return;
			for (const letter of alphabet) grow(prefix + letter);
		};
		grow("");
		expect(count).toBe(597_871); // sum of 9^k for k = 0..6
		expect(positives).toBeGreaterThan(300);
	});

	it("no new scheme match appears: the anchored pattern matches exactly the strings the previous one did", () => {
		// The converse cannot be read off the policy (its path, drive and host patterns also match some of these strings), so the
		// anchored pattern is restated here and compared with the previous one directly.
		const after = /(?<![A-Za-z0-9+.-])[0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/\S/;
		const grow = (prefix: string) => {
			expect(after.test(prefix), JSON.stringify(prefix)).toBe(before.test(prefix));
			if (prefix.length === 6) return;
			for (const letter of alphabet) grow(prefix + letter);
		};
		grow("");
	});
});

describe("resource use on hostile text is linear in its length", () => {
	// Each generator makes a text of about `n` characters built to provoke a backtracking or rescanning cost. A linear predicate
	// takes 16 times as long on 16 times the text, a quadratic one 256 times; a threshold of 64 separates them with room for the
	// noise of a loaded machine. Compared by ratio and best of three runs, not by an absolute time.
	const generators: Record<string, (n: number) => string> = {
		"digits and dots": (n) => "1.".repeat(n / 2),
		"three octets, repeated": (n) => "1.1.1 ".repeat(n / 6),
		"octets over 255": (n) => "256.256.256.256 ".repeat(n / 16),
		"one-letter labels": (n) => "a.".repeat(n / 2),
		"63-character labels": (n) => `${"a".repeat(63)}.`.repeat(n / 64),
		"hyphenated labels": (n) => `${"a-".repeat(n / 2)}.`,
		"a long label then a dot": (n) => `${"a".repeat(n)}.`,
		"hostnames with an invalid port": (n) => "a.b:99999 ".repeat(n / 10),
		"repeated candidate hosts": (n) => "db.internal ".repeat(n / 12),
		"dotted names and colons": (n) => "a.a:b.c:".repeat(n / 8),
		"colons only": (n) => ":".repeat(n),
		"colon, hex": (n) => ":a".repeat(n / 2),
		"hex groups": (n) => "ab:".repeat(n / 3),
		"unclosed brackets": (n) => "[::1".repeat(n / 4),
		"near IPv6": (n) => `${"fe80::".repeat(n / 6)}g`,
		"one long token": (n) => "a".repeat(n),
		"scheme characters, no separator": (n) => "a+.-".repeat(n / 4),
		"scheme characters, a lone colon": (n) => `${"a1+.-".repeat(n / 5)}:`,
		slashes: (n) => "://".repeat(n / 3),
		whitespace: (n) => " ".repeat(n),
		"key words": (n) => "token ".repeat(n / 6),
		// Ordinary log text that reaches the IPv6 parser's split on every run.
		"clock times": (n) => "12:30:45 ".repeat(n / 9),
		"short hex groups": (n) => "1:2:3:4:5:6:7:8 ".repeat(n / 16),
		"underscore labels": (n) => "a_b.".repeat(n / 4),
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
	for (const [name, make] of Object.entries(generators))
		it(name, () => {
			const small = best(make(32_768));
			const large = best(make(524_288));
			// Under a few milliseconds is below what a ratio can measure; the quadratic pattern took 55 ms at 8,192 characters.
			expect(large, `${name}: ${small.toFixed(1)} ms at 32K, ${large.toFixed(1)} ms at 512K`).toBeLessThan(
				Math.max(64 * small, 100),
			);
		});

	it("a text far past the bound is still judged whole, and an address at its end is found", () => {
		const text = `${"word ".repeat(200_000)}host db.internal:5432`;
		expect(text.length).toBeGreaterThan(1_000_000);
		expect(endoCockpitTextUnsafeV0(text)).toBe(true);
		expect(endoCockpitPresentableTextV0(text)).toBe(WITHHELD);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Source-backed projections
// ---------------------------------------------------------------------------------------------------------------

describe("a recorded endpoint is withheld whole by the projectors, and the projections still validate", () => {
	const reason = `failed connecting to ${IP}:${IP_PORT}`;
	const limitation = `host ${HOST}:${HOST_PORT} refused the connection`;
	const title = `Pi runtime moved behind ${IP}:${IP_PORT}`;

	/** The specimen's registry with an endpoint in a capability reason, an evidence limitation and a notice title. */
	function recordsWithEndpoints() {
		const records = specimenRecords();
		return {
			...records,
			state: records.state.map((state) =>
				mutated(state, (copy) => {
					copy.capabilities[0].reason = reason;
				}),
			),
			evidence: records.evidence.map((item) =>
				mutated(item, (copy) => {
					copy.limitations = [limitation, ...copy.limitations];
				}),
			),
			change: [changeRecord()],
			notification: [notificationRecord({ title })],
		};
	}
	const leaks = (value: unknown) => LEAKS.filter((canary) => JSON.stringify(value).includes(canary));

	it("a capability reason, an evidence limitation and a notice title: the whole value is the fixed text", () => {
		const records = recordsWithEndpoints();
		const before = structuredClone(records);
		const capabilities = capabilitiesOf(records);
		const identity = identityOf(records);
		expect(capabilities.capabilities[0]!.reason).toBe(WITHHELD);
		// Each cited evidence record now leads with the endpoint: that limitation alone is the fixed text, the others as recorded.
		const plain = capabilitiesOf(specimenRecords());
		const cited = capabilities.capabilities.filter((entry) => entry.evidence !== null);
		expect(cited.length).toBeGreaterThan(0);
		for (const entry of cited) {
			const unchanged = plain.capabilities.find((item) => item.capability === entry.capability)!;
			expect(entry.limitations, entry.capability).toEqual([WITHHELD, ...unchanged.limitations]);
		}
		expect(identity.lastNotification?.title).toBe(WITHHELD);
		// Nothing of the endpoint anywhere else: not in notes, refs, limits or any other field.
		expect(leaks(capabilities)).toEqual([]);
		expect(leaks(identity)).toEqual([]);
		for (const kept of ["failed connecting", "refused the connection", "moved behind"])
			expect(JSON.stringify([capabilities, identity]).includes(kept), kept).toBe(false);
		// The source is as it was.
		expect(records).toEqual(before);
		expect(JSON.stringify(records)).toContain(IP);
	});

	it("every projection validates, as does a snapshot holding them, and a repeated read is identical", () => {
		const records = recordsWithEndpoints();
		const capabilities = capabilitiesOf(records);
		const identity = identityOf(records);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		expect(validateEndoCockpitRuntimeIdentityV0(identity)).not.toBeNull();
		const snapshot = snapshotFrom(identity, capabilities);
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		expect(leaks(snapshot)).toEqual([]);
		expect(JSON.stringify(capabilitiesOf(records))).toBe(JSON.stringify(capabilities));
		expect(JSON.stringify(identityOf(records))).toBe(JSON.stringify(identity));
	});

	it("the specimen's own reasons are presented exactly as recorded, unless over the bound: the rule adds no withholding there", () => {
		const recorded = new Map(
			specimenRecords().state[0]!.capabilities.map((entry) => [entry.capability, entry.reason]),
		);
		const plain = capabilitiesOf(specimenRecords());
		expect(plain.capabilities.length).toBe(recorded.size);
		for (const entry of plain.capabilities) {
			const text = recorded.get(entry.capability)!;
			expect(entry.reason, entry.capability).toBe(text.length > ENDO_COCKPIT_MAX_FIELD_TEXT_V0 ? WITHHELD : text);
		}
		expect(validateEndoCockpitSnapshotV0(snapshotOf(specimenRecords()))).not.toBeNull();
	});

	it("the wire validators refuse an endpoint a projection should have withheld", () => {
		const records = recordsWithEndpoints();
		const capabilities = capabilitiesOf(records);
		const identity = identityOf(records);
		const timeline = timelineOf(
			event("lifecycle.session-started", {
				runtime: "pi",
				instance: "i-1",
				unavailable: [{ field: "endpoint", reason: "no endpoint recorded" }],
			}),
		);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		for (const text of [`failed connecting to ${IP}:${IP_PORT}`, `host ${HOST}:${HOST_PORT}`, `[::1]:${IP_PORT}`]) {
			const reasonForged = mutated(capabilities, (copy) => {
				copy.capabilities[0].reason = text;
			});
			expect(validateEndoCockpitCapabilityStateV0(reasonForged), `reason ${text}`).toBeNull();
			const limitationForged = mutated(capabilities, (copy) => {
				const entry = copy.capabilities.find((item: { limitations: string[] }) => item.limitations.length > 0);
				entry.limitations[0] = text;
			});
			expect(validateEndoCockpitCapabilityStateV0(limitationForged), `limitation ${text}`).toBeNull();
			const titleForged = mutated(identity, (copy) => {
				copy.lastNotification.title = text;
			});
			expect(validateEndoCockpitRuntimeIdentityV0(titleForged), `title ${text}`).toBeNull();
			const snapshotForged = mutated(snapshotFrom(identity, capabilities), (copy) => {
				copy.runtimes[0].identity.lastNotification.title = text;
			});
			expect(validateEndoCockpitSnapshotV0(snapshotForged), `snapshot ${text}`).toBeNull();
			const timelineForged = mutated(timeline, (copy) => {
				copy.entries[0].fields["unavailable.endpoint"].reason = text;
			});
			expect(validateEndoCockpitSessionTimelineV0(timelineForged), `timeline ${text}`).toBeNull();
		}
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();
	});

	it("a timeline: a declared-unavailable reason naming an endpoint is withheld whole, an ordinary one is not", () => {
		const log = timelineOf(
			event("lifecycle.session-started", {
				runtime: "pi",
				instance: "i-1",
				unavailable: [
					{ field: "endpoint", reason: `failed connecting to ${IP}:${IP_PORT}` },
					{ field: "run", reason: "the runtime did not say" },
				],
			}),
		);
		const fields = log.entries[0]!.fields;
		expect(fields["unavailable.endpoint"]).toEqual({ basis: "unavailable", reason: WITHHELD });
		expect(fields["unavailable.run"]).toEqual({ basis: "unavailable", reason: "the runtime did not say" });
		expect(leaks(log)).toEqual([]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
	});

	it("a timeline string field (`instance` of harness.attached): an endpoint is withheld, an ordinary value is presented", () => {
		const fingerprintId = "endo.evidence.pi-fingerprint.one";
		const log = timelineOf(
			event("harness.attached", { fingerprintId, instance: `${HOST}:${HOST_PORT}` }),
			event("harness.attached", { fingerprintId, instance: `failed connecting to ${IP}:${IP_PORT}` }),
			event("harness.attached", { fingerprintId, instance: "i-1" }),
		);
		const instance = (at: number) => log.entries[at]!.fields.instance;
		expect(instance(0)).toEqual({ basis: "unavailable", reason: WITHHELD });
		expect(instance(1)).toEqual({ basis: "unavailable", reason: WITHHELD });
		expect(instance(2)).toMatchObject({ value: "i-1" }); // the control: the field is presented when it is ordinary
		expect(log.entries[0]!.withheldFields).toBeGreaterThan(0);
		expect(leaks(log)).toEqual([]);
		expect(validateEndoCockpitSessionTimelineV0(log)).not.toBeNull();
		const forged = mutated(log, (copy) => {
			copy.entries[2].fields.instance.value = `${HOST}:${HOST_PORT}`;
		});
		expect(validateEndoCockpitSessionTimelineV0(forged)).toBeNull();
	});

	it("a version: an endpoint recorded as a check, adapter or extension version is withheld, and the wire refuses it", () => {
		const records = specimenRecords();
		const endpoint = `${IP}:${IP_PORT}`;
		const withVersions = {
			...records,
			evidence: records.evidence.map((item) =>
				mutated(item, (copy) => {
					copy.check.version = endpoint;
					copy.dependencies.adapterVersion = `adapter at ${endpoint}`;
					copy.dependencies.mappingVersion = `${HOST}:${HOST_PORT}`;
				}),
			),
		};
		const capabilities = capabilitiesOf(withVersions);
		const cited = capabilities.capabilities.filter((entry) => entry.evidence !== null);
		expect(cited.length).toBeGreaterThan(0);
		for (const entry of cited) {
			expect(entry.evidence!.check.version, entry.capability).toBe(WITHHELD);
			expect(entry.evidence!.dependencies.adapterVersion, entry.capability).toBe(WITHHELD);
			expect(entry.evidence!.dependencies.mappingVersion, entry.capability).toBe(WITHHELD);
			// Only what was an endpoint is withheld: the suite version was not touched.
			expect(entry.evidence!.dependencies.suiteVersion, entry.capability).not.toBe(WITHHELD);
		}
		expect(leaks(capabilities)).toEqual([]);
		expect(validateEndoCockpitCapabilityStateV0(capabilities)).not.toBeNull();
		const forged = mutated(capabilities, (copy) => {
			copy.capabilities.find((entry: { evidence: unknown }) => entry.evidence !== null).evidence.check.version =
				endpoint;
		});
		expect(validateEndoCockpitCapabilityStateV0(forged)).toBeNull();
	});

	it("reached from a durable store, through the normal read: withheld, the store untouched, the snapshot valid", () => {
		const root = tempRoot();
		const { fingerprint, evidence, state } = specimen();
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", fingerprint);
		for (const item of evidence) registry.append("evidence", item);
		registry.append(
			"state",
			mutated(state, (copy) => {
				copy.capabilities[0].reason = reason;
			}),
		);
		ingestAll(root, [
			event("lifecycle.session-started", {
				runtime: "pi",
				instance: "i-1",
				unavailable: [{ field: "endpoint", reason: `failed connecting to ${IP}:${IP_PORT}` }],
			}),
		]);
		const stored = treeHash(root);
		const snapshot = readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] });
		expect(treeHash(root), "reading changed the store").toBe(stored);
		expect(snapshot.runtimes).toHaveLength(1);
		expect(snapshot.runtimes[0]!.capabilities.capabilities[0]!.reason).toBe(WITHHELD);
		expect(snapshot.timeline.entries[0]!.fields["unavailable.endpoint"]).toEqual({
			basis: "unavailable",
			reason: WITHHELD,
		});
		expect(leaks(snapshot)).toEqual([]);
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		expect(JSON.stringify(readEndoCockpitSnapshotV0(root, { attachments: [ATTACHMENT] }))).toBe(
			JSON.stringify(snapshot),
		);
	});
});
