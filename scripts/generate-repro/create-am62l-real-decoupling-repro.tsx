import { AM62L32 } from "@tsci/tscircuit.ti-am62l/lib/chips/AM62L32.circuit.tsx"
import {
  type GenericLocalAutorouter,
  RootCircuit,
  type SimpleRouteJson,
} from "@tscircuit/core"
import { Fragment } from "react"
import type { FanoutSolverOptions } from "../../lib/types"
import {
  createCompletedAutorouter,
  createFanoutOptions,
  ddrConnections,
  ddrDecouplingCapacitors,
  fanoutBuses,
  lpddrBallMap,
  lpddrFootprint,
  lpddrPinLabels,
  signalLayers,
  socBusDirections,
  socDdrPowerBalls,
  socGroundBalls,
} from "./generate-repro04"
import {
  directDecouplingCapacitors,
  directPowerBallMembership,
} from "./am62l-real-decoupling-data"

const SOC_X = -9.5
const SOC_Y = 0
const DRAM_X = 9.616917
const DRAM_Y = 1.81916
const boardLayers = [
  "top",
  "inner1",
  "inner2",
  "inner3",
  "inner4",
  "inner5",
  "inner6",
  "bottom",
] as const

// Core's real AM62L fixture uses the TI 373-ball package with the exact
// 10.084 mil land radius from the board design. Override only the generated
// package's rounded footprint; AM62L32 still supplies the real pin mapping.
const am62lRowNames = [
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
  "L",
  "M",
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
  "AC",
] as const
const am62lRowMasks = [
  "11111111111111111111111",
  "11111111111111111111111",
  "11010101001110010101011",
  "11110111001010011101111",
  "11000101111111110100011",
  "11111100000000000111111",
  "11010011111111111001011",
  "11111111010101011111111",
  "11000001101010110000011",
  "11000001110101110000011",
  "11111111101010111111111",
  "11101011010101011010111",
  "11111111101010111111111",
  "11000001110101110000011",
  "11000001101010110000011",
  "11111111010101011111111",
  "11010011111111111001011",
  "11111100000000000111111",
  "11000101111111110100011",
  "11110111001010011101111",
  "11010101001110010101011",
  "11111111111111111111111",
  "11111111111111111111111",
] as const
const am62lPadPositions = (() => {
  let pinNumber = 0
  return am62lRowMasks.flatMap((rowMask, rowIndex) =>
    [...rowMask].flatMap((isPopulated, columnIndex) => {
      if (isPopulated !== "1") return []
      pinNumber += 1
      return [
        {
          ballName: `${am62lRowNames[rowIndex]}${columnIndex + 1}`,
          pinNumber,
          x: -5.5 + columnIndex * 0.5,
          y: 5.5 - rowIndex * 0.5,
        },
      ]
    }),
  )
})()
const exactAm62lFootprint = (
  <footprint>
    {am62lPadPositions.map(({ ballName, pinNumber, x, y }) => (
      <Fragment key={ballName}>
        <smtpad
          portHints={[`pin${pinNumber}`, ballName]}
          pcbX={x}
          pcbY={y}
          radius="0.12808mm"
          shape="circle"
        />
      </Fragment>
    ))}
  </footprint>
)

type AutorouterAlgorithm = (
  input: SimpleRouteJson,
) => Promise<GenericLocalAutorouter>

const rotateOffset = (
  [x, y]: readonly [number, number],
  rotationDegrees: number,
) => {
  const angle = (rotationDegrees * Math.PI) / 180
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  }
}

const getViaPosition = (
  capacitor: (typeof directDecouplingCapacitors)[number],
  offset: readonly [number, number],
) => {
  const rotated = rotateOffset(offset, capacitor.rotation)
  return {
    x: SOC_X + capacitor.x + rotated.x,
    y: SOC_Y + capacitor.y + rotated.y,
  }
}

const directRailNames = [
  ...new Set(directDecouplingCapacitors.map(({ railNetName }) => railNetName)),
]

const DirectDecouplingNetwork = () => (
  <group name="SOC_DIRECT_DECOUPLING">
    <group name="SOC_DIRECT_RAIL_MEMBERSHIP" routingDisabled>
      {directPowerBallMembership.map(([ball, railNetName]) => (
        <Fragment key={ball}>
          <trace
            name={`U1_${ball}_PDN_MEMBERSHIP`}
            from={`.U1 > .${ball}`}
            to={`net.${railNetName}`}
          />
        </Fragment>
      ))}
    </group>
    {directDecouplingCapacitors.map((capacitor) => {
      const powerViaName = `V_${capacitor.name}_POWER`
      const groundViaName = `V_${capacitor.name}_GND`
      const powerVia = getViaPosition(capacitor, capacitor.power)
      const groundVia = getViaPosition(capacitor, capacitor.ground)
      return (
        <Fragment key={capacitor.name}>
          <capacitor
            name={capacitor.name}
            capacitance={capacitor.capacitance}
            footprint={capacitor.footprint}
            layer="bottom"
            pcbX={SOC_X + capacitor.x}
            pcbY={SOC_Y + capacitor.y}
            pcbRotation={capacitor.rotation}
          />
          <via
            name={powerViaName}
            pcbX={powerVia.x}
            pcbY={powerVia.y}
            fromLayer="top"
            toLayer="bottom"
            layers={[...boardLayers]}
            holeDiameter="0.15mm"
            outerDiameter="0.24mm"
            connectsTo={`net.${capacitor.railNetName}`}
          />
          <trace
            name={`${capacitor.name}_POWER_DROP`}
            from={`.${capacitor.name} > .pin1`}
            to={`.${powerViaName} > .bottom`}
            pcbPathRelativeTo={`.${capacitor.name} > .pin1`}
            pcbPath={[`.${powerViaName} > .bottom`]}
          />
          <via
            name={groundViaName}
            pcbX={groundVia.x}
            pcbY={groundVia.y}
            fromLayer="top"
            toLayer="bottom"
            layers={[...boardLayers]}
            holeDiameter="0.15mm"
            outerDiameter="0.24mm"
            connectsTo="net.GND"
          />
          <trace
            name={`${capacitor.name}_GND_DROP`}
            from={`.${capacitor.name} > .pin2`}
            to={`.${groundViaName} > .bottom`}
            pcbPathRelativeTo={`.${capacitor.name} > .pin2`}
            pcbPath={[`.${groundViaName} > .bottom`]}
          />
        </Fragment>
      )
    })}
  </group>
)

const Am62lRealDecouplingCircuit = ({
  captureFanout,
  captureTarget,
  minViaHoleEdgeToViaHoleEdgeClearance,
}: {
  captureFanout: AutorouterAlgorithm
  captureTarget: "soc" | "dram"
  minViaHoleEdgeToViaHoleEdgeClearance: string
}) => (
  <board
    name="AM62L_LPDDR4_REAL_DECOUPLING_REPRO"
    width="40mm"
    height="20mm"
    layers={8}
    defaultTraceWidth="0.08128mm"
    minTraceWidth="0.08128mm"
    minTraceToPadEdgeClearance="0.05mm"
    minViaEdgeToPadEdgeClearance="0.08128mm"
    minViaHoleEdgeToViaHoleEdgeClearance={minViaHoleEdgeToViaHoleEdgeClearance}
    minViaHoleDiameter="0.15mm"
    minViaPadDiameter="0.24mm"
    pcbStyle={{ viaHoleDiameter: "0.15mm", viaPadDiameter: "0.24mm" }}
    allowBlindAndBuriedVias={false}
    isViaInPadAllowed={false}
    autorouter={{
      algorithmFn: async (input) => createCompletedAutorouter(input),
    }}
  >
    <autoroutingphase
      name="FANOUT_METADATA"
      phaseIndex={999}
      connection="__fanout_metadata_only__"
      autorouter="fanout"
    />

    <net name="GND" />
    <net name="VDD_LPDDR4" />
    <net name="SOC_DVDD1V8" />
    {directRailNames.map((railNetName) => (
      <Fragment key={railNetName}>
        <net name={railNetName} />
      </Fragment>
    ))}
    <copperpour layer="inner1" connectsTo="net.GND" />
    <copperpour layer="inner2" connectsTo="net.VDD_LPDDR4" />
    <copperpour layer="inner3" connectsTo="net.SOC_DVDD1V8" />

    <breakout
      name="SOC_FANOUT"
      pcbX={SOC_X}
      pcbY={SOC_Y}
      padding="3mm"
      autorouter={{
        algorithmFn:
          captureTarget === "soc"
            ? captureFanout
            : async (input) => createCompletedAutorouter(input),
      }}
      fanoutRoutingLayers={[...signalLayers]}
      fanoutPourNetMap={{ inner1: "GND", inner2: "VDD_LPDDR4" }}
      busFanoutDirections={socBusDirections}
    >
      <AM62L32
        name="U1"
        footprint={exactAm62lFootprint}
        noSchematicRepresentation
      />
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
      pcbX={DRAM_X}
      pcbY={DRAM_Y}
      padding="3mm"
      autorouter={{
        algorithmFn:
          captureTarget === "dram"
            ? captureFanout
            : async (input) => createCompletedAutorouter(input),
      }}
      fanoutRoutingLayers={[...signalLayers]}
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
          pcbX={SOC_X + capacitor.x}
          pcbY={SOC_Y + capacitor.y}
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

    <DirectDecouplingNetwork />
  </board>
)

export const createAm62lRealDecouplingRepro = async ({
  captureTarget = "soc",
  minViaHoleEdgeToViaHoleEdgeClearance = "0.1016mm",
}: {
  captureTarget?: "soc" | "dram"
  minViaHoleEdgeToViaHoleEdgeClearance?: string
} = {}): Promise<{
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}> => {
  let capturedInput: SimpleRouteJson | undefined
  const captureFanout: AutorouterAlgorithm = async (input) => {
    capturedInput = structuredClone(input)
    return createCompletedAutorouter(input)
  }
  const circuit = new RootCircuit({
    platform: { placementDrcChecksDisabled: true },
  })
  circuit.add(
    <Am62lRealDecouplingCircuit
      captureFanout={captureFanout}
      captureTarget={captureTarget}
      minViaHoleEdgeToViaHoleEdgeClearance={
        minViaHoleEdgeToViaHoleEdgeClearance
      }
    />,
  )
  await circuit.renderUntilSettled()
  if (!capturedInput)
    throw new Error(`${captureTarget.toUpperCase()}_FANOUT was not invoked`)

  return {
    inputSrj: capturedInput,
    options: createFanoutOptions(capturedInput, socBusDirections),
  }
}
