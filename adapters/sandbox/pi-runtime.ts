import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const NODE = "/usr/bin/node";
export const PI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_VERSION = "1.5.2";
export const ENV = {
	PATH: "/usr/bin",
	LC_ALL: "C",
	HOME: "/home/agent",
	PI_CODING_AGENT_DIR: "/home/agent",
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	NODE_DISABLE_COMPILE_CACHE: "1",
};

export function trustedPiInstallation(): boolean {
	const trusted = (s: Stats) => s.uid === 0 && (s.mode & 0o022) === 0;
	for (let path = PI; ; path = dirname(path)) {
		const s = lstatSync(path);
		if (!trusted(s) || !s.isDirectory()) return false;
		if (path === "/") break;
	}
	const walk = (directory: string): boolean =>
		readdirSync(directory).every((name) => {
			const path = join(directory, name);
			const s = lstatSync(path);
			if (s.isSymbolicLink()) {
				const target = readlinkSync(path);
				return (
					s.uid === 0 &&
					!isAbsolute(target) &&
					resolve(directory, target).startsWith(PI + sep) &&
					realpathSync(path).startsWith(PI + sep)
				);
			}
			return trusted(s) && (s.isDirectory() ? walk(path) : s.isFile());
		});
	return (
		realpathSync("/usr/bin/pi") === `${PI}/dist/bundle/cli.js` &&
		walk(PI) &&
		JSON.parse(readFileSync(join(PI, "package.json"), "utf8")).version === PI_VERSION
	);
}
