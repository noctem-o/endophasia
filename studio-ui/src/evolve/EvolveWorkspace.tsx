// Evolve workspace: Read-Only Protected Experiment Inspector (EVOLVE-INSPECT-001).
// Projection of independently verified protected-experiment records only: no execution, rerun,
// configuration edit, automatic polling, or host filesystem browsing.

import type { ReactElement } from "react";
import type {
	EndoEvolveEvidenceAvailabilityV0,
	EndoEvolveExperimentTypeV0,
	EndoEvolveProtectedAttemptViewV0,
	EndoEvolveProtectedExperimentSummaryV0,
	EndoEvolveProtectedTrialViewV0,
	EndoEvolveTrialOutcomeV0,
} from "../../../protocol/protected-experiment-observation.ts";
import { Note } from "../ui/text.tsx";
import type { EvolveApi } from "../use-evolve.ts";

const shortHex = (hex: string | null): string => (hex === null ? "UNAVAILABLE" : `${hex.slice(0, 12)}…`);

const formatDuration = (ms: number | null): string => {
	if (ms === null) return "UNAVAILABLE";
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
};

const experimentTypeLabel = (type: EndoEvolveExperimentTypeV0 | null): string => {
	switch (type) {
		case "offline-fixed":
			return "offline · fixed paths";
		case "model-connected-fixed":
			return "model-connected · fixed paths";
		case "offline-staged":
			return "offline · staged changeset";
		case "model-connected-staged":
			return "model-connected · staged changeset";
		default:
			return "UNAVAILABLE";
	}
};

const availabilityLabel = (a: EndoEvolveEvidenceAvailabilityV0 | null): { text: string; cls: string } => {
	switch (a) {
		case "complete":
			return { text: "complete", cls: "ev-badge ev-badge-ok" };
		case "partial":
			return { text: "partial", cls: "ev-badge ev-badge-warn" };
		case "has-refusals":
			return { text: "has refusals", cls: "ev-badge ev-badge-fault" };
		case "not-started":
			return { text: "not attempted", cls: "ev-badge ev-badge-na" };
		default:
			return { text: "UNAVAILABLE", cls: "ev-badge ev-badge-na" };
	}
};

const outcomeBadge = (outcome: EndoEvolveTrialOutcomeV0): { text: string; cls: string } => {
	switch (outcome) {
		case "passed":
			return { text: "Verified passed", cls: "ev-badge ev-badge-ok" };
		case "failed":
			return { text: "Verified failed", cls: "ev-badge ev-badge-fault" };
		case "attrition":
			return { text: "Attrition", cls: "ev-badge ev-badge-warn" };
		case "not-attempted":
			return { text: "Not attempted", cls: "ev-badge ev-badge-na" };
		case "refused":
			return { text: "Refused / invalid", cls: "ev-badge ev-badge-fault" };
	}
};

function AttemptProvenance({ attempt }: { attempt: EndoEvolveProtectedAttemptViewV0 }): ReactElement {
	if (attempt.recordStatus !== "verified") {
		return (
			<div className="ev-attempt-block" data-testid="ev-attempt-refused">
				<div className="ev-attempt-head">
					<span className="mono">Attempt #{attempt.attempt}</span>
					<span className="ev-badge ev-badge-fault">
						{attempt.recordStatus === "missing" ? "Missing record" : "Refused record"}
					</span>
				</div>
				<p className="ev-reason">{attempt.refusalReason ?? "Independent validation refused this record."}</p>
				<dl className="ev-kv">
					<dt>Trial schema</dt>
					<dd className="mono">UNAVAILABLE</dd>
					<dt>Record SHA-256</dt>
					<dd className="mono">UNAVAILABLE</dd>
					<dt>Evaluator outcome</dt>
					<dd className="mono">UNAVAILABLE</dd>
				</dl>
			</div>
		);
	}
	const sub = attempt.submission;
	const rec = attempt.modelRecording;
	return (
		<div className="ev-attempt-block" data-testid="ev-attempt-verified">
			<div className="ev-attempt-head">
				<span className="mono">
					Attempt #{attempt.attempt}
					{attempt.retryOf !== null ? ` (retry of #${attempt.retryOf})` : ""}
				</span>
				<span className="ev-badge ev-badge-ok">Verified record</span>
				<span className="mono ev-muted">{attempt.trialSchemaVersion ?? "UNAVAILABLE"}</span>
			</div>
			<dl className="ev-kv">
				<dt>Record SHA-256</dt>
				<dd className="mono" title={attempt.recordSha256 ?? undefined}>
					{attempt.recordSha256 ?? "UNAVAILABLE"}
				</dd>
				<dt>Recorded at</dt>
				<dd className="mono">{attempt.recordedAt ?? "UNAVAILABLE"}</dd>
				<dt>Finalization</dt>
				<dd className="mono">{attempt.finalized ?? "UNAVAILABLE"}</dd>
				<dt>Preflight boundary</dt>
				<dd className="mono">{attempt.preflightStatus ?? "UNAVAILABLE"}</dd>
				<dt>Agent process</dt>
				<dd className="mono">
					{attempt.agent === null
						? "UNAVAILABLE"
						: `${attempt.agent.status} · exit ${attempt.agent.exitCode === null ? "none" : attempt.agent.exitCode}${attempt.agent.signal !== null ? ` (${attempt.agent.signal})` : ""} · termination ${attempt.agent.termination} · ${formatDuration(attempt.agent.durationMs)}`}
				</dd>
				<dt>Independent evaluator</dt>
				<dd className="mono">
					{attempt.evaluation === null
						? "UNAVAILABLE"
						: `${attempt.evaluation.status}${attempt.evaluation.cases !== null ? ` (${attempt.evaluation.cases.passed}/${attempt.evaluation.cases.total} cases)` : ""}${attempt.evaluation.reason !== null ? ` — ${attempt.evaluation.reason}` : ""}`}
				</dd>
				<dt>Evaluator digests</dt>
				<dd className="mono">
					{attempt.evaluation === null
						? "UNAVAILABLE"
						: `def ${shortHex(attempt.evaluation.definitionSha256)} · driver ${shortHex(attempt.evaluation.driverSha256)} · out ${shortHex(attempt.evaluation.outputSha256)}`}
				</dd>
				{sub === null ? (
					<>
						<dt>Submission</dt>
						<dd className="mono">UNAVAILABLE</dd>
					</>
				) : sub.mode === "fixed-paths" ? (
					<>
						<dt>Submission (fixed)</dt>
						<dd className="mono">
							{sub.status} · {sub.fileCount} file(s) · {sub.refusalCount} refusal(s) · sha256{" "}
							{shortHex(sub.sha256)}
						</dd>
					</>
				) : (
					<>
						<dt>Baseline pin</dt>
						<dd className="mono">
							{sub.baselineStatus} · sha256 {shortHex(sub.baselineSha256)}
						</dd>
						<dt>Staged change set</dt>
						<dd className="mono">
							{sub.collectionStatus} ·{" "}
							{sub.changedFileCount === null ? "UNAVAILABLE" : `${sub.changedFileCount} changed`} ·{" "}
							{sub.refusalCount} refusal(s){sub.refusalsOmitted > 0 ? ` (${sub.refusalsOmitted} omitted)` : ""} ·
							sha256 {shortHex(sub.changesetSha256)}
						</dd>
						<dt>Candidate verification</dt>
						<dd className="mono">
							{sub.verificationStatus}
							{sub.verificationReason !== null ? ` (${sub.verificationReason})` : ""} · candidate{" "}
							{shortHex(sub.candidateSha256)}
						</dd>
					</>
				)}
				{rec !== null ? (
					<>
						<dt>Model recording</dt>
						<dd className="mono">
							{rec.status} · {rec.answeredVerified}/{rec.required} required verified ({rec.totalExchanges} total
							exchanges) · refused requests {rec.refusedRequests === null ? "UNAVAILABLE" : rec.refusedRequests}{" "}
							· policy {shortHex(rec.policySha256)}
						</dd>
					</>
				) : null}
				<dt>Invalidating conditions</dt>
				<dd className="mono">{attempt.invalidating.length === 0 ? "none" : attempt.invalidating.join(", ")}</dd>
			</dl>
		</div>
	);
}

function TrialRow({ trial }: { trial: EndoEvolveProtectedTrialViewV0 }): ReactElement {
	const badge = outcomeBadge(trial.outcome);
	const last = trial.finalAttempt;
	const evalSummary =
		last === null || last.evaluation === null
			? "UNAVAILABLE"
			: `${last.evaluation.status}${last.evaluation.cases !== null ? ` (${last.evaluation.cases.passed}/${last.evaluation.cases.total})` : ""}`;
	const agentSummary =
		last === null || last.agent === null
			? "UNAVAILABLE"
			: `${last.agent.status} · ${last.agent.termination}${last.agent.durationMs !== null ? ` · ${formatDuration(last.agent.durationMs)}` : ""}`;
	const candidatePassedWhileTimedOut =
		last !== null && last.evaluation?.status === "passed" && last.agent?.status === "timed-out";

	return (
		<tr data-testid="ev-trial-row" data-outcome={trial.outcome}>
			<td className="mono">#{trial.position}</td>
			<td className="mono">{trial.task}</td>
			<td className="mono">{trial.condition}</td>
			<td className="mono">{trial.trial}</td>
			<td>
				<span className={badge.cls}>{badge.text}</span>
				{trial.outcomeReason !== null ? <div className="ev-sub">{trial.outcomeReason}</div> : null}
				{trial.retryCount > 0 ? <div className="ev-sub">{trial.retryCount} retry(s)</div> : null}
			</td>
			<td className="mono">
				{evalSummary}
				{candidatePassedWhileTimedOut ? (
					<div className="ev-sub ev-warn-text">candidate passed; agent timed out afterward</div>
				) : null}
			</td>
			<td className="mono">{agentSummary}</td>
			<td>
				{trial.attempts.length === 0 ? (
					<span className="mono ev-muted">UNAVAILABLE</span>
				) : (
					<details className="ev-provenance-details">
						<summary className="mono">
							{trial.attempts.length} attempt{trial.attempts.length === 1 ? "" : "s"}
						</summary>
						<div className="ev-attempts-list">
							{trial.attempts.map((a) => (
								<AttemptProvenance key={a.attempt} attempt={a} />
							))}
						</div>
					</details>
				)}
			</td>
		</tr>
	);
}

function RunCard({
	run,
	selected,
	onSelect,
}: {
	run: EndoEvolveProtectedExperimentSummaryV0;
	selected: boolean;
	onSelect: () => void;
}): ReactElement {
	if (run.state !== "readable") {
		return (
			<div className="ev-run-item ev-run-unusable" data-testid="ev-run-unusable" data-state={run.state}>
				<div className="ev-run-head">
					<span className="mono">{run.label}</span>
					<span className="ev-badge ev-badge-fault">{run.state}</span>
				</div>
				{run.runSchemaVersion !== null ? <div className="mono ev-sub">{run.runSchemaVersion}</div> : null}
				<p className="ev-reason">{run.problem ?? "Run directory could not be validated."}</p>
			</div>
		);
	}
	const avail = availabilityLabel(run.evidenceAvailability);
	const c = run.counts!;
	return (
		<button
			type="button"
			className={selected ? "ev-run-item ev-run-button ev-run-selected" : "ev-run-item ev-run-button"}
			aria-pressed={selected}
			data-testid="ev-run-item"
			data-selector={run.selector}
			onClick={onSelect}
		>
			<div className="ev-run-head">
				<strong>{run.runId}</strong>
				<span className={avail.cls}>{avail.text}</span>
			</div>
			<div className="mono ev-sub">
				{run.label} · {run.runSchemaVersion}
			</div>
			<div className="ev-sub">{experimentTypeLabel(run.experimentType)}</div>
			<div className="mono ev-run-metrics">
				<span>
					{run.taskCount} task{run.taskCount === 1 ? "" : "s"} × {run.conditionCount} cond
				</span>
				<span>
					{c.passed} pass · {c.failed} fail · {c.attempted}/{c.planned} attempted
				</span>
				{c.attrition > 0 ? <span className="ev-warn-text">{c.attrition} attrition</span> : null}
				{c.refusedRecords > 0 ? <span className="ev-fault-text">{c.refusedRecords} refused</span> : null}
			</div>
		</button>
	);
}

export function EvolveWorkspace({ evolve }: { evolve: EvolveApi }): ReactElement {
	const { state, refreshList, retryDetail, selectRun } = evolve;
	const index = state.index;

	if (index === null && state.reading) {
		return (
			<section className="panel ev-shell" data-testid="evolve-workspace">
				<p className="ev-muted">Reading protected experiment index…</p>
			</section>
		);
	}

	if (index === null && state.problem !== null) {
		return (
			<section className="panel ev-shell" data-testid="evolve-workspace">
				<div className="ev-toolbar">
					<h2>Protected Experiment Inspector</h2>
					<button type="button" className="btn" onClick={refreshList} disabled={state.reading}>
						{state.reading ? "Reading…" : "Refresh"}
					</button>
				</div>
				<Note tone="error">{state.problem}</Note>
			</section>
		);
	}

	if (index !== null && !index.available) {
		return (
			<section className="panel ev-shell" data-testid="evolve-workspace" data-state="unconfigured">
				<div className="ev-toolbar">
					<div>
						<h2>Protected Experiment Inspector</h2>
						<p className="ev-muted">Read-only projection of independently verified protected runs.</p>
					</div>
					<button type="button" className="btn" onClick={refreshList} disabled={state.reading}>
						{state.reading ? "Reading…" : "Refresh"}
					</button>
				</div>
				<div className="ev-empty" data-testid="ev-unconfigured">
					<p>
						<strong>No protected-experiment source is configured.</strong>
					</p>
					<p>
						Studio never scans your home directory or exposes historical research artifacts automatically. Start
						Studio with an explicit read-only source directory:
					</p>
					<pre className="ev-code">endo studio --protected-runs /path/to/completed-runs</pre>
					<p className="ev-muted">
						Supports completed <code>endo.protected-run.v0</code> through <code>v3</code> directories (offline,
						model-connected, fixed-path, and staged-changeset runs). Evolve cannot execute, rerun, or modify
						experiments.
					</p>
				</div>
			</section>
		);
	}

	const runs = index?.available ? index.runs : [];
	const skipped = index?.available ? index.skipped : null;
	const totalSkipped =
		skipped === null ? 0 : skipped.links + skipped.notDirectory + skipped.overLimit + skipped.unreadable;
	const detail = state.detail;
	const showModelCols = detail !== null && detail.modelAccess !== null;

	return (
		<section className="ev-shell" data-testid="evolve-workspace" data-state="configured">
			<div className="panel ev-toolbar">
				<div>
					<h2>Protected Experiment Inspector</h2>
					<p className="ev-muted">
						Read-only projection of independently verified protected runs (<code>endo.protected-run.v0..v3</code>
						). Studio cannot execute, rerun, or modify experiments.
					</p>
				</div>
				<div className="ev-toolbar-actions">
					<button
						type="button"
						className="btn"
						data-testid="ev-refresh"
						onClick={refreshList}
						disabled={state.reading}
					>
						{state.reading ? "Reading…" : "Refresh"}
					</button>
				</div>
			</div>

			{state.problem !== null ? (
				<div className="ev-problem-row" data-testid="ev-problem">
					<Note tone="error">{state.problem}</Note>
					{state.selectedSelector !== null ? (
						<button type="button" className="btn" onClick={retryDetail} disabled={state.reading}>
							Retry selection
						</button>
					) : null}
				</div>
			) : null}

			{runs.length === 0 ? (
				<div className="panel ev-empty" data-testid="ev-empty">
					<p>
						<strong>No protected runs found in the configured source directory.</strong>
					</p>
					<p className="ev-muted">
						Expected a run directory containing <code>protected-run.json</code> or subdirectories holding
						completed protected runs (bounded to depth 2).
					</p>
					{totalSkipped > 0 && skipped !== null ? (
						<p className="mono ev-sub" data-testid="ev-skipped">
							Skipped entries: {skipped.links} symlink(s), {skipped.overLimit} over limit, {skipped.unreadable}{" "}
							unreadable.
						</p>
					) : null}
				</div>
			) : (
				<div className="ev-layout">
					<aside className="panel ev-rail" aria-label="Protected runs" data-testid="ev-run-list">
						<div className="ev-rail-head">
							<h3>Runs ({runs.length})</h3>
							{totalSkipped > 0 && skipped !== null ? (
								<span className="mono ev-sub" data-testid="ev-skipped">
									skipped: {skipped.links} links · {skipped.overLimit} over-limit · {skipped.unreadable}{" "}
									unreadable
								</span>
							) : null}
						</div>
						<div className="ev-run-items">
							{runs.map((run) => (
								<RunCard
									key={run.selector}
									run={run}
									selected={run.selector === state.selectedSelector}
									onSelect={() => selectRun(run.selector)}
								/>
							))}
						</div>
					</aside>

					<div className="ev-detail" data-testid="ev-detail">
						{detail === null ? (
							<div className="panel ev-empty">
								<p className="ev-muted">
									{state.reading
										? "Independently verifying selected run…"
										: "Select a readable protected run to inspect its verified report and trial provenance."}
								</p>
							</div>
						) : (
							<>
								<div className="panel ev-section">
									<div className="ev-detail-head">
										<div>
											<h3>{detail.run.id}</h3>
											<p className="ev-muted">{detail.run.description}</p>
										</div>
										<div className="ev-badges">
											<span className="ev-badge ev-badge-der">{detail.runSchemaVersion}</span>
											<span className="ev-badge ev-badge-der">{detail.reportSchemaVersion}</span>
											<span className="ev-badge ev-badge-na">
												{experimentTypeLabel(detail.experimentType)}
											</span>
										</div>
									</div>

									<dl className="ev-meta-grid">
										<div>
											<dt>Source label</dt>
											<dd className="mono">{detail.label}</dd>
										</div>
										<div>
											<dt>Spec SHA-256</dt>
											<dd className="mono" title={detail.run.specSha256}>
												{shortHex(detail.run.specSha256)}
											</dd>
										</div>
										<div>
											<dt>Seed</dt>
											<dd className="mono">
												{detail.run.seed} ({detail.run.seedSource})
											</dd>
										</div>
										<div>
											<dt>Ordering / Runner</dt>
											<dd className="mono">
												{detail.run.ordering} · {detail.run.runner}
											</dd>
										</div>
										<div>
											<dt>Created</dt>
											<dd className="mono">{detail.run.createdAt}</dd>
										</div>
										<div>
											<dt>Isolation</dt>
											<dd className="mono">
												{detail.run.isolation.mechanism} {detail.run.isolation.version} (
												{shortHex(detail.run.isolation.executableSha256)}) ·{" "}
												{detail.run.isolation.containment.mechanism} (tasksMax{" "}
												{detail.run.isolation.containment.tasksMax})
											</dd>
										</div>
										{detail.modelAccess !== null ? (
											<div>
												<dt>Declared model access</dt>
												<dd className="mono">
													{detail.modelAccess.model} @ {detail.modelAccess.upstream} · policy{" "}
													{shortHex(detail.modelAccess.policySha256)} · min{" "}
													{detail.modelAccess.minExchanges} / max {detail.modelAccess.maxExchanges}{" "}
													exchanges · maxCompletionTokens {detail.modelAccess.maxCompletionTokens}
												</dd>
											</div>
										) : (
											<div>
												<dt>Model access</dt>
												<dd className="mono">offline (network none)</dd>
											</div>
										)}
									</dl>
								</div>

								{detail.refusedRecords.length > 0 ? (
									<div className="panel ev-section ev-refused-panel" data-testid="ev-refused-records">
										<h3>
											Refused or invalid records ({detail.refusedRecords.length}
											{detail.refusedRecordsOmitted > 0 ? ` + ${detail.refusedRecordsOmitted} omitted` : ""})
										</h3>
										<p className="ev-muted">
											Refused records count as <code>record-refused</code> attrition and never silently
											disappear or register as passes.
										</p>
										<ul className="ev-refused-list">
											{detail.refusedRecords.map((rec, idx) => (
												<li key={`${rec.path}-${idx}`} className="mono">
													<strong>{rec.path}</strong>: {rec.reason}
												</li>
											))}
										</ul>
									</div>
								) : null}

								<div className="panel ev-section">
									<h3>Independent report — Task × Condition matrix</h3>
									<div className="ev-table-wrap">
										<table className="ev-table" data-testid="ev-cells-table">
											<thead>
												<tr>
													<th>Task</th>
													<th>Condition</th>
													<th>Planned</th>
													<th>Attempted</th>
													<th>Not att.</th>
													<th>Qualified</th>
													<th>Passed</th>
													<th>Failed</th>
													<th>No sub.</th>
													{showModelCols ? <th>Below min ex.</th> : null}
													<th>Retries</th>
													<th>Attrition</th>
												</tr>
											</thead>
											<tbody>
												{detail.cells.map((cell) => {
													const attritionEntries = Object.entries(cell.attrition);
													return (
														<tr key={`${cell.task}/${cell.condition}`} data-testid="ev-cell-row">
															<td className="mono">{cell.task}</td>
															<td className="mono">{cell.condition}</td>
															<td className="mono">{cell.planned}</td>
															<td className="mono">{cell.attempted}</td>
															<td className="mono">{cell.notAttempted}</td>
															<td className="mono">{cell.qualified}</td>
															<td className="mono">{cell.passed}</td>
															<td className="mono">{cell.failed}</td>
															<td className="mono">{cell.failedWithoutSubmission}</td>
															{showModelCols ? (
																<td className="mono">{cell.failedBelowMinimumExchanges ?? 0}</td>
															) : null}
															<td className="mono">{cell.retries}</td>
															<td className="mono">
																{attritionEntries.length === 0
																	? "0"
																	: attritionEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}
															</td>
														</tr>
													);
												})}
											</tbody>
										</table>
									</div>
								</div>

								<div className="panel ev-section">
									<h3>
										Trials &amp; attempt provenance ({detail.trials.length}
										{detail.trialsOmitted > 0 ? ` shown, ${detail.trialsOmitted} omitted` : ""})
									</h3>
									<p className="ev-muted">
										Evaluated candidate correctness and agent process completion are shown separately. Model
										transcripts are not displayed and never substitute for independent evaluation.
									</p>
									<div className="ev-table-wrap">
										<table className="ev-table" data-testid="ev-trials-table">
											<thead>
												<tr>
													<th>Pos</th>
													<th>Task</th>
													<th>Condition</th>
													<th>Trial</th>
													<th>Outcome</th>
													<th>Evaluated candidate</th>
													<th>Agent process</th>
													<th>Provenance</th>
												</tr>
											</thead>
											<tbody>
												{detail.trials.map((t) => (
													<TrialRow key={`${t.position}-${t.task}-${t.condition}-${t.trial}`} trial={t} />
												))}
											</tbody>
										</table>
									</div>
								</div>

								<details className="panel ev-section ev-rules-details">
									<summary>
										Tasks, conditions &amp; independent accounting rules ({detail.tasks.length} tasks ·{" "}
										{detail.conditions.length} conditions)
									</summary>
									<div className="ev-subgrid">
										<div>
											<h4>Tasks (evaluator pins)</h4>
											<ul className="ev-plain-list mono">
												{detail.tasks.map((t) => (
													<li key={t.id}>
														<strong>{t.id}</strong> ({t.submissionMode}) · def{" "}
														{shortHex(t.evaluatorDefinitionSha256)} · driver{" "}
														{shortHex(t.evaluatorDriverSha256)} · ref {t.referenceQualified}
														{t.negativeQualified !== null ? ` · neg ${t.negativeQualified}` : ""}
													</li>
												))}
											</ul>
										</div>
										<div>
											<h4>Conditions (profile digests)</h4>
											<ul className="ev-plain-list mono">
												{detail.conditions.map((c) => (
													<li key={c.id}>
														<strong>{c.id}</strong>: {c.description} · profile {shortHex(c.profileSha256)}
													</li>
												))}
											</ul>
										</div>
									</div>
									<h4>Accounting rules (from independent report)</h4>
									<ul className="ev-plain-list">
										{detail.rules.map((rule) => (
											<li key={rule}>{rule}</li>
										))}
									</ul>
								</details>
							</>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
