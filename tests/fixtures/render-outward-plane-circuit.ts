export type OutwardPlaneCircuitRender = {
  svg: string
  errors: Array<{ type: string; message: string }>
  componentNames: string[]
  traceCount: number
  phases: Array<{
    solved: boolean
    failed: boolean
    error: string | null
    buses: Array<{
      busId: string
      termination: { type: string; layer: string }
    }>
  }>
}

export async function renderOutwardPlaneCircuit(): Promise<OutwardPlaneCircuitRender> {
  // Isolate core's modern dependency graph from the solver's existing fixtures.
  const render = Bun.spawn(
    [process.execPath, `${import.meta.dir}/outward-plane/render-circuit.tsx`],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(render.stdout).text(),
    new Response(render.stderr).text(),
    render.exited,
  ])
  if (exitCode !== 0) throw new Error(`Native circuit render failed: ${stderr}`)
  return JSON.parse(stdout) as OutwardPlaneCircuitRender
}
