// Terminal-boundary rendering tests.
//
// The TUI paints by diffing against its own record of the screen, so any frame
// that disagrees with what the terminal actually ends up displaying leaves text
// behind that the renderer never repaints (it believes those cells are correct).
// These tests drive a real App through the state changes that hit that boundary
// and compare an emulated terminal against the frame the app just produced.
import { Terminal } from "../lib/term.js"
import { App, THEME } from "../lib/ui.js"
import { runeWidth } from "../lib/util.js"

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}

function paintCapture(cols, rows) {
  const writes = []
  const output = { columns: cols, rows, isTTY: true, write(s) { writes.push(s); return true }, on() {}, off() {} }
  const term = new Terminal({ input: { isTTY: false, on() {}, off() {}, setRawMode() {}, resume() {}, pause() {} }, output })
  return { term, writes }
}

// Apply a paint stream to a grid the way a terminal does: cursor addressing,
// erases, SGR skipped, and the renderer's own convention of emitting exactly
// `cols` columns per row.
function emulatePaint(writes, cols, rows) {
  const grid = []
  for (let y = 0; y < rows; y++) grid.push(new Array(cols).fill(" "))
  let x = 0, y = 0, pendingWrap = false
  for (const text of writes) {
    for (let i = 0; i < text.length;) {
      const ch = text[i]
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z@`])/.exec(text.slice(i))
        if (m) {
          const nums = m[1].replace(/[?>!]/g, "").split(";").filter((s) => s !== "").map(Number)
          if (m[2] === "H") { y = Math.min(rows - 1, Math.max(0, (nums[0] || 1) - 1)); x = Math.min(cols - 1, Math.max(0, (nums[1] || 1) - 1)); pendingWrap = false }
          i += m[0].length
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text.slice(i))
        if (osc) { i += osc[0].length; continue }
        i += 2
        continue
      }
      if (ch === "\r") { x = 0; pendingWrap = false; i++; continue }
      if (ch === "\n") { y = Math.min(rows - 1, y + 1); pendingWrap = false; i++; continue }
      const rune = String.fromCodePoint(text.codePointAt(i))
      const w = runeWidth(rune)
      if (pendingWrap) { x = 0; y = Math.min(rows - 1, y + 1); pendingWrap = false }
      if (w === 0) { if (x > 0) grid[y][x - 1] += rune; i += rune.length; continue }
      grid[y][x] = rune
      if (w === 2 && x + 1 < cols) grid[y][x + 1] = ""
      if (x + w >= cols) { x = cols - 1; pendingWrap = true } else x += w
      i += rune.length
    }
  }
  return grid
}

function gridDiff(grid, screen, cols, rows) {
  const bad = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const want = screen.cells[y][x].ch
      if (want === "") continue
      if (grid[y][x] !== want) bad.push({ y, x, want, got: grid[y][x] })
    }
  }
  return bad
}

// Column width of every row emission, delimited by the cursor address that
// starts each one.
function rowWidths(writes) {
  const rows = []
  let cur = null
  for (const text of writes) {
    for (let i = 0; i < text.length;) {
      const ch = text[i]
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z@`])/.exec(text.slice(i))
        if (m) {
          if (m[2] === "H") {
            if (cur) rows.push(cur)
            const nums = m[1].replace(/[?>!]/g, "").split(";").filter((s) => s !== "").map(Number)
            cur = { row: (nums[0] || 1) - 1, cols: 0 }
          }
          i += m[0].length
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text.slice(i))
        if (osc) { i += osc[0].length; continue }
        i += 2
        continue
      }
      if (ch === "\r" || ch === "\n") { i++; continue }
      const rune = String.fromCodePoint(text.codePointAt(i))
      if (cur) cur.cols += runeWidth(rune)
      i += rune.length
    }
  }
  if (cur) rows.push(cur)
  return rows
}

// ---- composer state changes ------------------------------------------------
// Every composer edit changes which row holds what; a frame that leaves the old
// text in place strands it inside the composer, where nothing repaints it until
// a click or resize.
{
  const COLS = 100, ROWS = 30
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Session" })
  const { term, writes } = paintCapture(COLS, ROWS)
  const steps = [
    ["long single-line value", "node pty-render-diff.cjs 2>&1 | Select-Object"],
    ["pasted two-line value", "node pty-render-diff.cjs 2>&1 | Select-Object\nnode p"],
    ["short tail", "node p\u2026"],
    ["cleared composer", ""],
    ["wide-rune value", "现在dsh更新到0.1.5-rc.1，检查一"],
    ["ascii after wide runes", "abcdefghij"],
  ]
  for (const [label, value] of steps) {
    app.inputText = value
    app.inputCursor = value.length
    const screen = app.render()
    term.paint(screen)
    const bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
    ok("composer edit leaves no residue: " + label, bad.length === 0, JSON.stringify(bad.slice(0, 6)))
  }
}

// Narrow widths where a wide rune lands on the last column, replaced by ASCII.
for (const COLS of [40, 46, 60]) {
  const ROWS = 30
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "X" })
  app.inputText = "现在这个渲染还是有问题，见图中红框框住的位置"
  app.inputCursor = app.inputText.length
  term.paint(app.render())
  app.inputText = "node p"
  app.inputCursor = 6
  const screen = app.render()
  term.paint(screen)
  const bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("narrow width " + COLS + " wide-rune row cleared by ASCII edit", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
}

// ---- active streaming ------------------------------------------------------
// A transcript block that is mid-stream may reuse lines rendered up to 120 ms
// ago, including at a previous width. The frame must still match the terminal.
{
  const COLS = 100, ROWS = 30
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Streaming" })
  app.setStatus("running")
  const live = { kind: "assistant", text: "partial output", streaming: true, rev: 1 }
  app.blocks.push(live)
  let screen = app.render(); term.paint(screen)
  ok("streaming baseline leaves no residue", gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  app.inputText = "node pty-render-diff.cjs 2>&1 | Select-Object"
  app.inputCursor = app.inputText.length
  screen = app.render(); term.paint(screen)
  let bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("composer edit during streaming leaves no residue", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
  live.text = "partial output that grew"
  live.rev = 2
  app.inputText = "x"
  app.inputCursor = 1
  screen = app.render(); term.paint(screen)
  bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("shrinking the composer during streaming leaves no residue", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
}

// ---- row width -------------------------------------------------------------
// Each painted row must occupy exactly `cols` columns. A wider row makes the
// terminal wrap, shifting the frame and stranding the previous text.
for (const [COLS, ROWS] of [[40, 30], [80, 24], [100, 30], [140, 42]]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "现在dsh更新到0.1.5-rc.1，检查一" })
  app.addNote("一个足够长的系统提示行，包含中文与 ascii 混排内容，用来占满整行宽度", "system-reminder")
  app.inputText = "node pty-render-diff.cjs 2>&1 | Select-Object --a-very-long-argument-tail 中文尾巴"
  app.inputCursor = app.inputText.length
  term.paint(app.render())
  app.inputText = "x"
  app.inputCursor = 1
  term.paint(app.render())
  const widths = rowWidths(writes).filter((r) => r.cols !== 0)
  const wrong = widths.filter((r) => r.cols !== COLS)
  ok("every painted row is exactly " + COLS + " columns", wrong.length === 0, JSON.stringify(wrong.slice(0, 5)))
}

// Rewind overlay open/close must not strand picker cells in the transcript.
{
  const COLS = 80, ROWS = 24
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Rewind" })
  app.openRewind({
    items: [
      { n: 1, seq: 0, time: Date.now(), label: "1. first prompt" },
      { n: 2, seq: null, label: "(current)", current: true },
    ],
    restoreOptions: [
      { id: "both", label: "Restore conversation and files" },
      { id: "cancel", label: "Cancel" },
    ],
  })
  let screen = app.render(); term.paint(screen)
  ok("rewind overlay leaves no residue", gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  app.moveRewind(-1)
  screen = app.render(); term.paint(screen)
  ok("rewind overlay move leaves no residue", gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  app.closeRewind()
  screen = app.render(); term.paint(screen)
  ok("closing rewind overlay leaves no residue", gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}

// The workspace row names the path a live session is rooted in. A long path must
// be shortened without breaking the row's width budget or leaving residue, and a
// wide-rune path must be clipped by cells rather than by code units.
for (const [COLS, ROWS, cwd, branch] of [
  [140, 42, "D:\\Projects\\DeepSeekHarnessPlugins", "main"],
  [100, 30, "D:\\Projects\\DeepSeekHarnessPlugins\\deepseek-harness-tui", "feat/rewind"],
  [80, 24, "D:\\Projects\\DeepSeekHarnessPlugins\\deepseek-harness-tui", ""],
  [60, 20, "C:\\Users\\Sanchess\\AppData\\Local\\Temp\\a-very-long-scratch-directory-name", "feature/very-long-branch-name"],
  [40, 24, "D:\\项目\\一个非常长的中文工作区目录名字", "main"],
  [40, 24, "D:\\Projects\\x", ""],
  [80, 18, "D:\\Projects\\deepseek-harness-tui", "main"],
]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Workspace row" })
  app.setWorkspace({ workingDirectory: cwd, gitBranch: branch })
  const screen = app.render(); term.paint(screen)
  const diff = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok(`${COLS}x${ROWS} workspace row no residue`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
  const wrong = rowWidths(writes).filter((r) => r.cols !== 0 && r.cols !== COLS)
  ok(`${COLS}x${ROWS} workspace row keeps ${COLS} columns`, wrong.length === 0, JSON.stringify(wrong.slice(0, 3)))
  const rows = screen.cells.map((row) => row.map((c) => c.ch).join(""))
  const painted = rows.some((row) => row.includes(cwd))
  if (ROWS >= 20) {
    ok(`${COLS}x${ROWS} workspace row shows the path`, painted || rows.some((row) => row.includes("WORKSPACE")),
      JSON.stringify(rows[1].slice(0, COLS)))
    // The strip has a tone of its own: not the brand bar above, not the page below.
    const barBg = screen.cells[1][2].style?.bg
    ok(`${COLS}x${ROWS} workspace strip has its own background`,
      barBg === THEME.workspaceBar && barBg !== THEME.backgroundPanel && barBg !== THEME.background,
      String(barBg))
  }
}

// Nothing to name (title screen, or a path with no room) keeps the page tone, so
// the strip never shows up as an unexplained empty band.
{
  const app = new App({ cols: 80, rows: 24, on() {} })
  app.setWelcome({ workingDirectory: "D:\\Projects\\x", gitBranch: "main" })
  ok("title screen keeps the page background on the workspace row",
    app.render().cells[1][2].style?.bg === THEME.background)
  const narrow = new App({ cols: 20, rows: 24, on() {} })
  narrow.setSession({ id: "s", title: "narrow" })
  narrow.setWorkspace({ workingDirectory: "D:\\Projects\\a-very-long-workspace-name", gitBranch: "" })
  ok("a path with no room leaves the row untinted",
    narrow.render().cells[1][2].style?.bg === THEME.background)
}

// ---- session stats strip and window ----------------------------------------
// The strip takes a transcript row and the window repaints over the frame; both
// must leave the terminal exactly as the painter believes it is, at every width.
for (const [COLS, ROWS] of [[130, 45], [100, 30], [80, 24], [60, 20], [46, 16]]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Stats", model: "m" })
  // A session with figures: counts, durations, speeds, cache and billed tokens.
  app.setStats({
    stats: {
      turns: 2, steps: 5, llmMs: 12_340, toolMs: 1_200,
      ttftMs: 1_800, ttftSteps: 3, decodeMs: 5_000, decodeTokens: 120,
      uncachedInputTokens: 1_800, outputTokens: 12_400, cacheReadTokens: 118_000, cacheWriteTokens: 200,
      billedInputTokens: 120_000, ttftAverageMs: 600, tokensPerSecond: 24, cacheHitRate: "98",
    },
    pressure: { projectedTokens: 32_000, contextWindow: 128_000 },
    breakdown: { systemTokens: 1_100, toolsTokens: 6_800, messageTokens: 24_100 },
  })
  let screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} stats strip leaves no residue`, gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  const stripRow = screen.cells.findIndex((row) => row.some((c) => c.ch === "▤"))
  ok(`${COLS}x${ROWS} stats strip is one row above the composer`, stripRow > 0)
  app.statsOpen = true
  screen = app.render(); term.paint(screen)
  const diff = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok(`${COLS}x${ROWS} stats window leaves no residue`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
  const rows = screen.cells.map((r) => r.map((c) => c.ch).join("")).join("\n")
  ok(`${COLS}x${ROWS} stats window keeps its box inside the screen`,
    rows.includes("session stats") && screen.cells.length === ROWS)
  app.statsOpen = false
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} closing the stats window leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}

console.log("")
if (failed > 0) { console.log(failed + " render test(s) failed"); process.exit(1) }
console.log("all render tests passed")
