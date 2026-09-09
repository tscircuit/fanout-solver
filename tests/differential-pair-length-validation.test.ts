import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("enforces an original differential pair inside a looser atomic bus by measured copper and exact identity", async () => {
  const bounds = { minX: -1, maxX: 4, minY: -1, maxY: 3 }
  const layerNames = ["top", "bottom"]
  const connections = ["DP", "DN", "OTHER"].map((name, index) => ({
    name,
    netConnectionName: `${name}-alias`,
    pointsToConnect: [
      {
        x: [0, -0.15, -0.2][index]!,
        y: index,
        layer: "top",
        pointId: `${name}-source`,
        pcb_port_id: `${name}-port`,
      },
      { x: 5, y: index, layer: "top", pointId: `${name}-target` },
    ],
  }))
  const pads: Obstacle[] = connections.map((connection) => ({
    type: "rect",
    shape: "circle",
    width: 0.15,
    height: 0.15,
    center: {
      x: connection.pointsToConnect[0]!.x,
      y: connection.pointsToConnect[0]!.y,
    },
    componentId: "U1",
    obstacleId: `${connection.name}-pad`,
    layers: ["top"],
    connectedTo: [connection.name, connection.pointsToConnect[0]!.pointId],
  }))
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -0.275, maxX: 0.075, minY: -0.075, maxY: 2.075 },
    sharedBoundary: bounds,
    xCoordinates: [-0.2, -0.15, 0],
    yCoordinates: [0, 1, 2],
    pitchX: 0.05,
    pitchY: 1,
    termination: { type: "boundary" },
    allowedLayers: ["top"],
    routableEscapeLayers: ["top"],
    maxLengthSkew: 0.25,
    connections: connections.map((connection, connectionIndex) => ({
      connection,
      connectionIndex,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: "top",
      sourceObstacle: pads[connectionIndex]!,
      targetPoint: connection.pointsToConnect[1]!,
    })),
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds,
    connections,
    obstacles: pads,
    differentialPairs: [
      { connectionNames: ["DP", "DN"], lengthTolerance: 0.1 },
    ],
  }
  const createPlan = (
    index: number,
    interior: Point2D[] = [],
  ): FanoutRoutePlan => {
    const source = bus.connections[index]!
    const name = source.connection.name
    const exitPoint = { x: 4, y: index }
    const points = [source.sourcePoint, ...interior, exitPoint]
    const segments = points
      .slice(1)
      .map((end, i) => ({ start: points[i]!, end, layer: "top", width: 0.1 }))
    return {
      busId: bus.busId,
      connectionName: name,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: source.sourcePoint,
      sourceLayer: "top",
      sourceObstacle: source.sourceObstacle,
      targetPoint: source.targetPoint,
      targetLayer: "top",
      termination: { type: "boundary" },
      direction: "right",
      exitEdge: "right",
      exitPoint,
      segments,
      length: segments.reduce(
        (sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y),
        0,
      ),
      trace: {
        type: "pcb_trace",
        pcb_trace_id: `fanout:${name}`,
        connection_name: name,
        connectsTo: [name, source.sourcePoint.pointId!],
        route: points.map((point, i) => ({
          route_type: "wire",
          x: point.x,
          y: point.y,
          layer: "top",
          width: 0.1,
          ...(i === 0
            ? { start_pcb_port_id: source.sourcePoint.pcb_port_id }
            : {}),
        })),
      },
    }
  }
  const original = connections.map((_, index) => createPlan(index))
  // A 45-degree trapezoid adds exactly 0.15mm to DP without changing its
  // source, exit, layer, or the other members of the intact three-lane bus.
  const height = 0.15 / (2 * (Math.SQRT2 - 1))
  const tuned = [
    createPlan(0, [
      { x: 1, y: 0 },
      { x: 1 + height, y: height },
      { x: 1.5 + height, y: height },
      { x: 1.5 + 2 * height, y: 0 },
    ]),
    original[1]!,
    original[2]!,
  ]
  const originalCopy = structuredClone({ inputSrj, bus, original })
  const output = (plans: FanoutRoutePlan[]) =>
    buildOutputSimpleRouteJson({ inputSrj, plans, layerNames })
  const validate = (
    plans = original,
    srj = inputSrj,
    outputSrj = output(original),
  ) =>
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj,
      plans,
      preparedBuses: [bus],
      sharedBoundary: bounds,
      clearance: 0.1,
    })
  const failure = validate()
  expect(failure.valid).toBe(false)
  expect(failure.issues).toEqual([
    expect.objectContaining({
      code: "differential-pair-length-skew",
      busId: "DATA",
      connectionName: "DP",
      otherConnectionName: "DN",
    }),
  ])
  expect(
    validate(original, { ...inputSrj, differentialPairs: undefined }).valid,
  ).toBe(true)
  expect(
    validate(original, inputSrj, { ...output(original), differentialPairs: [] })
      .valid,
  ).toBe(false)
  expect(
    validate(original.map((plan) => ({ ...plan, length: 4.15 }))).issues.some(
      (issue) => issue.code === "differential-pair-length-skew",
    ),
  ).toBe(true)
  expect(validate(tuned, inputSrj, output(tuned))).toMatchObject({
    valid: true,
    issues: [],
    brokenOutConnectionCount: 3,
  })
  expect(
    validate(
      tuned,
      {
        ...inputSrj,
        differentialPairs: [
          { connectionNames: ["DP", "DN"], lengthTolerance: 0 },
          { connectionNames: ["DN", "OTHER"], lengthTolerance: 0.04 },
        ],
      },
      output(tuned),
    ).issues,
  ).toEqual([
    expect.objectContaining({
      code: "differential-pair-length-skew",
      connectionName: "DN",
      otherConnectionName: "OTHER",
    }),
  ])
  const malformed: unknown[] = [
    null,
    {},
    [null],
    [{ connectionNames: ["DP"], lengthTolerance: 0.1 }],
    ...[
      ["DP", "DP"],
      ["DP", "missing"],
      ["DP-alias", "DN"],
      ["", "DN"],
      ["DP", 1],
      ["DP", "DN", "OTHER"],
    ].map((connectionNames) => [{ connectionNames, lengthTolerance: 0.1 }]),
    ...[-0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.1", undefined].map(
      (lengthTolerance) => [{ connectionNames: ["DP", "DN"], lengthTolerance }],
    ),
  ]
  for (const differentialPairs of malformed) {
    const report = validate(original, {
      ...inputSrj,
      differentialPairs,
    } as SimpleRouteJson)
    expect(report.valid).toBe(false)
    expect(
      report.issues.some((issue) => issue.code === "invalid-differential-pair"),
    ).toBe(true)
  }
  for (const plans of [
    original.slice(1),
    [...original, original[0]!],
    original.map((plan, i) => (i ? plan : { ...plan, connectionIndex: 1 })),
    original.map((plan, i) =>
      i
        ? plan
        : {
            ...plan,
            segments: plan.segments.map((segment) => ({
              ...segment,
              end: { ...segment.end, x: Number.NaN },
            })),
          },
    ),
  ]) {
    expect(
      validate(plans).issues.some(
        (issue) => issue.code === "invalid-differential-pair",
      ),
    ).toBe(true)
  }
  expect(
    validate(original, {
      ...inputSrj,
      connections: [...connections, connections[0]!],
    }).issues.some((issue) => issue.code === "invalid-differential-pair"),
  ).toBe(true)
  for (const plans of [original, tuned]) {
    expect(
      validateRoutedCopperDrc({
        inputSrj,
        routedSrj: output(plans),
        clearance: 0.1,
      }),
    ).toMatchObject({
      valid: true,
      issues: [],
      checkedTraceCount: 3,
      checkedViaCount: 0,
    })
  }
  for (const [index, plan] of tuned.entries()) {
    expect(plan.sourcePoint).toEqual(original[index]!.sourcePoint)
    expect(plan.exitPoint).toEqual(original[index]!.exitPoint)
    expect(plan.busId).toBe(bus.busId)
    expect(plan.targetLayer).toBe("top")
    expect(plan.via).toBeUndefined()
    for (const [i, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-8)
      if (i < plan.segments.length - 1)
        expect(segment.end.x).toBeLessThan(bounds.maxX)
      const prior = plan.segments[i - 1]
      if (!prior) continue
      const px = prior.end.x - prior.start.x
      const py = prior.end.y - prior.start.y
      expect(
        (px * dx + py * dy) / Math.hypot(px, py) / Math.hypot(dx, dy),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-8)
    }
  }
  expect({ inputSrj, bus, original }).toEqual(originalCopy)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output(tuned), connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
