// Markdown -> styled terminal lines, driven by markdown-it's CommonMark + GFM
// token stream (tables, nested lists, strikethrough) with highlight.js for
// fenced code. The output contract is unchanged from the legacy renderer: an
// array of lines, each line an array of { text, style } segments, blocks
// compact (a blank line appears only where the source had one).
//
// Two extra line shapes appear only when the caller passes hooks —
// { mermaid: code } for a ```mermaid fence and { image: { url, alt } } for a
// standalone markdown image. Without hooks both degrade in place (highlighted
// source / alt text), so callers that cannot show media still get sane output.
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import { makeStyle, mergeStyle } from './term.js'
import { runeWidth, displayWidth } from './util.js'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

// highlight.js scope -> THEME key. Unlisted scopes keep the code-block color.
const HLJS_COLOR_KEYS = {
  keyword: 'syntaxKeyword',
  literal: 'syntaxKeyword',
  title: 'syntaxFunction',
  function: 'syntaxFunction',
  built_in: 'syntaxType',
  type: 'syntaxType',
  class: 'syntaxType',
  attr: 'syntaxType',
  attribute: 'syntaxType',
  params: 'syntaxType',
  string: 'syntaxString',
  subst: 'syntaxString',
  regexp: 'syntaxString',
  addition: 'syntaxString',
  variable: 'syntaxString',
  number: 'syntaxNumber',
  symbol: 'syntaxNumber',
  comment: 'syntaxComment',
  doctag: 'syntaxComment',
  meta: 'syntaxComment',
}

const HTML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }
const decodeEntities = (s) => s.replace(/&lt;|&gt;|&quot;|&#39;|&amp;/g, (e) => HTML_ENTITIES[e])

// Parse highlight.js HTML output into styled segments, tracking the open span
// class stack. Output is well-defined (escaped text plus flat spans), so a
// two-branch regex covers it; multi-line tokens survive as '\n' inside text.
function parseHljsHtml(html, theme, base) {
  const segs = []
  const classes = []
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) classes.push(m[1])
    else if (m[0] === '</span>') classes.pop()
    else {
      const scope = (classes.find((c) => c && c !== 'hljs') ?? '').replace(/^hljs-/, '').replace(/_.*$/, '')
      const key = HLJS_COLOR_KEYS[scope]
      const fg = key ? (theme[key] ?? theme.markdownCodeBlock) : theme.markdownCodeBlock
      segs.push({ text: decodeEntities(m[2]), style: mergeStyle(base, { fg, bg: theme.codeBg }) })
    }
  }
  return segs
}

// Highlight one fenced block; returns an array of physical lines (segment
// arrays). Falls back to the plain code color for unknown or missing languages.
function highlightLines(code, lang, theme, base) {
  let segs = null
  if (lang && hljs.getLanguage(lang)) {
    try {
      segs = parseHljsHtml(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, theme, base)
    } catch { /* highlighting is best-effort */ }
  }
  if (!segs) {
    segs = [{ text: code, style: mergeStyle(base, { fg: theme.markdownCodeBlock, bg: theme.codeBg }) }]
  }
  const lines = [[]]
  for (const seg of segs) {
    const parts = seg.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part.length > 0) lines[lines.length - 1].push({ ...seg, text: part })
    })
  }
  return lines
}

// Render an inline token's children to flat segments. Style state (bold, em,
// strike) and the enclosing link ride a stack; link segments carry the href on
// a `link` property, which paint() turns into an OSC 8 hyperlink.
function inlineToSegments(token, ctx, base) {
  const theme = ctx.theme
  const segs = []
  const stack = []
  const state = { style: base, link: null }
  const push = (text, over = {}) => {
    if (text.length === 0) return
    const style = mergeStyle(state.style, over)
    segs.push({ text, style: state.link ? mergeStyle(style, { fg: theme.markdownLinkText, underline: true, link: state.link }) : style })
  }
  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        push(child.content)
        break
      case 'code_inline':
        push(child.content, { fg: theme.markdownCode, bg: theme.codeBg })
        break
      case 'softbreak':
      case 'hardbreak':
        push(' ')
        break
      case 'strong_open':
        stack.push({ ...state })
        state.style = mergeStyle(state.style, { bold: true })
        break
      case 'em_open':
        stack.push({ ...state })
        state.style = mergeStyle(state.style, { italic: true })
        break
      case 's_open':
        stack.push({ ...state })
        state.style = mergeStyle(state.style, { dim: true })
        break
      case 'strong_close':
      case 'em_close':
      case 's_close': {
        const restore = stack.pop()
        if (restore) Object.assign(state, restore)
        break
      }
      case 'link_open':
        stack.push({ ...state })
        state.link = child.attrGet('href') ?? null
        break
      case 'link_close': {
        const restore = stack.pop()
        if (restore) Object.assign(state, restore)
        break
      }
      case 'image':
        push(child.content || 'image', { italic: true })
        break
      default:
        if (child.content) push(child.content)
        break
    }
  }
  return segs
}

// A paragraph whose content is a single image (plus whitespace) is the markdown
// form of "show this picture".
function onlyImageChild(token) {
  const media = (token.children ?? []).filter((c) => c.type === 'image' || (c.type === 'text' && c.content.trim() === ''))
  return media.length === 1 && media[0].type === 'image' ? media[0] : null
}

function segWidth(text) {
  let w = 0
  for (const ch of text) w += runeWidth(ch)
  return w
}

// Truncate a segment line to `width` columns, appending an ellipsis when cut.
function clipSegLine(segs, width) {
  const total = segs.reduce((w, s) => w + segWidth(s.text), 0)
  if (total <= width) return segs
  const out = []
  let used = 0
  for (const seg of segs) {
    if (used >= width) break
    const w = segWidth(seg.text)
    if (used + w <= width) {
      out.push(seg)
      used += w
      continue
    }
    const room = width - used - 1
    if (room < 0) {
      if (out.length === 0) out.push({ ...seg, text: '…' })
      break
    }
    let text = ''
    for (const ch of seg.text) {
      if (segWidth(text) + runeWidth(ch) > room) break
      text += ch
    }
    if (text) out.push({ ...seg, text })
    out.push({ ...seg, text: '…' })
    used = width
  }
  return out
}

// ---- GFM table: rounded box, columns sized to content within the caller's
// width, overlong cells ellipsized. Alignment attributes are not rendered (v1).
function tableBorderStyle(theme) {
  return makeStyle({ fg: theme.tableBorder ?? theme.markdownHorizontalRule })
}

function tableBoxTop(widths) {
  return '╭' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '╮'
}
function tableBoxMid(widths) {
  return '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤'
}
function tableBoxBottom(widths) {
  return '╰' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '╯'
}
function tableBoxRow(cells, widths, theme) {
  const style = tableBorderStyle(theme)
  const segs = [{ text: '│', style }]
  cells.forEach((cell, i) => {
    segs.push({ text: ' ', style })
    segs.push(...clipSegLine(cell, widths[i]))
    const pad = widths[i] - cell.reduce((w, s) => w + segWidth(s.text), 0)
    if (pad > 0) segs.push({ text: ' '.repeat(pad), style })
    segs.push({ text: ' ', style })
    if (i < cells.length - 1) segs.push({ text: '│', style })
  })
  segs.push({ text: '│', style })
  return segs
}

function renderTable(tokens, start, ctx) {
  const theme = ctx.theme
  const rows = []
  let current = null
  let i = start
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'table_close') break
    if (t.type === 'tr_open') current = []
    else if (t.type === 'tr_close') {
      if (current) rows.push(current)
      current = null
    } else if ((t.type === 'th_open' || t.type === 'td_open') && current) {
      current.cell = []
    } else if (t.type === 'inline' && current?.cell) {
      current.cell.push(...inlineToSegments(t, ctx, makeStyle({ fg: theme.text })))
    } else if ((t.type === 'th_close' || t.type === 'td_close') && current) {
      current.push(current.cell ?? [])
    }
  }
  const head = rows.shift() ?? []
  const body = rows
  const all = [head, ...body].filter((r) => r.length > 0)
  if (all.length === 0) return i
  const cols = Math.max(...all.map((r) => r.length))
  for (const r of all) while (r.length < cols) r.push([])
  const inner = Math.max(8, ctx.width - 2 - cols * 3 - (cols - 1))
  const widths = []
  for (let c = 0; c < cols; c++) {
    const widest = Math.max(...all.map((r) => r[c].reduce((w, s) => w + segWidth(s.text), 0)))
    widths.push(Math.min(Math.max(widest, 3), Math.max(3, Math.floor(inner / cols))))
  }
  const lines = ctx.lines
  lines.push([{ text: tableBoxTop(widths), style: tableBorderStyle(theme) }])
  lines.push(tableBoxRow(head, widths, theme).map((s) => ({ ...s, style: mergeStyle(s.style, { bold: true }) })))
  lines.push([{ text: tableBoxMid(widths), style: tableBorderStyle(theme) }])
  for (const r of body) lines.push(tableBoxRow(r, widths, theme))
  lines.push([{ text: tableBoxBottom(widths), style: tableBorderStyle(theme) }])
  return i
}

// Detect a GFM task-list marker on a list item's first paragraph: the checkbox
// text is stripped from the token stream and the glyph returned ('☑ ' / '□ ').
function taskMarker(tokens, from) {
  for (let i = from; i < Math.min(tokens.length, from + 4); i++) {
    const t = tokens[i]
    if (t.type === 'inline') {
      const first = (t.children ?? []).find((c) => c.type === 'text' && c.content.trim() !== '')
      if (!first) return null
      const m = /^\[([ xX])\]\s+/.exec(first.content)
      if (!m) return null
      first.content = first.content.slice(m[0].length)
      return m[1] === ' ' ? '□ ' : '☑ '
    }
    if (t.type === 'paragraph_close') return null
  }
  return null
}

// ---- line emission ---------------------------------------------------------

// Prefix: quote bars then list indent, so nested quotes read as stacked bars.
function prefixOf(state) {
  return '▍ '.repeat(state.quotes) + state.indent
}

function markerText(marker) {
  return Array.isArray(marker) ? marker.map((s) => s.text).join('') : (marker ?? '')
}

function pushWrapped(ctx, segments, state, marker = null) {
  const prefix = prefixOf(state)
  const avail = Math.max(1, ctx.width - displayWidth(prefix))
  const body = wrapSegments(segments, avail)
  const mw = marker ? displayWidth(markerText(marker)) : 0
  const rows = body.length > 0 ? body : [[]]
  rows.forEach((line, i) => {
    const lineSegs = []
    if (prefix) lineSegs.push({ text: prefix, style: state.quoteStyle ?? null })
    if (i === 0 && marker) lineSegs.push(...(Array.isArray(marker) ? marker : [{ text: marker, style: state.markerStyle ?? null }]))
    else if (i > 0 && mw > 0) lineSegs.push({ text: ' '.repeat(mw), style: null })
    lineSegs.push(...line)
    ctx.lines.push(lineSegs)
  })
}

function pushPlain(ctx, segments, state) {
  const prefix = prefixOf(state)
  const lineSegs = []
  if (prefix) lineSegs.push({ text: prefix, style: state.quoteStyle ?? null })
  lineSegs.push(...segments)
  ctx.lines.push(lineSegs)
}

// Walk block tokens between [start, end). `state` carries indent, quote depth
// and the pending list marker. Blank lines from the source are preserved via
// token map gaps.
function renderBlocks(tokens, start, end, ctx, state) {
  const theme = ctx.theme
  let i = start
  let lastEnd = null
  while (i < end) {
    const t = tokens[i]
    if (t.map && lastEnd !== null && t.map[0] > lastEnd) ctx.lines.push([])
    if (t.map) lastEnd = t.map[1]
    switch (t.type) {
      case 'heading_open': {
        const inline = tokens[i + 1]
        pushWrapped(ctx, inlineToSegments(inline, ctx, makeStyle({ fg: theme.markdownHeading, bold: true })), state)
        i += 3
        continue
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1]
        const image = onlyImageChild(inline)
        if (image && ctx.hooks?.image) {
          ctx.lines.push({ image: { url: image.attrGet('src') ?? '', alt: image.content ?? '' } })
          i += 3
          continue
        }
        pushWrapped(ctx, inlineToSegments(inline, ctx, makeStyle({ fg: theme.text })), state, state.marker)
        state.marker = null
        i += 3
        continue
      }
      case 'fence': {
        const lang = (t.info ?? '').trim().split(/\s+/)[0] ?? ''
        if (lang === 'mermaid' && ctx.hooks?.mermaid) {
          ctx.lines.push({ mermaid: t.content.replace(/\n$/, '') })
          i += 1
          continue
        }
        const codeBase = makeStyle({ fg: theme.markdownCodeBlock, bg: theme.codeBg })
        const prefix = prefixOf(state) + '  '
        ctx.lines.push([])
        for (const line of highlightLines(t.content.replace(/\n$/, ''), lang, theme, codeBase)) {
          ctx.lines.push([{ text: prefix, style: codeBase }, ...line])
        }
        ctx.lines.push([])
        i += 1
        continue
      }
      case 'hr': {
        pushPlain(ctx, [{ text: '─'.repeat(Math.max(4, ctx.width)), style: makeStyle({ fg: theme.markdownHorizontalRule, dim: true }) }], state)
        i += 1
        continue
      }
      case 'blockquote_open':
        state.quotes += 1
        state.quoteStyle = makeStyle({ fg: theme.markdownBlockQuote })
        i += 1
        continue
      case 'blockquote_close':
        state.quotes -= 1
        if (state.quotes === 0) state.quoteStyle = null
        i += 1
        continue
      case 'bullet_list_open':
        if (state.markers.length > 0) state.indent += '  '
        state.markers.push('- ')
        i += 1
        continue
      case 'ordered_list_open':
        if (state.markers.length > 0) state.indent += '  '
        state.markers.push({ ordered: 1 })
        i += 1
        continue
      case 'bullet_list_close':
      case 'ordered_list_close':
        if (state.markers.length > 1) state.indent = state.indent.slice(0, -2)
        state.markers.pop()
        i += 1
        continue
      case 'list_item_open': {
        const marker = state.markers[state.markers.length - 1]
        const task = taskMarker(tokens, i + 1)
        if (task) {
          state.marker = [{ text: task, style: makeStyle({ fg: task.startsWith('☑') ? theme.success : theme.textMuted }) }]
        } else if (marker && typeof marker === 'object') {
          state.marker = [{ text: marker.ordered + '. ', style: makeStyle({ fg: theme.markdownListItem, bold: true }) }]
          marker.ordered += 1
        } else {
          state.marker = [{ text: '- ', style: makeStyle({ fg: theme.markdownListItem, bold: true }) }]
        }
        i += 1
        continue
      }
      case 'list_item_close':
        state.marker = null
        i += 1
        continue
      case 'table_open':
        i = renderTable(tokens, i, ctx) + 1
        continue
      case 'html_block': {
        for (const line of t.content.split('\n')) {
          if (line.trim() === '') continue
          pushWrapped(ctx, [{ text: line, style: makeStyle({ fg: theme.textMuted }) }], state)
        }
        i += 1
        continue
      }
      default:
        i += 1
        continue
    }
  }
}

// Render markdown text to styled lines for the given width. hooks (all
// optional): { mermaid: boolean, image: boolean } enable the special line
// shapes { mermaid } / { image } instead of their in-place fallbacks.
export function renderMarkdown(text, theme, width, hooks = null) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  const tokens = md.parse(raw, {})
  const ctx = { theme, width: Math.max(1, width), hooks, lines: [] }
  renderBlocks(tokens, 0, tokens.length, ctx, {
    indent: '',
    quotes: 0,
    quoteStyle: null,
    markers: [],
    marker: null,
  })
  return ctx.lines
}

// Wrap inline segments to `width` cells, returning lines of segments. Split
// parts keep every source property (link included), not just text/style.
export function wrapSegments(segments, width) {
  if (width <= 0) return [[]]
  const lines = []
  let current = []
  let currentW = 0
  let word = []
  let wordW = 0
  const pushWord = () => {
    if (wordW === 0) return
    if (currentW + wordW > width && current.length > 0) {
      lines.push(current)
      current = []
      currentW = 0
    }
    if (wordW > width) {
      let rest = word
      let restW = wordW
      while (restW > width) {
        let acc = 0
        let used = 0
        outer: for (const seg of rest) {
          for (const ch of seg.text) {
            const w = runeWidth(ch)
            if (acc + w > width) break outer
            acc += w
            used += ch.length
          }
        }
        const chunk = extractPrefixSegments(rest, used)
        lines.push([...current, ...chunk])
        current = []
        currentW = 0
        rest = consumePrefixSegments(rest, used)
        restW = rest.reduce((s, seg) => s + segWidth(seg.text), 0)
      }
      for (const seg of rest) current.push(seg)
      currentW = restW
    } else {
      for (const seg of word) current.push(seg)
      currentW += wordW
    }
    word = []
    wordW = 0
  }
  for (const seg of segments) {
    const parts = seg.text.split(/(\s+)/)
    for (const part of parts) {
      if (part === '') continue
      if (/^\s+$/.test(part)) {
        pushWord()
        if (currentW + runeWidth(part) <= width || current.length === 0) {
          current.push({ ...seg, text: part })
          currentW += runeWidth(part)
        } else if (current.length > 0) {
          lines.push(current)
          current = []
          currentW = 0
        }
      } else {
        if (word.length > 0 && word[word.length - 1].style !== seg.style) pushWord()
        word.push({ ...seg, text: part })
        wordW += segWidth(part)
      }
    }
  }
  pushWord()
  if (current.length > 0 || lines.length === 0) lines.push(current)
  return lines
}

function extractPrefixSegments(segs, used) {
  const out = []
  let acc = 0
  for (const seg of segs) {
    if (acc >= used) break
    const take = Math.min(used - acc, seg.text.length)
    out.push({ ...seg, text: seg.text.slice(0, take) })
    acc += take
  }
  return out
}
function consumePrefixSegments(segs, used) {
  const out = []
  let acc = 0
  for (const seg of segs) {
    if (acc >= used) {
      out.push(seg)
      continue
    }
    const take = Math.min(used - acc, seg.text.length)
    acc += take
    if (take < seg.text.length) out.push({ ...seg, text: seg.text.slice(take) })
  }
  return out
}

// Legacy inline entry point: parse one line of inline markdown the way
// renderMarkdown would and return its segments. Kept for callers that predate
// the token-stream renderer.
export function inlineSegments(text, theme, base = null) {
  const fallback = base ?? makeStyle({ fg: theme.text })
  const tokens = md.parse(String(text ?? ''), {})
  const inline = tokens.find((t) => t.type === 'inline')
  if (!inline) return [{ text: '', style: fallback }]
  return inlineToSegments(inline, { theme, width: Infinity, hooks: null }, fallback)
}
