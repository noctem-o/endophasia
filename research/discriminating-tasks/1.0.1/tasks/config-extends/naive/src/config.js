// A plausible wrong solution: shallow merge, no cycle detection, no path normalization, plain assignment.
import { dirname, join } from "node:path/posix";

export function loadConfig(file, { readFile } = {}) {
	if (typeof file !== "string" || file === "") throw new TypeError("file must be a non-empty string");
	if (typeof readFile !== "function") throw new TypeError("readFile must be a function");
	const parsed = JSON.parse(readFile(file));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError(`${file}: config must be a JSON object`);
	}
	const { extends: ext, ...own } = parsed;
	let result = {};
	for (const name of [ext ?? []].flat()) result = Object.assign(result, loadConfig(join(dirname(file), name), { readFile }));
	return Object.assign(result, own);
}
