// Esc on the `ask_user_question` modal (plan Task 13, item 6).
//
// WHY THIS IS NOT A UNIT TEST
// ---------------------------
// Every other suite drives hand-made objects: `tests/std.test.mjs` mounts the
// live-TUI handle through a stub, and `tests/render.test.mjs` drives an `App`
// directly. None of them can see the two things that matter here:
//
//   * the `next` continuation is bound by CORDIS as the last argument of a
//     waterfall listener. A hand-made context invents that argument, so a
//     listener body that reads it as a free variable looks fine. That is
//     exactly how the pre-fix `ReferenceError: next is not defined` survived
//     review: the modal path needs a real TTY and a real cordis context.
//   * Esc has to arrive as a raw byte through lib/term.js's decoder, on a
//     screen the app actually painted.
//
// So this file mounts the REAL `lib/index.js` `apply()` through a REAL cordis
// Context, registers the REAL `@deepseek-ai/dsh-user-questions`
// UserQuestionService (the same service the `ask_user_question` tool calls),
// and feeds raw ESC bytes into a headless TTY that lib/term.js consumes exactly
// as it consumes a terminal.
//
// It was checked against the pre-fix code: with `askQuestions(req)` and a free
// `next`, the run dies with
//   ReferenceError: next is not defined
//     at onDefer (lib/index.js:1242)
//     at Object.defer (lib/index.js:1159)
//     at handleQuestionKey (lib/index.js:1403)
// so this file genuinely discriminates the bug rather than passing vacuously.
//
// Run: node tests/esc-questions.test.mjs
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Service } from "@deepseek-ai/cordis"
import { UserQuestionService } from "@deepseek-ai/dsh-user-questions"
import { Terminal } from "../lib/term.js"

// The plugin reads the harness home for its session store and settings. Point
// it at a throwaway directory so a test run can never touch the real one.
const smokeHome = mkdtempSync(join(tmpdir(), "dsh-oc-tui-esc-"))
process.env.DSH_HOME = smokeHome
// The teardown below removes it, but a failed assertion can throw past that;
// this makes cleanup unconditional.
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
// Let the promise chain unwind: waterfall -> defer -> next() -> service catch.
const settle = async (rounds = 60) => { for (let i = 0; i < rounds; i++) await sleep(5) }

// ---- headless TTY -------------------------------------------------------
// A stdin/stdout pair good enough for lib/term.js: isTTY true, raw-mode
// bookkeeping, data events, and a captured write stream. Kept below the
// startup update check's 2s timer so the run stays offline and deterministic.
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

// Capture every frame the app paints. The Screen is what the renderer believes
// is on the terminal, so reading its cells is reading the user's screen.
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
// `lib/index.js` declares inject: agents, commands, sessionPersistence,
// tuiStartup. Cordis keeps a fiber INACTIVE until every injected service
// exists, so without these `apply()` never runs at all — which is the other
// reason a plain-object context cannot exercise this path.
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
new UserQuestionService(ctx)

const tui = await import("../lib/index.js")
await ctx.plugin({ apply: tui.apply, inject: tui.inject, name: tui.name }, {})
await sleep(150)

ok("the real plugin boots against a real cordis context (apply ran)",
  stdout.chunks.length > 0, "no terminal output was produced")
ok("the terminal entered raw mode and the alternate screen",
  stdout.chunks.join("").includes("\x1b[?1049h") && stdin.rawMode === true)

// Open a session through the TUI's own path, so `currentAgent` is the exact
// live instance the service demands. Typing + Enter goes through the real key
// decoder and the real composer submit.
stdin.send("x")
stdin.send("\r")
await settle()
ok("typing + Enter opened a session, so currentAgent is live",
  ctx.get("agents").roots().length === 1)

const question = {
  id: "q1",
  question: "Proceed with the smoke test?",
  header: "Smoke",
  options: [{ label: "yes (Recommended)" }, { label: "no" }],
}
const ask = (id) => ctx.get("userQuestions").ask({
  questions: [{ ...question, id }],
  agent: ctx.get("agents").roots()[0],
  signal: new AbortController().signal,
})

// ---- 1. Esc with no other answerer --------------------------------------
// Pre-fix this hung forever: `settled` was set and the modal was detached, but
// the promise never settled. Now it must delegate into the waterfall, which
// with no other answerer rejects NO_PROVIDER — the honest result.
frames.length = 0
let outcome = null
void ask("q1")
  .then((value) => { outcome = { resolved: value } })
  .catch((error) => { outcome = { rejected: error } })

await settle(20)
ok("the question modal is on screen before Esc",
  lastFrame().includes("Proceed with the smoke test?") && lastFrame().includes("Esc defer"),
  "last frame:\n" + lastFrame())
ok("the modal rendered its options",
  lastFrame().includes("yes (Recommended)") && lastFrame().includes("no"))

stdin.send("\x1b") // the real thing: one raw ESC byte
await settle()

ok("Esc did NOT hang the tool call (the promise settled)", outcome !== null,
  "still pending after the settle loop")
ok("Esc delegated to the waterfall, which had no other answerer, so it rejected",
  outcome?.rejected !== undefined,
  "outcome = " + JSON.stringify(outcome?.resolved ?? String(outcome?.rejected)))
ok("the rejection is the service's honest NO_PROVIDER, not a ReferenceError",
  outcome?.rejected?.code === "NO_PROVIDER",
  "code = " + String(outcome?.rejected?.code) + " message = " + String(outcome?.rejected?.message))
ok("no ReferenceError escaped anywhere",
  !String(outcome?.rejected?.message ?? "").includes("is not defined"))
ok("the modal closed after Esc",
  !lastFrame().includes("Proceed with the smoke test?") && !lastFrame().includes("Esc defer"),
  "last frame:\n" + lastFrame())

// ---- 2. Esc delegates to the next answerer ------------------------------
// This is the behaviour the original comment always claimed and the fix
// restored: the next answerer's answer is what the tool call receives.
frames.length = 0
let delegateSaw = null
const delegate = ctx.on("user-questions/request", (request) => {
  delegateSaw = request
  return { answers: [{ id: "q2", selected: ["delegated-by-the-next-answerer"] }] }
}, { global: true })

let outcomeB = null
void ask("q2")
  .then((value) => { outcomeB = { resolved: value } })
  .catch((error) => { outcomeB = { rejected: error } })

await settle(20)
ok("delegation: the modal is on screen before Esc", lastFrame().includes("Proceed with the smoke test?"))
stdin.send("\x1b")
await settle()

ok("delegation: Esc reached the next answerer rather than cancelling",
  delegateSaw?.questions?.[0]?.id === "q2",
  "the delegate saw " + JSON.stringify(delegateSaw?.questions?.map((q) => q.id)))
ok("delegation: the delegated answer is what the tool call received",
  outcomeB?.resolved?.answers?.[0]?.selected?.[0] === "delegated-by-the-next-answerer",
  "outcome = " + JSON.stringify(outcomeB?.resolved ?? String(outcomeB?.rejected)))
ok("delegation: the modal closed", !lastFrame().includes("Esc defer"))
delegate()

// ---- 3. Answering normally still works ----------------------------------
// The defer path shares its whole body with the happy path, so this guards the
// extraction in Task 7 that introduced the bug in the first place.
frames.length = 0
let outcomeC = null
void ask("q3")
  .then((value) => { outcomeC = { resolved: value } })
  .catch((error) => { outcomeC = { rejected: error } })

await settle(20)
ok("answering: the modal is on screen", lastFrame().includes("Proceed with the smoke test?"))
stdin.send("\r") // Enter accepts the highlighted option
await settle()

ok("answering: Enter resolves the tool call with the answer",
  outcomeC?.resolved?.answers?.[0]?.id === "q3",
  "outcome = " + JSON.stringify(outcomeC?.resolved ?? String(outcomeC?.rejected)))
ok("answering: the chosen option was carried through",
  outcomeC?.resolved?.answers?.[0]?.selected?.[0] === "yes (Recommended)",
  "answers = " + JSON.stringify(outcomeC?.resolved?.answers))
ok("answering: the modal closed", !lastFrame().includes("Esc defer"))

// ---- teardown -----------------------------------------------------------
// Restore the real streams before reporting: every check above was buffered
// because stdout was the fake TTY.
Terminal.prototype.paint = realPaint
Object.defineProperty(process, "stdin", realStdin)
Object.defineProperty(process, "stdout", realStdout)
console.log(report.join("\n"))
console.log("")
try { rmSync(smokeHome, { recursive: true, force: true }) } catch { /* best effort */ }
// The live plugin owns a paint interval and a TTY, so the loop would otherwise
// stay alive; every other suite in this repo exits explicitly for the same
// reason.
if (failed > 0) {
  console.log(failed + " esc-questions checks failed")
  process.exit(1)
}
console.log("esc-questions tests passed")
process.exit(0)
