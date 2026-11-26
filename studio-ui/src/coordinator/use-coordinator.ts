import { useLayoutEffect, useRef, useState } from "react";
import { fetchCoordinator, fetchCoordinatorCoordination } from "../api.ts";
import type { CoordinatorCoordinationReply, CoordinatorReply } from "./read.ts";

export function useCoordinator(grant: string | null, launchId: string | null, onGrantRequired: () => void) {
	const [refreshes, setRefreshes] = useState(0);
	const [read, setRead] = useState<{
		grant: string;
		launchId: string;
		refreshes: number;
		reply: CoordinatorReply;
		coordinationReply: CoordinatorCoordinationReply;
	} | null>(null);
	const refuse = useRef(onGrantRequired);
	refuse.current = onGrantRequired;

	useLayoutEffect(() => {
		setRead(null);
		if (grant === null || launchId === null) return;
		const abort = new AbortController();
		queueMicrotask(async () => {
			if (abort.signal.aborted) return;
			const [reply, coordinationReply] = await Promise.all([
				fetchCoordinator(grant, abort.signal),
				fetchCoordinatorCoordination(grant, abort.signal),
			]);
			if (abort.signal.aborted) return;
			setRead({ grant, launchId, refreshes, reply, coordinationReply });
			if (
				(reply.kind === "failure" && reply.problem === "grant-required") ||
				(coordinationReply.kind === "failure" && coordinationReply.problem === "grant-required")
			)
				refuse.current();
		});
		return () => abort.abort();
	}, [grant, launchId, refreshes]);

	const current = read?.grant === grant && read.launchId === launchId && read.refreshes === refreshes ? read : null;
	const reply = current?.reply ?? null;
	const coordinationReply = current?.coordinationReply ?? null;
	const busy = grant !== null && launchId !== null && reply === null;
	return {
		reply,
		coordinationReply,
		busy,
		refresh: () => {
			if (grant !== null && launchId !== null && !busy) setRefreshes((value) => value + 1);
		},
	};
}
