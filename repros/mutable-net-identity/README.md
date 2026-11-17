# Copper DRC after a net edit

Run `bun repros/mutable-net-identity/index.ts` or
`bun test tests/routed-copper-drc-net-edit.test.ts`.

Two 0.1 mm top-layer traces cross at the origin. Both initially belong to
`COMMON`, so their intersection is legal. Change each connection's
`netConnectionName` to its own name (`A` / `B`), leaving all geometry fixed,
then validate the same SRJ object again.

At base commit `818eec347e93493c204992e84ece827c2f7a493e`, the second call reports
`valid: true`. Validating a structured clone of those same inputs correctly
reports `different-net-trace-clearance`. No malformed alias metadata or
private router APIs are needed. The regression asserts that reused and fresh
objects agree and that merging the nets back restores a valid result.

The electrical identity WeakMap is keyed only by object identity. Refresh it
once at the public validation boundary so each audit sees current connections,
trace aliases, and obstacle ownership, while keeping cached lookups throughout
that synchronous audit. This does not change route geometry or the definition
of electrical net equivalence.

This case was reduced while investigating incremental AM3352 board edits. It
isolates a validator issue; it does not reproduce a full-board routing failure.
The SVG is a diagnostic of intentionally crossing, distinct-net copper.
