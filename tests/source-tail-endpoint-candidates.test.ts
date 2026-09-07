import "bun-match-svg"
import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { distance } from "../lib/geometry"
import { getSourceTailEndpointCandidates } from "../lib/get-source-tail-endpoint-candidates"
import {
  createOrthogonalFanoutView,
  ORTHOGONAL_MATRICES,
} from "../lib/orthogonal-fanout-view"
import { fanoutPlansAreClear } from "../lib/route-bus"
import type { PeripheralSourceEscape } from "../lib/route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

test("slides an unfinished first via in both directions while retaining its source prefix and respecting finite search bounds", async () => {
  const boundary = { minX: -0.5, maxX: 3.25, minY: -0.5, maxY: 2.25 }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const traceWidth = 0.1
  const clearance = 0.1
  const sourcePoint = {
    x: 0,
    y: 0,
    layer: "top",
    pointId: "source-point",
    pcb_port_id: "source-port",
  }
  const targetPoint = { x: 4, y: 1.5, layer: "inner1", pointId: "target-point" }
  const connection = {
    name: "SIGNAL",
    pointsToConnect: [sourcePoint, targetPoint],
  }
  const obstacle = {
    type: "rect" as const,
    shape: "circle" as const,
    componentId: "BGA",
    center: sourcePoint,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: [connection.name],
  }
  const prepared: PreparedConnection = {
    connection,
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint,
    targetPoint,
    sourceLayer: "top",
    sourceObstacle: obstacle,
  }
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    termination: { type: "boundary" },
    componentId: "BGA",
    componentObstacles: [obstacle],
    componentBounds: boundary,
    sharedBoundary: boundary,
    connections: [prepared],
    xCoordinates: [0],
    yCoordinates: [0],
    pitchX: 0.5,
    pitchY: 0.5,
  }
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: traceWidth,
    bounds: boundary,
    obstacles: [obstacle],
    connections: [connection],
  }
  const path = [
    sourcePoint,
    { x: 0, y: 1 },
    { x: 0.5, y: 1.5 },
    { x: 2, y: 1.5 },
  ]
  const sourceEscape: PeripheralSourceEscape = {
    connectionIndex: 0,
    connectionName: connection.name,
    segments: path.slice(1).map((end, i) => ({
      start: path[i],
      end,
      layer: "top",
      width: traceWidth,
    })),
    via: {
      center: path.at(-1)!,
      diameter: 0.4,
      holeDiameter: 0.2,
      fromLayer: "top",
      toLayer: "inner1",
      spanLayers: layerNames,
    },
  }
  const params = {
    bus,
    connection: prepared,
    sourceEscape,
    traceWidth,
    clearance,
  }
  const before = JSON.stringify(params)
  const candidates = [
    ...getSourceTailEndpointCandidates({ ...params, maximumSteps: 16 }),
  ]
  const pitch = sourceEscape.via.diameter + clearance + 1e-5
  expect(candidates).toHaveLength(4)
  expect(candidates.map((candidate) => candidate.via.center.x)).toEqual([
    2 - pitch,
    2 + pitch,
    2 - 2 * pitch,
    2 + 2 * pitch,
  ])
  expect([
    ...getSourceTailEndpointCandidates({ ...params, maximumSteps: 1 }),
  ]).toEqual(candidates.slice(0, 2))
  expect([
    ...getSourceTailEndpointCandidates({ ...params, maximumSteps: 0 }),
  ]).toEqual([])
  for (const maximumSteps of [
    -1,
    17,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])
    expect(() => [
      ...getSourceTailEndpointCandidates({ ...params, maximumSteps }),
    ]).toThrow("bounded nonnegative budget")
  expect(() => [
    ...getSourceTailEndpointCandidates({
      ...params,
      connection: { ...prepared },
    }),
  ]).toThrow("original connection")
  expect(() => [
    ...getSourceTailEndpointCandidates({
      ...params,
      sourceEscape: {
        ...sourceEscape,
        via: { ...sourceEscape.via, center: { x: 1, y: 1 } },
      },
    }),
  ]).toThrow("coherent first via")
  const native = {
    ...sourceEscape,
    segments: [{ ...sourceEscape.segments[0], end: sourceEscape.via.center }],
  }
  expect([
    ...getSourceTailEndpointCandidates({ ...params, sourceEscape: native }),
  ]).toEqual([])
  const diagonalPath = [sourcePoint, { x: 0, y: 1 }, { x: 1, y: 2 }]
  const diagonal = {
    ...sourceEscape,
    segments: diagonalPath.slice(1).map((end, i) => ({
      start: diagonalPath[i],
      end,
      layer: "top",
      width: traceWidth,
    })),
    via: { ...sourceEscape.via, center: diagonalPath.at(-1)! },
  }
  const diagonalCandidates = [
    ...getSourceTailEndpointCandidates({
      ...params,
      sourceEscape: diagonal,
      maximumSteps: 1,
    }),
  ]
  expect(diagonalCandidates).toHaveLength(1)
  expect(
    distance(diagonalCandidates[0].via.center, diagonal.via.center),
  ).toBeCloseTo(pitch, 8)
  expect(diagonalCandidates[0].via.center.x).toBeCloseTo(
    1 - pitch / Math.SQRT2,
    8,
  )
  const clipped = {
    ...bus,
    sharedBoundary: { ...boundary, minX: 1.8, maxX: 2.2 },
  }
  expect([
    ...getSourceTailEndpointCandidates({ ...params, bus: clipped }),
  ]).toEqual([])
  for (const candidate of candidates) {
    expect(candidate.connectionIndex).toBe(sourceEscape.connectionIndex)
    expect(candidate.connectionName).toBe(sourceEscape.connectionName)
    expect(candidate.segments).toHaveLength(sourceEscape.segments.length)
    for (let i = 0; i < sourceEscape.segments.length - 1; i++)
      expect(candidate.segments[i]).toBe(sourceEscape.segments[i])
    expect(candidate.segments.at(-1)!.start).toBe(
      sourceEscape.segments.at(-1)!.start,
    )
    expect(candidate.segments.at(-1)!.layer).toBe("top")
    expect(candidate.segments.at(-1)!.width).toBe(traceWidth)
    expect(candidate.segments.at(-1)!.end).toBe(candidate.via.center)
    expect({ ...candidate.via, center: sourceEscape.via.center }).toEqual(
      sourceEscape.via,
    )
    expect(candidate.via.spanLayers).toBe(sourceEscape.via.spanLayers)
    expect(
      Number.isFinite(candidate.via.center.x) &&
        Number.isFinite(candidate.via.center.y),
    ).toBe(true)
    expect(
      candidate.via.center.x - candidate.via.diameter / 2,
    ).toBeGreaterThanOrEqual(boundary.minX)
    expect(
      candidate.via.center.x + candidate.via.diameter / 2,
    ).toBeLessThanOrEqual(boundary.maxX)
    expect(
      candidate.via.center.y - candidate.via.diameter / 2,
    ).toBeGreaterThanOrEqual(boundary.minY)
    expect(
      candidate.via.center.y + candidate.via.diameter / 2,
    ).toBeLessThanOrEqual(boundary.maxY)
    expect(
      distance(candidate.segments.at(-1)!.start, candidate.via.center),
    ).toBeGreaterThanOrEqual(traceWidth)
  }
  const makePlan = (candidate: PeripheralSourceEscape) =>
    buildViaMinimalWindingPlan({
      bus,
      terminal: {
        connection: prepared,
        viaPoint: candidate.via.center,
        exitPoint: { x: boundary.maxX, y: targetPoint.y },
      },
      targetLayer: "inner1",
      targetLayerPoints: [
        candidate.via.center,
        { x: boundary.maxX, y: targetPoint.y },
      ],
      sourceEscapePoints: [
        sourcePoint,
        ...candidate.segments.map((s) => s.end),
      ],
      layerNames,
      traceWidth,
      viaDiameter: candidate.via.diameter,
      viaHoleDiameter: candidate.via.holeDiameter,
      allowBlindAndBuriedVias: false,
    })
  for (const candidate of [sourceEscape, ...candidates]) {
    const plan = makePlan(candidate)
    expect(plan.sourcePoint).toBe(sourcePoint)
    expect(plan.targetPoint).toBe(targetPoint)
    expect(plan.via).toEqual(candidate.via)
    expect(plan.sourceEscapeSegmentCount).toBe(candidate.segments.length)
    expect(
      fanoutPlansAreClear({
        plans: [plan],
        srj,
        sharedBoundary: boundary,
        clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toBe(true)
    const output = buildOutputSimpleRouteJson({
      inputSrj: srj,
      plans: [plan],
      layerNames,
    })
    expect(
      validateFanoutSolution({
        inputSrj: srj,
        outputSrj: output,
        plans: [plan],
        preparedBuses: [bus],
        sharedBoundary: boundary,
        clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({
      valid: true,
      checkedConnectionCount: 1,
      brokenOutConnectionCount: 1,
      issues: [],
    })
    expect(
      validateRoutedCopperDrc({
        inputSrj: srj,
        routedSrj: output,
        clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, checkedViaCount: 1, issues: [] })
  }
  for (const matrix of Object.values(ORTHOGONAL_MATRICES)) {
    const view = createOrthogonalFanoutView(matrix)
    const transformed = view.toCanonical(params)
    const rotated = [
      ...getSourceTailEndpointCandidates({ ...transformed, maximumSteps: 1 }),
    ]
    expect(rotated).toHaveLength(2)
    rotated.forEach((candidate, i) => {
      expect(
        distance(
          candidate.via.center,
          view.toCanonical(candidates[i].via.center),
        ),
      ).toBeLessThan(1e-8)
    })
  }
  expect(JSON.stringify(params)).toBe(before)
  const examples = [
    { title: "Original", source: sourceEscape },
    { title: "Inward first via", source: candidates[0] },
    { title: "Outward first via", source: candidates[1] },
  ]
  const panels = examples
    .map(({ title, source }, index) => {
      const y = 45 + index * 350
      const toX = (x: number) => 80 + x * 100
      const toY = (height: number) => y + 260 - height * 100
      const points = [
        sourcePoint,
        ...source.segments.map((segment) => segment.end),
      ]
        .map((p) => `${toX(p.x)},${toY(p.y)}`)
        .join(" ")
      const via = source.via.center
      return `<g><text x="30" y="${y}" font-size="18" fill="#202735">${title}</text><rect x="${toX(boundary.minX)}" y="${toY(boundary.maxY)}" width="${(boundary.maxX - boundary.minX) * 100}" height="${(boundary.maxY - boundary.minY) * 100}" fill="none" stroke="#cad0d8" stroke-dasharray="4 4"/><polyline points="${points}" fill="none" stroke="#e54b58" stroke-width="10" stroke-linejoin="round"/><line x1="${toX(via.x)}" y1="${toY(via.y)}" x2="${toX(boundary.maxX)}" y2="${toY(via.y)}" stroke="#2869c7" stroke-width="10"/><circle cx="${toX(sourcePoint.x)}" cy="${toY(sourcePoint.y)}" r="15" fill="#f2a6ad"/><circle cx="${toX(via.x)}" cy="${toY(via.y)}" r="${source.via.diameter * 50}" fill="#2869c7"/><circle cx="${toX(via.x)}" cy="${toY(via.y)}" r="${source.via.holeDiameter * 50}" fill="white"/></g>`
    })
    .join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="1115" viewBox="0 0 460 1115"><rect x="0" y="0" width="460" height="1115" fill="white"/><g font-family="sans-serif">${panels}<text x="30" y="1090" font-size="13" fill="#394457">Earlier source segments, via size and layers stay fixed.</text></g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
