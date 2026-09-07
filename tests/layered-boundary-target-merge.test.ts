import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  boundaryTargetsPreserveLayerOrder,
  mergeLayeredBoundaryTargets,
} from "lib/merge-layered-boundary-targets"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("merges layered lane sequences into clear routes without changing any packed track or within-layer order", async () => {
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  }
  const bounds = { minX: -1, maxX: 4, minY: -2, maxY: 2 }
  const canonical = [-1.25, -0.25, 0.75, -0.75, 0.25, 1.25]
  const connections: PreparedConnection[] = canonical.map((track, index) => {
    const source = { x: 0.5, y: (index - 2.5) * 0.5, layer: "top" },
      target = { x: 4, y: track, layer: index < 3 ? "inner1" : "inner2" },
      name = `N${index}`
    return {
      connectionIndex: index,
      connection: { name, pointsToConnect: [source, target] },
      sourcePoint: source,
      sourcePointIndex: 0,
      sourceLayer: "top",
      targetPoint: target,
      exitTargetPoint: target,
      hasExplicitLayeredExitTarget: true,
      sourceObstacle: {
        type: "rect",
        obstacleId: name,
        componentId: "U1",
        center: source,
        width: 0.15,
        height: 0.15,
        layers: ["top"],
        connectedTo: [name],
      },
    }
  })
  const bus: PreparedBus = {
    busId: "DATA",
    componentId: "U1",
    connections,
    componentObstacles: connections.map((c) => c.sourceObstacle),
    componentBounds: { minX: -1, maxX: 1, minY: -1.5, maxY: 1.5 },
    sharedBoundary: bounds,
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    allowedLayers: ["inner1", "inner2", "bottom"],
    routableEscapeLayers: ["inner1", "inner2", "bottom"],
    termination: { type: "boundary" },
    xCoordinates: [0.5],
    yCoordinates: connections.map((c) => c.sourcePoint.y),
    pitchX: 0.5,
    pitchY: 0.5,
  }
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((c) => c.connection),
    obstacles: bus.componentObstacles,
  }
  const exits = new Map(
    connections.map((c) => [
      c.connectionIndex,
      { x: 4, y: c.exitTargetPoint!.y },
    ]),
  )
  const original = JSON.stringify({ bus, srj, exits: [...exits] })
  const merged = mergeLayeredBoundaryTargets({ buses: [bus], exits })
  expect(merged).not.toEqual(exits)
  expect([...merged.values()].map((p) => p.y).sort()).toEqual(
    [...exits.values()].map((p) => p.y).sort(),
  )
  expect(boundaryTargetsPreserveLayerOrder(bus, merged)).toBe(true)
  expect(
    mergeLayeredBoundaryTargets({
      buses: [bus],
      exits,
      maximumSearchStates: 1,
    }),
  ).toEqual(exits)
  expect(
    mergeLayeredBoundaryTargets({
      buses: [
        {
          ...bus,
          connections: connections.map((c) => ({
            ...c,
            hasExplicitLayeredExitTarget: false,
          })),
        },
      ],
      exits,
    }),
  ).toEqual(exits)
  const invalid = new Map(merged)
  invalid.set(0, merged.get(1)!)
  invalid.set(1, merged.get(0)!)
  expect(boundaryTargetsPreserveLayerOrder(bus, invalid)).toBe(false)
  expect(boundaryTargetsPreserveLayerOrder(bus, new Map())).toBe(false)
  const plans = connections.map((connection) => {
    const viaPoint = { x: 0.8, y: connection.sourcePoint.y },
      exitPoint = merged.get(connection.connectionIndex)!
    expect(exitPoint.y).toBe(connection.sourcePoint.y)
    expect(exitPoint.x).toBe(exits.get(connection.connectionIndex)!.x)
    return buildViaMinimalWindingPlan({
      ...rules,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: [viaPoint, exitPoint],
      allowBlindAndBuriedVias: false,
    })
  })
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: rules.layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: [bus],
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    plans.every((p) => p.segments.every((s) => s.start.y === s.end.y)),
  ).toBe(true)
  expect(JSON.stringify({ bus, srj, exits: [...exits] })).toBe(original)
  expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(output)),
  ).toMatchSvgSnapshot(import.meta.path)
})
