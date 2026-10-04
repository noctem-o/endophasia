// The pinned environment's node:test reporter (DESIGN.md §4): what Node's default reporter prints, except time. One
// line per test (✔ or ✖), the counts, and for each failing test its location and assertion message; never a duration.
// It is named in NODE_OPTIONS (--test-reporter=<root>/env/test-reporter.mjs), so a plain `node --test`, and a test
// file run directly with `node`, both use it.
export default async function* reporter(source) {
	const failures = [];
	for await (const event of source) {
		const { type, data } = event;
		const indent = "  ".repeat(data?.nesting ?? 0);
		if (type === "test:pass" && data.details?.type !== "suite") yield `${indent}✔ ${data.name}\n`;
		else if (type === "test:fail" && data.details?.type !== "suite") {
			yield `${indent}✖ ${data.name}\n`;
			failures.push(data);
		} else if (type === "test:diagnostic" && !/^duration_ms\b/.test(data.message)) yield `ℹ ${data.message}\n`;
		else if (type === "test:stdout" || type === "test:stderr") yield data.message;
	}
	if (failures.length > 0) yield "\n✖ failing tests:\n";
	for (const failure of failures) {
		const error = failure.details?.error?.cause ?? failure.details?.error;
		const where = failure.file ? failure.file.split("/").slice(-2).join("/") : "?";
		yield `\ntest at ${where}:${failure.line}:${failure.column}\n✖ ${failure.name}\n`;
		yield `${String(error?.message ?? error).replace(/^/gm, "  ")}\n`;
	}
}
