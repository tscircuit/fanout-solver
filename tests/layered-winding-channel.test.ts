import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import {
  createLayeredWindingChannelFixture,
  windingTargetOrder,
} from "tests/fixtures/layered-winding-channel"

test("layered paired exits preserve winding without crossover vias", async () => {
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
  const exits = output.fanoutTraces
    .map((trace) => ({
      connectionName: trace.connection_name,
      exit: trace.route.at(-1),
    }))
    .toSorted((first, second) => {
      if (first.exit?.route_type !== "wire") return 1
      if (second.exit?.route_type !== "wire") return -1
      return first.exit.y - second.exit.y
    })
  expect(exits.map((exit) => exit.connectionName)).toEqual(windingTargetOrder)
  expect(
    exits.every(
      ({ exit }) =>
        exit?.route_type === "wire" &&
        exit.x === sharedBoundary.maxX &&
        exit.layer === assignedLayer,
    ),
  ).toBe(true)

  for (const trace of output.fanoutTraces) {
    const vias = trace.route.filter(
      (routePoint) => routePoint.route_type === "via",
    )
    expect(vias).toHaveLength(1)
    expect(
      output.simpleRouteJson.obstacles.filter(
        (obstacle) =>
          obstacle.componentId === undefined &&
          obstacle.connectedTo.includes(trace.connection_name),
      ),
    ).toHaveLength(1)
    expect(vias.map((via) => [via.from_layer, via.to_layer])).toEqual([
      ["top", assignedLayer],
    ])
  }

  const reversedAllowedLayersBus = {
    ...bus,
    allowedLayers: [...(bus.allowedLayers ?? [])].reverse(),
  }
  const reversedAllowedLayersSolver = new FanoutSolver(
    { ...simpleRouteJson, buses: [reversedAllowedLayersBus] },
    {
      buses: [reversedAllowedLayersBus],
      sharedBoundary,
      escapeLayers: ["inner1", "inner2"],
      compactBusTracks: true,
    },
  )
  reversedAllowedLayersSolver.solve()
  expect(reversedAllowedLayersSolver.failed).toBe(false)
  expect(
    reversedAllowedLayersSolver
      .getOutput()
      .fanoutTraces.map((trace) => ({
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

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
