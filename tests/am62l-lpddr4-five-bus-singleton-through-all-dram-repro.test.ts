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
import capturedFixture from "./fixtures/am62l-lpddr4-five-bus-singleton-through-all-dram.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

type CapturedInput = SimpleRouteJson & {
  allowBlindAndBuriedVias?: boolean
  allowViaInPad?: boolean
}

const fixture = capturedFixture as unknown as readonly [
  CapturedInput,
  FanoutSolverOptions,
]

const expectedSignalBuses = [
  {
    busId: "DDR_BYTE0",
    connectionCount: 8,
    maxLengthSkew: 8,
    allowedLayers: ["top", "inner4"],
    assignedLayer: "inner4",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_BYTE1",
    connectionCount: 8,
    maxLengthSkew: 14.5,
    allowedLayers: ["inner5", "bottom"],
    assignedLayer: "bottom",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_ADDR_CTRL",
    connectionCount: 8,
    maxLengthSkew: 15,
    allowedLayers: ["inner6"],
    assignedLayer: "inner6",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_CLOCK",
    connectionCount: 2,
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    assignedLayer: "inner5",
    exitPosition: "leftside_top",
  },
  {
    busId: "DDR_RESET",
    connectionCount: 1,
    maxLengthSkew: undefined,
    allowedLayers: ["inner6"],
    assignedLayer: "inner6",
    exitPosition: "leftside_top",
  },
] as const satisfies readonly {
  busId: string
  connectionCount: number
  maxLengthSkew?: number
  allowedLayers: readonly string[]
  assignedLayer: string
  exitPosition: FanoutExitPosition
}[]

type WireRoutePoint = Extract<FanoutRoutePoint, { route_type: "wire" }>

const isVia = (point: FanoutRoutePoint): point is FanoutViaRoutePoint =>
  point.route_type === "via"

function getOnlyVia(trace: FanoutSimplifiedPcbTrace): FanoutViaRoutePoint {
  const vias = trace.route.filter(isVia)
  expect(vias).toHaveLength(1)
  const via = vias[0]
  if (!via) throw new Error(`Expected one via on ${trace.connection_name}`)
  return via
}

function getLastWire(trace: FanoutSimplifiedPcbTrace): WireRoutePoint {
  const wire = trace.route.findLast(
    (point): point is WireRoutePoint => point.route_type === "wire",
  )
  if (!wire) throw new Error(`Expected a wire on ${trace.connection_name}`)
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

test("routes the AM62L-to-LPDDR4 five-bus DRAM fanout with a deferred singleton dogbone", async () => {
  const [inputSrj, options] = fixture
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
  expect(inputSrj.connections).toHaveLength(137)
  expect(inputSrj.obstacles).toHaveLength(201)
  expect(inputSrj.traces).toHaveLength(129)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(options.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)

  expect(inputSrj.differentialPairs).toEqual([
    {
      connectionNames: [
        "breakout:pcb_breakout_point_35",
        "breakout:pcb_breakout_point_36",
      ],
      lengthTolerance: 0.25,
    },
  ])

  const requestedBuses = options.buses
  if (!requestedBuses) throw new Error("Captured options must include buses")
  expect(requestedBuses).toHaveLength(115)
  const busById = new Map(requestedBuses.map((bus) => [bus.busId, bus]))
  expect(busById.size).toBe(requestedBuses.length)

  const signalConnectionNames = new Set<string>()
  for (const expectedBus of expectedSignalBuses) {
    const bus = busById.get(expectedBus.busId)
    expect(bus).toMatchObject({
      busId: expectedBus.busId,
      allowedLayers: [...expectedBus.allowedLayers],
      exitPosition: expectedBus.exitPosition,
    })
    expect(bus?.maxLengthSkew).toBe(expectedBus.maxLengthSkew)
    expect(bus?.connectionNames).toHaveLength(expectedBus.connectionCount)
    for (const connectionName of bus?.connectionNames ?? []) {
      signalConnectionNames.add(connectionName)
    }
  }
  expect(signalConnectionNames.size).toBe(27)
  expect(busById.get("DDR_RESET")).toMatchObject({
    connectionNames: ["breakout:pcb_breakout_point_49"],
    allowedLayers: ["inner6"],
    exitPosition: "leftside_top",
  })
  expect(
    inputSrj.connections.find(
      (connection) => connection.name === "breakout:pcb_breakout_point_49",
    ),
  ).toMatchObject({
    source_trace_id: "source_trace_238",
    pointsToConnect: [
      { x: 12.541917000000002, y: 5.41916, layer: "top" },
      {
        x: -0.3679829999999986,
        y: 3.4692481481481487,
        layer: "inner6",
      },
    ],
  })

  const planeBuses = requestedBuses.filter(
    (bus) => bus.termination?.type === "plane",
  )
  expect(planeBuses).toHaveLength(110)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.termination?.type === "plane" && bus.termination.layer === "inner1",
    ),
  ).toHaveLength(58)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.termination?.type === "plane" && bus.termination.layer === "inner2",
    ),
  ).toHaveLength(44)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.termination?.type === "plane" && bus.termination.layer === "inner3",
    ),
  ).toHaveLength(8)
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
    checkedConnectionCount: 137,
    brokenOutConnectionCount: 137,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(137)
  expect(output.planeTerminations).toHaveLength(110)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(110)
  expect(output.simpleRouteJson.differentialPairs).toEqual(
    inputSrj.differentialPairs,
  )
  const sequentialTraces = output.simpleRouteJson.traces ?? []
  expect(sequentialTraces).toHaveLength(266)
  expect(
    new Set(sequentialTraces.map((trace) => trace.pcb_trace_id)).size,
  ).toBe(266)
  for (const trace of sequentialTraces) {
    const vias = trace.route.filter((point) => point.route_type === "via")
    expect(vias).toHaveLength(1)
    const via = vias[0]
    expect(via && "layers" in via ? via.layers : undefined).toEqual(
      physicalLayers,
    )
  }

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
  expect(traceByConnection.size).toBe(137)
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
    if (!source)
      throw new Error(`Missing source point for ${trace.connection_name}`)
    const sourcePadRadius =
      Math.max(source.obstacle.width, source.obstacle.height) / 2
    const viaRadius = (via.via_diameter ?? inputSrj.minViaPadDiameter ?? 0) / 2
    expect(
      Math.hypot(via.x - source.point.x, via.y - source.point.y),
    ).toBeGreaterThanOrEqual(
      sourcePadRadius + viaRadius + viaPadClearance - 1e-6,
    )
  }
  expect(viaCoordinates.size).toBe(137)

  const terminationByConnection = new Map(
    output.planeTerminations.map((termination) => [
      termination.connectionName,
      termination,
    ]),
  )
  expect(terminationByConnection.size).toBe(110)
  for (const bus of planeBuses) {
    if (bus.termination?.type !== "plane") continue
    const connectionName = bus.connectionNames[0]!
    const termination = terminationByConnection.get(connectionName)
    expect(termination).toMatchObject({
      busId: bus.busId,
      layer: bus.termination.layer,
    })
    expect(termination?.via.spanLayers).toEqual(physicalLayers)
    const traceVia = getOnlyVia(traceByConnection.get(connectionName)!)
    expect(termination?.via.center).toEqual({ x: traceVia.x, y: traceVia.y })
  }

  expect(
    new Set(
      output.simpleRouteJson.connections.map((connection) => connection.name),
    ),
  ).toEqual(signalConnectionNames)
  expect(output.simpleRouteJson.connections).toHaveLength(27)

  for (const expectedBus of expectedSignalBuses) {
    const bus = busById.get(expectedBus.busId)!
    const traces = bus.connectionNames.map((connectionName) => {
      const trace = traceByConnection.get(connectionName)
      if (!trace) throw new Error(`Missing trace for ${connectionName}`)
      return trace
    })
    const lengths = traces.map(getPlanarLength)
    if (expectedBus.maxLengthSkew !== undefined) {
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
        expectedBus.maxLengthSkew + 1e-6,
      )
    }
    expect(output.busLayerAssignments[expectedBus.busId]).toBe(
      expectedBus.assignedLayer,
    )

    const exitWires = traces.map(getLastWire)
    expect(new Set(exitWires.map((wire) => wire.y)).size).toBe(
      expectedBus.connectionCount,
    )
    for (const exitWire of exitWires) {
      expect(exitWire).toMatchObject({
        x: options.sharedBoundary!.minX,
        layer: expectedBus.assignedLayer,
      })
      expect(exitWire.y).toBeGreaterThanOrEqual(options.sharedBoundary!.minY)
      expect(exitWire.y).toBeLessThanOrEqual(options.sharedBoundary!.maxY)
    }
  }

  const clearance =
    options.clearance ??
    inputSrj.minViaEdgeToPadEdgeClearance ??
    inputSrj.minTraceToPadEdgeClearance ??
    inputSrj.defaultObstacleMargin ??
    inputSrj.minTraceWidth
  const currentPhaseSrj = {
    ...output.simpleRouteJson,
    traces: output.fanoutTraces,
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: currentPhaseSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 137,
    checkedViaCount: 137,
    issues: [],
  })

  await expect(
    getPcbSvgFromSrj(
      {
        ...inputSrj,
        obstacles: inputSrj.obstacles.filter(
          (obstacle) =>
            obstacle.obstacleId !== "fanout-source-keepout:pcb_component_0",
        ),
      },
      currentPhaseSrj,
      {
        deduplicateTraceIds: true,
      },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
