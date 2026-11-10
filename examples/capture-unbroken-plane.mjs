// Run these two example files in a project with core 0.0.2323 / props 0.0.724.
// Keep this repo's older generator dependencies unchanged.
import { Circuit } from "@tscircuit/core"
import UnbrokenPlane from "./unbroken-plane.circuit.tsx"

for (const unbroken of [false, true]) {
  const circuit = new Circuit()
  const inputs = []
  circuit.on("solver:started", (event) => {
    if (event.solverName === "DogboneFanoutSolver") {
      inputs.push(structuredClone(event.solverParams))
    }
  })
  circuit.add(UnbrokenPlane({ unbroken }))
  await circuit.renderUntilSettled()
  if (inputs.length !== 1) throw new Error("Expected one native dogbone input")
  const name = unbroken ? "reserved" : "ordinary"
  await Bun.write(
    `unbroken-plane-${name}.json`,
    `${JSON.stringify(inputs[0], null, 2)}\n`,
  )
  console.log({
    unbroken,
    traces: circuit.db.pcb_trace.list().length,
    vias: circuit.db.pcb_via.list().length,
    errors: circuit.db.pcb_autorouting_error.list().map((e) => e.message),
  })
}
