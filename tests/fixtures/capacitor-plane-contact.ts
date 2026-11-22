import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"

// Board XY positions in mm, +X right and +Y up. A fixed top-side capacitor
// ground stub crosses a top GND island on its way to an inner1 through via.
export function createCapacitorPlaneContact() {
  const inputSrj: SimpleRouteJson = {
    layerCount: 6,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1.5, maxY: 1.5 },
    connections: [
      {
        name: "C1_GND",
        netConnectionName: "GND",
        pointsToConnect: [{ x: -1, y: 0, layer: "top", pointId: "C1.2" }],
      },
    ],
    obstacles: [
      {
        type: "rect",
        obstacleId: "C1.2",
        componentId: "C1",
        center: { x: -1, y: 0 },
        width: 0.55,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["C1_GND", "C1.2"],
      },
      {
        type: "rect",
        obstacleId: "C1.1",
        componentId: "C1",
        center: { x: -2.02, y: 0 },
        width: 0.55,
        height: 0.6,
        layers: ["top"],
        connectedTo: ["VDD"],
      },
      {
        type: "rect",
        obstacleId: "top-ground-island",
        isCopperPour: true,
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 0.8,
        layers: ["top"],
        connectedTo: ["GND"],
      },
      {
        type: "rect",
        obstacleId: "inner-ground-plane",
        isCopperPour: true,
        center: { x: 0, y: 0 },
        width: 6,
        height: 3,
        layers: ["inner1"],
        connectedTo: ["GND"],
      },
    ],
  }
  const [bus] = prepareFanoutBuses(inputSrj, {
    sharedBoundary: inputSrj.bounds,
    buses: [
      {
        busId: "C1_GND",
        connectionNames: ["C1_GND"],
        direction: "right",
        termination: { type: "plane", layer: "inner1" },
      },
    ],
  })
  const plan = buildViaMinimalWindingPlan({
    bus,
    terminal: {
      connection: bus.connections[0],
      viaPoint: { x: 1, y: 0 },
      exitPoint: { x: 1, y: 0 },
    },
    targetLayer: "inner1",
    targetLayerPoints: [{ x: 1, y: 0 }],
    sourceEscapePoints: [
      { x: -1, y: 0 },
      { x: -0.5, y: 0 },
      { x: 1, y: 0 },
    ],
    layerNames: ["top", "inner1", "inner2", "inner3", "inner4", "bottom"],
    traceWidth: 0.1,
    viaDiameter: 0.45,
    viaHoleDiameter: 0.2,
    allowBlindAndBuriedVias: false,
  })
  return {
    inputSrj,
    plan,
    rules: {
      srj: inputSrj,
      sharedBoundary: inputSrj.bounds,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    },
  }
}
