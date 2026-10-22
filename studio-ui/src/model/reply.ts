// Classifying what the server answers. Pure: no DOM, no network, so tests import it under the main tsconfig.
//
// `classifyReply` takes what a response was (status, Retry-After, content type, body text) and returns what the page
// should do about it. A body is never trusted by its status alone: it is parsed, its schema and projection versions are checked
// against the versions this build reads (nested projections included) and its structure against what the renderers index.
// A response this build cannot read is reported as such and nothing is shown from it.
import type { EndoCockpitSnapshotV0 } from "../../../protocol/cockpit.ts";
import { SUPPORTED_PROJECTIONS } from "./labels.ts";

export type Reply =
	| { kind: "snapshot"; snapshot: EndoCockpitSnapshotV0 }
	/** The server is pacing reads (HTTP 429). `retryAfterSeconds` is its own figure, or null when it gave none. */
	| { kind: "paced"; retryAfterSeconds: number | null }
	/** The server refused the request (4xx other than 429). `code` is its fixed refusal code when the body had one. */
	| { kind: "refused"; status: number; code: string | null }
	| { kind: "server-error"; status: number }
	/**
	 * A well-formed response of a contract version this build does not read: which record declared it, what was declared (`declared`,
	 * bounded printable text) and what this build reads for that record (`expected`, from this build's own constants).
	 */
	| {
			kind: "unsupported";
			record: "snapshot" | "timeline" | "runtime identity" | "capability state";
			what: "schema" | "projection" | "consistency";
			declared: string;
			expected: string;
	  }
	| { kind: "malformed"; reason: string }
	| { kind: "unreachable"; reason: "network" | "timeout" };

const REFUSAL_CODE = /^[a-z][a-z-]{0,40}$/;

/** What a declared version looks like once it is made safe to show: bounded, printable ASCII, else a fixed word. */
export function shownVersion(value: unknown): string {
	if (typeof value !== "string") return "not a string";
	return /^[\x20-\x7e]{1,64}$/.test(value) ? value : "unreadable";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const malformed = (reason: string): Reply => ({ kind: "malformed", reason });

type RecordName = Extract<Reply, { kind: "unsupported" }>["record"];

/**
 * Check a declared schema and projection version against this build's; null when both are read. A record that declares no version
 * is malformed (nothing says which contract it is); one that declares another is a contract this build does not read, and the
 * reply says which record and which version this build reads for it.
 */
function versionProblem(
	record: Record<string, unknown>,
	name: RecordName,
	schema: string,
	projection: string,
): Reply | null {
	if (typeof record.schemaVersion !== "string" || typeof record.projectionVersion !== "string")
		return malformed("a record declares no version");
	if (record.schemaVersion !== schema)
		return {
			kind: "unsupported",
			record: name,
			what: "schema",
			declared: shownVersion(record.schemaVersion),
			expected: schema,
		};
	if (record.projectionVersion !== projection)
		return {
			kind: "unsupported",
			record: name,
			what: "projection",
			declared: shownVersion(record.projectionVersion),
			expected: projection,
		};
	return null;
}

function sourceShape(source: unknown, domain: string): boolean {
	return (
		isObject(source) &&
		source.domain === domain &&
		isObject(source.condition) &&
		typeof source.condition.state === "string" &&
		(source.watermark === null || isObject(source.watermark))
	);
}

/** A list of notes, each with a code and references: what the renderers read of a note. */
function notesShape(notes: unknown): boolean {
	return (
		Array.isArray(notes) && notes.every((n) => isObject(n) && typeof n.code === "string" && Array.isArray(n.refs))
	);
}

function entryShape(entry: unknown): boolean {
	return (
		isObject(entry) &&
		Number.isSafeInteger(entry.storageSequence) &&
		typeof entry.eventId === "string" &&
		typeof entry.kind === "string" &&
		typeof entry.category === "string" &&
		typeof entry.producer === "string" &&
		typeof entry.recordedAt === "string" &&
		Array.isArray(entry.flags) &&
		entry.flags.every((flag) => typeof flag === "string") &&
		Array.isArray(entry.derivedFrom) &&
		entry.derivedFrom.every((id) => typeof id === "string") &&
		isObject(entry.fields)
	);
}

function timelineProblem(timeline: unknown): Reply | null {
	if (!isObject(timeline)) return malformed("the timeline is missing");
	const version = versionProblem(
		timeline,
		"timeline",
		"endo.cockpit-session-timeline.v0",
		SUPPORTED_PROJECTIONS.sessionTimeline,
	);
	if (version !== null) return version;
	const span = timeline.window;
	if (
		!sourceShape(timeline.source, "event-log") ||
		!isObject(span) ||
		!Number.isSafeInteger(span.afterSequence) ||
		!Number.isSafeInteger(span.nextAfterSequence) ||
		!(span.hasMore === null || typeof span.hasMore === "boolean") ||
		!Array.isArray(timeline.entries) ||
		!timeline.entries.every(entryShape) ||
		!Array.isArray(timeline.sessions) ||
		!timeline.sessions.every((session) => isObject(session) && typeof session.sessionId === "string") ||
		!notesShape(timeline.notes)
	)
		return malformed("the timeline does not have the shape this page reads");
	return null;
}

function runtimeProblem(runtime: unknown): Reply | null {
	if (!isObject(runtime)) return malformed("a runtime view is missing");
	const { identity, capabilities } = runtime;
	if (!isObject(identity) || !isObject(capabilities)) return malformed("a runtime view is incomplete");
	const idVersion = versionProblem(
		identity,
		"runtime identity",
		"endo.cockpit-runtime-identity.v0",
		SUPPORTED_PROJECTIONS.runtimeIdentity,
	);
	if (idVersion !== null) return idVersion;
	const capVersion = versionProblem(
		capabilities,
		"capability state",
		"endo.cockpit-capability-state.v0",
		SUPPORTED_PROJECTIONS.capabilityState,
	);
	if (capVersion !== null) return capVersion;
	if (
		!sourceShape(identity.source, "harness-registry") ||
		!sourceShape(capabilities.source, "harness-registry") ||
		typeof (identity.source as Record<string, unknown>).attachment !== "string" ||
		!notesShape(identity.notes) ||
		!notesShape(capabilities.notes) ||
		!Array.isArray(capabilities.capabilities) ||
		!capabilities.capabilities.every(
			(c) =>
				isObject(c) &&
				typeof c.capability === "string" &&
				Array.isArray(c.limits) &&
				c.limits.every((limit) => isObject(limit) && typeof limit.code === "string" && Array.isArray(limit.refs)),
		)
	)
		return malformed("a runtime view does not have the shape this page reads");
	return null;
}

/** Classify a snapshot response. Pure. */
export function classifyReply(
	status: number,
	retryAfter: string | null,
	contentType: string | null,
	body: string,
): Reply {
	if (status === 429) {
		const seconds = retryAfter !== null && /^[0-9]{1,6}$/.test(retryAfter) ? Number(retryAfter) : null;
		return { kind: "paced", retryAfterSeconds: seconds };
	}
	if (status >= 500) return { kind: "server-error", status };
	if (status !== 200) {
		let code: string | null = null;
		try {
			const parsed: unknown = JSON.parse(body);
			if (isObject(parsed) && typeof parsed.error === "string" && REFUSAL_CODE.test(parsed.error))
				code = parsed.error;
		} catch {
			// a refusal whose body is not the server's own is reported by status alone
		}
		return { kind: "refused", status, code };
	}
	if (contentType === null || !/^application\/json(;|$)/.test(contentType))
		return malformed("the response is not JSON");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return malformed("the response is not valid JSON");
	}
	if (!isObject(parsed)) return malformed("the response is not a snapshot");
	const version = versionProblem(parsed, "snapshot", "endo.cockpit-snapshot.v0", SUPPORTED_PROJECTIONS.snapshot);
	if (version !== null) return version;
	if (parsed.consistency !== "independent-sources")
		return {
			kind: "unsupported",
			record: "snapshot",
			what: "consistency",
			declared: shownVersion(parsed.consistency),
			expected: "independent-sources",
		};
	const timeline = timelineProblem(parsed.timeline);
	if (timeline !== null) return timeline;
	if (!Array.isArray(parsed.runtimes)) return malformed("the snapshot lists no runtimes array");
	for (const runtime of parsed.runtimes) {
		const problem = runtimeProblem(runtime);
		if (problem !== null) return problem;
	}
	return { kind: "snapshot", snapshot: parsed as unknown as EndoCockpitSnapshotV0 };
}
