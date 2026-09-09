import { expect, test } from "bun:test"
import { PortfolioSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter"
import { attachSourceOriginTransitSearch } from "../lib/source-origin-transit-search"

test("native search keys distinguish TOP history and reset for new connections and retries", () => {
  const factory = new PortfolioSingleIntraNodeSolver({
    nodeWithPortPoints: {
      capacityMeshNodeId: "phase-reset",
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      availableZ: [0, 1],
      portPoints: [-0.5, 0.5].flatMap((y, i) => [
        {
          x: -0.8,
          y,
          z: 0,
          connectionName: `N${i}`,
          rootConnectionName: `N${i}`,
        },
        {
          x: 0.8,
          y,
          z: 0,
          connectionName: `N${i}`,
          rootConnectionName: `N${i}`,
        },
      ]),
    },
    traceWidth: 0.1,
    viaDiameter: 0.3,
  })
  type Router = Parameters<typeof attachSourceOriginTransitSearch>[0]
  const router = factory.generateSolver({
    HIGH_DENSITY_A03: true,
  }) as unknown as Router & {
    _setup(): void
    nextStamp(): void
    usedCellsFlat: Int32Array
    layerToZ: Map<number, number>
    nodePool: Router["nodePool"] & { clear(): void }
    heap: Router["heap"] & {
      clear(): void
      push(cost: number, sequence: number, node: number): void
    }
  }
  router._setup()
  const occupancy = router.usedCellsFlat,
    layers = router.layerToZ,
    stride = router.planeSize * router.layers
  const source = 0,
    distant = Array.from(router.cellCenterX.keys()).find(
      (i) =>
        Math.hypot(
          router.cellCenterX[i]! - router.cellCenterX[source]!,
          router.cellCenterY[i]! - router.cellCenterY[source]!,
        ) > 0.5,
    )!,
    goal = router.planeSize - 1
  const phase = attachSourceOriginTransitSearch(router, [true, true], 0, 0.4)
  const visit = (z: number, cell: number, parent: number) => {
    const node = router.nodePool.push(z, cell, 0, parent, -1, 0)
    router.heap.push(0, 0, node)
    expect(router.heap.pop()).toBe(node)
    return node
  }
  router.activeConnId = 0
  router.activeConnSeg = {
    startZ: 0,
    startCellId: source,
    endZ: 0,
    endCellId: goal,
  }
  const start = visit(0, source, -1)
  expect(phase.beforeFirstVia()).toBe(true)
  expect(phase.prepareMove(0, goal, false)).toBe(false)
  phase.prepareMove(0, distant, false)
  const beforeKey = router.getSearchStateIdx(distant, 0)
  expect(phase.prepareMove(1, source, true)).toBe(true)
  const via = visit(1, source, start)
  expect(phase.beforeFirstVia()).toBe(false)
  expect(phase.prepareMove(0, source, true)).toBe(false)
  expect(phase.prepareMove(1, distant, false)).toBe(true)
  const travelled = visit(1, distant, via)
  // Positive internal travel does not permit a return at the original drill.
  expect(phase.prepareMove(0, source, true)).toBe(false)
  expect(phase.prepareMove(0, distant, true)).toBe(true)
  visit(0, distant, travelled)
  expect(router.getSearchStateIdx(distant, 0)).toBe(beforeKey + 2 * stride)
  expect(phase.prepareMove(0, goal, false)).toBe(true)
  expect(router.usedCellsFlat).toBe(occupancy)
  expect(router.layerToZ).toBe(layers)
  expect(router.visitedStamp).toHaveLength(3 * stride)
  for (const connection of [1, 0]) {
    // A03 clears/reuses the same pool when changing connection or rerouting it.
    router.nodePool.clear()
    router.heap.clear()
    router.nextStamp()
    router.activeConnId = connection
    const retry = visit(0, source, -1)
    expect(retry).toBe(0)
    expect(phase.beforeFirstVia()).toBe(true)
    expect(phase.prepareMove(0, goal, false)).toBe(false)
    phase.prepareMove(0, distant, false)
    expect(router.getSearchStateIdx(distant, 0)).toBe(beforeKey)
  }
  router.activeConnSeg = {
    startZ: 0,
    endZ: 0,
    startCellId: source,
    endCellId: source,
  }
  visit(0, source, -1)
  expect(router.failed).toBe(true)
})
