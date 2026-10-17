// The live mount proof: the REAL `@deepseek-ai/dsh-mcp-client` and the REAL
// `@deepseek-ai/dsh-tools` registry against local MCP servers, connected through
// the plugin's own `McpManager` — once over stdio and once over legacy SSE
// (which the plugin reaches through `bin/mcp-sse-bridge.mjs`, because the host
// client has no SSE transport of its own).
//
// The host packages are loaded from the dsh installation the `dsh` on PATH
// resolves to, not by bare specifier: a bare specifier inside the profile
// resolves through `profiles/node_modules`, which on a machine that ever ran the
// PTY harness can be a stale junction to an older harness tree. dsh itself
// resolves its rows from its own install, and that is what this test mirrors.
// When no dsh install is found the run is skipped with a clear line, which keeps
// `npm test` honest in a bare checkout.
//
//   node tests/mcp-live.test.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, 'fixtures', 'stdio-server.mjs')

const report = []
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) report.push('ok   ' + name)
  else { failed++; report.push('FAIL ' + name + (extra ? '  ' + extra : '')) }
}
const skip = (name, why) => report.push('skip ' + name + ' (' + why + ')')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(120)
  }
  return false
}

// ---- the host packages, or a clean skip ---------------------------------
function hostPackagesRoot() {
  try {
    const lookup = process.platform === 'win32' ? ['where', ['dsh']] : ['which', ['dsh']]
    const output = execFileSync(lookup[0], lookup[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const shim = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    if (shim === undefined) return null
    const manifest = createRequire(shim).resolve('@deepseek-ai/dsh/package.json')
    return { root: join(dirname(manifest), 'node_modules'), version: JSON.parse(readFileSync(manifest, 'utf8')).version }
  } catch {
    return null
  }
}

let host = null
const install = hostPackagesRoot()
if (install !== null) {
  const load = (name) => import(pathToFileURL(join(install.root, '@deepseek-ai', name, 'lib', 'index.js')).href)
  try {
    const [cordis, prompt, tools, client, scope, mcp] = await Promise.all([
      load('cordis'),
      load('dsh-system-prompt'),
      load('dsh-tools'),
      load('dsh-mcp-client'),
      load('dsh-scope'),
      import('../lib/mcp.js'),
    ])
    host = {
      Context: cordis.Context,
      SystemPrompt: prompt.default,
      ToolRuntime: tools.default,
      client,
      scopeOf: scope.scopeOf,
      mcp,
    }
  } catch (error) {
    skip('live MCP mount', 'host packages unavailable: ' + String(error?.message ?? error))
  }
}

if (host === null) {
  console.log(report.join('\n'))
  console.log('')
  console.log('mcp-live tests skipped (no dsh installation resolved)')
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-mcp-live-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsh-oc-tui-mcp-live-cwd-'))
process.env.DSH_HOME = home
const logPath = join(home, 'fixture-requests.log')
const configPath = join(home, 'mcp.json')
writeFileSync(configPath, JSON.stringify({
  version: 1,
  servers: {
    fixture: {
      type: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      env: { TUI_MCP_FIXTURE_LOG: logPath },
      timeoutMs: 30000,
      enabled: true,
    },
  },
}, null, 2) + '\n', 'utf8')

const cleanup = []
process.on('exit', () => {
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* best effort */ }
  }
  for (const path of [home, cwd]) {
    try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

// ---- the real service stack the bridge registers into --------------------
const ctx = new host.Context()
new host.SystemPrompt(ctx, {})
new host.ToolRuntime(ctx)
const tools = ctx.get('tools')
ok('the real tool registry is mounted', Boolean(tools) && typeof tools.schemas === 'function')
ok('a real dsh installation was resolved', install !== null && typeof install.version === 'string',
  'dsh ' + install?.version)

const { McpManager, collectServers } = host.mcp
// The same tool probe `lib/mcp.js` installs, built here against the resolved
// scope service so the test reads through one host installation, not two.
const probe = (agentCtx, serverName) => {
  try {
    const registry = agentCtx?.get?.('tools')
    const prefix = 'mcp__' + serverName + '__'
    return registry.schemas(host.scopeOf(agentCtx))
      .map((schema) => String(schema?.name ?? ''))
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
  } catch {
    return null
  }
}
const loadClient = async () => host.client

const namesIn = (list) => (list ?? []).map((schema) => schema?.name).filter(Boolean)
const visible = () => namesIn(tools.schemas(undefined))

// ---- stdio: configure, mount, observe, unmount --------------------------
const manager = new McpManager({ probe, loadClient })
const collected = await collectServers(cwd)
ok('the configured server is read from the user mcp.json',
  collected.servers.length === 1 && collected.servers[0].name === 'fixture',
  'servers: ' + JSON.stringify(collected.servers.map((entry) => entry.name)))
manager.setConfigured(collected.servers)
manager.attachAgent(ctx, cwd)

const connected = await waitFor(() => manager.status()[0]?.state === 'connected')
ok('the stdio server connected through the real MCP client', connected,
  'status: ' + JSON.stringify(manager.status().map(({ state, error }) => ({ state, error }))))
const status = manager.status()[0] ?? {}
ok('the connected row lists the server\'s tool', Array.isArray(status.tools) && status.tools.includes('echo'),
  'tools: ' + JSON.stringify(status.tools))
ok('the tool is registered on the agent scope as mcp__fixture__echo',
  visible().includes('mcp__fixture__echo'), 'visible: ' + JSON.stringify(visible()))
const log = (() => {
  try { return readFileSync(logPath, 'utf8') } catch { return '' }
})()
ok('the fixture saw a real handshake and tool discovery',
  log.includes('initialize') && log.includes('tools/list'), 'fixture log:\n' + log)

await manager.detachAgent()
const gone = await waitFor(() => !visible().includes('mcp__fixture__echo'), 8000)
ok('unmounting removes the server\'s tools again', gone, 'visible: ' + JSON.stringify(visible()))

// ---- legacy SSE: the same proof through the bundled bridge --------------
const { createSseMcpServer } = await import('./fixtures/sse-mcp-server.mjs')
const sseFixture = createSseMcpServer()
const port = await sseFixture.start()
cleanup.push(() => { void sseFixture.stop() })

writeFileSync(configPath, JSON.stringify({
  version: 1,
  servers: {
    legacy: {
      type: 'sse',
      url: `http://127.0.0.1:${port}/sse`,
      headers: {},
      timeoutMs: 30000,
      enabled: true,
    },
  },
}, null, 2) + '\n', 'utf8')

const sseManager = new McpManager({ probe, loadClient })
const sseCollected = await collectServers(cwd)
sseManager.setConfigured(sseCollected.servers)
sseManager.attachAgent(ctx, cwd)
const sseConnected = await waitFor(() => sseManager.status()[0]?.state === 'connected', 30000)
ok('the SSE server connected through bin/mcp-sse-bridge.mjs', sseConnected,
  'status: ' + JSON.stringify(sseManager.status().map(({ state, error }) => ({ state, error }))))
ok('the SSE tool is registered as mcp__legacy__echo', visible().includes('mcp__legacy__echo'),
  'visible: ' + JSON.stringify(visible()))
await sseManager.detachAgent()
await sseFixture.stop()

// ---- teardown -----------------------------------------------------------
console.log(report.join('\n'))
console.log('')
try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(cwd, { recursive: true, force: true }) } catch { /* best effort */ }
if (failed > 0) {
  console.log(failed + ' mcp-live check(s) failed')
  process.exit(1)
}
console.log('mcp-live tests passed')
process.exit(0)
