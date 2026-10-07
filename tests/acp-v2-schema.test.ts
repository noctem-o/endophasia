// The ACP v2 schema pin. v2 is Draft: the study claims one exact upstream revision, and these tests make an SDK bump or an
// edit to the vendored baseline fail loudly instead of drifting under a mapping that still claims the old one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACP_SCHEMA_V2,
	ACP_V2_BASELINE_UPDATE_VARIANTS_V0,
	ACP_V2_FIELDS_READ_V0,
	ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0,
	assertAcpSchemaV2Pins,
	readAcpBaselineSchemaV2,
	readAcpSdkUnstableSchemaV2,
	validateAcpV2DefinitionV0,
	validateAcpV2UpdateV0,
} from "../adapters/acp/v2.ts";

const root = join(import.meta.dirname, "..");
const baseline = readAcpBaselineSchemaV2();
const unstable = readAcpSdkUnstableSchemaV2();
type Def = {
	properties?: Record<string, unknown>;
	anyOf?: Array<{ properties?: { sessionUpdate?: { const?: string } } }>;
	description?: string;
};
const bdefs = baseline.document.$defs as Record<string, Def>;
const udefs = unstable.document.$defs as Record<string, Def>;

describe("ACP v2 schema provenance", () => {
	it("names the Draft status, the SDK, the upstream commit and both digests", () => {
		expect(ACP_SCHEMA_V2.status).toBe("Draft");
		expect(ACP_SCHEMA_V2.protocolVersion).toBe(2);
		expect(ACP_SCHEMA_V2.packageVersion).toBe("1.7.0");
		expect(ACP_SCHEMA_V2.experimentalEntry).toBe("@agentclientprotocol/sdk/experimental/v2");
		expect(ACP_SCHEMA_V2.upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(ACP_SCHEMA_V2.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(ACP_SCHEMA_V2.sdkUnstable.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("vendors exactly the pinned baseline bytes, and the SDK ships exactly the pinned layered schema", () => {
		expect(baseline.sha256).toBe(ACP_SCHEMA_V2.baseline.sha256);
		expect(
			createHash("sha256")
				.update(readFileSync(join(root, ACP_SCHEMA_V2.baseline.path)))
				.digest("hex"),
		).toBe(ACP_SCHEMA_V2.baseline.sha256);
		expect(unstable.sha256).toBe(ACP_SCHEMA_V2.sdkUnstable.sha256);
		expect(() => assertAcpSchemaV2Pins(baseline.sha256, unstable.sha256)).not.toThrow();
	});

	it("fails loudly on any other bytes", () => {
		expect(() => assertAcpSchemaV2Pins("0".repeat(64))).toThrow(/vendored ACP v2 baseline/);
		expect(() => assertAcpSchemaV2Pins(baseline.sha256, "1".repeat(64))).toThrow(/installed .* has sha256/);
	});

	it("pins the SDK to the version the study inspected", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			devDependencies: Record<string, string>;
		};
		expect(manifest.devDependencies["@agentclientprotocol/sdk"]).toBe(ACP_SCHEMA_V2.packageVersion);
		const installed = JSON.parse(
			readFileSync(join(root, "node_modules/@agentclientprotocol/sdk/package.json"), "utf8"),
		) as {
			version: string;
			exports: Record<string, unknown>;
		};
		expect(installed.version).toBe(ACP_SCHEMA_V2.packageVersion);
		expect(Object.keys(installed.exports)).toContain("./experimental/v2");
		// The SDK ships the layered schema only: that is why the baseline is vendored.
		expect(Object.keys(installed.exports)).toContain("./schema/v2/schema.unstable.json");
		expect(Object.keys(installed.exports)).not.toContain("./schema/v2/schema.json");
	});
});

describe("ACP v2 baseline versus the SDK's layered schema", () => {
	it("is a subset: every baseline definition exists in the layered schema", () => {
		const missing = Object.keys(bdefs).filter((name) => !(name in udefs));
		expect(missing).toEqual([]);
	});

	it("contains no UNSTABLE marker, which the layered schema does", () => {
		expect(JSON.stringify(baseline.document)).not.toContain("**UNSTABLE**");
		expect(JSON.stringify(unstable.document)).toContain("**UNSTABLE**");
	});

	it("keeps the baseline and the unstable update variants apart, exactly", () => {
		const variants = (defs: Record<string, Def>) =>
			(defs.SessionUpdate?.anyOf ?? [])
				.map((branch) => branch.properties?.sessionUpdate?.const)
				.filter((v): v is string => v !== undefined);
		expect(variants(bdefs)).toEqual([...ACP_V2_BASELINE_UPDATE_VARIANTS_V0]);
		const layered = variants(udefs);
		// Everything the SDK layers on top is exactly the unstable list: no baseline variant is hidden in it and no
		// unstable one has leaked into the baseline.
		expect(layered.filter((variant) => !ACP_V2_BASELINE_UPDATE_VARIANTS_V0.includes(variant)).sort()).toEqual(
			[...ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0].sort(),
		);
		for (const variant of ACP_V2_BASELINE_UPDATE_VARIANTS_V0) expect(layered).toContain(variant);
		for (const variant of ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0) expect(variants(bdefs)).not.toContain(variant);
	});

	it("lists the baseline session methods the study exercises", () => {
		const meta = JSON.parse(readFileSync(join(root, "adapters/acp/schema-v2/meta.json"), "utf8")) as {
			agentMethods: Record<string, string>;
			clientMethods: Record<string, string>;
		};
		for (const method of [
			"session/new",
			"session/list",
			"session/resume",
			"session/close",
			"session/prompt",
			"session/cancel",
		])
			expect(Object.values(meta.agentMethods), method).toContain(method);
		expect(Object.values(meta.clientMethods)).toEqual(
			expect.arrayContaining(["session/update", "session/request_permission"]),
		);
	});

	it("does not read an UNSTABLE field, and every field it reads exists in the baseline", () => {
		for (const [definition, fields] of Object.entries(ACP_V2_FIELDS_READ_V0)) {
			expect(bdefs[definition], definition).toBeDefined();
			for (const field of fields) {
				expect(Object.keys(bdefs[definition]?.properties ?? {}), `${definition}.${field}`).toContain(field);
				const layered = udefs[definition]?.properties?.[field] as { description?: string } | undefined;
				expect(layered?.description ?? "", `${definition}.${field}`).not.toContain("**UNSTABLE**");
			}
		}
	});

	it("keeps unstable capabilities out of the baseline's capability objects", () => {
		for (const [definition, unstableFields] of [
			["AgentCapabilities", ["providers", "nes", "positionEncoding"]],
			["SessionCapabilities", ["fork"]],
		] as const)
			for (const field of unstableFields) {
				expect(Object.keys(bdefs[definition]?.properties ?? {}), `${definition}.${field}`).not.toContain(field);
				expect(Object.keys(udefs[definition]?.properties ?? {}), `${definition}.${field}`).toContain(field);
			}
	});
});

describe("ACP v2 baseline validation", () => {
	const options = [{ optionId: "a", name: "A", kind: "allow_once" }];
	it("validates the initialize shape by role-neutral names, and rejects the v1 shape", () => {
		expect(
			validateAcpV2DefinitionV0("InitializeResponse", {
				protocolVersion: 2,
				info: { name: "a", version: "1" },
				capabilities: { session: {} },
			}),
		).toBe(true);
		expect(
			validateAcpV2DefinitionV0("InitializeResponse", {
				protocolVersion: 1,
				agentInfo: { name: "a", version: "1" },
				agentCapabilities: {},
			}),
		).toBe(false);
	});

	it("validates the prompt response as an acceptance carrying a message id", () => {
		expect(validateAcpV2DefinitionV0("PromptResponse", { messageId: "m" })).toBe(true);
		expect(validateAcpV2DefinitionV0("PromptResponse", { stopReason: "end_turn" })).toBe(false);
		expect(validateAcpV2DefinitionV0("PromptResponse", { messageId: null })).toBe(false);
	});

	it("requires a permission title and options, and validates subjects by their definition", () => {
		const base = { sessionId: "s", title: "t", options };
		expect(validateAcpV2DefinitionV0("RequestPermissionRequest", base)).toBe(true);
		expect(validateAcpV2DefinitionV0("RequestPermissionRequest", { sessionId: "s", options })).toBe(false);
		expect(validateAcpV2DefinitionV0("RequestPermissionRequest", { ...base, options: [] })).toBe(false);
		// "Must be an absolute path" is prose in the baseline: AbsolutePath is a plain string in the schema, so a relative cwd
		// validates. The study does not strengthen the schema; it never acts on a command's cwd (docs/acp-v2-study.md).
		expect(
			validateAcpV2DefinitionV0("RequestPermissionRequest", {
				...base,
				subject: { type: "command", command: "ls", cwd: "relative" },
			}),
		).toBe(true);
		expect(validateAcpV2DefinitionV0("RequestPermissionRequest", { ...base, subject: { type: "tool_call" } })).toBe(
			false,
		);
		// Open, by design: a custom or future subject is valid and carried as-is.
		expect(
			validateAcpV2DefinitionV0("RequestPermissionRequest", {
				...base,
				subject: { type: "_vendor", anything: [1, 2] },
			}),
		).toBe(true);
	});

	it("accepts custom and future values where the baseline is open, and rejects them where it is closed", () => {
		expect(validateAcpV2UpdateV0("state_update", { sessionUpdate: "state_update", state: "_busy" })).toBe(true);
		expect(
			validateAcpV2UpdateV0("state_update", {
				sessionUpdate: "state_update",
				state: "idle",
				stopReason: "_vendor_reason",
			}),
		).toBe(true);
		expect(validateAcpV2UpdateV0("state_update", { sessionUpdate: "state_update", state: 3 })).toBe(false);
		expect(
			validateAcpV2UpdateV0("agent_message_chunk", {
				sessionUpdate: "agent_message_chunk",
				messageId: "m",
				content: { type: "_custom", x: 1 },
			}),
		).toBe(true);
		expect(
			validateAcpV2UpdateV0("agent_message_chunk", { sessionUpdate: "agent_message_chunk", messageId: "m" }),
		).toBe(false);
	});

	it("validates message upserts: content may be omitted, null or an array, never anything else", () => {
		const base = { sessionUpdate: "agent_message", messageId: "m" };
		expect(validateAcpV2UpdateV0("agent_message", base)).toBe(true);
		expect(validateAcpV2UpdateV0("agent_message", { ...base, content: null })).toBe(true);
		expect(validateAcpV2UpdateV0("agent_message", { ...base, content: [] })).toBe(true);
		expect(validateAcpV2UpdateV0("agent_message", { ...base, content: "text" })).toBe(false);
		expect(validateAcpV2UpdateV0("agent_message", { sessionUpdate: "agent_message", content: [] })).toBe(false);
	});

	it("checks the calendar of a date-time, not just that something parses", () => {
		const info = (updatedAt: string) => ({ sessionId: "s", cwd: "/a", updatedAt });
		expect(validateAcpV2DefinitionV0("SessionInfo", info("2024-02-29T23:59:60+05:30"))).toBe(true);
		for (const bad of [
			"2023-02-30T00:00:00Z",
			"2023-02-29T00:00:00Z",
			"2023-13-01T00:00:00Z",
			"2023-04-31T00:00:00Z",
			"2023-01-01T24:00:00Z",
			"2023-01-01T00:00:00+24:00",
		])
			expect(validateAcpV2DefinitionV0("SessionInfo", info(bad)), bad).toBe(false);
	});

	it("validates the URI grammar, not just that the URL parser accepts it", () => {
		const link = (uri: string) => ({ type: "resource_link", name: "n", uri });
		for (const good of [
			"file:///tmp/a%20b.txt",
			"https://example.test:8080/p?q=1#frag",
			"http://[::1]/x",
			"urn:isbn:0451450523",
			"mailto:a@example.test",
		])
			expect(validateAcpV2DefinitionV0("ResourceLink", link(good)), good).toBe(true);
		for (const bad of [
			"http://example.test/%zz",
			"http://example.test/%a",
			"http://exa mple.test/",
			"http://example.test/\u00e9",
			"/no/scheme",
			"1http://x",
			"http://example.test/#a#b",
			"http://[::1/x",
		])
			expect(validateAcpV2DefinitionV0("ResourceLink", link(bad)), bad).toBe(false);
	});

	it("validates a bracketed host as an RFC 3986 IPv6 or IPvFuture literal", () => {
		const link = (uri: string) => ({ type: "resource_link", name: "n", uri });
		for (const good of [
			"http://[::1]/",
			"http://[::]/",
			"http://[2001:db8::8a2e:370:7334]/",
			"http://[1:2:3:4:5:6:7:8]/",
			"http://[1:2:3:4:5:6:7::]/",
			"http://[::2:3:4:5:6:7:8]/",
			"http://[1::8]:8080/p",
			"http://[::ffff:192.0.2.128]/",
			"http://[1:2:3:4:5:6:192.0.2.1]/",
			"http://[64:ff9b::192.0.2.33]/",
			"http://u:p@[fe80::1]/",
			"http://[v7.a:b]/",
			"http://[vF.~!$&'()*+,;=:x]/",
		])
			expect(validateAcpV2DefinitionV0("ResourceLink", link(good)), good).toBe(true);
		for (const bad of [
			"http://[::::]/",
			"http://[1:2:3:4:5:6:7:8:9]/",
			"http://[1:2:3:4:5:6:7]/",
			"http://[1::2::3]/",
			"http://[:1:2:3:4:5:6:7]/",
			"http://[1:2:3:4:5:6:7:]/",
			"http://[:::1]/",
			"http://[12345::1]/",
			"http://[g::1]/",
			"http://[1:2:3:4:5:6:7:8::]/",
			"http://[::1:2:3:4:5:6:7:8]/",
			"http://[::1.2.3]/",
			"http://[::256.0.0.1]/",
			"http://[::01.2.3.4]/",
			"http://[1.2.3.4::]/",
			"http://[1.2.3.4]/",
			"http://[fe80::1%25eth0]/",
			"http://[]/",
			"http://[/",
			"http://[::1/x",
			"http://[::1]x/",
			"http://[::1]:80a/",
			"http://[v.a]/",
			"http://[vG.a]/",
			"http://[v1.]/",
			"http://[v1.a b]/",
		])
			expect(validateAcpV2DefinitionV0("ResourceLink", link(bad)), bad).toBe(false);
	});

	it("enforces contentEncoding base64 wherever the baseline declares it", () => {
		const good = ["", "QQ==", "QUI=", "QUJD", "AAECAwQFBgcICQ==", "+/+/"];
		const bad = [
			"not base64!",
			"QQ=",
			"Q",
			"QUJDR",
			"=QQQ",
			"QQ==QQ==",
			"QU=J",
			"QUJD ",
			"QQ==\n",
			"Q-J_",
			"QQ===",
			"é===",
			"AB==".concat("="),
		];
		const forms: Array<[string, (data: string) => unknown]> = [
			["ImageContent", (data) => ({ type: "image", data, mimeType: "image/png" })],
			["AudioContent", (data) => ({ type: "audio", data, mimeType: "audio/wav" })],
			["BlobResourceContents", (blob) => ({ blob, uri: "file:///a" })],
			["TerminalOutput", (data) => ({ data })],
			["TerminalOutputChunk", (data) => ({ terminalId: "t", data })],
		];
		for (const [definition, make] of forms) {
			for (const value of good)
				expect(validateAcpV2DefinitionV0(definition, make(value)), `${definition} ${value}`).toBe(true);
			for (const value of bad)
				expect(validateAcpV2DefinitionV0(definition, make(value)), `${definition} ${value}`).toBe(false);
		}
		// And through an update, where the failure becomes a malformed event rather than retained state.
		expect(
			validateAcpV2UpdateV0("agent_message", {
				sessionUpdate: "agent_message",
				messageId: "m",
				content: [{ type: "image", data: "not base64!", mimeType: "image/png" }],
			}),
		).toBe(false);
	});

	it("refuses to give a verdict on a variant the baseline does not list", () => {
		expect(() => validateAcpV2UpdateV0("notice", {})).toThrow(/not a baseline/);
		expect(() => validateAcpV2DefinitionV0("ListProvidersResponse", {})).toThrow(/defines no/);
	});

	it("does not accept a 64-bit integer a JS number cannot hold exactly", () => {
		expect(validateAcpV2UpdateV0("usage_update", { sessionUpdate: "usage_update", used: 1, size: 2 })).toBe(true);
		expect(validateAcpV2UpdateV0("usage_update", { sessionUpdate: "usage_update", used: 2 ** 60, size: 2 })).toBe(
			false,
		);
	});
});
