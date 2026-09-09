import { RootCircuit } from "@tscircuit/core"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"
import { CheckoutFanoutAutorouter } from "./checkout-fanout-autorouter"
import { PowerFilter } from "./power-filter"

const autorouters: CheckoutFanoutAutorouter[] = []
const circuit = new RootCircuit()
circuit.schematicDisabled = true
circuit.add(
  <PowerFilter
    autorouter={{
      local: true,
      algorithmFn: async (srj) => {
        const autorouter = new CheckoutFanoutAutorouter(srj)
        autorouters.push(autorouter)
        return autorouter
      },
    }}
  />,
)
await circuit.renderUntilSettled()
const circuitJson = circuit.getCircuitJson()
console.log(
  JSON.stringify({
    svg: convertCircuitJsonToPcbSvg(circuitJson, { layer: "top" }),
    errors: circuitJson.filter((element) => element.type.includes("error")),
    componentNames: circuitJson
      .filter((element) => element.type === "source_component")
      .map((component) => component.name),
    traceCount: circuitJson.filter((element) => element.type === "pcb_trace")
      .length,
    phases: autorouters.map(({ solver }) => ({
      solved: solver.solved,
      failed: solver.failed,
      error: solver.error,
      buses: solver.preparedBuses.map(({ busId, termination }) => ({
        busId,
        termination,
      })),
    })),
  }),
)
