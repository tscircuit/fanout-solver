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
  maxAssignments: number
}): Array<Readonly<Record<string, string>>> {
  const { busIds, layers, maxAssignments } = params
  if (layers.length === 0) {
    throw new Error("FanoutSolver: no escape layers are available")
  }
  if (!Number.isInteger(maxAssignments) || maxAssignments < 1) {
    throw new Error(
      `FanoutSolver: maxLayerCombinations must be positive, received ${maxAssignments}`,
    )
  }

  const rawCombinationCount = layers.length ** busIds.length
  const combinationCount = Math.min(
    maxAssignments,
    Number.isFinite(rawCombinationCount) ? rawCombinationCount : maxAssignments,
  )
  const assignments: Array<Readonly<Record<string, string>>> = []

  for (let ordinal = 0; ordinal < combinationCount; ordinal++) {
    const assignment: Record<string, string> = {}
    let remaining = ordinal
    for (let busIndex = 0; busIndex < busIds.length; busIndex++) {
      const digit = remaining % layers.length
      remaining = Math.floor(remaining / layers.length)
      const rotatedLayerIndex = (digit + busIndex) % layers.length
      assignment[busIds[busIndex]!] = layers[rotatedLayerIndex]!
    }
    assignments.push(assignment)
  }

  return assignments
}
