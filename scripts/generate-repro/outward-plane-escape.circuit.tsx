import type {} from "@tscircuit/core"
import { Fragment } from "react"

// The actual Linux board's 0402 land pattern for these two manufacturer parts.
const footprint0402 = (
  <footprint>
    <smtpad
      portHints={["pin1"]}
      pcbX={-0.43}
      pcbY={0}
      width={0.56}
      height={0.54}
      shape="rect"
    />
    <smtpad
      portHints={["pin2"]}
      pcbX={0.43}
      pcbY={0}
      width={0.56}
      height={0.54}
      shape="rect"
    />
    <courtyardrect width={1.62} height={0.74} />
  </footprint>
)

export default function OutwardPlaneEscape() {
  return (
    <board
      width={12}
      height={12}
      layers={4}
      autorouter="default"
      autorouterVersion="beta_pipeline9"
      allowBlindAndBuriedVias={false}
      isViaInPadAllowed={false}
      defaultTraceWidth={0.15}
      minTraceWidth={0.1}
      minTraceToPadEdgeClearance={0.1}
      minPadEdgeToPadEdgeClearance={0.1}
      minViaEdgeToPadEdgeClearance={0.1}
      minViaHoleDiameter={0.3}
      minViaPadDiameter={0.55}
      pcbStyle={{ viaHoleDiameter: 0.3, viaPadDiameter: 0.55 }}
    >
      <net name="VCC" />
      <net name="GND" />
      <resistor
        name="R1"
        resistance="22ohm"
        manufacturerPartNumber="0402WGF220JTCE"
        footprint={footprint0402}
        pcbX={0}
        pcbY={0}
      />
      <silkscreentext text="R1" pcbX={-1.5} pcbY={0} fontSize={0.5} />
      {[
        { name: "C1", x: -0.35, y: -1.33, ccwRotationDegrees: 90 },
        { name: "C2", x: 1.21, y: -1.33, ccwRotationDegrees: 90 },
        { name: "C3", x: -0.35, y: 1.33, ccwRotationDegrees: 270 },
        { name: "C4", x: 1.21, y: 1.33, ccwRotationDegrees: 270 },
      ].map(({ name, x, y, ccwRotationDegrees }) => (
        <Fragment key={name}>
          <capacitor
            name={name}
            capacitance="100nF"
            manufacturerPartNumber="CL05B104KO5NNNC"
            footprint={footprint0402}
            pcbX={x}
            pcbY={y}
            pcbRotation={ccwRotationDegrees}
          />
          <silkscreentext
            text={name}
            pcbX={x}
            pcbY={Math.sign(y) * 2.7}
            fontSize={0.5}
          />
          <trace
            name={`${name}_FILTERED`}
            from="R1.pin1"
            to={`${name}.pin1`}
            routingPhaseIndex={1}
          />
          <trace
            name={`${name}_GROUND`}
            from={`${name}.pin2`}
            to="net.GND"
            routingPhaseIndex={3}
          />
        </Fragment>
      ))}
      <trace
        name="VCC_FEED"
        from="R1.pin2"
        to="net.VCC"
        routingPhaseIndex={2}
      />
      <autoroutingphase
        name="LOCAL_FILTER"
        phaseIndex={1}
        autorouter="default"
      />
      <autoroutingphase
        name="VCC_PLANE_FANOUT"
        phaseIndex={2}
        autorouter="fanout"
        fanoutRoutingLayers={["top", "bottom"]}
        fanoutPourNetMap={{ inner1: "VCC" }}
      />
      <autoroutingphase
        name="GND_PLANE_FANOUT"
        phaseIndex={3}
        autorouter="fanout"
        fanoutRoutingLayers={["top", "bottom"]}
        fanoutPourNetMap={{ inner2: "GND" }}
      />
      <copperpour
        name="VCC_PLANE"
        connectsTo="net.VCC"
        layer="inner1"
        clearance={0.2}
      />
      <copperpour
        name="GND_PLANE"
        connectsTo="net.GND"
        layer="inner2"
        clearance={0.2}
      />
    </board>
  )
}
