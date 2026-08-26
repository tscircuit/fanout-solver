import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-soc-length-matching.json"

const fixture = capturedFixture as unknown as {
  input: SimpleRouteJson
  options: FanoutSolverOptions
}

function getTraceLength(trace: SimplifiedPcbTrace): number {
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined
  let length = 0
  for (const routePoint of trace.route) {
    if (routePoint.route_type !== "wire") {
      previousWire = undefined
      continue
    }
    if (previousWire?.layer === routePoint.layer) {
      length += Math.hypot(
        routePoint.x - previousWire.x,
        routePoint.y - previousWire.y,
      )
    }
    previousWire = routePoint
  }
  return length
}

function createSolver(matchByte1Lengths: boolean): FanoutSolver {
  const input = structuredClone(fixture.input)
  const options = structuredClone(fixture.options)
  for (const buses of [input.buses, options.buses]) {
    for (const bus of buses ?? []) {
      if (bus.busId !== "DDR_BYTE1") continue
      if (matchByte1Lengths) {
        bus.maxLengthSkew = 8.5
      } else {
        delete bus.maxLengthSkew
      }
    }
  }
  return new FanoutSolver(input, options)
}

function getBusTraceLengths(
  solver: FanoutSolver,
  busId: string,
): Map<string, number> {
  const bus = solver.preparedBuses.find(
    (candidate) => candidate.busId === busId,
  )
  if (!bus) throw new Error(`Missing prepared bus ${busId}`)
  const connectionNames = new Set(
    bus.connections.map((connection) => connection.connection.name),
  )
  return new Map(
    solver
      .getOutput()
      .fanoutTraces.filter((trace) =>
        connectionNames.has(trace.connection_name ?? ""),
      )
      .map((trace) => [trace.connection_name!, getTraceLength(trace)]),
  )
}

function getSkew(lengths: Iterable<number>): number {
  const values = [...lengths]
  return Math.max(...values) - Math.min(...values)
}

test("length matches the AM62L SOC DDR byte-1 fanout", async () => {
  const baselineSolver = createSolver(false)
  baselineSolver.solve()
  expect(baselineSolver.failed).toBe(false)

  const matchedSolver = createSolver(true)
  matchedSolver.solve()
  expect(matchedSolver.failed).toBe(false)
  const matchedOutput = matchedSolver.getOutput()

  const baselineLengths = getBusTraceLengths(baselineSolver, "DDR_BYTE1")
  const matchedLengths = getBusTraceLengths(matchedSolver, "DDR_BYTE1")
  const baselineSkew = getSkew(baselineLengths.values())
  const matchedSkew = getSkew(matchedLengths.values())
  expect(baselineSkew).toBeCloseTo(9.6118992408, 8)
  expect(matchedSkew).toBeLessThanOrEqual(8.500001)
  expect(baselineSkew - matchedSkew).toBeGreaterThan(1.1)

  const tunedTraceCount = [...matchedLengths].filter(
    ([connectionName, matchedLength]) =>
      matchedLength - (baselineLengths.get(connectionName) ?? matchedLength) >
      1e-6,
  ).length
  expect(tunedTraceCount).toBe(2)
  expect(matchedOutput.validation).toMatchObject({
    valid: true,
    issues: [],
  })
  expect(matchedOutput.fanoutTraces).toHaveLength(16)
  for (const trace of matchedOutput.fanoutTraces) {
    expect(
      trace.route.filter((routePoint) => routePoint.route_type === "via"),
    ).toHaveLength(1)
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: fixture.input,
      routedSrj: matchedOutput.simpleRouteJson,
      clearance: fixture.input.minTraceToPadEdgeClearance ?? 0.05,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  await expect(
    getSvgFromGraphicsObject(matchedSolver.visualize()),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
