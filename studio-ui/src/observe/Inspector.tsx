// The inspector: one selected event or capability, in full, with its provenance. It says what the record establishes and what it does
// not. Nothing here is a new claim: every row is a field of a record the projection returned, with the basis it carries. Before
// anything is selected it is the legend that says how to read the marks.
import type { ReactElement, ReactNode } from "react";
import type { CapabilityDetail, EventDetail } from "../model/detail.ts";
import { type InspectorModel, type LegendModel, legendModel } from "../model/observe.ts";
import { ProvGlyph, StatusGlyph } from "../ui/marks.tsx";
import { BasisBadge, CellView, ConditionTag, FactsView, Note, TextView } from "../ui/text.tsx";

const Block = ({ title, children }: { title: string; children: ReactNode }): ReactElement => (
	<section className="block">
		<h3>{title}</h3>
		{children}
	</section>
);

function EventView({ detail, hidden }: { detail: EventDetail; hidden: boolean }): ReactElement {
	return (
		<div className="detail" data-testid="event-detail">
			<h3 className="detail-title">{detail.title}</h3>
			{hidden ? (
				<Note tone="info">The filters now set hide this event from the table. It is still in the window.</Note>
			) : null}
			<FactsView facts={detail.facts} label="Recorded identity" />
			<p className="dim small">
				Position is the order. The producer clock is the producer's own reading and can run backwards.
			</p>
			{detail.flags.length === 0 ? null : (
				<ul className="plain flags-list">
					{detail.flags.map((flag) => (
						<li key={flag.flag}>
							<span className={`flag flag-${flag.flag}`}>{flag.label}</span> {flag.meaning}
						</li>
					))}
				</ul>
			)}
			<Block title="Presented fields">
				{detail.fields.length === 0 ? (
					<Note>
						No payload field is approved for presentation for this kind. The event is recorded; nothing about its
						content is shown.
					</Note>
				) : (
					<table className="fields">
						<thead>
							<tr>
								<th scope="col">Field</th>
								<th scope="col">Value, and how it is known</th>
							</tr>
						</thead>
						<tbody>
							{detail.fields.map((field) => (
								<tr key={field.name}>
									<th scope="row" className="mono">
										{field.name}
									</th>
									<td>
										<CellView cell={field.cell} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<p className="dim small">{detail.withheldNote}</p>
			</Block>
			<Block title="Usage, as reported for this event">
				{detail.usage.kind === "never" ? (
					<span className="dim">This kind of event does not carry usage.</span>
				) : detail.usage.kind === "not-recorded" ? (
					<span className="unavailable">
						<BasisBadge
							mark={{
								basis: "unavailable",
								short: "N/A",
								label: "unavailable",
								meaning: "There is no value, for the reason shown.",
								known: true,
							}}
						/>
						<span className="reason">
							<TextView text={detail.usage.reason} />
						</span>
					</span>
				) : (
					<div>
						<FactsView facts={detail.usage.facts} label="Usage" />
						<p className="dim small">Not added up: one call can be recorded by more than one event.</p>
					</div>
				)}
			</Block>
			<details className="raw">
				<summary>Projection JSON of this entry</summary>
				<pre>{detail.raw}</pre>
			</details>
		</div>
	);
}

function CapabilityView({ detail }: { detail: CapabilityDetail }): ReactElement {
	return (
		<div className="detail" data-testid="capability-detail">
			<h3 className="detail-title">
				<TextView text={detail.name} />
			</h3>
			<dl className="facts">
				<div className="fact">
					<dt>recorded status</dt>
					<dd>
						<span className="status-line" data-status={detail.status}>
							<StatusGlyph status={detail.status} /> {detail.statusLabel}
							<span className="dim"> — {detail.statusMeaning}</span>
						</span>
					</dd>
				</div>
			</dl>
			<FactsView facts={detail.facts} label="Recorded state" />
			<Block title="Limits on this status">
				{detail.limits.length === 0 ? (
					<span className="dim">{detail.noLimitsText}</span>
				) : (
					<ul className="limits">
						{detail.limits.map((limit, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a limit code can repeat with different refs; the list is fixed
							<li key={index}>
								{limit.text ?? <code>{limit.code}</code>}
								{limit.refs === "" ? null : <span className="dim small">{` (${limit.refs})`}</span>}
							</li>
						))}
					</ul>
				)}
			</Block>
			<Block title="Evidence">
				{detail.evidence === null ? (
					<span className="dim">{detail.noEvidenceText}</span>
				) : (
					<FactsView facts={detail.evidence} label="Cited evidence" />
				)}
				{detail.limitations.length === 0 ? null : (
					<div>
						<h4>Limitations the evidence states</h4>
						<ul className="plain">
							{detail.limitations.map((l, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of recorded sentences
								<li key={index}>
									<TextView text={l} />
								</li>
							))}
						</ul>
					</div>
				)}
			</Block>
		</div>
	);
}

function Legend({ legend }: { legend: LegendModel }): ReactElement {
	return (
		<div className="legend" data-testid="legend">
			<p className="lead">Select an event or a capability to see exactly what was recorded, and where.</p>
			<h3>How a value is known</h3>
			<ul className="plain">
				{legend.bases.map((mark) => (
					<li key={mark.basis}>
						<BasisBadge mark={mark} /> <span className="dim">{mark.meaning}</span>
					</li>
				))}
			</ul>
			<h3>What a mark on the overview stands for</h3>
			<ul className="plain">
				{legend.marks.map((mark) => (
					<li key={mark.markClass}>
						<ProvGlyph kind={mark.markClass} size={11} /> {mark.label} <span className="dim">{mark.meaning}</span>
					</li>
				))}
			</ul>
			<h3>Flags on an event</h3>
			<ul className="plain">
				{legend.flags.map((flag) => (
					<li key={flag.flag}>
						<span className={`flag flag-${flag.flag}`}>{flag.label}</span>{" "}
						<span className="dim">{flag.meaning}</span>
					</li>
				))}
			</ul>
			<h3>Source conditions</h3>
			<ul className="plain">
				{legend.conditions.map((c) => (
					<li key={c.state}>
						<ConditionTag state={c.state} label={c.label} meaning={c.meaning} />{" "}
						<span className="dim">{c.meaning}</span>
					</li>
				))}
			</ul>
			<h3>Recorded capability status</h3>
			<ul className="plain">
				{legend.statuses.map((s) => (
					<li key={s.status} data-status={s.status}>
						<StatusGlyph status={s.status} /> {s.label} <span className="dim">{s.meaning}</span>
					</li>
				))}
			</ul>
			<p className="dim small">
				The timeline is in storage order. Recorded times are the producers' own clocks. A projection of records is
				not evidence in itself.
			</p>
		</div>
	);
}

const LEGEND = legendModel();

export function InspectorBody({
	model,
	clearedNote,
}: {
	model: InspectorModel;
	clearedNote: string | null;
}): ReactElement {
	switch (model.kind) {
		case "legend":
			return (
				<>
					{clearedNote === null ? null : (
						<Note tone="info" testid="cleared-note">
							{clearedNote}
						</Note>
					)}
					<Legend legend={LEGEND} />
				</>
			);
		case "event":
			return <EventView detail={model.detail} hidden={model.hiddenByFilters} />;
		case "capability":
			return <CapabilityView detail={model.detail} />;
		case "gone":
			return <Note tone="warn">{model.text}</Note>;
	}
}
