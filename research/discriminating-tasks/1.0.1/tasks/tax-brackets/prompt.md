Implement `computeTax(incomeCents, schedule)` in src/tax-brackets.js, as a named export. The stub in that file shows the shape, and test/tax-brackets.test.js shows two examples. Run the tests with: node --test. Do not change any file under test/.

Rules:
R1. `incomeCents` must be a non-negative integer, otherwise `computeTax` throws a `RangeError`. `schedule` must be a non-empty array of brackets `{ upTo, rateBp }`, otherwise it throws a `TypeError`. `upTo` is a positive integer number of cents, or `null` for the last bracket (no limit), and `rateBp` is an integer from 0 to 10000 (basis points: 2500 is 25%).
R2. A schedule is valid only if its `upTo` values strictly increase, only the last bracket has `upTo: null`, and the last bracket does have `upTo: null`. An invalid schedule throws a `TypeError`. R1 and R2 are both checked before any tax is computed, the schedule first, then `incomeCents`.
R3. The tax is progressive. The first bracket applies to income from 0 up to its `upTo`, each next bracket to the income above the previous `upTo` up to its own `upTo`, and the last to everything above. The tax on the part of the income in a bracket is that part times `rateBp` divided by 10000.
R4. The tax of each bracket is rounded to a whole number of cents on its own, before the brackets are added up, to the nearest cent, and exactly half a cent rounds to the even cent (so 2.5 becomes 2, 3.5 becomes 4, 0.5 becomes 0).
R5. `computeTax` returns an object `{ totalCents, perBracket }`. `perBracket` has one entry per bracket in schedule order, each `{ upTo, rateBp, taxableCents, taxCents }`, where `taxableCents` is the part of the income in that bracket (0 for brackets the income does not reach), and `totalCents` is the sum of the `taxCents` values.
R6. `computeTax` does not change `schedule` or the brackets in it, and it uses exact integer arithmetic: results must be right for incomes up to 9007199254740991 / 10000 cents with no floating-point error.

When all the rules hold, reply with the single word: done
