// mcp-sse-bridge tests: a real legacy SSE fixture server plus the bridge spawned
// as a child process, exercised exactly the way the host mcp-client mounts it
// (`node bin/mcp-sse-bridge.mjs` with MCP_SSE_URL / MCP_SSE_HEADERS in the env).
// Framework-free by design, like the rest of this suite.
//   node tests/mcp-sse-bridge.test.mjs
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { start } from "./fixtures/sse-server.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, "..", "bin", "mcp-sse-bridge.mjs")

let failed = 0
const ok = (cond, label) => {
  if (cond) console.log("ok   " + label)
  else { failed++; console.log("FAIL " + label) }
}
const eq = (actual, expected, label) => {
  const pass = actual === expected
  if (pass) console.log("ok   " + label)
  else {
    failed++
    console.log(`FAIL ${label}  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const children = []

// A clean env, so a parent MCP_SSE_* cannot leak into a case that asserts absence.
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.MCP_SSE_URL
  delete env.MCP_SSE_HEADERS
  delete env.MCP_SSE_TIMEOUT_MS
  return { ...env, ...extra }
}

function spawnBridge({ args = [], env = {}, timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [BRIDGE, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(env),
  })
  children.push(child)
  const lines = []
  const waiters = []
  let stderr = ""
  let buffer = ""
  let exited = false

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) break
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.trim() === "") continue
      const waiter = waiters.shift()
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line) }
      else lines.push(line)    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.stdin.on("error", () => { /* the bridge may exit before we write */ })

  const exit = new Promise((resolve) => {
    child.on("close", (code, signal) => { exited = true; resolve({ code, signal }) })
  })

  return {
    child,
    stderr: () => stderr,
    exit,
    exited: () => exited,
    next(timeout = timeoutMs) {
      if (lines.length > 0) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const waiter = { resolve }
        waiter.timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter)
          if (idx !== -1) waiters.splice(idx, 1)
          reject(new Error("timeout waiting for a stdout line"))
        }, timeout)
        waiters.push(waiter)
      })
    },
    send(message) { child.stdin.write(JSON.stringify(message) + "\n") },
    endInput() { child.stdin.end() },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      return exit
    },
  }
}

async function request(bridge, message) {
  bridge.send(message)
  return JSON.parse(await bridge.next())
}

// ---------------------------------------------------------------------------

// 1. argv surface: --help / missing url / bad header JSON.
{
  const help = spawnBridge({ args: ["--help"] })
  let helpOut = ""
  help.child.stdout.on("data", (chunk) => { helpOut += chunk })
  const helpExit = await help.exit
  eq(helpExit.code, 0, "--help exits 0")
  ok(helpOut.includes("MCP_SSE_URL"), "--help prints usage to stdout")
  await help.kill()

  const missing = spawnBridge({ args: [] })
  const missingExit = await missing.exit
  eq(missingExit.code, 2, "missing url exits 2")
  ok(missing.stderr().includes("MCP_SSE_URL"), "missing url explains itself on stderr")
  await missing.kill()

  const badJson = spawnBridge({ args: ["--url", "http://127.0.0.1:1/sse"], env: { MCP_SSE_HEADERS: "{not json" } })
  const badExit = await badJson.exit
  eq(badExit.code, 2, "invalid MCP_SSE_HEADERS exits 2")
  await badJson.kill()
}

// 2. initialize + tools/list round-trips over argv config, in order.
{
  const fixture = await start()
  const bridge = spawnBridge({ args: ["--url", fixture.url, "--timeout-ms", "5000"] })
  try {
    const init = await request(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })
    eq(init.id, 1, "initialize round-trips with the same id")
    eq(init.jsonrpc, "2.0", "initialize reply is JSON-RPC 2.0")

    const list = await request(bridge, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    eq(list.id, 2, "tools/list reply carries the tools/list id (order preserved)")
    eq(list.result?.tools?.[0]?.name, "echo", "tools/list returns the fixture echo tool")

    ok(fixture.state.posts.length >= 2, "fixture received both POSTs at the endpoint")
    eq(fixture.state.posts[0]?.url, "/messages?session=1", "the relative SSE endpoint data was resolved into the POST url")
  } finally {
    await bridge.kill()
    await fixture.stop()
  }
}

// 3. env-only config: the mount path the plugin actually uses.
{
  const fixture = await start()
  const bridge = spawnBridge({
    env: {
      MCP_SSE_URL: fixture.url,
      MCP_SSE_HEADERS: JSON.stringify({ "X-Test": "sse-bridge", Authorization: "Bearer fixture" }),
      MCP_SSE_TIMEOUT_MS: "5000",
    },
  })
  try {
    const init = await request(bridge, { jsonrpc: "2.0", id: 7, method: "initialize", params: {} })
    eq(init.id, 7, "env-only MCP_SSE_URL mounts and round-trips initialize")
    const list = await request(bridge, { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })
    eq(list.result?.tools?.[0]?.name, "echo", "env-only config also reaches tools/list")

    const seen = fixture.state.posts.at(-1)?.headers ?? {}
    eq(seen["x-test"], "sse-bridge", "MCP_SSE_HEADERS reached the POST")
    eq(seen.authorization, "Bearer fixture", "MCP_SSE_HEADERS reached the POST (second header)")
  } finally {
    await bridge.kill()
    await fixture.stop()
  }
}

// 4. stdin EOF -> exit 0.
{
  const fixture = await start()
  const bridge = spawnBridge({ args: ["--url", fixture.url, "--timeout-ms", "5000"] })
  try {
    await request(bridge, { jsonrpc: "2.0", id: 11, method: "initialize", params: {} })
    bridge.endInput()
    const { code, signal } = await bridge.exit
    eq(code, 0, "stdin EOF exits 0")
    if (code !== 0) console.log(`      exit=${code} signal=${signal} stderr=${JSON.stringify(bridge.stderr())}`)
  } finally {
    await bridge.kill()
    await fixture.stop()
  }
}

// 5. dead port -> non-zero exit (the host then reconnects).
{
  const bridge = spawnBridge({ args: ["--url", "http://127.0.0.1:1/sse", "--timeout-ms", "3000"] })
  try {
    const { code } = await bridge.exit
    ok(code !== 0, "dead port exits non-zero")
    ok(bridge.stderr().includes("127.0.0.1:1"), "dead port reports the failure on stderr")
  } finally {
    await bridge.kill()
  }
}

// 6. SSE stream closed by the server -> non-zero exit, queued stdin still posted.
{
  const fixture = await start()
  const bridge = spawnBridge({ args: ["--url", fixture.url, "--timeout-ms", "5000"] })
  try {
    await request(bridge, { jsonrpc: "2.0", id: 21, method: "initialize", params: {} })
    await fixture.stop()
    const { code } = await bridge.exit
    ok(code !== 0, "SSE stream close after connect exits non-zero")
    ok(bridge.stderr().includes("mcp-sse-bridge:"), "stream close is reported on stderr")
  } finally {
    await bridge.kill()
    await fixture.stop()
  }
}

// ---------------------------------------------------------------------------

ok(children.every((child) => child.exitCode !== null || child.signalCode !== null), "every bridge child was reaped")
console.log(failed > 0 ? `\n${failed} check(s) failed` : "\nall checks passed")
process.exitCode = failed > 0 ? 1 : 0
