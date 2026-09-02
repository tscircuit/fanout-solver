import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { AM62L32 } from "@tsci/tscircuit.ti-am62l/lib/chips/AM62L32.circuit.tsx"
import {
  type AutorouterCompleteEvent,
  type AutorouterErrorEvent,
  type AutorouterProgressEvent,
  type GenericLocalAutorouter,
  RootCircuit,
  type SimpleRouteBus,
  type SimpleRouteJson,
  type SimpleRoutePoint,
} from "@tscircuit/core"
import { Fragment } from "react"
import type {
  FanoutDirection,
  FanoutExitPosition,
  FanoutSolverOptions,
} from "../../lib/types"

type DdrBusName =
  | "DDR_BYTE0"
  | "DDR_BYTE1"
  | "DDR_ADDR_CTRL"
  | "DDR_CLOCK"
  | "DDR_DQS0"
  | "DDR_DQS1"
  | "DDR_RESET"
  | "DDR_DMI0"
  | "DDR_DMI1"

interface DdrConnection {
  busName: DdrBusName
  memorySignal: string
  socSignal: string
  traceName: string
}

const byteConnections: DdrConnection[] = [
  ...Array.from({ length: 8 }, (_, bit) => ({
    busName: "DDR_BYTE0" as const,
    memorySignal: `DQ${bit}`,
    socSignal: `DDR0_DQ${bit}`,
    traceName: `DQ${bit}`,
  })),
  ...Array.from({ length: 8 }, (_, index) => {
    const bit = index + 8
    return {
      busName: "DDR_BYTE1" as const,
      memorySignal: `DQ${bit}`,
      socSignal: `DDR0_DQ${bit}`,
      traceName: `DQ${bit}`,
    }
  }),
]

const ddrConnections: DdrConnection[] = [
  ...byteConnections,
  ...[
    ["CA0", "DDR0_A0"],
    ["CA1", "DDR0_A1"],
    ["CA2", "DDR0_A2"],
    ["CA3", "DDR0_A3"],
    ["CA4", "DDR0_A4"],
    ["CA5", "DDR0_A5"],
    ["CS", "DDR0_CS0_n"],
    ["CKE", "DDR0_CKE0"],
  ].map(([memorySignal, socSignal]) => ({
    busName: "DDR_ADDR_CTRL" as const,
    memorySignal: memorySignal!,
    socSignal: socSignal!,
    traceName: memorySignal!,
  })),
  {
    busName: "DDR_CLOCK",
    memorySignal: "CK_t",
    socSignal: "DDR0_CK0",
    traceName: "CK_t",
  },
  {
    busName: "DDR_CLOCK",
    memorySignal: "CK_c",
    socSignal: "DDR0_CK0_n",
    traceName: "CK_c",
  },
  {
    busName: "DDR_DQS0",
    memorySignal: "DQS0_t",
    socSignal: "DDR0_DQS0",
    traceName: "DQS0_t",
  },
  {
    busName: "DDR_DQS0",
    memorySignal: "DQS0_c",
    socSignal: "DDR0_DQS0_n",
    traceName: "DQS0_c",
  },
  {
    busName: "DDR_DQS1",
    memorySignal: "DQS1_t",
    socSignal: "DDR0_DQS1",
    traceName: "DQS1_t",
  },
  {
    busName: "DDR_DQS1",
    memorySignal: "DQS1_c",
    socSignal: "DDR0_DQS1_n",
    traceName: "DQS1_c",
  },
  {
    busName: "DDR_RESET",
    memorySignal: "RESET_n",
    socSignal: "DDR0_RESET0_n",
    traceName: "RESET_n",
  },
  {
    busName: "DDR_DMI0",
    memorySignal: "DMI0",
    socSignal: "DDR0_DM0",
    traceName: "DMI0",
  },
  {
    busName: "DDR_DMI1",
    memorySignal: "DMI1",
    socSignal: "DDR0_DM1",
    traceName: "DMI1",
  },
]

const signalLayers = ["top", "inner4", "inner5", "inner6", "bottom"] as const

const fanoutBuses = [
  {
    name: "DDR_BYTE0",
    preferredLayers: ["top", "inner4"],
    maxLengthSkew: 8,
  },
  {
    name: "DDR_BYTE1",
    preferredLayers: ["inner5", "bottom"],
    maxLengthSkew: 14.5,
  },
  {
    name: "DDR_ADDR_CTRL",
    preferredLayers: ["inner6"],
    maxLengthSkew: 15,
  },
  {
    name: "DDR_CLOCK",
    preferredLayers: ["inner5"],
    maxLengthSkew: 0.25,
  },
  {
    name: "DDR_DQS0",
    preferredLayers: ["inner5"],
    maxLengthSkew: 0.25,
  },
  {
    name: "DDR_DQS1",
    preferredLayers: ["inner5"],
    maxLengthSkew: 0.25,
  },
  {
    name: "DDR_RESET",
    preferredLayers: ["inner6"],
    maxLengthSkew: undefined,
  },
  {
    name: "DDR_DMI0",
    preferredLayers: ["inner5"],
    maxLengthSkew: undefined,
  },
  {
    name: "DDR_DMI1",
    preferredLayers: ["inner5"],
    maxLengthSkew: undefined,
  },
] as const

const socBusDirections: Record<DdrBusName, FanoutExitPosition> = {
  DDR_BYTE0: "topside_left",
  DDR_BYTE1: "topside_right",
  DDR_ADDR_CTRL: "topside_center",
  DDR_CLOCK: "topside_left",
  DDR_DQS0: "topside_left",
  DDR_DQS1: "topside_right",
  DDR_RESET: "topside_center",
  DDR_DMI0: "topside_left",
  DDR_DMI1: "topside_right",
}

const dramBusDirections: Record<DdrBusName, FanoutExitPosition> = {
  DDR_BYTE0: "bottomside_left",
  DDR_BYTE1: "bottomside_center",
  DDR_ADDR_CTRL: "bottomside_center",
  DDR_CLOCK: "bottomside_left",
  DDR_DQS0: "bottomside_left",
  DDR_DQS1: "bottomside_center",
  DDR_RESET: "bottomside_center",
  DDR_DMI0: "bottomside_left",
  DDR_DMI1: "bottomside_center",
}

const lpddrColumns = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] as const
const lpddrRows = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "N",
  "P",
  "R",
  "T",
  "U",
  "V",
  "W",
  "Y",
  "AA",
  "AB",
] as const

const lpddrSignals = [
  ["DNU", "DNU", "VSS", "VDD2", "ZQ", "NC", "VDD2", "VSS", "DNU", "DNU"],
  ["DNU", "DQ0", "VDDQ", "DQ7", "VDDQ", "VDDQ", "DQ15", "VDDQ", "DQ8", "DNU"],
  ["VSS", "DQ1", "DMI0", "DQ6", "VSS", "VSS", "DQ14", "DMI1", "DQ9", "VSS"],
  [
    "VDDQ",
    "VSS",
    "DQS0_t",
    "VSS",
    "VDDQ",
    "VDDQ",
    "VSS",
    "DQS1_t",
    "VSS",
    "VDDQ",
  ],
  [
    "VSS",
    "DQ2",
    "DQS0_c",
    "DQ5",
    "VSS",
    "VSS",
    "DQ13",
    "DQS1_c",
    "DQ10",
    "VSS",
  ],
  [
    "VDD1",
    "DQ3",
    "VDDQ",
    "DQ4",
    "VDD2",
    "VDD2",
    "DQ12",
    "VDDQ",
    "DQ11",
    "VDD1",
  ],
  ["VSS", "ODT_CA", "VSS", "VDD1", "VSS", "VSS", "VDD1", "VSS", "NC", "VSS"],
  ["VDD2", "CA0", "NC", "CS", "VDD2", "VDD2", "CA2", "CA3", "CA4", "VDD2"],
  ["VSS", "CA1", "VSS", "CKE", "NC", "CK_t", "CK_c", "VSS", "CA5", "VSS"],
  ["VDD2", "VSS", "VDD2", "VSS", "NC", "NC", "VSS", "VDD2", "VSS", "VDD2"],
  ["VDD2", "VSS", "VDD2", "VSS", "NC", "NC", "VSS", "VDD2", "VSS", "VDD2"],
  ["VSS", "NC", "VSS", "NC", "NC", "NC", "NC", "VSS", "NC", "VSS"],
  ["VDD2", "NC", "NC", "NC", "VDD2", "VDD2", "NC", "NC", "NC", "VDD2"],
  ["VSS", "NC", "VSS", "VDD1", "VSS", "VSS", "VDD1", "VSS", "RESET_n", "VSS"],
  ["VDD1", "NC", "VDDQ", "NC", "VDD2", "VDD2", "NC", "VDDQ", "NC", "VDD1"],
  ["VSS", "NC", "NC", "NC", "VSS", "VSS", "NC", "NC", "NC", "VSS"],
  ["VDDQ", "VSS", "NC", "VSS", "VDDQ", "VDDQ", "VSS", "NC", "VSS", "VDDQ"],
  ["VSS", "NC", "NC", "NC", "VSS", "VSS", "NC", "NC", "NC", "VSS"],
  ["DNU", "NC", "VDDQ", "NC", "VDDQ", "VDDQ", "NC", "VDDQ", "NC", "DNU"],
  ["DNU", "DNU", "VSS", "VDD2", "VSS", "VSS", "VDD2", "VSS", "DNU", "DNU"],
] as const

const lpddrBallMap = lpddrRows.flatMap((row, rowIndex) =>
  lpddrColumns.map((column, columnIndex) => ({
    ball: `${row}${column}`,
    signal: lpddrSignals[rowIndex]![columnIndex]!,
    x: (column - 6.5) * 0.8,
    y: (10.5 - (rowIndex < 10 ? rowIndex : rowIndex + 2)) * 0.65,
  })),
)

const uniqueLpddrSignals = new Set(
  lpddrBallMap
    .map(({ signal }) => signal)
    .filter(
      (signal) =>
        !["NC", "DNU", "VSS", "VDD1", "VDD2", "VDDQ"].includes(signal),
    ),
)

const lpddrPinLabels = Object.fromEntries(
  lpddrBallMap.map(({ ball, signal }, index) => [
    `pin${index + 1}`,
    uniqueLpddrSignals.has(signal)
      ? [ball, signal, `${signal}_${ball}`]
      : [ball, `${signal}_${ball}`],
  ]),
) as Record<`pin${number}`, readonly string[]>

const lpddrFootprint = (
  <footprint>
    {lpddrBallMap.map(({ ball, x, y }, index) => (
      <Fragment key={ball}>
        <smtpad
          portHints={[`pin${index + 1}`, ball]}
          pcbX={x}
          pcbY={y}
          radius="0.16mm"
          shape="circle"
        />
      </Fragment>
    ))}
  </footprint>
)

const socGroundBalls = `
  A1 A2 A4 A10 A13 A16 A19 A22 A23 B1 B5 B17 B20 B23 C12 C18 D1
  E2 E6 E8 E9 E10 E14 E15 F5 F6 F18 G7 G8 G9 G12 G15 G16 G17
  H1 H7 H14 H17 K8 K9 K15 L7 L9 L13 L16 L18 M1 M12 N7 N9 N11
  N13 N16 P9 P15 R1 R8 R13 R15 T2 T7 T8 T19 U7 U8 U10 U13 U14
  U15 U17 U20 V3 V18 V19 W9 W10 W12 W14 W15 W16 W18 Y1 Y20 Y21
  AA4 AA20 AB1 AB7 AB21 AB23 AC1 AC2 AC11 AC14 AC19 AC22 AC23
`
  .trim()
  .split(/\s+/)

const socDdrPowerBalls = ["L8", "M7", "M8", "N8", "P8"]

const ddrDecouplingCapacitors = [
  {
    name: "C_SOC_DDR_HS_L8",
    capacitance: "1uF",
    x: -0.625,
    y: 0.625,
    rotation: 180,
  },
  {
    name: "C_SOC_DDR_HS_M7",
    capacitance: "1uF",
    x: -3.125,
    y: -1.75,
    rotation: 180,
  },
  {
    name: "C_SOC_DDR_HS_M8",
    capacitance: "1uF",
    x: -1,
    y: -0.125,
    rotation: 180,
  },
  {
    name: "C_SOC_DDR_HS_N8",
    capacitance: "1uF",
    x: -0.75,
    y: -1.175,
    rotation: 180,
  },
  {
    name: "C_SOC_DDR_HS_P8",
    capacitance: "1uF",
    x: -1.75,
    y: -2.25,
    rotation: 90,
  },
  {
    name: "C_SOC_DDR_MED1",
    capacitance: "0.1uF",
    x: -0.625,
    y: -2,
    rotation: 180,
  },
  {
    name: "C_SOC_DDR_MED2",
    capacitance: "0.1uF",
    x: -0.75,
    y: -3.125,
    rotation: 90,
  },
  {
    name: "C_SOC_DDR_MED3",
    capacitance: "0.1uF",
    x: 0.75,
    y: -1.25,
    rotation: 180,
  },
] as const

const createCompletedAutorouter = (
  input: SimpleRouteJson,
): GenericLocalAutorouter => {
  const handlers = {
    complete: [] as Array<(event: AutorouterCompleteEvent) => void>,
    error: [] as Array<(event: AutorouterErrorEvent) => void>,
    progress: [] as Array<(event: AutorouterProgressEvent) => void>,
  }

  return {
    input,
    isRouting: false,
    async start() {
      this.isRouting = true
      for (const handler of handlers.progress) {
        handler({
          type: "progress",
          steps: 1,
          progress: 1,
          phase: "capture",
        })
      }
      setTimeout(() => {
        this.isRouting = false
        for (const handler of handlers.complete) {
          handler({ type: "complete", traces: [] })
        }
      }, 0)
    },
    stop() {
      this.isRouting = false
    },
    on(event, callback) {
      handlers[event].push(callback as never)
    },
    solveSync() {
      return []
    },
  }
}

const getSourceComponentIdForPoint = (
  input: SimpleRouteJson,
  point: SimpleRoutePoint,
): string | undefined =>
  input.obstacles.find(
    (obstacle) =>
      obstacle.componentId &&
      obstacle.layers.includes(point.layer) &&
      ((point.pointId && obstacle.connectedTo.includes(point.pointId)) ||
        (point.x >= obstacle.center.x - obstacle.width / 2 &&
          point.x <= obstacle.center.x + obstacle.width / 2 &&
          point.y >= obstacle.center.y - obstacle.height / 2 &&
          point.y <= obstacle.center.y + obstacle.height / 2)),
  )?.componentId

const inferPlaneBusDirection = (
  input: SimpleRouteJson,
  bus: SimpleRouteBus,
): FanoutDirection | undefined => {
  const connectionNames = new Set(bus.connectionNames)
  const sourcePointsByComponentId = new Map<string, SimpleRoutePoint[]>()
  for (const connection of input.connections) {
    if (!connectionNames.has(connection.name)) continue
    for (const point of connection.pointsToConnect) {
      const componentId = getSourceComponentIdForPoint(input, point)
      if (!componentId) continue
      const sourcePoints = sourcePointsByComponentId.get(componentId) ?? []
      sourcePoints.push(point)
      sourcePointsByComponentId.set(componentId, sourcePoints)
    }
  }
  const sourceComponent = [...sourcePointsByComponentId.entries()].sort(
    ([firstId, firstPoints], [secondId, secondPoints]) =>
      secondPoints.length - firstPoints.length ||
      firstId.localeCompare(secondId),
  )[0]
  if (!sourceComponent) return undefined

  const [componentId, sourcePoints] = sourceComponent
  const componentObstacles = input.obstacles.filter(
    (obstacle) => obstacle.componentId === componentId,
  )
  if (componentObstacles.length === 0) return undefined

  const minX = Math.min(...componentObstacles.map(({ center }) => center.x))
  const maxX = Math.max(...componentObstacles.map(({ center }) => center.x))
  const minY = Math.min(...componentObstacles.map(({ center }) => center.y))
  const maxY = Math.max(...componentObstacles.map(({ center }) => center.y))
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const average = {
    x:
      sourcePoints.reduce((sum, point) => sum + point.x, 0) /
      sourcePoints.length,
    y:
      sourcePoints.reduce((sum, point) => sum + point.y, 0) /
      sourcePoints.length,
  }
  const normalizedX = (average.x - center.x) / Math.max((maxX - minX) / 2, 1e-6)
  const normalizedY = (average.y - center.y) / Math.max((maxY - minY) / 2, 1e-6)
  if (Math.abs(normalizedX) > Math.abs(normalizedY)) {
    return normalizedX >= 0 ? "right" : "left"
  }
  if (Math.abs(normalizedY) > 1e-9) return normalizedY >= 0 ? "up" : "down"
  return "right"
}

const createFanoutOptions = (
  input: SimpleRouteJson,
  busDirections: Record<DdrBusName, FanoutExitPosition>,
): FanoutSolverOptions => {
  const buses = (input.buses ?? []).map((bus) => {
    const { preferredLayer, preferredLayers, ...busWithoutPreferences } = bus
    const requestedLayers = [
      ...(preferredLayer ? [preferredLayer] : []),
      ...(preferredLayers ?? []),
    ].filter((layer, index, layers) => layers.indexOf(layer) === index)
    const allowedLayers = bus.allowedLayers
      ? requestedLayers.filter((layer) => bus.allowedLayers!.includes(layer))
      : requestedLayers
    const exitPosition = busDirections[bus.busId as DdrBusName]

    return {
      ...busWithoutPreferences,
      ...(bus.termination?.type === "plane" || !exitPosition
        ? {}
        : { exitPosition }),
      ...(allowedLayers.length > 0 ? { allowedLayers } : {}),
    }
  })
  const planeDirections = Object.fromEntries(
    (input.buses ?? [])
      .filter((bus) => bus.termination?.type === "plane")
      .flatMap((bus) => {
        const direction = inferPlaneBusDirection(input, bus)
        return direction ? [[bus.busId, direction] as const] : []
      }),
  )

  return {
    buses,
    borderDistribution: "even",
    compactBusTracks: true,
    busDirections: planeDirections,
    escapeLayers: [...signalLayers],
    allowBlindAndBuriedVias: false,
    sharedBoundary: input.bounds,
  }
}

type AutorouterAlgorithm = (
  input: SimpleRouteJson,
) => Promise<GenericLocalAutorouter>

interface Repro04CircuitProps {
  captureSocFanout: AutorouterAlgorithm
  completeWithoutRouting: AutorouterAlgorithm
}

export default function Repro04Circuit({
  captureSocFanout,
  completeWithoutRouting,
}: Repro04CircuitProps) {
  return (
    <board
      name="AM62L_LPDDR4_REPRO04"
      width="32mm"
      height="54mm"
      layers={8}
      defaultTraceWidth="0.08128mm"
      minTraceWidth="0.08128mm"
      minTraceToPadEdgeClearance="0.05mm"
      minViaEdgeToPadEdgeClearance="0.08128mm"
      minViaHoleEdgeToViaHoleEdgeClearance="0.1016mm"
      minViaHoleDiameter="0.1mm"
      minViaPadDiameter="0.24mm"
      pcbStyle={{ viaHoleDiameter: "0.1mm", viaPadDiameter: "0.24mm" }}
      allowBlindAndBuriedVias={false}
      isViaInPadAllowed={false}
      autorouter={{ algorithmFn: completeWithoutRouting }}
    >
      {/*
       * Keep a fanout stage in core's routing-phase plan so copper-pour drops
       * are encoded as plane-terminated buses. The selector intentionally
       * matches no trace, so this stage is skipped before solver construction;
       * the real SOC stage below is intercepted through algorithmFn.
       */}
      <autoroutingphase
        name="FANOUT_METADATA"
        phaseIndex={999}
        connection="__fanout_metadata_only__"
        autorouter="fanout"
      />

      <net name="GND" />
      <net name="VDD_LPDDR4" />
      <net name="SOC_DVDD1V8" />

      <copperpour layer="inner1" connectsTo="net.GND" />
      <copperpour layer="inner2" connectsTo="net.VDD_LPDDR4" />
      <copperpour layer="inner3" connectsTo="net.SOC_DVDD1V8" />

      <breakout
        name="SOC_FANOUT"
        pcbX={0}
        pcbY={-11}
        padding="3mm"
        autorouter={{ algorithmFn: captureSocFanout }}
        fanoutRoutingLayers={[...signalLayers]}
        fanoutPourNetMap={{ inner1: "GND", inner2: "VDD_LPDDR4" }}
        busFanoutDirections={socBusDirections}
      >
        <AM62L32 name="U1" noSchematicRepresentation />
        {socGroundBalls.map((ball) => (
          <Fragment key={`U1_${ball}_DROP`}>
            <trace
              name={`U1_VSS_${ball}_DROP`}
              from={`.U1 > .${ball}`}
              to="net.GND"
            />
          </Fragment>
        ))}
        {socDdrPowerBalls.map((ball) => (
          <Fragment key={`U1_${ball}_DROP`}>
            <trace
              name={`U1_VDDS_DDR_${ball}_DROP`}
              from={`.U1 > .${ball}`}
              to="net.VDD_LPDDR4"
            />
          </Fragment>
        ))}
      </breakout>

      <breakout
        name="DRAM_FANOUT"
        pcbX={0}
        pcbY={11.5}
        padding="3mm"
        autorouter={{ algorithmFn: completeWithoutRouting }}
        fanoutRoutingLayers={[...signalLayers]}
        fanoutPourNetMap={{
          inner1: "GND",
          inner2: "VDD_LPDDR4",
          inner3: "SOC_DVDD1V8",
        }}
        busFanoutDirections={dramBusDirections}
      >
        <chip
          name="U2"
          pinLabels={lpddrPinLabels}
          manufacturerPartNumber="MT53E1G16D1ZW"
          footprint={lpddrFootprint}
          pcbRotation={90}
          noSchematicRepresentation
        />
        {lpddrBallMap
          .filter(({ signal }) => signal === "VSS")
          .map(({ ball }) => (
            <Fragment key={`U2_${ball}_DROP`}>
              <trace
                name={`U2_VSS_${ball}_DROP`}
                from={`.U2 > .${ball}`}
                to="net.GND"
              />
            </Fragment>
          ))}
        {lpddrBallMap
          .filter(({ signal }) => signal === "VDDQ" || signal === "VDD2")
          .map(({ ball, signal }) => (
            <Fragment key={`U2_${ball}_DROP`}>
              <trace
                name={`U2_${signal}_${ball}_DROP`}
                from={`.U2 > .${ball}`}
                to="net.VDD_LPDDR4"
              />
            </Fragment>
          ))}
        {lpddrBallMap
          .filter(({ signal }) => signal === "VDD1")
          .map(({ ball }) => (
            <Fragment key={`U2_${ball}_DROP`}>
              <trace
                name={`U2_VDD1_${ball}_DROP`}
                from={`.U2 > .${ball}`}
                to="net.SOC_DVDD1V8"
              />
            </Fragment>
          ))}
      </breakout>

      {ddrDecouplingCapacitors.map((capacitor) => (
        <Fragment key={capacitor.name}>
          <capacitor
            name={capacitor.name}
            capacitance={capacitor.capacitance}
            footprint="cap0201_nosilkscreen"
            layer="bottom"
            pcbX={capacitor.x}
            pcbY={-11 + capacitor.y}
            pcbRotation={capacitor.rotation}
          />
          <trace
            name={`${capacitor.name}_VDD_DROP`}
            from={`.${capacitor.name} > .pin1`}
            to="net.VDD_LPDDR4"
          />
          <trace
            name={`${capacitor.name}_GND_DROP`}
            from={`.${capacitor.name} > .pin2`}
            to="net.GND"
          />
        </Fragment>
      ))}

      {fanoutBuses.map((bus) => (
        <Fragment key={bus.name}>
          <bus
            name={bus.name}
            connections={ddrConnections
              .filter(({ busName }) => busName === bus.name)
              .map(({ traceName }) => traceName)}
            preferredLayers={[...bus.preferredLayers]}
            maxLengthSkew={bus.maxLengthSkew}
          />
        </Fragment>
      ))}

      <differentialpair
        name="DDR_CLOCK_PAIR"
        positiveConnection="CK_t"
        negativeConnection="CK_c"
        maxLengthSkew={0.25}
      />
      <differentialpair
        name="DDR_DQS0_PAIR"
        positiveConnection="DQS0_t"
        negativeConnection="DQS0_c"
        maxLengthSkew={0.25}
      />
      <differentialpair
        name="DDR_DQS1_PAIR"
        positiveConnection="DQS1_t"
        negativeConnection="DQS1_c"
        maxLengthSkew={0.25}
      />

      {ddrConnections.map(({ memorySignal, socSignal, traceName }) => (
        <Fragment key={traceName}>
          <trace
            name={traceName}
            from={`U1.${socSignal}`}
            to={`U2.${memorySignal}`}
          />
        </Fragment>
      ))}
    </board>
  )
}

const generateRepro04 = async () => {
  let captured:
    | { inputSrj: SimpleRouteJson; options: FanoutSolverOptions }
    | undefined

  const completeWithoutRouting: AutorouterAlgorithm = async (input) =>
    createCompletedAutorouter(input)
  const captureSocFanout: AutorouterAlgorithm = async (input) => {
    captured = {
      inputSrj: structuredClone(input),
      options: createFanoutOptions(input, socBusDirections),
    }
    return createCompletedAutorouter(input)
  }

  const circuit = new RootCircuit({
    platform: { placementDrcChecksDisabled: true },
  })
  circuit.add(
    <Repro04Circuit
      captureSocFanout={captureSocFanout}
      completeWithoutRouting={completeWithoutRouting}
    />,
  )
  await circuit.renderUntilSettled()

  if (!captured) throw new Error("SOC_FANOUT algorithmFn was not invoked")

  const outputPath = resolve(
    import.meta.dir,
    "../../tests/fixtures/am62l-lpddr4-ram-above-soc-fanout.json",
  )
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        generatedFrom: {
          generator: "scripts/generate-repro/generate-repro04.tsx",
          layout: "ram_above",
        },
        ...captured,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Wrote ${outputPath}`)
}

if (import.meta.main) await generateRepro04()
