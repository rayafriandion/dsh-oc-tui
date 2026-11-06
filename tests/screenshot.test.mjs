import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context, Service } from '@deepseek-ai/cordis'
import { App } from '../lib/ui.js'
import { Screen, Terminal, decodeKey, makeStyle } from '../lib/term.js'
import { defaultPicturesDirectory, renderScreenshot, saveScreenshot } from '../lib/screenshot.js'
import { TUI_SETTINGS, loadWebSettings, readTuiSetting, saveWebSetting } from '../lib/web-settings.js'
import { setLocale, tv } from '../lib/i18n.js'

process.env.DSH_TUI_LOCALE = 'en'
setLocale('en')
const root = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
process.env.DSH_HOME = root
const output = join(root, 'images')
const oldIn = Object.getOwnPropertyDescriptor(process, 'stdin')
const oldOut = Object.getOwnPropertyDescriptor(process, 'stdout')
const originalPaint = Terminal.prototype.paint
const originalRender = App.prototype.render
const waitFor = async (predicate) => {
  for (let i = 0; i < 160; i++) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the screenshot UI')
}

try {
  assert.equal(decodeKey(Buffer.from([0x13])).key.name, 's')
  assert.equal(decodeKey(Buffer.from([0x13])).key.ctrl, true)
  assert.ok(await defaultPicturesDirectory())

  const screen = new Screen(12, 4)
  screen.clear(makeStyle({ fg: 'ffffff', bg: '112233' }))
  screen.text(0, 0, '中文 & <test>', makeStyle({ fg: 'ff0000', bg: '112233' }))
  const payload = await sharp({ create: { width: 10, height: 20, channels: 4, background: '#00ff00' } }).png().toBuffer()
  screen.images.push({ key: 'sample', x: 4, y: 1, cellsW: 1, cellsH: 1 })
  const png = await renderScreenshot(screen, { title: '<project & 中文>', images: new Map([['sample', { kind: 'sixel', png: payload }]]) })
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], [168, 168])
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]
  assert.equal(pixel(2, 2)[3], 0, 'the outer canvas is transparent')
  assert.deepEqual(pixel(30, 104), [17, 34, 51, 255], 'terminal background is retained')
  assert.deepEqual(pixel(69, 86), [0, 255, 0, 255], 'terminal image payload is included')

  const stamp = new Date('2026-01-02T03:04:05.678Z')
  const first = await saveScreenshot(screen, { directory: output, now: stamp })
  const second = await saveScreenshot(screen, { directory: output, now: stamp })
  assert.notEqual(first, second, 'screenshots taken at the same instant do not overwrite one another')
  assert.equal((await sharp(await readFile(first)).metadata()).format, 'png')
  await assert.rejects(() => saveScreenshot(screen, { directory: join(first, 'child') }))

  // Both settings models must offer an editable row and read its committed value.
  for (const legacy of [true, false]) {
    const fields = Object.fromEntries(TUI_SETTINGS.map(({ configField }) => [configField, '']))
    const records = new Map(legacy ? [['tui-screenshot', { directory: '' }]] : [['tui-app', fields]])
    const settings = {
      writable: true,
      ...(legacy ? { register(ns) { if (!records.has(ns)) records.set(ns, {}) } } : {}),
      describe() { return [...records].map(([ns, value]) => ({ ns, value, revision: 1 })) },
      update(ns, patch) { Object.assign(records.get(ns), patch) },
    }
    const ctx = { get(name) { return name === 'settings' ? settings : undefined } }
    const loaded = await loadWebSettings(ctx)
    const item = loaded.items.find((entry) => entry.label === 'Screenshot folder')
    assert.ok(item && !item.disabled, `${legacy ? 'registry' : 'forms'} exposes the screenshot folder`)
    assert.equal(item.valueLabel, tv('system'))
    await saveWebSetting(ctx, settings, item, output)
    assert.equal(readTuiSetting(ctx, fields, 'tui-screenshot', 'directory'), output)
    await saveWebSetting(ctx, settings, item, '')
    assert.equal(readTuiSetting(ctx, fields, 'tui-screenshot', 'directory'), '')
  }

  const corner = new App({ cols: 40, rows: 16, on() {} })
  corner.showCornerNotice('Screenshot saved', 'C:\\Pictures\\example.png', 'success')
  let painted = corner.render()
  assert.ok(painted.cells[0].map((cell) => cell.ch).join('').includes('Screenshot saved'))
  assert.ok(painted.cells[1].map((cell) => cell.ch).join('').includes('example.png'))
  corner.showCornerNotice('Screenshot failed', 'access denied', 'error')
  painted = corner.render()
  assert.ok(painted.cells[0].map((cell) => cell.ch).join('').includes('Screenshot failed'))
  assert.ok(painted.cells[1].map((cell) => cell.ch).join('').includes('access denied'))

  class FakeIn extends EventEmitter {
    constructor() { super(); this.isTTY = true }
    setRawMode() { return this }
    resume() { return this }
    pause() { return this }
    send(text) { this.emit('data', Buffer.from(text)) }
  }
  class FakeOut extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.columns = 100; this.rows = 30 }
    write() { return true }
  }
  class Agents extends Service {
    constructor(ctx) { super(ctx, 'agents') }
    roots() { return [] }
    get() { return undefined }
  }
  class Commands extends Service { constructor(ctx) { super(ctx, 'commands') } }
  class Persistence extends Service { constructor(ctx) { super(ctx, 'sessionPersistence') } }
  class Startup extends Service { constructor(ctx) { super(ctx, 'tuiStartup') } }
  class Settings extends Service {
    constructor(ctx) {
      super(ctx, 'settings')
      this.writable = true
      this.records = new Map([['tui-screenshot', { directory: '' }]])
    }
    register(ns) { if (!this.records.has(ns)) this.records.set(ns, {}) }
    describe() { return [...this.records].map(([ns, value]) => ({ ns, value, revision: 1 })) }
    update(ns, patch) { Object.assign(this.records.get(ns), patch); return Promise.resolve() }
  }
  const stdin = new FakeIn()
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: new FakeOut(), configurable: true })
  const frames = []
  let liveApp
  App.prototype.render = function (...args) {
    liveApp = this
    return originalRender.apply(this, args)
  }
  Terminal.prototype.paint = function (frame) {
    frames.push(frame.cells.map((row) => row.map((cell) => cell.ch).join('')))
    return originalPaint.call(this, frame)
  }
  const ctx = new Context()
  new Agents(ctx); new Commands(ctx); new Persistence(ctx); new Startup(ctx)
  const settings = new Settings(ctx)
  const plugin = await import('../lib/index.js')
  await ctx.plugin({ apply: plugin.apply, inject: plugin.inject, name: plugin.name }, {})
  await waitFor(() => frames.length > 0)
  stdin.send('\x10')
  await waitFor(() => liveApp?.overlay === 'settings')
  const row = liveApp.settingsItems.findIndex((item) => item.label === 'Screenshot folder')
  assert.ok(row >= 0, 'the screenshot folder is available in the real settings dialog')
  for (let i = 0; i <= liveApp.settingsItems.length && liveApp.settingsSelection !== row; i++) {
    stdin.send('\x1b[B')
  }
  assert.equal(liveApp.settingsSelection, row)
  stdin.send('\x1b[200~' + output + '\x1b[201~')
  assert.equal(liveApp.settingsDraft, output)
  stdin.send('\r')
  await waitFor(() => settings.records.get('tui-screenshot').directory === output)
  stdin.send('\x1b')
  await waitFor(() => liveApp.overlay !== 'settings')
  const filesBefore = new Set(await readdir(output))
  stdin.send('\x13')
  await waitFor(() => frames.at(-1)?.[0].includes('Screenshot saved'))
  const newFiles = (await readdir(output)).filter((name) => !filesBefore.has(name))
  assert.equal(newFiles.length, 1, 'Ctrl+S writes a PNG from the live plugin')
  const titleArea = { left: 94, top: 25, width: 300, height: 38 }
  const actualTitle = await sharp(await readFile(join(output, newFiles[0]))).extract(titleArea).raw().toBuffer()
  const expectedPng = await renderScreenshot(new Screen(100, 30), { title: 'Deepseek Harness TUI' })
  const expectedTitle = await sharp(expectedPng).extract(titleArea).raw().toBuffer()
  assert.deepEqual(actualTitle, expectedTitle, 'the live screenshot uses the fixed window title')
  assert.ok(frames.at(-1)[1].includes('.png'), 'the result is shown in the top-right corner')

  const notDirectory = join(root, 'not-a-directory')
  await writeFile(notDirectory, 'x')
  settings.records.get('tui-screenshot').directory = notDirectory
  stdin.send('\x13')
  await waitFor(() => frames.at(-1)?.[0].includes('Screenshot failed'))
  assert.ok(frames.at(-1)[1].trim().length > 0, 'the failure notice includes an error')

} finally {
  App.prototype.render = originalRender
  Terminal.prototype.paint = originalPaint
  Object.defineProperty(process, 'stdin', oldIn)
  Object.defineProperty(process, 'stdout', oldOut)
  await rm(root, { recursive: true, force: true })
}
console.log('screenshot tests passed')
process.exit(0)
