import {
	ENDO_COORDINATOR_BASES_V0,
	ENDO_COORDINATOR_PHASES_V0,
	type EndoCoordinatorStatusV0,
	validateEndoCoordinatorStatusV0,
} from "../../../protocol/coordinator-status.ts";
import { ATTEMPT_LABELS, RECEIPT_RELATION_LABELS } from "../model/attempts-wire.ts";

export const ATTENTION_LABELS = {
	"awaiting-your-review": "Awaits your review",
	"verification-failing": "Current check failing",
	"verification-inconclusive": "Current check inconclusive",
	contradiction: "Contradiction",
	blocked: "Blocked",
	"evidence-stale": "Evidence not current",
	"source-unavailable": "Source unavailable",
} satisfies Record<EndoCoordinatorStatusV0["attention"][number]["kind"], string>;

export const RESULT_LABELS = {
	passed: "Pass recorded",
	failed: "Failure recorded",
	inconclusive: "Inconclusive result",
	mixed: "Mixed results",
	"not-run": "Not run",
} satisfies Record<
	EndoCoordinatorStatusV0["projects"][number]["tasks"][number]["verification"]["results"][number]["outcome"],
	string
>;

const text = (value: unknown): boolean => typeof value === "string";
const hasLabel = (labels: object, value: unknown): boolean => typeof value === "string" && Object.hasOwn(labels, value);
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const time = (value: number): boolean => count(value) && value <= 8.64e15;
const unique = (values: string[]): boolean => new Set(values).size === values.length;
const namedId = (value: string): boolean => value.length > 0 && !value.includes("\u0000");

export function readCoordinatorStatus(value: unknown): EndoCoordinatorStatusV0 | null {
	try {
		const status = validateEndoCoordinatorStatusV0(value);
		const { requested, projects, unknown } = status.scope;
		if (
			requested === null ||
			requested.length === 0 ||
			!requested.every(namedId) ||
			!unique(requested) ||
			!unique([...projects, ...unknown]) ||
			!unique(status.projects.map((project) => project.id)) ||
			!unique(status.projects.flatMap((project) => project.tasks.map((task) => task.taskId))) ||
			!unique(status.sessions.map((session) => session.sessionId))
		)
			return null;

		return displayFieldsValid(status) ? status : null;
	} catch {
		return null;
	}
}

function displayFieldsValid(status: EndoCoordinatorStatusV0): boolean {
	return (
		time(status.readAtMs) &&
		Object.values(status.unlistedSessions).every(count) &&
		status.attention.every((item) => hasLabel(ATTENTION_LABELS, item.kind)) &&
		status.findings.every((finding) => text(finding.text)) &&
		status.projects.every(
			(project) =>
				text(project.name) &&
				(project.head === null || typeof project.head.clean === "boolean") &&
				ENDO_COORDINATOR_PHASES_V0.every(
					(phase) => project.counts[phase] === project.tasks.filter((task) => task.phase === phase).length,
				) &&
				project.tasks.every((task) => {
					const { latest } = task.attempts;
					return (
						text(task.title) &&
						time(task.updatedAtMs) &&
						count(task.revision) &&
						count(task.attempts.count) &&
						(task.attempts.count === 0) === (latest === null) &&
						(latest === null ||
							(text(latest.id) &&
								hasLabel(ATTEMPT_LABELS, latest.state) &&
								latest.stateBasis === "operator-declared" &&
								typeof latest.sendAuthorized === "boolean")) &&
						typeof task.verification.incomplete === "boolean" &&
						task.verification.basis === "controller-observed-host-check" &&
						count(task.verification.moreResults) &&
						task.verification.results.every(
							(result) =>
								text(result.command) &&
								hasLabel(RESULT_LABELS, result.outcome) &&
								(result.relation === null || hasLabel(RECEIPT_RELATION_LABELS, result.relation)) &&
								(result.relation !== "at-head" || project.head?.clean === true) &&
								(result.reading === "planned" || result.reading === "unplanned") &&
								text(result.attemptId) &&
								(result.commit === null || text(result.commit)) &&
								(result.receiptId === null || text(result.receiptId)),
						) &&
						task.gaps.every((gap) => text(gap.text)) &&
						task.sessions.every((link) => link.source === "pi-live" || link.source === "omp-saved")
					);
				}),
		) &&
		status.sessions.every(
			(session) =>
				(session.runtime === null || text(session.runtime)) &&
				time(session.lastEventAtMs) &&
				count(session.moreActivity) &&
				(session.lastRun === null ||
					(["completed", "failed", "aborted", "unclassified", "interrupted"].includes(session.lastRun.outcome) &&
						count(session.lastRun.turns) &&
						ENDO_COORDINATOR_BASES_V0.includes(session.lastRun.basis))) &&
				(session.openRun === null ||
					(count(session.openRun.turns) && ENDO_COORDINATOR_BASES_V0.includes(session.openRun.basis))) &&
				session.activity.every((item) => text(item.kind) && text(item.eventId) && time(item.atMs)) &&
				session.links.every((link) => link.source === "pi-live" || link.source === "omp-saved"),
		)
	);
}

export type CoordinatorProblem =
	| "grant-required"
	| "forbidden"
	| "not-found"
	| "too-many-requests"
	| "unavailable"
	| "invalid"
	| "unreachable"
	| "timeout";

export type CoordinatorReply =
	| { kind: "status"; status: EndoCoordinatorStatusV0 }
	| { kind: "failure"; problem: CoordinatorProblem };
