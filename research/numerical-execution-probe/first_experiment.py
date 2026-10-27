#!/usr/bin/env python3
"""Linux-only, bounded launcher for the frozen E4e-H first experiment."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

import probe

MODEL_SHA = "f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57"
MODEL_SIZE = 270885952
BINARY_SHA = "b043bdfbfe1648a9c0a6162c6f3e97f244d8db550c6ecd0c6824d0e695c96ec9"
TOKENS = tuple(range(10, 161, 10))
CONFIG = {"context": 512, "batch": 32, "ubatch": 32, "threads": 1}
GIB = 1024 ** 3


def require(condition, message):
    if not condition:
        raise RuntimeError("BLOCKED_RESOURCE_LIMITS: " + message)


def check_private_parent(path):
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "evidence parent must be an owner-only directory")


def service_properties(unit):
    result = subprocess.run(["systemctl", "--user", "show", unit, "--no-pager",
                             "-p", "ControlGroup", "-p", "MemoryMax", "-p", "MemorySwapMax",
                             "-p", "RuntimeMaxUSec", "-p", "TimeoutStopUSec", "-p", "KillMode",
                             "-p", "Restart", "-p", "ExecMainStartTimestampMonotonic"],
                            check=True, capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"})
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def validate_service(properties, cgroup, cpu_affinity, selected_cpu, mem_available):
    require(properties.get("ControlGroup") == cgroup, "unexpected systemd control group")
    require(properties.get("MemoryMax") == str(4 * GIB), "4 GiB cgroup limit unavailable")
    require(properties.get("MemorySwapMax") == "0", "cgroup swap limit unavailable")
    require(properties.get("RuntimeMaxUSec") == "10min", "10 minute service deadline unavailable")
    require(properties.get("TimeoutStopUSec") == "5s" and properties.get("KillMode") == "control-group",
            "cgroup cleanup unavailable")
    require(properties.get("Restart") == "no", "automatic service restart is enabled")
    require(cpu_affinity == {selected_cpu}, "single-core affinity unavailable")
    require(mem_available >= 4 * GIB, "less than 4 GiB available RAM")


def check_cgroup(cgroup):
    directory = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    require((directory / "memory.max").read_text().strip() == str(4 * GIB), "memory.max is not active")
    require((directory / "memory.swap.max").read_text().strip() == "0", "memory.swap.max is not active")


def available_memory():
    lines = Path("/proc/meminfo").read_text().splitlines()
    value = next(line for line in lines if line.startswith("MemAvailable:"))
    return int(value.split()[1]) * 1024


def check_scratch(path):
    # The mount must be this exact private tmpfs, not merely a directory on a larger filesystem.
    mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    matches = [line for line in mounts if line.split(" - ")[0].split()[4] == str(path)]
    require(len(matches) == 1 and matches[0].split(" - ")[1].split()[0] == "tmpfs",
            "private tmpfs not mounted")
    fs = os.statvfs(path)
    require(fs.f_blocks * fs.f_frsize == GIB, "scratch tmpfs is not exactly 1 GiB")


def check_artifacts(model, native):
    for path in (model, native):
        require(path.is_file() and not path.is_symlink(), "artifact missing or not a regular file")
    require(model.stat().st_size == MODEL_SIZE and probe.sha_file(model) == MODEL_SHA,
            "model commitment mismatch")
    require(probe.sha_file(native) == BINARY_SHA, "native executable commitment mismatch")


def checkpoint_to(destination):
    def checkpoint(source):
        # The tmpfs bounds all working files; copy only the manifest and fixed vector names.
        for name in [*(f"{label}.f32le" for label in probe.DEFAULT_ORDER), "manifest.json"]:
            src = source / name
            if not src.exists():
                continue
            require(src.is_file() and not src.is_symlink(), "unexpected evidence file type")
            temp = destination / (name + ".tmp")
            with src.open("rb") as inp, temp.open("wb") as out:
                shutil.copyfileobj(inp, out, 1024 * 1024)
            os.chmod(temp, 0o600)
            os.replace(temp, destination / name)
    return checkpoint


class Interrupted(RuntimeError):
    pass


def interrupted(signum, _frame):
    raise Interrupted("experiment interrupted by signal " + str(signum))


def inside(args):
    os.umask(0o077)
    model = args.model.absolute()
    native = args.native.absolute()
    evidence = args.evidence_dir.absolute()
    scratch_parent = args.scratch_parent.resolve(strict=True)
    check_private_parent(evidence.parent.resolve(strict=True))
    check_private_parent(scratch_parent)
    repo = Path(__file__).resolve().parents[2]
    require(not evidence.resolve().is_relative_to(repo), "evidence must be outside the repository")
    require(not evidence.exists(), "evidence directory already exists")
    cgroup = Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1]
    props = service_properties(args.unit)
    validate_service(props, cgroup, set(os.sched_getaffinity(0)), args.cpu, available_memory())
    check_cgroup(cgroup)
    check_artifacts(model, native)
    probe.enable_child_subreaper()
    service_start = int(props["ExecMainStartTimestampMonotonic"]) / 1_000_000
    deadline = service_start + 600
    require(time.monotonic() < deadline, "total deadline already expired")

    scratch = scratch_parent / ("scratch-" + uuid.uuid4().hex)
    scratch.mkdir(mode=0o700)
    mounted = False
    try:
        subprocess.run(["mount", "-t", "tmpfs", "-o", "size=1073741824,mode=700,nosuid,nodev,noexec",
                        "tmpfs", str(scratch)], check=True, capture_output=True)
        mounted = True
        check_scratch(scratch)
        if args.preflight_only:
            print(json.dumps({"status": "preflight-passed", "cpu_affinity": [args.cpu],
                              "memory_max_bytes": 4 * GIB, "scratch_max_bytes": GIB,
                              "model_sha256": MODEL_SHA, "native_binary_sha256": BINARY_SHA}))
            return
        evidence.mkdir(mode=0o700)
        resource_limits = {"memory_max_bytes": 4 * GIB, "memory_swap_max_bytes": 0,
                           "scratch_max_bytes": GIB, "cpu_affinity": [args.cpu],
                           "per_repetition_timeout_seconds": 120, "total_service_timeout_seconds": 600,
                           "maximum_repetitions": 4, "automatic_retries": 0,
                           "process_cleanup": "owned process group and systemd control group"}
        (evidence / "preflight.json").write_text(json.dumps({"resource_limits": resource_limits,
            "service_properties": props, "cgroup": cgroup, "available_ram_bytes": available_memory(),
            "model_sha256": MODEL_SHA, "native_binary_sha256": BINARY_SHA}, indent=2) + "\n")

        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, interrupted)
        backend = probe.NativeBackend(native, model, 120, deadline=deadline)
        result = probe.run_experiment(scratch / "run", TOKENS, CONFIG, probe.DEFAULT_ORDER, backend,
                                      checkpoint=checkpoint_to(evidence), resource_limits=resource_limits)
        print(json.dumps({"status": result["status"], "order": result["order"]}))
    finally:
        if mounted:
            subprocess.run(["umount", str(scratch)], check=False, capture_output=True)
        scratch.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-real-model", action="store_true", required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--scratch-parent", type=Path, required=True)
    parser.add_argument("--cpu", type=int, required=True)
    parser.add_argument("--preflight-only", action="store_true", help="check all limits and artifacts without inference")
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--unit", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.inside:
            require(args.unit is not None, "missing systemd unit")
            inside(args)
        else:
            require(sys.platform == "linux" and args.cpu in os.sched_getaffinity(0), "CPU unavailable")
            unit = "e4eh-" + uuid.uuid4().hex + ".service"
            command = ["systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect", "--unit", unit,
                       "-p", "MemoryMax=4G", "-p", "MemorySwapMax=0", "-p", "RuntimeMaxSec=600",
                       "-p", "TimeoutStopSec=5", "-p", "KillMode=control-group", "-p", "Restart=no",
                       "taskset", "-c", str(args.cpu), "unshare", "-Ur", "-m", sys.executable,
                       str(Path(__file__).resolve()), "--inside", "--unit", unit, "--execute-real-model",
                       "--model", str(args.model.absolute()), "--native", str(args.native.absolute()),
                       "--evidence-dir", str(args.evidence_dir.absolute()),
                       "--scratch-parent", str(args.scratch_parent.absolute()), "--cpu", str(args.cpu)]
            if args.preflight_only:
                command.append("--preflight-only")
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(sig, interrupted)
            try:
                status = subprocess.run(command, check=False).returncode
            except BaseException:
                # Only the uniquely named service created above is stopped.
                subprocess.run(["systemctl", "--user", "stop", unit], check=False, timeout=15,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                raise
            if status and not args.evidence_dir.exists():
                print("e4eh: BLOCKED_RESOURCE_LIMITS: bounded service or preflight failed", file=sys.stderr)
            return status
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"e4eh: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
