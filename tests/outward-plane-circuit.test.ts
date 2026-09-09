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
  expect(result.phases[0].failed).toBe(true)
  expect(result.phases[0].error).toBe(
    "FanoutSolver: best layer assignment routed 3/4 connections",
  )
  expect(
    result.errors.filter((error) => error.type === "pcb_autorouting_error"),
  ).toEqual([expect.objectContaining({ message: result.phases[0].error })])
  // Core commits a group's copper only after every phase has succeeded.
  expect(result.traceCount).toBe(0)
  await expect(result.svg).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
