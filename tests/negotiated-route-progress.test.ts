import { expect, test } from "bun:test"
import { PortfolioSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter"

type NativeRouter = {
  solved: boolean
  failed: boolean
  MAX_ITERATIONS: number
  step(): void
  getSolvedRouteCount(): number
  getOutput(): unknown[]
  ripTrace(connectionId: number): void
}

function createRouter(): NativeRouter {
  const nodeWithPortPoints = {
    capacityMeshNodeId: "progress-count",
    center: { x: 0, y: 0 },
    width: 4,
    height: 4,
    availableZ: [0, 1],
    portPoints: [-1, 0, 1].flatMap((y, index) =>
      [-1.5, 1.5].map((x) => ({
        x,
        y,
        z: 1,
        connectionName: `N${index}`,
        rootConnectionName: `N${index}`,
      })),
    ),
  }
  const candidate = new PortfolioSingleIntraNodeSolver({
    nodeWithPortPoints,
    traceWidth: 0.1,
    viaDiameter: 0.3,
  }).generateSolver({ HIGH_DENSITY_A03: true })
  const Constructor = candidate.constructor as new (
    params: object,
  ) => NativeRouter
  return new Constructor({
    nodeWithPortPoints,
    traceThickness: 0.1,
    traceMargin: 0.1,
    viaDiameter: 0.3,
    highResolutionCellSize: 0.1,
    lowResolutionCellSize: 0.1,
    hyperParameters: { shuffleSeed: 1 },
  })
}

test("native negotiated counts equal output length through empty, partial, ripped, complete and failed states", () => {
  const router = createRouter(),
    seen = new Set<number>()
  const check = () => {
    const count = router.getSolvedRouteCount()
    expect(count).toBe(router.getOutput().length)
    seen.add(count)
  }
  for (let i = 0; i < 10_000 && !router.solved && !router.failed; i++) {
    router.step()
    check()
  }
  expect(router.solved).toBe(true)
  expect([...seen].sort()).toEqual([0, 1, 2, 3])
  router.ripTrace(0)
  expect(router.getSolvedRouteCount()).toBe(2)
  check()
  router.solved = false
  for (let i = 0; i < 10_000 && !router.solved && !router.failed; i++) {
    router.step()
    check()
  }
  expect(router.solved).toBe(true)
  expect(router.getSolvedRouteCount()).toBe(3)

  const failed = createRouter()
  failed.step()
  expect(failed.getSolvedRouteCount()).toBe(0)
  failed.MAX_ITERATIONS = 1
  for (let i = 0; i < 10 && !failed.failed; i++) failed.step()
  expect(failed.failed).toBe(true)
  expect(failed.getSolvedRouteCount()).toBe(failed.getOutput().length)
})
