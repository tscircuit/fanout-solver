import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import type { GraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerNames } from "lib/layer-names"
import { srj29FanoutSamples } from "../datasets/srj29"

const PASSING_SAMPLE_IDS = ["sample001", "sample005", "sample009"] as const

function graphicsLayerIncludes(layer: string | undefined, layerIndex: number) {
  if (!layer) return true
  return layer.replace(/^z/, "").split(",").map(Number).includes(layerIndex)
}

function selectLayer(
  graphics: GraphicsObject,
  layerIndex: number,
): GraphicsObject {
  return Object.fromEntries(
    Object.entries(graphics).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.filter((item) =>
            graphicsLayerIncludes(
              (item as { layer?: string }).layer,
              layerIndex,
            ),
          )
        : value,
    ]),
  ) as GraphicsObject
}

for (const sampleId of PASSING_SAMPLE_IDS) {
  test(`SRJ29 ${sampleId} validated fanout solution`, async () => {
    const sample = srj29FanoutSamples.find(({ id }) => id === sampleId)
    if (!sample) throw new Error(`SRJ29 ${sampleId} is missing`)

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()

    expect(solver.solved).toBe(true)
    expect(solver.failed).toBe(false)
    const output = solver.getOutput()
    expect(output.validation).toMatchObject({
      valid: true,
      checkedConnectionCount: sample.fanoutConnectionCount,
      brokenOutConnectionCount: sample.fanoutConnectionCount,
      issues: [],
    })
    expect(output.endpointCompletion).toMatchObject({
      connectivity: {
        valid: true,
        connectedConnectionCount: sample.fanoutConnectionCount,
        issues: [],
      },
      drc: { valid: true, issues: [] },
    })
    const graphics = solver.visualize()
    await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
      import.meta.path,
      `${sampleId}-validated-fanout`,
    )
    for (const [layerIndex, layerName] of getCopperLayerNames(
      sample.simpleRouteJson.layerCount,
    ).entries()) {
      await expect(
        getSvgFromGraphicsObject(selectLayer(graphics, layerIndex)),
      ).toMatchSvgSnapshot(
        import.meta.path,
        `${sampleId}-validated-fanout-${layerName}`,
      )
    }
  }, 90_000)
}
