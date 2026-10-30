// The live conversation: what a connected Pi session is saying and doing, and the one governed input path. Nothing here is recorded
// evidence. The text is the broker's private, in-memory transcript; the page says so. A prompt, steer, queue or stop can only be
// REQUESTED here: the operator approves it in the attached terminal, and a refused or unapproved request is shown as not sent. What each
// card claims stops where the evidence stops: acceptance is Pi's reply, consumption is proxy evidence, and a run's end is Pi's report.
import { type FormEvent, type KeyboardEvent, type ReactElement, useId, useRef, useState } from "react";
import { presentLivePi } from "../model/develop-session.ts";
import {
	COMMAND_WORDS,
	commandOpen,
	interventionOpen,
	interventionWords,
	OPERATION_WORDS,
	REFUSAL_WORDS,
	RUN_END_WORDS,
	runStripWords,
	stopInFlight,
} from "../model/workbench.ts";
import type { TranscriptItem, WorkbenchIntervention } from "../model/workbench-wire.ts";
import { ConnectionGlyph } from "../ui/marks.tsx";
import { Panel } from "../ui/Panel.tsx";
import { Note } from "../ui/text.tsx";
import type { useWorkbench } from "../use-workbench.ts";
import { SurfaceTag, SurfaceView } from "./Surface.tsx";

export type Workbench = ReturnType<typeof useWorkbench>;
const clock = (at: Date | null): string => (at === null ? "" : at.toLocaleTimeString([], { hour12: false }));
const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
export const shortSession = (alias: string): string => alias.replace(/^endo\.session\./, "");

/** The Connected row of the session rail. */
export function LiveRow({
	wb,
	selected,
	onSelect,
}: {
	wb: Workbench;
	selected: boolean;
	onSelect(): void;
}): ReactElement {
	const { status, unreachable } = wb.state;
	const connection = status === null || unreachable ? "unknown" : status.connection;
	return (
		<button
			type="button"
			className="caprow session-row live-row"
			aria-pressed={selected}
			data-testid="live-row"
			data-session-row=""
			onClick={onSelect}
		>
			<span className="session-name mono">
				{status?.session === null || status === null ? "pi session" : shortSession(status.session)}
			</span>
			<span className="session-state">
				<span className="state state-life" data-conn={connection}>
					<ConnectionGlyph state={connection} />
					<span>{runStripWords(status, unreachable)}</span>
				</span>
			</span>
			<SurfaceTag session={presentLivePi(status, unreachable)} />
			<span className="session-meta">
				{connection === "connected"
					? "Pi · admitted by this broker"
					: connection === "disconnected"
						? "Pi · no admitted connection now"
						: "Pi · connection unknown"}{" "}
				· live text is private
			</span>
		</button>
	);
}

type Row =
	| { kind: "item"; item: TranscriptItem }
	| { kind: "tools"; items: Extract<TranscriptItem, { kind: "tool" }>[] };

/** Three or more tool calls in a row become one folded line; errors, messages and run markers are never folded. */
function rowsOf(items: readonly TranscriptItem[]): Row[] {
	const rows: Row[] = [];
	let run: Extract<TranscriptItem, { kind: "tool" }>[] = [];
	const flush = () => {
		if (run.length >= 3) rows.push({ kind: "tools", items: run });
		else for (const item of run) rows.push({ kind: "item", item });
		run = [];
	};
	for (const item of items) {
		if (item.kind === "tool") run.push(item);
		else {
			flush();
			rows.push({ kind: "item", item });
		}
	}
	flush();
	return rows;
}

function Turn({ item }: { item: TranscriptItem }): ReactElement {
	if (item.kind === "run")
		return (
			<li className="turn-run" data-testid="run-marker">
				<span>{item.state === "started" ? "run started" : "run ended"}</span>
			</li>
		);
	if (item.kind === "tool")
		return (
			<li className={`turn turn-tool tool-${item.status}`} data-testid="tool-row">
				<span className="turn-role">tool</span>
				<span className="turn-body mono">
					{item.name}{" "}
					<span className="dim">
						· {item.status === "running" ? "running" : item.status === "ok" ? "ok" : "error (reported)"}
					</span>
				</span>
			</li>
		);
	return (
		<li className={`turn turn-${item.role}`} data-testid={`turn-${item.role}`}>
			<span className="turn-role">{item.role === "user" ? "user" : "assistant"}</span>
			<div className="turn-body">
				<p className="turn-text">{item.text}</p>
				<p className="turn-meta">
					<span
						className="live-tag"
						title="This text exists only in the attached process's memory. It is not recorded evidence and is cleared when the session ends."
					>
						live · private, cleared at session end
					</span>
					{item.truncated ? <span className="dim"> · cut at the display limit</span> : null}
					{item.stopReason === "error" ? <span className="flag flag-anomaly"> run error (reported)</span> : null}
				</p>
			</div>
		</li>
	);
}

function InterventionCard({ wb, i }: { wb: Workbench; i: WorkbenchIntervention }): ReactElement {
	const { name } = OPERATION_WORDS[i.operation];
	const text = wb.sentText[i.proposalId];
	const reached =
		i.state === "sent" || i.state === "accepted" || i.state === "unknown" || i.reason === "runtime-refused";
	const replied = i.state === "accepted" || i.reason === "runtime-refused";
	const expires = new Date(i.expiresAtMs).toLocaleTimeString([], { hour12: false });
	const message = i.operation !== "stop";
	return (
		<li
			className="turn turn-intervention"
			data-testid="intervention-card"
			data-op={i.operation}
			data-state={i.state}
			aria-label={`${name} request`}
		>
			<span className="turn-role">{i.operation}</span>
			<div className="turn-body">
				<p className="intervention-head">
					<strong>{interventionWords(i)}</strong>
					{i.state === "refused" && i.reason !== null && i.reason !== "runtime-refused" ? (
						<span>: {REFUSAL_WORDS[i.reason] ?? i.reason}</span>
					) : null}
				</p>
				{text === undefined ? null : (
					<p className="turn-text">
						{text} <span className="live-tag">· live · private, cleared at session end</span>
					</p>
				)}
				<ol className="chain" aria-label="Steps">
					<li data-done="true">requested</li>
					<li data-done={i.approved}>approved in the terminal</li>
					<li data-done={reached}>sent to Pi</li>
					<li data-done={replied}>{i.reason === "runtime-refused" ? "Pi refused" : "Pi replied"}</li>
					{message ? <li data-done={i.consumption?.status === "observed"}>consumption observed</li> : null}
					<li data-done={i.runEnded !== null}>run ended</li>
				</ol>
				{i.state === "awaiting-approval" ? (
					<>
						<p className="small">
							{i.bytes === null ? "no message" : `${i.bytes} bytes`} · digest{" "}
							<span className="mono">{i.digestPrefix}</span> · expires {expires} (browser clock) · single use.
							Type the approval phrase shown in the attached terminal. A local confirmation, not proof of
							identity. This page cannot approve it.
						</p>
						<button
							type="button"
							className="btn small-btn"
							data-testid="withdraw"
							onClick={() => void wb.withdraw(i.proposalId)}
						>
							Withdraw
						</button>
					</>
				) : null}
				{message && i.state === "accepted" ? (
					<div className="small" data-testid="consumption">
						{i.consumption === null ? (
							<p>
								Consumption: <strong>not checked</strong>. Acceptance does not show the message was used. It can
								be checked against the recording proxy&apos;s capture, and is checked when the session closes.
							</p>
						) : i.consumption.status === "observed" ? (
							<p>
								Consumption: <strong>observed</strong> in captured request {i.consumption.exchange}, which
								carried the message one more time than the request before it. That shows the model was sent it;
								it does not show it helped.
							</p>
						) : (
							<p>
								Consumption: <strong>not established</strong>. {i.consumption.reason}
							</p>
						)}
						{i.consumption?.status === "observed" ? null : (
							<button
								type="button"
								className="btn small-btn"
								data-testid="check-evidence"
								onClick={() => void wb.check(i.proposalId)}
							>
								{i.consumption === null ? "Check evidence" : "Check again"}
							</button>
						)}
					</div>
				) : null}
				{i.runEnded === null ? null : (
					<p className="small dim" data-testid="run-ended">
						The run this was made in {RUN_END_WORDS[i.runEnded]}. That is not shown to be caused by this request.
					</p>
				)}
				{i.state === "accepted" && i.operation === "stop" && i.runEnded === null ? (
					<p className="small dim">Pi replied, but no end of the run has been seen yet.</p>
				) : null}
				{interventionOpen(i) ? null : i.state === "accepted" || i.state === "unknown" ? (
					<p className="small dim">The effect and the consequence are recorded when the session closes.</p>
				) : null}
			</div>
		</li>
	);
}

function Transcript({ wb }: { wb: Workbench }): ReactElement {
	const { state } = wb;
	const rows = rowsOf(state.items);
	// Each intervention card sits after the last row it followed in time (the transcript position when it was requested).
	const cards = [...state.interventions].sort((a, b) => a.afterSeq - b.afterSeq);
	const out: ReactElement[] = [];
	let next = 0;
	const flush = (before: number) => {
		while (next < cards.length && cards[next]!.afterSeq < before) {
			out.push(<InterventionCard key={cards[next]!.proposalId} wb={wb} i={cards[next]!} />);
			next += 1;
		}
	};
	for (const row of rows) {
		const first = row.kind === "item" ? row.item.seq : (row.items[0]?.seq ?? 0);
		flush(first);
		out.push(
			row.kind === "item" ? (
				<Turn key={row.item.seq} item={row.item} />
			) : (
				<li key={row.items[0]!.seq} className="turn turn-tool">
					<span className="turn-role">tools</span>
					<details className="turn-body">
						<summary>
							{row.items.length} tool calls
							{row.items.some((i) => i.status === "error")
								? ` (${row.items.filter((i) => i.status === "error").length} error)`
								: ""}
						</summary>
						<ul className="plain">
							{row.items.map((i) => (
								<li key={i.seq} className="mono">
									{i.name} <span className="dim">· {i.status}</span>
								</li>
							))}
						</ul>
						<p className="dim small">Tool arguments and results are not kept by the workbench.</p>
					</details>
				</li>
			),
		);
	}
	flush(Number.POSITIVE_INFINITY);
	return (
		<>
			{state.evicted > 0 ? (
				<Note>Earlier items are no longer held here ({state.evicted} dropped to stay within the limit).</Note>
			) : null}
			{out.length === 0 ? (
				<div className="develop-empty" data-testid="transcript-empty">
					<h3>No messages seen yet</h3>
					<p>
						This conversation shows what the attached process has received since the workbench started. Anything
						said before that, and anything this page is not paired to read, is not available here. Pair this page
						to read the conversation.
					</p>
				</div>
			) : (
				<ol className="transcript" aria-label="Conversation" data-testid="transcript">
					{out}
				</ol>
			)}
		</>
	);
}

function CommandCard({ wb }: { wb: Workbench }): ReactElement | null {
	const c = wb.state.command;
	if (c === null) return null;
	const expires = new Date(c.expiresAtMs).toLocaleTimeString([], { hour12: false });
	return (
		<section className="command-card" data-testid="command-card" data-state={c.state} aria-label="Prompt status">
			<p>
				<strong>{COMMAND_WORDS[c.state]}</strong>
				{c.state === "refused" && c.reason !== null ? <span>: {REFUSAL_WORDS[c.reason] ?? c.reason}</span> : null}
				{c.state === "accepted" ? (
					<span> (a reply from the runtime, not a result: follow the run above)</span>
				) : null}
			</p>
			<ol className="chain" aria-label="Steps">
				<li data-done="true">requested</li>
				<li data-done={c.approved}>approved in the terminal</li>
				<li data-done={c.state === "dispatching" || c.state === "accepted" || c.state === "unknown"}>sent</li>
				<li data-done={c.state === "accepted"}>accepted by the runtime</li>
			</ol>
			{c.state === "awaiting-approval" ? (
				<>
					<p className="small">
						{c.bytes} bytes · digest <span className="mono">{c.digestPrefix}</span> · expires {expires} (browser
						clock) · single use. Type the approval phrase shown in the attached terminal. A local confirmation,
						not proof of identity. This page cannot approve it.
					</p>
					<button type="button" className="btn small-btn" data-testid="discard" onClick={() => void wb.discard()}>
						Withdraw
					</button>
				</>
			) : null}
		</section>
	);
}

function Pairing({ wb }: { wb: Workbench }): ReactElement {
	const [code, setCode] = useState("");
	const id = useId();
	return (
		<form
			className="composer pairing"
			aria-label="Pair this page"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				const entered = code.trim();
				setCode("");
				if (entered !== "") void wb.pair(entered);
			}}
		>
			<label htmlFor={id}>Pairing code</label>
			<p className="dim small" id={`${id}-hint`}>
				This page can read and ask. To let it, type the code shown in the terminal that started the workbench (type
				`pair` there for a new one). Pairing does not approve anything.
			</p>
			<div className="composer-row">
				<input
					id={id}
					className="search"
					autoComplete="off"
					spellCheck={false}
					aria-describedby={`${id}-hint`}
					value={code}
					onChange={(e) => setCode(e.currentTarget.value)}
					data-testid="pair-code"
				/>
				<button type="submit" className="btn" data-testid="pair-submit" disabled={code.trim() === ""}>
					Pair
				</button>
			</div>
		</form>
	);
}

const MODES = [
	{ id: "prompt", label: "Prompt", gist: "new run" },
	{ id: "steer", label: "Steer", gist: "change the open run" },
	{ id: "queue", label: "Queue", gist: "after the run's work" },
] as const;
const MODE_HINT: Readonly<Record<(typeof MODES)[number]["id"], string>> = {
	prompt:
		"Sends a NEW prompt: it starts a run and is not an intervention. It is only requested here; you approve it in the attached terminal, and it may use the model and cost money. Ctrl+Enter requests it.",
	steer: `${OPERATION_WORDS.steer.delivery} It is only requested here; you approve it in the attached terminal, and it may use the model and cost money. Its text is also kept in this store's interventions folder (as endo steer does), outside the event log, even if you decline it. Ctrl+Enter requests it.`,
	queue: `${OPERATION_WORDS.queue.delivery} It is only requested here; you approve it in the attached terminal, and it may use the model and cost money. Its text is also kept in this store's interventions folder (as endo steer does), outside the event log, even if you decline it. Ctrl+Enter requests it.`,
};

function Composer({ wb }: { wb: Workbench }): ReactElement {
	const { draft, setDraft, mode, setMode } = wb;
	const [sending, setSending] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	const id = useId();
	const offer = wb.state.status?.offers[mode] ?? { offered: false, reason: "Not read yet." };
	const promptOpen = mode === "prompt" && commandOpen(wb.state.command);
	const ok = offer.offered && !sending && !promptOpen && draft.trim() !== "";
	const label = MODES.find((m) => m.id === mode)!.label;
	const send = async () => {
		if (!ok) return;
		setSending(true);
		const sent = draft;
		const reply = mode === "prompt" ? await wb.propose(sent) : await wb.intervene(mode, sent);
		setSending(false);
		// Only what was requested is cleared: edits made while the request was pending stay.
		if (reply.kind === "command" || reply.kind === "intervention") setDraft((now) => (now === sent ? "" : now));
		field.current?.focus();
	};
	return (
		<form
			className="composer"
			aria-label="Message to agent"
			data-mode={mode}
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<fieldset className="modes">
				<legend>Send as</legend>
				{MODES.map((m) => (
					<label key={m.id} className="mode" data-mode={m.id} data-selected={mode === m.id}>
						<input
							type="radio"
							name={`${id}-mode`}
							value={m.id}
							checked={mode === m.id}
							onChange={() => setMode(m.id)}
							data-testid={`mode-${m.id}`}
						/>
						<span className="mode-name">{m.label}</span> <span className="dim">· {m.gist}</span>
					</label>
				))}
			</fieldset>
			<label htmlFor={id} className="sr-only">
				{label}
			</label>
			<textarea
				id={id}
				ref={field}
				rows={3}
				value={draft}
				disabled={!offer.offered || promptOpen}
				aria-describedby={`${id}-hint`}
				data-testid="composer"
				placeholder={
					offer.offered
						? mode === "prompt"
							? "A new prompt for the agent"
							: mode === "steer"
								? "A steering message for the run that is open"
								: "A follow-up for when the run's work is done"
						: ""
				}
				onChange={(e) => setDraft(e.currentTarget.value)}
				onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
					// Ctrl/Cmd+Enter sends; Enter is a newline; nothing sends while an input method is composing.
					if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
						event.preventDefault();
						void send();
					}
				}}
			/>
			<p className="dim small" id={`${id}-hint`} data-testid="composer-hint">
				{offer.offered ? MODE_HINT[mode] : (offer.reason ?? "")}
			</p>
			<div className="composer-row">
				<button type="submit" className="btn" data-testid="send" disabled={!ok}>
					Request {mode}
				</button>
			</div>
		</form>
	);
}

/** STOP: in the run strip, because it is a control on the run, not a message. It only requests; Pi answers once the run is idle. */
function StopControl({ wb }: { wb: Workbench }): ReactElement | null {
	const { status, grant } = wb.state;
	const stop = stopInFlight(wb.state);
	if (status === null || status.connection !== "connected") return null;
	if (stop !== null) {
		const st = stop.state;
		return (
			<span className="stop-control" data-testid="stop-status" data-state={st}>
				<strong>
					{st === "awaiting-approval"
						? "Stop requested · awaiting terminal approval"
						: st === "dispatching"
							? "Stop approved · dispatching to Pi"
							: "Stop dispatched to Pi · reply pending until the run is idle"}
				</strong>
				{st === "awaiting-approval" ? (
					<button
						type="button"
						className="btn small-btn"
						data-testid="stop-withdraw"
						onClick={() => void wb.withdraw(stop.proposalId)}
					>
						Withdraw
					</button>
				) : null}
			</span>
		);
	}
	if (status.run !== "active") return null;
	const offer = status.offers.stop;
	const usable = offer.offered && grant !== null;
	return (
		<span className="stop-control">
			<button
				type="button"
				className="btn small-btn"
				data-testid="stop"
				disabled={!usable}
				aria-describedby="stop-reason"
				onClick={() => void wb.intervene("stop", null)}
			>
				Request stop
			</button>
			<span className="dim small" id="stop-reason">
				{grant === null
					? "Pair this page to request a stop."
					: offer.offered
						? `${OPERATION_WORDS.stop.delivery} You approve it in the terminal.`
						: (offer.reason ?? "")}
			</span>
		</span>
	);
}

export function LiveConversation({ wb }: { wb: Workbench }): ReactElement {
	const { state } = wb;
	const words = runStripWords(state.status, state.unreachable);
	const connection = state.status === null || state.unreachable ? "unknown" : state.status.connection;
	return (
		<Panel
			id="develop-live"
			title="Conversation"
			subtitle="live · private to this session's process"
			className="develop-activity"
			resetKey={state.status?.launchId ?? "none"}
			tools={
				<>
					<label className="check" title="Reads the broker's memory every few seconds while on. Off by default.">
						<input
							type="checkbox"
							checked={state.follow}
							onChange={(e) => wb.setFollow(e.currentTarget.checked)}
							data-testid="follow"
						/>
						Follow
					</label>
					<button type="button" className="btn" id="workbench-refresh" disabled={state.busy} onClick={wb.refresh}>
						{state.busy ? "Reading…" : "Refresh"}
					</button>
				</>
			}
		>
			<div className="run-strip" data-testid="run-strip" data-connection={connection}>
				<ConnectionGlyph state={connection} />
				<span aria-live="polite" data-testid="run-strip-words">
					{words}
				</span>
				<span className="dim small">
					{state.statusAt === null ? "" : `read ${clock(state.statusAt)} (browser clock)`}
				</span>
				<StopControl wb={wb} />
			</div>
			{state.problem === null ? null : <Note tone="error">{state.problem}</Note>}
			<Transcript wb={wb} />
			<CommandCard wb={wb} />
			{state.grant === null ? <Pairing wb={wb} /> : <Composer wb={wb} />}
		</Panel>
	);
}

/** Concise context for the live session: what it is, what is offered and why not, and the way back to evidence. */
export function LiveContext({ wb, onObserve }: { wb: Workbench; onObserve(): void }): ReactElement {
	const { status, grant } = wb.state;
	return (
		<Panel
			id="develop-context"
			title="Context"
			subtitle="this session, and what you can do"
			className="develop-inspector"
			resetKey={status?.launchId ?? "none"}
		>
			<section className="block">
				<h3>Session</h3>
				<dl className="facts">
					<div className="fact">
						<dt>harness</dt>
						<dd>Pi</dd>
					</div>
					<div className="fact">
						<dt>attachment</dt>
						<dd className="mono">{status?.attachment ?? "unknown"}</dd>
					</div>
					<div className="fact">
						<dt>session</dt>
						<dd className="mono">
							{status?.session === null || status === null ? "not identified yet" : shortSession(status.session)}
						</dd>
					</div>
					<div className="fact">
						<dt>project</dt>
						<dd className="dim">unavailable: the evidence does not establish one</dd>
					</div>
					<div className="fact">
						<dt>this page</dt>
						<dd>
							{grant === null
								? "not paired: it can read status, not the conversation"
								: "paired: it can read the conversation and request what is offered"}
						</dd>
					</div>
				</dl>
			</section>
			<SurfaceView session={presentLivePi(status, wb.state.unreachable)} />
			<section className="block">
				<h3>Offered</h3>
				<ul className="plain">
					{(["prompt", "steer", "queue", "stop"] as const).map((op) => {
						const o = status?.offers[op];
						const gist = op === "prompt" ? "a new prompt" : OPERATION_WORDS[op].name.toLowerCase();
						return (
							<li key={op} data-testid={`offer-${op}`}>
								<strong>{op === "prompt" ? "Prompt" : OPERATION_WORDS[op].name}</strong> —{" "}
								{o?.offered
									? `available: ${gist}, approved in the attached terminal`
									: `unavailable: ${lower(o?.reason ?? "not read yet")}`}
							</li>
						);
					})}
				</ul>
			</section>
			<section className="block">
				<h3>Where the text lives</h3>
				<p className="dim small">
					The conversation above is held in the attached process's memory only, bounded, and cleared when the
					session ends. It is not written to the event store or any read view. Pi keeps its own session file as it
					always does; that is Pi's retention, not Endophasia's evidence.
				</p>
			</section>
			<section className="block">
				<h3>Evidence</h3>
				<button type="button" className="btn" data-testid="live-observe" onClick={onObserve}>
					Open in Observe
				</button>
				<p className="dim small">What was recorded about this session (structure, never its text) is in Observe.</p>
			</section>
		</Panel>
	);
}
