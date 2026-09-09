import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { getBoundaryTargetTrack } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"

test("spreads clamped single-layer K230 control targets into ordered boundary slots", async () => {
  // Exact LP4_B_CA_CTRL guidance from dataset31 sample29, dataset145d744.
  const definitions = [
    { name: "54", x: 6.175, y: 3.575, targetY: 16.75739272727273 },
    { name: "51", x: 5.525, y: 2.275, targetY: 17.25995272727273 },
    { name: "52", x: 4.875, y: 2.275, targetY: 15.249712727272728 },
    { name: "50", x: 4.225, y: 1.625, targetY: 14.747152727272729 },
    { name: "55", x: 4.225, y: 2.925, targetY: 14.244592727272728 },
    { name: "53", x: 5.525, y: 2.925, targetY: 13.74203272727273 },
    { name: "48", x: 6.175, y: 0.975, targetY: 15.752272727272729 },
    { name: "49", x: 4.875, y: 0.975, targetY: 16.25483272727273 },
  ]
  const boundary = { minX: -14.325, maxX: 14.325, minY: -14.325, maxY: 14.325 }
  const pads = definitions.map(({ name, x, y }) => ({
    obstacleId: name,
    componentId: "U1",
    type: "rect" as const,
    shape: "circle" as const,
    center: { x, y },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: [name],
  }))
  const prepared: PreparedConnection[] = definitions.map(
    ({ name, x, y, targetY }, index) => {
      const source = { x, y, layer: "top" }
      const target = { x: 17.900100000000002, y: targetY, layer: "inner6" }
      return {
        connection: { name, pointsToConnect: [source, target] },
        connectionIndex: index,
        sourcePointIndex: 0,
        sourcePoint: source,
        sourceLayer: "top",
        sourceObstacle: pads[index]!,
        targetPoint: target,
        exitTargetPoint: target,
        hasExplicitLayeredExitTarget: true,
      }
    },
  )
  const bus: PreparedBus = {
    busId: "LP4_B_CA_CTRL",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -6.325, maxX: 6.325, minY: -6.325, maxY: 6.325 },
    sharedBoundary: boundary,
    xCoordinates: definitions.map(({ x }) => x),
    yCoordinates: definitions.map(({ y }) => y),
    pitchX: 0.65,
    pitchY: 0.65,
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    allowedLayers: ["inner6"],
    routableEscapeLayers: ["inner6"],
    termination: { type: "boundary" },
    connections: prepared,
  }
  const params = {
    bus,
    boundaryDirection: "right" as const,
    traceWidth: 0.08128,
    clearance: 0.08128,
    layerNames: [
      "top",
      "inner1",
      "inner2",
      "inner3",
      "inner4",
      "inner5",
      "inner6",
      "bottom",
    ],
    targetLayer: "inner6",
  }
  const original = structuredClone(bus)
  expect(
    definitions.filter(({ targetY }) => targetY > boundary.maxY),
  ).toHaveLength(6)
  const tracks = prepared.map((connection) =>
    getBoundaryTargetTrack({ ...params, connection }),
  )
  expect(new Set(tracks.map((track) => track.toFixed(8))).size).toBe(8)
  const ordered = prepared.toSorted(
    (a, b) => a.exitTargetPoint!.y - b.exitTargetPoint!.y,
  )
  const orderedTracks = ordered.map(
    (connection) => tracks[connection.connectionIndex]!,
  )
  for (const [index, track] of orderedTracks.entries()) {
    expect(track).toBeGreaterThanOrEqual(boundary.minY)
    expect(track).toBeLessThanOrEqual(boundary.maxY)
    if (index > 0)
      expect(track - orderedTracks[index - 1]!).toBeCloseTo(0.16256, 8)
  }
  expect(orderedTracks.at(-1)).toBeCloseTo(boundary.maxY, 8)
  expect(bus).toEqual(original)
  const separatedBus = {
    ...bus,
    connections: prepared.map((connection, index) => ({
      ...connection,
      exitTargetPoint: { x: 17.9, y: index * 0.5, layer: "inner6" },
    })),
  }
  for (const connection of separatedBus.connections) {
    expect(
      getBoundaryTargetTrack({
        ...params,
        bus: separatedBus,
        connection,
        allowLayerInterleaving: true,
      }),
    ).toBe(connection.exitTargetPoint.y)
  }
  const graphics = {
    lines: [
      {
        points: [
          { x: boundary.maxX, y: 12.8 },
          { x: boundary.maxX, y: boundary.maxY },
        ],
        strokeColor: "#dc2626",
        strokeWidth: 0.025,
      },
      {
        points: [
          { x: boundary.maxX - 0.4, y: boundary.maxY },
          { x: boundary.maxX, y: boundary.maxY },
        ],
        strokeColor: "#dc2626",
        strokeWidth: 0.025,
      },
      ...definitions.map(({ targetY }, index) => ({
        points: [
          { x: 17.9001, y: targetY },
          { x: boundary.maxX, y: tracks[index]! },
        ],
        strokeColor: "#94a3b8",
        strokeWidth: 0.012,
        strokeDash: [0.08, 0.05],
      })),
      ...tracks.map((track) => ({
        points: [
          { x: boundary.maxX - 0.18, y: track },
          { x: boundary.maxX + 0.18, y: track },
        ],
        strokeColor: "#2563eb",
        strokeWidth: 0.04,
      })),
    ],
    texts: [
      {
        x: 16.0,
        y: 17.8,
        text: "Downstream RAM guidance",
        fontSize: 0.2,
        color: "#475569",
      },
      {
        x: 15.8,
        y: 12.5,
        text: "8 distinct inner6 boundary targets",
        fontSize: 0.2,
        color: "#2563eb",
      },
    ],
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
