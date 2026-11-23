import {
	ENDO_COORDINATOR_BASES_V0,
	ENDO_COORDINATOR_PHASES_V0,
	type EndoCoordinatorStatusV0,
	validateEndoCoordinatorStatusV0,
} from "../../../protocol/coordinator-status.ts";
import { ENDO_DEVELOP_ATTEMPT_LABELS_V0 } from "../../../protocol/develop-attempts.ts";
import { ENDO_RECEIPT_RELATION_LABELS_V0 } from "../../../protocol/develop-receipts.ts";

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
								hasLabel(ENDO_DEVELOP_ATTEMPT_LABELS_V0, latest.state) &&
								latest.stateBasis === "operator-declared" &&
								typeof latest.sendAuthorized === "boolean")) &&
						typeof task.verification.incomplete === "boolean" &&
						task.verification.basis === "controller-observed-host-check" &&
						count(task.verification.moreResults) &&
						task.verification.results.every(
							(result) =>
								text(result.command) &&
								hasLabel(RESULT_LABELS, result.outcome) &&
								(result.relation === null || hasLabel(ENDO_RECEIPT_RELATION_LABELS_V0, result.relation)) &&
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
				session.activity.every((item) => text(item.kind) && text(item.eventId) && time(item.atMs)),
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

export async function fetchCoordinator(grant: string, cancel: AbortSignal): Promise<CoordinatorReply> {
	const timeout = AbortSignal.timeout(60_000);
	try {
		const response = await fetch(new URL("./api/v0/workbench/workspace/coordinator", document.baseURI), {
			method: "GET",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			cache: "no-store",
			headers: { "X-Endo-Grant": grant },
			signal: AbortSignal.any([cancel, timeout]),
		});
		if (response.status === 401) return { kind: "failure", problem: "grant-required" };
		if (response.status === 403) return { kind: "failure", problem: "forbidden" };
		if (response.status === 404) return { kind: "failure", problem: "not-found" };
		if (response.status === 429) return { kind: "failure", problem: "too-many-requests" };
		if (response.status !== 200) return { kind: "failure", problem: "unavailable" };
		if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
			return { kind: "failure", problem: "invalid" };
		try {
			const record = readCoordinatorStatus(await response.json());
			return record === null ? { kind: "failure", problem: "invalid" } : { kind: "status", status: record };
		} catch {
			return { kind: "failure", problem: timeout.aborted ? "timeout" : "invalid" };
		}
	} catch {
		return { kind: "failure", problem: timeout.aborted ? "timeout" : "unreachable" };
	}
}
