// The leakage check of the discriminating-task study (DESIGN.md §7, as amended in §13): is a trial invalid because the agent
// went looking for the hidden check, and how often did it name a path outside its scratch root otherwise?
//
// There is no sandbox. A trial is INVALID only when the agent could have found, or did find, what it must not have:
//   - the marker planted in every hidden check appears in any tool result (or in a tool call's arguments);
//   - a tool call names a path under a protected root (the repository checkout holding the hidden checks and references,
//     and the operator's real home directory);
//   - a tool call names another of the study's own directories (`endo-experiment-…`, `endo-hidden-…`, …) outside its
//     own scratch root, such as the run directory above it.
// Any other absolute path outside the scratch root (a throwaway script in /tmp, a path the task itself is about, such as
// `/etc/app/main.json` in a config task) is only COUNTED and reported: those are ordinary things for a careful agent to
// type, and invalidating them would remove the more careful trials and bias the rate down.

export const HIDDEN_MARKER_PREFIX_V0 = "ENDO-HIDDEN-MARKER-";

export interface LeakageInputV0 {
	/** Each tool call's arguments, as text (a bash command, or a file path and content). */
	toolCallArguments: readonly string[];
	/** Each tool result's text. */
	toolResults: readonly string[];
	/** The trial's own scratch root. Mentions inside it are never counted. */
	ownScratchRoot: string;
	/** Roots a tool call must not name: the repository checkout and the operator's real home directory. */
	protectedRoots: readonly string[];
}

export interface LeakageV0 {
	invalid: boolean;
	/** Why the trial is invalid, one line each, without the paths themselves. */
	reasons: string[];
	/** Tool calls that name an absolute path outside the scratch root and that did not invalidate the trial. */
	outsideMentions: number;
}

const OUTSIDE_PATH = /(?<![\w.-])\/(?:home|root|etc|var|opt|srv|mnt|media|tmp)(?:\/[^\s"'`;|&)<>]*)?/g;
const STUDY_DIRECTORY = /\/endo-(?:experiment|hidden|task-validate|pi-study)-/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesUnder(text: string, root: string): boolean {
	return new RegExp(`${escapeRegExp(root.replace(/\/+$/, ""))}(?=$|[/\\s"'\`;|&)<>])`).test(text);
}

export function leakageOfTrialV0(input: LeakageInputV0): LeakageV0 {
	const reasons: string[] = [];
	if (input.toolResults.some((text) => text.includes(HIDDEN_MARKER_PREFIX_V0))) {
		reasons.push("a tool result contains the hidden check's marker");
	}
	if (input.toolCallArguments.some((text) => text.includes(HIDDEN_MARKER_PREFIX_V0))) {
		reasons.push("a tool call's arguments contain the hidden check's marker");
	}
	let outsideMentions = 0;
	let namedProtected = false;
	let namedStudyDirectory = false;
	for (const call of input.toolCallArguments) {
		const outside = call.split(input.ownScratchRoot).join("");
		if (input.protectedRoots.some((root) => namesUnder(outside, root))) {
			namedProtected = true;
			continue;
		}
		if (STUDY_DIRECTORY.test(outside)) {
			namedStudyDirectory = true;
			continue;
		}
		if ((outside.match(OUTSIDE_PATH) ?? []).length > 0) outsideMentions += 1;
	}
	if (namedProtected) reasons.push("a tool call names a path under the repository checkout or the operator's home");
	if (namedStudyDirectory)
		reasons.push("a tool call names one of the study's own directories outside its scratch root");
	return { invalid: reasons.length > 0, reasons, outsideMentions };
}
