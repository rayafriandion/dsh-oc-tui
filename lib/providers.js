// Adding a model provider from the TUI: the WebUI's add flow, expressed as the
// settings dialog's own sub-views. The WebUI offers two ways to gain a provider
// — adopt one the adapter already ships, or hand-declare a route it does not —
// and this file owns both: the directory split that decides which routes are
// still addable, the create draft, its validation, and the write.
//
// Nothing here caches: the Model tab re-reads the settings descriptors and the
// llm directory on every render, so a provider added by another surface (the
// WebUI, a hand-edited patch) appears as soon as it is written.
//
// The host services are reached through `ctx.get()` and never imported, so the
// plugin still installs and boots on a host that ships none of them.

import z from '@deepseek-ai/schemastery'
import { t, tv } from './i18n.js'
import { formatError } from './util.js'

// Any route key walks a dict schema to the same profile node, so this one —
// which cannot occur in a provider id — addresses one profile's fields without
// resolving a real route.
const PROBE_ROUTE = '\u0000probe'

// A route id usable as a settings key AND as the stem of a credential name. The
// leading letter is the second half of that: `routeKeyRef` uppercases the id and
// replaces every non-alphanumeric run with `_`, and a credential reference is a
// POSIX shell identifier, which cannot start with a digit.
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// Families whose profile carries a per-route endpoint. A whole-section provider
// (DeepSeek, the account route) resolves its endpoint from its own Config, so it
// has no URL row of its own.
export const URL_FAMILIES = new Set(['llm-deepseek', 'llm-pi-ai'])

// The route the account family owns: its credential is a sign-in, not a stored
// key, so it gets no key row and no removal.
export const ACCOUNT_ROUTE = 'deepseek-account'

// The credential reference a route's key is stored under — the same
// `<ROUTE>_API_KEY` derivation the WebUI makes, so a key stored from either
// surface is found by both.
export function routeKeyRef(route) {
  const id = String(route ?? '')
  if (id === '') return ''
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

// A provider's stored model catalog tolerates both string entries and
// `{ id, ... }` objects; normalize to objects with an id so the merged view and
// the picker can treat them uniformly.
export function normalizeModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  for (const entry of models) {
    if (typeof entry === 'string' && entry) out.push({ id: entry })
    else if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) out.push(entry)
  }
  return out
}

export function modelEntryId(entry) {
  return typeof entry === 'string' ? entry : entry?.id
}

export function valueAt(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = value[part]
  }
  return value
}

export function hasPath(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return false
    value = value[part]
  }
  return true
}

// Picker/choice annotation: a glanceable capability marker per model.
export function capabilitySuffix(model) {
  const capabilities = []
  if (Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) capabilities.push('vision')
  if (model.reasoning && Array.isArray(model.reasoning.efforts) && model.reasoning.efforts.length > 0) capabilities.push('thinking')
  return capabilities.length > 0 ? ' (' + capabilities.join(', ') + ')' : ''
}

// Discover the models a provider profile advertises. Uses the model-discovery
// seam (`ctx.llm.discoverModels`): it answers from the installed catalog for a
// known route and interrogates a custom/dormant route's endpoint — resolving the
// stored credential itself, or using `record.apiKey` for a key the create form
// holds but has not stored yet. `listModels` only covers registered adapters, so
// it silently missed user-added providers that are not currently registered; it
// is kept as the fallback for namespaces that register no discovery (e.g. the
// built-in DeepSeek adapter).
//
// The refusal text is returned, not swallowed: "the endpoint answered 401" and
// "this protocol has no model listing" are the two answers a user can act on,
// and an empty list with no reason is what makes a fetch look broken.
export async function fetchProviderModels(ctx, entry, record) {
  const llm = ctx.get('llm')
  const source = typeof record === 'object' && record !== null ? record : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  let fetched = null
  let failure
  if (llm?.discoverModels) {
    const request = {
      // An empty route id is not a route: omitting it lets the adapter treat the
      // draft as endpoint-only instead of looking up "" in its catalog.
      ...(text(entry.provider) === '' ? {} : { provider: entry.provider }),
      ...(text(source.baseURL) === '' ? {} : { baseURL: source.baseURL }),
      ...(text(source.api) === '' ? {} : { api: source.api }),
      // A key typed into the create form and not stored yet: asking with it is
      // what makes adding a provider one pass instead of save-then-return.
      ...(text(source.apiKey) === '' ? {} : { apiKey: source.apiKey }),
    }
    try {
      fetched = await llm.discoverModels(entry.settingsNs, request)
    } catch (error) {
      // `NO_DISCOVERY` means the namespace registered no discovery; its
      // registered adapter answers from its own catalog below.
      if (error?.code !== 'NO_DISCOVERY') failure = formatError(error)
    }
  }
  if (!Array.isArray(fetched) && failure === undefined && llm?.listModels) {
    try { fetched = await llm.listModels(entry.provider) } catch (error) { failure = formatError(error) }
  }
  // A callback that answered with something other than a list is a refusal too,
  // even though nothing was thrown.
  if (!Array.isArray(fetched) && failure === undefined) failure = t('model.fetchRefused')
  return { models: normalizeModels(fetched), failed: failure !== undefined, error: failure }
}

// Everything the Model tab and the add flows read, in one place: the settings
// service's redacted namespace views, the llm directory, and the two halves the
// Model tab splits that directory into — the routes whose profile resolves (a
// block of their own) and the ones it does not (the add picker's rows).
//
// A whole-section route (`settingsPath: []`) is always configured: its profile
// is the plugin entry's own Config, which exists whether or not the user has
// touched it. Getting that wrong is what hid DeepSeek from the Model tab on a
// fresh install, since the user layer of an untouched entry is empty.
//
// Returns undefined when the host exposes no settings service at all, which the
// caller renders as an explanatory row instead of an empty page.
export function providerDirectory(ctx) {
  const settings = ctx.get('settings')
  if (!settings) return undefined
  let described
  try { described = settings.describe({ redactSecrets: true }) } catch { return undefined }
  const descriptors = new Map(described.map((entry) => [String(entry.ns), entry]))
  const llm = ctx.get('llm')
  const directory = llm?.listConfigurableProviders?.() ?? []
  const configured = []
  const addable = []
  for (const entry of directory) {
    const descriptor = descriptors.get(entry.settingsNs)
    if (!descriptor) continue
    const path = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
    const profile = path.length === 0 ? descriptor.value : valueAt(descriptor.value, path)
    const row = { entry, descriptor, path, profile }
    if (profile !== undefined) configured.push(row)
    else addable.push(row)
  }
  return { settings, descriptors, llm, configured, addable }
}

// Walk a rehydrated schema to the node a path addresses. Dict and array nodes
// have no `dict` of their own — every key walks to their shared `inner` node.
function nodeAtPath(root, path) {
  let node = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = node.dict?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner
    else return undefined
  }
  return node
}

// The wire protocols a profile may name, read out of the owning namespace's own
// schema so the choices offered cannot drift from the ones the adapter accepts:
// both come from the same Config. Hardcoding them is how the TUI offered
// `google-generative-ai`, which this adapter family cannot serve at all.
export function protocolChoices(descriptor) {
  const serialized = descriptor?.schema
  if (!serialized) return []
  let node
  try {
    node = nodeAtPath(new z(serialized), ['providers', PROBE_ROUTE, 'api'])
  } catch { return [] }
  if (node?.type !== 'union' || !Array.isArray(node.list)) return []
  return node.list.map((entry) => entry.value).filter((value) => typeof value === 'string')
}

// The namespace a hand-declared route is written into, with the revision and
// the protocol choices its own schema declares.
//
// Found by probe rather than by name: only a namespace whose schema describes
// `providers.<route>.api` can hold a declared route, so the first one that
// answers IS that namespace — however a profile happens to name its entry.
export function declareNamespace(directory) {
  for (const [ns, descriptor] of directory.descriptors) {
    const protocols = protocolChoices(descriptor)
    if (protocols.length > 0) return { settingsNs: ns, revision: descriptor.revision, protocols }
  }
  return undefined
}

// The add picker's rows. A catalog route the adapter ships has a single-letter
// name that means nothing to a user scanning 40 of them, so the top row is a
// filter: the list is what matches it.
//
// The custom entry sits above the catalog rather than after it — declaring an
// endpoint is what a user with an unfamilar gateway is looking for, and being
// 40 rows down is the same as absent.
export function providerPickerItems(directory, { query = '' } = {}) {
  const items = [{
    kind: 'provider-search',
    label: t('provider.search'),
    value: query === '' ? t('provider.searchPlaceholder') : query,
    disabled: false,
  }]
  items.push({ kind: 'provider-pick-custom', label: t('provider.custom'), value: 'Enter', disabled: false })
  items.push({ kind: 'header', label: t('provider.catalog'), value: '', disabled: true })
  const rows = filterAddable(directory.addable, query)
  if (rows.length === 0) {
    items.push({
      kind: 'provider-empty',
      // "everything is configured" and "nothing matches what you typed" are
      // different answers, and the second one invites a different next keystroke.
      label: directory.addable.length === 0
        ? t('provider.catalogEmpty')
        : t('provider.searchEmpty', { query: String(query).trim() }),
      wide: true,
      disabled: true,
      selectable: false,
    })
  }
  for (const row of rows) {
    items.push({
      kind: 'provider-pick',
      label: row.entry.displayName,
      // A hand-declared route's name is the user's own text; the route id is
      // what identifies it in the settings and is worth showing beside it.
      value: row.entry.declared === true ? row.entry.provider : '',
      providerId: row.entry.provider,
      settingsNs: row.entry.settingsNs,
      revision: row.descriptor.revision,
      disabled: false,
    })
  }
  return items
}

// The addable routes matching a picker query: the route id (what a user who
// knows the provider types) and its display name (what a user who does not reads).
export function filterAddable(addable, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return addable
  return addable.filter((row) => row.entry.provider.toLowerCase().includes(needle)
    || String(row.entry.displayName ?? '').toLowerCase().includes(needle))
}

// A create draft starts from the picker's choice: adopting a route it already
// names, or declaring one from nothing.
export function createDraft(mode = 'catalog', route = '') {
  return { mode, route, displayName: '', baseURL: '', api: '', key: '', models: [] }
}

// A route id derived from a display name.
//
// The route is a settings key and a credential stem, so it must be spelled a
// particular way — but the user is thinking in the name they see in their
// gateway's console. Typing the name first is the common order, so the form
// fills the key from it; only characters a route may carry survive, and when
// nothing usable is left this returns '' so validation still says why.
export function deriveRoute(displayName) {
  const slug = String(displayName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // A credential reference cannot start with a digit, and neither may a route.
    .replace(/^\d+/, '')
  return ROUTE_PATTERN.test(slug) ? slug : ''
}

// The create form's rows. One list for both modes so the shared fields (key,
// models) are built once; the mode decides the identity rows.
//
// `protocols` arrives resolved: the caller read it out of the schema, because a
// draft has no stored profile for this file to inspect. `title` names the route
// a catalog draft is adopting — the picker already chose it, so the form shows
// which one instead of asking again.
export function buildCreateFormItems(draft, { protocols = [], title } = {}) {
  const custom = draft.mode === 'custom'
  const items = [{
    kind: 'header',
    label: title ?? t(custom ? 'provider.form.custom' : 'provider.form.catalog'),
    value: '',
    disabled: true,
  }]
  if (custom) {
    items.push({
      kind: 'provider-field',
      field: 'route',
      label: t('provider.field.route'),
      value: draft.route,
      providerText: true,
    })
    items.push({ kind: 'provider-hint', label: routeHint(draft.route), wide: true, disabled: true, selectable: false })
    items.push({ kind: 'provider-field', field: 'displayName', label: t('model.displayName'), value: draft.displayName, providerText: true })
  }
  items.push({ kind: 'provider-field', field: 'baseURL', label: t('model.providerUrl'), value: draft.baseURL, providerText: true })
  if (custom) {
    items.push({
      kind: 'provider-field',
      field: 'api',
      label: t('model.wireProtocol'),
      value: draft.api || protocols[0] || '',
      options: protocols.map((id) => ({ label: protocolLabel(id), value: id })),
    })
  }
  items.push({
    kind: 'provider-field',
    field: 'key',
    label: t('model.providerApiKey'),
    // The draft's key is never echoed: the row shows that one was typed, and
    // the editor starts blank so Enter replaces rather than appends to it.
    value: draft.key ? '••••••' : '',
    secret: true,
  })
  const stored = draft.models.length
  items.push({
    kind: 'provider-field',
    field: 'models',
    label: t('model.models'),
    value: stored > 0 ? t('model.selectedCount', { count: stored }) : t('model.fetch'),
    providerModels: true,
  })
  for (const model of draft.models) {
    items.push({
      kind: 'provider-form-model',
      label: model.id,
      value: capabilitySuffix(model),
      indent: 1,
      disabled: true,
      selectable: false,
    })
  }
  items.push({ kind: 'provider-field', field: 'addModel', label: t('provider.field.addModel'), value: '', providerText: true })
  items.push({ kind: 'provider-save', label: t('provider.field.save'), value: 'Enter', disabled: false })
  return items
}

// The route row's own hint: what an id may look like, and where its key will be
// stored. A rejected id is reported on save, not while typing — the TUI edits
// one row at a time and has no place for a live inline error.
function routeHint(route) {
  if (route === '') return t('provider.hint.route', { ref: routeKeyRef('acme-gateway') })
  if (!ROUTE_PATTERN.test(route)) return t('provider.error.route')
  return t('provider.hint.route', { ref: routeKeyRef(route) })
}

// Protocol ids are technical tokens, but two of them read as words; the rest
// stay verbatim (see `tv`). Kept local so a new protocol needs no catalog work.
function protocolLabel(id) {
  const label = tv(id)
  return label === id ? id : label
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(String(value ?? '').trim()).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// Whether a draft can be written, or why it cannot. The message names the field
// the user is looking at rather than repeating the schema's own path-shaped
// refusal, which arrives only after the write has already begun.
//
// A catalog route needs nothing but a route: its profile inherits the adapter's
// own endpoint, protocol, and model catalog, so an empty profile is a valid way
// to add one. A hand-declared route has nothing to inherit — the three fields it
// cannot default (endpoint, protocol, at least one model) are required here.
export function validateCreateDraft(draft, { taken = [] } = {}) {
  const route = String(draft.route ?? '').trim()
  if (draft.mode === 'custom') {
    if (!ROUTE_PATTERN.test(route)) return t('provider.error.route')
    if (taken.includes(route)) return t('provider.error.taken')
    const endpoint = String(draft.baseURL ?? '').trim()
    if (endpoint === '') return t('provider.error.baseUrlNeeded')
    if (!isHttpUrl(endpoint)) return t('provider.error.baseUrl')
    if (!String(draft.api ?? '').trim()) return t('provider.error.apiNeeded')
    if (draft.models.length === 0) return t('provider.error.modelsNeeded')
  } else {
    if (route === '') return t('provider.error.routeNeeded')
    const endpoint = String(draft.baseURL ?? '').trim()
    if (endpoint !== '' && !isHttpUrl(endpoint)) return t('provider.error.baseUrl')
  }
  const seen = new Set()
  for (let index = 0; index < draft.models.length; index++) {
    const id = String(modelEntryId(draft.models[index]) ?? '').trim()
    if (id === '') return t('provider.error.modelId', { index: index + 1 })
    if (seen.has(id)) return t('provider.error.modelDuplicate', { id })
    seen.add(id)
  }
  return undefined
}

// Write a create draft: the whole profile at `providers.<route>` in one
// `settings.mutate`, then the key through the credentials service.
//
// The order is the WebUI's and it matters: a profile naming an `apiKeyEnv` it
// never stores is a route that cannot authenticate, while a stored key with no
// profile is an orphan the removal path would not clean up. The profile goes
// first, so a failed key write leaves a provider the user can retry without
// creating it twice.
//
// `revision` is the namespace revision the form opened at, so a route declared
// by another surface meanwhile is a conflict instead of an overwrite.
export async function saveCreateDraft(ctx, settings, draft, { settingsNs, revision } = {}) {
  const route = String(draft.route ?? '').trim()
  const displayName = String(draft.displayName ?? '').trim()
  const endpoint = String(draft.baseURL ?? '').trim()
  const api = String(draft.api ?? '').trim()
  const key = String(draft.key ?? '').trim()
  const profile = {}
  // The profile names the conventional reference only when a key is about to be
  // stored: a route added with the key left blank keeps its provider-native
  // authentication (a credential chain, ADC) instead of resolving a reference
  // nothing ever sets.
  if (key !== '') profile.apiKeyEnv = routeKeyRef(route)
  if (displayName !== '') profile.displayName = displayName
  if (api !== '') profile.api = api
  if (endpoint !== '') profile.baseURL = endpoint
  if (draft.models.length > 0) profile.models = draft.models.map((model) => ({ ...model }))
  await settings.mutate(settingsNs, [{ op: 'set', path: ['providers', route], value: profile }], revision)
  if (key !== '') {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error(t('model.credentialsUnavailable'))
    await credentials.set(profile.apiKeyEnv, key)
  }
  return route
}

// The model-selection rows for a create draft. `discovered` is the endpoint's
// answer, cached by the caller: a toggle must not spend a round trip, and the
// list must not shift under the cursor because the endpoint answered twice.
//
// The first row is the whole-selection toggle: a fresh fetch arrives with every
// candidate already picked (that is what "get the models" was for), so the one
// keystroke a user reliably needs is the way back out of that.
export function draftModelItems(draft, discovered, { failed = false, error, providerId } = {}) {
  const items = []
  if (error) {
    // The refusal is the only answer a user can act on: 401 means the key, a
    // bare host means the endpoint, "no listing" means type the ids by hand.
    items.push({ kind: 'model-error', label: error, wide: true, indent: 1, tone: 'warning', disabled: true, selectable: false })
  }
  const candidates = normalizeModels(discovered)
  const storedIds = new Set(draft.models.map((model) => modelEntryId(model)))
  const seen = new Set()
  const rows = []
  const pushRow = (model) => {
    const id = modelEntryId(model)
    if (!id || seen.has(id)) return
    seen.add(id)
    const checked = storedIds.has(id)
    // The saved entry is what carries capacities; the discovered one supplies
    // them for a model the draft has not adopted yet.
    const saved = draft.models.find((entry) => modelEntryId(entry) === id)
    rows.push({
      kind: 'model-toggle',
      label: id + capabilitySuffix(model),
      value: (checked ? '[x]' : '[ ]') + capacitySuffix(saved ?? model),
      modelId: id,
      checked,
      draftToggle: true,
      candidate: model,
      providerId,
      disabled: false,
    })
  }
  for (const model of candidates) pushRow(model)
  // Models the catalog no longer returns, or that the user typed by hand, stay
  // toggleable so a stored selection is never a row the window cannot show.
  for (const model of draft.models) pushRow(model)
  if (candidates.length > 0) {
    const picked = candidates.filter((model) => storedIds.has(modelEntryId(model))).length
    items.push({
      kind: 'model-select-all',
      label: t('model.selectAll'),
      value: (picked === candidates.length ? '[x] ' : '[ ] ') + picked + '/' + candidates.length,
      allPicked: picked === candidates.length,
      draftToggle: true,
      providerId,
      disabled: false,
    })
  }
  items.push(...rows)
  if (rows.length === 0) {
    items.push({ label: failed ? t('model.noModels') : t('model.noModelsReturned'), value: '', disabled: true })
  }
  return items
}

// Every advertised model, merged into a saved list: an entry that is already
// there keeps its shape (and its position, so nothing the user corrected is
// rewritten), and a candidate joins with whatever the endpoint reported.
export function mergeModelSelection(stored, candidates) {
  const next = [...stored]
  for (const candidate of normalizeModels(candidates)) {
    if (next.some((entry) => modelEntryId(entry) === candidate.id)) continue
    next.push(adoptDiscovered(candidate) ?? { id: candidate.id })
  }
  return next
}

// Adopt one discovered model into a draft, keeping the metadata the endpoint
// advertised: without a context window and token cap a hand-declared model
// falls back to the route defaults, which is usually wrong for the model.
export function adoptDiscovered(model) {
  const candidate = normalizeModels([model])[0]
  if (!candidate) return undefined
  const out = { id: candidate.id }
  if (typeof candidate.name === 'string' && candidate.name && candidate.name !== candidate.id) out.name = candidate.name
  if (Number.isInteger(candidate.contextWindow) && candidate.contextWindow > 0) out.contextWindow = candidate.contextWindow
  if (Number.isInteger(candidate.maxTokens) && candidate.maxTokens > 0) out.maxTokens = candidate.maxTokens
  // A stored entry already speaks the profile's own vocabulary; a discovered one
  // arrives with the adapter's (`inputModalities`), which is not a profile field.
  if (Array.isArray(candidate.input) && candidate.input.length > 0) out.input = [...candidate.input]
  else if (Array.isArray(candidate.inputModalities) && candidate.inputModalities.length > 0) out.input = [...candidate.inputModalities]
  return out
}

// Interrogate the endpoint a create draft describes. Unlike a stored provider,
// the draft's fields — endpoint, protocol, and a key typed but not yet stored —
// are the only facts available, so they are what the request carries.
export async function discoverDraftModels(ctx, draft, { settingsNs, providerId } = {}) {
  return fetchProviderModels(ctx, { provider: providerId, settingsNs }, {
    baseURL: draft.baseURL,
    api: draft.api,
    apiKey: draft.key,
  })
}

// ---- one model's entry ------------------------------------------------------
// The fields a saved model carries besides its id. A model the installed catalog
// describes inherits all of them; a model on a hand-declared route inherits none,
// which is why they have to be typeable.

const INPUT_MODALITIES = ['text only', 'text + image']

// A stored entry's `input` array as the row's choice value.
export function modelInputValue(model) {
  return Array.isArray(model?.input) && model.input.includes('image') ? 'text + image' : 'text only'
}

function inputArray(value) {
  return String(value ?? '').trim() === 'text + image' ? ['text', 'image'] : ['text']
}

// Capacities are typed the way a person says them, so `256K` and `1000` both
// parse; an empty field means "unset" (the adapter's own default applies) and
// anything else is a refusal rather than a silent zero.
export function parseCapacity(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return undefined
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text)
  if (match === null) return Number.NaN
  const scale = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1000000 : 1
  const parsed = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

// ...and read back the same way, so a value that was typed as `256K` comes back
// as `256K` in the field without being rounded into a number that reads wrong.
export function formatCapacity(value) {
  if (!Number.isInteger(value) || value <= 0) return ''
  if (value % 1000000 === 0) return value / 1000000 + 'M'
  if (value % 1000 === 0) return value / 1000 + 'K'
  return String(value)
}

// The right-hand column of a model row: what the entry says beyond its id.
export function capacitySuffix(model) {
  const parts = []
  if (Number.isInteger(model?.contextWindow) && model.contextWindow > 0) parts.push(formatCapacity(model.contextWindow))
  if (Number.isInteger(model?.maxTokens) && model.maxTokens > 0) parts.push(formatCapacity(model.maxTokens))
  return parts.length === 0 ? '' : '  ' + parts.join(' · ')
}

// A stored entry as the editor's draft. `originalId` stays behind so the id can
// be corrected in place: the array is addressed by position, not by id.
export function modelDraftFrom(model) {
  const entry = typeof model === 'object' && model !== null ? model : { id: String(model ?? '') }
  return {
    originalId: typeof entry.id === 'string' ? entry.id : '',
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    contextWindow: Number.isInteger(entry.contextWindow) ? entry.contextWindow : undefined,
    maxTokens: Number.isInteger(entry.maxTokens) ? entry.maxTokens : undefined,
    input: Array.isArray(entry.input) ? [...entry.input] : undefined,
  }
}

// The model editor's rows. `id` is fixed while editing: the entry is addressed
// by position in the provider's list, and renaming it in place would silently
// change what the route serves rather than adding the model the user meant.
export function buildModelFormItems(draft, { isNew = false } = {}) {
  const items = [{
    kind: 'header',
    label: isNew ? t('model.form.add') : t('model.form.edit', { id: draft.originalId || draft.id }),
    value: '',
    disabled: true,
  }]
  if (isNew) items.push({ kind: 'model-field', field: 'id', label: t('model.field.id'), value: draft.id, modelText: true })
  else items.push({ kind: 'model-note', label: draft.originalId ?? '', wide: true, indent: 1, disabled: true, selectable: false })
  items.push({ kind: 'model-field', field: 'name', label: t('model.field.name'), value: draft.name, modelText: true })
  items.push({
    kind: 'model-field',
    field: 'contextWindow',
    label: t('model.field.contextWindow'),
    value: draft.contextWindow === undefined ? '' : formatCapacity(draft.contextWindow),
    modelText: true,
  })
  items.push({
    kind: 'model-field',
    field: 'maxTokens',
    label: t('model.field.maxTokens'),
    value: draft.maxTokens === undefined ? '' : formatCapacity(draft.maxTokens),
    modelText: true,
  })
  items.push({
    kind: 'model-field',
    field: 'input',
    label: t('model.field.input'),
    value: modelInputValue({ input: draft.input }),
    options: INPUT_MODALITIES.map((id) => ({ label: tv(id), value: id })),
  })
  items.push({ kind: 'model-save', label: t('model.form.save'), value: 'Enter', disabled: false })
  if (!isNew) items.push({ kind: 'model-remove', label: t('model.form.remove'), value: 'Enter', confirmText: t('model.form.removeConfirm'), disabled: false })
  return items
}

// Whether an editor draft can be written, or why not. `existing` is every model
// the provider already lists except the row being edited, so a corrected id
// cannot collide with a sibling.
export function validateModelDraft(draft, { existing = [] } = {}) {
  const id = String(draft.id ?? '').trim()
  if (id === '') return t('model.error.idNeeded')
  if (existing.some((model) => modelEntryId(model) === id)) return t('model.error.idDuplicate', { id })
  if (Number.isNaN(parseCapacity(draft.contextWindow))) return t('model.error.capacity')
  if (Number.isNaN(parseCapacity(draft.maxTokens))) return t('model.error.capacity')
  return undefined
}

// The draft as a stored entry: only the fields that are set, because an empty
// number is "inherit the route default" and storing it as a value the schema
// rejects would break the whole profile.
export function modelFromDraft(draft) {
  const entry = { id: String(draft.id ?? '').trim() }
  const name = String(draft.name ?? '').trim()
  if (name !== '') entry.name = name
  const contextWindow = parseCapacity(draft.contextWindow)
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  const maxTokens = parseCapacity(draft.maxTokens)
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  if (Array.isArray(draft.input) && draft.input.length > 0) entry.input = [...draft.input]
  return entry
}

// Write one editor draft over the provider's saved model list: replace the
// addressed row, or append a new one.
//
// `target.storedModels` is what the window loaded, so this is a full-array
// write against the revision the window opened at: a concurrent change from
// another surface is a conflict rather than a silent truncation.
export async function saveModelEntry(settings, target, draft) {
  const next = [...target.storedModels]
  const entry = modelFromDraft(draft)
  if (target.index >= 0 && target.index < next.length) next[target.index] = entry
  else next.push(entry)
  await settings.mutate(target.settingsNs, [{
    op: 'set',
    path: [...target.providerPath, 'models'],
    value: next,
  }], target.revision)
  return next
}

// Drop one row from the saved list. Removing the last one unsets the field
// rather than storing `[]`, so the patch carries no literal that a later
// catalog change would have to fight — for a route the installed catalog
// describes, unsetting is exactly "serve the catalog again".
//
// A hand-declared route has no catalog to fall back to, so the adapter refuses
// the write that would leave it with no models; the error surfaces to the
// caller instead of being papered over.
export async function removeModelEntry(settings, target) {
  const next = target.storedModels.filter((_model, at) => at !== target.index)
  const path = [...target.providerPath, 'models']
  await settings.mutate(target.settingsNs, [next.length === 0 ? { op: 'unset', path } : { op: 'set', path, value: next }], target.revision)
  return next
}

