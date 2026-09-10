import { spawn } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const MUTATING_TOOLS = new Set(['write', 'edit'])

export function contentLabel(content, max = 72) {
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
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

export function mutationPathsAfter(events, cut) {
  const paths = []
  const seen = new Set()
  for (const event of (events ?? []).slice(cut)) {
    if (event?.type !== 'tool/call') continue
    if (!MUTATING_TOOLS.has(event.data?.name)) continue
    let args = event.data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    if (!args || typeof args !== 'object') continue
    const raw = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : ''
    const filePath = raw.trim()
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    paths.push(filePath)
  }
  return paths
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

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      resolvePromise({ ok: false, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, stdout, stderr })
    })
  })
}

export async function restoreGitPaths(cwd, paths) {
  const restored = []
  const deleted = []
  const skipped = []
  if (!cwd || paths.length === 0) return { restored, deleted, skipped }
  const root = resolve(cwd)
  for (const filePath of paths) {
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath)
    const rel = relative(root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      skipped.push(filePath)
      continue
    }
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', rel])
    if (tracked.ok) {
      const checkout = await git(root, ['checkout', 'HEAD', '--', rel])
      if (checkout.ok) restored.push(rel)
      else skipped.push(rel)
      continue
    }
    try {
      await unlink(abs)
      deleted.push(rel)
    } catch {
      skipped.push(rel)
    }
  }
  return { restored, deleted, skipped }
}

export function formatRestore(result) {
  const bits = []
  if (result.restored.length > 0) bits.push(`restored ${result.restored.length} tracked`)
  if (result.deleted.length > 0) bits.push(`removed ${result.deleted.length} untracked`)
  if (result.skipped.length > 0) bits.push(`skipped ${result.skipped.length}`)
  return bits.length > 0 ? bits.join(', ') : 'no file changes after this point'
}
