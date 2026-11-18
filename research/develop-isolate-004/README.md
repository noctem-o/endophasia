# A bounded coding experiment, not a writable Everyday grant

On the supported Arch host, stock Pi 1.5.2 can repair a disposable source file through the fixed local Ornith relay using just `read` and `edit`. This experiment uses the existing protected-run controller and record format. It does **not** start an interactive workbench, accept a host project, promote files or change Strict, Protected or Everyday.

The generator takes a **new** condition directory beneath an operator-owned private experiment directory. It creates the condition and writes a spec, but does not run Pi. Inspect the spec before launching. Its two source files are literals; the starting bytes do not depend on a live checkout. Do not point an experiment or evidence directory into a shared or agent-writable directory.

```sh
run=$(mktemp -d)
mkdir "$run/home"
node research/develop-isolate-004/pilot.ts "$run/agent" > "$run/spec.json"
# Inspect "$run/spec.json" before running the experiment.
HOME="$run/home" node cli/index.ts experiment protected-run "$run/spec.json" --out "$run/result"
node cli/index.ts experiment protected-report "$run/result"
attempt="$run/result/trials/merge-intervals/pi/0/attempt-1"
jq '{agent, preflight: .preflight.status, submission, evaluation, invalidating}' "$attempt/record.json"
```

Only after the record reports confirmed termination and a collected submission, review the **staged submission**, not the untrusted working directory. For this fixed text fixture the following produces a deterministic diff (exit 1 means differences); do not run, source or automatically apply its contents. Keep the experiment directory private: the recorder stores a private digest key there.

```sh
jq -j '.tasks[0].workspace["src/interval.mjs"]' "$run/spec.json" |
  diff -u --label a/src/interval.mjs --label b/src/interval.mjs - "$attempt/submission/src/interval.mjs" > "$run/review.patch"
sha256sum "$run/review.patch" "$attempt/submission/src/interval.mjs"
```

**Observed on Arch:** Pi reported one read and one edit, and the controller recorded three HTTP 200 exchanges. The collected patch changed `pair[0] < last[1]` to `pair[0] <= last[1]`. A separate offline evaluation passed seven cases; an unchanged submission from a process exiting zero passed six. The patch digest was `0291d75b1d51f09cc9b7159daf2defe2eb19873e72a59b3dd5ecd44fe8d52f02`. Only the patch and the protected evaluation establish the behavioral difference. Tool start/end messages are Pi's account, not kernel-authenticated per-writer evidence. No general shell is offered or mounted. Node itself is an executable runtime, so the filesystem, namespace and scope restrictions still matter.

**Why the interactive route stays off:** the launch check follows Pi, not every process it could create. A detached synthetic child matched seven namespace identities at one observation and its identity disappeared on teardown; substituting each host namespace identity failed the comparison. A sampled child cannot establish the lifetime invariant for other descendants. Revoking the page grant rejects later dispatches; that is not proof that an in-flight Pi tool loop stopped. A real project also needs a reviewed change set beyond a declared submission file, provenance that labels admission as a non-atomic copy, and bounded writable storage. This experiment exports only one declared file and grants no authority over a real checkout. Running it successfully does not close those gates.
