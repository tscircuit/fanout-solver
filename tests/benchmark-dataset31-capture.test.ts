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

test("dataset 31 capture preserves every upstream connection, obstacle, and bus constraint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-dataset31-capture-"))
  try {
    const samples = await prepareDataset31Samples(
      benchmarkSamples.map((sample) => sample.id),
      directory,
    )
    expect(samples).toHaveLength(24)
    expect(samples.map((sample) => sample.id)).toEqual(
      DATASET31_DIRECTION_CASES.map((sample) => sample.id),
    )
    const definitionsById = new Map(
      DATASET31_DIRECTION_CASES.map((sample) => [sample.id, sample]),
    )
    const chips = { am62l: 0, rk3308: 0 }
    const edges = { am62l: new Set<string>(), rk3308: new Set<string>() }
    const uniqueInputs = new Set<string>()
    for (const sample of samples) {
      const definition = definitionsById.get(sample.id)!
      const isRk3308 = definition.chip === "rk3308"
      chips[definition.chip] += 1
      expect(sample.dataset).toBe("dataset31")
      expect(sample.simpleRouteJson.connections).toHaveLength(
        isRk3308 ? 162 : 135,
      )
      expect(sample.simpleRouteJson.obstacles).toHaveLength(
        isRk3308 ? 451 : 573,
      )
      expect(sample.simpleRouteJson.layerCount).toBe(8)
      expect(sample.simpleRouteJson.differentialPairs).toHaveLength(3)
      expect(sample.solverOptions?.buses).toHaveLength(isRk3308 ? 122 : 111)
      expect(
        sample.solverOptions?.buses?.filter(
          (bus) => bus.termination?.type === "plane",
        ),
      ).toHaveLength(isRk3308 ? 113 : 102)
      expect(
        sample.solverOptions?.buses?.find((bus) => bus.busId === "DDR_BYTE1")
          ?.maxLengthSkew,
      ).toBe(isRk3308 ? 8 : 14.5)
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
    expect(uniqueInputs.size).toBe(24)
    expect(chips).toEqual({ am62l: 12, rk3308: 12 })
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
}, 120_000)
