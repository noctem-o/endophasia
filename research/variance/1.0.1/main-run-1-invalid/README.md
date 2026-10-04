# Main run 1: invalid (a measurement artifact of the recording proxy)

The first main run (180 trials, seed 363281846, 2026-10-04 07:05–07:32) is **invalid** and is not interpreted. It is
kept as evidence of the artifact that invalidates it. See DESIGN.md §12, deviation 2.

## What was wrong

- **The symptom.** Many trials had a turn that ended with Pi's `Connection error.`: on `implement-function`, 13 of 20
  in arm A, 9 in B and 13 in B+C.
- **The control.** 20 trials of the same task sent straight to the same llama.cpp, without the proxy, had none.
- **The cause** (from a failing trial's timeline):
  1. llama.cpp closes the connection after each response.
  2. The recording proxy recorded each exchange (fsync'd writes) before relaying that close, so for 1–3 ms Pi still
     saw an open connection.
  3. After an instant tool, Pi sent its next request into the closing connection.

  Those error turns change the lifecycle and outcome layers, and so the measured variance. The pre-registered
  manipulation checks could not see this: they check what a request carries, not whether it arrived.
- **The fix** is commit 688d9ad18 ("Fix the recording proxy …"). Through the fixed proxy, 20 trials of the same task
  had 0 connection errors.

## Files

| File | Contents |
| :--- | :--- |
| `bundle.json`, `summary.md` | the report of the invalid run, unchanged |
| `experiment.json`, `plan.json` | the run's spec record and trial order |
| `connection-errors.json` | trials with a `Connection error.` turn: per cell of this run, for the fixed-proxy check, and for the direct control |
