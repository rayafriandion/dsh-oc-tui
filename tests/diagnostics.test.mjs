// Host diagnostics capture: while the alternate screen is up, a plugin's
// console output must not reach the terminal, and the TUI's own paint channel
// must keep working.
//
// Everything printed inside the capture window would itself be captured, so the
// results are collected and reported only after restore().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureDiagnostics } from '../lib/diagnostics.js'
import { Terminal } from '../lib/term.js'

const results = []
const ok = (name, cond, extra = '') => results.push((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))

const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-diag-')), 'diag.log')

// A terminal whose output is the real stdout, exactly as in production: the
// paint channel is bound in the constructor, before the streams are diverted.
const painted = []
const output = { columns: 80, rows: 24, isTTY: true, write(s) { painted.push(s); return true }, on() {}, off() {} }
const term = new Terminal({ input: { isTTY: false, on() {}, off() {}, setRawMode() {}, resume() {}, pause() {} }, output })

let firstNotifications = 0
const capture = captureDiagnostics({ logPath, onFirst: () => { firstNotifications++ } })

// The host logging the way the LLM adapters do.
console.warn('[llm-deepseek-api-key] model refused by the listing')
console.error('[llm-deepseek-api-key] could not reach the endpoint')
process.stdout.write('a stray stdout line\n')

// The TUI keeps painting through the channel it bound earlier.
term.write('\x1b[2J')

ok('host writes were counted', capture.count === 3, 'count=' + capture.count)
ok('nothing leaked onto the paint channel', painted.length === 1 && painted[0] === '\x1b[2J', JSON.stringify(painted))
ok('the first write notified once', firstNotifications === 1)
// The log is written in batches (a synchronous append per host write stalled the
// frame loop while MCP servers were streaming their startup output), so the file
// is read after an explicit flush rather than the moment the write returns.
capture.flush()
ok('the log file has the warnings', fs.readFileSync(logPath, 'utf8').includes('model refused by the listing'))
ok('the log file records the stream', /\[stderr\]/.test(fs.readFileSync(logPath, 'utf8')))
ok('stdout is recorded as stdout', /\[stdout\] a stray stdout line/.test(fs.readFileSync(logPath, 'utf8')))

// A writer waiting on its callback must not hang.
let callbackFired = false
process.stderr.write('with callback\n', () => { callbackFired = true })
ok('the write callback still fires', callbackFired)

const beforeText = capture.text()
ok('the captured text is kept for replay', beforeText.includes('could not reach the endpoint'))

const restored = capture.restore()
ok('restore is idempotent', restored === undefined && (capture.restore() === undefined))

// After restore the streams behave normally again.
const after = []
const originalWrite = process.stderr.write
process.stderr.write = function (chunk, ...rest) { after.push(String(chunk)); return originalWrite.call(this, chunk, ...rest) }
console.error('after restore')
process.stderr.write = originalWrite
ok('restored writes reach the stream again', after.some((line) => line.includes('after restore')))
ok('a second capture after restore starts clean', (() => {
  const again = captureDiagnostics({})
  const clean = again.count === 0
  again.restore()
  return clean
})())

// The replay goes to the real stderr; swallow it here so the test output stays
// readable, but assert that it happened.
let replayed = ''
const realStderr = process.stderr.write
process.stderr.write = (chunk) => { replayed += String(chunk); return true }
const second = captureDiagnostics({})
console.warn('replayed warning')
second.restore()
process.stderr.write = realStderr
ok('restore replays the captured text to stderr', replayed.includes('replayed warning'))

// The log is a debugging aid with no rotation of its own; a plugin warning on
// every frame would otherwise grow it for as long as the session runs.
{
  const rotatePath = path.join(path.dirname(logPath), 'rotate.log')
  fs.writeFileSync(rotatePath, 'x'.repeat(1024 * 1024 + 64))
  const rotating = captureDiagnostics({ logPath: rotatePath })
  console.warn('the line after rotation')
  rotating.restore()
  ok('an oversized log is truncated', fs.statSync(rotatePath).size < 1024 * 1024)
  ok('the newest line survives the rotation', fs.readFileSync(rotatePath, 'utf8').includes('the line after rotation'))
}

// The replayed lines above are the point of the test, not noise: restore()
// puts the diverted text back on stderr. The report follows.
for (const line of results) console.log(line)
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(failed === 0 ? '\nall diagnostics tests passed' : `\n${failed} diagnostics assertion(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
