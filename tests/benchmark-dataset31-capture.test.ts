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

// Render all 60 upstream circuits sequentially; this is capture/transport coverage,
// separate from the benchmark's per-sample routing deadline. The 500s capture
// allowance scales the previous 400s budget for 48 circuits to all 60 circuits.
test("dataset 31 capture preserves every upstream connection, obstacle, and bus constraint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-dataset31-capture-"))
  try {
    const samples = await prepareDataset31Samples(
      benchmarkSamples.map((sample) => sample.id),
      directory,
    )
    expect(samples).toHaveLength(60)
    expect(samples.map((sample) => sample.id)).toEqual(
      DATASET31_DIRECTION_CASES.map((sample) => sample.id),
    )
    const definitionsById = new Map(
      DATASET31_DIRECTION_CASES.map((sample) => [sample.id, sample]),
    )
    const chips = { am62l: 0, rk3308: 0, k230: 0, imx6ull: 0, t113s3: 0 }
    const edges = {
      am62l: new Set<string>(),
      rk3308: new Set<string>(),
      k230: new Set<string>(),
      imx6ull: new Set<string>(),
      t113s3: new Set<string>(),
    }
    const expectedByChip = {
      am62l: {
        connections: 135,
        obstacles: 573,
        pairs: 3,
        buses: 111,
        planes: 102,
        constrainedBus: "DDR_BYTE1",
        constrainedSkew: 14.5,
      },
      rk3308: {
        connections: 162,
        obstacles: 451,
        pairs: 3,
        buses: 122,
        planes: 113,
        constrainedBus: "DDR_BYTE1",
        constrainedSkew: 8,
      },
      k230: {
        connections: 171,
        obstacles: 790,
        pairs: 6,
        buses: 123,
        planes: 106,
        constrainedBus: "LP4_A_BYTE1",
        constrainedSkew: 8,
      },
      imx6ull: {
        connections: 102,
        obstacles: 385,
        pairs: 3,
        buses: 62,
        planes: 53,
        constrainedBus: "DDR_BYTE1",
        constrainedSkew: 8,
      },
      t113s3: {
        connections: 128,
        obstacles: 235,
        pairs: 3,
        buses: 60,
        planes: 22,
        constrainedBus: "USB0",
        constrainedSkew: 0.25,
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
          (bus) => bus.busId === expected.constrainedBus,
        )?.maxLengthSkew,
      ).toBe(expected.constrainedSkew)
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
      if (definition.chip === "t113s3") {
        const { simpleRouteJson: srj, solverOptions: options } = sample
        expect(options?.escapeLayers).toEqual(["top", "inner6", "bottom"])
        expect(options?.allowBlindAndBuriedVias).toBe(false)
        const planeBuses = options!.buses!.filter(
          (bus) => bus.termination?.type === "plane",
        )
        const signalBuses = options!.buses!.filter(
          (bus) => bus.termination?.type !== "plane",
        )
        expect(signalBuses).toHaveLength(38)
        expect(signalBuses.flatMap((bus) => bus.connectionNames!)).toHaveLength(
          106,
        )
        expect(
          planeBuses.find((bus) => bus.busId === "U1_PIN129_DROP")?.termination,
        ).toEqual({ type: "plane", layer: "inner1" })
        const capturedObstacles: Array<
          (typeof srj.obstacles)[number] & {
            circuitJsonMetadata?: {
              pcb_port_id?: string
              source_port_name?: string
            }
          }
        > = srj.obstacles
        const sourcePads = capturedObstacles.filter(
          (obstacle) =>
            obstacle.circuitJsonMetadata?.source_port_name === "pin129",
        )
        expect(sourcePads).toHaveLength(1)
        const componentId = sourcePads[0]!.componentId
        const padPins = new Map(
          capturedObstacles
            .filter((obstacle) => obstacle.componentId === componentId)
            .map((obstacle) => [
              obstacle.circuitJsonMetadata?.pcb_port_id,
              obstacle.circuitJsonMetadata?.source_port_name,
            ]),
        )
        expect(padPins.size).toBe(129)
        const sourcePin = (name: string) =>
          padPins.get(
            srj.connections.find((connection) => connection.name === name)!
              .pointsToConnect[0]!.pcb_port_id,
          )
        for (const [layer, pins] of [
          ["inner1", [91, 129]],
          ["inner2", [29, 34, 66, 77, 83, 128]],
          ["inner3", [20, 26, 50, 65, 89, 97, 107]],
          ["inner4", [48, 49]],
          ["inner5", [46, 51, 81, 116, 117]],
        ] as const)
          expect(
            new Set(
              planeBuses
                .filter(
                  (bus) =>
                    bus.termination?.type === "plane" &&
                    bus.termination.layer === layer,
                )
                .flatMap((bus) => bus.connectionNames!.map(sourcePin)),
            ),
          ).toEqual(new Set(pins.map((pin) => `pin${pin}`)))
        const connectedPins = srj.connections.map((connection) =>
          sourcePin(connection.name),
        )
        // Preserve every non-NC lead and the exposed pad; NC remains a physical obstacle.
        expect(new Set(connectedPins)).toEqual(
          new Set(
            Array.from({ length: 129 }, (_, index) => `pin${index + 1}`).filter(
              (pin) => pin !== "pin106",
            ),
          ),
        )
        expect(connectedPins).toHaveLength(128)
        expect([...padPins.values()]).toContain("pin106")
        expect(
          new Set(options!.buses!.flatMap((bus) => bus.connectionNames!)),
        ).toEqual(new Set(srj.connections.map((connection) => connection.name)))
        const lanesByBus = Object.fromEntries(
          signalBuses.map((bus) => [bus.busId, bus.connectionNames!.length]),
        )
        expect(lanesByBus).toMatchObject({
          GPIOB: 6,
          GPIOC: 6,
          GPIOD_0_9: 10,
          GPIOD_10_22: 13,
          GPIOE: 14,
          GPIOF: 7,
          GPIOG: 16,
          USB0: 2,
          USB1: 2,
          MICIN3: 2,
        })
        expect(
          signalBuses.filter((bus) => bus.busId!.startsWith("AUX_")),
        ).toHaveLength(28)
        const connectionsByEdge = new Map<string, number>()
        for (const bus of signalBuses) {
          expect(bus.allowedLayers).toEqual(["top", "inner6", "bottom"])
          expect(bus.exitPosition).toBe(
            captured.signalBusExitPositions[bus.busId!],
          )
          const edge = bus.exitPosition!.split("side_")[0]!
          connectionsByEdge.set(
            edge,
            (connectionsByEdge.get(edge) ?? 0) + bus.connectionNames!.length,
          )
        }
        expect(new Set(connectionsByEdge.keys())).toEqual(
          new Set(["top", "right", "bottom", "left"]),
        )
        expect([...connectionsByEdge.values()].sort((a, b) => a - b)).toEqual([
          21, 25, 28, 32,
        ])
        expect(
          signalBuses.find((bus) => bus.busId === "GPIOG")!.exitPosition,
        ).toStartWith(`${definition.exitEdge}side_`)
        expect(
          srj.differentialPairs!.map((pair) => ({
            pins: pair.connectionNames.map(sourcePin),
            tolerance: pair.lengthTolerance,
          })),
        ).toEqual([
          { pins: ["pin115", "pin114"], tolerance: 0.25 },
          { pins: ["pin112", "pin113"], tolerance: 0.25 },
          { pins: ["pin87", "pin88"], tolerance: 0.25 },
        ])
      }
      uniqueInputs.add(
        JSON.stringify([sample.simpleRouteJson, sample.solverOptions]),
      )
      expect(captured.directionCase.id).toBe(definition.id)
      expect(captured.directionCase.exitPosition).toBe(definition.exitPosition)
      expect(captured.directionCase.exitEdge).toBe(definition.exitEdge)
      edges[definition.chip].add(captured.directionCase.exitEdge)
    }
    expect(uniqueInputs.size).toBe(60)
    expect(chips).toEqual({
      am62l: 12,
      rk3308: 12,
      k230: 12,
      imx6ull: 12,
      t113s3: 12,
    })
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
}, 500_000)
