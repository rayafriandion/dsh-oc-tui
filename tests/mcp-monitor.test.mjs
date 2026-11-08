// The MCP connection notice and the output isolation that keeps a failed MCP
// server off the screen.
//   node tests/mcp-monitor.test.mjs
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createMcpMonitor, createMcpNotifier, filterMcpStartupAudit, filterMcpStderrWrites, isolateMcpOutput } from '../lib/mcp-monitor.js'
import { App } from '../lib/ui.js'

// ---- the state the host reports -------------------------------------------

let exporter, onStatus
const ctx = {
  logger: { exporter(value) { exporter = value } },
  on(name, fn) { assert.equal(name, 'internal/status'); onStatus = fn },
  get() { return { entries: () => [] } },
}
const monitor = createMcpMonitor(ctx)
const events = []
monitor.attach(event => events.push(event))
const fiber = (name, state) => {
  const result = { state, entry: { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: name } } } }
  result.entry.fiber = result
  return result
}
const failedFiber = fiber('failed', 1)
const goodFiber = fiber('good', 1)
onStatus({ state: 2, entry: goodFiber.entry })
assert.deepEqual(events, [], 'child effect activation is not an MCP connection')
onStatus(failedFiber)
exporter.export({ args: ['mcp-client(failed): connection attempt failed: Error: offline'] })
exporter.export({ args: ['mcp-client(failed): connection failed; retrying in 500ms'] })
failedFiber.state = 2
onStatus(failedFiber)
onStatus(goodFiber)
goodFiber.state = 2
onStatus(goodFiber)
exporter.export({ args: ['mcp-client(failed): reconnected and re-synced tools (attempt 1/10)'] })
exporter.export({ args: ['mcp-client(failed): reconnected and re-synced tools (attempt 1/10)'] })
failedFiber.state = 1
onStatus(failedFiber)
failedFiber.state = 2
onStatus(failedFiber)
assert.deepEqual(events, [
  { name: 'failed', status: 'failed' },
  { name: 'good', status: 'connected' },
  { name: 'failed', status: 'connected' },
  { name: 'failed', status: 'connected' },
])
monitor.detach()
exporter.export({ args: ['mcp-client(good): connection lost; reconnecting'] })
const replay = []
monitor.attach(event => replay.push(event))
assert.deepEqual(replay, [{ name: 'good', status: 'failed' }])

// A server that was already mounted before the TUI watched it is probed, not
// assumed: an unreachable server must not be reported as connected.
let probeStatus
const preexisting = fiber('offline', 2)
const probeCtx = {
  logger: { exporter() {} },
  on() {},
  get(name) {
    if (name === 'loader') return { entries: () => [{ fiber: preexisting }] }
    if (name === 'mcpResources') return { request(_server, _request, exec) {
      assert.equal(exec.signal.aborted, true)
      throw new Error('mcp-client(offline): server is disconnected')
    } }
  },
}
const probeMonitor = createMcpMonitor(probeCtx)
probeMonitor.attach(event => { probeStatus = event })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(probeStatus, { name: 'offline', status: 'failed' })

// ---- one notice per state ------------------------------------------------

const notifier = createMcpNotifier()
const notices = []
notifier.subscribe((name, status) => notices.push([name, status]))
notifier.report('unityMCP', 'failed')
notifier.report('unityMCP', 'failed')
notifier.report('blender', 'connected')
notifier.report('unityMCP', 'connected')
notifier.report('unityMCP', 'connected')
notifier.report('unityMCP', 'failed')
assert.deepEqual(notices, [
  ['unityMCP', 'failed'],
  ['blender', 'connected'],
  ['unityMCP', 'connected'],
  ['unityMCP', 'failed'],
])

// ---- the notice in the corner --------------------------------------------

const fakeTerm = { cols: 80, rows: 24, started: false, paint() {}, isTTY: () => true }
const app = new App(fakeTerm)
app.showMcpNotice('good', 'connected')
app.showMcpNotice('bad', 'failed')
const rows = app.render().cells.map(row => row.map(cell => cell.ch).join(''))
assert.match(rows[0], /MCP good: connected/)
assert.ok(rows[0].indexOf('MCP good') > 40, 'the notice sits in the top-right corner')
assert.doesNotMatch(rows.at(-1), /MCP good/)
app._nextMcpNotice()
assert.match(app.render().cells[0].map(cell => cell.ch).join(''), /MCP bad: connection failed/)
app.clearMcpNotices()
assert.equal(app.mcpNotice, null)

// ---- the output isolation ------------------------------------------------

const audit = 'dsh: warning: 2 entries did not activate\nmcp-offline (@deepseek-ai/dsh-mcp-client): connect failed\n    at mcp-stack\nother (example-plugin): other failure\n    at other-stack\n'
assert.equal(filterMcpStartupAudit(audit), 'dsh: warning: 1 entry did not activate\nother (example-plugin): other failure\n    at other-stack\n')
assert.equal(filterMcpStartupAudit('dsh: warning: 1 entry did not activate\nmcp (@deepseek-ai/dsh-mcp-client): failed\n    at stack\n'), '')
assert.equal(filterMcpStartupAudit('unrelated @deepseek-ai/dsh-mcp-client warning\n'), 'unrelated @deepseek-ai/dsh-mcp-client warning\n')

const originalWrite = process.stderr.write
const written = []
process.stderr.write = (chunk, encoding, callback) => {
  written.push(String(chunk))
  if (typeof encoding === 'function') encoding()
  else if (typeof callback === 'function') callback()
  return true
}
// The filter wraps whatever writer is current, so it is installed over the
// recorder: what the recorder sees is what would have reached the terminal.
const restoreFilter = filterMcpStderrWrites()
process.stderr.write(audit)
assert.equal(written.length, 1)
assert.equal(written[0], 'dsh: warning: 1 entry did not activate\nother (example-plugin): other failure\n    at other-stack\n')
restoreFilter()
process.stderr.write = originalWrite
assert.equal(process.stderr.write, originalWrite)

const originalSpawn = childProcess.spawn
const originalDebug = console.debug
const restoreOutput = isolateMcpOutput()
class StdioClientTransport {
  start() {
    return childProcess.spawn(process.execPath, ['-e', 'process.stderr.write("child diagnostic")'], { stdio: ['pipe', 'pipe', 'inherit'] })
  }
}
const child = new StdioClientTransport().start()
assert.ok(child.stderr, 'the MCP child stderr is piped')
await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
const other = childProcess.spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'ignore'] })
assert.equal(other.stderr, null, 'an unrelated child stdio is left alone')
await new Promise((resolve, reject) => { other.once('error', reject); other.once('close', resolve) })
restoreOutput()
assert.equal(childProcess.spawn, originalSpawn)
assert.equal(console.debug, originalDebug)

console.log('ok   the MCP monitor, the notice and the output isolation behave')
