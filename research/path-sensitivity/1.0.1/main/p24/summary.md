# Experiment endo.experiment.path-sensitivity-1.0.1-p24

Path-sensitivity study, path p24 (research/path-sensitivity/1.0.1/DESIGN.md)

Trials: 12 completed, 0 errored, 0 missing of 12 planned (0 interrupted and rerun). Seed 1266915492 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 7675 ms |
| tool-use | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 15012 ms |
| tool-use | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 11695.5 ms |
| implement-function | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 12063 ms |
| implement-function | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 26192.5 ms |
| implement-function | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 17602.5 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 66 | 0 |
| M2a | PASS | 12 | 0 |
| M2b | PASS | 66 | 0 |
| M3 | PASS | 12 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 836265011154115aeba492bec02625cd2e7f3f963551c3a79f0eb036c1710a2e. Details: bundle.json.
