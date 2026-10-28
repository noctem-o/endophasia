// Fixture-only fresh-process reader for task-owned provenance; the public key is never live attestation.
import { readTaskOwnedStudyV0 } from "../../research/governed-initial-continuation/aa/task-owned-reader.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../storage/digest-key.ts";

const [plan, flag] = process.argv.slice(2);
if (!plan || process.argv.length > 4 || (flag !== undefined && flag !== "--require-complete"))
	throw new Error("fixture plan required");
const result = await readTaskOwnedStudyV0(plan, loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0()));
process.stdout.write(JSON.stringify(result));
if (flag && result.studyAdmission !== "complete") process.exitCode = 3;
