// The TUI view model and renderer: opencode-inspired layout with a dark
// theme, session sidebar, chat transcript, input row, and status bar.
import { Screen, makeStyle, mergeStyle, hexToAnsi } from './term.js'
import { renderMarkdown } from './markdown.js'
import { sha16 } from './image.js'
import { displayWidth, truncateWidth, timeString, toolSummary, roughTokens, formatTokens, wrapText, shortenPath, decodeDataUrl } from './util.js'
import { paintSplashOpenCode } from './splash-opencode.js'
import { loadMermaidEngine, paintMermaidArt, renderMermaidArt } from './mermaid-ascii.js'

// Mermaid art sits where a code-block body sits, and the pane keeps the same
// slack a markdown table keeps for gutters and message insets before an art
// wider than that is declared too wide for the viewport.
const MERMAID_INDENT = '  '
const MERMAID_INDENT_WIDTH = displayWidth(MERMAID_INDENT)
const MERMAID_MARGIN = 4

// DeepSeek brand palette: deep blue accents on a blue-tinted dark canvas.
export const THEME = {
  primary: '4d6bfe',      // DeepSeek blue
  secondary: '6c9cff',    // light blue
  accent: '7c9cff',       // light blue accent
  error: 'e06c75',
  warning: 'e8c468',      // soft gold (no orange)
  warningDim: '806c39',   // dimmed gold: resting cells of the flowing composer frame
  success: '7fd88f',
  info: '56b6c2',
  text: 'f0f4ff',         // blue-white text
  textMuted: '8a93a8',
  background: '0a0e18',   // blue-tinted dark background
  backgroundPanel: '111a2c',
  backgroundElement: '1b2740',
  border: '3d4d73',
  borderSubtle: '2b3a5c',
  markdownHeading: '7c9cff',
  markdownLinkText: '6c9cff',
  markdownCode: '7fd88f',
  markdownCodeBlock: 'f0f4ff',
  markdownBlockQuote: '9fb0d8',
  markdownListItem: '4d6bfe',
  markdownHorizontalRule: '46547a',
  codeBg: '1b2740',
  thinking: '9aa6c2',
  reminder: 'c5bdf7',       // system-reminder row text (pale violet)
  imageChipBg: 'd97706',    // orange emphasis for pasted-image markers
  imageChipText: '1a0d00',  // text on the orange image chip
  compaction: '95d8c0',     // compaction row text (pale mint)
  inbox: '9fd0e8',          // pending-inbox row text (pale cyan)
  steering: '9fd0e8',       // inline badge on a user turn that arrived as steering
  systemPrompt: 'b9c4dd',   // system-prompt row text (cool gray)
  // Context-meter segments (web ContextMeter port): heuristic composition
  // shares get distinct hues so the breakdown bar reads at a glance.
  contextSystem: '7fd88f',
  contextTools: 'e8c468',
  contextMessages: '56b6c2',
  // Mouse text-selection highlight (left-drag select, right-click copy).
  selection: '3153b8',
  // Syntax highlighting palette (highlight.js token classes), tuned for the
  // blue-tinted dark canvas and the code background.
  syntaxKeyword: 'c792ea',
  syntaxString: '9ece8f',
  syntaxNumber: 'e5b567',
  syntaxComment: '6b7490',
  syntaxFunction: '82aaff',
  syntaxType: 'e5c07b',
  tableBorder: '41528a',
  // Transcript markers: the pointer that opens a user turn carries the brand
  // blue, the assistant's own label a quiet one, so a long transcript reads at
  // a glance without any frame around either.
  userPointer: '4d6bfe',
  assistantLabel: '9aa6c2',
}

// Flowing activity indicator frames (clockwise Braille flow).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Label of the header row that names the workspace a session is rooted in, and
// the fewest columns a path may occupy before the strip is dropped entirely (a
// six-cell fragment of a path helps nobody).
const WORKSPACE_LABEL = 'WORKSPACE'
const WORKSPACE_MIN_PATH = 8

// Cached styles for the composer's flowing (marching-ants) frame: a bright
// gold head, a warning-gold body, and the dimmed resting tone. Built once
// because the whole border re-resolves its tone on every animation frame.
let flowFramePalette = null

const COMMAND_HINTS = [
  ['/help', 'show help'], ['/settings', 'open settings'],
  ['/new', 'new session'], ['/resume', 'resume session'],
  ['/model', 'select model'], ['/provider', 'select provider'],
  ['/rewind', 'rewind picker'], ['/stats', 'session stats & token usage'],
  ['/clear', 'clear view'], ['/cancel', 'cancel running turn'],
  ['/quit', 'exit'],
  ['/compact', 'compact context'], ['/goal', 'manage goal'],
]

// The marker shown in place of an approval detail whose sensitivity is
// `private`. A fixed width on purpose: a length-derived mask (like the secret
// prompt's bullets) would leak how long the hidden value is.
const REDACTED_DETAIL = '••••••'

// Right status rail (OpenCode-style right column): the expanded home of the
// status figures the bottom row compresses — model, thinking intensity,
// context — plus the session's goal and subagent activity. The threshold sits
// well above the 120-column default many terminals open at (the rail at that
// width read as "small window"), while any maximized desktop window clears it.
const RAIL_MIN_COLS = 140
const RAIL_WIDTH = 34

// Usable text width inside the composer box, derived from the same geometry
// render() uses (composerX = sidebarW + 2 or 1; the box spans to the main
// area's right edge, with two columns of padding on each side). Shared so the
// approval prompt's line count and its painting can never disagree.
function composerTextWidth(cols, sidebarW, railW = 0) {
  const composerX = sidebarW > 0 ? sidebarW + 2 : 1
  const rightEdge = cols - (railW > 0 ? railW + 1 : 0)
  const composerW = rightEdge - composerX - 1
  return Math.max(1, composerW - 4)
}

// Width of the region an overlay may occupy: every column left of the rail's
// border. Rail mode shrinks the main area by that border column plus
// RAIL_WIDTH, so a modal centered on the full terminal width would sit half a
// rail's width right of the frame it covers — visibly off-center once the
// window is maximized. Without a rail the region is the whole screen, which
// keeps the narrow layout byte-identical.
function overlayRegion(cols, railW = 0) {
  return railW > 0 ? cols - railW - 1 : cols
}

export function inputRows(text, cursor, width) {
  const rows = ['']
  let row = 0
  let col = 0
  let cursorRow = 0
  let cursorCol = 0
  let offset = 0
  for (const ch of text) {
    if (offset === cursor) {
      cursorRow = row
      cursorCol = col
    }
    if (ch === '\n') {
      rows.push('')
      row++
      col = 0
      offset += ch.length
      continue
    }
    const rune = displayWidth(ch)
    if (col > 0 && col + rune > width) {
      rows.push('')
      row++
      col = 0
    }
    rows[row] += ch
    col += rune
    offset += ch.length
  }
  if (cursor >= offset) {
    cursorRow = row
    cursorCol = col
  }
  return { rows, cursorRow, cursorCol }
}

export function cursorAtVisual(text, width, targetRow, targetCol) {
  let row = 0
  let col = 0
  let offset = 0
  let lastOnRow = 0
  for (const ch of text) {
    if (ch === '\n') {
      if (row === targetRow) return targetCol >= col ? offset : lastOnRow
      row++
      col = 0
      offset += ch.length
      lastOnRow = offset
      continue
    }
    const rune = displayWidth(ch)
    if (col > 0 && col + rune > width) {
      if (row === targetRow) return offset
      row++
      col = 0
      lastOnRow = offset
    }
    if (row === targetRow && targetCol <= col) return offset
    col += rune
    offset += ch.length
    if (row === targetRow) lastOnRow = offset
  }
  return row < targetRow ? text.length : lastOnRow
}

function formatDuration(ms) {
  return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 's'
}

function formatMetric(value) {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1)
}

// `1 turn` / `3 turns`: the web stats strip pluralizes through its locale, the
// English TUI through the noun's own count.
function count(n, noun) {
  return n + ' ' + noun + (n === 1 ? '' : 's')
}

// Truncate a segment list to a display width, preserving each segment's style.
// Applied at the render boundary to every row, so no block can paint past the
// edge of its box: a row wider than the terminal wraps, which shifts the frame
// and leaves the previous content visible on the right until a full repaint.
function clipSegs(segs, width) {
  const out = []
  let used = 0
  for (const seg of segs) {
    if (used >= width) break
    const text = truncateWidth(seg.text, width - used)
    if (text === '') {
      // A zero-width rune carried no columns; keep it attached to its base.
      if (displayWidth(seg.text) === 0) out.push(seg)
      continue
    }
    out.push(text === seg.text ? seg : { ...seg, text })
    used += displayWidth(text)
  }
  return out
}

// A flat, unboxed block: the marker row comes first, body lines hang under it
// at `hang` columns in the block's own color, and every row is tagged so the
// whole block stays one click target. Transcript rows are plain segment lists
// that the render boundary clips, so a block computes no frame width — the
// boxed shapes did, and their borders drifted whenever a wide rune made the
// measured row differ from the painted one.
function flatRows(tag, block, markerSegs, body, hang = 4, width = Infinity) {
  // The marker row is the one row a caller composes by hand, so it is the one
  // that can outgrow the transcript: clip it here rather than trusting each
  // caller's arithmetic.
  const rows = [{ segs: clipSegs(markerSegs, width) }]
  const pad = ' '.repeat(hang)
  for (const line of body) rows.push({ segs: [{ text: pad, style: null }, ...line] })
  for (const row of rows) row[tag] = { block }
  return rows
}

// Per-tool accent for the activity rows: shell commands read as actions
// (gold), reads as lookups (cyan), edits as changes (light blue), todo writes
// as progress (mint); anything unmapped keeps the light-blue accent.
const TOOL_ACCENTS = {
  run: 'warning', bash: 'warning', pwsh: 'warning', shell: 'warning', command: 'warning',
  read: 'info', glob: 'info', grep: 'info', ls: 'info',
  edit: 'secondary', write: 'secondary', 'str-replace-editor': 'secondary', multiedit: 'secondary', patch: 'secondary',
  todo: 'success', todo_write: 'success',
  task: 'primary', agent: 'primary', subagent: 'primary',
  web_search: 'accent', webfetch: 'accent', fetch: 'accent',
}

function toolAccent(name, t) {
  return t[TOOL_ACCENTS[String(name ?? '').toLowerCase()]] ?? t.accent
}

// Interpolate between two hex colors; t in [0, 1].
function mixColor(a, b, t) {
  const ca = hexToAnsi(a)
  const cb = hexToAnsi(b)
  const ch = [0, 1, 2].map((i) => {
    const v = [ca.r, ca.g, ca.b][i] + ([cb.r, cb.g, cb.b][i] - [ca.r, ca.g, ca.b][i]) * t
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  })
  return '#' + ch.join('')
}

// Draw text with a per-character color gradient from `from` to `to`.
function gradientText(screen, x, y, text, from, to, base = {}) {
  const chars = Array.from(text)
  let cx = x
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0
    cx = screen.text(cx, y, chars[i], makeStyle({ ...base, fg: mixColor(from, to, t) }))
  }
  return cx
}

// A transcript block. Fields vary by kind.
// user:      { kind, text, time }
// assistant: { kind, text, reasoning, streaming, thinkingCollapsed, time }
// tool:      { kind, callId, name, args, status, result, time }
// todo:      { kind, todos, time }
// system:    { kind, text, level }
// note:      { kind, text, label, collapsed, time }
export function makeBlock(kind, data = {}) {
  return { kind, time: Date.now(), rev: 0, ...data }
}

// Classify a non-user context message into a labeled collapsible note.
// `system-reminder` frames and compaction checkpoints get labeled boxes;
// everything else stays a plain system line.
export function noteFromContext(src, text) {
  if (typeof text !== 'string') return null
  if (text.includes('<system-reminder>')) {
    return { label: 'system-reminder', text: stripTag(text, 'system-reminder') }
  }
  if (src && src.kind === 'plugin' && src.plugin === 'compact') {
    return { label: 'compaction', text: stripTag(text, 'compacted-summary') }
  }
  return null
}

function stripTag(text, name) {
  return text.replace(new RegExp('<\\s*/?\\s*' + name + '\\s*>', 'g'), '').trim()
}

// Flatten one pending-inbox message (a `UserMessage` with LLM content blocks)
// into display text. Reasoning is never part of admitted input; text blocks
// are concatenated and an attachment-only message falls back to a marker so a
// queued image or file still reads as queued work.
export function inboxMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[Image]')
    else if (block?.type === 'file') parts.push('[File]')
  }
  const text = parts.join(' ').trim()
  return text === '' ? '[empty message]' : text
}

// One-line preview for a pending-inbox row: newlines collapse so a multi-line
// queued prompt cannot stretch the box.
function inboxPreview(text, width) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return truncateWidth(flat, Math.max(4, width))
}

// The application view state + layout + painting. It is dsh-agnostic: the
// plugin feeds it events and key presses.
export class App {
  constructor(terminal, { sidebarWidth = 18 } = {}) {
    this.terminal = terminal
    this.sidebarWidth = sidebarWidth
    this.blocks = []
    this.assistantHeaderPending = true
    this.title = 'DeepSeek Harness'
    this.titleScreen = true
    this.workingDirectory = ''
    this.gitBranch = ''
    this.sessionId = ''
    this.model = ''
    this.provider = ''
    this.status = 'idle'           // idle | running
    this.usage = { input: 0, output: 0 }
    this.metrics = {}              // whole-log stats + billing (web stats strip / tokenUsage port)
    this.contextMeter = null       // { percent, usedTokens, contextWindow, breakdown } — web ContextMeter port
    this.statsOpen = false         // click-open session stats / token usage window
    this.statsDetailVisible = false // fullscreen stats panel (replaces modal)
    this.sidebarVisible = false
    this.sidebarAgents = []        // [{ id, label }]
    this.sidebarSessions = []      // [{ id, label, time }]
    this.sidebarSelection = -1
    // Right status rail state. `goal` is the current goal view (objective,
    // phase, rounds) folded from the harness's `goal` projection; `subagents`
    // are the delegation rows of `ctx.subagents.listDescendants()`; `versions`
    // names the running dsh and TUI builds in the rail footer.
    this.goal = null               // { objective, phase, blockedReason?, roundsStarted, maxGoalRounds }
    this.subagents = []            // [{ id, label, mode, activity, depth, readable }]
    this.railScroll = 0            // lines scrolled up from the rail's bottom (0 = follow)
    this.versions = { tui: '', dsh: '' }
    this.rewind = null             // rewind picker state, or null
    this.inputText = ''
    this.inputCursor = 0
    this.inputImages = []          // pasted images: [{ status, ref, mediaType, label }]
    this.history = []
    this.historyIndex = -1
    this.scroll = 0                // lines scrolled up from bottom (0 = follow)
    this.overlay = null            // 'help' | 'settings' | 'rewind' | null
    this.settingsSelection = 0
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsBusy = false       // update checks / installs animate a subtitle spinner
    this.settingsTitle = 'Settings'
    this.settingsSubtitle = ''
    this.settingsItems = []
    this.settingsMenu = []          // left menu of the settings dialog: [{ id, label }]
    this.settingsMenuIndex = 0      // active left-menu entry (Tab switches it)
    this.settingsScrollOffset = 0   // scroll offset for the settings window (wheel scroll support)
    this.toast = null              // { text, level }
    this.effortSlider = null       // { levels: [{id, name}], current } — the current model's real reasoning levels
    this.effortSliderVisible = false
    this.pendingApproval = null    // { toolName, summary, origin, details, risk, settle }
    this.pendingQuestions = null   // { questions, index, drafts, cursor, customMode, ... } modal state
    this.pendingSecret = null      // { label, description, draft, cursor, error, settle }
    // Durable agent inbox (dsh 0.1.5 `agent/inbox/spliced`): work admitted but
    // not yet claimed by the loop. `next-step` input is injected at the next
    // step boundary and is consumed before a `next-turn` entry, so it renders
    // first. `currentClaimed` classifies a later `user/message` as steering.
    this.inbox = { nextTurn: [], nextStep: [] }
    this._inboxClaimed = new Set()
    this.inboxBlock = null         // the parked transcript block, when one is shown
    this.inboxExpanded = false
    this.systemPromptText = ''     // last rendered system-prompt text (dedupe)
    this.systemPromptBlock = null
    this.focusedRegion = 'keyboard' // mouse hover temporarily owns focus
    this._lastHover = ''            // last hovered target (focus-follows-mouse cache)
    this.hitRegions = []           // topmost interactive regions from the latest render
    this._blockLineCache = new Map() // rendered lines per block, keyed by rev+width
    this._streamingRenderAt = 0    // last time the live streaming block was re-rendered
    this.textSelection = null      // { startX, startY, endX, endY, text } for mouse text selection
    this.textSelectionDragging = false // true while left button is held and dragging
    // Image pipeline state. Blocks carry `images: ImageSource[]`; results land
    // in _imageResults keyed by source key. Rendering (decode + encode) happens
    // outside the view model: onImageRequest hands a source to the host, which
    // calls setImageResult when the render lands. graphicsProtocol mirrors the
    // probed terminal capability ('kitty' | 'iterm2' | 'sixel' | 'halfblock');
    // halfblock results are plain styled lines, everything else reserves rows
    // and lets the terminal draw pixels there.
    this._imageGroupSeq = 0         // identifies one image's reserved rows inside a block
    this._imageResults = new Map() // key -> { state: 'loading' | 'done' | 'error', protocol?, cellsW?, cellsH?, segLines?, error? }
    this._imageBlocks = new Map()  // key -> Set of blocks showing it (rev bump on arrival)
    this._imageRequested = new Set()
    this._imageSources = new Map() // key -> the source that produced it (cropped variants are re-renders of it)
    this._imageCrops = new Map()   // key -> Set of '<key>\u0000<crop>' variants still holding a payload
    this._imageCropsPrev = new Set() // variants the previous render used (a crop outlives one idle frame)
    this.onImageRequest = null     // (source) => void
    this._mermaidResults = new Map() // 'mermaid:<hash>' -> { state, imageKey? }
    this._mermaidBlocks = new Map()
    this._mermaidRequested = new Set()
    this.onMermaidRequest = null   // (code, key) => void
    this._mermaidEngine = undefined // undefined: not asked yet, 'loading', engine, or null
    this._needsRepaint = null       // () => void, set by the host: repaint when a late art arrives
    this.mermaidMode = 'auto'       // 'auto' | 'local' | 'off' — off means a diagram is its source
    this.graphicsProtocol = 'halfblock'
    this.imagePixels = true        // false = the settings chose chip placeholders over any pixels
    this.imageMaxRows = 20
    this.imageCellW = 8            // terminal cell size in pixels (from caps probing)
    this.imageCellH = 16
    this._lastTransWidth = 80
  }

  addHitRegion(kind, x, y, width, height = 1, data = {}) {
    if (width <= 0 || height <= 0) return
    this.hitRegions.push({ kind, x, y, width, height, ...data })
  }

  hitTest(x, y, kinds) {
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const region = this.hitRegions[i]
      if (kinds && !kinds.includes(region.kind)) continue
      if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) return region
    }
    return undefined
  }

  placeInputCursor(x, y) {
    const region = this.hitTest(x, y, ['composer'])
    if (!region) return false
    const visualRow = region.firstVisual + Math.max(0, y - region.composerTop - 1)
    const visualCol = Math.max(0, x - region.x - 2)
    this.inputCursor = cursorAtVisual(this.inputText, Math.max(1, region.width - 4), visualRow, visualCol)
    return true
  }

  // Focus follows the cursor: hovering an interactive row (settings item,
  // sidebar session) moves the keyboard selection there. Returns true when
  // the pointer moved the focus (or left it stale relative to the current
  // selection), so the caller repaints; returns false when nothing changed.
  // The last-hover cache alone is not enough — the selection can move away
  // (keyboard, click, reopened list) while the pointer never leaves the row,
  // and re-hovering that row must move the focus back even though the target
  // did not change.
  hoverFocus(x, y) {
    const region = this.hitTest(x, y)
    // The settings left menu switches on Tab/click only; hovering it never
    // steals focus from the item list.
    if (region?.kind === 'settings-menu') return false
    const target = region ? region.kind + ':' + (region.settingsIndex ?? region.sessionIndex ?? region.rewindIndex ?? '') : ''
    const focusIndex = region ? (region.settingsIndex ?? region.sessionIndex ?? region.rewindIndex ?? -1) : -1
    const currentFocus = region?.kind === 'settings-item' ? this.settingsSelection
      : region?.kind === 'rewind-item' ? this.rewind?.selected
      : region?.kind === 'rewind-option' ? this.rewind?.modeIndex
      : this.sidebarSelection
    const focusDiffers = focusIndex >= 0 && focusIndex !== currentFocus
    if (target === this._lastHover && !focusDiffers) return false
    this._lastHover = target
    if (!region) return false
    this.focusedRegion = 'mouse'
    if (region.kind === 'settings-item') this.settingsSelection = region.settingsIndex
    if (region.kind === 'session') this.sidebarSelection = region.sessionIndex
    if (this.rewind) {
      if (region.kind === 'rewind-item') this.rewind.selected = region.rewindIndex
      if (region.kind === 'rewind-option') this.rewind.modeIndex = region.rewindIndex
    }
    return true
  }

  // ---- mouse text selection ------------------------------------------------
  // Left-drag selects what is on screen; a right click copies it. The
  // selection is stored as screen-space coordinates, and both the highlight
  // and the text extraction read from the last rendered screen — so the copy
  // always matches exactly what is highlighted (wide runes included).

  startTextSelection(x, y) {
    this.textSelectionDragging = true
    this.textSelection = { startX: x, startY: y, endX: x, endY: y, text: '' }
  }

  updateTextSelection(x, y) {
    if (!this.textSelection) return false
    if (this.textSelection.endX === x && this.textSelection.endY === y) return false
    this.textSelection.endX = x
    this.textSelection.endY = y
    this.textSelection.text = this.selectionText()
    return true
  }

  clearTextSelection() {
    const had = this.textSelection !== null || this.textSelectionDragging
    this.textSelection = null
    this.textSelectionDragging = false
    return had
  }

  // The selection normalized to a reading-order rect: a row range plus the
  // column bounds of its top and bottom rows (middle rows span the full row).
  _selectionRect() {
    const sel = this.textSelection
    if (!sel) return null
    if (sel.startY === sel.endY) {
      return {
        y0: sel.startY, y1: sel.endY,
        topFrom: Math.min(sel.startX, sel.endX),
        bottomFrom: Math.min(sel.startX, sel.endX),
        bottomTo: Math.max(sel.startX, sel.endX),
      }
    }
    const down = sel.startY < sel.endY
    return {
      y0: down ? sel.startY : sel.endY,
      y1: down ? sel.endY : sel.startY,
      topFrom: down ? sel.startX : sel.endX,
      bottomFrom: 0,
      bottomTo: down ? sel.endX : sel.startX,
    }
  }

  // The plain text under the selection rect, taken from the last rendered
  // screen so it matches what the user sees. Wide-rune continuation cells
  // ('') are skipped; trailing fill spaces are trimmed per row. Bubble border
  // glyphs (│) are dropped so copying a message body yields the message, not
  // the frame; a space replaces each one to keep interior columns intact.
  selectionText() {
    const screen = this._lastScreen
    const rect = this._selectionRect()
    if (!screen || !rect) return ''
    const y0 = Math.max(0, Math.min(rect.y0, screen.rows - 1))
    const y1 = Math.max(0, Math.min(rect.y1, screen.rows - 1))
    const lines = []
    for (let y = y0; y <= y1; y++) {
      const row = screen.cells[y]
      if (!row) continue
      const from = y === y0 ? Math.max(0, rect.topFrom) : 0
      const to = y === y1 ? Math.min(rect.bottomTo, row.length - 1) : row.length - 1
      let out = ''
      for (let x = from; x <= to; x++) {
        const ch = row[x]?.ch
        if (!ch) continue
        out += ch === '│' ? ' ' : ch
      }
      lines.push(out.replace(/\s+$/, ''))
    }
    while (lines.length > 0 && lines[0] === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  // Highlight the selection rect. Applied after background normalization so
  // every cell has a style to merge into; skipped while an overlay (settings
  // / help) covers the screen.
  _paintTextSelection(screen) {
    if (!this.textSelection || this.overlay) return
    const rect = this._selectionRect()
    if (!rect) return
    const y0 = Math.max(0, Math.min(rect.y0, screen.rows - 1))
    const y1 = Math.max(0, Math.min(rect.y1, screen.rows - 1))
    for (let y = y0; y <= y1; y++) {
      const row = screen.cells[y]
      if (!row) continue
      const from = y === y0 ? Math.max(0, rect.topFrom) : 0
      const to = y === y1 ? Math.min(rect.bottomTo, row.length - 1) : row.length - 1
      for (let x = from; x <= to; x++) {
        const cell = row[x]
        if (!cell) continue
        cell.style = cell.style
          ? mergeStyle(cell.style, { bg: THEME.selection })
          : makeStyle({ bg: THEME.selection })
      }
    }
  }

  // ---- state mutations -------------------------------------------------

  setWelcome({ workingDirectory = '', gitBranch = '', model, provider } = {}) {
    this.titleScreen = true
    this.workingDirectory = workingDirectory
    this.gitBranch = gitBranch
    this.sessionId = ''
    // No active session: the top bar names the empty workspace instead of
    // leaking the previous session's title.
    this.title = 'New session'
    if (model !== undefined) this.model = model
    if (provider !== undefined) this.provider = provider
  }

  // Workspace of the session currently open. A resumed or forked session
  // carries its own header cwd, which need not be the process cwd, so the plugin
  // pushes it here whenever a session becomes current.
  setWorkspace({ workingDirectory, gitBranch } = {}) {
    if (workingDirectory !== undefined) this.workingDirectory = workingDirectory
    if (gitBranch !== undefined) this.gitBranch = gitBranch
  }

  setSession({ id, title, model, provider }) {
    if (id !== undefined) {
      this.sessionId = id
      if (id) this.titleScreen = false
    }
    if (title !== undefined) this.title = title
    if (model !== undefined) this.model = model
    if (provider !== undefined) this.provider = provider
  }

  setStatus(status) {
    this.status = status
  }

  // The reasoning-effort slider data: the current model's ACTUAL selectable
  // levels (in provider order, weakest -> strongest — a boolean-thinking model
  // exposes two, a full-range one exposes every level the provider advertises)
  // plus the selected id. `null` means the current model exposes no reasoning.
  setEffortSlider(slider) {
    this.effortSlider = slider
  }

  _effortIndex() {
    const slider = this.effortSlider
    if (!slider) return -1
    return Math.max(0, slider.levels.findIndex((level) => level.id === slider.current))
  }

  _effortLevel() {
    const slider = this.effortSlider
    if (!slider || slider.levels.length === 0) return null
    return slider.levels[this._effortIndex()] ?? null
  }

  // The animation/styling is reserved for the strongest level the model
  // actually exposes. A one-level model (e.g. Off-only, thinking disabled)
  // has no meaningful max and never animates.
  _effortAtMax() {
    const slider = this.effortSlider
    if (!slider || slider.levels.length <= 1) return false
    return this._effortIndex() === slider.levels.length - 1
  }

  // Whole-session figures (web stats strip port): turn/step counts, model and
  // tool wall time, TTFT and decode throughput, and the durable billing
  // buckets. `metrics` is the effective figure set — the profile's
  // `sessionStats` / `tokenUsage` projections where it serves them, the
  // plugin's own log fold elsewhere — so the strip and the details window never
  // care which side produced a number.
  setMetrics(metrics) {
    this.metrics = metrics
    this.usage = { input: metrics.uncachedInputTokens ?? 0, output: metrics.outputTokens ?? 0 }
  }

  // Everything the stats strip and the details window show, in one push: the
  // whole-log figures plus the token-meter context occupancy and composition.
  setStats({ stats = {}, pressure, breakdown } = {}) {
    this.setMetrics(stats)
    this.setContextMeter({ pressure, breakdown })
  }

  // Port of the web composer's ContextMeter data: the token-meter
  // `contextPressure` projection (current context length over the context
  // window limit) plus the heuristic `contextBreakdown` composition. The
  // numerator is `projectedTokens` (the provider sample carried over the
  // surface's movement since) so a compaction shows at once; it falls back to
  // the bare sample only for a projection that predates that field. Renders
  // nothing until the provider reports both a numerator and a capacity.
  setContextMeter(meter = {}) {
    const { pressure, breakdown } = meter ?? {}
    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
    if (usedTokens === undefined || pressure?.contextWindow === undefined) {
      this.contextMeter = null
      return
    }
    const partsTotal = breakdown?.systemTokens + breakdown?.toolsTokens + breakdown?.messageTokens
    this.contextMeter = {
      percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
      usedTokens,
      contextWindow: pressure.contextWindow,
      breakdown: breakdown && partsTotal > 0 ? breakdown : null,
    }
  }

  // The rail's GOAL section data: one normalized view of the harness's current
  // goal (the `goal` projection view, or `ctx.goals.get(agent)`), or null when
  // no goal is current. The projection carries the rounds as a sibling of
  // `goal`; the live service view spreads them flat — read both.
  setGoal(view) {
    const goal = view?.goal
    if (!goal || typeof goal.objective !== 'string' || goal.objective.trim() === '') {
      this.goal = null
      return
    }
    this.goal = {
      objective: goal.objective.trim(),
      phase: String(goal.phase ?? 'active'),
      blockedReason: goal.blockedReason && typeof goal.blockedReason.message === 'string' ? goal.blockedReason : null,
      roundsStarted: Number.isFinite(view.roundsStarted) ? view.roundsStarted : 0,
      maxGoalRounds: Number.isFinite(goal.maxGoalRounds) ? goal.maxGoalRounds : 0,
    }
  }

  // The rail's SUBAGENTS section data: the delegation rows of
  // `ctx.subagents.listDescendants()` (child rows plus diagnostic rows), or a
  // host without the subagent service leaving the section empty.
  setSubagents(rows) {
    this.subagents = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: String(row?.id ?? ''),
      label: typeof row?.label === 'string' && row.label !== '' ? row.label : String(row?.id ?? '').slice(0, 8),
      mode: row?.mode === 'continuable' ? 'continuable' : 'one-shot',
      activity: row?.activity === 'running' ? 'running' : 'idle',
      depth: Number.isFinite(row?.depth) ? row.depth : 1,
      readable: row?.kind !== 'diagnostic',
    }))
  }

  // Shift+Up/Down and the wheel over the rail move the rail's own window.
  // Render clamps the offset to the content, so this stays unbounded.
  scrollRail(delta) {
    this.railScroll = Math.max(0, this.railScroll + delta)
  }

  // The stats strip and the details window share one group vocabulary, ported
  // from the web chat stats strip. Every group drops out whole when it has no
  // data, and a session whose steps all settled without billing keeps its
  // counts without a zero-token group.
  _statsGroups() {
    const m = this.metrics ?? {}
    const groups = []
    if ((m.steps ?? 0) > 0) {
      groups.push(count(m.turns ?? 0, 'turn') + ' · ' + count(m.steps, 'step'))
      const durations = []
      if ((m.llmMs ?? 0) > 0) durations.push('LLM ' + formatDuration(m.llmMs))
      if ((m.toolMs ?? 0) > 0) durations.push('tools ' + formatDuration(m.toolMs))
      if (durations.length > 0) groups.push(durations.join(' · '))
      const speeds = []
      if ((m.ttftSteps ?? 0) > 0) speeds.push('TTFT avg ' + formatDuration(m.ttftMs / m.ttftSteps))
      if ((m.decodeMs ?? 0) > 0) speeds.push(formatMetric(m.decodeTokens / (m.decodeMs / 1000)) + ' tok/s')
      if (speeds.length > 0) groups.push(speeds.join(' · '))
    }
    if ((m.billedInputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0) {
      if (m.cacheHitRate !== undefined) groups.push('cache ' + m.cacheHitRate + '%')
      groups.push('in ' + formatTokens(m.billedInputTokens ?? 0) + ' · out ' + formatTokens(m.outputTokens ?? 0))
    }
    return groups
  }

  // The strip is hidden for a session with no closed step and no billed token
  // activity, exactly as the web strip renders nothing.
  _statsStripVisible() {
    return this._statsGroups().length > 0
  }

  // `menu` (optional) drives the settings dialog's left menu bar (Main / Model);
  // views without a menu (choice lists, session manager, model picker) render
  // the classic single-column layout.
  openSettings(items, { title = 'Settings', subtitle = '', menu = [], menuIndex = 0 } = {}) {
    this.settingsItems = items
    this.setSettingsSelection(0)
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsTitle = title
    this.settingsSubtitle = subtitle
    this.settingsMenu = Array.isArray(menu) ? menu : []
    this.settingsMenuIndex = this.settingsMenu.length > 0
      ? Math.max(0, Math.min(menuIndex, this.settingsMenu.length - 1))
      : 0
    this.settingsScrollOffset = 0
    this.overlay = 'settings'
  }

  openRewind({ items = [], restoreOptions = [], defaultIndex = null } = {}) {
    const last = Math.max(0, items.length - 1)
    this.rewind = {
      items,
      restoreOptions,
      selected: defaultIndex === null ? last : Math.max(0, Math.min(last, defaultIndex)),
      modeIndex: 0,
      scroll: 0,
      step: 'list',
      error: '',
      busy: false,
    }
    this.overlay = 'rewind'
    this._clampRewindScroll()
  }

  closeRewind() {
    if (this.overlay === 'rewind') this.overlay = null
    this.rewind = null
  }

  moveRewind(delta) {
    const picker = this.rewind
    if (!picker || picker.busy) return
    if (picker.step === 'restore') {
      const n = picker.restoreOptions.length
      if (n === 0) return
      picker.modeIndex = (picker.modeIndex + delta + n) % n
    } else {
      const n = picker.items.length
      if (n === 0) return
      picker.selected = Math.max(0, Math.min(n - 1, picker.selected + delta))
    }
    this._clampRewindScroll()
  }

  _clampRewindScroll() {
    const picker = this.rewind
    if (!picker) return
    const visible = 7
    const n = picker.step === 'restore' ? picker.restoreOptions.length : picker.items.length
    const sel = picker.step === 'restore' ? picker.modeIndex : picker.selected
    if (sel < picker.scroll) picker.scroll = sel
    if (sel >= picker.scroll + visible) picker.scroll = sel - visible + 1
    picker.scroll = Math.max(0, Math.min(picker.scroll, Math.max(0, n - visible)))
  }

  // Point the selection at an item index, skipping group headers (kind
  // 'header' rows are never selectable): a landing on a header moves down to
  // the next real item, or back to the first selectable one.
  setSettingsSelection(index) {
    const items = this.settingsItems
    if (items.length === 0) {
      this.settingsSelection = 0
      return
    }
    let target = Math.max(0, Math.min(index, items.length - 1))
    while (target < items.length && items[target].kind === 'header') target++
    if (target >= items.length) {
      const first = items.findIndex((item) => item.kind !== 'header')
      target = first < 0 ? 0 : first
    }
    this.settingsSelection = target
  }

  // Move the selection by one row in either direction, wrapping around and
  // stepping over group headers so it always rests on a selectable item.
  moveSettingsSelection(delta) {
    const count = this.settingsItems.length
    if (count === 0) return
    let index = this.settingsSelection
    let steps = count
    while (steps-- > 0) {
      index = (index + delta + count) % count
      if (this.settingsItems[index].kind !== 'header') break
    }
    this.settingsSelection = index
  }

  addSystem(text, level = 'info') {
    this.detachInboxBlock()
    this.blocks.push(makeBlock('system', { text, level }))
    this._maybeFollow()
  }

  addNote(text, label = 'context') {
    this.detachInboxBlock()
    this.blocks.push(makeBlock('note', { text, label, collapsed: true }))
    this.scroll = 0
  }

  addUser(text, { steering = false, images } = {}) {
    this.detachInboxBlock()
    const block = makeBlock('user', { text, steering })
    if (images?.length) block.images = images
    this.blocks.push(block)
    this.assistantHeaderPending = true
    this.scroll = 0
  }

  // Attach image sources to the most recent user block (an event-side image
  // that the optimistic submit could not have shown, e.g. queued from Web UI).
  attachImagesToLastUser(images) {
    if (!images?.length) return false
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind !== 'user') continue
      if (b.images?.length) return false
      b.images = images
      b.rev = (b.rev ?? 0) + 1
      return true
    }
    return false
  }

  // Image render options for the host: the probed protocol, the size budget
  // (cells), the probed cell pixel size, and the canvas background the
  // renderer composes transparent pixels over.
  imageRenderOptions() {
    return {
      protocol: this.graphicsProtocol,
      maxCellsW: Math.max(8, Math.min(72, this._lastTransWidth - 6)),
      maxCellsH: this.imageMaxRows,
      cellW: this.imageCellW,
      cellH: this.imageCellH,
      bgHex: THEME.background,
    }
  }

  // A render landed for an image key: cache it and refresh every block that
  // shows the source so the next frame picks the finished render up. The block
  // set survives the bump — a result can be replaced (protocol upgrade after
  // caps probing, width re-render) and the replacement must reach the same
  // blocks; the map is cleared with the line cache in resetView.
  setImageResult(key, result) {
    this._imageResults.set(key, result)
    const blocks = this._imageBlocks.get(key)
    if (blocks) {
      for (const b of blocks) b.rev = (b.rev ?? 0) + 1
    }
  }

  // The payload for an image whose top rows scrolled above the window: the same
  // source rendered with cropCells set, so the band left on screen is encoded
  // at the height it occupies. The host treats it like any other image, and the
  // result lands under the variant key — nothing in the layout reads it, the
  // paint pass only needs the payload.
  _requestImageCrop(key, clip) {
    const cropKey = key + '\u0000' + clip
    let live = this._imageCrops.get(key)
    if (!live) {
      live = new Set()
      this._imageCrops.set(key, live)
    }
    if (live.has(cropKey)) return
    const src = this._imageSources.get(key)
    if (!src) return
    live.add(cropKey)
    this.onImageRequest?.({ ...src, key: cropKey, cropCells: clip })
  }

  // Lines for one image source: a loading placeholder while the host renders,
  // styled halfblock rows for the text fallback, or reserved annotation rows
  // for a graphics protocol (render() registers them on the Screen). Rows come
  // back unprefixed — the surrounding block (transcript, tool row) supplies
  // its own gutter.
  _imageLines(src, block, width, out) {
    const key = src.key
    // Kept for the cropped variants below: an image whose top rows scrolled out
    // of the window is re-rendered from the same source, and the host only
    // ever sees sources, never the blocks that resolved them.
    this._imageSources.set(key, src)
    // Chip mode: the settings turned pixels off entirely — images stay
    // placeholder chips and the pipeline never runs.
    if (this.imagePixels === false) {
      out.push({ segs: [{ text: '🖼 image attachment', style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
      return
    }
    let result = this._imageResults.get(key)
    if (!result) {
      result = { state: 'loading' }
      this._imageResults.set(key, result)
    }
    // Remember which blocks show this key so setImageResult can bump their
    // rev — without a bump the per-block line cache would keep showing the
    // placeholder after the render landed.
    let blocks = this._imageBlocks.get(key)
    if (!blocks) {
      blocks = new Set()
      this._imageBlocks.set(key, blocks)
    }
    blocks.add(block)
    if (result.state === 'loading') {
      if (!this._imageRequested.has(key)) {
        this._imageRequested.add(key)
        this.onImageRequest?.(src)
      }
      out.push({ segs: [{ text: '⏳ rendering image…', style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
      return
    }
    if (result.state === 'error') {
      out.push({ segs: [{ text: '⚠ image render failed · ' + truncateWidth(result.error ?? 'unknown', Math.max(8, width - 28)), style: makeStyle({ fg: THEME.error }) }] })
      return
    }
    if (result.protocol === 'halfblock') {
      for (const row of result.segLines ?? []) {
        out.push({ segs: row })
      }
      return
    }
    // Every reserved row carries the whole placement so a row that is drawn
    // without the group's first row above it still knows the x, the width, the
    // height it belongs to and which group it belongs to; `start` is the group's
    // own first row, re-anchored to the block's lines by _ensureBlockLines.
    const gid = ++this._imageGroupSeq
    const start = out.length
    for (let i = 0; i < (result.cellsH ?? 1); i++) {
      out.push({ segs: [], image: { key, gid, x: 2, cellsW: result.cellsW ?? 1, cellsH: result.cellsH ?? 1, top: i === 0, start } })
    }
  }

  // Markdown lines that may carry media: ```mermaid fences and standalone
  // images become mermaid/image pipeline lines when the result can render,
  // falling back to the inline renderings otherwise.
  _markdownLines(text, block, width, out) {
    const hooks = { mermaid: true, image: true }
    for (const line of renderMarkdown(text, THEME, width, hooks)) {
      if (line && line.mermaid !== undefined) this._mermaidLines(line.mermaid, block, width, out)
      else if (line && line.image !== undefined) this._markdownImageLines(line.image, block, width, out)
      else out.push({ segs: line })
    }
  }

  // A ```mermaid fence: native box-drawing art first, then the image provider
  // chain (local mmdc, then mermaid.ink) for grammars the engine does not
  // draw, and the highlighted source when mermaid rendering is off or nothing
  // else answers.
  _mermaidLines(code, block, width, out) {
    const key = 'mermaid:' + sha16(Buffer.from(code, 'utf8'))
    const off = this.mermaidMode === 'off'

    if (!off && this._mermaidEngine === undefined) {
      // The engine loads on the first fence and arrives after the paint that
      // shows the placeholder below. Until it settles there is no art to draw
      // and no image to ask for either: firing a network render for a diagram
      // the engine is about to draw natively would leak the diagram text to
      // mermaid.ink for nothing.
      this._mermaidEngine = 'loading'
      loadMermaidEngine().then((engine) => this._mermaidEngineSettled(engine))
    }

    const engine = this._mermaidEngine
    if (!off) {
      if (engine === 'loading') {
        out.push({ segs: [{ text: '⏳ rendering mermaid diagram…', style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
        return
      }
      if (engine) {
        const art = renderMermaidArt(engine, code)
        if (art) {
          const budget = width - MERMAID_INDENT_WIDTH - MERMAID_MARGIN
          if (art.width <= budget) {
            for (const segs of paintMermaidArt(art, THEME, MERMAID_INDENT)) out.push({ segs })
            return
          }
          // Real art, wider than this pane: name what it needs and show the
          // source. A raster of the same diagram reads worse, and sending the
          // source to mermaid.ink to draw what the engine already drew leaks
          // it for nothing.
          out.push({ segs: [{ text: `↔ mermaid diagram needs ${art.width} columns, this pane has ${Math.max(0, budget)}`, style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
          for (const line of renderMarkdown('```mermaid\n' + code + '\n```', THEME, width)) {
            out.push({ segs: line })
          }
          return
        }
      }
    }

    // Off, or a grammar the engine does not draw: the provider chain draws it
    // as an image unless the setting says a diagram stays its own source.
    if (off) {
      for (const line of renderMarkdown('```mermaid\n' + code + '\n```', THEME, width)) {
        out.push({ segs: line })
      }
      return
    }
    let result = this._mermaidResults.get(key)
    if (!result) {
      result = { state: 'loading' }
      this._mermaidResults.set(key, result)
    }
    this._trackMediaBlock(this._mermaidBlocks, key, block)
    if (result.state === 'loading') {
      if (!this._mermaidRequested.has(key)) {
        this._mermaidRequested.add(key)
        this.onMermaidRequest?.(code, key)
      }
      out.push({ segs: [{ text: '⏳ rendering mermaid diagram…', style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
      return
    }
    if (result.state === 'done') {
      this._imageLines({ key: result.imageKey }, block, width, out)
      return
    }
    // fallback / error: the source, highlighted.
    for (const line of renderMarkdown('```mermaid\n' + code + '\n```', THEME, width)) {
      out.push({ segs: line })
    }
  }

  // The lazy engine import resolved (engine, or null when missing/broken).
  // The first fence painted its placeholder into the per-block line cache
  // while the import was in flight, and nothing about that paint bumps the
  // cache key (rev + width) — a repaint alone would reuse the cached
  // "rendering…" rows forever, until a resize happened to change the width.
  // The settle therefore invalidates the cache before asking for a repaint.
  _mermaidEngineSettled(engine) {
    this._mermaidEngine = engine
    this._blockLineCache.clear()
    this._needsRepaint?.()
  }

  // A standalone markdown image: remote URLs go through the image pipeline,
  // data URLs decode to bytes locally; anything else keeps the alt text.
  _markdownImageLines({ url, alt }, block, width, out) {
    const text = String(url ?? '')
    if (/^data:image\//i.test(text)) {
      const decoded = decodeDataUrl(text)
      if (decoded) {
        this._imageLines({ kind: 'bytes', key: sha16(decoded.data), bytes: decoded.data }, block, width, out)
        return
      }
    } else if (/^https?:\/\//i.test(text)) {
      this._imageLines({ kind: 'url', key: 'url:' + sha16(Buffer.from(text, 'utf8')), url: text }, block, width, out)
      return
    }
    out.push({ segs: [{ text: '🖼 ' + (alt || 'image'), style: makeStyle({ fg: THEME.textMuted, italic: true }) }] })
  }

  _trackMediaBlock(map, key, block) {
    let blocks = map.get(key)
    if (!blocks) {
      blocks = new Set()
      map.set(key, blocks)
    }
    blocks.add(block)
  }

  // A mermaid provider result landed (done with an image key, or fallback).
  setMermaidResult(key, result) {
    this._mermaidResults.set(key, result)
    const blocks = this._mermaidBlocks.get(key)
    if (blocks) {
      for (const b of blocks) b.rev = (b.rev ?? 0) + 1
    }
  }

  startAssistant() {
    this.detachInboxBlock()
    const showHeader = this.assistantHeaderPending
    this.assistantHeaderPending = false
    this.blocks.push(makeBlock('assistant', { text: '', reasoning: '', streaming: true, showHeader }))
    this.scroll = 0
  }

  // Append a stream chunk to the live assistant block.
  streamChunk(chunk) {
    let last = this.blocks[this.blocks.length - 1]
    if (!last || last.kind !== 'assistant' || !last.streaming) {
      this.startAssistant()
      last = this.blocks[this.blocks.length - 1]
    }
    if (chunk.type === 'text-delta') last.text += chunk.text
    else if (chunk.type === 'reasoning-delta') last.reasoning += chunk.text
    last.rev++
    this.scroll = 0
  }

  finalizeAssistant() {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'assistant' && b.streaming) {
        b.streaming = false
        b.rev++
        // Thinking is collapsed by default once it has finished streaming.
        if (b.reasoning && b.thinkingCollapsed === undefined) b.thinkingCollapsed = true
        if (b.text === '' && b.reasoning === '') this.blocks.splice(i, 1)
        break
      }
    }
  }

  // Ensure an assistant block exists (e.g. replay); returns it.
  ensureAssistantBlock(time) {
    this.detachInboxBlock()
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === 'assistant') return last
    const showHeader = this.assistantHeaderPending
    this.assistantHeaderPending = false
    const b = makeBlock('assistant', { text: '', reasoning: '', streaming: false, time, showHeader })
    this.blocks.push(b)
    return b
  }

  setAssistantText(text, time) {
    const b = this.ensureAssistantBlock(time)
    b.text = text
    b.streaming = false
    b.rev++
    if (b.reasoning && b.thinkingCollapsed === undefined) b.thinkingCollapsed = true
    b.time = time ?? b.time
    this.scroll = 0
  }

  startTool({ callId, name, args }) {
    this.detachInboxBlock()
    const b = makeBlock('tool', { callId, name, args, status: 'running', result: '' })
    this.blocks.push(b)
    this.scroll = 0
    return b
  }

  updateTool(callId, patch) {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind === 'tool' && b.callId === callId) {
        Object.assign(b, patch)
        b.rev++
        this.scroll = 0
        return b
      }
    }
    return undefined
  }

  // Remove the parked pending-inbox block. Every append path calls this before
  // pushing, because pending input is always the newest thing in the
  // transcript: the block is re-derived right after the new entry lands, so a
  // message never renders below it.
  detachInboxBlock() {
    if (!this.inboxBlock) return
    const index = this.blocks.indexOf(this.inboxBlock)
    if (index >= 0) this.blocks.splice(index, 1)
  }

  // ---- durable agent inbox (dsh 0.1.5) ------------------------------------
  // Every mutation of the agent's pending input is logged as one normalized
  // `agent/inbox/spliced` event over the standard splice coordinates
  // (insert / edit / remove / claim / cancel), so folding the log reproduces
  // the pending lists exactly. The reducer mirrors the host projector: the
  // splice is applied to `target`'s list, and bounds are validated the same
  // way (a malformed splice is ignored rather than corrupting the view).

  // Drop all inbox state (new session / replay restart).
  resetInbox() {
    this.inbox = { nextTurn: [], nextStep: [] }
    this._inboxClaimed = new Set()
    this.inboxBlock = null
    this.inboxExpanded = false
    this.systemPromptText = ''
    this.systemPromptBlock = null
  }

  _spliceList(list, start, removedCount, inserted) {
    if (!Number.isSafeInteger(start) || start < 0 || start > list.length) return null
    if (!Number.isSafeInteger(removedCount) || removedCount < 0) return null
    if (start + removedCount > list.length) return null
    const next = list.slice()
    next.splice(start, removedCount, ...inserted)
    return next
  }

  // Apply one `agent/inbox/spliced` payload. Returns true when the splice was
  // structurally valid. A claim is a pure removal (no `outcome`); an ordinary
  // removal carries `outcome: 'canceled'`. A turn-boundary claim drains
  // `next-step` first and then one `next-turn` entry, so its ids become the
  // current claim.
  applyInboxSplice(data) {
    if (!data || (data.target !== 'next-turn' && data.target !== 'next-step')) return false
    const inserted = (Array.isArray(data.inserted) ? data.inserted : []).map((message) => ({
      id: String(message?.id ?? ''),
      text: inboxMessageText(message),
    }))
    const removedCount = Number.isInteger(data.removedCount) ? data.removedCount : 0
    const key = data.target === 'next-turn' ? 'nextTurn' : 'nextStep'
    const next = this._spliceList(this.inbox[key], data.start ?? 0, removedCount, inserted)
    if (next === null) return false
    // Classify a later `user/message` as steering: only the current claim can
    // own it. An insertion cancels a matching pending claim identity.
    const claimed = new Set(this._inboxClaimed)
    for (const message of inserted) claimed.delete(message.id)
    if (removedCount > 0 && data.outcome !== 'canceled') {
      for (const removed of this.inbox[key].slice(data.start ?? 0, (data.start ?? 0) + removedCount)) {
        claimed.add(removed.id)
      }
    }
    this._inboxClaimed = claimed
    this.inbox = { ...this.inbox, [key]: next }
    return true
  }

  // Take the current claim classification for one `user/message` id. True only
  // for a message the loop claimed from the inbox rather than a fresh turn.
  consumeClaimed(id) {
    return this._inboxClaimed.delete(String(id))
  }

  // Fold the pending lists into the parked transcript block. The block lives at
  // the end of the transcript (pending input is always the newest thing) and is
  // dropped entirely once nothing is pending, so a settled session carries no
  // leftover chrome. Idempotent: re-deriving an unchanged block mutates it in
  // place, so a repaint never duplicates it.
  updateInboxBlock() {
    this.detachInboxBlock()
    const nextStep = this.inbox.nextStep
    const nextTurn = this.inbox.nextTurn
    const total = nextStep.length + nextTurn.length
    if (total === 0) {
      this.inboxBlock = null
      return
    }
    if (this.inboxBlock) {
      this.inboxBlock.nextStep = nextStep
      this.inboxBlock.nextTurn = nextTurn
      this.inboxBlock.expanded = this.inboxExpanded
      this.inboxBlock.rev++
    } else {
      this.inboxBlock = makeBlock('inbox', { nextStep, nextTurn, expanded: this.inboxExpanded })
    }
    this.blocks.push(this.inboxBlock)
  }

  // Toggle the pending-inbox box between collapsed (counts only) and expanded.
  toggleInbox(block) {
    if (!block || block.kind !== 'inbox') return
    this.inboxExpanded = block.expanded !== true
    block.expanded = this.inboxExpanded
    block.rev++
  }

  // ---- system prompt (dsh 0.1.5 session format V3) -----------------------
  // V3 keeps the system prompt in the log: the first step carries an empty
  // `system/message` head and every later request header whose prompt differs
  // inserts a replacement immediately before it. Rendering those as a
  // collapsible box keeps the prompt visible without putting it in the
  // assistant's transcript. Identical text is not re-boxed, so a re-stated
  // prompt renders once.
  setSystemPrompt(text) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return false
    if (body === this.systemPromptText && this.systemPromptBlock) return false
    this.systemPromptText = body
    if (this.systemPromptBlock) {
      this.systemPromptBlock.text = body
      this.systemPromptBlock.rev++
    } else {
      this.detachInboxBlock()
      this.systemPromptBlock = makeBlock('sysnote', { text: body, collapsed: true })
      this.blocks.push(this.systemPromptBlock)
    }
    return true
  }

  setTodo(todos) {
    this.detachInboxBlock()
    const existing = this.blocks.find((b) => b.kind === 'todo')
    if (existing) {
      existing.todos = todos
      existing.rev++
    } else {
      this.blocks.push(makeBlock('todo', { todos }))
    }
    this.scroll = 0
  }

  resetView() {
    this.blocks = []
    this.usage = { input: 0, output: 0 }
    this.metrics = {}
    this.scroll = 0
    this.goal = null
    this.subagents = []
    this.railScroll = 0
    this._blockLineCache.clear()
    this._imageResults.clear()
    this._imageBlocks.clear()
    this._imageRequested.clear()
    this._imageSources.clear()
    this._imageCrops.clear()
    this._imageCropsPrev = new Set()
    this._mermaidResults.clear()
    this._mermaidBlocks.clear()
    this._mermaidRequested.clear()
    this.resetInbox()
  }

  // Toggle a completed thinking box between collapsed and expanded. Thinking
  // stays collapsed while it is still streaming.
  toggleThinking(block) {
    if (!block || block.kind !== 'assistant' || !block.reasoning || block.streaming) return
    block.thinkingCollapsed = block.thinkingCollapsed !== true
    block.rev++
  }

  // Toggle a tool activity card between the one-line summary and the full
  // result. A running tool has no result to show yet and stays collapsed.
  toggleTool(block) {
    if (!block || block.kind !== 'tool' || block.status === 'running') return
    block.expanded = block.expanded !== true
    block.rev++
  }

  // Toggle a collapsible context box (system-reminder / compaction / system
  // prompt / pending inbox) between collapsed and expanded. The pending-inbox
  // box keeps its expansion on the App (it is rebuilt as splices arrive), so
  // it has its own toggle.
  toggleNote(block) {
    if (!block) return
    if (block.kind === 'inbox') return this.toggleInbox(block)
    if (block.kind !== 'note' && block.kind !== 'sysnote') return
    block.collapsed = block.collapsed !== true
    block.rev++
  }

  // Current flowing-spinner frame (time-based so it animates across paints
  // without any per-frame state).
  animChar(interval = 80) {
    return SPINNER[Math.floor(Date.now() / interval) % SPINNER.length]
  }

  // Style for one cell of the composer's flowing frame: while a turn is
  // running, gold dashes with a bright head sweep clockwise around the
  // border (marching ants) instead of a flat yellow frame. `pos` is the
  // cell's distance along the perimeter from the top-left corner - top edge
  // left -> right, right edge downward, bottom edge right -> left, left
  // edge upward. `phase` advances with time (like the spinners) so the
  // pattern flows without any per-frame state.
  _flowBorderStyle(pos, phase) {
    if (!flowFramePalette) {
      flowFramePalette = {
        head: makeStyle({ fg: mixColor(THEME.warning, '#ffffff', 0.5) }),
        body: makeStyle({ fg: THEME.warning }),
        rest: makeStyle({ fg: THEME.warningDim }),
      }
    }
    const d = (((pos - phase) % 10) + 10) % 10
    return d === 0 ? flowFramePalette.head : d < 3 ? flowFramePalette.body : flowFramePalette.rest
  }

  // True while anything is still animating: a streaming turn or a running
  // tool (read/write/bash/...). The UI loop keeps repainting while this is
  // true so spinners keep flowing even when no events are arriving.
  hasAnimation() {
    if (this.status === 'running') return true
    // The settings update page keeps repainting while a registry check or
    // install is in flight so its subtitle spinner keeps flowing.
    if (this.settingsBusy) return true
    // The max effort effect keeps flowing even after the slider is closed —
    // the composer's top-right effort label stays animated at the strongest
    // level.
    if (this.effortSlider && this._effortAtMax()) return true
    for (const block of this.blocks) {
      if (block.kind === 'assistant' && block.streaming) return true
      if (block.kind === 'tool' && block.status === 'running') return true
    }
    return false
  }


  scrollTranscript(delta) {
    const layout = this._layout()
    const width = layout.borderX - layout.sidebarW - (layout.sidebarW > 0 ? 1 : 0)
    const maxScroll = Math.max(0, this._transcriptTotal(width) - layout.transcriptH)
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta))
  }

  scrollSettingsWindow(delta) {
    // Scroll the settings window by moving the virtual scroll offset.
    // The selection stays in the same place; the window contents scroll up/down.
    if (!this.settingsScrollOffset) this.settingsScrollOffset = 0
    this.settingsScrollOffset = Math.max(0, this.settingsScrollOffset + delta)
  }

  _maybeFollow() {
    // Only auto-follow when the user has not scrolled up.
    // (Appended content while scroll === 0 keeps following; scroll > 0 stays put.)
  }

  showToast(text, level = 'info') {
    this.toast = { text, level }
    if (this._toastTimer) clearTimeout(this._toastTimer)
    this._toastTimer = null
    // Auto-dismiss only makes sense when we can repaint to clear it; in
    // headless/test use (no term.paint) the toast stays for the caller to
    // inspect.
    if (!this.terminal || typeof this.terminal.paint !== 'function') return
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null
      if (this.toast) {
        this.toast = null
        if (this.terminal.started) this.terminal.paint(this.render())
      }
    }, 2000)
  }

  // ---- layout ----------------------------------------------------------

  _layout() {
    const cols = this.terminal.cols
    const rows = this.terminal.rows
    const headerH = 1
    const statusH = 1
    const sliderH = this.effortSliderVisible && this.effortSlider ? 1 : 0
    // OpenCode-style: very narrow sidebar (max 12 cols), auto-hide aggressively
    // Prioritize conversation view - sidebar only shows when explicitly toggled AND space allows
    let sidebarW = this.sidebarVisible && cols >= 110 ? Math.min(12, Math.floor(cols / 9)) : 0
    if (cols - sidebarW < 75) sidebarW = 0
    // The right status rail claims one border column plus RAIL_WIDTH content
    // columns; `borderX` is the main area's exclusive right edge (the border
    // glyph's own column). Narrow windows keep the single-column layout.
    const railW = cols >= RAIL_MIN_COLS ? RAIL_WIDTH : 0
    const borderX = railW > 0 ? cols - railW - 1 : cols
    const composerWidth = Math.max(20, borderX - sidebarW - 6)
    const visual = inputRows(this.inputText, this.inputCursor, composerWidth)
    const suggestions = this.inputText.startsWith('/') && !this.inputText.includes(' ') ? Math.min(COMMAND_HINTS.length, COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText)).length) : 0
    const imageHintH = this.inputImages.length > 0 ? 1 : 0
    // The stats strip takes one row directly above the composer, the seat the
    // web chat stats line occupies in its composer dock. A session with nothing
    // to report keeps the row for the transcript, and the rail (which carries
    // the same figures expanded) drops it.
    const statsH = railW > 0 ? 0 : this._statsStripVisible() ? 1 : 0
    // The composer's content rows. An approval prompt replaces the input text
    // and needs more rows than it: the protocol requires the action, summary,
    // origin and details to be shown. Its height comes from the same helper the
    // painter uses, so the box is exactly as tall as its content, and never so
    // tall that the transcript loses its last row.
    const maxComposerRows = Math.max(1, rows - headerH - statusH - sliderH - imageHintH - statsH - suggestions - 2)
    let inputRowsVisible
    if (this.pendingApproval) {
      const approval = this._approvalLines(composerTextWidth(cols, sidebarW, railW), maxComposerRows)
      inputRowsVisible = Math.max(1, Math.min(approval.length, maxComposerRows))
    } else {
      inputRowsVisible = Math.min(Math.max(1, visual.rows.length), rows >= 28 ? 6 : 3)
    }
    const inputH = inputRowsVisible + 2 + suggestions
    const transcriptTop = headerH
    const transcriptBottom = rows - inputH - statusH - sliderH - imageHintH - statsH
    const transcriptH = Math.max(1, transcriptBottom - transcriptTop)
    return { cols, rows, headerH, inputH, inputRowsVisible, suggestions, imageHintH, statsH, statusH, sliderH, transcriptTop, transcriptBottom, transcriptH, sidebarW, railW, borderX, composerWidth, visual }
  }

  // ---- block -> lines --------------------------------------------------

  _blockLines(block, width) {
    const t = THEME
    const out = []
    switch (block.kind) {
      case 'user': {
        // A pointer marks your turn and the text hangs under it — no frame, no
        // fill, so a long prompt never has to be measured against a border.
        // The timestamp trails the last line (or its own row when the last line
        // is full) so a steering message still reads as its own event.
        const pointerW = 4
        const hang = ' '.repeat(pointerW)
        const pointer = { text: '  ❯ ', style: makeStyle({ fg: t.userPointer, bold: true }) }
        const lines = renderMarkdown(block.text, t, Math.max(8, width - pointerW))
        if (lines.length === 0) lines.push([])
        const tail = []
        if (block.steering) tail.push({ text: ' ⟲ steering', style: makeStyle({ fg: t.steering, bold: true }) })
        tail.push({ text: ' · ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) })
        const last = lines[lines.length - 1]
        const tailW = tail.reduce((n, s) => n + displayWidth(s.text), 0)
        const lastW = last.reduce((n, s) => n + displayWidth(s.text), 0)
        // The text hangs at `pointerW`, so the tail only joins it when it fits
        // in what is left of the row *after* that indent.
        if (lastW + tailW <= width - pointerW) last.push(...tail)
        else lines.push([{ text: hang, style: null }, ...tail])
        for (let i = 0; i < lines.length; i++) {
          out.push({ segs: i === 0 ? [pointer, ...lines[i]] : [{ text: hang, style: null }, ...lines[i]] })
        }
        for (const src of block.images ?? []) this._imageLines(src, block, width, out)
        out.push({ segs: [] })
        break
      }
      case 'assistant': {
        // A message that only issued tool calls has nothing to say on its own:
        // its activity lives in the tool rows below, and drawing an empty frame
        // anyway is what produced the empty bubbles in long tool turns. The
        // turn's `dsh · time` header must not be swallowed here — pass it to
        // the next assistant block if there is one.
        if (block.text === '' && !block.reasoning) {
          if (block.showHeader === true) {
            // The next assistant message can sit behind this one's tool rows —
            // scan past them.
            let j = this.blocks.indexOf(block) + 1
            while (j < this.blocks.length && this.blocks[j].kind === 'tool') j++
            const next = this.blocks[j]
            if (next?.kind === 'assistant' && next.showHeader === false) {
              next.showHeader = true
              next.rev = (next.rev ?? 0) + 1
            }
            block.showHeader = false
          }
          break
        }
        // Thinking is one flat row: collapsed it names itself, expanded the
        // body hangs under it in muted italics. No frame and no full-width
        // band — the boxed shapes measured their own borders and drifted on
        // wide runes, and the band read as a bar across the transcript.
        if (block.reasoning) {
          const streaming = block.streaming === true
          const collapsed = block.thinkingCollapsed === true || streaming
          const hint = streaming ? ' · streaming…' : (collapsed ? ' · click to expand' : ' · click to collapse')
          // While streaming, a flowing spinner leads the marker (replaced at
          // draw time so the cached lines can stay static between frames).
          const marker = streaming
            ? { text: '⠿', style: makeStyle({ fg: t.primary, bold: true }), anim: 'spinner' }
            : { text: collapsed ? '▸' : '▾', style: makeStyle({ fg: t.thinking, bold: true }) }
          const body = []
          if (!collapsed) {
            for (const line of renderMarkdown(block.reasoning, t, Math.max(8, width - 6))) {
              body.push(line.map((s) => ({ ...s, style: mergeStyle(s.style, { fg: t.thinking, italic: true }) })))
            }
          }
          out.push(...flatRows('thinking', block, [
            { text: '  ', style: null },
            marker,
            { text: ' thinking' + hint, style: makeStyle({ fg: t.thinking, bold: true }) },
          ], body, 4, width))
          // A blank line separates the reasoning from the visible answer so
          // the two never run together.
          if (block.text) out.push({ segs: [] })
        }
        let text = block.text
        if (block.streaming) text += '▍'
        // One header per request: a turn split by tool calls renders one
        // answer per block, and only the first announces `dsh · time`.
        if (block.showHeader !== false) {
          out.push({
            segs: [
              { text: '  ', style: null },
              { text: 'dsh', style: makeStyle({ fg: t.assistantLabel, bold: true }) },
              { text: ' · ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) },
            ],
          })
        }
        if (text) {
          const body = []
          this._markdownLines(text, block, Math.max(8, width - 2), body)
          // The answer hangs at the same two columns as its header; a media row
          // (mermaid art, a reserved image slab) already carries its own x
          // offset, so it passes through untouched.
          for (const line of body) {
            if (line.image) {
              out.push(line)
              continue
            }
            out.push({ segs: [{ text: '  ', style: null }, ...(line.segs ?? [])] })
          }
        }
        for (const src of block.images ?? []) this._imageLines(src, block, width, out)
        out.push({ segs: [] })
        break
      }
      case 'tool': {
        // OpenCode-style activity row: a status marker, the action in its own
        // accent, and the target it acts on (the path read, the command run)
        // in muted text. Collapsed it is exactly that one row; expanded the
        // result hangs under a ⎿ gutter. The whole block is a click target —
        // a collapsed row hides its result precisely so a long turn of tool
        // calls stays scannable, and one click brings the details back.
        const running = block.status === 'running'
        const expanded = block.expanded === true
        const accent = toolAccent(block.name, t)
        const statusColor = running ? t.warning : block.status === 'error' ? t.error : t.success
        const marker = running
          ? { text: '⠿', style: makeStyle({ fg: statusColor, bold: true }), anim: 'spinner' }
          : { text: block.status === 'error' ? '✗' : '✓', style: makeStyle({ fg: statusColor, bold: true }) }
        const summary = toolSummary(block.name, block.args)
        const cut = summary.indexOf(' ')
        const verb = cut < 0 ? summary : summary.slice(0, cut)
        const rawTarget = cut < 0 ? '' : summary.slice(cut + 1)
        const hint = running ? '' : expanded ? '  · click to collapse' : '  · click to expand'
        const budget = Math.max(6, width - 7 - displayWidth(verb) - displayWidth(hint))
        const target = truncateWidth(rawTarget, budget)
        out.push({
          segs: [
            { text: '   ', style: null },
            marker,
            { text: ' ', style: null },
            { text: verb, style: makeStyle({ fg: accent, bold: true }) },
            ...(target ? [{ text: '  ' + target, style: makeStyle({ fg: t.textMuted }) }] : []),
            ...(hint ? [{ text: hint, style: makeStyle({ fg: t.textMuted, dim: true }) }] : []),
          ],
          tool: { block },
        })
        // Tool-result images (screenshots, generated pictures) render in full
        // only while expanded — the collapse is a text-economy rule, not a
        // media one.
        if (expanded) {
          const cap = 400
          const resultLines = renderMarkdown(block.result ?? '', t, Math.max(8, width - 8))
          const shown = Math.min(resultLines.length, cap)
          for (let i = 0; i < shown; i++) {
            out.push({
              segs: [
                { text: '   ', style: null },
                ...(i === 0
                  ? [{ text: '⎿', style: makeStyle({ fg: t.textMuted }) }, { text: ' ', style: null }]
                  : [{ text: '  ', style: null }]),
                ...resultLines[i].map((s) => ({ ...s, style: makeStyle({ fg: t.text }) })),
              ],
              tool: { block },
            })
          }
          if (resultLines.length > cap) {
            out.push({
              segs: [{ text: '     … ' + (resultLines.length - cap) + ' more lines', style: makeStyle({ fg: t.textMuted, dim: true }) }],
              tool: { block },
            })
          }
          const from = out.length
          for (const src of block.images ?? []) this._imageLines(src, block, width, out)
          for (let i = from; i < out.length; i++) out[i].tool = { block }
        }
        out.push({ segs: [] })
        break
      }
      case 'todo': {
        out.push({ segs: [{ text: '  tasks', style: makeStyle({ fg: t.info, bold: true }) }] })
        for (const item of block.todos ?? []) {
          const mark = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '□'
          const color = item.status === 'completed' ? t.success : item.status === 'in_progress' ? t.warning : t.textMuted
          // Item text is model-authored and arbitrarily long: truncate it to the
          // row so a long item cannot paint past the transcript edge. Screen.text
          // clips per cell, but keeping the row inside its width is what makes
          // the renderer's width contract true for every block.
          const text = truncateWidth(String(item.content ?? ''), Math.max(1, width - 4))
          out.push({ segs: [{ text: '  ' + mark + ' ', style: makeStyle({ fg: color }) },
            { text, style: makeStyle({ fg: t.text }) }] })
        }
        out.push({ segs: [] })
        break
      }
      case 'note': {
        // Context notes (system-reminder / compaction): one flat marker row
        // naming the label, the body hanging under it in the label's own
        // color, collapsed by default. Whole block clickable to toggle.
        const fg = block.label === 'compaction' ? t.compaction : t.reminder
        const collapsed = block.collapsed === true
        const hint = collapsed ? ' · click to expand' : ' · click to collapse'
        const body = []
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, Math.max(8, width - 6))) {
            body.push(line.map((s) => ({ ...s, style: mergeStyle(s.style, { fg }) })))
          }
        }
        out.push(...flatRows('note', block, [
          { text: '  ', style: null },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg, bold: true }) },
          { text: ' ' + block.label + hint, style: makeStyle({ fg, bold: true }) },
        ], body, 4, width))
        out.push({ segs: [] })
        break
      }
      case 'system': {
        const color = block.level === 'error' ? t.error : block.level === 'warn' ? t.warning : t.textMuted
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push({ segs: [{ text: '  ', style: null }, ...line.map((s) => ({ ...s, style: makeStyle({ fg: color, italic: true }) }))] })
        }
        out.push({ segs: [] })
        break
      }
      case 'sysnote': {
        // The session's system prompt (V3 `system/message`): the same flat
        // collapsible shape as the other notes, in its own neutral palette so
        // it never reads as a reminder or a compaction checkpoint.
        const fg = t.systemPrompt
        const collapsed = block.collapsed === true
        const hint = collapsed ? ' · click to expand' : ' · click to collapse'
        const body = []
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, Math.max(8, width - 6))) {
            body.push(line.map((s) => ({ ...s, style: mergeStyle(s.style, { fg }) })))
          }
        }
        out.push(...flatRows('note', block, [
          { text: '  ', style: null },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg, bold: true }) },
          { text: ' system prompt' + hint, style: makeStyle({ fg, bold: true }) },
        ], body, 4, width))
        out.push({ segs: [] })
        break
      }
      case 'inbox': {
        // Admitted-but-unclaimed input. "steering" entries are injected at the
        // next step boundary and are consumed first, so they lead; "queued"
        // entries wait for their own turn. A flat marker row plus one preview
        // line per entry, each kind labeled next to its marker.
        const fg = t.inbox
        const nextStep = block.nextStep ?? []
        const nextTurn = block.nextTurn ?? []
        const expanded = block.expanded === true
        const counts = []
        if (nextStep.length > 0) counts.push(nextStep.length + ' steering')
        if (nextTurn.length > 0) counts.push(nextTurn.length + ' queued')
        const hint = expanded ? ' · click to collapse' : ' · click to expand'
        const rows = [
          ...nextStep.map((message) => ({ marker: '⟲', kind: 'steering', message })),
          ...nextTurn.map((message) => ({ marker: '↳', kind: 'queued', message })),
        ]
        const body = []
        if (expanded) {
          for (const { marker, kind, message } of rows) {
            body.push([
              { text: marker + ' ', style: makeStyle({ fg, bold: true }) },
              { text: kind + '  ', style: makeStyle({ fg, dim: true }) },
              { text: inboxPreview(message.text, Math.max(8, width - 16)), style: makeStyle({ fg: t.text }) },
            ])
          }
        }
        out.push(...flatRows('note', block, [
          { text: '  ', style: null },
          { text: expanded ? '▾' : '▸', style: makeStyle({ fg, bold: true }) },
          { text: ' pending input · ' + counts.join(' · ') + hint, style: makeStyle({ fg, bold: true }) },
        ], body, 6, width))
        out.push({ segs: [] })
        break
      }
      default:
        break
    }
    return out
  }

  // Return the cached rendered lines for a block, re-rendering only when its
  // content (rev) changed. The live streaming block is re-rendered at a
  // throttled rate: re-parsing its whole markdown on every paint is the main
  // cost that grows with output, so short frames reuse the previous render.
  _ensureBlockLines(block, width) {
    const key = block.rev + ':' + width
    const cached = this._blockLineCache.get(block)
    if (cached && cached.key === key) return cached.lines
    if (block.streaming && cached && Date.now() - this._streamingRenderAt < 120) {
      return cached.lines
    }
    const rendered = this._blockLines(block, width)
    // `start` was captured while the image rows were still in whatever array the
    // block renderer was filling — a bubble builds its body first and wraps it
    // afterwards, so the index the rows were given is not the one they end up
    // at. Re-anchor it here, where the block's final lines are known: the draw
    // pass reads it as "how many rows of this group sit above the window".
    for (let i = 0; i < rendered.length; i++) {
      const img = rendered[i]?.image
      if (!img) continue
      const prev = rendered[i - 1]?.image
      img.start = prev && prev.gid === img.gid ? prev.start : i
    }
    if (block.streaming) this._streamingRenderAt = Date.now()
    this._blockLineCache.set(block, { key, lines: rendered })
    return rendered
  }

  // Total rendered line count for the transcript at a given width.
  _transcriptTotal(width) {
    let total = 0
    for (const block of this.blocks) total += this._ensureBlockLines(block, width).length
    return total
  }

  // ---- paint -----------------------------------------------------------

  render() {
    const { cols, rows, headerH, inputRowsVisible, suggestions, imageHintH, statsH, transcriptTop, transcriptBottom, transcriptH, sidebarW, railW, borderX, visual } = this._layout()
    this.hitRegions = []
    const screen = new Screen(cols, rows)
    const t = THEME
    screen.clear(makeStyle({ bg: t.background }))

    // Header: brand + session name on the left. The right end carries the
    // workspace the open session is rooted in; the model is deliberately not
    // painted here — the status row (narrow) and the rail's MODEL section
    // (wide) already name it, and a second copy read as clutter. When the row
    // runs tight the label yields first, then the branch (truncated, not
    // dropped while it still fits); the path itself is shortened from the head
    // so the project folder stays readable at any width.
    const headerStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
    screen.fill(0, 0, cols, ' ', headerStyle)
    const branch = this.gitBranch ? 'git: ' + this.gitBranch : ''
    let hx = 2
    hx = screen.text(hx, 0, '◈ ', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }))
    hx = gradientText(screen, hx, 0, 'DeepSeek Harness TUI', t.primary, '#dce6ff', { bold: true, bg: t.backgroundPanel })
    let workspace = null
    const hasTitle = this.title && this.title !== 'DeepSeek Harness'
    // The right block takes what is left of the row after the brand, the
    // session title and the margins. Within that budget the pieces yield in
    // order — the label first, then the branch (truncated, not dropped while
    // it still fits) — while the path is shortened from the head so the
    // project folder stays readable. The title itself gives ground only down
    // to 8 columns before the workspace gives up entirely.
    const workspaceFor = (budget) => {
      if (!this.titleScreen && this.workingDirectory) {
        for (const [withLabel, withBranch] of [[true, true], [false, true], [false, false]]) {
          const branchW = withBranch && branch ? Math.min(displayWidth(branch), 20) + 3 : 0
          const labelW = withLabel ? WORKSPACE_LABEL.length + 1 : 0
          const pathRoom = budget - branchW - labelW
          if (pathRoom >= WORKSPACE_MIN_PATH) {
            return {
              label: withLabel,
              path: shortenPath(this.workingDirectory, pathRoom),
              branch: withBranch && branch ? truncateWidth(branch, 20) : '',
            }
          }
        }
      }
      return null
    }
    let titleW = hasTitle ? displayWidth(this.title) : 0
    const wsPossible = !this.titleScreen && this.workingDirectory
    const titleSeat = hx + (hasTitle ? displayWidth('  ·  ') + titleW + 2 : 0)
    workspace = workspaceFor(cols - 2 - titleSeat)
    if (!workspace && wsPossible && titleW > 8) {
      const retry = workspaceFor(cols - 2 - (hx + displayWidth('  ·  ') + 8 + 2))
      if (retry) {
        titleW = 8
        workspace = retry
      }
    }
    if (hasTitle) {
      const rightW = workspace
        ? (workspace.label ? WORKSPACE_LABEL.length + 1 : 0) + displayWidth(workspace.path)
          + (workspace.branch ? displayWidth(workspace.branch) + 3 : 0)
        : 0
      hx = screen.text(hx, 0, '  ·  ', makeStyle({ fg: t.textMuted, bg: t.backgroundPanel }))
      // The title may grow back into whatever slack the shrunken allocation
      // left between it and the right block — the block is right-anchored, so
      // the extra columns are pure gap otherwise.
      const room = (workspace ? cols - 2 - rightW - 2 : cols - 2) - hx
      hx = screen.text(hx, 0, truncateWidth(this.title, Math.max(1, room)), makeStyle({ fg: t.text, bold: true, bg: t.backgroundPanel }))
    }
    if (workspace) {
      const rightW = (workspace.label ? WORKSPACE_LABEL.length + 1 : 0) + displayWidth(workspace.path)
        + (workspace.branch ? displayWidth(workspace.branch) + 3 : 0)
      let wx = cols - 2 - rightW
      if (workspace.label) {
        wx = screen.text(wx, 0, WORKSPACE_LABEL, makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })) + 1
      }
      wx = screen.text(wx, 0, workspace.path, makeStyle({ fg: t.text, bg: t.backgroundPanel }))
      if (workspace.branch) screen.text(wx + 3, 0, workspace.branch, makeStyle({ fg: t.success, bg: t.backgroundPanel }))
    }

    // Sidebar
    let transcriptX = 0
    if (sidebarW > 0) {
      transcriptX = sidebarW + 1
      const sideStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
      for (let y = headerH; y < transcriptBottom; y++) screen.fill(0, y, sidebarW, ' ', sideStyle)
      screen.text(2, headerH, 'SESSIONS', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
      const newSessionStyle = makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel })
      screen.text(1, headerH + 1, '＋ New session', newSessionStyle)
      this.addHitRegion('new-session', 0, headerH + 1, sidebarW)
      let sy = headerH + 3
      const active = this.sessionId
      for (const agent of this.sidebarAgents) {
        if (sy >= transcriptTop + transcriptH - 1) break
        const selected = agent.id === active
        const st = selected
          ? makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement })
          : sideStyle
        if (selected) screen.fill(0, sy, sidebarW, ' ', st)
        screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(agent.label, sidebarW - 4), st)
        sy++
      }
      if (this.sidebarSessions.length > 0) {
        if (sy < transcriptTop + transcriptH - 1) {
          screen.text(2, sy, 'RECENT', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
          sy++
        }
        for (let i = 0; i < this.sidebarSessions.length; i++) {
          if (sy >= transcriptTop + transcriptH - 1) break
          const s = this.sidebarSessions[i]
          const selected = s.id === active || i === this.sidebarSelection
          const st = selected
            ? makeStyle({ fg: s.id === active ? t.primary : t.text, bold: true, bg: t.backgroundElement })
            : sideStyle
          if (selected) screen.fill(0, sy, sidebarW, ' ', st)
          screen.text(1, sy, (selected ? '▸ ' : '  ') + truncateWidth(s.label, sidebarW - 4), st)
          this.addHitRegion('session', 0, sy, sidebarW, 1, { sessionIndex: i, sessionId: s.id })
          sy++
        }
      }
      // vertical border
      for (let y = 1; y < transcriptBottom; y++) screen.set(sidebarW, y, '│', makeStyle({ fg: t.borderSubtle }))
    }

    // Transcript. Only the visible window is materialised (never the whole
    // history), so render cost stays bounded no matter how long the session is.
    const transWidth = borderX - transcriptX
    this._lastTransWidth = transWidth
    this.addHitRegion('transcript', transcriptX, transcriptTop, transWidth, transcriptH)
    const total = this._transcriptTotal(transWidth)
    const maxScroll = Math.max(0, total - transcriptH)
    let offset = maxScroll - this.scroll
    if (this.scroll === 0) offset = maxScroll
    offset = Math.max(0, Math.min(offset, maxScroll))
    const endIndex = Math.min(total, offset + transcriptH)
    let cursor = 0
    let row = 0
    const usedCrops = new Set()
    for (const block of this.blocks) {
      const lines = this._ensureBlockLines(block, transWidth)
      const blockEnd = cursor + lines.length
      if (blockEnd > offset && cursor < endIndex) {
        const from = Math.max(0, offset - cursor)
        const to = Math.min(lines.length, endIndex - cursor)
        for (let i = from; i < to; i++) {
          const y = transcriptTop + row
          const line = lines[i]
          let x = transcriptX
          // Clip every row to the transcript width at the draw boundary. A row
          // is composed from a fixed prefix plus block content, and a single
          // segment (model-authored text, a long path, a wide rune at the last
          // column) can be wider than the box even when the markdown renderer
          // respected its own limit. Letting it through would paint past the
          // terminal edge, wrap the row, and shift the rest of the frame.
          const budget = transWidth
          for (const seg of clipSegs(line.segs, budget)) {
            // Animated placeholders (spinners) are resolved at draw time so
            // the cached lines stay static between animation frames.
            x = screen.text(x, y, seg.anim ? this.animChar() : seg.text, seg.style)
          }
          // The row tail fills to the main area's right edge; with the status
          // rail on screen the fill stops short of the rail's border column.
          if (borderX < cols) screen.fill(x, y, Math.max(0, borderX - x), ' ', makeStyle({ fg: t.text }))
          else screen.fillToEnd(x, y, makeStyle({ fg: t.text }))
          // A graphics-protocol image row: the cells stay blank (background
          // above), and the terminal draws pixels over them via the slab
          // registered here.
          if (line.image) {
            const img = line.image
            // The group's first row can be above the window: the transcript is
            // scrolled past the top of the image. Only the rows that are left
            // are reserved then, and the payload for them is a crop of the same
            // source — placing the whole image would draw its scrolled-away
            // rows back over the window.
            const clip = Math.max(0, Math.min(from - img.start, img.cellsH - 1))
            const cropKey = clip > 0 ? img.key + '\u0000' + clip : img.key
            // `i === from` because the group's own first row can be above the
            // window, and then every row in it is a continuation row.
            if (i === from || lines[i - 1]?.image?.gid !== img.gid) {
              if (clip > 0) this._requestImageCrop(img.key, clip)
              screen.setImageRow(y, {
                key: cropKey,
                x: transcriptX + img.x,
                cellsW: img.cellsW,
                cellsH: img.cellsH - clip,
                top: true,
              })
            }
            usedCrops.add(cropKey)
          }
          // The whole thinking card is a click target that toggles
          // expand/collapse; the region hugs the card, not the row.
          if (line.thinking) {
            this.addHitRegion('thinking', transcriptX, y, transWidth, 1, { thinkingBlock: line.thinking.block })
          }
          // Context notes (system-reminder / compaction) toggle the same way.
          if (line.note) {
            this.addHitRegion('note', transcriptX, y, transWidth, 1, { noteBlock: line.note.block })
          }
          // Tool activity cards expand to their full result on click.
          if (line.tool) {
            this.addHitRegion('tool', transcriptX, y, transWidth, 1, { toolBlock: line.tool.block })
          }
          row++
        }
      }
      cursor = blockEnd
      if (cursor >= endIndex) break
    }
    for (; row < transcriptH; row++) {
      const y = transcriptTop + row
      screen.fill(transcriptX, y, borderX - transcriptX, ' ', makeStyle({ bg: t.background }))
    }

    // Release the cropped variants these last two frames did not show. Each one
    // holds an encoded payload, and scrolling a tall image steps through every
    // crop offset — without this the transcript would accumulate one payload
    // per row ever scrolled past. Two frames of grace so a payload queued for
    // the paint that follows this render is not dropped underneath it.
    for (const [key, live] of this._imageCrops) {
      for (const cropKey of live) {
        if (usedCrops.has(cropKey) || this._imageCropsPrev.has(cropKey)) continue
        live.delete(cropKey)
        this._imageResults.delete(cropKey)
        this.terminal.dropImagePayload?.(cropKey)
      }
      if (live.size === 0) this._imageCrops.delete(key)
    }
    this._imageCropsPrev = usedCrops

    if (this.titleScreen && this.blocks.length === 0) {
      // OpenCode-style splash: DeepSeek brand mark with workspace/git context.
      // The composer claims the rows below `floor`, so the shortcut row has to
      // sit above it or it would be painted over. The mark centers in the main
      // area, never under the status rail.
      paintSplashOpenCode(screen, cols, rows, t, {
        workingDirectory: this.workingDirectory,
        gitBranch: this.gitBranch,
        model: this.model,
        provider: this.provider,
      }, transcriptBottom + statsH - 1, { x0: 0, width: borderX })
    }

    // Composer
    const composerX = sidebarW > 0 ? sidebarW + 2 : 1
    const composerW = borderX - composerX - 1
    let composerTop = transcriptBottom + statsH

    // Stats strip: the web chat's session stats line, one row between the
    // transcript and the composer (the composer-dock seat the web strip
    // occupies). Groups are drawn whole, in the order the details window lists
    // them, so a narrow terminal drops trailing groups instead of cutting a
    // figure in half; `/stats` keeps a seat only when the figures leave it one.
    // The whole row is a click target.
    if (statsH > 0) {
      const stripY = transcriptBottom
      const bg = t.backgroundPanel
      const groups = this._statsGroups()
      const hint = '/stats'
      const hintW = displayWidth(hint)
      const lineWidth = groups.reduce((sum, group, i) => sum + (i > 0 ? 1 : 0) + displayWidth(group), 0)
      const hintSeat = lineWidth + hintW + 6 <= cols - 2
      const budget = cols - 2 - (hintSeat ? hintW + 3 : 0)
      screen.fill(0, stripY, cols, ' ', makeStyle({ bg }))
      let sx = screen.text(composerX, stripY, '▤ ', makeStyle({ fg: t.primary, bg }))
      let drawn = 0
      for (const group of groups) {
        const lead = drawn > 0 ? '│' : ''
        if (sx + displayWidth(lead) + displayWidth(group) > budget) break
        sx = screen.text(sx, stripY, lead + group, makeStyle({ fg: t.textMuted, bg }))
        drawn++
      }
      if (drawn < groups.length) screen.text(sx, stripY, '│…', makeStyle({ fg: t.border, bg }))
      if (hintSeat) screen.text(cols - hintW - 2, stripY, hint, makeStyle({ fg: t.border, dim: true, bg }))
      this.addHitRegion('stats', 0, stripY, cols, 1)
    }
    if (suggestions > 0) {
      const matches = COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText)).slice(0, suggestions)
      for (const [command, description] of matches) {
        screen.fill(composerX, composerTop, composerW, ' ', makeStyle({ bg: t.backgroundElement }))
        screen.text(composerX + 2, composerTop, command, makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
        screen.text(composerX + 18, composerTop, description, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
        composerTop++
      }
    }
    if (imageHintH) {
      const hint = '已粘贴图片：需使用多模态模型/插件或 deepseek-v4-flash-vision-exp，否则无法读取图片'
      screen.fill(composerX, composerTop, composerW, ' ', makeStyle({ bg: t.background }))
      screen.text(composerX + 2, composerTop, truncateWidth(hint, composerW - 4), makeStyle({ fg: t.warning, bold: true, bg: t.background }))
      composerTop++
    }
    // Composer frame: idle draws the static border. While a turn runs the
    // frame flows instead of sitting flat yellow - gold dashes with a bright
    // head chase each other clockwise around the box (marching ants),
    // time-based like the transcript spinners.
    const running = this.status === 'running'
    const framePhase = Math.floor(Date.now() / 80)
    const frameH = inputRowsVisible + 2
    const borderStyle = running ? null : makeStyle({ fg: t.border })
    if (running) {
      for (let i = 0; i < composerW; i++) {
        screen.set(composerX + i, composerTop, i === 0 ? '╭' : i === composerW - 1 ? '╮' : '─', this._flowBorderStyle(i, framePhase))
      }
    } else {
      screen.text(composerX, composerTop, '╭' + '─'.repeat(Math.max(0, composerW - 2)) + '╮', borderStyle)
    }
    this._paintEffortLabel(screen, composerX, composerTop, composerW)
    const firstVisual = Math.max(0, visual.cursorRow - inputRowsVisible + 1)
    // The approval prompt replaces the composer's content. Computed once: the
    // same helper _layout used to size the box, so the two agree by construction.
    const approvalLines = this.pendingApproval
      ? this._approvalLines(composerTextWidth(cols, sidebarW, railW), inputRowsVisible)
      : null
    for (let i = 0; i < inputRowsVisible; i++) {
      const y = composerTop + 1 + i
      const visualIndex = firstVisual + i
      screen.fill(composerX, y, composerW, ' ', makeStyle({ bg: t.backgroundPanel }))
      if (running) {
        // Side edges follow the perimeter path: down the right edge, then
        // back up the left one (see _flowBorderStyle for the mapping).
        const edge = i + 1
        screen.set(composerX + composerW - 1, y, '│', this._flowBorderStyle(composerW - 1 + edge, framePhase))
        screen.set(composerX, y, '│', this._flowBorderStyle(2 * (composerW - 1) + (frameH - 1 - edge), framePhase))
      } else {
        screen.text(composerX, y, '│', borderStyle)
        screen.text(composerX + composerW - 1, y, '│', borderStyle)
      }
      if (approvalLines) {
        const line = approvalLines[i]
        if (line) {
          let ax = composerX + 2
          for (const seg of line) ax = screen.text(ax, y, seg.text, seg.style)
        }
        continue
      }
      const line = visual.rows[visualIndex] ?? ''
      let lx = composerX + 2
      const textStyle = makeStyle({ fg: t.text, bg: t.backgroundPanel })
      const chipStyle = makeStyle({ fg: t.imageChipText, bg: t.imageChipBg, bold: true })
      const markerRe = /\[Image \d+\]/g
      let last = 0
      let match
      while ((match = markerRe.exec(line)) !== null) {
        if (match.index > last) lx = screen.text(lx, y, line.slice(last, match.index), textStyle)
        lx = screen.text(lx, y, match[0], chipStyle)
        last = match.index + match[0].length
      }
      if (last < line.length) lx = screen.text(lx, y, line.slice(last), textStyle)
      if (visualIndex === visual.cursorRow) {
        const cursorX = composerX + 2 + visual.cursorCol
        const current = Array.from(this.inputText.slice(this.inputCursor))[0] ?? ' '
        screen.text(cursorX, y, current === '\n' ? ' ' : current, makeStyle({ fg: t.background, bg: t.primary }))
      }
    }
    const bottom = composerTop + inputRowsVisible + 1
    this.addHitRegion('composer', composerX, composerTop, composerW, inputRowsVisible + 2, { composerTop, firstVisual })
    if (running) {
      for (let i = 0; i < composerW; i++) {
        // Bottom edge continues the perimeter: right -> left.
        screen.set(composerX + i, bottom, i === 0 ? '╰' : i === composerW - 1 ? '╯' : '─', this._flowBorderStyle(composerW + frameH - 3 + (composerW - 1 - i), framePhase))
      }
    } else {
      screen.text(composerX, bottom, '╰' + '─'.repeat(Math.max(0, composerW - 2)) + '╯', borderStyle)
    }
    // The composer's mode label names the model that will receive the message.
    // With the status rail on screen the rail's MODEL section owns that fact,
    // so the label only stays for the interrupt hint.
    const mode = this.status === 'running'
      ? 'interrupt: ctrl+c'
      : railW > 0 ? '' : (this.provider ? this.provider + ' · ' : '') + (this.model || 'model')
    if (mode !== '') {
      screen.text(composerX + 2, bottom, ' ' + truncateWidth(mode, Math.max(0, composerW - 6)) + ' ', makeStyle({ fg: this.status === 'running' ? t.warning : t.textMuted, bg: t.background }))
    }

    // Reasoning-effort slider: one row between the composer and the status
    // row, driven by the current model's real selectable levels.
    if (this.effortSliderVisible) this._paintEffortSlider(screen, cols, rows, borderX)

    // Status row
    const statusRow = rows - 1
    const statusStyle = makeStyle({ fg: t.textMuted, bg: t.background })
    screen.fill(0, statusRow, cols, ' ', statusStyle)
    let leftX = 3
    if (this.status === 'running' && this.hasAnimation()) {
      // Flowing wave indicator while the agent is working (read/write/tools/
      // thinking): consecutive spinner frames render side by side so the
      // pattern visibly flows left to right.
      const phase = Math.floor(Date.now() / 70) % SPINNER.length
      const flow = SPINNER[phase] + SPINNER[(phase + 1) % SPINNER.length] + SPINNER[(phase + 2) % SPINNER.length]
      screen.text(1, statusRow, flow, makeStyle({ fg: t.primary, bg: t.background }))
      leftX = 4
    } else {
      const statusDot = this.status === 'running' ? '▮' : '·'
      const dotColor = this.status === 'running' ? t.success : t.textMuted
      screen.text(1, statusRow, statusDot, makeStyle({ fg: dotColor, bg: t.background }))
    }
    // Left cluster: with the rail on screen the model, thinking and context
    // figures live expanded in the rail, so the row keeps the live indicator
    // and the draft-token estimate, plus a shortcut hint at the right end.
    // Without the rail the model name leads the row and the context meter owns
    // the right end, sized to whatever space remains — the model name survives
    // before the draft count does when the row is crowded.
    const tokText = this.usage.input > 0 ? '' : roughTokens(this.inputText) + ' draft tok'
    if (railW > 0) {
      if (tokText) screen.text(leftX, statusRow, tokText, statusStyle)
      const hint = 'ctrl+p commands'
      const hintX = cols - displayWidth(hint) - 2
      if (hintX > leftX + displayWidth(tokText) + 2) {
        screen.text(hintX, statusRow, hint, makeStyle({ fg: t.textMuted, dim: true, bg: t.background }))
      }
    } else {
      const modelName = this.model || 'model'
      const leftBase = ' ' + modelName
      const leftWithTokens = tokText ? leftBase + ' · ' + tokText : leftBase
      const metricRight = cols - 2
      const meterGeom = this._contextMeterGeometry(statusRow, leftX + 1, metricRight)
      const leftBudget = meterGeom
        ? Math.max(0, meterGeom.x0 - leftX - 1)
        : Math.max(0, Math.floor(cols * 0.42))
      const leftClipped = displayWidth(leftWithTokens) <= leftBudget
        ? leftWithTokens
        : displayWidth(leftBase) <= leftBudget
          ? leftBase
          : truncateWidth(leftBase, leftBudget)
      screen.text(leftX, statusRow, leftClipped, statusStyle)
      if (meterGeom) this._paintContextMeter(screen, statusRow, meterGeom)
    }

    // Toast: bottom-center, on the same status row as the model/meter
    // readings; it auto-dismisses after 2 seconds.
    if (this.toast) {
      const st = makeStyle({ fg: this.toast.level === 'error' ? t.error : t.info, bg: t.backgroundElement })
      const toastText = ' ' + this.toast.text + ' '
      const toastX = Math.max(0, Math.floor((cols - displayWidth(toastText)) / 2))
      screen.fill(toastX, statusRow, displayWidth(toastText), ' ', st)
      screen.text(toastX, statusRow, toastText, st)
    }

    // Right status rail: painted after the main area (its border and panel
    // overwrite any transcript tail fill) and before the overlays, which must
    // be able to cover it.
    if (railW > 0) this._paintRail(screen, { cols, rows, headerH, railW, borderX })

    // Overlays
    if (this.overlay === 'help') this._paintHelp(screen, cols, rows, railW)
    if (this.overlay === 'settings') this._paintSettings(screen, cols, rows, railW)
    if (this.overlay === 'rewind') this._paintRewind(screen, cols, rows, railW)
    // The question modal owns the screen while a request is pending.
    this._questionCaret = null
    if (this.pendingQuestions) this._paintQuestions(screen, cols, rows, railW)
    else if (this.statsOpen && !this.overlay) this._paintStats(screen, cols, rows, railW)
    if (this.pendingSecret) this._paintSecret(screen, cols, rows, railW)

    // Normalize backgrounds: transcript markdown segments, indents, and row
    // tail fills carry fg-only styles, which would otherwise fall back to the
    // terminal's own default background (usually black). Every cell in the
    // finished frame sits on the themed canvas instead; cells with their own
    // background (panels, overlays, code spans) keep it.
    screen.defaultBackground(t.background)

    // Mouse text-selection highlight, applied after normalization so every
    // cell has a background to merge into.
    this._paintTextSelection(screen)
    // Keep the finished frame so selection text extraction reads exactly the
    // cells the user sees (selectionText / right-click copy).
    this._lastScreen = screen

    // Remember the input caret's screen position so term.paint can park the
    // (hidden) terminal cursor there — the OS IME composition window then
    // anchors inside the composer instead of at the bottom-left corner.
    screen.cursorX = composerX + 2 + visual.cursorCol
    screen.cursorY = composerTop + 1 + (visual.cursorRow - firstVisual)
    // A modal free-text field overrides the composer's caret.
    if (this._questionCaret) {
      screen.cursorX = this._questionCaret.x
      screen.cursorY = this._questionCaret.y
    }

    return screen
  }

  // The approval prompt's rows, one entry per painted line. Shared by _layout
  // (which sizes the composer to the prompt) and the composer painter, so the
  // box can never disagree with its content about the height.
  //
  // The protocol requires the provider to clearly show the action, the summary,
  // the origin and the policy-permitted details. The composer previously showed
  // the action alone, so three of the four were dropped.
  _approvalLines(width, maxRows) {
    const t = THEME
    const state = this.pendingApproval
    const rows = Math.max(1, Math.floor(maxRows))
    if (!state || !(width >= 8)) return []
    const bg = t.backgroundPanel
    const label = makeStyle({ fg: t.textMuted, bg })
    const value = makeStyle({ fg: t.text, bg })
    const action = String(state.toolName ?? '')
    const hint = 'y allow · n deny · Esc cancel'
    const hintStyle = makeStyle({ fg: t.textMuted, dim: true, bg })
    const lines = []

    // A labelled field: the label carries the meaning, the value the text, and
    // the value wraps into the room the label leaves so neither runs past the
    // composer's edge.
    const field = (prefix, text, style) => {
      const body = String(text ?? '')
      const room = width - displayWidth(prefix)
      if (room < 4) {
        const shownPrefix = truncateWidth(prefix, width)
        lines.push([
          { text: shownPrefix, style: label },
          { text: truncateWidth(body, Math.max(0, width - displayWidth(shownPrefix))), style },
        ])
        return
      }
      const wrapped = body === '' ? [''] : wrapText(body, room)
      for (let i = 0; i < wrapped.length; i++) {
        lines.push(i === 0
          ? [{ text: prefix, style: label }, { text: wrapped[i], style }]
          : [{ text: wrapped[i], style }])
      }
    }

    // 1. The action. The key hints ride along on this row when they fit, so the
    //    two things a decision needs — what is being approved and how to answer
    //    — survive even a one-row composer.
    const actionHead = 'Approval · '
    const hintInline = displayWidth(actionHead) + displayWidth(action) + 2 + displayWidth(hint) <= width
    const actionRow = [
      { text: actionHead, style: label },
      { text: action, style: makeStyle({ fg: t.warning, bold: true, bg }) },
    ]
    if (hintInline) {
      const gap = width - displayWidth(actionHead) - displayWidth(action) - displayWidth(hint)
      actionRow.push({ text: ' '.repeat(Math.max(1, gap)), style: label }, { text: hint, style: hintStyle })
    }
    lines.push(actionRow)

    // 2. The summary: the human explanation of what is being approved.
    if (state.summary) field('Summary · ', state.summary, value)
    // 3. The origin: which component asked.
    if (state.origin) field('Origin · ', state.origin, value)
    // 4. The risk, when the request carries one. Distinguishable by tone so it
    //    reads as a warning rather than another detail.
    if (state.risk) {
      const risk = String(state.risk)
      const riskColor = risk === 'low' ? t.success : risk === 'high' ? t.error : t.warning
      field('Risk · ', risk, makeStyle({ fg: riskColor, bold: true, bg }))
    }
    // 5. The details. A detail marked `private` shows its label but not its
    //    value: line 185's principle for CopyText.sensitivity ("private" means
    //    do not display the full text) applies to ApprovalDetail.sensitivity
    //    too. With no policy layer to decide otherwise, hiding the value is a
    //    conservative default, NOT a protocol requirement.
    for (const detail of Array.isArray(state.details) ? state.details : []) {
      if (!detail || detail.label === undefined) continue
      const privateDetail = detail.sensitivity === 'private'
      field(
        String(detail.label) + ': ',
        privateDetail ? REDACTED_DETAIL : detail.value,
        privateDetail ? makeStyle({ fg: t.textMuted, bg }) : value,
      )
    }

    const hintRow = [{ text: hint, style: hintStyle }]
    if (!hintInline) lines.push(hintRow)
    if (lines.length <= rows) return lines
    // Clipped: the action and the key hints are what a decision cannot be made
    // without, so the middle is what yields, with a count of what was left out.
    const tail = hintInline ? [] : [lines.pop()]
    const budget = rows - tail.length
    if (budget <= 1) return lines.slice(0, 1).concat(tail)
    const keep = Math.max(1, budget - 1)
    const clipped = lines.slice(0, keep)
    clipped.push([{ text: '… ' + (lines.length - keep) + ' more', style: label }])
    return clipped.concat(tail)
  }

  _paintEffortSlider(screen, cols, rows, rightEdge = cols) {
    const t = THEME
    const slider = this.effortSlider
    if (!slider || slider.levels.length === 0) return
    const y = rows - 2
    const bg = t.background
    screen.fill(0, y, rightEdge, ' ', makeStyle({ bg }))
    const levels = slider.levels
    const index = Math.min(this._effortIndex(), levels.length - 1)
    const atMax = this._effortAtMax()
    // The level name alone carries the meaning — no "effort" caption.
    const left = 2
    const trackWidth = Math.max(10, Math.min(26, rightEdge - left - 48))
    const fill = levels.length <= 1 ? 1 : Math.max(1, Math.round((index / (levels.length - 1)) * trackWidth))
    const phase = Math.floor(Date.now() / 60)
    const head = atMax ? phase % fill : -1
    for (let i = 0; i < trackWidth; i++) {
      if (i < fill) {
        // Filled segment: flat primary, or at max a gradient that flows
        // left -> right (wave index shrinks with position: (phase - i)), with
        // a bright comet head sweeping across the fill and a short trail.
        let color = t.primary
        if (atMax) {
          const wave = ((phase - i) % (fill + 1) + (fill + 1)) % (fill + 1) / Math.max(1, fill)
          const base = mixColor(t.primary, t.accent, wave)
          const dist = Math.abs(head - i)
          color = dist === 0 ? mixColor(base, '#ffffff', 0.85)
            : dist === 1 ? mixColor(base, '#ffffff', 0.45)
              : dist === 2 ? mixColor(base, '#ffffff', 0.2)
                : base
        }
        screen.text(left + i, y, '█', makeStyle({ fg: color, bg }))
      } else {
        // Empty segment: at max the cells shimmer, moving rightward too.
        const ch = atMax && ((phase - i) % 2 + 2) % 2 === 0 ? '▒' : '░'
        screen.text(left + i, y, ch, makeStyle({ fg: t.border, bg }))
      }
    }
    // Text-safe slider thumb on the right edge of the fill.
    screen.text(left + Math.min(fill, trackWidth) - 1, y, '▮', makeStyle({ fg: atMax ? '#ffffff' : t.secondary, bold: true, bg }))
    // Keep the current effort value in its original slider-row position as
    // well as in the composer's top-right corner.
    const current = levels[index] ?? levels[0]
    const name = truncateWidth(String(current?.name ?? current?.id ?? '—'), 18)
    let x = left + trackWidth + 2
    screen.text(x, y, name, makeStyle({ fg: atMax ? t.warning : t.secondary, bold: true, bg }))
    x += displayWidth(name)
    // The real range the provider exposed, so a boolean-thinking model shows
    // exactly its two ends rather than a fake none..max scale.
    if (levels.length > 1) {
      const range = ' · ' + String(levels[0]?.name ?? levels[0]?.id) + ' → ' + String(levels[levels.length - 1]?.name ?? levels[levels.length - 1]?.id)
      const clipped = truncateWidth(range, Math.max(4, rightEdge - x - 22))
      if (displayWidth(clipped) > 4) {
        screen.text(x, y, clipped, makeStyle({ fg: t.textMuted, bg }))
        x += displayWidth(clipped)
      }
    }
    const hint = 'Tab / ←/→ adjust · Esc close'
    const hintX = rightEdge - displayWidth(hint) - 1
    if (hintX > x + 2) screen.text(hintX, y, hint, makeStyle({ fg: t.textMuted, dim: true, bg }))
  }

  // ---- right status rail -------------------------------------------------
  // The wide-window column: session title on top, scrollable sections in the
  // middle (model, thinking, context, session figures, goal, subagents), and
  // the workspace path plus build versions pinned to the bottom. Sections with
  // no data drop out whole, and the whole rail scrolls so future sections can
  // outgrow the window without a redesign.

  // The rail's scrollable content, one line per row, every style carrying the
  // panel background (the renderer's default-background pass would otherwise
  // repaint text cells with the page background over the rail's panel).
  _railLines(width) {
    const t = THEME
    const bg = t.backgroundPanel
    const lines = []
    const st = (extra = {}) => makeStyle({ bg, ...extra })
    const muted = st({ fg: t.textMuted })
    // A section header: one blank line before it (never leading) plus the
    // all-caps label, the same vocabulary the left sidebar's SESSIONS/RECENT
    // headers use.
    const section = (name) => {
      if (lines.length > 0) lines.push([])
      lines.push([{ text: name, style: st({ fg: t.textMuted, bold: true }) }])
    }
    const row = (text, style) => lines.push([{ text, style: style ?? st({ fg: t.text }) }])

    section('MODEL')
    row(truncateWidth(this.model || '…', width), st({ fg: t.text, bold: true }))
    if (this.provider) row(truncateWidth(this.provider, width), muted)

    section('THINKING')
    const level = this._effortLevel()
    if (level) {
      row(truncateWidth(String(level.name ?? level.id ?? '—'), width), st({ fg: t.secondary, bold: true }))
      const slider = this.effortSlider
      if (slider && slider.levels.length > 1) {
        const range = String(slider.levels[0]?.name ?? '') + ' → ' + String(slider.levels[slider.levels.length - 1]?.name ?? '')
        row(truncateWidth(range, width), muted)
      }
    } else {
      row('—', muted)
    }

    section('CONTEXT')
    const meter = this.contextMeter
    if (meter) {
      const barW = Math.max(3, width - 2)
      const fill = Math.min(barW, Math.max(0, Math.round(meter.percent / 100 * barW)))
      const fillColor = meter.percent >= 100 ? t.error : meter.percent >= 90 ? t.warning : t.primary
      lines.push([{ text: '█'.repeat(fill) + '░'.repeat(barW - fill), style: st({ fg: fillColor }) }])
      row(meter.percent + '% used', meter.percent >= 90 ? st({ fg: fillColor }) : muted)
      row('~' + formatTokens(meter.usedTokens) + ' / ' + formatTokens(meter.contextWindow) + ' tokens', muted)
      const m = this.metrics ?? {}
      if ((m.billedInputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0) {
        row('in ' + formatTokens(m.billedInputTokens ?? 0) + ' · out ' + formatTokens(m.outputTokens ?? 0), muted)
        if (m.cacheHitRate !== undefined) row('cache ' + m.cacheHitRate + '% hit', muted)
      }
      if (meter.breakdown) {
        for (const piece of wrapText('system ' + formatTokens(meter.breakdown.systemTokens) + ' · tools '
          + formatTokens(meter.breakdown.toolsTokens) + ' · messages ' + formatTokens(meter.breakdown.messageTokens), width)) {
          row(piece, muted)
        }
      }
    } else {
      row('shown once usage is reported', st({ fg: t.textMuted, italic: true }))
    }

    // The figures the narrow window's stats strip carries; the strip drops out
    // while the rail is up, so this is their only home in the wide layout.
    if (this._statsStripVisible()) {
      section('SESSION')
      for (const group of this._statsGroups()) {
        for (const piece of wrapText(group, width)) row(piece, muted)
      }
    }

    if (this.goal) {
      section('GOAL')
      for (const piece of wrapText(this.goal.objective, width)) row(piece)
      const phaseColor = { active: t.success, paused: t.warning, blocked: t.error, complete: t.primary }[this.goal.phase] ?? t.textMuted
      let phaseLine = this.goal.phase
      if (this.goal.maxGoalRounds > 0) phaseLine += ' · round ' + this.goal.roundsStarted + '/' + this.goal.maxGoalRounds
      row(phaseLine, st({ fg: phaseColor }))
      if (this.goal.blockedReason?.message) {
        for (const piece of wrapText(this.goal.blockedReason.message, width)) {
          row(piece, st({ fg: t.error }))
        }
      }
    }

    if (this.subagents.length > 0) {
      section('SUBAGENTS')
      const running = this.subagents.filter((sub) => sub.activity === 'running').length
      row(running + ' running · ' + this.subagents.length + ' total', muted)
      // The list caps at 10 rows so one runaway delegation cannot push
      // everything else off the rail; the count above still names every one.
      for (const sub of this.subagents.slice(0, 10)) {
        const mark = sub.activity === 'running' ? '●' : '○'
        const color = sub.activity === 'running' ? t.success : t.textMuted
        const depthTag = sub.depth > 1 ? ' L' + sub.depth : ''
        lines.push([
          { text: mark + ' ', style: st({ fg: color }) },
          { text: truncateWidth((sub.readable ? sub.label : sub.label + ' (unreadable)') + depthTag, Math.max(4, width - 2)), style: st({ fg: sub.activity === 'running' ? t.text : t.textMuted }) },
        ])
      }
      if (this.subagents.length > 10) row('… +' + (this.subagents.length - 10) + ' more', muted)
    }

    return lines
  }

  _paintRail(screen, { cols, rows, headerH, railW, borderX }) {
    const t = THEME
    const bg = t.backgroundPanel
    const sideStyle = makeStyle({ fg: t.textMuted, bg })
    const x0 = borderX + 1
    const railTop = headerH
    const railBottom = rows - 1 // the status row stays full-width below the rail
    if (railBottom - railTop < 4) return
    for (let y = railTop; y < railBottom; y++) screen.fill(x0, y, railW, ' ', sideStyle)
    for (let y = railTop; y < railBottom; y++) screen.set(borderX, y, '│', makeStyle({ fg: t.borderSubtle }))

    const innerW = railW - 2
    // Session title, pinned above the scroll window (up to three rows).
    let contentTop = railTop
    const titleText = this.titleScreen ? '' : String(this.title ?? '')
    if (titleText !== '') {
      for (const line of wrapText(titleText, innerW).slice(0, 3)) {
        screen.text(x0 + 1, contentTop, truncateWidth(line, innerW), makeStyle({ fg: t.text, bold: true, bg }))
        contentTop++
      }
      contentTop++ // blank separator under the title
    }
    // One fixed footer row: the running builds. The workspace lives in the
    // header's right end now — repeating it here read as the same clutter the
    // duplicated model name did.
    const footerH = 1
    const contentBottom = railBottom - footerH
    const contentH = contentBottom - contentTop
    if (contentH <= 0) return

    const lines = this._railLines(innerW)
    const maxRail = Math.max(0, lines.length - contentH)
    if (this.railScroll > maxRail) this.railScroll = maxRail
    const scroll = this.railScroll
    for (let i = 0; i < contentH && scroll + i < lines.length; i++) {
      const line = lines[scroll + i]
      const y = contentTop + i
      let lx = x0 + 1
      for (const seg of clipSegs(line, innerW)) lx = screen.text(lx, y, seg.text, seg.style)
    }
    // Scrollbar in the rail's rightmost column whenever the sections overflow.
    if (lines.length > contentH) {
      const thumbH = Math.max(1, Math.round(contentH * contentH / lines.length))
      const thumbY = contentTop + Math.round(scroll * (contentH - thumbH) / Math.max(1, lines.length - contentH))
      for (let i = 0; i < contentH; i++) {
        screen.set(x0 + railW - 1, contentTop + i, '│', makeStyle({ fg: t.borderSubtle, bg }))
      }
      for (let i = 0; i < thumbH && thumbY + i < contentBottom; i++) {
        screen.set(x0 + railW - 1, thumbY + i, '┃', makeStyle({ fg: t.border, bold: true, bg }))
      }
    }

    const builds = [
      this.versions.dsh ? 'dsh ' + this.versions.dsh : '',
      this.versions.tui ? 'tui ' + this.versions.tui : '',
    ].filter((part) => part !== '').join(' · ')
    if (builds) screen.text(x0 + 1, railBottom - 1, truncateWidth(builds, innerW), makeStyle({ fg: t.textMuted, dim: true, bg }))

    // The whole rail is a wheel-scroll target; the context section doubles as
    // the stats window's opener (the seat the bottom-row meter vacates).
    this.addHitRegion('rail', x0, railTop, railW, railBottom - railTop)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length === 1 && lines[i][0].text === 'CONTEXT') {
        const y = contentTop + (i - scroll)
        const end = lines.findIndex((line, j) => j > i && line.length === 1 && line[0].style?.bold && line[0].text !== 'CONTEXT')
        const stop = (end < 0 ? lines.length : end) - scroll
        if (y >= contentTop && y < contentBottom) {
          this.addHitRegion('stats', x0, y, railW, Math.max(1, Math.min(stop, contentBottom) - y))
        }
        break
      }
    }
  }

  // The current effort value, pinned to the top-right corner of the composer
  // box — diagonally opposite the `provider · model` label at bottom-left.
  // `↑ max` gets a blinking text arrow and per-letter flowing gradient; any
  // other level is a static bold label.
  _paintEffortLabel(screen, composerX, composerTop, composerW) {
    const t = THEME
    const level = this._effortLevel()
    if (!level || composerW < 16) return
    const atMax = this._effortAtMax()
    const name = truncateWidth(String(level.name ?? level.id), Math.max(4, composerW - 16))
    const bg = t.background
    if (atMax) {
      const text = '↑ ' + name
      const x = composerX + composerW - displayWidth(text) - 2
      const phase = Math.floor(Date.now() / 60)
      const blink = Math.floor(Date.now() / 130) % 2 === 0 ? t.warning : mixColor(t.warning, '#ffffff', 0.75)
      screen.text(x, composerTop, '↑', makeStyle({ fg: blink, bold: true, bg }))
      let cx = x + 2
      let glyphIndex = 0
      for (const ch of Array.from(name)) {
        const wave = (((phase - glyphIndex * 3) % 10) + 10) % 10 / 10
        screen.text(cx, composerTop, ch, makeStyle({ fg: mixColor(t.primary, t.accent, wave), bold: true, bg }))
        cx += displayWidth(ch)
        glyphIndex++
      }
    } else {
      // The level name alone labels the corner — no "effort" prefix.
      const text = name
      const x = composerX + composerW - displayWidth(text) - 2
      screen.text(x, composerTop, text, makeStyle({ fg: t.secondary, bold: true, bg }))
    }
  }

  // Port of the web composer's ContextMeter ring: an always-visible occupancy
  // bar in the status row (`ctx ▓▓░░ 32K/128K 25%`) fed by the token-meter
  // `contextPressure` projection. The whole meter is a click target that
  // toggles the stats window (`_paintStats`). Renders nothing until both a
  // numerator and a capacity are known; the fill shifts toward the
  // warning/error palette as occupancy climbs.
  _contextMeterGeometry(y, leftFloor, rightLimit) {
    const meter = this.contextMeter
    if (!meter) return null
    const used = formatTokens(meter.usedTokens)
    const cap = formatTokens(meter.contextWindow)
    const pct = meter.percent
    const available = rightLimit - leftFloor
    if (available < 6) return null
    const barW = Math.max(3, Math.min(12, Math.floor(available * 0.4)))
    const text = ' ' + used + '/' + cap + ' ' + pct + '%'
    const total = displayWidth('ctx') + 1 + barW + displayWidth(text)
    const x0 = rightLimit - total
    if (x0 < leftFloor) return null
    return {
      x0, y, total, barW, used, cap, pct,
      fillColor: pct >= 100 ? THEME.error : pct >= 90 ? THEME.warning : THEME.primary,
    }
  }

  _paintContextMeter(screen, y, geom) {
    const t = THEME
    let x = geom.x0
    x = screen.text(x, y, 'ctx', makeStyle({ fg: t.textMuted, bold: true, bg: t.background }))
    x += 1
    const fillW = Math.min(geom.barW, Math.max(0, Math.round(geom.pct / 100 * geom.barW)))
    for (let i = 0; i < geom.barW; i++) {
      if (i < fillW) {
        screen.text(x + i, y, '█', makeStyle({ fg: mixColor(geom.fillColor, t.accent, Math.min(1, i / Math.max(1, geom.barW - 1))), bg: t.background }))
      } else {
        screen.text(x + i, y, '░', makeStyle({ fg: t.borderSubtle, bg: t.background }))
      }
    }
    x += geom.barW
    screen.text(x, y, ' ' + geom.used + '/' + geom.cap + ' ' + geom.pct + '%',
      makeStyle({ fg: geom.pct >= 90 ? geom.fillColor : t.textMuted, bg: t.background }))
    this.addHitRegion('context-meter', geom.x0, y, geom.total, 1)
  }

  // Click-open session stats window: the web chat's stats strip and its
  // ContextMeter dialog in one panel — whole-log turn/step counts, model and
  // tool wall time, first-token latency and decode throughput, the durable
  // token billing buckets, and the context occupancy bar whose colored parts
  // are proportioned by the heuristic `contextBreakdown` composition (system
  // prompt, tools, messages). The bar's overall length stays the provider-exact
  // percent; a zero-width part is dropped. Opened by clicking the stats strip
  // or the context meter, or with `/stats`.
  _paintStats(screen, cols, rows, railW = 0) {
    const t = THEME
    const m = this.metrics ?? {}
    const meter = this.contextMeter
    const body = []
    if ((m.steps ?? 0) > 0) {
      body.push({ label: 'usage', value: count(m.turns ?? 0, 'turn') + ' · ' + count(m.steps, 'step') })
      const durations = []
      if ((m.llmMs ?? 0) > 0) durations.push('LLM ' + formatDuration(m.llmMs))
      if ((m.toolMs ?? 0) > 0) durations.push('tools ' + formatDuration(m.toolMs))
      if (durations.length > 0) body.push({ label: 'duration', value: durations.join(' · ') })
      const speeds = []
      if ((m.ttftSteps ?? 0) > 0) speeds.push('TTFT avg ' + formatDuration(m.ttftMs / m.ttftSteps))
      if ((m.decodeMs ?? 0) > 0) speeds.push(formatMetric(m.decodeTokens / (m.decodeMs / 1000)) + ' tok/s')
      if (speeds.length > 0) body.push({ label: 'speed', value: speeds.join(' · ') })
    } else {
      body.push({ label: 'usage', value: 'no completed step yet' })
    }
    body.push({
      label: 'tokens',
      value: 'in ' + formatTokens(m.billedInputTokens ?? 0) + ' · out ' + formatTokens(m.outputTokens ?? 0),
    })
    if (m.cacheHitRate !== undefined) {
      body.push({
        label: 'cache',
        value: m.cacheHitRate + '% hit · read ' + formatTokens(m.cacheReadTokens ?? 0)
          + ' · write ' + formatTokens(m.cacheWriteTokens ?? 0)
          + ' · miss ' + formatTokens(m.uncachedInputTokens ?? 0),
      })
    }
    if (meter) {
      body.push({ blank: true })
      body.push({
        label: 'context',
        value: 'used ' + meter.percent + '%  ~' + formatTokens(meter.usedTokens) + ' / ' + formatTokens(meter.contextWindow),
      })
      const parts = meter.breakdown
        ? [
            { tokens: meter.breakdown.systemTokens, color: t.contextSystem, label: 'system prompt' },
            { tokens: meter.breakdown.toolsTokens, color: t.contextTools, label: 'tools' },
            { tokens: meter.breakdown.messageTokens, color: t.contextMessages, label: 'messages' },
          ].filter((p) => p.tokens > 0)
        : null
      body.push({ bar: true, parts })
      if (parts && parts.length > 0) {
        for (const part of parts) body.push({ legend: part })
      } else {
        body.push({ note: 'composition unavailable' })
      }
    } else {
      body.push({ blank: true })
      body.push({ note: 'context occupancy appears once a request reports usage' })
    }
    body.push({ blank: true })

    // One centered modal at every width. The maximized window used to swap
    // this for a right-hand panel, and the two shapes read as different
    // features; the modal is what the strip click always meant.
    const region = overlayRegion(cols, railW)
    const w = Math.min(64, region - 4)
    const h = Math.min(body.length + 5, Math.max(7, rows - 2))
    const x0 = Math.max(0, Math.floor((region - w) / 2))
    const y0 = Math.max(1, Math.floor((rows - h) / 2) - 1)
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let x = 0; x < w; x++) {
      screen.set(x0 + x, y0, '─', border)
      screen.set(x0 + x, y0 + h - 1, '─', border)
    }
    for (let y = 0; y < h; y++) {
      screen.set(x0, y0 + y, '│', border)
      screen.set(x0 + w - 1, y0 + y, '│', border)
    }
    screen.set(x0, y0, '╭', border); screen.set(x0 + w - 1, y0, '╮', border)
    screen.set(x0, y0 + h - 1, '╰', border); screen.set(x0 + w - 1, y0 + h - 1, '╯', border)

    const labelW = 9
    const barX = x0 + 3
    const barW = w - 8
    let yy = y0 + 1
    screen.text(x0 + 3, yy, 'session stats', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    screen.text(x0 + w - displayWidth('Esc close') - 3, yy, 'Esc close', makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    yy++
    screen.text(x0 + 3, yy, 'click the strip or /stats', makeStyle({ fg: t.textMuted, dim: true, bg: t.backgroundElement }))
    yy += 2
    for (const row of body) {
      if (yy >= y0 + h - 1) break
      if (row.blank) { yy++; continue }
      if (row.bar) {
        const fillTotal = Math.min(barW, Math.max(0, Math.round(meter.percent / 100 * barW)))
        const parts = row.parts
        const partTotal = parts ? parts.reduce((sum, p) => sum + p.tokens, 0) : 0
        if (parts && partTotal > 0 && fillTotal > 0) {
          let cx = barX
          for (const part of parts) {
            const partW = Math.max(1, Math.round(part.tokens / partTotal * fillTotal))
            screen.fill(cx, yy, Math.min(partW, barX + fillTotal - cx), '█', makeStyle({ fg: part.color, bg: t.backgroundElement }))
            cx += partW
          }
          screen.fill(Math.min(cx, barX + fillTotal), yy, Math.max(0, barX + barW - Math.min(cx, barX + fillTotal)), '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
        } else {
          screen.fill(barX, yy, fillTotal, '█', makeStyle({ fg: t.primary, bg: t.backgroundElement }))
          screen.fill(barX + fillTotal, yy, barW - fillTotal, '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
        }
        yy++
        continue
      }
      if (row.legend) {
        const figure = '~' + formatTokens(row.legend.tokens)
        screen.text(x0 + 3, yy, '■', makeStyle({ fg: row.legend.color, bg: t.backgroundElement }))
        screen.text(x0 + 6, yy, row.legend.label, makeStyle({ fg: t.text, bg: t.backgroundElement }))
        screen.text(x0 + w - displayWidth(figure) - 3, yy, figure, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
        yy++
        continue
      }
      if (row.note) {
        screen.text(x0 + 3, yy, truncateWidth(row.note, w - 6), makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
        yy++
        continue
      }
      screen.text(x0 + 3, yy, row.label, makeStyle({ fg: t.secondary, bg: t.backgroundElement }))
      screen.text(x0 + 3 + labelW + 1, yy, truncateWidth(row.value, w - 6 - labelW - 1),
        makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }

  // User-questions modal: the TUI's answerer for the `user-questions/request`
  // waterfall (registered in lib/index.js). Questions are staged one at a time,
  // the way the WebUI composer stages them. A question declaring the
  // `plan-review` intent renders its `detail` — the plan under review — above
  // the choices; the answer encoding is identical either way.
  _paintQuestions(screen, cols, rows, railW = 0) {
    const t = THEME
    const q = this.pendingQuestions
    if (!q) return
    const question = q.questions[q.index]
    if (!question) return
    this._questionCaret = null

    const region = overlayRegion(cols, railW)
    const w = Math.max(34, Math.min(78, region - 8)) + 6
    const maxH = Math.max(9, rows - 2)
    const contentW = w - 6
    const x0 = Math.max(0, Math.floor((region - w) / 2))
    const options = Array.isArray(question.options) ? question.options : []
    const multi = question.multiSelect === true
    const draft = q.drafts[q.index] ?? { selected: [], custom: '' }
    const questionLines = wrapText(String(question.question ?? ''), contentW)
    const detailLines = question.detail ? renderMarkdown(String(question.detail), t, contentW) : []

    // Height budget. Everything except the plan window is fixed, so the plan
    // yields space first and is windowed when it still does not fit.
    const fixedH = 5 + questionLines.length + options.length
    const detailH = detailLines.length === 0
      ? 0
      : Math.max(0, Math.min(detailLines.length, maxH - 2 - fixedH - 2))
    const h = Math.min(maxH, 2 + fixedH + (detailH > 0 ? detailH + 2 : 0))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))

    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let x = 0; x < w; x++) {
      screen.set(x0 + x, y0, '─', border)
      screen.set(x0 + x, y0 + h - 1, '─', border)
    }
    for (let y = 0; y < h; y++) {
      screen.set(x0, y0 + y, '│', border)
      screen.set(x0 + w - 1, y0 + y, '│', border)
    }
    screen.set(x0, y0, '╭', border); screen.set(x0 + w - 1, y0, '╮', border)
    screen.set(x0, y0 + h - 1, '╰', border); screen.set(x0 + w - 1, y0 + h - 1, '╯', border)

    const cx = x0 + 3
    const title = question.header
      ? String(question.header)
      : (q.questions.length > 1 ? 'Question ' + (q.index + 1) + ' of ' + q.questions.length : 'Question')
    const esc = 'Esc defer'
    screen.text(cx, y0 + 1, truncateWidth(title, contentW - displayWidth(esc) - 2), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    screen.text(x0 + w - 3 - displayWidth(esc), y0 + 1, esc, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))

    let y = y0 + 2
    // Clip rather than overdraw: a pathological question (long text, many
    // options) must never paint past the box interior or over its border.
    const footerY = y0 + h - 2
    for (const line of questionLines) {
      if (y > footerY - 3) break
      screen.text(cx, y++, truncateWidth(line, contentW), makeStyle({ fg: t.text, bold: true, bg: t.backgroundElement }))
    }
    y++

    if (detailH > 0) {
      const maxScroll = Math.max(0, detailLines.length - detailH)
      const scroll = Math.max(0, Math.min(q.scroll ?? 0, maxScroll))
      q.scroll = scroll
      for (let x = 0; x < contentW; x++) screen.set(cx + x, y, '─', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
      if (detailLines.length > detailH) {
        const counter = (scroll + 1) + '-' + (scroll + detailH) + ' of ' + detailLines.length + '  PgUp/PgDn'
        screen.text(x0 + w - 3 - displayWidth(counter), y, counter, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
      }
      y++
      for (let i = 0; i < detailH; i++) {
        const line = detailLines[scroll + i]
        let dx = cx
        if (line) for (const seg of line) dx = screen.text(dx, y, seg.text, seg.style)
        y++
      }
      y++
    }

    for (let i = 0; i < options.length; i++) {
      if (y > footerY - 3) break
      const option = options[i]
      const active = !q.customMode && q.cursor === i
      const selected = draft.selected.includes(option.label)
      const marker = multi
        ? (selected ? '[x] ' : '[ ] ')
        : (selected ? '(o) ' : '( ) ')
      const rowStyle = makeStyle({
        fg: active ? t.primary : (selected ? t.text : t.textMuted),
        bold: active || selected,
        bg: active ? t.backgroundPanel : t.backgroundElement,
      })
      if (active) screen.fill(x0 + 1, y, w - 2, ' ', rowStyle)
      const label = marker + option.label
      screen.text(cx, y, truncateWidth(label, contentW), rowStyle)
      if (option.description) {
        const descX = cx + displayWidth(label) + 2
        const room = x0 + w - 3 - descX
        if (room > 8) screen.text(descX, y, truncateWidth('· ' + option.description, room), makeStyle({ fg: t.textMuted, bg: rowStyle.bg }))
      }
      this.addHitRegion('question-option', x0 + 1, y, w - 2, 1, { optionIndex: i })
      y++
    }

    const customText = String(draft.custom ?? '')
    const customActive = q.customMode || q.cursor === options.length
    const customStyle = makeStyle({
      fg: customActive ? t.primary : t.textMuted,
      bg: customActive ? t.backgroundPanel : t.backgroundElement,
    })
    if (customActive) screen.fill(x0 + 1, y, w - 2, ' ', customStyle)
    const filled = customText.trim() !== ''
    const marker = multi ? (filled ? '[x] ' : '[ ] ') : (filled ? '(o) ' : '( ) ')
    const prefix = marker + (options.length > 0 ? 'Other: ' : 'Answer: ')
    screen.text(cx, y, prefix, customStyle)
    const textX = cx + displayWidth(prefix)
    const room = Math.max(1, x0 + w - 3 - textX)
    if (q.customMode) {
      const caret = Math.max(0, Math.min(q.customCursor ?? 0, customText.length))
      const visible = truncateWidth(customText, room)
      screen.text(textX, y, visible, customStyle)
      // Park the real (hidden) cursor here so an IME anchors inside the field.
      this._questionCaret = { x: textX + displayWidth(customText.slice(0, caret)), y }
    } else if (filled) {
      screen.text(textX, y, truncateWidth(customText, room), customStyle)
    } else {
      screen.text(textX, y, truncateWidth('type your own answer', room), makeStyle({ fg: t.textMuted, italic: true, bg: customStyle.bg }))
    }
    this.addHitRegion('question-custom', x0 + 1, y, w - 2, 1)
    y++

    y++
    const hints = q.customMode
      ? 'Enter confirm · Esc back'
      : multi
        ? 'Space toggle · Enter continue · Up/Down move'
        : 'Enter select · Up/Down move'
    screen.text(cx, y, truncateWidth(hints, contentW), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    if (q.error) {
      const errText = truncateWidth(String(q.error), Math.floor(contentW / 2))
      screen.text(x0 + w - 3 - displayWidth(errText), y, errText, makeStyle({ fg: t.warning, bold: true, bg: t.backgroundElement }))
    }
  }

  // A standalone masked prompt for secret-input requests. The Settings pages
  // have their own inline masked field; this is the same masking applied to a
  // one-field modal that a standard protocol request can drive.
  _paintSecret(screen, cols, rows, railW = 0) {
    const t = THEME
    const state = this.pendingSecret
    // Clamped to the available columns as well as the 64-column cap: a 30-column
    // floor with a centred x would push the right edge past the frame on a very
    // narrow terminal.
    const region = overlayRegion(cols, railW)
    const width = Math.max(20, Math.min(region - 8, 64))
    const height = state.description ? 7 : 6
    const x = Math.max(1, Math.floor((region - width) / 2))
    const y = Math.max(1, Math.floor((rows - height) / 2))
    const panel = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    // Screen.fill covers one row, so a panel is a per-row loop — the same shape
    // the settings dialog uses.
    for (let row = 0; row < height; row++) screen.fill(x, y + row, width, ' ', panel)
    for (let col = 0; col < width; col++) {
      screen.set(x + col, y, '─', border)
      screen.set(x + col, y + height - 1, '─', border)
    }
    for (let row = 0; row < height; row++) {
      screen.set(x, y + row, '│', border)
      screen.set(x + width - 1, y + row, '│', border)
    }
    screen.set(x, y, '╭', border); screen.set(x + width - 1, y, '╮', border)
    screen.set(x, y + height - 1, '╰', border); screen.set(x + width - 1, y + height - 1, '╯', border)

    let row = y + 1
    screen.text(x + 2, row, truncateWidth(state.label, width - 4),
      makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
    row += 1
    if (state.description) {
      screen.text(x + 2, row, truncateWidth(state.description, width - 4),
        makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
      row += 1
    }
    const masked = '•'.repeat(Array.from(state.draft).length)
    screen.text(x + 2, row, truncateWidth(masked, width - 4), panel)
    row += 1
    screen.text(x + 2, row,
      truncateWidth(state.error ?? 'Enter to submit · Esc to cancel', width - 4),
      makeStyle({ fg: state.error ? t.error : t.textMuted, bg: t.backgroundElement }))
  }

  // Settings dialog. Views that carry a left menu (Main / Model) render a
  // menu column on the left — Tab switches the active entry, clicking works
  // too; views without a menu (choice lists, session manager, model picker)
  // keep the classic single-column layout.
  _paintSettings(screen, cols, rows, railW = 0) {
    const t = THEME
    const menu = Array.isArray(this.settingsMenu) ? this.settingsMenu : []
    const hasMenu = menu.length > 0
    const menuW = hasMenu ? 12 : 0
    const w = Math.min(hasMenu ? 84 : 68, overlayRegion(cols, railW) - 4)
    // Display rows: group headers (kind 'header') break the list into
    // sections with a blank separator line; every selectable item is one
    // compact row. Headers are never selectable and carry no hit region.
    const display = []
    for (let i = 0; i < this.settingsItems.length; i++) {
      const item = this.settingsItems[i]
      if (item.kind === 'header') {
        if (display.length > 0) display.push({ blank: true })
        display.push({ header: item })
      } else {
        display.push({ item, index: i })
      }
    }
    const h = Math.max(9, Math.min(rows - 4, display.length + 6))
    const contentH = h - 6
    const x0 = Math.max(0, Math.floor((overlayRegion(cols, railW) - w) / 2))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let x = 0; x < w; x++) {
      screen.set(x0 + x, y0, '─', border)
      screen.set(x0 + x, y0 + h - 1, '─', border)
    }
    for (let y = 0; y < h; y++) {
      screen.set(x0, y0 + y, '│', border)
      screen.set(x0 + w - 1, y0 + y, '│', border)
    }
    screen.set(x0, y0, '╭', border); screen.set(x0 + w - 1, y0, '╮', border)
    screen.set(x0, y0 + h - 1, '╰', border); screen.set(x0 + w - 1, y0 + h - 1, '╯', border)
    // Content area: everything right of the menu column.
    const cx = x0 + menuW
    const cw = w - menuW
    if (hasMenu) {
      // Left menu column with a divider; the active entry is highlighted and
      // every entry is a click target.
      screen.set(x0 + menuW, y0, '┬', border)
      for (let yy = y0 + 1; yy < y0 + h - 1; yy++) screen.set(x0 + menuW, yy, '│', border)
      screen.set(x0 + menuW, y0 + h - 1, '┴', border)
      screen.text(x0 + 2, y0 + 1, 'MENU', makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundElement }))
      for (let i = 0; i < menu.length; i++) {
        const my = y0 + 3 + i
        if (my >= y0 + h - 1) break
        const active = i === this.settingsMenuIndex
        const menuStyle = makeStyle({
          fg: active ? t.primary : t.textMuted,
          bold: active,
          bg: active ? t.backgroundPanel : t.backgroundElement,
        })
        if (active) screen.fill(x0 + 1, my, menuW - 1, ' ', menuStyle)
        screen.text(x0 + 2, my, (active ? '▸ ' : '  ') + truncateWidth(menu[i].label, menuW - 5), menuStyle)
        this.addHitRegion('settings-menu', x0 + 1, my, menuW - 1, 1, { menuIndex: i })
      }
    }
    screen.text(cx + 3, y0 + 1, truncateWidth(this.settingsTitle, cw - 6), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))

    const subtitleText = (this.settingsBusy ? this.animChar() + ' ' : '') + (this.settingsSubtitle || 'Shared with DeepSeek Harness WebUI')
    screen.text(cx + 3, y0 + 2, truncateWidth(subtitleText, cw - 6), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    // Scroll window with explicit scroll offset (wheel scrolling support).
    // The scroll offset is clamped to ensure the window always shows content.
    const maxScroll = Math.max(0, display.length - contentH)
    const scrollOffset = Math.max(0, Math.min(this.settingsScrollOffset, maxScroll))
    const selRow = display.findIndex((entry) => entry.index === this.settingsSelection)
    // Auto-scroll to keep the selected row visible when keyboard navigation moves it
    let first = scrollOffset
    if (selRow >= 0) {
      if (selRow < first) first = selRow
      if (selRow >= first + contentH) first = selRow - contentH + 1
    }
    first = Math.max(0, Math.min(first, maxScroll))
    this.settingsScrollOffset = first
    let y = y0 + 4
    for (let r = first; r < Math.min(display.length, first + contentH); r++) {
      const entry = display[r]
      if (entry.header) {
        screen.text(cx + 3, y, truncateWidth(String(entry.header.label).toUpperCase(), cw - 6), makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundElement }))
      } else if (!entry.blank) {
        const item = entry.item
        const i = entry.index
        const selected = i === this.settingsSelection
        const style = makeStyle({
          fg: item.disabled ? t.textMuted : selected ? t.text : t.textMuted,
          bg: selected ? t.backgroundPanel : t.backgroundElement,
          bold: selected && !item.disabled,
        })
        if (selected) screen.fill(cx + 2, y, cw - 4, ' ', style)
        this.addHitRegion('settings-item', cx + 2, y, cw - 4, 1, { settingsIndex: i })
        screen.text(cx + 3, y, selected ? '› ' : '  ', makeStyle({ fg: item.disabled ? t.textMuted : t.primary, bg: style.bg }))
        const draft = this.settingsSecret ? '•'.repeat(Array.from(this.settingsDraft).length) : this.settingsDraft
        const confirming = this.settingsConfirm?.item === item
        const confirmHint = confirming
          ? this.settingsConfirm.item.kind === 'session'
            ? 'Ctrl+D again to delete'
            : (this.settingsConfirm.text ?? 'Y confirm · N cancel') + ' · Y / N'
          : ''
        const value = confirming ? confirmHint : this.settingsEditing === i ? draft + '█' : item.value
        const valueTone = item.tone === 'warning' ? t.warning : item.tone === 'success' ? t.success : undefined
        const valueStyle = makeStyle({ fg: confirming ? t.warning : valueTone ? valueTone : selected && !item.disabled ? t.secondary : t.textMuted, bg: style.bg })
        // Nested rows (e.g. a provider's models) indent one step per level.
        const indent = (item.indent ?? 0) * 3
        if (item.kind === 'session') {
          // Session rows right-align the timestamp and clamp the title so the
          // name and time columns stay clearly separated instead of running
          // together at a fixed 36-column boundary.
          const valueText = truncateWidth(value, cw - 41)
          const valueX = cx + cw - 5 - displayWidth(valueText)
          const labelMax = Math.max(6, Math.min(29, valueX - (cx + 6) - 3))
          screen.text(cx + 6, y, truncateWidth(item.label, labelMax), style)
          screen.text(valueX, y, valueText, valueStyle)
        } else if (item.kind === 'update-version') {
          if (confirming) {
            // The inline y/n confirm shows the exact target version.
            screen.text(cx + 6 + indent, y, truncateWidth(value, cw - 8), valueStyle)
          } else {
            // Version picker rows color their markers instead of using the
            // value column: [latest] success, [next] info, other tags muted,
            // and the installed version (+ its "(installed)" marker) secondary.
            const baseStyle = makeStyle({ fg: item.disabled ? t.textMuted : selected ? t.text : t.textMuted, bg: style.bg })
            const installedStyle = makeStyle({ fg: t.secondary, bg: style.bg })
            const tagStyle = (tag) => makeStyle({
              fg: tag === 'latest' ? t.success : tag === 'next' ? t.info : t.textMuted,
              bg: style.bg,
            })
            let vx = cx + 6 + indent
            vx = screen.text(vx, y, item.version, item.installed ? installedStyle : baseStyle)
            if (item.installed) vx = screen.text(vx, y, '  (installed)', installedStyle)
            for (const tag of item.tags ?? []) vx = screen.text(vx, y, '  [' + tag + ']', tagStyle(tag))
          }
        } else if (item.kind === 'update-progress') {
          // Live download bar: label, ten cells of █/░, then the byte progress
          // the value column normally carries. An unknown total (no
          // content-length) shows an entirely empty bar instead of a fake one.
          const barW = 10
          const percent = typeof item.percent === 'number' && Number.isFinite(item.percent)
            ? Math.max(0, Math.min(100, item.percent))
            : null
          const done = percent === null ? 0 : Math.round((barW * percent) / 100)
          const barStyle = makeStyle({ fg: percent === null ? t.textMuted : percent >= 100 ? t.success : t.primary, bg: style.bg })
          screen.text(cx + 6 + indent, y, truncateWidth(item.label, Math.max(6, 22 - indent)), style)
          screen.text(cx + 30, y, '\u2588'.repeat(done) + '\u2591'.repeat(barW - done), barStyle)
          screen.text(cx + 30 + barW + 1, y, truncateWidth(value, Math.max(4, cw - 41 - 5)), valueStyle)
        } else {
          screen.text(cx + 6 + indent, y, truncateWidth(item.label, Math.max(6, 29 - indent)), style)
          screen.text(cx + 36, y, truncateWidth(value, cw - 41), valueStyle)
        }
      }
      y++
    }
    const footer = this.settingsEditing !== null
      ? 'Enter save · Esc cancel'
      : hasMenu
        ? '↑/↓ move · Tab menu · Enter select · Esc back'
        : '↑/↓ move · Enter select · Esc back'
    screen.text(cx + 3, y0 + h - 2, footer, makeStyle({ fg: this.settingsConfirm ? t.warning : t.textMuted, bg: t.backgroundElement }))
  }

  _paintHelp(screen, cols, rows, railW = 0) {
    const t = THEME
    const region = overlayRegion(cols, railW)
    const w = Math.min(64, region - 4)
    const h = 25
    const x0 = Math.max(0, Math.floor((region - w) / 2))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let i = 0; i < w; i++) {
      screen.set(x0 + i, y0, '─', border)
      screen.set(x0 + i, y0 + h - 1, '─', border)
    }
    for (let i = 0; i < h; i++) {
      screen.set(x0, y0 + i, '│', border)
      screen.set(x0 + w - 1, y0 + i, '│', border)
    }
    screen.set(x0, y0, '╭', border); screen.set(x0 + w - 1, y0, '╮', border)
    screen.set(x0, y0 + h - 1, '╰', border); screen.set(x0 + w - 1, y0 + h - 1, '╯', border)
    screen.text(x0 + 2, y0 + 1, 'DeepSeek Harness TUI — help', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const rows2 = [
      ['Enter', 'send message'],
      ['Ctrl+Enter', 'insert newline'],
      ['Ctrl+C', 'cancel running turn; press again to quit'],
      ['Ctrl+P', 'open settings'],
      ['Ctrl+E', 'toggle thinking slider'],
      ['Tab', 'cycle thinking intensity'],
      ['Ctrl+N', 'new session'],
      ['Ctrl+D', 'delete session in Manage sessions (press twice)'],
      ['PgUp / PgDn', 'scroll transcript'],
      ['Shift+↑/↓', 'scroll status rail (wide windows)'],
      ['Up / Down', 'caret up/down; history at edges'],
      ['Mouse drag', 'select text; right-click copies'],
      ['Wheel', 'scroll transcript / settings'],
      ['Esc Esc', 'rewind picker'],
      ['Esc', 'close overlay · cancel turn · clear prompt'],
    ]
    let yy = y0 + 3
    for (const [key, desc] of rows2) {
      screen.text(x0 + 3, yy, key, makeStyle({ fg: t.success, bg: t.backgroundElement }))
      screen.text(x0 + 3 + 14, yy, desc, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
    yy++
    screen.text(x0 + 3, yy, 'Commands:', makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
    yy++
    for (const cmd of ['/help  /settings  /new  /resume <id>', '/model <id>  /provider <route>  /rewind', '/stats  /clear  /cancel  /quit']) {
      screen.text(x0 + 3, yy, cmd, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }

  _paintRewind(screen, cols, rows, railW = 0) {
    const picker = this.rewind
    if (!picker) return
    const t = THEME
    const listing = picker.step === 'restore' ? picker.restoreOptions : picker.items
    const sel = picker.step === 'restore' ? picker.modeIndex : picker.selected
    const region = overlayRegion(cols, railW)
    const w = Math.min(72, region - 4)
    const h = Math.min(rows - 2, 8 + Math.min(7, Math.max(1, listing.length)))
    const x0 = Math.max(0, Math.floor((region - w) / 2))
    const y0 = Math.max(0, Math.floor((rows - h) / 2))
    const box = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    for (let y = y0; y < y0 + h; y++) screen.fill(x0, y, w, ' ', box)
    for (let i = 0; i < w; i++) {
      screen.set(x0 + i, y0, '─', border)
      screen.set(x0 + i, y0 + h - 1, '─', border)
    }
    for (let i = 0; i < h; i++) {
      screen.set(x0, y0 + i, '│', border)
      screen.set(x0 + w - 1, y0 + i, '│', border)
    }
    screen.set(x0, y0, '╭', border); screen.set(x0 + w - 1, y0, '╮', border)
    screen.set(x0, y0 + h - 1, '╰', border); screen.set(x0 + w - 1, y0 + h - 1, '╯', border)
    screen.text(x0 + 2, y0 + 1, 'Rewind', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const innerW = w - 4
    let subtitle
    if (picker.busy) subtitle = 'Working…'
    else if (picker.error) subtitle = picker.error
    else if (picker.step === 'restore') {
      const item = picker.items[picker.selected]
      subtitle = 'Restore to the point before: ' + (item?.label ?? '')
    } else {
      subtitle = 'Restore the conversation to the point before…'
    }
    screen.text(x0 + 2, y0 + 2, truncateWidth(subtitle, innerW), makeStyle({
      fg: picker.error ? t.error : t.textMuted,
      bg: t.backgroundElement,
    }))
    const listTop = y0 + 4
    const listH = Math.max(1, h - 7)
    const start = picker.scroll
    const end = Math.min(listing.length, start + listH)
    if (listing.length === 0) {
      screen.text(x0 + 3, listTop, 'Nothing to rewind to yet.', makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
    }
    for (let i = start; i < end; i++) {
      const y = listTop + (i - start)
      const row = listing[i]
      const selected = i === sel
      const st = makeStyle({
        fg: selected ? t.primary : (row.current ? t.textMuted : t.text),
        bold: selected,
        bg: selected ? t.backgroundPanel : t.backgroundElement,
      })
      if (selected) screen.fill(x0 + 1, y, w - 2, ' ', st)
      const pointer = selected ? '▸ ' : '  '
      const label = row.label ?? ''
      const ago = rewindAgo(row.time)
      const right = ago ? '  ' + ago : ''
      const leftMax = Math.max(8, innerW - displayWidth(right) - 2)
      const text = pointer + truncateWidth(label, leftMax)
      screen.text(x0 + 2, y, truncateWidth(text, innerW - displayWidth(right)), st)
      if (right) {
        screen.text(x0 + w - 2 - displayWidth(right), y, right, makeStyle({
          fg: selected ? t.secondary : t.textMuted,
          bg: selected ? t.backgroundPanel : t.backgroundElement,
        }))
      }
      this.addHitRegion(picker.step === 'restore' ? 'rewind-option' : 'rewind-item', x0 + 1, y, w - 2, 1, { rewindIndex: i })
    }
    const footer = picker.busy
      ? 'please wait'
      : picker.step === 'restore'
        ? '↑/↓ select · Enter confirm · Esc back'
        : '↑/↓ select · Enter continue · Esc exit'
    screen.text(x0 + 2, y0 + h - 2, truncateWidth(footer, innerW), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
  }
}

function rewindAgo(ms) {
  if (typeof ms !== 'number' || ms < 1e12) return ''
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (sec < 60) return sec + 's'
  if (sec < 3600) return Math.round(sec / 60) + 'm'
  if (sec < 86400) return Math.round(sec / 3600) + 'h'
  return Math.round(sec / 86400) + 'd'
}