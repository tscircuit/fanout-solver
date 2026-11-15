import { test, expect } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { matchComponentDogboneViaSites, validateRoutedCopperDrc } from "../lib"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import { createSmtTerminalViaSiteFixture } from "./fixtures/smt-terminal-via-sites"
test("long rectangular SMT pads receive legal full-stack plane fanouts", async () => {
  const { bus, input, rules } = createSmtTerminalViaSiteFixture(),
    before = JSON.stringify(input),
    sites = matchComponentDogboneViaSites([bus], rules)
  expect(sites?.size).toBe(2)
  if (!sites) throw Error("Incomplete fanout cannot be snapshotted")
  const traces = bus.connections.map((c) => {
    const via = sites.get(c.connectionIndex)!
    return {
      type: "pcb_trace" as const,
      pcb_trace_id: `fanout-${c.connectionIndex}`,
      connection_name: c.connection.name,
      route: [
        { route_type: "wire" as const, ...c.sourcePoint, width: 0.1 },
        { route_type: "wire" as const, ...via, layer: "top", width: 0.1 },
        {
          route_type: "via" as const,
          ...via,
          from_layer: "top",
          to_layer: "bottom",
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.5,
          via_hole_diameter: 0.3,
        },
        { route_type: "wire" as const, ...via, layer: "bottom", width: 0.1 },
      ],
    }
  })
  const output = { ...input, traces }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(JSON.stringify(input)).toBe(before)
  expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(output)),
  ).toMatchSvgSnapshot(import.meta.path)
})
