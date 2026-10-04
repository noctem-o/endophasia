const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export function normalizeRoute(path) {
	if (typeof path !== "string" || !path.startsWith("/") || /[?#]/.test(path)) throw new TypeError("not a route path");
	if (/%(?![0-9A-Fa-f]{2})/.test(path)) throw new SyntaxError("bad percent escape");
	const decoded = path.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex) => {
		const ch = String.fromCharCode(Number.parseInt(hex, 16));
		return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
	});
	const raw = decoded.split("/");
	const last = raw[raw.length - 1];
	const trailing = last === "" || last === "." || last === "..";
	const stack = [];
	for (const segment of raw) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (stack.length === 0) throw new RangeError("path climbs above the root");
			stack.pop();
		} else stack.push(segment);
	}
	if (stack.length === 0) return "/";
	return `/${stack.join("/")}${trailing ? "/" : ""}`;
}
