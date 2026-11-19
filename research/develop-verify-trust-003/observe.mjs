import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";

const observe = (fn) => {
	try {
		fn();
		return "ok";
	} catch (e) {
		return e.code;
	}
};
const rule = "/agent/rule.txt";
const p = "/tmp/permission-control";
fs.writeFileSync(p, "control", { mode: 0, flag: "wx" });
const denied = observe(() => fs.readFileSync(p));
fs.chmodSync(p, 0o600);
const readable = fs.readFileSync(p, "utf8");
fs.unlinkSync(p);
const routes = fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
const observation = {
	uid: process.getuid(),
	gid: process.getgid(),
	groups: process.getgroups(),
	netns: fs.readlinkSync("/proc/self/ns/net"),
	interfaces: Object.keys(os.networkInterfaces()),
	routes,
	ipv6Routes: fs.readFileSync("/proc/net/ipv6_route", "utf8").trim().split("\n").filter(Boolean),
	rule: fs.readFileSync(rule, "utf8").trim(),
	writeOpen: observe(() => fs.closeSync(fs.openSync(rule, "r+"))),
	denied,
	readable,
	docker: observe(() => fs.statSync("/run/docker.sock")),
	libvirt: observe(() => fs.statSync("/run/libvirt/libvirt-sock")),
	bridge: fs.readFileSync("/proc/net/tcp", "utf8").split("\n").filter((line) => line.split(/\s+/).includes("0100007F:46A0") && line.trim().split(/\s+/)[3] === "0A").length,
};
console.log("TRUST003", JSON.stringify(observation));
assert.deepEqual(observation.interfaces, ["lo"]);
assert.equal(routes.length, 0);
assert.ok(observation.ipv6Routes.every((line) => line.trim().endsWith(" lo")));
assert.notEqual(observation.netns, fs.readFileSync("/agent/host-netns.txt", "utf8"));
assert.equal(observation.rule, "Count strictly positive numbers. Zero does not count.");
assert.equal(observation.writeOpen, "EROFS");
assert.equal(denied, "EACCES");
assert.equal(readable, "control");
assert.equal(observation.docker, "ENOENT");
assert.equal(observation.libvirt, "ENOENT");
assert.equal(observation.bridge, process.env.ENDO_MODEL_ORIGIN ? 1 : 0);
