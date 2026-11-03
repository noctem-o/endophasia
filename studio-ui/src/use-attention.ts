// The attention projection of this launch's project (docs/designs/develop-attention.md), read-only. Read exactly when the attempts are: after
// each good read of the workspace (the first one, the operator's Refresh, a change they made), never by a timer, so nothing polls and no Git
// is read in the background. The grant is the workbench hook's and is never stored. The only request is one GET with no body and no query.
// Which answers still count is decided by the same reader as the attempts' (model/attempts-reader.ts): a read whose launch or pairing has
// changed is obsolete, and its answer changes nothing.
import { useEffect, useRef, useState } from "react";
import { fetchAttention } from "./api.ts";
import { LaunchReader, type LaunchReadState } from "./model/attempts-reader.ts";
import type { AttentionView } from "./model/attention-wire.ts";

export type AttentionState = LaunchReadState<AttentionView>;
const INITIAL: AttentionState = { view: null, current: false, busy: false, problem: null };

export function useAttention(
	grant: string | null,
	launchId: string | null,
	active: boolean,
	ready: boolean,
	trigger: number | null,
): AttentionState {
	const [state, setState] = useState<AttentionState>(INITIAL);
	const reader = useRef<LaunchReader<AttentionView> | null>(null);
	reader.current ??= new LaunchReader<AttentionView>(fetchAttention, setState);
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
