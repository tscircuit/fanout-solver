import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { packBoundaryBusIntervals } from "lib/pack-boundary-bus-intervals"
import {
  getBoundaryTargetTrack,
  getCornerTargetTrack,
  routeBus,
} from "lib/route-bus"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("packs and routes overlapping whole bus intervals without changing lane order or bounds", async () => {
  const traceWidth = 0.08,
    clearance = 0.08,
    viaDiameter = 0.16,
    viaHoleDiameter = 0.08
  const layerNames = ["top", "bottom"]
  const sharedBoundary = { minX: -2, maxX: 2, minY: -1, maxY: 1 }
  const definitions = [
    { bus: "LOW_PAIR", desired: [0.4, 0.8], color: "#2563eb" },
    { bus: "CONTROL", desired: [0.6], color: "#059669" },
    { bus: "HIGH_PAIR", desired: [0.6, 1], color: "#d97706" },
  ]
  const pads: Obstacle[] = Array.from({ length: 5 }, (_, index) => ({
    obstacleId: `pad-${index}`,
    componentId: "U1",
    type: "rect",
    shape: "circle",
    center: { x: -1, y: -0.8 + index * 0.4 },
    width: 0.12,
    height: 0.12,
    layers: ["top"],
    connectedTo: [`signal-${index}`],
  }))
  let nextIndex = 0
  const buses: PreparedBus[] = definitions.map((definition) => ({
    busId: definition.bus,
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -1.06, maxX: -0.94, minY: -0.86, maxY: 0.86 },
    sharedBoundary,
    xCoordinates: [-1],
    yCoordinates: pads.map((pad) => pad.center.y),
    pitchX: 0.4,
    pitchY: 0.4,
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections: definition.desired.map((desiredTrack): PreparedConnection => {
      const connectionIndex = nextIndex++,
        sourceObstacle = pads[connectionIndex]!
      const source = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad-${connectionIndex}`,
      }
      const target = { x: 3, y: desiredTrack, layer: "bottom" }
      return {
        connection: {
          name: `signal-${connectionIndex}`,
          pointsToConnect: [source, target],
        },
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint: source,
        sourceLayer: "top",
        sourceObstacle,
        targetPoint: target,
        exitTargetPoint: target,
        hasExplicitLayeredExitTarget: true,
      }
    }),
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles: pads,
    connections: buses.flatMap((bus) =>
      bus.connections.map((c) => c.connection),
    ),
  }
  const params = {
    buses,
    targetLayerByBusId: new Map(buses.map((bus) => [bus.busId, "bottom"])),
    layerNames,
    traceWidth,
    viaDiameter,
    clearance,
  }
  const original = structuredClone(buses)
  const packed = packBoundaryBusIntervals(params)
  expect(packed.tracksByConnectionIndex.size).toBe(5)
  expect(packed.intervals.map((interval) => interval.busId)).toEqual(
    definitions.map((d) => d.bus),
  )
  expect(
    packed.intervals.some((interval) => Math.abs(interval.shift) > 0.1),
  ).toBe(true)
  expect(buses).toEqual(original)
  expect(
    packed.intervals.toSorted((a, b) => a.start - b.start).map((i) => i.busId),
  ).toEqual(definitions.map((definition) => definition.bus))
  for (const interval of packed.intervals) {
    expect(interval.layer).toBe("bottom")
    expect(interval.edge).toBe("right")
    expect(interval.start).toBeGreaterThanOrEqual(sharedBoundary.minY - 1e-9)
    expect(interval.end).toBeLessThanOrEqual(sharedBoundary.maxY + 1e-9)
    for (let index = 1; index < interval.tracks.length; index++)
      expect(interval.tracks[index]! - interval.tracks[0]!).toBeCloseTo(
        interval.desiredTracks[index]! - interval.desiredTracks[0]!,
        12,
      )
  }
  const tracks = [...packed.tracksByConnectionIndex.values()].sort(
    (a, b) => a - b,
  )
  for (let index = 1; index < tracks.length; index++)
    expect(tracks[index]! - tracks[index - 1]!).toBeGreaterThanOrEqual(
      traceWidth + clearance - 1e-9,
    )
  expect(tracks.at(-1)).toBeCloseTo(sharedBoundary.maxY, 12)

  // The public routeBus API receives packed goals without changing the source
  // circuit, its downstream guidance, or the connections' winding metadata.
  const plans: FanoutRoutePlan[] = []
  for (const bus of buses) {
    const ownIndices = new Set(bus.connections.map((c) => c.connectionIndex))
    const routed = routeBus({
      srj: inputSrj,
      bus,
      targetLayer: "bottom",
      layerNames,
      traceWidth,
      clearance,
      viaDiameter,
      viaHoleDiameter,
      allowBlindAndBuriedVias: false,
      acceptedPlans: plans,
      compactBusTracks: true,
      fixedViaFallbackRouteOrderAttempts: 8,
      windingGridStep: 0.08,
      fixedBoundaryTracksByConnectionIndex: packed.tracksByConnectionIndex,
      fixedViaPointsByConnectionIndex: new Map(
        bus.connections.map((connection) => [
          connection.connectionIndex,
          { x: -0.6, y: connection.sourcePoint.y },
        ]),
      ),
      reservedVias: buses
        .flatMap((candidate) => candidate.connections)
        .filter((c) => !ownIndices.has(c.connectionIndex))
        .map((connection) => ({
          connectionName: connection.connection.name,
          via: {
            center: { x: -0.6, y: connection.sourcePoint.y },
            diameter: viaDiameter,
            spanLayers: layerNames,
          },
        })),
    })
    expect(routed).toHaveLength(bus.connections.length)
    if (!routed) throw new Error(`Expected complete bus ${bus.busId}`)
    plans.push(...routed)
  }
  expect(plans).toHaveLength(5)
  expect(buses).toEqual(original)
  for (const fixedTracks of [
    new Map([[0, 0]]),
    new Map([
      [0, 2],
      [1, 0],
    ]),
  ])
    expect(() =>
      routeBus({
        ...params,
        srj: inputSrj,
        bus: buses[0]!,
        targetLayer: "bottom",
        acceptedPlans: [],
        viaHoleDiameter,
        compactBusTracks: true,
        fixedBoundaryTracksByConnectionIndex: fixedTracks,
      }),
    ).toThrow("invalid fixed boundary track")
  for (const plan of plans) {
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.exitEdge).toBe("right")
    expect(plan.exitPoint.x).toBe(sharedBoundary.maxX)
    expect(plan.exitPoint.y).toBeCloseTo(
      packed.tracksByConnectionIndex.get(plan.connectionIndex)!,
      12,
    )
  }
  const firstBus = buses[0]!,
    firstConnection = firstBus.connections[0]!
  for (const windingOrderIndex of [0, 1, 3]) {
    const targetParams = {
      ...params,
      bus: firstBus,
      connection: firstConnection,
      targetLayer: "bottom",
      boundaryDirection: "right" as const,
      cornerExitLaneOffset: 9,
      windingOrderIndex,
      fixedBoundaryTracksByConnectionIndex: packed.tracksByConnectionIndex,
    }
    expect(getBoundaryTargetTrack(targetParams)).toBe(
      packed.tracksByConnectionIndex.get(0)!,
    )
    expect(
      getCornerTargetTrack({
        ...targetParams,
        bus: { ...firstBus, preferredExit: "bottom-right" },
      }),
    ).toBe(packed.tracksByConnectionIndex.get(0)!)
  }
  const outputSrj = buildOutputSimpleRouteJson({ inputSrj, plans, layerNames })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans,
      preparedBuses: buses,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 5, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  // A second packing leaves already separated bus targets exactly in place.
  const separated = buses.map((bus) => ({
    ...bus,
    connections: bus.connections.map((connection) => ({
      ...connection,
      exitTargetPoint: {
        x: 3,
        y: packed.tracksByConnectionIndex.get(connection.connectionIndex)!,
        layer: "bottom",
      },
    })),
  }))
  for (const interval of packBoundaryBusIntervals({
    ...params,
    buses: separated,
  }).intervals)
    expect(interval.shift).toBe(0)
  expect(() =>
    packBoundaryBusIntervals({
      ...params,
      buses: buses.map((bus) => ({
        ...bus,
        sharedBoundary: { ...sharedBoundary, minY: 0, maxY: 0.7 },
      })),
    }),
  ).toThrow("do not fit")

  const colorByBus = new Map(definitions.map((d) => [d.bus, d.color]))
  const graphics: GraphicsObject = {
    title: "Three intact buses fit one shared boundary",
    lines: [
      {
        points: [
          { x: 2, y: -1 },
          { x: 2, y: 1 },
        ],
        strokeColor: "#dc2626",
        strokeWidth: 0.02,
      },
      ...plans.flatMap((plan) =>
        plan.segments.map((segment) => ({
          points: [segment.start, segment.end],
          strokeColor: colorByBus.get(plan.busId),
          strokeWidth: segment.width,
        })),
      ),
      ...packed.intervals.map((interval, index) => ({
        points: [
          { x: 2.55 + index * 0.25, y: interval.desiredStart },
          { x: 2.55 + index * 0.25, y: interval.desiredEnd },
        ],
        strokeColor: colorByBus.get(interval.busId),
        strokeWidth: 0.035,
      })),
    ],
    circles: [
      ...pads.map((pad) => ({
        center: pad.center,
        radius: pad.width / 2,
        fill: "#64748b",
      })),
      ...plans.flatMap((plan) =>
        plan.via
          ? [
              {
                center: plan.via.center,
                radius: viaDiameter / 2,
                strokeColor: colorByBus.get(plan.busId),
                fill: "#ffffff",
              },
            ]
          : [],
      ),
      ...packed.intervals.flatMap((interval, index) =>
        interval.desiredTracks.map((y) => ({
          center: { x: 2.55 + index * 0.25, y },
          radius: 0.055,
          fill: colorByBus.get(interval.busId),
        })),
      ),
    ],
    texts: [
      {
        x: 0.6,
        y: 1.35,
        text: "Validated bottom-layer routes",
        fontSize: 0.16,
      },
      { x: 2.8, y: 1.35, text: "Overlapping requests", fontSize: 0.14 },
    ],
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
