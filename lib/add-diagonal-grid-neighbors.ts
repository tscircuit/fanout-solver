export interface UniformNeighborGrid {
  planeSize: number
  cellCenterX: Float64Array
  cellCenterY: Float64Array
  cellMinX: Float64Array
  cellMaxX: Float64Array
  cellMinY: Float64Array
  cellMaxY: Float64Array
  neighborOffset: Int32Array
  neighborIds: Int32Array
  neighborCosts: Float32Array
}

/**
 * Add one-cell 45-degree edges without changing existing cardinal/seam links.
 * Clipped or unequal cells retain their original adjacency. Callers must apply
 * their existing exact segment, dynamic copper and final route validation.
 */
export function addDiagonalGridNeighbors(
  grid: UniformNeighborGrid,
): Pick<
  UniformNeighborGrid,
  "neighborOffset" | "neighborIds" | "neighborCosts"
> {
  const offsets = new Int32Array(grid.planeSize + 1)
  const ids: number[] = [],
    costs: number[] = []
  for (let cell = 0; cell < grid.planeSize; cell++) {
    offsets[cell] = ids.length
    const existing = new Set<number>()
    for (
      let i = grid.neighborOffset[cell]!;
      i < grid.neighborOffset[cell + 1]!;
      i++
    ) {
      const next = grid.neighborIds[i]!
      existing.add(next)
      ids.push(next)
      costs.push(grid.neighborCosts[i]!)
    }
    const candidates = new Set<number>()
    const width = grid.cellMaxX[cell]! - grid.cellMinX[cell]!
    const height = grid.cellMaxY[cell]! - grid.cellMinY[cell]!
    for (
      let i = grid.neighborOffset[cell]!;
      i < grid.neighborOffset[cell + 1]!;
      i++
    ) {
      const neighbor = grid.neighborIds[i]!
      for (
        let j = grid.neighborOffset[neighbor]!;
        j < grid.neighborOffset[neighbor + 1]!;
        j++
      ) {
        const next = grid.neighborIds[j]!
        if (next === cell || existing.has(next)) continue
        const dx = Math.abs(grid.cellCenterX[next]! - grid.cellCenterX[cell]!)
        const dy = Math.abs(grid.cellCenterY[next]! - grid.cellCenterY[cell]!)
        if (
          dx < 1e-9 ||
          Math.abs(dx - dy) > 1e-9 ||
          Math.abs(dx - width) > 1e-9 ||
          Math.abs(dy - height) > 1e-9 ||
          Math.abs(grid.cellMaxX[next]! - grid.cellMinX[next]! - width) >
            1e-9 ||
          Math.abs(grid.cellMaxY[next]! - grid.cellMinY[next]! - height) > 1e-9
        )
          continue
        candidates.add(next)
      }
    }
    for (const next of [...candidates].sort((a, b) => a - b)) {
      ids.push(next)
      costs.push(
        Math.hypot(
          grid.cellCenterX[next]! - grid.cellCenterX[cell]!,
          grid.cellCenterY[next]! - grid.cellCenterY[cell]!,
        ),
      )
    }
  }
  offsets[grid.planeSize] = ids.length
  return {
    neighborOffset: offsets,
    neighborIds: Int32Array.from(ids),
    neighborCosts: Float32Array.from(costs),
  }
}
