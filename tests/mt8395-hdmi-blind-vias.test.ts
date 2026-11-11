import { expect, test } from "bun:test"
import {
  routeLocalSignalDogbones,
  validateOriginalEndpointConnectivity,
  validateRoutedCopperDrc,
} from "lib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  loadMt8395HdmiInput,
  hashMt8395Input,
} from "./fixtures/mt8395-hdmi-input"
import { mt8395HdmiSnapshot } from "./fixtures/mt8395-hdmi-snapshot"

test("MT8395 HDMI blind vias escape above bottom decoupling pads", async () => {
  const input = loadMt8395HdmiInput()
  const before = hashMt8395Input(input)
  let result: ReturnType<typeof routeLocalSignalDogbones> | undefined
  let error: unknown
  try {
    result = routeLocalSignalDogbones(input, {
      targetLayers: new Map(input.connections.map((c) => [c.name, "inner4"])),
      viaDiameter: 0.15,
      viaHoleDiameter: 0.075,
      traceWidth: 0.06,
      clearance: 0.06,
      holeToHoleClearance: 0.1,
      boardEdgeClearance: 0.2,
      allowBlindAndBuriedVias: true,
    })
  } catch (cause) {
    error = cause
  }
  expect(hashMt8395Input(input)).toBe(before)
  expect(input.connections).toHaveLength(2)
  expect(input.traces).toHaveLength(138)
  expect(String(error)).toContain("No collision-free local dogbone assignment")
  expect(result).toBeUndefined()
  if (result) {
    for (const trace of result.traces) {
      const via = trace.route.find((p) => p.route_type === "via")!
      expect(via.layers).toEqual([
        "top",
        "inner1",
        "inner2",
        "inner3",
        "inner4",
      ])
    }
    // Validate all new copper against the complete board and all supplied DDR
    // copper. The fixed requests below are only validation context; the solver
    // receives the original core input unchanged.
    const fixedConnections = input.traces!.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0]!, t.route.at(-1)!],
    })) as SimpleRouteJson["connections"]
    const native = {
      ...input,
      connections: [...input.connections, ...fixedConnections],
    }
    const drc = validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: [...input.traces!, ...result.traces] },
      clearance: 0.06,
    })
    expect(drc.issues).toEqual([])
    // Local escapes deliberately stop at returned handoffs, not at the far end
    // of the HDMI pair. Check every pad-to-handoff path separately.
    const local = {
      ...input,
      connections: result.traces.map((t) => ({
        name: t.pcb_trace_id,
        pointsToConnect: [t.route[0]!, t.route.at(-1)!],
      })) as SimpleRouteJson["connections"],
      traces: result.traces.map((t) => ({
        ...t,
        connection_name: t.pcb_trace_id,
      })),
    }
    expect(
      validateOriginalEndpointConnectivity({
        inputSrj: local,
        routedSrj: local,
      }).valid,
    ).toBe(true)
  }
  await expect(
    mt8395HdmiSnapshot(input, result?.traces ?? []),
  ).toMatchSvgSnapshot(import.meta.path)
}, 300_000)
