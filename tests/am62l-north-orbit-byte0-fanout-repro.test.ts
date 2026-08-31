import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutRoutePoint, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-north-orbit-byte0-fanout-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

type WireRoutePoint = Extract<FanoutRoutePoint, { route_type: "wire" }>

test("routes all eight AM62L DDR byte-0 signals through the north-orbit fanout", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  const expectedConnectionNames = fixture.options.buses![0]!.connectionNames
  expect(output.fanoutTraces).toHaveLength(8)
  expect(
    output.fanoutTraces.map((trace) => trace.connection_name).toSorted(),
  ).toEqual(expectedConnectionNames.toSorted())
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 8,
    brokenOutConnectionCount: 8,
    issues: [],
  })

  const nonOctilinearSegments: Array<{
    connectionName: string | undefined
    from: WireRoutePoint
    to: WireRoutePoint
  }> = []
  for (const trace of output.fanoutTraces) {
    let previousWire: WireRoutePoint | undefined
    for (const routePoint of trace.route) {
      if (routePoint.route_type !== "wire") {
        previousWire = undefined
        continue
      }
      if (previousWire?.layer === routePoint.layer) {
        const dx = Math.abs(routePoint.x - previousWire.x)
        const dy = Math.abs(routePoint.y - previousWire.y)
        const isStraightOr45Degree =
          dx < 1e-9 || dy < 1e-9 || Math.abs(dx - dy) < 1e-9
        if (!isStraightOr45Degree) {
          nonOctilinearSegments.push({
            connectionName: trace.connection_name,
            from: previousWire,
            to: routePoint,
          })
        }
      }
      previousWire = routePoint
    }
  }
  expect(nonOctilinearSegments).toEqual([])

  expect(
    validateRoutedCopperDrc({
      inputSrj: fixture.inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance: fixture.inputSrj.minTraceToPadEdgeClearance ?? 0.05,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 8,
    checkedViaCount: 8,
    issues: [],
  })

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 60_000)
