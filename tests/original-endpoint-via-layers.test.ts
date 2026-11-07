import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type {
  FanoutSimplifiedPcbTrace,
  FanoutViaRoutePoint,
} from "../lib/types"
import { validateOriginalEndpointConnectivity } from "../lib/validate-original-endpoint-connectivity"

test("original endpoints connect only through the via's physical layer span", (): void => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -1, maxY: 1 },
    obstacles: [-1, 1].map((x) => ({
      type: "rect",
      center: { x, y: 0 },
      width: 0.2,
      height: 0.2,
      layers: [x < 0 ? "top" : "bottom"],
      connectedTo: ["signal"],
    })),
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: -1, y: 0, layer: "top" },
          { x: 1, y: 0, layer: "bottom" },
        ],
      },
    ],
  }
  const via: FanoutViaRoutePoint = {
    route_type: "via",
    x: 0,
    y: 0,
    from_layer: "top",
    to_layer: "inner1",
    via_diameter: 0.3,
    via_hole_diameter: 0.15,
  }
  for (const layers of [
    undefined,
    ["top", "inner1"],
    ["top", "inner1", "inner2", "bottom"],
  ]) {
    const traces: FanoutSimplifiedPcbTrace[] = [
      {
        type: "pcb_trace",
        pcb_trace_id: "prefix",
        connection_name: "signal",
        route: [
          { route_type: "wire", x: -1, y: 0, width: 0.1, layer: "top" },
          { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
          { ...via, layers },
          { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "inner1" },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "branch",
        connection_name: "signal",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "bottom" },
          { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "bottom" },
        ],
      },
    ]
    const routed = { ...input, traces }
    const unchanged = JSON.stringify({ input, routed })
    const report = validateOriginalEndpointConnectivity({
      inputSrj: input,
      routedSrj: routed,
    })
    const connected = layers?.includes("bottom") ?? false
    expect(report.valid).toBe(connected)
    expect(report.connectedEndpointCount).toBe(connected ? 2 : 1)
    expect(JSON.stringify({ input, routed })).toBe(unchanged)
  }
})
