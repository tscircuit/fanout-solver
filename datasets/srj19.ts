import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import {
  datasetDistManifest,
  samples as sourceSamples,
} from "@tsci/tscircuit.dataset-srj19-bga-passive-overlays"
import type { Bounds, FanoutSolverOptions } from "lib/types"

const BGA_COMPONENT_ID = "bga_component"
export const SRJ19_FANOUT_LAYER_COUNT = 6

interface Srj19SourceSample {
  sampleName: string
  srj: SimpleRouteJson
}

interface Srj19ManifestSample {
  sampleName: string
  connectionCount: number
  obstacleCount: number
  bgaLayer: string
  passiveLayer: string
  passiveOverlayCount: number
  bounds: Bounds
}

interface Srj19Manifest {
  datasetName: string
  sampleCount: number
  rule: string
  samples: Srj19ManifestSample[]
}

export interface Srj19FanoutSample {
  id: string
  sourceConnectionCount: number
  fanoutConnectionCount: number
  obstacleCount: number
  componentCount: number
  bgaPadCount: number
  bgaLayer: string
  passiveLayer: string
  passiveOverlayCount: number
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
}

const manifest = datasetDistManifest as unknown as Srj19Manifest
const manifestBySampleName = new Map(
  manifest.samples.map((sample) => [sample.sampleName, sample]),
)

function pointTouchesObstacle(
  point: ConnectionPoint,
  obstacle: Obstacle,
): boolean {
  const pointLayers = "layers" in point ? point.layers : [point.layer]
  if (!pointLayers.some((layer) => obstacle.layers.includes(layer))) {
    return false
  }

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

/**
 * Adapt a complete SRJ19 routing problem into the BGA-prefix problem consumed
 * by FanoutSolver. Passive-to-I/O connection segments are excluded, while all
 * passive and I/O copper remains in `obstacles` as routing keepouts.
 */
export function createSrj19FanoutInput(
  sourceSrj: SimpleRouteJson,
): SimpleRouteJson {
  const bgaObstacles = sourceSrj.obstacles.filter(
    (obstacle) => obstacle.componentId === BGA_COMPONENT_ID,
  )
  if (bgaObstacles.length === 0) {
    throw new Error("SRJ19 sample is missing the bga_component footprint")
  }

  const connections = sourceSrj.connections.filter((connection) =>
    connectionTouchesComponent(connection, bgaObstacles),
  )
  if (connections.length === 0) {
    throw new Error("SRJ19 sample has no connections touching bga_component")
  }

  const { buses: _sourceBuses, ...sourceWithoutBuses } = sourceSrj
  return {
    ...sourceWithoutBuses,
    layerCount: SRJ19_FANOUT_LAYER_COUNT,
    connections,
  }
}

export const srj19DatasetName = manifest.datasetName
export const srj19DatasetRule = manifest.rule

export const srj19FanoutSamples: Srj19FanoutSample[] = (
  sourceSamples as unknown as Srj19SourceSample[]
).map(({ sampleName, srj: sourceSrj }) => {
  const manifestSample = manifestBySampleName.get(sampleName)
  if (!manifestSample) {
    throw new Error(`SRJ19 manifest is missing ${sampleName}`)
  }
  const simpleRouteJson = createSrj19FanoutInput(sourceSrj)
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
    bgaLayer: manifestSample.bgaLayer,
    passiveLayer: manifestSample.passiveLayer,
    passiveOverlayCount: manifestSample.passiveOverlayCount,
    simpleRouteJson,
    solverOptions: {
      sourceComponentId: BGA_COMPONENT_ID,
      sharedBoundary: { ...manifestSample.bounds },
      maxLayerCombinations: 256,
    },
  }
})

if (srj19FanoutSamples.length !== manifest.sampleCount) {
  throw new Error(
    `SRJ19 manifest declares ${manifest.sampleCount} samples, but the package exported ${srj19FanoutSamples.length}`,
  )
}
