import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { obstacleSharesElectricalNet } from "lib/net-identity"
import { planIsStaticallyClear } from "lib/route-bus/plan-static-clearance"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createImx6PlaneVia } from "./fixtures/imx6-plane-via"

test("native plane via eligibility respects terminal pours", async () => {
  const { srj, plan, viewport } = createImx6PlaneVia()
  const copperDrc = validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: { ...srj, traces: [plan.trace] },
    clearance: 0.119,
    allowBlindAndBuriedVias: false,
  })
  expect(copperDrc.issues.map((issue) => issue.code)).toEqual([
    "via-obstacle-clearance",
    "via-obstacle-clearance",
    "via-obstacle-clearance",
  ])
  const clearance = {
    plan,
    sharedBoundary: srj.bounds,
    clearance: 0.119,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const accepted = planIsStaticallyClear({ ...clearance, srj })
  expect(accepted).toBe(false)
  // Transit-layer antipads and contact with this net's own plane remain legal.
  for (const [layer, sameNet] of [
    ["inner3", false],
    ["inner2", true],
  ] as const) {
    const obstacles = srj.obstacles.map((obstacle) =>
      obstacle.isCopperPour && obstacle.layers.includes("inner2")
        ? {
            ...obstacle,
            layers: [layer],
            connectedTo: sameNet ? [plan.connectionName] : obstacle.connectedTo,
          }
        : obstacle,
    )
    expect(
      planIsStaticallyClear({ ...clearance, srj: { ...srj, obstacles } }),
    ).toBe(true)
  }
  // Clip only the drawing; validation uses the original native pour geometry.
  const obstacles = srj.obstacles.map((obstacle) => {
    if (!obstacle.isCopperPour) return obstacle
    const minX = Math.max(viewport.minX, obstacle.center.x - obstacle.width / 2)
    const maxX = Math.min(viewport.maxX, obstacle.center.x + obstacle.width / 2)
    const minY = Math.max(
      viewport.minY,
      obstacle.center.y - obstacle.height / 2,
    )
    const maxY = Math.min(
      viewport.maxY,
      obstacle.center.y + obstacle.height / 2,
    )
    return {
      ...obstacle,
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      width: maxX - minX,
      height: maxY - minY,
    }
  })
  const graphics = visualizeSimpleRouteJson({
    ...srj,
    bounds: viewport,
    obstacles,
    traces: accepted ? [plan.trace] : [],
  })
  graphics.rects!.unshift(
    ...obstacles
      .filter(
        (obstacle) =>
          obstacle.isCopperPour &&
          obstacle.layers.includes("inner2") &&
          !obstacleSharesElectricalNet(srj, obstacle, plan.connectionName),
      )
      .map((obstacle) => ({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        fill: "rgba(234,179,8,0.2)",
        stroke: "#ca8a04",
        strokeWidth: 0.01,
      })),
  )
  const obstacleCollections = [
    graphics.rects,
    graphics.circles,
    graphics.points,
  ]
  for (const collection of obstacleCollections) {
    for (const shape of collection ?? []) shape.label = undefined
  }
  const status = accepted ? "accepted" : "rejected"
  graphics.texts = [
    {
      x: viewport.minX,
      y: viewport.maxY + 0.5,
      text: `Native i.MX6 plane candidate: ${status}`,
      fontSize: 0.15,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.25,
      text: "Foreign inner2 copper: yellow; captured via has 3 DRC issues",
      fontSize: 0.08,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 800,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
