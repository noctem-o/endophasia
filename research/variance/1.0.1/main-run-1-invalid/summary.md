# Experiment endo.experiment.variance-1.0.1

Variance study main run (research/variance/1.0.1/DESIGN.md)

Trials: 180 completed, 0 errored, 0 missing of 180 planned (0 interrupted and rerun). Seed 363281846 (drawn).

Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):

| task | condition | trials | lifecycle | tools | outcome | check | median wall |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | ---: |
| tool-use | a | 20/20 | 19/20 [76-99%]; 2 distinct; pairs 90% [71-100%] | 12/20 [39-78%]; 3 distinct; pairs 46% [32-64%] | 19/20 [76-99%]; 2 distinct; pairs 90% [71-100%] | 20/20 pass | 3845.5 ms |
| tool-use | b | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 3609.5 ms |
| tool-use | b-c | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 8099 ms |
| fix-failing-test | a | 20/20 | 8/20 [22-61%]; 5 distinct; pairs 24% [14-38%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 8/20 [22-61%]; 5 distinct; pairs 24% [14-39%] | 20/20 pass | 7939 ms |
| fix-failing-test | b | 20/20 | 19/20 [76-99%]; 2 distinct; pairs 90% [71-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 19/20 [76-99%]; 2 distinct; pairs 90% [71-100%] | 20/20 pass | 8727.5 ms |
| fix-failing-test | b-c | 20/20 | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 20/20 [84-100%]; 1 distinct; pairs 100% [100-100%] | 20/20 pass | 14620.5 ms |
| implement-function | a | 20/20 | 12/20 [39-78%]; 6 distinct; pairs 37% [17-62%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 14/20 [48-85%]; 4 distinct; pairs 50% [27-79%] | 20/20 pass | 7663 ms |
| implement-function | b | 20/20 | 11/20 [34-74%]; 2 distinct; pairs 48% [43-59%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 11/20 [34-74%]; 2 distinct; pairs 48% [43-59%] | 20/20 pass | 6002.5 ms |
| implement-function | b-c | 20/20 | 12/20 [39-78%]; 3 distinct; pairs 46% [32-64%] | 1/20 [1-24%]; 20 distinct; pairs 0% [0-0%] | 12/20 [39-78%]; 3 distinct; pairs 46% [32-64%] | 20/20 pass | 12780.5 ms |

Manipulation checks:

| check | status | checked | failures |
| :--- | :--- | ---: | ---: |
| M1 | PASS | 924 | 0 |
| M2a | PASS | 180 | 0 |
| M2b | PASS | 924 | 0 |
| M3 | PASS | 60 | 0 |
| M4 | NOT-APPLICABLE | 0 | 0 |

Validity: a valid, b valid, b-c valid.

Report digest b1d2089d29a57bfb0b3786c995e50e46de1cad30d6fad9f2840fb8349f235a52. Details: bundle.json.
