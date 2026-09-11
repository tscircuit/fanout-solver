import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { createAm62lDrillHoleClearanceRepro } from "./fixtures/create-am62l-drill-hole-clearance-repro"

interface RoutedVia {
  connectionName: string
  center: { x: number; y: number }
  diameter: number
  holeDiameter: number
}

function getClosestViaPair(vias: readonly RoutedVia[]) {
  let closest:
    | {
        first: RoutedVia
        second: RoutedVia
        centerDistance: number
        copperGap: number
        holeGap: number
      }
    | undefined
  for (let firstIndex = 0; firstIndex < vias.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < vias.length;
      secondIndex++
    ) {
      const first = vias[firstIndex]!
      const second = vias[secondIndex]!
      const centerDistance = Math.hypot(
        first.center.x - second.center.x,
        first.center.y - second.center.y,
      )
      const candidate = {
        first,
        second,
        centerDistance,
        copperGap: centerDistance - (first.diameter + second.diameter) / 2,
        holeGap:
          centerDistance - (first.holeDiameter + second.holeDiameter) / 2,
      }
      if (!closest || candidate.holeGap < closest.holeGap) closest = candidate
    }
  }
  if (!closest) throw new Error("Expected at least two routed vias")
  return closest
}

test("honors drill-hole clearance in a real AM62L memory fanout", async () => {
  const { generatedFrom, selectedBusIds, inputSrj, options } =
    createAm62lDrillHoleClearanceRepro()
  expect(generatedFrom).toMatchObject({
    repository: "https://github.com/tscircuit/core",
    pullRequest: 3783,
    sourceCircuit:
      "scripts/generate-repro/create-am62l-real-decoupling-repro.tsx",
    generator:
      "scripts/generate-repro/generate-am62l-drill-hole-clearance-repro.tsx",
  })
  expect(inputSrj.connections).toHaveLength(16)
  expect(options.buses).toHaveLength(9)
  expect(selectedBusIds).toHaveLength(9)
  expect(inputSrj.minViaPadDiameter).toBe(0.24)
  expect(inputSrj.minViaHoleDiameter).toBe(0.15)
  const drillHoleClearance = (
    inputSrj as typeof inputSrj & {
      minViaHoleEdgeToViaHoleEdgeClearance: number
    }
  ).minViaHoleEdgeToViaHoleEdgeClearance
  expect(drillHoleClearance).toBe(0.254)

  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()

  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  const vias: RoutedVia[] = output.fanoutTraces.flatMap((trace) =>
    trace.route.flatMap((point) =>
      point.route_type === "via"
        ? [
            {
              connectionName: trace.connection_name,
              center: { x: point.x, y: point.y },
              diameter: point.via_diameter!,
              holeDiameter: point.via_hole_diameter!,
            },
          ]
        : [],
    ),
  )
  const closest = getClosestViaPair(vias)
  const visualization = mergeGraphics(solver.visualize(), {
    circles: [closest.first, closest.second].map((via) => ({
      center: via.center,
      radius: via.holeDiameter / 2,
      fill: "rgba(239, 68, 68, 0.8)",
      stroke: "#7f1d1d",
      label: `${via.connectionName} drill`,
    })),
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `closest drill gap ${closest.holeGap.toFixed(3)}mm / required 0.254mm`,
        color: "#b91c1c",
        fontSize: 0.5,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )

  expect(closest.copperGap).toBeGreaterThanOrEqual(
    inputSrj.minViaEdgeToPadEdgeClearance! - 1e-6,
  )
  expect(closest.holeGap).toBeGreaterThanOrEqual(drillHoleClearance - 1e-6)
}, 600_000)
