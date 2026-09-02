// The TUI view model and renderer: opencode-inspired layout with a dark
// theme, session sidebar, chat transcript, input row, and status bar.
import { Screen, makeStyle, mergeStyle, hexToAnsi } from './term.js'
import { renderMarkdown } from './markdown.js'
import { displayWidth, truncateWidth, timeString, toolSummary, roughTokens, formatTokens } from './util.js'

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
  reminder: 'c5bdf7',       // system-reminder box text (pale violet)
  reminderBg: '3a2f66',     // system-reminder box background (violet)
  imageChipBg: 'd97706',    // orange emphasis for pasted-image markers
  imageChipText: '1a0d00',  // text on the orange image chip
  compaction: '95d8c0',     // compaction box text (pale mint)
  compactionBg: '1f5241',   // compaction box background (green)
  // Context-meter segments (web ContextMeter port): heuristic composition
  // shares get distinct hues so the breakdown bar reads at a glance.
  contextSystem: '7fd88f',
  contextTools: 'e8c468',
  contextMessages: '56b6c2',
  // Mouse text-selection highlight (left-drag select, right-click copy).
  selection: '3153b8',
}

// Flowing activity indicator frames (clockwise Braille flow).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Cached styles for the composer's flowing (marching-ants) frame: a bright
// gold head, a warning-gold body, and the dimmed resting tone. Built once
// because the whole border re-resolves its tone on every animation frame.
let flowFramePalette = null

const COMMAND_HINTS = [
  ['/help', 'show help'], ['/settings', 'open settings'],
  ['/new', 'new session'], ['/resume', 'resume session'],
  ['/model', 'select model'], ['/provider', 'select provider'],
  ['/clear', 'clear view'], ['/cancel', 'cancel running turn'],
  ['/quit', 'exit'],
  ['/compact', 'compact context'], ['/goal', 'manage goal'],
]

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

// Pad a line's segments to the full transcript width with a background fill
// so a "boxed" region (e.g. thinking) keeps its emphasized background even in
// cells that carry no text.
function boxPad(segs, width, bg) {
  let w = 0
  for (const s of segs) w += displayWidth(s.text)
  if (w >= width) return segs
  return [...segs, { text: ' '.repeat(width - w), style: makeStyle({ bg }) }]
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

// The application view state + layout + painting. It is dsh-agnostic: the
// plugin feeds it events and key presses.
export class App {
  constructor(terminal, { sidebarWidth = 30 } = {}) {
    this.term = terminal
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
    this.metrics = {}
    this.contextMeter = null       // { percent, usedTokens, contextWindow, breakdown } — web ContextMeter port
    this.contextMeterOpen = false  // click-open breakdown panel
    this.sidebarVisible = false
    this.sidebarAgents = []        // [{ id, label }]
    this.sidebarSessions = []      // [{ id, label, time }]
    this.sidebarSelection = -1
    this.inputText = ''
    this.inputCursor = 0
    this.inputImages = []          // pasted images: [{ status, ref, mediaType, label }]
    this.history = []
    this.historyIndex = -1
    this.scroll = 0                // lines scrolled up from bottom (0 = follow)
    this.overlay = null            // 'help' | 'settings' | null
    this.settingsSelection = 0
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsTitle = 'Settings'
    this.settingsSubtitle = ''
    this.settingsItems = []
    this.settingsMenu = []          // left menu of the settings dialog: [{ id, label }]
    this.settingsMenuIndex = 0      // active left-menu entry (Tab switches it)
    this.settingsScrollOffset = 0   // scroll offset for the settings window (wheel scroll support)
    this.toast = null              // { text, level }
    this.effortSlider = null       // { levels: [{id, name}], current } — the current model's real reasoning levels
    this.effortSliderVisible = false
    this.pendingApproval = null    // { toolName, reason, resolve, timer }
    this.focusedRegion = 'keyboard' // mouse hover temporarily owns focus
    this._lastHover = ''            // last hovered target (focus-follows-mouse cache)
    this.hitRegions = []           // topmost interactive regions from the latest render
    this._blockLineCache = new Map() // rendered lines per block, keyed by rev+width
    this._streamingRenderAt = 0    // last time the live streaming block was re-rendered
    this.textSelection = null      // { startX, startY, endX, endY, text } for mouse text selection
    this.textSelectionDragging = false // true while left button is held and dragging
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
    const target = region ? region.kind + ':' + (region.settingsIndex ?? region.sessionIndex ?? '') : ''
    const focusIndex = region ? (region.settingsIndex ?? region.sessionIndex ?? -1) : -1
    const focusDiffers = focusIndex >= 0 && focusIndex !== (region.kind === 'settings-item' ? this.settingsSelection : this.sidebarSelection)
    if (target === this._lastHover && !focusDiffers) return false
    this._lastHover = target
    if (!region) return false
    this.focusedRegion = 'mouse'
    if (region.kind === 'settings-item') this.settingsSelection = region.settingsIndex
    if (region.kind === 'session') this.sidebarSelection = region.sessionIndex
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
  // ('') are skipped; trailing fill spaces are trimmed per row.
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
        out += ch
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

  setMetrics(metrics) {
    this.metrics = metrics
    this.usage = { input: metrics.inputTokens ?? 0, output: metrics.outputTokens ?? 0 }
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
      this.contextMeterOpen = false
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
    this.blocks.push(makeBlock('system', { text, level }))
    this._maybeFollow()
  }

  addNote(text, label = 'context') {
    this.blocks.push(makeBlock('note', { text, label, collapsed: true }))
    this.scroll = 0
  }

  addUser(text) {
    this.blocks.push(makeBlock('user', { text }))
    this.assistantHeaderPending = true
    this.scroll = 0
  }

  startAssistant() {
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

  setTodo(todos) {
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
    this._blockLineCache.clear()
  }

  // Toggle a completed thinking box between collapsed and expanded. Thinking
  // stays collapsed while it is still streaming.
  toggleThinking(block) {
    if (!block || block.kind !== 'assistant' || !block.reasoning || block.streaming) return
    block.thinkingCollapsed = block.thinkingCollapsed !== true
    block.rev++
  }

  // Toggle a context note (system-reminder / compaction) between collapsed
  // and expanded.
  toggleNote(block) {
    if (!block || block.kind !== 'note') return
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
    const width = layout.cols - layout.sidebarW - (layout.sidebarW > 0 ? 1 : 0)
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
    if (!this.term || typeof this.term.paint !== 'function') return
    this._toastTimer = setTimeout(() => {
      this._toastTimer = null
      if (this.toast) {
        this.toast = null
        if (this.term.started) this.term.paint(this.render())
      }
    }, 2000)
  }

  // ---- layout ----------------------------------------------------------

  _layout() {
    const cols = this.term.cols
    const rows = this.term.rows
    const headerH = rows >= 20 ? 2 : 1
    const statusH = 1
    const sliderH = this.effortSliderVisible && this.effortSlider ? 1 : 0
    let sidebarW = this.sidebarVisible && cols >= 92 ? Math.min(this.sidebarWidth, Math.floor(cols / 3)) : 0
    if (cols - sidebarW < 52) sidebarW = 0
    const composerWidth = Math.max(20, cols - sidebarW - 6)
    const visual = inputRows(this.inputText, this.inputCursor, composerWidth)
    const inputRowsVisible = Math.min(Math.max(1, visual.rows.length), rows >= 28 ? 6 : 3)
    const suggestions = this.inputText.startsWith('/') && !this.inputText.includes(' ') ? Math.min(COMMAND_HINTS.length, COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText)).length) : 0
    const imageHintH = this.inputImages.length > 0 ? 1 : 0
    const inputH = inputRowsVisible + 2 + suggestions
    const transcriptTop = headerH
    const transcriptBottom = rows - inputH - statusH - sliderH - imageHintH
    const transcriptH = Math.max(1, transcriptBottom - transcriptTop)
    return { cols, rows, headerH, inputH, inputRowsVisible, suggestions, imageHintH, statusH, sliderH, transcriptTop, transcriptBottom, transcriptH, sidebarW, composerWidth, visual }
  }

  // ---- block -> lines --------------------------------------------------

  _blockLines(block, width) {
    const t = THEME
    const out = []
    switch (block.kind) {
      case 'user': {
        out.push({ segs: [{ text: '  You  ', style: makeStyle({ fg: t.primary, bold: true }) },
          { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }] })
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push({ segs: [{ text: '  ', style: null }, ...line] })
        }
        out.push({ segs: [] })
        break
      }
      case 'assistant': {
        if (block.showHeader !== false) {
          const header = [{ text: '  dsh  ', style: makeStyle({ fg: t.accent, bold: true }) },
            { text: '· ' + timeString(block.time), style: makeStyle({ fg: t.textMuted }) }]
          out.push({ segs: header })
        }
        // Thinking is rendered as a gray-emphasised box (no solid border).
        // It stays collapsed while streaming and collapses by default once
        // streaming finishes; the whole box is a click target that toggles
        // between collapsed and expanded (only after it has finished).
        if (block.reasoning) {
          const boxBg = t.backgroundElement
          const streaming = block.streaming === true
          const collapsed = block.thinkingCollapsed === true || streaming
          const hint = streaming ? ' · streaming…' : (collapsed ? ' · click to expand' : ' · click to collapse')
          // While streaming, a flowing spinner leads the header (replaced at
          // draw time so the cached lines can stay static between frames).
          const marker = streaming
            ? { text: '⠿', style: makeStyle({ fg: t.primary, bg: boxBg, bold: true }), anim: 'spinner' }
            : { text: collapsed ? '▸' : '▾', style: makeStyle({ fg: t.thinking, bg: boxBg, bold: true }) }
          const headerSegs = [
            { text: '  ', style: makeStyle({ fg: t.thinking, bg: boxBg }) },
            marker,
            { text: ' thinking' + hint, style: makeStyle({ fg: t.thinking, bg: boxBg, bold: true }) },
          ]
          out.push({ segs: boxPad(headerSegs, width, boxBg), thinking: { block } })
          if (!collapsed) {
            for (const line of renderMarkdown(block.reasoning, t, width - 4)) {
              const segs = boxPad([
                { text: '  ', style: makeStyle({ fg: t.thinking, bg: boxBg }) },
                ...line.map((s) => ({
                  ...s,
                  style: mergeStyle(s.style, { fg: t.thinking, italic: true, bg: boxBg }),
                })),
              ], width, boxBg)
              out.push({ segs, thinking: { block } })
            }
          }
        }
        let text = block.text
        if (block.streaming) text += '▍'
        // A blank line separates the thinking box from the visible answer so
        // the two never run together; skipped when there is no visible answer
        // (pure reasoning) to avoid doubling the block's trailing gap.
        if (block.reasoning && text) out.push({ segs: [] })
        if (text) {
          const lines = renderMarkdown(text, t, width - 2)
          if (lines.length === 0) lines.push([])
          for (const line of lines) out.push({ segs: [{ text: '  ', style: null }, ...line] })
        }
        out.push({ segs: [] })
        break
      }
      case 'tool': {
        const running = block.status === 'running'
        const statusColor = running ? t.warning : block.status === 'error' ? t.error : t.success
        const label = truncateWidth(toolSummary(block.name, block.args), width - 24)
        // A running tool shows a flowing spinner instead of a static marker.
        out.push({ segs: [
          { text: '  ', style: null },
          ...(running
            ? [{ text: '⠿', style: makeStyle({ fg: statusColor }), anim: 'spinner' }]
            : [{ text: (block.status === 'error' ? '✗' : '✓'), style: makeStyle({ fg: statusColor }) }]),
          { text: ' ', style: null },
          { text: label, style: makeStyle({ fg: t.text }) },
        ] })
        if (running) {
          out.push({ segs: [] })
          break
        }
        if (block.result) {
          const resultLines = renderMarkdown(block.result, t, width - 4)
          for (const line of resultLines.slice(0, 6)) {
            out.push({ segs: [{ text: '    ', style: null },
              ...line.map((s) => ({ ...s, style: makeStyle({ fg: t.textMuted }) }))] })
          }
          if (resultLines.length > 6) {
            out.push({ segs: [{ text: '    … ' + (resultLines.length - 6) + ' more lines', style: makeStyle({ fg: t.textMuted, dim: true }) }] })
          }
        }
        out.push({ segs: [] })
        break
      }
      case 'todo': {
        out.push({ segs: [{ text: '  tasks', style: makeStyle({ fg: t.info, bold: true }) }] })
        for (const item of block.todos ?? []) {
          const mark = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '□'
          const color = item.status === 'completed' ? t.success : item.status === 'in_progress' ? t.warning : t.textMuted
          out.push({ segs: [{ text: '  ' + mark + ' ', style: makeStyle({ fg: color }) },
            { text: item.content, style: makeStyle({ fg: t.text }) }] })
        }
        out.push({ segs: [] })
        break
      }
      case 'note': {
        // Context notes (system-reminder / compaction) reuse the thinking-box
        // treatment: full-width emphasized background, collapsed by default,
        // whole box clickable to toggle — each label gets its own palette.
        const palette = block.label === 'compaction'
          ? { fg: t.compaction, bg: t.compactionBg }
          : { fg: t.reminder, bg: t.reminderBg }
        const collapsed = block.collapsed === true
        const hint = collapsed ? ' · click to expand' : ' · click to collapse'
        const headerSegs = [
          { text: '  ', style: makeStyle({ fg: palette.fg, bg: palette.bg }) },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg: palette.fg, bg: palette.bg, bold: true }) },
          { text: ' ' + block.label + hint, style: makeStyle({ fg: palette.fg, bg: palette.bg, bold: true }) },
        ]
        out.push({ segs: boxPad(headerSegs, width, palette.bg), note: { block } })
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, width - 4)) {
            const segs = boxPad([
              { text: '  ', style: makeStyle({ fg: palette.fg, bg: palette.bg }) },
              ...line.map((s) => ({ ...s, style: mergeStyle(s.style, { fg: palette.fg, bg: palette.bg }) })),
            ], width, palette.bg)
            out.push({ segs, note: { block } })
          }
        }
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
    const { cols, rows, headerH, inputRowsVisible, suggestions, imageHintH, transcriptTop, transcriptBottom, transcriptH, sidebarW, visual } = this._layout()
    this.hitRegions = []
    const screen = new Screen(cols, rows)
    const t = THEME
    screen.clear(makeStyle({ bg: t.background }))

    // Header: brand + session name live in the top bar; model at the right.
    const headerStyle = makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })
    screen.fill(0, 0, cols, ' ', headerStyle)
    const modelInfo = this.model ? this.model : '…'
    const modelX = cols - displayWidth(modelInfo) - 2
    let hx = 2
    hx = screen.text(hx, 0, '◈ ', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel }))
    hx = gradientText(screen, hx, 0, 'DeepSeek Harness TUI', t.primary, '#dce6ff', { bold: true, bg: t.backgroundPanel })
    if (this.title && this.title !== 'DeepSeek Harness') {
      hx = screen.text(hx, 0, '  ·  ', makeStyle({ fg: t.textMuted, bg: t.backgroundPanel }))
      hx = screen.text(hx, 0, truncateWidth(this.title, Math.max(1, modelX - hx - 1)), makeStyle({ fg: t.text, bold: true, bg: t.backgroundPanel }))
    }
    if (modelX > hx) {
      screen.text(modelX, 0, modelInfo, makeStyle({ fg: t.accent, bg: t.backgroundPanel }))
      screen.fill(hx, 0, modelX - hx, ' ', headerStyle)
      screen.fillToEnd(modelX + displayWidth(modelInfo), 0, headerStyle)
    } else {
      screen.fillToEnd(hx, 0, headerStyle)
    }
    if (headerH > 1) {
      screen.fill(0, 1, cols, ' ', makeStyle({ bg: t.background }))
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
    const transWidth = cols - transcriptX
    this.addHitRegion('transcript', transcriptX, transcriptTop, transWidth, transcriptH)
    const total = this._transcriptTotal(transWidth)
    const maxScroll = Math.max(0, total - transcriptH)
    let offset = maxScroll - this.scroll
    if (this.scroll === 0) offset = maxScroll
    offset = Math.max(0, Math.min(offset, maxScroll))
    const endIndex = Math.min(total, offset + transcriptH)
    let cursor = 0
    let row = 0
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
          for (const seg of line.segs) {
            // Animated placeholders (spinners) are resolved at draw time so
            // the cached lines stay static between animation frames.
            x = screen.text(x, y, seg.anim ? this.animChar() : seg.text, seg.style)
          }
          screen.fillToEnd(x, y, makeStyle({ fg: t.text }))
          // The whole thinking box is a click target that toggles expand/collapse.
          if (line.thinking) {
            this.addHitRegion('thinking', transcriptX, y, transWidth, 1, { thinkingBlock: line.thinking.block })
          }
          // Context notes (system-reminder / compaction) toggle the same way.
          if (line.note) {
            this.addHitRegion('note', transcriptX, y, transWidth, 1, { noteBlock: line.note.block })
          }
          row++
        }
      }
      cursor = blockEnd
      if (cursor >= endIndex) break
    }
    for (; row < transcriptH; row++) {
      const y = transcriptTop + row
      screen.fill(transcriptX, y, cols - transcriptX, ' ', makeStyle({ bg: t.background }))
    }

    if (this.titleScreen && this.blocks.length === 0) {
      const centerX = transcriptX + Math.floor(transWidth / 2)
      const desiredY = transcriptTop + Math.max(2, Math.floor(transcriptH / 2) - 3)
      const centerY = Math.max(transcriptTop, Math.min(desiredY, transcriptBottom - 6))
      const brand = 'DeepSeek Harness'
      // Blue → white gradient title.
      gradientText(screen, centerX - Math.floor(displayWidth(brand) / 2), centerY, brand,
        t.primary, '#ffffff', { bold: true, bg: t.background })
      const cwd = truncateWidth(this.workingDirectory, Math.max(12, transWidth - 8))
      screen.text(centerX - Math.floor(displayWidth(cwd) / 2), centerY + 2, cwd, makeStyle({ fg: t.text, bg: t.background }))
      if (this.gitBranch) {
        const branch = 'git: ' + this.gitBranch
        screen.text(centerX - Math.floor(displayWidth(branch) / 2), centerY + 3, branch, makeStyle({ fg: t.success, bg: t.background }))
      }
      const hint = 'Ctrl+P  Settings · Tab thinking'
      screen.text(centerX - Math.floor(displayWidth(hint) / 2), centerY + 5, hint, makeStyle({ fg: t.textMuted, bg: t.background }))
    }

    // Composer
    const composerX = sidebarW > 0 ? sidebarW + 2 : 1
    const composerW = cols - composerX - 1
    let composerTop = transcriptBottom
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
      if (this.pendingApproval) {
        if (i === 0) screen.text(composerX + 2, y, 'Approval · ' + this.pendingApproval.toolName + ' · y allow / n deny', makeStyle({ fg: t.warning, bold: true, bg: t.backgroundPanel }))
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
    const mode = this.status === 'running' ? 'interrupt: ctrl+c' : (this.provider ? this.provider + ' · ' : '') + (this.model || 'model')
    screen.text(composerX + 2, bottom, ' ' + truncateWidth(mode, Math.max(0, composerW - 6)) + ' ', makeStyle({ fg: this.status === 'running' ? t.warning : t.textMuted, bg: t.background }))

    // Reasoning-effort slider: one row between the composer and the status
    // row, driven by the current model's real selectable levels.
    if (this.effortSliderVisible) this._paintEffortSlider(screen, cols, rows)

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
    const tokText = this.usage.input > 0
      ? '↑' + this.usage.input + ' ↓' + this.usage.output
      : roughTokens(this.inputText) + ' draft tok'
    const modelName = this.model || 'model'
    const leftBase = ' ' + modelName
    const leftWithTokens = leftBase + ' · ' + tokText
    const readings = []
    if (this.metrics.ttftAverageMs !== undefined) readings.push('TTFT avg ' + formatDuration(this.metrics.ttftAverageMs))
    if (this.metrics.tokensPerSecond !== undefined) readings.push(formatMetric(this.metrics.tokensPerSecond) + ' tok/s')
    if (this.metrics.cacheHitRate !== undefined) readings.push('cache ' + this.metrics.cacheHitRate + '%')
    const right = readings.join(' · ')
    const metricRight = cols - 2
    const metricLeft = 3 + Math.floor(cols * 0.42)
    let metricsWidth = 0
    if (right && metricRight > metricLeft) {
      const clipped = truncateWidth(right, metricRight - metricLeft)
      metricsWidth = displayWidth(clipped)
      screen.text(Math.max(metricLeft, metricRight - metricsWidth), statusRow, clipped, makeStyle({ fg: t.secondary, bg: t.background }))
    }
    // The context meter has priority over the model/token cluster and the
    // metrics: it sits just left of the metrics (or the row's right edge), and
    // the left cluster is sized to whatever space remains — the model name
    // survives before the token counts do when the row is crowded.
    const meterGeom = this._contextMeterGeometry(statusRow, leftX + 1,
      metricsWidth > 0 ? metricRight - metricsWidth - 1 : metricRight)
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

    // Toast: bottom-center, on the same status row as the model/metrics
    // readings; it auto-dismisses after 2 seconds.
    if (this.toast) {
      const st = makeStyle({ fg: this.toast.level === 'error' ? t.error : t.info, bg: t.backgroundElement })
      const toastText = ' ' + this.toast.text + ' '
      const toastX = Math.max(0, Math.floor((cols - displayWidth(toastText)) / 2))
      screen.fill(toastX, statusRow, displayWidth(toastText), ' ', st)
      screen.text(toastX, statusRow, toastText, st)
    }

    // Overlays
    if (this.overlay === 'help') this._paintHelp(screen, cols, rows)
    if (this.overlay === 'settings') this._paintSettings(screen, cols, rows)
    if (this.contextMeterOpen && !this.overlay) this._paintContextPanel(screen, cols, rows)

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

    return screen
  }

  _paintEffortSlider(screen, cols, rows) {
    const t = THEME
    const slider = this.effortSlider
    if (!slider || slider.levels.length === 0) return
    const y = rows - 2
    const bg = t.background
    screen.fill(0, y, cols, ' ', makeStyle({ bg }))
    const levels = slider.levels
    const index = Math.min(this._effortIndex(), levels.length - 1)
    const atMax = this._effortAtMax()
    // The level name alone carries the meaning — no "effort" caption.
    const left = 2
    const trackWidth = Math.max(10, Math.min(26, cols - left - 48))
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
      const clipped = truncateWidth(range, Math.max(4, cols - x - 22))
      if (displayWidth(clipped) > 4) {
        screen.text(x, y, clipped, makeStyle({ fg: t.textMuted, bg }))
        x += displayWidth(clipped)
      }
    }
    const hint = 'Tab / ←/→ adjust · Esc close'
    const hintX = cols - displayWidth(hint) - 1
    if (hintX > x + 2) screen.text(hintX, y, hint, makeStyle({ fg: t.textMuted, dim: true, bg }))
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
  // toggles the breakdown panel (`_paintContextPanel`). Renders nothing until
  // both a numerator and a capacity are known; the fill shifts toward the
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

  // Click-open breakdown panel, ported from the web ContextMeter dialog:
  // headline occupancy, the current/limit reading, an occupancy bar whose
  // colored parts are proportioned by the heuristic `contextBreakdown`
  // composition (system prompt, tools, messages), and a per-part legend. The
  // bar's overall length stays the provider-exact percent; the breakdown only
  // proportions its colored parts (a zero-width part is dropped).
  _paintContextPanel(screen, cols, rows) {
    const t = THEME
    const meter = this.contextMeter
    if (!meter) return
    const w = Math.min(46, cols - 4)
    const h = meter.breakdown ? 10 : 8
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
    const y0 = Math.max(1, Math.floor((rows - h) / 2) - 2)
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
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
    screen.text(x0 + 3, y0 + 1, 'context', makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    screen.text(x0 + w - displayWidth('Esc close') - 3, y0 + 1, 'Esc close', makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    screen.text(x0 + 3, y0 + 2, 'used ' + meter.percent + '%  ~' + formatTokens(meter.usedTokens) + ' / ' + formatTokens(meter.contextWindow),
      makeStyle({ fg: t.text, bold: true, bg: t.backgroundElement }))
    const barX = x0 + 3
    const barW = w - 8
    const fillTotal = Math.min(barW, Math.max(0, Math.round(meter.percent / 100 * barW)))
    const parts = meter.breakdown
      ? [
          { tokens: meter.breakdown.systemTokens, color: t.contextSystem, label: 'system prompt' },
          { tokens: meter.breakdown.toolsTokens, color: t.contextTools, label: 'tools' },
          { tokens: meter.breakdown.messageTokens, color: t.contextMessages, label: 'messages' },
        ].filter((p) => p.tokens > 0)
      : null
    const partTotal = parts ? parts.reduce((sum, p) => sum + p.tokens, 0) : 0
    if (parts && partTotal > 0 && fillTotal > 0) {
      let cx = barX
      for (const part of parts) {
        const partW = Math.max(1, Math.round(part.tokens / partTotal * fillTotal))
        screen.fill(cx, y0 + 3, Math.min(partW, barX + fillTotal - cx), '█', makeStyle({ fg: part.color, bg: t.backgroundElement }))
        cx += partW
      }
      screen.fill(Math.min(cx, barX + fillTotal), y0 + 3, Math.max(0, barX + barW - Math.min(cx, barX + fillTotal)), '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
    } else {
      screen.fill(barX, y0 + 3, fillTotal, '█', makeStyle({ fg: t.primary, bg: t.backgroundElement }))
      screen.fill(barX + fillTotal, y0 + 3, barW - fillTotal, '░', makeStyle({ fg: t.borderSubtle, bg: t.backgroundElement }))
    }
    if (parts && partTotal > 0) {
      let yy = y0 + 5
      for (const part of parts) {
        screen.text(x0 + 3, yy, '■', makeStyle({ fg: part.color, bg: t.backgroundElement }))
        screen.text(x0 + 6, yy, part.label, makeStyle({ fg: t.text, bg: t.backgroundElement }))
        screen.text(x0 + 26, yy, '~' + formatTokens(part.tokens), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
        yy++
      }
    } else {
      screen.text(x0 + 3, y0 + 5, 'composition unavailable', makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
    }
  }

  // Settings dialog. Views that carry a left menu (Main / Model) render a
  // menu column on the left — Tab switches the active entry, clicking works
  // too; views without a menu (choice lists, session manager, model picker)
  // keep the classic single-column layout.
  _paintSettings(screen, cols, rows) {
    const t = THEME
    const menu = Array.isArray(this.settingsMenu) ? this.settingsMenu : []
    const hasMenu = menu.length > 0
    const menuW = hasMenu ? 12 : 0
    const w = Math.min(hasMenu ? 84 : 68, cols - 4)
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
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
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
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
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

    screen.text(cx + 3, y0 + 2, truncateWidth(this.settingsSubtitle || 'Shared with DeepSeek Harness WebUI', cw - 6), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
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
        const confirmHint = confirming && this.settingsConfirm.item.kind === 'session' ? 'Ctrl+D again to delete' : 'Y confirm · N cancel'
        const value = confirming ? confirmHint : this.settingsEditing === i ? draft + '█' : item.value
        const valueStyle = makeStyle({ fg: confirming ? t.warning : selected && !item.disabled ? t.secondary : t.textMuted, bg: style.bg })
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

  _paintHelp(screen, cols, rows) {
    const t = THEME
    const w = Math.min(64, cols - 4)
    const h = 22
    const x0 = Math.max(0, Math.floor((cols - w) / 2))
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
    screen.set(x0, y0, '┌', border); screen.set(x0 + w - 1, y0, '┐', border)
    screen.set(x0, y0 + h - 1, '└', border); screen.set(x0 + w - 1, y0 + h - 1, '┘', border)
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
      ['Up / Down', 'caret up/down; history at edges'],
      ['Mouse drag', 'select text; right-click copies'],
      ['Wheel', 'scroll transcript / settings'],
      ['Esc', 'close help / cancel'],
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
    for (const cmd of ['/help  /settings  /new  /resume <id>', '/model <id>  /provider <route>  /clear  /cancel  /quit']) {
      screen.text(x0 + 3, yy, cmd, makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }
}