// The Language setting driven end to end: this boots the REAL plugin in a
// headless TTY, walks `Ctrl+P -> Language -> 日本語`, and asserts the interface
// itself changed — the frame is Japanese, the stored preference is the locale
// id, and the switch survives a rebuilt settings view rather than only the row
// the user pressed. Then it switches back to English the same way.
//
// The point of the test is that the language is not a boot-time choice: the
// title screen, the settings chrome and the stored document all have to agree
// within one repaint. Run:
//   node tests/locale.test.mjs
process.env.DSH_TUI_LOCALE = "en"

import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"
import { LOCALES } from "../lib/i18n.js"

const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-locale-home-"))
process.env.DSH_HOME = smokeHome
process.on("exit", () => {
  try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
})

const report = []
let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await sleep(10) }

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
// Restored before the report prints: console.log writes through the same
// process.stdout the plugin is given here.
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
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "locale-model", provider: "locale-provider" },
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
// A settings service that behaves like the real one for the one namespace this
// test writes: `update`/`replace` land in `this.stored` and `describe` reports
// them back, so the row builder after the switch reads what was just committed.
class SettingsStub extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.documentPath = join(smokeHome, "settings.yaml")
    this.registry = new Map()
    this.stored = new Map()
    this.revision = 0
    this.writes = []
  }
  register(ns, schema) { this.registry.set(String(ns), schema) }
  describe() {
    return [...this.registry].map(([ns]) => ({
      ns,
      value: this.stored.get(String(ns)) ?? {},
      revision: this.revision,
    }))
  }
  update(ns, patch) {
    this.writes.push({ op: "update", ns: String(ns), patch })
    this.stored.set(String(ns), { ...(this.stored.get(String(ns)) ?? {}), ...patch })
    this.revision++
    return Promise.resolve()
  }
  mutate(ns, ops) {
    this.writes.push({ op: "mutate", ns: String(ns), ops })
    const next = { ...(this.stored.get(String(ns)) ?? {}) }
    for (const op of ops) {
      if (op.op === "set") next[op.path[0]] = op.value
      else if (op.op === "unset") delete next[op.path[0]]
    }
    this.stored.set(String(ns), next)
    this.revision++
    return Promise.resolve()
  }
  replace(ns, value) {
    this.writes.push({ op: "replace", ns: String(ns), value })
    this.stored.set(String(ns), value)
    this.revision++
    return Promise.resolve()
  }
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
const settings = new SettingsStub(ctx)

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle(30)

// A session, because the title screen and the session view resolve their
// strings through different paths.
stdin.send("x")
stdin.send("\r")
await settle(30)

// ---- 1. the boot language is English ------------------------------------
ok("the boot language is English",
  lastFrame().includes("New session") && lastFrame().includes("WORKSPACE"),
  "last frame:\n" + lastFrame())

// ---- 2. switch to Japanese from the settings page -----------------------
// The list opens on the stored value, so navigation is relative to it rather
// than absolute: a hard-coded row number would silently drift with LOCALES.
const LOCALE_ORDER = ["system", ...LOCALES.map((entry) => entry.id)]
const move = async (delta) => {
  for (let i = 0; i < Math.abs(delta); i++) {
    stdin.send(delta > 0 ? "\x1b[B" : "\x1b[A")
    await settle(10)
  }
}
// The settings page stays open on the Language row after a commit, so the
// second and third switches only have to open the list again.
const chooseLocale = async (target) => {
  const stored = settings.stored.get("tui-locale")?.preference ?? "system"
  stdin.send("\r")
  await settle(40)
  await move(LOCALE_ORDER.indexOf(target) - LOCALE_ORDER.indexOf(stored))
  stdin.send("\r")
  await settle(60)
}

stdin.send("\x10") // Ctrl+P
await settle(40)
ok("the settings page opens on Main with a Language row",
  lastFrame().includes("Language") && lastFrame().includes("Main"),
  "last frame:\n" + lastFrame())

stdin.send("\r")
await settle(40)
ok("the Language choice list opens with the stored value selected",
  lastFrame().includes("System") && lastFrame().includes("English") && lastFrame().includes("日本語"),
  "last frame:\n" + lastFrame())

await move(LOCALE_ORDER.indexOf("ja") - LOCALE_ORDER.indexOf("system"))
stdin.send("\r")
await settle(60)

// ---- 3. the switch landed -------------------------------------------------
ok("the interface switched to Japanese",
  lastFrame().includes("新しいセッション") && lastFrame().includes("設定"),
  "last frame:\n" + lastFrame())
ok("the settings rows were rebuilt in Japanese",
  lastFrame().includes("言語") && lastFrame().includes("一般"),
  "last frame:\n" + lastFrame())
ok("the stored preference is the locale id",
  settings.stored.get("tui-locale")?.preference === "ja",
  "stored: " + JSON.stringify(settings.stored.get("tui-locale")))
ok("the preference was written through the settings service",
  settings.writes.some((entry) => entry.ns === "tui-locale" && entry.patch?.preference === "ja"),
  "writes: " + JSON.stringify(settings.writes.filter((entry) => entry.ns === "tui-locale")))

// ---- 4. switch back to English -------------------------------------------
// Leave the page and come back through Ctrl+P, so the second switch also
// proves the row is reachable in the new language, not just the old one.
stdin.send("\x1b")
await settle(40)
stdin.send("\x10")
await settle(40)
await chooseLocale("en")
ok("switching back to English restores the English chrome",
  lastFrame().includes("New session") && !lastFrame().includes("新しいセッション"),
  "last frame:\n" + lastFrame())
ok("the second switch stored the English locale id",
  settings.stored.get("tui-locale")?.preference === "en",
  "stored: " + JSON.stringify(settings.stored.get("tui-locale")))

// ---- 5. `System` clears the stored preference ----------------------------
await chooseLocale("system")
ok("System clears the namespace instead of storing an id",
  settings.writes.some((entry) => entry.op === "replace" && entry.ns === "tui-locale"),
  "writes: " + JSON.stringify(settings.writes.filter((entry) => entry.ns === "tui-locale")))
ok("System resolves back to the pinned environment locale",
  lastFrame().includes("New session") && lastFrame().includes("Language"),
  "last frame:\n" + lastFrame())

Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
if (failed > 0) {
  console.log(failed + " locale check(s) failed")
  process.exit(1)
}
console.log("locale tests passed")
process.exit(0)