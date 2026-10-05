import { dirname, isAbsolute, join, normalize } from "node:path/posix";

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function clone(value) {
	if (isPlain(value)) return merge({}, value);
	if (Array.isArray(value)) return value.map(clone);
	return value;
}

function merge(base, over) {
	const out = {};
	for (const key of Object.keys(base)) setOwn(out, key, clone(base[key]));
	for (const key of Object.keys(over)) {
		const current = Object.hasOwn(out, key) ? out[key] : undefined;
		setOwn(out, key, isPlain(current) && isPlain(over[key]) ? merge(current, over[key]) : clone(over[key]));
	}
	return out;
}

export function loadConfig(file, { readFile } = {}) {
	if (typeof file !== "string" || file === "") throw new TypeError("file must be a non-empty string");
	if (typeof readFile !== "function") throw new TypeError("readFile must be a function");
	const raw = new Map();
	const done = new Map();

	function resolveFile(path, chain) {
		if (chain.includes(path)) throw new RangeError(`cycle: ${[...chain, path].join(" -> ")}`);
		if (done.has(path)) return done.get(path);
		if (!raw.has(path)) raw.set(path, readFile(path));
		let parsed;
		try {
			parsed = JSON.parse(raw.get(path));
		} catch (error) {
			throw new SyntaxError(`${path}: ${error.message}`);
		}
		if (!isPlain(parsed)) throw new TypeError(`${path}: config must be a JSON object`);
		const extend = Object.hasOwn(parsed, "extends") ? parsed.extends : undefined;
		let names = [];
		if (typeof extend === "string") names = [extend];
		else if (Array.isArray(extend) && extend.every((n) => typeof n === "string")) names = extend;
		else if (extend !== undefined) throw new TypeError(`${path}: extends must be a string or an array of strings`);
		const own = { ...parsed };
		delete own.extends;
		let result = {};
		for (const name of names) {
			const target = normalize(isAbsolute(name) ? name : join(dirname(path), name));
			result = merge(result, resolveFile(target, [...chain, path]));
		}
		result = merge(result, own);
		done.set(path, result);
		return result;
	}

	return clone(resolveFile(normalize(file), []));
}
