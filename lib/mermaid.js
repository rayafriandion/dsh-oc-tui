// Mermaid diagram rendering provider chain. The TUI plugin cannot bundle a
// browser (mermaid-cli drags in puppeteer, ~300MB), so rendering goes through
// whatever is available, best first:
//
//   1. `mmdc` on PATH (user-installed mermaid-cli) — local, offline, private.
//      Emits SVG; sharp rasterizes it at the requested pixel width.
//   2. mermaid.ink — zero-install; the diagram text is sent to a public
//      service, so this provider is gated by the `mermaid` setting.
//   Fallback: the caller renders the source as a highlighted code block.
//
// `mode` mirrors the setting: 'auto' (default) tries local then network,
// 'local' never touches the network, 'off' renders nothing.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INK_TIMEOUT_MS = 10000
const MMDC_TIMEOUT_MS = 30000
const MAX_DIAGRAM_BYTES = 8 * 1024 * 1024

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

// Deterministic cache file name for a diagram (encoded diagrams are long and
// URL-unsafe; a content hash keeps the cache dir tidy and stable).
//
// The requested pixel width is part of the key: the same diagram rendered for a
// narrow terminal is a different raster from the one a wide terminal asks for,
// and serving the narrow file to the wide terminal would draw a diagram at half
// the width of the space reserved for it.
export function mermaidCachePath(code, pxWidth) {
  const width = pxWidth ? ':' + Math.round(pxWidth) : ''
  return sha1('mermaid:' + code + width).slice(0, 24) + '.png'
}

function spawnWithTimeout(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export function createMermaidRenderer({ fetch: fetchImpl = globalThis.fetch, mode = 'auto', cacheDir = join(tmpdir(), 'dsh-oc-tui', 'mermaid'), sharp: injectedSharp } = {}) {
  // `mode` may be a function so the setting is read live (the TUI's mermaid
  // choice can change mid-session from the settings dialog).
  const modeOf = typeof mode === 'function' ? mode : () => mode
  // Successful renders are cached in memory for the process lifetime — the
  // same diagram renders once even when the transcript re-materializes it on
  // every scroll. Failures are not cached: a network blip should not poison
  // the diagram for the session.
  const memory = new Map()
  let mmdcAvailable = null // tri-state memo for the PATH probe

  async function renderViaMmdc(code, { pxWidth }) {
    if (mmdcAvailable === null) {
      mmdcAvailable = await spawnWithTimeout('mmdc', ['--version'], 5000)
    }
    if (!mmdcAvailable) return null
    const sharp = injectedSharp ?? (await import('sharp')).default
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oc-tui-mmdc-'))
    try {
      const src = join(dir, 'diagram.mmd')
      const out = join(dir, 'diagram.svg')
      await writeFile(src, code, 'utf8')
      const okRun = await spawnWithTimeout('mmdc', ['-i', src, '-o', out, '-b', 'transparent'], MMDC_TIMEOUT_MS)
      if (!okRun) return null
      const svg = await readFile(out)
      const png = await sharp(svg, { density: Math.max(72, Math.round(72 * (pxWidth ?? 800) / 800)) })
        .resize({ width: Math.min(pxWidth ?? 800, 2000) })
        .png()
        .toBuffer()
      return { bytes: png, mediaType: 'image/png' }
    } catch {
      return null
    } finally {
      void rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function renderViaInk(code, { pxWidth }) {
    if (typeof fetchImpl !== 'function') return null
    const encoded = Buffer.from(code, 'utf8').toString('base64url')
    // `width` is the ink service's own pixel hint; without it the diagram comes
    // back at the service's default and is downscaled here for no reason.
    const width = Math.min(2000, Math.max(64, Math.round(pxWidth ?? 800)))
    const url = 'https://mermaid.ink/img/' + encoded + '?type=png&width=' + width
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(INK_TIMEOUT_MS) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_DIAGRAM_BYTES) return null
    return { bytes: buf, mediaType: 'image/png' }
  }

  return async function render(code, { pxWidth } = {}) {
    const effectiveMode = modeOf()
    if (effectiveMode === 'off') return null
    code = String(code ?? '')
    if (code.trim() === '') return null
    // Width is part of the memory key for the same reason it is part of the
    // file name: a resize asks for a different raster.
    const memoKey = code + '\u0000' + (pxWidth ?? 0)
    const cached = memory.get(memoKey)
    if (cached) return cached

    let result = null
    const cacheFile = cacheDir ? join(cacheDir, mermaidCachePath(code, pxWidth)) : null
    // Disk before any provider. A diagram this machine already rendered is a
    // file read; going to the network first made every session pay for a fresh
    // render of diagrams that were sitting on disk, and sent the diagram text
    // to a public service for nothing.
    if (cacheFile) {
      try {
        const bytes = await readFile(cacheFile)
        if (bytes.length > 0) result = { bytes, mediaType: 'image/png' }
      } catch { /* no cached file */ }
    }
    if (!result && (effectiveMode === 'auto' || effectiveMode === 'local')) {
      result = await renderViaMmdc(code, { pxWidth })
    }
    if (!result && (effectiveMode === 'auto' || effectiveMode === 'network')) {
      try {
        result = await renderViaInk(code, { pxWidth })
      } catch { /* offline or blocked; fall through */ }
    }
    if (result) {
      memory.set(memoKey, result)
      if (cacheFile) {
        // The cache directory is created on first write: it does not exist on a
        // fresh install, and a write into a missing directory fails silently —
        // which is how the disk cache went unused on every run.
        void mkdir(cacheDir, { recursive: true })
          .then(() => writeFile(cacheFile, result.bytes))
          .catch(() => { /* best-effort disk cache */ })
      }
    }
    return result
  }
}
