// The shape of the one command surface a host may give the cockpit server (cockpit-http/server.ts), as types only, so the host that
// implements it (adapters/pi/workbench.ts) and the server that forwards to it need not import each other.

/**
 * What a host that serves a command surface gives the server: ONE handler for the routes under `api/v0/workbench/`. Without it, which
 * is every `endo studio` launch, the server has no POST route at all and behaves exactly as before. With it the server still answers
 * every request only if it passes the Host, Origin and Fetch Metadata guards, and a POST additionally needs an Origin that is
 * exactly this server's own, `Content-Type: application/json` and a body of at most `MAX_WORKBENCH_BODY` bytes. The server forwards
 * the grant header and the parsed body and nothing else; it neither reads a store nor charges the read budget for these routes, and
 * the handler (not this module) decides what any command means.
 */
export interface EndoCockpitWorkbenchRequestV0 {
	method: "GET" | "POST";
	/** The path segments after `api/v0/workbench/`. */
	route: string[];
	/** The raw query string without `?`. */
	query: string;
	/** The value of the single `x-endo-grant` header, or null. */
	grant: string | null;
	/** The parsed JSON body of a POST, or null for a GET. */
	body: unknown;
}
export interface EndoCockpitWorkbenchV0 {
	handle(request: EndoCockpitWorkbenchRequestV0): Promise<{ status: number; body: unknown }>;
}
