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

console.log('')
if (failed > 0) { console.log(failed + ' test(s) failed'); process.exit(1) }
console.log('all graphics tests passed')
