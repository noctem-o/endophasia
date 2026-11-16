// What bounds the AGENT's effects, as the workbench broker is told it (research/develop-ux/DEVELOP-UX-002.md §5). This is not authority to
// send a message: a pairing, a phrase and a session grant decide who may ask the agent something; none of them limits what the agent then
// does. A session grant (runtime/contracts/session-control.ts) is issued and used only while a provider OBSERVES a boundary as enforced.
//
// A provider must report what it observed from inside the boundary, for the live runtime, never what its own arguments asked for. The
// broker treats `unknown`, a provider that throws and a malformed answer as not enforced: there is no default that enables anything.

/** `none`: no boundary. `workspace`: the agent's writes, reads of the home directory, privileged sockets, terminal and other processes are bounded to a workspace. `restricted`: also the network and the tools. */
export const ENDO_PROTECTION_LEVELS_V0 = ["none", "workspace", "restricted"] as const;
export type EndoProtectionLevelV0 = (typeof ENDO_PROTECTION_LEVELS_V0)[number];

export interface EndoExecutionProtectionStatusV0 {
	state: "enforced" | "not-enforced" | "unknown";
	level: EndoProtectionLevelV0;
	/** The mechanism's own versioned name (for example a sandbox profile), or null when there is none. */
	mechanism: string | null;
	/** The runtime session the boundary was observed around (`endo.session.…`), or null. A boundary around another session vouches for nothing. */
	session: string | null;
	/** The canonical path the boundary confines writes to, or null. */
	workspaceRoot: string | null;
	/** Why it is not enforced, or what it does not cover: fixed sentences for the operator, never text from a page or the agent. */
	limitations: readonly string[];
}

export interface EndoExecutionProtectionV0 {
	/** What is enforced NOW. Called at every use of a session grant: it must be cheap and must not block. */
	observe(): EndoExecutionProtectionStatusV0;
}

const rank = (level: EndoProtectionLevelV0): number => ENDO_PROTECTION_LEVELS_V0.indexOf(level);

/** Whether `have` is at least `need`. */
export const endoProtectionAtLeastV0 = (have: EndoProtectionLevelV0, need: EndoProtectionLevelV0): boolean =>
	rank(have) >= rank(need);

const NOT_OBSERVED: EndoExecutionProtectionStatusV0 = Object.freeze({
	state: "unknown",
	level: "none",
	mechanism: null,
	session: null,
	workspaceRoot: null,
	limitations: Object.freeze(["The execution boundary could not be observed, so it is treated as absent."]),
});

/**
 * Ask a provider, and accept only a well-formed answer: anything else (a throw, a missing member, an unknown level, `enforced` with no
 * mechanism, session or root) is `unknown`. The limitations are bounded so a provider cannot flood a status or a terminal.
 */
export function endoObserveProtectionV0(
	provider: EndoExecutionProtectionV0 | undefined,
): EndoExecutionProtectionStatusV0 {
	if (provider === undefined)
		return {
			...NOT_OBSERVED,
			state: "not-enforced",
			limitations: ["No execution boundary is configured for this launch."],
		};
	let seen: EndoExecutionProtectionStatusV0;
	try {
		seen = provider.observe();
	} catch {
		return NOT_OBSERVED;
	}
	if (
		typeof seen !== "object" ||
		seen === null ||
		(seen.state !== "enforced" && seen.state !== "not-enforced" && seen.state !== "unknown") ||
		!(ENDO_PROTECTION_LEVELS_V0 as readonly unknown[]).includes(seen.level) ||
		!Array.isArray(seen.limitations) ||
		!seen.limitations.every((line) => typeof line === "string")
	)
		return NOT_OBSERVED;
	const text = (value: unknown, max: number): string | null =>
		typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
	const status: EndoExecutionProtectionStatusV0 = {
		state: seen.state,
		level: seen.level,
		mechanism: text(seen.mechanism, 64),
		session: text(seen.session, 300),
		workspaceRoot: text(seen.workspaceRoot, 4096),
		limitations: seen.limitations.slice(0, 8).map((line) => line.slice(0, 300)),
	};
	// "Enforced" with nothing named is not an observation of anything.
	if (
		status.state === "enforced" &&
		(status.level === "none" || status.mechanism === null || status.session === null || status.workspaceRoot === null)
	)
		return NOT_OBSERVED;
	return status;
}

/**
 * Whether a boundary of at least `need` is observed as enforced around exactly this session and workspace. The one predicate the session
 * grant is issued and used under.
 */
export function endoProtectionHoldsV0(
	status: EndoExecutionProtectionStatusV0,
	need: EndoProtectionLevelV0,
	subject: { session: string; workspaceRoot: string },
): boolean {
	return (
		status.state === "enforced" &&
		need !== "none" &&
		endoProtectionAtLeastV0(status.level, need) &&
		status.session === subject.session &&
		status.workspaceRoot === subject.workspaceRoot
	);
}
