import { expect, test } from "bun:test"

test("declares the Cosmos renderer entry before Vite transforms the page", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text()

  expect(html).toContain('<script type="module" src="/src/main.tsx"></script>')
})
