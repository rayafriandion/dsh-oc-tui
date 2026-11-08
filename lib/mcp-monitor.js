// MCP connection state for the TUI, and the output isolation that keeps a
// failed MCP server off the screen.
//
// The host's MCP client reports a server it cannot reach by writing to the
// terminal, and a stdio server inherits the terminal's stderr, so adding an
// MCP server whose program is not running leaves stray text on the frame the
// renderer owns — the TUI then paints over a screen that never settled. This
// module diverts that output and reports the state instead: once per state,
// as a short notice in the corner.
import childProcess from 'node:child_process'

// The host prints one multiline audit after startup: the plugins that did not
// activate, each with its reason and a stack. Only the MCP entries are
// dropped; any other plugin's diagnostics are left alone.
export function filterMcpStartupAudit(text) {
  const lines = text.split('\n')
  const header = /^(.*?: warning: )\d+ entr(?:y|ies) did not activate$/.exec(lines[0])
  if (!header || !text.includes('@deepseek-ai/dsh-mcp-client')) return text
  const blocks = []
  for (const line of lines.slice(1)) {
    if (!line && blocks.length === 0) continue
    if (/^\S.* \([^)]+\): /.test(line)) blocks.push([line])
    else if (blocks.length) blocks.at(-1).push(line)
    else return text
  }
  if (!blocks.some((block) => block[0].includes('(@deepseek-ai/dsh-mcp-client)'))) return text
  const kept = blocks.filter((block) => !block[0].includes('(@deepseek-ai/dsh-mcp-client)'))
  if (!kept.length) return ''
  return `${header[1]}${kept.length} ${kept.length === 1 ? 'entry' : 'entries'} did not activate\n${kept.map((block) => block.join('\n').replace(/\n+$/, '')).join('\n')}\n`
}

// Wrap the current `process.stderr.write` so an MCP startup audit never
// reaches the terminal. The wrapper is installed around whatever writer is
// current — the raw stream before the alt screen, the diagnostics capture
// after it — so it composes instead of competing with it.
export function filterMcpStderrWrites() {
  const original = process.stderr.write
  function stderrWrite(chunk, encoding, callback) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return original.apply(this, arguments)
    const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : chunk
    const filtered = filterMcpStartupAudit(text)
    if (filtered === text) return original.apply(this, arguments)
    if (filtered) return original.call(this, filtered, encoding, callback)
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') queueMicrotask(done)
    return true
  }
  process.stderr.write = stderrWrite
  return () => {
    if (process.stderr.write === stderrWrite) process.stderr.write = original
  }
}

// Keep MCP diagnostics out of the terminal:
//
//   * a stdio server spawned by the SDK inherits stderr, so its own output
//     lands on the frame. Only the SDK's transport spawn is redirected, never
//     an ordinary tool process;
//   * the SDK writes its own diagnostics straight to the console (for example
//     when a server advertises no tools).
export function isolateMcpOutput() {
  const original = childProcess.spawn
  const consoleMethods = new Map()
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    const previous = console[name]
    function filtered(...args) {
      if (/[\\/]@modelcontextprotocol[\\/]/.test(new Error().stack || '')) return
      return previous.apply(this, args)
    }
    consoleMethods.set(name, { previous, filtered })
    console[name] = filtered
  }
  function spawn(command, args, options) {
    const stdio = options?.stdio
    const isMcp = Array.isArray(stdio) && stdio[0] === 'pipe' && stdio[1] === 'pipe'
      && stdio[2] === 'inherit' && /StdioClientTransport\.start/.test(new Error().stack || '')
    if (!isMcp) return original.apply(this, arguments)
    const child = original.call(this, command, args, { ...options, stdio: [stdio[0], stdio[1], 'pipe', ...stdio.slice(3)] })
    // Drain immediately: an unread pipe can block a noisy server. Its output
    // is diagnostic text, not a reliable indication of connection state.
    child.stderr?.resume()
    return child
  }
  childProcess.spawn = spawn
  return () => {
    if (childProcess.spawn === spawn) childProcess.spawn = original
    for (const [name, { previous, filtered }] of consoleMethods) {
      if (console[name] === filtered) console[name] = previous
    }
  }
}

// Watch the host's MCP client and report each server's state. The state is
// read from two places: the host's log lines, and the plugin fibers of
// `@deepseek-ai/dsh-mcp-client` (which know whether a server came up).
export function createMcpMonitor(ctx) {
  const state = new Map()
  const seenLoading = new WeakSet()
  const probes = new Map()
  const pending = []
  let listener = null
  const report = (name, status) => {
    if (!name || state.get(name) === status) return
    state.set(name, status)
    const event = { name, status }
    if (listener) listener(event)
    else pending.push(event)
  }
  const handleLog = (message) => {
    const text = String(message?.args?.[0] ?? '')
    const match = /^mcp-client\(([^)]+)\):\s*(.*)/s.exec(text)
    if (!match) return
    const detail = match[2]
    if (/connection attempt failed|connection failed|connection lost|giving up|failed generation|tool registration failed/i.test(detail)) report(match[1], 'failed')
    else if (/reconnected and re-synced/i.test(detail)) report(match[1], 'connected')
  }
  const handleFiber = (fiber) => {
    const entry = fiber?.entry
    if (!entry || !String(entry.options?.name ?? '').includes('dsh-mcp-client')) return
    // Effects created by a plugin inherit its entry but become active before
    // the plugin's asynchronous connection attempt has settled.
    if (entry.fiber !== fiber) return
    const server = entry.options?.config?.serverName
    if (!server) return
    if (fiber.state === 1) {
      seenLoading.add(fiber)
      probes.delete(server)
      state.delete(server)
    }
    // A host MCP plugin can activate after a failed first attempt while its
    // retry supervisor runs, so a failure log takes precedence over ACTIVE.
    if (fiber.state === 2 && !state.has(server)) {
      const resources = ctx.get('mcpResources')
      if (typeof resources?.request === 'function') {
        // The provider checks its connection before handling a request.
        // An already-aborted signal keeps this probe local to the host.
        const probe = {}
        probes.set(server, probe)
        const signal = AbortSignal.abort()
        Promise.resolve().then(() => resources.request(server, { method: 'resources/read', uri: 'tui-status://probe' }, { agent: undefined, signal }))
          .then(() => 'connected', (error) => {
            const text = String(error)
            if (/server is disconnected/i.test(text)) return 'failed'
            if (/unavailable in this agent's scope/i.test(text)) return null
            return 'connected'
          }).then((status) => {
            if (probes.get(server) === probe && !state.has(server) && status) report(server, status)
          })
      } else if (seenLoading.has(fiber)) {
        // If observation began before this fiber loaded, its failure logs
        // would have arrived before the ACTIVE transition.
        report(server, 'connected')
      }
    }
    if (fiber.state === 3) report(server, 'failed')
  }
  ctx.logger.exporter({ levels: { default: 2 }, export: handleLog })
  ctx.on('internal/status', handleFiber, { global: true })
  for (const entry of ctx.get('loader')?.entries?.() ?? []) if (entry.fiber) handleFiber(entry.fiber)
  return {
    attach(fn) { listener = fn; for (const event of pending.splice(0)) fn(event) },
    detach() { listener = null },
    handleLog, handleFiber,
  }
}

// One gate for every source of MCP state (the host's log, the host's plugin
// fibers, the TUI's own mounts): a server that reports the same state twice
// is reported once. The state changes on the next attempt, so a reconnect
// that succeeds is reported again.
export function createMcpNotifier() {
  const state = new Map()
  const listeners = new Set()
  return {
    report(name, status) {
      if (!name) return
      const key = String(name)
      if (state.get(key) === status) return
      state.set(key, status)
      for (const listener of listeners) {
        try { listener(key, status) } catch { /* a listener must not break the notifier */ }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}
