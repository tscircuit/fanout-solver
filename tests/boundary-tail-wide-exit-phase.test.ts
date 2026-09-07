import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("aligns widely separated exits to narrow approach corridors without moving their vias", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128
  const layerNames = ["top", "bottom"]
  const sharedBoundary = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
  const ys = [-0.32512, 0.32512].map((y) => y + 0.00206)
  const pads: Obstacle[] = ys.map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: 0.4, y },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    connectedTo: [`signal${i}`],
    componentId: "U1",
  }))
  // The exits are four physical track pitches apart. Each approach has its
  // own existing copper corridor, whose only legal centerline misses y=0's grid.
  const walls: Obstacle[] = ys.flatMap((y, i) =>
    [-1, 1].map((sign) => ({
      type: "rect" as const,
      center: { x: -1.35, y: y + sign * 0.26192 },
      width: 1.3,
      height: 0.28,
      layers: ["bottom"],
      connectedTo: [`wall${i}:${sign}`],
    })),
  )
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad${i}`,
      },
      targetPoint = { x: -3, y: ys[i]!, layer: "bottom" }
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
    componentBounds: {
      minX: 0.36,
      maxX: 0.44,
      minY: ys[0]! - 0.04,
      maxY: ys[1]! + 0.04,
    },
    sharedBoundary,
    xCoordinates: [0.4],
    yCoordinates: ys,
    pitchX: 0.65024,
    pitchY: 0.65024,
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles: [...pads, ...walls],
    connections: connections.map((c) => c.connection),
  }
  const config = {
    traceWidth,
    clearance,
    layerNames,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const original = connections.map((connection) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      exitPoint = { x: -2, y: connection.targetPoint.y }
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: [
        viaPoint,
        { x: -1.8, y: exitPoint.y },
        { x: -2, y: exitPoint.y + 0.02 },
        exitPoint,
      ],
    })
  })
  const before = structuredClone(original)
  const repaired = repairBoundaryRouteTails({
    ...config,
    inputSrj,
    plans: original,
    preparedBuses: [bus],
    gridOrigin: { x: 0, y: 0 },
  })
  expect(repaired).toHaveLength(2)
  if (!repaired)
    throw new Error("Expected both wide-spaced exit corridors to be repaired")
  expect(original).toEqual(before)
  for (const [i, plan] of repaired.entries()) {
    expect(plan.via).toEqual(original[i]!.via)
    expect(plan.exitPoint).toEqual(original[i]!.exitPoint)
    expect(plan.sourceObstacle).toBe(original[i]!.sourceObstacle)
    expect(plan.segments[0]).toEqual(original[i]!.segments[0])
    for (const s of plan.segments) {
      const dx = Math.abs(s.end.x - s.start.x),
        dy = Math.abs(s.end.y - s.start.y)
      expect(Math.min(dx, dy, Math.abs(dx - dy))).toBeLessThan(1e-7)
      for (const point of [s.start, s.end])
        if (Math.abs(point.x + 2) < 1e-7) expect(point).toEqual(plan.exitPoint)
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: repaired,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: repaired,
      preparedBuses: [bus],
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const graphics: GraphicsObject = {
    lines: [],
    rects: [],
    circles: [],
    texts: [],
  }
  for (const [plans, offset, label] of [
    [original, 0, "Before: early boundary contact"],
    [repaired, 4, "After: exact exit-phase corridors"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 0.9,
      text: label,
      fontSize: 0.12,
      anchorSide: "bottom_left",
    })
    for (const wall of walls)
      graphics.rects!.push({
        center: { x: wall.center.x + offset, y: wall.center.y },
        width: wall.width,
        height: wall.height,
        fill: "#cbd5e1",
      })
    for (const [i, plan] of plans.entries()) {
      for (const s of plan.segments)
        graphics.lines!.push({
          points: [s.start, s.end].map((p) => ({ x: p.x + offset, y: p.y })),
          strokeColor: ["#2563eb", "#e11d48"][i]!,
          strokeWidth: s.width,
        })
      graphics.circles!.push({
        center: { x: plan.via!.center.x + offset, y: plan.via!.center.y },
        radius: 0.12,
        fill: "#334155",
      })
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
