import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("repairs a boundary endpoint cluster while preserving the complete bus and real source vias", async () => {
  const traceWidth = 0.04,
    clearance = 0.04,
    viaDiameter = 0.08,
    viaHoleDiameter = 0.04,
    layerNames = ["top", "bottom"]
  const sharedBoundary = { minX: -2, maxX: 2, minY: -1, maxY: 1 }
  const pads: Obstacle[] = [-0.24, -0.08, 0.08].map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: 0.4, y },
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
      targetPoint = {
        x: -3,
        y: sourceObstacle.center.y + 0.12,
        layer: "bottom",
      }
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
    direction: "left",
    preferredExit: "left",
    exitEdge: "left",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: 0.36, maxX: 0.44, minY: -0.28, maxY: 0.12 },
    sharedBoundary,
    xCoordinates: [0.4],
    yCoordinates: pads.map((p) => p.center.y),
    pitchX: 0.16,
    pitchY: 0.16,
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
  const original = connections.map((connection) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      exitPoint = { x: -2, y: connection.targetPoint.y }
    const points = [
      viaPoint,
      ...Array.from({ length: 24 }, (_, i) => ({
        x: -(i + 1) * 0.08,
        y: viaPoint.y,
      })),
      { x: -1.96, y: viaPoint.y },
      exitPoint,
    ]
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: points,
    })
  })
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: original,
    }),
  ).toBe(false)
  const before = structuredClone(original),
    repaired = repairBoundaryRouteTails({
      ...config,
      inputSrj,
      preparedBuses: [bus],
      plans: original,
    })
  expect(repaired).toHaveLength(3)
  if (!repaired) throw new Error("Expected all bus lanes to be repaired")
  expect(original).toEqual(before)
  for (let i = 0; i < repaired.length; i++) {
    const plan = repaired[i]!
    expect(plan.exitPoint).toEqual(original[i]!.exitPoint)
    expect(plan.via).toEqual(original[i]!.via)
    expect(plan.sourcePoint).toEqual(original[i]!.sourcePoint)
    expect(plan.sourceObstacle).toBe(original[i]!.sourceObstacle)
    expect(plan.busId).toBe("DATA")
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.exitEdge).toBe("left")
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.segments[0]).toEqual(original[i]!.segments[0])
  }
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: repaired,
    }),
  ).toBe(true)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: repaired,
    layerNames,
  })
  const drc = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: outputSrj,
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc.valid).toBe(true)
  const validation = validateFanoutSolution({
    inputSrj,
    outputSrj,
    plans: repaired,
    preparedBuses: [bus],
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(validation.valid).toBe(true)
  expect(
    repairBoundaryRouteTails({
      ...config,
      inputSrj,
      preparedBuses: [bus],
      plans: repaired,
    }),
  ).toEqual(repaired)
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [plans, offset, label] of [
    [original, 0, "Before: crowded boundary links"],
    [repaired, 5, "After: same endpoints and vias"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 0.65,
      text: label,
      anchorSide: "bottom_left",
      fontSize: 0.13,
    })
    graphics.lines!.push({
      points: [
        { x: -2 + offset, y: -0.5 },
        { x: -2 + offset, y: 0.4 },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.015,
    })
    for (const [i, plan] of plans.entries())
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((p) => ({
            x: p.x + offset,
            y: p.y,
          })),
          strokeColor: ["#2563eb", "#059669", "#d97706"][i],
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
