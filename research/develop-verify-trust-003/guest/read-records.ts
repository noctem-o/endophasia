// DEVELOP-VERIFY-TRUST-003 guest run: the trusted reader's command line. Run as guest root after the matrix.
// For every invocation in the protected state root (records, and journals without one) it reports authenticity, binding and an
// independent grade of the verified bytes separately (reader.ts). Nothing the harness wrote (results.json, logs) is an input.
// Exit 0 only when no authentic PASS is false or unconfirmed.
//   node read-records.ts <installDir> <agent workspace>...
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invocations, type Oracle, readRecord } from "./reader.ts";

const [installDir, ...workspaces] = process.argv.slice(2);
if (installDir === undefined) throw new Error("usage: read-records.ts <installDir> <agent workspace>...");
const state = "/var/lib/endo-verify-002";
const id = (flag: string, user: string) => {
	const lookup = spawnSync("/usr/bin/id", [flag, user], { encoding: "utf8" });
	const text = lookup.stdout?.trim();
	if (lookup.status !== 0 || !/^[1-9]\d*$/.test(text ?? ""))
		throw new Error(`cannot resolve non-root identity: ${user}`);
	return Number(text);
};
const verifierUid = id("-u", "endo-verify-002");
const agent = { uid: id("-u", "endoagent"), gid: id("-g", "endoagent") };
const oracle = JSON.parse(readFileSync(join(installDir, "oracle/roman-numerals-cli/manifest.json"), "utf8")) as Oracle;
const repos = workspaces.flatMap((w) => readdirSync(join(w, "repos")).map((r) => join(w, "repos", r)));
const rows = [];
for (const invocation of invocations(state))
	rows.push(await readRecord({ state, installDir, verifierUid, invocation, repos, agent, oracle }));
const authenticPass = rows.filter((r) => r.authenticity.authoritative && r.authenticity.class === "PASS");
const summary = {
	verifierUid,
	invocations: rows.length,
	authoritative: rows.filter((r) => r.authenticity.authoritative).length,
	incomplete: rows.filter((r) => r.authenticity.class === "INCOMPLETE").map((r) => r.invocation),
	authenticPass: authenticPass.length,
	confirmedPass: rows.filter((r) => r.confirmedPass).length,
	falsePasses: rows.filter((r) => r.falsePass).map((r) => r.invocation),
	unconfirmedPasses: rows.filter((r) => r.unconfirmedPass).map((r) => r.invocation),
};
console.log(JSON.stringify({ ...summary, rows }, null, 1));
process.exitCode =
	summary.confirmedPass > 0 && summary.falsePasses.length === 0 && summary.unconfirmedPasses.length === 0 ? 0 : 1;
