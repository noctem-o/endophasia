// The schema-backed validation boundary: the validator is bound to the exact public schema the pinned SDK ships, and a
// recognized stable v1 variant is accepted or rejected by that schema, not by hand-written predicates.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACP_SCHEMA_V0,
	ACP_STABLE_UPDATE_VARIANTS_V0,
	ACP_STOP_REASONS_V0,
	ACP_UNSTABLE_UPDATE_VARIANTS_V0,
	assertAcpSchemaDigestV0,
	readAcpSchemaV0,
	translateAcpUpdateV0,
	validateAcpDefinitionV0,
	validateAcpUpdateV0,
} from "../adapters/acp/index.ts";

const root = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
type Def = {
	description?: string;
	oneOf?: Array<{ properties?: { sessionUpdate?: { const?: string } } }>;
	enum?: string[];
	anyOf?: unknown[];
};

describe("ACP schema binding", () => {
	it("binds the validator to the exact public schema of the pinned SDK", () => {
		const path = require.resolve(ACP_SCHEMA_V0.exportPath);
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		expect(digest).toBe(ACP_SCHEMA_V0.sha256);
		expect(readAcpSchemaV0().sha256).toBe(ACP_SCHEMA_V0.sha256);
		const sdk = JSON.parse(readFileSync(join(path, "..", "..", "package.json"), "utf8")) as { version: string };
		expect(sdk.version).toBe(ACP_SCHEMA_V0.packageVersion);
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			devDependencies: Record<string, string>;
		};
		expect(manifest.devDependencies["@agentclientprotocol/sdk"]).toBe(ACP_SCHEMA_V0.packageVersion);
	});

	it("refuses a schema revision other than the one the mapping was written against", () => {
		expect(() => assertAcpSchemaDigestV0(ACP_SCHEMA_V0.sha256)).not.toThrow();
		expect(() => assertAcpSchemaDigestV0("0".repeat(64))).toThrow(/not the 6449a87a/);
	});

	it("partitions the schema's session/update variants into stable (translated) and unstable (not)", () => {
		const defs = readAcpSchemaV0().document.$defs as unknown as Record<string, Def>;
		const branches = defs.SessionUpdate!.oneOf!;
		const consts = branches.map((branch) => branch.properties!.sessionUpdate!.const!);
		expect([...ACP_STABLE_UPDATE_VARIANTS_V0, ...ACP_UNSTABLE_UPDATE_VARIANTS_V0].sort()).toEqual([...consts].sort());
		// "Unstable" is the schema's own word, on the definition each branch references.
		const marked = (variant: string) => {
			const branch = (
				defs.SessionUpdate as unknown as {
					oneOf: Array<{ properties: { sessionUpdate: { const: string } }; allOf: Array<{ $ref: string }> }>;
				}
			).oneOf.find((entry) => entry.properties.sessionUpdate.const === variant)!;
			return defs[branch.allOf[0]!.$ref.replace("#/$defs/", "")]!.description!.startsWith("**UNSTABLE**");
		};
		for (const variant of ACP_STABLE_UPDATE_VARIANTS_V0) expect(marked(variant), variant).toBe(false);
		for (const variant of ACP_UNSTABLE_UPDATE_VARIANTS_V0) expect(marked(variant), variant).toBe(true);
	});

	it("takes the stop reasons from the schema's closed set", () => {
		const defs = readAcpSchemaV0().document.$defs as unknown as Record<string, { oneOf?: Array<{ const: string }> }>;
		const reasons = defs.StopReason!.oneOf!.map((entry) => entry.const);
		expect([...ACP_STOP_REASONS_V0].sort()).toEqual([...reasons].sort());
	});
});

const text = { type: "text", text: "x" };
const select = (options: unknown) => ({
	sessionUpdate: "config_option_update",
	configOptions: [{ id: "m", name: "M", type: "select", currentValue: "a", options }],
});

describe("ACP v1 stable update validation", () => {
	const valid: Record<string, unknown> = {
		user_message_chunk: { content: text },
		agent_message_chunk: { content: text },
		agent_thought_chunk: { content: { type: "resource_link", name: "n", uri: "file:///x" } },
		tool_call: { toolCallId: "c", title: "t", kind: "read", status: "pending" },
		tool_call_update: { toolCallId: "c", status: "completed", content: null },
		plan: { entries: [{ content: "c", priority: "high", status: "pending" }] },
		available_commands_update: { availableCommands: [{ name: "n", description: "d" }] },
		current_mode_update: { currentModeId: "m" },
		config_option_update: { configOptions: [] },
		session_info_update: {},
		usage_update: { used: 1, size: 2 },
	};

	it("accepts a valid instance of every stable variant", () => {
		expect(Object.keys(valid).sort()).toEqual([...ACP_STABLE_UPDATE_VARIANTS_V0].sort());
		for (const [variant, body] of Object.entries(valid)) {
			expect(validateAcpUpdateV0(variant, { sessionUpdate: variant, ...(body as object) }), variant).toBe(true);
			expect(translateAcpUpdateV0({ sessionUpdate: variant, ...(body as object) }).kind, variant).not.toBe(
				"malformed",
			);
		}
	});

	it("accepts known valid select, grouped-select and boolean configuration options", () => {
		for (const update of [
			select([{ value: "a", name: "A" }]),
			select([{ group: "g", name: "G", options: [{ value: "a", name: "A" }] }]),
			{
				sessionUpdate: "config_option_update",
				configOptions: [{ id: "b", name: "B", type: "boolean", currentValue: true }],
			},
		])
			expect(validateAcpUpdateV0("config_option_update", update)).toBe(true);
	});

	it("rejects malformed nested values: the deferred empty-record and malformed-group select cases first", () => {
		const hostile: Array<[string, unknown]> = [
			["empty option record", select([{}])],
			["group without options", select([{ group: "g", name: "G" }])],
			["group option without value", select([{ group: "g", name: "G", options: [{ name: "A" }] }])],
			["options not an array", select("nope")],
			[
				"select without currentValue",
				{
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "m", name: "M", type: "select", options: [] }],
				},
			],
			["option without type", { sessionUpdate: "config_option_update", configOptions: [{ id: "m", name: "M" }] }],
			[
				"unknown option type",
				{
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "x", name: "X", type: "slider", currentValue: 1 }],
				},
			],
			[
				"boolean with a string",
				{
					sessionUpdate: "config_option_update",
					configOptions: [{ id: "b", name: "B", type: "boolean", currentValue: "yes" }],
				},
			],
			["negative usage", { sessionUpdate: "usage_update", used: -1, size: 2 }],
			["fractional usage", { sessionUpdate: "usage_update", used: 1.5, size: 2 }],
			["cost without currency", { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 1 } }],
			[
				"plan priority outside the set",
				{ sessionUpdate: "plan", entries: [{ content: "c", priority: "urgent", status: "pending" }] },
			],
			["content blocks of an unknown type", { sessionUpdate: "agent_message_chunk", content: { type: "hologram" } }],
			["tool content not an array", { sessionUpdate: "tool_call", toolCallId: "c", title: "t", content: "x" }],
			["tool location without a path", { sessionUpdate: "tool_call_update", toolCallId: "c", locations: [{}] }],
			["tool status outside the set", { sessionUpdate: "tool_call_update", toolCallId: "c", status: "succeeded" }],
			["title of the wrong type", { sessionUpdate: "session_info_update", title: 5 }],
			["mode id of the wrong type", { sessionUpdate: "current_mode_update", currentModeId: 7 }],
			[
				"command without a description",
				{ sessionUpdate: "available_commands_update", availableCommands: [{ name: "n" }] },
			],
		];
		for (const [name, update] of hostile) {
			const variant = (update as { sessionUpdate: string }).sessionUpdate;
			expect(validateAcpUpdateV0(variant, update), name).toBe(false);
			expect(translateAcpUpdateV0(update).kind, name).toBe("malformed");
		}
	});

	it("leaves variants the schema does not stably describe to the caller: unknown and unstable are not malformed", () => {
		for (const variant of ["future_variant_from_v9", ...ACP_UNSTABLE_UPDATE_VARIANTS_V0]) {
			const result = translateAcpUpdateV0({ sessionUpdate: variant, anything: { goes: [1, 2] } });
			expect(result.kind).toBe("event");
			expect(result).toMatchObject({ eventKind: "runtime.unrecognized-event" });
		}
		expect(() => validateAcpUpdateV0("notice", {})).toThrow(/not a stable/);
	});

	it("validates whole definitions, which the SDK does not check on responses", () => {
		expect(validateAcpDefinitionV0("InitializeResponse", { protocolVersion: 1 })).toBe(true);
		expect(validateAcpDefinitionV0("InitializeResponse", { protocolVersion: "1" })).toBe(false);
		expect(validateAcpDefinitionV0("NewSessionResponse", { sessionId: "s" })).toBe(true);
		expect(validateAcpDefinitionV0("NewSessionResponse", {})).toBe(false);
		expect(validateAcpDefinitionV0("ListSessionsResponse", { sessions: [{ sessionId: "s", cwd: "/w" }] })).toBe(true);
		expect(validateAcpDefinitionV0("ListSessionsResponse", { sessions: [{ cwd: "/w" }] })).toBe(false);
		expect(validateAcpDefinitionV0("PromptResponse", { stopReason: "end_turn" })).toBe(true);
		expect(validateAcpDefinitionV0("PromptResponse", { stopReason: "bogus" })).toBe(false);
		expect(() => validateAcpDefinitionV0("NoSuchDefinition", {})).toThrow();
	});
});
