// Fixture: a minimal legacy MCP HTTP+SSE server (MCP 2024-11-05 transport).
//
//   GET  /sse       text/event-stream; immediately sends `event: endpoint` with
//                   the POST url, then keeps the socket open and pushes every
//                   reply as `event: message`.
//   POST /messages  202; parses the JSON-RPC body and replies on the stream.
//
// Used by tests/mcp-sse-bridge.test.mjs, which imports `start()` and stops the
// server through `stop()`. Run directly it prints `PORT <n>` once listening:
//   node tests/fixtures/sse-server.mjs
import http from "node:http"
import { pathToFileURL } from "node:url"

const ECHO_TOOL = { name: "echo", description: "echo", inputSchema: { type: "object" } }

/**
 * @returns {Promise<{port:number,url:string,state:{posts:{headers:object,body:string}[]},stop:()=>Promise<void>}>}
 */
export function start({ host = "127.0.0.1", port = 0 } = {}) {
  const clients = new Set()
  const sockets = new Set()
  const state = { posts: [] }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? host}`)

    if (req.method === "GET" && url.pathname === "/sse") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write("event: endpoint\ndata: /messages?session=1\n\n")
      clients.add(res)
      req.on("close", () => clients.delete(res))
      return
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      let body = ""
      req.setEncoding("utf8")
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        state.posts.push({ url: req.url, headers: req.headers, body })
        res.writeHead(202, { "content-type": "application/json" })
        res.end("{\"ok\":true}")

        let message
        try { message = JSON.parse(body) } catch { return }
        const result = message.method === "tools/list" ? { tools: [ECHO_TOOL] } : { ok: true }
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
        for (const client of clients) client.write(`event: message\ndata: ${payload}\n\n`)
      })
      return
    }

    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found")
  })

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })

  const stop = () =>
    new Promise((resolve) => {
      for (const client of clients) {
        try { client.end() } catch { /* already gone */ }
        try { client.destroy() } catch { /* already gone */ }
      }
      clients.clear()
      for (const socket of sockets) {
        try { socket.destroy() } catch { /* already gone */ }
      }
      sockets.clear()
      server.close(() => resolve())
    })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({ port: address.port, url: `http://${host}:${address.port}/sse`, state, stop })
    })
  })
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const fixture = await start()
  process.stdout.write(`PORT ${fixture.port}\n`)
  const shutdown = () => { fixture.stop().finally(() => process.exit(0)) }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
