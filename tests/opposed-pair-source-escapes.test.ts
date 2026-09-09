import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  getOpposedPairSourceGroups,
  hasOpposedPairSourceEscapes,
} from "lib/opposed-pair-source-escapes"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("multiple tight pairs split between advancing local vias and opposite-edge remote vias select joint source routing", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const sources = [
    { x: -0.65, y: 0.65 },
    { x: -0.65, y: 1.3 },
    { x: 0.65, y: 0.65 },
    { x: 0.65, y: 1.3 },
  ]
  const viaPoints = [
    { x: -0.975, y: 0.325 },
    { x: -0.325, y: 2.2 },
    { x: 0.975, y: 0.325 },
    { x: 0.325, y: 2.2 },
  ]
  const targetXs = [-1.4, -1, 1.4, 1]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    obstacles: [],
    connections: sources.map((point, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        { ...point, layer: "top", pcb_port_id: `P${index}` },
        { x: targetXs[index]!, y: -3, layer: "inner2" },
      ],
    })),
  }
  for (let row = -2; row <= 2; row++)
    for (let column = -2; column <= 2; column++) {
      const center = { x: column * 0.65, y: row * 0.65 },
        index = sources.findIndex(
          (source) =>
            Math.hypot(source.x - center.x, source.y - center.y) < 1e-7,
        )
      srj.obstacles.push({
        type: "rect",
        shape: "circle",
        obstacleId: index < 0 ? `unused-${row}-${column}` : `P${index}`,
        componentId: "U1",
        center,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: index < 0 ? [] : [`N${index}`, `P${index}`],
      } as SimpleRouteJson["obstacles"][number])
    }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    componentBounds: { U1: { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 } },
    escapeLayers: layerNames,
    buses: [0, 1].map((index) => ({
      busId: `pair-${index}`,
      connectionNames: [`N${index * 2}`, `N${index * 2 + 1}`],
      sourceComponentId: "U1",
      direction: "down",
      preferredExit: "bottom",
      exitEdge: "bottom",
      allowedLayers: ["inner2"],
      maxLengthSkew: 0.25,
    })),
  })
  const fixedViaPointsByConnectionIndex = new Map(
    viaPoints.map((point, index) => [index, point]),
  )
  const params = {
    buses,
    fixedViaPointsByConnectionIndex,
    clearance: rules.clearance,
  }
  const before = JSON.stringify({
    srj,
    buses,
    sites: [...fixedViaPointsByConnectionIndex],
  })
  expect(hasOpposedPairSourceEscapes(params)).toBe(true)
  const initialGroups = getOpposedPairSourceGroups({
    ...params,
    groups: [buses],
  })
  expect(initialGroups).toEqual([buses])
  expect(initialGroups[0]).toBe(buses)
  // One opposed pair in each different target-layer group does not produce
  // the repeated shared-corridor condition used for the initial search order.
  expect(
    getOpposedPairSourceGroups({
      ...params,
      groups: buses.map((bus) => [bus]),
    }),
  ).toEqual([])
  expect(
    getOpposedPairSourceGroups({
      ...params,
      groups: [
        buses.map((bus) => ({ ...bus, allowedLayers: ["inner1", "inner2"] })),
      ],
    }),
  ).toEqual([])

  expect(hasOpposedPairSourceEscapes({ ...params, buses: [buses[0]!] })).toBe(
    false,
  )
  expect(
    hasOpposedPairSourceEscapes({
      ...params,
      buses: buses.map((bus) => ({ ...bus, maxLengthSkew: 1 })),
    }),
  ).toBe(false)
  expect(
    hasOpposedPairSourceEscapes({
      ...params,
      buses: buses.map((bus) => ({
        ...bus,
        allowedLayers: ["inner1", "inner2"],
      })),
    }),
  ).toBe(false)
  expect(
    hasOpposedPairSourceEscapes({
      ...params,
      fixedViaPointsByConnectionIndex: new Map(
        [...fixedViaPointsByConnectionIndex].map(([index, point]) => [
          index,
          index % 2 ? { ...point, y: 1.1 } : point,
        ]),
      ),
    }),
  ).toBe(false)
  expect(
    hasOpposedPairSourceEscapes({
      ...params,
      fixedViaPointsByConnectionIndex: new Map(
        [...fixedViaPointsByConnectionIndex].map(([index, point]) => [
          index,
          index % 2 ? point : { ...point, y: 0.975 },
        ]),
      ),
    }),
  ).toBe(false)
  const rotate = ({ x, y }: { x: number; y: number }) => ({ x: -y, y: x })
  expect(
    hasOpposedPairSourceEscapes({
      ...params,
      buses: buses.map((bus) => ({
        ...bus,
        exitEdge: "right",
        componentBounds: {
          minX: -bus.componentBounds.maxY,
          maxX: -bus.componentBounds.minY,
          minY: bus.componentBounds.minX,
          maxY: bus.componentBounds.maxX,
        },
        connections: bus.connections.map((connection) => ({
          ...connection,
          sourcePoint: {
            ...connection.sourcePoint,
            ...rotate(connection.sourcePoint),
          },
        })),
      })),
      fixedViaPointsByConnectionIndex: new Map(
        [...fixedViaPointsByConnectionIndex].map(([index, point]) => [
          index,
          rotate(point),
        ]),
      ),
    }),
  ).toBe(true)
  // A physical pre-matching witness: these four fixed-via routes clear every
  // pad and barrel, but the opposed source escapes create substantial skew.
  const plans = buses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const index = connection.connectionIndex,
        source = sources[index]!,
        viaPoint = viaPoints[index]!,
        target = { x: targetXs[index]!, y: -3 }
      const prefix =
        index % 2
          ? [source, { x: viaPoint.x, y: 1.625 }, viaPoint]
          : [source, viaPoint]
      return buildViaMinimalWindingPlan({
        ...rules,
        layerNames,
        bus,
        terminal: { connection, viaPoint, exitPoint: target },
        targetLayer: "inner2",
        sourceEscapePoints: prefix,
        targetLayerPoints: [
          viaPoint,
          { x: viaPoint.x, y: -3 + Math.abs(viaPoint.x - target.x) },
          target,
        ],
        allowBlindAndBuriedVias: false,
      })
    }),
  )
  for (const bus of buses) {
    const own = plans.filter((plan) => plan.busId === bus.busId)
    expect(own).toHaveLength(2)
    expect(Math.abs(own[0]!.length - own[1]!.length)).toBeGreaterThan(
      bus.maxLengthSkew!,
    )
    for (const plan of own) {
      expect(plan.via!.spanLayers).toEqual(layerNames)
      expect(plan.exitPoint).toEqual({
        x: targetXs[plan.connectionIndex]!,
        y: -3,
      })
      for (const [index, segment] of plan.segments.entries()) {
        const dx = segment.end.x - segment.start.x,
          dy = segment.end.y - segment.start.y
        expect(
          Math.abs(dx) < 1e-7 ||
            Math.abs(dy) < 1e-7 ||
            Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7,
        ).toBe(true)
        const previous = plan.segments[index - 1]
        if (previous && previous.layer === segment.layer) {
          const px = previous.end.x - previous.start.x,
            py = previous.end.y - previous.start.y
          expect(
            (px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)),
          ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
        }
      }
    }
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 4,
    checkedViaCount: 4,
  })
  expect(
    JSON.stringify({ srj, buses, sites: [...fixedViaPointsByConnectionIndex] }),
  ).toBe(before)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
