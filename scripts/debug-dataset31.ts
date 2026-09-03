import { parseArgs } from "node:util"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    buses: { type: "string" },
    "connection-limit": { type: "string" },
    "dump-input": { type: "string" },
    "capture-only": { type: "boolean" },
    "max-layer-combinations": { type: "string", default: "1" },
    "timeout-ms": { type: "string", default: "120000" },
    output: { type: "string" },
    worker: { type: "boolean" },
  },
})
if (!values.input)
  throw new Error("--input must name a captured dataset 31 JSON file")
const positiveInteger = (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`Expected a positive integer, got ${value}`)
  return number
}
const timeoutMs = positiveInteger(values["timeout-ms"]!)
if (!values.worker) {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, ...process.argv.slice(2), "--worker"],
    { stdout: "inherit", stderr: "inherit" },
  )
  const timer = setTimeout(() => {
    console.error(
      `Hard timeout after ${timeoutMs} ms; last progress is retained.`,
    )
    child.kill("SIGKILL")
  }, timeoutMs)
  const exitCode = await child.exited
  clearTimeout(timer)
  process.exit(exitCode)
}

const { simpleRouteJson, solverOptions } = (await Bun.file(
  values.input,
).json()) as {
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}
if (values.buses) {
  const selected = new Set(values.buses.split(","))
  const known = new Set(solverOptions.buses?.map((bus) => bus.busId))
  for (const id of selected)
    if (id !== "planes" && id !== "signals" && !known.has(id))
      throw new Error(`Unknown bus ${id}`)
  const names = new Set(
    solverOptions.buses
      ?.filter(
        (bus) =>
          selected.has(bus.busId) ||
          selected.has(
            bus.termination?.type === "plane" ? "planes" : "signals",
          ),
      )
      .flatMap((bus) => bus.connectionNames),
  )
  simpleRouteJson.connections = simpleRouteJson.connections.filter(
    (connection) => names.has(connection.name),
  )
}
if (values["connection-limit"])
  simpleRouteJson.connections = simpleRouteJson.connections.slice(
    0,
    positiveInteger(values["connection-limit"]),
  )
const retained = new Set(
  simpleRouteJson.connections.map((connection) => connection.name),
)
solverOptions.buses = solverOptions.buses
  ?.map((bus) => ({
    ...bus,
    connectionNames: bus.connectionNames.filter((name) => retained.has(name)),
    connectionExitTargets:
      bus.connectionExitTargets &&
      Object.fromEntries(
        Object.entries(bus.connectionExitTargets).filter(([name]) =>
          retained.has(name),
        ),
      ),
  }))
  .filter((bus) => bus.connectionNames.length > 0)
simpleRouteJson.buses = simpleRouteJson.buses
  ?.map((bus) => ({
    ...bus,
    connectionNames: bus.connectionNames.filter((name) => retained.has(name)),
  }))
  .filter((bus) => bus.connectionNames.length > 0)
simpleRouteJson.differentialPairs = simpleRouteJson.differentialPairs?.filter(
  (pair) => pair.connectionNames.every((name) => retained.has(name)),
)
solverOptions.maxLayerCombinations = positiveInteger(
  values["max-layer-combinations"]!,
)
if (values["capture-only"] && !values["dump-input"]) {
  throw new Error("--capture-only requires --dump-input")
}
if (values["dump-input"]) {
  await Bun.write(
    values["dump-input"],
    `${JSON.stringify({ simpleRouteJson, solverOptions }, null, 2)}\n`,
  )
}
if (values["capture-only"]) process.exit(0)
const solver = new FanoutSolver(simpleRouteJson, solverOptions)
const start = performance.now()
let nextProgress = start
const report = () => ({
  solved: solver.solved,
  failed: solver.failed,
  error: solver.error,
  elapsedMs: Math.round(performance.now() - start),
  connections: simpleRouteJson.connections.length,
  stats: solver.stats,
  activeStats: solver.activeSubSolver?.stats,
  attempts: solver.attempts,
  validation: solver.solved ? solver.getOutput().validation : undefined,
})
const save = async () => {
  console.log(JSON.stringify(report()))
  if (values.output) {
    await Bun.write(`${values.output}.json`, JSON.stringify(report(), null, 2))
    await Bun.write(
      `${values.output}.svg`,
      getSvgFromGraphicsObject(solver.visualize()),
    )
  }
}
while (!solver.solved && !solver.failed) {
  solver.step()
  if (performance.now() >= nextProgress) {
    await save()
    nextProgress = performance.now() + 5000
  }
}
await save()
process.exitCode = solver.solved ? 0 : 1
