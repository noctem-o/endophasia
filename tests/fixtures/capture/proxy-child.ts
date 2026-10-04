// A recording proxy in its own process, for the crash test: records into <store> (async capture log), forwards to
// <upstream>, prints its port on stdout, and runs until killed.
//   node tests/fixtures/capture/proxy-child.ts <store> <upstream> <key hex>
import { EndoCaptureLogV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { startEndoRecordingProxyV0 } from "../../../adapters/openai-proxy/record.ts";
import { endoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";

const [store, upstream, keyHex] = process.argv.slice(2) as [string, string, string];
const log = new EndoCaptureLogV0(store, endoDigestKeyV0(Buffer.from(keyHex, "hex"), "installation"), "record", {
	async: true,
});
const proxy = await startEndoRecordingProxyV0({ upstream, log });
process.stdout.write(`${proxy.port}\n`);
await new Promise(() => {});
