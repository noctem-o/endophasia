Implement `packSlots(items, slotSize)` in src/slot-pack.js, as a named export. The stub in that file shows the shape, and test/slot-pack.test.js shows two examples. Run the tests with: node --test. Do not change any file under test/.

Rules:
R1. `items` is an array of `{ id, size }`, where `id` is a string and `size` is a positive integer. `slotSize` is a positive integer. An item whose `size` equals `slotSize` fits exactly.
R2. Items are placed in order of decreasing `size`. Items of equal `size` are placed in ascending `id` order (compared as strings with `<`).
R3. Each item goes into the first existing slot, in creation order, that still has enough room. If no slot has, a new slot is created for it and it goes there.
R4. The result is an array of slots in creation order. Each slot is an array of item ids in the order the items were placed into it.
R5. An item whose `size` is greater than `slotSize` makes the function throw a `RangeError` whose message contains that item's `id`. If several items are too large, the message names the first one in placement order (R2) and no other.
R6. The input array and its items are not modified.
R7. An empty `items` array gives `[]`.

When all the rules hold, reply with the single word: done
