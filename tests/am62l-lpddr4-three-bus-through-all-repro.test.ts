import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerNames } from "lib/layer-names"
import type {
  FanoutExitPosition,
  FanoutRoutePoint,
  FanoutSimplifiedPcbTrace,
  FanoutSolverOptions,
  FanoutViaRoutePoint,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-lpddr4-three-bus-through-all.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

type CapturedInput = SimpleRouteJson & {
  allowBlindAndBuriedVias?: boolean
  allowViaInPad?: boolean
}

const fixture = capturedFixture as unknown as {
  inputSrj: CapturedInput
  options: FanoutSolverOptions
}

const expectedSignalBuses = [
  {
    busId: "DDR_BYTE0",
    maxLengthSkew: 8,
    allowedLayers: ["top", "inner4"],
    exitPosition: "rightside_top",
  },
  {
    busId: "DDR_BYTE1",
    maxLengthSkew: 14.5,
    allowedLayers: ["inner5", "bottom"],
    exitPosition: "rightside_bottom",
  },
  {
    busId: "DDR_ADDR_CTRL",
    maxLengthSkew: 15,
    allowedLayers: ["inner6"],
    exitPosition: "rightside_center",
  },
] as const satisfies readonly {
  busId: string
  maxLengthSkew: number
  allowedLayers: readonly string[]
  exitPosition: FanoutExitPosition
}[]

type WireRoutePoint = Extract<FanoutRoutePoint, { route_type: "wire" }>

const isVia = (point: FanoutRoutePoint): point is FanoutViaRoutePoint =>
  point.route_type === "via"

function getOnlyVia(trace: FanoutSimplifiedPcbTrace): FanoutViaRoutePoint {
  const vias = trace.route.filter(isVia)
  expect(vias).toHaveLength(1)
  const via = vias[0]
  if (!via) {
    throw new Error(`Expected one via on ${trace.connection_name}`)
  }
  return via
}

function getLastWire(trace: FanoutSimplifiedPcbTrace): WireRoutePoint {
  const wire = trace.route.findLast(
    (point): point is WireRoutePoint => point.route_type === "wire",
  )
  if (!wire) {
    throw new Error(`Expected a wire on ${trace.connection_name}`)
  }
  return wire
}

function getPlanarLength(trace: FanoutSimplifiedPcbTrace): number {
  let previousWire: WireRoutePoint | undefined
  let length = 0
  for (const point of trace.route) {
    if (point.route_type !== "wire") {
      previousWire = undefined
      continue
    }
    if (previousWire?.layer === point.layer) {
      length += Math.hypot(point.x - previousWire.x, point.y - previousWire.y)
    }
    previousWire = point
  }
  return length
}

test("routes the AM62L three-bus fanout around through-all plane dogbones", async () => {
  const { inputSrj, options } = fixture
  const physicalLayers = getCopperLayerNames(inputSrj.layerCount)
  expect(physicalLayers).toEqual([
    "top",
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ])
  expect(inputSrj.connections).toHaveLength(126)
  expect(inputSrj.obstacles).toHaveLength(373)
  expect(
    inputSrj.obstacles.every((obstacle) => obstacle.connectedTo.length > 0),
  ).toBe(true)
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 1),
  ).toHaveLength(247)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(options.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)

  const requestedBuses = options.buses
  if (!requestedBuses) throw new Error("Captured options must include buses")
  expect(requestedBuses).toHaveLength(105)
  const busById = new Map(requestedBuses.map((bus) => [bus.busId, bus]))
  expect(busById.size).toBe(requestedBuses.length)

  const signalConnectionNames = new Set<string>()
  for (const expectedBus of expectedSignalBuses) {
    const bus = busById.get(expectedBus.busId)
    expect(bus).toMatchObject({
      busId: expectedBus.busId,
      maxLengthSkew: expectedBus.maxLengthSkew,
      allowedLayers: [...expectedBus.allowedLayers],
      exitPosition: expectedBus.exitPosition,
    })
    expect(bus?.connectionNames).toHaveLength(8)
    for (const connectionName of bus?.connectionNames ?? []) {
      signalConnectionNames.add(connectionName)
    }
  }
  expect(signalConnectionNames.size).toBe(24)

  const planeBuses = requestedBuses.filter(
    (bus) => bus.termination?.type === "plane",
  )
  expect(planeBuses).toHaveLength(102)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.termination?.type === "plane" && bus.termination.layer === "inner1",
    ),
  ).toHaveLength(97)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.termination?.type === "plane" && bus.termination.layer === "inner2",
    ),
  ).toHaveLength(5)
  expect(planeBuses.every((bus) => bus.connectionNames.length === 1)).toBe(true)

  const solver = new FanoutSolver(
    structuredClone(inputSrj),
    structuredClone(options),
  )
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 126,
    brokenOutConnectionCount: 126,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(126)
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(102)

  const traceByConnection = new Map<string, FanoutSimplifiedPcbTrace>()
  for (const trace of output.fanoutTraces) {
    const connectionName = trace.connection_name
    if (!connectionName) {
      throw new Error(`Unnamed fanout trace ${trace.pcb_trace_id}`)
    }
    if (traceByConnection.has(connectionName)) {
      throw new Error(`Duplicate fanout trace for ${connectionName}`)
    }
    traceByConnection.set(connectionName, trace)
  }
  expect(traceByConnection.size).toBe(126)
  expect(new Set(traceByConnection.keys())).toEqual(
    new Set(inputSrj.connections.map((connection) => connection.name)),
  )

  const sourceByConnection = new Map(
    solver.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [
            connection.connection.name,
            {
              obstacle: connection.sourceObstacle,
              point: connection.sourcePoint,
            },
          ] as const,
      ),
    ),
  )
  const viaCoordinates = new Set<string>()
  const viaPadClearance = inputSrj.minViaEdgeToPadEdgeClearance ?? 0
  for (const trace of output.fanoutTraces) {
    const via = getOnlyVia(trace)
    expect(via.layers).toEqual(physicalLayers)
    viaCoordinates.add(`${via.x},${via.y}`)

    const source = sourceByConnection.get(trace.connection_name ?? "")
    if (!source) {
      throw new Error(`Missing source point for ${trace.connection_name}`)
    }
    const sourcePadRadius =
      Math.max(source.obstacle.width, source.obstacle.height) / 2
    const viaRadius = (via.via_diameter ?? inputSrj.minViaPadDiameter ?? 0) / 2
    expect(
      Math.hypot(via.x - source.point.x, via.y - source.point.y),
    ).toBeGreaterThanOrEqual(
      sourcePadRadius + viaRadius + viaPadClearance - 1e-6,
    )
  }
  expect(viaCoordinates.size).toBe(126)

  const expectedPlaneByConnection = new Map<
    string,
    { busId: string; layer: string }
  >()
  for (const bus of planeBuses) {
    if (bus.termination?.type !== "plane") continue
    expectedPlaneByConnection.set(bus.connectionNames[0]!, {
      busId: bus.busId,
      layer: bus.termination.layer,
    })
  }
  const terminationByConnection = new Map(
    output.planeTerminations.map((termination) => [
      termination.connectionName,
      termination,
    ]),
  )
  expect(terminationByConnection.size).toBe(102)
  for (const [
    connectionName,
    expectedTermination,
  ] of expectedPlaneByConnection) {
    const termination = terminationByConnection.get(connectionName)
    expect(termination).toMatchObject(expectedTermination)
    expect(termination?.via.spanLayers).toEqual(physicalLayers)
    const traceVia = getOnlyVia(traceByConnection.get(connectionName)!)
    expect(termination?.via.center).toEqual({ x: traceVia.x, y: traceVia.y })
  }

  expect(
    new Set(
      output.simpleRouteJson.connections.map((connection) => connection.name),
    ),
  ).toEqual(signalConnectionNames)
  expect(output.simpleRouteJson.connections).toHaveLength(24)

  const exitYRangeByBus = new Map<string, { min: number; max: number }>()
  for (const expectedBus of expectedSignalBuses) {
    const bus = busById.get(expectedBus.busId)!
    const traces = bus.connectionNames.map((connectionName) => {
      const trace = traceByConnection.get(connectionName)
      if (!trace) throw new Error(`Missing trace for ${connectionName}`)
      return trace
    })
    const lengths = traces.map(getPlanarLength)
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
      expectedBus.maxLengthSkew + 1e-6,
    )
    expect(
      new Set<string>(expectedBus.allowedLayers).has(
        output.busLayerAssignments[expectedBus.busId]!,
      ),
    ).toBe(true)
    const exitWires = traces.map(getLastWire)
    for (const exitWire of exitWires) {
      expect(exitWire.x).toBeCloseTo(options.sharedBoundary!.maxX, 9)
    }
    const exitYs = exitWires.map((wire) => wire.y)
    exitYRangeByBus.set(expectedBus.busId, {
      min: Math.min(...exitYs),
      max: Math.max(...exitYs),
    })
  }
  expect(exitYRangeByBus.get("DDR_BYTE1")!.max).toBeLessThan(
    exitYRangeByBus.get("DDR_ADDR_CTRL")!.min,
  )
  expect(exitYRangeByBus.get("DDR_ADDR_CTRL")!.max).toBeLessThan(
    exitYRangeByBus.get("DDR_BYTE0")!.min,
  )

  const clearance =
    options.clearance ??
    inputSrj.minViaEdgeToPadEdgeClearance ??
    inputSrj.minTraceToPadEdgeClearance ??
    inputSrj.defaultObstacleMargin ??
    inputSrj.minTraceWidth
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 126,
    checkedViaCount: 126,
    issues: [],
  })

  await expect(
    getPcbSvgFromSrj(inputSrj, output.simpleRouteJson, {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
