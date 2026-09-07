import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { getBoundaryApproachReservations } from "lib/get-boundary-approach-reservations"
import { distancePointToSegment } from "lib/geometry"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import type { Point2D } from "lib/types"

test("joint first vias leave the later layer's boundary approach available", async () => {
  const bounds = { minX: -2, maxX: 4, minY: -2, maxY: 2 }
  const config = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "inner2", "bottom"],
    allowBlindAndBuriedVias: false,
  }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: config.traceWidth,
    connections: [0, 1].map((y, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        { x: -1, y, layer: "top" },
        { x: 4, y: 0, layer: index === 0 ? "inner2" : "bottom" },
      ],
    })),
    obstacles: [
      ...[0, 1].map((y, index) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center: { x: -1, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        componentId: "U1",
        connectedTo: [`N${index}`],
      })),
      {
        type: "rect",
        center: { x: 0.5, y: 0 },
        width: 6,
        height: 5,
        layers: ["inner2"],
        connectedTo: ["wall"],
      },
    ],
  }
  const buses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    escapeLayers: ["inner2", "bottom"],
    buses: ["CURRENT", "LATER"].map((busId, index) => ({
      busId,
      connectionNames: [`N${index}`],
      sourceComponentId: "U1",
      direction: "right",
      preferredExit: "right",
      exitEdge: "right",
      allowedLayers: [index === 0 ? "inner2" : "bottom"],
    })),
  })
  const current = buses[0]!,
    later = buses[1]!
  const exits = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) => [connection.connectionIndex, { x: 4, y: 0 }] as const,
      ),
    ),
  )
  const fixed = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [
            connection.connectionIndex,
            { x: 3.82, y: connection.sourcePoint.y },
          ] as const,
      ),
    ),
  )
  const paths = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [
            connection.connectionIndex,
            [connection.sourcePoint, fixed.get(connection.connectionIndex)!],
          ] as const,
      ),
    ),
  )
  const targetLayerByBusId = new Map([
    ["CURRENT", "inner2"],
    ["LATER", "bottom"],
  ])
  const reservations = getBoundaryApproachReservations({
    ...config,
    buses,
    exits,
    targetLayerByBusId,
    excludedBusIds: new Set([current.busId]),
  })
  expect(reservations).toHaveLength(1)
  expect(reservations[0]!.connection_name).toBe("N1")
  expect(reservations[0]!.route).toEqual([
    {
      route_type: "wire",
      x: 4 - config.traceWidth - config.clearance,
      y: 0,
      layer: "bottom",
      width: config.traceWidth,
    },
    {
      route_type: "wire",
      x: 4,
      y: 0,
      layer: "bottom",
      width: config.traceWidth,
    },
  ])
  const before = JSON.stringify({
    inputSrj,
    sites: [...fixed],
    paths: [...paths],
  })
  const params = {
    ...config,
    srj: inputSrj,
    allBuses: buses,
    buses: [current],
    targetLayer: "inner2",
    transitLayers: [],
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    fixedViaPointsByConnectionIndex: fixed,
    sourceEscapePaths: paths,
    acceptedPlans: [],
    terminals: current.connections.map((connection) => ({
      connection,
      viaPoint: fixed.get(connection.connectionIndex)!,
      exitPoint: exits.get(connection.connectionIndex)!,
    })),
    tightViaChannels: true,
    maximumIterations: 1_000_000,
    maximumRipEvents: 10,
    maximumLocalRepairAttempts: 0,
  }
  const run = (p: Parameters<typeof routeReservedViaBusesSteps>[0]) => {
    const steps = routeReservedViaBusesSteps(p)
    let result = steps.next()
    while (!result.done) result = steps.next()
    return result.value
  }
  const original = run(params)!
  expect(original).toHaveLength(1)
  const guarded = run({
    ...params,
    srj: { ...inputSrj, traces: reservations },
  })!
  expect(guarded).toHaveLength(1)
  const approach = reservations[0]!.route.filter(
    (point) => point.route_type === "wire",
  )
  const required =
    config.viaDiameter / 2 + config.traceWidth / 2 + config.clearance
  expect(
    distancePointToSegment(
      original[0]!.via!.center,
      approach[0]!,
      approach[1]!,
    ),
  ).toBeLessThan(required)
  expect(
    distancePointToSegment(guarded[0]!.via!.center, approach[0]!, approach[1]!),
  ).toBeGreaterThanOrEqual(required - 1e-7)
  const newSites = new Map<number, Point2D>(fixed),
    newPaths = new Map<number, readonly { x: number; y: number }[]>(paths)
  const changed = guarded[0]!
  newSites.set(changed.connectionIndex, changed.via!.center)
  newPaths.set(changed.connectionIndex, [
    changed.sourcePoint,
    ...changed.segments
      .slice(0, changed.sourceEscapeSegmentCount)
      .map((segment) => segment.end),
  ])
  const finishedLater = run({
    ...params,
    buses: [later],
    targetLayer: "bottom",
    routeFromSourcePads: false,
    fixedViaPointsByConnectionIndex: newSites,
    sourceEscapePaths: newPaths,
    acceptedPlans: guarded,
    terminals: later.connections.map((connection) => ({
      connection,
      viaPoint: newSites.get(connection.connectionIndex)!,
      exitPoint: exits.get(connection.connectionIndex)!,
    })),
  })!
  expect(finishedLater).toHaveLength(1)
  expect(finishedLater[0]!.via!.center).toEqual(
    fixed.get(later.connections[0]!.connectionIndex)!,
  )
  const plans = [...guarded, ...finishedLater]
  const output = buildOutputSimpleRouteJson({
    inputSrj,
    plans,
    layerNames: config.layerNames,
  })
  expect(output.traces).toHaveLength(2)
  expect(
    output.traces!.some((trace) =>
      trace.pcb_trace_id.includes("approach-reservation"),
    ),
  ).toBe(false)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: bounds,
      clearance: config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 2,
    brokenOutConnectionCount: 2,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  expect(
    JSON.stringify({ inputSrj, sites: [...fixed], paths: [...paths] }),
  ).toBe(before)
  const prefix = buildViaMinimalWindingPlan({
    ...config,
    bus: later,
    targetLayer: "bottom",
    terminal: {
      connection: later.connections[0]!,
      viaPoint: fixed.get(later.connections[0]!.connectionIndex)!,
      exitPoint: fixed.get(later.connections[0]!.connectionIndex)!,
    },
    targetLayerPoints: [fixed.get(later.connections[0]!.connectionIndex)!],
  })
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [routes, offset, label] of [
    [[...original, prefix], 0, "Before: via crowds later exit"],
    [plans, 2.1, "After: approach remains clear"],
  ] as const) {
    graphics.texts!.push({
      x: 3.3 + offset,
      y: 1.6,
      text: label,
      fontSize: 0.1,
      anchorSide: "bottom_left",
    })
    graphics.lines!.push({
      points: [
        { x: 4 + offset, y: -0.5 },
        { x: 4 + offset, y: 1.3 },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.02,
    })
    for (const [index, plan] of routes.entries()) {
      for (const segment of plan.segments) {
        if (Math.max(segment.start.x, segment.end.x) < 3.3) continue
        const clipped = [segment.start, segment.end].map((point, i) => {
          if (point.x >= 3.3) return point
          const other = i === 0 ? segment.end : segment.start
          const t = (3.3 - point.x) / (other.x - point.x)
          return { x: 3.3, y: point.y + t * (other.y - point.y) }
        })
        graphics.lines!.push({
          points: clipped.map((point) => ({
            x: point.x + offset,
            y: point.y,
          })),
          strokeColor: ["#2563eb", "#059669"][index],
          strokeWidth: segment.width,
        })
      }
      graphics.circles!.push({
        center: { x: plan.via!.center.x + offset, y: plan.via!.center.y },
        radius: config.viaDiameter / 2,
        fill: "#334155",
      })
    }
    graphics.lines!.push({
      points: approach.map((point) => ({ x: point.x + offset, y: point.y })),
      strokeColor: "#f97316",
      strokeWidth: config.traceWidth / 2,
      strokeDash: "dashed",
    })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
