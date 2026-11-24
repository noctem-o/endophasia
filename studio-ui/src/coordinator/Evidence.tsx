import type { ReactElement } from "react";
import type {
	EndoCoordinatorBasisV0,
	EndoCoordinatorFindingV0,
	EndoCoordinatorFreshnessStateV0,
	EndoCoordinatorLinkV0,
	EndoCoordinatorSessionV0,
	EndoCoordinatorTaskV0,
	EndoCoordinatorVerificationStateV0,
} from "../../../protocol/coordinator-status.ts";
import { ATTEMPT_LABELS, RECEIPT_RELATION_LABELS } from "../model/attempts-wire.ts";
import { ConditionGlyph, ProvGlyph } from "../ui/marks.tsx";
import { RESULT_LABELS } from "./read.ts";

const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function Timestamp({ ms }: { ms: number }): ReactElement {
	const date = new Date(ms);
	return <time dateTime={date.toISOString()}>{STAMP.format(date)}</time>;
}

const FRESHNESS = {
	fresh: { label: "Fresh at read", mark: "readable" },
	stale: { label: "Stale", mark: "empty" },
	unavailable: { label: "Unavailable", mark: "unavailable" },
	incomplete: { label: "Incomplete", mark: "degraded" },
} satisfies Record<EndoCoordinatorFreshnessStateV0, { label: string; mark: string }>;

export function Freshness({ state }: { state: EndoCoordinatorFreshnessStateV0 }): ReactElement {
	const { label, mark } = FRESHNESS[state];
	return (
		<span className="coordinator-chip" data-freshness={state}>
			<ConditionGlyph state={mark} />
			{label}
		</span>
	);
}

const BASIS = {
	"agent-reported": { label: "Agent-reported", mark: "reported" },
	"controller-observed": { label: "Controller-observed", mark: "observed" },
	"operator-declared": { label: "Operator-declared", mark: "declared" },
	unclassified: { label: "Unclassified", mark: "unavailable" },
} satisfies Record<EndoCoordinatorBasisV0, { label: string; mark: string }>;

export function Basis({ basis }: { basis: EndoCoordinatorBasisV0 }): ReactElement {
	const { label, mark } = BASIS[basis];
	return (
		<span className="coordinator-basis" data-basis={basis}>
			<ProvGlyph kind={mark} />
			{label}
		</span>
	);
}

const VERIFICATION = {
	incomplete: "Verification incomplete",
	failing: "Current check failing",
	inconclusive: "Current check inconclusive",
	"not-current": "No current verification",
	"no-checks": "No checks recorded",
	"not-read": "Not re-verified",
	unavailable: "Verification unavailable",
} satisfies Record<EndoCoordinatorVerificationStateV0, string>;

export function SessionLinks({
	links,
	by,
	taskTitles,
	onJumpToTask,
}: {
	links: EndoCoordinatorLinkV0[];
	by: "task" | "session";
	taskTitles?: Map<string, string>;
	onJumpToTask?: (taskId: string) => void;
}): ReactElement {
	return links.length === 0 ? (
		<p className="coordinator-muted">Relationship unknown. No explicit link was found in the records read.</p>
	) : (
		<ul className="coordinator-records">
			{links.map((link, i) => {
				const canJump = by === "session" && onJumpToTask !== undefined && taskTitles?.has(link.taskId) === true;
				return (
					<li key={`${by === "task" ? link.sessionId : link.taskId}:${link.via}:${i}`}>
						{canJump ? (
							<button
								type="button"
								className="coordinator-signal-jump"
								data-target-task={link.taskId}
								onClick={() => onJumpToTask(link.taskId)}
							>
								<span className="coordinator-signal-name">
									{taskTitles.get(link.taskId) || "Untitled task"}
								</span>
								<span className="coordinator-jump-cue" aria-hidden="true">
									Inspect →
								</span>
							</button>
						) : null}
						<code>{by === "task" ? link.sessionId : link.taskId}</code>
						<p>
							{link.via === "operator-linked" ? "Operator link" : "Recorded send authorization"} · {link.source}
						</p>
						<div className="coordinator-tags">
							<Basis basis={link.basis} />
							<span className="coordinator-muted">
								{link.inLog === "yes"
									? "Present in event log"
									: link.inLog === "no"
										? "Not found in event log"
										: link.inLog === "unknown"
											? "Event-log presence unknown"
											: "Event-log presence not applicable"}
							</span>
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function CheckReceipts({ verification }: { verification: EndoCoordinatorTaskV0["verification"] }): ReactElement {
	return (
		<section className="coordinator-evidence-group">
			<h4>
				Check receipts <span>· Controller-observed</span>
			</h4>
			{verification.freshness.reason !== null ? <p>{verification.freshness.reason}</p> : null}
			{verification.results.length === 0 ? (
				<p className="coordinator-muted">No check results shown in this read.</p>
			) : (
				<ul className="coordinator-records">
					{verification.results.map((result, i) => (
						<li key={`${result.receiptId ?? result.attemptId}:${i}`} data-relation={result.relation ?? undefined}>
							<div className="coordinator-tags">
								<strong className="coordinator-outcome" data-outcome={result.outcome}>
									{RESULT_LABELS[result.outcome]}
								</strong>
								{result.relation !== null &&
								result.relation !== "at-head" &&
								result.relation !== "unavailable" ? (
									<span className="coordinator-chip" data-freshness="stale">
										Historical · not current
									</span>
								) : null}
								<Freshness state={result.freshness} />
							</div>
							<p>
								{result.receiptId === null ? (
									"No receipt ID recorded"
								) : (
									<>
										Receipt <code>{result.receiptId}</code>
									</>
								)}
							</p>
							<p>
								{result.relation === null
									? "No recorded revision relation"
									: RECEIPT_RELATION_LABELS[result.relation]}
							</p>
							<p className="coordinator-muted">
								Attempt <code>{result.attemptId}</code>
							</p>
							<p className="coordinator-muted">
								{result.reading === "planned" ? "Planned check" : "Unplanned check"}
								{result.commit === null ? null : (
									<>
										{" "}
										· <code title={result.commit}>{result.commit.slice(0, 12)}</code>
									</>
								)}
							</p>
						</li>
					))}
				</ul>
			)}
			{verification.moreResults > 0 ? <p>{verification.moreResults} more results not shown in this read.</p> : null}
		</section>
	);
}

export function TaskCard({
	task,
	phaseLabel,
	projectLabel,
	inColumn = false,
	highlighted = false,
	findings,
	attemptsReady,
}: {
	task: EndoCoordinatorTaskV0;
	phaseLabel: string;
	projectLabel?: string;
	inColumn?: boolean;
	highlighted?: boolean;
	findings: EndoCoordinatorFindingV0[];
	attemptsReady: boolean;
}): ReactElement {
	const { attempts, verification, association } = task;
	const latest = attempts.latest;
	const contradictions = findings.filter((finding) => finding.severity === "contradiction");
	return (
		<article
			className="coordinator-task"
			data-testid="coordinator-task"
			data-task-id={task.taskId}
			data-phase={task.phase}
			data-verification={verification.state}
			data-contradiction={contradictions.length > 0 ? "true" : undefined}
			data-highlighted={highlighted ? "true" : undefined}
		>
			<div className="coordinator-task-overview">
				<div className="coordinator-task-head">
					<div className="coordinator-tags">
						{inColumn ? null : (
							<span className="coordinator-phase-tag" data-phase={task.phase}>
								{phaseLabel}
							</span>
						)}
						<Basis basis={task.statusSource} />
						{projectLabel !== undefined ? <span className="coordinator-task-project">{projectLabel}</span> : null}
					</div>
					<div className="coordinator-task-state coordinator-tags">
						<strong data-verification={verification.state}>{VERIFICATION[verification.state]}</strong>
						<Freshness state={verification.freshness.state} />
					</div>
				</div>
				<h3>{task.title || "Untitled task"}</h3>
				{task.phase === "completed" ? (
					<p className="coordinator-completed-note">
						The operator marked this complete. The board did not verify it.
					</p>
				) : null}
				<div className="coordinator-task-note">
					<span>
						{latest === null
							? attemptsReady
								? "No recorded attempt"
								: "Attempt evidence unknown"
							: ATTEMPT_LABELS[latest.state]}
					</span>
					<span className="coordinator-sep" aria-hidden="true">
						·
					</span>
					<span>
						{association === "explicit"
							? `${task.sessions.length} explicit session ${task.sessions.length === 1 ? "link" : "links"}`
							: "Session relationship unknown"}
					</span>
				</div>
				{contradictions.map((finding, i) => (
					<p key={`${finding.code}:${i}`} className="coordinator-contradiction">
						<strong>Contradiction</strong> · {finding.text}
					</p>
				))}
			</div>
			<details className="coordinator-evidence" data-testid="coordinator-task-evidence">
				<summary>
					<span className="coordinator-evidence-label">Task evidence</span>
					<span className="coordinator-evidence-counts">
						{verification.results.length} shown · {task.gaps.length} gaps
					</span>
				</summary>
				<div className="coordinator-evidence-body">
					<p className="coordinator-evidence-meta coordinator-muted">
						<code>{task.taskId}</code> · Revision {task.revision} · Updated <Timestamp ms={task.updatedAtMs} />
					</p>
					<div className="coordinator-evidence-grid">
						<CheckReceipts verification={verification} />
						<section className="coordinator-evidence-group">
							<h4>Evidence gaps</h4>
							{task.gaps.length === 0 ? (
								<p className="coordinator-muted">No gaps reported by this read.</p>
							) : (
								<ul className="coordinator-records">
									{task.gaps.map((gap, i) => (
										<li key={`${gap.code}:${i}`} data-gap={gap.code}>
											{gap.text}
										</li>
									))}
								</ul>
							)}
						</section>
						<section className="coordinator-evidence-group">
							<h4>
								Latest attempt <span>· Operator-declared</span>
							</h4>
							<p>
								{attempts.count}{" "}
								{attemptsReady
									? "attempts recorded"
									: "attempts visible in an incomplete or unavailable source"}
								.
							</p>
							{latest === null ? null : (
								<p>
									<code>{latest.id}</code>
									<br />
									{ATTEMPT_LABELS[latest.state]} ·{" "}
									{latest.sendAuthorized
										? "Send authorization recorded"
										: "No send authorization recorded in this attempt"}
								</p>
							)}
						</section>
						<section className="coordinator-evidence-group">
							<h4>
								Session association <span>· {association === "explicit" ? "Explicit" : "Unknown"}</span>
							</h4>
							<SessionLinks links={task.sessions} by="task" />
						</section>
					</div>
				</div>
			</details>
		</article>
	);
}

export function SessionCard({
	session,
	taskTitles,
	onJumpToTask,
}: {
	session: EndoCoordinatorSessionV0;
	taskTitles?: Map<string, string>;
	onJumpToTask?: (taskId: string) => void;
}): ReactElement {
	return (
		<details className="coordinator-session" data-testid="coordinator-session" data-observation={session.observation}>
			<summary>
				<span className="coordinator-session-name">
					<span className="coordinator-session-runtime">{session.runtime ?? "Runtime unknown"}</span>{" "}
					<code>{session.sessionId}</code>
				</span>
				<span className="coordinator-tags">
					<strong className="coordinator-obs-label" data-observation={session.observation}>
						{session.observation === "active" ? "Recorded active" : "Last observed"}
					</strong>
					<Freshness state={session.freshness.state} />
				</span>
				<span className="coordinator-tags coordinator-muted">
					Recorded {session.recordedState} <Basis basis={session.stateBasis} />
				</span>
				<span className="coordinator-tags coordinator-muted">
					Last event <Timestamp ms={session.lastEventAtMs} />
				</span>
			</summary>
			<div className="coordinator-evidence-body">
				{session.freshness.reason === null ? null : <p>{session.freshness.reason}</p>}
				<p className="coordinator-muted">This record does not establish whether the session is alive now.</p>
				<dl className="coordinator-session-counts">
					<div>
						<dt>Events</dt>
						<dd>{session.counts.events}</dd>
					</div>
					<div>
						<dt>Observed</dt>
						<dd>{session.counts.controllerObserved}</dd>
					</div>
					<div>
						<dt>Reported</dt>
						<dd>{session.counts.agentReported}</dd>
					</div>
					{session.counts.anomalies > 0 ? (
						<div data-tone="fault">
							<dt>Anomalies</dt>
							<dd>{session.counts.anomalies}</dd>
						</div>
					) : null}
				</dl>
				{session.openRun === null ? null : (
					<p>
						Open run recorded · {session.openRun.turns} turns · <Basis basis={session.openRun.basis} />
					</p>
				)}
				{session.lastRun === null ? null : (
					<p>
						Last run recorded {session.lastRun.outcome} · {session.lastRun.turns} turns ·{" "}
						<Basis basis={session.lastRun.basis} />
					</p>
				)}
				<h4>Recent recorded events</h4>
				{session.activity.length === 0 ? (
					<p className="coordinator-muted">No recent activity listed.</p>
				) : (
					<ul className="coordinator-records">
						{session.activity.map((item, i) => (
							<li key={`${item.eventId}:${i}`}>
								<code>{item.kind}</code>
								<div className="coordinator-tags">
									<Basis basis={item.basis} />
									<Timestamp ms={item.atMs} />
								</div>
							</li>
						))}
					</ul>
				)}
				{session.moreActivity > 0 ? <p>{session.moreActivity} older events not shown.</p> : null}
				<h4>{session.association === "explicit" ? "Explicit task links" : "Task association unknown"}</h4>
				<SessionLinks links={session.links} by="session" taskTitles={taskTitles} onJumpToTask={onJumpToTask} />
			</div>
		</details>
	);
}
