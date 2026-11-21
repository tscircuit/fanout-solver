import { expect, test } from "bun:test"
import { type AnyCircuitElement, pcb_trace, pcb_via } from "circuit-json"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

type RoutingInput = Parameters<typeof routeLocalSignalDogbones>[0]

test("RV1126B-P DDR DQ16 escapes past copper from the first byte", async () => {
  const { input }: { input: RoutingInput } = await Bun.file(
    new URL("./fixtures/rv1126b-ddr-dq16.srj.json", import.meta.url),
  ).json()
  const boardFixture = Bun.file(
    new URL("./fixtures/rv1126b-ddr-dq16-board.srj.json.gz", import.meta.url),
  )
  const {
    input: board,
    fixedConnections,
  }: {
    input: RoutingInput
    fixedConnections: RoutingInput["connections"]
  } = JSON.parse(
    new TextDecoder().decode(Bun.gunzipSync(await boardFixture.bytes())),
  )
  const pcbFixture = Bun.file(
    new URL("./fixtures/rv1126b-ddr-dq16-pcb.circuit.json.gz", import.meta.url),
  )
  const circuit: AnyCircuitElement[] = JSON.parse(
    new TextDecoder().decode(Bun.gunzipSync(await pcbFixture.bytes())),
  )
  const options = {
    targetLayers: new Map([[input.connections[0]!.name, "inner2"]]),
    viaDiameter: 0.45,
    viaHoleDiameter: 0.2,
    traceWidth: 0.09,
    clearance: 0.09,
    holeToHoleClearance: 0.1,
    boardEdgeClearance: 0.2,
  }
  expect(routeLocalSignalDogbones(input, options).traces).toHaveLength(2)
  const originalBoard = structuredClone(board)
  const { traces: escapes } = routeLocalSignalDogbones(board, options)
  expect(escapes).toHaveLength(2)
  expect(board).toEqual(originalBoard)

  const boardWithFixedConnections = {
    ...board,
    connections: [...board.connections, ...fixedConnections],
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: boardWithFixedConnections,
    routedSrj: {
      ...boardWithFixedConnections,
      traces: [...(board.traces ?? []), ...escapes],
    },
    clearance: options.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc.checkedViaCount).toBe(24)
  expect(drc.issues).toEqual([])

  const pcbEscapes = escapes.flatMap(({ pcb_trace_id, route }) => [
    pcb_trace.parse({
      type: "pcb_trace",
      pcb_trace_id,
      route: route.map((point) => {
        if (point.route_type !== "via") return point
        return {
          ...point,
          outer_diameter: point.via_diameter,
          hole_diameter: point.via_hole_diameter,
        }
      }),
    }),
    ...route.flatMap((point) => {
      if (point.route_type !== "via") return []
      return pcb_via.parse({
        type: "pcb_via",
        pcb_trace_id,
        x: point.x,
        y: point.y,
        outer_diameter: point.via_diameter,
        hole_diameter: point.via_hole_diameter,
        layers: point.layers,
      })
    }),
  ])
  const svg = convertCircuitJsonToPcbSvg([...circuit, ...pcbEscapes], {
    width: 1000,
    height: 1050,
    layer: "top",
    matchBoardAspectRatio: true,
    shouldDrawErrors: false,
    shouldDrawRatsNest: false,
  })
  await expect(svg.replaceAll("><", ">\n<")).toMatchSvgSnapshot(
    import.meta.path,
  )
})
