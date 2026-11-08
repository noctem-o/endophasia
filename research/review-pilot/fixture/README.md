# duration

Reads and writes durations such as `1h30m`.

- `parseDuration(text)` returns the whole number of seconds, or throws a `RangeError`.
- `formatDuration(seconds)` returns the shortest text for a whole, non-negative number of seconds (`0s` for zero).

## Format

A duration is one or more whole numbers, each followed by its unit. Units come largest first, and each at most once: `2h5s` is a
duration, `5s2h` and `1h1h` are not. Nothing else is allowed: no spaces, signs, fractions or empty text.

| Unit | Meaning | Seconds |
| :-- | :-- | --: |
| `h` | hours | 3600 |
| `m` | minutes | 60 |
| `s` | seconds | 1 |
