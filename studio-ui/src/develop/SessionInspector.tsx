// The session inspector: identity, qualification, source condition, recorded lifecycle counts, usage per run and evidence references.
// Every row is a field of the DEVELOP record or says why it is unavailable. Nothing here is a verdict about the session.
import type { ReactElement, ReactNode } from "react";
import type { EndoCockpitDevelopSessionV0 } from "../../../protocol/cockpit-develop.ts";
import { dim, type Fact, mono, parts, plain, textCell, textModel, unavailableCell } from "../model/cells.ts";
import { STATE_WORDING } from "../model/develop.ts";
import { known, SOURCE_STATE } from "../model/labels.ts";
import { duration, eventLogSourceView, grouped } from "../model/views.ts";
import { ConditionTag, FactsView, Note, TextView } from "../ui/text.tsx";
import { StateTag } from "./Navigator.tsx";

const Block = ({ title, children }: { title: string; children: ReactNode }): ReactElement => (
	<section className="block">
		<h3>{title}</h3>
		{children}
	</section>
);

export function SessionInspector({ detail }: { detail: EndoCockpitDevelopSessionV0 }): ReactElement {
	const row = detail.session;
	const recorded = row.recorded!;
	const life = detail.lifecycle!;
	const source = eventLogSourceView(detail.source);
	const described = known(SOURCE_STATE, detail.source.condition.state);
	const identity: Fact[] = [
		{ label: "source", cell: plain(row.label) },
		{ label: "alias", cell: textCell(row.session, { mono: true, copy: "session alias" }) },
		{
			label: "attachment",
			cell:
				detail.attachment === null
					? row.source === "dsh"
						? dim("none: a DSH recording has no attachment")
						: unavailableCell("The attachment name is not presentable.")
					: textCell(detail.attachment, { mono: true }),
		},
		{
			label: "project",
			cell: unavailableCell("The recorded evidence does not establish a project for this session."),
		},
		{
			label: "process now",
			cell: unavailableCell("Not checked. This page reads recordings; it does not detect live processes."),
		},
	];
	const counts: [string, number][] = [
		["runs", life.counts.runs],
		["turns", life.counts.turns],
		["completed", life.counts.completed],
		["failed", life.counts.failed],
		["aborted", life.counts.aborted],
		["interrupted", life.counts.interrupted],
		["unclassified", life.counts.unclassified],
		["compactions", life.counts.compactions],
	];
	return (
		<div className="detail" data-testid="session-detail">
			<Block title="Identity">
				<FactsView facts={identity} label="Session identity" />
			</Block>
			<Block title="Recorded lifecycle">
				<p>
					<StateTag state={recorded.state} />
				</p>
				<p className="dim small">{STATE_WORDING[recorded.state].meaning}</p>
				<p className="develop-counts">
					<span className="sr-only">Lifecycle counts from the recorded events: </span>
					{counts.map(([name, value]) => (
						<span key={name}>
							<b>{grouped(value)}</b> {name}
						</span>
					))}
				</p>
				<p className="develop-counts">
					<span>
						stop requested <b>{grouped(life.counts.stopsRequested)}</b>
					</span>
					<span>
						accepted <b>{grouped(life.counts.stopsAccepted)}</b>
					</span>
					<span>
						refused <b>{grouped(life.counts.stopsRefused)}</b>
					</span>
					<span>
						attachments <b>{grouped(life.attachments.count)}</b> ({grouped(life.attachments.resumes)} resumes)
					</span>
				</p>
				{life.open === null ? null : (
					<p className="dim small">
						A run was open at the last recorded event: {grouped(life.open.turns)} turn
						{life.open.turns === 1 ? "" : "s"} so far
						{life.open.turnOpen ? ", one still open" : ""}
						{life.open.stopRequested ? "; stop was requested" : ""}
						{life.open.stopAccepted ? " and accepted" : ""}. That is a recorded fact about the last event.
					</p>
				)}
				{life.anomalies + life.unrecognized === 0 ? null : (
					<Note tone="warn">
						{life.anomalies > 0
							? `${life.anomalies} recorded event${life.anomalies === 1 ? "" : "s"} arrived out of lifecycle order. `
							: ""}
						{life.unrecognized > 0
							? `${life.unrecognized} lifecycle event${life.unrecognized === 1 ? "" : "s"} of a kind this version does not define.`
							: ""}
					</Note>
				)}
			</Block>
			<Block title="Source condition">
				<p>
					<ConditionTag
						state={detail.source.condition.state}
						label={described?.label ?? null}
						meaning={described?.meaning ?? null}
					/>
				</p>
				{detail.source.condition.state === "degraded" ? (
					<Note tone="warn">
						The log is degraded: events after position {grouped(detail.source.watermark?.length ?? 0)} are not
						readable here. A torn tail can be an append in flight.
					</Note>
				) : null}
				<dl className="facts" aria-label="Event log position">
					{source.facts.map((fact) => (
						<div className="fact" key={fact.label}>
							<dt>{fact.label}</dt>
							<dd className="mono small">{fact.value}</dd>
						</div>
					))}
				</dl>
				<p className="dim small">
					One read of the event log. Selections and pages are valid only for the prefix read here; any append or
					rewrite invalidates them.
				</p>
			</Block>
			<Block title="Usage, per run, as the runtime reported it">
				{detail.runs.status === "unavailable" ? (
					<Note>
						<TextView text={textModel(detail.runs.reason)} />
					</Note>
				) : (
					<>
						<div className="table-scroll">
							<table className="runs-table">
								<caption className="sr-only">
									Per-run outcome, usage and observer-measured wall time. Not summed.
								</caption>
								<thead>
									<tr>
										<th scope="col">Run</th>
										<th scope="col">Outcome</th>
										<th scope="col">Tokens in · out</th>
										<th scope="col">Wall time (observer)</th>
									</tr>
								</thead>
								<tbody>
									{detail.runs.entries.map((run) => (
										<tr key={run.run}>
											<th scope="row">{run.run}</th>
											<td>
												{run.outcome}
												{run.stopRequested ? " · stop requested" : ""}
											</td>
											<td>
												{run.tokens.status === "reported" ? (
													<span className="mono">
														{grouped(run.tokens.value.input)} · {grouped(run.tokens.value.output)}
													</span>
												) : (
													<span className="unavailable" title={run.tokens.reason}>
														not reported
													</span>
												)}
											</td>
											<td>
												{run.wallMs.status === "reported" ? (
													<span className="mono">{duration(run.wallMs.value)}</span>
												) : (
													<span className="unavailable" title={run.wallMs.reason}>
														not measured
													</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="dim small">
							Not added up: one call can be recorded by more than one event. A missing figure is "not reported",
							never zero.
							{detail.runs.total > detail.runs.entries.length
								? ` Showing the first ${detail.runs.entries.length} of ${grouped(detail.runs.total)} runs.`
								: ""}
						</p>
					</>
				)}
			</Block>
			{life.unavailable.length === 0 ? null : (
				<Block title="Not reported by the runtime">
					<ul className="plain">
						{life.unavailable.map((item) => (
							<li key={item.field}>
								<span className="mono">{item.field}</span>: <span className="dim">{item.reason}</span>
							</li>
						))}
					</ul>
				</Block>
			)}
			<Block title="Evidence">
				<FactsView
					label="Evidence references"
					facts={[
						{
							label: "events",
							cell: parts(
								plain(grouped(row.events)),
								dim(
									` at log positions ${grouped(row.firstStorageSequence)}–${grouped(row.lastStorageSequence)}`,
								),
							),
						},
						{ label: "first event", cell: mono(`position ${grouped(row.firstStorageSequence)}`) },
						{ label: "last event", cell: mono(`position ${grouped(row.lastStorageSequence)}`) },
					]}
				/>
				<p className="dim small">
					Capabilities and the recorded runtime are shown for each attachment in Observe, not here.
				</p>
			</Block>
		</div>
	);
}
