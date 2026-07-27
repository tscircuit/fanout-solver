import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "lib/geometry"
import { getCopperLayerNames } from "lib/layer-names"
import type { FanoutDirection, Point2D, RoutedSegment } from "lib/types"
import {
  BGA16,
  BGA25,
  BGA36,
  BGA64,
  fanoutDataset04,
  RP2040_CLASS_QFN,
} from "../datasets/dataset04"

interface NamedSegment extends RoutedSegment {
  connectionName: string
}

interface NamedVia {
  connectionName: string
  center: Point2D
  diameter: number
  holeDiameter: number
  spanLayers: Set<string>
}

const expectedSamples = [
  {
    id: "sample001",
    centralComponentId: "bga16",
    centralFootprinterString: BGA16,
    centralPadCount: 16,
    centralRoutedPadCount: 16,
    centralBusCount: 8,
    innerPadCount: 4,
    layerCount: 1,
  },
  {
    id: "sample002",
    centralComponentId: "bga25",
    centralFootprinterString: BGA25,
    centralPadCount: 25,
    centralRoutedPadCount: 25,
    centralBusCount: 9,
    innerPadCount: 9,
    layerCount: 1,
  },
  {
    id: "sample003",
    centralComponentId: "bga36",
    centralFootprinterString: BGA36,
    centralPadCount: 36,
    centralRoutedPadCount: 36,
    centralBusCount: 12,
    innerPadCount: 16,
    layerCount: 1,
  },
  {
    id: "sample004",
    centralComponentId: "bga64",
    centralFootprinterString: BGA64,
    centralPadCount: 64,
    centralRoutedPadCount: 64,
    centralBusCount: 16,
    innerPadCount: 36,
    layerCount: 1,
  },
  {
    id: "sample005",
    centralComponentId: "rp2040-qfn56",
    centralFootprinterString: RP2040_CLASS_QFN,
    centralPadCount: 57,
    centralRoutedPadCount: 56,
    centralBusCount: 56,
    innerPadCount: 0,
    layerCount: 1,
  },
] as const

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

function getViaSpanLayers(params: {
  fromLayer: string
  toLayer: string
  layerNames: string[]
}): Set<string> {
  const { fromLayer, toLayer, layerNames } = params
  const fromIndex = layerNames.indexOf(fromLayer)
  const toIndex = layerNames.indexOf(toLayer)
  if (fromIndex < 0 || toIndex < 0) {
    throw new Error(`Unknown via span ${fromLayer} -> ${toLayer}`)
  }
  return new Set(
    layerNames.slice(
      Math.min(fromIndex, toIndex),
      Math.max(fromIndex, toIndex) + 1,
    ),
  )
}

test("dataset04 breaks out larger BGAs and an RP2040-class thermal QFN, each surrounded by eight capacitors", () => {
  expect(fanoutDataset04).toHaveLength(expectedSamples.length)

  for (const expected of expectedSamples) {
    const sample = fanoutDataset04.find(
      (candidate) => candidate.id === expected.id,
    )!
    const srj = sample.simpleRouteJson
    const expectedConnectionCount = expected.centralRoutedPadCount + 16
    const expectedBusCount = expected.centralBusCount + 16

    expect(sample.footprintCount).toBe(9)
    expect(sample.footprinterStrings).toEqual([
      expected.centralFootprinterString,
      ...Array.from({ length: 8 }, () => "cap0603"),
    ])
    expect(srj.layerCount).toBe(expected.layerCount)
    expect(srj.minTraceWidth).toBe(0.1)
    expect(srj.minTraceToPadEdgeClearance).toBe(0.1)
    expect(srj.connections).toHaveLength(expectedConnectionCount)
    expect(srj.obstacles).toHaveLength(expected.centralPadCount + 16)
    expect(srj.buses).toHaveLength(expectedBusCount)

    const componentIds = new Set(
      srj.obstacles.map((obstacle) => obstacle.componentId),
    )
    expect(componentIds.size).toBe(9)
    expect(
      [...componentIds].filter((componentId) =>
        componentId?.startsWith("capacitor-"),
      ),
    ).toHaveLength(8)
    expect(
      srj.obstacles.filter(
        (obstacle) => obstacle.componentId === expected.centralComponentId,
      ),
    ).toHaveLength(expected.centralPadCount)

    const targetKeys = srj.connections.map((connection) => {
      const target = connection.pointsToConnect.at(-1)!
      const targetLayers =
        "layer" in target ? target.layer : target.layers.join(",")
      return `${target.x.toFixed(6)}:${target.y.toFixed(6)}:${targetLayers}`
    })
    expect(new Set(targetKeys).size).toBe(expectedConnectionCount)

    const solver = new FanoutSolver(srj, sample.solverOptions)
    expect(
      new Set(solver.preparedBuses.map((bus) => bus.componentId)).size,
    ).toBe(9)
    expect(
      new Set(
        solver.preparedBuses
          .filter((bus) => bus.componentId === expected.centralComponentId)
          .map((bus) => bus.direction),
      ),
    ).toEqual(new Set(["left", "right", "up", "down"]))

    solver.solve()
    expect(solver.failed).toBe(false)
    const output = solver.getOutput()
    expect(output.attempts).toHaveLength(1)
    expect(output.fanoutTraces).toHaveLength(expectedConnectionCount)
    expect(new Set(Object.values(output.busLayerAssignments)).size).toBe(
      expected.layerCount,
    )
    expect(
      output.fanoutTraces.every((trace) =>
        trace.route.every(
          (routePoint) =>
            routePoint.route_type === "wire" && routePoint.layer === "top",
        ),
      ),
    ).toBe(true)
    expect(
      output.fanoutTraces.filter((trace) => trace.route.length >= 4).length,
    ).toBeGreaterThan(0)

    const layerNames = getCopperLayerNames(srj.layerCount)
    const segments: NamedSegment[] = []
    const vias: NamedVia[] = []
    let cornerCount = 0

    for (const bus of solver.preparedBuses) {
      const busViaUse: boolean[] = []
      for (const connection of bus.connections) {
        const trace = output.fanoutTraces.find(
          (candidate) =>
            candidate.connection_name === connection.connection.name,
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
        busViaUse.push(
          trace.route.some((routePoint) => routePoint.route_type === "via"),
        )
      }
      expect(new Set(busViaUse).size).toBe(1)
    }

    for (const trace of output.fanoutTraces) {
      let wireRun: Array<{
        x: number
        y: number
        width: number
        layer: string
      }> = []
      for (const routePoint of trace.route) {
        if (routePoint.route_type === "via") {
          vias.push({
            connectionName: trace.connection_name,
            center: { x: routePoint.x, y: routePoint.y },
            diameter: routePoint.via_diameter!,
            holeDiameter: routePoint.via_hole_diameter!,
            spanLayers: getViaSpanLayers({
              fromLayer: routePoint.from_layer,
              toLayer: routePoint.to_layer,
              layerNames,
            }),
          })
          wireRun = []
          continue
        }
        if (routePoint.route_type !== "wire") {
          wireRun = []
          continue
        }
        if (wireRun.at(-1)?.layer !== routePoint.layer) {
          wireRun = []
        }
        wireRun.push(routePoint)
        if (wireRun.length >= 2) {
          const start = wireRun.at(-2)!
          const end = wireRun.at(-1)!
          if (Math.hypot(end.x - start.x, end.y - start.y) > 1e-9) {
            segments.push({
              connectionName: trace.connection_name,
              start,
              end,
              width: end.width,
              layer: end.layer,
            })
          }
        }
        if (wireRun.length < 3) continue
        const start = wireRun.at(-3)!
        const corner = wireRun.at(-2)!
        const end = wireRun.at(-1)!
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
    expect(cornerCount).toBeGreaterThan(0)
    expect(vias).toHaveLength(0)

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
            `${sample.id}: ${first.connectionName} and ${second.connectionName} have ${edgeClearance} mm copper clearance`,
          )
        }
      }
    }

    for (const segment of segments) {
      if (segment.layer !== "top") continue
      for (const obstacle of srj.obstacles) {
        if (obstacle.connectedTo.includes(segment.connectionName)) continue
        const edgeClearance =
          distanceSegmentToObstacle(segment, obstacle) - segment.width / 2
        if (edgeClearance < 0.1 - 1e-6) {
          throw new Error(
            `${sample.id}: ${segment.connectionName} has ${edgeClearance} mm clearance from ${obstacle.obstacleId}`,
          )
        }
      }
    }

    for (const via of vias) {
      expect(via.diameter).toBe(0.25)
      expect(via.holeDiameter).toBe(0.15)
      for (const obstacle of srj.obstacles) {
        expect(
          distancePointToObstacle(via.center, obstacle) - via.diameter / 2,
        ).toBeGreaterThanOrEqual(0.1 - 1e-6)
      }
      for (const segment of segments) {
        if (
          segment.connectionName === via.connectionName ||
          !via.spanLayers.has(segment.layer)
        ) {
          continue
        }
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

    const centralObstacles = srj.obstacles.filter(
      (obstacle) => obstacle.componentId === expected.centralComponentId,
    )
    if (expected.innerPadCount > 0) {
      const maximumX = Math.max(
        ...centralObstacles.map((obstacle) => Math.abs(obstacle.center.x)),
      )
      const maximumY = Math.max(
        ...centralObstacles.map((obstacle) => Math.abs(obstacle.center.y)),
      )
      const innerConnectionNames = centralObstacles
        .filter(
          (obstacle) =>
            Math.abs(obstacle.center.x) < maximumX - 1e-6 &&
            Math.abs(obstacle.center.y) < maximumY - 1e-6,
        )
        .flatMap((obstacle) =>
          obstacle.connectedTo.filter((connectionName) =>
            connectionName.startsWith("BUS_"),
          ),
        )
      expect(innerConnectionNames).toHaveLength(expected.innerPadCount)
      expect(
        innerConnectionNames.every((connectionName) =>
          output.fanoutTraces.some(
            (trace) => trace.connection_name === connectionName,
          ),
        ),
      ).toBe(true)
    }

    if (sample.id === "sample005") {
      const thermalPad = centralObstacles.find(
        (obstacle) =>
          Math.abs(obstacle.center.x) < 1e-9 &&
          Math.abs(obstacle.center.y) < 1e-9 &&
          Math.abs(obstacle.width - 3.2) < 1e-9 &&
          Math.abs(obstacle.height - 3.2) < 1e-9,
      )
      expect(thermalPad).toBeDefined()
      const thermalConnectionName = thermalPad!.connectedTo.find(
        (connectionName) => connectionName.startsWith("BUS_"),
      )
      expect(thermalConnectionName).toBeUndefined()
      expect(
        output.fanoutTraces.some((trace) =>
          trace.connectsTo?.includes(thermalPad!.obstacleId!),
        ),
      ).toBe(false)
    }
  }
}, 30_000)
