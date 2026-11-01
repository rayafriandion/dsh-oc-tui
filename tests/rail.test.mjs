// Right status rail tests.
//
// The rail is the wide-window column that carries the expanded status figures
// (model, thinking, context), the session's goal, and the subagent tree. These
// tests pin the layout boundary (narrow windows keep the single-column
// layout), the sections' content, the rail's own scrolling, and the key
// decoding the rail's Shift+Up/Down binding depends on.
import { App, THEME } from "../lib/ui.js"
import { Screen, makeStyle } from "../lib/term.js"
import { paintSplashOpenCode } from "../lib/splash-opencode.js"
import { decodeKey } from "../lib/term.js"

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}

const newApp = (cols, rows) => new App({ cols, rows, on() {} })

// Text of one row between x0 (inclusive) and x1 (exclusive).
const rowText = (screen, y, x0 = 0, x1 = screen.cols) =>
  screen.cells[y].slice(x0, x1).map((c) => c.ch).join("")

// First row containing `needle` between x0 and x1, or -1.
const findRow = (screen, needle, x0 = 0, x1 = screen.cols) => {
  for (let y = 0; y < screen.rows; y++) {
    if (rowText(screen, y, x0, x1).includes(needle)) return y
  }
  return -1
}

// A standard populated wide-window app: session open, model known, versions
// set, effort slider loaded, context meter fed.
function wideApp(cols = 150, rows = 40, { titleScreen = false } = {}) {
  const app = newApp(cols, rows)
  app.versions = { tui: "0.2.0-pre.4", dsh: "0.2.0-rc.1" }
  app.workingDirectory = "D:\\Projects\\DeepSeekHarnessPlugins"
  if (!titleScreen) {
    app.setSession({ id: "s1", title: "Ship the status rail", model: "deepseek-v4-flash", provider: "deepseek" })
    app.setWorkspace({ workingDirectory: "D:\\Projects\\DeepSeekHarnessPlugins", gitBranch: "feature/chafa+" })
  } else {
    app.setWelcome({ workingDirectory: "D:\\Projects\\DeepSeekHarnessPlugins", model: "deepseek-v4-flash", provider: "deepseek" })
  }
  app.setEffortSlider({ levels: [{ id: "off", name: "off" }, { id: "max", name: "max" }], current: "max" })
  app.setContextMeter({ pressure: { projectedTokens: 32000, contextWindow: 128000 }, breakdown: { systemTokens: 4000, toolsTokens: 8000, messageTokens: 20000 } })
  app.setMetrics({ steps: 3, turns: 2, billedInputTokens: 12000, outputTokens: 3000, cacheHitRate: 82 })
  return app
}

// ---- narrow windows keep the single-column layout ---------------------------
{
  const app = newApp(100, 30)
  app.setSession({ id: "s", title: "T", model: "deepseek-v4-flash", provider: "deepseek" })
  const screen = app.render()
  const layout = app._layout()
  ok("narrow window: railW is 0", layout.railW === 0 && layout.borderX === 100)
  ok("narrow window: model stays on the status row", rowText(screen, screen.rows - 1).includes("deepseek-v4-flash"))
  ok("narrow window: no MODEL section anywhere", findRow(screen, "MODEL") === -1)
  // The threshold clears the 120-column default many terminals open at: one
  // column below it there is no rail, on it there is.
  ok("boundary: 139 columns keep the single-column layout", newApp(139, 30)._layout().railW === 0)
  ok("boundary: 140 columns open the rail", newApp(140, 30)._layout().railW === 34)
}

// ---- wide window: rail geometry and sections --------------------------------
{
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS)
  const screen = app.render()
  const layout = app._layout()
  const borderX = COLS - 35
  ok("wide window: railW is 34 and borderX matches", layout.railW === 34 && layout.borderX === borderX)
  ok("wide window: border column drawn", findRow(screen, "│", borderX, borderX + 1) >= 0)
  const rail = (needle) => findRow(screen, needle, borderX + 1, COLS)
  ok("wide window: session title pinned at rail top", rail("Ship the status rail") >= 0)
  ok("wide window: MODEL section present", rail("MODEL") >= 0)
  ok("wide window: model named in rail", rail("deepseek-v4-flash") >= 0)
  ok("wide window: provider named in rail", rail("deepseek") >= 0)
  ok("wide window: THINKING section shows the level", rail("THINKING") >= 0 && rail("max") >= 0)
  ok("wide window: THINKING range line", rail("off → max") >= 0)
  ok("wide window: CONTEXT section shows percent", rail("CONTEXT") >= 0 && rail("25% used") >= 0)
  ok("wide window: context occupancy figures", rail("~32K / 128K tokens") >= 0)
  ok("wide window: context breakdown line", rail("system 4K · tools 8K") >= 0 && rail("20K") >= 0)
  ok("wide window: billed tokens line", rail("in 12K · out 3K") >= 0)
  ok("wide window: cache hit line", rail("cache 82% hit") >= 0)
  ok("wide window: SESSION section shows counts", rail("SESSION") >= 0 && rail("2 turns · 3 steps") >= 0)
  ok("wide window: header names the workspace", rowText(screen, 0, 0, COLS).includes("DeepSeekHarnessPlugins"))
  ok("wide window: rail footer does not repeat the workspace", rail("DeepSeekHarnessPlugins") === -1)
  ok("wide window: header names the branch", rowText(screen, 0, 0, COLS).includes("git: feature/chafa+"))
  ok("wide window: footer names both builds", rail("dsh 0.2.0-rc.1 · tui 0.2.0-pre.4") >= 0)
  ok("wide window: model absent from the header", !rowText(screen, 0, 0, COLS).includes("deepseek-v4-flash"))
  ok("wide window: model absent from the status row", !rowText(screen, ROWS - 1).includes("deepseek-v4-flash"))
  ok("wide window: meter absent from the status row", !rowText(screen, ROWS - 1).includes("ctx"))
  ok("wide window: shortcut hint on the status row", rowText(screen, ROWS - 1).includes("ctrl+p commands"))
  ok("wide window: composer label drops the model", !rowText(screen, layout.transcriptBottom).includes("deepseek · deepseek-v4-flash"))
}

// ---- title screen: rail exists without a session ----------------------------
{
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS, { titleScreen: true })
  app.setContextMeter(null)
  const screen = app.render()
  const borderX = COLS - 35
  ok("title screen: MODEL section present", findRow(screen, "MODEL", borderX + 1, COLS) >= 0)
  ok("title screen: context without usage says so", findRow(screen, "shown once usage is reported", borderX + 1, COLS) >= 0)
  ok("title screen: splash brand stays inside the main area", (() => {
    const brandY = findRow(screen, "DeepSeek Harness".slice(0, 8), 0, borderX)
    if (brandY < 0) return false
    const line = rowText(screen, brandY, 0, borderX)
    // The gradient text renders rune by rune; the tail of the brand must end
    // before the rail border.
    return line.indexOf("DeepSeek Harness") >= 0 || line.includes("DeepSeek") 
  })())
}

// ---- goal + subagent sections ------------------------------------------------
{
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS)
  app.setGoal({ goal: { id: "g1", objective: "Finish the status rail", phase: "active", maxGoalRounds: 256, revision: 1 }, roundsStarted: 2, createdAt: 1, updatedAt: 2 })
  app.setSubagents([
    { kind: "child", id: "aaaaaaaa-1", label: "explorer", mode: "one-shot", activity: "running", depth: 1 },
    { kind: "child", id: "bbbbbbbb-2", label: "writer", mode: "continuable", activity: "idle", depth: 2 },
    { kind: "diagnostic", id: "cccccccc-3", reason: "corrupt" },
  ])
  const screen = app.render()
  const rail = (needle) => findRow(screen, needle, COLS - 34, COLS)
  ok("goal: section header", rail("GOAL") >= 0)
  ok("goal: objective wrapped into the rail", rail("Finish the status rail") >= 0)
  ok("goal: phase and rounds", rail("active · round 2/256") >= 0)
  ok("subagents: section header", rail("SUBAGENTS") >= 0)
  ok("subagents: running/total summary", rail("1 running · 3 total") >= 0)
  ok("subagents: running row marked", rail("● explorer") >= 0)
  ok("subagents: depth tag", rail("writer L2") >= 0)
  ok("subagents: diagnostic row readable", rail("(unreadable)") >= 0)

  app.setGoal(null)
  const after = app.render()
  ok("goal cleared: section drops out", findRow(after, "GOAL", COLS - 34, COLS) === -1)
}

// ---- blocked goal renders its reason -----------------------------------------
{
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS)
  app.setGoal({ goal: { objective: "Deploy", phase: "blocked", blockedReason: { code: "needs-input", message: "waiting for credentials" }, maxGoalRounds: 16 }, roundsStarted: 4 })
  const screen = app.render()
  const rail = (needle) => findRow(screen, needle, COLS - 34, COLS)
  ok("blocked goal: phase named", rail("blocked · round 4/16") >= 0)
  ok("blocked goal: reason shown", rail("waiting for credentials") >= 0)
}

// ---- rail scrolling -----------------------------------------------------------
{
  const COLS = 150, ROWS = 24
  const app = wideApp(COLS, ROWS)
  const subs = []
  for (let i = 0; i < 30; i++) {
    subs.push({ kind: "child", id: "id-" + i, label: "subagent-" + i, mode: "one-shot", activity: i < 2 ? "running" : "idle", depth: 1 })
  }
  app.setSubagents(subs)
  const first = app.render()
  const borderX = COLS - 35
  const railTop = first.cursorY >= 0 ? app._layout().headerH : 1
  ok("scroll: overflow produces a scrollbar thumb", findRow(first, "┃", COLS - 1, COLS) >= 0)
  const before = rowText(first, railTop + 2, borderX + 1, COLS)
  app.scrollRail(5)
  const scrolled = app.render()
  ok("scroll: content window moved", rowText(scrolled, railTop + 2, borderX + 1, COLS) !== before)
  ok("scroll: offset landed at 5", app.railScroll === 5)
  app.scrollRail(100000)
  const clamped = app.render()
  ok("scroll: clamped to the content", app.railScroll > 0 && app.railScroll < 100000)
  // The list caps at 10 rows, so the deepest rendered row is subagent-9 and
  // the tail count names the rest.
  ok("scroll: bottom row shows the list tail", findRow(clamped, "subagent-9", borderX + 1, COLS) >= 0 && findRow(clamped, "+20 more", borderX + 1, COLS) >= 0)
  // Shrinking content re-clamps on the next render instead of pinning the
  // window past the end. The visible height: the rail spans headerH..rows-2,
  // minus the one-row title, its blank separator, and the one footer row.
  app.setSubagents(subs.slice(0, 3))
  const total = app._railLines(app._layout().railW - 2).length
  const headerH = app._layout().headerH
  app.render()
  ok("scroll: shrink re-clamps the offset", app.railScroll === Math.max(0, total - (ROWS - 3 - headerH - 1)))
}

// ---- the rail never leaves the main area unpainted ---------------------------
{
  // Every cell right of the border column belongs to the rail (panel
  // background), and every cell left of it belongs to the main area — the
  // transcript tail fill must stop at the border, not under the rail.
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS)
  app.addUser("hello")
  const screen = app.render()
  const borderX = COLS - 35
  const railTop = app._layout().headerH
  let railBgHoles = 0
  let mainUnderRail = 0
  for (let y = railTop; y < ROWS - 1; y++) {
    for (let x = borderX + 1; x < COLS; x++) {
      if (screen.cells[y][x].style?.bg !== THEME.backgroundPanel) railBgHoles++
    }
  }
  for (let y = railTop; y < ROWS - 1; y++) {
    const cell = screen.cells[y][borderX]
    if (cell.ch !== "│" && cell.ch !== "") mainUnderRail++
  }
  ok("rail cells all carry the panel background", railBgHoles === 0, "holes=" + railBgHoles)
  ok("rail border column is the border", mainUnderRail === 0, "stray=" + mainUnderRail)
}

// ---- splash centers in the main area ------------------------------------------
{
  const COLS = 150, ROWS = 24
  const screen = new Screen(COLS, ROWS)
  screen.clear(makeStyle({ bg: THEME.background }))
  paintSplashOpenCode(screen, COLS, ROWS, THEME, {}, ROWS - 1, { x0: 0, width: 95 })
  let first = -1
  let last = -1
  for (let x = 0; x < COLS; x++) {
    if (screen.cells[8][x].ch !== " ") { if (first < 0) first = x; last = x }
  }
  ok("splash: brand centered inside the band, not the screen", first >= 0 && first < 95 && Math.abs((first + last) / 2 - 47) <= 2, "span=" + first + ".." + last)
}

// ---- key decoding: modifier flags on arrows -----------------------------------
{
  const plain = decodeKey(Buffer.from("\x1b[A", "latin1"))
  ok("decode: plain up has no flags", plain.key.name === "up" && !plain.key.shift && !plain.key.ctrl)
  const shifted = decodeKey(Buffer.from("\x1b[1;2A", "latin1"))
  ok("decode: shift+up", shifted.key.name === "up" && shifted.key.shift === true)
  const ctrled = decodeKey(Buffer.from("\x1b[1;5B", "latin1"))
  ok("decode: ctrl+down", ctrled.key.name === "down" && ctrled.key.ctrl === true)
  const alted = decodeKey(Buffer.from("\x1b[1;3C", "latin1"))
  ok("decode: alt+right", alted.key.name === "right" && alted.key.alt === true)
}

// ---- hit regions: rail wheel target and context click --------------------------
{
  const COLS = 150, ROWS = 40
  const app = wideApp(COLS, ROWS)
  app.render()
  const borderX = COLS - 35
  const railTop = app._layout().headerH
  const railHit = app.hitTest(borderX + 5, railTop + 3, ["rail"])
  ok("hit: rail is a wheel target", railHit?.kind === "rail")
  const contextHit = app.hitTest(borderX + 5, railTop + 10, ["stats"])
  ok("hit: context section opens the stats window", contextHit?.kind === "stats")
  const transcriptHit = app.hitTest(20, railTop + 3, ["transcript"])
  ok("hit: transcript stops at the border", transcriptHit?.kind === "transcript" && transcriptHit.x + transcriptHit.width <= borderX)
}

console.log(failed === 0 ? "\nall rail tests passed" : "\n" + failed + " rail test(s) failed")
process.exit(failed === 0 ? 0 : 1)
