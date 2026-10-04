# Experiment endo.experiment.path-sensitivity-1.0.1-p16

Path-sensitivity study, path p16 (research/path-sensitivity/1.0.1/DESIGN.md)

Trials: 12 completed, 0 errored, 0 missing of 12 planned (0 interrupted and rerun). Seed 1907120307 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 6961 ms |
| tool-use | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 13371.5 ms |
| tool-use | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 10575.5 ms |
| implement-function | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 11399 ms |
| implement-function | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 13561 ms |
| implement-function | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 17053 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 62 | 0 |
| M2a | PASS | 12 | 0 |
| M2b | PASS | 62 | 0 |
| M3 | PASS | 12 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 520a09d4be5327254e0e650b0d5ebfb9c837f691ef27b3e407566401f48d79ad. Details: bundle.json.
