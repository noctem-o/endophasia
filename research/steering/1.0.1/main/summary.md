# Experiment endo.experiment.steering-1.0.1

Steering study main run (research/steering/1.0.1/DESIGN.md)

Trials: 120 completed, 0 errored, 0 missing of 120 planned (0 interrupted and rerun). Seed 3004904282 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| tool-use | base | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 6902.5 ms |
| tool-use | steer | 20/20 | 18/20 [70-97%]; 2 distinct; pairs 81% [58-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 18/20 [70-97%]; 2 distinct; pairs 81% [58-100%] | 20/20 pass | 34192.5 ms |
| tool-use | queue | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 10666 ms |
| implement-function | base | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 10904.5 ms |
| implement-function | steer | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 15983.5 ms |
| implement-function | queue | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 15730 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 622 | 0 |
| M2a | PASS | 120 | 0 |
| M2b | PASS | 622 | 0 |
| M3 | PASS | 120 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: base valid, queue valid, steer valid.

Report digest 68d832f67c50ec2019ae769c37b558d7e59545f55c187b88af00a9161177e5a5. Details: bundle.json.
