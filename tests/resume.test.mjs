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
import { App } from "../lib/ui.js"

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
const notes = []
const realAddNote = App.prototype.addNote
App.prototype.addNote = function (...args) {
  realAddNote.apply(this, args)
  notes.push({ app: this, block: this.blocks.at(-1) })
}

const contextEvent = (kind, text) => ({
  type: "user/message", time: Date.now(),
  data: { id: kind, source: { kind }, content: [{ type: "text", text }] },
})
const summaryEvent = (type, text) => ({
  type, time: Date.now(), data: { summary: [{ type: "text", text }] },
})

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
    opened.agent.session.snapshotEvents = () => [
      { type: "user/message", time: 1_700_000_000_000,
        data: { id: "historical", source: { kind: "user" }, content: [{ type: "text", text: "historical prompt" }] } },
      { type: "request/header", time: 1_700_000_000_010,
        data: { header: { config: { model: "historical-model" } }, reason: "initial" } },
      { type: "assistant/message", time: 1_700_000_002_500,
        data: { message: { content: [{ type: "text", text: "historical answer" }] } } },
      { type: "model/selection", time: 1_700_000_002_600,
        data: { provider: "second-provider", model: "second-model" } },
      { type: "user/message", time: 1_700_000_003_000,
        data: { id: "second", source: { kind: "user" }, content: [{ type: "text", text: "second prompt" }] } },
      contextEvent("model-selection", "host model notice should stay hidden"),
      { type: "request/header", time: 1_700_000_003_010,
        data: { header: { config: { provider: "second-provider", model: "second-model" } }, reason: "change" } },
      { type: "request/context", time: 1_700_000_003_020,
        data: { provider: "second-provider", model: "second-model" } },
      { type: "assistant/message", time: 1_700_000_004_000,
        data: { message: { content: [{ type: "text", text: "second answer" }] } } },
      contextEvent("compact-checkpoint", "replayed checkpoint body"),
      contextEvent("compact-summary", "replayed context summary body"),
      summaryEvent("compaction/summary", "replayed event summary body"),
    ]
    return opened
  }
}
class CommandsStub extends Service { constructor(ctx) { super(ctx, "commands") } find() { return undefined } }
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

ok("replay collapses checkpoint and both summary forms",
  notes.length === 3 && notes.every(({ block }) => block.kind === "note" && block.label === "compaction" && block.collapsed),
  JSON.stringify(notes.map(({ block }) => ({ kind: block.kind, label: block.label, collapsed: block.collapsed }))))
ok("replayed compact bodies stay hidden", !lastFrame().includes("replayed checkpoint body") && !lastFrame().includes("replayed event summary body"))
const replayApp = notes[0]?.app
const historical = replayApp?.blocks.find((block) => block.kind === "assistant")
ok("replay restores the request model and original turn duration",
  historical?.model === "historical-model"
    && historical.turnStartedAt === 1_700_000_000_000
    && lastFrame().includes("historical-model · 2.5s"))
ok("historical request models do not overwrite the current model", replayApp?.model === "resume-model")
const replayChanges = replayApp?.blocks.filter((block) => block.kind === "model-change") ?? []
ok("replay reconstructs a single switch before the next prompt",
  replayChanges.length === 1 && replayChanges[0].from.model === "historical-model"
    && replayChanges[0].to.model === "second-model" && replayChanges[0].to.provider === "second-provider"
    && replayApp.blocks.indexOf(replayChanges[0]) < replayApp.blocks.findIndex((block) => block.text === "second prompt"))
ok("the host's internal model context is not shown as a duplicate",
  !replayApp.blocks.some((block) => block.text?.includes("host model notice should stay hidden")))
const liveSession = ctx.get("agents").get(RESUME_ID).session
ctx.emit("session/event", liveSession, contextEvent("compact-checkpoint", "live checkpoint body"))
ctx.emit("session/event", liveSession, contextEvent("compact-summary", "live context summary body"))
ctx.emit("session/event", liveSession, summaryEvent("compact/summary", "live event summary body"))
await settle(10)
ok("live compact events also become collapsed notes",
  notes.length === 6 && notes.slice(3).every(({ block }) => block.kind === "note" && block.collapsed))
const compactNote = notes.at(-1)
compactNote.app.toggleNote(compactNote.block)
const expanded = compactNote.app.render().cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n")
ok("compact summary can be expanded", expanded.includes("live event summary body"))
compactNote.app.toggleNote(compactNote.block)

const liveTime = Date.now() - 1500
ctx.emit("session/event", liveSession, {
  type: "user/message", time: liveTime,
  data: { id: "live-prompt", source: { kind: "user" }, content: [{ type: "text", text: "live prompt" }] },
})
ctx.emit("session/event", liveSession, {
  type: "request/context", time: liveTime + 10,
  data: { provider: "test", model: "live-request-model" },
})
ctx.emit("session/event", liveSession, {
  type: "assistant/message", time: liveTime + 1500,
  data: { message: { content: [{ type: "text", text: "live answer" }] } },
})
ctx.emit("session/event", liveSession, contextEvent("model-selection", "live internal model notice"))
await settle(10)
ok("live request metadata reaches the completed response footer",
  lastFrame().includes("live-request-model · 1.5s") && lastFrame().includes("live answer"))

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

const changesBeforeCommand = replayApp.blocks.filter((block) => block.kind === "model-change").length
stdin.send("/model chosen-model")
stdin.send("\r")
await settle(20)
const commandChanges = replayApp.blocks.filter((block) => block.kind === "model-change")
ok("the real model command immediately adds a route change notice",
  commandChanges.length === changesBeforeCommand + 1 && commandChanges.at(-1).from.model === "resume-model"
    && commandChanges.at(-1).to.model === "chosen-model")
stdin.send("/model chosen-model")
stdin.send("\r")
await settle(20)
ok("selecting the current model does not add a duplicate notice",
  replayApp.blocks.filter((block) => block.kind === "model-change").length === commandChanges.length)
ctx.emit("session/event", liveSession, {
  type: "model/selection", time: Date.now(),
  data: { provider: "external-provider", model: "external-model" },
})
await settle(10)
const externalChanges = replayApp.blocks.filter((block) => block.kind === "model-change")
ok("external model selections also add a notice and update the selected route",
  externalChanges.length === commandChanges.length + 1 && externalChanges.at(-1).to.model === "external-model"
    && replayApp.model === "external-model" && replayApp.provider === "external-provider"
    && !replayApp.blocks.some((block) => block.text?.includes("live internal model notice")))
ctx.emit("session/event", liveSession, {
  type: "model/selection", time: Date.now(),
  data: { provider: "external-provider", model: "external-model", reasoningEffort: "high" },
})
await settle(10)
ok("reasoning-only changes do not add a model switch notice",
  replayApp.blocks.filter((block) => block.kind === "model-change").length === externalChanges.length)

// ---- teardown -----------------------------------------------------------
Terminal.prototype.paint = realPaint
App.prototype.addNote = realAddNote
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
