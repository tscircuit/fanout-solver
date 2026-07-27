import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
  pointIsInsideObstacle,
} from "lib/geometry"
import type { FanoutDirection, Point2D, RoutedSegment } from "lib/types"
import { fanoutDataset03 } from "../datasets/dataset03"

interface NamedSegment extends RoutedSegment {
  connectionName: string
}

interface NamedVia {
  connectionName: string
  center: Point2D
  diameter: number
  holeDiameter: number
}

function pointIsOnBoundary(
  point: Point2D,
  direction: FanoutDirection,
  boundary: (typeof fanoutDataset03)[number]["sharedBoundary"],
): boolean {
  const epsilon = 1e-6
  switch (direction) {
    case "left":
      return (
        Math.abs(point.x - boundary.minX) <= epsilon &&
        point.y >= boundary.minY - epsilon &&
        point.y <= boundary.maxY + epsilon
      )
    case "right":
      return (
        Math.abs(point.x - boundary.maxX) <= epsilon &&
        point.y >= boundary.minY - epsilon &&
        point.y <= boundary.maxY + epsilon
      )
    case "up":
      return (
        Math.abs(point.y - boundary.maxY) <= epsilon &&
        point.x >= boundary.minX - epsilon &&
        point.x <= boundary.maxX + epsilon
      )
    case "down":
      return (
        Math.abs(point.y - boundary.minY) <= epsilon &&
        point.x >= boundary.minX - epsilon &&
        point.x <= boundary.maxX + epsilon
      )
  }
}

test("dataset03 fans out a rotated QFN50 and two oriented 0603s on two JLCPCB-rule layers", () => {
  expect(fanoutDataset03).toHaveLength(4)

  for (const sample of fanoutDataset03) {
    expect(sample.footprintCount).toBe(3)
    expect(sample.footprinterStrings).toEqual([
      "qfn50_p0.4mm",
      "res0603",
      "cap0603",
    ])
    expect(sample.simpleRouteJson.layerCount).toBe(2)
    expect(sample.simpleRouteJson.connections).toHaveLength(54)
    expect(sample.simpleRouteJson.obstacles).toHaveLength(54)
    expect(sample.simpleRouteJson.buses).toHaveLength(8)
    expect(
      new Set(
        sample.simpleRouteJson.obstacles.map(
          (obstacle) => obstacle.componentId,
        ),
      ),
    ).toEqual(new Set(["qfn50", "resistor-0603", "capacitor-0603"]))

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    expect(new Set(solver.preparedBuses.map((bus) => bus.componentId))).toEqual(
      new Set(["qfn50", "resistor-0603", "capacitor-0603"]),
    )
    expect(
      new Set(
        solver.preparedBuses
          .filter((bus) => bus.componentId === "qfn50")
          .map((bus) => bus.direction),
      ),
    ).toEqual(new Set(["left", "right", "up", "down"]))

    solver.solve()

    expect(solver.failed).toBe(false)
    const output = solver.getOutput()
    expect(output.attempts).toHaveLength(1)
    expect(output.fanoutTraces).toHaveLength(54)
    expect(new Set(Object.values(output.busLayerAssignments))).toEqual(
      new Set(["top", "bottom"]),
    )

    for (const bus of solver.preparedBuses) {
      const expectedLayer = output.busLayerAssignments[bus.busId]
      const viaUse = bus.connections.map((connection) => {
        const trace = output.fanoutTraces.find(
          (candidate) =>
            candidate.connection_name === connection.connection.name,
        )!
        const finalPoint = trace.route.at(-1)!
        if (finalPoint.route_type !== "wire") {
          throw new Error(`${trace.connection_name} does not end in a wire`)
        }
        expect(
          pointIsOnBoundary(finalPoint, bus.direction, sample.sharedBoundary),
        ).toBe(true)
        return trace.route.some((routePoint) => routePoint.route_type === "via")
      })
      expect(new Set(viaUse).size).toBe(1)
      expect(viaUse[0]).toBe(expectedLayer === "bottom")
    }

    if (sample.id === "sample001") {
      expect(output.busLayerAssignments["qfn50:north"]).toBe("bottom")
      expect(output.busLayerAssignments["qfn50:south"]).toBe("bottom")
    }
    if (sample.id === "sample002") {
      expect(output.busLayerAssignments["qfn50:east"]).toBe("bottom")
      expect(output.busLayerAssignments["qfn50:west"]).toBe("bottom")
    }

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
        expect(
          distanceSegmentToSegment(
            first.start,
            first.end,
            second.start,
            second.end,
          ) -
            (first.width + second.width) / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
      }
    }

    for (const segment of segments) {
      if (segment.layer !== "top") continue
      for (const obstacle of sample.simpleRouteJson.obstacles) {
        if (
          obstacle.connectedTo.includes(segment.connectionName) &&
          pointIsInsideObstacle(segment.start, obstacle)
        ) {
          continue
        }
        expect(
          distanceSegmentToObstacle(segment, obstacle) - segment.width / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
      }
    }

    for (const via of vias) {
      expect(via.diameter).toBe(0.25)
      expect(via.holeDiameter).toBe(0.15)
      for (const obstacle of sample.simpleRouteJson.obstacles) {
        expect(
          distancePointToObstacle(via.center, obstacle) - via.diameter / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
      }
      for (const segment of segments) {
        if (segment.connectionName === via.connectionName) continue
        expect(
          distancePointToSegment(via.center, segment.start, segment.end) -
            via.diameter / 2 -
            segment.width / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
        expect(
          distancePointToSegment(via.center, segment.start, segment.end) -
            via.holeDiameter / 2 -
            segment.width / 2,
        ).toBeGreaterThanOrEqual(0.15 - 1e-6)
      }
    }

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
        expect(
          centerDistance - (first.diameter + second.diameter) / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
        expect(
          centerDistance - (first.holeDiameter + second.holeDiameter) / 2,
        ).toBeGreaterThanOrEqual(0.2 - 1e-6)
      }
    }
  }
}, 30_000)
