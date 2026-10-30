// The neutral DEVELOP session surface: the contract's validator, the projections of the real sources (live Pi workbench status, recorded
// Pi and DSH rows from a real store), and two test-only shapes (an externally owned session; a meta-harness job with two children).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EndoCockpitDevelopSessionRowV0 } from "../protocol/cockpit-develop.ts";
import {
	ENDO_DEVELOP_ACTIONS_V0,
	type EndoDevelopSessionV0,
	type EndoDevelopSurfaceV0,
	endoDevelopChildrenV0,
	endoDevelopKeyV0,
	endoDevelopSessionProblemV0,
	endoDevelopSurfaceProblemV0,
} from "../protocol/develop-session.ts";
import { developSurface, presentLivePi, presentRecorded } from "../studio-ui/src/model/develop-session.ts";
import type { WorkbenchStatus } from "../studio-ui/src/model/workbench-wire.ts";
import {
	ALPHA_KEY,
	BETA_KEY,
	COORDINATOR_KEY,
	externalReadOnlySession,
	metaHarnessSurface,
} from "./develop-session-fixtures.ts";
import { compareEvents } from "./studio-compare-fixtures.ts";
import { developRecords } from "./studio-develop-fixtures.ts";

const surfaceOf = (...sessions: EndoDevelopSessionV0[]): EndoDevelopSurfaceV0 => ({
	schemaVersion: "endo.develop-session-surface.v0",
	sessions,
	relations: [],
});
const clone = <T>(value: T): T => structuredClone(value);

const LAUNCH = "0123456789abcdef";
const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: LAUNCH,
	harness: "pi",
	connection: "connected",
	run: "idle",
	session: "endo.session.pi.live",
	attachment: "pi.default",
	offers: {
		prompt: { offered: true, reason: null },
		steer: { offered: false, reason: "No run is open." },
		queue: { offered: false, reason: "No run is open." },
		stop: { offered: false, reason: "No run is open." },
	},
	paired: true,
	command: null,
	interventions: [],
	transcript: { watermark: 0, firstSeq: 1 },
	...over,
});
const allActions = (s: EndoDevelopSessionV0) =>
	(["observe", "control", "coordinate"] as const).flatMap((g) =>
		ENDO_DEVELOP_ACTIONS_V0[g].map((a) => ({ g, a, cap: (s.capabilities[g] as Record<string, any>)[a] })),
	);

describe("the live Pi workbench, presented", () => {
	it("keeps exactly what the broker offers, names the broker as the path, and is a valid production session", () => {
		const live = presentLivePi(status(), false);
		expect(endoDevelopSessionProblemV0(live)).toBeNull();
		expect(endoDevelopSurfaceProblemV0(surfaceOf(live))).toBeNull();
		expect(live.capabilities.control.prompt).toEqual({
			status: "supported",
			via: "pi-workbench-broker",
			reason: null,
		});
		expect(live.capabilities.control.steer).toEqual({ status: "unavailable", via: null, reason: "No run is open." });
		expect(live.capabilities.control.resume.status).toBe("unsupported");
		expect(live.ownership).toMatchObject({ status: "established", value: "direct" });
		expect(live.observation).toEqual({ mode: "live", reason: null });
		expect(live.identity.key).toEqual({ status: "established", id: "endo.session.pi.live", scope: "source" });
		// The run state is what Pi REPORTED through the broker, not something Endophasia observed.
		expect(live.status).toEqual([{ state: "idle", basis: "reported", by: "pi", at: null }]);
	});

	it("follows the offers as they change, so a run in progress offers steer, queue and stop", () => {
		const run = presentLivePi(
			status({
				run: "active",
				offers: {
					prompt: { offered: false, reason: "A run is open." },
					steer: { offered: true, reason: null },
					queue: { offered: true, reason: null },
					stop: { offered: true, reason: null },
				},
			}),
			false,
		);
		expect(run.status[0]).toMatchObject({ state: "active", basis: "reported" });
		expect(["steer", "queue", "stop"].map((a) => (run.capabilities.control as any)[a].status)).toEqual([
			"supported",
			"supported",
			"supported",
		]);
		expect(run.capabilities.control.prompt.status).toBe("unavailable");
		expect(endoDevelopSessionProblemV0(run)).toBeNull();
	});

	it("is not live when the workbench reports no connection, and says so without claiming the session ended", () => {
		const off = presentLivePi(status({ connection: "disconnected", run: "active" }), false);
		expect(endoDevelopSessionProblemV0(off)).toBeNull();
		expect(off.observation.mode).toBe("unavailable");
		expect(off.connection.state).toBe("disconnected");
		expect(off.status).toEqual([]);
		expect(off.ownership.status).toBe("unavailable");
		for (const { g, cap } of allActions(off).filter(({ g }) => g === "control")) {
			expect(cap.status, g).not.toBe("supported");
		}
		// An offer left over in the last status is not an offer once the connection is gone.
		expect(off.capabilities.control.prompt.status).toBe("unavailable");
	});

	it("separates an unreachable workbench from a disconnected session", () => {
		const lost = presentLivePi(status(), true);
		expect(endoDevelopSessionProblemV0(lost)).toBeNull();
		expect(lost.connection.state).toBe("unknown");
		expect(lost.observation.mode).toBe("unavailable");
		expect(lost.status).toEqual([]);
		expect(lost.capabilities.control.prompt.status).toBe("unavailable");
	});

	it("has an unavailable key before any status was read, and a launch-scoped key before Pi names its session", () => {
		const none = presentLivePi(null, false);
		expect(endoDevelopSessionProblemV0(none)).toBeNull();
		expect(none.identity.key.status).toBe("unavailable");
		expect(none.evidence).toEqual([]);
		const early = presentLivePi(status({ session: null }), false);
		expect(early.identity.key).toEqual({ status: "established", id: LAUNCH, scope: "launch" });
		expect(early.identity.alias).toBeNull();
		expect(endoDevelopSessionProblemV0(early)).toBeNull();
	});

	it("never turns an absent offer into a supported action", () => {
		const s = status();
		const partial = { ...s, offers: { prompt: s.offers.prompt } } as unknown as WorkbenchStatus;
		const live = presentLivePi(partial, false);
		for (const a of ["steer", "queue", "stop"] as const)
			expect(live.capabilities.control[a].status).toBe("unavailable");
		expect(endoDevelopSessionProblemV0(live)).toBeNull();
	});

	it("carries no pending command, intervention or transcript field into the presentation", () => {
		const busy = status({
			command: {
				proposalId: "endo.evidence.workbench-prompt-00000000000000000000000000000001",
				state: "awaiting-approval",
				approved: false,
				reason: null,
				disposition: null,
				bytes: 12,
				digestPrefix: "feedfacefeedface",
				expiresAtMs: 1,
			},
		});
		const text = JSON.stringify(presentLivePi(busy, false));
		for (const leaked of ["feedfacefeedface", "endo.evidence.workbench-prompt", "awaiting-approval", "pi.default"])
			expect(text, leaked).not.toContain(leaked);
		expect(JSON.stringify(presentLivePi(busy, false))).toBe(JSON.stringify(presentLivePi(status(), false)));
	});
});

describe("recorded Pi and DSH sessions, presented from a real store", () => {
	const { sessions } = developRecords();
	const byAlias = (alias: string) => sessions.sessions.find((r) => r.session === alias)!;

	it("presents every real row as a valid, read-only recording under its own source", () => {
		expect(sessions.sessions.length).toBeGreaterThan(3);
		for (const row of sessions.sessions) {
			const recorded = presentRecorded(row, sessions.generation);
			expect(endoDevelopSessionProblemV0(recorded), row.session).toBeNull();
			expect(recorded.identity.source).toBe(row.source === "pi" ? "pi-recorded" : "dsh-recorded");
			expect(recorded.observation.mode).toBe("recorded");
			expect(recorded.connection.state).toBe("not-applicable");
			expect(recorded.ownership).toMatchObject({ value: "imported", basis: "recorded" });
			expect(recorded.evidence).toEqual([
				{
					kind: "cockpit-develop-sessions.1",
					producedBy: recorded.identity.source,
					generation: sessions.generation,
				},
			]);
			for (const { cap } of allActions(recorded).filter(({ g }) => g === "control"))
				expect(cap.status).toBe("unsupported");
			expect(recorded.capabilities.observe["live-status"].status).toBe("unsupported");
		}
		expect(endoDevelopSurfaceProblemV0(developSurface(null, sessions.sessions, sessions.generation))).toBeNull();
	});

	it("keys an inspectable recording by the generation-bound selector, not by its alias", () => {
		const pi = presentRecorded(byAlias("endo.session.pi.a"), sessions.generation);
		expect(pi.identity.key).toEqual({
			status: "established",
			id: byAlias("endo.session.pi.a").selector,
			scope: "generation",
		});
		expect(pi.identity.alias).toBe("pi.a");
		expect(endoDevelopKeyV0(pi)).toBe(`pi-recorded:generation:${byAlias("endo.session.pi.a").selector}`);
	});

	it("reports the recorded lifecycle as a recorded claim, and a recorded 'running' is still read-only", () => {
		const row = clone(byAlias("endo.session.pi.a"));
		row.recorded = { ...row.recorded!, state: "running" };
		const recorded = presentRecorded(row, sessions.generation);
		expect(recorded.status).toEqual([
			{ state: "active", basis: "recorded", by: "pi-recorded", at: row.lastRecordedAt },
		]);
		expect(recorded.observation.mode).toBe("recorded");
		for (const a of ENDO_DEVELOP_ACTIONS_V0.control)
			expect(recorded.capabilities.control[a].status).toBe("unsupported");
		expect(endoDevelopSessionProblemV0(recorded)).toBeNull();
		const asRecord: EndoCockpitDevelopSessionRowV0 = row;
		expect(asRecord.selector).not.toBeNull();
	});

	it("does not infer a DSH control path and says there is none", () => {
		const dsh = presentRecorded(byAlias("endo.session.dsh.session-1"), sessions.generation);
		const reason = dsh.capabilities.control.prompt.reason!;
		expect(reason).toMatch(/no control path to DSH/);
		expect(dsh.integration).toMatchObject({ label: "DSH recording" });
		expect(dsh.capabilities.observe.lifecycle.status).toBe("supported");
	});

	it("gives a recording that cannot be inspected no key, no status and no observation capability, with the reason", () => {
		const incomplete = compareEvents().filter((e) => e.kind !== "dsh.import-checkpoint");
		const rows = developRecords(incomplete).sessions.sessions;
		const dsh = rows.find((r) => r.source === "dsh")!;
		expect(dsh.qualification).toBe("insufficient");
		const recorded = presentRecorded(dsh, null);
		expect(recorded.identity.key.status).toBe("unavailable");
		expect(recorded.status).toEqual([]);
		expect(recorded.capabilities.observe.lifecycle.status).toBe("unavailable");
		expect(recorded.capabilities.observe.lifecycle.reason).toMatch(/import is incomplete/);
		expect(endoDevelopSessionProblemV0(recorded)).toBeNull();
		// Rows without a key are kept out of the key-based duplicate check, so two of them do not collide.
		expect(
			endoDevelopSurfaceProblemV0(
				surfaceOf(recorded, { ...clone(recorded), identity: { ...recorded.identity, alias: "other" } }),
			),
		).toBeNull();
	});

	it("shows a live session and the recording of it as two entries, never joined by name", () => {
		const alias = byAlias("endo.session.pi.a").session;
		const live = presentLivePi(status({ session: alias }), false);
		const surface = developSurface(
			{ status: status({ session: alias }), unreachable: false },
			sessions.sessions,
			sessions.generation,
		);
		expect(endoDevelopSurfaceProblemV0(surface)).toBeNull();
		expect(surface.relations).toEqual([]);
		const same = surface.sessions.filter((s) => s.identity.alias === live.identity.alias);
		expect(same.map((s) => s.identity.source).sort()).toEqual(["pi-live", "pi-recorded"]);
		expect(same.find((s) => s.identity.source === "pi-live")!.observation.mode).toBe("live");
		expect(same.find((s) => s.identity.source === "pi-recorded")!.observation.mode).toBe("recorded");
	});
});

describe("an externally owned session (TEST-ONLY SHAPE)", () => {
	const ext = externalReadOnlySession();

	it("is valid as a fixture, and refused as a production session", () => {
		expect(endoDevelopSurfaceProblemV0(surfaceOf(ext), { allowSynthetic: true })).toBeNull();
		expect(endoDevelopSurfaceProblemV0(surfaceOf(ext))).toMatch(/synthetic/);
		expect(ext.integration.type).toBe("external-host");
		expect(ext.identity.source).toMatch(/^test-/);
	});

	it("can be observed and cannot be prompted, steered, queued, stopped or resumed", () => {
		expect(ext.capabilities.observe["live-status"].status).toBe("supported");
		expect(ext.capabilities.observe["live-transcript"].status).toBe("unavailable");
		for (const a of ENDO_DEVELOP_ACTIONS_V0.control) {
			expect(ext.capabilities.control[a].status).toBe("unsupported");
			expect(ext.capabilities.control[a].via).toBeNull();
		}
		// Nothing about it names the Pi broker.
		expect(JSON.stringify(ext)).not.toMatch(/pi-workbench|workbench|"pi"/);
	});

	it("keeps what the host reported apart from what Endophasia observed, even when they differ", () => {
		expect(ext.status.map((c) => [c.basis, c.state, c.by])).toEqual([
			["reported", "active", "test-external-host"],
			["observed", "idle", "endophasia"],
		]);
	});

	it("is refused if it claims control it cannot have, or if the Pi broker is named as its path", () => {
		const claims = clone(ext);
		claims.capabilities.control.stop = { status: "supported", via: "pi-workbench-broker", reason: null };
		expect(endoDevelopSessionProblemV0(claims)).toMatch(/live, directly owned/);
		// Forging the ownership as well does not help: the broker's path serves only the Pi workbench's own source.
		claims.ownership = { status: "established", value: "direct", basis: "observed", by: "endophasia" };
		expect(endoDevelopSessionProblemV0(claims)).toMatch(/pi-workbench-broker is the path of pi-live only/);
		const observed = clone(ext);
		observed.capabilities.observe["live-status"] = { status: "supported", via: "pi-workbench-broker", reason: null };
		expect(endoDevelopSessionProblemV0(observed)).toMatch(/path of pi-live only/);
	});
});

describe("a meta-harness job with two children (TEST-ONLY SHAPE)", () => {
	const surface = metaHarnessSurface();
	const at = (key: string) => surface.sessions.find((s) => endoDevelopKeyV0(s) === key)!;

	it("is a valid fixture with three independently identified sessions and one reported edge", () => {
		expect(endoDevelopSurfaceProblemV0(surface, { allowSynthetic: true })).toBeNull();
		expect(surface.sessions.map(endoDevelopKeyV0)).toEqual([COORDINATOR_KEY, ALPHA_KEY, BETA_KEY]);
		expect(endoDevelopChildrenV0(surface, COORDINATOR_KEY)).toEqual([
			{ parent: COORDINATOR_KEY, child: ALPHA_KEY, basis: "reported", by: COORDINATOR_KEY },
		]);
	});

	it("does not let the coordinator's completion stand for a child's", () => {
		expect(at(COORDINATOR_KEY).status[0]).toMatchObject({ state: "ended", basis: "reported" });
		expect(at(ALPHA_KEY).status[0]).toMatchObject({ state: "active" });
		expect(at(BETA_KEY).status).toEqual([]);
	});

	it("keeps coordination and control apart: the coordinator coordinates, and no session in the job can be controlled", () => {
		expect(at(COORDINATOR_KEY).capabilities.coordinate["list-children"].status).toBe("supported");
		expect(at(ALPHA_KEY).capabilities.coordinate["list-children"].status).toBe("unsupported");
		for (const s of surface.sessions)
			for (const a of ENDO_DEVELOP_ACTIONS_V0.control)
				expect(s.capabilities.control[a].status, `${s.identity.source}.${a}`).toBe("unsupported");
		// Each child's observation capability differs from the coordinator's and from the other child's.
		expect(at(ALPHA_KEY).capabilities.observe["live-status"].status).toBe("supported");
		expect(at(BETA_KEY).capabilities.observe["live-status"].status).toBe("unavailable");
		expect(at(COORDINATOR_KEY).capabilities.observe["live-transcript"].status).toBe("unsupported");
	});

	it("does not give a child control because the coordinator could coordinate, and refuses a child that claims it", () => {
		const bad = clone(surface);
		bad.sessions[1]!.capabilities.control.prompt = {
			status: "supported",
			via: "test-meta-harness-api",
			reason: null,
		};
		expect(endoDevelopSurfaceProblemV0(bad, { allowSynthetic: true })).toMatch(/live, directly owned/);
	});

	it("keeps child evidence attributed to the child's own source", () => {
		const bad = clone(surface);
		bad.sessions[1]!.evidence = [{ kind: "test-fixture", producedBy: "test-meta-harness", generation: null }];
		expect(endoDevelopSurfaceProblemV0(bad, { allowSynthetic: true })).toMatch(
			/only evidence produced by its own source/,
		);
		for (const s of surface.sessions) expect(s.evidence.every((e) => e.producedBy === s.identity.source)).toBe(true);
	});

	it("fills no relationship from a name, a path or a time", () => {
		const beta = at(BETA_KEY);
		expect(beta.identity.alias).toBe("job-1-beta");
		expect(endoDevelopChildrenV0(surface, COORDINATOR_KEY).map((r) => r.child)).not.toContain(BETA_KEY);
		expect(surface.relations.filter((r) => r.child === BETA_KEY || r.parent === BETA_KEY)).toEqual([]);
	});

	it("refuses cycles, a second parent, a self-edge, a dangling edge, a duplicate claim and a third party's claim", () => {
		const cycle = clone(surface);
		cycle.relations.push({ parent: ALPHA_KEY, child: COORDINATOR_KEY, basis: "reported", by: ALPHA_KEY });
		expect(endoDevelopSurfaceProblemV0(cycle, { allowSynthetic: true })).toMatch(/cycle|two parents/);
		const long = clone(surface);
		long.relations.push({ parent: ALPHA_KEY, child: BETA_KEY, basis: "reported", by: ALPHA_KEY });
		expect(endoDevelopSurfaceProblemV0(long, { allowSynthetic: true })).toBeNull();
		long.relations.push({ parent: BETA_KEY, child: COORDINATOR_KEY, basis: "reported", by: BETA_KEY });
		expect(endoDevelopSurfaceProblemV0(long, { allowSynthetic: true })).toMatch(/cycle/);
		const two = clone(surface);
		two.relations.push({ parent: BETA_KEY, child: ALPHA_KEY, basis: "reported", by: BETA_KEY });
		expect(endoDevelopSurfaceProblemV0(two, { allowSynthetic: true })).toMatch(/two parents/);
		const self = clone(surface);
		self.relations = [{ parent: ALPHA_KEY, child: ALPHA_KEY, basis: "reported", by: ALPHA_KEY }];
		expect(endoDevelopSurfaceProblemV0(self, { allowSynthetic: true })).toMatch(/own parent/);
		const dangling = clone(surface);
		dangling.relations = [
			{ parent: COORDINATOR_KEY, child: "test-agent-gamma:source:ghost", basis: "reported", by: COORDINATOR_KEY },
		];
		expect(endoDevelopSurfaceProblemV0(dangling, { allowSynthetic: true })).toMatch(/both ends/);
		const twice = clone(surface);
		twice.relations.push({ ...twice.relations[0]! });
		expect(endoDevelopSurfaceProblemV0(twice, { allowSynthetic: true })).toMatch(/duplicate claim/);
		const third = clone(surface);
		third.relations = [{ parent: COORDINATOR_KEY, child: ALPHA_KEY, basis: "reported", by: BETA_KEY }];
		expect(endoDevelopSurfaceProblemV0(third, { allowSynthetic: true })).toMatch(/claimed by an end/);
		const forged = clone(surface);
		forged.relations = [{ parent: COORDINATOR_KEY, child: ALPHA_KEY, basis: "observed", by: COORDINATOR_KEY }];
		expect(endoDevelopSurfaceProblemV0(forged, { allowSynthetic: true })).toMatch(/claimed by an end/);
	});

	it("refuses duplicate and conflicting identities", () => {
		const dup = clone(surface);
		dup.sessions.push({ ...clone(dup.sessions[1]!), identity: { ...dup.sessions[1]!.identity, alias: "twin" } });
		expect(endoDevelopSurfaceProblemV0(dup, { allowSynthetic: true })).toMatch(/duplicate session key/);
		const alias = clone(surface);
		alias.sessions[2]!.identity.alias = "alpha";
		alias.sessions[2]!.identity.source = "test-agent-alpha";
		alias.sessions[2]!.evidence[0]!.producedBy = "test-agent-alpha";
		expect(endoDevelopSurfaceProblemV0(alias, { allowSynthetic: true })).toMatch(/alias alpha is shared/);
	});
});

describe("the validator never lets an absent field become an affirmative", () => {
	const base = () => clone(externalReadOnlySession());
	it("rejects a capability map with a missing action or group", () => {
		const group = base();
		delete (group.capabilities as any).coordinate;
		expect(endoDevelopSessionProblemV0(group)).toMatch(/every group/);
		const action = base();
		delete (action.capabilities.control as any).stop;
		expect(endoDevelopSessionProblemV0(action)).toMatch(/exactly the actions/);
		const undef = base();
		(undef.capabilities.control as any).stop = undefined;
		expect(endoDevelopSessionProblemV0(undef)).not.toBeNull();
	});
	it("requires a supported action to name its path and an unsupported one to give a reason", () => {
		const a = base();
		a.capabilities.observe.activity = { status: "supported", via: null, reason: null } as any;
		expect(endoDevelopSessionProblemV0(a)).toMatch(/names its path/);
		const b = base();
		b.capabilities.observe.activity = { status: "unsupported", via: null, reason: "" } as any;
		expect(endoDevelopSessionProblemV0(b)).toMatch(/carries its reason/);
	});
	it("rejects unknown members, an unknown schema, and facts with no basis", () => {
		expect(endoDevelopSessionProblemV0({ ...base(), extra: 1 })).not.toBeNull();
		expect(endoDevelopSessionProblemV0({ ...base(), schemaVersion: "endo.develop-session.v1" })).not.toBeNull();
		const noBasis = base();
		(noBasis.ownership as any) = { status: "established", value: "direct" };
		expect(endoDevelopSessionProblemV0(noBasis)).toMatch(/ownership/);
		const bare = base();
		(bare.ownership as any) = { status: "unavailable" };
		expect(endoDevelopSessionProblemV0(bare)).toMatch(/exactly a status and a reason/);
	});
	it("refuses a recording that claims a connection, a live claim on a recording, or a status while unobservable", () => {
		const recorded = presentRecorded(developRecords().sessions.sessions[0]!, null);
		expect(endoDevelopSessionProblemV0({ ...recorded, connection: { state: "connected", reason: null } })).toMatch(
			/recording/,
		);
		expect(
			endoDevelopSessionProblemV0({
				...recorded,
				status: [{ state: "active", basis: "observed", by: "endophasia", at: null }],
			}),
		).toMatch(/not observed live/);
		const off = presentLivePi(status({ connection: "disconnected" }), false);
		expect(
			endoDevelopSessionProblemV0({ ...off, status: [{ state: "idle", basis: "reported", by: "pi", at: null }] }),
		).toMatch(/unavailable/);
		const live = presentLivePi(status(), false);
		expect(
			endoDevelopSessionProblemV0({ ...live, status: [{ state: "idle", basis: "recorded", by: "pi", at: null }] }),
		).toMatch(/recorded claim/);
		expect(
			endoDevelopSessionProblemV0({
				...live,
				status: [
					{ state: "idle", basis: "reported", by: "pi", at: null },
					{ state: "active", basis: "reported", by: "pi", at: null },
				],
			}),
		).toMatch(/merged/);
	});
	it("refuses control on a recording, on an unreachable session, and on one another process owns", () => {
		const recorded = presentRecorded(developRecords().sessions.sessions[0]!, null);
		const control = {
			...recorded.capabilities.control,
			stop: { status: "supported", via: "pi-workbench-broker", reason: null },
		};
		expect(endoDevelopSessionProblemV0({ ...recorded, capabilities: { ...recorded.capabilities, control } })).toMatch(
			/live, directly owned/,
		);
		const off = presentLivePi(status({ connection: "disconnected" }), false);
		const claimed = {
			...off.capabilities.control,
			stop: { status: "supported", via: "pi-workbench-broker", reason: null },
		};
		expect(endoDevelopSessionProblemV0({ ...off, capabilities: { ...off.capabilities, control: claimed } })).toMatch(
			/live, directly owned/,
		);
	});
});

describe("what the surface may and may not do", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path];
		});
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	it("is never imported by production code the fixtures, and the fixtures import no Pi module", () => {
		const importers = ["studio-ui/src", "cockpit-http", "adapters", "cli", "runtime", "protocol", "cockpit"].flatMap(
			(dir) =>
				walk(join(root, dir)).filter(
					(file) => /\.(ts|tsx)$/.test(file) && /develop-session-fixtures/.test(readFileSync(file, "utf8")),
				),
		);
		expect(importers.map((file) => relative(root, file))).toEqual([]);
		const fixtureImports = [...read("tests/develop-session-fixtures.ts").matchAll(/from "([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(fixtureImports).toEqual(["../protocol/develop-session.ts"]);
	});

	it("creates no control: the composer, the stop control and the command path never read the neutral capabilities", () => {
		const live = read("studio-ui/src/develop/Live.tsx");
		// A component is the text from its declaration to the next top-level declaration, exported or not.
		const pick = (name: string) => {
			const start = live.indexOf(`function ${name}(`);
			expect(start, name).toBeGreaterThan(-1);
			const rest = live.slice(start + 10);
			const next = rest.search(/\n(?:export )?function /);
			return next < 0 ? rest : rest.slice(0, next);
		};
		for (const name of ["Composer", "StopControl", "InterventionCard", "CommandCard", "Pairing"])
			expect(pick(name), name).not.toMatch(/presentLivePi|SurfaceView|capabilities|develop-session/);
		for (const file of ["use-workbench.ts", "api.ts", "model/workbench.ts", "model/workbench-wire.ts"])
			expect(read(`studio-ui/src/${file}`), file).not.toMatch(/develop-session/);
	});

	it("is pure: the projection module touches no network, storage, clock or random source", () => {
		const text = read("studio-ui/src/model/develop-session.ts");
		expect(text).not.toMatch(
			/\b(fetch|XMLHttpRequest|localStorage|sessionStorage|Date\.now|new Date|Math\.random|crypto)\b/,
		);
		expect(read("protocol/develop-session.ts")).not.toMatch(/\b(fetch|node:|Date\.now|Math\.random)\b/);
	});

	it("writes nothing to evidence: no workbench, intervention or event-store module imports the surface", () => {
		for (const dir of ["adapters", "runtime", "cockpit-http", "cli"])
			for (const file of walk(join(root, dir)).filter((f) => /\.ts$/.test(f)))
				expect(readFileSync(file, "utf8"), file).not.toMatch(/develop-session\.ts/);
	});
});
