// Drawing the small models: text told apart by what it is, a basis, a cell, a list of facts. These switch over data and format
// nothing; a string reaches the page only as a React text child, which the browser takes as text and never as markup.
import type { ReactElement, ReactNode } from "react";
import type { BasisMark, Cell, Fact, TextModel } from "../model/cells.ts";
import { ConditionGlyph, ProvGlyph } from "./marks.tsx";

export function BasisBadge({ mark }: { mark: BasisMark }): ReactElement {
	return (
		<span className={`basis basis-${mark.known ? mark.basis : "unknown"}`} title={mark.meaning}>
			<ProvGlyph kind={mark.known ? mark.basis : "unknown"} size={10} />
			<span aria-hidden="true">{mark.short}</span>
			<span className="sr-only">{mark.label}</span>
		</span>
	);
}

export function TextView({ text }: { text: TextModel }): ReactElement {
	if (text.kind === "withheld")
		return (
			<span className="withheld" title={text.full}>
				withheld
			</span>
		);
	if (text.kind === "alias")
		return (
			<span className="alias" title={`${text.full}\n(a generated alias: the original is not presented)`}>
				<span className="alias-tag">alias</span>
				<code>{text.shown}</code>
			</span>
		);
	return (
		<span className={text.mono ? "mono" : undefined} title={text.full}>
			{text.shown}
		</span>
	);
}

export function CellView({ cell }: { cell: Cell }): ReactElement {
	switch (cell.k) {
		case "plain":
			return <>{cell.text}</>;
		case "mono":
			return (
				<span className="mono" title={cell.title}>
					{cell.text}
				</span>
			);
		case "dim":
			return (
				<span className="dim" title={cell.title}>
					{cell.text}
				</span>
			);
		case "text":
			return <TextView text={cell.text} />;
		case "unavailable":
			return (
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
						<TextView text={cell.reason} />
					</span>
				</span>
			);
		case "claim":
			return (
				<span className="claim">
					<span className="claim-value">
						<CellView cell={cell.inner} />
					</span>
					<BasisBadge mark={cell.basis} />
				</span>
			);
		case "parts":
			return (
				<span>
					{cell.parts.map((part, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered sequence of parts; never reordered
						<CellView key={index} cell={part} />
					))}
				</span>
			);
		case "list":
			return (
				<ul className="plain">
					{cell.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list; never reordered
						<li key={index}>
							<CellView cell={item} />
						</li>
					))}
				</ul>
			);
		case "disclosure":
			return (
				<details className="dim">
					<summary title={cell.title}>{cell.summary}</summary>
					<span className="mono small">{cell.body}</span>
				</details>
			);
	}
}

export function FactsView({ facts, label }: { facts: readonly Fact[]; label?: string }): ReactElement {
	return (
		<dl className="facts" aria-label={label}>
			{facts.map((fact) => (
				<div className="fact" key={fact.label}>
					<dt>{fact.label}</dt>
					<dd>
						<CellView cell={fact.cell} />
					</dd>
				</div>
			))}
		</dl>
	);
}

export function ConditionTag({
	state,
	label,
	meaning,
}: {
	state: string;
	label: string | null;
	meaning: string | null;
}): ReactElement {
	return (
		<span
			className={`state state-${label === null ? "unknown" : state}`}
			title={meaning ?? "A condition this build does not know."}
		>
			<ConditionGlyph state={state} />
			<span>{label ?? state}</span>
		</span>
	);
}

export function Note({
	tone = "info",
	children,
	testid,
}: {
	tone?: "info" | "warn" | "error";
	children: ReactNode;
	testid?: string;
}): ReactElement {
	return (
		<p className={`note note-${tone}`} role={tone === "error" ? "alert" : "note"} data-testid={testid}>
			{children}
		</p>
	);
}
