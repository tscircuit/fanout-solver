import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { getViaChannelGridPhase } from "lib/get-via-channel-grid-phase"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

// Two real through vias leave a 0.16616 mm trace-center throat. The old
// pad-aligned subdivision offers 0.16250 mm, below the 0.16256 mm trace pitch.
test("phases a uniform grid to fit two legal traces between reserved vias", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128,
    gridStep = 0.08128
  const vias = [
    { connectionIndex: 0, center: { x: 0, y: 0 }, diameter: 0.24 },
    { connectionIndex: 1, center: { x: 0.65, y: 0 }, diameter: 0.24 },
  ]
  const params = {
    vias,
    activeConnectionIndices: new Set([0, 1]),
    traceWidth,
    clearance,
    gridStep,
  }
  const original = structuredClone(vias)
  const phase = getViaChannelGridPhase(params)
  const tracks = [phase.x + gridStep * 3, phase.x + gridStep * 5]
  expect(phase.x).toBeCloseTo(-0.00012, 10)
  expect(phase.y).toBe(0)
  expect(tracks).toEqual([
    expect.closeTo(0.24372, 10),
    expect.closeTo(0.40628, 10),
  ])
  expect(tracks[1]! - tracks[0]!).toBeCloseTo(traceWidth + clearance, 10)
  for (const x of tracks)
    for (const via of vias)
      expect(
        Math.abs(x - via.center.x) - via.diameter / 2 - traceWidth / 2,
      ).toBeGreaterThan(clearance + 0.0017)
  expect(vias).toEqual(original)
  expect(
    getViaChannelGridPhase({ ...params, vias: vias.toReversed() }),
  ).toEqual(phase)
  expect(
    getViaChannelGridPhase({
      ...params,
      vias: vias.map((via) => ({
        ...via,
        center: { x: via.center.y, y: via.center.x },
      })),
    }),
  ).toEqual({ x: 0, y: phase.x })

  // Active channels win over a greater number of unrelated channels whose
  // feasible phases are incompatible. Both x/y and unequal barrels use the
  // same geometry calculation, rather than a package-specific phase constant.
  const otherVias = [2, 3].flatMap((y, index) =>
    vias.map((via) => ({
      ...via,
      connectionIndex: 2 + index * 2 + via.connectionIndex,
      center: { x: via.center.x + 0.04, y },
    })),
  )
  expect(
    getViaChannelGridPhase({ ...params, vias: [...vias, ...otherVias] }).x,
  ).toBeCloseTo(phase.x, 10)
  const unequal = getViaChannelGridPhase({
    ...params,
    vias: vias.map((via, index) => ({
      ...via,
      diameter: index === 0 ? 0.2 : 0.28,
    })),
  })
  expect(unequal.x).toBeCloseTo(-0.02012, 10)
  expect(getViaChannelGridPhase({ ...params, vias: [] })).toEqual({
    x: 0,
    y: 0,
  })
  expect(() => getViaChannelGridPhase({ ...params, gridStep: 0 })).toThrow()
  expect(() =>
    getViaChannelGridPhase({ ...params, clearance: Number.NaN }),
  ).toThrow()
  expect(() =>
    getViaChannelGridPhase({
      ...params,
      vias: [{ ...vias[0]!, diameter: -1 }],
    }),
  ).toThrow()

  const oldGridStep = 0.65 / 8
  const oldTracks = [oldGridStep * 3, oldGridStep * 5]
  expect(traceWidth + clearance - (oldTracks[1]! - oldTracks[0]!)).toBeCloseTo(
    0.00006,
    10,
  )
  const makeScene = (laneTracks: number[]): SimpleRouteJson => {
    const viaConnections = vias.map((via) => ({
      name: `via-${via.connectionIndex}`,
      pointsToConnect: [
        { x: via.center.x, y: -0.3, layer: "top" },
        { x: via.center.x, y: 0.3, layer: "bottom" },
      ],
    }))
    const laneConnections = laneTracks.map((x, index) => ({
      name: `lane-${index}`,
      pointsToConnect: [
        { x, y: -0.5, layer: "inner1" },
        { x, y: 0.5, layer: "inner1" },
      ],
    }))
    return {
      bounds: { minX: -0.3, maxX: 0.95, minY: -0.7, maxY: 0.7 },
      layerCount: 3,
      minTraceWidth: traceWidth,
      obstacles: [],
      connections: [...viaConnections, ...laneConnections],
      traces: [
        ...viaConnections.map((connection, index) => ({
          type: "pcb_trace" as const,
          pcb_trace_id: connection.name,
          connection_name: connection.name,
          route: [
            {
              route_type: "wire" as const,
              ...connection.pointsToConnect[0]!,
              width: traceWidth,
            },
            {
              route_type: "wire" as const,
              ...vias[index]!.center,
              layer: "top",
              width: traceWidth,
            },
            {
              route_type: "via" as const,
              ...vias[index]!.center,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.24,
              via_hole_diameter: 0.1,
            },
            {
              route_type: "wire" as const,
              ...vias[index]!.center,
              layer: "bottom",
              width: traceWidth,
            },
            {
              route_type: "wire" as const,
              ...connection.pointsToConnect[1]!,
              width: traceWidth,
            },
          ],
        })),
        ...laneConnections.map((connection) => ({
          type: "pcb_trace" as const,
          pcb_trace_id: connection.name,
          connection_name: connection.name,
          route: connection.pointsToConnect.map((point) => ({
            route_type: "wire" as const,
            ...point,
            width: traceWidth,
          })),
        })),
      ],
    }
  }
  const oldScene = makeScene(oldTracks),
    newScene = makeScene(tracks)
  const validate = (scene: SimpleRouteJson) =>
    validateRoutedCopperDrc({
      inputSrj: scene,
      routedSrj: scene,
      clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(validate(oldScene)).toMatchObject({ valid: false, checkedViaCount: 2 })
  expect(validate(oldScene).issues.map((issue) => issue.code)).toEqual([
    "different-net-trace-clearance",
  ])
  expect(validate(newScene)).toMatchObject({
    valid: true,
    checkedTraceCount: 4,
    checkedViaCount: 2,
    issues: [],
  })

  const panels = [
    {
      offset: 0,
      tracks: oldTracks,
      color: "#dc2626",
      title: "Pad-aligned grid: 0.08125 mm",
      label: "81.22 µm clearance — fails",
    },
    {
      offset: 1.75,
      tracks,
      color: "#2563eb",
      title: "Phased grid: 0.08128 mm",
      label: "81.28 µm clearance — passes",
    },
  ]
  await expect(
    getSvgFromGraphicsObject({
      coordinateSystem: "cartesian",
      circles: panels.flatMap(({ offset }) =>
        vias.flatMap((via) => [
          {
            center: { x: via.center.x + offset, y: 0 },
            radius: 0.12,
            fill: "#64748b",
          },
          {
            center: { x: via.center.x + offset, y: 0 },
            radius: 0.05,
            fill: "#ffffff",
          },
        ]),
      ),
      lines: panels.flatMap(({ offset, tracks, color }) =>
        tracks.map((x) => ({
          points: [
            { x: x + offset, y: -0.5 },
            { x: x + offset, y: 0.5 },
          ],
          strokeColor: color,
          strokeWidth: traceWidth,
        })),
      ),
      texts: panels.flatMap(({ offset, title, label, color }) => [
        {
          x: offset + 0.325,
          y: 0.75,
          text: title,
          fontSize: 0.09,
          color: "#0f172a",
          anchorSide: "center" as const,
        },
        {
          x: offset + 0.325,
          y: -0.75,
          text: label,
          fontSize: 0.085,
          color,
          anchorSide: "center" as const,
        },
        {
          x: offset + 0.325,
          y: -0.9,
          text: "0.65 mm via pitch · 0.24 mm barrels",
          fontSize: 0.065,
          color: "#64748b",
          anchorSide: "center" as const,
        },
      ]),
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
