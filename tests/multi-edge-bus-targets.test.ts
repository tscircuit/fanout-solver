import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { getMultiEdgeBusTargets } from "lib/get-multi-edge-bus-targets"
import { getLayerReservedBusTargets } from "lib/route-layer-reserved-buses"
import type { PreparedBus, PreparedConnection } from "lib/types"

test("allocates flexible whole buses across layers before packing multiple boundary edges", async () => {
  const layerNames = ["top", "inner1", "inner2", "inner3", "bottom"]
  const boundary = { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 }
  const buses: PreparedBus[] = []
  let nextIndex = 0
  for (const edge of ["right", "top"] as const) {
    for (let group = 0; group < 3; group++) {
      const connections: PreparedConnection[] = [-0.9, 0, 0.9].map((track) => {
        const connectionIndex = nextIndex++
        const name = `signal-${connectionIndex}`
        const source = { x: -0.8 + group * 0.4, y: track / 2, layer: "top" }
        const target =
          edge === "right"
            ? { x: 1.5, y: track, layer: "bottom" }
            : { x: track, y: 1.5, layer: "bottom" }
        return {
          connectionIndex,
          connection: { name, pointsToConnect: [source, target] },
          sourcePointIndex: 0,
          sourcePoint: source,
          sourceLayer: "top",
          sourceObstacle: {
            obstacleId: name,
            componentId: "U1",
            type: "rect",
            center: source,
            width: 0.1,
            height: 0.1,
            layers: ["top"],
            connectedTo: [name],
          },
          targetPoint: target,
          exitTargetPoint: target,
          hasExplicitLayeredExitTarget: true,
        }
      })
      buses.push({
        busId: `${edge}-${group}`,
        direction: edge === "top" ? "up" : "right",
        exitEdge: edge,
        preferredExit: edge,
        allowedLayers: ["top", "inner2", "inner3", "bottom"],
        routableEscapeLayers: ["top", "inner2", "inner3", "bottom"],
        termination: { type: "boundary" },
        connections,
        componentId: "U1",
        componentObstacles: connections.map((c) => c.sourceObstacle),
        componentBounds: boundary,
        sharedBoundary: boundary,
        xCoordinates: [-0.8, -0.4, 0],
        yCoordinates: [-0.45, 0, 0.45],
        pitchX: 0.4,
        pitchY: 0.45,
      })
    }
  }
  buses[0] = {
    ...buses[0]!,
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
  }
  const plane: PreparedBus = {
    ...buses[0]!,
    busId: "POWER",
    connections: [],
    termination: { type: "plane", layer: "inner1" },
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
  }
  const allBuses = [...buses, plane]
  const original = structuredClone(allBuses)
  const srj: SimpleRouteJson = {
    layerCount: layerNames.length,
    bounds: boundary,
    minTraceWidth: 0.08,
    connections: buses.flatMap((b) => b.connections.map((c) => c.connection)),
    obstacles: buses.flatMap((b) => b.componentObstacles),
  }
  const params = {
    buses: allBuses,
    srj,
    layerNames,
    traceWidth: 0.08,
    clearance: 0.08,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  expect(() => getLayerReservedBusTargets(params)).toThrow("do not fit")
  const targets = getMultiEdgeBusTargets(params)!
  expect(targets).not.toBeNull()
  expect(targets.targetLayerByBusId.get("POWER")).toBe("inner1")
  expect(targets.targetLayerByBusId.get("right-0")).toBe("bottom")
  expect(targets.exits.size).toBe(18)
  expect(allBuses).toEqual(original)
  const layers = ["inner2", "inner3", "bottom"]
  for (const edge of ["right", "top"])
    expect(
      new Set(
        buses
          .filter((b) => b.exitEdge === edge)
          .map((b) => targets.targetLayerByBusId.get(b.busId)),
      ).size,
    ).toBe(3)
  for (const bus of buses) {
    const layer = targets.targetLayerByBusId.get(bus.busId)!
    expect(bus.routableEscapeLayers).toContain(layer)
    expect(layer).not.toBe("top")
    for (const c of bus.connections)
      expect(targets.exits.get(c.connectionIndex)).toEqual({
        x: c.exitTargetPoint!.x,
        y: c.exitTargetPoint!.y,
      })
  }
  expect(
    getMultiEdgeBusTargets({
      ...params,
      buses: buses.map((bus) => ({
        ...bus,
        allowedLayers: ["top", "bottom"],
        routableEscapeLayers: ["top", "bottom"],
      })),
    }),
  ).toBeNull()
  const colors = [
    "#2563eb",
    "#059669",
    "#d97706",
    "#9333ea",
    "#db2777",
    "#0891b2",
  ]
  const graphics: GraphicsObject = {
    title: "Whole bus exit intervals on three permitted layers",
    lines: [],
    circles: [],
    texts: [],
  }
  for (const [panel, layer] of layers.entries()) {
    const offset = panel * 4
    graphics.texts!.push({ x: offset, y: 1.8, text: layer, fontSize: 0.2 })
    graphics.lines!.push({
      points: [
        { x: offset - 1.5, y: -1.5 },
        { x: offset + 1.5, y: -1.5 },
        { x: offset + 1.5, y: 1.5 },
        { x: offset - 1.5, y: 1.5 },
        { x: offset - 1.5, y: -1.5 },
      ],
      strokeColor: "#cbd5e1",
      strokeWidth: 0.025,
    })
    for (const [index, bus] of buses.entries()) {
      if (targets.targetLayerByBusId.get(bus.busId) !== layer) continue
      const points = bus.connections.map((c) => {
        const p = targets.exits.get(c.connectionIndex)!
        return { x: p.x + offset, y: p.y }
      })
      graphics.lines!.push({
        points,
        strokeColor: colors[index],
        strokeWidth: 0.08,
      })
      graphics.circles!.push(
        ...points.map((center) => ({
          center,
          radius: 0.055,
          fill: colors[index],
        })),
      )
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
