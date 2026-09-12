import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { distanceSegmentToObstacle, segmentsAreClear } from "lib/geometry"
import type { RoutedSegment } from "lib/types"
import {
  validateRoutedCopperDrc,
  type RoutedCopperDrcIssueCode,
} from "lib/validate-routed-copper-drc"

test("spatial DRC preserves exhaustive violations and their order for mixed pad shapes and copper widths", () => {
  let seed = 7341
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const obstacles = Array.from({ length: 24 }, (_, i) => ({
    type: "rect" as const,
    obstacleId: `pad-${i}`,
    center: { x: random() * 12, y: random() * 12 },
    width: 0.3 + random() * 2,
    height: 0.1 + random(),
    layers: [i % 3 === 0 ? "bottom" : "top"],
    connectedTo: ["foreign"],
    ...(i % 3 === 0 ? { shape: "circle" as const } : {}),
    ...(i % 3 === 1 ? { ccwRotationDegrees: 45 } : {}),
  }))
  const traces: SimplifiedPcbTrace[] = Array.from({ length: 8 }, (_, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `trace-${i}`,
    connection_name: `net-${i}`,
    route: Array.from({ length: 24 }, () => ({
      route_type: "wire" as const,
      x: random() * 16,
      y: random() * 16,
      width: 0.05 + random() * 0.8,
      layer: i % 3 === 0 ? "bottom" : "top",
    })),
  }))
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.05,
    bounds: { minX: -5, minY: -5, maxX: 20, maxY: 20 },
    obstacles,
    connections: [
      ...traces.map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: [],
      })),
      { name: "foreign", pointsToConnect: [] },
    ],
    traces,
  }
  // Use the public route semantics, independently enumerate every pair, and
  // compare ordered diagnostics rather than just the final validity flag.
  const segments = traces.map((trace) =>
    trace.route.slice(1).map((point, i) => {
      const previous = trace.route[i]!
      if (point.route_type !== "wire" || previous.route_type !== "wire")
        throw new Error("Expected wire")
      return {
        start: previous,
        end: point,
        layer: point.layer,
        width: point.width,
      } satisfies RoutedSegment
    }),
  )
  const clearance = 0.12
  const expected: {
    code: RoutedCopperDrcIssueCode
    traceId: string
    obstacleId?: string
    otherTraceId?: string
  }[] = []
  for (const [i, own] of segments.entries()) {
    for (const segment of own) {
      for (const obstacle of obstacles) {
        if (
          obstacle.layers.includes(segment.layer) &&
          distanceSegmentToObstacle(segment, obstacle) <
            segment.width / 2 + clearance - 1e-6
        ) {
          expected.push({
            code: "trace-obstacle-clearance",
            traceId: traces[i]!.pcb_trace_id,
            obstacleId: obstacle.obstacleId,
          })
        }
      }
    }
  }
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      for (const first of segments[i]!) {
        for (const second of segments[j]!) {
          if (!segmentsAreClear(first, second, clearance))
            expected.push({
              code: "different-net-trace-clearance",
              traceId: traces[i]!.pcb_trace_id,
              otherTraceId: traces[j]!.pcb_trace_id,
            })
        }
      }
    }
  }
  const report = validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: srj,
    clearance,
  })
  expect(expected.length).toBeGreaterThan(100)
  expect(
    report.issues.map(({ code, traceId, obstacleId, otherTraceId }) => ({
      code,
      traceId,
      ...(obstacleId === undefined ? {} : { obstacleId }),
      ...(otherTraceId === undefined ? {} : { otherTraceId }),
    })),
  ).toEqual(expected)
})
