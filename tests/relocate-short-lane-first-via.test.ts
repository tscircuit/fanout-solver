import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { relocateShortLaneFirstVia } from "lib/relocate-short-lane-first-via"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

function fixture({ rotated = false, mirroredCollinear = false } = {}) {
  const rotate = (p: { x: number; y: number }) =>
    rotated ? { x: -p.y, y: p.x } : mirroredCollinear ? { x: -p.x, y: p.y } : p
  const rules = {
    layerNames: ["top", "inner1", "inner2", "bottom"],
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const paths = [
    [
      { x: -0.4, y: 0.4 },
      { x: -0.8, y: 0 },
    ],
    [
      { x: 1.2, y: 1.2 },
      { x: 1.6, y: 1.6 },
      { x: 2.3, y: 1.6 },
      { x: 2.4, y: 1.5 },
      { x: 2.4, y: -1.6 },
    ],
    [
      { x: -1.2, y: 1.2 },
      { x: -1.6, y: 1.6 },
      { x: -2.3, y: 1.6 },
      { x: -2.4, y: 1.5 },
      { x: -2.4, y: -1.2 },
      { x: -2, y: -1.6 },
      { x: -1.6, y: -1.6 },
    ],
  ].map((path) => path.map(rotate))
  // Put the short lane's target midpoint exactly on the outer return line.
  const returnLine =
    Math.max(...paths.slice(1).map((path) => -path.at(-1)!.y)) +
    rules.viaDiameter / 2 +
    (rules.traceWidth / 2 + rules.clearance) +
    rules.clearance / 10
  const exitY = mirroredCollinear ? -2 * returnLine : -3.4
  const bounds = { minX: -3.4, maxX: 3.4, minY: exitY, maxY: 3.4 }
  const exits = [-0.8, 2.4, -1.6].map((x) => rotate({ x, y: exitY }))
  const srj: SimpleRouteJson = {
    layerCount: 4,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: paths.map((p, i) => ({
      name: `lane-${i}`,
      pointsToConnect: [
        { ...p[0]!, layer: "top" },
        { ...exits[i]!, layer: "inner1" },
      ],
    })),
    obstacles: [-1.2, -0.4, 0.4, 1.2].flatMap((x) =>
      [-1.2, -0.4, 0.4, 1.2].map((y) => {
        const center = rotate({ x, y }),
          source = paths.findIndex(
            (p) => Math.hypot(p[0]!.x - center.x, p[0]!.y - center.y) < 1e-7,
          )
        return {
          type: "rect" as const,
          shape: "circle",
          center,
          width: 0.3,
          height: 0.3,
          layers: ["top"],
          componentId: "U1",
          connectedTo: source < 0 ? [] : [`lane-${source}`],
        }
      }),
    ),
  }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: srj.connections.map((c) => c.name),
        direction: rotated ? "right" : "down",
        preferredExit: rotated ? "right" : "bottom",
        exitEdge: rotated ? "right" : "bottom",
        allowedLayers: ["inner1"],
        maxLengthSkew: 2,
      },
    ],
  })
  const bus = buses[0]!
  const plans = paths.map((p, i) =>
    buildViaMinimalWindingPlan({
      ...rules,
      bus,
      terminal: {
        connection: bus.connections.find(
          (c) => c.connection.name === `lane-${i}`,
        )!,
        viaPoint: p.at(-1)!,
        exitPoint: exits[i]!,
      },
      targetLayer: "inner1",
      targetLayerPoints: [p.at(-1)!, exits[i]!],
      sourceEscapePoints: p,
      allowBlindAndBuriedVias: false,
    }),
  )
  return { ...rules, inputSrj: srj, preparedBuses: buses, bus, plans, rotate }
}

test("moves one short lane's first via onto its retained target path without changing neighboring copper", async () => {
  const params = fixture()
  const before = JSON.stringify(params)
  const output = (plans: typeof params.plans) =>
    buildOutputSimpleRouteJson({ ...params, plans })
  const validate = (plans: typeof params.plans, inputSrj = params.inputSrj) =>
    validateFanoutSolution({
      inputSrj,
      outputSrj: buildOutputSimpleRouteJson({ ...params, inputSrj, plans }),
      plans,
      preparedBuses: params.preparedBuses,
      sharedBoundary: params.bus.sharedBoundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(validate(params.plans).issues.map((i) => i.code)).toEqual([
    "bus-length-skew",
  ])
  const result = relocateShortLaneFirstVia(params)
  expect(result).not.toBeNull()
  expect(validate(result!).valid).toBe(true)
  expect(JSON.stringify(params)).toBe(before)
  expect(result).toHaveLength(3)
  for (const plan of result!) {
    for (const [i, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const previous = plan.segments[i - 1]
      if (!previous || previous.layer !== segment.layer) continue
      const px = previous.end.x - previous.start.x,
        py = previous.end.y - previous.start.y
      expect(
        (px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  expect(result![1]).toBe(params.plans[1])
  expect(result![2]).toBe(params.plans[2])
  const short = result![0]!,
    original = params.plans[0]!
  expect(short.via!.center).not.toEqual(original.via!.center)
  expect(short.via!.diameter).toBe(original.via!.diameter)
  expect(short.via!.holeDiameter).toBe(original.via!.holeDiameter)
  expect(short.via!.spanLayers).toEqual(original.via!.spanLayers)
  expect(short.connectionIndex).toBe(original.connectionIndex)
  expect(short.sourceObstacle).toBe(original.sourceObstacle)
  expect(short.exitPoint).toBe(original.exitPoint)
  expect(short.targetLayer).toBe(original.targetLayer)
  expect(short.segments[0]).toEqual(original.segments[0])
  const tail = short.segments.slice(short.sourceEscapeSegmentCount!)
  expect(tail).toHaveLength(1)
  expect(tail[0]!.start).toEqual(short.via!.center)
  expect(tail[0]!.end).toEqual(original.segments.at(-1)!.end)
  expect(tail[0]!.layer).toBe(original.targetLayer)
  expect(short.length).toBeGreaterThan(original.length)
  // The original first segment's count is implicitly one, as in ordinary dogbones.
  expect(original.sourceEscapeSegmentCount).toBeUndefined()
  const rotated = fixture({ rotated: true }),
    rotatedResult = relocateShortLaneFirstVia(rotated)
  expect(rotatedResult).not.toBeNull()
  for (const [i, plan] of result!.entries()) {
    expect(rotatedResult![i]!.segments).toHaveLength(plan.segments.length)
    for (const [j, segment] of plan.segments.entries())
      for (const end of ["start", "end"] as const) {
        const actual = rotatedResult![i]!.segments[j]![end]
        expect(actual.x).toBeCloseTo(-segment[end].y, 7)
        expect(actual.y).toBeCloseTo(segment[end].x, 7)
      }
  }
  // Mirroring forces the leftward detour. Its final approach is collinear
  // with the new via, so retaining a duplicate tail point would make the
  // declared segments disagree with the emitted trace despite passing DRC.
  const collinear = fixture({ mirroredCollinear: true })
  const collinearBefore = JSON.stringify(collinear)
  const validateCollinear = (plans: typeof collinear.plans) =>
    validateFanoutSolution({
      inputSrj: collinear.inputSrj,
      outputSrj: buildOutputSimpleRouteJson({ ...collinear, plans }),
      plans,
      preparedBuses: collinear.preparedBuses,
      sharedBoundary: collinear.bus.sharedBoundary,
      clearance: collinear.clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(validateCollinear(collinear.plans).issues.map((i) => i.code)).toEqual([
    "bus-length-skew",
  ])
  const collinearResult = relocateShortLaneFirstVia(collinear)
  expect(collinearResult).not.toBeNull()
  expect(validateCollinear(collinearResult!).valid).toBe(true)
  expect(JSON.stringify(collinear)).toBe(collinearBefore)
  expect(collinearResult![1]).toBe(collinear.plans[1])
  expect(collinearResult![2]).toBe(collinear.plans[2])
  const collinearShort = collinearResult![0]!
  expect(collinearShort.via!.center).toEqual({
    x: collinear.plans[0]!.via!.center.x,
    y: collinear.inputSrj.bounds.minY / 2,
  })
  expect(collinearShort.segments[0]).toBe(collinear.plans[0]!.segments[0])
  expect(collinearShort.segments.at(-1)!.end).toBe(
    collinear.plans[0]!.exitPoint,
  )
  for (const segment of collinearShort.segments)
    expect(
      Math.hypot(
        segment.end.x - segment.start.x,
        segment.end.y - segment.start.y,
      ),
    ).toBeGreaterThan(0)
  // This TOP barrier clears the original dogbones and inner-layer tails, but
  // leaves insufficient barrel clearance at the only replacement via site.
  const blockedInput = {
    ...params.inputSrj,
    obstacles: [
      ...params.inputSrj.obstacles,
      {
        type: "rect" as const,
        center: { x: 0, y: -1.94 },
        width: 6.79,
        height: 0.1,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  expect(
    validate(params.plans, blockedInput).issues.map((i) => i.code),
  ).toEqual(["bus-length-skew"])
  expect(
    relocateShortLaneFirstVia({ ...params, inputSrj: blockedInput }),
  ).toBeNull()
  expect(JSON.stringify(params)).toBe(before)
  const svg = getSvgFromGraphicsObject(
    visualizeSimpleRouteJson({ ...output(result!), connections: [] }),
  )
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
