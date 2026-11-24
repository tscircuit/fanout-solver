import { expect, test } from "bun:test"
import { getRouteViaSpanLayers } from "../lib/layer-names"

test("rejects physically discontinuous via layer metadata", (): void => {
  const layerNames = ["top", "inner1", "inner2", "bottom"]

  expect(() =>
    getRouteViaSpanLayers({
      fromLayer: "top",
      toLayer: "bottom",
      layers: ["top", "bottom"],
      layerNames,
      allowBlindAndBuriedVias: true,
    }),
  ).toThrow("invalid physical layer span")

  expect(
    getRouteViaSpanLayers({
      fromLayer: "top",
      toLayer: "bottom",
      layers: layerNames,
      layerNames,
      allowBlindAndBuriedVias: true,
    }),
  ).toEqual(layerNames)
})
