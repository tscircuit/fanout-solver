export interface RuntimeProcess {
  env: Record<string, string | undefined>
}

interface RuntimeGlobal {
  process?: RuntimeProcess
}

export const getRuntimeProcess = (runtime: RuntimeGlobal): RuntimeProcess =>
  runtime.process ?? { env: {} }
