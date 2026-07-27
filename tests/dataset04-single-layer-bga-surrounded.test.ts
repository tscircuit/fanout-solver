import { expect, test } from "bun:test"
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import {
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "lib/geometry"
import type { FanoutDirection, Point2D, RoutedSegment } from "lib/types"
import { fanoutDataset04 } from "../datasets/dataset04"

interface NamedSegment extends RoutedSegment {
  connectionName: string
}

function pointIsOutsideBoundary(
  point: Point2D,
  direction: FanoutDirection,
  boundary: (typeof fanoutDataset04)[number]["sharedBoundary"],
): boolean {
  switch (direction) {
    case "left":
      return point.x < boundary.minX
    case "right":
      return point.x > boundary.maxX
    case "up":
      return point.y > boundary.maxY
    case "down":
      return point.y < boundary.minY
  }
}

test("autorouter proves and fanout solves a BGA surrounded by eight 0603s on one JLCPCB-rule layer", () => {
  expect(fanoutDataset04).toHaveLength(1)
  const sample = fanoutDataset04[0]!
  const srj = sample.simpleRouteJson

  expect(sample.footprintCount).toBe(9)
  expect(sample.footprinterStrings).toEqual([
    "bga16_grid4x4_p0.8mm_pad0.3mm_circularpads",
    "res0603",
    "cap0603",
    "res0603",
    "cap0603",
    "res0603",
    "cap0603",
    "res0603",
    "cap0603",
  ])
  expect(srj.layerCount).toBe(1)
  expect(srj.minTraceWidth).toBe(0.1)
  expect(srj.minTraceToPadEdgeClearance).toBe(0.1)
  expect(srj.connections).toHaveLength(32)
  expect(srj.obstacles).toHaveLength(32)
  expect(srj.buses).toHaveLength(24)
  expect(
    new Set(srj.obstacles.map((obstacle) => obstacle.componentId)).size,
  ).toBe(9)
  expect(
    srj.obstacles.filter(
      (obstacle) =>
        obstacle.componentId === "bga16" &&
        "shape" in obstacle &&
        obstacle.shape === "circle",
    ),
  ).toHaveLength(16)

  const targetKeys = srj.connections.map((connection) => {
    const target = connection.pointsToConnect.at(-1)!
    const targetLayers =
      "layer" in target ? target.layer : target.layers.join(",")
    return `${target.x.toFixed(6)}:${target.y.toFixed(6)}:${targetLayers}`
  })
  expect(new Set(targetKeys).size).toBe(32)

  const oracle = new AutoroutingPipelineSolver(srj)
  oracle.solve()
  expect(oracle.failed).toBe(false)
  const oracleTraces = oracle.getOutputSimpleRouteJson().traces ?? []
  expect(oracleTraces).toHaveLength(32)
  expect(new Set(oracleTraces.map((trace) => trace.connection_name)).size).toBe(
    32,
  )
  expect(
    oracleTraces.every((trace) =>
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" && routePoint.layer === "top",
      ),
    ),
  ).toBe(true)

  const solver = new FanoutSolver(srj, sample.solverOptions)
  expect(new Set(solver.preparedBuses.map((bus) => bus.componentId)).size).toBe(
    9,
  )
  expect(
    new Set(
      solver.preparedBuses
        .filter((bus) => bus.componentId === "bga16")
        .map((bus) => bus.direction),
    ),
  ).toEqual(new Set(["left", "right", "up", "down"]))

  solver.solve()
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.attempts).toHaveLength(1)
  expect(output.fanoutTraces).toHaveLength(32)
  expect(new Set(Object.values(output.busLayerAssignments))).toEqual(
    new Set(["top"]),
  )
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" && routePoint.layer === "top",
      ),
    ),
  ).toBe(true)

  for (const bus of solver.preparedBuses) {
    for (const connection of bus.connections) {
      const trace = output.fanoutTraces.find(
        (candidate) => candidate.connection_name === connection.connection.name,
      )!
      const finalPoint = trace.route.at(-1)!
      if (finalPoint.route_type !== "wire") {
        throw new Error(`${trace.connection_name} does not end in a wire`)
      }
      expect(
        pointIsOutsideBoundary(
          finalPoint,
          bus.direction,
          sample.sharedBoundary,
        ),
      ).toBe(true)
    }
  }

  const innerBgaConnectionNames = srj.obstacles
    .filter(
      (obstacle) =>
        obstacle.componentId === "bga16" &&
        Math.abs(obstacle.center.x) < 0.5 &&
        Math.abs(obstacle.center.y) < 0.5,
    )
    .flatMap((obstacle) =>
      obstacle.connectedTo.filter((connectionName) =>
        connectionName.startsWith("BUS_"),
      ),
    )
  expect(innerBgaConnectionNames).toHaveLength(4)
  expect(
    innerBgaConnectionNames.every((connectionName) =>
      output.fanoutTraces.some(
        (trace) => trace.connection_name === connectionName,
      ),
    ),
  ).toBe(true)

  const segments: NamedSegment[] = []
  let cornerCount = 0
  for (const trace of output.fanoutTraces) {
    const wirePoints = trace.route.filter(
      (routePoint) => routePoint.route_type === "wire",
    )
    for (let index = 1; index < wirePoints.length; index++) {
      const start = wirePoints[index - 1]!
      const end = wirePoints[index]!
      if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) continue
      segments.push({
        connectionName: trace.connection_name,
        start,
        end,
        width: end.width,
        layer: end.layer,
      })
    }
    for (let index = 2; index < wirePoints.length; index++) {
      const start = wirePoints[index - 2]!
      const corner = wirePoints[index - 1]!
      const end = wirePoints[index]!
      const incoming = {
        x: corner.x - start.x,
        y: corner.y - start.y,
      }
      const outgoing = {
        x: end.x - corner.x,
        y: end.y - corner.y,
      }
      const incomingLength = Math.hypot(incoming.x, incoming.y)
      const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
      if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue
      cornerCount++
      const normalizedDot =
        (incoming.x * outgoing.x + incoming.y * outgoing.y) /
        (incomingLength * outgoingLength)
      expect(Math.abs(normalizedDot)).toBeGreaterThan(1e-6)
    }
  }
  expect(cornerCount).toBeGreaterThan(20)

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    const first = segments[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < segments.length;
      secondIndex++
    ) {
      const second = segments[secondIndex]!
      if (first.connectionName === second.connectionName) continue
      const edgeClearance =
        distanceSegmentToSegment(
          first.start,
          first.end,
          second.start,
          second.end,
        ) -
        (first.width + second.width) / 2
      if (edgeClearance < 0.1 - 1e-6) {
        throw new Error(
          `${first.connectionName} ${JSON.stringify(first)} and ${second.connectionName} ${JSON.stringify(second)} have ${edgeClearance} mm copper clearance`,
        )
      }
    }
  }

  for (const segment of segments) {
    for (const obstacle of srj.obstacles) {
      if (obstacle.connectedTo.includes(segment.connectionName)) continue
      const edgeClearance =
        distanceSegmentToObstacle(segment, obstacle) - segment.width / 2
      if (edgeClearance < 0.1 - 1e-6) {
        throw new Error(
          `${segment.connectionName} has ${edgeClearance} mm clearance from ${obstacle.obstacleId}`,
        )
      }
    }
  }
}, 30_000)
