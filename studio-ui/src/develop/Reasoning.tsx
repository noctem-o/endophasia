// Model-provided reasoning in the live conversation: one disclosure per trace, the operator's display preference, and the memory-only
// state behind them. What is shown and what is said about it is decided in model/reasoning.ts; this draws it. Reasoning text is a React
// child only (rendered as text, never markup), and none of it reaches the Field's renderer: the field is given typed state, not text.
import {
	createContext,
	type ReactElement,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type Disclosure,
	isLong,
	preview,
	type ReasoningMode,
	traceMeta,
	visibleText,
	wordCount,
} from "../model/reasoning.ts";
import type { ReasoningPart, ReasoningRelay } from "../model/workbench-wire.ts";

/**
 * The operator's choice (fold every trace, or show every trace as it arrives) and the traces they opened or folded by hand. Memory only.
 * Changing the choice applies it to every trace, so the hand-made exceptions are cleared; a new launch clears them too (they named its
 * traces). The choice itself is kept for the page's life: it applies to the whole DEVELOP workspace, in both appearances.
 */
export function useReasoningView(launchId: string | null) {
	const [mode, setModeState] = useState<ReasoningMode>("folded");
	const [overrides, setOverrides] = useState<ReadonlyMap<string, Disclosure>>(() => new Map());
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new launch is a new conversation, so its exceptions start empty
	useEffect(() => setOverrides(new Map()), [launchId]);
	const setMode = useCallback((next: ReasoningMode) => {
		setModeState(next);
		setOverrides(new Map());
	}, []);
	const set = useCallback((key: string, disclosure: Disclosure) => {
		setOverrides((now) => {
			const next = new Map(now);
			next.set(key, disclosure);
			return next;
		});
	}, []);
	return { mode, setMode, overrides, set };
}
export type ReasoningView = ReturnType<typeof useReasoningView>;

/**
 * The conversation's scroller listens for a trace being opened or folded, so it can tell whether the reader is still at the newest item:
 * opening a long trace near the bottom moves the reader away from it, and the next arrival must not pull them back down.
 */
export const ReflowContext = createContext<(() => void) | null>(null);

/** Fine horizontal strata: the trace's mark. Drawn, not a glyph, so it needs no font. */
function Strata(): ReactElement {
	return (
		<svg className="strata" viewBox="0 0 14 12" width={14} height={12} aria-hidden="true" focusable="false">
			<path d="M1 2.5h12M1 6h9M1 9.5h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
		</svg>
	);
}

/** One trace. A withheld or empty block is a line of text (there is nothing to open); a supplied one is a disclosure. */
export function ReasoningBlock({
	part,
	ordinal,
	count,
	disclosure,
	traceKey,
	onSet,
	partial = false,
}: {
	part: ReasoningPart;
	ordinal: number;
	count: number;
	disclosure: Disclosure;
	traceKey: string;
	onSet(key: string, disclosure: Disclosure): void;
	/** The trace of a message still being written, as of the last read. */
	partial?: boolean;
}): ReactElement {
	const id = useId();
	const reflow = useContext(ReflowContext);
	const mounted = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the reader's place is re-judged when this trace opens, folds or grows
	useLayoutEffect(() => {
		if (mounted.current) reflow?.();
		mounted.current = true;
	}, [disclosure]);
	const meta = traceMeta(part, ordinal, count);
	if (part.state !== "supplied")
		return (
			<div className="reasoning" data-state={part.state} data-testid="reasoning" data-partial={partial}>
				<p className="reasoning-line">
					<Strata />
					<span className="reasoning-label">Model-provided reasoning</span>
					<span className="reasoning-meta">{meta}</span>
				</p>
			</div>
		);
	const open = disclosure !== "folded";
	const long = isLong(part.text);
	const words = wordCount(part.text);
	const shown = open ? visibleText(part.text, disclosure) : "";
	return (
		<div
			className="reasoning"
			data-state={part.state}
			data-disclosure={disclosure}
			data-partial={partial}
			data-testid="reasoning"
		>
			<button
				type="button"
				className="reasoning-toggle"
				aria-expanded={open}
				aria-controls={id}
				data-testid="reasoning-toggle"
				onClick={() => onSet(traceKey, open ? "folded" : "open")}
			>
				<span className="reasoning-chevron" aria-hidden="true" />
				<Strata />
				<span className="reasoning-label">Model-provided reasoning</span>
				<span className="reasoning-meta">
					{meta}
					{partial ? " · being written, as of the last read" : ""}
				</span>
				{open ? null : (
					<span className="reasoning-preview" aria-hidden="true">
						{preview(part.text)}
					</span>
				)}
			</button>
			<div className="reasoning-body" id={id} hidden={!open} data-testid="reasoning-body">
				{open ? (
					<>
						<p className="reasoning-text" data-testid="reasoning-text">
							{shown}
						</p>
						{long ? (
							<button
								type="button"
								className="reasoning-more"
								data-testid="reasoning-more"
								onClick={() => onSet(traceKey, disclosure === "full" ? "open" : "full")}
							>
								{disclosure === "full"
									? "Show less"
									: `Show the whole trace (${(words - wordCount(shown)).toLocaleString("en-US")} more words)`}
							</button>
						) : null}
						<p className="reasoning-note">
							{part.truncated ? "Cut at the workbench's limit: the rest was not kept. " : ""}
							Relayed as the model sent it; not a record of how the answer was produced.
						</p>
					</>
				) : null}
			</div>
		</div>
	);
}

/** The operator's display preference: a radio pair, in the conversation's header. It never changes the model's thinking setting. */
export function ReasoningPreference({
	view,
	relay,
}: {
	view: ReasoningView;
	relay: ReasoningRelay | null;
}): ReactElement {
	const name = useId();
	const off = relay !== null && relay.relay !== "relayed";
	const title = off
		? (relay.reason ??
			(relay.relay === "withheld"
				? "This source withholds model-provided reasoning."
				: "This source does not provide model-provided reasoning."))
		: "Model-provided reasoning, where the runtime supplies it: folded under each turn, or shown as it arrives. Display only: it does not change the model's thinking setting.";
	return (
		<fieldset className="reasoning-pref" data-testid="reasoning-pref" disabled={off} title={title}>
			<legend>Reasoning</legend>
			{(["folded", "shown"] as const).map((mode) => (
				<label key={mode} className="reasoning-pref-option" data-selected={view.mode === mode}>
					<input
						type="radio"
						name={name}
						value={mode}
						checked={view.mode === mode}
						onChange={() => view.setMode(mode)}
						data-testid={`reasoning-${mode}`}
					/>
					{mode === "folded" ? "Folded" : "Shown"}
				</label>
			))}
		</fieldset>
	);
}
