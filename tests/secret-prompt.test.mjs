// The standalone secret prompt: pasted input must reach the MASKED draft, the
// single-line and length bounds must hold, and a backspace must delete a whole
// code point.
//
// WHY THIS IS NOT A UNIT TEST
// The masking arithmetic and the bounds are pure and are pinned in
// `tests/std.test.mjs` / `tests/render.test.mjs`. What lives only inside
// `apply()`'s closure is the interception itself: `term.on('key')` handles
// `paste` and `clipboard` BEFORE the composer's `mouse`/`paste`/`clipboard`
// early-returns, so while `app.pendingSecret` is set a pasted credential goes
// into the masked draft instead of `app.inputText`. That interception closed a
// real leak — routing the paste through `handlePaste` -> `insert()` put the
// plaintext in the screen buffer AND left it in the input row after the prompt
// closed, where it could be submitted as a chat message.
//
// So this file mounts the REAL `lib/index.js` `apply()` through a REAL cordis
// Context, drives the REAL live-TUI handle (`registerLiveTui`), and feeds raw
// bytes through `lib/term.js`'s decoder — including the bracketed-paste framing
// `ESC[200~ ... ESC[201~` the decoder expects (lib/term.js:223).
//
// Run: node tests/secret-prompt.test.mjs
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { Terminal } from "../lib/term.js"
import { App } from "../lib/ui.js"

// The plugin reads the harness home for its session store and settings. Point
// it at a throwaway directory so a test run can never touch the real one.
const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-secret-"))
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

// A lone UTF-16 surrogate is an invalid string: it masks as one bullet and
// counts as one code point while being unrepresentable.
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

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

// `app` is a const inside apply()'s closure, so the only honest way to read the
// draft and the composer is to take the instance off a render it performs.
// This observes; it does not change what is painted.
let app = null
const realRender = App.prototype.render
App.prototype.render = function (...args) {
  app = this
  return realRender.apply(this, args)
}

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
ok("a real App instance was observed through its own render",
  app !== null, "App.prototype.render was never called")

// Open a session through the TUI's own path so the modals paint over a real
// screen rather than the title screen.
stdin.send("x")
stdin.send("\r")
await settle()
ok("the composer is empty before any secret prompt opens", app?.inputText === "",
  "inputText = " + JSON.stringify(app?.inputText))

const base = { requestId: "r", invocationId: "i", origin: "tool:test" }
// Every request carries a deadline so a regression that stops the prompt
// settling (Enter no longer submitting, say) surfaces as an `expired` FAIL
// instead of hanging the whole suite on an unresolved promise.
const openSecret = (fields) =>
  handle.interact({
    ...base,
    kind: "secret-input",
    label: "API key",
    deadline: new Date(Date.now() + 4000).toISOString(),
    ...fields,
  }, { signal: new AbortController().signal })
// Bracketed paste, exactly as lib/term.js frames it.
const bracketedPaste = (text) => "\x1b[200~" + text + "\x1b[201~"

// ---- 1. A paste while the prompt is open reaches the draft, not the composer
// The leak this guards: handlePaste -> insert() would put the plaintext in
// app.inputText, so it would show in the composer row AND survive the prompt
// closing, where Enter would submit it as a chat message.
{
  frames.length = 0
  const secret = "sk-live-abc123"
  const pending = openSecret({ description: "used for the smoke test" })
  await settle(4)
  ok("the secret prompt is on screen before the paste",
    lastFrame().includes("API key") && lastFrame().includes("Enter to submit · Esc to cancel"),
    "last frame:\n" + lastFrame())
  ok("the prompt is the live pending state",
    app?.pendingSecret !== null && app?.pendingSecret !== undefined)

  stdin.send(bracketedPaste(secret))
  await settle(4)

  ok("the pasted credential reached the masked draft",
    app?.pendingSecret?.draft === secret,
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  ok("the pasted credential did NOT reach the composer",
    app?.inputText === "", "inputText = " + JSON.stringify(app?.inputText))
  ok("the frame shows one bullet per code point",
    lastFrame().includes("•".repeat(secret.length)),
    "last frame:\n" + lastFrame())
  ok("the plaintext is nowhere on screen",
    !lastFrame().includes(secret), "last frame:\n" + lastFrame())

  stdin.send("\r")
  const result = await pending
  ok("Enter submits the pasted secret",
    result.status === "submitted" && result.value?.secret === secret, JSON.stringify(result))
  await settle(2)
  ok("the composer is still empty after the prompt closed",
    app?.inputText === "", "inputText = " + JSON.stringify(app?.inputText))
  ok("the prompt is off screen after submitting",
    !lastFrame().includes("Enter to submit · Esc to cancel"), "last frame:\n" + lastFrame())
}

// ---- 1b. An OSC 52 clipboard reply is dropped, not routed to the composer --
// The guard clears `clipboardRequested`, so an unsolicited reply cannot be
// routed to the composer later either. An empty paste is what arms the
// outstanding-read flag in the unguarded path.
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const leaked = "clipboard-secret"
  const pending = openSecret({})
  await settle(4)
  stdin.send(bracketedPaste(""))                       // empty paste
  stdin.send("\x1b]52;c;" + Buffer.from(leaked, "utf8").toString("base64") + "\x07")
  await settle(4)
  ok("a clipboard reply while the prompt is open is dropped",
    app?.inputText === "", "inputText = " + JSON.stringify(app?.inputText))
  ok("the clipboard plaintext is nowhere on screen",
    !lastFrame().includes(leaked), "last frame:\n" + lastFrame())
  ok("the clipboard reply did not become the secret draft",
    app?.pendingSecret?.draft === "", "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  stdin.send("\x1b")
  const result = await pending
  ok("Esc cancels the secret prompt",
    result.status === "cancelled", JSON.stringify(result))
}

// ---- 2. A multi-line paste is collapsed --------------------------------
// A secret is single-line: a pasted PEM block or a stray CRLF must not become a
// newline inside the value. Newlines are removed, spaces are not.
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const pending = openSecret({})
  await settle(4)
  stdin.send(bracketedPaste("line1\nline2\r\nline3"))
  await settle(4)
  ok("a multi-line paste is collapsed to one line",
    app?.pendingSecret?.draft === "line1line2line3",
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  ok("no newline survived in the draft",
    !/[\r\n]/.test(app?.pendingSecret?.draft ?? ""),
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  ok("the collapsed draft is masked and not echoed",
    lastFrame().includes("•".repeat(15)) && !lastFrame().includes("line1line2line3"),
    "last frame:\n" + lastFrame())
  stdin.send("\x1b")
  const result = await pending
  ok("cancelling after a multi-line paste leaves the composer empty",
    result.status === "cancelled" && app?.inputText === "",
    JSON.stringify(result) + " inputText=" + JSON.stringify(app?.inputText))
}

// ---- 3a. Below the minimum is refused, in range submits ----------------
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const pending = openSecret({ minLength: 4, maxLength: 8 })
  await settle(4)
  stdin.send("ab")
  stdin.send("\r")
  await settle(4)
  ok("a value below minLength keeps the modal open",
    app?.pendingSecret?.draft === "ab" && app?.pendingSecret?.error === "at least 4 characters",
    "draft=" + JSON.stringify(app?.pendingSecret?.draft) + " error=" + JSON.stringify(app?.pendingSecret?.error))
  ok("the minLength error is on screen",
    lastFrame().includes("at least 4 characters"), "last frame:\n" + lastFrame())
  stdin.send("cdef")
  stdin.send("\r")
  const result = await pending
  ok("a value within the bounds submits with that exact value",
    result.status === "submitted" && result.value?.secret === "abcdef", JSON.stringify(result))
}

// ---- 3b. Above the maximum is refused ----------------------------------
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const pending = openSecret({ maxLength: 4 })
  await settle(4)
  stdin.send("abcde")
  stdin.send("\r")
  await settle(4)
  ok("a value above maxLength keeps the modal open",
    app?.pendingSecret?.draft === "abcde" && app?.pendingSecret?.error === "at most 4 characters",
    "draft=" + JSON.stringify(app?.pendingSecret?.draft) + " error=" + JSON.stringify(app?.pendingSecret?.error))
  ok("the maxLength error is on screen",
    lastFrame().includes("at most 4 characters"), "last frame:\n" + lastFrame())
  stdin.send("\x1b")
  const result = await pending
  ok("cancelling an over-long value leaves the composer empty",
    result.status === "cancelled" && app?.inputText === "", JSON.stringify(result))
}

// ---- 3c. The bound is counted in UTF-16 units, as the validator counts --
// validateSecretInputValue compares `result.secret.length`, which is UTF-16
// units (node_modules/@dsh-std/presentation/lib/index.js:410-411). Two emoji are
// 2 code points but 4 UTF-16 units, so maxLength 2 must refuse them: counting
// code points here would submit a value the protocol validator rejects, which
// is a capability failure rather than a clean re-prompt.
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const pending = openSecret({ maxLength: 2 })
  await settle(4)
  stdin.send("\u{1F511}\u{1F511}") // two key emoji
  await settle(2)
  ok("the two-emoji draft is 2 code points but 4 UTF-16 units",
    Array.from(app?.pendingSecret?.draft ?? "").length === 2 && (app?.pendingSecret?.draft ?? "").length === 4,
    "draft=" + JSON.stringify(app?.pendingSecret?.draft))
  stdin.send("\r")
  await settle(4)
  ok("maxLength 2 refuses a two-emoji draft (UTF-16 units, not code points)",
    app?.pendingSecret !== null && app?.pendingSecret !== undefined &&
      app?.pendingSecret?.error === "at most 2 characters",
    "pending=" + (app?.pendingSecret !== null && app?.pendingSecret !== undefined) +
      " error=" + JSON.stringify(app?.pendingSecret?.error))
  ok("the refused draft is still on screen",
    lastFrame().includes("at most 2 characters"), "last frame:\n" + lastFrame())
  stdin.send("\x1b")
  const result = await pending
  ok("cancelling the refused draft leaves the composer empty",
    result.status === "cancelled" && app?.inputText === "", JSON.stringify(result))
}

// ---- 4. Backspace removes a whole code point ---------------------------
// slice(0, -1) over an astral character leaves a lone surrogate: it masks as
// one bullet and counts as one code point while being an invalid string.
{
  frames.length = 0
  app.inputText = "" // isolate this block from any earlier leak
  const pending = openSecret({})
  await settle(4)
  stdin.send("ab\u{1F511}")
  await settle(2)
  ok("the emoji was typed into the draft",
    app?.pendingSecret?.draft === "ab\u{1F511}",
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  stdin.send("\x7f") // backspace
  await settle(2)
  ok("backspace deleted the whole emoji, not one UTF-16 unit",
    app?.pendingSecret?.draft === "ab",
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  ok("the draft is well-formed after backspacing an emoji",
    !hasLoneSurrogate(app?.pendingSecret?.draft ?? ""),
    "draft = " + JSON.stringify(app?.pendingSecret?.draft))
  ok("the masked draft shows two bullets after the backspace",
    lastFrame().includes("•".repeat(2)) && !lastFrame().includes("•".repeat(3)),
    "last frame:\n" + lastFrame())
  stdin.send("\x1b")
  const result = await pending
  ok("cancelling after the backspace leaves the composer empty",
    result.status === "cancelled" && app?.inputText === "", JSON.stringify(result))
}

// ---- teardown -----------------------------------------------------------
Terminal.prototype.paint = realPaint
App.prototype.render = realRender
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
if (failed > 0) {
  console.log(failed + " secret-prompt checks failed")
  process.exit(1)
}
console.log("secret-prompt tests passed")
process.exit(0)
