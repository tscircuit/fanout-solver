interface ViaOccupantRouter {
  _viaOccs: number[]
  usedCellsFlat?: Int32Array
  sharedCellsFlat?: (number[] | undefined)[]
  fillViaOccupants(cellId: number, activeConnection: number): void
  pushFlatOccupants(
    flatIndex: number,
    activeConnection: number,
    occupants: number[],
  ): void
}

/**
 * A router's grid, via diameter and layer count stay fixed during search.
 * Record the native neighborhood traversal once per cell, preserving its exact
 * order. Read current occupancy and ownership through the native routine on
 * every visit, including after rip-ups. Never cache the occupants themselves.
 */
export function cacheViaOccupantNeighborhoods(router: ViaOccupantRouter): void {
  if (
    typeof router.fillViaOccupants !== "function" ||
    typeof router.pushFlatOccupants !== "function"
  ) {
    throw new Error("FanoutSolver: native via-occupant interface changed")
  }
  const fill = router.fillViaOccupants.bind(router)
  const push = router.pushFlatOccupants.bind(router)
  const neighborhoods = new Map<number, Int32Array>()
  router.fillViaOccupants = (cellId, activeConnection) => {
    const cached = neighborhoods.get(cellId)
    if (cached) {
      const occupants = router._viaOccs
      occupants.length = 0
      const primary = router.usedCellsFlat
      const shared = router.sharedCellsFlat
      for (let i = 0; i < cached.length; i++) {
        const flat = cached[i]!
        // Read both live stores: a cell can retain shared halo owners after
        // its primary route is ripped up. Only truly empty cells skip the
        // native ownership and duplicate checks.
        if (primary && shared && primary[flat] === -1 && !shared[flat]) continue
        push(flat, activeConnection, occupants)
      }
      return
    }
    const visited: number[] = []
    const previousPush = router.pushFlatOccupants
    router.pushFlatOccupants = (flatIndex, owner, occupants) => {
      visited.push(flatIndex)
      push(flatIndex, owner, occupants)
    }
    try {
      fill(cellId, activeConnection)
    } finally {
      router.pushFlatOccupants = previousPush
    }
    neighborhoods.set(cellId, Int32Array.from(visited))
  }
}
