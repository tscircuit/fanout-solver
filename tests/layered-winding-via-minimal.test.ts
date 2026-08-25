import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { segmentsAreClear } from "lib/geometry"
import type { RoutedSegment } from "lib/types"
import {
  createLayeredWindingChannelFixture,
  windingTargetOrder,
} from "tests/fixtures/layered-winding-channel"

interface NamedSegment extends RoutedSegment {
  connectionName: string
}

test("layered winding is ordered at the first escape without crossover vias", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary,
    escapeLayers: ["inner1", "inner2"],
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })

  const assignedLayer = output.busLayerAssignments.DATA_BUS
  expect(["inner1", "inner2"]).toContain(assignedLayer)
  expect(
    output.fanoutTraces
      .map((trace) => ({
        connectionName: trace.connection_name,
        exit: trace.route.at(-1),
      }))
      .toSorted((first, second) => {
        if (first.exit?.route_type !== "wire") return 1
        if (second.exit?.route_type !== "wire") return -1
        return first.exit.y - second.exit.y
      })
      .map(({ connectionName }) => connectionName),
  ).toEqual(windingTargetOrder)

  const assignedLayerSegments: NamedSegment[] = []
  for (const trace of output.fanoutTraces) {
    const vias = trace.route.filter(
      (routePoint) => routePoint.route_type === "via",
    )
    expect(vias).toHaveLength(1)
    expect(vias[0]).toMatchObject({
      from_layer: "top",
      to_layer: assignedLayer,
    })

    const sourceViaIndex = trace.route.indexOf(vias[0]!)
    expect(
      trace.route
        .slice(sourceViaIndex + 1)
        .every(
          (routePoint) =>
            routePoint.route_type === "wire" &&
            routePoint.layer === assignedLayer,
        ),
    ).toBe(true)

    let previousWire:
      | Extract<(typeof trace.route)[number], { route_type: "wire" }>
      | undefined
    for (const routePoint of trace.route.slice(sourceViaIndex + 1)) {
      if (routePoint.route_type !== "wire") {
        previousWire = undefined
        continue
      }
      if (
        previousWire &&
        Math.hypot(
          routePoint.x - previousWire.x,
          routePoint.y - previousWire.y,
        ) > 1e-9
      ) {
        assignedLayerSegments.push({
          connectionName: trace.connection_name,
          start: previousWire,
          end: routePoint,
          width: routePoint.width,
          layer: routePoint.layer,
        })
      }
      previousWire = routePoint
    }
  }

  expect(
    assignedLayerSegments.some(
      ({ start, end }) =>
        Math.abs(start.x - end.x) > 1e-9 && Math.abs(start.y - end.y) > 1e-9,
    ),
  ).toBe(true)

  const clearanceViolations: string[] = []
  for (
    let firstIndex = 0;
    firstIndex < assignedLayerSegments.length;
    firstIndex++
  ) {
    const first = assignedLayerSegments[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < assignedLayerSegments.length;
      secondIndex++
    ) {
      const second = assignedLayerSegments[secondIndex]!
      if (first.connectionName === second.connectionName) continue
      if (!segmentsAreClear(first, second, 0.1)) {
        clearanceViolations.push(
          `${first.connectionName}/${second.connectionName}`,
        )
      }
    }
  }
  expect(clearanceViolations).toEqual([])
})
