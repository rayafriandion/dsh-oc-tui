// A request's `deadline` must bound the modal wait, and an expiry must be
// reported as `expired` — never as a cancel, and never as a decision.
//
// WHY THIS IS NOT A UNIT TEST
// The arithmetic that decides whether a timer is armed at all is pure and is
// pinned in `tests/std.test.mjs` (`deadlineDelay`). Everything else lives inside
// `apply()`'s closure and is only reachable through the real plugin: that a
// timer is armed, that it closes the modal, that the wait settles with a
// distinct outcome, that the handle maps it to `{ status: 'expired' }`, and that
// a settled modal leaves no live timer behind.
//
// So this file mounts the REAL `lib/index.js` `apply()` through a REAL cordis
// Context and drives the REAL live-TUI handle (`registerLiveTui`), which is
// exactly the object the Presentation handlers forward to. Nothing about the
// request path is stubbed.
//
// Run: node tests/deadline.test.mjs
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"

// The plugin reads the harness home for its session store and settings. Point
// it at a throwaway directory so a test run can never touch the real one.
const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-deadline-"))
process.env.DSH_HOME = smokeHome
process.on("exit", () => {
  try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
})

let failed = 0
// stdout is the fake TTY for the whole run, so results are buffered here and
// flushed to the real stdout at the end (see teardown).
const report = []
const ok = (name, cond, extra = "") => {
  if (cond) report.push("ok   " + name)
  else { failed++; report.push("FAIL " + name + (extra ? "  " + extra : "")) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await sleep(5) }

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

const COLS = 100
const ROWS = 30
const stdin = new FakeIn()
const stdout = new FakeOut(COLS, ROWS)
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")
const realStdout = Object.getOwnPropertyDescriptor(process, "stdout")
Object.defineProperty(process, "stdin", { value: stdin, configurable: true })
Object.defineProperty(process, "stdout", { value: stdout, configurable: true })

// The Screen the renderer believes is on the terminal is the user's screen.
const frames = []
const realPaint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  const rows = []
  for (let y = 0; y < screen.rows; y++) {
    let line = ""
    for (let x = 0; x < screen.cols; x++) {
      const ch = screen.cells[y][x].ch
      line += ch === "" ? "" : ch
    }
    rows.push(line.replace(/\s+$/, ""))
  }
  frames.push(rows.join("\n"))
  return realPaint.call(this, screen)
}
const lastFrame = () => frames.at(-1) ?? ""

// ---- the cordis services the plugin injects -----------------------------
// Cordis keeps the fiber INACTIVE until every injected service exists, so
// without these `apply()` never runs at all.
class AgentsStub extends Service {
  constructor(ctx) { super(ctx, "agents"); this.agents = new Map(); this.rootList = [] }
  get(id) { return this.agents.get(id) }
  roots() { return this.rootList }
  async create({ sessionId, meta }) {
    const agent = {
      id: String(sessionId),
      options: { model: "smoke-model", provider: "smoke-provider" },
      session: { id: String(sessionId), header: { cwd: meta?.cwd ?? process.cwd() }, snapshotEvents: () => [] },
      cancel() {},
      followup() {},
      steer() {},
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

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await sleep(150)

const { liveTui } = await import("../lib/bridge.js")
const handle = liveTui()

ok("the real plugin boots and registers a live TUI handle", handle !== null,
  "liveTui() returned null, so apply() never reached registerLiveTui")

// Open a session through the TUI's own path so the modals paint over a real
// screen rather than the title screen.
stdin.send("x")
stdin.send("\r")
await settle()

const PAST = new Date(Date.now() - 60_000).toISOString()
const future = (ms) => new Date(Date.now() + ms).toISOString()
const base = { requestId: "r", invocationId: "i", origin: "tool:test" }

// ---- 1. A deadline already spent expires at once ------------------------
// No timer is armed and the prompt never flashes on screen: the bound is gone,
// so there is nothing to wait for.
{
  frames.length = 0
  const result = await handle.interact(
    { ...base, kind: "approval", action: "fs.write", summary: "writes a file", deadline: PAST },
    { signal: new AbortController().signal },
  )
  ok("a past deadline expires instead of cancelling", result.status === "expired",
    JSON.stringify(result))
  ok("a past deadline never paints the prompt",
    !lastFrame().includes("Approval · fs.write"), "last frame:\n" + lastFrame())
}

// ---- 2. A live deadline closes the modal without any input --------------
{
  frames.length = 0
  const result = await handle.interact(
    { ...base, kind: "approval", action: "fs.write", summary: "writes a file", deadline: future(80) },
    { signal: new AbortController().signal },
  )
  ok("a live deadline expires when it passes", result.status === "expired", JSON.stringify(result))
  ok("the expired prompt is off screen", !lastFrame().includes("Approval · fs.write"))
  ok("no answer was recorded as a decision", result.value === undefined, JSON.stringify(result))
}

// ---- 3. A cancel is still a cancel, not an expiry -----------------------
// The distinction is the point: an abort means the consumer went away, an
// expiry means the bound passed. Neither is a decision, but a consumer must be
// able to tell them apart.
{
  frames.length = 0
  const controller = new AbortController()
  const pending = handle.interact(
    { ...base, kind: "approval", action: "fs.write", summary: "writes a file", deadline: future(10_000) },
    { signal: controller.signal },
  )
  await settle(4)
  ok("the approval prompt is on screen before the abort",
    lastFrame().includes("Approval · fs.write"), "last frame:\n" + lastFrame())
  controller.abort()
  const result = await pending
  ok("an abort is reported as cancelled, not expired", result.status === "cancelled",
    JSON.stringify(result))
  ok("the aborted prompt is off screen", !lastFrame().includes("Approval · fs.write"))
}

// ---- 4. Answering before the deadline settles once, and the timer dies ---
// A settled modal that left its deadline timer armed would fire into an
// already-settled promise. The observable half is that the first answer stands;
// the timer's absence is read off the active-resource list.
{
  frames.length = 0
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
  const pending = handle.interact(
    { ...base, kind: "approval", action: "fs.write", summary: "writes a file", deadline: future(30_000) },
    { signal: new AbortController().signal },
  )
  await settle(4)
  ok("the approval prompt is on screen before the answer",
    lastFrame().includes("Approval · fs.write"), "last frame:\n" + lastFrame())
  stdin.send("y")
  const result = await pending
  ok("an answered prompt is a submitted decision",
    result.status === "submitted" && result.value?.decision === "approved", JSON.stringify(result))
  await sleep(30)
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
  ok("a settled modal leaves no deadline timer behind", after <= before,
    "Timeout resources before=" + before + " after=" + after)
}

// ---- 5. secret-input and question honour the deadline the same way ------
{
  const secretPast = await handle.interact(
    { ...base, kind: "secret-input", label: "API key", deadline: PAST },
    { signal: new AbortController().signal },
  )
  ok("secret-input with a spent deadline is expired, not cancelled",
    secretPast.status === "expired", JSON.stringify(secretPast))

  const secretLive = await handle.interact(
    { ...base, kind: "secret-input", label: "API key", deadline: future(60) },
    { signal: new AbortController().signal },
  )
  ok("secret-input with a live deadline expires when it passes",
    secretLive.status === "expired", JSON.stringify(secretLive))

  const question = await handle.interact(
    { ...base, kind: "question", fields: [{ id: "f1", kind: "text", label: "Name" }], deadline: future(60) },
    { signal: new AbortController().signal },
  )
  ok("a question with a live deadline expires when it passes",
    question.status === "expired", JSON.stringify(question))
  ok("an expired question submits no answers", question.value === undefined,
    JSON.stringify(question))
}

// ---- teardown -----------------------------------------------------------
Terminal.prototype.paint = realPaint
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
if (failed > 0) {
  console.log(failed + " deadline checks failed")
  process.exit(1)
}
console.log("deadline tests passed")
process.exit(0)
