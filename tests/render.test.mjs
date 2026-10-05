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

// The header's right end names the workspace a live session is rooted in, with
// the git branch beside it. A long path must be shortened without breaking the
// row's width budget or leaving residue, and a wide-rune path must be clipped
// by cells rather than by code units.
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
  app.setSession({ id: "s", title: "Workspace row", model: "test-model-9" })
  app.setWorkspace({ workingDirectory: cwd, gitBranch: branch })
  const screen = app.render(); term.paint(screen)
  const diff = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok(`${COLS}x${ROWS} header no residue`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
  const wrong = rowWidths(writes).filter((r) => r.cols !== 0 && r.cols !== COLS)
  ok(`${COLS}x${ROWS} header keeps ${COLS} columns`, wrong.length === 0, JSON.stringify(wrong.slice(0, 3)))
  const row0 = screen.cells[0].map((c) => c.ch).join("")
  // The model lives on the status row / rail MODEL section, never in the header.
  ok(`${COLS}x${ROWS} header carries no model`, !row0.includes("test-model-9"))
  if (COLS >= 80) {
    // Roomy rows: label, path (shortened from the head, so the project folder
    // stays readable) and the branch when there is one — all on the brand row.
    ok(`${COLS}x${ROWS} header names the workspace`, row0.includes("WORKSPACE"), JSON.stringify(row0))
    ok(`${COLS}x${ROWS} header shows the project folder`, row0.includes("harness") || row0.includes(cwd))
    if (branch) ok(`${COLS}x${ROWS} header names the branch`, row0.includes("git: " + branch), JSON.stringify(row0))
  } else {
    // Tight rows keep the session title instead; the workspace yields whole,
    // and a clipped title is marked with an ellipsis, never a hard cut.
    ok(`${COLS}x${ROWS} narrow header keeps the title`, row0.includes("Workspa"), JSON.stringify(row0))
    ok(`${COLS}x${ROWS} narrow header marks the cut`, row0.includes("…"))
    ok(`${COLS}x${ROWS} narrow header drops the workspace`, !row0.includes("WORKSPACE") && !row0.includes("git: "))
  }
}

// The title screen keeps the workspace out of the header (its centre block
// owns it there), and the header is one row tall everywhere.
{
  const app = new App({ cols: 80, rows: 24, on() {} })
  app.setWelcome({ workingDirectory: "D:\\Projects\\x", gitBranch: "main" })
  const rows = app.render().cells.map((r) => r.map((c) => c.ch).join(""))
  ok("title screen header carries no workspace", !rows[0].includes("WORKSPACE"))
  const layout = app._layout()
  ok("header is one row", layout.headerH === 1 && layout.transcriptTop === 1)
}

// ---- session stats strip and window ----------------------------------------
// The strip takes a transcript row and the window repaints over the frame; both
// must leave the terminal exactly as the painter believes it is, at every width.
for (const [COLS, ROWS] of [[150, 45], [100, 30], [80, 24], [60, 20], [46, 16]]) {
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
  // Rail widths (>= 140) hand the strip's figures to the rail; narrower keep it.
  if (COLS < 140) ok(`${COLS}x${ROWS} stats strip is one row above the composer`, stripRow > 0)
  else ok(`${COLS}x${ROWS} rail width drops the strip for the rail`, stripRow === -1)
  app.statsOpen = true
  screen = app.render(); term.paint(screen)
  const diff = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok(`${COLS}x${ROWS} stats window leaves no residue`, diff.length === 0, JSON.stringify(diff.slice(0, 3)))
  const rows = screen.cells.map((r) => r.map((c) => c.ch).join("")).join("\n")
  // Every width gets the centered modal now: the maximized window used to
  // swap it for a right-hand panel, and the two shapes read as different
  // features.
  ok(`${COLS}x${ROWS} stats window keeps its box inside the screen`,
    rows.includes("session stats") && !rows.includes("SESSION STATS") && screen.cells.length === ROWS)
  // Centered in the main area, not on the full terminal: at rail widths the app
  // is only the columns left of the rail's border, and a full-width center
  // pushes the box half a rail's width right of the frame it covers.
  const layout = app._layout()
  const cut = layout.railW > 0 ? layout.borderX : COLS
  const modalRow = screen.cells.map((r) => r.slice(0, cut).map((c) => c.ch).join(""))
    .find((text) => text.includes("session stats"))
  const modalLeft = modalRow.indexOf("│")
  const modalRight = modalRow.lastIndexOf("│")
  ok(`${COLS}x${ROWS} stats window centers in the main area`,
    Math.abs(modalLeft - (cut - 1 - modalRight)) <= 1 && (layout.railW === 0 || modalRight < layout.borderX),
    JSON.stringify({ left: modalLeft, right: modalRight, cut, railW: layout.railW }))
  app.statsOpen = false
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} closing the stats window leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}

// Every modal centers in the main area, not on the full terminal. The rail
// leaves the app only the columns left of its border, so centering on the full
// width displaced each overlay half a rail's width to the right of the frame it
// covers — the maximized window then read as misaligned against the composer
// below it, while the narrow window (no rail) looked right.
{
  const overlays = [
    ["stats", (app) => {
      app.setStats({ stats: { turns: 2, steps: 5 }, pressure: {}, breakdown: {} })
      app.statsOpen = true
    }],
    ["help", (app) => { app.overlay = "help" }],
    ["settings", (app) => app.openSettings([
      { kind: "header", label: "General" },
      { id: "theme", label: "Theme", value: "blue" },
    ])],
    ["rewind", (app) => app.openRewind({
      items: [{ n: 1, seq: 0, label: "1. first prompt" }],
      restoreOptions: [{ id: "both", label: "Restore conversation and files" }],
    })],
    ["questions", (app) => {
      app.pendingQuestions = {
        questions: [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }],
        index: 0,
        drafts: [{ selected: [], custom: "" }],
      }
    }],
    ["secret", (app) => {
      app.pendingSecret = { label: "Provider API key", description: null, draft: "sk-123", cursor: 0, error: null, settle() {} }
    }],
  ]
  // The first rounded box whose top edge sits above the composer's rows.
  const modalBox = (screen, rows) => {
    for (let y = 0; y < rows - 8; y++) {
      const text = screen.cells[y].map((c) => c.ch).join("")
      const l = text.indexOf("╭")
      if (l < 0) continue
      const r = text.indexOf("╮", l)
      if (r >= 0) return [l, r]
    }
    return null
  }
  for (const [COLS, ROWS] of [[200, 50], [150, 45], [140, 42], [100, 30]]) {
    for (const [name, open] of overlays) {
      const app = new App({ cols: COLS, rows: ROWS, on() {} })
      app.setSession({ id: "s", title: "Overlay", model: "m" })
      app.setContextMeter({
        pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
        breakdown: { systemTokens: 1_100, toolsTokens: 6_800, messageTokens: 24_100 },
      })
      open(app)
      const layout = app._layout()
      const region = layout.railW > 0 ? layout.borderX : COLS
      const box = modalBox(app.render(), ROWS)
      ok(`${COLS}x${ROWS} ${name} centers in the main area`,
        box !== null && Math.abs(box[0] - (region - 1 - box[1])) <= 1
          && (layout.railW === 0 || box[1] < layout.borderX),
        JSON.stringify(box))
    }
  }
}

// The standalone secret prompt is a new painted overlay; like every other
// overlay it must not strand cells behind it when it opens, updates or closes.
// 26 columns is the smallest size where the panel still fits: the width floor
// is 20 and a centred x needs the remaining columns, so the clamp branch is
// reachable here and not at 40. Below ~21 columns the panel is clipped and only
// a human can judge it.
for (const [COLS, ROWS] of [[80, 24], [60, 20], [120, 40], [40, 24], [26, 20]]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Secret" })
  let screen = app.render(); term.paint(screen)

  app.pendingSecret = { label: "Provider API key", description: "Paste the key", draft: "", cursor: 0, error: null, settle() {} }
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt open leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)

  app.pendingSecret.draft = "sk-abcdefghijklmnop"
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt typing leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  const rows = screen.cells.map((row) => row.map((c) => c.ch).join(""))
  // The value is masked: the plaintext must never reach the screen buffer,
  // where it would be readable by anything that dumps the frame.
  ok(`${COLS}x${ROWS} secret prompt masks the value`,
    !rows.some((row) => row.includes("sk-abcdefghijklmnop")))
  ok(`${COLS}x${ROWS} secret prompt draws the label`,
    rows.some((row) => row.includes("Provider API key")))

  app.pendingSecret.error = "a value is required"
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt error leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  // Re-assert the mask in the error state: an implementation that echoed the
  // draft on the error line would otherwise pass every assertion in this block.
  ok(`${COLS}x${ROWS} secret prompt still masks the value in the error state`,
    !screen.cells.map((row) => row.map((c) => c.ch).join(""))
      .some((row) => row.includes("sk-abcdefghijklmnop")))

  app.pendingSecret = null
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} closing the secret prompt leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}

// ---- approval prompt -------------------------------------------------------
// The protocol requires the provider to clearly show the action, the summary,
// the origin and the policy-permitted details; the prompt used to show the
// action alone. A detail marked `private` shows its label but not its value, so
// the assertion this block exists for is that the hidden value never reaches
// the cell buffer.
for (const [COLS, ROWS] of [[80, 24], [60, 20], [120, 40], [40, 24]]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Approval" })
  let screen = app.render(); term.paint(screen)
  app.pendingApproval = {
    toolName: "fs.write",
    summary: "writes to /etc/hosts",
    origin: "tool:fs.write",
    risk: "high",
    details: [
      { label: "Command", value: "rm -rf ./build" },
      { label: "API key", value: "sk-private-value", sensitivity: "private" },
    ],
    settle() {},
  }
  screen = app.render(); term.paint(screen)
  const rows = screen.cells.map((row) => row.map((c) => c.ch).join(""))
  const painted = rows.join("\n")
  ok(`${COLS}x${ROWS} approval prompt leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  ok(`${COLS}x${ROWS} approval prompt shows the action`,
    painted.includes("Approval") && painted.includes("fs.write"))
  ok(`${COLS}x${ROWS} approval prompt shows the summary`, painted.includes("writes to /etc/hosts"))
  ok(`${COLS}x${ROWS} approval prompt shows the origin`, painted.includes("tool:fs.write"))
  ok(`${COLS}x${ROWS} approval prompt shows the risk`, painted.includes("Risk · high"))
  ok(`${COLS}x${ROWS} approval prompt shows each detail`,
    painted.includes("Command: rm -rf ./build") && painted.includes("API key"))
  ok(`${COLS}x${ROWS} approval prompt hides the private detail's value`,
    !painted.includes("sk-private-value"))
  ok(`${COLS}x${ROWS} approval prompt keeps the key hints`,
    painted.includes("y allow") && painted.includes("Esc cancel"))
  // The risk reads as a warning, not as one more detail row.
  const riskRow = screen.cells.find((row) => row.map((c) => c.ch).join("").includes("Risk · high"))
  const riskFg = riskRow?.[riskRow.map((c) => c.ch).join("").indexOf("high")]?.style?.fg
  ok(`${COLS}x${ROWS} approval prompt tones the risk`, riskFg === THEME.error, String(riskFg))
  app.pendingApproval = null
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} closing the approval prompt leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}

console.log("")
if (failed > 0) { console.log(failed + " render test(s) failed"); process.exit(1) }
console.log("all render tests passed")

// ---- image blocks -----------------------------------------------------------
// Image lines (halfblock text rows and graphics-protocol reserved rows) must
// obey the same frame contract as every other row: exactly cols columns, no
// residue, and the Screen carries the image slab annotations.
{
  const COLS = 100, ROWS = 30
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Images" })
  app.addUser("看看这张", { images: [{ kind: "bytes", key: "img:1", bytes: Buffer.alloc(1) }] })
  term.paint(app.render())
  app.setImageResult("img:1", { state: "done", protocol: "halfblock", cellsW: 40, cellsH: 6, segLines: Array.from({ length: 6 }, (_, i) => [{ text: "\u2580".repeat(20) + " ".repeat(20), style: { fg: "4d6bfe", bg: "0a0e18" } }]) })
  let screen = app.render()
  term.paint(screen)
  let bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("halfblock image frame leaves no residue", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
  ok("halfblock image rows span exact width", screen.cells.slice().every((row) => row.length === COLS))

  // Protocol mode: reserved rows + annotations, then the image moves (scroll)
  // and the vacated rows must repaint over the old pixels.
  app.graphicsProtocol = "sixel"
  app.setImageResult("img:1", { state: "done", protocol: "sixel", cellsW: 40, cellsH: 6 })
  screen = app.render()
  term.paint(screen)
  bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("protocol image frame leaves no residue", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
  ok("protocol frame carries the image slab", screen.images.length === 1 && screen.images[0].cellsH === 6)
  app.scrollTranscript(2)
  screen = app.render()
  term.paint(screen)
  bad = gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS)
  ok("scrolled image frame leaves no residue", bad.length === 0, JSON.stringify(bad.slice(0, 6)))
}

// ---- mermaid engine settle -------------------------------------------------
// The first fence renders its placeholder while the lazy engine import is in
// flight; when the engine settles, the per-block line cache (keyed rev+width)
// must be invalidated or the repaint reuses the cached "rendering…" rows
// forever — the stuck-loading symptom a window resize used to be the only
// cure for (the resize changed the cache key).
{
  const COLS = 100, ROWS = 30
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "T", model: "m" })
  const block = app.ensureAssistantBlock(Date.now())
  block.text = "```mermaid\ngraph TD\n A[Start] --> B[End]\n```"
  block.streaming = false
  app._mermaidEngine = undefined
  app.render() // first frame: engine starts loading, placeholder is cached
  ok("mermaid placeholder cached while the engine loads", app._blockLineCache.has(block))
  const fakeEngine = {
    render: (src) => ({ plain: ["A --> B"], styled: [[{ text: "A ── B", role: "edge" }]], width: 8, warnings: [] }),
  }
  app._mermaidEngineSettled(fakeEngine)
  const screen = app.render()
  const rows = screen.cells.map((r) => r.map((c) => c.ch).join("")).join("\n")
  ok("engine settle invalidates the line cache: art shows at the same width", rows.includes("A ── B") && !rows.includes("rendering mermaid"))
  // The settled engine must not re-trigger the lazy import on later fences.
  ok("engine state is settled", app._mermaidEngine === fakeEngine)
}

// ---- tool activity rows ---------------------------------------------------
// Collapsed, a tool row is one line: a status mark, the action in the tool's
// accent, and the target it acts on. Expanded, the result hangs under a ⎿
// gutter and the row offers the way back.
{
  const COLS = 110, ROWS = 30
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "T", model: "m" })
  app.startTool({ callId: "r1", name: "read", args: '{"file_path":"D:/x/README.md"}' })
  app.updateTool("r1", { status: "ok", result: "line one\nline two\nline three" })
  const readBlock = app.blocks.find((b) => b.kind === "tool")
  app.startTool({ callId: "p1", name: "pwsh", args: '{"command":"git status --short"}' })
  app.updateTool("p1", { status: "error", result: "fatal: not a git repository" })
  const screen = app.render()
  const rows = screen.cells.map((r) => r.map((c) => c.ch).join(""))
  // The composer below the transcript keeps its own rounded frame, so "no
  // frame" is about the transcript itself.
  const { transcriptTop, transcriptH } = app._layout()
  const transcript = rows.slice(transcriptTop, transcriptTop + transcriptH)
  const rowText = (needle) => rows.find((r) => r.includes(needle)) ?? ""
  const readRow = rowText("D:/x/README.md")
  ok("tool row shows the action and its target", readRow.includes("read") && readRow.includes("D:/x/README.md"))
  ok("tool row hides the result while collapsed", !rows.join("\n").includes("line three"))
  ok("tool row shows the expand hint", readRow.includes("click to expand"))
  ok("tool row keeps the error mark", rowText("git status --short").includes("✗"))
  ok("tool row marks success", readRow.includes("✓"))
  ok("tool row carries no frame", !transcript.join("\n").includes("╭") && !transcript.join("\n").includes("│"))
  // A flat row is clickable across the whole transcript width.
  ok("tool row hit spans the row", (() => {
    const hit = app.hitRegions.find((r) => r.kind === "tool")
    return hit && hit.width === COLS && hit.x === 0
  })())
  app.toggleTool(readBlock)
  const open = app.render().cells.map((r) => r.map((c) => c.ch).join(""))
  ok("tool row expanded shows the full result", open.join("\n").includes("line three"))
  ok("tool row expanded uses the ⎿ gutter", open.some((r) => r.includes("⎿")))
  ok("tool row expanded shows the collapse hint", open.find((r) => r.includes("D:/x/README.md")).includes("click to collapse"))
  app.toggleTool(readBlock)
  ok("tool row toggles back", !app.render().cells.map((r) => r.map((c) => c.ch).join("")).join("\n").includes("line three"))
  // Accents: read -> info, pwsh/run -> warning, edit -> secondary.
  const t = THEME
  ok("tool accents differ per tool", (() => {
    const app2 = new App({ cols: COLS, rows: ROWS, on() {} })
    app2.setSession({ id: "s", title: "T", model: "m" })
    app2.startTool({ callId: "a", name: "read", args: "{}" })
    app2.updateTool("a", { status: "ok", result: "x" })
    app2.startTool({ callId: "b", name: "pwsh", args: "{}" })
    app2.updateTool("b", { status: "ok", result: "y" })
    app2.startTool({ callId: "c", name: "edit", args: "{}" })
    app2.updateTool("c", { status: "ok", result: "z" })
    const screen = app2.render()
    const colorAt = (needle) => {
      for (let y = 0; y < screen.rows; y++) {
        const text = screen.cells[y].map((c) => c.ch).join("")
        const x = text.indexOf(needle)
        if (x >= 0) return screen.cells[y][x].style?.fg
      }
      return null
    }
    return colorAt("read") === t.info && colorAt("run") === t.warning && colorAt("edit") === t.secondary
  })())
}

// ---- assistant output is flat, not boxed ------------------------------------
// The answer is a plain column of text under its `dsh · time` label: no bubble
// frame anywhere in the transcript, and a message that only issued tool calls
// renders nothing at all while its label moves to the answer that follows.
{
  const app = new App({ cols: 110, rows: 30, on() {} })
  app.setSession({ id: "s", title: "T", model: "m", provider: "p" })
  app.addUser("check")
  const empty = app.ensureAssistantBlock(Date.now())
  empty.streaming = false
  app.startTool({ callId: "r", name: "read", args: '{"file_path":"D:/x/README.md"}' })
  app.updateTool("r", { status: "ok", result: "ok" })
  const withText = app.ensureAssistantBlock(Date.now())
  withText.text = "读取完成。"
  withText.streaming = false
  const rows = app.render().cells.map((r) => r.map((c) => c.ch).join(""))
  const { transcriptTop, transcriptH } = app._layout()
  const transcript = rows.slice(transcriptTop, transcriptTop + transcriptH)
  ok("tool-only assistant message renders nothing", !transcript.join("\n").includes("╭"))
  ok("dsh label transfers to the text answer", rows.some((r) => r.trimStart().startsWith("dsh · ")))
  ok("assistant answer is flush text", rows.some((r) => r.startsWith("  读取完成。")))
  ok("user turn opens with the pointer", rows.some((r) => r.startsWith("  ❯ ")))
}
