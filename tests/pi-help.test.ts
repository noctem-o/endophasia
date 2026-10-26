import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { piHelpAdvertisesRequiredFlagsV0 } from "../cli/initial-child-execution.ts";

// Pin the governed requirements independently so a removed requirement cannot silently make these controls pass.
const flags = [
	"--no-tools",
	"--no-extensions",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-approve",
	"--offline",
	"--provider",
	"--model",
	"--session-dir",
	"--session-id",
];
const help = (declarations = flags.map((flag) => `  ${flag}`)) => `Options:\n${declarations.join("\n")}\n`;
const replaceTools = (line: string) => help(flags.map((flag) => (flag === "--no-tools" ? line : `  ${flag}`)));
const realHelp = readFileSync(new URL("./fixtures/pi-help/1.0.1.txt", import.meta.url), "utf8");

describe("governed Pi help declarations", () => {
	it.each([
		["standalone long flags", help()],
		["long option before alias", replaceTools("  --no-tools, -nt  Disable tools")],
		["alias before long option", replaceTools("  -nt, --no-tools  Disable tools")],
		["indentation", help(flags.map((flag) => `    ${flag}    description`))],
		["spaces and tabs", replaceTools("\t-nt , \t--no-tools\tDisable tools")],
		["CRLF", help().replaceAll("\n", "\r\n")],
		["argument placeholders", help(flags.map((flag) => `  ${flag}${flag === "--model" ? " <provider/id>" : ""}`))],
		["unindented declarations", help(flags)],
	])("accepts %s", (_name, text) => {
		expect(piHelpAdvertisesRequiredFlagsV0(text)).toBe(true);
	});

	it.each(flags)("refuses the incomplete list when %s is missing", (missing) => {
		expect(piHelpAdvertisesRequiredFlagsV0(help(flags.filter((flag) => flag !== missing)))).toBe(false);
	});

	it.each([
		["longer option", replaceTools("  --no-tools-extra  Disable tools")],
		["underscore suffix", replaceTools("  --no-tools_extra")],
		["substring in description", replaceTools("  --other  Equivalent to --no-tools")],
		["short alias alone", replaceTools("  -nt  Disable tools")],
		["ordinary prose", help(flags.map((flag) => `  You can use ${flag} here.`))],
		["prose beginning with a flag", replaceTools("  --no-tools is mentioned in prose")],
		["usage", `Usage:\n  pi ${flags.join(" ")}\n`],
		["examples", `Examples:\n${help()}`],
		["example option lines", `Options:\nExamples:\n${flags.map((flag) => `  ${flag}`).join("\n")}\n`],
		["indented examples", `Options:\n  Examples:\n${flags.map((flag) => `    ${flag}`).join("\n")}\n`],
		["inline flag list", help([flags.join(" ")])],
		["trailing comma", replaceTools("  --no-tools, ")],
		["duplicate option", help([...flags, "--no-tools"])],
		["duplicate Options sections", `${help()}${help()}`],
		["empty output", ""],
		["unusable output", "Pi 1.0.4\n"],
		["truncated declaration", replaceTools("  --no-tools <unfinished")],
		["truncated argument after two spaces", help().replace("--model", "--model  <unfinished")],
		["truncated argument after a tab", help().replace("--model", "--model\t<unfinished")],
		["truncated optional argument", help().replace("--model", "--model  [unfinished")],
		["alias after argument", help().replace("--model", "--model <id>  , --other")],
		["alias without comma", replaceTools("  --no-tools  -nt")],
		["missing final newline", help().trimEnd()],
		["NUL", `${help()}\0`],
		["invalid UTF-8 replacement", `${help()}\uFFFD\n`],
		["bare carriage return", help().replace("--no-tools", "--no-\rtools")],
		["terminal escapes", `\u001B[0m${help()}`],
	])("refuses %s", (_name, text) => {
		expect(piHelpAdvertisesRequiredFlagsV0(text)).toBe(false);
	});

	it("recognises realistic Pi 1.0.1 aliases but refuses its absent --no-mcp", () => {
		expect(piHelpAdvertisesRequiredFlagsV0(realHelp)).toBe(false);
		const compatible = realHelp.replace("  --no-skills", "  --no-mcp  Disable MCP\n  --no-skills");
		expect(piHelpAdvertisesRequiredFlagsV0(compatible)).toBe(true);
	});
});
