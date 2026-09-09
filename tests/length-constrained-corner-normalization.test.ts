import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"

test("corner cleanup preserves matched lengths or physically retunes their lost margin", async () => {
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

  // Two chamfers together exceed the remaining matching margin even at the
  // minimum trim. Keep real corner geometry and recover the lost length.
  const tightBus = { ...bus, maxLengthSkew: oldSkew + 0.000001 }
  const tightParams = {
    ...rules,
    inputSrj,
    plans,
    preparedBuses: [tightBus],
    layerNames,
  }
  expect(normalizeFanoutPlanCorners(tightParams)).toBeNull()
  const rematched = normalizeFanoutPlanCorners({
    ...tightParams,
    rematchRepairedLengths: (repaired) =>
      matchBusPlanLengths({
        inputSrj,
        plans: repaired,
        preparedBuses: [tightBus],
        sharedBoundary: bounds,
        clearance: rules.clearance,
        maximumWorkUnits: 1000,
        allowMatchingInsideDenseBounds: true,
      }).plans,
  })
  expect(rematched).not.toBeNull()
  expectStraightOr45Fanout(rematched!.map((p) => p.trace))
  expect(
    Math.abs(rematched![0]!.length - rematched![1]!.length),
  ).toBeLessThanOrEqual(tightBus.maxLengthSkew + 1e-7)
  for (let i = 0; i < 2; i++) {
    expect(rematched![i]!.via).toBe(plans[i]!.via)
    expect(rematched![i]!.sourcePoint).toBe(plans[i]!.sourcePoint)
    expect(rematched![i]!.exitPoint).toBe(plans[i]!.exitPoint)
  }
  expect(JSON.stringify({ inputSrj, plans, buses })).toBe(before)
  const output = buildOutputSimpleRouteJson({
    inputSrj,
    plans: rematched!,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
