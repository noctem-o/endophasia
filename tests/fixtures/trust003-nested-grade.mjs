import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gradeFiles } from "../../research/develop-verify-trust-003/guest/reader.ts";

process.umask(0o077);
const uid = process.geteuid();
const grader = uid === 0 ? 65534 : uid;
const files = {
	"lib/nested/value.mjs": "export default 42;",
	"main.mjs": `import value from "./lib/nested/value.mjs";
console.log(process.geteuid(), value);`,
	"deny.mjs": `import { statSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(process.geteuid(), ${grader});
for (const path of [".","lib","lib/nested","lib/nested/value.mjs"]) {
  const s = statSync(path);
  assert.equal(s.mode & 0o222, 0);
  assert.throws(() => writeFileSync(s.isDirectory() ? path+"/new" : path, ""), e => ["EACCES","EROFS"].includes(e.code));
}
console.log("denied");`,
};
const result = await gradeFiles(Object.entries(files).map(([path, text]) => ({
	path, mode: "100644", bytes: Buffer.byteLength(text), content: Buffer.from(text),
	sha256: createHash("sha256").update(text).digest("hex"),
})), {
	timeoutMs: 3000, maxOutputBytes: 65536,
	cases: [
		{name:"nested-import-as-grader", argv:["node","main.mjs"], expect:{exitCode:0,stdout:`${grader} 42\n`}},
		{name:"no-writable-stage", argv:["node","deny.mjs"], expect:{exitCode:0,stdout:"denied\n"}},
	],
});
console.log(JSON.stringify({ stagerUid: uid, expectedGraderUid: grader, umask: process.umask().toString(8), result }));
assert.equal(result.correct, true);
