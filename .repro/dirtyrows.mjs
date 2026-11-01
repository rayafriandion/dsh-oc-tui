// Pin down WHY the image rows are rewritten after the sixel payload lands.
// Two candidates: the cells genuinely changed, or paint()'s dirtyRows force-
// rewrite of image rows fires on every frame.
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/term.js"

const home = mkdtempSync(join(tmpdir(), "dsh-oc-tui-dirty-"))
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
let writes = []
let capturing = 0
class FakeOut extends EventEmitter {
  constructor(c, r) { super(); this.isTTY = true; this.columns = c; this.rows = r }
  write(s) { if (capturing > 0) writes.push(String(s)); return true }
}
const realOut = process.stdout
const stdin = new FakeIn()
const stdout = new FakeOut(100, 30)
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })
const say = (...a) => realOut.write(a.join(" ") + "\n")

function rowsIn(text) {
  const rows = []
  const re = /\x1b\[(\d+);(\d+)H/g
  let m
  while ((m = re.exec(text))) rows.push([Number(m[1]), Number(m[2])])
  return rows
}

const report = []
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  const before = writes.length
  capturing++
  const result = realPaint.call(this, screen)
  capturing--
  const chunk = writes.slice(before).join("")
  writes.length = 0

  // Which rows did the frame rewrite?
  const rewritten = new Set(rowsIn(chunk).map((r) => r[0]))
  // Which rows "genuinely" changed relative to the terminal's own record?
  const prev = this._prev
  const changedRows = new Set()
  if (prev) {
    for (let y = 0; y < screen.rows; y++) {
      for (let x = 0; x < screen.cols; x++) {
        const a = screen.cells[y][x]
        const b = prev.cells[y]?.[x]
        if (a.ch !== b?.ch || a.style !== b?.style || (b && (a.style.fg !== b.style.fg || a.style.bg !== b.style.bg || a.style.bold !== b.style.bold || a.style.italic !== b.style.italic || a.style.dim !== b.style.dim || a.style.underline !== b.style.underline || a.style.link !== b.style.link))) { changedRows.add(y + 1); break }
      }
    }
  }
  const imageRows = new Set()
  for (const img of screen.images) for (let i = 0; i < img.cellsH; i++) imageRows.add(img.y + 1 + i)
  if (imageRows.size === 0) return result
  const forced = [...imageRows].filter((r) => rewritten.has(r) && !changedRows.has(r))
  const realChange = [...imageRows].filter((r) => changedRows.has(r))
  report.push({
    imageRows: [...imageRows],
    rewritten: [...imageRows].filter((r) => rewritten.has(r)),
    forcedByDirtyRows: forced,
    changedForReal: realChange,
    emittedPayload: chunk.includes("\x1bP0;1;1q"),
  })
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
stdin.send("\x1b[?62;4;6c"); stdin.send("\x1bP>|Windows Terminal 1.22\x1b\\"); stdin.send("\x1b_Gi=31;error=ENOSYS\x1b\\"); stdin.send("\x1b[8;16;8t")
await settle(160)
stdin.send("hi"); stdin.send("\r"); await settle(60)
const { createRequire } = await import("node:module")
const sharp = createRequire("D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/.repro/erase.mjs")("sharp")
const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toBuffer()
stdin.send("\x1b[200~"); stdin.send(png.toString("latin1")); stdin.send("\x1b[201~")
await settle(40)
stdin.send("\r"); await settle(400)

say("frames with images:", report.length)
for (const r of report.slice(-8)) {
  say(JSON.stringify({
    rows: r.imageRows[0] + "-" + r.imageRows.at(-1),
    rewritten: r.rewritten.length ? r.rewritten[0] + "-" + r.rewritten.at(-1) : "none",
    forcedByDirtyRows: r.forcedByDirtyRows.length ? r.forcedByDirtyRows[0] + "-" + r.forcedByDirtyRows.at(-1) + (" (" + r.forcedByDirtyRows.length + ")") : "none",
    changedForReal: r.changedForReal.length ? r.changedForReal.join(",") : "none",
    payload: r.emittedPayload,
  }))
}
const forcedFrames = report.filter((r) => r.forcedByDirtyRows.length > 0).length
const payloadAfterForced = report.find((r, i) => r.emittedPayload && report.slice(0, i).some((p) => p.forcedByDirtyRows.length > 0))
say("frames that force-rewrote image rows with no real change:", forcedFrames, "/", report.length)
say("a payload emitted AFTER a forced rewrite (i.e. written over blank cells):", Boolean(payloadAfterForced))
process.exit(0)
