import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import capturedInput from "./am625sip-microsd-fanout.json"

// Captured from AnasSarkiz/am625sip-linux v1.0.3 with the B21 microSD
// connection added. Only debug-serializer undefined markers were removed.
// Keep every physical obstacle in both cases to isolate the extra connection.
export function createAm625sipMicrosdFanout({
  includeInnerRow = true,
}: {
  includeInnerRow?: boolean
} = {}) {
  const inputSrj = {
    ...structuredClone(capturedInput),
    obstacles: capturedInput.obstacles.map((obstacle) => {
      if (obstacle.type !== "rect") {
        throw new Error(`Unexpected captured obstacle type: ${obstacle.type}`)
      }
      return { ...structuredClone(obstacle), type: obstacle.type }
    }),
  } satisfies SimpleRouteJson

  const options: FanoutSolverOptions = {
    buses: [
      {
        ...inputSrj.buses[0],
        exitPosition: "topside_center",
        allowedLayers: ["top"],
      },
      { ...inputSrj.buses[1], exitPosition: "rightside_bottom" },
    ],
    borderDistribution: "even",
    compactBusTracks: true,
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    sharedBoundary: { ...inputSrj.bounds },
  }

  if (!includeInnerRow) {
    const innerConnectionNames = new Set(inputSrj.buses[1].connectionNames)
    inputSrj.connections = inputSrj.connections.filter(
      (connection) => !innerConnectionNames.has(connection.name),
    )
    inputSrj.buses = inputSrj.buses.slice(0, 1)
    options.buses = options.buses!.slice(0, 1)
  }

  return { inputSrj, options }
}
