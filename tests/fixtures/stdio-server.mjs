// A minimal MCP server over stdio: newline-delimited JSON-RPC on stdin/stdout,
// exactly the framing the harness `StdioClientTransport` uses.
//
// `TUI_MCP_FIXTURE_LOG` (optional) appends every received request method to that
// file, which is how the live test proves real protocol traffic happened rather
// than just a plugin activation.
import { appendFileSync } from 'node:fs'
import { handleRpc } from './mcp-rpc.mjs'

const logPath = process.env.TUI_MCP_FIXTURE_LOG ?? ''
const log = (line) => {
  if (logPath === '') return
  try { appendFileSync(logPath, line + '\n', 'utf8') } catch { /* the log is a test aid */ }
}

const send = (message) => { process.stdout.write(JSON.stringify(message) + '\n') }

let buffer = ''
const drain = () => {
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    log(String(message?.method ?? '?'))
    const response = handleRpc(message)
    if (response !== null) send(response)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { buffer += chunk; drain() })
// The harness probes a stdio server before serving one: the probe ends when its
// stdin closes, and so must this process.
process.stdin.on('end', () => process.exit(0))
