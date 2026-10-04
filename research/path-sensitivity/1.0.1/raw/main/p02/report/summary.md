# Experiment endo.experiment.path-sensitivity-1.0.1-p02

Path-sensitivity study, path p02 (research/path-sensitivity/1.0.1/DESIGN.md)

Trials: 12 completed, 0 errored, 0 missing of 12 planned (0 interrupted and rerun). Seed 4247399873 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 6998.5 ms |
| tool-use | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 16501.5 ms |
| tool-use | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 11095.5 ms |
| implement-function | base | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 10997.5 ms |
| implement-function | steer | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 22929.5 ms |
| implement-function | queue | 2/2 | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 [34-100%]; 1 distinct; pairs 100% [100-100%] | 2/2 pass | 15943 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 66 | 0 |
| M2a | PASS | 12 | 0 |
| M2b | PASS | 66 | 0 |
| M3 | PASS | 12 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 6eef51a2fe4ef4230f0dee5cdc5528ba7206a3b8a2ad92096c44151a6f0db0c9. Details: bundle.json.
