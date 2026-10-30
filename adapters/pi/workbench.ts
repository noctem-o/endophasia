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
//   POST intervention/propose {operation, message?}   ask to STEER, QUEUE or STOP the open run. Needs the grant. Only REQUESTS.
//   GET  intervention/<id>      the state of that request. Needs the grant.
//   POST intervention/discard {proposalId}   withdraw it before it is approved.
//   GET  project                the launch directory's Git context (repository, worktree, branch, linked worktrees, changed files). Needs the grant. READ ONLY.
//   GET  project/diff?snapshot=&file=   one changed file's diff, for an entry of that snapshot. Needs the grant. READ ONLY.
//   POST intervention/check {proposalId}     start a bounded check of whether the capture shows a STEER or QUEUE was consumed; the answer is read
//                                             back from the request's view. Needs the grant.
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
// STEER, QUEUE and STOP are not new machinery: they go through the existing intervention desk and its chain (adapters/pi/
// workbench-interventions.ts), behind the same terminal approval. Not here: a shell, a PTY, a raw Pi RPC passthrough, or any store read
// or write other than those two record chains.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	ENDO_WORKBENCH_DISPOSITIONS_V0,
	ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0,
	ENDO_WORKBENCH_SCHEMA_V0,
	type EndoWorkbenchKindV0,
	type EndoWorkbenchRefusalReasonV0,
} from "../../protocol/workbench.ts";
import type { EndoCockpitWorkbenchRequestV0, EndoCockpitWorkbenchV0 } from "../../protocol/workbench-http.ts";
import type {
	EndoDiffOutcomeV0,
	EndoWorkbenchDiffV0,
	EndoWorkbenchProjectV0,
} from "../../protocol/workbench-project.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import { LiveTranscriptV0 } from "./live-transcript.ts";
import { PiRpcRefusalV0 } from "./rpc.ts";
import {
	type WorkbenchDeskV0,
	type WorkbenchEvidenceBudgetV0,
	WorkbenchInterventionsV0,
} from "./workbench-interventions.ts";

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
	/** What the operator is being asked to approve. A prompt starts a run; the others act on the run that is open. */
	operation: "prompt" | "steer" | "queue" | "stop";
	proposalId: string;
	/** The exact phrase that approves this request. Anything else declines. */
	phrase: string;
	session: string;
	attachment: string;
	bytes: number;
	/** The whole message (null for STOP): it is the operator's own terminal, and they must see exactly what they authorise. */
	message: string | null;
	expiresAtMs: number;
	/** For a STOP: the steer or queue it superseded while that was still awaiting approval (it was cancelled unapproved), else null. */
	supersedes?: "steer" | "queue" | null;
}
/** "allow" only for the exact phrase; "deny" for any other answer; null when there was no answer in time or it was withdrawn. */
export type WorkbenchApproverV0 = (
	request: WorkbenchApprovalRequestV0,
	signal: AbortSignal,
) => Promise<"allow" | "deny" | null>;

/**
 * The project context the broker may serve: two READS about the directory the session was launched in (adapters/git/project-inspector.ts).
 * It is not part of the command surface: it can change nothing, takes no path from the page, and says nothing about who made a change.
 */
export interface WorkbenchProjectSourceV0 {
	overview(): Promise<EndoWorkbenchProjectV0>;
	diff(snapshot: string, id: number): Promise<EndoDiffOutcomeV0>;
	/** The session ended: drop what was read. */
	dispose?(): void;
}

export interface WorkbenchOptionsV0 {
	session: WorkbenchSessionV0;
	/** The comparison-domain key the prompt's digest is made under (its text never enters a record). */
	key: EndoDigestKeyV0;
	/** The attachment name as recorded (for example `pi.default`). */
	attachment: string;
	approver: WorkbenchApproverV0;
	/** The intervention desk STEER, QUEUE and STOP go through. Without it they are not offered. */
	interventions?: WorkbenchDeskV0;
	/** Read-only project context (the launch directory's Git state). Without it the project routes do not exist. */
	project?: WorkbenchProjectSourceV0;
	/** The presented alias of a session id (the cockpit's own), so the page can link the live session to its recording. */
	aliasOf?: (sessionId: string) => string;
	now?: () => number;
	/** How long the operator has to approve a prompt. Default 5 minutes. */
	approvalWindowMs?: number;
	/** How long a pairing code lives. Default 10 minutes. */
	pairingWindowMs?: number;
	/** How long a grant lives. Default 1 hour. */
	grantMs?: number;
	/** For tests: where an evidence check yields between slices, and its work limits. */
	yieldToLoop?: () => Promise<void>;
	evidenceBudget?: Partial<WorkbenchEvidenceBudgetV0>;
}

/**
 * `unknown`: the prompt was dispatched and the runtime's reply was not seen (a timeout, a lost connection, an odd answer). Agent work may
 * have started: it is neither accepted nor refused, and the page says so rather than inviting a duplicate.
 */
export type WorkbenchCommandStateV0 = "awaiting-approval" | "dispatching" | "accepted" | "refused" | "unknown";
export interface WorkbenchCommandViewV0 {
	proposalId: string;
	state: WorkbenchCommandStateV0;
	/** Whether the operator typed the approval on the terminal. A withdrawn, timed-out or declined prompt was never approved. */
	approved: boolean;
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

/**
 * What a prompt may not contain, because the operator reads it on a terminal to approve it: every control character except a newline and a
 * tab (a carriage return or an escape could overwrite or hide text on the line), the C1 controls (0x9b is a terminal escape), the line and
 * paragraph separators, and the bidirectional overrides and isolates that reorder what is shown. A prompt with any of them is refused,
 * not shown. What the operator sees is what would be sent.
 */
const UNSAFE_PROMPT_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
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
	readonly #interventions: WorkbenchInterventionsV0 | null;
	/** The desk's final finish began: no prompt is offered or sent from here on, and one waiting for the terminal is withdrawn. */
	#closing = false;
	#disposed = false;
	/** The runtime ended: the workbench for this session is over. Terminal: a later process is a new connection, never a continuation. */
	#ended = false;

	constructor(options: WorkbenchOptionsV0) {
		this.#o = {
			approvalWindowMs: 5 * 60_000,
			pairingWindowMs: 10 * 60_000,
			grantMs: 60 * 60_000,
			...options,
		};
		this.#now = options.now ?? Date.now;
		this.#interventions =
			options.interventions === undefined
				? null
				: new WorkbenchInterventionsV0({
						session: options.session,
						desk: options.interventions,
						approver: options.approver,
						launchId: this.launchId,
						now: this.#now,
						approvalWindowMs: this.#o.approvalWindowMs,
						granted: (grant) => this.#granted(grant),
						closed: () => this.#disposed || this.#ended,
						unsafe: (message) => UNSAFE_PROMPT_CHARS.test(message),
						watermark: () => this.transcript.view(Number.MAX_SAFE_INTEGER).watermark,
						promptAwaitingApproval: () => this.#command?.view.state === "awaiting-approval",
						maxMessageBytes: ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0,
						...(options.yieldToLoop === undefined ? {} : { yieldToLoop: options.yieldToLoop }),
						...(options.evidenceBudget === undefined ? {} : { evidenceBudget: options.evidenceBudget }),
					});
		// The desk records consequences when it finishes: a prompt still waiting for the terminal is withdrawn then too.
		options.interventions?.onFinishing(() => this.beginClose());
		options.session.onLiveEvent = (event) => {
			this.transcript.push(event);
			this.#interventions?.observe(event);
		};
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
		if (held === null || this.#disposed || this.#ended || this.#now() >= held.expiresAtMs) return refused;
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
			!this.#ended &&
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
		const connected = !this.#disposed && !this.#ended && session.live && id !== null;
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
			offers: {
				prompt,
				...Object.fromEntries(
					(["steer", "queue", "stop"] as const).map((operation) => [
						operation,
						this.#interventions?.offer(operation) ?? {
							offered: false,
							reason: "Interventions are not configured for this launch.",
						},
					]),
				),
			},
			paired: this.#grant !== null && this.#now() < this.#grant.expiresAtMs,
			command: this.#command?.view ?? null,
			interventions: this.#interventions?.views() ?? [],
			transcript: {
				watermark: this.transcript.view(Number.MAX_SAFE_INTEGER).watermark,
				firstSeq: this.transcript.view(Number.MAX_SAFE_INTEGER).firstSeq,
			},
		};
	}

	/** Whether a new prompt can be proposed now, and if not, why (fixed sentences). */
	#promptOffer(): { offered: boolean; reason: string | null } {
		const session = this.#o.session;
		if (this.#disposed || this.#ended || !session.live || session.piSessionId === null)
			return { offered: false, reason: "The session has no admitted connection now." };
		if (this.#closing) return { offered: false, reason: "The session is closing." };
		if (session.runActive)
			return {
				offered: false,
				reason:
					"A run is open. A new prompt is sent only when the agent is idle; steer or queue changes the open run.",
			};
		if (
			this.#command !== null &&
			(this.#command.view.state === "awaiting-approval" || this.#command.view.state === "dispatching")
		)
			return { offered: false, reason: "Another prompt is waiting for approval or being sent." };
		if (this.#interventions?.awaitingApproval())
			return {
				offered: false,
				reason:
					"An intervention is waiting for approval in the terminal. Press Enter there to decline it, or withdraw it on this page.",
			};
		return { offered: true, reason: null };
	}

	// --- the request surface -------------------------------------------------------------------------------------------------

	/**
	 * The runtime this broker serves has ended (or was lost): withdraw a waiting approval, revoke the grant and forget the transcript NOW,
	 * not when the host eventually exits. Idempotent. The listener may live on, answering status only, until the host stops it.
	 */
	endSession(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#grant = null;
		this.#code = null;
		this.#command?.abort.abort();
		this.#interventions?.beginClose();
		this.transcript.clear();
		this.#o.project?.dispose?.();
		this.#o.session.onLiveEvent = null;
	}

	/**
	 * The session is about to close and record its consequences: take nothing new and withdraw what waits for the terminal, so no
	 * request is approved after the chains have been closed off. The desk calls this when its `finish` begins.
	 */
	beginClose(): void {
		this.#closing = true;
		this.#interventions?.beginClose();
		this.#command?.abort.abort();
	}

	async handle(request: EndoCockpitWorkbenchRequestV0): Promise<{ status: number; body: unknown }> {
		// A runtime that is no longer running ends the session before anything is answered: no private text outlives it.
		if (!this.#o.session.live) this.endSession();
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
		// A workbench with no project context says so with one constant answer (as the read-only server does for status), so a page can ask
		// quietly: a 404 would be logged by every browser as a failed request.
		if (
			this.#o.project === undefined &&
			a === "project" &&
			b === undefined &&
			request.method === "GET" &&
			request.query === ""
		)
			return reply(200, { available: false, schemaVersion: "endo.workbench-project.v0" });
		if (this.#o.project !== undefined && a === "project" && request.method === "GET" && more.length === 0) {
			const project = this.#o.project;
			try {
				if (b === undefined && request.query === "") {
					const overview = await project.overview();
					// Busy is not a read: it says nothing about the worktree, so it is not served as one (the page keeps what it had).
					if (overview.state === "unavailable" && overview.reason === "busy") return refuse(429, "busy");
					return reply(200, overview);
				}
				if (b === "diff") {
					const match = /^snapshot=([0-9a-f]{16})&file=(0|[1-9][0-9]{0,5})$/.exec(request.query);
					if (match === null) return refuse(400, "bad-request");
					const outcome = await project.diff(match[1] as string, Number(match[2]));
					if (outcome.kind === "diff") return reply(200, outcome.diff satisfies EndoWorkbenchDiffV0);
					if (outcome.kind === "stale") return refuse(409, "stale-snapshot");
					if (outcome.kind === "busy") return refuse(429, "busy");
					return refuse(400, "bad-request");
				}
			} catch {
				return refuse(503, "unavailable");
			}
		}
		if (a === "prompt" && b === "propose" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#propose(request.grant as string, isRecord(request.body) ? request.body : null);
		if (a === "prompt" && b === "discard" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#discard(isRecord(request.body) ? request.body.proposalId : undefined);
		if (a === "prompt" && b !== undefined && more.length === 0 && request.method === "GET" && request.query === "") {
			return this.#command?.view.proposalId === b ? reply(200, this.#command.view) : refuse(404, "not-found");
		}
		if (this.#interventions !== null && a === "intervention" && b !== undefined) {
			const body = isRecord(request.body) ? request.body : null;
			if (request.query === "" && more.length === 0) {
				if (request.method === "POST" && b === "propose")
					return this.#interventions.propose(request.grant as string, body);
				if (request.method === "POST" && b === "discard") return this.#interventions.discard(body?.proposalId);
				if (request.method === "POST" && b === "check") return this.#interventions.check(body?.proposalId);
				if (request.method === "GET") {
					const view = this.#interventions.viewOf(b);
					return view === null ? refuse(404, "not-found") : reply(200, view);
				}
			}
		}
		return refuse(404, "not-found");
	}

	// --- the prompt command --------------------------------------------------------------------------------------------------

	#propose(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null || Object.keys(body).join() !== "message" || typeof body.message !== "string")
			return refuse(400, "bad-request");
		const message = body.message;
		const bytes = Buffer.byteLength(message, "utf8");
		if (
			message.trim().length === 0 ||
			bytes > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 ||
			UNSAFE_PROMPT_CHARS.test(message)
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
				approved: false,
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
					operation: "prompt",
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
		if (this.#disposed || this.#ended || this.#closing) return settle("session-ended", p.proposedEventId);
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
		p.view = { ...p.view, approved: true };
		// The gate is checked again at the moment of sending: what was true when it was proposed may not be.
		const piId = session.piSessionId;
		if (this.#now() >= p.view.expiresAtMs) return settle("authorization-expired", authorized.id);
		if (this.#closing || this.#ended || !session.live || piId === null || `endo.session.pi.${piId}` !== p.session)
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
			if (!(ENDO_WORKBENCH_DISPOSITIONS_V0 as readonly string[]).includes(disposition)) {
				// Pi answered, in a form this version does not know: not an acceptance, and not a refusal either.
				p.view = { ...p.view, state: "unknown" };
				return;
			}
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
		} catch (error) {
			// Only Pi's own explicit refusal is a refusal. A timeout, a lost connection or a protocol fault rejected a request that was
			// already written: the work may have started, so the outcome is unknown, never "not sent".
			if (error instanceof PiRpcRefusalV0) settle("runtime-refused", dispatched.id);
			else p.view = { ...p.view, state: "unknown" };
		}
	}

	// --- disposal ------------------------------------------------------------------------------------------------------------

	/** Stop accepting anything, withdraw a waiting approval, revoke the grant and forget the transcript. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#grant = null;
		this.#code = null;
		this.#ended = true;
		this.#command?.abort.abort();
		this.#interventions?.beginClose();
		await this.#command?.done.catch(() => {});
		// Bounded: a STOP Pi answers only once idle must not hold the process (the desk's `finish` has already waited for it).
		await this.#interventions?.settle(2_000);
		this.transcript.clear();
		this.#o.session.onLiveEvent = null;
	}
}
