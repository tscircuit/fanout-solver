import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import {
  datasetDistManifest,
  samples as sourceSamples,
} from "@tsci/tscircuit.dataset-srj29-bga-decoupling"
import type { Bounds, FanoutBusSpec, FanoutSolverOptions } from "lib/types"

const BGA_COMPONENT_ID = "bga_component"
export const SRJ29_FANOUT_LAYER_COUNT = 6

interface Srj29SourceSample {
  sampleName: string
  srj: SimpleRouteJson
}

interface Srj29ManifestSample {
  sampleName: string
  connectionCount: number
  obstacleCount: number
  bgaLayer: string
  passiveLayer: string
  decouplingCapacitorCount: number
  powerConnectionCount: number
  signalConnectionCount: number
  signalBusCount: number
  bounds: Bounds
}

interface Srj29Manifest {
  datasetName: string
  sampleCount: number
  rule: string
  samples: Srj29ManifestSample[]
}

export interface Srj29FanoutSample {
  id: string
  sourceConnectionCount: number
  fanoutConnectionCount: number
  obstacleCount: number
  componentCount: number
  bgaPadCount: number
  decouplingCapacitorCount: number
  powerConnectionCount: number
  signalConnectionCount: number
  signalBusCount: number
  bgaLayer: string
  passiveLayer: string
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
}

const manifest = datasetDistManifest as unknown as Srj29Manifest
const manifestBySampleName = new Map(
  manifest.samples.map((sample) => [sample.sampleName, sample]),
)

function pointTouchesObstacle(
  point: ConnectionPoint,
  obstacle: Obstacle,
): boolean {
  const pointLayers = "layers" in point ? point.layers : [point.layer]
  if (!pointLayers.some((layer) => obstacle.layers.includes(layer)))
    return false

  const rotationRadians =
    (-(
      (obstacle as Obstacle & { ccwRotationDegrees?: number })
        .ccwRotationDegrees ?? 0
    ) *
      Math.PI) /
    180
  const dx = point.x - obstacle.center.x
  const dy = point.y - obstacle.center.y
  const localX = dx * Math.cos(rotationRadians) - dy * Math.sin(rotationRadians)
  const localY = dx * Math.sin(rotationRadians) + dy * Math.cos(rotationRadians)
  return (
    Math.abs(localX) <= obstacle.width / 2 + 1e-6 &&
    Math.abs(localY) <= obstacle.height / 2 + 1e-6
  )
}

function connectionTouchesComponent(
  connection: SimpleRouteConnection,
  componentObstacles: Obstacle[],
): boolean {
  return connection.pointsToConnect.some((point) =>
    componentObstacles.some((obstacle) =>
      pointTouchesObstacle(point, obstacle),
    ),
  )
}

function directionForBusId(busId: string): FanoutBusSpec["direction"] {
  const side = busId.match(/^signal_bus_(left|right|top|bottom)$/)?.[1]
  switch (side) {
    case "left":
      return "left"
    case "right":
      return "right"
    case "top":
      return "up"
    case "bottom":
      return "down"
    default:
      return undefined
  }
}

function createSrj29Buses(sourceSrj: SimpleRouteJson): FanoutBusSpec[] {
  return (sourceSrj.buses ?? []).flatMap((bus): FanoutBusSpec[] => {
    const isPowerBus = bus.busId === "power_vcc" || bus.busId === "power_gnd"
    const direction =
      bus.busId === "power_vcc"
        ? "left"
        : bus.busId === "power_gnd"
          ? "right"
          : directionForBusId(bus.busId)
    const adaptedBus: FanoutBusSpec = {
      ...bus,
      sourceComponentId: BGA_COMPONENT_ID,
      direction,
      termination: { type: "boundary" },
    }

    if (!isPowerBus) return [adaptedBus]

    // A power net is not a length-matched signal bus: every pin can choose its
    // own escape layer and can merge into existing same-net copper. Keeping
    // VCC and GND on opposite sides still gives each net a coherent corridor,
    // while singleton routing prevents one blocked pin from discarding every
    // otherwise valid breakout on that power net.
    return bus.connectionNames.map((connectionName) => ({
      ...adaptedBus,
      busId: connectionName,
      connectionNames: [connectionName],
    }))
  })
}

/**
 * Adapt a complete SRJ29 routing problem into the BGA-prefix problem consumed
 * by FanoutSolver. Every connection in the derivative is intentionally kept:
 * signal and VCC/GND buses terminate at the board edge while the opposite-layer
 * capacitor pads remain connected as downstream endpoints and in the obstacle
 * field.
 */
export function createSrj29FanoutInput(
  sourceSrj: SimpleRouteJson,
): SimpleRouteJson {
  const bgaObstacles = sourceSrj.obstacles.filter(
    (obstacle) => obstacle.componentId === BGA_COMPONENT_ID,
  )
  if (bgaObstacles.length === 0) {
    throw new Error("SRJ29 sample is missing the bga_component footprint")
  }

  const connections = sourceSrj.connections.filter((connection) =>
    connectionTouchesComponent(connection, bgaObstacles),
  )
  if (connections.length === 0) {
    throw new Error("SRJ29 sample has no connections touching bga_component")
  }

  return {
    ...sourceSrj,
    layerCount: SRJ29_FANOUT_LAYER_COUNT,
    connections,
  }
}

export const srj29DatasetName = manifest.datasetName
export const srj29DatasetRule = manifest.rule

export const srj29FanoutSamples: Srj29FanoutSample[] = (
  sourceSamples as unknown as Srj29SourceSample[]
).map(({ sampleName, srj: sourceSrj }) => {
  const manifestSample = manifestBySampleName.get(sampleName)
  if (!manifestSample) {
    throw new Error(`SRJ29 manifest is missing ${sampleName}`)
  }
  const simpleRouteJson = createSrj29FanoutInput(sourceSrj)
  const componentIds = new Set(
    sourceSrj.obstacles.flatMap((obstacle) =>
      obstacle.componentId ? [obstacle.componentId] : [],
    ),
  )
  const bgaPadCount = sourceSrj.obstacles.filter(
    (obstacle) => obstacle.componentId === BGA_COMPONENT_ID,
  ).length

  return {
    id: sampleName,
    sourceConnectionCount: manifestSample.connectionCount,
    fanoutConnectionCount: simpleRouteJson.connections.length,
    obstacleCount: manifestSample.obstacleCount,
    componentCount: componentIds.size,
    bgaPadCount,
    decouplingCapacitorCount: manifestSample.decouplingCapacitorCount,
    powerConnectionCount: manifestSample.powerConnectionCount,
    signalConnectionCount: manifestSample.signalConnectionCount,
    signalBusCount: manifestSample.signalBusCount,
    bgaLayer: manifestSample.bgaLayer,
    passiveLayer: manifestSample.passiveLayer,
    simpleRouteJson,
    solverOptions: {
      sourceComponentId: BGA_COMPONENT_ID,
      buses: createSrj29Buses(sourceSrj),
      sharedBoundary: { ...manifestSample.bounds },
      compactBusTracks: simpleRouteJson.connections.length <= 64,
      allowSameNetMerges: true,
      maxLayerCombinations: 256,
    },
  }
})

if (srj29FanoutSamples.length !== manifest.sampleCount) {
  throw new Error(
    `SRJ29 manifest declares ${manifest.sampleCount} samples, but the package exported ${srj29FanoutSamples.length}`,
  )
}
