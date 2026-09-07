import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { benchmarkSamples } from "../benchmarks/benchmark-catalog"
import { prepareDataset31Samples } from "../benchmarks/prepare-dataset31"
import { createAm62lRamLeftInput } from "../datasets/dataset08"
import {
  DATASET31_DIRECTION_CASES,
  dataset31Source,
} from "../scripts/generate-repro/dataset31-source"

// Render all 48 upstream circuits sequentially; this is capture/transport coverage,
// separate from the benchmark's per-sample routing deadline.
test("dataset 31 capture preserves every upstream connection, obstacle, and bus constraint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-dataset31-capture-"))
  try {
    const samples = await prepareDataset31Samples(
      benchmarkSamples.map((sample) => sample.id),
      directory,
    )
    expect(samples).toHaveLength(48)
    expect(samples.map((sample) => sample.id)).toEqual(
      DATASET31_DIRECTION_CASES.map((sample) => sample.id),
    )
    const definitionsById = new Map(
      DATASET31_DIRECTION_CASES.map((sample) => [sample.id, sample]),
    )
    const chips = { am62l: 0, rk3308: 0, k230: 0, imx6ull: 0 }
    const edges = {
      am62l: new Set<string>(),
      rk3308: new Set<string>(),
      k230: new Set<string>(),
      imx6ull: new Set<string>(),
    }
    const expectedByChip = {
      am62l: {
        connections: 135,
        obstacles: 573,
        pairs: 3,
        buses: 111,
        planes: 102,
        byte1Bus: "DDR_BYTE1",
        byte1Skew: 14.5,
      },
      rk3308: {
        connections: 162,
        obstacles: 451,
        pairs: 3,
        buses: 122,
        planes: 113,
        byte1Bus: "DDR_BYTE1",
        byte1Skew: 8,
      },
      k230: {
        connections: 171,
        obstacles: 790,
        pairs: 6,
        buses: 123,
        planes: 106,
        byte1Bus: "LP4_A_BYTE1",
        byte1Skew: 8,
      },
      imx6ull: {
        connections: 102,
        obstacles: 385,
        pairs: 3,
        buses: 62,
        planes: 53,
        byte1Bus: "DDR_BYTE1",
        byte1Skew: 8,
      },
    }
    const uniqueInputs = new Set<string>()
    for (const sample of samples) {
      const definition = definitionsById.get(sample.id)!
      const expected = expectedByChip[definition.chip]
      chips[definition.chip] += 1
      expect(sample.dataset).toBe("dataset31")
      expect(sample.simpleRouteJson.connections).toHaveLength(
        expected.connections,
      )
      expect(sample.simpleRouteJson.obstacles).toHaveLength(expected.obstacles)
      expect(sample.simpleRouteJson.layerCount).toBe(8)
      expect(sample.simpleRouteJson.differentialPairs).toHaveLength(
        expected.pairs,
      )
      expect(sample.solverOptions?.buses).toHaveLength(expected.buses)
      expect(
        sample.solverOptions?.buses?.filter(
          (bus) => bus.termination?.type === "plane",
        ),
      ).toHaveLength(expected.planes)
      expect(
        sample.solverOptions?.buses?.find(
          (bus) => bus.busId === expected.byte1Bus,
        )?.maxLengthSkew,
      ).toBe(expected.byte1Skew)
      if (definition.chip === "imx6ull") {
        expect(sample.solverOptions?.escapeLayers).toEqual([
          "top",
          "inner4",
          "inner5",
          "inner6",
          "bottom",
        ])
        for (const [layer, count] of [
          ["inner1", 47],
          ["inner2", 6],
        ] as const)
          expect(
            sample.solverOptions?.buses?.filter(
              (bus) =>
                bus.termination?.type === "plane" &&
                bus.termination.layer === layer,
            ),
          ).toHaveLength(count)
        const padCounts = new Map<string | undefined, number>()
        for (const obstacle of sample.simpleRouteJson.obstacles)
          padCounts.set(
            obstacle.componentId,
            (padCounts.get(obstacle.componentId) ?? 0) + 1,
          )
        expect([...padCounts.values()].sort((a, b) => a - b)).toEqual([96, 289])
      }
      // No callbacks or non-JSON constraints may be lost in worker transport.
      expect(JSON.parse(JSON.stringify(sample))).toEqual(sample)
      const captured = await Bun.file(
        join(directory, `${sample.id}.json`),
      ).json()
      expect(captured.generatedFrom).toEqual({
        ...dataset31Source,
        sample: `samples/${sample.id}.tsx`,
      })
      expect(captured.simpleRouteJson).toEqual(sample.simpleRouteJson)
      expect(captured.solverOptions).toEqual(sample.solverOptions)
      uniqueInputs.add(
        JSON.stringify([sample.simpleRouteJson, sample.solverOptions]),
      )
      expect(captured.directionCase.id).toBe(definition.id)
      expect(captured.directionCase.exitPosition).toBe(definition.exitPosition)
      expect(captured.directionCase.exitEdge).toBe(definition.exitEdge)
      edges[definition.chip].add(captured.directionCase.exitEdge)
    }
    expect(uniqueInputs.size).toBe(48)
    expect(chips).toEqual({ am62l: 12, rk3308: 12, k230: 12, imx6ull: 12 })
    for (const chipEdges of Object.values(edges))
      expect(chipEdges).toEqual(new Set(["top", "right", "bottom", "left"]))
    // Prove the existing RAM-left repro is unchanged by the new capture path.
    const left = samples.find((sample) => sample.id === "11-left-center")!
    const original = createAm62lRamLeftInput()
    expect(left.simpleRouteJson).toEqual(original.simpleRouteJson)
    expect(left.solverOptions).toEqual(original.solverOptions)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 300_000)
