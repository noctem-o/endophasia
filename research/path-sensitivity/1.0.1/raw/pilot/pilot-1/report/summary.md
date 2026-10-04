# Experiment endo.experiment.path-sensitivity-1.0.1-pilot-1

Path-sensitivity study, path pilot-1 (research/path-sensitivity/1.0.1/DESIGN.md)

Trials: 12 completed, 0 errored, 0 missing of 12 planned (0 interrupted and rerun). Seed 278483486 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 7731 ms |
| tool-use | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 14586.5 ms |
| tool-use | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 11388 ms |
| implement-function | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 11298 ms |
| implement-function | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 25028 ms |
| implement-function | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 17040.5 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 64 | 0 |
| M2a | PASS | 12 | 0 |
| M2b | PASS | 64 | 0 |
| M3 | PASS | 12 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 07a49f5187cd3010a453f63a9779ebd05e136b299d19174edef48cff1cce7db0. Details: bundle.json.
