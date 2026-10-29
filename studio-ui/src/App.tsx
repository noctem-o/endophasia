// Studio shell: read-only Observe, Compare and Develop workspaces with persistent, separate request state.
// Capabilities and Evolve remain explicit placeholders.
import { lazy, type ReactElement, Suspense, useEffect, useState } from "react";
import type { EndoCockpitDevelopSessionRowV0 } from "../../protocol/cockpit-develop.ts";
import { CompareWorkspace } from "./compare/CompareWorkspace.tsx";
import { DevelopWorkspace } from "./develop/DevelopWorkspace.tsx";
import { candidateValue } from "./model/compare.ts";
import { NO_FILTERS } from "./model/contract.ts";
import { sourcesModel } from "./model/detail.ts";
import { observeHandoffBlock } from "./model/develop.ts";
import { attentionOf } from "./model/observe.ts";
import { Attention } from "./observe/Attention.tsx";
import { Banner, readStatusText } from "./observe/Chrome.tsx";
import { ObserveWorkspace } from "./observe/ObserveWorkspace.tsx";
import { PanelBoundary } from "./ui/Panel.tsx";
import { Note } from "./ui/text.tsx";
import { useCompare } from "./use-compare.ts";
import { useDevelop } from "./use-develop.ts";
import { useObserve } from "./use-observe.ts";

// The placeholder workspaces are loaded on demand, so the build's handling of a dynamic import (a separate file under the same
// capability-prefixed assets path) is exercised by every browser run.
const Unavailable = lazy(() => import("./observe/Unavailable.tsx"));

const WORKSPACES = [
	{ id: "observe", label: "Observe", ready: true },
	{ id: "compare", label: "Compare", ready: true },
	{ id: "develop", label: "Develop", ready: true },
	{ id: "capabilities", label: "Capabilities", ready: false },
	{ id: "evolve", label: "Evolve", ready: false },
] as const;

export function App(): ReactElement {
	const observe = useObserve();
	const { state } = observe;
	const [workspace, setWorkspace] = useState<(typeof WORKSPACES)[number]["id"]>("observe");
	const compare = useCompare(workspace === "compare");
	const develop = useDevelop(workspace === "develop");
	// A hand-off from DEVELOP to Compare: the recording is preselected as Recording A once Compare's own inventory has it as selectable.
	const [pending, setPending] = useState<{ source: "pi" | "dsh"; session: string } | null>(null);
	const [compareNotice, setCompareNotice] = useState<string | null>(null);
	useEffect(() => {
		if (pending === null || workspace !== "compare") return;
		const inventory = compare.state.inventory;
		if (inventory === null || compare.state.request !== null) return;
		const found = inventory.candidates.find(
			(c) =>
				c.source === pending.source &&
				c.session === pending.session &&
				c.eligibility === "selectable" &&
				c.selector !== null,
		);
		if (found !== undefined) compare.choose("a", candidateValue(found));
		else
			setCompareNotice(
				"The recording opened from Develop is not among the selectable candidates Compare has loaded, so nothing was preselected.",
			);
		setPending(null);
	}, [pending, workspace, compare.state.inventory, compare.state.request, compare.choose]);
	const observeBlocked = observeHandoffBlock(observe.locked);
	const showObserve = (row: EndoCockpitDevelopSessionRowV0, attachment: string | null) => {
		if (observeBlocked !== null) return;
		observe.dispatch({ type: "set-filters", filters: { ...NO_FILTERS, session: row.session } });
		if (attachment !== null) observe.dispatch({ type: "want-attachment", name: attachment });
		setWorkspace("observe");
		// One explicit read, starting just before the session's first event; Observe shows its own window and may need paging.
		observe.goTo(Math.max(0, row.firstStorageSequence - 1));
	};
	const showCompare = (row: EndoCockpitDevelopSessionRowV0) => {
		setCompareNotice(null);
		setPending({ source: row.source, session: row.session });
		setWorkspace("compare");
	};

	// The page's state, for a test that must know a read finished, and for the style sheet.
	useEffect(() => {
		document.body.dataset.state = state.busy
			? "loading"
			: state.problem !== null
				? "error"
				: state.loaded !== null
					? "ready"
					: "idle";
		document.body.dataset.attempts = String(state.attempts);
		document.body.dataset.busy = String(state.busy);
	}, [state.busy, state.problem, state.loaded, state.attempts]);

	// `r` reads again, unless the operator is typing.
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			// Not while the inspector dialog is open: the page behind it is inert, and so are its shortcuts.
			if (document.querySelector("dialog[open]") !== null) return;
			if (workspace !== "observe") return;
			if (event.key !== "r" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
			const target = event.target as HTMLElement | null;
			if (target !== null && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
			observe.refresh();
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [observe.refresh, workspace]);

	const attention = (() => {
		if (state.loaded === null) return [];
		try {
			return attentionOf(sourcesModel(state.loaded.snapshot, state.attachment));
		} catch {
			return [];
		}
	})();

	return (
		<>
			<a className="skip" href="#main">
				Skip to the content
			</a>
			<header className="topbar">
				<span className="wordmark">Endophasia</span>
				<nav className="workspaces" aria-label="Workspaces">
					{WORKSPACES.map((w) => (
						<button
							key={w.id}
							type="button"
							className="workspace"
							aria-current={workspace === w.id ? "page" : undefined}
							data-workspace={w.id}
							onClick={() => setWorkspace(w.id)}
						>
							{w.label}
							{w.ready ? null : <span className="later"> · later</span>}
						</button>
					))}
				</nav>
				<span className="spacer" />
				<span
					className="readonly"
					title="This page only reads. It cannot change a store, steer a runtime or start anything."
				>
					<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
						<rect
							x="2.4"
							y="5.4"
							width="7.2"
							height="5"
							rx="1"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.2"
						/>
						<path d="M4 5.4V4a2 2 0 0 1 4 0v1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
					</svg>
					Read-only
				</span>
				<span id="read-status" className="read-status" aria-live="polite">
					{workspace === "observe" ? readStatusText(state) : "Read-only workspace"}
				</span>
				{workspace === "observe" ? (
					<button
						type="button"
						id="refresh"
						className="btn"
						data-focus="refresh"
						disabled={observe.locked}
						onClick={observe.refresh}
					>
						{state.busy ? "Reading…" : "Refresh"}
					</button>
				) : null}
			</header>
			{workspace === "observe" ? (
				<>
					<Banner state={state} />
					<Attention items={attention} testid="attention" />
				</>
			) : null}
			<main id="main" data-studio-ui="ready">
				<PanelBoundary resetKey={`${workspace}:${state.attempts}`}>
					{workspace === "observe" ? (
						<ObserveWorkspace observe={observe} />
					) : workspace === "compare" ? (
						<>
							{compareNotice === null ? null : <Note tone="warn">{compareNotice}</Note>}
							<CompareWorkspace compare={compare} />
						</>
					) : workspace === "develop" ? (
						<DevelopWorkspace
							develop={develop}
							onObserve={showObserve}
							onCompare={showCompare}
							observeBlocked={observeBlocked}
						/>
					) : (
						<Suspense fallback={<output>Loading…</output>}>
							<Unavailable
								workspace={workspace}
								label={WORKSPACES.find((w) => w.id === workspace)?.label ?? ""}
							/>
						</Suspense>
					)}
				</PanelBoundary>
			</main>
		</>
	);
}
