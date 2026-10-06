// The one schema-backed validation boundary for ACP v1 wire structures this adapter recognizes.
//
// The source is the JSON Schema the pinned SDK publishes through its public `./schema/schema.json` export (never the
// SDK's internal zod validators, which are not exported, and never `schema/v2/`). The file is read from the installed
// package, hashed, and must match ACP_SCHEMA_V0.sha256 before any validator is built: an SDK bump that changes the
// schema fails loudly here instead of drifting under a mapping that still claims the old revision.
//
//   recognized ACP v1 message -> validateAcpDefinitionV0 / validateAcpUpdateV0 -> translation
//
// Strict validation is stricter than the reference deserializer, which marks many optional fields
// `x-deserialize-default-on-error` (a bad optional field is treated as absent) and `x-deserialize-skip-invalid-items`
// (a bad array item is skipped). Here a bad optional field or a bad array item makes the whole message malformed:
// nothing is "repaired" into evidence. Messages the schema does not describe at all (an unknown `sessionUpdate`
// variant, or one the schema marks UNSTABLE) are not validated and not malformed; they are the caller's to observe.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** The exact revision this adapter's mapping claims to understand. */
export const ACP_SCHEMA_V0 = Object.freeze({
	package: "@agentclientprotocol/sdk",
	packageVersion: "1.7.0",
	/** The public export path the schema is read from. */
	exportPath: "@agentclientprotocol/sdk/schema/schema.json",
	/** SHA-256 of that file's bytes. */
	sha256: "6449a87a3b3c42aa0abd30033fc9bd3236cd785078ad084ce3675766be09109e",
});

/**
 * The `session/update` variants this adapter translates: every v1 variant the pinned schema lists that is not marked
 * UNSTABLE. An unlisted variant is never validated against the schema.
 */
export const ACP_STABLE_UPDATE_VARIANTS_V0: readonly string[] = Object.freeze([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
	"available_commands_update",
	"current_mode_update",
	"config_option_update",
	"session_info_update",
	"usage_update",
]);

/**
 * `session/update` variants the pinned schema lists but marks `**UNSTABLE**`: "not part of the spec yet, and may be
 * removed or changed at any point". They are deliberately not translated; an agent that sends one is observed as
 * `runtime.unrecognized-event`, exactly as an unknown future variant is.
 */
export const ACP_UNSTABLE_UPDATE_VARIANTS_V0: readonly string[] = Object.freeze([
	"plan_update",
	"plan_removed",
	"notice",
	"compaction_update",
	"compaction_summary_chunk",
	"subagent_update",
	"session_message",
	"session_message_chunk",
]);

// Annotation keywords the schema uses. Registered by name so Ajv's strict mode stays on: a keyword added by a later
// schema revision is a compile error, not silently ignored.
const ANNOTATION_KEYWORDS = [
	"x-deserialize-default-on-error",
	"x-deserialize-skip-invalid-items",
	"x-docs-ignore",
	"x-method",
	"x-side",
	// Redundant with `oneOf` + the per-branch `const` on the tag, which is what actually selects a branch.
	"discriminator",
];

const integerIn = (min: number, max: number) => (value: number) =>
	Number.isInteger(value) && value >= min && value <= max;

// The schema's numeric formats, with their ranges.
//
// 64-bit integers: the schema allows uint64/int64 values past 2^53, but the JSON has already been parsed into a JS number,
// which has rounded them. Such a value is not accepted as an exact integer, and is never recorded as one: the adapter
// can only represent integers in [-(2^53-1), 2^53-1]. A value that is a schema-valid 64-bit integer but outside that
// range is *not exactly representable here* (verdict "inexact-integer"), which is a different fact from a schema
// violation. Nothing is rounded into evidence either way; the update is not counted.
const U64_MAX = 18446744073709551615; // 2^64, as the nearest double
const I64_MIN = -9223372036854775808;
const I64_MAX = 9223372036854775807; // 2^63, as the nearest double
let inexactSeen = false;
const exact64 = (min: number, max: number, safeMin: number) => (value: number) => {
	if (!Number.isInteger(value)) return false;
	if (value >= safeMin && value <= Number.MAX_SAFE_INTEGER) return true;
	// Inside the schema's 64-bit range but beyond what a JS number holds exactly.
	if (value >= min && value <= max) inexactSeen = true;
	return false;
};
const NUMBER_FORMATS: Record<string, (value: number) => boolean> = {
	uint16: integerIn(0, 0xffff),
	uint32: integerIn(0, 0xffff_ffff),
	uint64: exact64(0, U64_MAX, 0),
	int32: integerIn(-0x8000_0000, 0x7fff_ffff),
	int64: exact64(I64_MIN, I64_MAX, Number.MIN_SAFE_INTEGER),
	double: Number.isFinite,
};

/**
 * The schema properties the adapter reads (`definition: [property, ...]`). None may be marked UNSTABLE in the pinned
 * schema (tests/acp-schema.test.ts), so a revision that destabilizes a field this adapter depends on cannot pass
 * unnoticed. `PromptResponse.usage` is UNSTABLE and deliberately absent: validated as part of the response, not read.
 */
export const ACP_FIELDS_READ_V0: Readonly<Record<string, readonly string[]>> = Object.freeze({
	InitializeResponse: ["protocolVersion", "agentInfo", "agentCapabilities", "authMethods"],
	Implementation: ["name", "version"],
	AuthMethodAgent: ["id"],
	AuthMethodTerminal: ["id"],
	AgentCapabilities: ["sessionCapabilities"],
	RequestPermissionRequest: ["sessionId", "toolCall", "options"],
	PermissionOption: ["optionId", "kind"],
	SessionConfigSelectGroup: ["options"],
	SessionCapabilities: ["list", "resume", "close"],
	NewSessionRequest: ["cwd", "mcpServers"],
	NewSessionResponse: ["sessionId", "modes", "configOptions"],
	ResumeSessionRequest: ["sessionId", "cwd", "mcpServers"],
	ResumeSessionResponse: ["modes", "configOptions"],
	ListSessionsRequest: ["cwd", "cursor"],
	ListSessionsResponse: ["sessions", "nextCursor"],
	SessionInfo: ["sessionId", "cwd", "additionalDirectories", "title", "updatedAt"],
	CloseSessionRequest: ["sessionId"],
	SessionModeState: ["currentModeId", "availableModes"],
	SessionConfigOption: ["id", "category"],
	SessionConfigSelect: ["currentValue", "options"],
	SessionConfigBoolean: ["currentValue"],
	PromptResponse: ["stopReason"],
	ToolCall: ["toolCallId", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput"],
	ToolCallUpdate: ["toolCallId", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput"],
	Plan: ["entries"],
	PlanEntry: ["status"],
	AvailableCommandsUpdate: ["availableCommands"],
	CurrentModeUpdate: ["currentModeId"],
	ConfigOptionUpdate: ["configOptions"],
	SessionInfoUpdate: ["title"],
	UsageUpdate: ["used", "size", "cost"],
	Cost: ["amount", "currency"],
});

function isAbsoluteUri(value: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return false;
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

const SCHEMA_KEY = "acp-v1";

export interface AcpSchemaDocumentV0 {
	readonly $defs: Record<string, Record<string, unknown>>;
}

let loaded: { document: AcpSchemaDocumentV0; ajv: Ajv2020 } | undefined;
const compiled = new Map<string, ValidateFunction>();

/** The pinned schema as a fresh object (callers cannot change what later validation sees). */
export function readAcpSchemaV0(): { document: AcpSchemaDocumentV0; sha256: string } {
	const path = createRequire(import.meta.url).resolve(ACP_SCHEMA_V0.exportPath);
	const bytes = readFileSync(path);
	return { document: JSON.parse(bytes.toString("utf8")) as AcpSchemaDocumentV0, sha256: sha256(bytes) };
}

/** Throws unless `digest` is the digest of the schema revision this adapter's mapping was written against. */
export function assertAcpSchemaDigestV0(digest: string): void {
	if (digest !== ACP_SCHEMA_V0.sha256) {
		throw new Error(
			`the installed ${ACP_SCHEMA_V0.exportPath} has sha256 ${digest}, not the ${ACP_SCHEMA_V0.sha256} this adapter's mapping was written against`,
		);
	}
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function load(): { document: AcpSchemaDocumentV0; ajv: Ajv2020 } {
	if (loaded !== undefined) return loaded;
	const { document, sha256: digest } = readAcpSchemaV0();
	assertAcpSchemaDigestV0(digest);
	const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: false });
	for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword(keyword);
	for (const [name, validate] of Object.entries(NUMBER_FORMATS)) ajv.addFormat(name, { type: "number", validate });
	// The schema's only `format: uri` is ElicitationUrlMode.url, an UNSTABLE definition no stable validation reaches; the
	// resource URIs of content blocks are plain strings in the schema and are accepted as such. Checked as an absolute URI
	// the WHATWG parser accepts (a scheme is required; spaces, control characters and unparseable hosts are not), not as a
	// full RFC 3986 grammar.
	ajv.addFormat("uri", { type: "string", validate: isAbsoluteUri });
	ajv.addSchema(document, SCHEMA_KEY);
	loaded = { document, ajv };
	return loaded;
}

function validator(ref: string): ValidateFunction {
	const cached = compiled.get(ref);
	if (cached !== undefined) return cached;
	const built = load().ajv.compile({ $ref: `${SCHEMA_KEY}#/${ref}` });
	compiled.set(ref, built);
	return built;
}

/** Whether `value` is a valid instance of the pinned schema's `$defs/<name>` (e.g. "NewSessionResponse"). */
export function validateAcpDefinitionV0(name: string, value: unknown): boolean {
	if (!Object.hasOwn(load().document.$defs, name)) throw new TypeError(`the pinned ACP schema defines no ${name}`);
	return validator(`$defs/${name}`)(value) === true;
}

/**
 * Whether a `session/update` `update` object satisfies the pinned schema's branch for its (stable) variant. A variant
 * outside ACP_STABLE_UPDATE_VARIANTS_V0 is a caller error: it is not described here, so it has no verdict.
 */
export function validateAcpUpdateV0(variant: string, update: unknown): boolean {
	return acpUpdateVerdictV0(variant, update) === "valid";
}

/**
 * `valid`; `invalid` (the schema rejects it); or `inexact-integer` (rejected, and it carries a schema-valid 64-bit integer
 * that a JS number cannot hold exactly: the adapter cannot represent the value, which is not the agent's schema error).
 */
export function acpUpdateVerdictV0(variant: string, update: unknown): "valid" | "invalid" | "inexact-integer" {
	if (!ACP_STABLE_UPDATE_VARIANTS_V0.includes(variant))
		throw new TypeError(`${variant} is not a stable ACP v1 update variant`);
	const branches = load().document.$defs.SessionUpdate?.oneOf as ReadonlyArray<{
		properties?: { sessionUpdate?: { const?: string } };
	}>;
	const index = branches.findIndex((branch) => branch.properties?.sessionUpdate?.const === variant);
	if (index < 0) throw new Error(`the pinned ACP schema has no ${variant} update branch`);
	inexactSeen = false;
	if (validator(`$defs/SessionUpdate/oneOf/${index}`)(update) === true) return "valid";
	return inexactSeen ? "inexact-integer" : "invalid";
}
