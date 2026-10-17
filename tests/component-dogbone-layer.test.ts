import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
} from "lib/match-component-dogbone-via-sites"
import type { PreparedBus, PreparedConnection } from "lib/types"

// Board-world XY in mm, +X right and +Y up. The source wire stays on TOP;
// its through-via must clear obstacles on every physical copper layer.
const via = { x: -0.4, y: -0.4 }

function fixture(blocker: Obstacle) {
  const pads: (Obstacle & { shape: "circle" })[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0.8 },
    { x: 0.8, y: 0 },
    { x: 0.8, y: 0.8 },
  ].map((center, index) => ({
    obstacleId: `pad-${index}`,
    componentId: "U1",
    type: "rect",
    shape: "circle",
    center,
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: [`signal-${index}`],
  }))
  const connection: PreparedConnection = {
    connection: {
      name: "signal-0",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top", pointId: "source", pcb_port_id: "port" },
        { x: -3, y: 0, layer: "bottom", pointId: "target" },
      ],
    },
    connectionIndex: 0,
    sourcePoint: {
      x: 0,
      y: 0,
      layer: "top",
      pointId: "source",
      pcb_port_id: "port",
    },
    sourcePointIndex: 0,
    sourceLayer: "top",
    sourceObstacle: pads[0]!,
    targetPoint: { x: -3, y: 0, layer: "bottom", pointId: "target" },
  }
  const buses: PreparedBus[] = [
    {
      busId: "DATA",
      direction: "left",
      termination: { type: "boundary" },
      componentId: "U1",
      componentObstacles: pads,
      componentBounds: { minX: -0.2, maxX: 1, minY: -0.2, maxY: 1 },
      sharedBoundary: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
      xCoordinates: [0, 0.8],
      yCoordinates: [0, 0.8],
      pitchX: 0.8,
      pitchY: 0.8,
      connections: [connection],
    },
  ]
  const rules = {
    viaDiameter: 0.5,
    viaHoleDiameter: 0.3,
    traceWidth: 0.1,
    clearance: 0.1,
    maximumSearchStates: 10,
    fixedViaPointsByConnectionIndex: new Map([[0, via]]),
    additionalObstacles: [blocker],
  }
  return { buses, pads, rules }
}

function obstacle(
  layer: "top" | "bottom",
  center: { x: number; y: number },
): Obstacle {
  return {
    obstacleId: "foreign-pad",
    componentId: "C1",
    type: "rect",
    center,
    width: 0.05,
    height: 0.05,
    layers: [layer],
    connectedTo: ["foreign-net"],
  }
}

test("dogbone wires ignore opposite-layer pads while through-vias clear every layer", async () => {
  // At (-0.1, -0.1), the foreign pad intersects the wire interior but its
  // nearest corner is over 0.388 mm from the via center: clear of the
  // 0.25 mm via radius plus 0.1 mm clearance. Only its layer should decide
  // whether it blocks the wire. At the via center, either layer must block.
  const cases = [
    {
      label: "BOTTOM pad under TOP wire",
      detail: "Accepted: different wire layer",
      blocker: obstacle("bottom", { x: -0.1, y: -0.1 }),
      accepted: true,
    },
    {
      label: "TOP pad across TOP wire",
      detail: "Rejected: same-layer wire collision",
      blocker: obstacle("top", { x: -0.1, y: -0.1 }),
      accepted: false,
    },
    {
      label: "BOTTOM pad at through-via",
      detail: "Rejected: via spans BOTTOM too",
      blocker: obstacle("bottom", via),
      accepted: false,
    },
  ]
  const graphics: GraphicsObject = {
    title: "Dogbone candidate clearance: TOP wire and through-via",
    coordinateSystem: "cartesian",
    circles: [],
    lines: [],
    rects: [],
    texts: [],
  }
  for (const [panel, scenario] of cases.entries()) {
    const { buses, pads, rules } = fixture(scenario.blocker)
    const candidates = getComponentDogboneViaSiteCandidates(buses, rules)
    const matching = matchComponentDogboneViaSites(buses, rules)
    expect(candidates).toEqual(
      scenario.accepted ? [{ connectionIndex: 0, point: via }] : [],
    )
    expect(matching ? [...matching] : null).toEqual(
      scenario.accepted ? [[0, via]] : null,
    )

    const shift = panel * 3.4
    const color = matching ? "#2b8a3e" : "#868e96"
    const blockerColor = scenario.blocker.layers.includes("top")
      ? "#e03131"
      : "#1971c2"
    graphics.texts!.push(
      {
        x: 0.2 + shift,
        y: 1.55,
        text: scenario.label,
        fontSize: 0.14,
      },
      {
        x: 0.2 + shift,
        y: -1.05,
        text: scenario.detail,
        color: matching ? "#2b8a3e" : "#c92a2a",
        fontSize: 0.12,
      },
    )
    for (const pad of pads)
      graphics.circles!.push({
        center: { x: pad.center.x + shift, y: pad.center.y },
        radius: pad.width / 2,
        // Translucent projection keeps the opposite-layer pad visible.
        fill: "rgba(233,236,239,0.5)",
        stroke: "#adb5bd",
      })
    // Rejected panels show the proposed wire and via as gray geometry;
    // these are candidate sites, not copper returned by the matcher.
    graphics.lines!.push({
      points: [
        { x: shift, y: 0 },
        { x: via.x + shift, y: via.y },
      ],
      strokeWidth: rules.traceWidth,
      strokeColor: color,
    })
    graphics.circles!.push(
      {
        center: { x: via.x + shift, y: via.y },
        radius: rules.viaDiameter / 2,
        fill: matching ? "rgba(43,138,62,0.2)" : "rgba(134,142,150,0.2)",
        stroke: color,
      },
      {
        center: { x: via.x + shift, y: via.y },
        radius: rules.viaHoleDiameter / 2,
        fill: "none",
        stroke: color,
      },
    )
    graphics.rects!.push({
      center: {
        x: scenario.blocker.center.x + shift,
        y: scenario.blocker.center.y,
      },
      width: scenario.blocker.width,
      height: scenario.blocker.height,
      fill: blockerColor,
      stroke: blockerColor,
    })
  }
  const svg = getSvgFromGraphicsObject(graphics)
  console.log("DOGBONE_LAYER_SVG=" + JSON.stringify(svg))
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
