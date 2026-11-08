// The TUI view model and renderer: opencode-inspired layout with a dark
// theme, session sidebar, chat transcript, input row, and status bar.
import { stripVTControlCharacters } from 'node:util'
import { Screen, makeStyle, mergeStyle, hexToAnsi } from './term.js'
import { renderMarkdown } from './markdown.js'
import { DEFAULT_THEME, THEME, getTheme, themeId as normalizeThemeId } from './themes.js'
import { sha16 } from './image.js'
import { displayWidth, truncateWidth, timeString, toolSummary, roughTokens, formatTokens, wrapText, shortenPath, decodeDataUrl, reasoningText } from './util.js'
import { paintSplashOpenCode } from './splash-opencode.js'
import { loadMermaidEngine, paintMermaidArt, renderMermaidArt } from './mermaid-ascii.js'
// `tr` on purpose: the paint methods below bind `t` to THEME, and a bare `t`
// import would be shadowed there.
import { t as tr, tn, getLocale } from './i18n.js'

// Mermaid art sits where a code-block body sits, and the pane keeps the same
// slack a markdown table keeps for gutters and message insets before an art
// wider than that is declared too wide for the viewport.
const MERMAID_INDENT = '  '
const MERMAID_INDENT_WIDTH = displayWidth(MERMAID_INDENT)
const MERMAID_MARGIN = 4

export { THEME } from './themes.js'

// Flowing activity indicator frames (clockwise Braille flow).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Label of the header row that names the workspace a session is rooted in, and
// the fewest columns a path may occupy before the strip is dropped entirely (a
// six-cell fragment of a path helps nobody).
const WORKSPACE_LABEL_KEY = 'header.workspace'
const WORKSPACE_MIN_PATH = 8

// Composer command palette: the command stays literal, the description is a
// catalog key resolved at paint time (so a language switch is live).
const COMMAND_HINTS = [
  ['/help', 'hint.help'], ['/settings', 'hint.settings'],
  ['/new', 'hint.new'], ['/resume', 'hint.resume'],
  ['/model', 'hint.model'], ['/provider', 'hint.provider'],
  ['/rewind', 'hint.rewind'], ['/stats', 'hint.stats'],
  ['/clear', 'hint.clear'], ['/cancel', 'hint.cancel'],
  ['/quit', 'hint.quit'], ['/branch', 'hint.branch'],
  ['/compact', 'hint.compact'], ['/goal', 'hint.goal'],
]

// The marker shown in place of an approval detail whose sensitivity is
// `private`. A fixed width on purpose: a length-derived mask (like the secret
// prompt's bullets) would leak how long the hidden value is.
const REDACTED_DETAIL = '••••••'

// The goal phases the catalog names; anything else renders as the raw id.
const GOAL_PHASE_KEYS = new Set(['goal.active', 'goal.paused', 'goal.blocked', 'goal.complete'])

// Right status rail (OpenCode-style right column): the expanded home of the
// status figures the bottom row compresses — model, thinking intensity,
// context — plus the session's goal and subagent activity. The threshold sits
// well above the 120-column default many terminals open at (the rail at that
// width read as "small window"), while any maximized desktop window clears it.
const RAIL_MIN_COLS = 140
const RAIL_WIDTH = 34

// Usable text width inside the composer box, derived from the same geometry
// render() uses, including the centered homepage and its width cap. Shared so the
// approval prompt's line count and its painting can never disagree.
function composerGeometry(cols, sidebarW, railW = 0, home = false) {
  const left = sidebarW > 0 ? sidebarW + 2 : 2
  const rightEdge = cols - (railW > 0 ? railW + 1 : 0)
  const available = Math.max(5, rightEdge - left - 2)
  const composerW = home ? Math.min(76, available) : available
  const composerX = home ? left + Math.floor((available - composerW) / 2) : left
  return { composerX, composerW }
}

function composerTextWidth(cols, sidebarW, railW = 0, home = false) {
  return Math.max(1, composerGeometry(cols, sidebarW, railW, home).composerW - 4)
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

// Rows that carry no action (group headers, a server's transport target or
// tool names) are stepped over instead of being selectable dead ends; a row
// opts out with `selectable: false`.
function settingsRowSelectable(item) {
  return item.kind !== 'header' && item.selectable !== false
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

// `1 turn` / `3 turns`: the count comes from the active locale's plural rules
// through the catalog (`transcript.turns`, `transcript.steps`).
function count(n, key) {
  return tn(key, n, { count: n })
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

function tintMarkdownSegment(seg, style, theme, replace = false) {
  if (!seg.style) return { ...seg, style: makeStyle(style) }
  if (seg.style?.bg === theme.codeBg) return seg
  return { ...seg, style: replace ? makeStyle(style) : mergeStyle(seg.style, style) }
}

function transcriptText(text) {
  return stripVTControlCharacters(String(text ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function indentTranscriptRow(row, amount) {
  // Protocol images retain the old two-column origin; text rows arrive bare.
  return {
    ...row,
    segs: [{ text: ' '.repeat(amount), style: null }, ...row.segs],
    ...(row.image ? { image: { ...row.image, x: amount + row.image.x - 2 } } : {}),
  }
}

function transcriptPanel(body, width, border, theme, tag) {
  const rows = [{ segs: [] }, ...body, { segs: [] }]
  return rows.map((row) => ({
    ...indentTranscriptRow(row, 3),
    segs: [
      { text: '┃', style: makeStyle({ fg: border }) },
      { text: '  ', style: null },
      ...clipSegs(row.segs, Math.max(1, width - 5)),
    ],
    background: theme.backgroundPanel,
    ...tag,
  }))
}

// Catalog key for a context note's marker row. An unknown label (a context
// kind a newer host introduced) falls back to the label itself, which at least
// names the subsystem that produced it.
const NOTE_LABEL_KEYS = {
  compaction: 'note.compaction',
  'system-reminder': 'note.systemReminder',
  'runtime-context': 'note.runtimeContext',
}

function noteLabelKey(label) {
  return NOTE_LABEL_KEYS[label] ?? String(label ?? 'context')
}

// A row that paints nothing: no cell text and no image. Block renderers pad
// their own edges with these, and the transcript collapses them into the one
// gutter row between two blocks (see App._blockRows).
function isBlankRow(row) {
  if (!row || row.image) return false
  return row.segs.every((seg) => !seg?.text || seg.text.trim() === '')
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

// One-line gist of a collapsed thinking box. A folded row that only says
// "Thinking" tells the reader nothing about what was thought; the first real
// line, stripped of its markdown noise, is enough to decide whether to expand.
// Only the head of the text is scanned — a long chain of thought costs nothing
// to preview, and the row is clipped to the pane by the caller anyway.
function thinkingPreview(text) {
  const head = String(text).slice(0, 400)
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    // A fence opener on its own line carries no gist; skip to the next line.
    if (/^```/.test(line)) continue
    return line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`#>~|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
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
// `system-reminder` frames, the runtime-context snapshot and compaction
// checkpoints get labeled boxes; everything else stays a plain system line.
//
// These are the messages the harness assembles for the model rather than
// something the human typed, and the first two restate state on every change
// (the working directory, the approval policy) — so they render collapsed, and
// `contextDetails: hide` (a developer setting) drops them entirely.
const CONTEXT_LABELS = new Set(['system-reminder', 'runtime-context'])

export function noteFromContext(src, text) {
  if (typeof text !== 'string') return null
  if (text.includes('<system-reminder>')) {
    return { label: 'system-reminder', text: stripTag(text, 'system-reminder') }
  }
  if (src?.kind === 'runtime-context') return { label: 'runtime-context', text }
  if (src && ((src.kind === 'plugin' && src.plugin === 'compact')
    || src.kind === 'compact-checkpoint' || src.kind === 'compact-summary')) {
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
  return text === '' ? tr('common.emptyMessage') : text
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
  constructor(terminal, { sidebarWidth = 26 } = {}) {
    this.terminal = terminal
    this.sidebarWidth = sidebarWidth
    this.themeId = DEFAULT_THEME
    this.theme = THEME
    this.blocks = []
    this._turnStartedAt = undefined
    this._turnAssistant = null
    this._pendingModelChanges = []
    this.title = 'DeepSeek Harness'
    this.titleScreen = true
    this.workingDirectory = ''
    this.gitBranch = ''
    this.sessionId = ''
    this.model = ''
    this._requestModel = undefined
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
    this.gitBranches = null        // git branch switcher state, or null
    this.inputText = ''
    this.inputCursor = 0
    this.commandSelection = 0
    this._commandQuery = ''
    this._commandDismissed = false
    this.inputImages = []          // pasted images: [{ status, ref, mediaType, label }]
    this.history = []
    this.historyIndex = -1
    this.scroll = 0                // lines scrolled up from bottom (0 = follow)
    this.overlay = null            // 'help' | 'settings' | 'rewind' | 'git-branches' | null
    this.settingsSelection = 0
    this.settingsEditing = null
    this.settingsDraft = ''
    this.settingsSecret = false
    this.settingsConfirm = null
    this.settingsBusy = false       // update checks / installs animate a subtitle spinner
    this.settingsTitle = tr('settings.title')
    this.settingsSubtitle = ''
    this.settingsItems = []
    this.settingsMenu = []          // left menu of the settings dialog: [{ id, label }]
    this.settingsMenuIndex = 0      // active left-menu entry (Tab switches it)
    this.settingsScrollOffset = 0   // scroll offset for the settings window (wheel scroll support)
    this.toast = null              // { text, level }
    this.cornerNotice = null
    this._cornerNoticeTimer = null
    this.mcpNotice = null          // { name, status } — the corner notice
    this._mcpNotices = []
    this._mcpNoticeTimer = null
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
    // 'show' renders the context boxes collapsed; 'hide' drops them from the
    // transcript entirely (developer setting, see App.setContextDetails).
    this.contextDetails = 'show'
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
    // The geometry each in-flight render was requested for. A resize can land
    // while the host is decoding; stamping the result with what was asked for
    // (not with what is current when it arrives) is what lets the next frame
    // notice the mismatch and render again.
    this._imagePendingSig = new Map()
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

  setTheme(value) {
    const id = normalizeThemeId(value)
    if (id === this.themeId) return false
    this.themeId = id
    this.theme = getTheme(id)
    this._blockLineCache.clear()
    return true
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
    const target = region ? region.kind + ':' + (region.settingsIndex ?? region.sessionIndex ?? region.rewindIndex ?? region.branchIndex ?? '') : ''
    const focusIndex = region ? (region.settingsIndex ?? region.sessionIndex ?? region.rewindIndex ?? region.branchIndex ?? -1) : -1
    const currentFocus = region?.kind === 'settings-item' ? this.settingsSelection
      : region?.kind === 'rewind-item' ? this.rewind?.selected
      : region?.kind === 'rewind-option' ? this.rewind?.modeIndex
      : region?.kind === 'git-branch-item' ? this.gitBranches?.selected
      : this.sidebarSelection
    const focusDiffers = focusIndex >= 0 && focusIndex !== currentFocus
    if (target === this._lastHover && !focusDiffers) return false
    this._lastHover = target
    if (!region) return false
    this.focusedRegion = 'mouse'
    if (region.kind === 'settings-item') this.settingsSelection = region.settingsIndex
    if (region.kind === 'session') this.sidebarSelection = region.sessionIndex
    if (region.kind === 'git-branch-item' && this.gitBranches) this.gitBranches.selected = region.branchIndex
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
          ? mergeStyle(cell.style, { bg: this.theme.selection })
          : makeStyle({ bg: this.theme.selection })
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
    // leaking the previous session's title. `untitled` is the sentinel the
    // header resolves through the catalog at paint time, so a language switch
    // renames the placeholder too.
    this.untitled = true
    this.title = ''
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
    if (title !== undefined) {
      this.title = title
      this.untitled = title === '' || title === undefined
    }
    if (model !== undefined) {
      if (model !== this.model) this._requestModel = undefined
      this.model = model
    }
    if (provider !== undefined) this.provider = provider
  }

  setRequestModel(model) {
    if (typeof model === 'string') this._requestModel = model
  }

  setStatus(status) {
    if (status === 'idle' && this.status !== 'idle') this.finalizeAssistant()
    this.status = status
    if (status === 'idle' && this._pendingModelChanges.length) {
      for (const block of this._pendingModelChanges.splice(0)) this._insertModelChange(block)
    }
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
  _statsGroups({ billing = true } = {}) {
    const m = this.metrics ?? {}
    const groups = []
    if ((m.steps ?? 0) > 0) {
      groups.push(count(m.turns ?? 0, 'transcript.turns') + ' · ' + count(m.steps, 'transcript.steps'))
      const durations = []
      if ((m.llmMs ?? 0) > 0) durations.push(tr('stats.llmTime', { value: formatDuration(m.llmMs) }))
      if ((m.toolMs ?? 0) > 0) durations.push(tr('stats.toolTime', { value: formatDuration(m.toolMs) }))
      if (durations.length > 0) groups.push(durations.join(' · '))
      const speeds = []
      if ((m.ttftSteps ?? 0) > 0) speeds.push(tr('stats.ttft', { value: formatDuration(m.ttftMs / m.ttftSteps) }))
      if ((m.decodeMs ?? 0) > 0) speeds.push(tr('stats.tokensPerSecond', { value: formatMetric(m.decodeTokens / (m.decodeMs / 1000)) }))
      if (speeds.length > 0) groups.push(speeds.join(' · '))
    }
    if (billing && ((m.billedInputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0)) {
      if (m.cacheHitRate !== undefined) groups.push(tr('stats.cacheRate', { percent: m.cacheHitRate }))
      groups.push(tr('stats.inOut', { input: formatTokens(m.billedInputTokens ?? 0), output: formatTokens(m.outputTokens ?? 0) }))
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
  openSettings(items, { title = tr('settings.title'), subtitle = '', menu = [], menuIndex = 0 } = {}) {
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

  // ---- git branch switcher ------------------------------------------------
  // Rows for the branch window: one non-selectable header per section, then
  // one row per branch. Rebuilt from the fresh lists on every refresh so the
  // current marker and the remote set can never go stale in an open window.

  _gitBranchItems(local, remote, current) {
    const items = []
    if (local.length > 0) {
      items.push({ kind: 'header', label: tr('git.local') })
      for (const name of local) {
        items.push({ kind: 'branch', ref: name, name, remote: false, current: name === current })
      }
    }
    if (remote.length > 0) {
      items.push({ kind: 'header', label: tr('git.remote') })
      for (const name of remote) {
        items.push({ kind: 'branch', ref: name, name, remote: true, current: false })
      }
    }
    return items
  }

  openGitBranches({ cwd = '', root = '', current = '', local = [], remote = [] } = {}) {
    this.gitBranches = {
      cwd,
      root,
      current,
      local,
      remote,
      items: this._gitBranchItems(local, remote, current),
      selected: 0,
      scroll: 0,
      busy: false,
      error: '',
      status: '',
    }
    this.overlay = 'git-branches'
    this._preselectGitBranch(current)
  }

  closeGitBranches() {
    if (this.overlay === 'git-branches') this.overlay = null
    this.gitBranches = null
  }

  // Replace the branch data after a switch, pull or refresh. The selection
  // follows the branch it was on when that branch still exists, so a pull
  // that only updates the remote set does not yank the cursor elsewhere; a
  // list that dropped it (a pruned remote branch) lands on the new current
  // branch instead of on an arbitrary row.
  setGitBranchList({ current = '', local = [], remote = [] } = {}) {
    const picker = this.gitBranches
    if (!picker) return
    const row = picker.items[picker.selected]
    const previousRef = row?.kind === 'branch' ? row.ref : null
    picker.current = current
    picker.local = local
    picker.remote = remote
    picker.items = this._gitBranchItems(local, remote, current)
    this._preselectGitBranch(previousRef, current)
  }

  // Point the selection at the first candidate ref that still has a row, else
  // at the first branch there is. Candidates arrive most-preferred first.
  _preselectGitBranch(...candidates) {
    const picker = this.gitBranches
    if (!picker) return
    let target = -1
    for (const ref of candidates) {
      if (!ref) continue
      target = picker.items.findIndex((item) => item.kind === 'branch' && item.ref === ref)
      if (target >= 0) break
    }
    if (target < 0) target = picker.items.findIndex((item) => item.kind === 'branch')
    picker.selected = target < 0 ? 0 : target
    this._clampGitBranchesScroll()
  }

  moveGitBranches(delta) {
    const picker = this.gitBranches
    if (!picker || picker.busy) return
    const count = picker.items.length
    if (count === 0) return
    let index = picker.selected
    let steps = count
    while (steps-- > 0) {
      index = (index + delta + count) % count
      if (settingsRowSelectable(picker.items[index])) break
    }
    picker.selected = index
    this._clampGitBranchesScroll()
  }

  _clampGitBranchesScroll() {
    const picker = this.gitBranches
    if (!picker) return
    const visible = 7
    const n = picker.items.length
    const sel = picker.selected
    if (sel < picker.scroll) picker.scroll = sel
    if (sel >= picker.scroll + visible) picker.scroll = sel - visible + 1
    picker.scroll = Math.max(0, Math.min(picker.scroll, Math.max(0, n - visible)))
  }

  // Point the selection at an item index, skipping rows that carry no action
  // (kind 'header' rows are never selectable): a landing on one moves down to
  // the next real item, or back to the first selectable one.
  setSettingsSelection(index) {
    const items = this.settingsItems
    if (items.length === 0) {
      this.settingsSelection = 0
      return
    }
    let target = Math.max(0, Math.min(index, items.length - 1))
    while (target < items.length && !settingsRowSelectable(items[target])) target++
    if (target >= items.length) {
      const first = items.findIndex(settingsRowSelectable)
      target = first < 0 ? 0 : first
    }
    this.settingsSelection = target
  }

  // Move the selection by one row in either direction, wrapping around and
  // stepping over rows with no action so it always rests on a selectable item.
  moveSettingsSelection(delta) {
    const count = this.settingsItems.length
    if (count === 0) return
    let index = this.settingsSelection
    let steps = count
    while (steps-- > 0) {
      index = (index + delta + count) % count
      if (settingsRowSelectable(this.settingsItems[index])) break
    }
    this.settingsSelection = index
  }

  addSystem(text, level = 'info') {
    this.detachInboxBlock()
    this.blocks.push(makeBlock('system', { text, level }))
    this._maybeFollow()
  }

  addModelChange(from, to, { beforeLatestUser = false, defer = false } = {}) {
    const oldModel = transcriptText(from?.model).trim()
    const newModel = transcriptText(to?.model).trim()
    const oldProvider = transcriptText(from?.provider).trim()
    const newProvider = transcriptText(to?.provider).trim()
    if (!oldModel || !newModel || (oldModel === newModel && oldProvider === newProvider)) return
    const block = makeBlock('model-change', {
      from: { model: oldModel, provider: oldProvider },
      to: { model: newModel, provider: newProvider },
    })
    if (defer && this.status !== 'idle') this._pendingModelChanges.push(block)
    else this._insertModelChange(block, beforeLatestUser)
  }

  _insertModelChange(block, beforeLatestUser = false) {
    this.detachInboxBlock()
    let index = this.blocks.length
    if (beforeLatestUser) {
      const user = this.blocks.findLastIndex((entry) => entry.kind === 'user')
      if (user >= 0 && !this.blocks.slice(user + 1).some((entry) => entry.kind === 'assistant' || entry.kind === 'tool')) index = user
    }
    this.blocks.splice(index, 0, block)
    this._maybeFollow()
  }

  addNote(text, label = 'context') {
    this.detachInboxBlock()
    this.blocks.push(makeBlock('note', { text, label, collapsed: true }))
    this.scroll = 0
  }

  addUser(text, { steering = false, images, time = Date.now() } = {}) {
    this.detachInboxBlock()
    const block = makeBlock('user', { text, steering, time })
    if (images?.length) block.images = images
    this.blocks.push(block)
    this._turnStartedAt = time
    this._turnAssistant = null
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

  // Badge the most recent user block as a steering turn. A steered prompt is
  // drawn by the composer first and echoed by the loop only when the inbox
  // claim happens, so the badge is applied to that block rather than to a new
  // one — the two would otherwise sit next to each other and read as a repeat.
  markLastUserSteering() {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]
      if (b.kind !== 'user') continue
      if (b.steering) return true
      b.steering = true
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
      maxCellsW: Math.max(1, Math.min(72, this._lastTransWidth - 9)),
      maxCellsH: this.imageMaxRows,
      cellW: this.imageCellW,
      cellH: this.imageCellH,
      bgHex: this.theme.background,
    }
  }

  // Identity of the geometry every image render is built for. A result carries
  // the signature it was produced under, so a frame at a different width (a
  // resize, a sidebar toggled open) can tell that the raster on hand was scaled
  // for the old grid and ask again, instead of drawing it at the wrong size
  // until the session is reopened.
  imageRenderSignature() {
    const o = this.imageRenderOptions()
    return [o.protocol, o.maxCellsW, o.maxCellsH, o.cellW, o.cellH, o.bgHex].join('|')
  }

  // A render landed for an image key: cache it and refresh every block that
  // shows the source so the next frame picks the finished render up. The block
  // set survives the bump — a result can be replaced (protocol upgrade after
  // caps probing, width re-render) and the replacement must reach the same
  // blocks; the map is cleared with the line cache in resetView.
  setImageResult(key, result) {
    const sig = this._imagePendingSig.get(key) ?? this.imageRenderSignature()
    this._imagePendingSig.delete(key)
    this._imageResults.set(key, { ...result, sig })
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
    this._imagePendingSig.set(cropKey, this.imageRenderSignature())
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
      out.push({ segs: [{ text: tr('image.attachment'), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
      return
    }
    // Geometry check: a finished render whose signature no longer matches the
    // current grid was scaled for a different width and would draw at the wrong
    // size inside this one. Drop it — and the bookkeeping around it, or the
    // request would never be repeated — so the placeholder shows for the frame
    // or two the re-render takes.
    const sig = this.imageRenderSignature()
    let result = this._imageResults.get(key)
    if (result && result.sig !== undefined && result.sig !== sig) {
      this._imageResults.delete(key)
      this._imageRequested.delete(key)
      this._imageCrops.delete(key)
      result = undefined
    }
    if (!result) {
      result = { state: 'loading', sig }
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
        this._imagePendingSig.set(key, sig)
        this.onImageRequest?.(src)
      }
      out.push({ segs: [{ text: tr('image.rendering'), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
      return
    }
    if (result.state === 'error') {
      out.push({ segs: [{ text: tr('image.renderFailed', { error: truncateWidth(result.error ?? tr('common.unknown'), Math.max(8, width - 28)) }), style: makeStyle({ fg: this.theme.error }) }] })
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
    for (const line of renderMarkdown(text, this.theme, width, hooks)) {
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
    // A fence that is still streaming is a partial diagram: laying it out costs
    // a full parse per frame for a picture that changes on the next chunk, and
    // the half-drawn boxes flash as it grows. Keep the source visible until the
    // block settles — the finished block invalidates the line cache and draws
    // the diagram then.
    if (!off && block?.streaming === true) {
      for (const line of renderMarkdown('```mermaid\n' + code + '\n```', this.theme, width)) {
        out.push({ segs: line })
      }
      return
    }
    if (!off) {
      if (engine === 'loading') {
        out.push({ segs: [{ text: tr('image.mermaidRendering'), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
        return
      }
      if (engine) {
        const art = renderMermaidArt(engine, code)
        if (art) {
          const budget = width - MERMAID_INDENT_WIDTH - MERMAID_MARGIN
          if (art.width <= budget) {
            for (const segs of paintMermaidArt(art, this.theme, MERMAID_INDENT)) out.push({ segs })
            return
          }
          // Real art, wider than this pane: name what it needs and show the
          // source. A raster of the same diagram reads worse, and sending the
          // source to mermaid.ink to draw what the engine already drew leaks
          // it for nothing.
          out.push({ segs: [{ text: tr('image.mermaidTooWide', { width: art.width, budget: Math.max(0, budget) }), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
          for (const line of renderMarkdown('```mermaid\n' + code + '\n```', this.theme, width)) {
            out.push({ segs: line })
          }
          return
        }
      }
    }

    // Off, or a grammar the engine does not draw: the provider chain draws it
    // as an image unless the setting says a diagram stays its own source.
    if (off) {
      for (const line of renderMarkdown('```mermaid\n' + code + '\n```', this.theme, width)) {
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
      out.push({ segs: [{ text: tr('image.mermaidRendering'), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
      return
    }
    if (result.state === 'done') {
      this._imageLines({ kind: 'bytes', key: result.imageKey, bytes: result.bytes }, block, width, out)
      return
    }
    // fallback / error: the source, highlighted.
    for (const line of renderMarkdown('```mermaid\n' + code + '\n```', this.theme, width)) {
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
    out.push({ segs: [{ text: '🖼 ' + (alt || tr('image.altFallback')), style: makeStyle({ fg: this.theme.textMuted, italic: true }) }] })
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
    this._appendAssistant(Date.now(), true)
    this.scroll = 0
  }

  _hideAssistantFooter() {
    if (!this._turnAssistant || this._turnAssistant.showFooter === false) return
    this._turnAssistant.showFooter = false
    this._turnAssistant.rev++
  }

  _appendAssistant(time = Date.now(), streaming = false) {
    this.detachInboxBlock()
    this._hideAssistantFooter()
    const block = makeBlock('assistant', {
      text: '', reasoning: '', streaming, time, showFooter: true,
      model: this._requestModel ?? this.model, turnStartedAt: this._turnStartedAt,
    })
    this.blocks.push(block)
    this._turnAssistant = block
    return block
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
        b.time = Date.now()
        b.rev++
        // Thinking is collapsed by default once it has finished streaming.
        if (b.reasoning && b.thinkingCollapsed === undefined) b.thinkingCollapsed = true
        if (b.text === '' && !reasoningText(b.reasoning)) this.blocks.splice(i, 1)
        break
      }
    }
  }

  // Ensure an assistant block exists (e.g. replay); returns it.
  ensureAssistantBlock(time) {
    this.detachInboxBlock()
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === 'assistant') return last
    return this._appendAssistant(time)
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
    this._hideAssistantFooter()
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

  // Show or hide the harness-plumbing boxes (runtime-context snapshot, system
  // prompt, system reminders). The blocks stay in the list either way — only
  // their rendering is gated — so flipping the setting back is instant and
  // needs no replay of the session log. Every block's cached rows are dropped
  // because a hidden block leaves no rows behind, which changes the gutter the
  // neighbours get.
  setContextDetails(value) {
    const next = value === 'hide' ? 'hide' : 'show'
    if (next === this.contextDetails) return false
    this.contextDetails = next
    this._blockLineCache.clear()
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
    this._turnStartedAt = undefined
    this._turnAssistant = null
    this._pendingModelChanges = []
    this._requestModel = undefined
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
    this._imagePendingSig.clear()
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
    if (!block || block.kind !== 'assistant' || !reasoningText(block.reasoning) || block.streaming) return
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

  // True while anything is still animating: a streaming turn or a running
  // tool (read/write/bash/...). The UI loop keeps repainting while this is
  // true so spinners keep flowing even when no events are arriving.
  hasAnimation() {
    if (this.status === 'running') return true
    // The settings update page keeps repainting while a registry check or
    // install is in flight so its subtitle spinner keeps flowing.
    if (this.settingsBusy) return true
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

  showCornerNotice(title, detail, level = 'info') {
    this.cornerNotice = { title: String(title), detail: String(detail), level }
    if (this._cornerNoticeTimer) clearTimeout(this._cornerNoticeTimer)
    if (!this.terminal || typeof this.terminal.paint !== 'function') return
    this._cornerNoticeTimer = setTimeout(() => {
      this.clearCornerNotice()
      if (this.terminal.started) this.terminal.paint(this.render())
    }, 5000)
    this._cornerNoticeTimer.unref?.()
  }

  clearCornerNotice() {
    if (this._cornerNoticeTimer) clearTimeout(this._cornerNoticeTimer)
    this._cornerNoticeTimer = null
    this.cornerNotice = null
  }

  // An MCP server's connection result. Shown in the corner for two seconds,
  // independent of the bottom toast: a modal or a status line must not hide
  // the answer to "did that server come up".
  showMcpNotice(name, status) {
    this._mcpNotices.push({ name: String(name), status })
    if (!this.mcpNotice) this._nextMcpNotice()
  }

  _nextMcpNotice() {
    this.mcpNotice = this._mcpNotices.shift() ?? null
    if (!this.mcpNotice || !this.terminal || typeof this.terminal.paint !== 'function') return
    this._mcpNoticeTimer = setTimeout(() => {
      this._mcpNoticeTimer = null
      this._nextMcpNotice()
      if (this.terminal.started) this.terminal.paint(this.render())
    }, 2000)
    this._mcpNoticeTimer.unref?.()
  }

  clearMcpNotices() {
    if (this._mcpNoticeTimer) clearTimeout(this._mcpNoticeTimer)
    this._mcpNoticeTimer = null
    this._mcpNotices = []
    this.mcpNotice = null
  }

  // ---- layout ----------------------------------------------------------

  commandMatches() {
    if (this._commandQuery !== this.inputText) {
      this._commandQuery = this.inputText
      this.commandSelection = 0
      this._commandDismissed = false
    }
    if (this._commandDismissed || !/^\/\S*$/.test(this.inputText)) return []
    return COMMAND_HINTS.filter(([command]) => command.startsWith(this.inputText))
  }

  moveCommandSelection(delta) {
    const matches = this.commandMatches()
    if (!matches.length) return false
    this.commandSelection = (this.commandSelection + delta + matches.length) % matches.length
    return true
  }

  completeCommand(index = this.commandSelection) {
    const match = this.commandMatches()[index]
    if (!match) return false
    this.inputText = match[0] + ' '
    this.inputCursor = this.inputText.length
    return true
  }

  dismissCommands() {
    if (!this.commandMatches().length) return false
    this._commandDismissed = true
    return true
  }

  _layout() {
    const cols = this.terminal.cols
    const rows = this.terminal.rows
    const headerH = 1
    const statusH = 1
    const sliderH = this.effortSliderVisible && this.effortSlider ? 1 : 0
    const home = this.titleScreen && this.blocks.length === 0 && !this.pendingApproval
    // The right status rail claims one border column plus RAIL_WIDTH content
    // columns; `borderX` is the main area's exclusive right edge (the border
    // glyph's own column). Narrow windows keep the single-column layout.
    const railW = !home && cols >= RAIL_MIN_COLS ? RAIL_WIDTH : 0
    const borderX = railW > 0 ? cols - railW - 1 : cols
    const sidebarW = !home && this.sidebarVisible && borderX >= 110
      ? Math.max(22, Math.min(30, this.sidebarWidth)) : 0
    const { composerX, composerW } = composerGeometry(cols, sidebarW, railW, home)
    const composerWidth = Math.max(1, composerW - 4)
    const visual = inputRows(this.inputText, this.inputCursor, composerWidth)
    const suggestions = this.pendingApproval ? 0 : Math.min(Math.max(1, Math.min(6, rows - 12)), this.commandMatches().length)
    const imageHintH = this.inputImages.length > 0 ? 1 : 0
    const composerGap = !this.pendingApproval && rows >= 12 ? 1 : 0
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
    const maxComposerRows = Math.max(1, rows - headerH - statusH - sliderH - imageHintH - statsH - suggestions - 2 - composerGap)
    let inputRowsVisible
    if (this.pendingApproval) {
      const approval = this._approvalLines(composerTextWidth(cols, sidebarW, railW, home), maxComposerRows)
      inputRowsVisible = Math.max(1, Math.min(approval.length, maxComposerRows))
    } else {
      inputRowsVisible = Math.min(Math.max(1, visual.rows.length), rows >= 28 ? 6 : 3, maxComposerRows)
    }
    const inputH = inputRowsVisible + 2 + composerGap + suggestions
    const transcriptTop = headerH
    const dockTop = rows - inputH - statusH - sliderH - imageHintH - statsH
    const transcriptBottom = home && rows >= 16
      ? Math.min(dockTop, Math.max(headerH + 4, Math.min(dockTop - 3, Math.floor(rows * 0.44)))) : dockTop
    const transcriptH = Math.max(1, transcriptBottom - transcriptTop)
    return { cols, rows, home, headerH, inputH, inputRowsVisible, composerGap, suggestions, imageHintH, statsH, statusH, sliderH, transcriptTop, transcriptBottom, transcriptH, sidebarW, railW, borderX, composerX, composerW, composerWidth, visual }
  }

  // ---- block -> lines --------------------------------------------------

  _blockLines(block, width) {
    const t = this.theme
    const out = []
    const gutter = ['user', 'assistant', 'tool', 'model-change'].includes(block.kind)
      ? Math.min(2, Math.max(0, Math.floor((width - 12) / 2)))
      : 0
    width = Math.max(1, width - gutter * 2)
    switch (block.kind) {
      case 'model-change': {
        const route = (value) => value.model + (value.provider ? ' · ' + value.provider : '')
        const text = tr('transcript.modelChanged', { from: route(block.from), to: route(block.to) })
        const muted = makeStyle({ fg: t.textMuted })
        const rule = makeStyle({ fg: t.borderSubtle })
        const content = '◇ ' + text
        out.push({ segs: [] })
        if (displayWidth(content) + 6 <= width) {
          const available = width - displayWidth(content) - 2
          const left = Math.floor(available / 2)
          out.push({ segs: [
            { text: '─'.repeat(left) + ' ', style: rule },
            { text: content, style: muted },
            { text: ' ' + '─'.repeat(available - left), style: rule },
          ] })
        } else {
          for (const line of wrapText(content, Math.max(2, width))) {
            out.push({ segs: [{ text: line, style: muted }] })
          }
        }
        out.push({ segs: [] })
        break
      }
      case 'user': {
        const bodyWidth = Math.max(2, width - 5)
        const body = []
        // Prompts preserve their literal markdown, as in OpenCode's text part.
        for (const text of wrapText(transcriptText(block.text), bodyWidth)) {
          body.push({ segs: [{ text, style: makeStyle({ fg: t.text }) }] })
        }
        if (block.images?.length) {
          if (block.text) body.push({ segs: [] })
          for (const src of block.images) this._imageLines(src, block, bodyWidth, body)
        }
        body.push({ segs: [
          { text: timeString(block.time), style: makeStyle({ fg: t.textMuted }) },
          ...(block.steering ? [{ text: tr('transcript.steeringBadge'), style: makeStyle({ fg: t.steering, bold: true }) }] : []),
        ] })
        if (this.blocks[0] !== block) out.push({ segs: [] })
        out.push(...transcriptPanel(body, width, block.steering ? t.steering : t.userPointer, t))
        break
      }
      case 'assistant': {
        const reasoning = reasoningText(block.reasoning)
        if (!block.text && !reasoning && !block.images?.length) break
        out.push({ segs: [] })
        if (reasoning) {
          const streaming = block.streaming === true
          const collapsed = block.thinkingCollapsed === true || streaming
          const hint = streaming ? tr('transcript.streaming') : (collapsed ? tr('common.clickExpand') : tr('common.clickCollapse'))
          const marker = streaming
            ? { text: '⠿', style: makeStyle({ fg: t.primary, bold: true }), anim: 'spinner' }
            : { text: collapsed ? '+' : '−', style: makeStyle({ fg: t.thinking }) }
          const body = []
          if (!collapsed) {
            body.push([])
            for (const line of renderMarkdown(reasoning, t, Math.max(1, width - 3))) {
              body.push(line.map((s) => tintMarkdownSegment(s, { fg: t.thinking, italic: true }, t)))
            }
          }
          const previewBudget = Math.max(0, width - 7 - displayWidth(tr('transcript.thinking')) - displayWidth(hint))
          const preview = collapsed && !streaming && previewBudget > 0
            ? truncateWidth(thinkingPreview(reasoning), previewBudget) : ''
          out.push(...flatRows('thinking', block, [
            { text: '   ', style: null },
            marker,
            { text: tr('transcript.thinking'), style: makeStyle({ fg: t.thinking }) },
            ...(preview
              ? [
                  { text: ' · ', style: makeStyle({ fg: t.thinking, dim: true }) },
                  { text: preview, style: makeStyle({ fg: t.thinking, italic: true }) },
                ]
              : []),
            { text: hint, style: makeStyle({ fg: t.textMuted, dim: true }) },
          ], body, 3, width))
          if (block.text) out.push({ segs: [] })
        }
        let text = block.text ?? ''
        if (block.streaming && text) text += '▍'
        if (text) {
          const body = []
          this._markdownLines(text, block, Math.max(1, width - 3), body)
          for (const line of body) out.push(indentTranscriptRow(line, 3))
        }
        const images = []
        for (const src of block.images ?? []) this._imageLines(src, block, Math.max(1, width - 3), images)
        for (const line of images) out.push(indentTranscriptRow(line, 3))
        if (!block.streaming && block.showFooter !== false) {
          const model = block.model ?? this.model
          const duration = block.time - block.turnStartedAt
          out.push({ segs: [] })
          out.push({ segs: [
            { text: '   ▣  ', style: makeStyle({ fg: t.primary }) },
            { text: 'dsh', style: makeStyle({ fg: t.text }) },
            ...(model ? [{ text: ' · ' + model, style: makeStyle({ fg: t.textMuted }) }] : []),
            ...(Number.isFinite(duration) && duration > 0
              ? [{ text: ' · ' + formatDuration(duration), style: makeStyle({ fg: t.textMuted }) }] : []),
          ] })
        }
        out.push({ segs: [] })
        break
      }
      case 'tool': {
        const running = block.status === 'running'
        const expanded = block.expanded === true
        const shell = ['bash', 'pwsh', 'shell'].includes(block.name)
        const preview = !running && (shell || block.status === 'error') && !!block.result
        const panel = expanded || preview
        const accent = toolAccent(block.name, t)
        const statusColor = running ? t.warning : block.status === 'error' ? t.error : t.success
        const icon = shell ? '$' : ['read'].includes(block.name) ? '→'
          : ['write', 'edit', 'str_replace_editor'].includes(block.name) ? '←'
            : ['glob', 'grep', 'web_search'].includes(block.name) ? '✱' : '◇'
        const marker = running
          ? { text: '⠿', style: makeStyle({ fg: statusColor, bold: true }), anim: 'spinner' }
          : { text: block.status === 'error' ? '✗' : icon, style: makeStyle({ fg: block.status === 'error' ? t.error : accent }) }
        const summary = transcriptText(toolSummary(block.name, block.args)).replace(/\n/g, ' ')
        const cut = summary.indexOf(' ')
        const verb = cut < 0 ? summary : summary.slice(0, cut)
        const rawTarget = cut < 0 ? '' : summary.slice(cut + 1)
        const hint = running ? '' : (expanded ? tr('common.clickCollapse') : tr('common.clickExpand'))
        const budget = Math.max(1, width - (panel ? 10 : 7) - displayWidth(verb) - displayWidth(hint))
        const target = truncateWidth(rawTarget, budget)
        const header = {
          segs: [
            marker,
            { text: ' ', style: null },
            { text: verb, style: makeStyle({ fg: accent, bold: true }) },
            ...(target ? [{ text: '  ' + target, style: makeStyle({ fg: t.textMuted }) }] : []),
            ...(hint ? [{ text: hint, style: makeStyle({ fg: t.textMuted, dim: true }) }] : []),
          ],
          tool: { block },
        }
        if (panel) {
          const cap = expanded ? 400 : 10
          const bodyWidth = Math.max(2, width - 5)
          const body = shell
            ? wrapText(rawTarget || summary, Math.max(2, bodyWidth - 2)).map((text, i) => ({
              segs: [
                i === 0 ? marker : { text: ' ', style: null },
                { text: ' ' + text, style: makeStyle({ fg: t.text }) },
              ],
            }))
            : [header]
          body.push({ segs: [] })
          const resultLines = shell
            ? wrapText(transcriptText(block.result), bodyWidth).map((text) => [{ text, style: makeStyle({ fg: t.text }) }])
            : renderMarkdown(block.result ?? '', t, bodyWidth)
          const shown = Math.min(resultLines.length, cap)
          for (let i = 0; i < shown; i++) {
            body.push({ segs: resultLines[i] })
          }
          if (resultLines.length > cap) {
            body.push({ segs: [{ text: tr('common.moreLines', { count: resultLines.length - cap }), style: makeStyle({ fg: t.textMuted, dim: true }) }] })
          }
          if (expanded) for (const src of block.images ?? []) this._imageLines(src, block, bodyWidth, body)
          if (shell && hint) {
            body.push({ segs: [] })
            body.push({ segs: [{ text: hint.trimStart(), style: makeStyle({ fg: t.textMuted, dim: true }) }] })
          }
          out.push({ segs: [] })
          out.push(...transcriptPanel(body, width, block.status === 'error' ? t.error : t.borderSubtle, t, { tool: { block } }))
          out.push({ segs: [] })
        } else {
          out.push(indentTranscriptRow(header, 3))
        }
        break
      }
      case 'todo': {
        out.push({ segs: [{ text: '  ' + tr('transcript.tasks'), style: makeStyle({ fg: t.info, bold: true }) }] })
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
        // Context notes (system-reminder / runtime-context / compaction): one
        // flat marker row naming the label, the body hanging under it in the
        // label's own color, collapsed by default. Whole block clickable to
        // toggle. A developer setting can drop the harness-plumbing kinds.
        if (this.contextDetails === 'hide' && CONTEXT_LABELS.has(block.label)) break
        const fg = block.label === 'compaction' ? t.compaction
          : block.label === 'runtime-context' ? t.systemPrompt : t.reminder
        const collapsed = block.collapsed === true
        const hint = collapsed ? tr('common.clickExpand') : tr('common.clickCollapse')
        const body = []
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, Math.max(8, width - 6))) {
            body.push(line.map((s) => tintMarkdownSegment(s, { fg }, t)))
          }
        }
        out.push(...flatRows('note', block, [
          { text: '  ', style: null },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg, bold: true }) },
          { text: ' ' + tr(noteLabelKey(block.label)) + hint, style: makeStyle({ fg, bold: true }) },
        ], body, 4, width))
        out.push({ segs: [] })
        break
      }
      case 'system': {
        const color = block.level === 'error' ? t.error : block.level === 'warn' ? t.warning : t.textMuted
        for (const line of renderMarkdown(block.text, t, width - 2)) {
          out.push({ segs: [{ text: '  ', style: null }, ...line.map((s) => tintMarkdownSegment(s, { fg: color, italic: true }, t, true))] })
        }
        out.push({ segs: [] })
        break
      }
      case 'sysnote': {
        // The session's system prompt (V3 `system/message`): the same flat
        // collapsible shape as the other notes, in its own neutral palette so
        // it never reads as a reminder or a compaction checkpoint.
        if (this.contextDetails === 'hide') break
        const fg = t.systemPrompt
        const collapsed = block.collapsed === true
        const hint = collapsed ? tr('common.clickExpand') : tr('common.clickCollapse')
        const body = []
        if (!collapsed) {
          for (const line of renderMarkdown(block.text, t, Math.max(8, width - 6))) {
            body.push(line.map((s) => tintMarkdownSegment(s, { fg }, t)))
          }
        }
        out.push(...flatRows('note', block, [
          { text: '  ', style: null },
          { text: collapsed ? '▸' : '▾', style: makeStyle({ fg, bold: true }) },
          { text: tr('transcript.systemPrompt') + hint, style: makeStyle({ fg, bold: true }) },
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
        if (nextStep.length > 0) counts.push(nextStep.length + tr('transcript.steering'))
        if (nextTurn.length > 0) counts.push(nextTurn.length + tr('transcript.queued'))
        const hint = expanded ? tr('common.clickCollapse') : tr('common.clickExpand')
        const rows = [
          ...nextStep.map((message) => ({ marker: '⟲', kind: tr('transcript.steering').trim(), message })),
          ...nextTurn.map((message) => ({ marker: '↳', kind: tr('transcript.queued').trim(), message })),
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
          { text: tr('transcript.pendingInput') + counts.join(' · ') + hint, style: makeStyle({ fg, bold: true }) },
        ], body, 6, width))
        out.push({ segs: [] })
        break
      }
      default:
        break
    }
    return out.map((row) => ({ ...row, inset: gutter, rightInset: gutter }))
  }

  // Return the cached rendered lines for a block, re-rendering only when its
  // content (rev) changed. The live streaming block is re-rendered at a
  // throttled rate: re-parsing its whole markdown on every paint is the main
  // cost that grows with output, so short frames reuse the previous render.
  _ensureBlockLines(block, width) {
    const key = block.rev + ':' + width
    const cached = this._blockLineCache.get(block)
    if (cached && cached.key === key) return cached.lines
    if (block.streaming && cached?.width === width && Date.now() - this._streamingRenderAt < 120) {
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
    this._blockLineCache.set(block, { key, width, lines: rendered })
    return rendered
  }

  // Total rendered line count for the transcript at a given width.
  _transcriptTotal(width) {
    let total = 0
    let prevKind = null
    for (const block of this.blocks) {
      const rows = this._blockRows(block, width, prevKind)
      if (rows.length === 0) continue
      total += rows.length
      prevKind = block.kind
    }
    return total
  }

  // The rows one block contributes to the transcript, with the block gutter
  // applied. Each block renderer pads its own edges and those paddings drifted:
  // a user bubble opened with a gap but left none behind it, so a context note
  // right after one sat flush under the panel, while a system line owned only a
  // trailing gap and was glued to the block above. The gutter is decided here
  // instead — strip whatever blank rows the block put at its own edges, then
  // place exactly one between two occupied blocks — so every pair of blocks
  // reads at the same distance. A block that renders nothing (an assistant
  // block with no text yet) takes no room and no gutter at all.
  //
  // A run of tool calls is the one exception: those rows are a list of what the
  // turn did, and one gap per call would scatter it across the screen.
  //
  // The trimmed rows are cached on the block's own line-cache entry, so every
  // invalidation site (theme switch, a settled mermaid engine, a reset) drops
  // them together with the lines they were cut from.
  _blockRows(block, width, prevKind) {
    const lead = prevKind !== null && !(prevKind === 'tool' && block.kind === 'tool')
    const lines = this._ensureBlockLines(block, width)
    const entry = this._blockLineCache.get(block)
    const key = (entry?.key ?? '') + ':' + (lead ? 1 : 0)
    if (entry?.rows?.key === key) return entry.rows.lines
    let from = 0
    let to = lines.length
    while (from < to && isBlankRow(lines[from])) from++
    while (to > from && isBlankRow(lines[to - 1])) to--
    const rows = from === to ? [] : lines.slice(from, to)
    if (rows.length > 0 && lead) rows.unshift({ segs: [] })
    // An image row carries the index the draw pass reads as "how many rows of
    // this group sit above the window"; after a trim that index has moved.
    for (let i = 0; i < rows.length; i++) {
      const img = rows[i]?.image
      if (!img) continue
      const prev = rows[i - 1]?.image
      img.start = prev && prev.gid === img.gid ? prev.start : i
    }
    if (entry) entry.rows = { key, lines: rows }
    return rows
  }

  // ---- paint -----------------------------------------------------------

  render() {
    const { cols, rows, home, headerH, inputRowsVisible, composerGap, suggestions, imageHintH, statsH, transcriptTop, transcriptBottom, transcriptH, sidebarW, railW, borderX, composerX, composerW, visual } = this._layout()
    this.hitRegions = []
    const screen = new Screen(cols, rows)
    const t = this.theme
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
    hx = gradientText(screen, hx, 0, 'DeepSeek Harness TUI', '#4d6bfe', '#dce6ff', { bold: true, bg: t.backgroundPanel })
    let workspace = null
    // The placeholder a session with no title of its own shows: resolved here,
    // not when the session was opened, so a language switch renames it.
    const sessionTitle = this.untitled ? tr('session.newTitle') : this.title
    const hasTitle = Boolean(sessionTitle) && sessionTitle !== 'DeepSeek Harness'
    // The right block takes what is left of the row after the brand, the
    // session title and the margins. Within that budget the pieces yield in
    // order — the label first, then the branch (truncated, not dropped while
    // it still fits) — while the path is shortened from the head so the
    // project folder stays readable. The title itself gives ground only down
    // to 8 columns before the workspace gives up entirely.
    const workspaceLabel = tr(WORKSPACE_LABEL_KEY)
    const workspaceLabelW = displayWidth(workspaceLabel)
    const workspaceFor = (budget) => {
      if (!this.titleScreen && this.workingDirectory) {
        for (const [withLabel, withBranch] of [[true, true], [false, true], [false, false]]) {
          const branchW = withBranch && branch ? Math.min(displayWidth(branch), 20) + 3 : 0
          const labelW = withLabel ? workspaceLabelW + 1 : 0
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
    let titleW = hasTitle ? displayWidth(sessionTitle) : 0
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
        ? (workspace.label ? workspaceLabelW + 1 : 0) + displayWidth(workspace.path)
          + (workspace.branch ? displayWidth(workspace.branch) + 3 : 0)
        : 0
      hx = screen.text(hx, 0, '  ·  ', makeStyle({ fg: t.textMuted, bg: t.backgroundPanel }))
      // The title may grow back into whatever slack the shrunken allocation
      // left between it and the right block — the block is right-anchored, so
      // the extra columns are pure gap otherwise.
      const room = (workspace ? cols - 2 - rightW - 2 : cols - 2) - hx
      hx = screen.text(hx, 0, truncateWidth(sessionTitle, Math.max(1, room)), makeStyle({ fg: t.text, bold: true, bg: t.backgroundPanel }))
    }
    if (workspace) {
      const rightW = (workspace.label ? workspaceLabelW + 1 : 0) + displayWidth(workspace.path)
        + (workspace.branch ? displayWidth(workspace.branch) + 3 : 0)
      let wx = cols - 2 - rightW
      if (workspace.label) {
        wx = screen.text(wx, 0, workspaceLabel, makeStyle({ fg: t.textMuted, bg: t.backgroundPanel })) + 1
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
      screen.text(2, headerH, tr('sidebar.sessions'), makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
      const newSessionStyle = makeStyle({ fg: t.primary, bold: true, bg: t.backgroundPanel })
      screen.text(1, headerH + 1, tr('sidebar.newSession'), newSessionStyle)
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
          screen.text(2, sy, tr('sidebar.recent'), makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundPanel }))
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
    let prevKind = null
    for (const block of this.blocks) {
      const lines = this._blockRows(block, transWidth, prevKind)
      if (lines.length > 0) prevKind = block.kind
      const blockEnd = cursor + lines.length
      if (blockEnd > offset && cursor < endIndex) {
        const from = Math.max(0, offset - cursor)
        const to = Math.min(lines.length, endIndex - cursor)
        for (let i = from; i < to; i++) {
          const y = transcriptTop + row
          const line = lines[i]
          let x = transcriptX + (line.inset ?? 0)
          // Clip every row to the transcript width at the draw boundary. A row
          // is composed from a fixed prefix plus block content, and a single
          // segment (model-authored text, a long path, a wide rune at the last
          // column) can be wider than the box even when the markdown renderer
          // respected its own limit. Letting it through would paint past the
          // terminal edge, wrap the row, and shift the rest of the frame.
          const right = borderX - (line.rightInset ?? 0)
          const budget = Math.max(0, right - x)
          for (const seg of clipSegs(line.segs, budget)) {
            // Animated placeholders (spinners) are resolved at draw time so
            // the cached lines stay static between animation frames.
            const style = line.background ? makeStyle({ ...seg.style, bg: seg.style?.bg ?? line.background }) : seg.style
            x = screen.text(x, y, seg.anim ? this.animChar() : seg.text, style)
          }
          // The row tail fills to the main area's right edge; with the status
          // rail on screen the fill stops short of the rail's border column.
          screen.fill(x, y, Math.max(0, right - x), ' ', makeStyle({ fg: t.text, bg: line.background }))
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
                x: transcriptX + (line.inset ?? 0) + img.x,
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

    if (home) {
      paintSplashOpenCode(screen, cols, rows, t, {
        workingDirectory: this.workingDirectory,
        gitBranch: this.gitBranch,
        model: this.model,
        provider: this.provider,
      }, transcriptBottom + statsH - 1, {
        x0: composerX, width: composerW, composerTop: transcriptBottom,
        composerBottom: transcriptBottom + suggestions + imageHintH + inputRowsVisible + composerGap + 1,
      })
    }

    // Composer
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
      const hintSeat = lineWidth + hintW + 6 <= composerW
      const budget = composerX + composerW - 2 - (hintSeat ? hintW + 3 : 0)
      screen.fill(0, stripY, cols, ' ', makeStyle({ bg }))
      let sx = screen.text(composerX, stripY, '▤ ', makeStyle({ fg: t.primary, bg }))
      let drawn = 0
      for (const group of groups) {
        const lead = drawn > 0 ? ' ' : ''
        if (sx + displayWidth(lead) + displayWidth(group) > budget) break
        sx = screen.text(sx, stripY, lead + group, makeStyle({ fg: t.textMuted, bg }))
        drawn++
      }
      if (drawn < groups.length) screen.text(sx, stripY, ' …', makeStyle({ fg: t.border, bg }))
      if (hintSeat) screen.text(composerX + composerW - hintW - 2, stripY, hint, makeStyle({ fg: t.textMuted, bg }))
      this.addHitRegion('stats', 0, stripY, cols, 1)
    }
    if (suggestions > 0) {
      const matches = this.commandMatches()
      const start = Math.max(0, Math.min(this.commandSelection - suggestions + 1, matches.length - suggestions))
      for (let i = start; i < start + suggestions; i++) {
        const [command, description] = matches[i]
        const selected = i === this.commandSelection
        const bg = selected ? t.backgroundElement : t.backgroundPanel
        screen.fill(composerX, composerTop, composerW, ' ', makeStyle({ bg }))
        screen.text(composerX, composerTop, selected ? '┃' : ' ', makeStyle({ fg: t.primary, bg }))
        screen.text(composerX + 2, composerTop, truncateWidth(command, composerW - 4), makeStyle({ fg: selected ? t.secondary : t.text, bold: selected, bg }))
        if (composerW >= 40) screen.text(composerX + 18, composerTop, truncateWidth(tr(description), composerW - 20), makeStyle({ fg: t.textMuted, bg }))
        this.addHitRegion('command', composerX, composerTop, composerW, 1, { commandIndex: i })
        composerTop++
      }
    }
    if (imageHintH) {
      const hint = tr('composer.imageHint')
      screen.fill(composerX, composerTop, composerW, ' ', makeStyle({ bg: t.background }))
      screen.text(composerX + 2, composerTop, truncateWidth(hint, composerW - 4), makeStyle({ fg: t.warning, bold: true, bg: t.background }))
      composerTop++
    }
    const running = this.status === 'running'
    const composerBg = t.backgroundPanel
    const focusColor = this.pendingApproval ? t.warning : t.primary
    for (let i = 0; i < inputRowsVisible + composerGap + 2; i++) {
      screen.fill(composerX, composerTop + i, composerW, ' ', makeStyle({ bg: composerBg }))
      screen.set(composerX, composerTop + i, '┃', makeStyle({ fg: focusColor, bg: composerBg }))
    }
    this._paintEffortLabel(screen, composerX, composerTop, composerW)
    const firstVisual = Math.max(0, visual.cursorRow - inputRowsVisible + 1)
    // The approval prompt replaces the composer's content. Computed once: the
    // same helper _layout used to size the box, so the two agree by construction.
    const approvalLines = this.pendingApproval
      ? this._approvalLines(composerTextWidth(cols, sidebarW, railW, home), inputRowsVisible)
      : null
    for (let i = 0; i < inputRowsVisible; i++) {
      const y = composerTop + 1 + i
      const visualIndex = firstVisual + i
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
      if (!this.inputText && i === 0) {
        screen.text(lx, y, truncateWidth(tr('splash.hint'), composerW - 4), makeStyle({ fg: t.textMuted, bg: composerBg }))
      }
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
        const current = Array.from(this.inputText.slice(this.inputCursor))[0] ?? (!this.inputText ? Array.from(tr('splash.hint'))[0] : ' ')
        screen.text(cursorX, y, current === '\n' ? ' ' : current, makeStyle({ fg: t.background, bg: t.primary }))
      }
    }
    const bottom = composerTop + inputRowsVisible + composerGap + 1
    this.addHitRegion('composer', composerX, composerTop, composerW, inputRowsVisible + composerGap + 2, { composerTop, firstVisual })
    // The composer's mode label names the model that will receive the message.
    // With the status rail on screen the rail's MODEL section owns that fact,
    // so the label only stays for the interrupt hint.
    const mode = this.status === 'running'
      ? tr('status.interrupt')
      : railW > 0 ? '' : (this.provider ? this.provider + ' · ' : '') + (this.model || tr('status.model'))
    if (mode !== '') {
      screen.text(composerX + 2, bottom, truncateWidth(mode, Math.max(0, composerW - 4)), makeStyle({ fg: running ? t.warning : t.textMuted, bg: composerBg }))
    }
    const sendHints = tr('composer.keys').split(' · ').slice(0, 2).join(' · ')
    const hintsW = displayWidth(sendHints)
    if (!home && hintsW + displayWidth(mode) + 8 <= composerW) {
      paintKeyHints(screen, composerX + composerW - hintsW - 2, bottom, sendHints, hintsW, t, makeStyle({ fg: t.textMuted, bg: composerBg }))
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
      const phase = Math.floor(Date.now() / 70) % SPINNER.length
      screen.text(1, statusRow, SPINNER[phase], makeStyle({ fg: t.primary, bg: t.background }))
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
    const tokText = this.usage.input > 0 ? '' : tr('status.draftTokens', { count: roughTokens(this.inputText) })
    if (railW > 0) {
      if (tokText) screen.text(leftX, statusRow, tokText, statusStyle)
      const hint = tr('status.ctrlP')
      const hintX = cols - displayWidth(hint) - 2
      if (hintX > leftX + displayWidth(tokText) + 2) {
        screen.text(hintX, statusRow, hint, makeStyle({ fg: t.textMuted, dim: true, bg: t.background }))
      }
    } else {
      const modelName = this.model || tr('status.model')
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
    const keyHints = tr(suggestions > 0 ? 'composer.commandKeys' : 'composer.keys')
    if (home || (suggestions > 0 && cols >= 76)) {
      const hintW = displayWidth(keyHints)
      if (hintW + 4 <= borderX) {
        screen.fill(0, statusRow, borderX, ' ', statusStyle)
        paintKeyHints(screen, borderX - hintW - 2, statusRow, keyHints, hintW, t, statusStyle)
      }
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
    if (this.overlay || this.pendingQuestions || this.pendingSecret || this.statsOpen) {
      const shades = new Map()
      for (const row of screen.cells) {
        for (const cell of row) {
          const style = cell.style ?? {}
          const key = (style.fg ?? t.text) + ':' + (style.bg ?? t.background)
          if (!shades.has(key)) shades.set(key, makeStyle({
            fg: mixColor(style.fg ?? t.text, t.background, 0.6),
            bg: mixColor(style.bg ?? t.background, t.background, 0.35),
          }))
          cell.style = shades.get(key)
        }
      }
      screen.images = []
    }
    if (this.overlay === 'help') this._paintHelp(screen, cols, rows, railW)
    if (this.overlay === 'settings') this._paintSettings(screen, cols, rows, railW)
    if (this.overlay === 'rewind') this._paintRewind(screen, cols, rows, railW)
    if (this.overlay === 'git-branches') this._paintGitBranches(screen, cols, rows, railW)
    // The question modal owns the screen while a request is pending.
    this._questionCaret = null
    if (this.pendingQuestions) this._paintQuestions(screen, cols, rows, railW)
    else if (this.statsOpen && !this.overlay) this._paintStats(screen, cols, rows, railW)
    if (this.pendingSecret) this._paintSecret(screen, cols, rows, railW)

    // MCP connection notice: top-right, above the header, dismissed after two
    // seconds. It is painted last so an overlay cannot bury the answer to
    // "did that server come up".
    if (this.mcpNotice && cols > 0 && rows > 0) {
      const connected = this.mcpNotice.status === 'connected'
      const label = tr(connected ? 'mcp.notice.connected' : 'mcp.notice.failed', { name: this.mcpNotice.name })
      const text = truncateWidth(' ' + label + ' ', cols)
      const width = displayWidth(text)
      const x = Math.max(0, cols - width)
      const style = makeStyle({ fg: connected ? t.success : t.error, bg: t.backgroundElement, bold: true })
      screen.fill(x, 0, width, ' ', style)
      screen.text(x, 0, text, style)
    }
    if (this.cornerNotice && cols > 0 && rows > 0) {
      const width = Math.min(cols, Math.max(20, Math.min(64, Math.max(displayWidth(this.cornerNotice.title), displayWidth(this.cornerNotice.detail)) + 4)))
      const x = cols - width
      const titleStyle = makeStyle({ fg: this.cornerNotice.level === 'error' ? t.error : t.success, bg: t.backgroundElement, bold: true })
      const detailStyle = makeStyle({ fg: t.text, bg: t.backgroundElement })
      screen.fill(x, 0, width, ' ', titleStyle)
      screen.text(x + 1, 0, truncateWidth(this.cornerNotice.title, Math.max(0, width - 2)), titleStyle)
      if (rows > 1) {
        screen.fill(x, 1, width, ' ', detailStyle)
        screen.text(x + 1, 1, shortenPath(this.cornerNotice.detail, Math.max(0, width - 2)), detailStyle)
      }
    }

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
    const t = this.theme
    const state = this.pendingApproval
    const rows = Math.max(1, Math.floor(maxRows))
    if (!state || !(width >= 8)) return []
    const bg = t.backgroundPanel
    const label = makeStyle({ fg: t.textMuted, bg })
    const value = makeStyle({ fg: t.text, bg })
    const action = String(state.toolName ?? '')
    const hint = tr('composer.approvalHint')
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
    const actionHead = tr('composer.approval')
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
    if (state.summary) field(tr('composer.summary'), state.summary, value)
    // 3. The origin: which component asked.
    if (state.origin) field(tr('composer.origin'), state.origin, value)
    // 4. The risk, when the request carries one. Distinguishable by tone so it
    //    reads as a warning rather than another detail.
    if (state.risk) {
      const risk = String(state.risk)
      const riskColor = risk === 'low' ? t.success : risk === 'high' ? t.error : t.warning
      const riskText = ['low', 'medium', 'high'].includes(risk) ? tr('risk.' + risk) : risk
      field(tr('composer.risk'), riskText, makeStyle({ fg: riskColor, bold: true, bg }))
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
    clipped.push([{ text: tr('common.more', { count: lines.length - keep }), style: label }])
    return clipped.concat(tail)
  }

  _paintEffortSlider(screen, cols, rows, rightEdge = cols) {
    const t = this.theme
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
    for (let i = 0; i < trackWidth; i++) {
      if (i < fill) {
        screen.text(left + i, y, '█', makeStyle({ fg: t.primary, bg }))
      } else {
        screen.text(left + i, y, '░', makeStyle({ fg: t.border, bg }))
      }
    }
    // Text-safe slider thumb on the right edge of the fill.
    screen.text(left + Math.min(fill, trackWidth) - 1, y, '▮', makeStyle({ fg: atMax ? '#ffffff' : t.secondary, bold: true, bg }))
    // Keep the current effort value in its original slider-row position as
    // well as in the composer's top-right corner.
    const current = levels[index] ?? levels[0]
    const name = truncateWidth(String(current?.name ?? current?.id ?? '—'), 18)
    let x = left + trackWidth + 2
    screen.text(x, y, name, makeStyle({ fg: t.secondary, bold: true, bg }))
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
    const hint = tr('composer.effortHint')
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
    const t = this.theme
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

    section(tr('rail.model'))
    row(truncateWidth(this.model || '…', width), st({ fg: t.text, bold: true }))
    if (this.provider) row(truncateWidth(this.provider, width), muted)

    section(tr('rail.thinking'))
    const level = this._effortLevel()
    if (level) {
      row(truncateWidth(String(level.name ?? level.id ?? '—'), width), st({ fg: t.secondary, bold: true }))
      const slider = this.effortSlider
      if (slider && slider.levels.length > 1) {
        const range = String(slider.levels[0]?.name ?? '') + ' → ' + String(slider.levels[slider.levels.length - 1]?.name ?? '')
        row(truncateWidth(range, width), muted)
      }
    } else {
      row(tr('rail.noData'), muted)
    }

    section(tr('rail.context'))
    const meter = this.contextMeter
    if (meter) {
      const barW = Math.max(3, width - 2)
      const fill = Math.min(barW, Math.max(0, Math.round(meter.percent / 100 * barW)))
      const fillColor = meter.percent >= 100 ? t.error : meter.percent >= 90 ? t.warning : t.primary
      lines.push([
        { text: '━'.repeat(fill), style: st({ fg: fillColor }) },
        { text: '─'.repeat(barW - fill), style: st({ fg: t.border }) },
      ])
      row(tr('rail.percentUsed', { percent: meter.percent }), meter.percent >= 90 ? st({ fg: fillColor }) : muted)
      row(tr('rail.tokens', { used: formatTokens(meter.usedTokens), window: formatTokens(meter.contextWindow) }), muted)
      const m = this.metrics ?? {}
      if ((m.billedInputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0) {
        row(tr('stats.inOut', { input: formatTokens(m.billedInputTokens ?? 0), output: formatTokens(m.outputTokens ?? 0) }), muted)
        if (m.cacheHitRate !== undefined) row(tr('rail.cacheHit', { percent: m.cacheHitRate }), muted)
      }
      if (meter.breakdown) {
        for (const piece of wrapText(tr('rail.breakdown', {
          system: formatTokens(meter.breakdown.systemTokens),
          tools: formatTokens(meter.breakdown.toolsTokens),
          messages: formatTokens(meter.breakdown.messageTokens),
        }), width)) {
          row(piece, muted)
        }
      }
    } else {
      row(tr('rail.contextPending'), st({ fg: t.textMuted, italic: true }))
    }

    // The figures the narrow window's stats strip carries; the strip drops out
    // while the rail is up, so this is their only home in the wide layout.
    const sessionStats = this._statsGroups({ billing: !meter })
    if (sessionStats.length > 0) {
      section(tr('rail.session'))
      for (const group of sessionStats) {
        for (const piece of wrapText(group, width)) row(piece, muted)
      }
    }

    if (this.goal) {
      section(tr('rail.goal'))
      for (const piece of wrapText(this.goal.objective, width)) row(piece)
      const phaseColor = { active: t.success, paused: t.warning, blocked: t.error, complete: t.primary }[this.goal.phase] ?? t.textMuted
      // The phase is a protocol id: the four known ones are named by the
      // catalog, an unknown future phase still renders as itself.
      const phaseKey = 'goal.' + this.goal.phase
      let phaseLine = GOAL_PHASE_KEYS.has(phaseKey) ? tr(phaseKey) : this.goal.phase
      if (this.goal.maxGoalRounds > 0) phaseLine += tr('rail.round', { started: this.goal.roundsStarted, max: this.goal.maxGoalRounds })
      row(phaseLine, st({ fg: phaseColor }))
      if (this.goal.blockedReason?.message) {
        for (const piece of wrapText(this.goal.blockedReason.message, width)) {
          row(piece, st({ fg: t.error }))
        }
      }
    }

    if (this.subagents.length > 0) {
      section(tr('rail.subagents'))
      const running = this.subagents.filter((sub) => sub.activity === 'running').length
      row(tr('rail.subagentCounts', { running, total: this.subagents.length }), muted)
      // The list caps at 10 rows so one runaway delegation cannot push
      // everything else off the rail; the count above still names every one.
      for (const sub of this.subagents.slice(0, 10)) {
        const mark = sub.activity === 'running' ? '●' : '○'
        const color = sub.activity === 'running' ? t.success : t.textMuted
        const depthTag = sub.depth > 1 ? ' L' + sub.depth : ''
        lines.push([
          { text: mark + ' ', style: st({ fg: color }) },
          { text: truncateWidth((sub.readable ? sub.label : tr('rail.unreadable', { label: sub.label })) + depthTag, Math.max(4, width - 2)), style: st({ fg: sub.activity === 'running' ? t.text : t.textMuted }) },
        ])
      }
      if (this.subagents.length > 10) row(tr('rail.more', { count: this.subagents.length - 10 }), muted)
    }

    return lines
  }

  _paintRail(screen, { cols, rows, headerH, railW, borderX }) {
    const t = this.theme
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
    const titleText = this.titleScreen ? '' : String(this.untitled ? tr('session.newTitle') : this.title ?? '')
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
    const contextHeader = tr('rail.context')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length === 1 && lines[i][0].text === contextHeader) {
        const y = contentTop + (i - scroll)
        const end = lines.findIndex((line, j) => j > i && line.length === 1 && line[0].style?.bold && line[0].text !== contextHeader)
        const stop = (end < 0 ? lines.length : end) - scroll
        if (y >= contentTop && y < contentBottom) {
          this.addHitRegion('stats', x0, y, railW, Math.max(1, Math.min(stop, contentBottom) - y))
        }
        break
      }
    }
  }

  // A stable label keeps the selected reasoning level visible while idle.
  _paintEffortLabel(screen, composerX, composerTop, composerW) {
    const t = this.theme
    const level = this._effortLevel()
    if (!level || composerW < 16) return
    const atMax = this._effortAtMax()
    const name = truncateWidth(String(level.name ?? level.id), Math.max(4, composerW - 16))
    const text = (atMax ? '↑ ' : '') + name + ' · Tab'
    const x = composerX + composerW - displayWidth(text) - 2
    screen.text(x, composerTop, text, makeStyle({ fg: t.secondary, bold: true, bg: t.backgroundPanel }))
    this.addHitRegion('effort', x, composerTop, displayWidth(text))
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
      fillColor: pct >= 100 ? this.theme.error : pct >= 90 ? this.theme.warning : this.theme.primary,
    }
  }

  _paintContextMeter(screen, y, geom) {
    const t = this.theme
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
    const t = this.theme
    const m = this.metrics ?? {}
    const meter = this.contextMeter
    const body = []
    if ((m.steps ?? 0) > 0) {
      body.push({ label: tr('stats.usage'), value: count(m.turns ?? 0, 'transcript.turns') + ' · ' + count(m.steps, 'transcript.steps') })
      const durations = []
      if ((m.llmMs ?? 0) > 0) durations.push(tr('stats.llmTime', { value: formatDuration(m.llmMs) }))
      if ((m.toolMs ?? 0) > 0) durations.push(tr('stats.toolTime', { value: formatDuration(m.toolMs) }))
      if (durations.length > 0) body.push({ label: tr('stats.duration'), value: durations.join(' · ') })
      const speeds = []
      if ((m.ttftSteps ?? 0) > 0) speeds.push(tr('stats.ttft', { value: formatDuration(m.ttftMs / m.ttftSteps) }))
      if ((m.decodeMs ?? 0) > 0) speeds.push(tr('stats.tokensPerSecond', { value: formatMetric(m.decodeTokens / (m.decodeMs / 1000)) }))
      if (speeds.length > 0) body.push({ label: tr('stats.speed'), value: speeds.join(' · ') })
    } else {
      body.push({ label: tr('stats.usage'), value: tr('stats.noSteps') })
    }
    body.push({
      label: tr('stats.tokens'),
      value: tr('stats.inOut', { input: formatTokens(m.billedInputTokens ?? 0), output: formatTokens(m.outputTokens ?? 0) }),
    })
    if (m.cacheHitRate !== undefined) {
      body.push({
        label: tr('stats.cache'),
        value: tr('stats.cacheDetail', {
          percent: m.cacheHitRate,
          read: formatTokens(m.cacheReadTokens ?? 0),
          write: formatTokens(m.cacheWriteTokens ?? 0),
          miss: formatTokens(m.uncachedInputTokens ?? 0),
        }),
      })
    }
    if (meter) {
      body.push({ blank: true })
      body.push({
        label: tr('stats.context'),
        value: tr('stats.contextUsed', {
          percent: meter.percent,
          used: formatTokens(meter.usedTokens),
          window: formatTokens(meter.contextWindow),
        }),
      })
      const parts = meter.breakdown
        ? [
            { tokens: meter.breakdown.systemTokens, color: t.contextSystem, label: tr('stats.systemPrompt') },
            { tokens: meter.breakdown.toolsTokens, color: t.contextTools, label: tr('stats.tools') },
            { tokens: meter.breakdown.messageTokens, color: t.contextMessages, label: tr('stats.messages') },
          ].filter((p) => p.tokens > 0)
        : null
      body.push({ bar: true, parts })
      if (parts && parts.length > 0) {
        for (const part of parts) body.push({ legend: part })
      } else {
        body.push({ note: tr('stats.compositionUnavailable') })
      }
    } else {
      body.push({ blank: true })
      body.push({ note: tr('stats.contextPending') })
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
    screen.text(x0 + 3, yy, tr('stats.title'), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const escLabel = tr('common.escClose')
    screen.text(x0 + w - displayWidth(escLabel) - 3, yy, escLabel, makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    yy++
    screen.text(x0 + 3, yy, tr('stats.hint'), makeStyle({ fg: t.textMuted, dim: true, bg: t.backgroundElement }))
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
    const t = this.theme
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
      : (q.questions.length > 1
        ? tr('questions.titleOf', { index: q.index + 1, total: q.questions.length })
        : tr('questions.title'))
    const esc = tr('questions.defer')
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
        const counter = tr('questions.range', { from: scroll + 1, to: scroll + detailH, total: detailLines.length })
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
    const prefix = marker + (options.length > 0 ? tr('questions.other') : tr('questions.answer'))
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
      screen.text(textX, y, truncateWidth(tr('questions.placeholder'), room), makeStyle({ fg: t.textMuted, italic: true, bg: customStyle.bg }))
    }
    this.addHitRegion('question-custom', x0 + 1, y, w - 2, 1)
    y++

    y++
    const hints = q.customMode
      ? tr('questions.hintCustom')
      : multi
        ? tr('questions.hintMulti')
        : tr('questions.hintSingle')
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
    const t = this.theme
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
      truncateWidth(state.error ?? tr('secret.hint'), width - 4),
      makeStyle({ fg: state.error ? t.error : t.textMuted, bg: t.backgroundElement }))
  }

  // Settings dialog. Views that carry a left menu (Main / Model) render a
  // menu column on the left — Tab switches the active entry, clicking works
  // too; views without a menu (choice lists, session manager, model picker)
  // keep the classic single-column layout.
  _paintSettings(screen, cols, rows, railW = 0) {
    const t = this.theme
    const menu = Array.isArray(this.settingsMenu) ? this.settingsMenu : []
    const hasMenu = menu.length > 0
    // The menu column is sized from its labels: "Aggiornamento" or "Обновление"
    // must not be cut to the English "Update" width. Capped so a runaway label
    // cannot eat the content pane.
    const w = Math.min(hasMenu ? 84 : 68, overlayRegion(cols, railW) - 4)
    const menuW = hasMenu && w >= 72 ? Math.min(20, Math.max(12, ...menu.map((entry) => displayWidth(entry.label))) + 5) : 0
    const stacked = w - menuW < 50
    // Display rows: group headers (kind 'header') break the list into
    // sections with a blank separator line; every selectable item is one
    // compact row, or a label/value pair on narrow terminals.
    const display = []
    for (let i = 0; i < this.settingsItems.length; i++) {
      const item = this.settingsItems[i]
      if (item.kind === 'header') {
        if (display.length > 0) display.push({ blank: true })
        display.push({ header: item })
      } else {
        display.push({ item, index: i })
        if (stacked && !item.wide && (item.value || item.valueLabel || item.version || this.settingsEditing === i || this.settingsConfirm?.item === item)) {
          display.push({ item, index: i, detail: true })
        }
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
    if (menuW > 0) {
      // Left menu column with a divider; the active entry is highlighted and
      // every entry is a click target.
      screen.set(x0 + menuW, y0, '┬', border)
      for (let yy = y0 + 1; yy < y0 + h - 1; yy++) screen.set(x0 + menuW, yy, '│', border)
      screen.set(x0 + menuW, y0 + h - 1, '┴', border)
      screen.text(x0 + 2, y0 + 1, tr('settings.menu'), makeStyle({ fg: t.textMuted, bold: true, bg: t.backgroundElement }))
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
        screen.text(x0 + 2, my, (active ? '▸ ' : '  ') + truncateWidth(menu[i].label, menuW - 3), menuStyle)
        this.addHitRegion('settings-menu', x0 + 1, my, menuW - 1, 1, { menuIndex: i })
      }
    }
    screen.text(cx + 3, y0 + 1, truncateWidth(this.settingsTitle, cw - 6), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))

    const subtitleText = (this.settingsBusy ? this.animChar() + ' ' : '') + (this.settingsSubtitle || tr('settings.shared'))
    if (hasMenu && menuW === 0) {
      let mx = cx + 3
      const order = [...menu.keys()].slice(this.settingsMenuIndex).concat([...menu.keys()].slice(0, this.settingsMenuIndex))
      for (const i of order) {
        const label = truncateWidth(menu[i].label, cw - 6)
        const mw = displayWidth(label) + 2
        if (mx + mw > cx + cw - 2) break
        const active = i === this.settingsMenuIndex
        screen.text(mx, y0 + 2, label, makeStyle({ fg: active ? t.secondary : t.textMuted, bold: active, bg: t.backgroundElement }))
        this.addHitRegion('settings-menu', mx, y0 + 2, mw, 1, { menuIndex: i })
        mx += mw
      }
    } else {
      screen.text(cx + 3, y0 + 2, truncateWidth(subtitleText, cw - 6), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    }
    // Scroll window with explicit scroll offset (wheel scrolling support).
    // The scroll offset is clamped to ensure the window always shows content.
    const maxScroll = Math.max(0, display.length - contentH)
    const scrollOffset = Math.max(0, Math.min(this.settingsScrollOffset, maxScroll))
    const selRow = display.findIndex((entry) => entry.index === this.settingsSelection)
    // Auto-scroll to keep the selected row visible when keyboard navigation moves it
    let first = scrollOffset
    if (selRow >= 0) {
      if (selRow < first) first = selRow
      const selEnd = display[selRow + 1]?.detail && contentH > 1 ? selRow + 1 : selRow
      if (selEnd >= first + contentH) first = selEnd - contentH + 1
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
        screen.text(cx + 3, y, selected ? '┃ ' : '  ', makeStyle({ fg: item.disabled ? t.textMuted : t.primary, bg: style.bg }))
        const draft = this.settingsSecret ? '•'.repeat(Array.from(this.settingsDraft).length) : this.settingsDraft
        const confirming = this.settingsConfirm?.item === item
        const confirmHint = confirming
          ? this.settingsConfirm.item.kind === 'session'
            ? tr('settings.confirmDeleteSession')
            : tr('settings.confirmHint', { text: this.settingsConfirm.text ?? tr('settings.confirmDefault') })
          : ''
        // A row whose stored id differs from what the user should read (a
        // locale id, a `queue`/`steer` choice) carries `valueLabel`; the id is
        // still what gets committed.
        const stored = item.valueLabel ?? item.value
        const value = confirming ? confirmHint : this.settingsEditing === i ? draft + '█' : stored
        const valueTone = item.tone === 'warning' ? t.warning : item.tone === 'success' ? t.success : undefined
        const valueStyle = makeStyle({ fg: confirming ? t.warning : valueTone ? valueTone : selected && !item.disabled ? t.secondary : t.textMuted, bg: style.bg })
        // Nested rows (e.g. a provider's models) indent one step per level.
        const indent = (item.indent ?? 0) * 3
        if (stacked) {
          const version = item.version ? [item.version, item.installed ? tr('common.installed') : '', ...(item.tags ?? []).map((tag) => '[' + tag + ']')].filter(Boolean).join(' · ') : ''
          const text = entry.detail ? value || version : item.label
          screen.text(cx + 6 + indent, y, truncateWidth(String(text ?? ''), cw - 9 - indent), entry.detail ? valueStyle : style)
        } else if (item.kind === 'session') {
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
            const piece = (text, style) => { vx = screen.text(vx, y, truncateWidth(text, Math.max(0, cx + cw - 3 - vx)), style) }
            piece(item.version, item.installed ? installedStyle : baseStyle)
            if (item.installed) piece('  ' + tr('common.installed'), installedStyle)
            for (const tag of item.tags ?? []) piece('  [' + tag + ']', tagStyle(tag))
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
        } else if (item.wide === true) {
          // A sentence, not a label/value pair: rows that explain rather than
          // configure get the whole content width instead of the value column.
          screen.text(cx + 6 + indent, y, truncateWidth(item.label, cw - 8 - indent), style)
        } else {
          screen.text(cx + 6 + indent, y, truncateWidth(item.label, Math.max(6, 29 - indent)), style)
          screen.text(cx + 36, y, truncateWidth(value, cw - 41), valueStyle)
        }
      }
      y++
    }
    if (display.length > contentH) {
      const thumbH = Math.max(1, Math.round(contentH * contentH / display.length))
      const thumbY = y0 + 4 + Math.round(first * (contentH - thumbH) / Math.max(1, maxScroll))
      for (let i = 0; i < contentH; i++) screen.set(x0 + w - 2, y0 + 4 + i, '│', border)
      for (let i = 0; i < thumbH; i++) screen.set(x0 + w - 2, thumbY + i, '┃', makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    }
    const footer = this.settingsEditing !== null
      ? tr('settings.footerEdit')
      : hasMenu
        ? tr('settings.footerMenu')
        : tr('settings.footerPlain')
    // A pending confirm repaints the whole row as a warning; otherwise the
    // key token leads each pair in the accent color so it reads apart from
    // its description.
    if (this.settingsConfirm) {
      screen.text(cx + 3, y0 + h - 2, truncateWidth(footer, cw - 6), makeStyle({ fg: t.warning, bg: t.backgroundElement }))
    } else {
      paintKeyHints(screen, cx + 3, y0 + h - 2, footer, cw - 6, t)
    }
  }

  _paintHelp(screen, cols, rows, railW = 0) {
    const t = this.theme
    const region = overlayRegion(cols, railW)
    const w = Math.min(64, region - 4)
    const h = Math.min(25, rows - 2)
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
    screen.text(x0 + 2, y0 + 1, truncateWidth(tr('help.title'), w - 4), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const rows2 = [
      [tr('help.enter'), tr('help.enterDesc')],
      [tr('help.ctrlEnter'), tr('help.ctrlEnterDesc')],
      [tr('help.ctrlC'), tr('help.ctrlCDesc')],
      [tr('help.ctrlP'), tr('help.ctrlPDesc')],
      ['Ctrl+S', tr('screenshot.shortcut')],
      [tr('help.ctrlE'), tr('help.ctrlEDesc')],
      [tr('help.tab'), tr('help.tabDesc')],
      [tr('help.ctrlN'), tr('help.ctrlNDesc')],
      [tr('help.ctrlG'), tr('help.ctrlGDesc')],
      [tr('help.ctrlD'), tr('help.ctrlDDesc')],
      [tr('help.pg'), tr('help.pgDesc')],
      [tr('help.shiftArrows'), tr('help.shiftArrowsDesc')],
      [tr('help.upDown'), tr('help.upDownDesc')],
      [tr('help.mouse'), tr('help.mouseDesc')],
      [tr('help.wheel'), tr('help.wheelDesc')],
      [tr('help.escEsc'), tr('help.escEscDesc')],
      [tr('help.esc'), tr('help.escDesc')],
    ]
    // The key column is measured, not assumed: a translated key label ("Hoch /
    // Runter") must not push its description off the box, and every description
    // is truncated to what is left of the row.
    const keyCol = Math.min(Math.floor((w - 6) / 2), Math.max(14, ...rows2.map(([key]) => displayWidth(key))) + 2)
    const descRoom = Math.max(1, w - 5 - keyCol)
    const keyRows = h < 22 ? [...rows2.slice(0, Math.max(0, h - 7)), rows2.at(-1)] : rows2
    let yy = y0 + 3
    for (const [key, desc] of keyRows) {
      screen.text(x0 + 3, yy, truncateWidth(key, keyCol - 2), makeStyle({ fg: t.success, bg: t.backgroundElement }))
      screen.text(x0 + 3 + keyCol, yy, truncateWidth(desc, descRoom), makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
    if (h === 25) {
      yy++
      screen.text(x0 + 3, yy, truncateWidth(tr('help.commands'), w - 6), makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
      yy++
    }
    for (const cmd of ['/help  /settings  /new  /resume <id>', '/branch  /model <id>  /provider <route>  /rewind', '/stats  /clear  /cancel  /quit']) {
      if (yy >= y0 + h - 1) break
      screen.text(x0 + 3, yy, truncateWidth(cmd, w - 6), makeStyle({ fg: t.text, bg: t.backgroundElement }))
      yy++
    }
  }

  _paintRewind(screen, cols, rows, railW = 0) {
    const picker = this.rewind
    if (!picker) return
    const t = this.theme
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
    screen.text(x0 + 2, y0 + 1, tr('rewind.title'), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const innerW = w - 4
    let subtitle
    if (picker.busy) subtitle = tr('common.working')
    else if (picker.error) subtitle = picker.error
    else if (picker.step === 'restore') {
      const item = picker.items[picker.selected]
      subtitle = tr('rewind.restoreTo', { label: item?.label ?? '' })
    } else {
      subtitle = tr('rewind.restorePrompt')
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
      screen.text(x0 + 3, listTop, tr('rewind.empty'), makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
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
    if (picker.busy) {
      screen.text(x0 + 2, y0 + h - 2, truncateWidth(tr('common.pleaseWait'), innerW), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    } else {
      paintKeyHints(screen, x0 + 2, y0 + h - 2,
        picker.step === 'restore' ? tr('common.selectConfirmBack') : tr('common.selectContinueExit'),
        innerW, t)
    }
  }

  _paintGitBranches(screen, cols, rows, railW = 0) {
    const picker = this.gitBranches
    if (!picker) return
    const t = this.theme
    const region = overlayRegion(cols, railW)
    const w = Math.min(72, region - 4)
    const h = Math.min(rows - 2, 8 + Math.min(7, Math.max(1, picker.items.length)))
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
    screen.text(x0 + 2, y0 + 1, tr('git.title'), makeStyle({ fg: t.primary, bold: true, bg: t.backgroundElement }))
    const innerW = w - 4
    // The subtitle doubles as the action report: busy while an operation
    // runs, its failure, its one-line outcome, or the resting current-branch
    // reading — in that precedence, so a failed pull is never hidden by the
    // branch it was pulling.
    let subtitle
    if (picker.busy) subtitle = tr('common.working')
    else if (picker.error) subtitle = picker.error
    else if (picker.status) subtitle = picker.status
    else subtitle = tr('git.subtitle', { branch: picker.current || tr('git.detached'), path: picker.root })
    screen.text(x0 + 2, y0 + 2, truncateWidth(subtitle, innerW), makeStyle({
      fg: picker.error ? t.error : t.textMuted,
      bg: t.backgroundElement,
    }))
    const listTop = y0 + 4
    const listH = Math.max(1, h - 7)
    const start = picker.scroll
    const end = Math.min(picker.items.length, start + listH)
    if (picker.items.length === 0) {
      screen.text(x0 + 3, listTop, tr('git.empty'), makeStyle({ fg: t.textMuted, italic: true, bg: t.backgroundElement }))
    }
    for (let i = start; i < end; i++) {
      const y = listTop + (i - start)
      const row = picker.items[i]
      if (row.kind === 'header') {
        screen.text(x0 + 3, y, truncateWidth(row.label, innerW - 2), makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
        continue
      }
      const selected = i === picker.selected
      const st = makeStyle({
        fg: selected ? t.primary : (row.current ? t.textMuted : t.text),
        bold: selected,
        bg: selected ? t.backgroundPanel : t.backgroundElement,
      })
      if (selected) screen.fill(x0 + 1, y, w - 2, ' ', st)
      // The `*` marker is git's own, so it needs no translation and reads the
      // same in every locale.
      const pointer = selected ? '▸ ' : '  '
      const marker = row.current ? '* ' : '  '
      screen.text(x0 + 2, y, truncateWidth(pointer + marker + row.name, innerW), st)
      this.addHitRegion('git-branch-item', x0 + 1, y, w - 2, 1, { branchIndex: i })
    }
    if (picker.busy) {
      screen.text(x0 + 2, y0 + h - 2, truncateWidth(tr('common.pleaseWait'), innerW), makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
    } else {
      paintKeyHints(screen, x0 + 2, y0 + h - 2, tr('git.footer'), innerW, t)
    }
  }
}

// Overlay footers and hint rows read as "key description · key description"
// pairs. Painting such a line in one muted style let the keys sink into their
// descriptions, so each pair's leading key token is repainted in the accent
// color and bold while the descriptions and the ' · ' glue stay muted. The
// split takes the first space of every ' · '-separated segment — a structure
// every footer catalog follows by design — so a translated key word
// ("Entrée") is highlighted exactly like "Enter".
function paintKeyHints(screen, x, y, text, maxWidth, theme, base = null) {
  const keyStyle = makeStyle({ fg: theme.accent, bold: true, bg: base?.bg ?? theme.backgroundElement })
  const restStyle = base ?? makeStyle({ fg: theme.textMuted, bg: theme.backgroundElement })
  let cx = x
  const put = (chunk, style) => {
    if (chunk === '' || cx >= x + maxWidth) return
    const shown = truncateWidth(chunk, x + maxWidth - cx)
    if (shown === '') return
    screen.text(cx, y, shown, style)
    cx += displayWidth(shown)
  }
  const segments = text.split(' · ')
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) put(' · ', restStyle)
    const gap = segments[i].indexOf(' ')
    if (gap < 0) put(segments[i], keyStyle)
    else {
      put(segments[i].slice(0, gap), keyStyle)
      put(segments[i].slice(gap), restStyle)
    }
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
