// DEVELOP-VERIFY-TRUST-003 guest run, ENDO-11 remediation: the matrix driver's control flow (reviews 4627690170, 4627690189) and the
// probe's process discovery (review 4627583985). The driver is sourced with MATRIX_LIB=1 and its system-facing functions are replaced by
// recorders, so each test sees exactly which stages ran.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MATRIX = join(REPO, "research/develop-verify-trust-003/guest/matrix.sh");
const PROBE = join(REPO, "research/develop-verify-trust-003/guest/probe.py");
const scratch = mkdtempSync(join(tmpdir(), "dvt003-driver-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GOOD_GATE = JSON.stringify({ h0: true, closure: true, checks: [] });
/** Run main() with recorded stand-ins. `gate` is the audit's stdout, `active` how many polls a run stays active (-1: forever). */
function drive(o: {
	gate?: string;
	gateExit?: number;
	sudoErr?: string;
	sudoOut?: string;
	active?: number;
	stopWorks?: boolean;
	status?: string;
	readerExit?: number;
	name: string;
}) {
	const out = mkdtempSync(join(scratch, `${o.name}-`));
	const calls = join(out, "calls");
	writeFileSync(join(out, "gate.fixture"), o.gate ?? GOOD_GATE);
	const script = `
set -u
MATRIX_LIB=1 OUT=${out} POLL_BUDGET=3 source ${MATRIX}
OUT=${out}; POLL_BUDGET=3
rec() { echo "$*" >> ${calls}; }
sleep() { :; }
inspect() { rec inspect "$1"; }
policy_review() { rec policy_review; }
agent() {
  local name=$1; rec agent "$name"
  case "$name" in
    identity) echo "uid=1500(endoagent) gid=1500(endoagent) groups=1500(endoagent)" > "$OUT/identity.out"; return 0 ;;
    gate) cp ${out}/gate.fixture "$OUT/gate.out"; return ${o.gateExit ?? 0} ;;
    sudo-n) printf '%s\n' '${o.sudoOut ?? "status=1"}' > "$OUT/sudo-n.out"; printf '%s\n' '${o.sudoErr ?? "sudo: a password is required"}' > "$OUT/sudo-n.err"; return 0 ;;
    *) return 0 ;;
  esac
}
polls=0
start_run() { rec start_run "$1"; polls=0; stopped=no; }
on_prompts() { :; }
unit_active() { polls=$((polls + 1)); if [ "$stopped" = yes ]; then [ ${o.stopWorks === false ? "yes" : "no"} = yes ]; return; fi; [ ${o.active ?? 1} -lt 0 ] || [ $polls -le ${o.active ?? 1} ]; }
stop_unit() { rec stop_unit "$1"; stopped=yes; }
run_status() { echo ${o.status ?? 0}; }
trusted_read() { rec trusted_read; return ${o.readerExit ?? 0}; }
collect() { rec collect; }
cat() { if [ "$1" = /root/stage/commit ]; then echo deadbeef; else command cat "$@"; fi; }
main; echo "main=$?" >> ${calls}
`;
	const r = spawnSync("/usr/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin" } });
	const recorded = (() => {
		try {
			return readFileSync(calls, "utf8").trim().split("\n");
		} catch {
			return [];
		}
	})();
	return {
		recorded,
		stdout: r.stdout,
		stderr: r.stderr,
		exits: (() => {
			try {
				return readFileSync(join(out, "exits.txt"), "utf8");
			} catch {
				return "";
			}
		})(),
	};
}
const stagesIn = (recorded: string[], stage: RegExp) => recorded.filter((c) => stage.test(c));

describe("matrix driver: a failed first stop stops everything (review 4627690170)", () => {
	it("runs the whole matrix when every first-stop condition holds (positive control)", () => {
		const d = drive({ name: "ok" });
		expect(d.recorded).toEqual([
			"inspect inspect-before.txt",
			"agent identity",
			"agent gate",
			"agent sudo-n",
			"policy_review",
			"agent probe-idle",
			"start_run 1",
			"start_run 2",
			"trusted_read",
			"collect",
			"main=0",
		]);
	});
	for (const [name, gate] of [
		["h0:false", JSON.stringify({ h0: false, closure: true })],
		["closure:false", JSON.stringify({ h0: true, closure: false })],
		["h0 missing", JSON.stringify({ closure: true })],
		["h0 as a string", JSON.stringify({ h0: "true", closure: true })],
		["malformed audit JSON", "{h0: true"],
		["empty audit output", ""],
	] as const)
		it(`aborts with ${name}: no probe, no run, no read`, () => {
			const d = drive({ name: name.replace(/\W/g, ""), gate });
			expect(stagesIn(d.recorded, /probe|start_run|trusted_read|policy_review|collect/)).toEqual([]);
			expect(d.recorded.at(-1)).toBe("main=3");
			expect(d.exits).toMatch(/ABORT: first stop failed/);
		});
	it("aborts when the audit itself exits non-zero, even with a passing JSON", () => {
		const d = drive({ name: "auditexit", gateExit: 3 });
		expect(stagesIn(d.recorded, /probe|start_run|trusted_read/)).toEqual([]);
		expect(d.recorded.at(-1)).toBe("main=3");
	});
	for (const [name, sudoOut, sudoErr] of [
		["sudo success", "status=0", ""],
		[
			"traced sudo",
			"status=1",
			"sudo: effective uid is not 0, is /usr/bin/sudo on a file system with the 'nosuid' option set",
		],
		["missing sudo", "status=127", "bash: /usr/bin/sudo: No such file or directory"],
		["sudo-rs wording", "status=1", "sudo: interactive authentication is required"],
	] as const)
		it(`aborts on ${name}: only classic sudo's policy refusal passes`, () => {
			const d = drive({ name: name.replace(/\W/g, ""), sudoOut, sudoErr });
			expect(stagesIn(d.recorded, /probe|start_run|trusted_read/)).toEqual([]);
			expect(d.recorded.at(-1)).toBe("main=3");
		});
});

describe("matrix driver: the polling budget (review 4627690189)", () => {
	it("preserves a failed trusted read after collecting the evidence", () => {
		const d = drive({ name: "reader-failure", readerExit: 1 });
		expect(d.recorded.slice(-3)).toEqual(["trusted_read", "collect", "main=1"]);
	});
	it("stops the run's own unit, records it, and starts no further run and no read", () => {
		const d = drive({ name: "budget", active: -1 });
		expect(d.recorded).toContain("stop_unit endoagent-run-1.service");
		expect(stagesIn(d.recorded, /start_run 2|trusted_read|collect/)).toEqual([]);
		expect(d.recorded.at(-1)).toBe("main=5");
		expect(d.exits).toMatch(/run-1 exceeded the polling budget \(3\); unit stopped/);
	});
	it("says so when the stop did not take", () => {
		const d = drive({ name: "budget-stuck", active: -1, stopWorks: false });
		expect(d.exits).toMatch(/stop FAILED, unit still active/);
		expect(stagesIn(d.recorded, /start_run 2|trusted_read/)).toEqual([]);
	});
	it("continues normally when a run ends within the budget", () => {
		const d = drive({ name: "within", active: 2 });
		expect(stagesIn(d.recorded, /stop_unit/)).toEqual([]);
		expect(stagesIn(d.recorded, /start_run|trusted_read/)).toEqual(["start_run 1", "start_run 2", "trusted_read"]);
	});
	it("does not continue past a run that ended with an unexpected status (IP0 refusal is 3)", () => {
		const d = drive({ name: "status3", status: "3" });
		expect(stagesIn(d.recorded, /start_run 2|trusted_read/)).toEqual([]);
		expect(d.recorded.at(-1)).toBe("main=6");
	});
});

describe("probe: process discovery under churn (review 4627583985)", () => {
	const py = (code: string) => spawnSync("/usr/bin/python3", ["-I", "-c", code, PROBE], { encoding: "utf8" });
	const load =
		"import importlib.util,sys,json,errno\ns=importlib.util.spec_from_file_location('probe',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)\n";
	it("skips a process that vanished between listing and stat, keeps the rest, and reports other errors instead of hiding them", () => {
		const r = py(`${load}
def st(path):
    pid = path.rsplit('/', 1)[1]
    if pid == '20': raise FileNotFoundError(errno.ENOENT, 'gone', path)
    if pid == '30': raise PermissionError(errno.EACCES, 'denied', path)
    class S: st_uid = 968 if pid in ('10', '40') else 1000
    return S()
print(json.dumps(p.verifier_pids(968, listdir=lambda _: ['10', 'self', '20', '30', '40', '50'], stat=st)))`);
		expect(r.stderr).toBe("");
		expect(JSON.parse(r.stdout)).toEqual({ pids: [10, 40], vanished: [20], errors: [{ pid: 30, error: "EACCES" }] });
	});
	it("does nothing at import: no account lookup, no attempt", () => {
		const r = py(`${load}print('imported', hasattr(p, 'main'))`);
		expect(r.stdout.trim()).toBe("imported True");
	});
});
