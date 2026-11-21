import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import * as planBuilder from "lib/route-bus/build-plan"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native U22 boundary search rebuilds statically rejected candidates", async () => {
  const { solverParams: input, solverOptions: options } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { solverParams: SimpleRouteJson; solverOptions: FanoutSolverOptions }
  const bus = prepareFanoutBuses(input, options).find(
    (candidate) =>
      candidate.busId === "connection:breakout:pcb_breakout_point_9",
  )
  if (!bus) throw new Error("Captured U22 boundary escape is missing")
  const viaDiameter = input.minViaPadDiameter
  const viaHoleDiameter = input.minViaHoleDiameter
  const clearance = input.minViaEdgeToPadEdgeClearance
  if (
    viaDiameter === undefined ||
    viaHoleDiameter === undefined ||
    clearance === undefined
  ) {
    throw new Error("Captured U22 via rules are missing")
  }
  const params: RouteBusParams = {
    srj: input,
    bus,
    targetLayer: "top",
    acceptedPlans: [],
    layerNames: ["top", "inner1", "inner2", "bottom"],
    traceWidth: bus.traceWidth ?? input.minTraceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
    staticClearanceCache: new Map(),
  }
  const builds = spyOn(planBuilder, "buildPlan")
  const first = routeBus(params)
  builds.mockClear()
  const repeated = routeBus(params)
  const buildCount = builds.mock.calls.length
  builds.mockRestore()
  expect(repeated).toEqual(first)
  expect(repeated).toHaveLength(1)
  if (!repeated) throw new Error("Captured U22 escape was rejected")
  const output = buildOutputSimpleRouteJson({
    inputSrj: input,
    plans: repeated,
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const boundary = bus.sharedBoundary
  const graphics = visualizeSimpleRouteJson({
    ...output,
    bounds: boundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: boundary.minX,
      y: boundary.maxY + 2,
      text: "iCE/Pi U22 boundary escape: 1 route; 0 vias",
      fontSize: 0.25,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 1.5,
      text: `Candidate plans rebuilt on repeat: ${buildCount}`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
