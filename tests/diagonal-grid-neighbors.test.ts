import { expect, test } from "bun:test"
import { addDiagonalGridNeighbors } from "lib/add-diagonal-grid-neighbors"

test("diagonal grid edges preserve cardinal costs and exclude clipped cells", () => {
  const grid = {
    planeSize: 4,
    cellCenterX: new Float64Array([0, 1, 0, 1]),
    cellCenterY: new Float64Array([0, 0, 1, 1]),
    cellMinX: new Float64Array([-0.5, 0.5, -0.5, 0.5]),
    cellMaxX: new Float64Array([0.5, 1.5, 0.5, 1.5]),
    cellMinY: new Float64Array([-0.5, -0.5, 0.5, 0.5]),
    cellMaxY: new Float64Array([0.5, 0.5, 1.5, 1.5]),
    neighborOffset: new Int32Array([0, 2, 4, 6, 8]),
    neighborIds: new Int32Array([1, 2, 0, 3, 0, 3, 1, 2]),
    neighborCosts: new Float32Array(8).fill(1),
  }
  const before = JSON.stringify(grid)
  const diagonal = addDiagonalGridNeighbors(grid)
  for (let cell = 0; cell < 4; cell++) {
    const offset = diagonal.neighborOffset[cell]!
    expect([...diagonal.neighborIds.slice(offset, offset + 2)]).toEqual([
      ...grid.neighborIds.slice(cell * 2, cell * 2 + 2),
    ])
    expect([...diagonal.neighborCosts.slice(offset, offset + 2)]).toEqual([
      1, 1,
    ])
    expect(diagonal.neighborIds[offset + 2]).toBe(3 - cell)
    expect(diagonal.neighborCosts[offset + 2]).toBeCloseTo(Math.SQRT2)
  }
  expect(JSON.stringify(grid)).toBe(before)
  grid.cellMaxX[3] = 1.25
  grid.cellMaxY[3] = 1.25
  grid.cellCenterX[3] = 0.875
  grid.cellCenterY[3] = 0.875
  const clipped = addDiagonalGridNeighbors(grid)
  expect([
    ...clipped.neighborIds.slice(
      clipped.neighborOffset[0],
      clipped.neighborOffset[1],
    ),
  ]).toEqual([1, 2])
  expect([
    ...clipped.neighborIds.slice(
      clipped.neighborOffset[3],
      clipped.neighborOffset[4],
    ),
  ]).toEqual([1, 2])
  expect([
    ...clipped.neighborIds.slice(
      clipped.neighborOffset[1],
      clipped.neighborOffset[2],
    ),
  ]).toEqual([0, 3, 2])
})
