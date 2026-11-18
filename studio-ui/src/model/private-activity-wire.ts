import type { ActivityCapabilities, PrivateActivity } from "../../../protocol/private-activity.ts";
import { type Check, count, eitherNull, one, shape } from "./compare-wire.ts";

const toolLabels = [
	"Command",
	"Directory",
	"Timeout",
	"Path",
	"Offset",
	"Limit",
	"Edits",
	"Content",
	"Arguments",
	"Exit code",
	"Output",
] as const;

const toolLabel = one(...toolLabels);
const field: Check = (v) => {
	if (shape(v, { label: toolLabel, state: one("unavailable", "withheld") })) return true;
	if (
		!shape(v, {
			label: toolLabel,
			state: one("counted", "truncated", "reported"),
			text: (x) => typeof x === "string" && x.length <= 512 && new TextEncoder().encode(x).length <= 512,
		})
	)
		return false;
	if (v.label === "Edits") return v.state === "counted" && /^\d{1,10}$/.test(v.text as string);
	if (v.state === "counted" || v.label === "Arguments" || v.label === "Content") return false;
	return v.state !== "truncated" || v.label === "Output";
};

const flag = one("supported", "unavailable", "unverified");
const flags: Record<keyof ActivityCapabilities, Check> = {
	nativeSessionIdentity: flag,
	stableCallIdentity: flag,
	toolBoundaries: flag,
	argumentPreview: flag,
	resultPreview: flag,
	toolCancellation: flag,
	interrupt: flag,
	steer: flag,
	approvals: flag,
	resume: flag,
	fileChanges: flag,
	subagents: flag,
};
export const validActivityCapabilities = (v: unknown): v is ActivityCapabilities => shape(v, flags);
export function isPrivateActivity(v: unknown): v is PrivateActivity {
	if (
		!shape(v, {
			seq: (n) => count(n) && n >= 1,
			kind: one("tool"),
			source: (x) => typeof x === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(x),
			category: one("command", "file-read", "file-change", "retrieval", "external", "other"),
			turn: eitherNull((n) => count(n) && n > 0),
			occurrence: (n) => count(n) && n >= 1,
			callId: eitherNull((x) => typeof x === "string" && /^[a-zA-Z0-9_.:|-]{1,128}$/.test(x)),
			name: (x) =>
				x === "name unavailable" ||
				x === "name withheld" ||
				(typeof x === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(x)),
			status: one("requested", "running", "completed", "failed", "unknown"),
			fields: (x) =>
				Array.isArray(x) && x.length <= 3 && x.every(field) && new Set(x.map((f) => f.label)).size === x.length,
		})
	)
		return false;
	const i = v as unknown as PrivateActivity;
	return (
		i.occurrence <= i.seq &&
		(i.status !== "requested" || i.seq === i.occurrence) &&
		!(
			(i.status === "running" || i.status === "requested") &&
			i.fields.some((f) => f.label === "Output" || f.label === "Exit code")
		)
	);
}
