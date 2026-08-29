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
import capturedFixture from "./fixtures/am62l-lpddr4-six-bus-through-all-dram.json"
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
    connectionNames: [
      "breakout:pcb_breakout_point_56",
      "breakout:pcb_breakout_point_35",
      "breakout:pcb_breakout_point_58",
      "breakout:pcb_breakout_point_57",
      "breakout:pcb_breakout_point_36",
      "breakout:pcb_breakout_point_37",
      "breakout:pcb_breakout_point_38",
      "breakout:pcb_breakout_point_59",
    ],
    maxLengthSkew: 8,
    allowedLayers: ["top", "inner4"],
    assignedLayer: "inner4",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_BYTE1",
    connectionNames: [
      "breakout:pcb_breakout_point_44",
      "breakout:pcb_breakout_point_31",
      "breakout:pcb_breakout_point_41",
      "breakout:pcb_breakout_point_42",
      "breakout:pcb_breakout_point_43",
      "breakout:pcb_breakout_point_34",
      "breakout:pcb_breakout_point_32",
      "breakout:pcb_breakout_point_33",
    ],
    maxLengthSkew: 14.5,
    allowedLayers: ["inner5", "bottom"],
    assignedLayer: "bottom",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_ADDR_CTRL",
    connectionNames: [
      "breakout:pcb_breakout_point_53",
      "breakout:pcb_breakout_point_47",
      "breakout:pcb_breakout_point_52",
      "breakout:pcb_breakout_point_50",
      "breakout:pcb_breakout_point_49",
      "breakout:pcb_breakout_point_48",
      "breakout:pcb_breakout_point_54",
      "breakout:pcb_breakout_point_51",
    ],
    maxLengthSkew: 15,
    allowedLayers: ["inner6"],
    assignedLayer: "inner6",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_CLOCK",
    connectionNames: [
      "breakout:pcb_breakout_point_39",
      "breakout:pcb_breakout_point_40",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    assignedLayer: "inner5",
    exitPosition: "leftside_top",
  },
  {
    busId: "DDR_DQS0",
    connectionNames: [
      "breakout:pcb_breakout_point_46",
      "breakout:pcb_breakout_point_45",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    assignedLayer: "inner5",
    exitPosition: "leftside_top",
  },
  {
    busId: "DDR_DQS1",
    connectionNames: [
      "breakout:pcb_breakout_point_60",
      "breakout:pcb_breakout_point_61",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    assignedLayer: "inner5",
    exitPosition: "leftside_center",
  },
  {
    busId: "DDR_RESET",
    connectionNames: ["breakout:pcb_breakout_point_55"],
    maxLengthSkew: undefined,
    allowedLayers: ["inner6"],
    assignedLayer: "inner6",
    exitPosition: "leftside_top",
  },
] as const satisfies readonly {
  busId: string
  connectionNames: readonly string[]
  maxLengthSkew?: number
  allowedLayers: readonly string[]
  assignedLayer: string
  exitPosition: FanoutExitPosition
}[]

const expectedDifferentialPairs = [
  {
    connectionNames: [
      "breakout:pcb_breakout_point_39",
      "breakout:pcb_breakout_point_40",
    ],
    lengthTolerance: 0.25,
  },
  {
    connectionNames: [
      "breakout:pcb_breakout_point_46",
      "breakout:pcb_breakout_point_45",
    ],
    lengthTolerance: 0.25,
  },
  {
    connectionNames: [
      "breakout:pcb_breakout_point_60",
      "breakout:pcb_breakout_point_61",
    ],
    lengthTolerance: 0.25,
  },
] satisfies NonNullable<SimpleRouteJson["differentialPairs"]>

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

test("routes the AM62L seven-bus DRAM fanout with DQS1", async () => {
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
  expect(inputSrj.connections).toHaveLength(141)
  expect(inputSrj.connections.map((connection) => connection.name)).toEqual([
    ...Array.from({ length: 110 }, (_, index) => `source_trace_${index + 102}`),
    ...Array.from(
      { length: 31 },
      (_, index) => `breakout:pcb_breakout_point_${index + 31}`,
    ),
  ])
  expect(inputSrj.obstacles).toHaveLength(201)
  expect(inputSrj.traces).toHaveLength(133)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(options.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)
  expect(options).toMatchObject({
    borderDistribution: "even",
    compactBusTracks: true,
    sharedBoundary: inputSrj.bounds,
  })

  const obstaclesWithMetadata = inputSrj.obstacles.filter(
    (obstacle) => "circuitJsonMetadata" in obstacle,
  ) as Array<
    (typeof inputSrj.obstacles)[number] & {
      shape?: string
      circuitJsonMetadata: {
        pcb_smtpad_id?: string
        pcb_port_id?: string
        source_port_name?: string
      }
    }
  >
  expect(obstaclesWithMetadata).toHaveLength(200)
  expect(
    obstaclesWithMetadata.every(
      (obstacle) =>
        obstacle.componentId === "pcb_component_1" &&
        obstacle.shape === "circle" &&
        obstacle.circuitJsonMetadata.pcb_smtpad_id &&
        obstacle.circuitJsonMetadata.pcb_port_id &&
        obstacle.circuitJsonMetadata.source_port_name &&
        obstacle.connectedTo.length > 0,
    ),
  ).toBe(true)
  expect(
    new Set(
      obstaclesWithMetadata.map(
        (obstacle) => obstacle.circuitJsonMetadata.pcb_smtpad_id,
      ),
    ).size,
  ).toBe(200)
  expect(
    new Set(
      obstaclesWithMetadata.map(
        (obstacle) => obstacle.circuitJsonMetadata.pcb_port_id,
      ),
    ).size,
  ).toBe(200)
  expect(
    inputSrj.obstacles.find(
      (obstacle) =>
        "isFanoutSourceKeepout" in obstacle &&
        obstacle.isFanoutSourceKeepout === true,
    ),
  ).toMatchObject({
    obstacleId: "fanout-source-keepout:pcb_component_0",
    componentId: "pcb_component_0",
    connectedTo: [],
  })
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 0),
  ).toHaveLength(1)
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 1),
  ).toHaveLength(59)
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 4),
  ).toHaveLength(141)

  expect(inputSrj.differentialPairs).toHaveLength(3)
  expect(inputSrj.differentialPairs).toEqual(expectedDifferentialPairs)

  const requestedBuses = options.buses
  if (!requestedBuses) throw new Error("Captured options must include buses")
  expect(requestedBuses).toHaveLength(117)
  const busById = new Map(requestedBuses.map((bus) => [bus.busId, bus]))
  expect(busById.size).toBe(requestedBuses.length)

  const signalConnectionNames = new Set<string>()
  expect(expectedSignalBuses.map((bus) => bus.connectionNames.length)).toEqual([
    8, 8, 8, 2, 2, 2, 1,
  ])
  for (const expectedBus of expectedSignalBuses) {
    const bus = busById.get(expectedBus.busId)
    expect(bus).toMatchObject({
      busId: expectedBus.busId,
      allowedLayers: [...expectedBus.allowedLayers],
      exitPosition: expectedBus.exitPosition,
    })
    expect(bus?.maxLengthSkew).toBe(expectedBus.maxLengthSkew)
    expect(bus?.connectionNames).toEqual([...expectedBus.connectionNames])
    for (const connectionName of bus?.connectionNames ?? []) {
      signalConnectionNames.add(connectionName)
    }
  }
  expect(signalConnectionNames.size).toBe(31)
  expect(busById.get("DDR_CLOCK")?.connectionNames).toEqual(
    expectedDifferentialPairs[0].connectionNames,
  )
  expect(busById.get("DDR_DQS0")?.connectionNames).toEqual(
    expectedDifferentialPairs[1].connectionNames,
  )
  expect(busById.get("DDR_DQS1")?.connectionNames).toEqual(
    expectedDifferentialPairs[2].connectionNames,
  )

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

  const planeConnectionNames = new Set(
    planeBuses.flatMap((bus) => bus.connectionNames),
  )
  expect(planeConnectionNames.size).toBe(110)
  expect(
    [...planeConnectionNames].filter((name) => signalConnectionNames.has(name)),
  ).toHaveLength(0)
  expect(new Set([...planeConnectionNames, ...signalConnectionNames])).toEqual(
    new Set(inputSrj.connections.map((connection) => connection.name)),
  )

  const connectionByName = new Map(
    inputSrj.connections.map((connection) => [connection.name, connection]),
  )
  expect(
    inputSrj.connections.filter(
      (connection) => connection.netConnectionName === "GND",
    ),
  ).toHaveLength(58)
  expect(
    inputSrj.connections.filter(
      (connection) => connection.netConnectionName === "VDD_LPDDR4",
    ),
  ).toHaveLength(44)
  expect(
    inputSrj.connections.filter(
      (connection) => connection.netConnectionName === "SOC_DVDD1V8",
    ),
  ).toHaveLength(8)
  for (const connectionName of signalConnectionNames) {
    expect(connectionByName.get(connectionName)?.netConnectionName).toBe(
      connectionName,
    )
  }
  for (const bus of planeBuses) {
    if (bus.termination?.type !== "plane") continue
    const connection = connectionByName.get(bus.connectionNames[0]!)
    const expectedNetName =
      bus.termination.layer === "inner1"
        ? "GND"
        : bus.termination.layer === "inner2"
          ? "VDD_LPDDR4"
          : "SOC_DVDD1V8"
    expect(connection?.netConnectionName).toBe(expectedNetName)
  }

  const sourceObstacleByPortId = new Map<
    string,
    (typeof obstaclesWithMetadata)[number]
  >()
  for (const obstacle of obstaclesWithMetadata) {
    const portId = obstacle.circuitJsonMetadata.pcb_port_id
    if (!portId) throw new Error("Captured pad obstacle is missing a port id")
    if (sourceObstacleByPortId.has(portId)) {
      throw new Error(`Duplicate captured pad obstacle for ${portId}`)
    }
    sourceObstacleByPortId.set(portId, obstacle)
  }
  expect(sourceObstacleByPortId.size).toBe(200)
  for (const connection of inputSrj.connections) {
    const sourcePoint = connection.pointsToConnect[0]
    const sourcePointId =
      sourcePoint && "pointId" in sourcePoint ? sourcePoint.pointId : undefined
    if (typeof sourcePointId !== "string") {
      throw new Error(`Missing source point identity for ${connection.name}`)
    }
    const sourceObstacle = sourceObstacleByPortId.get(sourcePointId)
    expect(sourceObstacle?.connectedTo).toEqual(
      expect.arrayContaining([
        connection.name,
        sourcePointId,
        `connectivity_net:${connection.netConnectionName}`,
      ]),
    )
  }

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
    checkedConnectionCount: 141,
    brokenOutConnectionCount: 141,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(141)
  expect(output.planeTerminations).toHaveLength(110)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(110)
  expect(output.simpleRouteJson.differentialPairs).toEqual(
    inputSrj.differentialPairs,
  )
  const sequentialTraces = output.simpleRouteJson.traces ?? []
  expect(sequentialTraces).toHaveLength(274)
  expect(
    new Set(sequentialTraces.map((trace) => trace.pcb_trace_id)).size,
  ).toBe(274)
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
  expect(traceByConnection.size).toBe(141)
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
  expect(viaCoordinates.size).toBe(141)

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
  expect(output.simpleRouteJson.connections).toHaveLength(31)

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
    for (const trace of traces) {
      expect(getOnlyVia(trace)).toMatchObject({
        from_layer: "top",
        to_layer: expectedBus.assignedLayer,
      })
    }

    const exitWires = traces.map(getLastWire)
    expect(new Set(exitWires.map((wire) => wire.y)).size).toBe(
      expectedBus.connectionNames.length,
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

  const clockExitYs = busById
    .get("DDR_CLOCK")!
    .connectionNames.map(
      (connectionName) => getLastWire(traceByConnection.get(connectionName)!).y,
    )
  const dqs0ExitYs = busById
    .get("DDR_DQS0")!
    .connectionNames.map(
      (connectionName) => getLastWire(traceByConnection.get(connectionName)!).y,
    )
  const dqs1Traces = busById
    .get("DDR_DQS1")!
    .connectionNames.map(
      (connectionName) => traceByConnection.get(connectionName)!,
    )
  const dqs1ExitYs = dqs1Traces.map((trace) => getLastWire(trace).y)
  const dqs1Lengths = dqs1Traces.map(getPlanarLength)
  expect(output.busLayerAssignments.DDR_DQS1).toBe("inner5")
  expect(
    Math.max(...dqs1Lengths) - Math.min(...dqs1Lengths),
  ).toBeLessThanOrEqual(0.25 + 1e-6)
  for (const trace of dqs1Traces) {
    expect(getLastWire(trace)).toMatchObject({
      x: options.sharedBoundary!.minX,
      layer: "inner5",
    })
  }
  expect(dqs1ExitYs[0]!).toBeLessThan(dqs1ExitYs[1]!)
  expect(Math.max(...dqs1ExitYs)).toBeLessThan(Math.min(...clockExitYs))
  expect(Math.max(...clockExitYs)).toBeLessThan(Math.min(...dqs0ExitYs))
  expect(Math.max(...dqs1ExitYs)).toBeLessThan(Math.min(...dqs0ExitYs))

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
    checkedTraceCount: 141,
    checkedViaCount: 141,
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
      { deduplicateTraceIds: true },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
