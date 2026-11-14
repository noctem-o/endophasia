// The course: the lower region of the session rail (docs/develop-course.md). What the selected session is doing, and where a prepared
// attempt stands, as lanes and stages with each statement's basis beside it. Presentation only: it draws model/course.ts, which reads
// state the page already holds. Nothing here sends, approves, records or decides; the chart is a picture of what was reported, not a
// state machine. It has three heights (closed, fitted, tall) set by a separator that works from the keyboard and by dragging, and
// a larger chart in a dialog with the runs this page holds and where each one is in the conversation.
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type AttemptCourse,
	COURSE_BASIS_WORDS,
	COURSE_STATUS_WORDS,
	type CourseBasis,
	type CourseLane,
	type CourseStatus,
	courseAttention,
	type LiveCourse,
	type RecordedCourse,
	runWords,
} from "../model/course.ts";
import { OUTCOME_WORDING, STATE_WORDING } from "../model/develop.ts";
import { grouped } from "../model/views.ts";
import { ProvGlyph } from "../ui/marks.tsx";

export const COURSE_SIZES = ["closed", "fit", "tall"] as const;
export type CourseSize = (typeof COURSE_SIZES)[number];
const SIZE_WORDS: Readonly<Record<CourseSize, string>> = {
	closed: "closed",
	fit: "fitted to what it says",
	tall: "tall",
};

export interface CourseSubject {
	/** What the course is of, in a few words: the session's short alias, or why there is none. */
	name: string | null;
	/** How current it is: "read 12:00:01 (browser clock)", "as recorded". */
	asOf: string;
	live: LiveCourse | null;
	attempt: AttemptCourse | null;
	recorded: RecordedCourse | null;
	/** The recorded event selected in the activity table, marked on the strip. */
	event: number | null;
	/** Why there is nothing to draw, when there is nothing. */
	empty: { title: string; text: string } | null;
}

/** A basis mark with its word: how the statement beside it is known. */
export function Basis({ basis, word = true }: { basis: CourseBasis; word?: boolean }): ReactElement {
	const words = COURSE_BASIS_WORDS[basis];
	return (
		<span className="course-basis" data-basis={basis} title={words.meaning}>
			<ProvGlyph kind={basis} size={11} />
			{word ? <span>{words.word}</span> : <span className="sr-only">{words.word}</span>}
		</span>
	);
}

function Lane({ lane, full }: { lane: CourseLane; full: boolean }): ReactElement {
	// A calm lane is one line: its track, the state in words, and how that is known. The sentence is shown when it adds something
	// (the lane waits, is interrupted or is not known) and always in the chart; otherwise it stays for assistive technology.
	const calm = lane.status === "done" || lane.status === "current";
	return (
		<div className="course-lane" data-lane={lane.id} data-status={lane.status} data-testid={`course-lane-${lane.id}`}>
			<span className="course-lane-name">{lane.label}</span>
			<ol className="course-nodes" aria-label={`${lane.label}: states`}>
				{lane.nodes.map((n) => (
					<li
						key={n.id}
						className="course-node"
						data-node={n.id}
						data-on={n.on}
						data-status={n.status}
						aria-current={n.on ? "step" : undefined}
					>
						<span className="course-dot" aria-hidden="true" />
						<span className="course-node-label">{n.label}</span>
					</li>
				))}
			</ol>
			<span className="course-state" data-testid={`course-state-${lane.id}`}>
				<span>{lane.state}</span> <Basis basis={lane.basis} word={false} />
			</span>
			<p className={full || !calm ? "course-line" : "sr-only"} data-testid={`course-text-${lane.id}`}>
				{full ? <Basis basis={lane.basis} /> : null} <span>{lane.text}</span>
			</p>
		</div>
	);
}

const STATUS_MARK: Readonly<Record<CourseStatus, string>> = {
	done: "●",
	current: "◉",
	waiting: "◍",
	failed: "✕",
	interrupted: "◐",
	unknown: "?",
	pending: "○",
	skipped: "–",
};

function Stages({ attempt, full }: { attempt: AttemptCourse; full: boolean }): ReactElement {
	const at = attempt.steps.find((s) => s.id === attempt.at) ?? attempt.steps[0]!;
	return (
		<div
			className="course-attempt"
			data-testid="course-attempt"
			data-attempt={attempt.attemptId}
			data-at={attempt.at}
		>
			<p className="course-attempt-head">
				<span className="chip-ref">Attempt {attempt.attemptId.slice(-8)}</span>
				{full ? <span className="dim small">its stages, each from its own record</span> : null}
			</p>
			<ol className="course-stages" aria-label="Stages of the attempt">
				{attempt.steps.map((s) => (
					<li
						key={s.id}
						className="course-stage"
						data-stage={s.id}
						data-status={s.status}
						data-basis={s.basis}
						aria-current={s.id === attempt.at ? "step" : undefined}
						title={full ? undefined : s.text}
					>
						<span className="course-stage-mark" aria-hidden="true">
							{STATUS_MARK[s.status]}
						</span>
						<span className="course-stage-name">{s.label}</span>
						<span className={full ? "course-stage-status" : "sr-only"}>{COURSE_STATUS_WORDS[s.status]}</span>
						{full ? (
							<span className="course-stage-text">
								<Basis basis={s.basis} /> {s.text}
							</span>
						) : null}
					</li>
				))}
			</ol>
			{full ? null : (
				<p className="course-line" data-testid="course-attempt-text">
					<Basis basis={at.basis} word={false} />{" "}
					<span>
						<b>{at.label}</b> · {COURSE_STATUS_WORDS[at.status]}. {at.text}
					</span>
				</p>
			)}
		</div>
	);
}

const ROWS = ["run", "message", "tool", "other"] as const;

/** The loaded events of a recording, in storage order, on four rows. A picture of the table beside it; a click selects that event there. */
function Strip({
	course,
	event,
	onEvent,
	full,
}: {
	course: RecordedCourse;
	event: number | null;
	onEvent?(sequence: number): void;
	full: boolean;
}): ReactElement {
	const pitch = 4;
	const rowH = full ? 9 : 6;
	const width = Math.max(course.marks.length, 60) * pitch;
	const height = ROWS.length * rowH + 2;
	return (
		<div className="course-strip" data-testid="course-strip">
			<div className="course-strip-rows" aria-hidden="true">
				{ROWS.map((row) => (
					<span key={row}>{row}</span>
				))}
			</div>
			<svg
				className="course-strip-marks"
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				height={height * (full ? 2 : 1.6)}
				role="img"
				aria-label={`${grouped(course.loaded)} loaded events in storage order, by kind. The activity table lists the same events.`}
			>
				{ROWS.map((row, r) => (
					<line
						key={row}
						x1="0"
						x2={width}
						y1={r * rowH + rowH / 2 + 1}
						y2={r * rowH + rowH / 2 + 1}
						className="course-strip-rule"
					/>
				))}
				{course.marks.map((m, i) => (
					// biome-ignore lint/a11y/noStaticElementInteractions: a pointer convenience; the keyboard path is the activity table, which lists the same events
					<rect
						key={m.sequence}
						x={i * pitch + 0.5}
						y={ROWS.indexOf(m.row) * rowH + 1.5}
						width={pitch - 1}
						height={rowH - 1}
						className={`course-mark mk-${m.mark}`}
						data-flagged={m.flagged}
						data-selected={m.sequence === event}
						data-sequence={m.sequence}
						onClick={onEvent === undefined ? undefined : () => onEvent(m.sequence)}
					/>
				))}
			</svg>
		</div>
	);
}

function Recorded({
	course,
	event,
	onEvent,
	full,
}: {
	course: RecordedCourse;
	event: number | null;
	onEvent?(sequence: number): void;
	full: boolean;
}): ReactElement {
	const wording = STATE_WORDING[course.state as keyof typeof STATE_WORDING];
	return (
		<div className="course-recorded" data-testid="course-recorded" data-state={course.state}>
			<p className="course-line">
				<Basis basis="derived" word={full} />{" "}
				<span>
					<b>{wording?.word ?? course.state}</b>
					{full ? ` — ${wording?.meaning ?? ""}` : ". Not a statement about a process now."}
				</span>
			</p>
			<p className="course-counts">
				<span>
					<b>{grouped(course.runs)}</b> run{course.runs === 1 ? "" : "s"}
				</span>
				<span>
					<b>{grouped(course.turns)}</b> turn{course.turns === 1 ? "" : "s"}
				</span>
				{course.tools.calls === null ? null : (
					<span>
						<b>{grouped(course.tools.calls)}</b> tool call{course.tools.calls === 1 ? "" : "s"}
					</span>
				)}
				{course.tools.errors === null || course.tools.errors === 0 ? null : (
					<span data-tone="fault">
						<b>{grouped(course.tools.errors)}</b> reported as error
					</span>
				)}
				{course.flagged === 0 ? null : (
					<span data-tone="attention">
						<b>{grouped(course.flagged)}</b> flag{course.flagged === 1 ? "" : "s"}
					</span>
				)}
			</p>
			{course.lastRunOutcome === null ? null : (
				<p className="course-line">
					<Basis basis="reported" word={full} />{" "}
					<span>Last run: {OUTCOME_WORDING[course.lastRunOutcome] ?? course.lastRunOutcome}.</span>
				</p>
			)}
			<Strip course={course} event={event} onEvent={onEvent} full={full} />
			<p className="dim small">
				{grouped(course.loaded)} of {grouped(course.total)} events drawn, in storage order. Hue is how the event's
				shown fields are known; a brighter mark is flagged.
			</p>
		</div>
	);
}

function Live({
	course,
	full,
	onShowRun,
}: {
	course: LiveCourse;
	full: boolean;
	onShowRun?(seq: number): void;
}): ReactElement {
	const t = course.totals;
	return (
		<div className="course-live" data-testid="course-live" data-stale={course.stale}>
			{course.lanes.map((lane) => (
				<Lane key={lane.id} lane={lane} full={full} />
			))}
			<p className="course-counts" data-testid="course-totals">
				<span className="sr-only">Held by this page: </span>
				<span>
					<b>{t.runs}</b> run{t.runs === 1 ? "" : "s"} held
				</span>
				<span>
					<b>{t.tools}</b> tool call{t.tools === 1 ? "" : "s"}
				</span>
				{t.errors === 0 ? null : (
					<span data-tone="fault">
						<b>{t.errors}</b> reported error{t.errors === 1 ? "" : "s"}
					</span>
				)}
				{t.dropped === 0 ? null : <span>{t.dropped} earlier dropped</span>}
			</p>
			{full ? (
				<section className="course-history" aria-label="Runs this page holds">
					<h3>Runs this page holds</h3>
					{course.runs.length === 0 ? (
						<p className="dim small">
							No run marker is held. Runs from before the workbench started, or before this page was paired, are
							not here.
						</p>
					) : (
						<ol className="course-runs">
							{[...course.runs].reverse().map((r) => (
								<li key={`${r.ordinal}:${r.startSeq}`} data-state={r.state} data-testid="course-run">
									<span className="course-run-name">
										{r.startSeq === null ? "A run that began before what is held" : `Run ${r.ordinal} held`}
									</span>
									<span className="course-run-words">{runWords(r)}</span>
									{r.startSeq === null || onShowRun === undefined ? null : (
										<button
											type="button"
											className="btn quiet small-btn"
											data-testid="course-show-run"
											onClick={() => onShowRun(r.startSeq as number)}
										>
											Show in conversation
										</button>
									)}
								</li>
							))}
						</ol>
					)}
					<p className="dim small">
						Counted from the conversation this page holds: private live text, not recorded evidence. What was
						recorded about the session is in Observe.
					</p>
				</section>
			) : null}
		</div>
	);
}

function Body({
	subject,
	full,
	onEvent,
	onShowRun,
}: {
	subject: CourseSubject;
	full: boolean;
	onEvent?(sequence: number): void;
	onShowRun?(seq: number): void;
}): ReactElement {
	if (subject.live === null && subject.attempt === null && subject.recorded === null)
		return (
			<div className="course-empty" data-testid="course-empty">
				<p className="course-empty-title">{subject.empty?.title ?? "Nothing to chart"}</p>
				<p className="dim small">
					{subject.empty?.text ?? "Choose a session. Its course is drawn from what it reported or recorded."}
				</p>
			</div>
		);
	return (
		<>
			{subject.attempt === null ? null : <Stages attempt={subject.attempt} full={full} />}
			{subject.live === null ? null : <Live course={subject.live} full={full} onShowRun={onShowRun} />}
			{subject.recorded === null ? null : (
				<Recorded course={subject.recorded} event={subject.event} onEvent={onEvent} full={full} />
			)}
			{subject.attempt !== null || subject.live === null || !full ? null : (
				<p className="dim small course-plain" data-testid="course-no-workflow">
					No managed attempt: an ordinary conversation. Nothing here needs a task.
				</p>
			)}
		</>
	);
}

function Chart({
	open,
	onClose,
	afterClose,
	children,
}: {
	open: boolean;
	onClose(): void;
	/** Called once the dialog has closed: where focus goes next. */
	afterClose(): void;
	children: ReactNode;
}): ReactElement {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) {
			dialog.close();
			// After the dialog's own return of focus, which goes to whatever had it before and may be nothing useful.
			afterClose();
		}
	}, [open, afterClose]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is a convenience; Escape and the Close button are the keyboard paths
		<dialog
			ref={ref}
			id="course-chart"
			className="inspector-dialog course-chart"
			aria-labelledby="course-chart-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<header className="panel-head">
				<div className="panel-titles">
					<h2 id="course-chart-title">Course</h2>
					<p className="panel-sub">what was reported, and how each part is known</p>
				</div>
				<div className="panel-tools">
					<button type="button" className="btn" data-testid="course-chart-close" onClick={onClose}>
						Close
					</button>
				</div>
			</header>
			{/* Drawn only while open: closed, the chart holds nothing a search of the page could find twice. */}
			<div className="panel-body">{open ? children : null}</div>
		</dialog>
	);
}

const LEGEND: CourseBasis[] = ["observed", "reported", "declared", "derived", "unavailable"];

export function Course({
	subject,
	size,
	onSize,
	resizable,
	onEvent,
	onShowRun,
}: {
	subject: CourseSubject;
	size: CourseSize;
	onSize(size: CourseSize): void;
	/** Whether the height can be set here (where the rail fills the window); elsewhere it only folds. */
	resizable: boolean;
	onEvent?(sequence: number): void;
	/** Show a held run's start in the conversation. */
	onShowRun?(seq: number): void;
}): ReactElement {
	const [chart, setChart] = useState(false);
	const chartButton = useRef<HTMLButtonElement>(null);
	// Closing the chart gives focus back to the button that opens it, unless the operator asked to be shown something else.
	const refocus = useRef(true);
	const closeChart = (toButton: boolean) => {
		refocus.current = toButton;
		setChart(false);
	};
	const afterClose = useCallback(() => {
		if (refocus.current) chartButton.current?.focus({ preventScroll: true });
	}, []);
	// The height to return to when the course is opened again from closed.
	const last = useRef<CourseSize>(size === "closed" ? "fit" : size);
	if (size !== "closed") last.current = size;
	const at = COURSE_SIZES.indexOf(size);
	const closed = size === "closed";
	const attention = courseAttention(subject.live, subject.attempt);
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const next =
			// The course is above the sessions, and its separator is its lower edge: Down makes it taller.
			event.key === "ArrowDown"
				? COURSE_SIZES[Math.min(COURSE_SIZES.length - 1, at + 1)]
				: event.key === "ArrowUp"
					? COURSE_SIZES[Math.max(0, at - 1)]
					: event.key === "Home"
						? "closed"
						: event.key === "End"
							? "tall"
							: event.key === "Enter" || event.key === " "
								? closed
									? last.current
									: "closed"
								: undefined;
		if (next === undefined) return;
		event.preventDefault();
		onSize(next);
	};
	// Dragging the separator: the height snaps to one of the three, so there is nothing to store and nothing set as a style.
	const drag = (event: PointerEvent<HTMLDivElement>) => {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		const rail = event.currentTarget.closest("[data-course-rail]");
		if (rail === null) return;
		const box = rail.getBoundingClientRect();
		const own = event.currentTarget.closest(".develop-course")?.getBoundingClientRect();
		if (box.height <= 0 || own === undefined) return;
		// From the course's own top: pulled up to its head it closes, pulled past the middle of the rail it is tall, between them it
		// is fitted. Fitted is the height of what it says, so the thresholds are places, not shares.
		const y = event.clientY - own.top;
		const nearest: CourseSize = y < 44 ? "closed" : y > box.height * 0.5 ? "tall" : "fit";
		if (nearest !== size) onSize(nearest);
	};
	const summary =
		subject.live !== null
			? subject.live.lanes.map((l) => l.text).join(" ")
			: subject.recorded !== null
				? `${subject.recorded.state}, as recorded`
				: (subject.empty?.title ?? "nothing to chart");
	return (
		<section
			className="panel develop-course"
			id="develop-course"
			aria-labelledby="develop-course-title"
			data-testid="course"
			data-size={size}
			data-attention={attention ?? "none"}
		>
			<header className="panel-head course-head">
				<button
					type="button"
					className="course-fold"
					data-testid="course-fold"
					aria-expanded={!closed}
					aria-controls="develop-course-body"
					onClick={() => onSize(closed ? last.current : "closed")}
				>
					<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
						<path
							d="M2 3.5 5 6.5 8 3.5"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinecap="round"
						/>
					</svg>
					<h2 id="develop-course-title">Course</h2>
				</button>
				<div className="panel-tools">
					{attention === null ? null : (
						<span className="course-flag" data-attention={attention} data-testid="course-flag">
							{attention === "waiting" ? "waits for you" : "look"}
						</span>
					)}
					<button
						type="button"
						className="btn small-btn"
						data-testid="course-open-chart"
						aria-haspopup="dialog"
						ref={chartButton}
						onClick={() => setChart(true)}
					>
						Chart
					</button>
				</div>
			</header>
			<div className="panel-body course-body" id="develop-course-body" hidden={closed} data-testid="course-body">
				<p className="course-of" data-testid="course-of">
					{subject.name === null ? null : <span className="mono">{subject.name}</span>}
					<span>{subject.asOf}</span>
				</p>
				<Body subject={subject} full={false} onEvent={onEvent} />
			</div>
			{closed ? (
				<p className="sr-only" data-testid="course-summary">
					{summary}
				</p>
			) : null}
			{resizable ? (
				// biome-ignore lint/a11y/useSemanticElements: a focusable separator with a value is the ARIA pattern for a splitter; <hr> cannot carry it
				<div
					className="course-split"
					role="separator"
					aria-orientation="horizontal"
					aria-controls="develop-course-body"
					aria-label="Course height"
					aria-valuemin={0}
					aria-valuemax={COURSE_SIZES.length - 1}
					aria-valuenow={at}
					aria-valuetext={SIZE_WORDS[size]}
					tabIndex={0}
					data-testid="course-split"
					title="Drag, or use the arrow keys, to set the height. Enter folds it."
					onKeyDown={keys}
					onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
					onPointerMove={drag}
					onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
					onDoubleClick={() => onSize(closed ? last.current : "closed")}
				/>
			) : null}
			<Chart open={chart} onClose={() => closeChart(true)} afterClose={afterClose}>
				<p className="course-of">
					{subject.name === null ? null : <span className="mono">{subject.name}</span>}
					<span>{subject.asOf}</span>
				</p>
				<Body
					subject={subject}
					full
					onEvent={onEvent}
					onShowRun={
						onShowRun === undefined
							? undefined
							: (seq) => {
									closeChart(false);
									onShowRun(seq);
								}
					}
				/>
				<section className="course-legend" aria-label="How each statement is known">
					<h3>How each statement is known</h3>
					<dl>
						{LEGEND.map((basis) => (
							<div key={basis}>
								<dt>
									<Basis basis={basis} />
								</dt>
								<dd>{COURSE_BASIS_WORDS[basis].meaning}</dd>
							</div>
						))}
					</dl>
					<p className="dim small">
						This chart draws what was reported and recorded. It does not govern the session, and a stage's name is
						where the work is, not a finding: "Check" is a stage; whether a check passed is stated beside it.
						Nothing here is independent verification.
					</p>
				</section>
			</Chart>
		</section>
	);
}
