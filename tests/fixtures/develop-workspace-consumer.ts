// A programmatic consumer of the workspace service that is NOT Pi: no Pi process, no workbench, no HTTP server, no browser, no model, and
// no import of any harness adapter (the test walks this file's imports to prove it). It runs as its own `node` process.
//
// It is not a Codex, DSH, ACP or meta-harness integration and does not pretend to be one. Its host declares synthetic identities, says
// plainly that it has no session it can vouch for, and then does what any later host could: open the registered project, read and create a
// task, move it through the operator's status rules, and read the result back through a second, independent service object. It also asks,
// as a host of a source the file does not know, to link "its" session, and reports that it was refused.
//
//   node develop-workspace-consumer.ts <root> <projectId> <launchDirectory>
// prints one JSON line.

import { DevelopWorkspaceServiceV0 } from "../../runtime/contracts/develop-workspace.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";

const [root, projectId, launchDirectory] = process.argv.slice(2) as [string, string, string];
const config = { projectId, launchDirectory };

// Synthetic, explicitly declared identities. `session: null`: this host vouches for no session at all.
const host = { launchId: "0c0c0c0c0c0c0c0c", attachment: "fixture.consumer", session: null };
const workspace = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root)).forLaunch(config, host);

const opened = workspace.view();
const before = opened.tasks.map((t) => t.id);
const made = workspace.createTask({ title: "Written by a non-Pi consumer", acceptance: "It reads back." });
if (!made.ok) throw new Error(`create refused: ${made.code}`);
let revision = made.value.revision;
const moves: string[] = [];
for (const to of ["in-progress", "review", "done"]) {
	const moved = workspace.setStatus(made.value.id, revision, to, `moved to ${to} by the consumer`);
	if (!moved.ok) throw new Error(`status refused: ${moved.code}`);
	revision = moved.value.revision;
	moves.push(moved.value.status);
}
// The rules are the file's, not the consumer's: done is not reachable from open, and an old revision is refused.
const skipped = workspace.createTask({ title: "Skip ahead" });
const skip = skipped.ok ? workspace.setStatus(skipped.value.id, skipped.value.revision, "done") : skipped;
const stale = workspace.setStatus(made.value.id, 0, "open");
const link = workspace.linkCurrentSession(made.value.id, revision);

// A host that claims a source this version of the file cannot record. Whatever id it reports, nothing is written and nothing becomes current.
const borrowing = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root)).forLaunch(config, {
	launchId: "0c0c0c0c0c0c0c0c",
	attachment: "fixture.consumer",
	session: { source: "fixture-harness", current: () => ({ sessionId: process.env.BORROW_SESSION_ID ?? "none" }) },
});
const borrowed = borrowing.linkCurrentSession(made.value.id, revision);

// A second, independent service object reads what was written.
const again = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root)).forLaunch(config, host).view();
const mine = again.tasks.find((t) => t.id === made.value.id);
process.stdout.write(
	`${JSON.stringify({
		opened: {
			state: opened.state,
			writable: opened.writable,
			linkable: opened.linkable,
			project: opened.project?.id,
		},
		before,
		created: made.value.id,
		moves,
		skip: skip.ok ? "allowed" : skip.code,
		stale: stale.ok ? "allowed" : stale.code,
		link: link.ok ? "allowed" : link.code,
		borrowed: borrowed.ok ? "allowed" : borrowed.code,
		borrowingView: borrowing.view().tasks.flatMap((t) => t.sessions.map((s) => s.relation)),
		readBack:
			mine === undefined ? null : { status: mine.status, revision: mine.revision, history: mine.history.length },
		references: again.tasks.flatMap((t) =>
			t.sessions.map((s) => ({
				task: t.id,
				source: s.source,
				launchId: s.source === "pi-live" ? s.launchId : null,
				relation: s.relation,
			})),
		),
	})}\n`,
);
