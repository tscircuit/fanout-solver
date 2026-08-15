import type { AnyCircuitElement } from "circuit-json"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

type PcbSvgFromSrjOptions = {
  deduplicateTraceIds?: boolean
}

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

const getObstacleBounds = (obstacles: SimpleRouteJson["obstacles"]) => ({
  minX: Math.min(
    ...obstacles.map((obstacle) => obstacle.center.x - obstacle.width / 2),
  ),
  maxX: Math.max(
    ...obstacles.map((obstacle) => obstacle.center.x + obstacle.width / 2),
  ),
  minY: Math.min(
    ...obstacles.map((obstacle) => obstacle.center.y - obstacle.height / 2),
  ),
  maxY: Math.max(
    ...obstacles.map((obstacle) => obstacle.center.y + obstacle.height / 2),
  ),
})

/**
 * Render actual emitted SRJ copper as a PCB. Every pad, package outline, trace,
 * and via is derived from the fixture or solver output; this helper adds no
 * explanatory geometry.
 */
export function getPcbSvgFromSrj(
  inputSrj: SimpleRouteJson,
  outputSrj: SimpleRouteJson,
  options: PcbSvgFromSrjOptions = {},
): string {
  const circuitJson: Array<Record<string, unknown>> = []
  const { bounds } = inputSrj
  circuitJson.push({
    type: "pcb_board",
    pcb_board_id: "pcb_board_fanout_fixture",
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    thickness: 1.6,
    num_layers: inputSrj.layerCount,
    material: "fr4",
  })

  const obstaclesByComponent = new Map<string, SimpleRouteJson["obstacles"]>()
  for (const obstacle of inputSrj.obstacles) {
    const componentId = obstacle.componentId ?? "unassigned"
    const componentObstacles = obstaclesByComponent.get(componentId) ?? []
    componentObstacles.push(obstacle)
    obstaclesByComponent.set(componentId, componentObstacles)

    circuitJson.push({
      type: "pcb_smtpad",
      pcb_smtpad_id: safeId(obstacle.obstacleId ?? `pad_${circuitJson.length}`),
      shape: "rect",
      x: obstacle.center.x,
      y: obstacle.center.y,
      width: obstacle.width,
      height: obstacle.height,
      layer: obstacle.layers[0] === "bottom" ? "bottom" : "top",
    })
  }

  for (const [componentId, obstacles] of obstaclesByComponent) {
    const componentBounds = getObstacleBounds(obstacles)
    const center = {
      x: (componentBounds.minX + componentBounds.maxX) / 2,
      y: (componentBounds.minY + componentBounds.maxY) / 2,
    }
    const width = componentBounds.maxX - componentBounds.minX + 0.5
    const height = componentBounds.maxY - componentBounds.minY + 0.5
    const pcbComponentId = `pcb_component_${safeId(componentId)}`
    const sourceComponentId = `source_component_${safeId(componentId)}`
    circuitJson.push(
      {
        type: "source_component",
        source_component_id: sourceComponentId,
        name: componentId,
        ftype: "simple_chip",
      },
      {
        type: "pcb_component",
        pcb_component_id: pcbComponentId,
        source_component_id: sourceComponentId,
        center,
        width,
        height,
        rotation: 0,
        layer: "top",
        obstructs_within_bounds: false,
      },
      {
        type: "pcb_silkscreen_rect",
        pcb_silkscreen_rect_id: `silkscreen_${safeId(componentId)}`,
        pcb_component_id: pcbComponentId,
        center,
        width,
        height,
        stroke_width: 0.12,
        layer: "top",
      },
    )
  }

  const traces = options.deduplicateTraceIds
    ? [
        ...new Map(
          (outputSrj.traces ?? []).map((trace) => [trace.pcb_trace_id, trace]),
        ).values(),
      ]
    : (outputSrj.traces ?? [])

  for (const trace of traces) {
    circuitJson.push({
      type: "pcb_trace",
      pcb_trace_id: trace.pcb_trace_id,
      source_trace_id: trace.connection_name,
      route: trace.route.filter(
        (segment) =>
          segment.route_type === "wire" || segment.route_type === "via",
      ),
    })
    trace.route.forEach((segment, segmentIndex) => {
      if (segment.route_type !== "via") return
      circuitJson.push({
        type: "pcb_via",
        pcb_via_id: `pcb_via_${safeId(trace.pcb_trace_id)}_${segmentIndex}`,
        pcb_trace_id: trace.pcb_trace_id,
        x: segment.x,
        y: segment.y,
        outer_diameter:
          segment.via_diameter ?? outputSrj.minViaPadDiameter ?? 0.3,
        hole_diameter:
          segment.via_hole_diameter ?? outputSrj.minViaHoleDiameter ?? 0.15,
        layers: [segment.from_layer, segment.to_layer],
      })
    })
  }

  return convertCircuitJsonToPcbSvg(circuitJson as AnyCircuitElement[], {
    width: 1200,
    height: 800,
    matchBoardAspectRatio: true,
    backgroundColor: "#0d1218",
    drawPaddingOutsideBoard: true,
    showSolderMask: true,
    shouldDrawRatsNest: false,
    includeVersion: true,
    colorOverrides: {
      boardOutline: "#68a68b",
      substrate: "#15352b",
      silkscreen: { top: "#f2eee5" },
      copper: { top: "#e9a23b" },
    },
  })
}
