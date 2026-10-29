// The workbench's reads and commands, one at a time. A read happens when DEVELOP is first opened, when the operator asks (Refresh, pair,
// send, withdraw), and, only while a prompt or an intervention is open (waiting, being sent, or waiting for Pi) or the operator has switched Follow on, every few seconds from one timer that is
// set after each read ends (never two at once, never while the page is hidden, never by hover). It reads the broker's memory, not the
// store. A grant is held in this hook's state only.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchWorkbench } from "./api.ts";
import { anyOpen, initialWorkbench, reduceWorkbench } from "./model/workbench.ts";
import type { InterventionOperation, WorkbenchReply, WorkbenchRequest } from "./model/workbench-wire.ts";

const FOLLOW_MS = 3000;
const WAITING_MS = 1500;
const MAX_PAGES = 5;

export function useWorkbench(active: boolean) {
	const [state, dispatch] = useReducer(reduceWorkbench, undefined, initialWorkbench);
	const latest = useRef(state);
	latest.current = state;
	// Whether DEVELOP is shown NOW: a read that was already running when the operator left must not re-arm the timer when it ends.
	const shown = useRef(active);
	shown.current = active;
	const running = useRef(false);
	// A read asked for while another is running: its answer may predate what the asker just did (a proposal made meanwhile), so one fresh read
	// follows the running one rather than being dropped.
	const again = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The unsent prompt lives here, not in the composer: the composer is unmounted when the stage or the layout changes. Memory only.
	const [draft, setDraft] = useState("");
	// What the operator is composing: a new prompt, or a change to the run that is open. Chosen by the operator and never switched for them.
	const [mode, setMode] = useState<"prompt" | "steer" | "queue">("prompt");
	// The text THIS page sent as a steer or queue, by request, so its card can show it. Memory only; the broker's view never carries text.
	const [sentText, setSentText] = useState<Readonly<Record<string, string>>>({});
	// It is private live text, so it goes when the session ends or the launch changes, and with the cards the broker no longer lists.
	const ended = state.status?.connection === "disconnected";
	const listed = state.interventions.map((i) => i.proposalId).join();
	useEffect(() => {
		setSentText((now) => {
			const keep = Object.keys(now).filter((id) => !ended && listed.split(",").includes(id));
			return keep.length === Object.keys(now).length
				? now
				: Object.fromEntries(keep.map((id) => [id, now[id] as string]));
		});
	}, [ended, listed]);
	const reading = useRef<(() => Promise<void>) | null>(null);

	// Bumped when a grant is issued. A read that began before it carries an older status (paired: false) that must not be applied over the
	// new grant, which no later status can bring back: the broker never repeats the token.
	const epoch = useRef(0);

	const send = useCallback(async (request: WorkbenchRequest, since?: number): Promise<WorkbenchReply> => {
		const abort = controller.current ?? new AbortController();
		controller.current = abort;
		const reply = await fetchWorkbench(request, latest.current.grant, abort.signal);
		if (reply.kind === "grant") epoch.current += 1;
		if (!abort.signal.aborted && (since === undefined || since === epoch.current))
			dispatch({ type: "reply", reply, at: new Date() });
		return reply;
	}, []);

	const schedule = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
		const s = latest.current;
		if (!shown.current || s.availability !== "available" || document.hidden) return;
		if (!s.follow && !anyOpen(s)) return;
		timer.current = setTimeout(
			() => {
				if (shown.current) void reading.current?.();
			},
			s.follow ? FOLLOW_MS : WAITING_MS,
		);
	}, []);

	const read = useCallback(async (): Promise<void> => {
		if (running.current) {
			again.current = true;
			return;
		}
		running.current = true;
		again.current = false;
		const since = epoch.current;
		dispatch({ type: "started" });
		try {
			const status = await send({ kind: "status" }, since);
			if (status.kind === "status" && status.record.paired && latest.current.grant !== null) {
				let after = status.record.launchId === latest.current.launchId ? latest.current.watermark : 0;
				for (let page = 0; page < MAX_PAGES; page += 1) {
					const reply = await send({ kind: "transcript", after }, since);
					if (reply.kind !== "transcript" || !reply.record.more || reply.record.items.length === 0) break;
					after = reply.record.items.at(-1)?.seq ?? after;
				}
			}
		} finally {
			running.current = false;
			dispatch({ type: "finished" });
			// State from this read is applied before the timer decides.
			if (again.current && shown.current) queueMicrotask(() => void reading.current?.());
			else queueMicrotask(schedule);
		}
	}, [send, schedule]);
	reading.current = read;

	useEffect(() => {
		// On entering DEVELOP, and on coming back to it after a visit elsewhere (the timer was cleared when it was left), read once now: this
		// also discovers a workbench whose first status failed, and resumes Follow or a waiting prompt's check. Nothing keeps polling while
		// the workspace is not shown, and a server known to have no workbench is not asked again.
		if (active && latest.current.availability !== "absent") void read();
		if (!active) {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
		}
	}, [active, read]);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
			controller.current?.abort();
		},
		[],
	);
	// A page that is hidden reads nothing; coming back reads once and resumes.
	useEffect(() => {
		const visible = () => {
			if (
				!document.hidden &&
				active &&
				latest.current.availability === "available" &&
				(latest.current.follow || anyOpen(latest.current))
			)
				void read();
		};
		document.addEventListener("visibilitychange", visible);
		return () => document.removeEventListener("visibilitychange", visible);
	}, [active, read]);

	return {
		state,
		dispatch,
		draft,
		setDraft,
		mode,
		setMode,
		sentText,
		refresh: () => void read(),
		pair: async (code: string) => {
			const reply = await send({ kind: "pair", code });
			// A refused code stays on screen as refused: a read would replace the message with a fresh status.
			if (reply.kind === "grant") void read();
		},
		propose: async (message: string) => {
			const reply = await send({ kind: "propose", message });
			if (reply.kind === "command") void read();
			return reply;
		},
		intervene: async (operation: InterventionOperation, message: string | null) => {
			const reply = await send({ kind: "intervene", operation, message });
			if (reply.kind === "intervention") {
				if (message !== null) setSentText((now) => ({ ...now, [reply.record.proposalId]: message }));
				void read();
			}
			return reply;
		},
		withdraw: async (proposalId: string) => {
			await send({ kind: "withdraw", proposalId });
			void read();
		},
		check: async (proposalId: string) => {
			await send({ kind: "check", proposalId });
		},
		discard: async () => {
			const open = latest.current.command;
			if (open !== null && open.state === "awaiting-approval") {
				await send({ kind: "discard", proposalId: open.proposalId });
				void read();
			}
		},
		setFollow: (on: boolean) => {
			dispatch({ type: "follow", on });
			latest.current = { ...latest.current, follow: on };
			if (on) void read();
			else schedule();
		},
		setView: (view: "live" | "recorded") => dispatch({ type: "view", view }),
		unpair: () => dispatch({ type: "unpair" }),
	};
}
