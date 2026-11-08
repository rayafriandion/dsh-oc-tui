// The refusal path: a dsh this build was not run against gets one page and
// nothing else.
//
// The version is faked honestly rather than by monkey-patching the module:
// `runningDshVersion()` resolves `@deepseek-ai/dsh-app-boot/package.json` from
// the process entry, so this suite writes such a package into a scratch
// directory and points `argv[1]` at it — the same resolution the real boot does,
// answering "0.3.0-rc.1" instead of what is installed here.
//
// What must hold: the page names the running version and the version to install,
// no session is opened, no settings surface is read, ordinary keys are ignored,
// and Esc leaves with a non-zero status. The escape hatch is checked in the
// second half, because a gate nobody can get past on purpose is untestable.
//
// Run: node tests/boot-gate.test.mjs
process.env.DSH_TUI_LOCALE = "en"

import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"

const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-gate-home-"))
const fakeHost = mkdtempSync(join(tmpdir(), "dsh-oc-tui-gate-host-"))
process.env.DSH_HOME = smokeHome
// A host this build has never seen: outside `engines.dsh` as well as outside
// `dshSupport.tested`, so the refusal is unambiguous.
const FAKE_DSH_VERSION = "0.3.0-rc.1"
mkdirSync(join(fakeHost, "node_modules", "@deepseek-ai", "dsh-app-boot"), { recursive: true })
writeFileSync(join(fakeHost, "node_modules", "@deepseek-ai", "dsh-app-boot", "package.json"),
  JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: FAKE_DSH_VERSION }, null, 2))
writeFileSync(join(fakeHost, "main.js"), "// the process entry this run pretends to have\n")
const realEntry = process.argv[1]
process.argv[1] = join(fakeHost, "main.js")

const report = []
let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await sleep(10) }

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
const stdout = new FakeOut(100, 30)
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
  frames.push({ started: this.started, text: rows.join("\n") })
  return realPaint.call(this, screen)
}
const lastFrame = () => frames.at(-1)?.text ?? ""

// `quit` calls the host's own exit when there is one and `process.exit` when
// there is not; recording instead of leaving keeps the assertions in this
// process. Everything is restored before the report is printed.
const exits = []
const realExit = process.exit
process.exit = (code) => { exits.push(code) }

// ---- the services the plugin injects ------------------------------------
const calls = { created: 0, described: 0, mutated: 0 }
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create() { calls.created++; throw new Error("a refused boot must not create a session") }
  async resume() { calls.created++; throw new Error("a refused boot must not resume a session") }
}
class CommandsStub extends Service { constructor(ctx) { super(ctx, "commands") } find() { return undefined } }
class SessionPersistenceStub extends Service { constructor(ctx) { super(ctx, "sessionPersistence") } }
class TuiStartupStub extends Service { constructor(ctx) { super(ctx, "tuiStartup") } }
class SettingsStub extends Service {
  constructor(ctx) {
    super(ctx, "settings")
    this.writable = true
    this.documentPath = join(smokeHome, "settings.json")
  }
  register() {}
  describe() { calls.described++; return [] }
  async mutate() { calls.mutated++ }
}

const ctx = new Context()
new AgentsStub(ctx)
new CommandsStub(ctx)
new SessionPersistenceStub(ctx)
new TuiStartupStub(ctx)
new SettingsStub(ctx)

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await settle()

const refused = lastFrame()
ok("the refused boot paints the gate page", refused.includes("Unsupported dsh version"))
ok("the gate page names the dsh that is running", refused.includes(FAKE_DSH_VERSION))
ok("the gate page names the version to install", refused.includes("npm i -g @deepseek-ai/dsh@"))
ok("the gate page says how to leave", refused.includes("Esc or Ctrl+C exits"))
ok("the refused boot paints no interface", !refused.includes("Ask anything") && !refused.includes("DeepSeek Harness TUI"))
ok("no session was created", calls.created === 0)
// The appearance reads (language, theme, context details) happen before the gate
// because the page is painted in the user's own theme; nothing may be *written*.
ok("the refused boot writes no settings", calls.mutated === 0)
ok("the gate page stays up", frames.length === 1)

// "Cannot do anything else": typing, Enter, Tab and Ctrl+P are all ignored. A
// key that reached the interface would repaint (and, with no settings, would
// have shown a toast); the frame count is what proves nothing happened.
const frameCount = frames.length
for (const key of ["a", "\r", "\t", "\x10"]) stdin.send(key)
await settle(10)
ok("ordinary keys are ignored", frames.length === frameCount)
ok("the refused boot has not exited on its own", exits.length === 0)

// Esc is the way out, and the status is a failure: the profile did not come up.
stdin.send("\x1b")
await settle(10)
ok("Esc leaves the page", exits.length === 1 && exits[0] === 1)
ok("the terminal is released before exiting", frames.every((frame) => frame.started) && !process.stdin.isRaw)

// ---- the escape hatch ----------------------------------------------------
// The same fake host, with the override a maintainer uses for an unreleased
// version: the interface boots instead of the page.
{
  frames.length = 0
  process.env.DSH_TUI_IGNORE_DSH_VERSION = "1"
  const second = new Context()
  new AgentsStub(second)
  new CommandsStub(second)
  new SessionPersistenceStub(second)
  new TuiStartupStub(second)
  new SettingsStub(second)
  await second.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
  await settle()
  const title = lastFrame()
  ok("the override boots the interface", title.includes("Ask anything"))
  ok("the override paints no gate page", !title.includes("Unsupported dsh version"))
  delete process.env.DSH_TUI_IGNORE_DSH_VERSION
  await second.fiber?.dispose?.()
}

// ---- report --------------------------------------------------------------
process.exit = realExit
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
Terminal.prototype.paint = realPaint
process.argv[1] = realEntry
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(fakeHost, { recursive: true, force: true }) } catch { /* best effort */ }

for (const line of report) console.log(line)
console.log("")
if (failed > 0) { console.log(failed + " boot-gate test(s) failed"); process.exitCode = 1 }
else console.log("all boot-gate tests passed")
