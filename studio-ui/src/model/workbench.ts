// Workbench state. Pure: no DOM, no network, no clock (times are passed in). One owner for what the page knows of the live session: what
// the broker last said (status), the private transcript it served, the one prompt in flight, and the grant, which lives here in memory
// only. Nothing is inferred: a state is what the broker reported; a lost broker is "unreachable", never "ended".
import type { TranscriptItem, WorkbenchCommand, WorkbenchReply, WorkbenchStatus } from "./workbench-wire.ts";

export const MAX_ITEMS = 400;

export interface WorkbenchState {
	/** unknown until the first status answer; absent on a server that has no workbench (the read-only Studio). */
	availability: "unknown" | "available" | "absent";
	status: WorkbenchStatus | null;
	statusAt: Date | null;
	launchId: string | null;
	/** The operator grant: held in memory only, dropped when the broker says the page is no longer paired. */
	grant: string | null;
	items: TranscriptItem[];
	watermark: number;
	evicted: number;
	command: WorkbenchCommand | null;
	busy: boolean;
	problem: string | null;
	/** The last attempt did not reach the broker at all. It says nothing about whether the session ended. */
	unreachable: boolean;
	/** Opt-in, bounded following of the live session: a read every few seconds while on. */
	follow: boolean;
	/** Which surface DEVELOP shows: the live conversation, or a recorded session. */
	view: "live" | "recorded";
}

export const initialWorkbench = (): WorkbenchState => ({
	availability: "unknown",
	status: null,
	statusAt: null,
	launchId: null,
	grant: null,
	items: [],
	watermark: 0,
	evicted: 0,
	command: null,
	busy: false,
	problem: null,
	unreachable: false,
	follow: false,
	view: "live",
});

export type WorkbenchAction =
	| { type: "started" }
	| { type: "finished" }
	| { type: "reply"; reply: WorkbenchReply; at: Date }
	| { type: "follow"; on: boolean }
	| { type: "view"; view: "live" | "recorded" }
	| { type: "unpair" };

export const commandOpen = (c: WorkbenchCommand | null): boolean =>
	c !== null && (c.state === "awaiting-approval" || c.state === "dispatching");

export function reduceWorkbench(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
	switch (action.type) {
		case "started":
			return { ...state, busy: true };
		case "finished":
			return { ...state, busy: false };
		case "follow":
			return { ...state, follow: action.on };
		case "view":
			return { ...state, view: action.view };
		case "unpair":
			return { ...state, grant: null };
		case "reply":
			return apply(state, action.reply, action.at);
	}
}

function apply(state: WorkbenchState, reply: WorkbenchReply, at: Date): WorkbenchState {
	switch (reply.kind) {
		case "absent":
			return { ...initialWorkbench(), availability: "absent", view: "recorded" };
		case "status": {
			const status = reply.record;
			// A different launch is a different process: nothing held from the old one (grant, text, a prompt) belongs to it.
			const fresh = state.launchId !== null && state.launchId !== status.launchId;
			const base = fresh ? { ...initialWorkbench(), view: state.view, follow: state.follow } : state;
			// The broker says the session is DISCONNECTED (its answer, not a failure to reach it): the private text it held is gone, so the
			// page forgets its copy too. An unreachable broker is a different thing and clears nothing.
			const gone = status.connection === "disconnected";
			return {
				...base,
				...(gone ? { items: [], watermark: 0, evicted: 0 } : {}),
				availability: "available",
				status,
				statusAt: at,
				launchId: status.launchId,
				// The broker holds one grant: if it says this page is not paired, the grant we hold is no longer one.
				grant: status.paired ? base.grant : null,
				command: status.command,
				problem: null,
				unreachable: false,
			};
		}
		case "transcript": {
			const t = reply.record;
			if (state.launchId !== t.launchId) return state;
			const reset = t.watermark < state.watermark;
			const held = reset ? [] : state.items;
			const last = held.at(-1)?.seq ?? 0;
			// Items of one tool call fold into one row: the running item is updated in place by its later outcome, which arrives as a
			// NEW item (a new sequence number) so the same cursor delivers it.
			const items = [...held];
			for (const item of t.items) {
				if (item.seq <= last && !reset) continue;
				const at =
					item.kind === "tool" ? items.findIndex((x) => x.kind === "tool" && x.callId === item.callId) : -1;
				if (item.kind === "tool" && at >= 0) {
					const existing = items[at] as typeof item;
					items[at] = { ...existing, status: item.status };
				} else items.push(item);
			}
			// The cursor is what was RECEIVED: when more pages follow, it is the last item of this one, not the broker's highest number,
			// so a later page that fails is read again and nothing is skipped.
			const cursor = t.more ? (t.items.at(-1)?.seq ?? state.watermark) : t.watermark;
			return {
				...state,
				items: items.slice(-MAX_ITEMS),
				watermark: Math.max(reset ? 0 : state.watermark, cursor),
				evicted: t.evicted,
				problem: null,
			};
		}
		case "grant":
			return { ...state, grant: reply.record.grant, problem: null };
		case "command":
			return { ...state, command: reply.record, problem: null };
		case "failure": {
			// 401 on a grant-gated route: the page is not (or no longer) paired. Say so; do not keep a grant the broker refused.
			const unpaired = reply.status === 401 && reply.code === "grant-required";
			return {
				...state,
				grant: unpaired ? null : state.grant,
				problem: reply.message,
				unreachable: reply.status === 0 && reply.code === "",
			};
		}
	}
}

/** One line for the run strip, from what the broker reported and nothing more. */
export function runStripWords(status: WorkbenchStatus | null, unreachable: boolean): string {
	if (status === null) return unreachable ? "connection unknown: the broker did not answer" : "not read yet";
	if (unreachable) return `connection unknown: the broker did not answer (last reported: ${describe(status)})`;
	return describe(status);
}
function describe(status: WorkbenchStatus): string {
	if (status.connection === "disconnected") return "disconnected: no admitted connection now";
	return status.run === "active" ? "connected · run active" : status.run === "idle" ? "connected · idle" : "connected";
}

export const COMMAND_WORDS: Readonly<Record<string, string>> = {
	"awaiting-approval": "Waiting for you to approve it in the attached terminal",
	dispatching: "Approved. Sending to the runtime",
	accepted: "Accepted by the runtime",
	unknown:
		"Sent, but the runtime's reply was not seen. It may have started: check the conversation before sending another",
	refused: "Not sent",
};
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
	"not-authorized": "it was withdrawn or the page was no longer paired",
	"authorization-denied": "it was declined in the terminal",
	"approval-timed-out": "no approval was typed in time",
	"authorization-expired": "the approval window had passed",
	"session-ended": "the session had ended",
	"run-active": "a run had opened meanwhile",
	"capability-unavailable": "the runtime does not offer it",
	duplicate: "it duplicated another prompt",
	"runtime-refused": "the runtime did not accept it",
};
