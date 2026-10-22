// The one place the Studio frontend's other modules reach the pure logic about the contract: the closed vocabularies and their wording
// (labels.ts), the version-checking classifier of what the server answers (reply.ts), and the pure view functions (views.ts: usage that
// is never summed, filters that never reach beyond the loaded window, a pager read off the watermark). They have no DOM and no network,
// and they are where the rules that keep a page from claiming more than the record permits live, each with a test.
export * from "./labels.ts";
export * from "./reply.ts";
export * from "./views.ts";
