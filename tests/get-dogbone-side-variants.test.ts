import { expect, test } from "bun:test"
import { getDogboneSideVariants } from "lib/get-dogbone-side-variants"

test("local dogbone variants are bounded and rotate with the source rows", () => {
  const connections = [
    { connectionIndex: 7, sourcePoint: { x: 0, y: 0 } },
    { connectionIndex: 2, sourcePoint: { x: 0.5, y: 0 } },
    { connectionIndex: 9, sourcePoint: { x: 0.5, y: 0.5 } },
  ]
  const expected = [[7], [2], [9], [7, 2]]
  expect(getDogboneSideVariants(connections, "down")).toEqual(expected)
  expect(getDogboneSideVariants(connections, "up")).toEqual(expected)
  const rotated = connections.map((connection) => ({
    ...connection,
    sourcePoint: { x: -connection.sourcePoint.y, y: connection.sourcePoint.x },
  }))
  expect(getDogboneSideVariants(rotated, "left")).toEqual(expected)
  expect(getDogboneSideVariants(rotated, "right")).toEqual(expected)
  const wideRow = Array.from({ length: 64 }, (_, connectionIndex) => ({
    connectionIndex,
    sourcePoint: { x: connectionIndex * 0.5, y: 0 },
  }))
  expect(getDogboneSideVariants(wideRow, "down")).toHaveLength(32)
})
