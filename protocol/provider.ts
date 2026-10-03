/**
 * Phase 12 — the neutral model-provider contract (README "## Phase 12 — Operational substrate &
 * integration"): the protocol records for talking to a model provider without depending on any
 * provider. A request names the model and the conversation; a response, a stream, or an error is
 * the recorded outcome; capabilities and health are what the host declares and observes about the
 * provider. These are observational records — the provider seam does not add a ledger kind; the
 * adapter that produces them maps an outcome to the ledgerable `endo.model-telemetry.v0` record
 * (see `models/provider/contract.ts`). The provider name is opaque text: the protocol never
 * re-parses it, never assumes an endpoint scheme beyond what the host configures, and never
 * invents a measurement the provider did not report (a missing usage stays missing).
 */

import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded identity or name: a non-empty string within the given length bound. Opaque by design. */
function isProfileTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A recorded message body: a string within the 1 MiB bound (empty is recorded content). */
function isMessageContentV0(value: unknown): value is string {
	return typeof value === "string" && value.length <= 1048576;
}

/** A recorded non-negative integer: a finite, integral, non-negative number. */
function isNonNegativeIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** A recorded positive integer: a finite, integral number of at least one. */
function isPositiveIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1;
}

/** A sampling temperature: a finite number in [0, 2]. */
function isTemperatureV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2;
}

/** A provider message role. */
export type EndoProviderMessageRoleV0 = "system" | "user" | "assistant";

/** The closed provider message roles. */
export const ENDO_PROVIDER_MESSAGE_ROLES_V0 = [
	"system",
	"user",
	"assistant",
] as const satisfies readonly EndoProviderMessageRoleV0[];

/**
 * One provider message: a role and its content. The content is the recorded text — no provider-
 * specific multimodal structure is carried here; a provider that needs it records what it
 * observed in its own response, not in the request shape.
 */
export interface EndoProviderMessageV0 {
	role: EndoProviderMessageRoleV0;
	content: string;
}

const ENDO_PROVIDER_MESSAGE_ALLOWED_KEYS_V0 = new Set(["role", "content"]);

/**
 * Validates a provider message. Rejects unknown fields, a role outside the closed set, and
 * over-long content. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderMessageV0(value: unknown): EndoProviderMessageV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_MESSAGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (!(ENDO_PROVIDER_MESSAGE_ROLES_V0 as readonly string[]).includes(v.role as string)) return null;
	if (!isMessageContentV0(v.content)) return null;
	return value as EndoProviderMessageV0;
}

/**
 * A request to a model provider: the provider and model identities, the conversation, and the
 * optional sampling parameters. A ledger record in the endo.evidence.* namespace — the request
 * id is the call id: one request is one call, and a retry is a new request with a new id.
 */
export interface EndoProviderRequestV0 {
	schemaVersion: "endo.provider-request.v0";
	/** endo.evidence.* identifier — the call id. */
	id: string;
	/** The provider name, opaque. */
	provider: string;
	/** The model id, opaque. */
	modelId: string;
	/** The conversation: 1-512 messages, in order. */
	messages: EndoProviderMessageV0[];
	/** Whether the response is streamed. */
	stream?: boolean;
	/** The requested maximum completion tokens, when set. */
	maxTokens?: number;
	/** The sampling temperature, when set. */
	temperature?: number;
}

const ENDO_PROVIDER_REQUEST_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"provider",
	"modelId",
	"messages",
	"stream",
	"maxTokens",
	"temperature",
]);

/**
 * Validates a provider request. Rejects unknown fields, an id outside the endo.evidence.*
 * namespace, empty provider or model ids, a message list outside 1-512 or containing invalid
 * messages, a non-boolean stream flag, a maxTokens that is not a positive integer, and a
 * temperature outside [0, 2]. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderRequestV0(value: unknown): EndoProviderRequestV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_REQUEST_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-request.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isProfileTextV0(v.provider, 256)) return null;
	if (!isProfileTextV0(v.modelId, 256)) return null;
	if (!Array.isArray(v.messages) || v.messages.length < 1 || v.messages.length > 512) return null;
	for (const message of v.messages) if (validateEndoProviderMessageV0(message) === null) return null;
	if (v.stream !== undefined && typeof v.stream !== "boolean") return null;
	if (v.maxTokens !== undefined && !isPositiveIntV0(v.maxTokens)) return null;
	if (v.temperature !== undefined && !isTemperatureV0(v.temperature)) return null;
	return value as EndoProviderRequestV0;
}

/**
 * Token usage a provider reported for one call. Every count the provider reported; a count it
 * did not report stays absent — never filled in with zero.
 */
export interface EndoProviderUsageV0 {
	schemaVersion: "endo.provider-usage.v0";
	/** The reported input token count. */
	inputTokens: number;
	/** The reported output token count. */
	outputTokens: number;
	/** The reported total token count, when the provider reported one. */
	totalTokens?: number;
}

const ENDO_PROVIDER_USAGE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "inputTokens", "outputTokens", "totalTokens"]);

/**
 * Validates a provider usage record. Rejects unknown fields and counts that are not
 * non-negative integers. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderUsageV0(value: unknown): EndoProviderUsageV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_USAGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-usage.v0") return null;
	if (!isNonNegativeIntV0(v.inputTokens)) return null;
	if (!isNonNegativeIntV0(v.outputTokens)) return null;
	if (v.totalTokens !== undefined && !isNonNegativeIntV0(v.totalTokens)) return null;
	return value as EndoProviderUsageV0;
}

/**
 * The recorded outcome of a non-streaming provider call: the content, the finish reason the
 * provider gave, the usage it reported, and how long the call took. A ledger record in the
 * endo.evidence.* namespace.
 */
export interface EndoProviderResponseV0 {
	schemaVersion: "endo.provider-response.v0";
	/** endo.evidence.* identifier for this outcome record. */
	id: string;
	/** The request this outcome belongs to. endo.evidence.* identifier. */
	requestId: string;
	/** The completion content. */
	content: string;
	/** The finish reason the provider gave, when it gave one. */
	finishReason?: string;
	/** The usage the provider reported, when it reported one. */
	usage?: EndoProviderUsageV0;
	/** The wall-clock duration of the call, in milliseconds. */
	durationMs: number;
}

const ENDO_PROVIDER_RESPONSE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"requestId",
	"content",
	"finishReason",
	"usage",
	"durationMs",
]);

/**
 * Validates a provider response record. Rejects unknown fields, ids outside the
 * endo.evidence.* namespace, over-long content, a finishReason that is not 1-64 characters, an
 * invalid usage record, and a duration that is not a non-negative integer. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoProviderResponseV0(value: unknown): EndoProviderResponseV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_RESPONSE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-response.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.requestId, "evidence")) return null;
	if (!isMessageContentV0(v.content)) return null;
	if (v.finishReason !== undefined && !isProfileTextV0(v.finishReason, 64)) return null;
	if (v.usage !== undefined && validateEndoProviderUsageV0(v.usage) === null) return null;
	if (!isNonNegativeIntV0(v.durationMs)) return null;
	return value as EndoProviderResponseV0;
}

/**
 * One streamed delta: its sequence in the stream and the content delta it carried.
 */
export interface EndoProviderStreamEventV0 {
	/** The event sequence within the stream: a non-negative integer, in order. */
	sequence: number;
	/** The content delta. */
	delta: string;
}

const ENDO_PROVIDER_STREAM_EVENT_ALLOWED_KEYS_V0 = new Set(["sequence", "delta"]);

/**
 * Validates a stream event. Rejects unknown fields, a sequence that is not a non-negative
 * integer, and over-long deltas. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderStreamEventV0(value: unknown): EndoProviderStreamEventV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_STREAM_EVENT_ALLOWED_KEYS_V0.has(key)) return null;
	if (!isNonNegativeIntV0(v.sequence)) return null;
	if (!isMessageContentV0(v.delta)) return null;
	return value as EndoProviderStreamEventV0;
}

/**
 * The recorded outcome of a streaming provider call: the content deltas in order, the usage the
 * provider reported at the end of the stream (when it reported one), and the duration. A ledger
 * record in the endo.evidence.* namespace.
 */
export interface EndoProviderStreamV0 {
	schemaVersion: "endo.provider-stream.v0";
	/** endo.evidence.* identifier for this outcome record. */
	id: string;
	/** The request this outcome belongs to. endo.evidence.* identifier. */
	requestId: string;
	/** The content deltas, in stream order: at most 4096. */
	events: EndoProviderStreamEventV0[];
	/** The usage the provider reported, when it reported one. */
	usage?: EndoProviderUsageV0;
	/** The wall-clock duration of the call, in milliseconds. */
	durationMs: number;
}

const ENDO_PROVIDER_STREAM_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"requestId",
	"events",
	"usage",
	"durationMs",
]);

/**
 * Validates a provider stream record. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, an event list over 4096 or containing invalid events, an invalid usage record, and
 * a duration that is not a non-negative integer. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderStreamV0(value: unknown): EndoProviderStreamV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_STREAM_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-stream.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.requestId, "evidence")) return null;
	if (!Array.isArray(v.events) || v.events.length > 4096) return null;
	for (const event of v.events) if (validateEndoProviderStreamEventV0(event) === null) return null;
	if (v.usage !== undefined && validateEndoProviderUsageV0(v.usage) === null) return null;
	if (!isNonNegativeIntV0(v.durationMs)) return null;
	return value as EndoProviderStreamV0;
}

/**
 * The recorded outcome of a failed provider call: the error code, the message, and whether the
 * error is retryable (a transport failure or a retryable status is; a permanent rejection is
 * not). A ledger record in the endo.evidence.* namespace.
 */
export interface EndoProviderErrorV0 {
	schemaVersion: "endo.provider-error.v0";
	/** endo.evidence.* identifier for this outcome record. */
	id: string;
	/** The request this outcome belongs to. endo.evidence.* identifier. */
	requestId: string;
	/** The error code: the HTTP status string for an HTTP error, "transport" for a transport failure. */
	code: string;
	/** The error message, truncated to the bound. */
	message: string;
	/** Whether the error is retryable. */
	retryable: boolean;
}

const ENDO_PROVIDER_ERROR_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"requestId",
	"code",
	"message",
	"retryable",
]);

/**
 * Validates a provider error record. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, a code that is not 1-64 characters, a message outside 1-4096 characters, and a
 * non-boolean retryable flag. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderErrorV0(value: unknown): EndoProviderErrorV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_ERROR_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-error.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.requestId, "evidence")) return null;
	if (!isProfileTextV0(v.code, 64)) return null;
	if (!isProfileTextV0(v.message, 4096)) return null;
	if (typeof v.retryable !== "boolean") return null;
	return value as EndoProviderErrorV0;
}

/**
 * What the host declares about a provider: streaming, tool, and vision support, and the
 * declared context window when the host declares one. Observational — the host's declaration,
 * not a measurement; a missing capability stays absent, never assumed.
 */
export interface EndoProviderCapabilitiesV0 {
	schemaVersion: "endo.provider-capabilities.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The provider name, opaque. */
	provider: string;
	/** Whether the provider supports streaming. */
	streaming: boolean;
	/** Whether the provider supports tool calls. */
	tools: boolean;
	/** Whether the provider supports vision input. */
	vision: boolean;
	/** The declared context window in tokens, when the host declared one. */
	maxContextTokens?: number;
}

const ENDO_PROVIDER_CAPABILITIES_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"provider",
	"streaming",
	"tools",
	"vision",
	"maxContextTokens",
]);

/**
 * Validates a provider capabilities record. Rejects unknown fields, an id outside the
 * endo.evidence.* namespace, an empty provider name, non-boolean capability flags, and a
 * maxContextTokens that is not a positive integer. Returns the validated value unchanged, or
 * null.
 */
export function validateEndoProviderCapabilitiesV0(value: unknown): EndoProviderCapabilitiesV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_CAPABILITIES_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-capabilities.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isProfileTextV0(v.provider, 256)) return null;
	if (typeof v.streaming !== "boolean") return null;
	if (typeof v.tools !== "boolean") return null;
	if (typeof v.vision !== "boolean") return null;
	if (v.maxContextTokens !== undefined && !isPositiveIntV0(v.maxContextTokens)) return null;
	return value as EndoProviderCapabilitiesV0;
}

/** The observed provider health status. */
export type EndoProviderHealthStatusV0 = "up" | "degraded" | "down";

/** The closed provider health statuses. */
export const ENDO_PROVIDER_HEALTH_STATUSES_V0 = [
	"up",
	"degraded",
	"down",
] as const satisfies readonly EndoProviderHealthStatusV0[];

/**
 * The observed health of a provider at one moment: the status and the latency measured, when
 * one was measured. Observational — a latency the probe did not measure stays absent, never
 * filled in.
 */
export interface EndoProviderHealthV0 {
	schemaVersion: "endo.provider-health.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The provider name, opaque. */
	provider: string;
	/** The observed status. */
	status: EndoProviderHealthStatusV0;
	/** The measured latency in milliseconds, when a probe measured one. */
	latencyMs?: number;
}

const ENDO_PROVIDER_HEALTH_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "provider", "status", "latencyMs"]);

/**
 * Validates a provider health record. Rejects unknown fields, an id outside the
 * endo.evidence.* namespace, an empty provider name, a status outside the closed set, and a
 * latency that is not a non-negative integer. Returns the validated value unchanged, or null.
 */
export function validateEndoProviderHealthV0(value: unknown): EndoProviderHealthV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROVIDER_HEALTH_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.provider-health.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isProfileTextV0(v.provider, 256)) return null;
	if (!(ENDO_PROVIDER_HEALTH_STATUSES_V0 as readonly string[]).includes(v.status as string)) return null;
	if (v.latencyMs !== undefined && !isNonNegativeIntV0(v.latencyMs)) return null;
	return value as EndoProviderHealthV0;
}
