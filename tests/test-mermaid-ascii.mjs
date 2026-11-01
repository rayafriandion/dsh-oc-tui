// Native-art tests for ```mermaid fences.
//
// Diagrams draw as box-drawing characters through lovely-mermaid, so a diagram
// is terminal text rather than a raster. The invariants worth guarding are the
// ones a hand-rolled renderer broke: an emoji or wide glyph must occupy
// exactly the cells the art claims (the art's `width` is the contract), the
// engine must answer every grammar it draws without reaching the image chain,
// and a diagram wider than the pane must degrade to its source rather than to
// a network raster of the same diagram.
import { App, THEME } from "../lib/ui.js"
import { loadMermaidEngine, renderMermaidArt, paintMermaidArt } from "../lib/mermaid-ascii.js"
import { displayWidth } from "../lib/util.js"

// The engine sizes a box, this table paints and wraps the line beside it, so the
// two have to agree cell for cell on what gets drawn: a disagreement either way
// leaves a border beside the glyph instead of beside its padding. Its exports
// map hides the width module, so it is reached from the package entry.
const engineWidth = (await import(new URL("../dist/width.js", import.meta.resolve("lovely-mermaid")).href)).stringWidth

let failed = 0
const ok = (name, cond, extra = "") => {
  if (cond) console.log("ok   " + name)
  else { failed++; console.log("FAIL " + name + (extra ? "  " + extra : "")) }
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) console.log("ok   " + name)
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}

// The engine promise is module-shared: awaiting it here is the same await the
// App's first fence performs, so one load covers the whole file.
const engine = await loadMermaidEngine()
ok("the mermaid engine loads", engine !== null && typeof engine?.render === "function")

// ---- the adapter ----------------------------------------------------------
const FLOW = `graph TD
    A[Christmas] --> B(Go shopping)
    B --> C{Let me think}
    C --> D[Laptop]
    C --> E[fa:fa-car Car]`
const EMOJI = `graph TD
    A[🎄 圣诞快乐] --> B[买礼物 🎁]
    B -->|金额| C{确认?}
    C -->|Yes| D[付款 💳]`
// Emoji the unicode-width crate leaves East-Asian-Neutral — one column — while
// every terminal draws them two. The engine would size 🌡's box a cell narrow
// and its border would land beside the glyph instead of beside the padding.
const NEUTRAL_EMOJI = `graph TD
    A[🌡 sensor] -->|🏠 home| B{👁 watch}
    B -->|⛈ storm| C[🐿 hide]
    B -->|☀ fine| D[🛰 orbit]`
const JOINED = `graph LR
    A[👨‍👩‍👧 family] -->|👍🏽| B[🧑‍💻 work]`
// Emoji that take their emoji presentation from a variation selector — ☀️ ❤️
// ✈️ ✔️ 1️⃣ — are one rune wide without it, so measuring the runes instead of the
// cluster leaves their label a cell short of its own border.
const EMOJI_FORM = `graph TD
    A[☀️ fine] --> B(❤️ love)
    B --> C{✈️ fly}
    C -->|✔️ ok| D[1️⃣ first]`

const flowArt = engine ? renderMermaidArt(engine, FLOW) : null
const emojiArt = engine ? renderMermaidArt(engine, EMOJI) : null
const neutralArt = engine ? renderMermaidArt(engine, NEUTRAL_EMOJI) : null
const joinedArt = engine ? renderMermaidArt(engine, JOINED) : null
const formArt = engine ? renderMermaidArt(engine, EMOJI_FORM) : null

ok("a flowchart lays out as art", flowArt !== null)
ok("emoji and wide labels lay out as art", emojiArt !== null)
ok("neutral-width emoji lay out as art", neutralArt !== null)
ok("joined emoji lay out as art", joinedArt !== null)
ok("emoji-presentation labels lay out as art", formArt !== null)

const arts = [["flowchart", flowArt], ["emoji", emojiArt], ["neutral emoji", neutralArt],
  ["joined emoji", joinedArt], ["emoji presentation", formArt]]
if (arts.every(([, art]) => art !== null)) {
  for (const [name, art] of arts) {
    const rows = art.styled.map((row) => row.map((span) => span.text).join(""))
    eq(name + ": styled rows describe the same rows as plain", rows, art.plain)
    eq(name + ": the widest row is exactly the reported width",
      Math.max(...rows.map((r) => displayWidth(r))), art.width)
    // The reported width is the widest row, so no row may draw wider: one that
    // does is a label the engine under-measured, and its box is no longer square.
    eq(name + ": every row draws within the reported width",
      rows.filter((r) => displayWidth(r) > art.width), [])
    // Narrower is just as wrong: the box was sized for a label wider than the
    // one drawn into it, and the right border lands past the padding.
    eq(name + ": the engine measures every drawn row the way this table does",
      rows.filter((r) => displayWidth(r) !== engineWidth(r)), [])
  }
  const [top, label, bottom] = neutralArt.plain
  eq("a neutral emoji's box stays square",
    new Set([top, label, bottom].map((r) => displayWidth(r))).size, 1)
  // Every label row must be closed by a frame drawn as wide as it is; a
  // variation-selected emoji measured as one rune breaks that. The engine draws
  // single, rounded and double borders depending on the node shape, so any
  // frame closes it.
  const BAR = /[│║]/
  const FRAME = /[┌┐└┘╭╮╰╯╔╗╚╝]/
  // A label row is closed by bars; a connector only carries one down the middle.
  const LABEL_ROW = /^ *[│║].*[│║] *$/
  const closed = formArt.plain.flatMap((row, i) => LABEL_ROW.test(row) ? [i] : [])
    .every((i) => {
      const w = displayWidth(formArt.plain[i])
      for (const step of [-1, 1]) {
        for (let j = i + step; j >= 0 && j < formArt.plain.length; j += step) {
          if (FRAME.test(formArt.plain[j])) return displayWidth(formArt.plain[j]) === w
          if (!BAR.test(formArt.plain[j])) break   // a connector, not this box
        }
      }
      return true
    })
  eq("every emoji-presentation label row is closed by a frame of its own width", closed, true)
  ok("neutral emoji labels keep their glyph",
    neutralArt.plain.some((r) => r.includes("🌡️ sensor")) && neutralArt.plain.some((r) => r.includes("🐿️ hide")),
    JSON.stringify(neutralArt.plain))
  ok("joined emoji are one glyph wide",
    joinedArt.plain.some((r) => r.includes("👨‍👩‍👧 family")) && displayWidth("👨‍👩‍👧") === 2,
    JSON.stringify(joinedArt.plain))
  ok("emoji labels survive as whole glyphs",
    emojiArt.plain.some((r) => r.includes("🎄 圣诞快乐")) && emojiArt.plain.some((r) => r.includes("买礼物 🎁")),
    JSON.stringify(emojiArt.plain))
  ok("an emoji cell never splits into surrogates",
    emojiArt.plain.every((r) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r)))
  ok("flowcharts draw borders and arrowheads",
    flowArt.plain.some((r) => r.includes("┌")) && flowArt.plain.some((r) => r.includes("▼")))
  ok("edge labels ride the connector",
    emojiArt.plain.some((r) => r.includes("金额")))
}

// Painting: one entry per row, every row indented to the code-block body
// position, roles mapped onto the theme.
if (emojiArt) {
  const painted = paintMermaidArt(emojiArt, THEME)
  eq("paint emits one line per art row", painted.length, emojiArt.styled.length)
  ok("every painted row carries the body indent", painted.every((segs) => segs[0]?.text === "  "),
    JSON.stringify(painted.map((s) => s[0]?.text)))
  const joined = painted.map((segs) => segs.map((s) => s.text).join(""))
  eq("painting preserves the art's columns", joined, emojiArt.plain.map((r) => "  " + r))
  // Painted rows carry one segment per span after the indent, so a role's
  // style can be read off by position instead of by text — a border's │ and
  // an edge's │ are the same glyph with different jobs.
  const byRole = {}
  let aligned = true
  emojiArt.styled.forEach((row, i) => {
    row.forEach((span, j) => {
      const seg = painted[i][j + 1]
      if (!seg || seg.text !== span.text) aligned = false
      else byRole[span.role] ??= seg
    })
  })
  ok("every painted segment keeps its span's text", aligned)
  eq("borders take the theme's border colour", byRole.border?.style.fg, THEME.border)
  eq("connectors take the theme's cyan", byRole.edge?.style.fg, THEME.info)
  eq("edge labels dim the connector colour", byRole.edgeLabel?.style.fg, THEME.info)
  eq("edge labels are dimmed", byRole.edgeLabel?.style.dim, true)
  eq("labels stay body-coloured", byRole.text?.style.fg, THEME.text)
}

// Null cases: no engine, blank source, grammars the engine does not draw.
ok("no engine renders nothing", renderMermaidArt(null, FLOW) === null)
if (engine) {
  ok("a blank fence renders nothing", renderMermaidArt(engine, "   \n ") === null)
  for (const [name, src] of [["journey", "journey\n  title My day\n  section Go\n    Wake: 5: Me"], ["gantt", "gantt\n  title A"]]) {
    ok(name + " is left to the caller's own chain", renderMermaidArt(engine, src) === null)
  }
}

// ---- the fence path through the App ---------------------------------------
const fakeTerm = { cols: 80, rows: 24, on() {} }
const app = new App(fakeTerm)
const block = {}
const asked = []
app.onMermaidRequest = (code) => asked.push(code)
let repaints = 0
app._needsRepaint = () => repaints++

// Rendering switched off: a diagram is its own source, the engine never loads,
// and nothing goes anywhere.
const offApp = new App(fakeTerm)
offApp.mermaidMode = 'off'
const offAsked = []
offApp.onMermaidRequest = (code) => offAsked.push(code)
let offOut = []
offApp._mermaidLines(FLOW, block, 80, offOut)
const offRows = offOut.map((l) => l.segs.map((s) => s.text).join(""))
ok("mermaid off renders the source",
  offRows.some((r) => r.includes("graph TD")) && offRows.some((r) => r.includes("Christmas")),
  JSON.stringify(offRows.slice(0, 3)))
ok("mermaid off draws no art", offRows.every((r) => !r.includes("┌")))
ok("mermaid off loads no engine", offApp._mermaidEngine === undefined)
ok("mermaid off asks for no render", offAsked.length === 0)

let out = []
app._mermaidLines(FLOW, block, 80, out)
ok("the first fence waits on the engine load",
  out.length === 1 && out[0].segs[0].text.includes("rendering mermaid"),
  JSON.stringify(out.map((l) => l.segs.map((s) => s.text).join(""))))
ok("waiting fires no image render", asked.length === 0)

// The module-shared engine promise is already resolved; one macrotask lets
// the App's continuation run.
await new Promise((resolve) => setTimeout(resolve, 0))
ok("the engine's arrival asks for a repaint", repaints === 1)

out = []
app._mermaidLines(FLOW, block, 80, out)
const rows = out.map((l) => l.segs.map((s) => s.text).join(""))
ok("the settled engine draws the art", rows.some((r) => r.includes("Christmas")) && rows.some((r) => r.includes("Let me think")),
  JSON.stringify(rows))
ok("the art is indented like a code-block body", rows.every((r) => r.startsWith("  ")))
ok("the art shows no fence line", rows.every((r) => !r.includes("```")))
ok("no image render fires for a grammar the engine draws", asked.length === 0)
ok("every art row fits the pane", rows.every((r) => displayWidth(r) <= 80))

// Too wide for the pane: the caption names the width, the source follows, and
// nothing goes to the image chain.
out = []
app._mermaidLines(FLOW, block, 24, out)
const narrow = out.map((l) => l.segs.map((s) => s.text).join(""))
ok("a too-wide diagram says what it needs",
  narrow.some((r) => /mermaid diagram needs \d+ columns, this pane has \d+/.test(r)),
  JSON.stringify(narrow.slice(0, 2)))
ok("a too-wide diagram falls back to its source", narrow.some((r) => r.includes("graph TD")))
ok("a too-wide diagram fires no image render", asked.length === 0)

if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all mermaid native-art tests passed")
