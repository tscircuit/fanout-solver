# Native RC-filter plane-fanout reproduction

`power-filter.tsx` is a real supply filter: a 22-ohm resistor feeds four
100-nF bypass capacitors. It uses the Linux board's actual 0402 land pattern,
courtyards, and manufacturer part numbers. All copper comes from autorouters.

The first phase routes resistor-to-capacitor connections with Pipeline 9.
The second uses core's native fanout preset to connect the input resistor to
the VCC plane. The third connects all capacitor ground pads to the GND plane
using this checkout's `FanoutSolver` through core's local-autorouter API.
Core generates the actual pads, previously routed copper, and plane-terminated
buses. The adapter does not reconstruct or alter the routing problem.

The GND phase intentionally uses `algorithmFn` without `preset`: core 0.0.1871
discards `algorithmFn` when `preset: "fanout"` is also supplied. The genuine
VCC fanout phase enables native plane handling for both declared plane maps.
The test verifies that the checkout receives four GND plane-terminated buses.

The baseline routes only three of the four ground escapes. Core commits a
group's copper only when all phases succeed, so the baseline PCB SVG shows
components but no committed traces. The snapshot is directly
`convertCircuitJsonToPcbSvg(circuit.getCircuitJson(), { layer: "top" })`; it has no reconstructed
copper, custom annotations, or SVG postprocessing.

This is a reduced reproduction of the missing centered outward escape candidate
found at the real board's LDO input resistor. Here, capacitor ground escapes
exercise the same candidate-generation omission. A passing reduced circuit does
not imply that the entire Linux board or its other routing phases are complete.

Run from the repository root:

```sh
bun test tests/outward-plane-circuit.test.ts
bun run typecheck
```

The private workspace and subprocess isolate modern core/Pipeline 9 from the
repository's existing older solver fixtures. Both TypeScript projects are checked.
