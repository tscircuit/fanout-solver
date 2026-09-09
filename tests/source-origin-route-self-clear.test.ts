import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { sourceOriginRouteIsSelfClear } from "lib/source-origin-route-self-clear"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("TOP returns and through-vias cannot shortcut retained copper on their own net", async () => {
  const rules = {
    topZ: 0,
    traceWidth: 0.1,
    viaDiameter: 0.3,
    clearance: 0.1,
  }
  const points = (coordinates: [number, number, number][]) =>
    coordinates.map(([x, y, z]) => ({ x, y, z }))
  // Both holes are legal and separated. The returned TOP arm still bypasses
  // the internal excursion by crossing the original source prefix at (-1, 0).
  const crossing = points([
    [-2, 0, 0],
    [0, 0, 0],
    [0, 0, 1],
    [0.5, 0.5, 1],
    [0.5, 1, 1],
    [0, 1.5, 1],
    [-0.5, 1.5, 1],
    [-1, 1, 1],
    [-1, 1, 0],
    [-1, -1, 0],
    [-0.5, -1.5, 0],
    [3, -1.5, 0],
  ])
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const route: SimplifiedPcbTrace["route"] = []
  for (const [index, point] of crossing.entries()) {
    const previous = crossing[index - 1]
    if (previous && previous.z !== point.z)
      route.push({
        route_type: "via",
        x: point.x,
        y: point.y,
        from_layer: layerNames[previous.z]!,
        to_layer: layerNames[point.z]!,
        via_diameter: rules.viaDiameter,
        via_hole_diameter: 0.15,
      })
    route.push({
      route_type: "wire",
      x: point.x,
      y: point.y,
      layer: layerNames[point.z]!,
      width: rules.traceWidth,
    })
    if (!previous || previous.z !== point.z) continue
    const dx = point.x - previous.x,
      dy = point.y - previous.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const earlier = crossing[index - 2]
    if (!earlier || earlier.z !== point.z) continue
    const px = previous.x - earlier.x,
      py = previous.y - earlier.y
    expect(
      (px * dx + py * dy) / (Math.hypot(dx, dy) * Math.hypot(px, py)),
    ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
  }
  const srj: SimpleRouteJson = {
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    obstacles: [
      {
        type: "rect",
        center: { x: -2, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["signal"],
      },
    ],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 3, y: -1.5, layer: "top" },
        ],
      },
    ],
  }
  const routedSrj: SimpleRouteJson = {
    ...srj,
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "signal",
        connection_name: "signal",
        route,
      },
    ],
  }
  // The ordinary DRC deliberately permits same-net contact, so it does not
  // establish that the source-to-boundary path really traverses both vias.
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 2, issues: [] })
  expect(
    Math.hypot(
      crossing[2]!.x - crossing[8]!.x,
      crossing[2]!.y - crossing[8]!.y,
    ),
  ).toBeGreaterThan(rules.viaDiameter + rules.clearance)
  expect(sourceOriginRouteIsSelfClear({ ...rules, points: crossing })).toBe(
    false,
  )

  // Trace centerlines clear each other, but the return barrel reaches the
  // earlier TOP prefix. Only its actual incoming/outgoing leads are incident.
  const barrelTouchesPrefix = [
    ...crossing.slice(0, 8),
    ...points([
      [-1, 0.25, 1],
      [-1, 0.25, 0],
      [-1, 1, 0],
      [-0.5, 1.5, 0],
      [3, 1.5, 0],
    ]),
  ]
  expect(
    sourceOriginRouteIsSelfClear({ ...rules, points: barrelTouchesPrefix }),
  ).toBe(false)
  const overlappingHoles = points([
    [-2, 0, 0],
    [0, 0, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 0, 2],
    [1, 0.1, 2],
    [1, 0.1, 0],
    [3, 0.1, 0],
  ])
  expect(
    sourceOriginRouteIsSelfClear({ ...rules, points: overlappingHoles }),
  ).toBe(false)

  // Short chamfered, contiguous incident leads can legitimately contain more
  // than one segment inside the barrel's clearance radius.
  const clear = points([
    [-2, 0, 0],
    [-0.05, 0, 0],
    [0, 0.05, 0],
    [0, 0.05, 1],
    [0.05, 0.1, 1],
    [0.1, 0.1, 1],
    [1, 0.1, 1],
    [1, 0.1, 0],
    [1.05, 0.1, 0],
    [1.1, 0.05, 0],
    [3, 0.05, 0],
  ])
  expect(sourceOriginRouteIsSelfClear({ ...rules, points: clear })).toBe(true)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
