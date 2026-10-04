# Experiment endo.experiment.path-sensitivity-1.0.1-p11

Path-sensitivity study, path p11 (research/path-sensitivity/1.0.1/DESIGN.md)

Trials: 12 completed, 0 errored, 0 missing of 12 planned (0 interrupted and rerun). Seed 4202634358 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 6909 ms |
| tool-use | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 14172.5 ms |
| tool-use | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 10856.5 ms |
| implement-function | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 10576 ms |
| implement-function | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 15878.5 ms |
| implement-function | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 15144 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 64 | 0 |
| M2a | PASS | 12 | 0 |
| M2b | PASS | 64 | 0 |
| M3 | PASS | 12 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 2c24164c7566fb9499953a19efad4e9b80ef797e36ff1ad1d55687cec223ccc7. Details: bundle.json.
