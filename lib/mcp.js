// MCP server configuration for the TUI: the JSON documents that hold the server
// list, the validation the form applies, and the live mounts that connect a
// configured server to the open session's agent scope.
//
// Storage is two file scopes — `$DSH_HOME/mcp.json` for every session, and
// `<dir>/.dsh/mcp.json` for a session whose cwd sits under `<dir>` — so this
// plugin owns the documents themselves and never goes through the settings
// service (on dsh 0.2.0 that service cannot describe a namespace the plugin did
// not declare as its own Config field).
//
// Every read path degrades instead of throwing: a missing, unreadable or
// malformed file costs that file's servers and nothing else, and the host's MCP
// client, scope key and tool registry are optional too. Writes are the
// exception — they run on a user action that must be able to show a reason, so
// they throw.
//
// No @deepseek-ai module is imported at module scope: the plugin must install
// and boot on a host that ships none, so both host modules load through a
// dynamic import inside a try/catch.

import { validateHeaderName, validateHeaderValue } from 'node:http'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatError } from './util.js'
import { t } from './i18n.js'

// The interface's server types. The host client only knows `stdio` and
// `streamable-http`; `sse` is a UI type mounted through the bundled bridge.
export const MCP_TYPES = ['stdio', 'http', 'sse']
export const DEFAULT_TIMEOUT_MS = 30000
export const MAX_TIMEOUT_MS = 3600000
export const MCP_ENTRY_PREFIX = 'mcp__'
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

// How long a single server may take to connect before its row is an error. The
// host's own client has no connect budget of its own — it retries forever — so
// without this a dead server would leave a `pending` row for the whole session.
const CONNECT_TIMEOUT_MS = 20000

// ---------------------------------------------------------------- storage ---

// `$DSH_HOME` is the host's own root, so the user file lives beside the profiles
// and settings the host writes; a host started without it falls back to ~/.dsh.
export function dshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

export function userConfigPath(home = dshHome()) {
  const base = String(home ?? '').trim() || dshHome()
  return join(base, 'mcp.json')
}

export function pathConfigPath(directory) {
  return join(String(directory ?? ''), '.dsh', 'mcp.json')
}

// Every document that can define a server for `cwd`, nearest first and the user
// file last. Nearest-first is what makes a closer file win a duplicate name.
export function configPathsForCwd(cwd, home = dshHome()) {
  const locations = []
  const start = String(cwd ?? '').trim()
  if (start !== '') {
    let directory = resolve(start)
    for (;;) {
      locations.push({ scope: 'path', path: pathConfigPath(directory), directory })
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  locations.push({ scope: 'user', path: userConfigPath(home) })
  return locations
}

function normalizeTimeout(value) {
  const timeout = Number(String(value ?? '').trim())
  return Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS
}

// A JSON value the document can hold as a string. Anything else is dropped: a
// nested object stringified into "[object Object]" would reach a child process
// environment as a lie.
function normalizePairObject(value) {
  const pairs = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return pairs
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') pairs[name] = String(raw)
  }
  return pairs
}

// One document record, normalized to the shape the document fixes. An in-memory
// record always carries `name` — the document itself keeps it only as the map
// key, and `serializeDocument` strips it again on the way out.
function normalizeRecord(name, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const declared = raw.type ?? raw.transport
  // `streamable-http` is the host's own name for this transport, and what an
  // earlier revision of this document stored; the interface type is `http`.
  const type = declared === 'streamable-http' ? 'http' : MCP_TYPES.includes(declared) ? declared : 'stdio'
  const record = {
    name,
    type,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    enabled: raw.enabled !== false,
  }
  if (type === 'stdio') {
    record.command = typeof raw.command === 'string' ? raw.command : ''
    record.args = Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : []
    record.env = normalizePairObject(raw.env)
  } else {
    record.url = typeof raw.url === 'string' ? raw.url : ''
    record.headers = normalizePairObject(raw.headers)
  }
  return record
}

function recordName(record) {
  const name = record?.name ?? record?.serverName
  return typeof name === 'string' ? name : ''
}

function sortByName(servers) {
  return [...servers].sort((a, b) => recordName(a).localeCompare(recordName(b)))
}

// Tokenize a command line the way a shell would: whitespace splits, double
// quotes group. An unclosed quote is an error rather than a silent truncation.
// A JSON array is accepted as well, so an argument carrying whitespace or a
// quote survives the single-line text field that has no way to express it.
export function parseArgs(text) {
  const source = String(text ?? '').trim()
  if (source === '') return []
  if (source.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new Error('arguments are not a valid JSON array: ' + formatError(error))
    }
    if (!Array.isArray(parsed)) throw new Error(t('mcp.error.argsArray'))
    return parsed.map((value) => {
      if (value === null || typeof value === 'object') throw new Error(t('mcp.error.argsTypes'))
      return String(value)
    })
  }
  const args = []
  let current = ''
  let quoted = false
  let inToken = false
  for (const char of source) {
    if (char === '"') {
      quoted = !quoted
      inToken = true
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (inToken) args.push(current)
      current = ''
      inToken = false
      continue
    }
    current += char
    inToken = true
  }
  if (quoted) throw new Error(t('mcp.error.argsUnclosed'))
  if (inToken) args.push(current)
  return args
}

// A name carrying a control character is rejected before it can reach a child
// process environment or an HTTP header line.
function hasControlChar(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// The form's env/header field: a JSON object whose values are scalars. Empty
// text is a legal empty map, so clearing the field clears the environment.
export function parseKeyValueJson(text, { header = false, label = 'environment' } = {}) {
  const source = String(text ?? '').trim()
  if (source === '') return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    // The catalog covers the sentence, not the parser detail: the label prefix
    // is translated and the thrown message is appended verbatim.
    return { ok: false, error: t('mcp.error.envObject', { label }) + ': ' + formatError(error) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: t('mcp.error.envObject', { label }) }
  }
  const value = {}
  for (const [name, raw] of Object.entries(parsed)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return { ok: false, error: t('mcp.error.envValue', { label, name }) }
    }
    if (header) {
      try {
        validateHeaderName(name)
        validateHeaderValue(name, String(raw))
      } catch {
        return { ok: false, error: t('mcp.error.header', { name }) }
      }
    } else if (name === '' || name.includes('=') || hasControlChar(name)) {
      return { ok: false, error: t('mcp.error.envName', { name }) }
    }
    value[name] = String(raw)
  }
  return { ok: true, value }
}

// One document's servers, or the reason it defines none. `mcpServers` is read
// as an alias for `servers`: that is the key every other MCP client uses, so an
// imported document works without editing.
export function parseDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (error) {
    return { ok: false, error: t('mcp.error.json', { error: formatError(error) }) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: t('mcp.error.jsonObject') }
  }
  const declared = parsed.servers !== undefined ? parsed.servers : parsed.mcpServers
  if (declared === undefined) return { ok: true, servers: [] }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { ok: false, error: t('mcp.error.serversObject') }
  }
  const servers = []
  for (const [name, raw] of Object.entries(declared)) {
    const record = normalizeRecord(name, raw)
    // A key whose value is not an object describes no server at all; the rest
    // of the file still reads.
    if (record) servers.push(record)
  }
  return { ok: true, servers: sortByName(servers) }
}

export async function readDocument(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, servers: [], error: '' }
    return { exists: true, servers: [], error: formatError(error) }
  }
  const parsed = parseDocument(text)
  if (!parsed.ok) return { exists: true, servers: [], error: parsed.error }
  return { exists: true, servers: parsed.servers, error: '' }
}

// The effective server list for a session: every document from cwd up to the
// filesystem root plus the user file, a duplicate name going to the nearest
// file. `files` is every document that was considered, in that same order, so
// the page can explain where a server came from — and which file failed.
export async function collectServers(cwd, { home } = {}) {
  const locations = configPathsForCwd(cwd, home)
  const servers = []
  const files = []
  const claimed = new Set()
  for (const location of locations) {
    const document = await readDocument(location.path)
    // `directory` is the scope a path document stands for, so a page can label
    // the row without re-deriving it from the path; a user document has none.
    files.push({
      scope: location.scope,
      path: location.path,
      directory: location.directory ?? '',
      exists: document.exists,
      error: document.error,
    })
    for (const record of document.servers) {
      if (claimed.has(record.name)) continue
      claimed.add(record.name)
      servers.push({ ...record, scope: location.scope, sourcePath: location.path })
    }
  }
  return { servers: sortByName(servers), files }
}

// ---------------------------------------------------------------- write -----

function storedRecord(entry) {
  const record = entry ?? {}
  const type = MCP_TYPES.includes(record.type) ? record.type : 'stdio'
  const common = { timeoutMs: normalizeTimeout(record.timeoutMs), enabled: record.enabled !== false }
  if (type === 'stdio') {
    return {
      type,
      command: String(record.command ?? ''),
      args: Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : [],
      env: normalizePairObject(record.env),
      ...common,
    }
  }
  return {
    type,
    url: String(record.url ?? ''),
    headers: normalizePairObject(record.headers),
    ...common,
  }
}

// The document on disk: `servers` keyed by name, every decoration an in-memory
// record picked up on the way (name, scope, sourcePath) left out.
export function serializeDocument(servers) {
  const document = {}
  for (const entry of sortByName(Array.isArray(servers) ? servers : [])) {
    const name = recordName(entry)
    if (name === '') continue
    document[name] = storedRecord(entry)
  }
  return JSON.stringify({ version: 1, servers: document }, null, 2) + '\n'
}

// A temp file in the target directory plus a rename: an interrupted write
// leaves the previous document readable instead of a truncated one. The rename
// replaces an existing file on every platform this plugin runs on.
async function writeDocument(file, servers) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, '.' + basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp')
  try {
    await writeFile(temporary, serializeDocument(servers), 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function existingKind(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

// -------------------------------------------------------------- validation ---

export function emptyDraft() {
  return {
    name: '',
    type: 'stdio',
    timeoutMs: String(DEFAULT_TIMEOUT_MS),
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    scope: 'user',
    path: '',
    enabled: true,
    // The stored name while an existing server is edited: renaming is removing
    // one server and adding another, so the write needs to know what to drop.
    originalName: '',
  }
}

// A field that cannot hold whitespace, a quote or an empty argument is written
// as a JSON array instead, which parseArgs reads back exactly.
function formatArgs(args) {
  const plain = args.every((arg) => typeof arg === 'string' && arg !== '' && !/[\s"]/.test(arg))
  return plain ? args.join(' ') : JSON.stringify(args.map((arg) => String(arg)))
}

// The directory a path-scoped entry came from: the document sits in
// `<directory>/.dsh/mcp.json`, so its own directory is two levels up.
function directoryOf(record) {
  if (typeof record?.directory === 'string' && record.directory !== '') return record.directory
  const source = String(record?.sourcePath ?? '')
  return source === '' ? '' : dirname(dirname(source))
}

export function draftFromEntry(entry) {
  const record = entry ?? {}
  const scope = record.scope === 'path' ? 'path' : 'user'
  return {
    name: recordName(record),
    type: MCP_TYPES.includes(record.type) ? record.type : 'stdio',
    timeoutMs: String(record.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    command: typeof record.command === 'string' ? record.command : '',
    args: formatArgs(Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : []),
    env: JSON.stringify(record.env && typeof record.env === 'object' ? record.env : {}),
    url: typeof record.url === 'string' ? record.url : '',
    headers: JSON.stringify(record.headers && typeof record.headers === 'object' ? record.headers : {}),
    scope,
    path: scope === 'path' ? directoryOf(entry) : '',
    enabled: record.enabled !== false,
    originalName: recordName(entry),
  }
}

// Validate a form draft against the document contract. Returns the record to
// store — carrying its name, the document key — or the first reason it cannot
// work. `existing` is the list the name has to be unique in; the caller leaves
// the edited server's own `originalName` out of it.
export function validateDraft(draft, { existing = [] } = {}) {
  const source = draft ?? {}
  const name = String(source.name ?? '').trim()
  if (!SERVER_NAME_PATTERN.test(name)) {
    return { ok: false, error: t('mcp.error.name') }
  }
  if (existing.some((entry) => recordName(entry) === name)) {
    return { ok: false, error: t('mcp.error.duplicate', { name }) }
  }

  const declaredTimeout = String(source.timeoutMs ?? '').trim()
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (declaredTimeout !== '') {
    timeoutMs = Number(declaredTimeout)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return { ok: false, error: t('mcp.error.timeout', { max: MAX_TIMEOUT_MS }) }
    }
  }

  if (source.scope === 'path') {
    const directory = String(source.path ?? '').trim()
    if (directory === '') return { ok: false, error: t('mcp.error.pathNeeded') }
    if (!isAbsolute(directory)) return { ok: false, error: t('mcp.error.pathAbsolute') }
  }

  const type = MCP_TYPES.includes(source.type) ? source.type : 'stdio'
  const record = { name, type, timeoutMs, enabled: source.enabled !== false }
  if (type === 'stdio') {
    const command = String(source.command ?? '').trim()
    if (command === '') return { ok: false, error: t('mcp.error.commandNeeded') }
    let args
    try {
      args = parseArgs(source.args)
    } catch (error) {
      return { ok: false, error: formatError(error) }
    }
    const env = parseKeyValueJson(source.env, { label: 'environment' })
    if (!env.ok) return { ok: false, error: env.error }
    return { ok: true, record: { ...record, command, args, env: env.value } }
  }

  const url = String(source.url ?? '').trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: t('mcp.error.urlParse') }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: t('mcp.error.urlScheme') }
  }
  const headers = parseKeyValueJson(source.headers, { header: true, label: 'headers' })
  if (!headers.ok) return { ok: false, error: headers.error }
  return { ok: true, record: { ...record, url, headers: headers.value } }
}

// Replace or append one record, keyed by name, and keep the list sorted so the
// page and the document do not reorder between a write and the next read.
export function upsertEntry(servers, record, originalName = '') {
  const list = Array.isArray(servers) ? servers : []
  const dropped = new Set([originalName, recordName(record)].filter((name) => name !== ''))
  return sortByName([...list.filter((entry) => !dropped.has(recordName(entry))), record])
}

export function removeEntry(servers, name) {
  return (Array.isArray(servers) ? servers : []).filter((entry) => recordName(entry) !== name)
}

// Choose a draft's document, then read-modify-write it. Throws on a bad draft
// or an I/O failure: the caller is a user action that must show the reason, and
// a document that could not be parsed is never overwritten.
export async function saveDraft({ cwd = '', draft, home = dshHome() } = {}) {
  const source = draft ?? {}
  const scope = source.scope === 'path' ? 'path' : 'user'
  let file
  if (scope === 'path') {
    const directory = String(source.path ?? '').trim()
    if (directory === '' || !isAbsolute(directory)) throw new Error(t('mcp.error.pathAbsolute'))
    const target = resolve(directory)
    const info = await existingKind(target)
    if (info && !info.isDirectory()) throw new Error(t('mcp.error.pathNotDir', { path: target }))
    file = pathConfigPath(target)
  } else {
    // `cwd` is part of the frozen signature but not of the choice: a user-scope
    // draft has one document, and a path-scope draft carries an absolute one.
    file = userConfigPath(home)
  }
  const fileInfo = await existingKind(file)
  if (fileInfo?.isDirectory()) throw new Error(t('mcp.error.configIsDir', { path: file }))

  const current = await readDocument(file)
  if (current.error !== '') throw new Error(current.error)
  const originalName = String(source.originalName ?? '')
  const existing = current.servers.filter((entry) => recordName(entry) !== originalName)
  const validated = validateDraft(source, { existing })
  if (!validated.ok) throw new Error(validated.error)

  const servers = upsertEntry(current.servers, validated.record, originalName)
  await writeDocument(file, servers)
  return { scope, path: file, servers }
}

// Delete a name from the document that defines it. A farther document may then
// define the same name again — that is the scope contract, not a failure.
// `sourcePath` names that document explicitly, which a scope move needs: once
// the entry has been written to a nearer document, the effective entry is the
// new one and the old file would no longer be found by name.
export async function removeServer({ cwd = '', name, home = dshHome(), sourcePath } = {}) {
  const target = String(name ?? '').trim()
  let file = String(sourcePath ?? '').trim()
  if (file === '') {
    const collected = await collectServers(cwd, { home })
    const entry = collected.servers.find((server) => server.name === target)
    if (!entry) throw new Error(t('mcp.error.notFound', { name: target }))
    file = entry.sourcePath
  }
  const current = await readDocument(file)
  if (!current.exists) throw new Error(t('mcp.error.documentGone', { name: target, error: file }))
  if (current.error !== '') throw new Error(current.error)
  const servers = removeEntry(current.servers, target)
  if (servers.length === current.servers.length) throw new Error('no MCP server named "' + target + '" in ' + file)

  await writeDocument(file, servers)
  return { path: file, servers }
}

// ---------------------------------------------------------------- manager ---

// The host client plugin, imported lazily: it is a harness dependency, but this
// plugin must install and boot where it is absent.
let mcpClientModule = null
let mcpClientResolved = false
async function loadMcpClient() {
  if (mcpClientResolved) return mcpClientModule
  mcpClientResolved = true
  try {
    mcpClientModule = await import('@deepseek-ai/dsh-mcp-client')
  } catch {
    mcpClientModule = null
  }
  return mcpClientModule
}

// The bundled bridge, resolved from this module's own package so an installed
// or globally resolved copy both find it.
let bridgePath = null
function sseBridgePath() {
  if (bridgePath === null) bridgePath = fileURLToPath(new URL('../bin/mcp-sse-bridge.mjs', import.meta.url))
  return bridgePath
}

// The plugin config handed to one MCP client instance. Only fields the host's
// schema declares are passed, and a stdio server gets the session's working
// directory so a relative command resolves where the user works.
function mountConfig(server, cwd) {
  const base = {
    serverName: recordName(server),
    failOnStartupError: true,
    toolCallTimeoutMs: normalizeTimeout(server?.timeoutMs),
  }
  if (server?.type === 'sse') {
    return {
      ...base,
      transport: 'stdio',
      command: process.execPath,
      args: [sseBridgePath()],
      // A URL and its headers can carry credentials, and a process's argv is
      // readable by every user on the machine: they travel in the environment.
      env: {
        MCP_SSE_URL: String(server.url ?? ''),
        MCP_SSE_HEADERS: JSON.stringify(server.headers ?? {}),
        MCP_SSE_TIMEOUT_MS: String(base.toolCallTimeoutMs),
      },
      cwd: cwd ?? '',
    }
  }
  if (server?.type === 'http') {
    return {
      ...base,
      transport: 'streamable-http',
      url: String(server.url ?? ''),
      headers: { ...(server.headers ?? {}) },
    }
  }
  return {
    ...base,
    transport: 'stdio',
    command: String(server?.command ?? ''),
    args: Array.isArray(server?.args) ? [...server.args] : [],
    env: { ...(server?.env ?? {}) },
    cwd: cwd ?? '',
  }
}

function serverTarget(server) {
  if (server?.type === 'http' || server?.type === 'sse') return String(server.url ?? '')
  const args = Array.isArray(server?.args) ? server.args.join(' ') : ''
  return args === '' ? String(server?.command ?? '') : String(server?.command ?? '') + ' ' + args
}

function disposeFiber(fiber) {
  return fiber?.dispose ? Promise.resolve(fiber.dispose()).catch(() => undefined) : Promise.resolve()
}

function withTimeout(thenable, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    Promise.resolve(thenable).then(
      () => { clearTimeout(timer); resolve() },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

// Read the tools one server registered on its agent scope. `tools.schemas`
// answers what the agent sees (scoped registrations included), so a server with
// no visible tool is a silent one. A host whose scope key or tool registry
// cannot be read answers null, which the page shows as a bare "connected".
let scopeResolver = null
let scopeResolverTried = false
async function loadScopeOf() {
  if (scopeResolverTried) return scopeResolver
  scopeResolverTried = true
  try {
    const mod = await import('@deepseek-ai/dsh-scope')
    scopeResolver = typeof mod?.scopeOf === 'function' ? mod.scopeOf : null
  } catch {
    scopeResolver = null
  }
  return scopeResolver
}

export async function createToolProbe() {
  const scopeOf = await loadScopeOf()
  if (!scopeOf) return () => null
  return (agentCtx, serverName) => {
    try {
      const tools = agentCtx?.get?.('tools') ?? agentCtx?.tools
      if (!tools || typeof tools.schemas !== 'function') return null
      const prefix = MCP_ENTRY_PREFIX + serverName + '__'
      return tools.schemas(scopeOf(agentCtx))
        .map((schema) => String(schema?.name ?? ''))
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
    } catch {
      return null
    }
  }
}

// The live MCP mounts of the session that is currently open. One entry per
// configured server, carrying the honest outcome of its connection attempt; a
// configured server with no entry is simply not connected.
export class McpManager {
  constructor({ probe, loadClient = loadMcpClient } = {}) {
    this.probe = probe ?? null
    this.loadClient = loadClient
    this.configured = []
    this.agentCtx = null
    this.attachGeneration = 0
    this.cwd = ''
    this.entries = new Map()
  }

  setConfigured(servers) {
    this.configured = Array.isArray(servers) ? servers : []
  }

  // Mount every enabled server on the given agent scope. Never awaited by the
  // caller: a slow server must not hold up the first frame of a session, and a
  // failing one must not stop the servers after it.
  attachAgent(agentCtx, cwd = '') {
    const generation = ++this.attachGeneration
    this.cwd = cwd
    void this.detachAgent().then(() => {
      // detachAgent clears the scope, so it is restored here — and a second
      // attach arriving meanwhile leaves this one to be superseded rather than
      // mounting into a scope that is already being torn down.
      if (generation !== this.attachGeneration) return
      this.agentCtx = agentCtx ?? null
      for (const server of this.configured) {
        if (server?.enabled === false) continue
        void this.mount(server)
      }
    })
    return this
  }

  async detachAgent() {
    this.agentCtx = null
    await this.removeAll()
  }

  // Drop every live mount but keep the configured list: a reconnect, not a
  // configuration change.
  async removeAll() {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      entry.cancelled = true
      await disposeFiber(entry.fiber)
    }
  }

  // Final teardown. The generation bump supersedes an attach still in flight,
  // so it cannot mount into the scope that was just cleared.
  async dispose() {
    this.attachGeneration++
    this.agentCtx = null
    this.configured = []
    await this.removeAll()
  }

  // What one mount is built from, so sync can tell a matching mount from a
  // reconfigured one without depending on record identity.
  mountKey(server) {
    try {
      return JSON.stringify(mountConfig(server, this.cwd))
    } catch {
      return ''
    }
  }

  // Install one server: connect, register its tools, record the outcome. A
  // failure is a row on the MCP page, never an exception into the session.
  async mount(server) {
    const name = recordName(server)
    if (name === '') return
    const agentCtx = this.agentCtx
    if (!agentCtx) return
    await this.unmount(name)
    const entry = { state: 'pending', error: '', tools: null, fiber: null, cancelled: false, key: this.mountKey(server) }
    this.entries.set(name, entry)
    const client = await this.loadClient()
    if (!client) {
      entry.state = 'error'
      entry.error = t('mcp.error.noClient')
      return
    }
    let fiber = null
    try {
      // Strict startup turns the plugin's own connection failure into a
      // rejection here, which is the only honest signal a failed server can
      // give; cordis disposes that plugin's fiber either way, so the agent
      // scope keeps running.
      fiber = agentCtx.plugin(client, mountConfig(server, this.cwd))
      entry.fiber = fiber
      await withTimeout(fiber, CONNECT_TIMEOUT_MS, t('mcp.error.connectTimeout', { name }))
      entry.state = 'connected'
      entry.error = ''
    } catch (error) {
      entry.state = 'error'
      entry.error = formatError(error)
      // A timed-out fiber is still connecting and would register its tools
      // after the row already says it failed; disposing it stops that.
      entry.fiber = null
      await disposeFiber(fiber)
      return
    }
    // A server dropped while it was connecting is disposed the moment its
    // fiber exists: its row is gone and its tools must not be registered.
    if (entry.cancelled) {
      entry.fiber = null
      await disposeFiber(fiber)
      return
    }
    entry.tools = this.toolsOf(name)
  }

  async unmount(name) {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    entry.cancelled = true
    await disposeFiber(entry.fiber)
  }

  // Reconcile the configured list with the live mounts: mount what is new or
  // reconfigured, unmount what went away, leave a matching mount alone.
  async sync() {
    const wanted = new Set()
    for (const server of this.configured) {
      if (server?.enabled === false) continue
      const name = recordName(server)
      if (name === '') continue
      wanted.add(name)
      const entry = this.entries.get(name)
      if (!entry || entry.key !== this.mountKey(server)) await this.mount(server)
    }
    for (const name of [...this.entries.keys()]) {
      if (!wanted.has(name)) await this.unmount(name)
    }
    this.refresh()
  }

  // Re-read each entry's tool list through the agent scope (a server can change
  // its tool list while connected, and a retry can succeed on its own).
  refresh() {
    for (const [name, entry] of this.entries) entry.tools = this.toolsOf(name)
  }

  toolsOf(name) {
    if (!this.probe) return null
    try {
      return this.probe(this.agentCtx, name) ?? null
    } catch {
      return null
    }
  }

  // What the MCP page renders: the configured list, each row carrying its live
  // state, where it came from, and the record it was built from.
  status() {
    return this.configured.map((server) => {
      const entry = this.entries.get(recordName(server))
      return {
        name: recordName(server),
        type: MCP_TYPES.includes(server?.type) ? server.type : 'stdio',
        target: serverTarget(server),
        enabled: server?.enabled !== false,
        scope: server?.scope ?? 'user',
        sourcePath: server?.sourcePath ?? '',
        state: server?.enabled === false ? 'disabled' : entry ? entry.state : 'unmounted',
        error: entry?.error ?? '',
        tools: entry?.tools ?? null,
        record: server,
      }
    })
  }
}
