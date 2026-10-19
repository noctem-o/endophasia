// The top bar's read status and the banner for a read that did not produce a snapshot. Plain sentences, each saying what happened
// and what is still on screen; the browser's clock is always named as the browser's, apart from any recorded time.
import { show } from "./dom.ts";
import { SUPPORTED_PROJECTIONS } from "./labels.ts";
import { duration } from "./model.ts";
import { shownVersion } from "./reply.ts";
import { type AppState, controlsLocked, type Problem } from "./state.ts";
import { note } from "./widgets.ts";

const clock = (date: Date) => date.toLocaleTimeString("en-GB");

export function readStatusText(state: AppState): string {
	if (state.busy)
		return state.loaded === null ? "Reading the stores…" : "Reading the stores… the previous read stays on screen";
	if (state.loaded === null) return state.problem === null ? "Nothing read yet" : "No read has succeeded";
	const read = `Read ${clock(state.loaded.fetchedAt)} by this browser's clock · ${duration(state.loaded.durationMs)}`;
	return state.problem === null ? read : `${read} · the latest attempt failed, so this is not current`;
}

function problemText(problem: Problem): string {
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
				: "The cockpit server did not answer. It may have stopped. Its address changes on every launch, so open the one the launcher printed last.";
		case "refused":
			return reply.status === 404
				? "The server does not recognize this address. The access address is different on each launch: open the one the launcher printed last."
				: `The server refused the request (status ${reply.status}${reply.code === null ? "" : `, ${reply.code}`}).`;
		case "server-error":
			return `The server reported an internal error (status ${reply.status}). Nothing was read.`;
		case "unsupported":
			return `This page cannot read the response: it declares a ${reply.what} version of “${shownVersion(reply.declared)}”, and this build reads ${SUPPORTED_PROJECTIONS.snapshot}. Nothing from it is shown.`;
		case "malformed":
			return `The response did not have the shape this page reads (${reply.reason}). Nothing from it is shown.`;
	}
}

export function renderBanner(container: HTMLElement, state: AppState): void {
	const problem = state.problem;
	if (problem === null) {
		show(container);
		return;
	}
	const stale =
		state.loaded === null ? "" : ` The read of ${clock(state.loaded.fetchedAt)} is still shown and is not current.`;
	show(container, note(`${problemText(problem)}${stale}`, problem.reply.kind === "paced" ? "warn" : "error"));
}

export function renderTopbar(status: HTMLElement, refresh: HTMLButtonElement, state: AppState): void {
	show(status, readStatusText(state));
	refresh.disabled = controlsLocked(state);
	refresh.textContent = state.busy ? "Reading…" : "Refresh";
	document.body.dataset.busy = String(state.busy);
}
