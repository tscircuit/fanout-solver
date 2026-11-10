// Only `unbroken` changes between the reproduction and its control.
// routeRemaining=false isolates the native dogbone escape phase.
export default function UnbrokenPlane({ unbroken = true }) {
  return (
    <board
      width={16}
      height={12}
      layers={4}
      schematicDisabled
      routeRemaining={false}
      minTraceWidth={0.15}
      minViaHoleDiameter={0.15}
      minViaPadDiameter={0.3}
    >
      <copperpour connectsTo="net.GND" layer="inner1" unbroken={unbroken} />
      <breakout
        name="ESC"
        autorouter="dogbone"
        fanoutRoutingLayers={["inner2"]}
        fanoutPourNetMap={{}}
        padding={1}
      >
        <chip
          name="U1"
          pcbX={-3}
          pinLabels={{ pin5: "SIGNAL" }}
          footprint={
            <footprint>
              <courtyardrect width={2.4} height={2.4} />
              <smtpad
                portHints={["pin1"]}
                pcbX={-0.8}
                pcbY={-0.8}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin2"]}
                pcbX={-0.8}
                pcbY={0}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin3"]}
                pcbX={-0.8}
                pcbY={0.8}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin4"]}
                pcbX={0}
                pcbY={-0.8}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin5"]}
                pcbX={0}
                pcbY={0}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin6"]}
                pcbX={0}
                pcbY={0.8}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin7"]}
                pcbX={0.8}
                pcbY={-0.8}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin8"]}
                pcbX={0.8}
                pcbY={0}
                shape="circle"
                radius={0.2}
              />
              <smtpad
                portHints={["pin9"]}
                pcbX={0.8}
                pcbY={0.8}
                shape="circle"
                radius={0.2}
              />
            </footprint>
          }
        />
        <trace from="U1.pin5" to="net.SIGNAL" />
      </breakout>
      <resistor name="R1" pcbX={3} resistance="1k" footprint="0603" />
      <trace from="R1.pin1" to="net.SIGNAL" />
      <pcbnotetext
        pcbY={4.6}
        fontSize={0.65}
        text={unbroken ? "REPRO: unbroken = true" : "CONTROL: unbroken = false"}
      />
      <pcbnotetext
        pcbY={3.3}
        fontSize={0.4}
        text="Same pads, net, ground plane and clearances"
      />
      <pcbnotetext
        pcbX={-3}
        pcbY={1.9}
        fontSize={0.4}
        text="U1: center pad = SIGNAL"
      />
      <pcbnotetext
        pcbY={-2.5}
        fontSize={0.4}
        text="Expected: top pad -> via -> inner2"
      />
      <pcbnotetext
        pcbY={-3.6}
        fontSize={0.4}
        text="inner1 GND must clear the SIGNAL via (antipad)"
      />
      <pcbnotetext
        pcbY={-4.7}
        fontSize={0.35}
        text="Only the local escape is requested; R1 stays unrouted"
      />
    </board>
  )
}
