// Real rc.5 services, session log and agent loop, driven through the TUI's TTY.
// Only the LLM transport and startup arguments are fixtures; no network or keys.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hostRuntime } from './host-runtime.mjs'

const host = hostRuntime()
if (host?.version !== '0.2.2-rc.5') {
  console.log('skip host-live tests (requires dsh 0.2.2-rc.5)')
  process.exit(0)
}
const root = process.env.DSH_TUI_TEST_ROOT ? pathToFileURL(resolve(process.env.DSH_TUI_TEST_ROOT) + '/').href : new URL('../', import.meta.url).href
const home = mkdtempSync(join(tmpdir(), 'tui-rc5-host-'))
process.env.DSH_HOME = home
process.env.DSH_TUI_LOCALE = 'en'
const originalEntry = process.argv[1]
process.argv[1] = host.entry
const { Context, Service } = await host.load('cordis')
const { LlmAdapter, ReasoningEffortId } = await host.load('dsh-llm')
const { Terminal } = await import(root + 'lib/term.js')
const { App } = await import(root + 'lib/ui.js')
const tui = await import(root + 'lib/index.js')
const { teamSnapshot } = await import(root + 'lib/team.js')
const realIn = Object.getOwnPropertyDescriptor(process, 'stdin')
const realOut = Object.getOwnPropertyDescriptor(process, 'stdout')
class Input extends EventEmitter {
  isTTY = true
  setRawMode() {}
  resume() {}
  pause() {}
  send(text) { this.emit('data', Buffer.from(text)) }
}
class Output extends EventEmitter {
  isTTY = true; columns = 120; rows = 40
  write() { return true }
}
const input = new Input()
Object.defineProperty(process, 'stdin', { configurable: true, value: input })
Object.defineProperty(process, 'stdout', { configurable: true, value: new Output() })
const report = []
let app
const setSession = App.prototype.setSession
App.prototype.setSession = function (...args) { app = this; return setSession.apply(this, args) }
const frames = []
const paint = Terminal.prototype.paint
Terminal.prototype.paint = function (screen) {
  frames.push(screen.cells.map((row) => row.map((cell) => cell.ch ?? '').join('')).join('\n'))
  return paint.call(this, screen)
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
async function until(check, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { if (check()) return; await pause() }
  throw new Error('Timed out: ' + label + '\n' + frames.at(-1))
}
const requests = []
const longModel = 'very-long-model-' + 'abcdefghij'.repeat(12) + '-end'
class Adapter extends LlmAdapter {
  async resolveModel(provider, id) {
    return {
      provider, id, name: id, input: ['text'],
      reasoning: { efforts: ['low', 'high'].map((id) => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('low') },
    }
  }
  async *stream(options) {
    requests.push({ provider: options.provider, model: options.model, effort: options.reasoningEffort })
    const text = 'rc5 answer ' + requests.length
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = new Context()
const fibers = []
async function mount(name, config = {}) {
  const module = await host.load(name)
  const fiber = ctx.plugin(module.default ?? module, config)
  fibers.push([name, fiber])
  await fiber
  return fiber
}
let tuiFiber
let failure
try {
  await mount('cordis-plugin-timer')
  await mount('dsh-session-projection')
  await mount('dsh-session')
  await mount('dsh-agent')
  await mount('dsh-system-prompt')
  await mount('dsh-tools')
  await mount('dsh-tool-executor-native')
  await mount('dsh-llm')
  await mount('dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' })
  await mount('dsh-agent-loop')
  await mount('dsh-fs-local')
  await mount('dsh-working-directory')
  await mount('dsh-subagent')
  await mount('dsh-agent-team')
  const profile = join(home, 'profile')
  mkdirSync(profile)
  const patchPath = join(profile, 'cordis.patch.yml')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'tui-rc5-test', private: true, dsh: { profile: { bundles: [] } } }))
  const rows = [
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'settings', name: '@deepseek-ai/dsh-settings' },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'fixture', model: 'first' } },
    { id: 'renamed-web', name: '@deepseek-ai/dsh-web' },
    { id: 'renamed-web-api', name: '@deepseek-ai/dsh-web-deepseek-api' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {
      providers: { custom: { api: 'google-generative-ai', baseURL: 'http://127.0.0.1:1', models: [{ id: 'gemini-fixture' }, { id: longModel }] } },
    } },
  ]
  const patches = [{ insert: rows }]
  writeFileSync(patchPath, JSON.stringify(patches))
  const configPath = join(profile, 'cordis.yml')
  writeFileSync(configPath, '[]')
  ctx.provide('profileContext', {
    name: 'test', dir: profile, patchPath, home, cwd: process.cwd(), installAnchor: host.entry,
    overlays: [], startedBundles: [],
  })
  await mount('cordis-plugin-loader')
  const { mountRootInclude } = await host.load('dsh-app-boot')
  await mountRootInclude(ctx, configPath, patches, pathToFileURL(host.entry).href)
  await ctx.get('loader').await()
  assert(ctx.get('settings'))
  class Startup extends Service {
    constructor(ctx) { super(ctx, 'tuiStartup'); this.resume = undefined }
  }
  new Startup(ctx)
  ctx.plugin({ apply(ctx) { ctx.get('llm').registerAdapter(['fixture'], new Adapter()) } })
  await mount('dsh-commands')
  await until(() => ctx.get('agentLoop') && ctx.get('agentTeams'), 'host services')
  tuiFiber = ctx.plugin(tui, { defaultProvider: 'fixture', defaultModel: 'first' })
  await tuiFiber
  input.send('hello rc5\r')
  await until(() => requests.length === 1 && frames.at(-1)?.includes('rc5 answer 1'), 'real agent response')
  const agent = ctx.get('agents').list()[0]
  assert(agent)
  const id = String(agent.session.id)
  assert.equal(agent.model.current().model, 'first')
  assert.equal(app.blocks.find((block) => block.kind === 'user')?.steering, false)
  report.push('ok   real rc.5 creates a session, accepts TTY input and renders an agent response')
  input.send('/model second\r')
  await until(() => agent.model.current().model === 'second', 'model switch')
  await until(() => app.effortSlider?.current === 'low', 'reasoning choices')
  input.send('\t')
  await until(() => agent.model.current().reasoningEffort === 'high', 'reasoning switch')
  input.send('second turn\r')
  await until(() => requests.length === 2 && frames.at(-1)?.includes('rc5 answer 2'), 'second response')
  assert.deepEqual(requests[1], { provider: 'fixture', model: 'second', effort: 'high' })
  report.push('ok   model and reasoning switches reach the actual rc.5 model request')
  const { loadWebSettings, loadModelSettings, loadMcpSettings, saveWebSetting } = await import(root + 'lib/web-settings.js')
  const webPage = await loadWebSettings(ctx)
  const search = webPage.items.find((item) => item.path?.[0] === 'searchProvider')
  assert(search)
  assert.equal(search.ns, 'renamed-web')
  await saveWebSetting(ctx, ctx.get('settings'), search, 'custom-search')
  const updatedPage = await loadWebSettings(ctx)
  await saveWebSetting(ctx, ctx.get('settings'), updatedPage.items.find((item) => item.path?.[0] === 'searchProvider'), 'default')
  const savedPage = await loadWebSettings(ctx)
  assert.equal(savedPage.items.find((item) => item.path?.[0] === 'searchProvider').value, 'default')
  assert(readFileSync(patchPath, 'utf8').includes('reasoningEffort'))
  report.push('ok   real SettingsForms saves volatile edits to the profile patch and resets automatic search')
  const retryPage = await loadModelSettings(ctx)
  const maxRetries = retryPage.items.find((item) => item.ns === 'llm-pi-ai' && item.path?.at(-1) === 'maxRetries')
  assert(maxRetries)
  await saveWebSetting(ctx, ctx.get('settings'), maxRetries, '7')
  const piConfig = ctx.get('settings').describe().find((entry) => entry.ns === 'llm-pi-ai').value
  assert.deepEqual(piConfig.providers.custom.retryPolicy.mode, 'normal')
  assert.equal(piConfig.providers.custom.retryPolicy.maxRetries, 7)
  assert(readFileSync(patchPath, 'utf8').includes('maxRetries'))
  report.push('ok   actual provider retry edits pass SettingsForms validation and persist to the profile')
  await ctx.get('settings').update('agent-default-model', { provider: 'custom', model: 'gemini-fixture' })
  input.send('/settings\r')
  await until(() => app.overlay === 'settings' && app.settingsMenuIndex === 0, 'main settings for model picker')
  input.send('\t')
  await until(() => app.settingsItems.some((item) => item.kind === 'default-model' && item.options?.length > 1), 'model settings')
  const modelRow = app.settingsItems.findIndex((item) => item.kind === 'default-model')
  for (let moves = 0; app.settingsSelection !== modelRow && moves < app.settingsItems.length; moves++) input.send('\x1b[B')
  assert.equal(app.settingsSelection, modelRow)
  input.send('\r')
  await until(() => app.settingsItems.some((item) => item.optionValue === longModel), 'default model choices')
  const longRow = app.settingsItems.findIndex((item) => item.optionValue === longModel)
  assert.equal(app.settingsItems[longRow].modelLabel, true)
  for (let moves = 0; app.settingsSelection !== longRow && moves < app.settingsItems.length; moves++) input.send('\x1b[B')
  assert.equal(app.settingsSelection, longRow)
  const modelY = app.hitRegions.find((region) => region.kind === 'settings-item' && region.settingsIndex === longRow).y
  const initialLine = frames.at(-1).split('\n')[modelY]
  await until(() => app.hasAnimation() && frames.at(-1).split('\n')[modelY] !== initialLine, 'focused model label scrolls on the animation timer')
  assert.equal(app.settingsSelection, longRow)
  input.send('\x1b')
  await until(() => app.settingsMenuIndex === 1 && app.settingsItems.some((item) => item.kind === 'default-model'), 'return from model choices')
  input.send('\x1b')
  await until(() => app.overlay === null, 'close model settings')
  await ctx.get('settings').update('agent-default-model', { provider: 'fixture', model: 'first' })
  report.push('ok   real default-model choices scroll the focused long label without input')
  await mount('dsh-mcp-manager', { servers: {
    'host-fixture': { transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))] },
    'host-disabled': { transport: 'stdio', command: process.execPath, enabled: false },
  } })
  const manager = ctx.get('mcpManager')
  await until(() => manager.list().some((server) => server.name === 'host-fixture' && server.status.state === 'connected'), 'host MCP connection')
  const mcpPage = await loadMcpSettings(ctx, null)
  assert(mcpPage.items.some((item) => item.kind === 'host-mcp-restart' && item.serverName === 'host-fixture' && !item.disabled))
  assert(mcpPage.items.some((item) => item.serverName === 'host-disabled' && item.disabled))
  let reconnected = false
  ctx.on('mcp-manager/status', (name, status) => {
    if (name === 'host-fixture' && status.state === 'connected') reconnected = true
  }, { global: true })
  input.send('/settings\r')
  await until(() => app.overlay === 'settings' && app.settingsMenuIndex === 0, 'main settings')
  input.send('\x1b[Z')
  await until(() => app.settingsItems.some((item) => item.kind === 'host-mcp-restart'), 'MCP settings tab')
  const target = app.settingsItems.findIndex((item) => item.serverName === 'host-fixture')
  for (let moves = 0; app.settingsSelection !== target && moves < app.settingsItems.length; moves++) input.send('\x1b[B')
  assert.equal(app.settingsSelection, target)
  input.send('\r')
  await until(() => reconnected && app.settingsItems.some((item) => item.serverName === 'host-fixture' && !item.disabled), 'host MCP restart through Enter')
  input.send('\x1b')
  await until(() => app.overlay === null, 'close MCP settings')
  report.push('ok   real host MCP manager connects a local stdio server, exposes status and restarts it')
  input.send('/team on\r')
  await until(() => ctx.get('agentTeams').isEnabled(agent), 'Team mode on')
  await ctx.get('agentTeams').createTask(agent, { subject: 'Shared rc5 task', description: 'Inspect the board' })
  input.send('/team\r')
  await until(() => frames.at(-1)?.includes('Shared rc5 task'), 'shared task board')
  assert(app.settingsItems.some((item) => item.label === 'Shared rc5 task'))
  input.send('\x1b[B')
  assert.equal(app.settingsItems[app.settingsSelection].label, 'Shared rc5 task')
  input.send('\r')
  assert.equal(app.settingsItems[app.settingsSelection].label, 'Shared rc5 task')
  input.send('\x1b')
  await until(() => app.settingsMenu.length > 0, 'return from Team board')
  input.send('\x1b')
  await until(() => app.overlay === null, 'close settings')
  input.send('/team off\r')
  await until(() => !ctx.get('agentTeams').isEnabled(agent), 'Team mode off')
  assert.equal(teamSnapshot(ctx, agent).tasks.length, 1)
  input.send('/team\r')
  await until(() => app.settingsItems.some((item) => item.label === 'Shared rc5 task'), 'disabled Team board')
  input.send('\x1b')
  await until(() => app.settingsMenu.length > 0, 'return from disabled Team board')
  input.send('\x1b')
  await until(() => app.overlay === null, 'close disabled Team settings')
  report.push('ok   actual Team mode persists and the shared task board renders without losing tasks on disable')
  await tuiFiber.dispose()
  await until(() => ctx.get('agents').list().length === 0, 'first TUI disposal')
  ctx.get('tuiStartup').resume = id
  tuiFiber = ctx.plugin(tui, { defaultProvider: 'fixture', defaultModel: 'first' })
  await tuiFiber
  await until(() => ctx.get('agents').list().length === 1 && frames.at(-1)?.includes('rc5 answer 2'), '--resume replay')
  const resumed = ctx.get('agents').list()[0]
  assert.equal(String(resumed.session.id), id)
  assert.equal(resumed.model.current().model, 'second')
  assert.equal(ctx.get('agentTeams').isEnabled(resumed), false)
  assert.equal(teamSnapshot(ctx, resumed).tasks.length, 1)
  assert(app.blocks.filter((block) => block.kind === 'user').every((block) => !block.steering))
  input.send('after resume\r')
  await until(() => requests.length === 3 && frames.at(-1)?.includes('rc5 answer 3'), 'resumed response')
  assert.equal(requests[2].model, 'second')
  report.push('ok   apply-time --resume restores the actual persisted session and sends another turn')
} catch (error) {
  failure = error
} finally {
  try { await tuiFiber?.dispose() } catch {}
  for (const [, fiber] of fibers.reverse()) { try { await fiber.dispose() } catch {} }
  App.prototype.setSession = setSession
  Terminal.prototype.paint = paint
  Object.defineProperty(process, 'stdin', realIn)
  Object.defineProperty(process, 'stdout', realOut)
  process.argv[1] = originalEntry
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}
console.log(report.join('\n'))
if (failure) { console.error(failure); process.exit(1) }
console.log('all actual rc.5 host tests passed')
process.exit(0)
