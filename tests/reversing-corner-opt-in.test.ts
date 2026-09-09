import { expect, test } from "bun:test"
import { distanceSegmentToObstacle } from "lib/geometry"
import {
  type LayeredPathPoint,
  normalizeLayeredPath,
} from "lib/normalize-layered-path"

test("reversing corners require an explicit clear final repair with fixed terminals and vias", async () => {
  const points = [
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 1 },
    { x: 0, y: 1, z: 1 },
    { x: 0, y: 1, z: 2 },
    { x: 0, y: 2, z: 2 },
  ]
  const before = JSON.stringify(points)
  const params = { points, chamfer: 0.24, segmentIsClear: () => true }
  expect(normalizeLayeredPath(params)).toBeNull()
  const repaired = normalizeLayeredPath({
    ...params,
    repairReversingDiagonalCorners: true,
  })
  expect(repaired).not.toBeNull()
  expect(repaired![0]).toBe(points[0])
  expect(repaired!.at(-1)).toBe(points.at(-1))
  const transitions = (path: LayeredPathPoint[]) =>
    path.slice(1).flatMap((p, i) => (p.z === path[i]!.z ? [] : [[path[i]!, p]]))
  const originalVias = transitions(points)
  const repairedVias = transitions(repaired!)
  expect(repairedVias).toHaveLength(2)
  for (let i = 0; i < originalVias.length; i++) {
    expect(repairedVias[i]![0]).toBe(originalVias[i]![0])
    expect(repairedVias[i]![1]).toBe(originalVias[i]![1])
  }
  for (let i = 1; i < repaired!.length; i++) {
    const a = repaired![i - 1]!,
      b = repaired![i]!,
      c = repaired![i + 1]
    if (a.z !== b.z) continue
    const dx = b.x - a.x,
      dy = b.y - a.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    if (c?.z === b.z) {
      const dot =
        (dx * (c.x - b.x) + dy * (c.y - b.y)) /
        (Math.hypot(dx, dy) * Math.hypot(c.x - b.x, c.y - b.y))
      expect(dot).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const blocker = {
    type: "rect" as const,
    shape: "circle" as const,
    center: { x: 1, y: 0 },
    width: 0.5,
    height: 0.5,
    layers: ["inner1"],
    connectedTo: [],
  }
  const width = 0.06,
    clearance = 0.04
  expect(
    normalizeLayeredPath({
      ...params,
      repairReversingDiagonalCorners: true,
      segmentIsClear: (start, end) =>
        start.z !== 1 ||
        distanceSegmentToObstacle(
          { start, end, layer: "inner1", width },
          blocker,
        ) >=
          width / 2 + clearance - 1e-7,
    }),
  ).toBeNull()
  expect(JSON.stringify(points)).toBe(before)

  const scale = 85
  const panel = (
    path: LayeredPathPoint[],
    title: string,
    offset: number,
    blocked = false,
    accepted = false,
  ) => {
    const xy = (p: LayeredPathPoint) => ({
      x: 130 + p.x * scale,
      y: 275 - p.y * scale,
    })
    const segments = path
      .slice(1)
      .flatMap((p, i) => {
        const a = path[i]!
        if (a.z !== p.z) return []
        const start = xy(a),
          end = xy(p)
        return [
          `<path d="M ${start.x} ${start.y} L ${end.x} ${end.y}" stroke="${accepted ? ["#b45309", "#2563eb", "#15803d"][p.z] : "#64748b"}" stroke-width="5.1" ${accepted ? "" : 'stroke-dasharray="5 4"'}/>`,
        ]
      })
      .join("")
    const vias = originalVias
      .map(([p]) => {
        const at = xy(p!)
        return `<circle cx="${at.x}" cy="${at.y}" r="7" fill="white" stroke="#0f172a" stroke-width="2"/>`
      })
      .join("")
    const obstacle = xy({ ...blocker.center, z: 1 })
    return `<g transform="translate(${offset},0)">
      <text x="15" y="30" font-size="16" font-weight="600">${title}</text>
      <text x="15" y="53" font-size="12" fill="#475569">${accepted ? "45° turns; terminals and vias retained" : "Candidate rejected; no copper emitted"}</text>
      ${blocked ? `<circle cx="${obstacle.x}" cy="${obstacle.y}" r="${(blocker.width / 2 + width / 2 + clearance) * scale}" fill="#fee2e2"/><circle cx="${obstacle.x}" cy="${obstacle.y}" r="${(blocker.width / 2) * scale}" fill="#fca5a5" stroke="#b91c1c"/>` : ""}
      ${segments}${vias}
      <circle cx="45" cy="275" r="5" fill="#0f172a"/><circle cx="130" cy="105" r="5" fill="#0f172a"/>
      <text x="25" y="305" font-size="12">Source</text><text x="143" y="105" font-size="12">Destination</text>
    </g>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="330" viewBox="0 0 840 330">
    <rect width="840" height="330" fill="white"/>
    <g font-family="sans-serif" fill="#0f172a">
      ${panel(points, "Intermediate: rejected", 0)}
      ${panel(repaired!, "Final repair: accepted", 280, false, true)}
      ${panel(points, "Blocked repair: rejected", 560, true)}
    </g>
  </svg>`
  await expect(
    svg
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
  ).toMatchSvgSnapshot(import.meta.path)
})
