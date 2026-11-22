import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { audit, createCrossingTraces } from "../repros/mutable-net-identity"

test("copper DRC reflects net splits and merges on the same SRJ object", async () => {
  const scene = createCrossingTraces()
  expect(audit(scene).valid).toBe(true)

  for (const connection of scene.connections) {
    connection.netConnectionName = connection.name
  }
  const split = audit(scene)
  expect(split).toEqual(audit(structuredClone(scene)))
  expect(split.valid).toBe(false)
  expect(split.checkedTraceCount).toBe(2)
  expect(split.issues.map((issue) => issue.code)).toContain(
    "different-net-trace-clearance",
  )

  const graphics = visualizeSimpleRouteJson({ ...scene, connections: [] })
  graphics.texts ??= []
  graphics.texts.push({
    x: 0,
    y: 2.6,
    text: "After net split: crossing A/B must fail copper DRC",
    fontSize: 0.16,
    anchorSide: "bottom_center",
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )

  for (const connection of scene.connections) {
    connection.netConnectionName = "COMMON"
  }
  expect(audit(scene)).toEqual(audit(structuredClone(scene)))
  expect(audit(scene).valid).toBe(true)
})
