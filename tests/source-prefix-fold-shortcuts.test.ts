import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { distance, distanceSegmentToObstacle } from "lib/geometry"
import { createPlanWithSegments } from "lib/match-bus-lengths"
import { changedFanoutCopperIsSelfClear } from "lib/normalize-fanout-plan-corners"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { createFanoutPlanClearanceValidator } from "lib/route-bus"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { getSourcePadReentries } from "lib/source-pad-reentry"
import { sourcePrefixFoldShortcuts } from "lib/source-prefix-fold-shortcuts"
import type { Point2D } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

function fixture(rotated = false, blocked = false) {
  const rotate = (p: Point2D) => (rotated ? { x: -p.y, y: p.x } : p)
  const layerNames = ["top", "bottom"]
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
  }
  const bounds = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
  const points = [
    { x: 0, y: 0.8 },
    { x: 0, y: 0.4 },
    { x: -0.08, y: 0.32 },
    { x: -0.08, y: 0.28 },
    { x: -0.02, y: 0.22 },
    { x: -0.02, y: 0.18 },
    { x: -0.1, y: 0.1 },
    { x: -0.1, y: -0.5 },
  ].map(rotate)
  const viaPoint = points.at(-1)!,
    exitPoint = rotate({ x: -0.1, y: -2 })
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: rules.traceWidth,
    connections: [
      {
        name: "folded-lead",
        pointsToConnect: [
          { ...points[0]!, layer: "top" },
          { ...exitPoint, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: points[0]!,
        width: 0.12,
        height: 0.12,
        layers: ["top"],
        connectedTo: ["folded-lead"],
        componentId: "U1",
      },
      ...(blocked
        ? [
            {
              type: "rect" as const,
              center: rotate({ x: 0, y: 0.5 }),
              width: rotated ? 0.05 : 3.9,
              height: rotated ? 3.9 : 0.05,
              layers: ["top"],
              connectedTo: [],
            },
          ]
        : []),
    ],
  }
  const buses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signal",
        sourceComponentId: "U1",
        connectionNames: ["folded-lead"],
        direction: rotated ? "right" : "down",
        preferredExit: rotated ? "right" : "bottom",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const plan = buildViaMinimalWindingPlan({
    ...rules,
    layerNames,
    bus: buses[0]!,
    terminal: { connection: buses[0]!.connections[0]!, viaPoint, exitPoint },
    targetLayer: "bottom",
    targetLayerPoints: [viaPoint, exitPoint],
    sourceEscapePoints: points,
    allowBlindAndBuriedVias: false,
  })
  const clear = createFanoutPlanClearanceValidator({
    srj: inputSrj,
    sharedBoundary: bounds,
    clearance: rules.clearance,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  })
  const proposals = [...sourcePrefixFoldShortcuts(plan, rules.clearance)]
  const repaired =
    proposals.flatMap((points) => {
      const normalized = normalizeLayeredPath({
        points: points.map((p) => ({ ...p, z: 0 })),
        chamfer: rules.traceWidth / 2,
        segmentIsClear: (start, end) =>
          inputSrj.obstacles.every(
            (obstacle) =>
              obstacle === plan.sourceObstacle ||
              distanceSegmentToObstacle(
                {
                  start,
                  end,
                  width: rules.traceWidth,
                  layer: "top",
                },
                obstacle,
              ) >=
                rules.traceWidth / 2 + rules.clearance - 1e-7,
          ),
      })
      if (!normalized) return []
      const prefix = normalized.slice(1).map((end, i) => ({
        start: normalized[i]!,
        end,
        width: rules.traceWidth,
        layer: "top",
      }))
      const candidate = createPlanWithSegments(
        plan,
        [...prefix, ...plan.segments.slice(plan.sourceEscapeSegmentCount)],
        true,
      )!
      candidate.sourceEscapeSegmentCount = prefix.length
      return getSourcePadReentries(candidate, rules.clearance).length === 0 &&
        changedFanoutCopperIsSelfClear(
          candidate,
          candidate.segments,
          rules.clearance,
          new Set(prefix.map((_, i) => i)),
        ) &&
        clear([candidate])
        ? [candidate]
        : []
    })[0] ?? null
  return { inputSrj, plan, repaired, proposals, rules, rotate }
}

test("shortens a small returning source arm with exact held via and target copper", async () => {
  const f = fixture()
  expect(
    changedFanoutCopperIsSelfClear(
      f.plan,
      f.plan.segments,
      f.rules.clearance,
      new Set(
        f.plan.segments
          .slice(0, f.plan.sourceEscapeSegmentCount)
          .map((_, i) => i),
      ),
    ),
  ).toBe(false)
  expect(f.proposals.length).toBeGreaterThan(0)
  expect(f.proposals.length).toBeLessThanOrEqual(64)
  expect(f.repaired).not.toBeNull()
  const result = f.repaired!
  expect(result.via).toBe(f.plan.via)
  expect(result.sourcePoint).toBe(f.plan.sourcePoint)
  expect(result.exitPoint).toBe(f.plan.exitPoint)
  expect(result.segments.slice(result.sourceEscapeSegmentCount)).toEqual(
    f.plan.segments.slice(f.plan.sourceEscapeSegmentCount),
  )
  expect(result.length).toBeLessThan(f.plan.length)
  expect(getSourcePadReentries(result, f.rules.clearance)).toEqual([])
  const output = { ...f.inputSrj, traces: [result.trace] }
  expect(
    validateRoutedCopperDrc({
      inputSrj: f.inputSrj,
      routedSrj: output,
      clearance: f.rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const turned = fixture(true)
  expect(turned.repaired).not.toBeNull()
  for (const [index, segment] of result.segments.entries())
    for (const point of ["start", "end"] as const)
      expect(
        distance(
          turned.rotate(segment[point]),
          turned.repaired!.segments[index]![point],
        ),
      ).toBeLessThan(1e-7)
  expect(fixture(false, true).repaired).toBeNull()
  expect(fixture(true, true).repaired).toBeNull()
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  graphics.lines!.push({
    points: [
      f.plan.sourcePoint,
      ...f.plan.segments
        .slice(0, f.plan.sourceEscapeSegmentCount)
        .map((s) => s.end),
    ],
    strokeColor: "#dc2626",
    strokeWidth: f.rules.traceWidth / 3,
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
