import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec, FanoutSolverOptions } from "lib/types"
import fixtureJson from "./fixtures/am62l-soc-winding-fanout.json"

interface CapturedConnectionTarget {
  x: number
  y: number
  layer: string
}

interface CapturedFanoutBus extends FanoutBusSpec {
  connectionTargets: Readonly<Record<string, CapturedConnectionTarget>>
}

interface CapturedFixture {
  simpleRouteJson: SimpleRouteJson
  options: Omit<FanoutSolverOptions, "buses"> & {
    buses: CapturedFanoutBus[]
  }
}

const fixture = fixtureJson as unknown as CapturedFixture

interface CapturedCircularObstacle extends Obstacle {
  shape: "circle"
}

function isCapturedCircularObstacle(
  obstacle: Obstacle,
): obstacle is CapturedCircularObstacle {
  return (obstacle as Obstacle & { shape?: string }).shape === "circle"
}

function expectViasToClearCircularPads(
  trace: SimplifiedPcbTrace,
  simpleRouteJson: SimpleRouteJson,
): void {
  const padObstacles = simpleRouteJson.obstacles.filter(
    isCapturedCircularObstacle,
  )
  const clearance = simpleRouteJson.minViaEdgeToPadEdgeClearance ?? 0

  for (const routePoint of trace.route) {
    if (routePoint.route_type !== "via") continue
    const viaDiameter =
      routePoint.via_diameter ?? simpleRouteJson.minViaPadDiameter ?? 0

    for (const pad of padObstacles) {
      const centerDistance = Math.hypot(
        routePoint.x - pad.center.x,
        routePoint.y - pad.center.y,
      )
      const minimumCenterDistance = viaDiameter / 2 + pad.width / 2 + clearance
      expect(centerDistance).toBeGreaterThanOrEqual(minimumCenterDistance)
    }
  }
}

test.todo("routes the captured AM62L winding handoffs without via-in-pad escapes", () => {
  expect(fixture.simpleRouteJson.connections).toHaveLength(33)
  expect(fixture.simpleRouteJson.obstacles).toHaveLength(573)
  expect(fixture.simpleRouteJson.differentialPairs ?? []).toHaveLength(3)

  const targetByConnectionName = new Map(
    fixture.options.buses.flatMap((bus) =>
      Object.entries(bus.connectionTargets),
    ),
  )
  expect(targetByConnectionName.size).toBe(33)

  const solver = new FanoutSolver(fixture.simpleRouteJson, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  expect(output.fanoutTraces).toHaveLength(33)

  for (const trace of output.fanoutTraces) {
    const target = targetByConnectionName.get(trace.connection_name)
    expect(target).toBeDefined()
    if (!target) continue

    const lastWire = trace.route.findLast(
      (routePoint) => routePoint.route_type === "wire",
    )
    expect(lastWire?.route_type).toBe("wire")
    if (lastWire?.route_type !== "wire") continue
    expect(lastWire.x).toBeCloseTo(target.x)
    expect(lastWire.y).toBeCloseTo(target.y)
    expect(lastWire.layer).toBe(target.layer)
    expectViasToClearCircularPads(trace, fixture.simpleRouteJson)
  }
})
