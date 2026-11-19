import { expect, test } from "bun:test"
import { routeLocalSignalDogbones } from "lib"

test("blocked local signal dogbones can escape on an explicitly rectangular board", async () => {
  const { input }: { input: Parameters<typeof routeLocalSignalDogbones>[0] } =
    await Bun.file(
      new URL("./fixtures/rv1126b-ddr-dq16.srj.json", import.meta.url),
    ).json()
  const { minX, minY, maxX, maxY } = input.bounds
  const outline = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  const { traces } = routeLocalSignalDogbones(
    { ...input, outline },
    {
      targetLayers: new Map([[input.connections[0]!.name, "inner2"]]),
      viaDiameter: 0.45,
      viaHoleDiameter: 0.2,
      traceWidth: 0.09,
      clearance: 0.09,
      holeToHoleClearance: 0.1,
      boardEdgeClearance: 0.2,
    },
  )
  expect(traces).toHaveLength(2)
})
