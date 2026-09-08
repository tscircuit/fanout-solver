import { expect, test } from "bun:test"
import {
  addBoundaryTerminalNeighbors,
  appendBoundaryTerminalApproach,
  BoundaryTerminalCopper,
  createBoundaryTerminalConnector,
  getBoundaryTerminalEntry,
  type TerminalCopperRoute,
} from "lib/boundary-terminal-connectors"

test("terminal elbows negotiate intervening copper and physical barrels after finalize, rip, and reroute", () => {
  const connector = createBoundaryTerminalConnector({
    connectionName: "entry",
    edge: "right",
    layer: "bottom",
    exit: { x: 5, y: 2.13 },
    bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 },
    approachLength: 1,
  })
  const xs: number[] = []
  const ys: number[] = []
  const offset: number[] = []
  const ids: number[] = []
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) {
      xs.push(x + 0.5)
      ys.push(y + 0.5)
      offset.push(ids.length)
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nx = x + dx!
        const ny = y + dy!
        if (nx >= 0 && nx < 5 && ny >= 0 && ny < 5) ids.push(ny * 5 + nx)
      }
    }
  offset.push(ids.length)
  const grid = {
    planeSize: 25,
    cellCenterX: Float64Array.from(xs),
    cellCenterY: Float64Array.from(ys),
    neighborOffset: Int32Array.from(offset),
    neighborIds: Int32Array.from(ids),
    neighborCosts: Float32Array.from(ids.map(() => 1)),
  }
  const before = JSON.stringify(grid)
  const extended = addBoundaryTerminalNeighbors({
    grid,
    terminals: [{ connector, cellId: 13 }],
    margin: 0.3,
    segmentIsClear: () => true,
  })
  expect(extended.extendedEdges.size).toBeGreaterThan(0)
  expect(JSON.stringify(grid)).toBe(before)
  // The selected approach is one millimeter deep; its candidate region must
  // include bends more than the old diagnostic's fixed 0.8mm from the edge.
  expect(extended.regions[0]!.minX).toBeLessThan(2)
  const entry = getBoundaryTerminalEntry({ x: 2, y: 1.13 }, connector)!
  expect(entry).toEqual([
    { x: 2, y: 1.13 },
    { x: 3, y: 2.13 },
    { x: 4, y: 2.13 },
  ])
  let routes: TerminalCopperRoute[] = []
  let reads = 0
  const copper = new BoundaryTerminalCopper({
    regions: extended.regions,
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.2,
    getRoutes: () => {
      reads++
      return routes
    },
  })
  expect([...copper.blockingSegmentOwners("entry", entry, 1)]).toEqual([])
  routes = [
    {
      connectionName: "crossing",
      route: [
        { x: 3, y: 1.9, z: 1 },
        { x: 3, y: 2.3, z: 1 },
      ],
      vias: [],
    },
  ]
  copper.invalidate() // native finalizeRoute
  expect([...copper.blockingSegmentOwners("entry", entry, 1)]).toEqual([
    "crossing",
  ])
  expect([
    ...copper.blockingSegmentOwners("entry", [entry[0]!, entry[0]!], 1),
  ]).toEqual([])
  expect([
    ...copper.blockingSegmentOwners("entry", [entry.at(-1)!, entry.at(-1)!], 1),
  ]).toEqual([])
  expect([...copper.blockingSegmentOwners("entry", entry, 0)]).toEqual([])
  expect([...copper.blockingSegmentOwners("crossing", entry, 1)]).toEqual([])
  const cachedReads = reads
  copper.blockingSegmentOwners("entry", entry, 1)
  expect(reads).toBe(cachedReads)
  routes = []
  copper.invalidate() // native ripTrace
  expect([...copper.blockingSegmentOwners("entry", entry, 1)]).toEqual([])
  const emitted = appendBoundaryTerminalApproach(
    {
      connectionName: "entry",
      route: [
        { ...entry[0]!, z: 1 },
        { ...connector.goal, z: 1 },
      ],
      vias: [],
    },
    connector,
    { x: 3.5, y: 2.5 },
  )
  routes = [emitted]
  copper.invalidate() // reroute/finalize; ordinary future moves see the bend
  expect([
    ...copper.blockingSegmentOwners(
      "later",
      [
        { x: 3, y: 1.9 },
        { x: 3, y: 2.3 },
      ],
      1,
    ),
  ]).toEqual(["entry"])
  expect([...copper.blockingViaOwners("later", { x: 3, y: 2.13 })]).toEqual([
    "entry",
  ])

  // Aligned goals produce a one-point entry, but their barrels still need an
  // independent point query. Through-via tests include every physical layer.
  expect(getBoundaryTerminalEntry(connector.goal, connector)).toHaveLength(1)
  routes = [
    {
      connectionName: "barrel-blocker",
      route: [
        { x: 4.1, y: 2, z: 0 },
        { x: 4.1, y: 2.3, z: 0 },
      ],
      vias: [],
    },
  ]
  copper.invalidate()
  expect([...copper.blockingViaOwners("entry", connector.goal)]).toEqual([
    "barrel-blocker",
  ])
  const actualCenter = { x: 3.7, y: 2.13 }
  routes = [
    { connectionName: "near-cell", route: [], vias: [{ x: 3.5, y: 2.13 }] },
  ]
  copper.invalidate()
  expect([...copper.blockingViaOwners("entry", actualCenter)]).toEqual([
    "near-cell",
  ])
  expect([...copper.blockingViaOwners("entry", connector.goal)]).toEqual([])
  const viaRoute = {
    connectionName: "entry",
    route: [
      { x: 3.5, y: 2.13, z: 0 },
      { ...actualCenter, z: 0 },
      { ...connector.goal, z: 1 },
    ],
    vias: [actualCenter],
  }
  const viaBefore = JSON.stringify(viaRoute)
  const appendedVia = appendBoundaryTerminalApproach(
    viaRoute,
    connector,
    actualCenter,
  )
  expect(appendedVia.route).toEqual([
    { x: 3.5, y: 2.13, z: 0 },
    { ...actualCenter, z: 0 },
    { ...actualCenter, z: 1 },
    { ...connector.goal, z: 1 },
    { ...connector.exit, z: 1 },
  ])
  expect(appendedVia.vias).toBe(viaRoute.vias)
  expect(JSON.stringify(viaRoute)).toBe(viaBefore)
  expect(() =>
    appendBoundaryTerminalApproach(viaRoute, connector, { x: 3.6, y: 2.13 }),
  ).toThrow("noncoincident")
})
