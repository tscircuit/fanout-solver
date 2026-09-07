import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { distance } from "lib/geometry"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("boundary repair joins retained copper without reversing search spurs", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128,
    viaDiameter = 0.08,
    viaHoleDiameter = 0.04,
    layerNames = ["top", "bottom"]
  const sharedBoundary = { minX: -1, maxX: 6, minY: 0, maxY: 8 }
  // Cropped boundary geometry: the first lanes approach the repair strip
  // sideways, while tightly packed neighbors require a joint tail search.
  const coordinates: number[][][] = [
    [
      [0.6522, 2.37648],
      [0.6522, 1.4824],
      [0.57092, 1.4824],
      [0.57092, 1.31984],
      [0.48964, 1.31984],
      [0.48964, 1.23856],
      [0.40836, 1.23856],
      [0.40836, 0.01936],
      [1.13988, 0.01936],
      [1.2311, 0.0],
    ],
    [
      [0.81476, 2.21392],
      [0.81476, 1.31984],
      [0.73348, 1.31984],
      [0.73348, 1.15728],
      [0.6522, 1.15728],
      [0.6522, 1.076],
      [0.57092, 1.076],
      [0.57092, 0.18192],
      [1.465, 0.18192],
      [1.465, 0.01936],
      [1.55238, 0.0],
    ],
    [
      [3.82212, 1.8888],
      [3.82212, 1.80752],
      [3.74084, 1.80752],
      [3.74084, 1.72624],
      [3.65956, 1.72624],
      [3.65956, 1.64496],
      [3.57828, 1.64496],
      [3.57828, 1.56368],
      [3.497, 1.56368],
      [3.497, 1.4824],
      [3.41572, 1.4824],
      [3.41572, 1.40112],
      [3.33444, 1.40112],
      [3.33444, 1.31984],
      [3.25316, 1.31984],
      [3.25316, 1.23856],
      [3.17188, 1.23856],
      [3.17188, 1.15728],
      [3.0906, 1.15728],
      [3.0906, 1.076],
      [3.00932, 1.076],
      [3.00932, 0.99472],
      [2.92804, 0.99472],
      [2.92804, 0.91344],
      [2.84676, 0.91344],
      [2.84676, 0.83216],
      [2.76548, 0.83216],
      [2.76548, 0.75088],
      [2.6842, 0.75088],
      [2.6842, 0.6696],
      [2.60292, 0.6696],
      [2.60292, 0.58832],
      [2.52164, 0.58832],
      [2.52164, 0.50704],
      [2.44036, 0.50704],
      [2.44036, 0.10064],
      [2.46765333, 0.0],
    ],
    [
      [4.14724, 1.8888],
      [4.14724, 1.80752],
      [4.06596, 1.80752],
      [4.06596, 1.72624],
      [3.98468, 1.72624],
      [3.98468, 1.64496],
      [3.9034, 1.64496],
      [3.9034, 1.56368],
      [3.82212, 1.56368],
      [3.82212, 1.4824],
      [3.74084, 1.4824],
      [3.74084, 1.40112],
      [3.65956, 1.40112],
      [3.65956, 1.31984],
      [3.57828, 1.31984],
      [3.57828, 1.23856],
      [3.497, 1.23856],
      [3.497, 1.15728],
      [3.41572, 1.15728],
      [3.41572, 1.076],
      [3.33444, 1.076],
      [3.33444, 0.99472],
      [3.25316, 0.99472],
      [3.25316, 0.91344],
      [3.17188, 0.91344],
      [3.17188, 0.83216],
      [3.0906, 0.83216],
      [3.0906, 0.75088],
      [3.00932, 0.75088],
      [3.00932, 0.6696],
      [2.92804, 0.6696],
      [2.92804, 0.58832],
      [2.84676, 0.58832],
      [2.84676, 0.50704],
      [2.76548, 0.50704],
      [2.76548, 0.42576],
      [2.6842, 0.42576],
      [2.6842, 0.34448],
      [2.60292, 0.34448],
      [2.60292, 0.10064],
      [2.63021333, 0.0],
    ],
    [
      [0.97732, 2.05136],
      [0.97732, 0.83216],
      [1.22116, 0.83216],
      [1.22116, 0.50704],
      [1.30244, 0.50704],
      [1.30244, 0.42576],
      [1.70884, 0.42576],
      [1.70884, 0.18192],
      [1.79012, 0.18192],
      [1.79012, 0.10064],
      [1.82125333, 0.0],
    ],
    [
      [3.17188, 1.8888],
      [3.17188, 1.80752],
      [3.0906, 1.80752],
      [3.0906, 1.72624],
      [3.00932, 1.72624],
      [3.00932, 1.64496],
      [2.92804, 1.64496],
      [2.92804, 1.56368],
      [2.84676, 1.56368],
      [2.84676, 1.4824],
      [2.76548, 1.4824],
      [2.76548, 1.40112],
      [2.6842, 1.40112],
      [2.6842, 1.31984],
      [2.60292, 1.31984],
      [2.60292, 1.23856],
      [2.52164, 1.23856],
      [2.52164, 1.15728],
      [2.11524, 1.15728],
      [2.11524, 0.6696],
      [2.03396, 0.6696],
      [2.03396, 0.01936],
      [2.14253333, 0.0],
    ],
    [
      [4.63492, 1.8888],
      [4.63492, 1.80752],
      [4.55364, 1.80752],
      [4.55364, 1.72624],
      [4.47236, 1.72624],
      [4.47236, 1.64496],
      [4.39108, 1.64496],
      [4.39108, 1.56368],
      [4.3098, 1.56368],
      [4.3098, 1.4824],
      [4.22852, 1.4824],
      [4.22852, 1.40112],
      [4.14724, 1.40112],
      [4.14724, 1.31984],
      [4.06596, 1.31984],
      [4.06596, 1.23856],
      [3.98468, 1.23856],
      [3.98468, 1.15728],
      [3.9034, 1.15728],
      [3.9034, 1.076],
      [3.82212, 1.076],
      [3.82212, 0.99472],
      [3.74084, 0.99472],
      [3.74084, 0.91344],
      [3.57828, 0.91344],
      [3.57828, 0.75088],
      [3.497, 0.75088],
      [3.497, 0.6696],
      [3.33444, 0.6696],
      [3.33444, 0.50704],
      [3.25316, 0.50704],
      [3.25316, 0.42576],
      [3.17188, 0.42576],
      [3.17188, 0.34448],
      [3.0906, 0.34448],
      [3.0906, 0.2632],
      [3.00932, 0.2632],
      [3.00932, 0.18192],
      [2.92804, 0.18192],
      [2.92804, 0.10064],
      [2.84676, 0.10064],
      [2.84676, 0.01936],
      [2.79277333, 0.0],
    ],
    [
      [3.497, 1.8888],
      [3.497, 1.80752],
      [3.41572, 1.80752],
      [3.41572, 1.72624],
      [3.33444, 1.72624],
      [3.33444, 1.64496],
      [3.25316, 1.64496],
      [3.25316, 1.56368],
      [3.17188, 1.56368],
      [3.17188, 1.4824],
      [3.0906, 1.4824],
      [3.0906, 1.40112],
      [3.00932, 1.40112],
      [3.00932, 1.31984],
      [2.92804, 1.31984],
      [2.92804, 1.23856],
      [2.84676, 1.23856],
      [2.84676, 1.15728],
      [2.76548, 1.15728],
      [2.76548, 1.076],
      [2.6842, 1.076],
      [2.6842, 0.99472],
      [2.60292, 0.99472],
      [2.60292, 0.91344],
      [2.52164, 0.91344],
      [2.52164, 0.83216],
      [2.44036, 0.83216],
      [2.44036, 0.75088],
      [2.35908, 0.75088],
      [2.35908, 0.6696],
      [2.2778, 0.6696],
      [2.2778, 0.10064],
      [2.30509333, 0.0],
    ],
  ]
  const paths = coordinates.map((points) =>
    points.map(([x, y]) => ({ x: x!, y: y! })),
  )
  const pads: Obstacle[] = paths.map((points, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: points[0]!.x, y: points[0]!.y + 0.4 },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`signal${i}`],
  }))
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad${i}`,
      },
      targetPoint = { ...paths[i]!.at(-1)!, layer: "bottom" }
    return {
      connection: {
        name: `signal${i}`,
        pointsToConnect: [sourcePoint, targetPoint],
      },
      connectionIndex: i,
      sourcePointIndex: 0,
      sourcePoint,
      sourceLayer: "top",
      sourceObstacle,
      targetPoint,
      exitTargetPoint: targetPoint,
      hasExplicitLayeredExitTarget: true,
    }
  })
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "down",
    preferredExit: "bottom",
    exitEdge: "bottom",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: 0, maxX: 5, minY: 2, maxY: 3 },
    sharedBoundary,
    xCoordinates: pads.map((p) => p.center.x),
    yCoordinates: pads.map((p) => p.center.y),
    pitchX: 0.32512,
    pitchY: 0.32512,
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles: pads,
    connections: connections.map((c) => c.connection),
  }
  const config = {
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    layerNames,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const original = connections.map((connection, i) =>
    buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: {
        connection,
        viaPoint: paths[i]![0]!,
        exitPoint: paths[i]!.at(-1)!,
      },
      targetLayer: "bottom",
      targetLayerPoints: paths[i]!,
    }),
  )
  const before = structuredClone(original)
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: original,
    }),
  ).toBe(false)
  const repaired = repairBoundaryRouteTails({
    ...config,
    inputSrj,
    preparedBuses: [bus],
    plans: original,
  })
  expect(repaired).toHaveLength(original.length)
  if (!repaired) throw Error("Expected the complete boundary cluster")
  expect(original).toEqual(before)
  const normalized = repaired.map((plan, i) => {
    expect(plan.via).toEqual(original[i]!.via)
    expect(plan.sourcePoint).toEqual(original[i]!.sourcePoint)
    expect(plan.exitPoint).toEqual(original[i]!.exitPoint)
    expect(plan.segments[0]).toEqual(original[i]!.segments[0])
    const segments = plan.segments.filter(
      (segment) => segment.layer === "bottom",
    )
    for (let j = 1; j < segments.length; j++) {
      const a = segments[j - 1]!,
        b = segments[j]!,
        dot =
          ((a.end.x - a.start.x) * (b.end.x - b.start.x) +
            (a.end.y - a.start.y) * (b.end.y - b.start.y)) /
          (distance(a.start, a.end) * distance(b.start, b.end))
      expect(dot).toBeGreaterThanOrEqual(-1e-7)
    }
    const points = normalizeLayeredPath({
      points: [segments[0]!.start, ...segments.map((s) => s.end)].map((p) => ({
        ...p,
        z: 1,
      })),
      chamfer: traceWidth / 4,
      segmentIsClear: () => true,
    })
    expect(points).not.toBeNull()
    if (!points)
      throw Error("The repaired boundary route must be octilinear-normalizable")
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: {
        connection: connections[i]!,
        viaPoint: plan.via!.center,
        exitPoint: plan.exitPoint,
      },
      targetLayer: "bottom",
      targetLayerPoints: points,
    })
  })
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: normalized,
    }),
  ).toBe(true)
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: { ...inputSrj, traces: normalized.map((p) => p.trace) },
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(validation.valid).toBe(true)
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [plans, offset, label] of [
    [original, 0, "Before: crowded boundary links"],
    [normalized, 8, "After: clear joins without reversing spurs"],
  ] as const) {
    graphics.texts!.push({
      x: offset,
      y: 3.3,
      text: label,
      anchorSide: "bottom_left",
      fontSize: 0.16,
    })
    graphics.lines!.push({
      points: [
        { x: offset - 0.5, y: 0 },
        { x: offset + 5, y: 0 },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.02,
    })
    for (const [i, plan] of plans.entries())
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((p) => ({
            x: p.x + offset,
            y: p.y,
          })),
          strokeColor: ["#2563eb", "#059669", "#d97706", "#9333ea"][i % 4],
          strokeWidth: segment.width,
        })
    for (const plan of plans)
      graphics.circles!.push({
        center: { x: plan.via!.center.x + offset, y: plan.via!.center.y },
        radius: viaDiameter / 2,
        fill: "#334155",
      })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
