Implement `retrySchedule(options, rand)` in src/retry-schedule.js, as a named export. The stub in that file shows the shape, and test/retry-schedule.test.js shows two examples. Run the tests with: node --test. Do not change any file under test/.

`retrySchedule` returns the list of waits, in whole milliseconds, before each retry of a failed call.

Rules:
R1. `options` is `{ retries, baseMs, factor, maxMs, jitter }`. `retries` is an integer from 0 to 100, `baseMs` and `maxMs` are finite numbers greater than 0, `factor` is a finite number of 1 or more, and `jitter` is one of the strings `"none"`, `"full"` or `"equal"`. Anything else (including a missing option or an `options` that is not an object) makes `retrySchedule` throw a `TypeError`, except that `baseMs` greater than `maxMs` throws a `RangeError`. A `TypeError` takes priority over the `RangeError`.
R2. The result has `retries` entries: entry `n` (counting from 0) is the wait before retry number `n + 1`. `retries: 0` gives `[]`.
R3. The capped delay for entry `n` is `cap(n) = min(maxMs, baseMs * factor ** n)`, computed in floating point.
R4. With `jitter: "none"` the wait is `cap(n)`. With `"full"` it is `cap(n) * r`, and with `"equal"` it is `cap(n) / 2 + (cap(n) / 2) * r`, where `r` is the next number from `rand()` (a number from 0 up to but not including 1). `rand` is called exactly once per entry, in order, and not at all with `"none"`.
R5. Every wait is rounded to a whole number of milliseconds with `Math.round`, and then is at least 1. (So a computed wait that rounds to 0 becomes 1.)
R6. `rand` must be a function whenever `jitter` is not `"none"` (otherwise a `TypeError`, checked together with R1). If `rand` returns something that is not a finite number from 0 up to but not including 1, `retrySchedule` throws a `RangeError`. `options` and its values are never changed.

When all the rules hold, reply with the single word: done
