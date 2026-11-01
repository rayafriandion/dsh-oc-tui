// End-to-end invariant check on the real plugin: for every frame that rewrites
// rows a graphics image occupies, the payload for that image must also be in
// that same frame. A text write over sixel/iTerm2 pixels erases them, so a frame
// that blanks the image's rows without re-sending the payload leaves the image
// permanently gone — the reported "images and mermaid show nothing" symptom.
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/term.js"

const home = mkdtempSync(join(tmpdir(), "dsh-oc-tui-e2e-"))
process.env.DSH_HOME = home
process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 80) => { for (let i = 0; i < n; i++) await sleep(5) }
const realOut = process.stdout
const say = (...a) => realOut.write(a.join(" ") + "\n")

let writes = []
let capturing = 0
class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true }
  setRawMode() { return this }
  resume() { return this }
  pause() { return this }
  send(t) { this.emit("data", Buffer.from(t, "latin1")) }
}
class FakeOut extends EventEmitter {
  constructor(c, r) { super(); this.isTTY = true; this.columns = c; this.rows = r }
  write(s) { if (capturing > 0) writes.push(String(s)); return true }
}
const stdin = new FakeIn()
const stdout = new FakeOut(100, 30)
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })

const violations = []
const diag = { frames: 0, framesWithImages: 0, framesWithPayload: 0, framesRewroteImageRows: 0, hexDcs: 0 }
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  const before = writes.length
  capturing++
  const result = realPaint.call(this, screen)
  capturing--
  const chunk = writes.slice(before).join("")
  writes.length = 0
  diag.frames++
  const payloads = this._imagePayloads
  const rows = new Set()
  const re = /\x1b\[(\d+);(\d+)H/g
  let m
  while ((m = re.exec(chunk))) rows.add(Number(m[1]))
  if (!screen.images.length || !payloads.size) return result
  diag.framesWithImages++
  if (chunk.includes("\x1bP0;1;1q")) diag.hexDcs++
  let rewroteAny = false
  for (const img of screen.images) {
    const payload = payloads.get(img.key)
    if (!payload) continue
    const own = payload.kind === 'sixel' ? payload.s : payload.b64
    const rowsOfImage = new Set()
    for (let i = 0; i < img.cellsH; i++) rowsOfImage.add(img.y + 1 + i)
    const hit = [...rowsOfImage].filter((r) => rows.has(r))
    if (hit.length) { rewroteAny = true; diag.framesRewroteImageRows++ }
    if (hit.length && !chunk.includes(own)) {
      violations.push({ y: img.y, cellsH: img.cellsH, hit: hit.length, kind: payload.kind })
    }
  }
  return result
}

class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = { id: String(sessionId), options: {}, session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] }, cancel() {}, followup() {}, steer() {} }
    this.agents.set(agent.id, agent); this.rootList.push(agent)
    return { agent, dispose: async () => {} }
  }
}
class A extends Service { constructor(c, n) { super(c, n) } }
const ctx = new Context()
new AgentsStub(ctx); new A(ctx, "commands"); new A(ctx, "sessionPersistence"); new A(ctx, "tuiStartup")
const tui = await import("file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(20)

// Sixel-capable Windows Terminal answers the probes.
stdin.send("\x1b[?62;4;6c"); stdin.send("\x1bP>|Windows Terminal 1.22\x1b\\"); stdin.send("\x1b_Gi=31;error=ENOSYS\x1b\\"); stdin.send("\x1b[8;16;8t")
await settle(160)
stdin.send("hi"); stdin.send("\r"); await settle(60)
const { createRequire } = await import("node:module")
const sharp = createRequire("D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/.repro/e2e.mjs")("sharp")
const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toBuffer()
stdin.send("\x1b[200~"); stdin.send(png.toString("latin1")); stdin.send("\x1b[201~")
await settle(40)
stdin.send("\r"); await settle(500)   // let many ticks pass: the clock, the caret, repaints

say("frames that erased an image without re-sending its payload:", violations.length)
say(JSON.stringify(violations.slice(0, 5)))
say(violations.length === 0 ? "PASS the image survives every frame" : "FAIL the image is erased")
process.exit(0)
