// A paste that arrives while the settings dialog is open must land in the field
// being edited — never in the composer behind the dialog.
//
// WHY THIS IS NOT A UNIT TEST
// The pure half (newline folding, image refusal) is pinned in
// `tests/provider-form.test.mjs` against `fieldPasteText`. What lives only inside
// `apply()`'s closure is the routing: `term.on('key')` sees a bracketed paste
// before it knows which surface is focused, and `handlePaste()` -> `insert()`
// writes to `app.inputText`. With a dialog on screen that row is invisible, so a
// pasted API key would sit in the composer — one Enter away from being sent as a
// chat message — which is exactly what a user reported after pressing Ctrl+V on
// the provider form's key field.
//
// So this mounts the REAL `lib/index.js` `apply()` through a REAL cordis Context,
// drives the REAL live-TUI handle, and feeds the bracketed-paste framing
// `lib/term.js` decodes (ESC[200~ ... ESC[201~).
//
// Run: node tests/settings-paste.test.mjs
process.env.DSH_TUI_LOCALE = "en"

// This suite boots the interface, not the host gate: pin the version verdict so a
// machine running a dsh this build has not been run against still runs the tests.
process.env.DSH_TUI_IGNORE_DSH_VERSION = "1"

import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"
import { App } from "../lib/ui.js"

const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-settings-paste-"))
process.env.DSH_HOME = smokeHome
process.on("exit", () => {
  try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
})

let failed = 0
const report = []
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await sleep(5) }

// ---- headless TTY -------------------------------------------------------
class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.rawMode = null }
  setRawMode(value) { this.rawMode = value; return this }
  resume() { return this }
  pause() { return this }
  send(text) { this.emit("data", Buffer.from(text, "utf8")) }
  sendBytes(bytes) { this.emit("data", Buffer.from(bytes)) }
}
class FakeOut extends EventEmitter {
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows }
  write() { return true }
}

const stdin = new FakeIn()
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout")
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: new FakeOut(120, 32), configurable: true })

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

// `app` lives inside apply()'s closure; taking the instance off a render it
// performs is the only honest way to read its state. This observes only.
let app = null
const realRender = App.prototype.render
App.prototype.render = function (...args) {
  app = this
  return realRender.apply(this, args)
}

// ---- the services the plugin injects ------------------------------------
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "paste-model", provider: "paste-provider" },
      session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
      cancel() {}, followup() {}, steer() {},
    }
    this.agents.set(agent.id, agent)
    this.rootList.push(agent)
    return { agent, dispose: async () => {} }
  }
}
class CommandsStub extends Service {
  constructor(ctx) { super(ctx, "commands") }
  find() { return undefined }
}
class SessionPersistenceStub extends Service { constructor(ctx) { super(ctx, "sessionPersistence") } }
class TuiStartupStub extends Service { constructor(ctx) { super(ctx, "tuiStartup") } }

// A settings service shaped like dsh 0.2.0's `SettingsForms`: no registry, and
// `describe()` projects whatever the entries resolve to. One entry with a plain
// string field is all this test needs — it gives the Main tab a real text row to
// paste into.
class FormsSettings extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.revision = 0
    this.writes = []
    this.value = { default: "" }
  }
  describe() {
    return [{ ns: "agent-presets", value: { ...this.value }, user: { ...this.value }, revision: this.revision, applies: "live" }]
  }
  async update(ns, patch) {
    this.writes.push({ ns, patch })
    this.value = { ...this.value, ...patch }
    this.revision++
  }
  async mutate(ns, ops) {
    this.writes.push({ ns, ops })
    return this.update(ns, {})
  }
  async replace() {}
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
const settings = new FormsSettings(ctx)

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(30)

const { liveTui } = await import("../lib/bridge.js")
ok("the real plugin boots and registers a live TUI handle", liveTui() !== null)
ok("a real App instance was observed through its own render", app !== null)

// Exercise suggestions through the real key and mouse decoders before opening
// a session; completion must neither submit a message nor steal ordinary Tab.
stdin.send("/")
await settle(5)
stdin.send("\x1b[B")
await settle(5)
const selectedCommand = app.commandMatches()[app.commandSelection]?.[0]
stdin.send("\t")
await settle(5)
ok("Down and Tab complete the selected command", app.inputText === selectedCommand + " ")
ok("completion leaves the title screen open", ctx.get("agents").roots().length === 0)
stdin.send("\x03") // clear
stdin.send("/res")
stdin.send("\r")
await settle(5)
ok("Enter completes an unfinished command without executing it", app.inputText === "/resume ")
stdin.send("\x03")
stdin.send("/")
await settle(5)
stdin.send("\x1b")
await settle(15)
ok("Esc closes suggestions and keeps the draft", app.inputText === "/" && app.commandMatches().length === 0)
stdin.send("\x03")
stdin.send("/")
await settle(5)
const commandHit = app.hitRegions.find((region) => region.kind === "command" && region.commandIndex === 1)
ok("command choices expose a real mouse target", !!commandHit)
if (commandHit) {
  stdin.send(`\x1b[<0;${commandHit.x + 3};${commandHit.y + 1}M`)
  await settle(5)
  ok("clicking a suggestion completes it", app.inputText === "/settings ")
  stdin.send("\r")
  await settle(10)
  ok("a complete command executes on Enter", app.overlay === "settings")
  stdin.send("\x1b")
  await settle(15)
}
stdin.send("\x03")

// A session, so the composer exists as a real input row rather than the title
// screen's menu.
stdin.send("x")
stdin.send("\r")
await settle(20)
ok("the composer is empty before anything is pasted", app?.inputText === "")

const bracketedPaste = (text) => "\x1b[200~" + text + "\x1b[201~"
const imagePaste = () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  stdin.sendBytes(Buffer.concat([Buffer.from("\x1b[200~", "utf8"), png, Buffer.from([0x1b]), Buffer.from("[201~", "utf8")]))
}

// ---- 1. the dialog is up and has a text row ------------------------------
stdin.send("\x10") // Ctrl+P
await settle(30)
ok("the settings dialog is open", app?.overlay === "settings", "overlay = " + String(app?.overlay))
const textRow = app.settingsItems.findIndex((item) => item.ns === "agent-presets" && item.kind === "text")
ok("the Main tab has a text row to paste into", textRow >= 0,
  "rows: " + app.settingsItems.map((item) => item.kind + ":" + String(item.ns)).join(","))
// Walk the selection with the key a user would press. The list wraps, so a
// bounded loop always reaches a selectable row.
const moveTo = async (target) => {
  for (let i = 0; i <= app.settingsItems.length; i++) {
    if (app.settingsSelection === target) return
    stdin.send("\x1b[B")
    await sleep(3)
  }
}
await moveTo(textRow)
ok("the text row is selected", app.settingsSelection === textRow,
  "selection = " + String(app.settingsSelection))

// ---- 2. a paste ON the row opens its editor around the pasted text -------
{
  frames.length = 0
  stdin.send(bracketedPaste("sk-test-123"))
  await settle(10)
  ok("a paste on a text row opens its editor", app.settingsEditing === textRow,
    "editing = " + String(app.settingsEditing))
  ok("the pasted text is the draft", app.settingsDraft === "sk-test-123",
    "draft = " + JSON.stringify(app.settingsDraft))
  ok("the text is on screen", lastFrame().includes("sk-test-123"), "last frame:\n" + lastFrame())
  ok("the composer did NOT receive it", app.inputText === "",
    "inputText = " + JSON.stringify(app.inputText))
}

// ---- 3. Enter commits the pasted value -----------------------------------
stdin.send("\r")
await settle(20)
ok("Enter commits the pasted value to the settings service",
  settings.writes.some((entry) => entry.patch?.default === "sk-test-123"),
  "writes: " + JSON.stringify(settings.writes))
ok("the composer is still empty after the commit", app.inputText === "")

// ---- 4. a paste while editing APPENDS, it does not replace ---------------
{
  await moveTo(app.settingsItems.findIndex((item) => item.ns === "agent-presets"))
  stdin.send("\r") // open the editor on the stored value
  await settle(10)
  ok("the editor opens on the stored value", app.settingsDraft === "sk-test-123",
    "draft = " + JSON.stringify(app.settingsDraft))
  stdin.send(bracketedPaste("-tail"))
  await settle(10)
  ok("a second paste appends", app.settingsDraft === "sk-test-123-tail",
    "draft = " + JSON.stringify(app.settingsDraft))
  ok("and still does not reach the composer", app.inputText === "")
  stdin.send("\x1b") // Esc closes the editor without committing
  await settle(10)
}

// ---- 5. a multi-line paste is folded to one line -------------------------
{
  stdin.send("\r")
  await settle(10)
  app.settingsDraft = ""
  stdin.send(bracketedPaste("line-one\r\nline-two"))
  await settle(10)
  ok("newlines fold into a space", app.settingsDraft === "line-one line-two",
    "draft = " + JSON.stringify(app.settingsDraft))
  stdin.send("\x1b")
  await settle(10)
}

// ---- 6. an image paste is refused rather than typed as mojibake ----------
{
  stdin.send("\r")
  await settle(10)
  const before = app.settingsDraft
  imagePaste()
  await settle(10)
  ok("an image paste leaves the field alone", app.settingsDraft === before,
    "draft = " + JSON.stringify(app.settingsDraft))
  ok("and does not become an attachment", (app.inputImages ?? []).length === 0)
  stdin.send("\x1b")
  await settle(10)
}

// ---- 7. a paste on a row with no text field goes nowhere ----------------
{
  const actionRow = app.settingsItems.findIndex((item) => item.kind === "new-session")
  await moveTo(actionRow)
  const before = app.inputText
  stdin.send(bracketedPaste("stray"))
  await settle(10)
  ok("a paste on an action row opens no editor", app.settingsEditing === null,
    "editing = " + String(app.settingsEditing))
  ok("and the composer keeps its content", app.inputText === before,
    "inputText = " + JSON.stringify(app.inputText))
}

// ---- 8. the same paste belongs to the composer once the dialog is gone ---
stdin.send("\x1b") // close the dialog
await settle(20)
ok("the dialog closed", app.overlay === null, "overlay = " + String(app.overlay))
{
  stdin.send(bracketedPaste("hello composer"))
  await settle(10)
  ok("a paste with no dialog open reaches the composer", app.inputText.includes("hello composer"),
    "inputText = " + JSON.stringify(app.inputText))
}

Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
if (failed > 0) {
  console.log(failed + " settings-paste check(s) failed")
  process.exit(1)
}
console.log("settings-paste tests passed")
process.exit(0)
