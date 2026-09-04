// In-app update manager for dsh and dsh-oc-tui. All npm/pnpm interaction is
// concentrated here (async spawn, no spawnSync), so the rest of the plugin only
// wires the results into the settings UI. Version comparison is deliberately
// dependency-free: major.minor.patch numerics plus a pre-release segment.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { stripAnsi } from './util.js'
import { SETTINGS_MENU } from './web-settings.js'

export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const TUI_PACKAGE = 'dsh-oc-tui'

const PACKAGE_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const TUI_MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

// ---- version parsing / comparison (pure) ---------------------------------

// Split a version into numeric core segments (padded to 3) and its pre-release
// tail. Build metadata (`+...`) is stripped first, as is an optional leading
// `v`/`=`. Non-numeric core parts degrade to 0 so a malformed version never
// throws — it just compares as "older".
export function splitVersion(version) {
  const text = String(version ?? '').trim()
  const withoutBuild = text.split('+')[0]
  const dash = withoutBuild.indexOf('-')
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1)
  const clean = core.replace(/^[v=]/, '')
  const segments = clean.split('.').map((part) => {
    const n = parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  while (segments.length < 3) segments.push(0)
  return { segments, pre }
}

export function isPrerelease(version) {
  return splitVersion(version).pre !== ''
}

export function coreSegments(version) {
  return splitVersion(version).segments
}

// Semver-style pre-release comparison: numeric identifiers compare numerically
// and sort below alphanumeric ones; a shorter list sorts first.
function comparePrerelease(a, b) {
  const ap = a.split('.')
  const bp = b.split('.')
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i++) {
    const x = ap[i]
    const y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x < y) {
      return -1
    } else if (x > y) {
      return 1
    }
  }
  return 0
}

// Ascending comparison. A stable release sorts above a pre-release sharing its
// core; otherwise cores decide first, then the pre-release tail.
export function compareVersions(a, b) {
  const av = splitVersion(a)
  const bv = splitVersion(b)
  for (let i = 0; i < 3; i++) {
    if (av.segments[i] !== bv.segments[i]) return av.segments[i] - bv.segments[i]
  }
  if (av.pre === '' && bv.pre !== '') return 1
  if (av.pre !== '' && bv.pre === '') return -1
  if (av.pre === bv.pre) return 0
  return comparePrerelease(av.pre, bv.pre)
}

export function latestStable(versions) {
  if (!Array.isArray(versions)) return null
  let best = null
  for (const version of versions) {
    if (typeof version !== 'string' || version === '' || isPrerelease(version)) continue
    if (best === null || compareVersions(version, best) > 0) best = version
  }
  return best
}

// The "is there an update?" rule, stable releases only (pre-releases never
// prompt). `installed` may be null/undefined (package not found).
export function updateStatus(installed, registry) {
  const stable = latestStable(registry?.versions)
  if (stable === null) return { kind: 'no-stable' }
  if (installed === null || installed === undefined) return { kind: 'available', target: stable }
  const installedPre = isPrerelease(installed)
  const cmp = compareVersions(stable, installed)
  if (cmp > 0 || (cmp === 0 && installedPre)) return { kind: 'available', target: stable }
  return { kind: 'up-to-date' }
}

// ---- registry / install spawn helpers ------------------------------------

// Parse `npm view <pkg> versions dist-tags --json`. Defensive: a versions
// string degrades to a single-element array, missing/odd fields become empty.
export function parseRegistryView(json) {
  let data
  try { data = JSON.parse(String(json ?? '')) } catch { data = null }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  let versions = obj.versions
  if (typeof versions === 'string') versions = [versions]
  if (!Array.isArray(versions)) versions = []
  versions = versions.filter((version) => typeof version === 'string' && version !== '')
  const distTags = obj['dist-tags'] && typeof obj['dist-tags'] === 'object' && !Array.isArray(obj['dist-tags'])
    ? obj['dist-tags']
    : {}
  const tags = {}
  for (const [tag, version] of Object.entries(distTags)) {
    if (typeof version === 'string' && version !== '') tags[tag] = version
  }
  return { versions, distTags: tags }
}

function findOnPath(name) {
  const path = process.env.PATH || ''
  const names = process.platform === 'win32' ? [name + '.cmd', name + '.exe', name] : [name]
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const candidate of names) {
      const full = join(directory, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

// Resolve the dsh package's bin entry from an npm shim next to its install,
// mirroring the launcher: returning the JS entry lets Windows run it through
// node directly (avoids .cmd EINVAL hardening and shell quoting).
function resolveDshEntry(dshExecutable) {
  try {
    const packagePath = createRequire(resolve(dshExecutable)).resolve(`${DSH_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof entry === 'string' && entry !== '') return resolve(dirname(packagePath), entry)
  } catch {
    // Not an npm shim beside the dsh install, or a non-npm layout.
  }
  return undefined
}

function npmCommand() {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] }
  const onPath = findOnPath('npm')
  if (onPath !== undefined) return { command: onPath, args: [] }
  return undefined
}

function npxCommand() {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] }
  const onPath = findOnPath('npx')
  if (onPath !== undefined) return { command: onPath, args: [] }
  return undefined
}

// Async spawn that collects stdout/stderr and resolves with the outcome. A
// timeout kills the child instead of letting a hung registry/install freeze the
// TUI. `.cmd`/`.bat` shims go through cmd.exe on Windows.
function runCommand(command, args, timeoutMs) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return runCommand('cmd.exe', ['/d', '/s', '/c', command, ...args], timeoutMs)
  }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: error?.message ?? String(error) })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* already gone */ }
      resolve({ code: null, signal: 'timeout', stdout, stderr: stderr + `\n(timed out after ${timeoutMs}ms)` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout, stderr: stderr + '\n' + (error?.message ?? String(error)) })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function runNpm(npmArgs, timeoutMs) {
  const npm = npmCommand()
  if (!npm) return Promise.resolve({ code: null, signal: null, stdout: '', stderr: 'npm not found on PATH' })
  return runCommand(npm.command, [...npm.args, ...npmArgs], timeoutMs)
}

function runDsh(dshArgs, timeoutMs, dshEntry) {
  if (dshEntry) return runCommand(process.execPath, [dshEntry, ...dshArgs], timeoutMs)
  const dshExecutable = findOnPath('dsh')
  if (dshExecutable !== undefined) {
    const entry = resolveDshEntry(dshExecutable)
    if (entry !== undefined) return runCommand(process.execPath, [entry, ...dshArgs], timeoutMs)
    return runCommand(dshExecutable, dshArgs, timeoutMs)
  }
  const npx = npxCommand()
  if (npx) return runCommand(npx.command, [...npx.args, '--yes', DSH_PACKAGE, ...dshArgs], timeoutMs)
  return Promise.resolve({ code: null, signal: null, stdout: '', stderr: 'dsh not found on PATH' })
}

// The last ~3 non-empty stderr lines, ANSI stripped and length-capped — the
// digest shown in a failure toast.
export function stderrSummary(stderr) {
  const text = stripAnsi(String(stderr ?? '')).trim()
  if (!text) return '(no output)'
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const joined = lines.slice(-3).join(' · ')
  return joined.length > 240 ? joined.slice(0, 240) + '…' : joined
}

export async function registryInfo(pkg) {
  const result = await runNpm(['view', pkg, 'versions', 'dist-tags', '--json'], 30_000)
  if (result.code !== 0) throw new Error(stderrSummary(result.stderr) || `npm view ${pkg} exited ${result.code}`)
  return parseRegistryView(result.stdout)
}

export async function installDsh(version) {
  return runNpm(['install', '-g', `${DSH_PACKAGE}@${version}`], 300_000)
}

export async function installTui(version, profile, dshEntry) {
  return runDsh(['plugin', '--profile', profile, 'add', '-E', `${TUI_PACKAGE}@${version}`], 300_000, dshEntry)
}

// ---- install safety (Windows self-update lock) ----------------------------
//
// A `npm install -g @deepseek-ai/dsh` while any dsh process is alive can leave
// a hybrid old/new tree behind: memory-mapped native DLLs (sharp) block npm's
// directory retire/cleanup with EPERM, and npm still exits 0. The helpers here
// exist so the UI can (a) refuse to run the install until every other dsh
// process is gone (the TUI defers its own install to exit time), and (b) never
// trust the exit code alone — after npm exits 0 the on-disk manifest must still
// report the requested version.

// A dsh process is running whose entry lives in `node_modules/@deepseek-ai/dsh`
// (global CLI, `dsh web`, or another TUI). The path fragment is matched
// case-insensitively with either separator, surviving quoting and both `node
// dsh.cmd` (cmd shim name only) and resolved absolute paths.
const DSH_ENTRY_FRAGMENT = 'dsh\\lib\\bin.js'

function commandLineMatchesDsh(commandLine) {
  const normalized = String(commandLine ?? '').toLowerCase().replace(/\//g, '\\')
  return normalized.includes(DSH_ENTRY_FRAGMENT)
}

// Parse a tasklist row — either csv cells (["node.exe","8100","Console",…])
// or the plain table format ("node.exe   8100 Console …"), where column
// padding is not guaranteed to exceed one space.
function parseTasklistRow(row) {
  if (Array.isArray(row)) {
    if (row.length < 2) return null
    const pid = Number(row[1])
    if (!Number.isInteger(pid) || pid <= 0) return null
    return { pid, name: String(row[0] ?? '') }
  }
  const m = /^(\S+)\s+(\d+)\s/.exec(String(row ?? ''))
  if (m === null) return null
  const pid = Number(m[2])
  return { pid, name: m[1] }
}

// Build the list of *other* running dsh processes. `rows` is a tasklist table
// (arrays of csv cells or whitespace-split strings), `commandLineOf(pid)` an
// optional wmic-style lookup, `selfPid` excluded (this TUI is itself a dsh
// process). Merged by pid, first row wins: the node.exe row carries the real
// command line, a later shim row (dsh.cmd) adds nothing.
export function dshLockEntries(rows, commandLineOf, selfPid = 0) {
  const commandLine = typeof commandLineOf === 'function' ? commandLineOf : () => undefined
  const byPid = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const parsed = parseTasklistRow(row)
    if (parsed === null) continue
    if (parsed.pid === selfPid) continue
    if (byPid.has(parsed.pid)) continue
    if (parsed.name.toLowerCase() === 'node.exe') {
      const cmd = commandLine(parsed.pid) ?? ''
      if (commandLineMatchesDsh(cmd)) {
        byPid.set(parsed.pid, { pid: parsed.pid, name: parsed.name, commandLine: cmd })
      }
    } else if (parsed.name.toLowerCase().startsWith('dsh')) {
      byPid.set(parsed.pid, { pid: parsed.pid, name: parsed.name, commandLine: commandLine(parsed.pid) ?? '' })
    }
  }
  return [...byPid.values()]
}

// The live process table on Windows: [{ pid, name, commandLine }], self
// excluded. wmic is gone on current Windows builds, so PowerShell CIM lists
// node processes with their command lines in one shot. Any spawn failure
// degrades to "no locks" — the install then proceeds and is still covered by
// the post-install verification.
export async function detectDshLocks(selfPid = 0) {
  if (process.platform !== 'win32') return []
  const ps = await runCommand('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"{0}`t{1}`t{2}\" -f $_.ProcessId, $_.Name, $_.CommandLine }"], 30_000)
  if (ps.code !== 0) return []
  const rows = []
  const cmdlines = new Map()
  for (const line of ps.stdout.split(/\r?\n/)) {
    const m = /^(\d+)\t(\S+)\t(.*)$/.exec(String(line ?? '').trim())
    if (m === null) continue
    const pid = Number(m[1])
    rows.push([m[2], String(pid)])
    cmdlines.set(pid, m[3])
  }
  return dshLockEntries(rows, (pid) => cmdlines.get(pid), selfPid)
}

// Classify a finished `npm install -g dsh` run. npm exit 0 is downgraded to
// `corrupt` unless the on-disk manifest exists and reports the requested
// version — the exact shape of the 2026-09-04 hybrid-tree incident (npm
// exited 0 while the tree mixed 0.1.1-rc.2 manifests with 0.1.2-rc.1 code).
// `manifest` is the freshly-read dsh package.json object, or null/undefined
// when it cannot be read at all (also corrupt: the install should never end
// with the package gone).
export function installResultFrom(spawnResult, manifest, requestedVersion) {
  const code = spawnResult?.code
  const stderr = spawnResult?.stderr ?? ''
  // Any npm failure (non-zero exit, kill, timeout) is 'failed' — the version
  // check below only decides between 'installed' and a *silent* corruption.
  if (code !== 0 || spawnResult?.signal) {
    return { kind: 'failed', code, stderr, reason: stderrSummary(stderr) || `install exited ${code ?? 'killed'}` }
  }
  const installed = manifest && typeof manifest === 'object' ? manifest.version : undefined
  if (code !== 0 || installed !== requestedVersion) {
    return {
      kind: 'corrupt',
      code,
      stderr,
      found: installed ?? null,
      reason: `install reported success but the installed version is ${installed ?? 'unreadable'} (expected ${requestedVersion}) — repair: fully close dsh, then npm install -g ${DSH_PACKAGE}@${requestedVersion}`,
    }
  }
  return { kind: 'installed', code, stderr, reason: '' }
}

// ---- deferred install on exit (Windows self-update) ------------------------

// The inline CJS script the detached installer runs. argv (after `node -e
// <script> …`): parentPid, npm command, npm args…, requested version, marker
// path. It polls the parent pid (bounded — a reused pid must not wedge the
// child forever), runs the npm install once the parent is gone, then records
// the outcome in the marker.
const DEFERRED_INSTALL_SCRIPT = [
  '(function () {',
  '  var argv = process.argv.slice(1)',
  '  var parentPid = Number(argv[0])',
  '  var npmCommand = argv[1]',
  '  var requested = argv[argv.length - 2]',
  '  var marker = argv[argv.length - 1]',
  '  var npmArgs = argv.slice(2, -2)',
  '  var deadline = Date.now() + 600000',
  '  var fs = require("fs")',
  '  var cp = require("child_process")',
  '  function alive(pid) { try { process.kill(pid, 0); return true } catch (err) { return false } }',
  '  function finish(code) {',
  '    try { fs.writeFileSync(marker, JSON.stringify({ requested: requested, code: code, finishedAt: Date.now() })) } catch (err) {}',
  '    process.exit(0)',
  '  }',
  '  ;(function poll() {',
  '    if (alive(parentPid) && Date.now() < deadline) { setTimeout(poll, 500); return }',
  '    if (alive(parentPid)) { finish(1) }',
  '    var child = cp.spawn(npmCommand, npmArgs, { stdio: "ignore", windowsHide: true })',
  '    child.on("error", function () { finish(1) })',
  '    child.on("close", function (code) { finish(code === null ? 1 : code) })',
  '  })()',
  '})()',
].join('\n')

// Marker file recording the outcome of the last deferred install, read (and
// drained) on the next boot to verify what the detached child actually did.
export function installMarkerPath() {
  const home = process.env.DSH_HOME || homedir()
  return join(home, 'tui-dsh-install.json')
}

// Pure argv/options builder for the detached installer; `npm` defaults to
// npmCommand() (the node + npm-cli bootstrap), `markerPath` to
// installMarkerPath(). The install target args are appended here so the
// spawned child receives the complete npm argv. Exposed for tests.
export function deferredInstallSpec(version, parentPid, npm, markerPath) {
  const resolved = npm ?? npmCommand()
  const marker = markerPath ?? installMarkerPath()
  return {
    command: resolved.command,
    args: [
      '-e', DEFERRED_INSTALL_SCRIPT,
      String(parentPid), resolved.command, ...resolved.args,
      'install', '-g', `${DSH_PACKAGE}@${version}`,
      String(version), marker,
    ],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
  }
}

// Spawn the exit-time installer. Detached + unref'd: the child outlives this
// process and never owns the terminal. Returns false when npm cannot be
// located (nothing spawned, nothing recorded).
export function spawnDeferredDshInstall(version, parentPid) {
  const npm = npmCommand()
  if (!npm) return false
  const spec = deferredInstallSpec(version, parentPid, npm)
  try {
    const child = spawn(spec.command, spec.args, spec.options)
    child.unref()
    return true
  } catch {
    return false
  }
}

// fs injectable for tests (existsSync / readFileSync / writeFileSync /
// unlinkSync; default: node fs).
const MARKER_FS = () => ({ existsSync, readFileSync, writeFileSync, unlinkSync })

// Record the outcome of the last dsh install attempt.
export function writeInstallMarker(fs, path, record) {
  const f = fs ?? MARKER_FS()
  try {
    f.writeFileSync(path, JSON.stringify({ requested: record?.requested, code: record?.code, finishedAt: Date.now() }))
  } catch {
    // Unwritable home: the next boot simply has nothing to verify.
  }
}

// Read and drain the marker: returns { requested, code, finishedAt } or null.
// Missing and malformed markers both drain to null — a bad file must never
// wedge the Update page.
export function readInstallMarker(fs, path) {
  const f = fs ?? MARKER_FS()
  const file = path ?? installMarkerPath()
  if (!f.existsSync(file)) return null
  let text
  try { text = f.readFileSync(file, 'utf8') } catch { return null }
  try { f.unlinkSync(file) } catch { /* next write recreates it */ }
  try {
    const record = JSON.parse(text)
    if (record && typeof record === 'object' && typeof record.requested === 'string' && Number.isInteger(record.code)) {
      return { requested: record.requested, code: record.code, finishedAt: record.finishedAt ?? 0 }
    }
  } catch { /* malformed marker */ }
  return null
}

// Evaluate a drained marker against the version live on disk. Returns the
// same shapes as installResultFrom: 'installed' means the deferred install
// landed, 'corrupt' means exit 0 with the wrong version on disk (silent
// hybrid tree), 'failed' means npm itself failed.
export function deferredInstallOutcome(marker, installedVersion) {
  if (!marker) return null
  return installResultFrom({ code: marker.code, stderr: '' }, { version: installedVersion }, marker.requested)
}

// ---- local install detection ---------------------------------------------

// Read the active profile's package.json and report whether dsh-oc-tui is
// installed from a local path / file: reference (which `plugin add` will switch
// to a registry version).
export function tuiInstallIsLocal(profile) {
  try {
    const home = process.env.DSH_HOME || homedir()
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    const dep = manifest?.dependencies?.[TUI_PACKAGE] ?? manifest?.devDependencies?.[TUI_PACKAGE]
    if (typeof dep !== 'string' || dep === '') return false
    return dep.startsWith('file:') || dep.startsWith('link:') || dep.startsWith('.')
      || dep.startsWith('/') || /^[A-Za-z]:/.test(dep)
  } catch {
    return false
  }
}

// The version of this running dsh-oc-tui package (its own package.json).
export function tuiInstalledVersion() {
  return TUI_MANIFEST.version
}

// The dsh install on PATH: version + JS bin entry, or `{ found: false }`.
// Millisecond-scale — no spawn.
export function detectDshInstall() {
  const dshExecutable = findOnPath('dsh')
  if (dshExecutable === undefined) return { found: false }
  try {
    const packagePath = createRequire(resolve(dshExecutable)).resolve(`${DSH_PACKAGE}/package.json`)
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    return { found: true, version: manifest.version ?? null, entry: resolveDshEntry(dshExecutable) }
  } catch {
    return { found: false }
  }
}

function safeRealpath(realpath, path) {
  try { return realpath(path) } catch { return path }
}

// Which profile is this TUI booted under? Priority:
//   1. DSH_TUI_BOOT_PROFILE (injected by the launcher);
//   2. the profile whose node_modules/dsh-oc-tui realpaths to this package root
//      (survives pnpm symlinks);
//   3. the default profile name 'tui'.
// `fs` is injectable for tests (readdirSync / realpathSync / env / homedir).
export function resolveActiveProfile(fs = {}) {
  const env = fs.env ?? process.env
  if (env.DSH_TUI_BOOT_PROFILE) return env.DSH_TUI_BOOT_PROFILE
  const readdir = fs.readdirSync ?? readdirSync
  const realpath = fs.realpathSync ?? realpathSync
  const homeFn = fs.homedir ?? homedir
  const home = env.DSH_HOME || homeFn()
  const profilesDir = join(home, 'profiles')
  const selfRoot = safeRealpath(realpath, PACKAGE_ROOT)
  let entries
  try {
    entries = readdir(profilesDir, { withFileTypes: true })
  } catch {
    return 'tui'
  }
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue
    const candidate = join(profilesDir, entry.name, 'node_modules', TUI_PACKAGE)
    if (safeRealpath(realpath, candidate) === selfRoot) return entry.name
  }
  return 'tui'
}

// ---- item builders (pure) ------------------------------------------------

function infoRow(label, value, extra = {}) {
  return { kind: 'update-info', label, value, disabled: true, ...extra }
}

function statusText(status, error, installed, corrupt, note) {
  if (corrupt) return 'Install damaged — reinstall below'
  if (note) return note
  if (!installed && !status && !error) return '—'
  if (error) return 'Registry check failed: ' + error
  if (!status) return '—'
  if (status.kind === 'available') return 'Update available → ' + status.target
  if (status.kind === 'up-to-date') return 'Up to date'
  return 'No stable release — pick from Versions'
}

// Build the Update page's item rows from a state snapshot (see
// `loadUpdateView` for the shape). Pure so the smoke tests can drive it.
export function buildUpdateItems(state) {
  const items = []
  const pushBlock = (pkg, label, section) => {
    items.push({ kind: 'header', label, value: '', disabled: true })
    const installed = section.installed
    const registry = section.registry
    const status = installed && registry ? updateStatus(installed, registry) : null
    items.push(infoRow('Installed', installed ?? (section.found ? 'unknown' : 'not found on PATH')))
    items.push(infoRow('Latest (npm tag)', registry?.distTags?.latest ?? (section.error ? 'unavailable' : '—')))
    items.push(infoRow('Status', statusText(status, section.error, installed, section.corrupt === true, section.note),
      section.corrupt === true ? { tone: 'error', pkg } : status?.kind === 'available' || section.note ? { tone: 'warning', pkg } : { pkg }))
    items.push({ kind: 'update-versions', label: 'Versions', value: 'Select version…', pkg, disabled: false })
  }
  items.push(infoRow('profile', state.profile))
  pushBlock('dsh', 'dsh (@deepseek-ai/dsh)', state.dsh)
  pushBlock('tui', 'dsh-oc-tui', state.tui)
  items.push({ kind: 'header', label: 'Actions', value: '', disabled: true })
  items.push({ kind: 'update-check', label: 'Check now', value: state.checking ? 'Checking…' : 'Enter', disabled: state.busy === true })
  items.push({
    kind: 'choice',
    ns: 'tui-updates',
    field: 'startupCheck',
    label: 'Startup check',
    value: state.startupCheck ?? 'on',
    options: ['on', 'off'],
    revision: state.startupCheckRevision ?? 0,
    disabled: state.startupCheck === null || state.settingsWritable === false,
  })
  return items
}

// Build the version picker rows for one package, newest first, with the
// dist-tags and the installed marker attached for the renderer to color.
export function buildVersionItems(registry, installed) {
  const versions = Array.isArray(registry?.versions) ? registry.versions.slice() : []
  const distTags = registry?.distTags && typeof registry.distTags === 'object' ? registry.distTags : {}
  const tagsByVersion = new Map()
  for (const [tag, version] of Object.entries(distTags)) {
    if (typeof version !== 'string' || version === '') continue
    if (!tagsByVersion.has(version)) tagsByVersion.set(version, [])
    tagsByVersion.get(version).push(tag)
  }
  versions.sort((a, b) => compareVersions(b, a))
  return versions.map((version) => ({
    kind: 'update-version',
    label: version,
    value: '',
    version,
    tags: tagsByVersion.get(version) ?? [],
    installed: version === installed,
    disabled: false,
  }))
}

// ---- the Update settings loader ------------------------------------------

export async function loadUpdateView(ctx) {
  const settings = ctx.get('settings')
  let updDescriptor
  let startupCheck = 'on'
  let startupCheckRevision = 0
  if (settings) {
    try {
      updDescriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === 'tui-updates')
      startupCheck = updDescriptor?.value?.startupCheck ?? 'on'
      startupCheckRevision = updDescriptor?.revision ?? 0
    } catch {
      updDescriptor = undefined
    }
  }
  const state = {
    profile: resolveActiveProfile(),
    dsh: { found: false, installed: null, entry: undefined, registry: null, error: null },
    tui: { installed: tuiInstalledVersion(), registry: null, error: null },
    startupCheck: settings ? startupCheck : null,
    startupCheckRevision,
    settingsWritable: settings?.writable !== false,
    checking: false,
    busy: false,
  }
  const dshInstall = detectDshInstall()
  state.dsh.found = dshInstall.found
  state.dsh.installed = dshInstall.version ?? null
  // On every Update-page load: consume the deferred-install marker (left by
  // the exit-time installer of a previous run) and, when the TUI boots fine
  // but the manifest mismatches its own files, surface the hybrid-tree state
  // from the 2026-09-04 incident so the user is pointed at a reinstall.
  const marker = readInstallMarker()
  if (marker) {
    const outcome = deferredInstallOutcome(marker, dshInstall.version ?? undefined)
    if (outcome?.kind === 'failed') {
      state.dsh.note = `Deferred install failed (exit ${marker.code}) — retry from Versions`
    } else if (outcome?.kind === 'corrupt') {
      state.dsh.corrupt = true
      state.dsh.note = outcome.reason
    }
    // 'installed' needs no note — the Installed row already shows the version.
  }
  state.dsh.entry = dshInstall.entry
  const [dshResult, tuiResult] = await Promise.all([
    registryInfo(DSH_PACKAGE).then((registry) => ({ registry })).catch((error) => ({ error: error?.message ?? String(error) })),
    registryInfo(TUI_PACKAGE).then((registry) => ({ registry })).catch((error) => ({ error: error?.message ?? String(error) })),
  ])
  state.dsh.registry = dshResult.registry ?? null
  state.dsh.error = dshResult.error ?? null
  state.tui.registry = tuiResult.registry ?? null
  state.tui.error = tuiResult.error ?? null

  return {
    settings,
    items: buildUpdateItems(state),
    title: 'Update',
    subtitle: 'Enter select · installs need a restart to apply',
    menu: SETTINGS_MENU,
    menuIndex: Math.max(0, SETTINGS_MENU.findIndex((entry) => entry.id === 'update')),
    state,
  }
}
