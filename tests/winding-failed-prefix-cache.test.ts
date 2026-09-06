import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "lib/route-via-minimal-winding"
import type { PreparedBus } from "lib/types"

test("winding reuses failed prefixes without conflating lane biases or accepted copper", () => {
  const sharedBoundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  // A cannot cross the wall. B and C can route above it, so changing their
  // route order changes A's accepted copper without making A reachable.
  // Target order is A/B/C; source X order is A/C/B, repeating A's empty prefix.
  const endpoints = [
    { name: "A", via: { x: -4, y: -3 }, exit: { x: -3, y: 5 } },
    { name: "B", via: { x: 3, y: 2 }, exit: { x: 0, y: 5 } },
    { name: "C", via: { x: 0, y: 2 }, exit: { x: 3, y: 5 } },
  ]
  const pads: Obstacle[] = endpoints.map(({ name, via }) => ({
    type: "rect",
    obstacleId: `pad:${name}`,
    componentId: "component",
    center: { x: via.x - 0.2, y: via.y - 0.2 },
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: [name],
  }))
  const connections = endpoints.map(({ name, exit }, index) => ({
    name,
    pointsToConnect: [
      { ...pads[index]!.center, layer: "top", pointId: `pad:${name}` },
      { ...exit, layer: "bottom" },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: sharedBoundary,
    obstacles: [
      ...pads,
      {
        type: "rect",
        obstacleId: "wall",
        center: { x: 0, y: 0 },
        width: 10,
        height: 0.3,
        layers: ["bottom"],
        connectedTo: [],
      },
    ],
    connections,
  }
  const prepared = connections.map((connection, index) => ({
    connection,
    connectionIndex: index,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pads[index]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "BUS",
    direction: "up",
    exitEdge: "top",
    preferredExit: "top",
    termination: { type: "boundary" },
    connections: prepared,
    componentId: "component",
    componentObstacles: pads,
    componentBounds: sharedBoundary,
    sharedBoundary,
    xCoordinates: [-4, 0, 3],
    yCoordinates: [-3, 2],
    pitchX: 1,
    pitchY: 1,
    routableEscapeLayers: ["bottom"],
  }
  const steps = routeViaMinimalWindingAlternativesSteps(
    {
      srj,
      bus,
      targetLayer: "bottom",
      acceptedPlans: [],
      terminals: prepared.map((connection, index) => ({
        connection,
        viaPoint: endpoints[index]!.via,
        exitPoint: endpoints[index]!.exit,
      })),
      layerNames: ["top", "bottom"],
      traceWidth: 0.1,
      clearance: 0.1,
      viaDiameter: 0.1,
      viaHoleDiameter: 0.05,
      maximumRouteOrderAttempts: 12,
    },
    1,
    true,
  )
  const progress: RouteViaMinimalWindingProgress[] = []
  let result = steps.next()
  while (!result.done) {
    progress.push(result.value)
    result = steps.next()
  }
  expect(result.value).toEqual([])
  const eventsForAttempt = (attempt: number) =>
    progress.filter((event) => event.routeOrderAttempt === attempt)
  for (let biasIndex = 0; biasIndex < 3; biasIndex++) {
    // The first order must execute A separately for every lane bias. Each
    // failed search expands enough states to emit at least one progress batch.
    const firstEvents = eventsForAttempt(1 + biasIndex)
    expect(firstEvents.every((event) => event.connectionName === "A")).toBe(
      true,
    )
    expect(firstEvents.some((event) => !event.connectionComplete)).toBe(true)
    const firstCompletion = firstEvents.at(-1)!
    expect(firstCompletion.connectionComplete).toBe(true)
    expect(firstCompletion.searchBatch).toBeGreaterThan(0)

    // The source-X order has the identical empty prefix. Reusing failure emits
    // no expansion batches while preserving completion counts and its visual.
    expect(eventsForAttempt(7 + biasIndex)).toEqual([
      { ...firstCompletion, routeOrderAttempt: 7 + biasIndex },
    ])

    // Both other orders route B and C before A. Their accepted copper must
    // prevent reuse of the empty-prefix failure, for all three lane biases.
    for (const [firstAttempt, connectionOrder] of [
      [4, ["C", "B", "A"]],
      [10, ["B", "C", "A"]],
    ] as const) {
      const events = eventsForAttempt(firstAttempt + biasIndex)
      expect(
        events
          .filter((event) => event.connectionComplete)
          .map((event) => event.connectionName),
      ).toEqual([...connectionOrder])
      expect(
        events.some(
          (event) => event.connectionName === "A" && !event.connectionComplete,
        ),
      ).toBe(true)
      const acceptedLabels = events
        .at(-1)!
        .visualization!.lines!.map((line) => line.label)
        .filter((label) => label?.startsWith("accepted:"))
      expect(acceptedLabels).toContain("accepted: B")
      expect(acceptedLabels).toContain("accepted: C")
    }
  }
})
