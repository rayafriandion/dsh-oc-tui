import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MUTATING_TOOLS = new Set(['write', 'edit'])

export function contentLabel(content, max = 72) {
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const images = content.filter((block) => block?.type === 'image').length
  if (text.length === 0 && images > 0) return images === 1 ? '[image]' : `[${images} images]`
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

export function listRewindPoints(events) {
  const points = []
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const label = contentLabel(event.data.content) || '(empty)'
    points.push({
      n: points.length + 1,
      seq: event.seq,
      time: event.time,
      label,
    })
  }
  return points
}

export function rewindCut(events, userMessageSeq) {
  const list = events ?? []
  const start = list.findLast((event) => event.type === 'turn/start' && event.seq < userMessageSeq)
  if (start === undefined) return 0
  return eventIndex(list, start.seq)
}

function eventIndex(events, seq) {
  const index = events.findIndex((event) => event.seq === seq)
  return index < 0 ? 0 : index
}

function toolCallPath(event) {
  let args = event?.data?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return ''
    }
  }
  if (!args || typeof args !== 'object') return ''
  const raw = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : ''
  return raw.trim()
}

export function mutationPathsAfter(events, cut) {
  const paths = []
  const seen = new Set()
  for (const event of (events ?? []).slice(cut)) {
    if (event?.type !== 'tool/call') continue
    if (!MUTATING_TOOLS.has(event.data?.name)) continue
    const filePath = toolCallPath(event)
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    paths.push(filePath)
  }
  return paths
}

// Paths whose FIRST recorded mutation sits at or after `cut`. That is the only
// evidence the transcript offers that a file did not already exist before the
// rewind point, which is what removing an untracked file has to rest on.
export function createdPathsAfter(events, cut) {
  const firstSeen = new Map()
  for (const [index, event] of (events ?? []).entries()) {
    if (event?.type !== 'tool/call') continue
    if (!MUTATING_TOOLS.has(event.data?.name)) continue
    const filePath = toolCallPath(event)
    if (!filePath || firstSeen.has(filePath)) continue
    firstSeen.set(filePath, index)
  }
  const created = new Set()
  for (const [filePath, index] of firstSeen) {
    if (index >= cut) created.add(filePath)
  }
  return created
}

export function parseRewindArgs(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  let selector
  let mode
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'conversation' || lower === 'chat' || lower === 'code' || lower === 'files' || lower === 'both') {
      mode = lower === 'chat' ? 'conversation' : lower === 'files' ? 'code' : lower
      continue
    }
    if (selector === undefined) selector = token
  }
  return { selector, mode: mode ?? 'both' }
}

export function resolvePoint(points, selector) {
  if (points.length === 0) throw new Error('no user messages to rewind to')
  if (selector === undefined || selector === '' || selector.toLowerCase() === 'last') {
    return points[points.length - 1]
  }
  if (!/^\d+$/.test(selector)) {
    throw new Error(`unknown rewind point "${selector}" — use a number or last`)
  }
  const n = Number(selector)
  const point = points[n - 1]
  if (!point) throw new Error(`no rewind point ${n} — 1..${points.length}`)
  return point
}

// ---- file restore --------------------------------------------------------
//
// Undoing file writes is the only destructive thing rewind does, so it is
// fenced: it runs only inside a git worktree, every byte it is about to
// overwrite or delete is copied into a backup directory first, and a path whose
// pre-rewind existence cannot be established is never removed. The transcript
// records that a path was *touched*, never its previous content, so a check
// that cannot be made is reported as skipped rather than guessed.

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout?.on('data', (chunk) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk) => { stderr.push(chunk) })
    child.on('error', (error) => {
      resolvePromise({ ok: false, stdout: '', stdoutBuffer: Buffer.alloc(0), stderr: error.message })
    })
    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(stdout)
      resolvePromise({
        ok: code === 0,
        stdout: stdoutBuffer.toString('utf8'),
        // Binary-safe: `git show HEAD:<path>` content is written back verbatim.
        stdoutBuffer,
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

// `<rev>:<path>` takes forward slashes only — git normalizes a backslash
// *pathspec*, but `git show HEAD:src\a.ts` fails with "exists on disk, but not
// in 'HEAD'" — so a Windows relative path is converted before that lookup.
function gitPath(rel) {
  return sep === '/' ? rel : rel.split(sep).join('/')
}

// Whether `cwd` is a git worktree at all. Probed before any mutation so a
// non-repository workspace refuses the restore instead of half-applying it.
export async function canRestoreFiles(cwd) {
  if (!cwd) return false
  const probe = await git(resolve(cwd), ['rev-parse', '--is-inside-work-tree'])
  return probe.ok && probe.stdout.trim() === 'true'
}

// Directory that holds the pre-restore copy of everything a rewind touches,
// under the harness home so it survives the process and never lands in the
// project tree. Created on the first actual backup, so a rewind that touches
// nothing leaves no empty directory behind.
export function backupRootFor(dshHome, sessionId, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return join(dshHome, 'rewind-backups', String(sessionId ?? 'session'), stamp)
}

export async function restoreGitPaths(cwd, paths, { backupRoot = null, createdPaths = null } = {}) {
  const restored = []
  const removed = []
  const skipped = []
  const refuse = (reason) => ({
    ok: false,
    reason,
    restored,
    removed,
    skipped: [...(paths ?? [])],
    backupRoot: null,
  })
  if (!cwd || !Array.isArray(paths) || paths.length === 0) {
    return { ok: true, restored, removed, skipped, backupRoot: null }
  }
  const root = resolve(cwd)
  if (!(await canRestoreFiles(root))) return refuse('not a git worktree')
  if (!backupRoot) return refuse('no backup location')

  let backedUp = false
  const backup = async (abs, rel) => {
    const target = join(backupRoot, rel)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(abs, target)
    backedUp = true
  }

  for (const filePath of paths) {
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath)
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      skipped.push(filePath)
      continue
    }
    const relPath = gitPath(rel)
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', relPath])
    if (tracked.ok) {
      // Restore the worktree from HEAD without staging anything: `git show`
      // rewrites the file, where `git checkout HEAD -- <path>` would also
      // rewrite the index behind the user's back.
      const head = await git(root, ['show', 'HEAD:' + relPath])
      if (!head.ok) {
        skipped.push(rel)
        continue
      }
      try {
        if (existsSync(abs)) await backup(abs, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, head.stdoutBuffer)
        restored.push(rel)
      } catch {
        skipped.push(rel)
      }
      continue
    }
    if (!existsSync(abs)) {
      // Already absent: nothing to undo, and no evidence the turn created it.
      skipped.push(rel)
      continue
    }
    if (!(createdPaths instanceof Set) || !createdPaths.has(filePath)) {
      // The log touched this path before the rewind point too, so it may well
      // predate it: report it and leave it alone rather than guess.
      skipped.push(rel)
      continue
    }
    try {
      await backup(abs, rel)
      await unlink(abs)
      removed.push(rel)
    } catch {
      skipped.push(rel)
    }
  }
  return { ok: true, restored, removed, skipped, backupRoot: backedUp ? backupRoot : null }
}

export function formatRestore(result) {
  if (!result) return 'files not restored'
  if (result.ok === false) return 'files not restored (' + result.reason + ')'
  const bits = []
  if (result.restored.length > 0) bits.push(`restored ${result.restored.length} tracked file(s) from HEAD`)
  if (result.removed.length > 0) bits.push(`removed ${result.removed.length} new file(s)`)
  if (result.skipped.length > 0) bits.push(`skipped ${result.skipped.length}`)
  if (result.backupRoot) bits.push('previous content saved in ' + result.backupRoot)
  return bits.length > 0 ? bits.join(', ') : 'no file changes after this point'
}
