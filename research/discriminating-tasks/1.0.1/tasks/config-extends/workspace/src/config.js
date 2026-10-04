export function loadConfig(file, { readFile } = {}) {
	if (typeof file !== "string" || file === "") throw new TypeError("file must be a non-empty string");
	if (typeof readFile !== "function") throw new TypeError("readFile must be a function");
	const parsed = JSON.parse(readFile(file));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError(`${file}: config must be a JSON object`);
	}
	return parsed;
}
