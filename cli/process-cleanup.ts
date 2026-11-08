// LIVE-PROCESS-CONTAINMENT-001 (docs/live-process-containment.md): what the operator is told about the processes a live harness session
// started. A harness's exit is never reported as its cleanup: only a scope the user manager stopped, with an empty cgroup, is.

import type { ProcessCleanupV0 } from "../adapters/rpc-jsonl/process-group.ts";
import {
	detectContainmentV0,
	type EndoContainmentV0,
	liveScopesV0,
	scopeProcessesV0,
} from "../adapters/sandbox/containment.ts";

export interface EndoLiveContainmentV0 {
	/** The containment to run the session's harness in, or null when this host cannot contain it. */
	readonly containment: EndoContainmentV0 | null;
	/** Why it cannot, when it cannot. */
	readonly unavailable: string | null;
	/** What to tell the operator before the session starts. */
	readonly notes: readonly string[];
}

/**
 * Detect containment for a live session, and find live scopes an earlier session left (its owner and keeper both gone). Those are
 * reported with the command that ends them, never stopped here: this session did not start them.
 */
export async function liveContainmentV0(
	detect: typeof detectContainmentV0 = detectContainmentV0,
): Promise<EndoLiveContainmentV0> {
	const detected = await detect();
	if (!detected.ok)
		return {
			containment: null,
			unavailable: detected.detail,
			notes: [
				`note: Pi's processes are not contained here (${detected.detail}). A process Pi starts outside its own process group (its bash tool does) cannot be found when the session ends, so cleanup will be reported as unverified.`,
			],
		};
	const notes: string[] = [];
	for (const scope of liveScopesV0(detected.containment)) {
		if (scope.ownerAlive) continue;
		const count = scopeProcessesV0(detected.containment, scope.unit)?.length ?? null;
		notes.push(
			`warning: an earlier live session left scope ${scope.unit} running${count === null ? "" : ` with ${count} process${count === 1 ? "" : "es"}`}; its owner${scope.owner === null ? "" : ` (pid ${scope.owner.pid})`} is gone. \`systemctl --user stop ${scope.unit}.scope\` ends ${count === 1 ? "it" : "them"}.`,
		);
	}
	return { containment: detected.containment, unavailable: null, notes };
}

/** One line per Pi process the session started: how its cleanup ended. Only `confirmed` says that nothing it started still runs. */
export function describeProcessCleanupV0(cleanups: readonly ProcessCleanupV0[]): string[] {
	return cleanups.map((cleanup, index) => {
		const which = cleanups.length === 1 ? "Pi" : `Pi (process ${index + 1} of ${cleanups.length})`;
		if (cleanup.boundary === "scope" && cleanup.result === "confirmed")
			return `harness: ${which} and every process it started have ended (scope ${cleanup.unit} stopped; its cgroup is empty).`;
		if (cleanup.boundary === "scope")
			return `harness: CLEANUP INCOMPLETE: scope ${cleanup.unit} was not confirmed empty${cleanup.remaining === null ? "" : ` (${cleanup.remaining} process${cleanup.remaining === 1 ? "" : "es"} left)`}. \`systemctl --user stop ${cleanup.unit}.scope\` ends what is left; \`systemd-cgls --user-unit ${cleanup.unit}.scope\` lists it.`;
		if (cleanup.result === "incomplete")
			return `harness: CLEANUP INCOMPLETE: a process in ${which}'s process group was still running when the session released it.`;
		return `harness: ${which} has exited; whether every process it started has ended is UNVERIFIED (not contained): one started outside its process group may still be running.`;
	});
}
