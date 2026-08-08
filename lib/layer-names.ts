export function getCopperLayerNames(layerCount: number): string[] {
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new Error(
      `FanoutSolver: layerCount must be a positive integer, received ${layerCount}`,
    )
  }
  if (layerCount === 1) return ["top"]
  if (layerCount === 2) return ["top", "bottom"]

  return [
    "top",
    ...Array.from(
      { length: layerCount - 2 },
      (_, index) => `inner${index + 1}`,
    ),
    "bottom",
  ]
}

export function getLayerSpan(
  fromLayer: string,
  toLayer: string,
  layerNames: string[],
): string[] {
  const fromIndex = layerNames.indexOf(fromLayer)
  const toIndex = layerNames.indexOf(toLayer)
  if (fromIndex < 0 || toIndex < 0) {
    throw new Error(
      `FanoutSolver: cannot build via span from "${fromLayer}" to "${toLayer}"`,
    )
  }
  const firstIndex = Math.min(fromIndex, toIndex)
  const lastIndex = Math.max(fromIndex, toIndex)
  return layerNames.slice(firstIndex, lastIndex + 1)
}

export function generateLayerAssignments(params: {
  busIds: string[]
  layers: string[]
  layersByBusId?: Readonly<Record<string, readonly string[]>>
  maxAssignments: number
}): Array<Readonly<Record<string, string>>> {
  const { busIds, layers, layersByBusId, maxAssignments } = params
  if (layers.length === 0) {
    throw new Error("FanoutSolver: no escape layers are available")
  }
  if (!Number.isInteger(maxAssignments) || maxAssignments < 1) {
    throw new Error(
      `FanoutSolver: maxLayerCombinations must be positive, received ${maxAssignments}`,
    )
  }

  const availableLayersByBus = busIds.map(
    (busId) => layersByBusId?.[busId] ?? layers,
  )
  const busWithoutLayersIndex = availableLayersByBus.findIndex(
    (availableLayers) => availableLayers.length === 0,
  )
  if (busWithoutLayersIndex >= 0) {
    throw new Error(
      `FanoutSolver: no escape layers are available for bus "${busIds[busWithoutLayersIndex]}"`,
    )
  }

  const rawCombinationCount = availableLayersByBus.reduce(
    (count, availableLayers) => count * availableLayers.length,
    1,
  )
  const combinationCount = Math.min(
    maxAssignments,
    Number.isFinite(rawCombinationCount) ? rawCombinationCount : maxAssignments,
  )
  const assignments: Array<Readonly<Record<string, string>>> = []
  const seenAssignments = new Set<string>()

  function addAssignment(layerIndexes: number[]): void {
    const assignment: Record<string, string> = {}
    for (let busIndex = 0; busIndex < busIds.length; busIndex++) {
      assignment[busIds[busIndex]!] =
        availableLayersByBus[busIndex]![layerIndexes[busIndex]!]!
    }
    const key = JSON.stringify(assignment)
    if (seenAssignments.has(key)) return
    seenAssignments.add(key)
    assignments.push(assignment)
  }

  if (rawCombinationCount <= maxAssignments) {
    for (let ordinal = 0; ordinal < combinationCount; ordinal++) {
      const layerIndexes: number[] = []
      let remaining = ordinal
      for (let busIndex = 0; busIndex < busIds.length; busIndex++) {
        const layerCount = availableLayersByBus[busIndex]!.length
        const digit = remaining % layerCount
        remaining = Math.floor(remaining / layerCount)
        layerIndexes.push((digit + busIndex) % layerCount)
      }
      addAssignment(layerIndexes)
    }
    return assignments
  }

  function mix32(value: number): number {
    let mixed = value | 0
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad)
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97)
    return (mixed ^ (mixed >>> 15)) >>> 0
  }

  const balancedLayerIndexes = busIds.map(
    (_, busIndex) => busIndex % availableLayersByBus[busIndex]!.length,
  )
  addAssignment(balancedLayerIndexes)
  const maximumAvailableLayerCount = Math.max(
    ...availableLayersByBus.map((availableLayers) => availableLayers.length),
  )
  for (
    let globalShift = 1;
    globalShift < maximumAvailableLayerCount &&
    assignments.length < combinationCount;
    globalShift++
  ) {
    addAssignment(
      balancedLayerIndexes.map(
        (layerIndex, busIndex) =>
          (layerIndex + globalShift) % availableLayersByBus[busIndex]!.length,
      ),
    )
  }
  for (
    let busIndex = 0;
    busIndex < busIds.length && assignments.length < combinationCount;
    busIndex++
  ) {
    for (
      let shift = 1;
      shift < availableLayersByBus[busIndex]!.length &&
      assignments.length < combinationCount;
      shift++
    ) {
      const layerIndexes = [...balancedLayerIndexes]
      layerIndexes[busIndex] =
        (balancedLayerIndexes[busIndex]! + shift) %
        availableLayersByBus[busIndex]!.length
      addAssignment(layerIndexes)
    }
  }
  for (
    let seed = 1;
    assignments.length < combinationCount && seed < combinationCount * 20;
    seed++
  ) {
    addAssignment(
      busIds.map(
        (_, busIndex) =>
          mix32(seed * 0x9e3779b1 + busIndex * 0x85ebca6b) %
          availableLayersByBus[busIndex]!.length,
      ),
    )
  }

  return assignments
}
