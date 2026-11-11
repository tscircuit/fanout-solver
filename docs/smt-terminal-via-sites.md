# Rectangular SMT terminal fanouts

The input-only regression has long rectangular pads and a small imported
coordinate difference within one pad column. Grid midpoints fall inside one
terminal, so the existing matcher cannot assign both full-stack vias. The
stacked fix additionally proposes straight sites beyond the physical pad edge,
then uses the existing pad, trace, via and hole clearance checks.

The SVG snapshot is the inspected expected fix result: two complete native
plane fanouts with 0.30 mm drills / 0.50 mm lands. The reproduction fails before
snapshot export because it has no complete assignment. This is a focused
fixture, not a completed AM3352 board or a manually specified signal route.

Run the focused case with:

`bun benchmarks/smt-terminal-via-sites.ts /path/to/revision/lib/index.ts report.json`

The dedicated PR workflow compares 200 fresh assignments on pinned base/head
using the same fixture and harness. A failure that returns immediately is not
a routing performance win. The canonical Dataset 31 benchmark is unchanged:
72 directional cases, pinned upstream inputs, 120-second per-sample budgets.
Run it on both revisions with the same runtime and concurrency, and include
completion/DRC/length/runtime regressions in the PR before merge. Pending
comparisons do not establish no regressions.
