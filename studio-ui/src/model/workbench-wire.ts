// Browser wire gate for the workbench routes. The broker (adapters/pi/workbench.ts) is authoritative for state, authority and privacy;
// nothing of it runs here. These checks cover every field the workbench renderers read. A body that does not match is refused whole,
// and a failure becomes fixed text: no response body, grant or transcript text ever reaches a message.
import { type Check, count, eitherNull, list, obj, one, shape } from "./compare-wire.ts";

export type WorkbenchCommandState = "awaiting-approval" | "dispatching" | "accepted" | "refused";
export interface WorkbenchCommand {
	proposalId: string;
	state: WorkbenchCommandState;
	/** Whether the operator typed the approval on the terminal (a withdrawn, timed-out or declined prompt was never approved). */
	approved: boolean;
	reason: string | null;
	disposition: string | null;
	bytes: number;
	digestPrefix: string;
	expiresAtMs: number;
}
export interface WorkbenchStatus {
	schemaVersion: "endo.workbench-status.v0";
	launchId: string;
	harness: "pi";
	connection: "connected" | "disconnected";
	run: "active" | "idle" | "unknown";
	session: string | null;
	attachment: string;
	offers: { prompt: { offered: boolean; reason: string | null } };
	paired: boolean;
	command: WorkbenchCommand | null;
	transcript: { watermark: number; firstSeq: number };
}
export type TranscriptItem =
	| {
			seq: number;
			kind: "message";
			role: "user" | "assistant";
			text: string;
			truncated: boolean;
			stopReason: string | null;
	  }
	| { seq: number; kind: "tool"; callId: string; name: string; status: "running" | "ok" | "error" }
	| { seq: number; kind: "run"; state: "started" | "ended" };
export interface WorkbenchTranscript {
	schemaVersion: "endo.workbench-transcript.v0";
	launchId: string;
	items: TranscriptItem[];
	watermark: number;
	firstSeq: number;
	evicted: number;
	more: boolean;
}

const bool = (v: unknown): boolean => typeof v === "boolean";
const text =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max;
const short: Check = text(256);
const REASONS = [
	"not-authorized",
	"authorization-denied",
	"approval-timed-out",
	"authorization-expired",
	"session-ended",
	"run-active",
	"capability-unavailable",
	"duplicate",
	"runtime-refused",
];

const command: Check = (v) =>
	shape(v, {
		proposalId: (x) => typeof x === "string" && /^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/.test(x),
		state: one("awaiting-approval", "dispatching", "accepted", "refused"),
		approved: bool,
		reason: eitherNull(one(...REASONS)),
		disposition: eitherNull(one("started", "queued", "handled")),
		bytes: (n) => count(n) && n <= 16384,
		digestPrefix: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		expiresAtMs: count,
	});

export const readWorkbenchStatus = (v: unknown): WorkbenchStatus | null =>
	shape(v, {
		schemaVersion: one("endo.workbench-status.v0"),
		launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
		harness: one("pi"),
		connection: one("connected", "disconnected"),
		run: one("active", "idle", "unknown"),
		session: eitherNull((x) => typeof x === "string" && x.length <= 269 && /^endo\.session\./.test(x)),
		attachment: short,
		offers: (o) => shape(o, { prompt: (p) => shape(p, { offered: bool, reason: eitherNull(text(300)) }) }),
		paired: bool,
		command: eitherNull(command),
		transcript: (t) => shape(t, { watermark: count, firstSeq: count }),
	})
		? (v as unknown as WorkbenchStatus)
		: null;

const item: Check = (v) =>
	shape(v, {
		seq: (n) => count(n) && n >= 1,
		kind: one("message"),
		role: one("user", "assistant"),
		text: text(40_000),
		truncated: bool,
		stopReason: eitherNull(text(32)),
	}) ||
	shape(v, {
		seq: (n) => count(n) && n >= 1,
		kind: one("tool"),
		callId: short,
		name: short,
		status: one("running", "ok", "error"),
	}) ||
	shape(v, { seq: (n) => count(n) && n >= 1, kind: one("run"), state: one("started", "ended") });

export function readWorkbenchTranscript(v: unknown): WorkbenchTranscript | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.workbench-transcript.v0"),
			launchId: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
			items: (x) => Array.isArray(x) && x.length <= 200 && list(item)(x),
			watermark: count,
			firstSeq: count,
			evicted: count,
			more: bool,
		})
	)
		return null;
	const t = v as unknown as WorkbenchTranscript;
	let previous = 0;
	for (const i of t.items) {
		if (i.seq <= previous || i.seq > t.watermark) return null;
		previous = i.seq;
	}
	return t;
}

export const readWorkbenchGrant = (v: unknown): { grant: string; expiresAtMs: number } | null =>
	shape(v, {
		schemaVersion: one("endo.workbench-grant.v0"),
		grant: (x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x),
		expiresAtMs: count,
	})
		? (v as unknown as { grant: string; expiresAtMs: number })
		: null;

export const readWorkbenchCommand = (v: unknown): WorkbenchCommand | null =>
	command(v) && obj(v) ? (v as unknown as WorkbenchCommand) : null;

export type WorkbenchRequest =
	| { kind: "status" }
	| { kind: "transcript"; after: number }
	| { kind: "pair"; code: string }
	| { kind: "propose"; message: string }
	| { kind: "command"; proposalId: string }
	| { kind: "discard"; proposalId: string };

export type WorkbenchReply =
	| { kind: "status"; record: WorkbenchStatus }
	| { kind: "transcript"; record: WorkbenchTranscript }
	| { kind: "grant"; record: { grant: string; expiresAtMs: number } }
	| { kind: "command"; record: WorkbenchCommand }
	/** 404 on the status route: this server has no workbench (it is the read-only Studio). */
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: string; message: string; retrySeconds: number | null };

const FIXED: Record<string, string> = {
	"pairing-refused": "That pairing code was not accepted. Type `pair` in the attached terminal for a new one.",
	"grant-required": "This page is not paired. Enter the pairing code shown in the attached terminal.",
	"not-offered": "A prompt cannot be sent right now.",
	"bad-request": "The request was not in a form the workbench accepts.",
	"not-found": "That prompt is no longer known to the workbench.",
	"not-withdrawable": "That prompt is no longer waiting for approval.",
	"not-recording": "The session is not recording, so nothing was requested.",
	forbidden: "The workbench refused this request.",
};

/** A failure as fixed text. The body's `error` code selects a sentence; nothing else of it is shown. */
export function workbenchFailure(
	status: number,
	body: unknown,
	retry: string | null,
): Extract<WorkbenchReply, { kind: "failure" }> {
	const code = obj(body) && typeof body.error === "string" && /^[a-z-]{1,40}$/.test(body.error) ? body.error : "";
	return {
		kind: "failure",
		status,
		code,
		retrySeconds:
			status === 429 && retry !== null && /^(0|[1-9][0-9]{0,3})$/.test(retry) ? Math.min(3600, Number(retry)) : null,
		message:
			status === 429
				? "The server is pacing requests. Wait, then try again."
				: (FIXED[code] ??
					(status >= 500
						? "The workbench could not complete the request."
						: "The workbench did not accept the request.")),
	};
}
