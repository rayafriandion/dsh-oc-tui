// In-app update manager for dsh and dsh-oc-tui. Every network/package-manager
// interaction is concentrated here (async spawn plus a streaming fetch, never a
// blocking install), so the rest of the plugin only wires results into the
// settings UI. Version comparison is deliberately dependency-free:
// major.minor.patch numerics plus a pre-release segment.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

export function npmCommand() {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] }
  const onPath = findOnPath('npm')
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

// The dsh executable on PATH (an npm shim on Windows). The applier uses it to
// re-resolve the dsh bin entry *after* a dsh update, so a layout change in the
// new version cannot break the relaunch.
export function dshShimPath() {
  return findOnPath('dsh') ?? null
}

// Args the running dsh was started with (everything after its bin entry) — the
// relaunch replays them verbatim so `--profile tui --resume` survives.
export function dshProcessArgs() {
  return process.argv.slice(2)
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
// `manifest` is the freshly-read package.json object, or null/undefined when
// it cannot be read at all (also corrupt: the install should never end with
// the package gone). `repair` overrides the repair hint for the TUI package,
// which is repaired through the profile rather than through npm.
export function installResultFrom(spawnResult, manifest, requestedVersion, repair) {
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
      reason: `install reported success but the installed version is ${installed ?? 'unreadable'} (expected ${requestedVersion}) — repair: ${repair ?? `fully close dsh, then npm install -g ${DSH_PACKAGE}@${requestedVersion}`}`,
    }
  }
  return { kind: 'installed', code, stderr, reason: '' }
}

// ---- download, stage, restart (the whole update path) ---------------------
//
// Updating never installs inline. The TUI downloads the registry tarball
// itself — so the user watches real byte progress instead of a spinner — and
// stages it under $DSH_HOME/updates, recording what is staged in `staged.json`.
// Applying is a *restart*: this process exits, and a detached applier child
// (bin/apply-update.cjs) waits for it to die, installs from the staged tarball,
// verifies the on-disk version, writes the install marker, then relaunches dsh
// in the same terminal. Two properties fall out of that shape:
//
//   * the install never runs while this process holds the files, so the Windows
//     self-update hazard (npm exiting 0 over a hybrid old/new tree) cannot be
//     triggered from inside the TUI — the exit *is* the handoff;
//   * the staged tarball stays on disk, so a rollback to an older version is a
//     verified cache hit through exactly the same code path as an update.

const DSH_REGISTRY = 'https://registry.npmjs.org'
const METADATA_TIMEOUT_MS = 30_000

// ---- byte / progress formatting (pure) -----------------------------------

// Human-readable byte count: bytes below 1 KiB, then one decimal that drops to
// zero above 100, so '1.2 GB' and '120 GB' both fit a narrow row.
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
}

// Progress text for a running download. An unknown total (no content-length,
// chunked transfer) reports bytes only — never an invented percentage.
export function formatDownloadProgress(received, total) {
  const got = Number.isFinite(Number(received)) ? Math.max(0, Number(received)) : 0
  const want = Number(total)
  if (!Number.isFinite(want) || want <= 0) return { text: formatBytes(got), percent: null }
  const percent = Math.max(0, Math.min(100, Math.round((got / want) * 100)))
  return { text: formatBytes(got) + ' / ' + formatBytes(want) + ' · ' + percent + '%', percent }
}

// ---- staging paths -------------------------------------------------------

// Cache file name prefix for a package: `deepseek-ai-dsh-`, `dsh-oc-tui-`.
function tarballPrefix(pkg) {
  return String(pkg ?? '').replace(/^@/, '').replace(/[/\\]/g, '-') + '-'
}

// One flat cache file per package + version: `deepseek-ai-dsh-0.2.0-rc.2.tgz`,
// `dsh-oc-tui-0.1.4.tgz`.
export function tarballFileName(pkg, version) {
  return tarballPrefix(pkg) + String(version ?? '') + '.tgz'
}

export function updateCacheDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'updates')
}

export function tarballCachePath(pkg, version) {
  return join(updateCacheDir(), tarballFileName(pkg, version))
}

// The record of a downloaded-but-not-applied install.
export function stagedInstallPath() {
  return join(updateCacheDir(), 'staged.json')
}

const STAGED_FS = () => ({ existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync })

export function writeStagedInstall(fs, path, record) {
  const f = fs ?? STAGED_FS()
  try {
    if (typeof f.mkdirSync === 'function') f.mkdirSync(dirname(path), { recursive: true })
    f.writeFileSync(path, JSON.stringify(record))
    return true
  } catch {
    return false // unwritable home: the restart row simply never appears
  }
}

// Read the staged install, or null. A record whose tarball is gone (the user
// cleaned the cache) drains to null — a stale row must not offer a restart that
// cannot work.
export function readStagedInstall(fs, path) {
  const f = fs ?? STAGED_FS()
  const file = path ?? stagedInstallPath()
  try {
    if (!f.existsSync(file)) return null
    const record = JSON.parse(f.readFileSync(file, 'utf8'))
    if (!record || typeof record !== 'object') return null
    if (typeof record.pkg !== 'string') return null
    if (record.pkg !== 'dsh' && record.pkg !== 'tui') return null
    if (typeof record.version !== 'string' || record.version === '') return null
    if (typeof record.tarball !== 'string' || record.tarball === '') return null
    if (!f.existsSync(record.tarball)) return null
    return record
  } catch {
    return null
  }
}

export function clearStagedInstall(fs, path) {
  const f = fs ?? STAGED_FS()
  try { f.unlinkSync(path ?? stagedInstallPath()) } catch { /* nothing staged */ }
}

// Versions already downloaded for one package — the rollback cache.
export function cachedTarballVersions(pkg) {
  const prefix = tarballPrefix(pkg)
  try {
    return new Set(readdirSync(updateCacheDir())
      .filter((name) => name.startsWith(prefix) && name.endsWith('.tgz'))
      .map((name) => name.slice(prefix.length, -'.tgz'.length)))
  } catch {
    return new Set()
  }
}

// ---- registry metadata + streaming download ------------------------------

// The tarball URL and integrity hash for one exact version, from the
// abbreviated registry document (`…/<pkg>/<version>` — a few hundred bytes,
// unlike the full packument).
export async function registryTarball(pkg, version) {
  const url = DSH_REGISTRY + '/' + pkg + '/' + encodeURIComponent(version)
  let response
  try {
    // No custom Accept header: the registry answers the plain JSON request
    // with the full version document, and a packument-specific media type
    // earns a 406.
    response = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
  } catch (error) {
    throw new Error('registry unreachable: ' + (error?.message ?? String(error)))
  }
  if (response.status === 404) throw new Error(pkg + '@' + version + ' is not on the registry')
  if (!response.ok) throw new Error('registry returned HTTP ' + response.status + ' for ' + pkg + '@' + version)
  const doc = await response.json()
  const tarball = doc?.dist?.tarball
  if (typeof tarball !== 'string' || tarball === '') throw new Error('registry response carries no tarball URL')
  return { tarball, integrity: typeof doc?.dist?.integrity === 'string' ? doc.dist.integrity : null }
}

// Compare a computed sha512 (base64) against a registry `dist.integrity`. An
// absent or non-sha512 value reports `checked: false` — every npm-published
// tarball we care about is sha512.
export function checkIntegrity(sha512Base64, integrity) {
  if (typeof integrity !== 'string' || integrity.trim() === '') return { ok: true, checked: false }
  const m = /^sha512-(.+)$/i.exec(integrity.trim())
  if (!m) return { ok: true, checked: false }
  return { ok: m[1] === sha512Base64, checked: true }
}

// Stream a tarball to disk, reporting progress. `signal` aborts (Esc in the
// UI); a failed download leaves no partial file behind.
export async function downloadTarball(url, destPath, options = {}) {
  const { onProgress, signal } = options
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('download failed: HTTP ' + response.status + ' for ' + url)
  const length = Number(response.headers?.get?.('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : null
  const body = response.body
  if (!body) throw new Error('download failed: empty response body')
  const chunks = []
  let received = 0
  let lastReport = 0
  const report = (force) => {
    if (typeof onProgress !== 'function') return
    const now = Date.now()
    if (!force && now - lastReport < 100) return
    lastReport = now
    try {
      onProgress({
        received,
        total,
        percent: total === null ? null : Math.max(0, Math.min(100, Math.round((received / total) * 100))),
      })
    } catch { /* a repaint must never kill the download */ }
  }
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    chunks.push(chunk)
    received += chunk.length
    report(false)
  }
  const data = Buffer.concat(chunks)
  report(true)
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath + '.part', data)
  renameSync(destPath + '.part', destPath)
  return { bytes: received, sha512: createHash('sha512').update(data).digest('base64') }
}

// Download one exact version into the cache and record it as staged. A tarball
// already in the cache is integrity-checked and reused, so a cache hit cannot
// resurrect a corrupt file — that is what makes a rollback instant.
export async function stageInstall(input = {}) {
  const { pkg, version, profile, cwd, onProgress, signal } = input
  const packageName = pkg === 'tui' ? TUI_PACKAGE : DSH_PACKAGE
  const cache = tarballCachePath(packageName, version)
  const meta = await registryTarball(packageName, version)
  let bytes = 0
  let cached = false
  if (existsSync(cache)) {
    const data = readFileSync(cache)
    bytes = data.length
    if (checkIntegrity(createHash('sha512').update(data).digest('base64'), meta.integrity).ok) cached = true
    else { try { unlinkSync(cache) } catch { /* re-downloaded below */ } }
  }
  if (!cached) {
    const result = await downloadTarball(meta.tarball, cache, { onProgress, signal })
    bytes = result.bytes
    const check = checkIntegrity(result.sha512, meta.integrity)
    if (!check.ok) {
      try { unlinkSync(cache) } catch { /* nothing else to clean */ }
      throw new Error('integrity check failed for ' + packageName + '@' + version + ' — download discarded')
    }
  } else if (typeof onProgress === 'function') {
    try { onProgress({ received: bytes, total: bytes, percent: 100 }) } catch { /* ignore */ }
  }
  const record = {
    pkg,
    packageName,
    version,
    tarball: cache,
    url: meta.tarball,
    integrity: meta.integrity,
    bytes,
    cached,
    profile: profile ?? 'tui',
    cwd: cwd ?? process.cwd(),
    finishedAt: Date.now(),
  }
  writeStagedInstall(null, stagedInstallPath(), record)
  return record
}

// ---- manifest paths the applier verifies ---------------------------------

// The on-disk manifest of the global dsh install, or null when dsh is not on
// PATH. The applier re-reads it *after* installing: npm's exit code alone is
// not proof (2026-09-04 hybrid-tree incident).
export function dshManifestPath() {
  const shim = findOnPath('dsh')
  if (shim === undefined) return null
  try {
    return createRequire(resolve(shim)).resolve(DSH_PACKAGE + '/package.json')
  } catch {
    return null
  }
}

// The installed copy of this plugin inside one profile (a junction into
// .pnpm — reading the manifest through it is fine).
export function tuiInstalledManifestPath(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', profile ?? 'tui', 'node_modules', TUI_PACKAGE, 'package.json')
}

// ---- restart plan + applier spawn ----------------------------------------

// Marker file recording the outcome of the last restart-applied install, read
// (and drained) on the next boot to verify what the detached child did.
export function installMarkerPath() {
  const home = process.env.DSH_HOME || homedir()
  return join(home, 'tui-dsh-install.json')
}

// Plain data describing what the detached applier must do. Pure builder: the
// tests drive it without touching the filesystem; `spawnApplyUpdater` persists
// it as a file (restartPlanPath) and hands that file to the applier.
export function restartPlan(input = {}) {
  return {
    parentPid: Number(input.parentPid ?? process.pid),
    pkg: input.pkg,
    packageName: input.packageName ?? (input.pkg === 'tui' ? TUI_PACKAGE : DSH_PACKAGE),
    version: input.version,
    tarball: input.tarball,
    profile: input.profile ?? 'tui',
    cwd: input.cwd ?? process.cwd(),
    verifyPath: input.verifyPath ?? null,
    marker: input.marker ?? installMarkerPath(),
    npm: input.npm ?? npmCommand() ?? null,
    dsh: input.dsh ?? null,
    dshShim: input.dshShim ?? dshShimPath(),
    dshArgs: input.dshArgs ?? dshProcessArgs(),
    relaunch: input.relaunch ?? null,
  }
}

// The shipped applier script, resolved from this package's root.
export function applierPath() {
  return join(PACKAGE_ROOT, 'bin', 'apply-update.cjs')
}

// The plan is handed over as a file, not an argv blob: it stays inspectable
// after the fact (a failed install is much easier to diagnose), and it cannot
// hit a command-line length limit.
export function restartPlanPath() {
  return join(updateCacheDir(), 'restart-plan.json')
}

export function writeRestartPlan(fs, path, plan) {
  const f = fs ?? STAGED_FS()
  try {
    if (typeof f.mkdirSync === 'function') f.mkdirSync(dirname(path), { recursive: true })
    f.writeFileSync(path, JSON.stringify(plan))
    return true
  } catch {
    return false
  }
}

// Spawn spec for the applier: `node bin/apply-update.cjs <plan.json>`.
// Detached so it outlives this process, stdio inherited so the install runs in
// the user's own terminal and the relaunched TUI reopens there.
export function restartSpec(plan, planPath) {
  return {
    command: process.execPath,
    args: [applierPath(), planPath ?? restartPlanPath()],
    options: { detached: true, stdio: 'inherit', windowsHide: false },
  }
}

// Spawn the applier and let it go. Returns false when it cannot be spawned (or
// the script is missing) so the caller can report instead of exiting quietly.
export function spawnApplyUpdater(plan, planPath) {
  const file = planPath ?? restartPlanPath()
  if (!existsSync(applierPath())) return false
  if (!writeRestartPlan(null, file, plan)) return false
  const spec = restartSpec(plan, file)
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
    f.writeFileSync(path, JSON.stringify({
      requested: record?.requested,
      // The marker is shared by both packages; 'dsh' is the default so a marker
      // written by an older build still routes somewhere sane.
      pkg: record?.pkg === 'tui' ? 'tui' : 'dsh',
      code: record?.code,
      finishedAt: Date.now(),
    }))
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
      return {
        requested: record.requested,
        code: record.code,
        finishedAt: record.finishedAt ?? 0,
        // 'dsh' unless the applier said otherwise: the marker is shared by both
        // packages, and the next boot must check the right one on disk.
        pkg: record.pkg === 'tui' ? 'tui' : 'dsh',
      }
    }
  } catch { /* malformed marker */ }
  return null
}

// Evaluate a drained marker against the version live on disk. Returns the
// same shapes as installResultFrom: 'installed' means the deferred install
// landed, 'corrupt' means exit 0 with the wrong version on disk (silent
// hybrid tree), 'failed' means npm itself failed.
export function deferredInstallOutcome(marker, installedVersion, repair) {
  if (!marker) return null
  return installResultFrom({ code: marker.code, stderr: '' }, { version: installedVersion }, marker.requested, repair)
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
    // A downloaded-but-unapplied install waits here: one Enter restarts and
    // applies it, the second row drops the staged tarball again.
    const staged = state.staged && state.staged.pkg === pkg ? state.staged : null
    if (staged) {
      items.push({
        kind: 'update-restart',
        label: 'Restart to apply ' + staged.version,
        value: 'Enter restart',
        pkg,
        staged,
        tone: 'warning',
        disabled: false,
      })
      items.push({ kind: 'update-discard', label: 'Discard downloaded ' + staged.version, value: 'Enter', pkg, staged, disabled: false })
    }
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
// `options.cached` (a Set or a predicate) marks versions whose tarball is
// already on disk — a rollback to one of them needs no download; `staged`
// marks the version waiting to be applied on the next restart.
export function buildVersionItems(registry, installed, options = {}) {
  const isCached = typeof options.cached === 'function'
    ? options.cached
    : (options.cached instanceof Set ? (version) => options.cached.has(version) : () => false)
  const versions = Array.isArray(registry?.versions) ? registry.versions.slice() : []
  const distTags = registry?.distTags && typeof registry.distTags === 'object' ? registry.distTags : {}
  const tagsByVersion = new Map()
  for (const [tag, version] of Object.entries(distTags)) {
    if (typeof version !== 'string' || version === '') continue
    if (!tagsByVersion.has(version)) tagsByVersion.set(version, [])
    tagsByVersion.get(version).push(tag)
  }
  versions.sort((a, b) => compareVersions(b, a))
  const stagedVersion = typeof options.staged === 'string' ? options.staged : null
  return versions.map((version) => {
    const tags = [...(tagsByVersion.get(version) ?? [])]
    if (isCached(version)) tags.push('cached')
    if (version === stagedVersion) tags.push('staged')
    return {
      kind: 'update-version',
      label: version,
      value: '',
      version,
      tags,
      installed: version === installed,
      cached: isCached(version),
      staged: version === stagedVersion,
      disabled: false,
    }
  })
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
    // A tarball downloaded but not applied yet (this run or a previous one).
    staged: null,
    startupCheck: settings ? startupCheck : null,
    startupCheckRevision,
    settingsWritable: settings?.writable !== false,
    checking: false,
    busy: false,
  }
  const dshInstall = detectDshInstall()
  state.dsh.found = dshInstall.found
  state.dsh.installed = dshInstall.version ?? null
  // On every Update-page load: consume the install marker the applier left
  // behind and, when the TUI boots fine but the manifest mismatches its own
  // files, surface the hybrid-tree state from the 2026-09-04 incident so the
  // user is pointed at a reinstall. The marker says which package it belongs
  // to, so a TUI install is checked against the profile, not against dsh.
  const marker = readInstallMarker()
  if (marker) {
    const section = marker.pkg === 'tui' ? state.tui : state.dsh
    const installed = marker.pkg === 'tui' ? state.tui.installed ?? undefined : dshInstall.version ?? undefined
    const outcome = deferredInstallOutcome(marker, installed,
      marker.pkg === 'tui' ? 'open Update → dsh-oc-tui → Versions, then pick a version to download again' : undefined)
    if (outcome?.kind === 'failed') {
      section.note = `Install failed (exit ${marker.code}) — retry from Versions`
    } else if (outcome?.kind === 'corrupt') {
      section.corrupt = true
      section.note = outcome.reason
    }
    // 'installed' needs no note — the Installed row already shows the version.
  }
  state.dsh.entry = dshInstall.entry
  state.staged = readStagedInstall()
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
    subtitle: state.staged
      ? state.staged.packageName + ' ' + state.staged.version + ' downloaded — restart to apply'
      : 'Enter select · download, then restart to apply',
    menu: SETTINGS_MENU,
    menuIndex: Math.max(0, SETTINGS_MENU.findIndex((entry) => entry.id === 'update')),
    state,
  }
}
