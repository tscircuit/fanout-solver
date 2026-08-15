import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset06 } from "../datasets/dataset06"

test("dataset06 routes the spaced 0603 clad1 RP2040 fanout on one layer", () => {
  const sample = fanoutDataset06[0]!

  expect(sample.simpleRouteJson.layerCount).toBe(1)
  expect(sample.simpleRouteJson.minTraceWidth).toBe(0.1)
  expect(sample.simpleRouteJson.connections).toHaveLength(132)
  expect(sample.simpleRouteJson.obstacles).toHaveLength(265)
  expect(sample.simpleRouteJson.buses).toHaveLength(132)
  expect(sample.solverOptions).toMatchObject({
    escapeLayers: ["top"],
    singleLayerPushAndShove: true,
    singleLayerAdaptiveExits: true,
    compactBusTracks: true,
    borderDistribution: "preserve",
    maxLayerCombinations: 1,
  })
  expect(
    sample.simpleRouteJson.obstacles
      .filter((obstacle) => obstacle.componentId === "fanout:pcb_component_12")
      .map((obstacle) => ({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
      })),
  ).toEqual([
    {
      center: { x: 15, y: 9.175 },
      width: 0.95,
      height: 0.8,
    },
    {
      center: { x: 15, y: 10.825 },
      width: 0.95,
      height: 0.8,
    },
  ])
  const typeCObstacles = sample.simpleRouteJson.obstacles.filter(
    (obstacle) => obstacle.componentId === "fanout:pcb_component_13",
  )
  expect(typeCObstacles).toHaveLength(18)
  expect(typeCObstacles[0]!.center.x).toBeCloseTo(-38.875)
  expect(Math.min(...typeCObstacles.map(({ center }) => center.x))).toBeCloseTo(
    -43.625,
  )
  const originalDirectionByConnectionName = new Map(
    sample.solverOptions.buses!.map((bus) => [
      bus.connectionNames[0]!,
      bus.direction,
    ]),
  )

  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.attempts).toHaveLength(1)
  expect(solver.attempts[0]).toMatchObject({
    routedConnectionCount: 132,
    routedBusCount: 132,
  })
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(132)
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" && routePoint.layer === "top",
      ),
    ),
  ).toBe(true)
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.slice(1).every((routePoint, index) => {
        const previous = trace.route[index]!
        if (
          routePoint.route_type !== "wire" ||
          previous.route_type !== "wire"
        ) {
          return false
        }
        const deltaX = Math.abs(routePoint.x - previous.x)
        const deltaY = Math.abs(routePoint.y - previous.y)
        return (
          deltaX < 1e-6 || deltaY < 1e-6 || Math.abs(deltaX - deltaY) < 1e-6
        )
      }),
    ),
  ).toBe(true)
  const traceByConnectionName = new Map(
    output.fanoutTraces.map((trace) => [trace.connection_name, trace]),
  )
  for (const bus of solver.preparedBuses) {
    const trace = traceByConnectionName.get(
      bus.connections[0]!.connection.name,
    )!
    const exit = trace.route.at(-1)!
    expect(exit.route_type).toBe("wire")
    if (exit.route_type !== "wire") continue
    switch (bus.direction) {
      case "left":
        expect(exit.x).toBeCloseTo(sample.sharedBoundary.minX)
        break
      case "right":
        expect(exit.x).toBeCloseTo(sample.sharedBoundary.maxX)
        break
      case "up":
        expect(exit.y).toBeCloseTo(sample.sharedBoundary.maxY)
        break
      case "down":
        expect(exit.y).toBeCloseTo(sample.sharedBoundary.minY)
        break
    }
  }
  expect(
    solver.preparedBuses.filter(
      (bus) =>
        originalDirectionByConnectionName.get(
          bus.connections[0]!.connection.name,
        ) !== bus.direction,
    ).length,
  ).toBeGreaterThan(0)
  const centerPadTrace = traceByConnectionName.get("source_net_0::fanout:12")!
  expect(centerPadTrace.connection_name).toBe("source_net_0::fanout:12")
  expect(centerPadTrace.connectsTo).not.toContain("connectivity_net376")
  expect(centerPadTrace.connectsTo).toContain(
    "fanout-exit:source_net_0::fanout:12:source-0",
  )
  expect(
    centerPadTrace.route.some(
      (routePoint) =>
        routePoint.route_type === "wire" &&
        Math.abs(routePoint.x - 2.92505) < 1e-5 &&
        Math.abs(routePoint.y + 1.00025) < 1e-5,
    ),
  ).toBe(true)
}, 60_000)
