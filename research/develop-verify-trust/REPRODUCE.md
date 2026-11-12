# Reproducing DEVELOP-VERIFY-TRUST-001

## Prerequisites (declared; the runner refuses or reports BLOCKED without them)

- Linux with unprivileged user namespaces; `/usr/bin/bwrap` root-owned and not setuid; a systemd user manager reachable at
  `/run/user/<uid>`, with cgroup v2.
- Root-owned `/usr/bin/{node,git,systemd-run,systemctl,sh,env,id,dirname,tar,timeout}`. Node 26 runs the TypeScript sources directly;
  no build is needed.
- `node_modules` installed (`npm ci`) in the checkout, for the ordinary `endo` CLI. No network is used while the study runs.
- An empty directory **outside the repository**, with no `oracle/manifest.json` in any directory above it (the runner checks this).

## One complete run

```sh
git checkout 9c8b6ff79                      # the frozen runner (any later commit of this branch has the same runner)
W=$(mktemp -d -p ~/some/scratch/place)      # outside the repository
env -i PATH=/usr/bin HOME=$HOME LANG=C.UTF-8 XDG_RUNTIME_DIR=/run/user/$(id -u) \
  /usr/bin/node research/develop-verify-trust/study.ts run "$W"
# about 130 s; prints one line per row and the acceptance; writes $W/out/{results.json,records/,evidence/}
```

Two runs are compared with:

```sh
node research/develop-verify-trust/study.ts compare <run-1>/out/results.json <run-2>/out/results.json   # {"identical":true,...}
```

## From the committed evidence alone

```sh
node research/develop-verify-trust/table.ts research/develop-verify-trust/results/run-1   # re-reads all 35 records; 0 mismatches
```

## One verification by hand

```sh
P=3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31
sh research/develop-verify-trust/run.sh run --mechanism sandbox --oracle <dir>/oracle/manifest.json --oracle-sha256 $P \
   --repo <candidate repository> --commit <full commit id> --out <record.json>       # exit 0 PASS, 1 FAIL, 3 BLOCKED, 4 INCOMPLETE
sh research/develop-verify-trust/run.sh read <record.json> --oracle <dir>/oracle/manifest.json --oracle-sha256 $P
```

`--mechanism filtered` runs the same cases on the host with the rebuilt environment. Keep the oracle outside the candidate's repository.
Under `filtered`, the candidate can read it anyway; that is row 6x.

## What the recorded runs were

- Run 1: from the research worktree at `9c8b6ff79`, into `../endophasia-research/develop-verify-trust-001/raw/run-1`.
- Run 2: from a fresh `git clone --no-local` checked out at `9c8b6ff79`, into `…/raw/run-2`.
- The ablation in `results/run-1/ablation/`: after run 1, in its workspace. It ran C2 through `run.sh run --mechanism filtered` twice,
  once with the oracle at `oracle/manifest.json` and once with the same bytes at `oracle-renamed/manifest.oracle`.

The raw workspaces (9.6 MB, without the 65 MB user-owned node copies used by row 7d) stay in `../endophasia-research/`; they are not
committed.
