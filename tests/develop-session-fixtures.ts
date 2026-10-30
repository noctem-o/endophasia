// TEST-ONLY SHAPES for the neutral DEVELOP session surface. Nothing here is a real integration, and nothing here may reach production:
// every session is `synthetic: true`, every source id begins `test-`, and a source guard (endo-develop-session.test.ts) fails if any
// module outside tests/ imports this file. Nothing is installed, launched or connected. They import the protocol only: no Pi type.
import type {
	EndoDevelopCapabilitiesV0,
	EndoDevelopCapabilityV0,
	EndoDevelopSessionV0,
	EndoDevelopSurfaceV0,
} from "../protocol/develop-session.ts";

const no = (reason: string): EndoDevelopCapabilityV0 => ({ status: "unsupported", via: null, reason });
const via = (path: string): EndoDevelopCapabilityV0 => ({ status: "supported", via: path, reason: null });
const absent = (reason: string): EndoDevelopCapabilityV0 => ({ status: "unavailable", via: null, reason });

const NOT_OURS = "Another process owns this session. Endophasia has no control path to it.";
const noControl = (): EndoDevelopCapabilitiesV0["control"] => ({
	prompt: no(NOT_OURS),
	steer: no(NOT_OURS),
	queue: no(NOT_OURS),
	stop: no(NOT_OURS),
	resume: no(NOT_OURS),
});
const noCoordination = (): EndoDevelopCapabilitiesV0["coordinate"] => ({
	"list-children": no("This session coordinates nothing."),
	"dispatch-job": no("This session coordinates nothing."),
});

/** An externally owned session whose host reports activity. It can be watched, never driven, through anything Endophasia owns. */
export function externalReadOnlySession(): EndoDevelopSessionV0 {
	return {
		schemaVersion: "endo.develop-session.v0",
		identity: {
			source: "test-external-host",
			key: { status: "established", id: "ext-session-1", scope: "source" },
			alias: "external one",
		},
		integration: { label: "Test external host", type: "external-host" },
		synthetic: true,
		runtime: {
			status: "established",
			value: { name: "test-agent", version: null },
			basis: "reported",
			by: "test-external-host",
		},
		ownership: { status: "established", value: "external", basis: "reported", by: "test-external-host" },
		observation: { mode: "live", reason: null },
		connection: { state: "connected", reason: null },
		// The host REPORTS a run in progress; Endophasia independently OBSERVED no activity. Neither claim replaces the other.
		status: [
			{ state: "active", basis: "reported", by: "test-external-host", at: "2026-01-01T00:00:10Z" },
			{ state: "idle", basis: "observed", by: "endophasia", at: "2026-01-01T00:00:12Z" },
		],
		capabilities: {
			observe: {
				"live-status": via("test-external-feed"),
				"live-transcript": absent("The host reports no transcript feed."),
				lifecycle: no("The host exposes no lifecycle records."),
				activity: no("The host exposes no recorded activity."),
			},
			control: noControl(),
			coordinate: noCoordination(),
		},
		evidence: [{ kind: "test-fixture", producedBy: "test-external-host", generation: null }],
	};
}

const child = (
	source: string,
	id: string,
	alias: string,
	over: Partial<EndoDevelopSessionV0>,
): EndoDevelopSessionV0 => ({
	schemaVersion: "endo.develop-session.v0",
	identity: { source, key: { status: "established", id, scope: "source" }, alias },
	integration: { label: `Test agent ${alias}`, type: "harness" },
	synthetic: true,
	runtime: {
		status: "established",
		value: { name: source, version: null },
		basis: "reported",
		by: "test-meta-harness",
	},
	ownership: { status: "established", value: "external", basis: "reported", by: "test-meta-harness" },
	observation: { mode: "live", reason: null },
	connection: { state: "connected", reason: null },
	status: [],
	capabilities: {
		observe: {
			"live-status": via("test-meta-harness-feed"),
			"live-transcript": no("Not offered by the coordinator."),
			lifecycle: no("Not offered by the coordinator."),
			activity: no("Not offered by the coordinator."),
		},
		control: noControl(),
		coordinate: noCoordination(),
	},
	evidence: [{ kind: "test-fixture", producedBy: source, generation: null }],
	...over,
});

export const COORDINATOR_KEY = "test-meta-harness:source:job-1";
export const ALPHA_KEY = "test-agent-alpha:source:agent-a";
export const BETA_KEY = "test-agent-beta:source:agent-b";

/**
 * One externally owned coordinating job and two children, each its own source with its own capabilities.
 * - The coordinator REPORTS the job ended, and reports alpha as its child. Alpha says nothing of its parent: that edge stays reported.
 * - Beta's alias contains the job's name and it was "started" with the job, but NO edge exists for it: names and times link nothing.
 *   Its status is not established and it is not observable now.
 */
export function metaHarnessSurface(): EndoDevelopSurfaceV0 {
	const coordinator: EndoDevelopSessionV0 = {
		...child("test-meta-harness", "job-1", "job-1", {}),
		integration: { label: "Test meta-harness", type: "meta-harness" },
		runtime: {
			status: "established",
			value: { name: "test-orchestrator", version: null },
			basis: "reported",
			by: "test-meta-harness",
		},
		status: [{ state: "ended", basis: "reported", by: "test-meta-harness", at: "2026-01-01T00:05:00Z" }],
		capabilities: {
			observe: {
				"live-status": via("test-meta-harness-feed"),
				"live-transcript": no("A job has no conversation."),
				lifecycle: no("Not offered."),
				activity: no("Not offered."),
			},
			control: noControl(),
			coordinate: { "list-children": via("test-meta-harness-api"), "dispatch-job": via("test-meta-harness-api") },
		},
	};
	const alpha = child("test-agent-alpha", "agent-a", "alpha", {
		status: [{ state: "active", basis: "reported", by: "test-meta-harness", at: "2026-01-01T00:05:30Z" }],
	});
	const beta = child("test-agent-beta", "agent-b", "job-1-beta", {
		observation: { mode: "unavailable", reason: "The coordinator offers no feed for this agent." },
		connection: { state: "unknown", reason: "No connection to this agent is established." },
		capabilities: {
			observe: {
				"live-status": absent("The coordinator offers no feed for this agent."),
				"live-transcript": no("Not offered by the coordinator."),
				lifecycle: no("Not offered by the coordinator."),
				activity: no("Not offered by the coordinator."),
			},
			control: noControl(),
			coordinate: noCoordination(),
		},
	});
	return {
		schemaVersion: "endo.develop-session-surface.v0",
		sessions: [coordinator, alpha, beta],
		relations: [{ parent: COORDINATOR_KEY, child: ALPHA_KEY, basis: "reported", by: COORDINATOR_KEY }],
	};
}
