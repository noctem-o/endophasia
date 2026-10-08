/**
 * The next commands of the installed Pi loop, printed on stderr after `endo harness attach` so the operator need not read
 * JSON to find them. Nothing here is invented: a session id appears only when Pi reported one, and a prompt's outcome
 * is worded as what was observed (accepted, then settled or not), never as success.
 */

/** Quote one word for a POSIX shell, only when it needs it. */
export function shellWordV0(text: string): string {
	return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export const ENDO_PROMPT_COST_NOTICE_V0 =
	"a prompted agent session can call the model provider Pi is configured with, and may incur cost";

export function attachSummaryV0(input: {
	root: string;
	attachment: string | undefined;
	piSessionId: string | null;
	prompt: { disposition: string; settled: boolean | null } | null;
	waitMs: number;
}): string[] {
	const root = shellWordV0(input.root);
	const attachment = input.attachment === undefined ? "" : ` --attachment ${shellWordV0(input.attachment)}`;
	const lines: string[] = [];
	if (input.prompt === null)
		lines.push("no prompt was sent; the session was opened and closed (observed lifecycle only)");
	else {
		const { disposition, settled } = input.prompt;
		lines.push(
			disposition === "started"
				? "Pi accepted the prompt (acceptance is not completion)"
				: `Pi answered the prompt with disposition "${disposition}"`,
		);
		if (settled === true) lines.push("Pi reported the run settled");
		else if (settled === false)
			lines.push(
				`the run was not seen to settle within ${input.waitMs} ms; it may still have been running when the session closed`,
			);
	}
	lines.push(
		input.piSessionId === null
			? "Pi reported no session id, so there is no trajectory to name"
			: `Pi session id: ${input.piSessionId}`,
	);
	lines.push("inspect the durable records (read-only):");
	lines.push(`  endo harness status --root ${root}${attachment}`);
	lines.push(`  endo harness overview --root ${root}${attachment}`);
	if (input.piSessionId !== null)
		lines.push(`  endo trajectory show --root ${root} ${shellWordV0(input.piSessionId)}${attachment}`);
	return lines;
}
