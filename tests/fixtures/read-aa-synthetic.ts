// Fixture-only fresh-process reader; public key and synthetic evidence are never live attestation.
import { readStudy } from "../../research/governed-initial-continuation/aa/reader.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../storage/digest-key.ts";

const plan = process.argv[2];
if (!plan || process.argv.length !== 3) throw new Error("fixture plan required");
const result = await readStudy(plan, loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0()));
if (result.syntheticAdmission !== "verified") throw new Error("synthetic admission unavailable");
process.stdout.write(
	JSON.stringify({
		status: result.status,
		syntheticAdmission: result.syntheticAdmission,
		serverIdentity: result.serverIdentity,
	}),
);
