import { expect, test } from "bun:test"
import { srj29FanoutSamples } from "../datasets/srj29"
import { FanoutSolver } from "../lib/fanout-solver"
import { distancePointToSegment } from "../lib/geometry"

test("SRJ29 endpoint completion only retains physically connected DRC-clean copper", () => {
  const sample = srj29FanoutSamples.find(({ id }) => id === "sample001")!
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  const output = solver.getOutput()
  expect(output.endpointCompletion).toBeDefined()
  expect(output.endpointCompletion?.drc).toMatchObject({
    valid: true,
    issues: [],
  })
  expect(output.endpointCompletion!.connectivity.connectedConnectionCount).toBe(
    sample.fanoutConnectionCount,
  )
  expect(output.completionTraces.length).toBeGreaterThan(0)
  expect(
    output.fanoutTraces.some((trace) =>
      trace.pcb_trace_id.startsWith("fanout-plane-endpoint:"),
    ),
  ).toBe(true)
  expect(
    output.completionTraces.every((trace) =>
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" || routePoint.route_type === "via",
      ),
    ),
  ).toBe(true)
  const originalAndRoutedEndpoints = [
    sample.simpleRouteJson,
    output.simpleRouteJson,
  ].flatMap((srj) =>
    srj.connections.flatMap((connection) => connection.pointsToConnect),
  )
  const emittedVias = [
    ...output.fanoutTraces,
    ...output.completionTraces,
  ].flatMap((trace) =>
    trace.route.filter((routePoint) => routePoint.route_type === "via"),
  )
  expect(emittedVias.length).toBeGreaterThan(0)
  for (const via of emittedVias) {
    expect(
      Math.min(
        ...originalAndRoutedEndpoints.map((endpoint) =>
          Math.hypot(via.x - endpoint.x, via.y - endpoint.y),
        ),
      ),
    ).toBeGreaterThan(1e-6)
  }
}, 60_000)

test("short outside-pad routes transition at an interior fanout-trace point", () => {
  const sample = srj29FanoutSamples.find(({ id }) => id === "sample009")!
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  const output = solver.getOutput()
  const connectionName = "BUS_SIGNAL_009"
  const fanoutTrace = output.fanoutTraces.find(
    (trace) => trace.connection_name === connectionName,
  )!
  const completionTrace = output.completionTraces.find(
    (trace) => trace.connection_name === connectionName,
  )!
  const completionVia = completionTrace.route.find(
    (routePoint) => routePoint.route_type === "via",
  )!
  const routedConnection = output.simpleRouteJson.connections.find(
    (connection) => connection.name === connectionName,
  )!

  expect(output.endpointCompletion?.connectivity.valid).toBe(true)
  expect(
    routedConnection.pointsToConnect.every(
      (endpoint) =>
        Math.hypot(completionVia.x - endpoint.x, completionVia.y - endpoint.y) >
        1e-6,
    ),
  ).toBe(true)

  let previousWire:
    | Extract<(typeof fanoutTrace.route)[number], { route_type: "wire" }>
    | undefined
  let viaLiesOnFanoutCopper = false
  for (const routePoint of fanoutTrace.route) {
    if (routePoint.route_type !== "wire") {
      previousWire = undefined
      continue
    }
    if (
      previousWire?.layer === completionVia.from_layer &&
      routePoint.layer === completionVia.from_layer &&
      distancePointToSegment(completionVia, previousWire, routePoint) <= 1e-6
    ) {
      viaLiesOnFanoutCopper = true
    }
    previousWire = routePoint
  }
  expect(viaLiesOnFanoutCopper).toBe(true)
}, 30_000)
