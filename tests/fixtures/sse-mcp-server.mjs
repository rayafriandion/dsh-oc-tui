// A minimal MCP server speaking the legacy HTTP+SSE transport (protocol
// revision 2024-11-05): `GET /sse` opens the event stream and announces the POST
// endpoint, requests arrive as POSTs, responses leave as `event: message`
// frames. This is what `bin/mcp-sse-bridge.mjs` is expected to speak, so the
// live test can prove the `sse` type connects through the real host client.
import { createServer } from 'node:http'
import { handleRpc } from './mcp-rpc.mjs'

export function createSseMcpServer() {
  const streams = new Set()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/sse') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      streams.add(response)
      response.write('event: endpoint\ndata: /messages?session=fixture\n\n')
      request.on('close', () => streams.delete(response))
      return
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        response.writeHead(202, { 'Content-Type': 'application/json' })
        response.end('{}')
        let message
        try { message = JSON.parse(body) } catch { return }
        const reply = handleRpc(message)
        if (reply === null) return
        const frame = 'event: message\ndata: ' + JSON.stringify(reply) + '\n\n'
        for (const stream of streams) stream.write(frame)
      })
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      return server.address().port
    },
    async stop() {
      // The SSE responses are keep-alive: destroying them lets close() settle
      // instead of waiting for the client to hang up.
      for (const stream of streams) stream.destroy()
      streams.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// Direct execution: print the port so a shell or test harness can use it.
if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const fixture = createSseMcpServer()
  const port = await fixture.start()
  console.log('PORT ' + port)
}
