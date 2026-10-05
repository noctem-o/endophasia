export function createClient({ fetchImpl, now = Date.now } = {}) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
	return {
		async get(url) {
			if (typeof url !== "string" || url === "") throw new TypeError("url must be a non-empty string");
			const response = await fetchImpl(url);
			return { status: response.status, body: response.body };
		},
	};
}
