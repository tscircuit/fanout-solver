interface TransitSearchRouter {
  failed: boolean
  planeSize: number
  layers: number
  activeConnId: number
  activeConnSeg: {
    startCellId: number
    endCellId: number
    startZ: number
    endZ: number
  } | null
  cellCenterX: Float64Array
  cellCenterY: Float64Array
  visitedStamp: Uint32Array
  bestGStamp: Uint32Array
  bestGValue: Float64Array
  nodePool: {
    z: Int32Array
    cellId: Int32Array
    push(
      z: number,
      cell: number,
      g: number,
      parent: number,
      ripHead: number,
      ripCount: number,
    ): number
  }
  heap: { pop(): number }
  getSearchStateIdx(flat: number, ripCount: number): number
}

/** Add path history to search keys while all copper keeps its physical cell/layer. */
export function attachSourceOriginTransitSearch(
  router: TransitSearchRouter,
  requiresTransit: readonly boolean[],
  topZ: number,
  minimumViaDistance: number,
) {
  const stride = router.planeSize * router.layers
  router.visitedStamp = new Uint32Array(stride * 3)
  router.bestGStamp = new Uint32Array(stride * 3)
  router.bestGValue = new Float64Array(stride * 3)
  // First-via positions guard physical separation. As with the native bounded
  // search, alternate paths to the same state may be pruned; returned routes
  // still have to satisfy every physical check.
  let phases = new Uint8Array(1024),
    firstVias = new Int32Array(1024)
  let currentPhase = 0,
    currentFirstVia = -1,
    currentCell = -1,
    currentZ = -1,
    searchPhase = 0
  const enabled = () => requiresTransit[router.activeConnId] === true
  const nextPhase = (
    phase: number,
    fromZ: number,
    fromCell: number,
    z: number,
    cell: number,
  ) =>
    phase === 0 && fromZ === topZ && z !== topZ
      ? 1
      : phase === 1 && fromZ !== topZ && fromZ === z && fromCell !== cell
        ? 2
        : phase
  const push = router.nodePool.push.bind(router.nodePool)
  router.nodePool.push = (z, cell, g, parent, ripHead, ripCount) => {
    const index = push(z, cell, g, parent, ripHead, ripCount)
    if (index >= phases.length) {
      const size = Math.max(index + 1, phases.length * 2),
        next = new Uint8Array(size),
        vias = new Int32Array(size)
      next.set(phases)
      vias.set(firstVias)
      phases = next
      firstVias = vias
    }
    if (parent < 0 || !enabled()) {
      phases[index] = 0
      firstVias[index] = -1
      searchPhase = 0
      const segment = router.activeConnSeg
      if (
        enabled() &&
        segment &&
        segment.startCellId === segment.endCellId &&
        segment.startZ === segment.endZ
      )
        router.failed = true
    } else {
      const old = phases[parent]!,
        oldZ = router.nodePool.z[parent]!
      phases[index] = nextPhase(
        old,
        oldZ,
        router.nodePool.cellId[parent]!,
        z,
        cell,
      )
      firstVias[index] =
        old === 0 && oldZ === topZ && z !== topZ ? cell : firstVias[parent]!
    }
    return index
  }
  const pop = router.heap.pop.bind(router.heap)
  router.heap.pop = () => {
    const index = pop()
    currentPhase = phases[index]!
    searchPhase = currentPhase
    currentFirstVia = firstVias[index]!
    currentCell = router.nodePool.cellId[index]!
    currentZ = router.nodePool.z[index]!
    return index
  }
  const stateIndex = router.getSearchStateIdx.bind(router)
  router.getSearchStateIdx = (flat, rips) =>
    stateIndex(flat, rips) + (enabled() ? searchPhase * stride : 0)
  return {
    beforeFirstVia: () => !enabled() || currentPhase === 0,
    /** Called before the native move's state-key lookup, even if this move is rejected. */
    prepareMove(z: number, cell: number, isVia: boolean): boolean {
      searchPhase = enabled()
        ? nextPhase(currentPhase, currentZ, currentCell, z, cell)
        : 0
      if (!enabled()) return true
      if (isVia && z === topZ) {
        if (searchPhase !== 2 || currentFirstVia < 0) return false
        if (
          Math.hypot(
            router.cellCenterX[cell]! - router.cellCenterX[currentFirstVia]!,
            router.cellCenterY[cell]! - router.cellCenterY[currentFirstVia]!,
          ) <
          minimumViaDistance - 1e-9
        )
          return false
      }
      const end = router.activeConnSeg!
      return z !== end.endZ || cell !== end.endCellId || searchPhase === 2
    },
  }
}
