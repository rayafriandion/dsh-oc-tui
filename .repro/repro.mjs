// Repro harness: boot the real plugin through a real cordis Context with a
// fake sixel-capable Windows Terminal, paste a PNG image, and dump every
// escape sequence that reaches the terminal.
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/term.js"

const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-repro-"))
process.env.DSH_HOME = smokeHome
process.on("exit", () => { try { rmSync(smokeHome, { recursive: true, force: true }) } catch {} })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (rounds = 80) => { for (let i = 0; i < rounds; i++) await sleep(5) }

class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.rawMode = null }
  setRawMode(v) { this.rawMode = v; return this }
  resume() { return this }
  pause() { return this }
  send(text) { this.emit("data", Buffer.from(text, "latin1")) }
}
// Circular write log: the app repaints on a timer, so accumulating the whole
// stream and re-joining it on every paint grows quadratically. Instead, test
// each write once as it arrives and keep only the last few for eyeballing.
const log = []
const MAXLOG = 12
const seen = new Set()
const NEEDLES = [
  ["sixel DCS header", "\x1bP0;1;1q"],
  ["sixel raster attributes", '"1;1;'],
  ["kitty transmission", "\x1b_Ga=T,"],
  ["iterm2 payload", "\x1b]1337;File=inline=1"],
  ["halfblock upper-half glyph", "\u2580"],
  ["image placeholder", "rendering image"],
  ["image render failed", "image render failed"],
  ["image chip fallback", "image attachment"],
  ["mermaid placeholder", "rendering mermaid"],
  ["mermaid fallback header", "```"],
  ["paint probe DA1", "\x1b[c"],
]
class FakeOut extends EventEmitter {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; this.count = 0 }
  write(s) {
    this.count++
    const text = String(s)
    for (const [label, needle] of NEEDLES) if (text.includes(needle)) seen.add(label)
    log.push(text); if (log.length > MAXLOG) log.shift()
    return true
  }
  saw(label) { return seen.has(label) }
}

const COLS = 100, ROWS = 30
const realOut = process.stdout   // console.log must not land in the fake TTY
const stdin = new FakeIn()
const stdout = new FakeOut(COLS, ROWS)
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })
const say = (...args) => realOut.write(args.join(" ") + "\n")

// Record the raw byte stream per paint so we can see what the terminal got.
const paints = []
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  const before = stdout.count
  const result = realPaint.call(this, screen)
  if (paints.length > 400) paints.shift()
  paints.push({ wrote: stdout.count - before, images: screen.images.map((i) => ({ ...i })) })
  return result
}

class AgentsStub extends Service {
  constructor(ctx) {
    super(ctx, "agents"); this.agents = new Map(); this.rootList = []
  }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "smoke-model", provider: "smoke-provider" },
      session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
      cancel() {}, followup() {}, steer() {},
    }
    this.agents.set(agent.id, agent)
    this.rootList.push(agent)
    return { agent, dispose: async () => {} }
  }
}
class CommandsStub extends Service { constructor(ctx) { super(ctx, "commands") } }
class SessionPersistenceStub extends Service { constructor(ctx) { super(ctx, "sessionPersistence") } }
class TuiStartupStub extends Service { constructor(ctx) { super(ctx, "tuiStartup") } }

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)

const tui = await import("file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(20)

// A real Windows Terminal answers the capability probes. Send the replies on
// stdin: DA1 with attribute 4 (sixel), XTVERSION naming WT 1.22, an ENOSYS
// kitty answer, and a cell-size report.
stdin.send("\x1b[?62;4;6c")                 // DA1: sixel = attribute 4
stdin.send("\x1bP>|Windows Terminal 1.22\x1b\\") // XTVERSION
stdin.send("\x1b_Gi=31;error=ENOSYS\x1b\\") // kitty: not supported
stdin.send("\x1b[8;16;8t")                  // cell 8x16 px
await settle(160)

stdin.send("hello")                          // composer text
stdin.send("\r")                             // open a session
await settle(60)

// Paste a real PNG inside bracketed paste, as a terminal would deliver it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
  "base64",
)
stdin.send("\x1b[200~")
stdin.send(PNG.toString("latin1"))
stdin.send("\x1b[201~")
await settle(40)

stdin.send("\r")   // submit
await settle(300)

// Ask the model for a mermaid diagram through the assistant block directly.
import { liveTui } from "file:///D:/Projects/DeepSeekHarnessPlugins/deepseek-harness-tui/lib/bridge.js"
const handle = liveTui()
console.log("handle:", handle ? "present" : "null")

const report = []
for (const [label] of NEEDLES) report.push((stdout.saw(label) ? "ok   " : "FAIL ") + label)

say(report.join("\n"))
say("--- total writes:", stdout.count)
say("--- paints with image annotations:", paints.filter((p) => p.images.length > 0).length)
say("--- image annotations seen:", JSON.stringify(paints.filter((p) => p.images.length > 0).slice(-3).map((p) => p.images)))
say("--- paint writes histogram:", JSON.stringify(paints.slice(-12).map((p) => p.wrote)))
say("--- longest single write:", Math.max(0, ...log.map((c) => c.length)))
process.exit(0)

