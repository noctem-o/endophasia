// Bounded read-only Coordinator fetch hook (`COORDINATOR-STUDIO-F1-002` B7).
//
// Discipline:
// - Single in-flight read bundle (status + coordination + operations); overlapping reads are never issued.
// - Obsolete responses from prior grants, launches, or cancelled refreshes are aborted and discarded.
// - Optional auto-refresh is OFF by default, uses ONE bounded setTimeout (30 s) scheduled only AFTER a read completes,
//   pauses while `document.hidden`, and stops immediately on grant loss, forbidden scope, or unmount.
// - Never uses setInterval, WebSockets, SSE, or local storage; never triggers model inference or schedule ticks.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchCoordinator, fetchCoordinatorCoordination, fetchCoordinatorOperations } from "../api.ts";
import type { CoordinatorCoordinationReply, CoordinatorOperationsReply, CoordinatorReply } from "./read.ts";

export const COORDINATOR_AUTO_REFRESH_MS = 30_000;

export function useCoordinator(grant: string | null, launchId: string | null, onGrantRequired: () => void) {
	const [refreshes, setRefreshes] = useState(0);
	const [autoRefresh, setAutoRefresh] = useState(false);
	const [read, setRead] = useState<{
		grant: string;
		launchId: string;
		refreshes: number;
		reply: CoordinatorReply;
		coordinationReply: CoordinatorCoordinationReply;
		operationsReply: CoordinatorOperationsReply;
	} | null>(null);
	const [lastSuccessAtMs, setLastSuccessAtMs] = useState<number | null>(null);
	const prevSession = useRef<{ grant: string | null; launchId: string | null }>({ grant, launchId });
	const refuse = useRef(onGrantRequired);
	refuse.current = onGrantRequired;
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useLayoutEffect(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		const sessionChanged = prevSession.current.grant !== grant || prevSession.current.launchId !== launchId;
		prevSession.current = { grant, launchId };
		setRead(null);
		if (sessionChanged) {
			setAutoRefresh(false);
			setLastSuccessAtMs(null);
		}
		if (grant === null || launchId === null) {
			return;
		}
		const abort = new AbortController();
		queueMicrotask(async () => {
			if (abort.signal.aborted) return;
			const [reply, coordinationReply, operationsReply] = await Promise.all([
				fetchCoordinator(grant, abort.signal),
				fetchCoordinatorCoordination(grant, abort.signal),
				fetchCoordinatorOperations(grant, abort.signal),
			]);
			if (abort.signal.aborted) return;
			const grantLost =
				(reply.kind === "failure" && reply.problem === "grant-required") ||
				(coordinationReply.kind === "failure" && coordinationReply.problem === "grant-required") ||
				(operationsReply.kind === "failure" && operationsReply.problem === "grant-required");
			const forbiddenAny =
				(reply.kind === "failure" && reply.problem === "forbidden") ||
				(coordinationReply.kind === "failure" && coordinationReply.problem === "forbidden") ||
				(operationsReply.kind === "failure" && operationsReply.problem === "forbidden");
			if (grantLost) {
				setAutoRefresh(false);
				setLastSuccessAtMs(null);
				refuse.current();
				return;
			}
			setRead({ grant, launchId, refreshes, reply, coordinationReply, operationsReply });
			if (reply.kind === "status") {
				setLastSuccessAtMs(reply.status.readAtMs);
			}
			if (forbiddenAny) {
				setAutoRefresh(false);
			}
		});
		return () => abort.abort();
	}, [grant, launchId, refreshes]);

	const current = read?.grant === grant && read.launchId === launchId && read.refreshes === refreshes ? read : null;
	const reply = current?.reply ?? null;
	const coordinationReply = current?.coordinationReply ?? null;
	const operationsReply = current?.operationsReply ?? null;
	const busy = grant !== null && launchId !== null && reply === null;

	// Bounded optional auto-refresh: schedules ONE timeout strictly AFTER a completed read, only while enabled,
	// paired, healthy, and tab visible. Stops cleanly on visibility loss, grant loss, forbidden scope, or unmount (S7).
	useEffect(() => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		if (!autoRefresh || busy || grant === null || launchId === null || reply === null) return;
		const authBlocked = (r: { kind: string; problem?: string } | null) =>
			r !== null && r.kind === "failure" && (r.problem === "grant-required" || r.problem === "forbidden");
		if (authBlocked(reply) || authBlocked(coordinationReply) || authBlocked(operationsReply)) return;

		const arm = () => {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
			if (document.hidden) return;
			timer.current = setTimeout(() => {
				if (!document.hidden) setRefreshes((value) => value + 1);
			}, COORDINATOR_AUTO_REFRESH_MS);
		};
		arm();
		const onVisibility = () => {
			if (document.hidden) {
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
			} else {
				arm();
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		};
	}, [autoRefresh, busy, grant, launchId, reply, coordinationReply, operationsReply]);

	return {
		reply,
		coordinationReply,
		operationsReply,
		busy,
		lastSuccessAtMs,
		autoRefresh,
		toggleAutoRefresh: () => {
			if (grant !== null && launchId !== null) setAutoRefresh((v) => !v);
		},
		refresh: () => {
			if (grant !== null && launchId !== null && !busy) setRefreshes((value) => value + 1);
		},
	};
}
