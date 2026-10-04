// The child half of a cassette session's kill step (cassette-session.ts): open the session on the given store, send the
// prompt, report Pi's pid on stdout, and wait to be SIGKILLed. Pi runs in its own process group with a keeper, so it
// ends when this process is killed. If nobody kills it, it closes the session normally after the timeout.
//
//   node cli/cassette-child.ts <base64 JSON {config, text, timeoutMs}>

import { type PiCassetteAttachmentConfigV0, piCassetteAttachmentV0 } from "./cassette-session.ts";

const { config, text, timeoutMs } = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as {
	config: PiCassetteAttachmentConfigV0;
	text: string;
	timeoutMs: number;
};

try {
	const session = await piCassetteAttachmentV0(config).openSession();
	await session.prompt(text);
	process.stdout.write(`${JSON.stringify({ piPid: session.pid ?? null })}\n`);
	await new Promise((done) => setTimeout(done, timeoutMs));
	await session.close();
	process.exit(0);
} catch (error) {
	process.stderr.write(`${(error as Error).message}\n`);
	process.exit(1);
}
