// The one control on the live workbench page that can ASK to send a prepared work attempt's brief to the attached Pi session
// (docs/designs/develop-attempt-workbench.md). It names the attempt and nothing else: the broker reads the brief from the attempt's own
// record, checks it, and shows it whole on the attached terminal, where only the operator's typed APPROVE ATTEMPT phrase lets it be sent.
// The pairing grant lets this page ask; it never approves. Only the live conversation passes this into the Task view: the workspace host
// and the read-only Studio have no way to reach it.
//
// What it shows is what the broker reported of that one request, and nothing more: requested, approved, authorisation recorded, sent, and
// Pi's reply. A reply is not a result, and a run Pi reports as completed is not verification.
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import {
	failureWords,
	type RequestWords,
	requestable,
	requestFor,
	requestWords,
	shortAttempt,
} from "../model/attempt-request.ts";
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
}): ReactElement {
	const id = useId();
	const [asking, setAsking] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	// Where focus goes when the control it was on is replaced (the button by the request's status, Withdraw by the button): this region,
	// which is always mounted, so keyboard and screen-reader users keep their place.
	const region = useRef<HTMLElement>(null);
	const refocus = useRef(false);
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
	// A message about an earlier attempt to ask goes once there is a request for this attempt to show instead.
	const mineId = mine?.proposalId ?? null;
	useEffect(() => {
		if (mineId !== null) setProblem(null);
	}, [mineId]);
	const view = `${mineId ?? ""}:${mine?.state ?? ""}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `view` stands for "what this region shows changed"
	useEffect(() => {
		if (!refocus.current) return;
		refocus.current = false;
		region.current?.focus({ preventScroll: true });
	}, [view]);

	const shown = mine === null ? null : <RequestStatus c={mine} words={requestWords(mine)} />;
	// A request that is still moving, or that bound the attempt, is all there is to show. One that ended without binding it left the
	// attempt as it was: it is shown, and below it whatever the attempt allows now.
	const settledUnbound = mine !== null && mine.state === "refused" && mine.attempt?.bound !== true;
	const eligible = requestable(a);
	const offer = status?.offers.attempt ?? { offered: false, reason: "Not read yet." };
	const why =
		grant === null
			? "Pair this page to request it."
			: !offer.offered
				? (offer.reason ?? "It cannot be requested now.")
				: null;
	return (
		<section
			className="attempt-request-region"
			ref={region}
			tabIndex={-1}
			aria-live="polite"
			aria-label={`Sending attempt ${shortAttempt(a.id)} to Pi`}
			data-testid="attempt-request-region"
		>
			{shown}
			{mine !== null && mine.state === "awaiting-approval" ? (
				<button
					type="button"
					className="btn small-btn"
					data-testid="attempt-request-withdraw"
					onClick={async () => {
						refocus.current = true;
						await wb.discard();
					}}
				>
					Withdraw
				</button>
			) : null}
			{mine !== null && !settledUnbound ? null : !eligible.ok ? (
				a.execution === null ? (
					<p className="dim small attempt-request-none" data-testid="attempt-request-none">
						{eligible.why} It cannot be sent to Pi from here.
					</p>
				) : null
			) : (
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
							refocus.current = true;
							const reply = await wb.requestAttempt(a.id);
							setAsking(false);
							if (reply.kind === "failure") {
								const words = failureWords(reply);
								setProblem(words.text);
								if (words.uncertain) wb.refresh();
							}
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
							{problem}
						</p>
					)}
				</div>
			)}
		</section>
	);
}

/** Where the request for this attempt stands, as the broker reported it. It may have been asked here or on the terminal. */
function RequestStatus({
	c,
	words,
}: {
	c: NonNullable<Workbench["state"]["command"]>;
	words: RequestWords;
}): ReactElement {
	const sent = c.state === "accepted" || c.state === "unknown" || c.reason === "runtime-refused";
	return (
		<div className="attempt-request" data-testid="attempt-request-status" data-state={c.state}>
			<p className="small">
				<strong>{words.head}.</strong> {words.detail}
			</p>
			<ol className="chain" aria-label="Steps">
				<li data-done="true">requested</li>
				<li data-done={c.approved}>approved in the terminal</li>
				<li data-done={c.attempt?.bound === true}>authorisation recorded</li>
				<li data-done={sent}>recorded as sent</li>
				<li data-done={c.state === "accepted" || c.reason === "runtime-refused"}>Pi replied</li>
			</ol>
		</div>
	);
}
