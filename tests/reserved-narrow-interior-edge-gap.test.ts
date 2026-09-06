import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { getFreeBoundaryTracks } from "lib/get-free-boundary-tracks"
import { routeBusAlternativesSteps } from "lib/route-bus"
import { routeReservedNarrowBusesSteps } from "lib/route-reserved-narrow-buses"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

function finish<T>(steps: Generator<unknown, T, void>): T {
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

test("recovers a fixed-via singleton through an interior gap in its original corner band", async () => {
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const layerNames = ["top", "inner1", "bottom"]
  const width = 0.1,
    clearance = 0.1
  const pads = [
    {
      type: "rect" as const,
      center: { x: 0, y: -0.4 },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      connectedTo: ["RESET"],
    },
    {
      type: "rect" as const,
      center: { x: 4.7, y: 0.8 },
      width: 0.6,
      height: 0.3,
      layers: ["inner1"],
      componentId: "U2",
      connectedTo: ["ACCEPTED"],
    },
  ]
  const connections = pads.map((pad, index) => ({
    name: pad.connectedTo[0]!,
    pointsToConnect: [
      { ...pad.center, layer: pad.layers[0]!, pointId: `source-${index}` },
      {
        x: -6,
        y: index === 0 ? 4 : 0.8,
        layer: "inner1",
        pointId: `target-${index}`,
      },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: layerNames.length,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map(
    (connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: pads[index]!.layers[0]!,
      sourceObstacle: pads[index]!,
      targetPoint: connection.pointsToConnect[1]!,
      exitTargetPoint: connection.pointsToConnect[1]!,
      hasExplicitExitTarget: true,
      hasExplicitLayeredExitTarget: true,
    }),
  )
  const buses: PreparedBus[] = prepared.map((connection, index) => ({
    busId: connection.connection.name,
    componentId: pads[index]!.componentId,
    componentObstacles: [pads[index]!],
    componentBounds: {
      minX: pads[index]!.center.x - pads[index]!.width / 2,
      maxX: pads[index]!.center.x + pads[index]!.width / 2,
      minY: pads[index]!.center.y - pads[index]!.height / 2,
      maxY: pads[index]!.center.y + pads[index]!.height / 2,
    },
    sharedBoundary: boundary,
    xCoordinates: [pads[index]!.center.x],
    yCoordinates: [pads[index]!.center.y],
    pitchX: 1,
    pitchY: 1,
    direction: index === 0 ? "up" : "left",
    exitEdge: "left",
    preferredExit: index === 0 ? "top-left" : "left",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    termination: { type: "boundary" },
    connections: [connection],
  }))
  // This accepted lane and its pad join opposite edges. The source below it
  // cannot reach the projected top-left track, but the positive gap stays open.
  const accepted: FanoutRoutePlan = {
    ...prepared[1]!,
    busId: "ACCEPTED",
    connectionName: "ACCEPTED",
    targetLayer: "inner1",
    direction: "left",
    exitEdge: "left",
    termination: { type: "boundary" },
    exitPoint: { x: -5, y: 0.8 },
    length: 9.7,
    segments: [
      {
        start: pads[1]!.center,
        end: { x: -5, y: 0.8 },
        layer: "inner1",
        width,
      },
    ],
    trace: {
      type: "pcb_trace",
      pcb_trace_id: "accepted-trace",
      connection_name: "ACCEPTED",
      route: [pads[1]!.center, { x: -5, y: 0.8 }].map((point) => ({
        route_type: "wire" as const,
        ...point,
        layer: "inner1",
        width,
      })),
    },
  }
  const bus = buses[0]!
  const connection = prepared[0]!
  const viaPoint = { x: 0.3, y: -0.1 }
  const sourcePath = [pads[0]!.center, viaPoint]
  const params = {
    srj,
    targetLayer: "inner1",
    acceptedPlans: [accepted],
    layerNames,
    traceWidth: width,
    clearance,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: false,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    fixedViaPointsByConnectionIndex: new Map([[0, viaPoint]]),
    sourceEscapePaths: new Map([[0, sourcePath]]),
  }
  expect(
    finish(
      routeBusAlternativesSteps(
        {
          ...params,
          bus,
          viaMinimalOnly: true,
          adaptiveWindingRouteOrder: true,
          alignWindingGridToPads: true,
          windingGridStep: 0.1,
          fixedViaFallbackRouteOrderAttempts: 32,
        },
        1,
        false,
      ),
    ),
  ).toEqual([])
  const tracks = getFreeBoundaryTracks({ ...params, bus })
  expect(tracks[0]).toBeCloseTo(0.325, 8)
  expect(
    tracks.every((track) => track >= width / 2 && track <= 5 - width / 2),
  ).toBe(true)
  const recovered = finish(
    routeReservedNarrowBusesSteps({ ...params, buses: [bus] }),
  )
  expect(recovered).toHaveLength(1)
  const plan = recovered![0]!
  expect(plan.targetPoint).toEqual(connection.targetPoint)
  expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
  expect(plan.sourcePoint).toEqual(connection.sourcePoint)
  expect(plan.via!.center).toEqual(viaPoint)
  expect(plan.via!.spanLayers).toEqual(layerNames)
  expect(plan.additionalVias ?? []).toHaveLength(0)
  expect(plan.segments[0]).toEqual({
    start: sourcePath[0],
    end: sourcePath[1],
    layer: "top",
    width,
  })
  expect(plan.direction).toBe("up")
  expect(plan.exitEdge).toBe("left")
  expect(plan.cornerBandSide).toBe("maximum")
  expect(bus.preferredExit).toBe("top-left")
  expect(plan.exitPoint).toEqual({ x: -5, y: tracks[0]! })
  const plans = [plan, accepted]
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 2,
    brokenOutConnectionCount: 2,
    issues: [],
  })

  // Closing only the positive gap leaves the lower half physically available.
  // The singleton must fail instead of silently changing its declared band.
  const closedSrj: SimpleRouteJson = {
    ...srj,
    obstacles: [
      ...pads,
      {
        type: "rect",
        center: { x: -4.5, y: 0.4 },
        width: 1,
        height: 0.8,
        layers: ["inner1"],
        connectedTo: [],
      },
    ],
  }
  expect(
    finish(
      routeReservedNarrowBusesSteps({
        ...params,
        srj: closedSrj,
        buses: [bus],
      }),
    ),
  ).toBeNull()
  expect(
    finish(
      routeReservedNarrowBusesSteps({
        ...params,
        srj: closedSrj,
        buses: [{ ...bus, preferredExit: "bottom-left" }],
      }),
    )?.[0]?.exitPoint.y,
  ).toBeLessThan(0)
  const graphics = visualizeSimpleRouteJson(output)
  graphics.lines!.unshift(
    {
      points: [
        { x: -5, y: 0 },
        { x: -5, y: 5 },
      ],
      strokeColor: "#86b697",
      strokeWidth: 0.035,
    },
    {
      points: [
        { x: -5, y: -1 },
        { x: -5, y: 0 },
      ],
      strokeColor: "#b0b0b0",
      strokeWidth: 0.035,
    },
    {
      points: [
        { x: -5, y: 0 },
        { x: 1, y: 0 },
      ],
      strokeColor: "#a0a0a0",
      strokeWidth: 0.025,
      strokeDash: [0.1, 0.1],
    },
  )
  graphics.points!.push({ x: -5, y: 2.5, color: "#dc2626" })
  graphics.texts = [
    {
      x: -4.7,
      y: 4,
      text: "Original target retained",
      fontSize: 0.22,
      anchorSide: "center_left",
      color: "#666666",
    },
    {
      x: -4.7,
      y: 2.5,
      text: "Blocked corner track",
      fontSize: 0.22,
      anchorSide: "center_left",
      color: "#dc2626",
    },
    {
      x: -1,
      y: 1.2,
      text: "Accepted copper",
      fontSize: 0.22,
      color: "#2563eb",
    },
    {
      x: -5.2,
      y: 0.325,
      text: "0.325",
      fontSize: 0.18,
      anchorSide: "center_right",
      color: "#2563eb",
    },
    {
      x: -2.5,
      y: -0.7,
      text: "Outside top-left band",
      fontSize: 0.22,
      color: "#888888",
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
