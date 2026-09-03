import type { FanoutSolver } from "../lib/fanout-solver"
import type { FanoutDatasetSample } from "./dataset-types"
import capturedSample from "./fixtures/fanout31-am62l-top-center.json"

const fixture = capturedSample as unknown as {
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

/** Preserve the captured geometry and timing limits; add explicit plane-site hints. */
export const createAm62lRamTopInput = () => ({
  simpleRouteJson: structuredClone(fixture.simpleRouteJson),
  solverOptions: {
    ...structuredClone(fixture.solverOptions),
    // Keep scarce plane escapes available while routing the dense signal buses.
    densePlaneReservationBusIds: [
      "U1_VSS_A1_DROP",
      "U1_VSS_A2_DROP",
      "U1_VSS_A4_DROP",
      "U1_VSS_A10_DROP",
      "U1_VSS_A13_DROP",
      "U1_VSS_A16_DROP",
      "U1_VSS_A19_DROP",
      "U1_VSS_A22_DROP",
      "U1_VSS_E6_DROP",
      "U1_VSS_F5_DROP",
      "U1_VSS_F6_DROP",
      "U1_VSS_G8_DROP",
      "U1_VSS_H1_DROP",
      "U1_VSS_H7_DROP",
      "U1_VSS_K8_DROP",
      "U1_VSS_L9_DROP",
      "U1_VSS_R1_DROP",
      "U1_VSS_T2_DROP",
      "U1_VSS_V3_DROP",
      "U1_VDDS_DDR_M7_DROP",
      "U1_VDDS_DDR_L8_DROP",
    ],
    denseUnrestrictedPlaneRoutingBusIds: [
      "U1_VSS_U7_DROP",
      "U1_VSS_R8_DROP",
      "U1_VSS_P9_DROP",
      "U1_VSS_N9_DROP",
      "U1_VSS_N11_DROP",
    ],
  },
})

export const fanoutDataset09: FanoutDatasetSample[] = [
  {
    id: "02-top-center",
    name: "AM62L · RAM above",
    description:
      "Captured dataset-fanout31 sample 02: all 135 connections and original timing constraints, with explicit plane reservation hints. All vias span the complete stack.",
    footprintCount: 2,
    footprinterStrings: ["AM62L FCCSP373", "LPDDR4 FBGA200"],
    ...createAm62lRamTopInput(),
    componentBounds: {},
    sharedBoundary: fixture.solverOptions.sharedBoundary!,
  },
]
