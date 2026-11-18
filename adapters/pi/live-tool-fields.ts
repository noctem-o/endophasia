// Private transcript projection only. Admit known syntax rather than attempting to scrub arbitrary shell, paths or file contents.
export type ToolField = {
	label:
		| "Command"
		| "Path"
		| "Directory"
		| "Offset"
		| "Limit"
		| "Timeout"
		| "Edits"
		| "Content"
		| "Arguments"
		| "Exit code"
		| "Output";
} & ({ state: "reported" | "truncated" | "observed"; text: string } | { state: "unavailable" | "redacted" });

const record = (x: unknown): Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

const commands = new Set([
	"git status",
	"git status --short",
	"git diff --stat",
	"git diff --check",
	"pwd",
	"ls",
	"ls -la",
	"npm test",
	"npm run build",
	"npm run lint",
	"npm run typecheck",
]);
const paths = new Set([
	".",
	"README.md",
	"LICENSE",
	"CHANGELOG.md",
	"package.json",
	"package-lock.json",
	"tsconfig.json",
	"src",
	"src/index.ts",
	"src/index.js",
	"docs",
	"tests",
]);
const hidden = (label: ToolField["label"], raw: unknown): ToolField => ({
	label,
	state: raw === undefined ? "unavailable" : "redacted",
});
const known = (label: ToolField["label"], raw: unknown, allowed: Set<string>): ToolField =>
	typeof raw === "string" && raw.length <= 128 && allowed.has(raw)
		? { label, state: "reported", text: raw }
		: hidden(label, raw);
function command(raw: unknown): ToolField {
	if (typeof raw === "string" && raw.length <= 128) {
		const [verb, path, ...rest] = raw.split(" ");
		if (
			rest.length === 0 &&
			path !== undefined &&
			paths.has(path) &&
			(verb === "ls" || verb === "cat" || verb === "wc")
		)
			return { label: "Command", state: "reported", text: raw };
	}
	return known("Command", raw, commands);
}
const number = (label: ToolField["label"], raw: unknown): ToolField =>
	typeof raw === "number" && Number.isSafeInteger(raw)
		? { label, state: "reported", text: String(raw) }
		: hidden(label, raw);

export function startFields(name: string, input: unknown): ToolField[] {
	if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)))
		return [hidden("Arguments", input)];
	const args = record(input);
	if (name === "bash")
		return [command(args.command), known("Directory", args.cwd, paths), number("Timeout", args.timeout)];
	if (name === "read")
		return [known("Path", args.path, paths), number("Offset", args.offset), number("Limit", args.limit)];
	if (name === "write") return [known("Path", args.path, paths), hidden("Content", args.content)];
	if (name === "edit")
		return [
			known("Path", args.path, paths),
			Array.isArray(args.edits)
				? { label: "Edits", state: "observed", text: String(args.edits.length) }
				: hidden("Edits", args.oldText ?? args.newText ?? args.edits),
		];
	return [hidden("Arguments", input)];
}

function output(name: string, content: unknown): ToolField {
	if (name !== "bash" || !Array.isArray(content) || content.length !== 1) return hidden("Output", content);
	const block = record(content[0]);
	const value = block.text;
	if (block.type !== "text" || typeof value !== "string" || value.length > 65536) return hidden("Output", content);
	// Only a fixed diagnostic or porcelain lines with public vocabulary; never truncate an unvalidated line into something plausible.
	if (
		value !== "(no output)" &&
		!value.split("\n").every((line) => line === "" || (/^[ MADRCU?!]{2} /.test(line) && paths.has(line.slice(3))))
	)
		return hidden("Output", content);
	return { label: "Output", state: value.length > 512 ? "truncated" : "reported", text: value.slice(0, 512) };
}

export function endFields(name: string, raw: unknown): ToolField[] {
	const result = record(raw);
	return [number("Exit code", record(result.details).exitCode), output(name, result.content)];
}
