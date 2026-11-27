// Read-only Coordinator Studio F1 operational views (`COORDINATOR-STUDIO-F1-002` B3-B6):
//   - DeterministicAttentionView (B3)
//   - ResourcesView (B4)
//   - SchedulesView (B5)
//   - AdvisoryHistoryView (B6)
//
// Invariants:
// - Strictly read-only: zero forms, zero mutation controls, zero proposal acceptance or schedule execution triggers.
// - Zero inline style={} props, zero raw HTML sinks, zero network calls.
// - Every operational panel preserves explicit epistemic caveats (recorded != live, reported != authenticated,
//   advisory != authoritative, unknown != zero).

import type { ReactElement } from "react";
import type { EndoCoordinatorStudioOperationsV0 } from "../../../protocol/coordinator-studio-operations.ts";
import type { AttentionTarget, AttentionTier, DeterministicAttentionResult } from "./attention.ts";
import { Timestamp } from "./Evidence.tsx";
import type { CoordinatorProblem } from "./read.ts";

const shortId = (id: string): string => (id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-6)}` : id);

const OPS_PROBLEM_LABELS: Record<CoordinatorProblem, string> = {
	"grant-required": "Pairing grant required",
	forbidden: "Project scope unavailable",
	"not-found": "Operations endpoint not available on this host",
	"too-many-requests": "Host busy (rate limited)",
	unavailable: "Operations projection unavailable (503)",
	invalid: "Operations response failed schema validation",
	unreachable: "Workspace host unreachable",
	timeout: "Operations read timed out",
};

const TIER_LABELS: Record<AttentionTier, string> = {
	hazard: "Hazard",
	blocker: "Blocker",
	verification: "Verification",
	observation: "Observation",
};

const TIER_TONES: Record<AttentionTier, "fault" | "attention" | "info" | "muted"> = {
	hazard: "fault",
	blocker: "attention",
	verification: "info",
	observation: "muted",
};

const formatBytes = (bytes: number | null): string => {
	if (bytes === null) return "unknown";
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	return `${bytes} B`;
};

const targetActionLabel = (target: AttentionTarget): string => {
	switch (target.kind) {
		case "task":
			return "Inspect task →";
		case "lanes":
			return "Open Lanes →";
		case "graph":
			return "Open Graph →";
		case "resources":
			return "Open Resources →";
		case "schedules":
			return "Open Schedules →";
		case "advisory":
			return "Open Advisory →";
	}
};

export function OperationsUnavailableBoard({
	section,
	problem,
}: {
	section: "Resources" | "Schedules" | "Advisory history";
	problem: CoordinatorProblem;
}): ReactElement {
	return (
		<div
			className="coordinator-empty coordinator-empty-board"
			data-testid={`coordinator-${section.toLowerCase().replace(/\s+/g, "-")}-unavailable`}
		>
			<p className="coordinator-index">OPERATIONS READ UNAVAILABLE</p>
			<p className="coordinator-empty-title">
				{section} could not be established ({OPS_PROBLEM_LABELS[problem]}).
			</p>
			<p className="coordinator-muted">
				Unavailable operational state is unknown — never treated as healthy, empty, or zero. Deterministic task and
				coordination views remain usable.
			</p>
		</div>
	);
}

// ---- B3: Deterministic Attention View --------------------------------------------------------------------------------------------

export function DeterministicAttentionView({
	attention,
	onNavigate,
}: {
	attention: DeterministicAttentionResult;
	onNavigate(target: AttentionTarget): void;
}): ReactElement {
	return (
		<div className="coordinator-ops-view" data-testid="coordinator-attention-view">
			<div className="coordinator-ops-banner" data-tone="neutral">
				<span className="coordinator-pill" data-tone="info">
					{attention.rulesetVersion}
				</span>
				<span className="coordinator-muted">
					Deterministic rule ranking · zero language models · zero inference tokens. Priority ranking is an
					explicit ruleset over recorded facts — not a verified optimal plan.
				</span>
			</div>

			<div className="coordinator-ops-counts" data-testid="coordinator-attention-counts">
				<span className="coordinator-pill" data-tone={attention.counts.hazard > 0 ? "fault" : "muted"}>
					{attention.counts.hazard} hazards
				</span>
				<span className="coordinator-pill" data-tone={attention.counts.blocker > 0 ? "attention" : "muted"}>
					{attention.counts.blocker} blockers
				</span>
				<span className="coordinator-pill" data-tone={attention.counts.verification > 0 ? "info" : "muted"}>
					{attention.counts.verification} verification
				</span>
				<span className="coordinator-pill" data-tone="muted">
					{attention.counts.observation} observation
				</span>
			</div>

			{attention.items.length === 0 ? (
				<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-attention-empty">
					<p className="coordinator-index">NO TRIGGERED RULES</p>
					<p className="coordinator-empty-title">No deterministic attention rules triggered in this read.</p>
					<p className="coordinator-muted">
						Absence of triggered rules reflects only the records read and does not establish overall task
						correctness.
					</p>
				</div>
			) : (
				<ol className="coordinator-ops-list" data-testid="coordinator-attention-list">
					{attention.items.map((item) => (
						<li
							key={item.id}
							className="coordinator-ops-card"
							data-testid="coordinator-attention-card"
							data-tier={item.tier}
							data-rule={item.ruleId}
						>
							<div className="coordinator-ops-card-head">
								<div className="coordinator-tags">
									<span className="coordinator-count">#{item.rank}</span>
									<span className="coordinator-pill" data-tone={TIER_TONES[item.tier]}>
										{TIER_LABELS[item.tier]}
									</span>
									<code className="coordinator-ops-code">{item.ruleId}</code>
									<span className="coordinator-pill" data-tone="muted">
										basis: {item.evidenceBasis}
									</span>
									<span className="coordinator-pill" data-tone="muted">
										freshness: {item.freshness}
									</span>
								</div>
								{item.target !== null ? (
									<button
										type="button"
										className="coordinator-link-btn"
										data-testid="coordinator-attention-nav"
										onClick={() => onNavigate(item.target!)}
									>
										{targetActionLabel(item.target)}
									</button>
								) : null}
							</div>
							<h3 className="coordinator-ops-title">
								{item.title} <span className="coordinator-ops-subject">· {item.subjectLabel}</span>
							</h3>
							<dl className="coordinator-assign-meta">
								<div>
									<dt>Observed</dt>
									<dd>{item.observed}</dd>
								</div>
								<div>
									<dt>Rule consequence</dt>
									<dd>{item.consequence}</dd>
								</div>
								<div>
									<dt>Not established</dt>
									<dd className="coordinator-muted">{item.uncertainty}</dd>
								</div>
							</dl>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

// ---- B4: Read-Only S1 Resource Observations View ---------------------------------------------------------------------------------

export function ResourcesView({
	operations,
	problem,
}: {
	operations: EndoCoordinatorStudioOperationsV0 | null;
	problem: CoordinatorProblem | null;
}): ReactElement {
	if (problem !== null || operations === null) {
		return <OperationsUnavailableBoard section="Resources" problem={problem ?? "unavailable"} />;
	}
	const { resources } = operations;
	return (
		<div className="coordinator-ops-view" data-testid="coordinator-resources-view">
			<div className="coordinator-ops-banner" data-tone="neutral">
				<span className="coordinator-pill" data-tone="info">
					Recorded S1 observations · liveProbed: false
				</span>
				<span className="coordinator-muted">
					Studio reads recorded S1 observations only — never wakes a model, triggers router loads, or probes
					endpoints. Reachable ≠ ready · Reported model ≠ authenticated weights · Healthy ≠ free capacity · Unknown
					≠ zero.
				</span>
			</div>

			{resources.state === "unreadable" ? (
				<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-resources-unreadable">
					<p className="coordinator-index">RESOURCE SNAPSHOT UNREADABLE</p>
					<p className="coordinator-empty-title">
						S1 resource observations could not be parsed ({resources.detail ?? "unreadable"}).
					</p>
					<p className="coordinator-muted">
						Unreadable resource state is unknown — never treated as healthy or empty.
					</p>
				</div>
			) : resources.state === "absent" ? (
				<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-resources-absent">
					<p className="coordinator-index">NO RECORDED RESOURCE OBSERVATION</p>
					<p className="coordinator-empty-title">No S1 resource snapshot is recorded in this store yet.</p>
					<p className="coordinator-muted">
						Run passive S1 observation (`endo automation tick`) from the CLI to record zero-token observations.
						Studio never initiates probes on view.
					</p>
				</div>
			) : (
				<>
					<div className="coordinator-ops-counts">
						<span className="coordinator-pill" data-tone={resources.freshness === "fresh" ? "info" : "attention"}>
							Freshness: {resources.freshness}
						</span>
						{resources.observedAtMs !== null ? (
							<span className="coordinator-muted">
								Recorded at <Timestamp ms={resources.observedAtMs} />
								{resources.staleAfterMs !== null
									? ` · stale after ${Math.round(resources.staleAfterMs / 1000)}s`
									: ""}
							</span>
						) : null}
						{resources.poolSource !== null ? (
							<span className="coordinator-pill" data-tone="muted">
								pool source: {resources.poolSource}
							</span>
						) : null}
					</div>

					<section className="coordinator-ops-section">
						<h3>
							Local model endpoints <span className="coordinator-count">{resources.localEndpoints.length}</span>
						</h3>
						{resources.localEndpoints.length === 0 ? (
							<p className="coordinator-muted">No local endpoints were recorded in this observation.</p>
						) : (
							<ul className="coordinator-ops-list" data-testid="coordinator-resource-endpoints">
								{resources.localEndpoints.map((ep) => {
									const tone =
										ep.readiness === "ready"
											? "info"
											: ep.readiness === "capacity-unknown" ||
													ep.readiness === "model-unconfirmed" ||
													ep.readiness === "loading"
												? "attention"
												: "fault";
									return (
										<li key={ep.memberId} className="coordinator-ops-card" data-readiness={ep.readiness}>
											<div className="coordinator-ops-card-head">
												<div className="coordinator-tags">
													<strong>{ep.memberId}</strong>
													<span className="coordinator-pill" data-tone={tone}>
														{ep.readiness}
													</span>
													<span className="coordinator-pill" data-tone="muted">
														{ep.detail}
													</span>
													<span
														className="coordinator-pill"
														data-tone={ep.freshness === "fresh" ? "neutral" : "attention"}
													>
														{ep.freshness}
													</span>
												</div>
												<span className="coordinator-muted">{ep.inferenceTokens} inference tokens</span>
											</div>
											<dl className="coordinator-assign-meta">
												<div>
													<dt>Endpoint</dt>
													<dd>
														<code>{ep.endpoint}</code> · backend: {ep.backend}
														{ep.build !== null ? ` (${ep.build})` : ""}
													</dd>
												</div>
												<div>
													<dt>Reported model</dt>
													<dd>
														<code>{ep.modelId}</code> ·{" "}
														<span className="coordinator-muted">self-reported (unauthenticated)</span>
													</dd>
												</div>
												<div>
													<dt>Capacity</dt>
													<dd>
														{ep.capacityConfirmed
															? "Free capacity passively confirmed at observation time"
															: "Free capacity NOT established (healthy ≠ free capacity)"}
													</dd>
												</div>
												<div>
													<dt>Observed</dt>
													<dd>
														<Timestamp ms={ep.observedAtMs} />
													</dd>
												</div>
											</dl>
										</li>
									);
								})}
							</ul>
						)}
					</section>

					<section className="coordinator-ops-section">
						<h3>
							Provider allowances <span className="coordinator-count">{resources.providers.length}</span>
						</h3>
						{resources.providers.length === 0 ? (
							<p className="coordinator-muted">No provider allowance observations recorded.</p>
						) : (
							<ul className="coordinator-ops-list" data-testid="coordinator-resource-providers">
								{resources.providers.map((p) => (
									<li key={p.providerId} className="coordinator-ops-card">
										<div className="coordinator-ops-card-head">
											<div className="coordinator-tags">
												<strong>{p.providerId}</strong>
												<span
													className="coordinator-pill"
													data-tone={
														p.effectiveStanding === "available"
															? "info"
															: p.effectiveStanding === "exhausted-until-reset" ||
																	p.effectiveStanding === "degraded-endpoint"
																? "fault"
																: "attention"
													}
												>
													effective: {p.effectiveStanding}
												</span>
												<span className="coordinator-pill" data-tone="muted">
													{p.surfaceKind} · {p.basis}
												</span>
												<span
													className="coordinator-pill"
													data-tone={p.freshness === "fresh" ? "neutral" : "attention"}
												>
													{p.freshness}
												</span>
											</div>
										</div>
										<dl className="coordinator-assign-meta">
											<div>
												<dt>Recorded standing</dt>
												<dd>
													{p.standing}
													{p.quotaPoolId !== null ? ` · pool ${p.quotaPoolId}` : ""} · observed{" "}
													<Timestamp ms={p.observedAtMs} />
												</dd>
											</div>
											{p.windows.length > 0 ? (
												<div>
													<dt>Windows</dt>
													<dd>
														<ul className="coordinator-inline-list">
															{p.windows.map((w, idx) => (
																<li key={`${w.windowKind}:${idx}`}>
																	{w.windowKind}: {w.standing} · confirmed:{" "}
																	{w.availabilityConfirmed ? "yes" : "no"}
																	{w.remainingEstimate !== null && w.limitEstimate !== null
																		? ` · est. ${w.remainingEstimate}/${w.limitEstimate} ${w.unit}`
																		: " · remaining unknown"}
																	{w.resetAtMs !== null ? (
																		<>
																			{" "}
																			· reset <Timestamp ms={w.resetAtMs} /> ({w.resetBasis})
																		</>
																	) : null}
																</li>
															))}
														</ul>
													</dd>
												</div>
											) : null}
											{p.localLedgerLowerBound !== null ? (
												<div>
													<dt>Local ledger</dt>
													<dd className="coordinator-muted">
														{p.localLedgerLowerBound.recordedTurns} local Endophasia turn(s) recorded
														(lower bound only; does not reflect external account usage)
													</dd>
												</div>
											) : null}
										</dl>
									</li>
								))}
							</ul>
						)}
					</section>

					{resources.hardware !== null ? (
						<section className="coordinator-ops-section">
							<h3>
								Hardware snapshot <span className="coordinator-count">{resources.hardware.devices.length}</span>
							</h3>
							<p className="coordinator-muted">
								Mode: {resources.hardware.mode} · observed <Timestamp ms={resources.hardware.observedAtMs} />
							</p>
							{resources.hardware.devices.length > 0 ? (
								<ul className="coordinator-ops-list">
									{resources.hardware.devices.map((dev) => (
										<li key={dev.deviceId} className="coordinator-ops-card">
											<div className="coordinator-tags">
												<strong>{dev.label ?? dev.deviceId}</strong>
												<span className="coordinator-pill" data-tone="muted">
													{dev.kind}
													{dev.backendFamily !== null ? ` · ${dev.backendFamily}` : ""}
												</span>
												<span className="coordinator-pill" data-tone="muted">
													contention: {dev.sharedDeviceContention}
												</span>
											</div>
											<p className="coordinator-muted">
												Memory ({dev.memoryBasis}): free {formatBytes(dev.memoryFreeBytes)} / used{" "}
												{formatBytes(dev.memoryUsedBytes)} / total {formatBytes(dev.memoryTotalBytes)}
												{dev.attributedModelMemberIds.length > 0
													? ` · members: ${dev.attributedModelMemberIds.join(", ")}`
													: ""}
											</p>
										</li>
									))}
								</ul>
							) : null}
						</section>
					) : null}
				</>
			)}
			{resources.declarations.state === "unreadable" ? (
				<section className="coordinator-ops-section" data-testid="coordinator-resource-declarations-unreadable">
					<h3>Operator allowance declarations</h3>
					<p className="coordinator-empty">
						Operator declarations file (`declarations.json`) is unreadable — declared provider ceilings cannot be
						established.
					</p>
				</section>
			) : resources.declarations.items.length > 0 ? (
				<section className="coordinator-ops-section">
					<h3>
						Operator allowance declarations{" "}
						<span className="coordinator-count">{resources.declarations.items.length}</span>
					</h3>
					<ul className="coordinator-ops-list" data-testid="coordinator-resource-declarations">
						{resources.declarations.items.map((d, idx) => (
							<li key={`${d.providerId}:${d.windowKind}:${idx}`} className="coordinator-ops-card">
								<div className="coordinator-tags">
									<strong>{d.providerId}</strong>
									<span className="coordinator-pill" data-tone="attention">
										{d.standing}
									</span>
									<span className="coordinator-pill" data-tone="muted">
										{d.windowKind} · {d.basis}
									</span>
								</div>
								<p className="coordinator-muted">
									Declared <Timestamp ms={d.declaredAtMs} /> · reset <Timestamp ms={d.resetAtMs} />
									{d.note !== null ? ` · ${d.note}` : ""}
								</p>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

// ---- B5: Read-Only S1 & S2 Schedules View ----------------------------------------------------------------------------------------

export function SchedulesView({
	operations,
	problem,
}: {
	operations: EndoCoordinatorStudioOperationsV0 | null;
	problem: CoordinatorProblem | null;
}): ReactElement {
	if (problem !== null || operations === null) {
		return <OperationsUnavailableBoard section="Schedules" problem={problem ?? "unavailable"} />;
	}
	const { observation, advisory } = operations.schedules;
	return (
		<div className="coordinator-ops-view" data-testid="coordinator-schedules-view">
			<div className="coordinator-ops-banner" data-tone="neutral">
				<span className="coordinator-pill" data-tone="info">
					Read-only schedule ledger · executesSchedules: false
				</span>
				<span className="coordinator-muted">
					Viewing schedules never executes ticks or installs timers. Scheduled ≠ running · Claimed ≠ dispatched ≠
					completed ≠ published · Disabled ≠ unavailable · Unknown ≠ failed.
				</span>
			</div>

			{/* S1 Store Observation Schedules */}
			<section className="coordinator-ops-section" data-testid="coordinator-s1-schedules">
				<div className="coordinator-ops-card-head">
					<h3>
						S1 Observation schedules (store-level, 0 tokens){" "}
						<span className="coordinator-count">{observation.schedules.length}</span>
					</h3>
					<span
						className="coordinator-pill"
						data-tone={
							observation.lease.active ? "info" : observation.lease.state === "unreadable" ? "fault" : "muted"
						}
					>
						S1 lease:{" "}
						{observation.lease.state === "ready"
							? observation.lease.active
								? `active (epoch ${observation.lease.epoch})`
								: `idle (epoch ${observation.lease.epoch})`
							: observation.lease.state}
					</span>
				</div>
				{observation.degraded ? (
					<p className="coordinator-muted">
						Observation ledger has unreadable or damaged entries; absence of records does not imply no scheduled
						runs.
					</p>
				) : null}
				{observation.state === "unreadable" ? (
					<p className="coordinator-empty">S1 schedules unreadable ({observation.detail ?? "error"}).</p>
				) : observation.schedules.length === 0 ? (
					<p className="coordinator-muted">No S1 observation schedules are configured in this store.</p>
				) : (
					<ul className="coordinator-ops-list">
						{observation.schedules.map((s) => (
							<li
								key={s.scheduleId}
								className="coordinator-ops-card"
								data-enabled={s.enabled ? "true" : "false"}
							>
								<div className="coordinator-ops-card-head">
									<div className="coordinator-tags">
										<strong>{s.label ?? s.scheduleId}</strong>
										<span className="coordinator-pill" data-tone={s.enabled ? "info" : "muted"}>
											{s.enabled ? "enabled" : "disabled"} · rev {s.revision}
										</span>
										<span className="coordinator-pill" data-tone="muted">
											{s.actionKind}
										</span>
										<span
											className="coordinator-pill"
											data-tone={
												s.nextDueState === "due" || s.nextDueState === "missed" ? "attention" : "muted"
											}
										>
											{s.nextDueState}
										</span>
									</div>
									<span className="coordinator-muted">{s.triggerSummary}</span>
								</div>
								<p className="coordinator-muted">
									ID <code>{s.scheduleId}</code> · missed-run: {s.missedRunPolicy}
									{s.nextWindowStartMs !== null ? (
										<>
											{" "}
											· next/due window <Timestamp ms={s.nextWindowStartMs} />
										</>
									) : null}
									{s.lastFireStatus !== null
										? ` · last outcome: ${s.lastFireStatus}`
										: " · no outcome recorded"}
								</p>
							</li>
						))}
					</ul>
				)}

				{observation.recentFires.length > 0 ? (
					<div className="coordinator-ops-sub">
						<h4>
							Recent S1 observation fires{" "}
							<span className="coordinator-count">{observation.recentFires.length}</span>
							{observation.incompleteCount > 0 ? (
								<span className="coordinator-pill" data-tone="attention">
									{observation.incompleteCount} claimed-incomplete
								</span>
							) : null}
						</h4>
						<ul className="coordinator-ops-list" data-testid="coordinator-s1-fires">
							{observation.recentFires.map((f) => (
								<li key={f.idempotencyKey} className="coordinator-ops-card" data-fire-state={f.state}>
									<div className="coordinator-tags">
										<strong>{f.scheduleId}</strong>
										<span
											className="coordinator-pill"
											data-tone={
												f.state === "completed"
													? "info"
													: f.state === "claimed-incomplete" || f.state === "missed-skipped"
														? "attention"
														: "fault"
											}
										>
											{f.state}
										</span>
										<span className="coordinator-pill" data-tone="muted">
											{f.actionKind} · 0 tokens
										</span>
									</div>
									<p className="coordinator-muted">
										Window <Timestamp ms={f.windowStartMs} />
										{f.claimedAtMs !== null ? (
											<>
												{" "}
												· claimed <Timestamp ms={f.claimedAtMs} />
											</>
										) : null}
										{f.completedAtMs !== null ? (
											<>
												{" "}
												· completed <Timestamp ms={f.completedAtMs} />
											</>
										) : (
											" · completion unrecorded"
										)}
										{f.detail !== null ? ` · ${f.detail}` : ""}
									</p>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</section>

			{/* S2 Project-Scoped Advisory Schedules */}
			<section className="coordinator-ops-section" data-testid="coordinator-s2-schedules">
				<div className="coordinator-ops-card-head">
					<h3>
						S2 Advisory schedules (this project only){" "}
						<span className="coordinator-count">{advisory.schedules.length}</span>
					</h3>
					<span
						className="coordinator-pill"
						data-tone={
							advisory.lease.active ? "attention" : advisory.lease.state === "unreadable" ? "fault" : "muted"
						}
					>
						S2 lease:{" "}
						{advisory.lease.state === "ready"
							? advisory.lease.active
								? "active (this project)"
								: "idle"
							: advisory.lease.state}
					</span>
				</div>
				{advisory.degraded ? (
					<p className="coordinator-muted">
						Some advisory ledger files could not be read; budget and history may be incomplete.
					</p>
				) : null}
				{advisory.state === "unreadable" ? (
					<p className="coordinator-empty">Advisory schedules unreadable ({advisory.detail ?? "error"}).</p>
				) : advisory.schedules.length === 0 ? (
					<p className="coordinator-muted">No S2 advisory schedules are recorded for this project.</p>
				) : (
					<ul className="coordinator-ops-list">
						{advisory.schedules.map((s) => (
							<li
								key={s.scheduleId}
								className="coordinator-ops-card"
								data-enabled={s.enabled ? "true" : "false"}
							>
								<div className="coordinator-ops-card-head">
									<div className="coordinator-tags">
										<strong>{s.label ?? s.scheduleId}</strong>
										<span className="coordinator-pill" data-tone={s.enabled ? "info" : "muted"}>
											{s.enabled ? "enabled" : "disabled"} · rev {s.revision}
										</span>
										<span className="coordinator-pill" data-tone={s.authorization.ok ? "info" : "attention"}>
											auth: {s.authorization.status}
										</span>
										<span className="coordinator-pill" data-tone="muted">
											wake: {s.wake}
										</span>
									</div>
									<span className="coordinator-muted">{s.triggerSummary}</span>
								</div>
								<dl className="coordinator-assign-meta">
									<div>
										<dt>Schedule</dt>
										<dd>
											<code>{s.scheduleId}</code> · {s.actionKind} · due state: {s.nextDueState}
											{s.lastFireStatus !== null ? ` · last fire: ${s.lastFireStatus}` : ""}
										</dd>
									</div>
									<div>
										<dt>Budget</dt>
										<dd>
											{s.budget === null ? (
												<span className="coordinator-muted">
													Unavailable (requires active authorization and readable turn ledger)
												</span>
											) : (
												<>
													Turns: {s.budget.turnsCharged}/{s.budget.maxTurnsPerPeriod} · Tokens:{" "}
													{s.budget.generatedTokensCharged}/{s.budget.maxGeneratedTokensPerPeriod} ·
													Uncertain: {s.budget.uncertainTurns} ·{" "}
													{s.budget.admissible
														? "admissible"
														: `refused (${s.budget.refusal ?? "budget"})`}
												</>
											)}
										</dd>
									</div>
								</dl>
							</li>
						))}
					</ul>
				)}

				{advisory.recentFires.length > 0 ? (
					<div className="coordinator-ops-sub">
						<h4>
							Recent project advisory fires{" "}
							<span className="coordinator-count">{advisory.recentFires.length}</span>
							{advisory.incompleteCount > 0 ? (
								<span className="coordinator-pill" data-tone="attention">
									{advisory.incompleteCount} claimed-incomplete
								</span>
							) : null}
						</h4>
						<ul className="coordinator-ops-list" data-testid="coordinator-s2-fires">
							{advisory.recentFires.map((f) => (
								<li key={f.idempotencyKey} className="coordinator-ops-card" data-fire-state={f.state}>
									<div className="coordinator-tags">
										<strong>{f.scheduleId}</strong>
										<span
											className="coordinator-pill"
											data-tone={
												f.outcomeStatus === "briefing-published"
													? "info"
													: f.state === "claimed-incomplete" || f.outcomeStatus === "briefing-refused"
														? "attention"
														: "muted"
											}
										>
											{f.outcomeStatus ?? f.state}
										</span>
										<span className="coordinator-pill" data-tone="muted">
											dispatched: {f.inferenceDispatched}
										</span>
									</div>
									<p className="coordinator-muted">
										Window <Timestamp ms={f.windowStartMs} />
										{f.completedAtMs !== null ? (
											<>
												{" "}
												· finished <Timestamp ms={f.completedAtMs} />
											</>
										) : (
											" · outcome unrecorded"
										)}
										{f.detail !== null ? ` · ${f.detail}` : ""}
									</p>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</section>
		</div>
	);
}

// ---- B6: Read-Only Project-Scoped S2 Advisory History & Proposal Queue -----------------------------------------------------------

export function AdvisoryHistoryView({
	operations,
	problem,
	taskTitles,
	onJumpToTask,
}: {
	operations: EndoCoordinatorStudioOperationsV0 | null;
	problem: CoordinatorProblem | null;
	taskTitles: ReadonlyMap<string, string>;
	onJumpToTask(taskId: string): void;
}): ReactElement {
	if (problem !== null || operations === null) {
		return <OperationsUnavailableBoard section="Advisory history" problem={problem ?? "unavailable"} />;
	}
	const { advisoryHistory } = operations;
	const { totals } = advisoryHistory;
	return (
		<div className="coordinator-ops-view" data-testid="coordinator-advisory-view">
			<div className="coordinator-ops-banner" data-tone="attention">
				<span className="coordinator-pill" data-tone="attention">
					Untrusted model interpretation · advisory only · authority: none
				</span>
				<span className="coordinator-muted">
					Project-scoped S2 history only. Proposal acceptance and execution controls are intentionally absent in
					Studio F1 (deferred to F2). Refused, withheld, or stale briefings never alter or obscure deterministic
					project state.
				</span>
			</div>

			{advisoryHistory.state === "unreadable" ? (
				<div className="coordinator-empty coordinator-empty-board" data-testid="coordinator-advisory-unreadable">
					<p className="coordinator-index">ADVISORY HISTORY UNREADABLE</p>
					<p className="coordinator-empty-title">
						Advisory turn or proposal records could not be established ({advisoryHistory.detail ?? "error"}).
					</p>
					<p className="coordinator-muted">
						Deterministic task, coordination, and attention views remain unaffected.
					</p>
				</div>
			) : (
				<>
					{advisoryHistory.degraded ? (
						<div
							className="coordinator-ops-banner"
							data-tone="attention"
							data-testid="coordinator-advisory-degraded"
						>
							<span className="coordinator-pill" data-tone="attention">
								History degraded
							</span>
							<span className="coordinator-muted">
								Some advisory turn or proposal files could not be read; displayed counts and token totals may be
								incomplete (unreadable ≠ zero).
							</span>
						</div>
					) : null}
					<div className="coordinator-ops-counts" data-testid="coordinator-advisory-totals">
						<span className="coordinator-pill" data-tone="muted">
							Briefings: {totals.briefingsCount} ({totals.publishedCount} published · {totals.refusedCount}{" "}
							refused · {totals.withheldCount} withheld · {totals.notDispatchedCount} not dispatched)
						</span>
						{totals.uncertainTurnsCount > 0 ? (
							<span className="coordinator-pill" data-tone="attention">
								Uncertain dispatched turns: {totals.uncertainTurnsCount} (charged at reservation)
							</span>
						) : null}
						<span className="coordinator-pill" data-tone="muted">
							Proposals: {totals.pendingProposalsCount} pending / {totals.totalProposalsCount} retained
						</span>
						<span className="coordinator-pill" data-tone="muted">
							Charged tokens: {totals.recordedChargedTokens}
							{totals.anyUsageIncomplete ? " (incomplete usage reported — missing ≠ zero)" : ""}
						</span>
					</div>

					{/* Proposal Queue (Strictly Read-Only — Zero Accept/Execute Controls) */}
					<section className="coordinator-ops-section">
						<h3>
							Advisory proposals (read-only){" "}
							<span className="coordinator-count">{advisoryHistory.proposals.length}</span>
						</h3>
						{advisoryHistory.proposals.length === 0 ? (
							<p className="coordinator-muted">No advisory proposals are recorded for this project.</p>
						) : (
							<ul className="coordinator-ops-list" data-testid="coordinator-advisory-proposals">
								{advisoryHistory.proposals.map((p) => (
									<li key={p.proposalId} className="coordinator-ops-card" data-queue-state={p.queueState}>
										<div className="coordinator-ops-card-head">
											<div className="coordinator-tags">
												<strong>{p.kind}</strong>
												<span
													className="coordinator-pill"
													data-tone={p.queueState === "pending" ? "attention" : "muted"}
												>
													{p.queueState}
												</span>
												<span
													className="coordinator-pill"
													data-tone={p.currency === "current" ? "info" : "attention"}
												>
													{p.currency}
												</span>
												<span className="coordinator-pill" data-tone="muted">
													{p.standing} · grants: {p.authorityGrants}
												</span>
											</div>
											{p.subject.taskId !== null && taskTitles.has(p.subject.taskId) ? (
												<button
													type="button"
													className="coordinator-link-btn"
													onClick={() => onJumpToTask(p.subject.taskId!)}
												>
													Inspect task →
												</button>
											) : null}
										</div>
										<dl className="coordinator-assign-meta">
											<div>
												<dt>Subject</dt>
												<dd>
													{p.subject.taskId !== null
														? (taskTitles.get(p.subject.taskId) ?? shortId(p.subject.taskId))
														: "Project-level"}
													{p.subject.candidateId !== null
														? ` · candidate ${shortId(p.subject.candidateId)}`
														: ""}
												</dd>
											</div>
											{p.evidenceFacts.length > 0 ? (
												<div>
													<dt>Evidence facts</dt>
													<dd>{p.evidenceFacts.join(" · ")}</dd>
												</div>
											) : null}
											{p.uncertainties.length > 0 ? (
												<div>
													<dt>Uncertainties</dt>
													<dd className="coordinator-muted">{p.uncertainties.join(" · ")}</dd>
												</div>
											) : null}
											<div>
												<dt>Provenance</dt>
												<dd className="coordinator-muted">
													Schedule <code>{p.scheduleId}</code> · turn <code>{shortId(p.turnId)}</code> ·
													generated <Timestamp ms={p.generatedAtMs} />
												</dd>
											</div>
										</dl>
									</li>
								))}
							</ul>
						)}
					</section>

					{/* Recorded Briefings & Refusals */}
					<section className="coordinator-ops-section">
						<h3>
							Recorded advisory briefings &amp; refusals{" "}
							<span className="coordinator-count">{advisoryHistory.briefings.length}</span>
						</h3>
						{advisoryHistory.briefings.length === 0 ? (
							<p className="coordinator-muted">No advisory briefing turns are recorded for this project.</p>
						) : (
							<ul className="coordinator-ops-list" data-testid="coordinator-advisory-briefings">
								{advisoryHistory.briefings.map((b) => (
									<li key={b.turnId} className="coordinator-ops-card" data-availability={b.availability}>
										<div className="coordinator-ops-card-head">
											<div className="coordinator-tags">
												<strong>{b.scheduleId}</strong>
												<span
													className="coordinator-pill"
													data-tone={
														b.availability === "available"
															? "info"
															: b.availability === "unavailable" || b.availability === "withheld"
																? "attention"
																: "muted"
													}
												>
													{b.availability}
												</span>
												{b.refusal !== null ? (
													<span className="coordinator-pill" data-tone="fault">
														refusal: {b.refusal}
													</span>
												) : null}
												<span
													className="coordinator-pill"
													data-tone={b.currency === "current-at-publication" ? "neutral" : "attention"}
												>
													{b.currency}
												</span>
											</div>
											<span className="coordinator-muted">
												<Timestamp ms={b.publishedAtMs} />
											</span>
										</div>
										<dl className="coordinator-assign-meta">
											<div>
												<dt>Model provenance</dt>
												<dd>
													Reported: <code>{b.model.reportedModel}</code> ({b.model.harness})
													{b.model.selectedMemberId !== null
														? ` · member ${b.model.selectedMemberId}`
														: ""}
													{b.model.selectedReadiness !== null
														? ` · readiness ${b.model.selectedReadiness}`
														: ""}
												</dd>
											</div>
											<div>
												<dt>Token accounting</dt>
												<dd>
													Charged: {b.accounting.chargedGeneratedTokens} tok (reserved{" "}
													{b.accounting.reservedTokens}){" · "}prompt:{" "}
													{b.accounting.reportedPromptTokens === null
														? "unknown"
														: b.accounting.reportedPromptTokens}
													{" · "}completion:{" "}
													{b.accounting.reportedCompletionTokens === null
														? "unknown"
														: b.accounting.reportedCompletionTokens}
													{!b.accounting.usageReportComplete && b.availability !== "not-dispatched"
														? " · usage incomplete"
														: ""}
													{b.accounting.inferenceElapsedMs !== null
														? ` · ${(b.accounting.inferenceElapsedMs / 1000).toFixed(1)}s`
														: ""}
												</dd>
											</div>
											<div>
												<dt>Proposal</dt>
												<dd className="coordinator-muted">
													{b.proposalOutcome}
													{b.proposalRefusal !== null ? ` (${b.proposalRefusal})` : ""}
												</dd>
											</div>
										</dl>
										{b.answer !== null ? (
											<details className="coordinator-evidence">
												<summary>
													<span className="coordinator-evidence-label">
														Untrusted advisory text ({b.standing})
													</span>
												</summary>
												<div className="coordinator-evidence-body">
													<p className="coordinator-ops-answer">{b.answer}</p>
												</div>
											</details>
										) : null}
									</li>
								))}
							</ul>
						)}
					</section>
				</>
			)}
		</div>
	);
}
