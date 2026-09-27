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
