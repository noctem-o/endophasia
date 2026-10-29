// The workbench's reads and commands, one at a time. A read happens when DEVELOP is first opened, when the operator asks (Refresh, pair,
// send, withdraw), and, only while a prompt is waiting or the operator has switched Follow on, every few seconds from one timer that is
// set after each read ends (never two at once, never while the page is hidden, never by hover). It reads the broker's memory, not the
// store. A grant is held in this hook's state only.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { fetchWorkbench } from "./api.ts";
import { commandOpen, initialWorkbench, reduceWorkbench } from "./model/workbench.ts";
import type { WorkbenchReply, WorkbenchRequest } from "./model/workbench-wire.ts";

const FOLLOW_MS = 3000;
const WAITING_MS = 1500;
const MAX_PAGES = 5;

export function useWorkbench(active: boolean) {
	const [state, dispatch] = useReducer(reduceWorkbench, undefined, initialWorkbench);
	const latest = useRef(state);
	latest.current = state;
	const running = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const entered = useRef(false);
	const reading = useRef<(() => Promise<void>) | null>(null);

	const send = useCallback(async (request: WorkbenchRequest): Promise<WorkbenchReply> => {
		const abort = controller.current ?? new AbortController();
		controller.current = abort;
		const reply = await fetchWorkbench(request, latest.current.grant, abort.signal);
		if (!abort.signal.aborted) dispatch({ type: "reply", reply, at: new Date() });
		return reply;
	}, []);

	const schedule = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
		const s = latest.current;
		if (s.availability !== "available" || document.hidden) return;
		if (!s.follow && !commandOpen(s.command)) return;
		timer.current = setTimeout(() => void reading.current?.(), s.follow ? FOLLOW_MS : WAITING_MS);
	}, []);

	const read = useCallback(async (): Promise<void> => {
		if (running.current) return;
		running.current = true;
		dispatch({ type: "started" });
		try {
			const status = await send({ kind: "status" });
			if (status.kind === "status" && status.record.paired && latest.current.grant !== null) {
				let after = status.record.launchId === latest.current.launchId ? latest.current.watermark : 0;
				for (let page = 0; page < MAX_PAGES; page += 1) {
					const reply = await send({ kind: "transcript", after });
					if (reply.kind !== "transcript" || !reply.record.more || reply.record.items.length === 0) break;
					after = reply.record.items.at(-1)?.seq ?? after;
				}
			}
		} finally {
			running.current = false;
			dispatch({ type: "finished" });
			// State from this read is applied before the timer decides.
			queueMicrotask(schedule);
		}
	}, [send, schedule]);
	reading.current = read;

	useEffect(() => {
		if (active && !entered.current) {
			entered.current = true;
			void read();
		}
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
				(latest.current.follow || commandOpen(latest.current.command))
			)
				void read();
		};
		document.addEventListener("visibilitychange", visible);
		return () => document.removeEventListener("visibilitychange", visible);
	}, [active, read]);

	return {
		state,
		dispatch,
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
