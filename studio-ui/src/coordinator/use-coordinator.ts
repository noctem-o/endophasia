import { useLayoutEffect, useRef, useState } from "react";
import { fetchCoordinator } from "../api.ts";
import type { CoordinatorReply } from "./read.ts";

export function useCoordinator(grant: string | null, launchId: string | null, onGrantRequired: () => void) {
	const [refreshes, setRefreshes] = useState(0);
	const [read, setRead] = useState<{
		grant: string;
		launchId: string;
		refreshes: number;
		reply: CoordinatorReply;
	} | null>(null);
	const refuse = useRef(onGrantRequired);
	refuse.current = onGrantRequired;

	useLayoutEffect(() => {
		setRead(null);
		if (grant === null || launchId === null) return;
		const abort = new AbortController();
		queueMicrotask(async () => {
			if (abort.signal.aborted) return;
			const reply = await fetchCoordinator(grant, abort.signal);
			if (abort.signal.aborted) return;
			setRead({ grant, launchId, refreshes, reply });
			if (reply.kind === "failure" && reply.problem === "grant-required") refuse.current();
		});
		return () => abort.abort();
	}, [grant, launchId, refreshes]);

	const reply =
		read?.grant === grant && read.launchId === launchId && read.refreshes === refreshes ? read.reply : null;
	const busy = grant !== null && launchId !== null && reply === null;
	return {
		reply,
		busy,
		refresh: () => {
			if (grant !== null && launchId !== null && !busy) setRefreshes((value) => value + 1);
		},
	};
}
