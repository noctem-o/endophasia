# inventory

A small in-memory stock library: `import { Inventory } from "./src/inventory.js"`.

Rules:
R1. A SKU is trimmed of whitespace at both ends and upper-cased. Every method that takes a SKU does this first, so `" ab-1 "` and `"AB-1"` are the same SKU. A SKU that is not a string, or is empty after trimming, throws a `TypeError`.
R2. A quantity must be a positive integer, otherwise the method throws a `RangeError`. This applies to `add`, `remove`, `reserve` and `release`.
R3. `add(sku, qty)` increases the stock on hand.
R4. `reserve(sku, qty)` sets stock aside. A reservation may be at most what is available (on hand minus already reserved); a bigger one, or one for a SKU that was never added, throws a `RangeError` and changes nothing.
R5. `release(sku, qty)` undoes reservations. It cannot release more than is reserved for that SKU, otherwise it throws a `RangeError` and changes nothing.
R6. `remove(sku, qty)` takes stock away. Reserved stock cannot be removed: the stock on hand cannot go below what is reserved, otherwise `remove` throws a `RangeError` and changes nothing.
R7. `snapshot()` returns an array of `{ sku, onHand, reserved, available }`, sorted by `sku` in plain code-unit order (the order of the `<` operator, not locale order). A SKU with nothing on hand and nothing reserved is left out.
