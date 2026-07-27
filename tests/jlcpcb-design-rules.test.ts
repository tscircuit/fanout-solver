import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
  pointIsInsideObstacle,
} from "lib/geometry"
import type { Point2D, RoutedSegment } from "lib/types"
import { fanoutDataset02 } from "../datasets/dataset02"

interface NamedSegment extends RoutedSegment {
  connectionName: string
}

interface NamedVia {
  connectionName: string
  center: Point2D
  diameter: number
  holeDiameter: number
}

test("the hardest sample clears JLCPCB copper spacing with explicit HDI microvias", () => {
  const sample = fanoutDataset02.at(-1)!
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()
  const output = solver.getOutput()
  const segments: NamedSegment[] = []
  const vias: NamedVia[] = []

  for (const trace of output.fanoutTraces) {
    let previousWire:
      | { x: number; y: number; width: number; layer: string }
      | undefined
    for (const routePoint of trace.route) {
      if (routePoint.route_type === "via") {
        vias.push({
          connectionName: trace.connection_name,
          center: { x: routePoint.x, y: routePoint.y },
          diameter: routePoint.via_diameter!,
          holeDiameter: routePoint.via_hole_diameter!,
        })
        previousWire = undefined
        continue
      }
      if (routePoint.route_type !== "wire") {
        previousWire = undefined
        continue
      }
      if (
        previousWire &&
        previousWire.layer === routePoint.layer &&
        Math.hypot(
          routePoint.x - previousWire.x,
          routePoint.y - previousWire.y,
        ) > 1e-9
      ) {
        segments.push({
          connectionName: trace.connection_name,
          start: previousWire,
          end: routePoint,
          width: routePoint.width,
          layer: routePoint.layer,
        })
      }
      previousWire = routePoint
    }
  }

  let minimumTraceSpacing = Number.POSITIVE_INFINITY
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    const first = segments[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < segments.length;
      secondIndex++
    ) {
      const second = segments[secondIndex]!
      if (
        first.layer !== second.layer ||
        first.connectionName === second.connectionName
      ) {
        continue
      }
      minimumTraceSpacing = Math.min(
        minimumTraceSpacing,
        distanceSegmentToSegment(
          first.start,
          first.end,
          second.start,
          second.end,
        ) -
          (first.width + second.width) / 2,
      )
    }
  }

  const pads = sample.simpleRouteJson.obstacles.filter(
    (obstacle) => obstacle.componentId,
  )
  let minimumPadToTrace = Number.POSITIVE_INFINITY
  for (const segment of segments) {
    if (segment.layer !== "top") continue
    for (const pad of pads) {
      if (
        pad.connectedTo.includes(segment.connectionName) &&
        pointIsInsideObstacle(segment.start, pad)
      ) {
        continue
      }
      minimumPadToTrace = Math.min(
        minimumPadToTrace,
        distanceSegmentToObstacle(segment, pad) - segment.width / 2,
      )
    }
  }

  let minimumViaToPad = Number.POSITIVE_INFINITY
  let minimumViaCopperToTrace = Number.POSITIVE_INFINITY
  let minimumViaHoleToTrace = Number.POSITIVE_INFINITY
  for (const via of vias) {
    for (const pad of pads) {
      minimumViaToPad = Math.min(
        minimumViaToPad,
        distancePointToObstacle(via.center, pad) - via.diameter / 2,
      )
    }
    for (const segment of segments) {
      if (segment.connectionName === via.connectionName) continue
      minimumViaCopperToTrace = Math.min(
        minimumViaCopperToTrace,
        distancePointToSegment(via.center, segment.start, segment.end) -
          via.diameter / 2 -
          segment.width / 2,
      )
      minimumViaHoleToTrace = Math.min(
        minimumViaHoleToTrace,
        distancePointToSegment(via.center, segment.start, segment.end) -
          via.holeDiameter / 2 -
          segment.width / 2,
      )
    }
  }

  let minimumViaCopperSpacing = Number.POSITIVE_INFINITY
  let minimumViaHoleSpacing = Number.POSITIVE_INFINITY
  for (let firstIndex = 0; firstIndex < vias.length; firstIndex++) {
    const first = vias[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < vias.length;
      secondIndex++
    ) {
      const second = vias[secondIndex]!
      const centerDistance = Math.hypot(
        first.center.x - second.center.x,
        first.center.y - second.center.y,
      )
      minimumViaCopperSpacing = Math.min(
        minimumViaCopperSpacing,
        centerDistance - (first.diameter + second.diameter) / 2,
      )
      minimumViaHoleSpacing = Math.min(
        minimumViaHoleSpacing,
        centerDistance - (first.holeDiameter + second.holeDiameter) / 2,
      )
    }
  }

  const pitch = 0.4
  const padDiameter = 0.2
  const jlcStandardViaDiameter = 0.25
  const configuredMicroviaDiameter = 0.15
  const cornerDistance = Math.hypot(pitch / 2, pitch / 2)
  const standardViaToPadEdgeGap =
    cornerDistance - padDiameter / 2 - jlcStandardViaDiameter / 2
  const microviaToPadEdgeGap =
    cornerDistance - padDiameter / 2 - configuredMicroviaDiameter / 2

  expect(segments.length).toBeGreaterThan(500)
  expect(vias).toHaveLength(100)
  expect(standardViaToPadEdgeGap).toBeLessThan(0.1)
  expect(microviaToPadEdgeGap).toBeGreaterThanOrEqual(0.1)
  expect(vias.every((via) => via.diameter === 0.15)).toBe(true)
  expect(vias.every((via) => via.holeDiameter === 0.1)).toBe(true)
  expect(minimumTraceSpacing).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(minimumPadToTrace).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(minimumViaToPad).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(minimumViaCopperToTrace).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(minimumViaHoleToTrace).toBeGreaterThanOrEqual(0.125 - 1e-6)
  expect(minimumViaCopperSpacing).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(minimumViaHoleSpacing).toBeGreaterThanOrEqual(0.15 - 1e-6)
})
