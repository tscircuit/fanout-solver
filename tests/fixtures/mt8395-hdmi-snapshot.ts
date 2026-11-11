import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSimplifiedPcbTrace } from "lib/types"

/** Diagnostic projection in board-world mm (+X right, +Y up, +Z above).
 * Copper is drawn from emitted routes; bottom pads are translucent context. */
export function mt8395HdmiSnapshot(
  input: SimpleRouteJson,
  traces: FanoutSimplifiedPcbTrace[],
): string {
  const X = (x: number) => 40 + (x + 9.4) * 235,
    Y = (y: number) => 145 + (-5.35 - y) * 235
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="850" viewBox="0 0 1180 850"><rect width="1180" height="850" fill="#10202c"/><style>text{font-family:Arial,sans-serif;fill:#eef3f8}.code{font-family:monospace}</style><text x="30" y="42" font-size="26" font-weight="bold">MT8395 HDMI: bottom capacitors must not block a blind via</text><text x="30" y="78" font-size="20" fill="${traces.length ? "#88e4a1" : "#ffb276"}">${traces.length ? "4/4 local pad escapes routed and checked" : "BEFORE: no local escapes; bottom pads reject all via sites"}</text><defs><clipPath id="zoom"><rect x="30" y="125" width="495" height="495"/></clipPath></defs><rect x="30" y="125" width="495" height="495" fill="#17343e" stroke="#78929c"/><g clip-path="url(#zoom)">`
  for (const o of input.obstacles) {
    const x = X(o.center.x),
      y = Y(o.center.y),
      w = o.width * 235,
      h = o.height * 235
    if (x + w / 2 < 30 || x - w / 2 > 525 || y + h / 2 < 125 || y - h / 2 > 620)
      continue
    if (o.layers.includes("bottom"))
      svg += `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="#f06f86" fill-opacity=".22" stroke="#f06f86" stroke-width="1.5" stroke-dasharray="6 4"/>`
    if (
      o.layers.includes("top") &&
      (o as typeof o & { shape?: string }).shape === "circle"
    )
      svg += `<circle cx="${x}" cy="${y}" r="${w / 2}" fill="#708994" fill-opacity=".75"/>`
    else if (o.layers.includes("top"))
      svg += `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="#708994" fill-opacity=".75"/>`
  }
  for (const [index, c] of input.connections.entries()) {
    const p = c.pointsToConnect[0]!,
      color = index ? "#f89bd5" : "#ffe182"
    svg += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="25" fill="none" stroke="${color}" stroke-width="2"/><text x="${X(p.x) + 30}" y="${Y(p.y) - 15}" font-size="17">${index ? "AR35 −" : "AR36 +"}</text>`
    for (const t of traces.filter((t) => t.connection_name === c.name)) {
      for (let i = 1; i < t.route.length; i++) {
        const a = t.route[i - 1]!,
          b = t.route[i]!
        if (
          a.route_type === "wire" &&
          b.route_type === "wire" &&
          a.layer === "top" &&
          b.layer === "top"
        )
          svg += `<path d="M${X(a.x)} ${Y(a.y)}L${X(b.x)} ${Y(b.y)}" stroke="${color}" stroke-width="${a.width * 235}" stroke-linecap="round"/>`
      }
      for (const p of t.route)
        if (p.route_type === "via")
          svg += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${((p.via_diameter ?? 0.15) * 235) / 2}" fill="${color}" stroke="#10202c" stroke-width="2"/><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${((p.via_hole_diameter ?? 0.075) * 235) / 2}" fill="#10202c"/>`
    }
  }
  svg +=
    '</g><text x="30" y="651" font-size="17">CPU pads: gray. Bottom capacitors: dashed red.</text><text x="30" y="677" font-size="17">Gold / pink: emitted positive / negative escapes.</text>'
  const lines = [
    "Relevant board TSX",
    "<board layers={8} allowBlindAndBuriedVias>",
    '  <trace name="HDMI_CH2_CPU_N"',
    '    path={["U1.AR35", "U_HDMI.22",',
    '      "net.HDMITX21_CH2_M"]} />',
    '  <bus connections={["HDMI_CH2_CPU_P",',
    '    "HDMI_CH2_CPU_N"]}',
    '    pcbAllowedLayers={["inner4"]} />',
    "</board>",
    "",
    "Blind via: top → inner4.",
    "C_SOC_115 and C_SOC_122 are on bottom.",
    "They do not intersect the via or its top trace.",
    "",
    "The complete core request is retained:",
    "2 HDMI connections; 138 fixed DDR traces.",
    "Four escapes: CPU and ESD ends of both signals.",
    "This zoom shows the two CPU-side escapes.",
    "",
    "Only local pad escapes are tested here.",
    "The remaining HDMI interconnect is not routed.",
  ]
  let y = 146
  for (const [i, line] of lines.entries()) {
    svg += `<text x="555" y="${y}" font-size="${i === 0 ? 22 : 17}" font-weight="${i === 0 ? "bold" : "normal"}" class="${i > 0 && i < 9 ? "code" : ""}">${esc(line)}</text>`
    y += i === 0 ? 37 : 27
  }
  svg +=
    '<text x="30" y="749" font-size="18">Geometry: 0.06 mm trace / clearance; 0.15 mm via pad / 0.075 mm drill.</text><text x="30" y="781" font-size="18">The blind-via span stops before bottom copper. Through vias must still clear it.</text><text x="30" y="816" font-size="16">Exact input captured from core 79735a0; no obstacles, fixed routes or endpoints removed.</text></svg>'
  return svg
}
