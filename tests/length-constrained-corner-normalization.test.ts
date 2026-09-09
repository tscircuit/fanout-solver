import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("a corner chamfer preserves the remaining length margin of a matched bus", () => {
  const bounds = { minX: -2, maxX: 3, minY: -2, maxY: 2 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: -0.325, y: -0.325 },
    { x: -0.325, y: -1.325 },
  ]
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((p, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...p, layer: "top", pcb_port_id: `P${i}`, pointId: `P${i}` },
        { x: 3, y: i === 0 ? 1 : -1, layer: "inner1" },
      ],
    })),
    obstacles: sources.map((center, i) => ({
      type: "rect",
      center,
      width: 0.254,
      height: 0.254,
      layers: ["top"],
      componentId: "U",
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  const buses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["inner1"],
      },
    ],
  })
  const bus = buses[0]!
  bus.exitEdge = "right"
  const paths = [
    [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.8 },
      { x: 0.21, y: 0.8 },
      { x: 0.21, y: 0.81 },
      { x: 0.4, y: 1 },
      { x: 3, y: 1 },
    ],
    [
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 1.5, y: 0 },
      { x: 2.5, y: -1 },
      { x: 3, y: -1 },
    ],
  ]
  const plans = bus.connections.map((connection) => {
    const path = paths[connection.connectionIndex]!
    return buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: { connection, viaPoint: path[0]!, exitPoint: path.at(-1)! },
      targetLayer: "inner1",
      targetLayerPoints: path,
      allowBlindAndBuriedVias: false,
    })
  })
  const oldSkew = Math.abs(plans[0]!.length - plans[1]!.length)
  bus.maxLengthSkew = oldSkew + 0.000002
  const before = JSON.stringify({ inputSrj, plans, buses })
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    plans,
    preparedBuses: buses,
    layerNames,
  })
  expect(normalized).not.toBeNull()
  expect(JSON.stringify({ inputSrj, plans, buses })).toBe(before)
  expect(plans[0]!.length - normalized![0]!.length).toBeGreaterThan(0)
  expect(
    Math.abs(normalized![0]!.length - normalized![1]!.length),
  ).toBeLessThanOrEqual(bus.maxLengthSkew)
  expect(normalized![1]).toBe(plans[1])
  for (let i = 0; i < 2; i++) expect(normalized![i]!.via).toBe(plans[i]!.via)
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: normalized!.map((p) => p.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
})
