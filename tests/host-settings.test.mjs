import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import { webSettingRows, retrySettingRows, saveHostSetting } from '../lib/host-settings.js'
import { teamBoard, teamModeRow } from '../lib/team.js'
import { protocolChoices } from '../lib/providers.js'
import { hostModuleUrl } from '../lib/host.js'
import { hostRuntime } from './host-runtime.mjs'

const host = hostRuntime()
const webSchema = z.object({ searchProvider: z.string(), fetchProvider: z.string() })
const billingSchema = z.object({
  searchBilling: z.union(['auto', 'account', 'api-key']).default('auto'),
  fetchBilling: z.union(['auto', 'account', 'api-key']).default('auto'),
})
function descriptor(schema, value) { return { schema: schema.toJSON(), value, revision: 7 } }
const providers = { search: [{ id: 'deepseek', title: 'DeepSeek' }], fetch: [{ id: 'http', title: 'HTTP' }] }
const ctx = { get: (name) => name === 'web' ? { listProviders: () => providers } : undefined }
for (const names of [['web', 'web-deepseek-api'], ['renamed-web', 'renamed-api']]) {
  const descriptors = new Map([
    [names[0], descriptor(webSchema, { fetchProvider: 'http' })],
    [names[1], descriptor(billingSchema, billingSchema())],
  ])
  const rows = webSettingRows(ctx, descriptors, true)
  const search = rows.find((row) => row.path?.[0] === 'searchProvider')
  assert.equal(search.ns, names[0])
  assert.deepEqual(search.options.map((option) => option.value), ['default', 'deepseek'])
  assert.equal(search.value, 'default')
  const calls = []
  const settings = { mutate: (...args) => calls.push(args) }
  await saveHostSetting(settings, search, 'default')
  assert.deepEqual(calls[0], [names[0], [{ op: 'unset', path: ['searchProvider'] }], 7])
  await saveHostSetting(settings, search, 'deepseek')
  assert.equal(calls[1][1][0].value, 'deepseek')
  assert.equal(descriptors.get(names[0]).value.searchProvider, undefined)
}
assert.deepEqual(webSettingRows(ctx, new Map(), true), [])
console.log('ok   web settings preserve automatic routing and support renamed Config entries')

if (host?.version === '0.2.2-rc.5') {
  const [pi, official, web, billing] = await Promise.all([
    host.load('dsh-llm-pi-ai'), host.load('dsh-llm-deepseek'), host.load('dsh-web'), host.load('dsh-web-deepseek-api'),
  ])
  const piDescriptor = descriptor(pi.Config, { providers: { custom: { api: 'google-generative-ai', models: [{ id: 'gemini-pro' }] } } })
  assert(protocolChoices(piDescriptor).includes('google-generative-ai'))
  const rows = retrySettingRows('pi', piDescriptor, ['providers', 'custom'], true)
  assert.equal(rows.length, 6)
  const calls = []
  const settings = { mutate: (...args) => calls.push(args), describe: () => [{ ns: 'pi', ...piDescriptor }] }
  await saveHostSetting(settings, rows.find((row) => row.path.at(-1) === 'maxRetries'), '8')
  assert.deepEqual(calls.at(-1)[1], [
    { op: 'set', path: ['providers', 'custom', 'retryPolicy', 'mode'], value: 'normal' },
    { op: 'set', path: ['providers', 'custom', 'retryPolicy', 'maxRetries'], value: 8 },
  ])
  await assert.rejects(() => saveHostSetting(settings, rows[1], 'NaN'))
  await saveHostSetting(settings, rows.find((row) => row.valueType === 'list'), 'SERVER, TIMEOUT, SERVER')
  assert.deepEqual(calls.at(-1)[1].at(-1).value, ['SERVER', 'TIMEOUT'])
  piDescriptor.value.providers.custom.retryPolicy = { mode: 'normal', maxRetries: 4, backoff: { initialDelayMs: 800 } }
  await saveHostSetting(settings, rows[0], 'always')
  assert.deepEqual(calls.at(-1)[1][0].value, { mode: 'always', backoff: { initialDelayMs: 800 } })
  piDescriptor.value.providers.custom.retryPolicy = calls.at(-1)[1][0].value
  assert.equal(retrySettingRows('pi', piDescriptor, ['providers', 'custom'], true).length, 4)
  assert.equal(retrySettingRows('official', descriptor(official.Config, official.Config()), [], true).length, 6)
  const actualWebRows = webSettingRows(ctx, new Map([
    ['web', descriptor(web.default.Config, web.default.Config())],
    ['web-deepseek-api', descriptor(billing.Config, billing.Config())],
  ]), true)
  assert.equal(actualWebRows.filter((row) => row.kind === 'host-setting').length, 4)
  assert(hostModuleUrl('@deepseek-ai/dsh-llm', { entry: host.entry }).includes('/dsh/node_modules/'))
  console.log('ok   actual rc.5 schemas: Gemini, web billing, provider retries, typed writes and reset')
} else console.log('skip rc.5 schema checks (requires dsh 0.2.2-rc.5)')

const agent = { session: { id: 'root' } }
const teams = {
  isEnabled: () => false, setEnabled() {},
  listTasks: () => { throw new Error('TEAM_DISABLED') },
}
const teamCtx = { get: (name) => name === 'agentTeams' ? teams : name === 'sessionProjections' ? {
  snapshot: () => ({ values: { agentTeam: { enabled: false, tasks: [
    { subject: 'Review', description: 'Inspect changes', status: 'in_progress', blockedBy: ['task-1'], ownerName: 'root/reviewer', writeScopeWarnings: [] },
  ] } } }),
} : undefined }
assert.equal(teamModeRow(teamCtx, null).disabled, true)
assert.equal(teamModeRow(teamCtx, agent).agentId, 'root')
const board = teamBoard(teamCtx, agent)
assert(board.items.some((item) => item.value?.includes('root/reviewer')))
assert(board.items.some((item) => item.label.includes('task-1')))
assert.equal(teamModeRow({ get: () => undefined }, agent), null)
console.log('ok   Team board retains tasks while disabled and hides unsupported controls')
