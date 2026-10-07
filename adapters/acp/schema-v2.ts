// The validation boundary for the ACP v2 BASELINE wire structures this study recognizes. ACP v2 is a Draft protocol; this
// module is deliberately separate from schema.ts (v1) and the two never share a validator or a definition table.
//
// Why the baseline is vendored. The published SDK ships v2 only as `schema/v2/schema.unstable.json`, which layers every
// UNSTABLE feature over the baseline. The upstream repository also publishes the baseline alone as `schema/v2/schema.json`
// (the file the migration guide names), and the SDK does not carry it. This study therefore commits that file, copied from
// the exact upstream commit the SDK's own unstable schema was generated from, and pins all of it:
//
//   upstream commit  ->  schema-v2/schema.json (baseline, vendored, validated against)   sha256 pinned
//                    ->  the SDK's schema.unstable.json (read only to prove the pin)       sha256 pinned
//
// An SDK bump that changes either file fails loudly here instead of drifting under a mapping that still claims this
// revision. "Baseline" is the upstream file, not a subtraction of UNSTABLE markers (the markers are not uniform).
//
// Validation is strict where the baseline is strict and open where it is open: the schema's `other` branches (custom or
// future variants, `_`-prefixed extensions) validate, because ACP v2 is extensible. Unlike the reference deserializer
// (`x-deserialize-default-on-error`, `x-deserialize-skip-invalid-items`), a bad optional field or array item makes the
// whole message malformed here: nothing is repaired into evidence.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** The exact revision the v2 study claims to understand. */
export const ACP_SCHEMA_V2 = Object.freeze({
	status: "Draft",
	protocolVersion: 2,
	package: "@agentclientprotocol/sdk",
	packageVersion: "1.7.0",
	/** The only entry the v2 code imports (adapters/acp/client-v2.ts, nothing else). */
	experimentalEntry: "@agentclientprotocol/sdk/experimental/v2",
	upstream: Object.freeze({
		repository: "agentclientprotocol/agent-client-protocol",
		commit: "836266379de98194b848b897207939d19d240a9d",
		/** The upstream path of the vendored baseline file. */
		baselinePath: "schema/v2/schema.json",
	}),
	/** The vendored baseline: committed in this repository, relative to this directory. */
	baseline: Object.freeze({
		path: "adapters/acp/schema-v2/schema.json",
		sha256: "98b51a64b02e757e013948d88b73d990b4ad11b507d8a3dfd6fcd7f9f3b08dee",
	}),
	/** The SDK's own layered schema, read only to prove which upstream commit the SDK was built from. */
	sdkUnstable: Object.freeze({
		exportPath: "@agentclientprotocol/sdk/schema/v2/schema.unstable.json",
		sha256: "75b2aa359dd26cd9d0468674be96482b14a2d181bc8e3ea8c91a8e598f63e3b5",
	}),
});

/** `session/update` variants the baseline schema lists. Anything else is not validated against the baseline. */
export const ACP_V2_BASELINE_UPDATE_VARIANTS_V0: readonly string[] = Object.freeze([
	"user_message_chunk",
	"user_message",
	"agent_message_chunk",
	"agent_message",
	"agent_thought_chunk",
	"agent_thought",
	"state_update",
	"tool_call_content_chunk",
	"tool_call_update",
	"terminal_update",
	"terminal_output_chunk",
	"plan_update",
	"available_commands_update",
	"config_option_update",
	"session_info_update",
	"usage_update",
]);

/**
 * `session/update` variants only the SDK's layered unstable schema lists ("not part of the spec yet, and may be removed
 * or changed at any point"). Observed by name as `runtime.unrecognized-event`, never translated.
 */
export const ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0: readonly string[] = Object.freeze([
	"plan_removed",
	"notice",
	"compaction_update",
	"compaction_summary_chunk",
	"subagent_update",
	"session_message",
	"session_message_chunk",
]);

/**
 * The baseline properties the v2 client reads, by definition. Each must exist in the vendored baseline, and none may be
 * UNSTABLE in the SDK's layered schema (tests/acp-v2-schema.test.ts).
 */
export const ACP_V2_FIELDS_READ_V0: Readonly<Record<string, readonly string[]>> = Object.freeze({
	InitializeResponse: ["protocolVersion", "info", "capabilities", "authMethods"],
	Implementation: ["name", "version"],
	AuthMethodAgent: ["methodId"],
	AuthMethodTerminal: ["methodId"],
	AgentCapabilities: ["session"],
	SessionCapabilities: ["delete", "additionalDirectories"],
	NewSessionRequest: ["cwd", "mcpServers"],
	NewSessionResponse: ["sessionId", "configOptions"],
	ListSessionsRequest: ["cwd", "cursor"],
	ListSessionsResponse: ["sessions", "nextCursor"],
	SessionInfo: ["sessionId", "cwd", "additionalDirectories", "title", "updatedAt"],
	ResumeSessionRequest: ["sessionId", "cwd", "mcpServers", "replayFrom"],
	ResumeSessionResponse: ["configOptions"],
	CloseSessionRequest: ["sessionId"],
	PromptResponse: ["messageId"],
	ContentChunk: ["messageId", "content"],
	UserMessage: ["messageId", "content"],
	AgentMessage: ["messageId", "content"],
	AgentThought: ["messageId", "content"],
	IdleStateUpdate: ["stopReason"],
	ToolCallUpdate: ["toolCallId", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput"],
	ToolCallContentChunk: ["toolCallId", "content"],
	TerminalUpdate: ["terminalId", "output", "exitStatus"],
	PlanUpdate: ["plan"],
	PlanItems: ["planId", "entries"],
	PlanEntry: ["status"],
	AvailableCommandsUpdate: ["availableCommands"],
	ConfigOptionUpdate: ["configOptions"],
	SessionConfigOption: ["configId", "category"],
	SessionConfigSelect: ["currentValue", "options"],
	SessionConfigSelectGroup: ["options"],
	SessionConfigBoolean: ["currentValue"],
	SessionInfoUpdate: ["title"],
	UsageUpdate: ["used", "size", "cost"],
	Cost: ["amount", "currency"],
	RequestPermissionRequest: ["sessionId", "description", "subject", "options"],
	ToolCallPermissionSubject: ["toolCall"],
	CommandPermissionSubject: ["toolCallId"],
	PermissionOption: ["optionId", "kind"],
});

const ANNOTATION_KEYWORDS = [
	"x-deserialize-default-on-error",
	"x-deserialize-skip-invalid-items",
	"x-docs-ignore",
	"x-method",
	"x-side",
];

const integerIn = (min: number, max: number) => (value: number) =>
	Number.isInteger(value) && value >= min && value <= max;
// 64-bit integers: a JSON number past 2^53 has already been rounded by the parser, so it is not an exact integer here.
// It is rejected (never recorded rounded); the adapter reports it as invalid, not as a faithful value.
const safeInteger = (min: number) => (value: number) => Number.isSafeInteger(value) && value >= min;
const NUMBER_FORMATS: Record<string, (value: number) => boolean> = {
	uint16: integerIn(0, 0xffff),
	uint32: integerIn(0, 0xffff_ffff),
	uint64: safeInteger(0),
	int32: integerIn(-0x8000_0000, 0x7fff_ffff),
	int64: (value) => Number.isSafeInteger(value),
	double: Number.isFinite,
};

function isAbsoluteUri(value: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\u0000- \u007f-\u009f]/.test(value)) return false;
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

// RFC 3339 date-time, with the calendar checked: Date.parse normalizes an impossible date (February 30th) into a real
// one, which would pass a message the baseline calls invalid.
const isDateTime = (value: string): boolean => {
	const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
		value,
	);
	if (match === null) return false;
	const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
		.slice(1)
		.map((part) => Number(part ?? 0)) as [number, number, number, number, number, number, number, number];
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= (daysInMonth as number) &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 60 &&
		offsetHour <= 23 &&
		offsetMinute <= 59
	);
};

const SCHEMA_KEY = "acp-v2-baseline";

export interface AcpSchemaV2DocumentV0 {
	readonly $defs: Record<string, Record<string, unknown>>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The vendored baseline as a fresh object, with its digest. */
export function readAcpBaselineSchemaV2(): { document: AcpSchemaV2DocumentV0; sha256: string } {
	const bytes = readFileSync(fileURLToPath(new URL("./schema-v2/schema.json", import.meta.url)));
	return { document: JSON.parse(bytes.toString("utf8")) as AcpSchemaV2DocumentV0, sha256: sha256(bytes) };
}

/** The SDK's layered unstable schema as a fresh object, with its digest. Read only to prove the pin; never validated against. */
export function readAcpSdkUnstableSchemaV2(): { document: AcpSchemaV2DocumentV0; sha256: string } {
	const path = createRequire(import.meta.url).resolve(ACP_SCHEMA_V2.sdkUnstable.exportPath);
	const bytes = readFileSync(path);
	return { document: JSON.parse(bytes.toString("utf8")) as AcpSchemaV2DocumentV0, sha256: sha256(bytes) };
}

/** Throws unless both schema files are the revision this study was written against. */
export function assertAcpSchemaV2Pins(baselineDigest: string, sdkDigest?: string): void {
	if (baselineDigest !== ACP_SCHEMA_V2.baseline.sha256)
		throw new Error(
			`the vendored ACP v2 baseline has sha256 ${baselineDigest}, not the ${ACP_SCHEMA_V2.baseline.sha256} this study was written against`,
		);
	if (sdkDigest !== undefined && sdkDigest !== ACP_SCHEMA_V2.sdkUnstable.sha256)
		throw new Error(
			`the installed ${ACP_SCHEMA_V2.sdkUnstable.exportPath} has sha256 ${sdkDigest}, not the ${ACP_SCHEMA_V2.sdkUnstable.sha256} the vendored baseline was taken alongside`,
		);
}

let loaded: { document: AcpSchemaV2DocumentV0; ajv: Ajv2020 } | undefined;
const compiled = new Map<string, ValidateFunction>();

function load(): { document: AcpSchemaV2DocumentV0; ajv: Ajv2020 } {
	if (loaded !== undefined) return loaded;
	const { document, sha256: digest } = readAcpBaselineSchemaV2();
	assertAcpSchemaV2Pins(digest);
	const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: false });
	for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword(keyword);
	for (const [name, validate] of Object.entries(NUMBER_FORMATS)) ajv.addFormat(name, { type: "number", validate });
	ajv.addFormat("uri", { type: "string", validate: isAbsoluteUri });
	ajv.addFormat("date-time", { type: "string", validate: isDateTime });
	// `regex` annotates a string that is itself a pattern: only its being a string is checked.
	ajv.addFormat("regex", { type: "string", validate: () => true });
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

/** Whether `value` is a valid instance of the vendored baseline's `$defs/<name>`. */
export function validateAcpV2DefinitionV0(name: string, value: unknown): boolean {
	if (!Object.hasOwn(load().document.$defs, name)) throw new TypeError(`the ACP v2 baseline defines no ${name}`);
	return validator(`$defs/${name}`)(value) === true;
}

/**
 * Whether a `session/update` `update` satisfies the baseline's branch for one of ACP_V2_BASELINE_UPDATE_VARIANTS_V0.
 * A variant outside that list is a caller error: the baseline does not describe it, so it has no verdict.
 */
export function validateAcpV2UpdateV0(variant: string, update: unknown): boolean {
	if (!ACP_V2_BASELINE_UPDATE_VARIANTS_V0.includes(variant))
		throw new TypeError(`${variant} is not a baseline ACP v2 update variant`);
	const branches = load().document.$defs.SessionUpdate?.anyOf as ReadonlyArray<{
		properties?: { sessionUpdate?: { const?: string } };
	}>;
	const index = branches.findIndex((branch) => branch.properties?.sessionUpdate?.const === variant);
	if (index < 0) throw new Error(`the ACP v2 baseline has no ${variant} update branch`);
	return validator(`$defs/SessionUpdate/anyOf/${index}`)(update) === true;
}
