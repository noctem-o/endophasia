// Retained sanitised recordings, never active sessions. Shared by the DEVELOP frontend model and browser tests.
import { readEndoCockpitObservationV0 } from "../cockpit/index.ts";
import { projectEndoCockpitDevelopSessionsV0, projectEndoCockpitDevelopSessionV0 } from "../cockpit-http/develop.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { ingestAll, tempRoot } from "./cockpit-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { compareEvents, comparePiEvents } from "./studio-compare-fixtures.ts";

/** A recorded Pi session with `filler` extra recorded entries, so its activity needs more than one page. */
export function longPiSession(session: string, filler: number): EndoEventV0[] {
	const base = comparePiEvents("baseline", session);
	const at = base.findIndex((e) => e.kind === "harness.catch-up");
	const template = base.find((e) => e.kind === "session.entry-observed")!;
	const extra = Array.from({ length: filler }, (_, i) => ({
		...template,
		id: `endo.event.filler.${session.slice(13)}.${i}`,
		sequence: 1000 + i,
	}));
	return [...base.slice(0, at), ...extra, ...base.slice(at)];
}

/** Pi and DSH recordings plus extra Pi variants, as a populated store would hold them. */
export function developEvents(): EndoEventV0[] {
	const variants = ["tool-errors", "no-usage", "unknown-lifecycle"].flatMap((name, i) =>
		comparePiEvents(name, `endo.session.pi.${name.replace(/[^a-z]/g, "")}${i}`),
	);
	return [...compareEvents(), ...variants, ...longPiSession("endo.session.pi.long", 230)];
}

export function developStore(events: readonly EndoEventV0[] = developEvents()): string {
	const root = tempRoot("endo-develop-ui-");
	ingestAll(root, events);
	return root;
}

/** Real server records for the pure frontend tests, projected from one observation. */
export function developRecords(events: readonly EndoEventV0[] = developEvents()) {
	const root = developStore(events);
	const observation = readEndoCockpitObservationV0(root, OTHER_KEY);
	const sessions = projectEndoCockpitDevelopSessionsV0(observation, OTHER_KEY);
	const selectorOf = (alias: string) => sessions.sessions.find((r) => r.session === alias)!.selector!;
	const session = (alias: string, cursor?: string) =>
		projectEndoCockpitDevelopSessionV0(observation, OTHER_KEY, selectorOf(alias), cursor);
	return { root, observation, sessions, session, selectorOf };
}
