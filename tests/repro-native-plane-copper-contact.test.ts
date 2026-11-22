import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { distance } from "lib/geometry"
import { getPlanVias } from "lib/route-bus/plan-copper"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { AssignmentAttempt, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native GND drops complete without merging their drilled holes", async () => {
  const { solverParams, solverOptions } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as {
    solverParams: SimpleRouteJson & {
      minViaHoleEdgeToViaHoleEdgeClearance?: number
      minPlatedHoleDrillEdgeToDrillEdgeClearance?: number
    }
    solverOptions: FanoutSolverOptions
  }
  const busIds = ["ESC_U22_pin34", "ESC_U22_pin54", "ESC_U22_pin65"]
  const buses = solverOptions.buses!.filter((bus) => busIds.includes(bus.busId))
  const connectionNames = new Set(buses.flatMap((bus) => bus.connectionNames))
  solverParams.connections = solverParams.connections.filter((connection) =>
    connectionNames.has(connection.name),
  )
  const solver = new FanoutSolver(solverParams, {
    ...solverOptions,
    buses,
    maxLayerCombinations: 1,
  })
  solver.solve()
  const best = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  expect(solver.solved).toBe(true)
  expect(best.plans).toHaveLength(3)
  expect(
    validateRoutedCopperDrc({
      inputSrj: solverParams,
      routedSrj: best.outputSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const vias = best.plans.flatMap(getPlanVias)
  const drillClearance = Math.max(
    solverParams.minViaHoleEdgeToViaHoleEdgeClearance ?? 0,
    solverParams.minPlatedHoleDrillEdgeToDrillEdgeClearance ?? 0,
  )
  for (const [index, via] of vias.entries()) {
    for (const other of vias.slice(index + 1)) {
      const requiredDistance =
        (via.holeDiameter + other.holeDiameter) / 2 + drillClearance
      expect(distance(via.center, other.center)).toBeGreaterThanOrEqual(
        requiredDistance - 1e-9,
      )
    }
  }
  const graphics = visualizeSimpleRouteJson({
    ...best.outputSrj,
    connections: [],
    bounds: { minX: 0.5, maxX: 3.5, minY: 12, maxY: 15 },
    obstacles: solverParams.obstacles.filter(
      ({ center }) =>
        center.x >= 0.5 && center.x <= 3.5 && center.y >= 12 && center.y <= 15,
    ),
  })
  graphics.texts = [
    {
      x: 0.5,
      y: 15.4,
      text: `iCE/Pi GND: ${best.plans.length}/3 connected; fanout ${solver.solved ? "complete" : "failed"}`,
      fontSize: 0.12,
      color: "#0f172a",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
