interface ViaOccupantRouter {
  _viaOccs: number[]
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
      for (let i = 0; i < cached.length; i++)
        push(cached[i]!, activeConnection, occupants)
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
