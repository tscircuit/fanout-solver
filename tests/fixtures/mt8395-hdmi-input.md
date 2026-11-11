# MT8395 HDMI local escape reproduction

The compressed fixture is the complete first HDMI routing request captured from
`@tscircuit/core` commit `79735a0` while rendering the MT8395 SBC revision 2.2.
It contains both HDMI_CH2_CPU signals, every board obstacle, and all 138 supplied
DDR traces. No geometry, ownership aliases, endpoints, or fixed copper is removed.

To keep the fixture small, `obstacles[].connectedTo` strings are dictionary-encoded
before gzip compression. `mt8395-hdmi-input.ts` restores them and verifies SHA-256
of `JSON.stringify(input)`:
`03062c9c48ccc0fdccbfdc1e670b8989b94cdb719daccc31b2a5382054af464b`.

The routing request uses top-to-inner4 blind vias on an eight-layer board.
Bottom-layer pads of C_SOC_115 and C_SOC_122 occupy the XY neighborhood of U1.AR35.
The original matcher incorrectly checks those pads against both the via and the
top-layer source stub. Thus it cannot assign a local escape even though this
copper does not occupy bottom.

Run `bun test tests/mt8395-hdmi-blind-vias.test.ts`. Its SVG zooms the CPU pads,
shows emitted copper, and includes the relevant expanded board TSX. Both CPU
and ESD endpoints are tested (four local escapes total). The solver receives the
restored original input unchanged. Extra fixed-route connection records are
created only for independent clearance validation. Every pad-to-handoff path
is independently checked for connectivity. Allow up to five minutes for the
full-board clearance check.

The companion layer-obstacle and disjoint-span tests cover bottom pads, supplied
traces/vias, through vias, intersecting spans, and opposite-side blind escapes.
Their snapshots report measured solver results, not requested geometry.

These are **local pad escapes**, not a completed HDMI interconnect. With the
span fix, the full bus-lanes pipeline advances beyond local assignment but still
hits a later dense-grid search budget. This reproduction does not hide or solve
that separate limitation.
