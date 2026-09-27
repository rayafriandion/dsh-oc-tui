// Standalone tests for the graphics stack: terminal capability probing,
// image encoders, markdown extensions, and the mermaid provider chain.
// Run: node tests/graphics.test.mjs  (no dsh environment required)
import { decodeKey } from '../lib/term.js'

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log('ok   ' + name) }
  else { console.log('FAIL ' + name + '  got ' + a + '  want ' + e); failed++ }
}
const ok = (name, cond) => cond ? console.log('ok   ' + name) : (console.log('FAIL ' + name), failed++)

// ---- terminal reply decoding (term.js) ----

{
  const r = decodeKey(Buffer.from('\x1b[?62;4;6;9;15;22c', 'latin1'))
  eq('decodeKey DA1 reply -> terminal-reply', r?.key?.name, 'terminal-reply')
  eq('decodeKey DA1 kind', r?.key?.reply?.kind, 'da1')
  eq('decodeKey DA1 body', r?.key?.reply?.body, '?62;4;6;9;15;22')
  eq('decodeKey DA1 consumed fully', r.consumed, 18)
}
{
  const r = decodeKey(Buffer.from('\x1b_Gi=31;OK\x1b\\', 'latin1'))
  eq('decodeKey kitty APC reply', r?.key?.reply?.kind, 'apc')
  eq('decodeKey kitty APC body', r?.key?.reply?.body, 'Gi=31;OK')
}
{
  const r = decodeKey(Buffer.from('\x1bP>|iTerm2 3.5.11\x1b\\', 'latin1'))
  eq('decodeKey XTVERSION DCS reply', r?.key?.reply?.kind, 'dcs')
  eq('decodeKey XTVERSION body', r?.key?.reply?.body, '>|iTerm2 3.5.11')
}
{
  const r = decodeKey(Buffer.from('\x1b[8;16;8t', 'latin1'))
  eq('decodeKey cell-size windowops reply', r?.key?.reply?.kind, 'windowops')
  eq('decodeKey cell-size body', r?.key?.reply?.body, '8;16;8')
}
{
  // A partial reply (no ST/BEL terminator yet) must wait for more bytes.
  eq('decodeKey partial APC waits', decodeKey(Buffer.from('\x1b_Gi=31;', 'latin1')), null)
  eq('decodeKey partial CSI waits', decodeKey(Buffer.from('\x1b[?62;', 'latin1')), null)
}
{
  // Cursor position reports and other CSI forms must never become keys.
  const r = decodeKey(Buffer.from('\x1b[24;80R', 'latin1'))
  eq('decodeKey CPR swallowed as unknown reply', r?.key?.reply?.kind, 'unknown')
}
{
  // Ordinary keys must still decode after the reply branches were added.
  eq('decodeKey arrow still works', decodeKey(Buffer.from('\x1b[A', 'latin1'))?.key?.name, 'up')
  eq('decodeKey printable still works', decodeKey(Buffer.from('a', 'latin1'))?.key?.text, 'a')
  eq('decodeKey mouse still works', decodeKey(Buffer.from('\x1b[<0;10;5M', 'latin1'))?.key?.name, 'mouse')
  eq('decodeKey paste still works', decodeKey(Buffer.from('\x1b[200~hi\x1b[201~', 'latin1'))?.key?.name, 'paste')
}

// ---- capability parsing (caps.js) ----

import { parseDA1, parseCellSize, probeCapabilities } from '../lib/caps.js'
import { EventEmitter } from 'node:events'

eq('parseDA1 sixel present', parseDA1('?62;4;6;9').sixel, true)
eq('parseDA1 sixel absent', parseDA1('?62;1;2').sixel, false)
eq('parseCellSize h;w', parseCellSize('8;16;8'), { h: 16, w: 8 })
eq('parseCellSize rejects other forms', parseCellSize('22;0'), null)

// probeCapabilities against a scripted fake terminal.
{
  const writes = []
  const term = new EventEmitter()
  term.write = (s) => { writes.push(s) }
  const probe = probeCapabilities(term, { timeoutMs: 20 })
  // The terminal answers after the probes were sent.
  term.emit('key', { name: 'terminal-reply', reply: { kind: 'da1', body: '?62;4;6' } })
  term.emit('key', { name: 'terminal-reply', reply: { kind: 'dcs', body: '>|WezTerm 20240203' } })
  term.emit('key', { name: 'terminal-reply', reply: { kind: 'apc', body: 'Gi=31;OK' } })
  term.emit('key', { name: 'terminal-reply', reply: { kind: 'windowops', body: '8;16;9' } })
  const caps = await probe
  eq('probe caps kitty', caps.kitty, true)
  eq('probe caps sixel', caps.sixel, true)
  eq('probe caps iterm2 (WezTerm alias)', caps.iterm2, true)
  eq('probe caps name', caps.name, 'WezTerm 20240203')
  eq('probe caps cell size', { w: caps.cellW, h: caps.cellH }, { w: 9, h: 16 })
  ok('probe wrote four probes', writes.length === 4)
  ok('probe listener detached', term.listenerCount('key') === 0)
}

// ---- image pipeline (image.js) ----

import { scaleToCells, renderHalfblock, encodeSixel, encodeKittyTransmission, kittyPlacement, kittyDelete, kittyDeleteAll, encodeITerm2, renderImage, PayloadCache } from '../lib/image.js'

eq('scaleToCells fits 800x600 into 60x20 cells', scaleToCells(800, 600, 60, 20, 8, 16), { cellsW: 53, cellsH: 20 })
eq('scaleToCells small image stays natural size', scaleToCells(80, 40, 60, 20, 8, 16), { cellsW: 10, cellsH: 3 })
eq('scaleToCells wide banner caps width', scaleToCells(2000, 50, 60, 20, 8, 16), { cellsW: 60, cellsH: 1 })
eq('scaleToCells never rounds to zero', scaleToCells(4, 4, 60, 20, 8, 16), { cellsW: 1, cellsH: 1 })

{
  // One cell = 2x2 px here: top row white, bottom row black -> upper half block.
  const rgba = Buffer.from([
    255, 255, 255, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ])
  const lines = renderHalfblock(rgba, 2, 2, 1, 1)
  eq('halfblock split cell', lines, [[{ text: '▀', style: { fg: 'ffffff', bg: '000000' } }]])
}
{
  const rgba = Buffer.alloc(2 * 2 * 4, 255)
  const lines = renderHalfblock(rgba, 2, 2, 1, 1)
  eq('halfblock uniform cell collapses to a space', lines, [[{ text: ' ', style: { fg: 'ffffff', bg: 'ffffff' } }]])
}
{
  // Adjacent cells with the same style merge into one segment.
  const rgba = Buffer.alloc(4 * 2 * 4, 255)
  const lines = renderHalfblock(rgba, 4, 2, 2, 1)
  eq('halfblock merges same-style runs', lines[0].length, 1)
  eq('halfblock row keeps exact cell count', lines[0].reduce((w, s) => w + s.text.length, 0), 2)
}

{
  // 2x1 px: red + blue -> two palette entries, one band.
  const s = encodeSixel(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1)
  ok('sixel DCS header', s.startsWith('\x1bP0;1;1q'))
  ok('sixel ST terminator', s.endsWith('\x1b\\'))
  ok('sixel palette entries', s.includes('#0') && s.includes('#1'))
  ok('sixel data chars in 0x3F range', [...s].some((ch) => ch.codePointAt(0) >= 0x3F && ch.codePointAt(0) <= 0x7E))
}
{
  const s = encodeKittyTransmission(7, 'A'.repeat(5000))
  ok('kitty first chunk carries control params', s.startsWith('\x1b_Ga=T,f=100,q=2,i=7,m=1;'))
  ok('kitty last chunk is m=0 continuation', s.includes('\x1b_Gm=0;'))
  ok('kitty ends with ST', s.endsWith('\x1b\\'))
  const single = encodeKittyTransmission(7, 'QUJD')
  eq('kitty small payload is one chunk', single, '\x1b_Ga=T,f=100,q=2,i=7,m=0;QUJD\x1b\\')
}
eq('kitty placement at cells', kittyPlacement(7, 2, 3), '\x1b[4;3H\x1b_Ga=p,i=7,C=1,q=2\x1b\\')
eq('kitty delete all', kittyDeleteAll(), '\x1b_Ga=d,d=a,q=2\x1b\\')
eq('iTerm2 inline image', encodeITerm2('QUJD', 64, 32), '\x1b]1337;File=inline=1;size=4;width=64px;height=32px:name=x.png:QUJD\x07')

{
  const cache = new PayloadCache(2)
  cache.set('a', 1); cache.set('b', 2)
  eq('payload cache hit', cache.get('a'), 1)
  cache.set('c', 3) // evicts b (least recently used; a was refreshed)
  eq('payload cache evicts LRU', cache.get('b'), undefined)
  eq('payload cache keeps refreshed entry', cache.get('a'), 1)
}

{
  // Integration: real decode path with sharp (lazy-imported inside renderImage).
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
  const r = await renderImage({ bytes: png }, { protocol: 'halfblock', maxCellsW: 4, maxCellsH: 4, cellW: 8, cellH: 16 })
  eq('renderImage halfblock protocol', r.protocol, 'halfblock')
  eq('renderImage cells', { w: r.cellsW, h: r.cellsH }, { w: 1, h: 1 })
  ok('renderImage segLines rows', r.segLines.length === r.cellsH && r.segLines.every((row) => row.reduce((w, s) => w + s.text.length, 0) === r.cellsW))
  ok('renderImage hash present', typeof r.hash === 'string' && r.hash.length === 16)
  const kitty = await renderImage({ bytes: png }, { protocol: 'kitty', maxCellsW: 4, maxCellsH: 4, cellW: 8, cellH: 16 })
  ok('renderImage kitty payload b64', kitty.payload.kind === 'kitty' && kitty.payload.b64.length > 0)
  const iterm2 = await renderImage({ bytes: png }, { protocol: 'iterm2', maxCellsW: 4, maxCellsH: 4, cellW: 8, cellH: 16 })
  ok('renderImage iterm2 payload', iterm2.payload.kind === 'iterm2' && iterm2.payload.b64.length > 0)
  const sixel = await renderImage({ bytes: png }, { protocol: 'sixel', maxCellsW: 4, maxCellsH: 4, cellW: 8, cellH: 16 })
  ok('renderImage sixel payload', sixel.payload.kind === 'sixel' && sixel.payload.s.endsWith('\x1b\\'))
  const bad = await renderImage({ bytes: Buffer.from('not an image') }, { protocol: 'halfblock', maxCellsW: 4, maxCellsH: 4 })
  eq('renderImage bad input degrades to error', bad.protocol, 'error')
}

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')

// ---- image slab emission in paint (term.js) ----

import { Screen, Terminal, safeLink } from '../lib/term.js'

test_screen: {
  const s = new Screen(10, 6)
  s.setImageRow(2, { key: 'abc', x: 1, cellsW: 4, cellsH: 3, top: true })
  eq('setImageRow records the top annotation', s.images, [{ key: 'abc', x: 1, cellsW: 4, cellsH: 3, top: true, y: 2 }])
}

function fakeTerminal() {
  const t = new Terminal({ output: { write() {}, columns: 80, rows: 24 } })
  let out = ''
  t.output = { write(s) { out += s }, on() {}, off() {}, columns: 80, rows: 24 }
  t.getOut = () => out
  t.resetOut = () => { out = '' }
  return t
}

{
  const t = fakeTerminal()
  t.caps = { kitty: true, iterm2: false, sixel: false, cellW: 8, cellH: 16 }
  t._imagePayloads.set('abc', { kind: 'kitty', b64: 'QUJD', bytes: 3 })
  const s = new Screen(80, 24)
  s.setImageRow(3, { key: 'abc', x: 2, cellsW: 10, cellsH: 5, top: true })
  t.paint(s)
  ok('kitty first paint transmits', t.getOut().includes('a=T,f=100,q=2,i=1'))
  ok('kitty first paint places', t.getOut().includes(kittyPlacement(1, 2, 3)))
  t.resetOut()
  s.setImageRow(5, { key: 'abc', x: 2, cellsW: 10, cellsH: 5, top: true })
  t.paint(s)
  ok('kitty move re-places without retransmit', t.getOut().includes(kittyPlacement(1, 2, 5)) && !t.getOut().includes('a=T,'))
  t.resetOut()
  const s2 = new Screen(80, 24)
  t.paint(s2)
  ok('kitty deletes when the image leaves the screen', t.getOut().includes(kittyDelete(1)))
}

{
  const t = fakeTerminal()
  t.caps = { kitty: false, iterm2: false, sixel: true, cellW: 8, cellH: 16 }
  t._imagePayloads.set('six', { kind: 'sixel', s: 'SIXELPAYLOAD' })
  const s = new Screen(80, 24)
  s.setImageRow(2, { key: 'six', x: 0, cellsW: 20, cellsH: 4, top: true })
  t.paint(s)
  ok('sixel payload emitted at position', t.getOut().includes('\x1b[3;1HSIXELPAYLOAD'))
  t.resetOut()
  s.setImageRow(6, { key: 'six', x: 0, cellsW: 20, cellsH: 4, top: true })
  t.paint(s)
  ok('sixel re-emits when the image moves', t.getOut().includes('\x1b[7;1HSIXELPAYLOAD'))
}

{
  const t = fakeTerminal()
  t.caps = { kitty: true, iterm2: false, sixel: false, cellW: 8, cellH: 16 }
  t.started = true
  t.stop()
  ok('stop deletes all kitty images', t.getOut().includes(kittyDeleteAll()))
}

eq('safeLink rejects non-http schemes', safeLink('javascript:alert(1)'), null)
eq('safeLink rejects control characters', safeLink('https://x.example/\u0007'), null)
eq('safeLink percent-encodes parens', safeLink('https://x.example/a(b)'), 'https://x.example/a%28b%29')
eq('safeLink keeps plain urls', safeLink('https://x.example/a'), 'https://x.example/a')

{
  // OSC 8 hyperlinks: emission wraps exactly the linked run inside one row
  // rewrite (SGR sequences may sit between the OSC 8 wrapper and the text).
  const t = fakeTerminal()
  const s = new Screen(40, 2)
  s.text(0, 0, 'xy', null)
  const style = { fg: '6c9cff', bg: null, bold: false, dim: false, italic: false, underline: true, link: 'https://x.example' }
  s.text(2, 0, 'ab', style)
  t.paint(s)
  const out = t.getOut()
  const open = out.indexOf('\x1b]8;;https://x.example\x07')
  const close = out.indexOf('\x1b]8;;\x07')
  ok('paint opens OSC 8 after the plain run', open > 0 && open < out.indexOf('ab'))
  ok('paint closes OSC 8 after the linked run', close > open)
}

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')

// ---- transcript image integration (util.js + ui.js) ----

import { contentImages } from '../lib/util.js'
import { App } from '../lib/ui.js'

eq('contentImages extracts usable refs', contentImages([
  { type: 'text', text: '看这张图' },
  { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
]), [{ kind: 'ref', key: 'ref:sha256:abc', ref: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }, mediaType: 'image/png' }])
eq('contentImages ignores text and partial refs', contentImages([
  { type: 'text', text: 'x' },
  { type: 'image', attachment: { attachmentId: 'sha256:no-media-type' } },
]).length, 0)

{
  const app = new App({ cols: 80, rows: 24, on() {} })
  const requests = []
  app.onImageRequest = (src) => requests.push(src)
  app.addUser('看图', { images: [{ kind: 'bytes', key: 'k1', bytes: Buffer.alloc(1) }] })
  const block = app.blocks[0]
  const lines = app._blockLines(block, 76)
  ok('loading placeholder line while rendering', lines.some((l) => (l.segs ?? []).some((s) => s.text.includes('rendering image'))))
  eq('onImageRequest fired once per key', requests.map((r) => r.key), ['k1'])
  app.setImageResult('k1', { state: 'done', protocol: 'halfblock', cellsW: 2, cellsH: 1, segLines: [[{ text: '▀', style: { fg: 'ffffff', bg: '000000' } }]] })
  const lines2 = app._blockLines(block, 76)
  ok('halfblock lines appear after the result lands', lines2.some((l) => (l.segs ?? []).some((s) => s.text === '▀')))
}
{
  const app = new App({ cols: 80, rows: 24, on() {} })
  app.graphicsProtocol = 'kitty'
  app.addUser('图', { images: [{ kind: 'ref', key: 'ref:x', ref: {} }] })
  app.setImageResult('ref:x', { state: 'done', protocol: 'kitty', cellsW: 10, cellsH: 4 })
  const lines = app._blockLines(app.blocks[0], 76)
  const imageLines = lines.filter((l) => l.image)
  eq('protocol render reserves cellsH rows', imageLines.length, 4)
  eq('first annotation row is the top', imageLines[0].image.top, true)
  eq('annotation carries placement', { x: imageLines[0].image.x, w: imageLines[0].image.cellsW, h: imageLines[0].image.cellsH }, { x: 2, w: 10, h: 4 })
}
{
  const app = new App({ cols: 80, rows: 24, on() {} })
  app.addUser('先发的文本')
  ok('attachImagesToLastUser works on a bare user block', app.attachImagesToLastUser([{ kind: 'ref', key: 'ref:y', ref: {} }]))
  ok('second attach refused (block already has images)', !app.attachImagesToLastUser([{ kind: 'ref', key: 'ref:z', ref: {} }]))
  ok('attached images render', app._blockLines(app.blocks[0], 76).some((l) => (l.segs ?? []).some((s) => s.text.includes('rendering image'))))
}
{
  const app = new App({ cols: 80, rows: 24, on() {} })
  app.addUser('bad image', { images: [{ kind: 'bytes', key: 'bad' }] })
  app.setImageResult('bad', { state: 'error', error: 'decode failed' })
  const lines = app._blockLines(app.blocks[0], 76)
  ok('error state renders a failed line', lines.some((l) => (l.segs ?? []).some((s) => s.text.includes('image render failed'))))
}

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')

// ---- markdown rewrite (markdown.js) ----

import { renderMarkdown } from '../lib/markdown.js'

const T = {
  text: 'f0f4ff', textMuted: '8a93a8', primary: '4d6bfe', codeBg: '1b2740',
  markdownCode: '7fd88f', markdownHeading: '7c9cff', markdownLinkText: '6c9cff',
  markdownListItem: '4d6bfe', markdownBlockQuote: '9fb0d8', markdownHorizontalRule: '46547a',
  markdownCodeBlock: 'f0f4ff', syntaxKeyword: 'c678dd', syntaxString: '98c379',
  syntaxNumber: 'd19a66', syntaxComment: '7f848e', syntaxFunction: '61afef',
  syntaxType: 'e5c07b', tableBorder: '3d4d73', background: '0a0e18', error: 'e06c75',
}
const mdText = (md) => md.map((l) => Array.isArray(l) ? l.map((s) => s.text).join('') : JSON.stringify(l))

{
  const md = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', T, 40)
  const text = mdText(md).join('\n')
  ok('table has vertical borders', text.includes('│'))
  ok('table has header and body cells', text.includes('a') && text.includes('2'))
  ok('table uses rounded corners', text.includes('╭') && text.includes('╰'))
  ok('table rows span the grid width', md.every((l) => l.reduce((w, s) => w + s.text.length, 0) <= 40))
}
{
  const text = mdText(renderMarkdown('- one\n  - one.a\n- two', T, 40))
  ok('nested list indents', text.some((t) => t.startsWith('  - ') && t.includes('one.a')), JSON.stringify(text))
  eq('nested list keeps depth-0 items', text.filter((t) => t.startsWith('- ')).length, 2)
}
{
  const text = mdText(renderMarkdown('- [x] done\n- [ ] todo', T, 40))
  ok('task list done glyph', text.some((t) => t.includes('☑') && t.includes('done')), JSON.stringify(text))
  ok('task list open glyph', text.some((t) => t.includes('□') && t.includes('todo')), JSON.stringify(text))
}
{
  const withHooks = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```', T, 40, { mermaid: true, image: true })
  ok('mermaid fence becomes a special line with hooks', withHooks.some((l) => l && l.mermaid === 'graph TD\nA-->B'), JSON.stringify(mdText(withHooks)))
  const noHooks = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```', T, 40)
  ok('mermaid fence falls back to a code block without hooks', mdText(noHooks).some((t) => t.includes('graph TD')), JSON.stringify(mdText(noHooks)))
}
{
  const withHooks = renderMarkdown('![logo](https://x/y.png)', T, 40, { mermaid: true, image: true })
  eq('image syntax becomes a special line with hooks', withHooks[0], { image: { url: 'https://x/y.png', alt: 'logo' } })
  const noHooks = renderMarkdown('![logo](https://x/y.png)', T, 40)
  ok('image syntax falls back to alt text without hooks', mdText(noHooks).some((t) => t.includes('logo')), JSON.stringify(mdText(noHooks)))
}
{
  const seg = renderMarkdown('[site](https://x.example)', T, 40)[0].find((s) => s.text === 'site')
  eq('link keeps the url on the segment style', seg?.style?.link, 'https://x.example')
}
{
  const flat = renderMarkdown('```js\nconst a = 1\n```', T, 40).flat().filter(Boolean)
  ok('js code gets keyword color', flat.some((s) => s.style?.fg === T.syntaxKeyword && s.text.includes('const')), JSON.stringify(flat.slice(0, 3)))
}
{
  const md = renderMarkdown('Hello **world**\n- one\n> quote\n# Head\npara two', T, 40)
  eq('compact block semantics match the legacy renderer', mdText(md), ['Hello world', '- one', '▍ quote', 'Head', 'para two'])
}
{
  const text = mdText(renderMarkdown('para one\n\npara two', T, 40))
  eq('explicit blank line stays a blank line', text, ['para one', '', 'para two'])
}
{
  const md = renderMarkdown('中文长段落测试，这一段包含很多宽字符用来验证换行逻辑是否保持列宽正确不越界', T, 20)
  ok('CJK wrapping stays within width', md.every((l) => l.reduce((w, s) => w + s.text.length, 0) <= 20))
}

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')

// ---- mermaid provider chain (mermaid.js) ----

import { createMermaidRenderer, mermaidCachePath } from '../lib/mermaid.js'

{
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer }
  }
  const r = createMermaidRenderer({ fetch: fakeFetch, mode: 'network', cacheDir: null })
  const a = await r('graph TD; A-->B', {})
  ok('network provider returns png bytes', a && Buffer.from(a.bytes).toString().startsWith('PNG'))
  await r('graph TD; A-->B', {})
  eq('second call hits the in-memory cache', calls.length, 1)
  ok('mermaid.ink url carries the encoded diagram', calls[0].startsWith('https://mermaid.ink/img/'))
  const b = await r('graph LR; C-->D', {})
  eq('a different diagram misses the cache', calls.length, 2)
}
{
  const r = createMermaidRenderer({ fetch: async () => { throw new Error('offline') }, mode: 'off' })
  eq('mode off renders nothing', await r('graph TD', {}), null)
}
{
  let fetches = 0
  const r = createMermaidRenderer({
    fetch: async () => { fetches++; return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) } },
    mode: 'network',
    cacheDir: null,
  })
  eq('network failure falls back to null', await r('graph TD', {}), null)
  eq('failure is not cached', (await r('graph TD', {}), fetches), 2)
}
eq('mermaidCachePath uses sha1 of the code', mermaidCachePath('abc'), mermaidCachePath('abc'))
ok('mermaidCachePath distinguishes sources', mermaidCachePath('a') !== mermaidCachePath('b'))

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')

// ---- bubble layout + mermaid consumption (ui.js) ----

test_bubbles: {
  const app = new App({ cols: 60, rows: 24, on() {} })
  app.setSession({ id: 's', title: 'Bubbles' })
  app.addUser('中文消息：这条消息里有宽字符，用来验证气泡内换行与边框列宽。')
  app.startAssistant()
  app.streamChunk({ type: 'text-delta', text: '回答包含 ```js 代码块与 **加粗**。' })
  const block = app.blocks[1]
  block.streaming = false
  block.rev++
  const COLS = 60, ROWS = 24
  const screen = app.render()
  ok('bubble rows stay within the frame', screen.cells.every((row) => row.length === COLS))
  const rows = screen.cells.map((r) => r.map((c) => c.ch).join(''))
  ok('user bubble top border', rows.some((r) => r.includes('╭─ you ·')))
  ok('assistant bubble top border', rows.some((r) => r.includes('╭─ dsh ·')))
  ok('bubble bottom border', rows.some((r) => r.trimEnd().endsWith('╯')))
  ok('bubble body carries the left border', rows.some((r) => r.includes('│ ' + '中文消息')))
}
test_mermaid: {
  const app = new App({ cols: 80, rows: 24, on() {} })
  const requests = []
  app.onMermaidRequest = (code, key) => requests.push({ code, key })
  app.startAssistant()
  app.streamChunk({ type: 'text-delta', text: '```mermaid\ngraph TD\nA-->B\n```' })
  const block = app.blocks[0]
  block.streaming = false
  block.rev++
  let lines = app._blockLines(block, 76)
  ok('mermaid fence requests a render', requests.length === 1 && requests[0].code.includes('graph TD'))
  ok('mermaid loading placeholder', lines.some((l) => (l.segs ?? []).some((s) => s.text.includes('rendering mermaid'))))
  // Fallback: the provider chain failed — the source renders highlighted.
  app.setMermaidResult(requests[0].key, { state: 'fallback' })
  lines = app._blockLines(block, 76)
  ok('mermaid fallback renders the source', lines.some((l) => (l.segs ?? []).some((s) => s.text.includes('graph TD'))))
  // Done: delegates to the image pipeline under the derived image key.
  const imageKey = requests[0].key.replace('mermaid:', 'mermaid-img:')
  app.setImageResult(imageKey, { state: 'done', protocol: 'halfblock', cellsW: 4, cellsH: 2, segLines: [[{ text: '▀', style: { fg: 'ffffff', bg: '000000' } }], [{ text: '▀', style: { fg: 'ffffff', bg: '000000' } }]] })
  app.setMermaidResult(requests[0].key, { state: 'done', imageKey })
  lines = app._blockLines(block, 76)
  ok('mermaid done renders the diagram rows', lines.filter((l) => (l.segs ?? []).some((s) => s.text === '▀')).length === 2)
}
test_markdown_image_data_url: {
  const app = new App({ cols: 80, rows: 24, on() {} })
  const requests = []
  app.onImageRequest = (src) => requests.push(src)
  app.startAssistant()
  app.streamChunk({ type: 'text-delta', text: '![logo](https://x/y.png)\n\n![ghost](ftp://bad/z.png)' })
  const block = app.blocks[0]
  block.streaming = false
  block.rev++
  const lines = app._blockLines(block, 76)
  eq('https image enters the pipeline', requests.map((r) => r.kind), ['url'])
  ok('unsupported scheme keeps alt text', lines.some((l) => (l.segs ?? []).some((s) => s.text.includes('ghost'))))
}

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')
