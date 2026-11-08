// Media pipeline: the caches that stand between a diagram or an image and the
// terminal must key on the geometry they were built for, and the disk cache
// must actually be reachable.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMermaidRenderer, mermaidCachePath } from '../lib/mermaid.js'
import { App } from '../lib/ui.js'
import { getTheme } from '../lib/themes.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('ok   ' + name)
  else { failed++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-media-'))

// ---- mermaid: the disk cache is created on first write --------------------
// The cache directory does not exist on a fresh install. A write into a missing
// directory fails, and the failure was swallowed, so every run re-rendered every
// diagram and no cross-session cache ever appeared.
{
  const cacheDir = path.join(tmpRoot, 'never', 'existed', 'mermaid')
  let calls = 0
  const r = createMermaidRenderer({
    fetch: async () => { calls++; return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer } },
    mode: 'network',
    cacheDir,
  })
  ok('the cache directory starts absent', !fs.existsSync(cacheDir))
  await r('graph TD; A-->B', { pxWidth: 400 })
  // The write is fire-and-forget; give it a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 100))
  ok('the render created the cache directory', fs.existsSync(cacheDir))
  ok('the render wrote a cache file', fs.existsSync(path.join(cacheDir, mermaidCachePath('graph TD; A-->B', 400))))

  // A second renderer with the same cache dir answers from disk, no network.
  const before = calls
  const diskOnly = createMermaidRenderer({ fetch: async () => { calls++; return { ok: false } }, mode: 'network', cacheDir })
  const fromDisk = await diskOnly('graph TD; A-->B', { pxWidth: 400 })
  ok('a later session reads the cached render', fromDisk !== null && Buffer.from(fromDisk.bytes).toString().startsWith('PNG'))
  ok('the disk hit issued no request', calls === before)
}

// ---- mermaid: width is part of both cache keys -----------------------------
// A diagram rendered for a narrow terminal is a different raster from the same
// diagram at a wider one; serving the narrow file draws it at half the width of
// the space reserved for it.
{
  const cacheDir = path.join(tmpRoot, 'widths')
  const calls = []
  const r = createMermaidRenderer({
    fetch: async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer } },
    mode: 'network',
    cacheDir,
  })
  await r('graph LR; A-->B', { pxWidth: 400 })
  await r('graph LR; A-->B', { pxWidth: 400 })
  ok('the same width hits the memory cache', calls.length === 1)
  await r('graph LR; A-->B', { pxWidth: 800 })
  ok('a new width is a new render', calls.length === 2, 'calls=' + calls.length)
  ok('the width reaches the ink provider', calls[1].includes('width=800'))
  ok('cache paths differ per width', mermaidCachePath('x', 400) !== mermaidCachePath('x', 800))
  ok('a cache path without a width is unchanged', mermaidCachePath('x') === mermaidCachePath('x'))
}

// ---- images: a resize invalidates the rendered payload --------------------
// The raster is scaled to a cell grid. After the transcript gets wider the old
// render draws at the old width, so it has to be treated as stale.
{
  const app = new App({ cols: 100, rows: 30, on() {} })
  app.setSession({ id: 's', title: 'Media' })
  let requests = 0
  app.onImageRequest = () => { requests++ }
  app._lastTransWidth = 100
  const src = { kind: 'bytes', key: 'k1', bytes: Buffer.from('x') }
  const block = { kind: 'assistant', rev: 1 }
  const out = []

  app._imageLines(src, block, 100, out)
  ok('the first frame asks for a render', requests === 1)
  app.setImageResult('k1', { state: 'done', protocol: 'halfblock', cellsW: 10, cellsH: 4, segLines: [] })

  out.length = 0
  app._imageLines(src, block, 100, out)
  ok('the same width reuses the render', requests === 1)

  // Same width, so the signature is unchanged.
  const sig = app.imageRenderSignature()
  ok('the signature names the grid', typeof sig === 'string' && sig.includes('halfblock'))

  app._lastTransWidth = 60
  out.length = 0
  app._imageLines(src, block, 60, out)
  ok('a narrower frame asks again', requests === 2, 'requests=' + requests)

  app.setImageResult('k1', { state: 'done', protocol: 'halfblock', cellsW: 6, cellsH: 4, segLines: [] })
  out.length = 0
  app._imageLines(src, block, 60, out)
  ok('the re-render is not requested twice for the same width', requests === 2)

  // A result that arrives for the old geometry must not be taken as current:
  // the signature is the one it was requested under.
  app._lastTransWidth = 40
  out.length = 0
  app._imageLines(src, block, 40, out)
  ok('a third width asks again', requests === 3)
  // The stamp must describe the geometry the render was asked for, not whatever
  // the app happens to be at when it lands: a resize mid-render has to leave
  // the result stale, or the new frame would adopt a raster for the old grid.
  const pendingSig = app._imagePendingSig.get('k1')
  app._lastTransWidth = 30
  ok('the in-flight request remembers its geometry', pendingSig !== undefined && pendingSig !== app.imageRenderSignature())

  // A palette switch while the old image is still loading must issue a new
  // request: halfblock transparency is composited over the theme background.
  app.setTheme('dracula')
  out.length = 0
  app._imageLines(src, block, 30, out)
  ok('a theme switch requests a fresh render even while one is loading',
    requests === 4 && app.imageRenderOptions().bgHex === getTheme('dracula').background, 'requests=' + requests)
}

console.log(failed === 0 ? '\nall media tests passed' : `\n${failed} media assertion(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
