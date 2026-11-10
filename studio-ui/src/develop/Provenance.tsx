// What Endophasia saw of the working tree around one attempt (docs/designs/develop-candidate-provenance.md), in the attempt's body, between
// its acceptance ledger and its checks. It answers, in order: what the tree was just before the brief was sent; what it was when the run
// had ended (or at the operator's own later observation); which paths differ between those; whether the tree now, and each commit a check
// ran at, holds the same content as the last of them. It says what Git showed at each moment and never who changed anything: the words
// say so, and every observation can be opened to its own paths. Read-only: nothing here observes, records or runs anything.
import type { ReactElement } from "react";
import {
	BASIS_TEXT,
	type Comparison,
	type HeadMove,
	NOT_COMPARED_TEXT,
	OBSERVATION_LIMITATIONS,
	OBSERVATION_POINT_LABELS,
	OBSERVATION_TRIGGER_TEXT,
	type Observation,
	PROVENANCE_NOTE_TEXT,
	type Provenance as ProvenanceView,
	shownPath,
} from "../model/provenance-wire.ts";

const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const commitOf = (sha: string): string => sha.slice(0, 12);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const CHANGE_LETTER = { added: "A", deleted: "D", modified: "M", mode: "T" } as const;
const CHANGE_WORD = { added: "added", deleted: "deleted", modified: "changed", mode: "mode changed" } as const;
const SHORT_POINT = { "before-send": "Before send", "after-run": "Run ended", operator: "Your observation" } as const;

function headWords(h: HeadMove): string {
	if (h.from === h.to) return `HEAD stayed at ${commitOf(h.from)}`;
	const how =
		h.descends === true
			? `${plural(h.ahead ?? 0, "commit", "commits")} on`
			: h.descends === false
				? "not a descendant: history was rewritten or another branch checked out"
				: "how they relate is unknown";
	return `HEAD ${commitOf(h.from)} → ${commitOf(h.to)} (${how})`;
}

/** The paths of a comparison, folded, each with its letter. */
function Paths({ comparison: c, testid }: { comparison: Comparison; testid: string }): ReactElement | null {
	if (c.relation !== "different") return null;
	return (
		<details className="provenance-paths" data-testid={testid}>
			<summary className="small">
				{plural(c.total, "path", "paths")}
				{c.total > c.paths.length ? ` (the first ${c.paths.length} shown)` : ""}
			</summary>
			<ul className="plain mono small">
				{c.paths.map((p) => (
					<li key={p.path} data-change={p.change}>
						<span className="provenance-letter" title={CHANGE_WORD[p.change]}>
							{CHANGE_LETTER[p.change]}
						</span>{" "}
						{shownPath(p.path)}
					</li>
				))}
			</ul>
		</details>
	);
}

/** One comparison as a short sentence: what it says, against what. */
function Relation({
	comparison: c,
	same,
	different,
	testid,
}: {
	comparison: Comparison;
	same: string;
	different: string;
	testid: string;
}): ReactElement {
	return (
		<span className="provenance-relation" data-relation={c.relation} data-testid={testid}>
			{c.relation === "same"
				? same
				: c.relation === "different"
					? `${plural(c.total, "path differs", "paths differ")} ${different}`
					: `not compared: ${NOT_COMPARED_TEXT[c.reason]}`}
		</span>
	);
}

function PointLine({ observation: o, at }: { observation: Observation; at: "start" | "end" }): ReactElement {
	return (
		<li className="provenance-point" data-point={o.point} data-role={at} data-testid={`provenance-${at}`}>
			<span className="chip-ref" data-observation={o.state}>
				{SHORT_POINT[o.point]}
			</span>
			<span className="provenance-what">
				<span className="dim">{when(o.startedAtMs)}</span>{" "}
				{o.state === "unavailable" ? (
					<span>not observed ({o.reason})</span>
				) : (
					<span>
						HEAD <span className="mono">{commitOf(o.commit as string)}</span>
						{o.branch === null ? (
							" (detached)"
						) : (
							<span className="dim"> {shownPath(o.branch.replace(/^refs\/heads\//, ""))}</span>
						)}
						{", "}
						{o.changed === 0 ? "nothing uncommitted" : plural(o.changed, "uncommitted path", "uncommitted paths")}
						{o.complete ? "" : " (not fully read)"}
						{o.here === false ? <span className="dim"> · another working tree</span> : null}
					</span>
				)}
			</span>
		</li>
	);
}

function ObservationList({ observations }: { observations: readonly Observation[] }): ReactElement {
	return (
		<ul className="plain small provenance-all">
			{observations.map((o) => (
				<li key={o.id} data-testid="provenance-observation" data-point={o.point} data-bound={o.bound ?? "operator"}>
					<p>
						<strong>{OBSERVATION_POINT_LABELS[o.point]}</strong>{" "}
						<span className="dim">{when(o.startedAtMs)}</span>
						{o.bound === "other-send" ? (
							<span className="attempt-changed"> · names another send: not used</span>
						) : null}
					</p>
					<p className="dim">How: {OBSERVATION_TRIGGER_TEXT[o.trigger]}.</p>
					{o.state === "unavailable" ? (
						<p className="dim">Git could not read the working tree then ({o.reason}).</p>
					) : o.paths.length === 0 ? (
						<p className="dim">
							HEAD <span className="mono">{commitOf(o.commit as string)}</span>; Git listed nothing staged,
							unstaged or untracked.
						</p>
					) : (
						<>
							<p className="dim">
								HEAD <span className="mono">{commitOf(o.commit as string)}</span>; what Git listed as
								uncommitted
								{o.changed > o.paths.length ? ` (the first ${o.paths.length} of ${o.changed})` : ""}
								{o.truncated ? "; Git listed more than were recorded" : ""}:
							</p>
							<ul className="plain mono">
								{o.paths.map((p) => (
									<li key={p.path}>
										{shownPath(p.path)} <span className="dim">{p.areas.join(", ")}</span>
										{p.content === "absent" ? <span className="dim"> · deleted</span> : null}
										{p.content === "not-read" ? <span className="dim"> · not read</span> : null}
									</li>
								))}
							</ul>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

export function Provenance({
	provenance: p,
	attemptId,
}: {
	provenance: ProvenanceView;
	attemptId: string;
}): ReactElement {
	const find = (id: string | null): Observation | null =>
		id === null ? null : (p.observations.find((o) => o.id === id) ?? null);
	const start = find(p.start);
	const end = find(p.end);
	const latest = end ?? start;
	// Named by what the latest observation IS (its point and trigger), never by the frame's shape: a lone operator observation is not
	// "before the send", and one taken as the workbench closed with the run open is not "when the run ended".
	const latestName =
		latest === null
			? "the latest observation"
			: latest.point === "before-send"
				? "the observation just before the send"
				: latest.point === "after-run"
					? latest.trigger === "workbench-closing"
						? "the observation taken as the workbench closed (the run had not ended)"
						: "the observation when the run ended"
					: "your latest observation";
	return (
		<div
			className="attempt-provenance"
			data-testid="attempt-provenance"
			data-basis={p.basis ?? "none"}
			data-state={p.state}
		>
			<h4 className="small">
				Working tree around this attempt{" "}
				<span className="dim task-clause">what Git showed at each moment; not who changed it</span>
			</h4>
			{p.state === "unreadable" ? (
				<p className="dim small" data-testid="provenance-unreadable">
					This attempt's observations cannot be read now; there may be some. Nothing was changed.
				</p>
			) : p.state === "none" ? (
				<p className="dim small" data-testid="provenance-none">
					No observation of the working tree is recorded for this attempt.
				</p>
			) : p.basis === null ? (
				<p className="dim small" data-testid="provenance-no-frame">
					No usable observation frames this attempt (see the list below).
				</p>
			) : (
				<>
					<p className="dim small" data-testid="provenance-basis">
						{BASIS_TEXT[p.basis]}.
					</p>
					<ol className="plain provenance-frame">
						{start === null ? null : <PointLine observation={start} at="start" />}
						{p.span === null || p.head === null ? null : (
							<li className="provenance-between small" data-testid="provenance-span">
								<span className="dim">{headWords(p.head)};</span>{" "}
								<Relation
									comparison={p.span}
									same="the same content at every path either lists (ignored files are not compared)"
									different="between them"
									testid="provenance-span-relation"
								/>
								<Paths comparison={p.span} testid="provenance-span-paths" />
							</li>
						)}
						{end === null ? null : <PointLine observation={end} at="end" />}
					</ol>
					{p.now === null ? null : (
						<div
							className="small provenance-now"
							data-testid="provenance-now"
							data-relation={p.now.comparison.relation}
						>
							<strong>Now</strong> <span className="dim">(read {when(p.now.observedAtMs)})</span>:{" "}
							{p.now.head !== null && p.now.head.from !== p.now.head.to ? (
								<span className="dim">{headWords(p.now.head)}; </span>
							) : null}
							<Relation
								comparison={p.now.comparison}
								same={`the same content as ${latestName} (ignored files are not compared)`}
								different={`from ${latestName}`}
								testid="provenance-now-relation"
							/>
							<Paths comparison={p.now.comparison} testid="provenance-now-paths" />
						</div>
					)}
					{p.checked.length === 0 || latest === null ? null : (
						<ul className="plain small provenance-checked" data-testid="provenance-checked">
							{p.checked.map((c) => (
								<li
									key={c.commit}
									data-relation={c.comparison.relation}
									data-testid="provenance-checked-commit"
								>
									Checked at <span className="mono">{commitOf(c.commit)}</span>{" "}
									<span className="dim">({plural(c.receipts, "receipt", "receipts")})</span>:{" "}
									<Relation
										comparison={c.comparison}
										same={`the same content as ${latestName} (ignored files are not compared)`}
										different={`from ${latestName}`}
										testid="provenance-checked-relation"
									/>
									<Paths comparison={c.comparison} testid="provenance-checked-paths" />
								</li>
							))}
						</ul>
					)}
				</>
			)}
			{p.overlaps.length === 0 ? null : (
				<p className="small attempt-changed" data-testid="provenance-overlaps">
					{plural(p.overlaps.length, "other attempt was", "other attempts were")} observed in this working tree
					within this frame (<span className="mono">{p.overlaps.map((id) => id.slice(-8)).join(", ")}</span>):
					their work may have overlapped.
				</p>
			)}
			{p.notes.map((n) => (
				<p key={n} className="dim small" data-testid="provenance-note" data-note={n}>
					{PROVENANCE_NOTE_TEXT[n]}
				</p>
			))}
			{p.observations.length === 0 ? null : (
				<details className="provenance-details" data-testid="provenance-details">
					<summary className="small">
						Every observation ({p.observations.length}) and what they do not establish
					</summary>
					<ObservationList observations={p.observations} />
					<ul className="small dim provenance-limits">
						{OBSERVATION_LIMITATIONS.map((l) => (
							<li key={l}>{l}</li>
						))}
					</ul>
				</details>
			)}
			<p className="dim small">Record an observation yourself (it reads the tree; it runs nothing):</p>
			<pre className="mono task-command">{`endo attempt observe --root <store> --attempt ${attemptId}\nendo attempt provenance --root <store> --attempt ${attemptId}`}</pre>
		</div>
	);
}
