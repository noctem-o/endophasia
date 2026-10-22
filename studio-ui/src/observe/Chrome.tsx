// The read status and the banner for a read that did not produce a snapshot. Plain sentences, each saying what happened and what is
// still on screen; the browser's clock is always named as the browser's, apart from any recorded time.
import type { ReactElement } from "react";
import { duration, shownVersion } from "../model/contract.ts";
import type { AppState, Problem } from "../model/state.ts";
import { Note } from "../ui/text.tsx";

const clock = (date: Date): string => date.toLocaleTimeString("en-GB");

const DECLARED = {
	schema: "the schema version",
	projection: "the projection version",
	consistency: "the consistency mode",
} as const;

export function readStatusText(state: AppState): string {
	if (state.busy)
		return state.loaded === null ? "Reading the stores…" : "Reading the stores… the previous read stays on screen";
	if (state.loaded === null) return state.problem === null ? "Nothing read yet" : "No read has succeeded";
	const read = `Read ${clock(state.loaded.fetchedAt)} by this browser's clock · ${duration(state.loaded.durationMs)}`;
	return state.problem === null ? read : `${read} · the latest attempt failed, so this is not current`;
}

export function problemText(problem: Problem): string {
	const reply = problem.reply;
	switch (reply.kind) {
		case "paced":
			return `The server is pacing reads, because each one re-reads the whole history and the machine may be busy with your sessions. ${
				problem.retryAt === null
					? "It gave no time; try again in a little while."
					: `Reading is available again at ${clock(problem.retryAt)} (the server asked for ${reply.retryAfterSeconds} s).`
			}`;
		case "unreachable":
			return reply.reason === "timeout"
				? "The read took longer than 60 s and was abandoned. The server may be busy reading a very long history."
				: "The Studio server did not answer. It may have stopped. Its address changes on every launch, so open the one the launcher printed last.";
		case "refused":
			return reply.status === 404
				? "The server does not recognize this address. The access address is different on each launch: open the one the launcher printed last."
				: `The server refused the request (status ${reply.status}${reply.code === null ? "" : `, ${reply.code}`}).`;
		case "server-error":
			return `The server reported an internal error (status ${reply.status}). Nothing was read.`;
		case "unsupported":
			return `This page cannot read the response: its ${reply.record} declares ${DECLARED[reply.what]} “${shownVersion(reply.declared)}”, and this build reads “${reply.expected}” there. Nothing from it is shown.`;
		case "malformed":
			return `The response did not have the shape this page reads (${reply.reason}). Nothing from it is shown.`;
	}
}

export function Banner({ state }: { state: AppState }): ReactElement {
	const problem = state.problem;
	if (problem === null) return <div id="banner" />;
	const stale =
		state.loaded === null ? "" : ` The read of ${clock(state.loaded.fetchedAt)} is still shown and is not current.`;
	return (
		<div id="banner">
			<Note tone={problem.reply.kind === "paced" ? "warn" : "error"} testid="problem">
				{`${problemText(problem)}${stale}`}
			</Note>
		</div>
	);
}
