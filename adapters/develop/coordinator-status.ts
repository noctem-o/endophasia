import { ENDO_COORDINATOR_LIMITS_V0 } from "../../protocol/coordinator-status.ts";
import {
	type ReadEndoCoordinatorStatusOptionsV0,
	readEndoCoordinatorStatusV0 as readStatus,
} from "../../storage/coordinator-status.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";

export type { ReadEndoCoordinatorStatusOptionsV0 };

export function readEndoCoordinatorStatusV0(options: ReadEndoCoordinatorStatusOptionsV0) {
	return readStatus({
		...options,
		current:
			options.current ??
			(async (directory) => {
				const seen = await new GitRevisionObserverV0().observe(directory, { within: true });
				if (!seen.ok) return null;
				const { worktree, commonDir, commit, dirty } = seen.observation;
				return { worktree, commonDir, commit, clean: dirty.length === 0 };
			}),
	});
}

export function endoCoordinatorStaleAfterV0(seconds: string): number {
	if (!/^[1-9][0-9]*$/.test(seconds)) throw new TypeError("--stale-after takes a whole number of seconds");
	const ms = Number(seconds) * 1000;
	if (ms < ENDO_COORDINATOR_LIMITS_V0.minStaleAfterMs || ms > ENDO_COORDINATOR_LIMITS_V0.maxStaleAfterMs)
		throw new TypeError("--stale-after must be between 1 second and 7 days");
	return ms;
}
