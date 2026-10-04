// A client in its own process, so the proxy's event loop cannot delay what it observes: connects to 127.0.0.1:<port>,
// sends one request, and prints {lastData, end}: milliseconds from its own start to the last byte and to the close.
//   node tests/fixtures/capture/timed-client.mjs <port>
import { connect } from "node:net";

const start = performance.now();
let lastData = 0;
const socket = connect({ host: "127.0.0.1", port: Number(process.argv[2]) }, () =>
	socket.write("POST /v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}"),
);
socket.on("data", () => {
	lastData = performance.now() - start;
});
socket.on("end", () => {
	process.stdout.write(`${JSON.stringify({ lastData, end: performance.now() - start })}\n`);
	process.exit(0);
});
socket.on("error", (error) => {
	process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
	process.exit(1);
});
