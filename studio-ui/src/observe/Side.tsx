// The runtime, capability and source panels: which runtime an attachment records, its capabilities status by status as recorded, and
// where every shown value was read from, each source on its own. Every value is a claim with its basis or an explicit unavailable mark.
import type { ReactElement } from "react";
import type { CapabilitiesModel, NoteModel, RuntimeModel, SourcesModel } from "../model/detail.ts";
import type { Action } from "../model/state.ts";
import { StatusGlyph } from "../ui/marks.tsx";
import { CellView, ConditionTag, FactsView, Note, TextView } from "../ui/text.tsx";

const Notes = ({ notes }: { notes: NoteModel[] }): ReactElement | null =>
	notes.length === 0 ? null : (
		<ul className="notes">
			{notes.map((n, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of notes
				<li key={index}>
					{n.text ?? <code>{n.code}</code>}
					{n.refs === "" ? null : <span className="dim">{` (${n.refs})`}</span>}
				</li>
			))}
		</ul>
	);

export function RuntimeTools({
	model,
	dispatch,
}: {
	model: RuntimeModel;
	dispatch: (a: Action) => void;
}): ReactElement | null {
	if (model.choices.length < 2) return null;
	return (
		<label className="select-label">
			<span className="sr-only">Attachment</span>
			<select
				aria-label="Attachment"
				data-focus="attachment"
				value={model.choices.find((c) => c.selected)?.attachment ?? ""}
				onChange={(event) => dispatch({ type: "select-attachment", name: event.target.value })}
			>
				{model.choices.map((c) => (
					<option key={c.attachment} value={c.attachment}>
						{c.label}
					</option>
				))}
			</select>
		</label>
	);
}

export function RuntimePanel({ model }: { model: RuntimeModel }): ReactElement {
	const a = model.attachment;
	if (a === null) return <Note>{model.noRegistryText}</Note>;
	return (
		<>
			<div className="source-line">
				<ConditionTag state={a.condition.state} label={a.condition.label} meaning={a.condition.meaning} />
				<span className="mono dim">registry · {a.name}</span>
			</div>
			{a.unopenableText === null ? null : <Note tone="error">{a.unopenableText}</Note>}
			<dl className="facts">
				<div className="fact">
					<dt>runtime</dt>
					<dd>
						<CellView cell={a.runtime} />
					</dd>
				</div>
			</dl>
			<section className="block">
				<h3>Current fingerprint</h3>
				{a.current === null ? (
					<Note>{a.currentText}</Note>
				) : (
					<FactsView facts={a.current} label="Current fingerprint" />
				)}
			</section>
			{a.neitherRecorded ? (
				<dl className="facts">
					<div className="fact">
						<dt>last change</dt>
						<dd className="dim">none recorded</dd>
					</div>
					<div className="fact">
						<dt>notification</dt>
						<dd className="dim">none recorded</dd>
					</div>
				</dl>
			) : null}
			{a.lastChange === null ? null : (
				<section className="block">
					<h3>Last recorded change</h3>
					<FactsView facts={a.lastChange} label="Last recorded change" />
				</section>
			)}
			{a.lastNotification === null ? null : (
				<section className="block">
					<h3>Last notification</h3>
					<FactsView facts={a.lastNotification} label="Last notification" />
				</section>
			)}
			{a.previousDifferent === null ? null : (
				<section className="block">
					<h3>Latest earlier observation with a different identity</h3>
					<FactsView facts={a.previousDifferent} label="Earlier observation" />
				</section>
			)}
			<Notes notes={a.notes} />
		</>
	);
}

export function CapabilitiesPanel({
	model,
	dispatch,
}: {
	model: CapabilitiesModel;
	dispatch: (a: Action) => void;
}): ReactElement {
	if (model.kind === "no-registry") return <Note>{model.text}</Note>;
	if (model.kind === "no-state")
		return (
			<>
				<Note tone={model.tone}>{model.text}</Note>
				<Notes notes={model.notes} />
			</>
		);
	return (
		<>
			<div className="cap-state">
				<span className={`currency currency-${model.currency.tone}`} title={model.currency.meaning}>
					{model.currency.label}
				</span>
				<span className="dim"> state recorded </span>
				<span className="mono iso">{model.recordedAt}</span>
			</div>
			<p className="dim small">
				For fingerprint{" "}
				{model.fingerprint === null ? (
					<span className="withheld">none named</span>
				) : (
					<TextView text={model.fingerprint} />
				)}
				. Latest recorded: {model.latest === null ? "none" : <TextView text={model.latest} />}.
			</p>
			{model.rows.length === 0 ? (
				<Note>{model.emptyText}</Note>
			) : (
				<ul className="counts plain" aria-label="capabilities by recorded status">
					{model.counts.map((c) => (
						<li key={c.status} className="count" data-status={c.status}>
							<StatusGlyph status={c.status} /> {c.count} {c.label}
						</li>
					))}
				</ul>
			)}
			<ul className="caplist">
				{model.rows.map((row) => (
					<li key={row.key}>
						<button
							type="button"
							className="caprow"
							aria-pressed={row.selected}
							data-status={row.status}
							data-key={row.key}
							title={row.statusMeaning}
							onClick={() => dispatch({ type: "select", selection: { kind: "capability", name: row.key } })}
						>
							<span className="cap-status">
								<StatusGlyph status={row.status} />
							</span>
							<span className="cap-name">
								<TextView text={row.name} />
							</span>
							<span className="cap-status-label">{row.statusLabel}</span>
							<span
								className={row.hasClassification ? "cap-class" : "cap-class none"}
								title="the classification this capability state records (the cited evidence records its own: see the inspector)"
							>
								{row.classification}
							</span>
							{row.limits === 0 ? null : (
								<span className="cap-limits" title="reasons this status cannot be taken at face value">
									{`${row.limits} limit${row.limits === 1 ? "" : "s"}`}
								</span>
							)}
						</button>
					</li>
				))}
			</ul>
			<Notes notes={model.notes} />
		</>
	);
}

export function SourcesPanel({ model, readLine }: { model: SourcesModel; readLine: string }): ReactElement {
	return (
		<>
			<p className="independent">
				<strong>Independent sources. </strong>Opened one after another; no shared sequence or moment.
			</p>
			{model.cards.map((card) => (
				<article
					key={card.id}
					className={`source${card.current ? " current" : ""}`}
					data-state={card.condition.state}
				>
					<header>
						<h3>{card.title}</h3>
						<ConditionTag
							state={card.condition.state}
							label={card.condition.label}
							meaning={card.condition.meaning}
						/>
					</header>
					{card.meaning === null ? null : <p className="dim small">{card.meaning}</p>}
					{card.positioned ? (
						<FactsView facts={card.facts} label={`${card.title} position`} />
					) : (
						<Note>
							This source has no position: nothing was read from it, which is not the same as a log of length
							zero.
						</Note>
					)}
					{card.tornTail === null ? null : <p className="small warn-text">{card.tornTail}</p>}
					{card.sealedAt === null ? null : <p className="small warn-text">{card.sealedAt}</p>}
					{card.error === null ? null : <p className="small error-text">{card.error}</p>}
				</article>
			))}
			{model.noRegistryText === null ? null : <Note>{model.noRegistryText}</Note>}
			{model.timelineNotes.length === 0 ? null : (
				<section className="block">
					<h3>Timeline notes</h3>
					<Notes notes={model.timelineNotes} />
				</section>
			)}
			<p className="dim small read-line">{readLine}</p>
		</>
	);
}
