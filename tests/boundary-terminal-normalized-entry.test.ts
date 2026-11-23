import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  boundaryTerminalPlanIsSelfClear,
  repairBoundaryTerminalEntries,
  type BoundaryTerminalConnector,
  type BoundaryTerminalSplice,
} from "lib/boundary-terminal-connectors"
import type { FanoutRoutePlan } from "lib/types"

// Native ButterStick source-origin output, after target-side corner normalization.
// Board-world millimeters, +X right and +Y up; no geometry or rules rescaled.
test("repairs a normalized terminal entry using its final join margin", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/butterstick-normalized-terminal-entry.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    plan: FanoutRoutePlan
    splice: BoundaryTerminalSplice
    connector: BoundaryTerminalConnector
    clearance: number
    maximumJoinLength: number
  }
  const { plan, splice, connector, clearance, maximumJoinLength } = fixture
  const original = JSON.stringify(fixture)
  const params = {
    plans: [plan],
    splices: new Map([[plan.connectionName, splice]]),
    connectors: new Map([[plan.connectionName, connector]]),
    clearance,
    segmentIsClear: () => true,
  }
  expect(
    boundaryTerminalPlanIsSelfClear({
      plan,
      splice,
      clearance,
      maximumJoinLength: 0,
    }),
  ).toBe(true)
  expect(
    boundaryTerminalPlanIsSelfClear({
      plan,
      splice,
      clearance,
      maximumJoinLength,
    }),
  ).toBe(false)
  expect(repairBoundaryTerminalEntries(params)!.plans[0]).toBe(plan)
  const result = repairBoundaryTerminalEntries({ ...params, maximumJoinLength })
  expect(result).not.toBeNull()
  const repaired = result!.plans[0]!
  expect(
    boundaryTerminalPlanIsSelfClear({
      plan: repaired,
      splice: result!.splices.get(plan.connectionName)!,
      clearance,
      maximumJoinLength,
    }),
  ).toBe(true)
  expect(repaired.via).toEqual(plan.via)
  expect(repaired.additionalVias).toEqual(plan.additionalVias)
  expect(repaired.segments.slice(0, plan.sourceEscapeSegmentCount)).toEqual(
    plan.segments.slice(0, plan.sourceEscapeSegmentCount),
  )
  expect(repaired.exitPoint).toEqual(plan.exitPoint)
  expect(repaired.length).toBeLessThan(plan.length)
  expect(
    repairBoundaryTerminalEntries({
      ...params,
      maximumJoinLength,
      segmentIsClear: () => false,
    }),
  ).toBeNull()
  expect(JSON.stringify(fixture)).toBe(original)
  const lines = [plan, repaired].flatMap((candidate, index) =>
    candidate.segments
      .filter(
        (s) =>
          s.layer === connector.layer && Math.min(s.start.y, s.end.y) < 2.2,
      )
      .map((s) => ({
        points: [s.start, s.end].map((p) => ({ x: p.x + index * 1.8, y: p.y })),
        strokeColor: index ? "#169547" : "#cf2835",
        strokeWidth: s.width,
      })),
  )
  await expect(
    getSvgFromGraphicsObject(
      { lines },
      { backgroundColor: "white", svgWidth: 1000, svgHeight: 600 },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
