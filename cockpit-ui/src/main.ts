// Wiring: state, the one read at a time, and the panels. Everything the page shows comes from a snapshot read from the cockpit
// server's API; nothing is polled and nothing refreshes by itself. A read happens when the page opens and when the operator asks
// (Refresh, or a page of the timeline), never two at once. A 429 is shown as the server pacing reads, the controls come back at the
// time it named by one timeout, and the page never retries on its own.

import type { EndoCockpitSnapshotV0 } from "../../protocol/cockpit.ts";
import { fetchSnapshot } from "./api.ts";
import { filtersActive, NO_FILTERS, selectRuntime } from "./model.ts";
import { renderCapabilities } from "./render-capabilities.ts";
import { renderBanner, renderTopbar } from "./render-chrome.ts";
import { capabilityDetail, eventDetail, renderInspector } from "./render-inspector.ts";
import { renderRuntime } from "./render-runtime.ts";
import { renderSources } from "./render-sources.ts";
import { renderTimeline } from "./render-timeline.ts";
import {
	type Actions,
	type AppState,
	controlsLocked,
	PAGE_SIZES,
	pacedNow,
	pauseRemaining,
	type Selection,
} from "./state.ts";
import { note, panel } from "./widgets.ts";

const state: AppState = {
	loaded: null,
	busy: false,
	problem: null,
	attachment: null,
	selection: null,
	filters: NO_FILTERS,
	pageSize: 100,
	attempts: 0,
};

const need = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (element === null) throw new Error(`the page lacks #${id}`);
	return element as T;
};

const status = need("read-status");
const refreshButton = need<HTMLButtonElement>("refresh");
const banner = need("banner");

const runtimePanel = panel("runtime", "Runtime", { subtitle: "as the registry records it" });
const capabilitiesPanel = panel("capabilities", "Capabilities", { subtitle: "recorded status, never inferred" });
const timelinePanel = panel("timeline", "Timeline", { subtitle: "storage order", className: "grow" });
const sourcesPanel = panel("sources", "Sources & provenance", { subtitle: "each on its own" });
const inspectorPanel = panel("inspector", "Inspector", { subtitle: "what was recorded, and where", className: "grow" });
need("col-left").append(runtimePanel.root, capabilitiesPanel.root);
need("col-center").append(timelinePanel.root);
need("col-right").append(sourcesPanel.root, inspectorPanel.root);

/**
 * Keep the operator's place across a re-render: the control that had focus is found again by a stable name (`data-focus`), a row by
 * its position, a capability by its name; a text box gets its caret back. A control that is gone (a cleared filter) leaves focus where
 * the browser puts it.
 */
function focusMemory(): () => void {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return () => undefined;
	const named = active.getAttribute("data-focus");
	const caret =
		active instanceof HTMLInputElement && active.type === "search"
			? ([active.selectionStart, active.selectionEnd] as const)
			: null;
	const seq = active.closest("tr")?.getAttribute("data-seq") ?? null;
	const key = active.getAttribute("data-key");
	const isSeq = active.classList.contains("seq");
	return () => {
		let target: HTMLElement | null = null;
		if (named !== null) target = document.querySelector(`[data-focus="${CSS.escape(named)}"]`);
		else if (isSeq && seq !== null) target = document.querySelector(`tr[data-seq="${CSS.escape(seq)}"] button.seq`);
		else if (key !== null) target = document.querySelector(`button[data-key="${CSS.escape(key)}"]`);
		if (target === null || (target instanceof HTMLButtonElement && target.disabled)) return;
		target.focus({ preventScroll: true });
		if (target instanceof HTMLInputElement && caret !== null) target.setSelectionRange(caret[0], caret[1]);
	};
}

function guarded(area: HTMLElement, draw: () => void): void {
	try {
		draw();
	} catch {
		// A renderer that fails says so in its own panel and leaves the rest of the page working. What failed is not shown.
		area.replaceChildren(note("This panel could not be displayed.", "error"));
	}
}

/** Where each scrolling region was, so a re-render (a selection, a filter) does not throw the operator back to the top. */
function scrollMemory(): () => void {
	const regions = [".table-scroll", ".panel-body", ".col"];
	const before = new Map<string, number>();
	for (const selector of regions)
		document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
			before.set(`${selector}#${element.closest(".panel")?.id ?? ""}#${index}`, element.scrollTop);
		});
	return () => {
		for (const selector of regions)
			document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
				const key = `${selector}#${element.closest(".panel")?.id ?? ""}#${index}`;
				const top = before.get(key);
				if (top !== undefined && !(resetTimelineScroll && selector === ".table-scroll")) element.scrollTop = top;
			});
		resetTimelineScroll = false;
	};
}
/** Set when a read brought a different window of the log: the new rows start at the top. A refresh of the same window keeps its place. */
let resetTimelineScroll = false;

function render(): void {
	const restore = focusMemory();
	const restoreScroll = scrollMemory();
	renderTopbar(status, refreshButton, state);
	renderBanner(banner, state);
	guarded(runtimePanel.body, () => renderRuntime(runtimePanel, state, actions));
	guarded(capabilitiesPanel.body, () => renderCapabilities(capabilitiesPanel, state, actions));
	guarded(timelinePanel.body, () => renderTimeline(timelinePanel, state, actions));
	guarded(sourcesPanel.body, () => renderSources(sourcesPanel, state));
	guarded(inspectorPanel.body, () => renderInspector(inspectorPanel, state));
	document.body.dataset.state = state.busy
		? "loading"
		: state.problem !== null
			? "error"
			: state.loaded !== null
				? "ready"
				: "idle";
	document.body.dataset.attempts = String(state.attempts);
	restoreScroll();
	restore();
}

/**
 * Whether the page can draw everything this snapshot lets the operator reach, without a further read: a dry run into detached
 * containers, so nothing on screen changes. Selecting an event or a capability, switching attachment and clearing a filter all draw
 * from the snapshot already held, so each of those views is drawn here, for every event, every attachment and every capability. A
 * snapshot that any of them cannot draw is a failed read now, not a broken panel later.
 */
function displayable(snapshot: EndoCockpitSnapshotV0): boolean {
	const request = state.loaded?.request ?? { afterSequence: 0, limit: state.pageSize };
	const view = (patch: Partial<AppState>): AppState => ({
		...state,
		busy: false,
		problem: null,
		loaded: { snapshot, fetchedAt: new Date(), durationMs: 0, request },
		...patch,
	});
	const scratch = () => ({ body: document.createElement("div"), tools: document.createElement("div") });
	try {
		// The timeline under the filters now set and under none (which draws every row of the window, whatever a filter later hides).
		for (const filters of filtersActive(state.filters) ? [state.filters, NO_FILTERS] : [NO_FILTERS])
			renderTimeline(scratch(), view({ filters }), actions);
		renderSources(scratch(), view({}));
		renderInspector(scratch(), view({}));
		for (const entry of snapshot.timeline.entries) eventDetail(entry);
		for (const runtime of snapshot.runtimes) {
			const shown = view({ attachment: runtime.identity.source.attachment });
			renderRuntime(scratch(), shown, actions);
			renderCapabilities(scratch(), shown, actions);
			for (const capability of runtime.capabilities.capabilities) capabilityDetail(capability);
		}
		return true;
	} catch {
		return false;
	}
}

let resumeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The one timeout: it fires when the server's requested pause is over and the controls come back. It is set from the same monotonic
 * deadline the lock reads, and sets itself again if it fires early, so the two never disagree. (The server sends at most 3,600 s; the
 * classifier reads at most six digits, 999,999 s or about 11.6 days, which a browser timer, limited to about 24.8 days, holds.)
 */
function armResume(): void {
	clearTimeout(resumeTimer);
	const wait = pauseRemaining(state);
	if (wait <= 0) return;
	resumeTimer = setTimeout(() => {
		render();
		armResume();
	}, wait + 50);
}

async function load(request: { afterSequence: number; limit: number }): Promise<void> {
	if (state.busy || pacedNow(state)) return;
	// A control that starts a read is disabled while it runs, which takes focus away; focus goes back to it when the read ends.
	const returnTo =
		document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-focus") : null;
	state.busy = true;
	render();
	const { reply, durationMs } = await fetchSnapshot(request);
	state.busy = false;
	state.attempts += 1;
	try {
		if (reply.kind === "snapshot" && !displayable(reply.snapshot)) {
			// The classifier checks the shapes it knows; this checks the rest the one general way: a snapshot the renderers cannot draw
			// is a failed read, and the read before it stays on screen as not current.
			state.problem = {
				reply: { kind: "malformed", reason: "the snapshot could not be displayed" },
				at: new Date(),
				retryAt: null,
				holdUntil: null,
			};
		} else if (reply.kind === "snapshot") {
			const moved =
				state.loaded === null ||
				state.loaded.request.afterSequence !== request.afterSequence ||
				state.loaded.request.limit !== request.limit;
			state.loaded = { snapshot: reply.snapshot, fetchedAt: new Date(), durationMs, request };
			state.problem = null;
			state.pageSize = request.limit;
			resetTimelineScroll = moved;
			const attachments = reply.snapshot.runtimes.map((r) => r.identity.source.attachment);
			if (state.attachment === null || !attachments.includes(state.attachment))
				state.attachment = attachments[0] ?? null;
			if (state.selection?.kind === "event") {
				const sequence = state.selection.sequence;
				if (!reply.snapshot.timeline.entries.some((e) => e.storageSequence === sequence)) state.selection = null;
			}
			if (
				state.filters.session !== null &&
				!reply.snapshot.timeline.sessions.some((s) => s.sessionId === state.filters.session)
			)
				state.filters = { ...state.filters, session: null };
		} else {
			const pause =
				reply.kind === "paced" && reply.retryAfterSeconds !== null ? reply.retryAfterSeconds * 1000 : null;
			state.problem = {
				reply,
				at: new Date(),
				retryAt: pause === null ? null : new Date(Date.now() + pause),
				holdUntil: pause === null ? null : performance.now() + pause,
			};
			armResume();
		}
	} catch {
		// A reply that passed the classifier but could not be used is a failed read like any other: said so, never a page stuck
		// "loading". Nothing of the reply is shown.
		state.problem = {
			reply: { kind: "malformed", reason: "the snapshot could not be used" },
			at: new Date(),
			retryAt: null,
			holdUntil: null,
		};
	} finally {
		render();
		if (returnTo !== null && (document.activeElement === null || document.activeElement === document.body))
			document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(returnTo)}"]`)?.focus({ preventScroll: true });
	}
}

const actions: Actions = {
	refresh() {
		void load(state.loaded?.request ?? { afterSequence: 0, limit: state.pageSize });
	},
	goTo(afterSequence) {
		void load({ afterSequence, limit: state.pageSize });
	},
	setPageSize(size) {
		// The size is committed when the read succeeds (see load): a refused or failed read leaves the page showing, and asking for, the
		// window it has.
		if (!(PAGE_SIZES as readonly number[]).includes(size) || controlsLocked(state)) return;
		void load({ afterSequence: state.loaded?.request.afterSequence ?? 0, limit: size });
	},
	selectAttachment(name) {
		state.attachment = name;
		if (state.selection?.kind === "capability") {
			const runtime = state.loaded === null ? null : selectRuntime(state.loaded.snapshot, name);
			const name2 = state.selection.name;
			if (!runtime?.capabilities.capabilities.some((c) => c.capability === name2)) state.selection = null;
		}
		render();
	},
	select(selection: Selection) {
		state.selection = selection;
		render();
		inspectorPanel.root.scrollIntoView({ block: "nearest" });
	},
	setFilters(filters) {
		state.filters = filters;
		render();
	},
};

refreshButton.addEventListener("click", () => actions.refresh());
document.addEventListener("keydown", (event) => {
	if (event.key !== "r" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
	const target = event.target as HTMLElement | null;
	if (target !== null && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA"))
		return;
	actions.refresh();
});

render();
actions.refresh();
