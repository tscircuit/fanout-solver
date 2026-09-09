import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("keeps prior-phase copper hard without requiring its old connection in the current phase", () => {
  const config = {
    traceWidth: 0.04,
    clearance: 0.04,
    viaDiameter: 0.08,
    viaHoleDiameter: 0.04,
    layerNames: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const sharedBoundary = { minX: -1, maxX: 2, minY: -1, maxY: 1 }
  const pad: Obstacle & { shape: "circle" } = {
    type: "rect",
    shape: "circle",
    center: { x: 0.6, y: 0.2 },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    connectedTo: ["current"],
  }
  const sourcePoint = { ...pad.center, layer: "top" }
  const targetPoint = { x: 3, y: 0.2, layer: "bottom" }
  const connection: PreparedConnection = {
    connection: {
      name: "current",
      pointsToConnect: [sourcePoint, targetPoint],
    },
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint,
    targetPoint,
    sourceLayer: "top",
    sourceObstacle: pad,
  }
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    componentId: "U1",
    componentObstacles: [pad],
    componentBounds: { minX: 0.56, maxX: 0.64, minY: 0.16, maxY: 0.24 },
    sharedBoundary,
    xCoordinates: [0.6],
    yCoordinates: [0.2],
    pitchX: 0.4,
    pitchY: 0.4,
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections: [connection],
  }
  const priorTrace = {
    type: "pcb_trace" as const,
    pcb_trace_id: "previous-phase-copper",
    connection_name: "completed-previous-phase",
    route: [-0.8, -0.4].map((y) => ({
      route_type: "wire" as const,
      x: 1,
      y,
      width: config.traceWidth,
      layer: "bottom",
    })),
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: config.traceWidth,
    bounds: sharedBoundary,
    obstacles: [pad],
    connections: [connection.connection],
    traces: [priorTrace],
  }
  const plan = buildViaMinimalWindingPlan({
    ...config,
    bus,
    terminal: {
      connection,
      viaPoint: { x: 0, y: 0.2 },
      exitPoint: { x: 2, y: 0.2 },
    },
    targetLayer: "bottom",
    targetLayerPoints: [
      { x: 0, y: 0.2 },
      { x: 2, y: 0.2 },
    ],
  })
  const before = structuredClone({ inputSrj, plan })
  const repaired = repairBoundaryRouteTails({
    ...config,
    inputSrj,
    preparedBuses: [bus],
    plans: [plan],
  })
  expect(repaired).toEqual([plan])
  expect({ inputSrj, plan }).toEqual(before)
  const blockedInput = {
    ...inputSrj,
    traces: [
      {
        ...priorTrace,
        route: [0, 0.4].map((y) => ({ ...priorTrace.route[0]!, y })),
      },
    ],
  }
  expect(
    repairBoundaryRouteTails({
      ...config,
      inputSrj: blockedInput,
      preparedBuses: [bus],
      plans: [plan],
    }),
  ).toBeNull()
  expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...buildOutputSimpleRouteJson({
          inputSrj,
          plans: repaired!,
          layerNames: config.layerNames,
        }),
        connections: [],
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
