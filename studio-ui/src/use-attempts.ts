// The selected task's work attempts, read-only. A read follows each good read of the workspace (the first one, the operator's Refresh, a
// change they made), so the attempts are as fresh as the tasks beside them and never fresher by a timer: nothing polls. One read at a time;
// a read asked for while one runs is run once after it. The grant is the workbench hook's and is never stored. Nothing here can prepare or
// record an attempt, or send a brief anywhere: the only request is one GET with no body and no query.
import { useEffect, useRef, useState } from "react";
import { fetchAttempts } from "./api.ts";
import type { AttemptsView } from "./model/attempts-wire.ts";

export interface AttemptsState {
	/** The last good read, kept through failures and marked by `current`. Null until one arrived (or after a different launch). */
	view: AttemptsView | null;
	current: boolean;
	busy: boolean;
	/** Why the last read did not replace the view. `absent`: this workbench serves no attempts. */
	problem: "absent" | "unpaired" | "invalid" | "unreachable" | "refused" | null;
}

const INITIAL: AttemptsState = { view: null, current: false, busy: false, problem: null };

/**
 * `trigger` changes on every good workspace read (its time); `ready` says the workspace is one this page can show tasks of. Reads happen
 * only while `active` (the DEVELOP workspace is shown) and a grant is held.
 */
export function useAttempts(
	grant: string | null,
	launchId: string | null,
	active: boolean,
	ready: boolean,
	trigger: number | null,
): AttemptsState {
	const [state, setState] = useState<AttemptsState>(INITIAL);
	const running = useRef(false);
	const again = useRef(false);
	const held = useRef(grant);
	held.current = grant;
	const controller = useRef<AbortController | null>(null);
	const launch = useRef<string | null>(null);

	useEffect(() => {
		// A different launch is a different workspace: nothing carries over.
		if (launchId !== null && launch.current !== null && launch.current !== launchId) setState(INITIAL);
		if (launchId !== null) launch.current = launchId;
	}, [launchId]);

	useEffect(() => {
		if (grant === null) setState((s) => (s.view === null ? s : { ...s, current: false, problem: "unpaired" }));
	}, [grant]);

	useEffect(() => {
		if (!active || !ready || trigger === null || grant === null) return;
		const read = async (): Promise<void> => {
			if (running.current) {
				again.current = true;
				return;
			}
			const g = held.current;
			if (g === null) return;
			running.current = true;
			setState((s) => ({ ...s, busy: true }));
			controller.current ??= new AbortController();
			try {
				const reply = await fetchAttempts(g, controller.current.signal);
				setState((s) =>
					reply.kind === "attempts"
						? { view: reply.record, current: true, busy: false, problem: null }
						: {
								...s,
								busy: false,
								current: false,
								problem:
									reply.kind === "absent"
										? "absent"
										: reply.code === "invalid"
											? "invalid"
											: reply.code === "unreachable"
												? "unreachable"
												: "refused",
							},
				);
			} finally {
				running.current = false;
			}
			if (again.current) {
				again.current = false;
				void read();
			}
		};
		void read();
	}, [active, ready, trigger, grant]);

	useEffect(
		() => () => {
			controller.current?.abort();
		},
		[],
	);

	return state;
}
