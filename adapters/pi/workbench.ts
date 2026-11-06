// The workbench broker: the ONLY writable boundary of the DEVELOP workbench. It lives in the attached process (`endo harness attach
// --workbench`), beside the Pi child it launched, and controls nothing else: it never attaches to a Pi another tool started.
//
// What it offers, as a closed list of routes under `api/v0/workbench/` (cockpit-http/server.ts guards every one of them: Host, Origin,
// Fetch Metadata, and for a POST an exact same-origin Origin, `application/json` and a bounded body):
//
//   GET  status                 connection, run state, the one command in flight, what is offered and why not. Read capability only.
//   POST pair {code}            exchange the one-time code shown on the attached terminal for an operator grant.
//   GET  transcript?after=n     the live, private, in-memory transcript (with model-provided reasoning, when the runtime supplies it in
//                               structured form, and the message being written). Needs the grant.
//   POST prompt/propose {message}   ask to send ONE new user prompt. Needs the grant. This only REQUESTS: see below.
//   GET  prompt/<id>            the state of that prompt. Needs the grant.
//   POST prompt/discard {proposalId}  withdraw it before it is approved.
//   POST intervention/propose {operation, message?}   ask to STEER, QUEUE or STOP the open run. Needs the grant. Only REQUESTS.
//   GET  intervention/<id>      the state of that request. Needs the grant.
//   POST intervention/discard {proposalId}   withdraw it before it is approved.
//   GET  project                the launch directory's Git context (repository, worktree, branch, linked worktrees, changed files). Needs the grant. READ ONLY.
//   GET  project/diff?snapshot=&file=   one changed file's diff, for an entry of that snapshot. Needs the grant. READ ONLY.
//   GET  workspace              the operator's registered project and its tasks (metadata they wrote), and POST workspace/tasks/<create|update|status|
//                               select|link-session|unlink-session>: see runtime/contracts/workspace-routes.ts. Needs the grant. METADATA ONLY: none of them sends a command.
//   GET  workspace/attempts     the selected task's work attempts and their briefs (docs/designs/develop-work-attempts.md). Needs the grant.
//                               READ ONLY: no attempt is made or recorded here, and no brief is sent anywhere.
//   GET  workspace/attention    every open task's attempts and latest checks, summarised for triage (docs/designs/develop-attention.md).
//                               Needs the grant. READ ONLY: nothing is decided, written or run here.
//   POST intervention/check {proposalId}     start a bounded check of whether the capture shows a STEER or QUEUE was consumed; the answer is read
//                                             back from the request's view. Needs the grant.
//   POST attempt/propose {attemptId}   ask to send a prepared work attempt's brief as ONE new prompt. Needs the grant. Only REQUESTS: the
//                                      page names the attempt and nothing else; the brief is read from the attempt's own record here. Its
//                                      state is read, and it is withdrawn, through prompt/<id> and prompt/discard, as any prompt.
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
// A DEVELOP work attempt's brief can be sent as such a prompt (docs/designs/develop-attempt-execution.md). The operator asks for it on the
// attached terminal (`attempt <id>`, cli/workbench.ts) or from the paired page (`attempt/propose`, docs/designs/develop-attempt-workbench.md):
// either way it is only a REQUEST, and the page's request is one more thing a grant may ask, never approve. The broker renders the brief
// from the attempt's own record (never text from a page), shows it whole on the terminal for approval under its own phrase (`APPROVE
// ATTEMPT <16 hex>`) with where it was requested from, and, once approved and gated, writes the attempt's one authorisation record
// (runtime/contracts/develop-attempt-dispatch.ts) BEFORE it records the send. The prompt chain is the same chain; nothing else changes.
//
// STEER, QUEUE and STOP are not new machinery: they go through the existing intervention desk and its chain (adapters/pi/
// workbench-interventions.ts), behind the same terminal approval. Not here: a shell, a PTY, a raw Pi RPC passthrough, or any store read
// or write other than those two record chains.

import { createHash, randomBytes } from "node:crypto";
import { ENDO_DEVELOP_WORKSPACE_ABSENT_V1 } from "../../protocol/develop-tasks.ts";
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
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type {
	DevelopAttemptCandidateV0,
	DevelopAttemptDispatchRefusalV0,
	DevelopAttemptDispatchV0,
} from "../../runtime/contracts/develop-attempt-dispatch.ts";
import type { DevelopLaunchHostV0, DevelopLaunchWorkspaceV0 } from "../../runtime/contracts/develop-workspace.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { EndoPairingV0 } from "../../runtime/contracts/workbench-pairing.ts";
import {
	type EndoProjectSourceV0,
	EndoWorkspaceRoutesV0,
	endoProjectRouteV0,
} from "../../runtime/contracts/workspace-routes.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import { LIVE_TRANSCRIPT_SCHEMA_V1, LiveTranscriptV0 } from "./live-transcript.ts";
import { piEndoSessionIdV0 } from "./mapping.ts";
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
	/**
	 * What the operator is being asked to approve. A prompt starts a run, and so does an attempt (a prompt whose text is a work attempt's
	 * brief); the others act on the run that is open.
	 */
	operation: "prompt" | "attempt" | "steer" | "queue" | "stop";
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
	/** For an attempt: which one, and its task as checked when it was requested. The message is its brief. */
	attempt?: { attemptId: string; taskId: string; taskRevision: number; preparedOnRevision: number };
	/** For a prompt or an attempt: where it was requested, on this terminal or from the paired page. Either way only the terminal approves. */
	requestedFrom?: "terminal" | "page";
}
/** "allow" only for the exact phrase; "deny" for any other answer; null when there was no answer in time or it was withdrawn. */
export type WorkbenchApproverV0 = (
	request: WorkbenchApprovalRequestV0,
	signal: AbortSignal,
) => Promise<"allow" | "deny" | null>;

/**
 * The project context the broker may serve: two READS about the directory the session was launched in (adapters/git/project-inspector.ts),
 * served by the shared `endoProjectRouteV0` (runtime/contracts/workspace-routes.ts). Not part of the command surface.
 */
export type WorkbenchProjectSourceV0 = EndoProjectSourceV0;

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
	/**
	 * The operator's project and tasks (runtime/contracts/workspace-routes.ts over runtime/contracts/develop-workspace.ts): opens the launch scope of the
	 * project the operator named for this launch with `--project`, from the directory the process was launched in. The broker supplies the
	 * host's facts (its launch id, attachment and connected session) from its own state; the broker never holds the operator scope or the
	 * store. Without it the workspace routes answer one constant. It adds no command.
	 */
	tasks?: { open(host: DevelopLaunchHostV0): DevelopLaunchWorkspaceV0 };
	/** The presented alias of a session id (the cockpit's own), so the page can link the live session to its recording. */
	aliasOf?: (sessionId: string) => string;
	/**
	 * Sending a work attempt's brief (runtime/contracts/develop-attempt-dispatch.ts), for the project named with `--project`. Reached only by
	 * `requestAttempt` (the attached terminal's `attempt <id>`) and the page's `attempt/propose` (under its grant); both only request.
	 * Without it, attempts cannot be sent from this workbench.
	 */
	attempts?: Pick<DevelopAttemptDispatchV0, "check" | "authorize">;
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
	/**
	 * For a work attempt's brief: which attempt and task, as checked when it was requested, and whether its one authorisation record was
	 * written for this request (from then on the attempt can never be sent again, whatever happened next). Null for a typed prompt.
	 */
	attempt: {
		attemptId: string;
		taskId: string;
		bound: boolean;
		/** Why it could not be bound at the moment of sending (a closed code), when it could not. */
		refusal: DevelopAttemptDispatchRefusalV0 | null;
	} | null;
}

interface Proposal {
	view: WorkbenchCommandViewV0;
	proposalDigest: string;
	proposedEventId: string;
	message: string | null;
	/** The message's keyed digest and length, as the proposal recorded them. */
	ref: { digest: { algorithm: "hmac-sha256"; keyId: string; value: string }; bytes: number };
	session: string;
	attachment: string;
	/** The page grant it was requested under, or null when the operator requested it on the attached terminal itself. */
	grant: string | null;
	/** The work attempt whose brief this is, as checked when it was requested; null for a typed prompt. */
	attempt: DevelopAttemptCandidateV0 | null;
	/** Why the attempt could not be bound at the moment of sending, when it could not. For the terminal's own account. */
	attemptRefusal: DevelopAttemptDispatchRefusalV0 | null;
	/** The attempt's authorisation record was written for this request (so the attempt can never be sent again). */
	attemptBound: boolean;
	abort: AbortController;
	done: Promise<void>;
}

/** The answer to a request made on the attached terminal: the request's view, or why nothing was requested. */
export type WorkbenchTerminalRequestV0 =
	| { ok: true; view: WorkbenchCommandViewV0 }
	| {
			ok: false;
			code: DevelopAttemptDispatchRefusalV0 | "not-offered" | "not-configured" | "not-recording";
			reason: string | null;
	  };

/**
 * What a prompt may not contain, because the operator reads it on a terminal to approve it: every control character except a newline and a
 * tab (a carriage return or an escape could overwrite or hide text on the line), the C1 controls (0x9b is a terminal escape), the line and
 * paragraph separators, and the bidirectional overrides and isolates that reorder what is shown. A prompt with any of them is refused,
 * not shown. What the operator sees is what would be sent.
 */
const UNSAFE_PROMPT_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const reply = (status: number, body: unknown) => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

export class WorkbenchBrokerV0 implements EndoCockpitWorkbenchV0 {
	readonly launchId = randomBytes(8).toString("hex");
	readonly transcript = new LiveTranscriptV0();
	readonly #o: Required<Pick<WorkbenchOptionsV0, "approvalWindowMs" | "pairingWindowMs" | "grantMs">> &
		WorkbenchOptionsV0;
	readonly #now: () => number;
	/** The page's pairing (runtime/contracts/workbench-pairing.ts): one code at a time from the terminal, one grant at a time for the page. */
	readonly #pairing: EndoPairingV0;
	#command: Proposal | null = null;
	readonly #interventions: WorkbenchInterventionsV0 | null;
	readonly #tasks: EndoWorkspaceRoutesV0 | null;
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
		this.#pairing = new EndoPairingV0({
			now: this.#now,
			pairingWindowMs: this.#o.pairingWindowMs,
			grantMs: this.#o.grantMs,
			closed: () => this.#disposed || this.#ended,
		});
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
						watermark: () => this.transcript.watermark,
						promptAwaitingApproval: () => this.#command?.view.state === "awaiting-approval",
						maxMessageBytes: ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0,
						...(options.yieldToLoop === undefined ? {} : { yieldToLoop: options.yieldToLoop }),
						...(options.evidenceBudget === undefined ? {} : { evidenceBudget: options.evidenceBudget }),
					});
		this.#tasks =
			options.tasks === undefined
				? null
				: new EndoWorkspaceRoutesV0(
						options.tasks.open({
							launchId: this.launchId,
							attachment: options.attachment,
							// The one session this host can vouch for: its own Pi session, by the canonical mapping, while it is connected.
							session: {
								source: "pi-live",
								current: () => {
									const s = options.session;
									return !this.#disposed && !this.#ended && s.live && s.piSessionId !== null
										? { sessionId: piEndoSessionIdV0(s.piSessionId) }
										: null;
								},
							},
							...(options.aliasOf === undefined ? {} : { aliasOf: options.aliasOf }),
						}),
					);
		// The desk records consequences when it finishes: a prompt still waiting for the terminal is withdrawn then too.
		options.interventions?.onFinishing(() => this.beginClose());
		options.session.onLiveEvent = (event) => {
			this.transcript.push(event);
			this.#interventions?.observe(event);
		};
	}

	// --- pairing and grant ---------------------------------------------------------------------------------------------------

	/** What the page would be told of the project and tasks now (null without `--project`). For the terminal's own account at start. */
	workspaceView() {
		return this.#tasks?.view() ?? null;
	}

	/** A new one-time pairing code, replacing any earlier one. It is shown only on the attached terminal. */
	issuePairingCode(): { code: string; expiresAtMs: number } {
		return this.#pairing.issue();
	}

	#granted(grant: string | null): boolean {
		return this.#pairing.granted(grant);
	}

	// --- status --------------------------------------------------------------------------------------------------------------

	/**
	 * `paired`: the request carried the grant. Status needs no grant, so what it says of the prompt in flight is only its state: which work
	 * attempt and task it carries is told to the paired page alone (as the attempts themselves are, behind the grant).
	 */
	#status(paired: boolean) {
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
				attempt: this.#attemptOffer(prompt),
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
			paired: this.#pairing.paired(),
			command:
				this.#command === null
					? null
					: paired || this.#command.view.attempt === null
						? this.#command.view
						: { ...this.#command.view, attempt: null },
			interventions: this.#interventions?.views() ?? [],
			transcript: {
				watermark: this.transcript.watermark,
				firstSeq: this.transcript.firstSeq,
			},
		};
	}

	/** Whether a work attempt's brief can be requested now: as a prompt can, on a workbench started with `--project`. */
	#attemptOffer(prompt: { offered: boolean; reason: string | null }): { offered: boolean; reason: string | null } {
		if (this.#o.attempts === undefined)
			return { offered: false, reason: "Attempts can be sent only from a workbench started with --project." };
		return prompt;
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
		this.#pairing.clear();
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
			return reply(200, this.#status(this.#granted(request.grant)));
		if (a === "pair" && b === undefined && request.method === "POST" && request.query === "")
			return this.#pairing.pair(isRecord(request.body) ? request.body.code : undefined);
		// Everything below needs the grant.
		if (!this.#granted(request.grant)) return refuse(401, "grant-required");
		if (a === "transcript" && b === undefined && request.method === "GET") {
			const match = /^after=(0|[1-9][0-9]{0,15})$/.exec(request.query);
			if (request.query !== "" && match === null) return refuse(400, "bad-request");
			const view = this.transcript.view(match === null ? 0 : Number(match[1]));
			return reply(200, { schemaVersion: LIVE_TRANSCRIPT_SCHEMA_V1, launchId: this.launchId, ...view });
		}
		// The operator's tasks: metadata only, behind the grant. Without a registered project the workbench says so with one constant answer.
		if (a === "workspace") {
			if (this.#tasks === null)
				return b === undefined && request.method === "GET" && request.query === ""
					? reply(200, ENDO_DEVELOP_WORKSPACE_ABSENT_V1)
					: refuse(404, "not-found");
			const answer = await this.#tasks.route(request.route, request.method, request.query, request.body);
			// A read that waited (the attempts and the attention overview read the launch directory's HEAD) answers only if the grant it was
			// asked under still holds: a pairing revoked meanwhile gets the refusal, never data that would look current.
			return this.#granted(request.grant) ? answer : refuse(401, "grant-required");
		}
		// The project context (read-only Git), by the shared translation: without a source, the bare route answers one constant (as the
		// read-only server does for status), so a page can ask quietly: a 404 would be logged by every browser as a failed request.
		if (a === "project") {
			const answer = await endoProjectRouteV0(this.#o.project, request.route, request.method, request.query);
			// As for the workspace reads: a pairing revoked while Git was being read gets the refusal, never the read.
			if (answer !== null) return this.#granted(request.grant) ? answer : refuse(401, "grant-required");
		}
		if (a === "prompt" && b === "propose" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#propose(request.grant as string, isRecord(request.body) ? request.body : null);
		if (a === "attempt" && b === "propose" && more.length === 0 && request.method === "POST" && request.query === "")
			return this.#proposeAttempt(request.grant as string, isRecord(request.body) ? request.body : null);
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
		const opened = this.#open(grant, message, null);
		return opened === null ? refuse(503, "not-recording") : reply(202, opened.view);
	}

	/**
	 * The operator typed `attempt <id>` on the attached terminal: request that attempt's brief as a new prompt. The same chain, offer and
	 * approval as a prompt from the page, with the brief rendered here from the attempt's own record (never text from a page), shown whole
	 * on the terminal under its own phrase. The terminal calls this (no grant); the page's route is `#proposeAttempt`. It sends nothing: it only REQUESTS.
	 */
	requestAttempt(attemptId: string): WorkbenchTerminalRequestV0 {
		return this.#requestAttempt(null, attemptId);
	}

	/**
	 * The paired page asks to send a prepared attempt's brief. The body names the attempt and nothing else: no text, task, session or
	 * project is taken from the page. The same checks and the same chain as the terminal's `attempt <id>`, under the page's grant (which
	 * must still hold when it is sent). It only REQUESTS: the operator approves it on the terminal, where it is shown whole.
	 */
	#proposeAttempt(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null || Object.keys(body).join() !== "attemptId" || typeof body.attemptId !== "string")
			return refuse(400, "bad-request");
		const asked = this.#requestAttempt(grant, body.attemptId);
		if (asked.ok) return reply(202, asked.view);
		switch (asked.code) {
			case "not-configured":
				return refuse(404, "not-found");
			case "not-offered":
				return refuse(409, "not-offered");
			case "not-recording":
				return refuse(503, "not-recording");
			case "bad-request":
				return refuse(400, "bad-request");
			default:
				// Why this attempt cannot be requested, as a closed code: the page words it; nothing was recorded or sent.
				return refuse(409, `attempt-${asked.code}`);
		}
	}

	#requestAttempt(grant: string | null, attemptId: string): WorkbenchTerminalRequestV0 {
		const attempts = this.#o.attempts;
		if (attempts === undefined)
			return {
				ok: false,
				code: "not-configured",
				reason: "Attempts can be sent only from a workbench started with --project.",
			};
		const offer = this.#promptOffer();
		if (!offer.offered) return { ok: false, code: "not-offered", reason: offer.reason };
		const checked = attempts.check(attemptId);
		if (!checked.ok) return { ok: false, code: checked.code, reason: null };
		// The checks the page's prompts get: a brief is the operator's own text, but the terminal must still show it faithfully.
		const brief = checked.value.brief;
		const bytes = Buffer.byteLength(brief, "utf8");
		if (brief.trim().length === 0 || bytes > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0)
			return { ok: false, code: "brief-too-large", reason: null };
		if (UNSAFE_PROMPT_CHARS.test(brief)) return { ok: false, code: "brief-unsafe", reason: null };
		const opened = this.#open(grant, brief, checked.value);
		return opened === null
			? { ok: false, code: "not-recording", reason: "The session is not recording." }
			: { ok: true, view: opened.view };
	}

	/** Record the proposal and start asking. The caller has checked the message and the offer. Null when the proposal cannot be recorded. */
	#open(grant: string | null, message: string, attempt: DevelopAttemptCandidateV0 | null): Proposal | null {
		const session = this.#o.session;
		const piId = session.piSessionId as string;
		const sessionId = `endo.session.pi.${piId}`;
		const proposedAt = new Date(this.#now()).toISOString();
		const bytes = Buffer.byteLength(message, "utf8");
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
			return null;
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
				attempt:
					attempt === null
						? null
						: { attemptId: attempt.attemptId, taskId: attempt.taskId, bound: false, refusal: null },
			},
			proposalDigest,
			proposedEventId: proposed.id,
			message,
			ref: ref as Proposal["ref"],
			session: sessionId,
			attachment: this.#o.attachment,
			grant,
			attempt,
			attemptRefusal: null,
			attemptBound: false,
			abort,
			done: Promise.resolve(),
		};
		this.#command = proposal;
		proposal.done = this.#run(proposal);
		return proposal;
	}

	/** For the terminal: whether the attempt request with this id was bound to its attempt, and if binding was refused, why. */
	attemptBindingOf(proposalId: string): { bound: boolean; refusal: DevelopAttemptDispatchRefusalV0 | null } | null {
		const p = this.#command;
		return p !== null && p.view.proposalId === proposalId && p.attempt !== null
			? { bound: p.attemptBound, refusal: p.attemptRefusal }
			: null;
	}

	/** Settles when the request with this id has settled (for the terminal's own account of what happened). */
	settled(proposalId: string): Promise<WorkbenchCommandViewV0 | null> {
		const p = this.#command;
		if (p === null || p.view.proposalId !== proposalId) return Promise.resolve(null);
		return p.done.then(
			() => p.view,
			() => p.view,
		);
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
		// An attempt has its own phrase: a prompt's approval, typed into an attempt's question, declines it, and the other way round.
		const phrase = `APPROVE ${p.attempt === null ? "PROMPT" : "ATTEMPT"} ${p.proposalDigest.slice(0, 16)}`;
		let answer: "allow" | "deny" | null = null;
		try {
			answer = await this.#o.approver(
				{
					operation: p.attempt === null ? "prompt" : "attempt",
					proposalId: p.view.proposalId,
					phrase,
					session: p.session,
					attachment: p.attachment,
					bytes: p.view.bytes,
					message: p.message as string,
					expiresAtMs: p.view.expiresAtMs,
					requestedFrom: p.grant === null ? "terminal" : "page",
					...(p.attempt === null
						? {}
						: {
								attempt: {
									attemptId: p.attempt.attemptId,
									taskId: p.attempt.taskId,
									taskRevision: p.attempt.taskRevision,
									preparedOnRevision: p.attempt.preparedOnRevision,
								},
							}),
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
		// A page's request needs its grant still held; a request the operator made on the terminal needs none.
		if (p.grant !== null && !this.#granted(p.grant)) return settle("not-authorized", authorized.id);
		if (session.runActive) return settle("run-active", authorized.id);
		// An attempt is bound to this request now: after the approval and the gate, BEFORE the send is recorded. The attempt is checked again
		// (its task, project and brief may have changed while the operator read it), and its authorisation is written once. From here a send
		// may follow; the log, which records the send before it is made, says whether one was.
		if (p.attempt !== null) {
			let bound: ReturnType<DevelopAttemptDispatchV0["authorize"]>;
			try {
				bound = this.#o.attempts?.authorize(p.attempt, {
					session: p.session,
					attachment: p.attachment,
					launchId: this.launchId,
					proposalId: p.view.proposalId,
					proposalDigest: p.proposalDigest,
					authorizationEventId: authorized.id,
					message: p.ref,
				}) ?? { ok: false as const, code: "storage-failed" as const };
			} catch {
				// A failure here must settle the request (never leave it holding the one approval slot): nothing was sent.
				bound = { ok: false, code: "storage-failed" };
			}
			if (!bound.ok) {
				p.attemptRefusal = bound.code;
				p.view = {
					...p.view,
					attempt: { ...(p.view.attempt as NonNullable<WorkbenchCommandViewV0["attempt"]>), refusal: bound.code },
				};
				return settle(
					bound.code === "already-authorized"
						? "duplicate"
						: bound.code === "storage-failed" || bound.code === "unreadable"
							? "attempt-not-recorded"
							: "attempt-changed",
					authorized.id,
				);
			}
			p.attemptBound = true;
			p.view = {
				...p.view,
				attempt: { ...(p.view.attempt as NonNullable<WorkbenchCommandViewV0["attempt"]>), bound: true },
			};
		}
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
		this.#pairing.clear();
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
