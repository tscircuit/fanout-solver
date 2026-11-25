import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { routeLocalSignalDogbones } from "lib/route-local-signal-dogbones"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("OrangeCrab first-byte local dogbones retain all 22 pad escapes", async () => {
  const { input, options } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/orangecrab-byte0-local-dogbones.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  )
  const before = JSON.stringify(input)
  const result = routeLocalSignalDogbones(input, {
    ...options,
    targetLayers: new Map(options.targetLayers),
  })
  expect(result.traces).toHaveLength(22)
  expect(JSON.stringify(input)).toBe(before)
  const routed = { ...input, traces: result.traces }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: routed,
      clearance: options.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 22, issues: [] })
  const graphics = visualizeSimpleRouteJson({ ...routed, connections: [] })
  graphics.title = "OrangeCrab first byte: 22 local pad escapes"
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 700,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
