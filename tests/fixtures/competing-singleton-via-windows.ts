import type { Obstacle } from "@tscircuit/capacity-autorouter"
import type { Bounds } from "lib/types"
import { createPlaneAndSignalEscapes } from "./plane-and-signal-escapes"

function foreignCopper(bounds: Bounds): Obstacle {
  return {
    type: "rect" as const,
    layers: ["inner2"],
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    connectedTo: ["foreign-copper"],
  }
}

export function createCompetingSingletonViaWindows(): ReturnType<
  typeof createPlaneAndSignalEscapes
> {
  const { input, options } = createPlaneAndSignalEscapes()
  input.minViaPadDiameter = 0.2
  input.obstacles = [
    ...input.obstacles.filter((obstacle) => obstacle.componentId === "U1"),
    // The signal's straight bottom trace crosses the plane's only free barrel.
    // Both via centers are fixed by these two 0.36 mm apertures at x = ±0.3.
    foreignCopper({ minX: -1.1, maxX: 1.7, minY: -1.1, maxY: -0.18 }),
    foreignCopper({ minX: -1.1, maxX: 1.7, minY: 0.18, maxY: 1.1 }),
    foreignCopper({ minX: -1.1, maxX: -0.48, minY: -0.18, maxY: 0.18 }),
    foreignCopper({ minX: -0.12, maxX: 0.12, minY: -0.18, maxY: 0.18 }),
    foreignCopper({ minX: 0.48, maxX: 1.7, minY: -0.18, maxY: 0.18 }),
  ]
  return { input, options }
}
