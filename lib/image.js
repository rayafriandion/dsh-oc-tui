// Image pipeline: decode, scale to terminal cells, and encode for the best
// graphics protocol the terminal supports (kitty graphics, iTerm2 inline
// images, sixel) or ANSI halfblock characters as the universal fallback.
// sharp is injected by the caller (lazy import) so the module stays loadable
// in environments without it (tests, degraded installs).
import { createHash } from 'node:crypto'

export function sha16(bytes) {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16)
}

// Small LRU for rendered payloads keyed by content hash + size + protocol:
// a scrolling transcript re-emits the same image many times, and sixel/iTerm2
// payloads are large enough that regenerating them per frame would stall.
export class PayloadCache {
  constructor(max = 64) {
    this.max = max
    this.map = new Map()
  }

  get(key) {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value)
    this.map.set(key, value)
  }
}

// Fit an image of pxW x pxH into maxCellsW x maxCellsH cells without
// upscaling past its natural cell size. Cells are what the renderer reserves,
// so fractional cells round to whole ones (never zero).
export function scaleToCells(pxW, pxH, maxCellsW, maxCellsH, cellW, cellH) {
  let w = pxW / cellW
  let h = pxH / cellH
  const factor = Math.min(maxCellsW / w, maxCellsH / h, 1)
  w *= factor
  h *= factor
  return { cellsW: Math.max(1, Math.round(w)), cellsH: Math.max(1, Math.round(h)) }
}

const hex2 = (n) => n.toString(16).padStart(2, '0')

// Compose a source pixel over the background color and return the hex pair
// the terminal truecolor SGR expects.
function blendHex(r, g, b, a, bg) {
  const f = a / 255
  const rr = Math.round(r * f + bg[0] * (1 - f))
  const gg = Math.round(g * f + bg[1] * (1 - f))
  const bb = Math.round(b * f + bg[2] * (1 - f))
  return hex2(rr) + hex2(gg) + hex2(bb)
}

// ANSI halfblock renderer: each cell shows two stacked pixel rows through the
// foreground/background pair of '▀' (a plain space when both rows match).
// Every glyph is a basic block present in every terminal font, which is what
// makes this the universal fallback. A cell averages the pixel block it covers
// (pxW/cellsW wide, pxH/cellsH tall split at half height), so downsampling is
// done here rather than by sampling a single pixel.
export function renderHalfblock(rgba, pxW, pxH, cellsW, cellsH, { bgHex = '000000' } = {}) {
  const bg = [0, 0, 0]
  if (/^[0-9a-fA-F]{6}$/.test(bgHex)) {
    bg[0] = parseInt(bgHex.slice(0, 2), 16)
    bg[1] = parseInt(bgHex.slice(2, 4), 16)
    bg[2] = parseInt(bgHex.slice(4, 6), 16)
  }
  const cellPxW = pxW / cellsW
  const cellPxH = pxH / cellsH
  const halfH = Math.max(1, Math.floor(cellPxH / 2))
  // Average an axis-aligned pixel block, alpha-composited over the background.
  const blockColor = (x0, y0, w, h) => {
    let r = 0, g = 0, b = 0, a = 0, n = 0
    const xa = Math.max(0, Math.floor(x0))
    const xb = Math.min(pxW, Math.ceil(x0 + w))
    const ya = Math.max(0, Math.floor(y0))
    const yb = Math.min(pxH, Math.ceil(y0 + h))
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = (y * pxW + x) * 4
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]
        n++
      }
    }
    if (n === 0) return blendHex(0, 0, 0, 0, bg)
    return blendHex(r / n, g / n, b / n, a / n, bg)
  }
  const lines = []
  for (let cy = 0; cy < cellsH; cy++) {
    const row = []
    let last = null
    for (let cx = 0; cx < cellsW; cx++) {
      const x0 = cx * cellPxW
      const y0 = cy * cellPxH
      const top = blockColor(x0, y0, cellPxW, halfH)
      const bottom = blockColor(x0, y0 + halfH, cellPxW, halfH)
      let seg
      if (top === bottom) seg = { text: ' ', style: { fg: top, bg: top } }
      else seg = { text: '▀', style: { fg: top, bg: bottom } }
      if (last && last.style.fg === seg.style.fg && last.style.bg === seg.style.bg) {
        last.text += seg.text
      } else {
        row.push(seg)
        last = seg
      }
    }
    lines.push(row)
  }
  return lines
}

// Median-cut color quantization for sixel (which carries at most 256 palette
// entries). The histogram is sampled and looked up through a coarse 15-bit
// key so per-pixel palette matching costs one Map read, not a color scan.
function quantize(rgba, pxW, pxH, maxColors) {
  const indices = new Uint8Array(pxW * pxH)
  const total = pxW * pxH
  const step = Math.max(1, Math.floor(total / 16384))
  const histogram = new Map()
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)
    if (!histogram.has(key)) histogram.set(key, [rgba[o], rgba[o + 1], rgba[o + 2], 1])
    else histogram.get(key)[3]++
  }
  let buckets = [[...histogram.values()]]
  while (buckets.length < maxColors) {
    let bi = -1
    let range = 0
    let chan = 0
    buckets.forEach((b, i) => {
      if (b.length < 2) return
      for (let c = 0; c < 3; c++) {
        let min = 255
        let max = 0
        for (const p of b) {
          if (p[c] < min) min = p[c]
          if (p[c] > max) max = p[c]
        }
        if (max - min > range) { range = max - min; bi = i; chan = c }
      }
    })
    if (bi < 0) break
    const b = buckets[bi]
    b.sort((x, y) => x[chan] - y[chan])
    const mid = b.length >> 1
    buckets.splice(bi, 1, b.slice(0, mid), b.slice(mid))
  }
  const palette = buckets
    .filter((b) => b.length > 0)
    .map((b) => {
      let r = 0, g = 0, bl = 0, n = 0
      for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; n++ }
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)]
    })
  // Coarse-key cache: every source color inside one 5-bit cube maps to the
  // same palette entry, which keeps banding visible but the encoder fast.
  const lookup = new Map()
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    let idx = lookup.get(key)
    if (idx !== undefined) return idx
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i]
      const dr = r - p[0], dg = g - p[1], db = b - p[2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; best = i }
    }
    lookup.set(key, best)
    return best
  }
  for (let i = 0; i < total; i++) {
    const o = i * 4
    indices[i] = nearest(rgba[o], rgba[o + 1], rgba[o + 2])
  }
  return { palette, indices }
}

// Sixel encoder (DEC graphics). The raster attributes ("1;1;<H>;<W>") force
// square pixels — the bare DCS P1=0 means 2:1 on some terminals and would
// stretch every image to twice its reserved rows. P2=1 leaves unset pixels
// transparent so the text grid behind the image (the bubble/canvas background
// the renderer already painted) shows through instead of a painted rectangle.
//
// Within a color pass, EVERY column emits a data character — blank columns
// send '?' (bits 0). The sixel cursor only advances on data characters, so
// skipping gaps would shift everything after the first hole sideways.
export function encodeSixel(rgba, pxW, pxH) {
  const { palette, indices } = quantize(rgba, pxW, pxH, 256)
  const parts = [`\x1bP0;1;1q"1;1;${pxH};${pxW}`]
  const bands = Math.ceil(pxH / 6)
  for (let band = 0; band < bands; band++) {
    if (band > 0) parts.push('-')
    // Which palette entries appear in this band, most-used first so the
    // dominant color switches cost the least.
    const used = new Map()
    for (let y = band * 6; y < Math.min(pxH, band * 6 + 6); y++) {
      for (let x = 0; x < pxW; x++) {
        const idx = indices[y * pxW + x]
        used.set(idx, (used.get(idx) ?? 0) + 1)
      }
    }
    const order = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i)
    for (const idx of order) {
      const p = palette[idx]
      parts.push(`#${idx};2;${Math.round(p[0] / 2.55)};${Math.round(p[1] / 2.55)};${Math.round(p[2] / 2.55)}`)
      let runChar = ''
      let run = 0
      const flush = () => {
        if (run === 0) return
        parts.push(run > 3 ? `!${run}${runChar}` : runChar.repeat(run))
        run = 0
      }
      for (let x = 0; x < pxW; x++) {
        let bits = 0
        for (let r = 0; r < 6; r++) {
          const y = band * 6 + r
          if (y < pxH && indices[y * pxW + x] === idx) bits |= 1 << r
        }
        const ch = String.fromCharCode(0x3F + bits)
        if (ch === runChar) run++
        else { flush(); runChar = ch; run = 1 }
      }
      flush()
      parts.push('$')
    }
  }
  parts.push('\x1b\\')
  return parts.join('')
}

// Kitty graphics protocol. Transmission: base64 PNG in 4096-char chunks with
// the continuation flag m; the first chunk carries the full control params.
// Placement happens separately (kittyPlacement) so a scrolled transcript moves
// an already-transmitted image for free instead of resending pixel data.
export function encodeKittyTransmission(id, b64) {
  const parts = []
  for (let i = 0; i < b64.length; i += 4096) {
    const chunk = b64.slice(i, i + 4096)
    const last = i + 4096 >= b64.length
    const control = i === 0
      ? `a=T,f=100,q=2,i=${id},m=${last ? 0 : 1}`
      : `m=${last ? 0 : 1}`
    parts.push(`\x1b_G${control};${chunk}\x1b\\`)
  }
  if (parts.length === 0) parts.push(`\x1b_Ga=T,f=100,q=2,i=${id},m=0;\x1b\\`)
  return parts.join('')
}

// Place a previously transmitted image with its top-left cell at (x, y).
// The CSI prefix moves the (hidden) cursor there; C=1 keeps the placement
// from advancing it, and q=2 suppresses the terminal's response frames.
export function kittyPlacement(id, x, y) {
  return `\x1b[${y + 1};${x + 1}H\x1b_Ga=p,i=${id},C=1,q=2\x1b\\`
}

export function kittyDelete(id) {
  return `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`
}

export function kittyDeleteAll() {
  return '\x1b_Ga=d,d=a,q=2\x1b\\'
}

// iTerm2 inline image (also WezTerm, recent Konsole, mintty). There is no
// image registry on the terminal side, so moving an image means re-emitting
// the payload at the new cursor position; callers cache the payload string.
export function encodeITerm2(b64, pxW, pxH, byteLength = b64.length) {
  return `\x1b]1337;File=inline=1;size=${byteLength};width=${pxW}px;height=${pxH}px:name=x.png:${b64}\x07`
}

// Decode + scale + encode one image for the requested protocol.
// Returns { protocol, cellsW, cellsH, hash, payload? | segLines? } on success
// or { protocol: 'error', error } — never throws.
export async function renderImage(source, { protocol, maxCellsW, maxCellsH, cellW = 8, cellH = 16, bgHex = '000000', sharp: injectedSharp }) {
  const bytes = source?.bytes
  const hash = sha16(bytes ?? Buffer.alloc(0))
  if (!bytes) return { protocol: 'error', error: 'no image bytes', hash }
  try {
    const sharp = injectedSharp ?? (await import('sharp')).default
    const meta = await sharp(bytes, { animated: false }).metadata()
    if (!meta.width || !meta.height) throw new Error('image has no dimensions')
    const { cellsW, cellsH } = scaleToCells(meta.width, meta.height, maxCellsW, maxCellsH, cellW, cellH)
    const pxW = cellsW * cellW
    const pxH = cellsH * cellH
    const base = sharp(bytes, { animated: false }).resize(pxW, pxH, { fit: 'fill' }).ensureAlpha()
    if (protocol === 'kitty' || protocol === 'iterm2') {
      const png = await base.png().toBuffer()
      const b64 = png.toString('base64')
      if (protocol === 'kitty') return { protocol, cellsW, cellsH, hash, payload: { kind: 'kitty', b64, bytes: png.length } }
      return { protocol, cellsW, cellsH, hash, payload: { kind: 'iterm2', b64, bytes: png.length, pxW, pxH } }
    }
    const { data } = await base.raw().toBuffer({ resolveWithObject: true })
    if (protocol === 'sixel') {
      return { protocol, cellsW, cellsH, hash, payload: { kind: 'sixel', s: encodeSixel(data, pxW, pxH) } }
    }
    const segLines = renderHalfblock(data, pxW, pxH, cellsW, cellsH, { bgHex })
    return { protocol: 'halfblock', cellsW, cellsH, hash, segLines }
  } catch (e) {
    return { protocol: 'error', error: String(e?.message ?? e), hash }
  }
}
