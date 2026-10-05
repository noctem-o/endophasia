// A plausible wrong solution: decodeURIComponent, no error handling, drops ".." at the root, trims trailing slashes.
export function normalizeRoute(path) {
	const stack = [];
	for (const segment of decodeURIComponent(path).split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") stack.pop();
		else stack.push(segment);
	}
	return `/${stack.join("/")}`;
}
