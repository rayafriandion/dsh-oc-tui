// The `--resume` boot path, which is an apply-time path: the session is opened
// while the plugin is still applying, so it can lose a startup race that the
// post-boot paths (typing + Enter, /resume) win. That matters most for the MCP
// mounts, which are attached at session-open time — so this file boots with a
// configured server that cannot connect and requires the resumed session to
// open anyway. Without that guarantee a broken MCP row would cost the user
// their session, which is the failure mode this feature must never have.
//
// The same real-cordis harness as the esc-questions suite: REAL lib/index.js
// apply(), REAL lib/term.js decoding, a headless TTY. Run:
//   node tests/resume.test.mjs
// The assertions below are on English chrome text, so the run is pinned to
// English instead of following the machine locale. DSH_TUI_LOCALE is the same
// override a user has, and the plugin reads it when it applies.
process.env.DSH_TUI_LOCALE = "en"

import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"

// The plugin reads the harness home for its session store and settings, so the
// run is pointed at a throwaway one and never touches the real profile.
const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-resume-"))
process.env.DSH_HOME = smokeHome
process.on("exit", () => {
  try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
})

// stdout is the fake TTY for the whole run, so results are buffered and flushed
// once the real streams are back in place.
const report = []
let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 80) => { for (let i = 0; i < rounds; i++) await sleep(10) }

// ---- headless TTY -------------------------------------------------------
class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.rawMode = null }
  setRawMode(value) { this.rawMode = value; return this }
  resume() { return this }
  pause() { return this }
  send(text) { this.emit("data", Buffer.from(text, "utf8")) }
}
class FakeOut extends EventEmitter {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows; this.chunks = [] }
  write(s) { this.chunks.push(String(s)); return true }
}

const stdin = new FakeIn()
const stdout = new FakeOut(110, 32)
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout")
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })

const frames = []
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  const rows = []
  for (let y = 0; y < screen.rows; y++) {
    let line = ""
    for (let x = 0; x < screen.cols; x++) line += screen.cells[y][x].ch ?? ""
    rows.push(line.replace(/\s+$/, ""))
  }
  frames.push(rows.join("\n"))
  return realPaint.call(this, screen)
}
const lastFrame = () => frames.at(-1) ?? ""

// ---- the cordis services the plugin injects -----------------------------
// `agents` carries a `resume` because that is the only call the --resume boot
// makes, and `settings` carries one MCP server whose command does not exist.
const RESUME_ID = "sess-resume-probe"
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = []; this.resumed = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "resume-model", provider: "resume-provider" },
      session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
      cancel() {}, followup() {}, steer() {},
    }
    this.agents.set(agent.id, agent)
    this.rootList.push(agent)
    return { agent, dispose: async () => {} }
  }
  async resume({ resumeSessionId }) {
    this.resumed.push(String(resumeSessionId))
    const opened = await this.create({ sessionId: resumeSessionId, meta: { cwd: process.cwd() } })
    opened.agent.session.header = { ...opened.agent.session.header, resumed: true }
    return opened
  }
}
class CommandsStub extends Service { constructor(ctx) { super(ctx, "commands") } }
class SessionPersistenceStub extends Service { constructor(ctx) { super(ctx, "sessionPersistence") } }
// The apply-time startup arguments arrive through this injected service; the
// CLI flag `--resume <id>` is what fills it in a real boot.
class TuiStartupStub extends Service {
  constructor(ctx) { super(ctx, "tuiStartup"); this.resume = RESUME_ID }
}
class SettingsStub extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.documentPath = join(smokeHome, "settings.json")
    this.registry = new Map()
    this.values = new Map()
    this.mutations = []
  }
  register(ns, schema) { this.registry.set(String(ns), schema) }
  describe() {
    return [...this.registry].map(([ns, schema]) => ({
      ns,
      value: this.values.get(ns) ?? schema(),
      revision: 0,
    }))
  }
  async mutate(ns, ops) { this.mutations.push({ ns, ops }) }
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
new SettingsStub(ctx)
// A stdio server whose command does not exist: the mount can only fail, and it
// fails through the same row a mis-typed command produces in real use. The
// server list lives in the user-scope `mcp.json`, which is read at session-open
// time and again when the MCP page opens.
writeFileSync(join(smokeHome, "mcp.json"), JSON.stringify({
  version: 1,
  servers: { ghost: { type: "stdio", command: "dsh-oc-tui-no-such-binary", args: [], env: {}, timeoutMs: 30000, enabled: true } },
}, null, 2) + "\n", "utf8")

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(20)

ok("the apply-time --resume path opened a session", ctx.get("agents").resumed.length === 1,
  "resume calls: " + JSON.stringify(ctx.get("agents").resumed))
ok("the resumed session's id is the one asked for", ctx.get("agents").resumed[0] === RESUME_ID)
ok("the title screen was skipped", frames.some((frame) => frame.includes("resumed")),
  "no frame announced the resumed session; last frame:\n" + lastFrame())
ok("the boot survived an MCP server that cannot connect",
  ctx.get("agents").roots().length === 1 && lastFrame().includes("resumed"),
  "last frame:\n" + lastFrame())
ok("the resumed session is what is on screen",
  lastFrame().includes(RESUME_ID) && lastFrame().includes("resume-model"),
  "last frame:\n" + lastFrame())

// The MCP page is the row that failed, and it must still be reachable: the
// overlay is entered through the real key decoder (Ctrl+P), and Tab walks the
// left menu the same way a user does.
stdin.send("\x10") // Ctrl+P
await settle(20)
ok("the settings overlay opened after the resume", lastFrame().includes("SETTINGS") || lastFrame().includes("Settings"),
  "last frame:\n" + lastFrame())
stdin.send("\t") // model
await settle(10)
stdin.send("\t") // update
await settle(10)
stdin.send("\t") // mcp
await settle(20)
ok("the MCP tab opens after a resume", lastFrame().includes("ghost"),
  "last frame:\n" + lastFrame())
ok("the unreachable server is shown as a failed row, not a dead overlay",
  /[⚠●○…]/.test(lastFrame()), "last frame:\n" + lastFrame())
stdin.send("\x1b") // Esc closes the overlay; nothing may hang on the way out
await settle(20)
ok("the overlay closed cleanly", !lastFrame().includes("SETTINGS") && lastFrame().includes(RESUME_ID),
  "last frame:\n" + lastFrame())

// ---- teardown -----------------------------------------------------------
Terminal.prototype.paint = realPaint
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
// The live plugin owns a paint interval, a settings poll and an MCP fiber, so
// the loop would otherwise stay alive; every suite here exits explicitly.
if (failed > 0) {
  console.log(failed + " resume check(s) failed")
  process.exit(1)
}
console.log("resume tests passed")
process.exit(0)
