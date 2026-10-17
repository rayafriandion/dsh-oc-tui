// The MCP settings page driven end to end: this boots the REAL plugin in a
// headless TTY, walks `Ctrl+P -> MCP`, and adds a user-scope and a path-scope
// server through the same key decoder, form and overlay the user touches.
//
// Assertions read the `mcp.json` documents themselves, so they are assertions
// on what the user — or the bundled mcp-import skill, which writes the same
// files — would find on disk. Run:
//   node tests/mcp-form.test.mjs
// The assertions below are on English chrome text, so the run is pinned to
// English instead of following the machine locale. DSH_TUI_LOCALE is the same
// override a user has, and the plugin reads it when it applies.
process.env.DSH_TUI_LOCALE = "en"

import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"

const origin = process.cwd()
const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-mcp-form-home-"))
const projectDir = mkdtempSync(join(tmpdir(), "dsh-oc-tui-mcp-form-proj-"))
process.env.DSH_HOME = smokeHome
// The session's cwd is `process.cwd()` (the plugin passes it as the session
// meta), so a path-scoped server written here is inside this session's scope.
process.chdir(projectDir)

const userFile = join(smokeHome, "mcp.json")
const projectFile = join(projectDir, ".dsh", "mcp.json")
mkdirSync(join(projectDir, ".dsh"), { recursive: true })

process.on("exit", () => {
  try { process.chdir(origin) } catch { /* the directory is going away anyway */ }
  for (const path of [smokeHome, projectDir]) {
    try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

const report = []
let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await sleep(10) }
// Each key is decoded, the view rebuilt and the frame painted asynchronously,
// so the frame itself is the only reliable "the UI moved on" signal. A fixed
// sleep long enough on a fast machine is a flaky test on a slow one.
const waitFor = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}
// A choice list is the only settings view whose footer is this hint; the MCP
// list and form paint their own subtitles.
const choiceListOpen = () => hintLine() !== undefined
// The MCP list, told apart from the add/edit form: the form has a title and the
// list has the config-file block. ("Add MCP server" is on BOTH — it is the
// form's own section header — so it cannot be the list's marker.)
const mcpListOpen = () => screen().includes("config files") && !screen().includes("mcp · add") && !screen().includes("mcp · edit")

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
const stdout = new FakeOut(120, 34)
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
// Header rows and titles paint UPPERCASE, so text assertions compare folded.
const screen = () => lastFrame().toLowerCase()
const row = (needle) => {
  const folded = needle.toLowerCase()
  return lastFrame().split("\n").find((line) => line.toLowerCase().includes(folded)) ?? ""
}
// The choice list's subtitle is this hint on a line of its own; the MCP form's
// footer carries the same words after "↑/↓ move · ", so a plain substring test
// matches the form as well and returns before the list has opened.
const hintLine = () => screen().split("\n")
  .map((line) => line.replace(/^\s*│\s*/, "").replace(/\s*│\s*$/, "").trim())
  .find((line) => line === "enter select · esc back")

// ---- the document readers the assertions use ----------------------------
const readServers = (path) => {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, "utf8")).servers ?? {} } catch { return null }
}
const namesIn = (path) => Object.keys(readServers(path) ?? {})

// ---- the cordis services the plugin injects -----------------------------
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "mcp-form-model", provider: "mcp-form-provider" },
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
// The MCP page itself needs no settings service any more; this stub keeps the
// Main/Model tabs composable so Tab navigation behaves as it does in the app.
class SettingsStub extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.documentPath = join(smokeHome, "profile.yml")
    this.registry = new Map()
  }
  register(ns, schema) { this.registry.set(String(ns), schema) }
  describe() {
    return [...this.registry].map(([ns]) => ({ ns, value: {}, revision: 0 }))
  }
  update() { return Promise.resolve() }
  mutate() { return Promise.resolve() }
  replace() { return Promise.resolve() }
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
new SettingsStub(ctx)

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(30)

// A session, because the MCP mounts attach to the open session's agent.
stdin.send("x")
stdin.send("\r")
await settle(30)
ok("a session opened for the MCP mounts to attach to", ctx.get("agents").roots().length === 1)

// ---- open the MCP tab ---------------------------------------------------
const down = async (times) => { for (let i = 0; i < times; i++) { stdin.send("\x1b[B"); await settle(10) } }
const up = async (times) => { for (let i = 0; i < times; i++) { stdin.send("\x1b[A"); await settle(10) } }

stdin.send("\x10") // Ctrl+P
await settle(30)
stdin.send("\x1b[Z") // Shift+Tab: main -> mcp (wraps backwards)
await settle(40)
ok("the MCP tab opens with no servers configured",
  screen().includes("add mcp server") && screen().includes("config files") && screen().includes("secrets"),
  "last frame:\n" + lastFrame())
ok("the user config file is listed as not created yet",
  namesIn(userFile).length === 0 && screen().includes("not created yet"),
  "last frame:\n" + lastFrame())

// Each text row needs Enter to open its inline editor, the text, then Enter to
// commit; committing keeps the selection on that row.
const fill = async (text) => {
  stdin.send("\r")
  await settle(20)
  stdin.send(text)
  stdin.send("\r")
  await settle(30)
}

// ---- 1. a user-scope stdio server through the form ----------------------
stdin.send("\r") // Enter on "Add MCP server"
await settle(40)
ok("the add form opened",
  screen().includes("mcp · add") && screen().includes("type") && screen().includes("timeout (ms)"),
  "last frame:\n" + lastFrame())

await fill("smoke-demo") // Name (row 0), the cursor stays there
await down(3) // Name -> Type -> Timeout -> Command
await fill("node") // Command
await down(1)
await fill("server.js --port 3000") // Arguments
await down(1)
await fill('{"TOKEN":"abc"}') // Environment (JSON)
await down(3) // Environment -> Scope -> Enabled -> Save
stdin.send("\r")
await settle(120)

const userServers = readServers(userFile)
ok("the server reached the user-scope mcp.json", userServers !== null && namesIn(userFile).includes("smoke-demo"),
  "file: " + JSON.stringify(userServers))
ok("the stored record kept type, args, JSON env and the default timeout",
  userServers?.["smoke-demo"]?.type === "stdio"
  && userServers?.["smoke-demo"]?.command === "node"
  && JSON.stringify(userServers?.["smoke-demo"]?.args) === JSON.stringify(["server.js", "--port", "3000"])
  && userServers?.["smoke-demo"]?.env?.TOKEN === "abc"
  && userServers?.["smoke-demo"]?.timeoutMs === 30000
  && userServers?.["smoke-demo"]?.enabled === true,
  "record: " + JSON.stringify(userServers?.["smoke-demo"]))
ok("the record carries no name field (the document key is the name)",
  userServers?.["smoke-demo"] !== undefined && !("name" in userServers["smoke-demo"]))
ok("the MCP list shows the new server with a connection state",
  row("smoke-demo").includes("smoke-demo") && /[⚠●○…]/.test(row("smoke-demo")),
  "row: " + row("smoke-demo"))

// ---- 2. a path-scope server written under the session's cwd -------------
await down(3) // server row -> target -> scope -> "Add MCP server"
stdin.send("\r")
await settle(40)
await fill("smoke-proj") // Name
await down(3) // -> Command
await fill("node")
await down(3) // Command -> Arguments -> Environment -> Scope
stdin.send("\r") // open the Scope choices (User is selected)
await waitFor(choiceListOpen)
stdin.send("\x1b[B") // User -> Path
await settle(10)
stdin.send("\r")
await waitFor(() => screen().includes("timeout (ms)"))
ok("choosing the Path scope reveals the Path row",
  screen().includes("mcp · add") && screen().includes("path") && screen().includes("timeout (ms)"),
  "last frame:\n" + lastFrame())
await down(1) // Scope -> Path
await fill(projectDir) // the directory the scope applies to
await down(2) // Path -> Enabled -> Save
stdin.send("\r")
await waitFor(mcpListOpen)

const projectServers = readServers(projectFile)
ok("the path-scope server reached <dir>/.dsh/mcp.json",
  projectServers !== null && namesIn(projectFile).includes("smoke-proj"),
  "file: " + JSON.stringify(projectServers) + " at " + projectFile)
ok("the path-scope record stayed a stdio record without scope fields on disk",
  projectServers?.["smoke-proj"]?.type === "stdio"
  && projectServers?.["smoke-proj"]?.command === "node"
  && !("scope" in (projectServers?.["smoke-proj"] ?? {}))
  && !("sourcePath" in (projectServers?.["smoke-proj"] ?? {})),
  "record: " + JSON.stringify(projectServers?.["smoke-proj"]))
ok("the user file was not touched by the path-scope save",
  !namesIn(userFile).includes("smoke-proj"), "user file: " + JSON.stringify(readServers(userFile)))
ok("the list reports the path scope with its directory",
  screen().includes("path ·") && screen().includes("smoke-proj"), "last frame:\n" + lastFrame())

// ---- 3. edit: flip Enabled on the user-scope server ---------------------
// A new form opens on its first field; this list still has the cursor on
// smoke-demo (the first server row), so Enter reopens that record.
stdin.send("\r")
await settle(40)
ok("the edit form reopens the stored server",
  screen().includes("mcp · edit") && screen().includes("edit mcp server · smoke-demo")
  && screen().includes("timeout (ms)") && screen().includes('"token":"abc"'),
  "last frame:\n" + lastFrame())
await down(6) // Type -> Timeout -> Command -> Arguments -> Environment -> Scope -> Enabled
stdin.send("\r") // open the Enabled choices (on is selected)
await waitFor(choiceListOpen)
stdin.send("\x1b[B") // on -> off
await settle(10)
stdin.send("\r")
await waitFor(() => /enabled\s+off/.test(screen()))
ok("the edit form flipped Enabled", screen().includes("mcp · edit") && /enabled\s+off/.test(screen()),
  "last frame:\n" + lastFrame())
await down(1) // Enabled -> Save
stdin.send("\r")
await waitFor(mcpListOpen)
ok("the edit reached the user-scope document",
  readServers(userFile)?.["smoke-demo"]?.enabled === false,
  "record: " + JSON.stringify(readServers(userFile)?.["smoke-demo"]))

// ---- 4. delete the path-scope server from its own file ------------------
await down(1) // smoke-demo -> smoke-proj
stdin.send("\x1b[3~") // Delete arms the confirm
await waitFor(() => screen().includes("press delete again"))
ok("Delete asks before removing", screen().includes("press delete again"), "last frame:\n" + lastFrame())
stdin.send("\x1b[3~") // a second Delete removes it
await waitFor(() => !screen().includes("smoke-proj"))
ok("the server was removed from the path-scope document",
  readServers(projectFile) !== null && !namesIn(projectFile).includes("smoke-proj"),
  "file: " + JSON.stringify(readServers(projectFile)))
ok("the other scope's server is untouched", namesIn(userFile).includes("smoke-demo"))
ok("the MCP list no longer shows it", !screen().includes("smoke-proj"), "last frame:\n" + lastFrame())

// ---- the input must still work after all that ---------------------------
stdin.send("\x1b") // close the overlay
// Wait past the MCP page's 500 ms refresh: it re-renders through openSettings,
// so a poll that ignores the overlay would put the dialog straight back up.
await settle(80)
stdin.send("still alive")
stdin.send("\r")
await settle(40)
ok("the TUI is still interactive after installing and removing servers",
  screen().includes("still alive"), "last frame:\n" + lastFrame())

// ---- teardown -----------------------------------------------------------
Terminal.prototype.paint = realPaint
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
try { process.chdir(origin) } catch { /* the directory is going away anyway */ }
for (const path of [smokeHome, projectDir]) {
  try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ }
}
if (failed > 0) {
  console.log(failed + " mcp-form check(s) failed")
  process.exit(1)
}
console.log("mcp-form tests passed")
process.exit(0)

