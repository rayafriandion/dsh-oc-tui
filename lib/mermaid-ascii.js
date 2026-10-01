// mermaid-ascii.js - native terminal art for ```mermaid fences.
//
// lovely-mermaid lays a diagram out in box-drawing characters and labels every
// cell with what it is: a border, a node label, an edge, an edge label, a
// title. It is pure JavaScript - no browser, no SVG, no image protocol - so a
// diagram becomes terminal text instead of a rasterized picture.
//
// This module is the TUI's side of that engine: it loads the engine lazily (a
// session that never opens a diagram never pays for it), maps the engine's
// semantic roles onto the TUI theme, settles the one measurement the two sides
// disagree on - emoji width - and reports the art's display width so the caller
// decides what to do when it does not fit the space at hand.
//
// Parsing is best-effort by design - a streaming prefix keeps drawing instead
// of flickering between art and source - so every failure mode here degrades
// to `null` and the caller falls back to its own chain.
import { makeStyle } from './term.js'
import { displayWidth } from './util.js'

// One module-level promise: the first fence pays for the engine, every later
// one shares it, and a failed import settles once instead of on every paint.
let enginePromise = null

/**
 * Load the mermaid engine, once per process.
 * @returns {Promise<{render: (src: string) => object|null}|null>} the engine,
 *   or null when the package is missing or broken.
 */
export function loadMermaidEngine() {
  enginePromise ??= import('lovely-mermaid')
    .then((mod) => ({
      // The engine is best-effort by contract, but a parser bug on model
      // output must not take the transcript down with it.
      render: (src) => {
        try {
          return mod.render(src)
        } catch {
          return null
        }
      },
    }))
    .catch(() => null)
  return enginePromise
}

/**
 * Lay one mermaid source out as box-drawing art.
 * @param {{render: Function}|null} engine - from {@link loadMermaidEngine}.
 * @param {string} src - the fence body.
 * @returns {{plain: string[], styled: object[], width: number, warnings: string[]}|null}
 *   the art, or null when there is none to show.
 */
export function renderMermaidArt(engine, src) {
  if (!engine || typeof src !== 'string' || src.trim() === '') return null
  return engine.render(emojiWideSource(engine, src))
}

// The engine sizes a label from the `unicode-width` crate, which follows
// EastAsianWidth.txt and leaves the emoji Unicode marks East-Asian-Neutral at
// one column; terminals draw every one of them two, so 🌡 overflows its box and
// the border beside it lands a column out. A cluster that carries the variation
// selector asking for emoji presentation is measured as two columns by the
// engine and drawn by the terminal as the very same emoji, so appending the
// selector restores the box without moving a pixel. Only clusters this terminal
// really draws wider than the engine sized them are touched - the probe below is
// what tells those apart from an emoji the engine already measures correctly -
// and its verdict is memoised, so a session renders each probe once.
const EMOJI = /[\u{10000}-\u{10FFFF}]/u
const EMOJI_WIDE = new Map()
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

function needsEmojiWide(engine, cluster) {
  const known = EMOJI_WIDE.get(cluster)
  if (known !== undefined) return known
  // One node holding the cluster: a label wider than the art's own width means
  // the engine under-measured this glyph.
  const art = engine.render('graph TD\n A["' + cluster + '"]')
  const wide = !!art && art.plain.some((row) => displayWidth(row) > art.width)
  EMOJI_WIDE.set(cluster, wide)
  return wide
}

function emojiWideSource(engine, src) {
  if (!EMOJI.test(src)) return src
  let out = ''
  let widened = false
  for (const { segment } of graphemes.segment(src)) {
    out += segment
    if (!EMOJI.test(segment) || segment.includes('\uFE0F')) continue
    if (!needsEmojiWide(engine, segment)) continue
    out += '\uFE0F'
    widened = true
  }
  return widened ? out : src
}

// The engine never knows about colour; it names roles and the consumer maps
// them. Borders and connectors recede, labels stay body-coloured, and the
// `title` role (the `mermaid: …` header of a framed source box) is bold.
const roleStyle = (role, theme) => {
  switch (role) {
    case 'border':
      return makeStyle({ fg: theme.border })
    case 'edge':
      return makeStyle({ fg: theme.info })
    case 'edgeLabel':
      return makeStyle({ fg: theme.info, dim: true })
    case 'title':
      return makeStyle({ fg: theme.textMuted, bold: true })
    case 'text':
      return makeStyle({ fg: theme.text })
    default:
      return makeStyle({})
  }
}

/**
 * Paint art rows as TUI line segments - one entry per physical row, each an
 * array of `{ text, style }` ready to push as `{ segs }`. Adjacent spans that
 * share a role share a style, and every row is indented to sit where a code
 * block body sits.
 * @param {object} art - from {@link renderMermaidArt}.
 * @param {object} theme - the TUI theme.
 * @param {string} [indent] - row prefix; the code-block body indent.
 * @returns {object[][]} one segment array per row.
 */
export function paintMermaidArt(art, theme, indent = '  ') {
  const out = []
  for (const row of art.styled) {
    const segs = indent ? [{ text: indent, style: makeStyle({}) }] : []
    for (const span of row) {
      if (span.text === '') continue
      segs.push({ text: span.text, style: roleStyle(span.role, theme) })
    }
    out.push(segs)
  }
  return out
}
