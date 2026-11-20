import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

function routeWithBoundaryReadCount(params: RouteBusParams): {
  plans: ReturnType<typeof routeBus>
  boundaryReads: number
} {
  let boundaryReads = 0
  const bus = { ...params.bus }
  Object.defineProperty(bus, "cornerBandConnectionCount", {
    get(): number | undefined {
      boundaryReads++
      return params.bus.cornerBandConnectionCount
    },
  })
  return { plans: routeBus({ ...params, bus }), boundaryReads }
}

test("native plane escape avoids constructing an unused boundary layout", async (): Promise<void> => {
  const params = createIcepiPlaneDrop()
  const inputBefore = JSON.stringify(params.srj)
  // Freeze the published solver's actual two-segment escape, in board mm.
  const source = params.bus.connections[0].sourcePoint
  const sourceEscapePath = [
    { x: source.x, y: source.y },
    { x: 1.2399999999987585, y: 15.079999999999984 },
    { x: 1.7399999999987577, y: 15.079999999999984 },
  ]
  const { plans, boundaryReads } = routeWithBoundaryReadCount({
    ...params,
    fixedViaPointsByConnectionIndex: new Map([[0, sourceEscapePath[2]]]),
    sourceEscapePaths: new Map([[0, sourceEscapePath]]),
  })
  expect(JSON.stringify(params.srj)).toBe(inputBefore)
  expect(plans).toHaveLength(1)
  if (!plans) throw new Error("Captured native escape was rejected")
  expect(plans[0].segments).toEqual(
    sourceEscapePath.slice(1).map((end, index) => ({
      start: sourceEscapePath[index],
      end,
      layer: "top",
      width: params.traceWidth,
    })),
  )
  expect(plans[0].via).toMatchObject({
    center: sourceEscapePath[2],
    diameter: 0.45,
    holeDiameter: 0.2,
    spanLayers: ["top", "inner1", "inner2", "bottom"],
  })
  const routedSrj = buildOutputSimpleRouteJson({
    inputSrj: params.srj,
    plans,
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  const boundary = params.bus.sharedBoundary
  const viewport = {
    minX: boundary.minX - 1.5,
    maxX: boundary.maxX + 1.5,
    minY: boundary.minY - 1.5,
    maxY: boundary.maxY + 1.5,
  }
  const graphics = visualizeSimpleRouteJson({
    ...params.srj,
    bounds: viewport,
    connections: [params.bus.connections[0].connection],
    traces: plans.map((plan) => plan.trace),
  })
  graphics.texts = [
    {
      x: viewport.minX,
      y: viewport.maxY + 0.8,
      text: `U22 escape: ${plans.length} route; ${plans.filter((plan) => plan.via).length} through-via`,
      fontSize: 0.3,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.3,
      text: `Boundary slot calculations: ${boundaryReads}`,
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
