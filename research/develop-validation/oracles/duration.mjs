// Independent oracle for T2, written by hand before any candidate was examined. Run from the candidate repository:
//   node <this file> <repo>    Prints one line per case and "ORACLE PASS" or "ORACLE FAIL". Criteria 2 and 5 (README, no new files)
// are judged from the diff and are reported separately by the study, not here.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const repo = process.argv[2];
const m = await import(pathToFileURL(join(repo, "src/duration.mjs")).href);
let fail = false;
const eq = (label, got, want) => { const ok = got === want; if (!ok) fail = true; console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); };
const call = (f) => { try { return f(); } catch { return "rejected"; } };
eq("parse 1d2h", call(() => m.parseDuration("1d2h")), 93600);
eq("parse 2d", call(() => m.parseDuration("2d")), 172800);
eq("format 90061", call(() => m.formatDuration(90061)), "1d1h1m1s");
eq("format 86400", call(() => m.formatDuration(86400)), "1d");
eq("parse 1h30m", call(() => m.parseDuration("1h30m")), 5400);
eq("format 5400", call(() => m.formatDuration(5400)), "1h30m");
eq("format 0", call(() => m.formatDuration(0)), "0s");
for (const bad of ["5s2h", "1h1h", "1d1d", "2h1d", "", " 1h", "1.5h", "-1h", "1x"]) eq(`reject ${JSON.stringify(bad)}`, call(() => m.parseDuration(bad)), "rejected");
console.log(fail ? "ORACLE FAIL" : "ORACLE PASS");
