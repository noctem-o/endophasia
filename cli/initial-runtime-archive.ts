// Shared PR81 source-archive restrictions; the initial execution validation is unchanged.
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { readEndoWorkspaceArchiveV0 } from "../storage/workspace-snapshot.ts";

const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);

export function supportedInitialRuntimeArchiveV0(bytes: Uint8Array, provider: string, model: string): string | null {
	const parsed = readEndoWorkspaceArchiveV0(bytes);
	if (!parsed.ok || parsed.schemaVersion !== "endo.workspace-archive.v1") return "unsupported archive";
	const entries = parsed.value.entries;
	const files = entries.filter((e) => e.type === "file");
	if (entries.some((e) => e.type === "symlink" || (e.type === "file" && e.executable)))
		return "symlink or executable archive entry";
	if (
		entries.some(
			(e) =>
				e.path !== "home" &&
				e.path !== "agent" &&
				e.path !== "work" &&
				!e.path.startsWith("work/") &&
				e.path !== "agent/models.json" &&
				e.path !== "agent/settings.json",
		)
	)
		return "unsupported archived path or startup configuration";
	if (
		entries.some(
			(e) =>
				e.path.startsWith("work/") &&
				/(^|\/)(?:AGENTS\.md|\.pi|\.codex|\.agents|\.env|\.mcp\.json|package\.json)(\/|$)/.test(e.path),
		)
	)
		return "unresolved workspace startup or secret path";
	if (
		files.some(
			(e) => e.path !== "agent/models.json" && e.path !== "agent/settings.json" && !e.path.startsWith("work/"),
		)
	)
		return "unsupported agent file";
	const config = files.find((e) => e.path === "agent/models.json");
	if (!config || config.type !== "file") return "models.json missing";
	try {
		const parsedConfig = JSON.parse(Buffer.from(config.base64, "base64").toString("utf8"));
		if (!same(Object.keys(parsedConfig), ["providers"]) || !same(Object.keys(parsedConfig.providers), [provider]))
			return "unsupported models.json provider configuration";
		const entry = parsedConfig.providers[provider];
		if (
			!same(Object.keys(entry).sort(), ["api", "apiKey", "baseUrl", "models"]) ||
			entry.api !== "openai-completions" ||
			entry.apiKey !== "local" ||
			!Array.isArray(entry.models) ||
			entry.models.length !== 1 ||
			!same(entry.models[0], { id: model }) ||
			typeof entry.baseUrl !== "string" ||
			!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(entry.baseUrl)
		)
			return "unsupported or unresolved models.json configuration";
		const settings = files.find((e) => e.path === "agent/settings.json");
		if (
			settings?.type === "file" &&
			!same(JSON.parse(Buffer.from(settings.base64, "base64").toString("utf8")), { thinkingLevel: "off" })
		)
			return "unsupported historical settings";
	} catch {
		return "malformed models.json or settings.json";
	}
	return null;
}
