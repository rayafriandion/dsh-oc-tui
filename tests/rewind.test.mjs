import { contentLabel, listRewindPoints, mutationPathsAfter, parseRewindArgs, resolvePoint, rewindCut } from '../lib/rewind.js'

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) console.log('ok   ' + name)
  else { console.log('FAIL ' + name + '  got ' + a + '  want ' + e); failed++ }
}
const ok = (name, cond) => cond ? console.log('ok   ' + name) : (console.log('FAIL ' + name), failed++)

function ev(seq, type, data = {}) {
  return { seq, time: seq * 1000, type, data }
}
function user(seq, text) {
  return ev(seq, 'user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

eq('contentLabel joins text', contentLabel([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a b')

const points = listRewindPoints([
  user(0, 'first'),
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', {
    source: { kind: 'compaction' },
    content: [{ type: 'text', text: 'hidden' }],
  }),
  user(3, 'second prompt that is quite long and should be clipped in the label so the picker stays readable'),
])
eq('listRewindPoints length', points.length, 2)
eq('listRewindPoints first', points[0].label, 'first')
ok('listRewindPoints clips', points[1].label.endsWith('…'))

const events = [
  ev(0, 'turn/start', { turn: 1 }),
  user(1, 'one'),
  ev(2, 'assistant/message', {}),
  ev(3, 'turn/end', { turn: 1 }),
  ev(4, 'session/title', { title: 't' }),
  ev(5, 'turn/start', { turn: 2 }),
  user(6, 'two'),
  ev(7, 'tool/call', { name: 'write', arguments: '{"file_path":"src/a.ts"}' }),
  ev(8, 'turn/end', { turn: 2 }),
  ev(9, 'turn/start', { turn: 3 }),
  user(10, 'three'),
]
eq('rewindCut drops selected turn', rewindCut(events, 6), 5)
eq('rewindCut first turn', rewindCut(events, 1), 0)
eq('rewindCut open turn', rewindCut(events, 10), 9)

eq('mutationPathsAfter', mutationPathsAfter([
  ev(0, 'tool/call', { name: 'read', arguments: '{"file_path":"skip.ts"}' }),
  ev(1, 'tool/call', { name: 'write', arguments: '{"file_path":"src/a.ts"}' }),
  ev(2, 'tool/call', { name: 'edit', arguments: '{"file_path":"src/a.ts"}' }),
  ev(3, 'tool/call', { name: 'edit', arguments: '{"file_path":"src/b.ts"}' }),
], 1), ['src/a.ts', 'src/b.ts'])
eq('mutationPathsAfter object args', mutationPathsAfter([
  ev(1, 'tool/call', { name: 'write', arguments: { file_path: 'src/c.ts' } }),
], 0), ['src/c.ts'])

eq('parseRewindArgs empty', parseRewindArgs(''), { selector: undefined, mode: 'both' })
eq('parseRewindArgs last code', parseRewindArgs('last code'), { selector: 'last', mode: 'code' })
eq('parseRewindArgs files', parseRewindArgs('files'), { selector: undefined, mode: 'code' })

const resolved = listRewindPoints([user(0, 'a'), user(4, 'b')])
eq('resolvePoint last', resolvePoint(resolved, 'last').seq, 4)
eq('resolvePoint 1', resolvePoint(resolved, '1').seq, 0)

try { resolvePoint(resolved, '9'); failed++ } catch { console.log('ok   resolvePoint miss') }

if (failed > 0) process.exit(1)
console.log('rewind tests passed')
