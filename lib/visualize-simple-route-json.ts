import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import type { Circle, GraphicsObject, Line, Point, Rect } from "graphics-debug"
import { getCopperLayerColor } from "./layer-colors"
import { getCopperLayerNames } from "./layer-names"

const LEGACY_VISUALIZATION_LAYERS = new Set([
  "top",
  "bottom",
  "inner1",
  "inner2",
  "inner3",
  "inner4",
  "inner5",
  "inner6",
  "inner7",
  "inner8",
])

const JUMPER_DIMENSIONS = {
  "0603": { padLength: 0.8, padWidth: 0.95 },
  "1206": { padLength: 0.6, padWidth: 1.6 },
  "1206x4_pair": { padLength: 0.8, padWidth: 0.5 },
} as const

const getLayerIndex = (layerNames: string[], layerName: string): number => {
  const layerIndex = layerNames.indexOf(layerName)
  if (layerIndex < 0) {
    throw new Error(
      `FanoutSolver: cannot visualize unknown copper layer "${layerName}"`,
    )
  }
  return layerIndex
}

const getGraphicsLayer = (
  layerNames: string[],
  copperLayers: readonly string[],
): string => {
  const zLayers = [
    ...new Set(
      copperLayers.map((layerName) => getLayerIndex(layerNames, layerName)),
    ),
  ].sort((first, second) => first - second)
  return `z${zLayers.join(",")}`
}

const getPointLayers = (point: ConnectionPoint): string[] => {
  const layers = "layers" in point ? point.layers : undefined
  if (layers && layers.length > 0) return layers
  return [(point as ConnectionPoint & { layer: string }).layer]
}

const getObstacleLayerIndexes = (
  obstacle: Obstacle,
  layerNames: string[],
): number[] => {
  if (obstacle.__zLayers && obstacle.__zLayers.length > 0) {
    return [...new Set(obstacle.__zLayers)]
      .filter(
        (layerIndex) =>
          Number.isInteger(layerIndex) &&
          layerIndex >= 0 &&
          layerIndex < layerNames.length,
      )
      .sort((first, second) => first - second)
  }
  return [
    ...new Set(
      obstacle.layers.map((layerName) => getLayerIndex(layerNames, layerName)),
    ),
  ].sort((first, second) => first - second)
}

const getViaLayerNames = (
  layerNames: string[],
  fromLayer: string,
  toLayer: string,
): string[] => {
  const fromIndex = getLayerIndex(layerNames, fromLayer)
  const toIndex = getLayerIndex(layerNames, toLayer)
  return layerNames.slice(
    Math.min(fromIndex, toIndex),
    Math.max(fromIndex, toIndex) + 1,
  )
}

const firstFiniteNumber = (
  ...values: Array<number | undefined>
): number | undefined =>
  values.find((value) => typeof value === "number" && Number.isFinite(value))

const getViaPadDiameter = (srj: SimpleRouteJson): number => {
  const holeDiameter = firstFiniteNumber(
    srj.min_via_hole_diameter,
    srj.minViaHoleDiameter,
  )
  const padDiameter = firstFiniteNumber(
    srj.min_via_pad_diameter,
    srj.minViaPadDiameter,
    srj.minViaDiameter,
  )
  return Math.max(padDiameter ?? srj.minViaDiameter ?? 0.3, holeDiameter ?? 0)
}

const getColorMap = (
  connections: SimpleRouteJson["connections"],
): Record<string, string> =>
  Object.fromEntries(
    connections.map((connection, index) => [
      connection.name,
      `hsl(${(index * 340) / connections.length}, 100%, 50%)`,
    ]),
  )

const hslToRgb = (hue: number, saturation: number, lightness: number) => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hueSegment = (((hue % 360) + 360) % 360) / 60
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1))
  const [red, green, blue] =
    hueSegment < 1
      ? [chroma, secondary, 0]
      : hueSegment < 2
        ? [secondary, chroma, 0]
        : hueSegment < 3
          ? [0, chroma, secondary]
          : hueSegment < 4
            ? [0, secondary, chroma]
            : hueSegment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  const match = lightness - chroma / 2
  return [red, green, blue].map((channel) =>
    Math.round((channel + match) * 255),
  )
}

const transparentize = (color: string, amount: number): string => {
  const namedColors: Record<string, [number, number, number]> = {
    blue: [0, 0, 255],
    orange: [255, 165, 0],
    purple: [128, 0, 128],
    red: [255, 0, 0],
  }
  let channels = namedColors[color]
  let alpha = 1
  const rgbaMatch =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      color,
    )
  if (rgbaMatch) {
    channels = [
      Number(rgbaMatch[1]),
      Number(rgbaMatch[2]),
      Number(rgbaMatch[3]),
    ]
    alpha = rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4])
  }
  const hslMatch =
    /^hsl\(\s*([\d.-]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(color)
  if (hslMatch) {
    channels = hslToRgb(
      Number(hslMatch[1]),
      Number(hslMatch[2]) / 100,
      Number(hslMatch[3]) / 100,
    ) as [number, number, number]
  }
  if (!channels) return color
  const outputAlpha =
    +Math.max(0, alpha * 100 - amount * 100).toFixed(2) / 100
  if (outputAlpha >= 1) {
    const hex = channels
      .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")
    return hex[0] === hex[1] && hex[2] === hex[3] && hex[4] === hex[5]
      ? `#${hex[0]}${hex[2]}${hex[4]}`
      : `#${hex}`
  }
  return `rgba(${channels.join(",")},${outputAlpha})`
}

const getUniqueValues = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

const createObstacleLabelFormatter = (srj: SimpleRouteJson) => {
  const rootConnectionIndex = new Map<string, string[]>()
  const addMapping = (identifier: string | undefined, rootName: string) => {
    if (!identifier) return
    const names = rootConnectionIndex.get(identifier) ?? []
    if (!names.includes(rootName)) names.push(rootName)
    rootConnectionIndex.set(identifier, names)
  }
  for (const connection of srj.connections) {
    const rootNames = connection.__rootConnectionNames ?? [connection.name]
    for (const rootName of rootNames) {
      addMapping(connection.name, rootName)
      addMapping(rootName, rootName)
      addMapping(connection.__netConnectionName, rootName)
      for (const point of connection.pointsToConnect) {
        addMapping(point.pointId, rootName)
        addMapping(point.pcb_port_id, rootName)
      }
    }
  }
  return (obstacle: Obstacle): string => {
    const rootNames = getUniqueValues([
      ...obstacle.connectedTo.flatMap(
        (identifier) => rootConnectionIndex.get(identifier) ?? [],
      ),
      ...(obstacle.offBoardConnectsTo ?? []).flatMap(
        (identifier) => rootConnectionIndex.get(identifier) ?? [],
      ),
    ])
    const rootLabel = rootNames.join(", ")
    return obstacle.layers
      .map((layerName) =>
        rootLabel ? `${layerName}\n${rootLabel}` : layerName,
      )
      .join("\n")
  }
}

export function visualizeSimpleRouteJson(srj: SimpleRouteJson): GraphicsObject {
  const layerNames = getCopperLayerNames(srj.layerCount)
  const hasArbitraryCopperLayer = (srj.traces ?? []).some((trace) =>
    trace.route.some((routePoint, routePointIndex) => {
      const nextRoutePoint = trace.route[routePointIndex + 1]
      return (
        routePoint.route_type === "wire" &&
        nextRoutePoint?.route_type === "wire" &&
        nextRoutePoint.layer === routePoint.layer &&
        !LEGACY_VISUALIZATION_LAYERS.has(routePoint.layer)
      )
    }),
  )
  const connectionNames = new Set(srj.connections.map(({ name }) => name))
  const traceOnlyConnections: SimpleRouteJson["connections"] =
    hasArbitraryCopperLayer
      ? [
          ...new Set(
            (srj.traces ?? [])
              .map(({ connection_name }) => connection_name)
              .filter(
                (connectionName) =>
                  connectionName && !connectionNames.has(connectionName),
              ),
          ),
        ].map((name) => ({ name, pointsToConnect: [] }))
      : []
  const visualizedConnections = [...srj.connections, ...traceOnlyConnections]
  const colorMap = getColorMap(visualizedConnections)
  const formatObstacleLabel = createObstacleLabelFormatter({
    ...srj,
    connections: visualizedConnections,
  })
  const lines: Line[] = []
  const circles: Circle[] = []
  const rects: Rect[] = []
  const points: Point[] = []

  for (const connection of visualizedConnections) {
    for (const point of connection.pointsToConnect) {
      const pointLayers = getPointLayers(point)
      const rootNames = connection.__rootConnectionNames ?? [connection.name]
      points.push({
        x: point.x,
        y: point.y,
        color: colorMap[connection.name]!,
        layer: getGraphicsLayer(layerNames, pointLayers),
        label: [
          connection.name,
          rootNames.join(", "),
          pointLayers.join(","),
        ].join("\n"),
      })
    }
  }

  for (const trace of srj.traces ?? []) {
    const jumpers = trace.route.filter(
      (routePoint) => routePoint.route_type === "jumper",
    )
    const isWireSegmentInsideJumper = (
      start: { x: number; y: number },
      end: { x: number; y: number },
    ): boolean =>
      jumpers.some((jumper) => {
        const tolerance = 0.01
        return (
          (Math.abs(start.x - jumper.start.x) < tolerance &&
            Math.abs(start.y - jumper.start.y) < tolerance &&
            Math.abs(end.x - jumper.end.x) < tolerance &&
            Math.abs(end.y - jumper.end.y) < tolerance) ||
          (Math.abs(start.x - jumper.end.x) < tolerance &&
            Math.abs(start.y - jumper.end.y) < tolerance &&
            Math.abs(end.x - jumper.start.x) < tolerance &&
            Math.abs(end.y - jumper.start.y) < tolerance)
        )
      })

    for (const routePoint of trace.route) {
      if (routePoint.route_type === "via") {
        const viaLayers = getViaLayerNames(
          layerNames,
          routePoint.from_layer,
          routePoint.to_layer,
        )
        circles.push({
          center: { x: routePoint.x, y: routePoint.y },
          radius: (routePoint.via_diameter ?? getViaPadDiameter(srj)) / 2,
          fill: hasArbitraryCopperLayer
            ? colorMap[trace.connection_name]!
            : "blue",
          stroke: "none",
          layer: getGraphicsLayer(layerNames, viaLayers),
        })
      } else if (routePoint.route_type === "through_obstacle") {
        lines.push({
          points: [routePoint.start, routePoint.end],
          strokeColor: transparentize(
            colorMap[trace.connection_name] ?? "purple",
            0.35,
          ),
          strokeWidth: routePoint.width,
          strokeDash: [0.1, 0.1],
          layer: getGraphicsLayer(layerNames, [
            routePoint.from_layer,
            routePoint.to_layer,
          ]),
          label: `${trace.connection_name} through_obstacle`,
        })
      }
    }

    for (
      let routePointIndex = 0;
      routePointIndex < trace.route.length - 1;
      routePointIndex++
    ) {
      const routePoint = trace.route[routePointIndex]!
      const nextRoutePoint = trace.route[routePointIndex + 1]!
      if (routePoint.route_type === "jumper") {
        const color =
          colorMap[trace.connection_name] ?? "rgba(255, 165, 0, 0.8)"
        const dimensions =
          JUMPER_DIMENSIONS[
            routePoint.footprint === "1206x4_pair" ? "1206x4_pair" : "0603"
          ]
        const horizontal =
          Math.abs(routePoint.end.x - routePoint.start.x) >
          Math.abs(routePoint.end.y - routePoint.start.y)
        const padWidth = horizontal ? dimensions.padLength : dimensions.padWidth
        const padHeight = horizontal
          ? dimensions.padWidth
          : dimensions.padLength
        const layer = getGraphicsLayer(layerNames, [routePoint.layer])
        for (const center of [routePoint.start, routePoint.end]) {
          rects.push({
            center,
            width: padWidth,
            height: padHeight,
            fill: transparentize(color, 0.5),
            stroke: "rgba(0, 0, 0, 0.5)",
            layer,
          })
        }
        lines.push({
          points: [routePoint.start, routePoint.end],
          strokeColor: "rgba(100, 100, 100, 0.8)",
          strokeWidth: dimensions.padWidth * 0.3,
          layer,
        })
      } else if (
        routePoint.route_type === "wire" &&
        nextRoutePoint.route_type === "wire" &&
        nextRoutePoint.layer === routePoint.layer &&
        !isWireSegmentInsideJumper(routePoint, nextRoutePoint)
      ) {
        const layerIndex = getLayerIndex(layerNames, routePoint.layer)
        lines.push({
          points: [
            { x: routePoint.x, y: routePoint.y },
            { x: nextRoutePoint.x, y: nextRoutePoint.y },
          ],
          layer: `z${layerIndex}`,
          strokeWidth: routePoint.width,
          strokeColor: getCopperLayerColor(layerIndex),
          ...(hasArbitraryCopperLayer ? { label: trace.connection_name } : {}),
        })
      }
    }
  }

  for (const obstacle of srj.obstacles) {
    if (obstacle.isCopperPour) continue
    const layerIndexes = getObstacleLayerIndexes(obstacle, layerNames)
    if (layerIndexes.length === 0) {
      throw new Error(
        `FanoutSolver: cannot visualize obstacle "${obstacle.obstacleId ?? "unknown"}" without a valid layer`,
      )
    }
    const onlyLayerName =
      layerIndexes.length === 1 ? layerNames[layerIndexes[0]!] : undefined
    const fill = transparentize(
      onlyLayerName === "bottom" ? "blue" : "red",
      0.5 ** layerIndexes.length,
    )
    const shape = (obstacle as Obstacle & { shape?: string }).shape
    const common = {
      center: obstacle.center,
      fill,
      layer: `z${layerIndexes.join(",")}`,
      label: formatObstacleLabel(obstacle),
    }
    if (shape === "circle") {
      circles.push({
        ...common,
        radius: Math.min(obstacle.width, obstacle.height) / 2,
      })
    } else {
      rects.push({
        ...common,
        width: obstacle.width,
        height: obstacle.height,
        ccwRotationDegrees: obstacle.ccwRotationDegrees,
      })
    }
  }

  for (const jumper of srj.jumpers ?? []) {
    for (const pad of jumper.pads) {
      rects.push({
        center: pad.center,
        width: pad.width,
        height: pad.height,
        ccwRotationDegrees: pad.ccwRotationDegrees,
        fill: "rgba(255, 165, 0, 0.3)",
        stroke: "rgba(255, 165, 0, 0.8)",
        layer: getGraphicsLayer(layerNames, pad.layers),
      })
    }
  }

  return { rects, circles, lines, points }
}
