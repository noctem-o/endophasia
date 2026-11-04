// The one control on the live workbench page that can ASK to send a prepared work attempt's brief to the attached Pi session
// (docs/designs/develop-attempt-workbench.md). It names the attempt and nothing else: the broker reads the brief from the attempt's own
// record, checks it, and shows it whole on the attached terminal, where only the operator's typed APPROVE ATTEMPT phrase lets it be sent.
// The pairing grant lets this page ask; it never approves. Only the live conversation passes this into the Task view: the workspace host
// and the read-only Studio have no way to reach it.
//
// What it shows is what the broker reported of that one request, and nothing more: requested, approved, authorisation recorded, sent, and
// Pi's reply. A reply is not a result, and a run Pi reports as completed is not verification.
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { type RequestWords, requestable, requestFor, requestWords, shortAttempt } from "../model/attempt-request.ts";
import type { Attempt } from "../model/attempts-wire.ts";
import { commandOpen } from "../model/workbench.ts";
import type { useWorkbench } from "../use-workbench.ts";

type Workbench = ReturnType<typeof useWorkbench>;

export function AttemptRequest({
	wb,
	attempt: a,
	onSettled,
}: {
	wb: Workbench;
	attempt: Attempt;
	/** A request for this attempt reached an end (sent, refused or unknown): the attempts are read again, to show the session's records. */
	onSettled(): void;
}): ReactElement | null {
	const id = useId();
	const [asking, setAsking] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const { status, grant, command } = wb.state;
	const mine = requestFor(command, a.id);
	// When this attempt's request settles, read the attempts again (once per request and state).
	const settledKey = mine === null || commandOpen(mine) ? null : `${mine.proposalId}:${mine.state}`;
	const seen = useRef<string | null>(null);
	useEffect(() => {
		if (settledKey === null || seen.current === settledKey) return;
		seen.current = settledKey;
		onSettled();
	}, [settledKey, onSettled]);

	// A request for this attempt that is still moving, or that bound it, is all there is to show. One that ended without binding it (withdrawn,
	// declined, refused before its authorisation was written) left the attempt as it was: it is shown, and the attempt can be asked again.
	const shown = mine === null ? null : <RequestStatus wb={wb} c={mine} words={requestWords(mine)} />;
	if (mine !== null && (mine.state !== "refused" || mine.attempt?.bound === true)) return shown;
	const eligible = requestable(a);
	if (!eligible.ok)
		return a.execution === null ? (
			<p className="dim small attempt-request-none">{eligible.why} It cannot be sent to Pi from here.</p>
		) : null;
	const offer = status?.offers.attempt ?? { offered: false, reason: "Not read yet." };
	const why =
		grant === null
			? "Pair this page to request it."
			: !offer.offered
				? (offer.reason ?? "It cannot be requested now.")
				: null;
	return (
		<>
			{shown}
			<div className="attempt-request" data-testid="attempt-request">
				<button
					type="button"
					className="btn small-btn"
					data-testid="attempt-request-send"
					disabled={why !== null || asking}
					aria-describedby={`${id}-what`}
					onClick={async () => {
						setAsking(true);
						setProblem(null);
						const reply = await wb.requestAttempt(a.id);
						setAsking(false);
						if (reply.kind === "failure") setProblem(reply.message);
					}}
				>
					{asking ? "Requesting…" : `Request sending ${shortAttempt(a.id)} to Pi`}
				</button>
				<p className="dim small" id={`${id}-what`} data-testid="attempt-request-what">
					{why === null
						? "Asks the attached terminal to approve sending this brief, as recorded, once, as a new prompt to this Pi session. Nothing is sent unless you type its APPROVE ATTEMPT phrase there. It may use the model and cost money; it is never retried."
						: why}
				</p>
				{problem === null ? null : (
					<p className="small attempt-changed" role="alert" data-testid="attempt-request-problem">
						{problem} Nothing was recorded or sent.
					</p>
				)}
			</div>
		</>
	);
}

/** Where the request for this attempt stands, as the broker reported it. Withdrawing is offered only while it waits for the terminal. */
function RequestStatus({
	wb,
	c,
	words,
}: {
	wb: Workbench;
	c: NonNullable<Workbench["state"]["command"]>;
	words: RequestWords;
}): ReactElement {
	const sent = c.state === "accepted" || c.state === "unknown" || c.reason === "runtime-refused";
	return (
		<div className="attempt-request" data-testid="attempt-request-status" data-state={c.state} aria-live="polite">
			<p className="small">
				<strong>{words.head}.</strong> {words.detail}
			</p>
			<ol className="chain" aria-label="Steps">
				<li data-done="true">requested from this page</li>
				<li data-done={c.approved}>approved in the terminal</li>
				<li data-done={c.attempt?.bound === true}>authorisation recorded</li>
				<li data-done={sent}>sent</li>
				<li data-done={c.state === "accepted" || c.reason === "runtime-refused"}>Pi replied</li>
			</ol>
			{c.state === "awaiting-approval" ? (
				<button
					type="button"
					className="btn small-btn"
					data-testid="attempt-request-withdraw"
					onClick={() => void wb.discard()}
				>
					Withdraw
				</button>
			) : null}
		</div>
	);
}
