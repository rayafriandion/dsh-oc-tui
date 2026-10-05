// Terminal engine: raw-mode input, alternate screen, a diffing cell buffer,
// and ANSI truecolor rendering. Zero dependencies; works on any VT-capable
// terminal (Windows Terminal, ConPTY, iTerm2, GNOME Terminal, ...).
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { runeWidth, truncateWidth, fitWidth } from './util.js'
import { encodeKittyTransmission, kittyPlacement, kittyDelete, kittyDeleteAll, encodeITerm2 } from './image.js'

// ---- ANSI helpers -------------------------------------------------------

export function hexToAnsi(hex) {
  const h = hex.replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return undefined
  return { r, g, b }
}

// Immutable-ish style bundle: { fg, bg (hex or null), bold, dim, italic,
// underline, link (sanitized OSC 8 url or undefined) }. Merges by producing a
// new object.
export function makeStyle(partial = {}) {
  return {
    fg: partial.fg ?? null,
    bg: partial.bg ?? null,
    bold: partial.bold ?? false,
    dim: partial.dim ?? false,
    italic: partial.italic ?? false,
    underline: partial.underline ?? false,
    link: partial.link,
  }
}

export function mergeStyle(base, over) {
  return {
    fg: over.fg ?? base.fg ?? null,
    bg: over.bg ?? base.bg ?? null,
    bold: over.bold ?? base.bold ?? false,
    dim: over.dim ?? base.dim ?? false,
    italic: over.italic ?? base.italic ?? false,
    underline: over.underline ?? base.underline ?? false,
    link: over.link ?? base.link,
  }
}

// URLs painted into cells are emitted later as OSC 8 hyperlinks — raw paint
// output — so they get the same trust boundary as cell characters: only
// http(s)/file schemes, no control characters, parens percent-encoded so the
// OSC terminator logic can never be confused by the URL body.
export function safeLink(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null
  if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) return null
  if (!/^(https?:\/\/|file:\/\/)/i.test(url)) return null
  return url.replace(/[()]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
}

function styleAnsi(style) {
  const parts = []
  if (style.bold) parts.push('1')
  if (style.dim) parts.push('2')
  if (style.italic) parts.push('3')
  if (style.underline) parts.push('4')
  if (style.fg) {
    const c = hexToAnsi(style.fg)
    if (c) parts.push('38;2;' + c.r + ';' + c.g + ';' + c.b)
  }
  if (style.bg) {
    const c = hexToAnsi(style.bg)
    if (c) parts.push('48;2;' + c.r + ';' + c.g + ';' + c.b)
  }
  return parts.length > 0 ? '\x1b[' + parts.join(';') + 'm' : ''
}

const RESET = '\x1b[0m'

// Control characters must never reach the output stream: paint() emits each
// cell's character verbatim, so a C0/C1 byte in a tool name, a path, a title or
// a markdown run would be interpreted by the terminal as a control sequence —
// screen clears, cursor moves, even clipboard writes. The protocol names
// exactly this: a provider must not treat shell escapes or ANSI control
// sequences as trusted markup. Replaced with a visible marker rather than
// dropped, so an injection shows up instead of shifting the layout.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function cellCharacter(ch) {
  // '' is the wide-rune continuation marker and must pass through untouched.
  if (ch === '') return ch
  return CONTROL_CHARACTERS.test(ch) ? '\uFFFD' : ch
}

// ---- Screen -------------------------------------------------------------

// A row-major grid of cells; each cell carries a char and a style. The
// renderer diffs two screens so only changed cells reach the terminal.
export class Screen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.cells = []
    // Image annotations for the current frame: rows whose cells stand in for
    // graphics-protocol output (kitty placement / sixel / iTerm2 payloads
    // emitted by Terminal.paint). Text cells stay blank so the diffing engine
    // and the width invariant keep working unchanged.
    this.images = []
    for (let y = 0; y < rows; y++) {
      const row = []
      for (let x = 0; x < cols; x++) row.push({ ch: ' ', style: null })
      this.cells.push(row)
    }
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return false
    const next = new Screen(cols, rows)
    const copyRows = Math.min(rows, this.rows)
    const copyCols = Math.min(cols, this.cols)
    for (let y = 0; y < copyRows; y++) {
      for (let x = 0; x < copyCols; x++) {
        next.cells[y][x] = this.cells[y][x]
      }
    }
    this.cols = cols
    this.rows = rows
    this.cells = next.cells
    return true
  }

  clear(style = null) {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        this.cells[y][x] = { ch: ' ', style }
      }
    }
  }

  set(x, y, ch, style = null) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    // A link on a style is paint output, not cell text: sanitize it once here
    // so paint() can emit it verbatim as OSC 8.
    if (style?.link) {
      const link = safeLink(style.link)
      style = { ...style, link: link ?? undefined }
    }
    this.cells[y][x] = { ch: cellCharacter(ch), style }
  }

  // Write a string horizontally starting at (x, y), clipping to the screen.
  // Handles wide runes by skipping the following cell. Returns the x after
  // the last written rune.
  text(x, y, str, style = null) {
    if (y < 0 || y >= this.rows) return x
    let cx = x
    for (const ch of str) {
      if (cx >= this.cols) break
      const w = runeWidth(ch)
      if (w === 0) {
        if (cx >= 0) this.set(cx, y, ch, style)
        continue
      }
      this.set(cx, y, ch, style)
      if (w === 2 && cx + 1 < this.cols) this.set(cx + 1, y, '', style)
      cx += w
    }
    return cx
  }

  // Fill a horizontal run with a char.
  fill(x, y, width, ch, style = null) {
    for (let i = 0; i < width; i++) this.set(x + i, y, ch, style)
  }

  // Record that the cell area of an image starts at row `y` (top: true only on
  // the image's first row, carrying the full placement info).
  setImageRow(y, info) {
    if (y < 0 || y >= this.rows) return
    if (info?.top) this.images.push({ ...info, y })
  }

  // Fill an entire row to its right edge (used to keep background continuous).
  fillToEnd(x, y, style = null) {
    this.fill(x, y, Math.max(0, this.cols - x), ' ', style)
  }

  // Give every cell that carries no explicit background (style null or
  // bg null) the given default background. Without this, fg-only styles
  // (markdown text, row tail fills) emit no background SGR and the terminal
  // falls back to its own default background - usually black - instead of
  // the app canvas. `== null` rather than `=== null`: Screen.text stores the
  // style object it is handed verbatim, so a caller that builds the style
  // inline instead of through makeStyle leaves the key absent (undefined)
  // rather than null, and those cells would keep the black background.
  defaultBackground(hex) {
    for (let y = 0; y < this.rows; y++) {
      const row = this.cells[y]
      for (let x = 0; x < this.cols; x++) {
        const cell = row[x]
        if (cell.style === null) cell.style = makeStyle({ bg: hex })
        else if (cell.style.bg == null) cell.style = mergeStyle(cell.style, { bg: hex })
      }
    }
  }
}

// ---- Key decoding -------------------------------------------------------

const KEY_NAMES = {
  '\r': 'return', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\x08': 'backspace',
  '\x1b': 'escape',
}
const CTRL_NAMES = {
  '\x03': 'c', '\x04': 'd', '\x0e': 'n', '\x13': 's', '\x0c': 'l',
  '\x15': 'u', '\x01': 'a', '\x02': 'b', '\x05': 'e', '\x06': 'f',
  '\x07': 'g', '\x08': 'h', '\x09': 'i', '\x0a': 'j', '\x0b': 'k',
  '\x0f': 'o', '\x10': 'p', '\x11': 'q', '\x12': 'r', '\x14': 't',
  '\x16': 'v', '\x17': 'w', '\x18': 'x', '\x19': 'y', '\x1a': 'z',
}

// xterm-style modifier parameter of `CSI 1;<mods>` final sequences. The
// parameter is 1+bitmask (shift=1, alt=2, ctrl=4), so the bits are `mods-1`.
// Arrows arrive with the parameter whenever a modifier is held; without one
// they stay plain.
function csiModifierFlags(param) {
  const bits = Math.max(0, (Number(String(param ?? '').split(';')[1]) || 1) - 1)
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 }
}

// Decode one key event from a raw-mode byte buffer. Returns { key } or null
// when more bytes are needed.
export function decodeKey(input) {
  const first = input[0]
  if (first === 0x1b) {
    // A lone ESC is the escape key itself.
    if (input.length === 1) return { key: { name: 'escape' }, consumed: 1 }
    const seq = Buffer.from(input)
    const s = seq.toString('latin1')
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s)
    if (mouse) {
      const code = Number(mouse[1])
      const x = Number(mouse[2]) - 1
      const y = Number(mouse[3]) - 1
      const wheel = (code & 64) !== 0
      const motion = (code & 32) !== 0
      const buttonCode = code & 3
      const button = wheel ? 'wheel' : ['left', 'middle', 'right', 'none'][buttonCode]
      const action = wheel
        ? (buttonCode === 0 ? 'wheel-up' : 'wheel-down')
        : motion ? 'move'
          : mouse[4] === 'm' || buttonCode === 3 ? 'up'
            : 'down'
      return {
        key: {
          name: 'mouse',
          mouse: {
            x, y, button, action,
            shift: (code & 4) !== 0,
            alt: (code & 8) !== 0,
            ctrl: (code & 16) !== 0,
          },
        },
        consumed: mouse[0].length,
      }
    }
    // Bracketed paste: ESC[200~ ... ESC[201~. The payload can be arbitrary
    // bytes (including a pasted image), so it is returned raw and the caller
    // decides whether it is text or an attachment.
    if (s.startsWith('\x1b[200~')) {
      const end = input.indexOf(Buffer.from('\x1b[201~', 'latin1'))
      if (end < 0) return null
      return {
        key: { name: 'paste', data: Buffer.from(input.subarray(6, end)) },
        consumed: end + 6,
      }
    }
    // OSC 52 clipboard read reply: ESC ] 52 ; <pc> ; <base64> BEL/ST. The app
    // requests the clipboard to recover images that have no text form.
    if (s.startsWith('\x1b]52;')) {
      const m = /^[^;]*;([^]*?)(?:\x07|\x1b\\)/.exec(s.slice(5))
      if (!m) return null
      let data = Buffer.alloc(0)
      try { data = Buffer.from(m[1].replace(/[\r\n\s]/g, ''), 'base64') } catch { /* empty */ }
      return {
        key: { name: 'clipboard', data },
        consumed: 5 + m[0].length,
      }
    }
    // Legacy X10 mouse (no SGR): ESC [ M <button+32> <x+32> <y+32>.
    // Without this, wheel/click bytes that follow \x1b[M would be misread as
    // printable text and inserted into the input text.
    if (s.startsWith('\x1b[M')) {
      if (input.length < 6) return null
      const b = input[3] - 32
      const x = input[4] - 32 - 1
      const y = input[5] - 32 - 1
      const wheel = (b & 64) !== 0
      const motion = (b & 32) !== 0
      const release = (b & 3) === 3
      const buttonCode = b & 3
      const button = wheel ? 'wheel' : ['left', 'middle', 'right', 'none'][buttonCode]
      const action = wheel
        ? (buttonCode === 0 ? 'wheel-up' : 'wheel-down')
        : motion ? 'move'
          : release ? 'up' : 'down'
      return {
        key: {
          name: 'mouse',
          mouse: { x, y, button, action, shift: false, alt: false, ctrl: false },
        },
        consumed: 6,
      }
    }
    if (s.startsWith('\x1b[<')) return null
    // Terminal replies. Probes (capability detection) and in-band queries make
    // the client terminal answer on stdin; every answer must be consumed as a
    // reply event or it leaks into the composer as garbage keys. A reply
    // without its ST/BEL terminator yet waits for more bytes.
    if (s.startsWith('\x1bP')) {
      const dcs = /^\x1bP([^]*?)(?:\x1b\\|\x07)/.exec(s)
      if (!dcs) return null
      return { key: { name: 'terminal-reply', reply: { kind: 'dcs', body: dcs[1] } }, consumed: dcs[0].length }
    }
    if (s.startsWith('\x1b_')) {
      const apc = /^\x1b_([^]*?)(?:\x1b\\|\x07)/.exec(s)
      if (!apc) return null
      return { key: { name: 'terminal-reply', reply: { kind: 'apc', body: apc[1] } }, consumed: apc[0].length }
    }
    if (s.startsWith('\x1b]')) {
      const osc = /^\x1b\]([^]*?)(?:\x1b\\|\x07)/.exec(s)
      if (!osc) return null
      return { key: { name: 'terminal-reply', reply: { kind: 'osc', body: osc[1] } }, consumed: osc[0].length }
    }
    // CSI report forms: DA1 attributes ('?...c'), XTWINOPS reports ('...t'),
    // CPR ('...R'), kitty keyboard attributes ('?...u'). The '?'-prefixed 'c'
    // and 'u' finals are replies — bare 'c'/'u' finals are keyboard key events
    // (Ctrl+Enter arrives as CSI 13;5u) and must keep falling through to the
    // key decoder below.
    const report = /^\x1b\[(\??[0-9;:?<>=]*)([cRtu])/.exec(s)
    if (report) {
      const params = report[1]
      const final = report[2]
      const isReplyish = params.startsWith('?') || final === 'R' || final === 't'
      if (isReplyish) {
        let kind = 'unknown'
        if (final === 'c') kind = 'da1'
        else if (final === 't') kind = /^8;\d+;\d+$/.test(params) ? 'windowops' : 'unknown'
        return { key: { name: 'terminal-reply', reply: { kind, body: params } }, consumed: report[0].length }
      }
    }
    // A CSI sequence that has not reached its final byte yet: keep waiting
    // instead of decoding a prefix (a partial DA1 reply would otherwise fall
    // through to the alt-key path below and type "?62" into the composer).
    if (/^\x1b\[[0-9;:?<>=]*$/.test(s)) return null
    const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s)
    if (m) {
      const param = m[1]
      const final = m[2]
      const consumed = m[0].length
      if (consumed > input.length) return null
      if (final === 'A') return { key: { name: 'up', ...csiModifierFlags(param) }, consumed }
      if (final === 'B') return { key: { name: 'down', ...csiModifierFlags(param) }, consumed }
      if (final === 'C') return { key: { name: 'right', ...csiModifierFlags(param) }, consumed }
      if (final === 'D') return { key: { name: 'left', ...csiModifierFlags(param) }, consumed }
      if (final === 'H') return { key: { name: 'home' }, consumed }
      if (final === 'F') return { key: { name: 'end' }, consumed }
      if (final === 'Z') return { key: { name: 'shift-tab' }, consumed }
      if (final === 'u') {
        const [code, modifier = 1] = param.split(';').map(Number)
        if (code === 13 && (modifier === 2 || modifier === 3)) return { key: { name: 'enter', shift: true }, consumed }
        if (code === 13 && modifier === 5) return { key: { name: 'enter', ctrl: true }, consumed }
        if (code > 0 && modifier === 5) return { key: { name: String.fromCodePoint(code), ctrl: true }, consumed }
      }
      if (final === '~') {
        const p = Number(param)
        const map = { 2: 'insert', 3: 'delete', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' }
        if (map[p]) return { key: { name: map[p] }, consumed }
        if (p >= 11 && p <= 15) return { key: { name: 'f' + (p - 10) }, consumed }
        if (p === 17) return { key: { name: 'f6' }, consumed }
        if (p === 18) return { key: { name: 'f7' }, consumed }
        if (p === 19) return { key: { name: 'f8' }, consumed }
        if (p === 20) return { key: { name: 'f9' }, consumed }
        if (p === 21) return { key: { name: 'f10' }, consumed }
        if (p === 23) return { key: { name: 'f11' }, consumed }
        if (p === 24) return { key: { name: 'f12' }, consumed }
      }
      return { key: { name: 'unknown', sequence: s.slice(0, consumed) }, consumed }
    }
    // Alt+key or other ESC prefix: treat ESC + rest as alt-modified char.
    const rest = s[1]
    if (rest === '\r' || rest === '\n') return { key: { name: 'enter', shift: true }, consumed: 2 }
    if (rest !== undefined && !/^[\x00-\x1f\x7f]$/.test(rest)) {
      return { key: { name: rest, alt: true }, consumed: 2 }
    }
    return { key: { name: 'escape' }, consumed: 1 }
  }
  // Single control byte.
  const ch = Buffer.from([first]).toString('latin1')
  if (first === 0x1b) return { key: { name: 'escape' }, consumed: 1 }
  if (first === 0x0a) {
    // LF = Ctrl+J / Ctrl+Enter in raw mode. Route it to the newline path so
    // Ctrl+Enter inserts a line break instead of submitting (Enter is CR).
    return { key: { name: 'enter', ctrl: true }, consumed: 1 }
  }
  if (first < 0x20 || first === 0x7f) {
    const named = KEY_NAMES[ch]
    if (named) return { key: { name: named }, consumed: 1 }
    const ctrl = CTRL_NAMES[ch]
    if (ctrl) return { key: { name: ctrl, ctrl: true }, consumed: 1 }
    return { key: { name: 'unknown', sequence: ch }, consumed: 1 }
  }
  // Printable UTF-8: consume the full multibyte char.
  const decoded = seqFromUtf8(input)
  return { key: { name: decoded.text, text: decoded.text }, consumed: decoded.consumed }
}

function seqFromUtf8(input) {
  const b0 = input[0]
  let len = 1
  if (b0 >= 0xf0) len = 4
  else if (b0 >= 0xe0) len = 3
  else if (b0 >= 0xc0) len = 2
  const bytes = input.slice(0, len)
  if (bytes.length < len) return { text: '', consumed: 0 } // incomplete
  return { text: bytes.toString('utf8'), consumed: len }
}

// ---- Terminal -----------------------------------------------------------

export class Terminal extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    super()
    this.input = input
    this.output = output
    this.raw = false
    this.started = false
    this._buffer = Buffer.alloc(0)
    this.cols = output.columns || 80
    this.rows = output.rows || 24
    // Graphics state, filled in by the app: caps from lib/caps.js probing,
    // payload registry keyed by image hash (App renders payloads through
    // lib/image.js and hands them here). With caps unset, paint() is pure
    // text — halfblock images need no protocol output at all.
    this.caps = null
    this._imagePayloads = new Map()
    this._kittyIds = new Map()
    this._kittyNextId = 1
    this._kittySent = new Set()
    this._prevImageRows = []
    this._onData = (chunk) => this._handleData(chunk)
    this._onResize = () => {
      this.cols = this.output.columns || this.cols
      this.rows = this.output.rows || this.rows
      this.emit('resize')
    }
  }

  isTTY() {
    return Boolean(this.input.isTTY && this.output.isTTY)
  }

  // Release one image payload. The view model drops the cropped variants it no
  // longer shows — each holds an encoded raster, and a payload that outlives its
  // placement would be re-transmitted the moment its key comes back.
  dropImagePayload(key) {
    this._imagePayloads.delete(key)
  }

  start() {
    if (this.started) return
    this.started = true
    this.cols = this.output.columns || 80
    this.rows = this.output.rows || 24
    if (this.input.isTTY) {
      this.input.setRawMode(true)
      this.input.resume()
    }
    this.input.on('data', this._onData)
    this.output.on('resize', this._onResize)
    // Alternate screen, hide cursor, enable click/motion/wheel tracking and
    // bracketed paste so pasted payloads (including binary images) arrive as
    // one delimited event instead of scattered printable bytes.
    this.write('\x1b[?1049h\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H')
    this.raw = true
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.input.off('data', this._onData)
    this.output.off('resize', this._onResize)
    // Kitty images live in the terminal's own storage and would otherwise
    // outlive the alt screen they were placed on.
    if (this.caps?.kitty) this.write(kittyDeleteAll())
    this._kittyIds.clear()
    this._kittySent.clear()
    this._imagePayloads.clear()
    this._prevImageRows = []
    if (this.input.isTTY) {
      this.input.setRawMode(false)
      this.input.pause()
    }
    // Disable bracketed paste + mouse tracking, show cursor, reset.
    this.write('\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[0m\x1b[?1049l')
    this.raw = false
  }

  write(s) {
    this.output.write(s)
  }

  // Ask the terminal for its clipboard (OSC 52 read). The reply arrives on
  // stdin and is decoded into a 'clipboard' key event. Best-effort: terminals
  // that do not implement clipboard reads simply stay silent.
  requestClipboard() {
    this.write('\x1b]52;c;?\x1b\\')
  }

  // Write text to the system clipboard. Primary path: an OSC 52 write, which
  // Windows Terminal, iTerm2, and most modern terminals honor. On Windows a
  // PowerShell fallback covers hosts that drop OSC 52 — the fallback
  // round-trips the text through base64 so UTF-8 (CJK, emoji) survives, unlike
  // `clip.exe`, which re-decodes stdin with the console's ANSI/OEM code page
  // and mangles non-ASCII. Both paths write the same UTF-8 text, so whichever
  // lands last leaves the clipboard correct. Best-effort: never throws.
  //
  // `osc52Only` exists for text the caller marked private: the fallback passes
  // the base64 as a powershell.exe command-line argument, which any process of
  // the same user can read back. Private text must stay on the in-band path.
  copyToClipboard(text, options = {}) {
    if (typeof text !== 'string' || text.length === 0) return false
    // `?? {}` as well as the default: an explicit null would otherwise throw
    // on the destructure, outside every try/catch, breaking the never-throws
    // contract this function is relied on for.
    // `spawn` is injectable so tests can observe the fallback without
    // launching powershell.exe; production always uses the module import.
    const { osc52Only = false, spawn: injectedSpawn } = options ?? {}
    // `?? spawn`, not a destructure default: `{ spawn: null }` must fall back to
    // the real spawn rather than making spawnFn null.
    const spawnFn = injectedSpawn ?? spawn
    let written = false
    try {
      this.write('\x1b]52;c;' + Buffer.from(text, 'utf8').toString('base64') + '\x1b\\')
      written = true
    } catch { /* output unavailable */ }
    if (!osc52Only && process.platform === 'win32' && this.output?.isTTY) {
      try {
        const b64 = Buffer.from(text, 'utf8').toString('base64')
        // System.Windows.Forms.Clipboard needs an STA thread; powershell.exe
        // honors -STA. The base64 argument is ASCII-only, so it passes through
        // CreateProcess and -Command untouched (no shell re-quoting).
        const script =
          'Add-Type -AssemblyName System.Windows.Forms;' +
          '[System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'' + b64 + '\')))'
        const child = spawnFn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on('error', () => { /* no PowerShell available */ })
        written = true
      } catch { /* spawn failure — OSC 52 may still have succeeded */ }
    }
    return written
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    while (this._buffer.length > 0) {
      const decoded = decodeKey(this._buffer)
      if (!decoded || decoded.consumed === 0) break
      this._buffer = this._buffer.subarray(decoded.consumed)
      this.emit('key', decoded.key)
    }
  }

  // Paint a Screen to the terminal, diffing against the previous frame.
  // Only rows that changed are rewritten.
  //
  // Each rewritten row emits exactly `cols` terminal columns. That invariant is
  // what keeps the terminal's cursor model in step with this renderer's grid: a
  // row that emits fewer cells than it consumes would leave the cursor short of
  // the next row's start, and the leftover cells of a longer previous frame
  // would stay on screen as stray glyphs (the "residual text on the right" that
  // only a resize or a full repaint clears).
  paint(screen) {
    const out = []
    if (!this._prev || this._prev.rows !== screen.rows || this._prev.cols !== screen.cols) {
      this._prev = new Screen(screen.cols, screen.rows)
    }
    const prev = this._prev
    const W = screen.cols
    // A graphics image is not text: it is pixel payload the terminal drew into
    // the text grid, and any text write over those cells erases it. That cuts
    // both ways, so the two cases are kept apart:
    //   - a row the previous frame showed an image on, that the SAME image no
    //     longer covers, must be force-rewritten: only a text rewrite clears
    //     the pixels an image leaves behind when it moves, shrinks, or scrolls
    //     away (_paintImages has no delete to send, unlike the kitty path);
    //   - a row the image still covers must not be, unless the payload is
    //     re-emitted right after the rewrite (rewrittenImageRows below) —
    //     otherwise a stationary image is erased by the very frames that render
    //     around it, and never comes back.
    // "Still covers" has to mean the same cells, not just the same row: an
    // image re-rendered narrower (or taller) keeps every one of its rows but
    // vacates cells inside them, and those vacated cells would never see a
    // text write. They keep whatever the wider footprint drew — the image
    // looks wider than the text it sits beside, with a stale strip down its
    // right hand edge. So the key carries the position and size as well as the
    // row, and any change to any of them counts as "no longer covered".
    const covered = new Set()
    for (const img of screen.images) {
      for (let i = 0; i < img.cellsH; i++) {
        covered.add(img.key + ':' + img.x + ':' + img.cellsW + ':' + img.cellsH + ':' + (img.y + i))
      }
    }
    const dirtyRows = new Set()
    for (const img of this._prevImageRows) {
      for (let i = 0; i < img.cellsH; i++) {
        const row = img.y + i
        if (covered.has(img.key + ':' + img.x + ':' + img.cellsW + ':' + img.cellsH + ':' + row)) continue
        dirtyRows.add(row)
      }
    }
    // Which image owns each row, so a rewrite knows which payload it destroyed.
    const imageRowOwner = new Map()
    for (const img of screen.images) {
      for (let i = 0; i < img.cellsH; i++) imageRowOwner.set(img.y + i, img.key)
    }
    const rewrittenImageRows = new Set()
    for (let y = 0; y < screen.rows; y++) {
      let changed = false
      for (let x = 0; x < W; x++) {
        const a = screen.cells[y][x]
        const b = prev.cells[y][x]
        if (a.ch !== b.ch || !sameStyle(a.style, b.style)) {
          changed = true
          break
        }
      }
      if (!changed && !dirtyRows.has(y)) continue
      if (imageRowOwner.has(y)) rewrittenImageRows.add(imageRowOwner.get(y))
      // Rewrite the whole row: move cursor, emit styled runes, pad to width.
      out.push('\x1b[' + (y + 1) + ';1H')
      let lastStyle = null
      let openLink
      for (let x = 0; x < W; x++) {
        const cell = screen.cells[y][x]
        if (cell.ch === '') continue // wide-rune continuation cell
        const st = cell.style
        // OSC 8 hyperlinks: open before a linked run, close after. The URL
        // was sanitized when it entered the cell (Screen.set → safeLink).
        const link = st?.link
        if (link !== openLink) {
          if (openLink) out.push('\x1b]8;;\x07')
          if (link) out.push('\x1b]8;;' + link + '\x07')
          openLink = link
        }
        if (!sameStyle(st, lastStyle)) {
          if (lastStyle !== null) out.push(RESET)
          if (st !== null) out.push(styleAnsi(st))
          lastStyle = st
        }
        // Guard against orphaned wide runes. A wide (double-cell) character
        // expects the following cell to be a continuation marker (ch === '')
        // so the terminal advances two columns while we only consume one array
        // entry. The marker can be gone for two reasons: an overlay panel filled
        // across it, or this row's content simply ends inside the pair. Emitting
        // the rune then would make the terminal advance two columns while the
        // next cell is still emitted, shifting every following column right by
        // one ("misaligned panel" when CJK text underlaps a dialog) — and, when
        // the pair straddles the content's end, leaving the second half of the
        // rune painted beside text that no longer belongs to it. Emit a space
        // instead so the column count stays exact and the stale rune is painted
        // over. The same guard covers a wide rune landing on the last column
        // with no room for a continuation.
        if (runeWidth(cell.ch) === 2 && (x + 1 >= W || screen.cells[y][x + 1].ch !== '')) {
          out.push(' ')
        } else {
          out.push(cell.ch)
        }
      }
      if (openLink) out.push('\x1b]8;;\x07')
      if (lastStyle !== null) out.push(RESET)
    }
    this._prev.cells = screen.cells
    if (out.length > 0) this.write(out.join(''))
    this._paintImages(screen.images, rewrittenImageRows)
    // Snapshot, not a reference: the caller may keep annotating the same
    // Screen before the next paint, and the diff must not see the future.
    // hasPayload rides along so the next paint can tell a placement whose
    // pixels are on screen from one that was reserved before its render landed.
    this._prevImageRows = screen.images.map((i) => ({ ...i, hasPayload: this._imagePayloads.has(i.key) }))
    // Park the (hidden) terminal cursor at the input caret so the OS IME
    // anchors its composition window inside the composer instead of at the
    // bottom-left corner. Screen coords are 0-based; the CSI cursor address
    // is 1-based, so add one to each. Falls back to the bottom-left.
    const cursorY = (screen.cursorY ?? screen.rows - 1) + 1
    const cursorX = (screen.cursorX ?? 0) + 1
    this.write('\x1b[' + cursorY + ';' + cursorX + 'H')
  }

  // Emit graphics-protocol output for the frame's images. Kitty transmits
  // each image once and moves placements by reference; sixel and iTerm2 have
  // no terminal-side registry, so their payloads re-emit at the new position
  // whenever the top row moves. `rewrittenImageRows` lists the images whose
  // cells this frame's text diff just wrote over: for every protocol except
  // kitty that destroys the image, so the payload goes out again — a stationary
  // image must survive the frames that render around it. Missing payloads
  // (still decoding) leave the blank placeholder cells visible until the result
  // arrives.
  _paintImages(images, rewrittenImageRows) {
    if (!this.caps) return
    const w = []
    if (this.caps.kitty) {
      const prevByKey = new Map(this._prevImageRows.map((i) => [i.key, i]))
      for (const img of images) {
        let id = this._kittyIds.get(img.key)
        if (id === undefined) {
          id = this._kittyNextId++
          this._kittyIds.set(img.key, id)
        }
        if (!this._kittySent.has(img.key)) {
          const payload = this._imagePayloads.get(img.key)
          if (payload?.kind === 'kitty') {
            w.push(encodeKittyTransmission(id, payload.b64))
            this._kittySent.add(img.key)
            w.push(kittyPlacement(id, img.x, img.y))
          }
          // Without a payload yet there is nothing to transmit or place.
          continue
        }
        const prev = prevByKey.get(img.key)
        if (!prev || prev.x !== img.x || prev.y !== img.y || rewrittenImageRows.has(img.key)) {
          w.push(kittyPlacement(id, img.x, img.y))
        }
      }
      const alive = new Set(images.map((i) => i.key))
      for (const [key, id] of this._kittyIds) {
        if (!alive.has(key)) {
          w.push(kittyDelete(id))
          this._kittyIds.delete(key)
          this._kittySent.delete(key)
        }
      }
    } else if (this.caps.sixel || this.caps.iterm2) {
      const prevByKey = new Map(this._prevImageRows.map((i) => [i.key, i]))
      for (const img of images) {
        const prev = prevByKey.get(img.key)
        // A footprint change counts as a move: the payload is sized to the
        // reserved cells, so the old pixels cover the wrong area either way. So
        // does a placement that had nothing to send last time — the rows can be
        // reserved before the render they need has landed (a cropped variant
        // registers the moment the window scrolls, its payload arrives after),
        // and calling that "unmoved" would leave the reserved cells blank for
        // good. Kitty has no such hole: it keys off what it really transmitted.
        const unmoved = prev && prev.x === img.x && prev.y === img.y
          && prev.cellsW === img.cellsW && prev.cellsH === img.cellsH
          && prev.hasPayload !== false
        if (unmoved && !rewrittenImageRows.has(img.key)) continue
        const payload = this._imagePayloads.get(img.key)
        if (!payload) continue
        w.push('\x1b[' + (img.y + 1) + ';' + (img.x + 1) + 'H')
        if (payload.kind === 'sixel') w.push(payload.s)
        else if (payload.kind === 'iterm2') w.push(encodeITerm2(payload.b64, payload.pxW, payload.pxH, payload.bytes))
      }
    }
    if (w.length > 0) this.write(w.join(''))
  }
}

function sameStyle(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline && a.link === b.link
}