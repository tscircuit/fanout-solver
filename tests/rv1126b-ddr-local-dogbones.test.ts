import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import { routeLocalSignalDogbones } from "lib"

type RoutingInput = Parameters<typeof routeLocalSignalDogbones>[0]

test("RV1126B-P DDR DQ16 escapes past copper from the first byte", async () => {
  const { input }: { input: RoutingInput } = await Bun.file(
    new URL("./fixtures/rv1126b-ddr-dq16.srj.json", import.meta.url),
  ).json()
  const boardFixture = Bun.file(
    new URL("./fixtures/rv1126b-ddr-dq16-board.srj.json.gz", import.meta.url),
  )
  const { input: board }: { input: RoutingInput } = JSON.parse(
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
  const failure = "No collision-free local dogbone assignment"
  expect(() => routeLocalSignalDogbones(input, options)).toThrow(failure)
  expect(() => routeLocalSignalDogbones(board, options)).toThrow(failure)
  const svg = convertCircuitJsonToPcbSvg(circuit, {
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
