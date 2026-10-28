import { execFile } from "node:child_process";

// pidfd_getfd is syscall 438 on the explicitly supported Linux x86-64 and arm64 ABIs.
// The helper duplicates only the already identified socket and calls read-only fstat/getsockopt.
const script = `import os,sys,ctypes,socket,stat
try:
 pid,fd,inode=map(int,sys.argv[1:])
 p=os.pidfd_open(pid,0)
 libc=ctypes.CDLL(None,use_errno=True)
 dup=libc.syscall(438,p,fd,0)
 os.close(p)
 if dup < 0: print("UNAVAILABLE")
 else:
  try:
   info=os.fstat(dup)
   if not stat.S_ISSOCK(info.st_mode) or info.st_ino != inode: print("CHANGED")
   else:
    s=socket.socket(fileno=dup)
    try: print("ENABLED" if s.getsockopt(socket.SOL_SOCKET,socket.SO_REUSEPORT) else "DISABLED")
    finally: s.close()
    dup=-1
  finally:
   if dup >= 0: os.close(dup)
except Exception: print("UNAVAILABLE")
`;
export type ReusePortStatusV0 = "MATCH" | "MISMATCH" | "UNAVAILABLE";
export function classifyReusePortResultV0(stdout: string, failed: boolean): ReusePortStatusV0 {
	if (failed) return "UNAVAILABLE";
	if (stdout === "DISABLED\n") return "MATCH";
	if (stdout === "ENABLED\n" || stdout === "CHANGED\n") return "MISMATCH";
	return "UNAVAILABLE";
}

/** Unavailable Python, unsupported ABI, denied ptrace, malformed output or timeout all fail closed. */
export async function inspectReusePortV0(
	pid: number,
	fd: string,
	inode: string,
	signal: AbortSignal,
): Promise<ReusePortStatusV0> {
	if (
		process.platform !== "linux" ||
		!["x64", "arm64"].includes(process.arch) ||
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		!/^[0-9]+$/.test(fd) ||
		!/^[0-9]+$/.test(inode) ||
		signal.aborted
	)
		return "UNAVAILABLE";
	return new Promise((resolve) => {
		execFile(
			"/usr/bin/python3",
			["-I", "-S", "-c", script, String(pid), fd, inode],
			{
				timeout: 1500,
				maxBuffer: 1024,
				signal,
				env: {},
				windowsHide: true,
			},
			(error, stdout) => {
				return resolve(classifyReusePortResultV0(stdout, !!error || signal.aborted));
			},
		);
	});
}
