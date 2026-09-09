import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("joint routing keeps each crossing bus atomic on its mapped final layer", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    layerNames: ["top", "inner1", "bottom"],
  }
  const points = [
    { x: -2, y: -0.5 },
    { x: -2, y: 0.5 },
    { x: -0.5, y: -2 },
    { x: 0.5, y: -2 },
  ]
  const ends = [
    { x: 3, y: -0.5 },
    { x: 3, y: 0.5 },
    { x: -0.5, y: 3 },
    { x: 0.5, y: 3 },
  ]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 3,
    minTraceWidth: rules.traceWidth,
    connections: points.map((p, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...p, layer: "top", pointId: `P${i}` },
        { ...ends[i]!, layer: i < 2 ? "bottom" : "inner1" },
      ],
    })),
    obstacles: points.map((p, i) => ({
      type: "rect",
      center: p,
      width: 0.2,
      height: 0.2,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  const allBuses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "horizontal",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom"],
      },
      {
        busId: "vertical",
        sourceComponentId: "U1",
        connectionNames: ["N2", "N3"],
        direction: "up",
        preferredExit: "top",
        allowedLayers: ["inner1"],
      },
    ],
  })
  const fixed = new Map(
    points.map((p, i) => [
      i,
      i < 2 ? { x: p.x + 0.5, y: p.y } : { x: p.x, y: p.y + 0.5 },
    ]),
  )
  const targets = new Map([
    ["horizontal", "bottom"],
    ["vertical", "inner1"],
  ])
  const params = {
    ...rules,
    srj,
    allBuses,
    buses: allBuses,
    targetLayer: "bottom",
    targetLayerByBusId: targets,
    fixedViaPointsByConnectionIndex: fixed,
    acceptedPlans: [],
    terminals: allBuses.flatMap((b) =>
      b.connections.map((c) => ({
        connection: c,
        viaPoint: fixed.get(c.connectionIndex)!,
        exitPoint: ends[c.connectionIndex]!,
      })),
    ),
    maximumIterations: 200_000,
  }
  const original = JSON.stringify({
    srj,
    allBuses,
    fixed: [...fixed],
    targets: [...targets],
  })
  const solve = (
    extra: Partial<typeof params> & { routeFromSourcePads?: boolean } = {},
  ) => {
    const g = routeReservedViaBusesSteps({ ...params, ...extra })
    let n = g.next()
    while (!n.done) n = g.next()
    return n.value
  }
  const plans = solve()!
  expect(plans).toHaveLength(4)
  for (const p of plans) {
    expect(p.targetLayer).toBe(targets.get(p.busId)!)
    expect(p.via!.center).toEqual(fixed.get(p.connectionIndex)!)
    expect(p.trace.route.at(-1)).toMatchObject({
      ...ends[p.connectionIndex]!,
      layer: p.targetLayer,
    })
    expect(
      p.segments.every((s) => s.layer === "top" || s.layer === p.targetLayer),
    ).toBe(true)
    for (let i = 0; i < p.segments.length; i++) {
      const s = p.segments[i]!,
        dx = s.end.x - s.start.x,
        dy = s.end.y - s.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const n = p.segments[i + 1]
      if (n?.layer === s.layer)
        expect(
          (dx * (n.end.x - n.start.x) + dy * (n.end.y - n.start.y)) /
            (Math.hypot(dx, dy) *
              Math.hypot(n.end.x - n.start.x, n.end.y - n.start.y)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const output = { ...srj, traces: plans.map((p) => p.trace) }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 4 })
  const free = solve({ routeFromSourcePads: true })!
  expect(free).toHaveLength(4)
  expect(
    free.every(
      (p) =>
        p.targetLayer === targets.get(p.busId) &&
        p.trace.route.at(-1)?.route_type === "wire",
    ),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: { ...srj, traces: free.map((p) => p.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    solve({ targetLayerByBusId: new Map([["horizontal", "bottom"]]) }),
  ).toBeNull()
  expect(
    solve({
      targetLayerByBusId: new Map([
        ["horizontal", "bottom"],
        ["vertical", "bottom"],
      ]),
    }),
  ).toBeNull()
  expect(
    solve({
      targetLayerByBusId: new Map([
        ["horizontal", "bottom"],
        ["vertical", "top"],
      ]),
    }),
  ).toBeNull()
  expect(solve({ targetLayerByBusId: undefined })).toBeNull()
  expect(
    JSON.stringify({ srj, allBuses, fixed: [...fixed], targets: [...targets] }),
  ).toBe(original)
  await expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(output)),
  ).toMatchSvgSnapshot(import.meta.path)
})
