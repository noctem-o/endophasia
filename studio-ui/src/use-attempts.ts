// The selected task's work attempts, read-only. A read follows each good read of the workspace (the first one, the operator's Refresh, a
// change they made), so the attempts are as fresh as the tasks beside them and never fresher by a timer: nothing polls. The grant is the
// workbench hook's and is never stored. Nothing here can prepare or record an attempt, or send a brief anywhere: the only request is one GET
// with no body and no query. What to read when, and which answers still count, is decided by `AttemptsReader` (model/attempts-reader.ts):
// a read whose launch or pairing has changed is obsolete, and a refresh asked for during a read is never lost to it.
import { useEffect, useRef, useState } from "react";
import { fetchAttempts } from "./api.ts";
import { AttemptsReader, type AttemptsState, INITIAL_ATTEMPTS } from "./model/attempts-reader.ts";

export type { AttemptsState } from "./model/attempts-reader.ts";

export function useAttempts(
	grant: string | null,
	launchId: string | null,
	active: boolean,
	ready: boolean,
	trigger: number | null,
): AttemptsState {
	const [state, setState] = useState<AttemptsState>(INITIAL_ATTEMPTS);
	const reader = useRef<AttemptsReader | null>(null);
	reader.current ??= new AttemptsReader(fetchAttempts, setState);
	useEffect(() => {
		reader.current?.sync({ grant, launchId, active, ready, trigger });
	}, [grant, launchId, active, ready, trigger]);
	useEffect(
		() => () => {
			reader.current?.dispose();
		},
		[],
	);
	return state;
}
