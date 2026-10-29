// The workbench broker: the ONLY writable boundary of the DEVELOP workbench. It lives in the attached process (`endo harness attach
// --workbench`), beside the Pi child it launched, and controls nothing else: it never attaches to a Pi another tool started.
//
// What it offers, as a closed list of routes under `api/v0/workbench/` (cockpit-http/server.ts guards every one of them: Host, Origin,
// Fetch Metadata, and for a POST an exact same-origin Origin, `application/json` and a bounded body):
//
//   GET  status                 connection, run state, the one command in flight, what is offered and why not. Read capability only.
//   POST pair {code}            exchange the one-time code shown on the attached terminal for an operator grant.
//   GET  transcript?after=n     the live, private, in-memory transcript. Needs the grant.
//   POST prompt/propose {message}   ask to send ONE new user prompt. Needs the grant. This only REQUESTS: see below.
//   GET  prompt/<id>            the state of that prompt. Needs the grant.
//   POST prompt/discard {proposalId}  withdraw it before it is approved.
//
// Authority. The browser can request and can never authorise. A prompt is sent only after the operator types its exact digest on the
// attached process's CONTROLLING TERMINAL (the `approver` below); a page script cannot do that. The grant (obtained by typing the
// terminal's pairing code into the page) only lets the page ask and read. It is single, held in the page's memory, expires, and is
// replaced by a new pairing. The approval is a local operator's decision, not proof of identity.
//
// A prompt is not an intervention: it opens a run, STEER/QUEUE/STOP change one. It has its own record chain (protocol/workbench.ts):
// proposed → authorized → dispatched → accepted, or refused with a closed reason. HTTP acceptance of a request means only that it was
// REQUESTED. The prompt text is never recorded; it is held in memory until the prompt is dispatched or refused, then dropped.
//
// Not here: a shell, a PTY, a raw Pi RPC passthrough, STEER/QUEUE/STOP (the next change, through the existing intervention chain), or
// any store read or write other than the record chain above.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EndoCockpitWorkbenchRequestV0, EndoCockpitWorkbenchV0 } from "../../cockpit-http/server.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	ENDO_WORKBENCH_DISPOSITIONS_V0,
	ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0,
	ENDO_WORKBENCH_SCHEMA_V0,
	type EndoWorkbenchKindV0,
	type EndoWorkbenchRefusalReasonV0,
} from "../../protocol/workbench.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import { LiveTranscriptV0 } from "./live-transcript.ts";

export const ENDO_WORKBENCH_STATUS_SCHEMA_V0 = "endo.workbench-status.v0";

/** What the broker needs of the attached session (PiSessionAttachmentV0 satisfies it). */
export interface WorkbenchSessionV0 {
	readonly piSessionId: string | null;
	/** The Pi process is running and can receive a command. */
	readonly live: boolean;
	/** A run is open, by the live lifecycle. */
	readonly runActive: boolean;
	prompt(message: string): Promise<string>;
	recordWorkbench(
		kind: EndoWorkbenchKindV0,
		payload: Record<string, JsonValueV0>,
		derivedFrom?: readonly string[],
	): EndoEventV0;
	onLiveEvent: ((event: RpcEventV0) => void) | null;
}

/** What the operator is shown on the controlling terminal to decide. */
export interface WorkbenchApprovalRequestV0 {
	proposalId: string;
	/** The exact phrase that approves this prompt. Anything else declines. */
	phrase: string;
	session: string;
	attachment: string;
	bytes: number;
	/** The whole prompt: it is the operator's own terminal, and they must see exactly what they authorise. */
	message: string;
	expiresAtMs: number;
}
/** "allow" only for the exact phrase; "deny" for any other answer; null when there was no answer in time or it was withdrawn. */
export type WorkbenchApproverV0 = (
	request: WorkbenchApprovalRequestV0,
	signal: AbortSignal,
) => Promise<"allow" | "deny" | null>;

export interface WorkbenchOptionsV0 {
	session: WorkbenchSessionV0;
	/** The comparison-domain key the prompt's digest is made under (its text never enters a record). */
	key: EndoDigestKeyV0;
	/** The attachment name as recorded (for example `pi.default`). */
	attachment: string;
	approver: WorkbenchApproverV0;
	/** The presented alias of a session id (the cockpit's own), so the page can link the live session to its recording. */
	aliasOf?: (sessionId: string) => string;
	now?: () => number;
	/** How long the operator has to approve a prompt. Default 5 minutes. */
	approvalWindowMs?: number;
	/** How long a pairing code lives. Default 10 minutes. */
	pairingWindowMs?: number;
	/** How long a grant lives. Default 1 hour. */
	grantMs?: number;
}

export type WorkbenchCommandStateV0 = "awaiting-approval" | "dispatching" | "accepted" | "refused";
export interface WorkbenchCommandViewV0 {
	proposalId: string;
	state: WorkbenchCommandStateV0;
	/** Why it was refused, when it was. */
	reason: EndoWorkbenchRefusalReasonV0 | null;
	/** The runtime's disposition, when it accepted. Acceptance is not completion. */
	disposition: string | null;
	bytes: number;
	/** The first 16 hex characters of the digest the operator types to approve. */
	digestPrefix: string;
	expiresAtMs: number;
}

interface Proposal {
	view: WorkbenchCommandViewV0;
	proposalDigest: string;
	proposedEventId: string;
	message: string | null;
	session: string;
	attachment: string;
	grant: string;
	abort: AbortController;
	done: Promise<void>;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const MAX_PAIR_ATTEMPTS = 5;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const equal = (a: string, b: string): boolean => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const reply = (status: number, body: unknown) => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

export class WorkbenchBrokerV0 implements EndoCockpitWorkbenchV0 {
	readonly launchId = randomBytes(8).toString("hex");
	readonly transcript = new LiveTranscriptV0();
	readonly #o: Required<Pick<WorkbenchOptionsV0, "approvalWindowMs" | "pairingWindowMs" | "grantMs">> &
		WorkbenchOptionsV0;
	readonly #now: () => number;
	#code: { value: string; expiresAtMs: number; attempts: number } | null = null;
	#grant: { token: string; expiresAtMs: number } | null = null;
	#command: Proposal | null = null;
	#disposed = false;

	constructor(options: WorkbenchOptionsV0) {
		this.#o = {
			approvalWindowMs: 5 * 60_000,
			pairingWindowMs: 10 * 60_000,
			grantMs: 60 * 60_000,
			...options,
		};
		this.#now = options.now ?? Date.now;
		options.session.onLiveEvent = (event) => this.transcript.push(event);
	}

	// --- pairing and grant ---------------------------------------------------------------------------------------------------

	/** A new one-time pairing code, replacing any earlier one. It is shown only on the attached terminal. */
	issuePairingCode(): { code: string; expiresAtMs: number } {
		const bytes = randomBytes(8);
		const letters = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
		const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
		const expiresAtMs = this.#now() + this.#o.pairingWindowMs;
		this.#code = { value: code, expiresAtMs, attempts: 0 };
		return { code, expiresAtMs };
	}

	#pair(code: unknown): { status: number; body: unknown } {
		const held = this.#code;
		// Every refusal is the same answer: nothing says whether a code existed, expired or was used up.
		const refused = refuse(401, "pairing-refused");
		if (held === null || this.#disposed || this.#now() >= held.expiresAtMs) return refused;
		if (typeof code !== "string" || code.length > 16) {
			held.attempts += 1;
		} else if (equal(code.toUpperCase(), held.value)) {
			this.#code = null; // single use
			const token = randomBytes(32).toString("base64url");
			// A new pairing replaces the grant: whatever held the old one can no longer ask.
			this.#grant = { token, expiresAtMs: this.#now() + this.#o.grantMs };
			return reply(200, {
				schemaVersion: "endo.workbench-grant.v0",
				grant: token,
				expiresAtMs: this.#grant.expiresAtMs,
			});
		} else held.attempts += 1;
		if (held.attempts >= MAX_PAIR_ATTEMPTS) this.#code = null;
		return refused;
	}

	#granted(grant: string | null): boolean {
		const held = this.#grant;
		return (
			!this.#disposed &&
			held !== null &&
			grant !== null &&
			this.#now() < held.expiresAtMs &&
			equal(grant, held.token)
		);
	}

	// --- status --------------------------------------------------------------------------------------------------------------

	#status() {
		const session = this.#o.session;
		const id = session.piSessionId;
		const connected = !this.#disposed && session.live && id !== null;
		const sessionId = id === null ? null : `endo.session.pi.${id}`;
		const prompt = this.#promptOffer();
		return {
			schemaVersion: ENDO_WORKBENCH_STATUS_SCHEMA_V0,
			launchId: this.launchId,
			harness: "pi",
			connection: connected ? "connected" : "disconnected",
			run: connected ? (session.runActive ? "active" : "idle") : "unknown",
			session: sessionId === null ? null : (this.#o.aliasOf?.(sessionId) ?? sessionId),
			attachment: this.#o.attachment,
			offers: { prompt },
			paired: this.#grant !== null && this.#now() < this.#grant.expiresAtMs,
			command: this.#command?.view ?? null,
			transcript: {
				watermark: this.transcript.view(Number.MAX_SAFE_INTEGER).watermark,
				firstSeq: this.transcript.view(Number.MAX_SAFE_INTEGER).firstSeq,
			},
		};
	}

	/** Whether a new prompt can be proposed now, and if not, why (fixed sentences). */
	#promptOffer(): { offered: boolean; reason: string | null } {
		const session = this.#o.session;
		if (this.#disposed || !session.live || session.piSessionId === null)
			return { offered: false, reason: "The session has no admitted connection now." };
		if (session.runActive)
			return {
				offered: false,
				reason: "A run is open. A new prompt is sent only when the agent is idle; steering comes later.",
			};
		if (
			this.#command !== null &&
			(this.#command.view.state === "awaiting-approval" || this.#command.view.state === "dispatching")
		)
			return { offered: false, reason: "Another prompt is waiting for approval or being sent." };
		return { offered: true, reason: null };
	}

	// --- the request surface -------------------------------------------------------------------------------------------------

	async handle(request: EndoCockpitWorkbenchRequestV0): Promise<{ status: number; body: unknown }> {
		const [a, b, ...more] = request.route;
		if (a === "status" && b === undefined && request.method === "GET" && request.query === "")
			return reply(200, this.#status());
		if (a === "pair" && b === undefined && request.method === "POST" && request.query === "")
			return this.#pair(isRecord(request.body) ? request.body.code : undefined);
		// Everything below needs the grant.
		if (!this.#granted(request.grant)) return refuse(401, "grant-required");
		if (a === "transcript" && b === undefined && request.method === "GET") {
			const match = /^after=(0|[1-9][0-9]{0,15})$/.exec(request.query);
			if (request.query !== "" && match === null) return refuse(400, "bad-request");
			const view = this.transcript.view(match === null ? 0 : Number(match[1]));
			return reply(200, { schemaVersion: "endo.workbench-transcript.v0", launchId: this.launchId, ...view });
		}
		if (a === "prompt" && b === "propose" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#propose(request.grant as string, isRecord(request.body) ? request.body : null);
		if (a === "prompt" && b === "discard" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#discard(isRecord(request.body) ? request.body.proposalId : undefined);
		if (a === "prompt" && b !== undefined && more.length === 0 && request.method === "GET" && request.query === "") {
			return this.#command?.view.proposalId === b ? reply(200, this.#command.view) : refuse(404, "not-found");
		}
		return refuse(404, "not-found");
	}

	// --- the prompt command --------------------------------------------------------------------------------------------------

	#propose(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null || Object.keys(body).join() !== "message" || typeof body.message !== "string")
			return refuse(400, "bad-request");
		const message = body.message;
		const bytes = Buffer.byteLength(message, "utf8");
		// eslint-disable-next-line no-control-regex
		if (
			message.trim().length === 0 ||
			bytes > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 ||
			/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)
		)
			return refuse(400, "bad-request");
		const offer = this.#promptOffer();
		if (!offer.offered) return refuse(409, "not-offered");
		const session = this.#o.session;
		const piId = session.piSessionId as string;
		const sessionId = `endo.session.pi.${piId}`;
		const proposedAt = new Date(this.#now()).toISOString();
		const ref = {
			digest: this.#o.key.digest({ purpose: "endo.workbench.prompt-message.v0", message }),
			bytes,
		};
		const content = {
			session: sessionId,
			attachment: this.#o.attachment,
			message: ref,
			origin: "operator-workbench",
			proposedAt,
		};
		const proposalDigest = sha256(canonicalEndoJsonV0(content as never));
		const proposalId = `endo.evidence.workbench-prompt-${proposalDigest.slice(0, 32)}`;
		let proposed: EndoEventV0;
		try {
			proposed = session.recordWorkbench("workbench.prompt-proposed", {
				schemaVersion: ENDO_WORKBENCH_SCHEMA_V0,
				proposalId,
				proposalDigest,
				...content,
			} as unknown as Record<string, JsonValueV0>);
		} catch {
			return refuse(503, "not-recording");
		}
		const abort = new AbortController();
		const expiresAtMs = this.#now() + this.#o.approvalWindowMs;
		const proposal: Proposal = {
			view: {
				proposalId,
				state: "awaiting-approval",
				reason: null,
				disposition: null,
				bytes,
				digestPrefix: proposalDigest.slice(0, 16),
				expiresAtMs,
			},
			proposalDigest,
			proposedEventId: proposed.id,
			message,
			session: sessionId,
			attachment: this.#o.attachment,
			grant,
			abort,
			done: Promise.resolve(),
		};
		this.#command = proposal;
		proposal.done = this.#run(proposal);
		return reply(202, proposal.view);
	}

	#discard(proposalId: unknown): { status: number; body: unknown } {
		const proposal = this.#command;
		if (proposal === null || proposal.view.proposalId !== proposalId) return refuse(404, "not-found");
		if (proposal.view.state !== "awaiting-approval") return refuse(409, "not-withdrawable");
		proposal.abort.abort();
		return reply(200, proposal.view);
	}

	/** Ask the operator, then gate and send. The only place a prompt leaves the broker. */
	async #run(p: Proposal): Promise<void> {
		const session = this.#o.session;
		const settle = (reason: EndoWorkbenchRefusalReasonV0, derived: string): void => {
			p.message = null;
			p.view = { ...p.view, state: "refused", reason };
			try {
				session.recordWorkbench(
					"workbench.prompt-refused",
					{ schemaVersion: ENDO_WORKBENCH_SCHEMA_V0, proposalId: p.view.proposalId, reason },
					[derived],
				);
			} catch {
				// the store is closed: the view still says refused
			}
		};
		const phrase = `APPROVE PROMPT ${p.proposalDigest.slice(0, 16)}`;
		let answer: "allow" | "deny" | null = null;
		try {
			answer = await this.#o.approver(
				{
					proposalId: p.view.proposalId,
					phrase,
					session: p.session,
					attachment: p.attachment,
					bytes: p.view.bytes,
					message: p.message as string,
					expiresAtMs: p.view.expiresAtMs,
				},
				p.abort.signal,
			);
		} catch {
			answer = null;
		}
		if (this.#disposed) return settle("session-ended", p.proposedEventId);
		if (answer === null)
			return settle(p.abort.signal.aborted ? "not-authorized" : "approval-timed-out", p.proposedEventId);
		const decidedAt = new Date(this.#now()).toISOString();
		let authorized: EndoEventV0;
		try {
			authorized = session.recordWorkbench(
				"workbench.prompt-authorized",
				{
					schemaVersion: ENDO_WORKBENCH_SCHEMA_V0,
					proposalId: p.view.proposalId,
					proposalDigest: p.proposalDigest,
					decision: answer,
					confirmation: "terminal",
					decidedAt,
				},
				[p.proposedEventId],
			);
		} catch {
			return settle("session-ended", p.proposedEventId);
		}
		if (answer === "deny") return settle("authorization-denied", authorized.id);
		// The gate is checked again at the moment of sending: what was true when it was proposed may not be.
		const piId = session.piSessionId;
		if (this.#now() >= p.view.expiresAtMs) return settle("authorization-expired", authorized.id);
		if (!session.live || piId === null || `endo.session.pi.${piId}` !== p.session)
			return settle("session-ended", authorized.id);
		if (!this.#granted(p.grant)) return settle("not-authorized", authorized.id);
		if (session.runActive) return settle("run-active", authorized.id);
		p.view = { ...p.view, state: "dispatching" };
		let dispatched: EndoEventV0;
		try {
			dispatched = session.recordWorkbench(
				"workbench.prompt-dispatched",
				{ schemaVersion: ENDO_WORKBENCH_SCHEMA_V0, proposalId: p.view.proposalId },
				[authorized.id],
			);
		} catch {
			return settle("session-ended", authorized.id);
		}
		const text = p.message as string;
		p.message = null; // sent from here on: the broker keeps no copy
		try {
			const disposition = await session.prompt(text);
			const known = (ENDO_WORKBENCH_DISPOSITIONS_V0 as readonly string[]).includes(disposition);
			if (!known) return settle("runtime-refused", dispatched.id);
			p.view = { ...p.view, state: "accepted", disposition };
			try {
				session.recordWorkbench(
					"workbench.prompt-accepted",
					{ schemaVersion: ENDO_WORKBENCH_SCHEMA_V0, proposalId: p.view.proposalId, disposition },
					[dispatched.id],
				);
			} catch {
				// recorded acceptance is best effort once the runtime has answered; the view says what Pi replied
			}
		} catch {
			settle("runtime-refused", dispatched.id);
		}
	}

	// --- disposal ------------------------------------------------------------------------------------------------------------

	/** Stop accepting anything, withdraw a waiting approval, revoke the grant and forget the transcript. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#grant = null;
		this.#code = null;
		this.#command?.abort.abort();
		await this.#command?.done.catch(() => {});
		this.transcript.clear();
		this.#o.session.onLiveEvent = null;
	}
}
