// The neutral session surface, drawn: where a session comes from, how it is observed, who owns it, what it is said to be doing and by
// whom, and which actions its source offers with the reason for each one it does not. Presentation only. No control reads this, and
// none is enabled by it: the composer and the stop control keep reading the broker's own `offers`, and the broker still admits each
// request itself. The words are fixed in the model; no source text is shown here except a capability's fixed reason sentence.
import type { ReactElement } from "react";
import type { EndoDevelopSessionV0 } from "../../../protocol/develop-session.ts";
import { BASIS_WORDS, GROUP_WORDS, OBSERVATION_WORDS, OWNERSHIP_WORDS } from "../model/develop-session.ts";

const KEY_SCOPE_WORDS = {
	source: "stable as the source gives it",
	launch: "this launch only",
	generation: "this verified read only",
} as const;
const STATUS_WORDS = {
	active: "a run is open",
	idle: "no run is open",
	ended: "ended",
	interrupted: "interrupted",
	detached: "detached",
	"not-observed": "no attachment observed",
} as const;

/** A short, honest tag for a list row: live or recorded-only. */
export function SurfaceTag({ session }: { session: EndoDevelopSessionV0 }): ReactElement {
	const mode = session.observation.mode;
	return (
		<span className="surface-tag" data-testid="surface-tag" data-mode={mode} title={OBSERVATION_WORDS[mode]}>
			{mode === "live" ? "live" : mode === "recorded" ? "recorded only" : "not observable now"}
		</span>
	);
}

export function SurfaceView({ session }: { session: EndoDevelopSessionV0 }): ReactElement {
	const key = session.identity.key;
	const runtime = session.runtime;
	const ownership = session.ownership;
	return (
		<div className="surface" data-testid="surface" data-source={session.identity.source}>
			<section className="block">
				<h3>Source and ownership</h3>
				<dl className="facts">
					<div className="fact">
						<dt>source</dt>
						<dd data-testid="surface-source">
							{session.integration.label} · {session.integration.type}
							{session.synthetic ? " · TEST-ONLY SHAPE" : ""}
						</dd>
					</div>
					<div className="fact">
						<dt>identity</dt>
						<dd className="dim" data-testid="surface-identity">
							{key.status === "established"
								? `a ${session.identity.source} key, ${KEY_SCOPE_WORDS[key.scope]}; the alias is a label, not the key`
								: `unavailable: ${key.reason}`}
						</dd>
					</div>
					<div className="fact">
						<dt>runtime</dt>
						<dd>
							{runtime.status === "established"
								? `${runtime.value.name}${runtime.value.version === null ? "" : ` ${runtime.value.version}`} (${BASIS_WORDS[runtime.basis]})`
								: `unavailable: ${runtime.reason}`}
						</dd>
					</div>
					<div className="fact">
						<dt>ownership</dt>
						<dd data-testid="surface-ownership">
							{ownership.status === "established"
								? `${OWNERSHIP_WORDS[ownership.value]} (${BASIS_WORDS[ownership.basis]})`
								: `unknown: ${ownership.reason}`}
						</dd>
					</div>
					<div className="fact">
						<dt>observation</dt>
						<dd data-testid="surface-observation">
							{OBSERVATION_WORDS[session.observation.mode]}
							{session.observation.reason === null ? "" : `: ${session.observation.reason}`}
						</dd>
					</div>
					<div className="fact">
						<dt>connection</dt>
						<dd data-testid="surface-connection" data-state={session.connection.state}>
							{session.connection.state === "connected"
								? "connected"
								: session.connection.state === "not-applicable"
									? "none: this is a recording"
									: `${session.connection.state}: ${session.connection.reason}`}
						</dd>
					</div>
					<div className="fact">
						<dt>status</dt>
						<dd data-testid="surface-status">
							{session.status.length === 0 ? (
								<span className="dim">unavailable: nothing about it is established</span>
							) : (
								<ul className="plain">
									{session.status.map((claim) => (
										<li key={claim.basis} data-basis={claim.basis}>
											{STATUS_WORDS[claim.state]} — {BASIS_WORDS[claim.basis]}
											{claim.at === null ? "" : `, at ${claim.at}`}
										</li>
									))}
								</ul>
							)}
						</dd>
					</div>
				</dl>
			</section>
			<section className="block">
				<h3>What its source offers</h3>
				<p className="dim small">
					An offer here is a description, not a permission. Anything that changes the session is approved in the
					attached terminal and admitted by the session's own broker at the moment it is sent.
				</p>
				{(Object.keys(session.capabilities) as (keyof EndoDevelopSessionV0["capabilities"])[]).map((group) => (
					<div key={group} data-testid={`caps-${group}`}>
						<h4>{GROUP_WORDS[group]}</h4>
						<ul className="plain">
							{Object.entries(session.capabilities[group]).map(([action, cap]) => (
								<li key={action} data-testid={`cap-${group}-${action}`} data-status={cap.status}>
									<strong>{action}</strong> —{" "}
									{cap.status === "supported" ? `offered, through ${cap.via}` : `${cap.status}: ${cap.reason}`}
								</li>
							))}
						</ul>
					</div>
				))}
			</section>
		</div>
	);
}
