import { AM3352_FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/am3352-fanout-directions"
import { FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/fanout-directions"
import { IMX6ULL_FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/imx6ull-fanout-directions"
import { K230_FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/k230-fanout-directions"
import { RK3308_FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/rk3308-fanout-directions"
import { T113S3_FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/t113s3-fanout-directions"
import generatorPackage from "./package.json"

const dependency =
  generatorPackage.dependencies["@tscircuit/dataset-fanout31-am62l"]
const commit = dependency.match(
  /^github:tscircuit\/dataset-fanout31-am62l#([a-f0-9]{40})$/,
)?.[1]
if (!commit)
  throw new Error("Dataset 31 must be pinned to an exact upstream commit")

export const dataset31Source = {
  repository: "https://github.com/tscircuit/dataset-fanout31-am62l",
  commit,
}
export {
  FANOUT_DIRECTION_CASES,
  RK3308_FANOUT_DIRECTION_CASES,
  K230_FANOUT_DIRECTION_CASES,
  IMX6ULL_FANOUT_DIRECTION_CASES,
  T113S3_FANOUT_DIRECTION_CASES,
  AM3352_FANOUT_DIRECTION_CASES,
}

// Keep --list/--help lightweight: circuit factories are loaded by the generator.
export const DATASET31_DIRECTION_CASES = [
  ...FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "am62l" as const,
  })),
  ...RK3308_FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "rk3308" as const,
  })),
  ...K230_FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "k230" as const,
  })),
  ...IMX6ULL_FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "imx6ull" as const,
  })),
  ...T113S3_FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "t113s3" as const,
  })),
  ...AM3352_FANOUT_DIRECTION_CASES.map((sample) => ({
    ...sample,
    chip: "am3352" as const,
  })),
]
