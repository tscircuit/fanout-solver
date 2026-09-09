import { expect, test } from "bun:test"
import { renderOutwardPlaneCircuit } from "./fixtures/render-outward-plane-circuit"

test("outward plane escape in a routed RC supply filter", async () => {
  const result = await renderOutwardPlaneCircuit()
  expect(result.componentNames).toEqual(["R1", "C1", "C2", "C3", "C4"])
  expect(result.phases).toHaveLength(1)
  expect(result.phases[0].buses).toEqual(
    ["C1_GROUND", "C2_GROUND", "C3_GROUND", "C4_GROUND"].map((busId) => ({
      busId,
      termination: { type: "plane", layer: "inner2" },
    })),
  )
  expect(result.phases[0].solved).toBe(true)
  expect(result.phases[0].failed).toBe(false)
  expect(result.phases[0].error).toBeNull()
  expect(result.errors).toEqual([])
  expect(result.traceCount).toBe(9)
  await expect(result.svg).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
