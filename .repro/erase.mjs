// Decisive test: does a later text rewrite erase the sixel/iTerm2 payload?
//
// paint() marks the rows an image occupies as always-dirty, so every frame
// rewrites those rows with blank cells. For sixel/iTerm2 (no terminal-side
// image registry) _paintImages re-emits the payload only when the image MOVES.
// A pixel layer under text cells is erased by any rewrite of those cells.
//
// This harness replays the real write stream in order and reports, for each
// image payload write, whether a subsequent write rewrote the same rows.
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/term.js"

const home = mkdtempSync(join(tmpdir(), "dsh-oc-tui-erase-"))
process.env.DSH_HOME = home
process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 80) => { for (let i = 0; i < n; i++) await sleep(5) }

class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true }
  setRawMode() { return this }
  resume() { return this }
  pause() { return this }
  send(t) { this.emit("data", Buffer.from(t, "latin1")) }
}
const writes = []   // ordered log of every write the terminal received
class FakeOut extends EventEmitter {
  constructor(c, r) { super(); this.isTTY = true; this.columns = c; this.rows = r }
  write(s) { writes.push(String(s)); return true }
}
const realOut = process.stdout
const stdin = new FakeIn()
const stdout = new FakeOut(100, 30)
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })
const say = (...a) => realOut.write(a.join(" ") + "\n")

// Record every image annotation the renderer produced, so we know the rows the
// images occupy. Also record paint order.
const annotations = []
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  for (const img of screen.images) annotations.push({ ...img })
  return realPaint.call(this, screen)
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
stdin.send("\x1b[?62;4;6c")
stdin.send("\x1bP>|Windows Terminal 1.22\x1b\\")
stdin.send("\x1b_Gi=31;error=ENOSYS\x1b\\")
stdin.send("\x1b[8;16;8t")
await settle(160)

stdin.send("hi"); stdin.send("\r"); await settle(60)

// Paste a realistic 400x300 PNG (a solid color block sharp can decode).
const { createRequire } = await import("node:module")
const sharp = createRequire("D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/.repro/erase.mjs")("sharp")
const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toBuffer()
stdin.send("\x1b[200~"); stdin.send(png.toString("latin1")); stdin.send("\x1b[201~")
await settle(40)
stdin.send("\r")
await settle(400)

// ---- analysis -------------------------------------------------------------
const say6 = (s) => say(s)
say("total writes:", writes.length)
say("annotations:", JSON.stringify(annotations.slice(-4)))

// Find each payload write and the rows the images occupy, then look for a
// LATER write that rewrites those rows.
const rowOf = (text) => {
  const rows = []
  const re = /\x1b\[(\d+);1H/g
  let m
  while ((m = re.exec(text))) rows.push(Number(m[1]))
  return rows
}

let payloadWrites = 0
let erased = 0
const evidence = []
for (let i = 0; i < writes.length; i++) {
  const w = writes[i]
  const isPayload = w.includes("\x1bP0;1;1q") || w.includes("\x1b]1337;File=inline=1")
  if (!isPayload) continue
  payloadWrites++
  // Which rows does this payload claim? The CSI before the payload.
  const head = w.slice(0, w.indexOf("\x1bP0") > 0 ? w.indexOf("\x1bP0") : 0)
  const rows = rowOf(head.length ? head : w)
  // Look for any later write that addresses the image rows.
  const imgRows = annotations.length ? new Set() : null
  // Use the annotation rows from the paint that produced this payload:
  // the payload is the last write of a paint, so take the annotation seen
  // at paints count as of this write.
  let laterSame = 0
  const firstCall = evidence.length
  for (let j = i + 1; j < writes.length; j++) {
    const rows2 = rowOf(writes[j])
    if (rows2.some((r) => rows.includes(r))) laterSame++
  }
  evidence.push({ index: i, rows, laterRowRewrites: laterSame })
  if (laterSame > 0) erased++
}

say("payload writes:", payloadWrites)
say("payload writes followed by a rewrite of the same rows:", erased)
say("detail:", JSON.stringify(evidence.slice(-6)))
say("sample payload write (first 120 chars):", JSON.stringify(writes.find((w) => w.includes("\x1bP0;1;1q"))?.slice(0, 120) ?? "none"))
// Show the write order around the last payload.
const lastPayload = writes.findLastIndex((w) => w.includes("\x1bP0;1;1q"))
if (lastPayload >= 0) {
  for (let j = Math.max(0, lastPayload - 1); j < Math.min(writes.length, lastPayload + 4); j++) {
    const isP = writes[j].includes("\x1bP0;1;1q")
    say(`  write[${j}] ${isP ? "SIXEL" : "text"} rows=${JSON.stringify(rowOf(writes[j]).slice(0, 8))} len=${writes[j].length}`)
  }
}
process.exit(0)
