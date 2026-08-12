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

function getPowerPlaneLayer(busId: string): string {
  return busId === "power_vcc" ? "inner2" : "inner3"
}

function getPowerEscapeDirections(
  sourceSrj: SimpleRouteJson,
): Map<string, FanoutBusSpec["direction"]> {
  const bgaObstacles = sourceSrj.obstacles.filter(
    (obstacle) => obstacle.componentId === BGA_COMPONENT_ID,
  )
  const sourcePointByConnectionName = new Map<string, ConnectionPoint>()
  for (const connection of sourceSrj.connections) {
    const sourcePoint = connection.pointsToConnect.find((point) =>
      bgaObstacles.some((obstacle) => pointTouchesObstacle(point, obstacle)),
    )
    if (sourcePoint)
      sourcePointByConnectionName.set(connection.name, sourcePoint)
  }
  const sourcePoints = [...sourcePointByConnectionName.values()]
  const center = {
    x:
      sourcePoints.reduce((sum, point) => sum + point.x, 0) /
      Math.max(sourcePoints.length, 1),
    y:
      sourcePoints.reduce((sum, point) => sum + point.y, 0) /
      Math.max(sourcePoints.length, 1),
  }
  const directions = new Map<string, FanoutBusSpec["direction"]>()
  for (const connection of sourceSrj.connections) {
    const sourcePoint = sourcePointByConnectionName.get(connection.name)
    if (!sourcePoint) continue
    const targetPoint = connection.pointsToConnect.find(
      (point) => point !== sourcePoint,
    )
    // The nearby capacitor pad tells us which side of the BGA pad is occupied.
    // Escape in the opposite direction so the dogbone via does not sit under
    // the capacitor body or force its top-layer branch through the other pad.
    let dx = sourcePoint.x - (targetPoint?.x ?? sourcePoint.x)
    let dy = sourcePoint.y - (targetPoint?.y ?? sourcePoint.y)
    if (Math.hypot(dx, dy) < 1e-3) {
      dx = sourcePoint.x - center.x
      dy = sourcePoint.y - center.y
    }
    directions.set(
      connection.name,
      Math.abs(dx) >= Math.abs(dy)
        ? dx < 0
          ? "left"
          : "right"
        : dy < 0
          ? "down"
          : "up",
    )
  }
  return directions
}

function createSrj29Buses(sourceSrj: SimpleRouteJson): FanoutBusSpec[] {
  const powerEscapeDirections = getPowerEscapeDirections(sourceSrj)
  return (sourceSrj.buses ?? []).flatMap((bus): FanoutBusSpec[] => {
    const isPowerBus = bus.busId === "power_vcc" || bus.busId === "power_gnd"
    if (!isPowerBus) {
      return [
        {
          ...bus,
          sourceComponentId: BGA_COMPONENT_ID,
          direction: directionForBusId(bus.busId),
          termination: { type: "boundary" },
        },
      ]
    }

    // Each power pin needs two local results: a short branch to its nearby
    // decoupling capacitor and a physical breakout into the appropriate power
    // plane. Treating power pins as edge-bound signal traces creates long,
    // redundant copper and gives the optimizer the wrong topology.
    return bus.connectionNames.map((connectionName) => ({
      ...bus,
      busId: connectionName,
      connectionNames: [connectionName],
      sourceComponentId: BGA_COMPONENT_ID,
      direction:
        powerEscapeDirections.get(connectionName) ??
        (bus.busId === "power_vcc" ? "left" : "right"),
      termination: {
        type: "plane",
        layer: getPowerPlaneLayer(bus.busId),
      },
    }))
  })
}

/**
 * Adapt a complete SRJ29 routing problem into the BGA-prefix problem consumed
 * by FanoutSolver. Every connection in the derivative is intentionally kept:
 * signals terminate at the board edge, while VCC/GND pins terminate into
 * dedicated inner planes and retain their opposite-layer capacitor pads as
 * required endpoints in the obstacle field.
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
      // Keep signals off the capacitor side and the two dedicated power
      // planes. This leaves bottom/inner1/inner4 as coherent signal-routing
      // layers and prevents a legal fanout prefix from blocking the short
      // top-layer decoupling branches during endpoint completion.
      escapeLayers: ["bottom", "inner1", "inner4"],
      completeOriginalEndpoints: true,
      endpointCompletionEffort: 1,
      balanceLayerLoadByConnectionCount: true,
      maxLayerCombinations: 256,
    },
  }
})

if (srj29FanoutSamples.length !== manifest.sampleCount) {
  throw new Error(
    `SRJ29 manifest declares ${manifest.sampleCount} samples, but the package exported ${srj29FanoutSamples.length}`,
  )
}
