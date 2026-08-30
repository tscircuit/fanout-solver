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
import capturedFixture from "./fixtures/am62l-lpddr4-six-bus-through-all-soc.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

type CapturedInput = Omit<SimpleRouteJson, "connections"> & {
  connections: Array<
    SimpleRouteJson["connections"][number] & { source_trace_id?: string }
  >
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
      "breakout:pcb_breakout_point_29",
      "breakout:pcb_breakout_point_4",
      "breakout:pcb_breakout_point_31",
      "breakout:pcb_breakout_point_30",
      "breakout:pcb_breakout_point_5",
      "breakout:pcb_breakout_point_6",
      "breakout:pcb_breakout_point_7",
      "breakout:pcb_breakout_point_32",
    ],
    maxLengthSkew: 8,
    allowedLayers: ["top", "inner4"],
    exitPosition: "rightside_top",
  },
  {
    busId: "DDR_BYTE1",
    connectionNames: [
      "breakout:pcb_breakout_point_13",
      "breakout:pcb_breakout_point_0",
      "breakout:pcb_breakout_point_10",
      "breakout:pcb_breakout_point_11",
      "breakout:pcb_breakout_point_12",
      "breakout:pcb_breakout_point_3",
      "breakout:pcb_breakout_point_1",
      "breakout:pcb_breakout_point_2",
    ],
    maxLengthSkew: 14.5,
    allowedLayers: ["inner5", "bottom"],
    exitPosition: "rightside_bottom",
  },
  {
    busId: "DDR_ADDR_CTRL",
    connectionNames: [
      "breakout:pcb_breakout_point_26",
      "breakout:pcb_breakout_point_20",
      "breakout:pcb_breakout_point_25",
      "breakout:pcb_breakout_point_23",
      "breakout:pcb_breakout_point_22",
      "breakout:pcb_breakout_point_21",
      "breakout:pcb_breakout_point_27",
      "breakout:pcb_breakout_point_24",
    ],
    maxLengthSkew: 15,
    allowedLayers: ["inner6"],
    exitPosition: "rightside_center",
  },
  {
    busId: "DDR_CLOCK",
    connectionNames: [
      "breakout:pcb_breakout_point_8",
      "breakout:pcb_breakout_point_9",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    exitPosition: "rightside_top",
  },
  {
    busId: "DDR_DQS0",
    connectionNames: [
      "breakout:pcb_breakout_point_19",
      "breakout:pcb_breakout_point_18",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    exitPosition: "rightside_top",
  },
  {
    busId: "DDR_DQS1",
    connectionNames: [
      "breakout:pcb_breakout_point_14",
      "breakout:pcb_breakout_point_15",
    ],
    maxLengthSkew: 0.25,
    allowedLayers: ["inner5"],
    exitPosition: "rightside_center",
  },
  {
    busId: "DDR_RESET",
    connectionNames: ["breakout:pcb_breakout_point_28"],
    maxLengthSkew: undefined,
    allowedLayers: ["inner6"],
    exitPosition: "rightside_center",
  },
  {
    busId: "DDR_DMI0",
    connectionNames: ["breakout:pcb_breakout_point_17"],
    maxLengthSkew: undefined,
    allowedLayers: ["inner5"],
    exitPosition: "rightside_top",
  },
  {
    busId: "DDR_DMI1",
    connectionNames: ["breakout:pcb_breakout_point_16"],
    maxLengthSkew: undefined,
    allowedLayers: ["inner5"],
    exitPosition: "rightside_bottom",
  },
] as const satisfies readonly {
  busId: string
  connectionNames: readonly string[]
  maxLengthSkew?: number
  allowedLayers: readonly string[]
  exitPosition: FanoutExitPosition
}[]

const expectedDifferentialPairs = [
  {
    connectionNames: [
      "breakout:pcb_breakout_point_8",
      "breakout:pcb_breakout_point_9",
    ],
    lengthTolerance: 0.25,
  },
  {
    connectionNames: [
      "breakout:pcb_breakout_point_19",
      "breakout:pcb_breakout_point_18",
    ],
    lengthTolerance: 0.25,
  },
  {
    connectionNames: [
      "breakout:pcb_breakout_point_14",
      "breakout:pcb_breakout_point_15",
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

test("routes the AM62L nine-bus SoC fanout with DMI1", async () => {
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
  expect(inputSrj.connections).toHaveLength(135)
  expect(inputSrj.connections.map((connection) => connection.name)).toEqual([
    ...Array.from({ length: 102 }, (_, index) => `source_trace_${index}`),
    ...Array.from(
      { length: 33 },
      (_, index) => `breakout:pcb_breakout_point_${index}`,
    ),
  ])
  expect(inputSrj.obstacles).toHaveLength(373)
  expect(inputSrj.traces).toHaveLength(0)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(options.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)
  expect(options).toMatchObject({
    borderDistribution: "even",
    compactBusTracks: true,
    sharedBoundary: inputSrj.bounds,
  })

  const obstaclesWithMetadata = inputSrj.obstacles as Array<
    (typeof inputSrj.obstacles)[number] & {
      shape?: string
      circuitJsonMetadata?: {
        pcb_smtpad_id?: string
        pcb_port_id?: string
        source_port_name?: string
      }
    }
  >
  expect(
    obstaclesWithMetadata.every(
      (obstacle) =>
        obstacle.componentId === "pcb_component_0" &&
        obstacle.shape === "circle" &&
        obstacle.circuitJsonMetadata?.pcb_smtpad_id &&
        obstacle.circuitJsonMetadata.pcb_port_id &&
        obstacle.circuitJsonMetadata.source_port_name &&
        obstacle.connectedTo.length > 0,
    ),
  ).toBe(true)
  expect(
    new Set(
      obstaclesWithMetadata.map(
        (obstacle) => obstacle.circuitJsonMetadata!.pcb_smtpad_id,
      ),
    ).size,
  ).toBe(373)
  expect(
    inputSrj.obstacles.filter(
      (obstacle) => obstacle.componentId === "pcb_component_0",
    ),
  ).toHaveLength(373)
  expect(
    inputSrj.obstacles.filter(
      (obstacle) => obstacle.componentId === "pcb_component_1",
    ),
  ).toHaveLength(0)
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 1),
  ).toHaveLength(238)
  expect(
    inputSrj.obstacles.filter((obstacle) => obstacle.connectedTo.length === 4),
  ).toHaveLength(135)

  expect(inputSrj.differentialPairs).toHaveLength(3)
  expect(inputSrj.differentialPairs).toEqual(expectedDifferentialPairs)

  const requestedBuses = options.buses
  if (!requestedBuses) throw new Error("Captured options must include buses")
  expect(requestedBuses).toHaveLength(111)
  const busById = new Map(requestedBuses.map((bus) => [bus.busId, bus]))
  expect(busById.size).toBe(requestedBuses.length)

  const signalConnectionNames = new Set<string>()
  expect(expectedSignalBuses.map((bus) => bus.connectionNames.length)).toEqual([
    8, 8, 8, 2, 2, 2, 1, 1, 1,
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
  expect(signalConnectionNames.size).toBe(33)
  expect(busById.get("DDR_CLOCK")?.connectionNames).toEqual(
    expectedDifferentialPairs[0].connectionNames,
  )
  expect(busById.get("DDR_DQS0")?.connectionNames).toEqual(
    expectedDifferentialPairs[1].connectionNames,
  )
  expect(busById.get("DDR_DQS1")?.connectionNames).toEqual(
    expectedDifferentialPairs[2].connectionNames,
  )
  expect(busById.get("DDR_DMI0")?.connectionNames).toEqual([
    "breakout:pcb_breakout_point_17",
  ])
  const dmi0Connection = inputSrj.connections.find(
    (connection) => connection.name === "breakout:pcb_breakout_point_17",
  )
  expect(dmi0Connection?.source_trace_id).toBe("source_trace_243")
  expect(dmi0Connection?.pointsToConnect[0]).toMatchObject({
    pointId: "pcb_port_117",
    pcb_port_id: "pcb_port_117",
  })
  expect(busById.get("DDR_DMI1")?.connectionNames).toEqual([
    "breakout:pcb_breakout_point_16",
  ])
  const dmi1Connection = inputSrj.connections.find(
    (connection) => connection.name === "breakout:pcb_breakout_point_16",
  )
  expect(dmi1Connection?.source_trace_id).toBe("source_trace_244")
  expect(dmi1Connection?.pointsToConnect[0]).toMatchObject({
    x: -14.5,
    y: -3.5,
    layer: "top",
    pointId: "pcb_port_118",
    pcb_port_id: "pcb_port_118",
  })
  expect(dmi1Connection?.pointsToConnect[1]).toMatchObject({
    layer: "inner5",
    pointId: "pcb_breakout_point_16",
  })

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

  const planeConnectionNames = new Set(
    planeBuses.flatMap((bus) => bus.connectionNames),
  )
  expect(planeConnectionNames.size).toBe(102)
  expect(
    [...planeConnectionNames].filter((name) => signalConnectionNames.has(name)),
  ).toHaveLength(0)
  expect(new Set([...planeConnectionNames, ...signalConnectionNames])).toEqual(
    new Set(inputSrj.connections.map((connection) => connection.name)),
  )

  const expectedConnectivityNetByConnectionName = new Map(
    [...signalConnectionNames].map((connectionName) => [
      connectionName,
      connectionName,
    ]),
  )
  for (const bus of planeBuses) {
    if (bus.termination?.type !== "plane") continue
    expectedConnectivityNetByConnectionName.set(
      bus.connectionNames[0]!,
      bus.termination.layer === "inner1" ? "GND" : "VDD_LPDDR4",
    )
  }
  expect(
    [...expectedConnectivityNetByConnectionName.values()].filter(
      (netName) => netName === "GND",
    ),
  ).toHaveLength(97)
  expect(
    [...expectedConnectivityNetByConnectionName.values()].filter(
      (netName) => netName === "VDD_LPDDR4",
    ),
  ).toHaveLength(5)
  const connectionByName = new Map(
    inputSrj.connections.map((connection) => [connection.name, connection]),
  )
  expect(connectionByName.size).toBe(inputSrj.connections.length)
  for (const [
    connectionName,
    expectedNetName,
  ] of expectedConnectivityNetByConnectionName) {
    expect(connectionByName.get(connectionName)?.netConnectionName).toBe(
      expectedNetName,
    )
  }

  const sourceObstacleByPortId = new Map<
    string,
    (typeof obstaclesWithMetadata)[number]
  >()
  for (const obstacle of obstaclesWithMetadata) {
    const portId = obstacle.circuitJsonMetadata?.pcb_port_id
    if (!portId) throw new Error("Captured pad obstacle is missing a port id")
    if (sourceObstacleByPortId.has(portId)) {
      throw new Error(`Duplicate captured pad obstacle for ${portId}`)
    }
    sourceObstacleByPortId.set(portId, obstacle)
  }
  expect(sourceObstacleByPortId.size).toBe(373)
  expect(
    sourceObstacleByPortId.get("pcb_port_117")?.circuitJsonMetadata,
  ).toMatchObject({ source_port_name: "F2" })
  expect(
    sourceObstacleByPortId.get("pcb_port_118")?.circuitJsonMetadata,
  ).toMatchObject({ source_port_name: "W2" })
  for (const connection of inputSrj.connections) {
    const sourcePoint = connection.pointsToConnect[0]
    const sourcePointId =
      sourcePoint && "pointId" in sourcePoint ? sourcePoint.pointId : undefined
    if (typeof sourcePointId !== "string") {
      throw new Error(`Missing source point identity for ${connection.name}`)
    }
    const expectedConnectivityNet = expectedConnectivityNetByConnectionName.get(
      connection.name,
    )
    if (!expectedConnectivityNet) {
      throw new Error(`Missing connectivity net for ${connection.name}`)
    }
    const sourceObstacle = sourceObstacleByPortId.get(sourcePointId)
    expect(sourceObstacle?.connectedTo).toEqual(
      expect.arrayContaining([
        connection.name,
        sourcePointId,
        `connectivity_net:${expectedConnectivityNet}`,
      ]),
    )
  }

  const solver = new FanoutSolver(
    structuredClone(inputSrj),
    structuredClone(options),
  )
  const preparedDmi1 = solver.preparedBuses.find(
    (bus) => bus.busId === "DDR_DMI1",
  )
  expect(preparedDmi1).toMatchObject({
    busId: "DDR_DMI1",
    direction: "down",
    preferredExit: "bottom-right",
    exitEdge: "right",
    cornerBandConnectionCount: 9,
    allowedLayers: ["inner5"],
    termination: { type: "boundary" },
  })
  if (!preparedDmi1) throw new Error("Expected a prepared DDR_DMI1 bus")
  expect(preparedDmi1.connections).toHaveLength(1)
  const preparedDmi1Connection = preparedDmi1.connections[0]
  if (!preparedDmi1Connection) {
    throw new Error("Expected a prepared DDR_DMI1 connection")
  }
  expect(preparedDmi1Connection.sourcePoint).toMatchObject({
    x: -14.5,
    y: -3.5,
    layer: "top",
    pointId: "pcb_port_118",
  })
  const preparedDmi1ExitTarget = preparedDmi1Connection.exitTargetPoint
  if (!preparedDmi1ExitTarget) {
    throw new Error("Expected a prepared DDR_DMI1 exit target")
  }
  expect(preparedDmi1ExitTarget).toMatchObject({
    y: 2.387192121212122,
    layer: "inner5",
  })
  expect(preparedDmi1ExitTarget.x).toBeGreaterThan(options.sharedBoundary!.maxX)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 135,
    brokenOutConnectionCount: 135,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(135)
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(102)
  expect(output.simpleRouteJson.differentialPairs).toEqual(
    inputSrj.differentialPairs,
  )

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
  expect(traceByConnection.size).toBe(135)
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
  expect(viaCoordinates.size).toBe(135)

  const terminationByConnection = new Map(
    output.planeTerminations.map((termination) => [
      termination.connectionName,
      termination,
    ]),
  )
  expect(terminationByConnection.size).toBe(102)
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
  expect(output.simpleRouteJson.connections).toHaveLength(33)

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

    const assignedLayer = output.busLayerAssignments[expectedBus.busId]
    expect(new Set<string>(expectedBus.allowedLayers).has(assignedLayer!)).toBe(
      true,
    )
    for (const trace of traces) {
      expect(getOnlyVia(trace)).toMatchObject({
        from_layer: "top",
        to_layer: assignedLayer,
      })
    }
    const exitWires = traces.map(getLastWire)
    expect(new Set(exitWires.map((wire) => wire.y)).size).toBe(
      expectedBus.connectionNames.length,
    )
    for (const exitWire of exitWires) {
      expect(exitWire).toMatchObject({
        x: options.sharedBoundary!.maxX,
        layer: assignedLayer,
      })
      expect(exitWire.y).toBeGreaterThanOrEqual(options.sharedBoundary!.minY)
      expect(exitWire.y).toBeLessThanOrEqual(options.sharedBoundary!.maxY)
    }
  }

  const dmi0Trace = traceByConnection.get("breakout:pcb_breakout_point_17")!
  expect(output.busLayerAssignments.DDR_DMI0).toBe("inner5")
  expect(getOnlyVia(dmi0Trace)).toMatchObject({
    from_layer: "top",
    to_layer: "inner5",
  })
  const dmi0ExitWire = getLastWire(dmi0Trace)
  expect(dmi0ExitWire).toMatchObject({
    x: options.sharedBoundary!.maxX,
    layer: "inner5",
  })

  const dmi1Trace = traceByConnection.get("breakout:pcb_breakout_point_16")!
  expect(output.busLayerAssignments.DDR_DMI1).toBe("inner5")
  expect(getOnlyVia(dmi1Trace)).toMatchObject({
    from_layer: "top",
    to_layer: "inner5",
  })
  const dmi1ExitWire = getLastWire(dmi1Trace)
  expect(dmi1ExitWire).toMatchObject({
    x: options.sharedBoundary!.maxX,
    layer: "inner5",
  })
  expect(dmi1ExitWire.y).toBeGreaterThanOrEqual(options.sharedBoundary!.minY)
  expect(dmi1ExitWire.y).toBeLessThanOrEqual(options.sharedBoundary!.maxY)

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
      x: options.sharedBoundary!.maxX,
      layer: "inner5",
    })
  }
  expect(dqs1ExitYs[0]!).toBeLessThan(dqs1ExitYs[1]!)
  expect(Math.max(...dqs1ExitYs)).toBeLessThan(Math.min(...clockExitYs))
  expect(Math.max(...clockExitYs)).toBeLessThan(Math.min(...dqs0ExitYs))
  expect(Math.max(...dqs1ExitYs)).toBeLessThan(Math.min(...dqs0ExitYs))
  expect(dmi0ExitWire.y).toBeGreaterThan(Math.max(...dqs0ExitYs))

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
    checkedTraceCount: 135,
    checkedViaCount: 135,
    issues: [],
  })

  await expect(
    getPcbSvgFromSrj(inputSrj, currentPhaseSrj, {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
