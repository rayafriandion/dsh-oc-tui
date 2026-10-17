// The Language setting on a dsh 0.2.0 host — the settings model that has NO
// namespace registry. That host derives its settings page from per-entry Config
// forms (`SettingsForms`), so `settings.register` does not exist, `describe()`
// lists only entries whose Config declares the field, and a write goes through
// `update`/`mutate` on the plugin's own entry id.
//
// This is a separate file from tests/locale.test.mjs on purpose: that one
// exercises the 0.1.x registry path, and the bug this covers was precisely that
// the row existed only there. Both must keep working — one build serves both
// hosts.
//
// The second half covers the live-switch path a host-initiated write takes: the
// loader pushes the new value into the running Config reference and emits
// `loader/volatile-update`, and the interface has to follow without a restart.
// Run:
//   node tests/locale-forms.test.mjs
process.env.DSH_TUI_LOCALE = "en"

import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"
import { LOCALES } from "../lib/i18n.js"

const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-locale-forms-home-"))
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
  constructor(cols, rows) { super(); this.isTTY = true; this.columns = cols; this.rows = rows }
  write() { return true }
}
const stdin = new FakeIn()
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout")
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: new FakeOut(120, 34), configurable: true })

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

// ---- the services the plugin injects ------------------------------------
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "forms-model", provider: "forms-provider" },
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

// A settings service shaped like dsh 0.2.0's `SettingsForms`:
//   * no `register` at all (the bug was a code path that assumed one),
//   * `describe()` projects the ENTRY's live Config — the same volatile
//     references the plugin is running with, which is why a host-side push and
//     the plugin's own view can never disagree,
//   * `update`/`mutate`/`replace` write into that Config and bump the revision.
class FormsSettings extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.entryId = "tui-app"
    this.config = null
    this.revision = 0
    this.writes = []
    this.describes = 0
  }
  // Called once the plugin has mounted, mirroring how the loader holds the
  // entry's resolved Config.
  attach(config) { this.config = config }
  plain() {
    const value = {}
    for (const [key, field] of Object.entries(this.config ?? {})) {
      value[key] = typeof field?.get === "function" ? field.get() : field
    }
    return value
  }
  // Every settings page rebuild re-reads the descriptors, so this is a count of
  // rebuilds — including the ones the locale change itself triggers.
  describe() {
    this.describes++
    return [{ ns: this.entryId, value: this.plain(), revision: this.revision, applies: "live" }]
  }
  // The host writes through the volatile reference, exactly as
  // `updateVolatile()` does in the loader.
  setField(field, value) {
    const ref = this.config?.[field]
    if (typeof ref?.get === "function") ref[Symbol.for("cosmokit.volatile.write")](value)
    else this.config[field] = value
    this.revision++
  }
  update(ns, patch) {
    this.writes.push({ op: "update", ns: String(ns), patch })
    for (const [field, value] of Object.entries(patch)) this.setField(field, value)
    this.announce?.()
    return Promise.resolve()
  }
  mutate(ns, ops) {
    this.writes.push({ op: "mutate", ns: String(ns), ops })
    for (const op of ops) {
      const field = op.path[0]
      if (op.op === "set") this.setField(field, op.value)
      // `unset` returns the field to its schema default, which for `locale` is
      // `system` — the host drops the raw value from the profile patch.
      else if (op.op === "unset") this.setField(field, "system")
    }
    this.announce?.()
    return Promise.resolve()
  }
  replace(ns, section) {
    this.writes.push({ op: "replace", ns: String(ns), section })
    for (const field of Object.keys(section ?? {})) this.setField(field, section[field])
    return Promise.resolve()
  }
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
const settings = new FormsSettings(ctx)

const tui = await import("../lib/index.js")
ok("the plugin's Config declares the fields a 0.2.0 page is built from",
  typeof tui.Config?.dict?.locale === "function"
  && typeof tui.Config?.dict?.graphics === "function"
  && typeof tui.Config?.dict?.startupCheck === "function",
  "Config fields: " + Object.keys(tui.Config?.dict ?? {}).join(","))
ok("the language field is volatile, so a host edit does not remount the TUI",
  tui.Config?.dict?.locale?.meta?.volatile === true,
  "locale meta: " + JSON.stringify(tui.Config?.dict?.locale?.meta))

const mounted = await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name, Config: tui.Config }, {})
await settle(30)
settings.attach(mounted.fiber?.config ?? mounted.config ?? {})

// The real host announces a committed Config field *while* it writes it, so the
// plugin sees the change before its own commit has finished. Announcing from
// inside the write reproduces that ordering, which is what makes the selection
// race below reachable at all.
settings.announce = () => ctx.emit("loader/volatile-update", [["locale"]])

// A session: the settings page is reachable from both, but the transcript
// strings are only painted once one exists.
stdin.send("x")
stdin.send("\r")
await settle(30)

// ---- 1. the row is there at all -----------------------------------------
stdin.send("\x10") // Ctrl+P
await settle(40)
ok("the Main tab lists a Language row without any namespace registry",
  lastFrame().includes("Language") && lastFrame().includes("Main"),
  "last frame:\n" + lastFrame())
ok("the Language row shows the resolved system language",
  /Language\s+System/.test(lastFrame()),
  "last frame:\n" + lastFrame())

// ---- 2. switching writes to the plugin's own entry ----------------------
const LOCALE_ORDER = ["system", ...LOCALES.map((entry) => entry.id)]
const move = async (delta) => {
  for (let i = 0; i < Math.abs(delta); i++) {
    stdin.send(delta > 0 ? "\x1b[B" : "\x1b[A")
    await settle(10)
  }
}
stdin.send("\r")
await settle(40)
ok("the Language list opens with every locale plus System",
  lastFrame().includes("日本語") && lastFrame().includes("한국어") && lastFrame().includes("System"),
  "last frame:\n" + lastFrame())
await move(LOCALE_ORDER.indexOf("ja") - LOCALE_ORDER.indexOf("system"))
// Count the page rebuilds the commit itself costs, so the assertion below can
// tell one from two.
settings.describes = 0
stdin.send("\r")
await settle(60)
const rebuildsForTheCommit = settings.describes

ok("the interface switched to Japanese in place",
  lastFrame().includes("新しいセッション") && lastFrame().includes("設定"),
  "last frame:\n" + lastFrame())
ok("the preference was written to this plugin's own entry",
  settings.writes.some((entry) => entry.ns === "tui-app" && entry.patch?.locale === "ja"),
  "writes: " + JSON.stringify(settings.writes))
ok("the running Config reference carries the new language",
  settings.plain().locale === "ja",
  "config locale: " + JSON.stringify(settings.plain().locale))

// The host announced the change *during* the write, before commitSetting had
// repainted the page. Rebuilding from that announcement too would rebuild with
// the index the option list was sitting on — a few rows below the Language row —
// so the highlight would drift off the row that was just edited for as long as
// the extra rebuild takes. One rebuild per commit is the whole job here.
// One rebuild per commit is the whole job here: a second one, triggered by the
// host's mid-write announcement, would be built with the index the option list
// was sitting on — a few rows below the Language row — so the highlight would
// drift off the row that was just edited for as long as that rebuild takes.
await settle(120)
ok("one language commit rebuilds the settings page once",
  rebuildsForTheCommit <= 2,
  "describes during commit: " + rebuildsForTheCommit)
stdin.send("\r")
await settle(50)
const listAgain = lastFrame()
ok("the highlight stays on the row that was edited",
  listAgain.includes("日本語") && listAgain.includes("简体中文") && !listAgain.includes("자동"),
  "last frame:\n" + listAgain)
stdin.send("\x1b") // close the list
await settle(30)

// ---- 3. a host-side write is followed live ------------------------------
// The host (its own settings surface, or a hand-edited profile patch) pushes a
// value into the Config reference and announces it. The TUI must adopt it
// without a restart and without dropping the open settings page.
stdin.send("\x1b") // close the overlay first
await settle(30)
settings.setField("locale", "ko")
ctx.emit("loader/volatile-update", [["locale"]])
await settle(40)
ok("a host-initiated language change repaints the interface live",
  lastFrame().includes("새 세션") || lastFrame().includes("새로운 세션"),
  "last frame:\n" + lastFrame())

// ---- 4. back to System --------------------------------------------------
stdin.send("\x10")
await settle(40)
stdin.send("\r")
await settle(40)
await move(LOCALE_ORDER.indexOf("system") - LOCALE_ORDER.indexOf("ko"))
stdin.send("\r")
await settle(60)
ok("System unsets the field rather than storing an id",
  settings.writes.some((entry) => entry.op === "mutate" && entry.ops?.some((op) => op.op === "unset" && op.path[0] === "locale")),
  "writes: " + JSON.stringify(settings.writes))
ok("System resolves back to the pinned environment locale",
  lastFrame().includes("New session"),
  "last frame:\n" + lastFrame())

Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
if (failed > 0) {
  console.log(failed + " locale-forms check(s) failed")
  process.exit(1)
}
console.log("locale-forms tests passed")
process.exit(0)





