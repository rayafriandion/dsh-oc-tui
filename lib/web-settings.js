import z from '@deepseek-ai/schemastery'
import { dirname } from 'node:path'
import { collectServers } from './mcp.js'
import { LOCALES, isLocaleId, localeInfo, resolveLocale, setLocale, t, tv, valueChoices } from './i18n.js'

// The settings this plugin owns. Each is declared twice on purpose: as a
// namespace for a 0.1.x settings provider (which has a registry and stores a
// document of namespaces), and as a volatile field on this plugin's Config for
// dsh 0.2.0 (whose settings page is derived from Config forms and has no
// registry at all). `namespace`/`field` are the legacy coordinates;
// `configField` is the 0.2.0 one. The values are identical, so a build serves
// both hosts and the reader/writer below picks whichever the host exposes.
export const TUI_SETTINGS = [
  // The TUI's own interface language. Deliberately NOT the WebUI's `locale`
  // namespace: the two surfaces have different translation catalogs, and one
  // setting must not drag the other's language with it. `system` follows the
  // POSIX/Windows language variables (see lib/i18n.js detectSystemLocale).
  { namespace: 'tui-locale', field: 'preference', configField: 'locale' },
  { namespace: 'ui-conversation', field: 'busyEnter', configField: 'busyEnter' },
  { namespace: 'tui-updates', field: 'startupCheck', configField: 'startupCheck' },
  // TUI-owned graphics pipeline. `graphics: off` disables protocol rendering
  // entirely; `imageFallback` decides what pixels become on terminals with no
  // graphics protocol; `mermaid` gates the provider chain (local mmdc and/or
  // the mermaid.ink network service).
  { namespace: 'tui-graphics', field: 'graphics', configField: 'graphics' },
  { namespace: 'tui-graphics', field: 'imageFallback', configField: 'imageFallback' },
  { namespace: 'tui-graphics', field: 'imageMaxRows', configField: 'imageMaxRows' },
  { namespace: 'tui-graphics', field: 'mermaid', configField: 'mermaid' },
]

const WEB_SETTING_SCHEMAS = [
  ['ui-theme', z.object({ preference: z.union(['light', 'dark', 'system']).default('system') })],
  ['locale', z.object({ preference: z.union(['zh', 'en']).required(false) })],
  ['agent-presets', z.object({ default: z.string().required(false) })],
  // The legacy (0.1.x) namespaces for the rows above. A 0.2.0 host ignores
  // these — its page comes from Config — but a 0.1.x host needs them registered
  // before `add()` can read a descriptor.
  ['ui-conversation', z.object({ busyEnter: z.union(['queue', 'steer']).default('queue') })],
  ['tui-updates', z.object({ startupCheck: z.union(['on', 'off']).default('on') })],
  ['tui-locale', z.object({ preference: z.string().default('system') })],
  ['tui-graphics', z.object({
    graphics: z.union(['auto', 'off']).default('auto'),
    imageFallback: z.union(['halfblock', 'chip']).default('halfblock'),
    imageMaxRows: z.union(['10', '15', '20', '28', '40']).default('20'),
    mermaid: z.union(['auto', 'local', 'off']).default('auto'),
  })],
]

// The settings dialog's left menu: Main keeps the general settings, Model
// carries the merged provider + model settings, Update carries the in-app
// dsh / dsh-oc-tui version manager, MCP carries the external MCP servers the
// TUI connects for the session. Tab switches the entries.
//
// `label` is a getter rather than a stored string: the menu outlives a
// language switch (the dialog repaints without reloading), so it has to
// resolve through the active catalog every time it is read.
export const SETTINGS_MENU = [
  { id: 'main', get label() { return t('menu.main') } },
  { id: 'model', get label() { return t('menu.model') } },
  { id: 'update', get label() { return t('menu.update') } },
  { id: 'mcp', get label() { return t('menu.mcp') } },
]

const MCP_MENU_INDEX = SETTINGS_MENU.findIndex((entry) => entry.id === 'mcp')

function valueAt(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = value[part]
  }
  return value
}

function hasPath(source, path) {
  let value = source
  for (const part of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return false
    value = value[part]
  }
  return true
}

function keyRef(provider) {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

// A provider's stored model catalog tolerates both string entries and
// `{ id, ... }` objects; normalize to objects with an id so the merged view
// and the picker can treat them uniformly.
function normalizeModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  for (const entry of models) {
    if (typeof entry === 'string' && entry) out.push({ id: entry })
    else if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) out.push(entry)
  }
  return out
}

function modelEntryId(entry) {
  return typeof entry === 'string' ? entry : entry?.id
}

// Picker/choice annotation: a glanceable capability marker per model.
function capabilitySuffix(model) {
  const capabilities = []
  if (Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) capabilities.push('vision')
  if (model.reasoning && Array.isArray(model.reasoning.efforts) && model.reasoning.efforts.length > 0) capabilities.push('thinking')
  return capabilities.length > 0 ? ' (' + capabilities.join(', ') + ')' : ''
}

// Discover the models a configurable provider advertises. Uses the
// model-discovery seam (`ctx.llm.discoverModels`): it answers from the
// installed catalog for a known route and interrogates a custom/dormant
// route's endpoint — resolving the stored credential itself. `listModels`
// only covers registered adapters, so it silently missed user-added
// providers that are not currently registered; it is kept as the fallback for
// namespaces that register no discovery (e.g. the built-in DeepSeek adapter).
// Returns the normalized list plus whether discovery failed.
async function fetchProviderModels(ctx, entry, record) {
  const llm = ctx.get('llm')
  let fetched = null
  let failed = false
  if (llm?.discoverModels) {
    const request = {
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      ...(typeof record.baseURL === 'string' && record.baseURL.trim().length > 0 ? { baseURL: record.baseURL } : {}),
      ...(typeof record.api === 'string' && record.api.trim().length > 0 ? { api: record.api } : {}),
    }
    try {
      fetched = await llm.discoverModels(entry.settingsNs, request)
    } catch (error) {
      // `NO_DISCOVERY` means the namespace registered no discovery; its
      // registered adapter answers from its own catalog below.
      if (error?.code !== 'NO_DISCOVERY') failed = true
    }
  }
  if (!Array.isArray(fetched) && !failed && llm?.listModels) {
    try { fetched = await llm.listModels(entry.provider) } catch { failed = true }
  }
  if (!Array.isArray(fetched) && !failed) failed = true
  return { models: normalizeModels(fetched), failed }
}

function effortOptions(models, selectedModel) {
  const model = models.find((candidate) => candidate.id === selectedModel)
  // The adapter-reported reasoning listing (LlmModelInfo.reasoning) is the
  // authoritative "can this model's thinking strength be adjusted?" answer.
  if (model?.reasoning && Array.isArray(model.reasoning.efforts)) {
    return model.reasoning.efforts.map((effort) => String(effort.id))
  }
  const efforts = model?.reasoningEfforts
  if (Array.isArray(efforts)) return efforts.map(String)
  if (efforts && typeof efforts === 'object') return Object.keys(efforts)
  return undefined
}

export function installWebSettingSchemas(ctx) {
  const settings = ctx.get('settings')
  if (!settings) return
  // dsh 0.2.0 replaced the namespace registry with per-entry Config forms
  // (`SettingsForms`): the service no longer exposes `register`, and the
  // namespaces that survive there are the ones whose host rows declare
  // volatile Config fields. One build serves both hosts — and a settings
  // failure must never take the TUI down, so registration is guarded as a
  // whole rather than trusted to succeed.
  if (typeof settings.register !== 'function') return
  try {
    const registered = new Set(settings.describe().map((entry) => String(entry.ns)))
    for (const [namespace, schema] of WEB_SETTING_SCHEMAS) {
      if (!registered.has(namespace)) settings.register(namespace, schema)
    }
  } catch { /* a settings failure must not take the TUI down */ }
}

// Main menu tab: the general settings (the models section moved to the Model
// tab together with the provider settings).
export async function loadWebSettings(ctx) {
  installWebSettingSchemas(ctx)
  const settings = ctx.get('settings')
  if (!settings) {
    return { settings: null, items: [{ label: t('settings.dshSettings'), value: t('common.unavailable'), disabled: true }], title: t('settings.title'), menu: SETTINGS_MENU, menuIndex: 0 }
  }
  const descriptors = new Map(settings.describe({ redactSecrets: true }).map((entry) => [String(entry.ns), entry]))
  const items = []
  // A row is emitted only for a setting the host actually exposes. TUI-owned
  // settings go through the two-generation resolver; everything else is a
  // namespace some other plugin registered, which only a 0.1.x-style registry
  // can serve.
  const add = (ns, field, label, options, extra = {}) => {
    const owned = TUI_SETTINGS.some((entry) => entry.namespace === ns && entry.field === field)
    const target = owned ? resolveTuiSetting(ctx, descriptors, ns, field) : undefined
    const descriptor = target?.descriptor ?? descriptors.get(ns)
    if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) return
    const raw = target ? target.value : descriptor.value[field]
    const stored = raw === undefined ? 'system' : String(raw)
    const { translateValues, ...rest } = extra
    items.push({
      kind: options?.length ? 'choice' : 'text',
      // A 0.2.0 row writes through this plugin's own Config entry, so the row
      // carries that entry id rather than the legacy namespace name.
      ns: target?.ns ?? ns,
      field: target?.field ?? field,
      // A locale row clears the field differently depending on which host it
      // is writing to (see saveWebSetting); `settingGroup` is the legacy
      // namespace name, which the commit path uses to recognize the row it
      // knows how to apply live (graphics, language).
      ...(owned ? { settingGroup: ns, legacySetting: target?.legacy === true } : {}),
      label,
      value: stored,
      // The row shows the translated label of the stored id; the id itself is
      // what gets committed (see lib/index.js openSettingChoices).
      ...(translateValues ? { valueLabel: tv(stored) } : {}),
      options: options ? (translateValues ? valueChoices(options) : options) : undefined,
      revision: descriptor.revision,
      disabled: !settings.writable,
      ...rest,
    })
  }
  items.push({ kind: 'header', label: t('settings.general'), value: '', disabled: true })
  // The language row reads its own label: the stored value is a locale id, and
  // the label is the language's native name.
  const locale = resolveTuiSetting(ctx, descriptors, 'tui-locale', 'preference')
  if (locale) {
    add('tui-locale', 'preference', t('settings.language'), localeChoices(), {
      kind: 'locale',
      valueLabel: describeLocale(normalizePreference(locale.value)),
    })
  }
  add('ui-conversation', 'busyEnter', t('settings.busyEnter'), ['queue', 'steer'], { translateValues: true })
  const agentPresets = ctx.get('agentPresets')
  let presetOptions
  if (agentPresets) {
    try {
      // The roster is best-effort: an unreadable root must not take down the
      // whole settings panel. Broken presets are excluded because no session
      // can be composed from one.
      presetOptions = (await agentPresets.list())
        .filter((preset) => preset.broken === undefined)
        .map((preset) => preset.id)
    } catch { /* roster unavailable; fall back to the free-text row below */ }
  }
  add('agent-presets', 'default', t('settings.defaultPreset'), presetOptions, presetOptions?.length ? { kind: 'agent-preset', value: agentPresets.defaultId } : undefined)
  const permissionPresets = ctx.get('permissionPresets')
  add('permission', 'defaultPreset', t('settings.permissionPreset'), permissionPresets ? [...permissionPresets.names] : undefined, { confirmValue: 'danger-full-access', confirmText: t('settings.permissionDangerConfirm') })

  items.push({ kind: 'header', label: t('settings.graphics'), value: '', disabled: true })
  add('tui-graphics', 'graphics', t('settings.graphicsRendering'), ['auto', 'off'], { translateValues: true })
  add('tui-graphics', 'imageFallback', t('settings.noProtocolFallback'), ['halfblock', 'chip'], { translateValues: true })
  add('tui-graphics', 'imageMaxRows', t('settings.imageHeightCap'), ['10', '15', '20', '28', '40'])
  add('tui-graphics', 'mermaid', t('settings.mermaidRendering'), ['auto', 'local', 'off'], { translateValues: true })

  items.push({ kind: 'header', label: t('settings.sessions'), value: '', disabled: true })
  items.push({ kind: 'new-session', label: t('settings.newSession'), value: 'Enter', disabled: false })
  items.push({ kind: 'manage-sessions', label: t('settings.manageSessions'), value: 'Enter', disabled: false })
  items.push({ kind: 'header', label: t('settings.system'), value: '', disabled: true })
  items.push({ kind: 'provider-config-info', label: t('settings.providerConfig'), value: t('menu.model'), disabled: true })
  items.push({ kind: 'open-update', label: t('settings.updateManager'), value: t('menu.update'), disabled: false })
  // The 0.2.0 form service resolves the document through its
  // configuration editor, which a composition without that row never mounts,
  // so the getter can throw where the 0.1.x provider returned undefined.
  let settingsDocumentPath
  try { settingsDocumentPath = settings.documentPath } catch { /* no configuration editor */ }
  if (settingsDocumentPath) items.push({ label: t('settings.settingsFile'), value: settingsDocumentPath, disabled: true })
  return { settings, items, title: t('settings.title'), menu: SETTINGS_MENU, menuIndex: 0 }
}

// The language picker's rows: the stored value is a locale id (or `system`),
// the label is the language's own name so a user looking for their language
// finds it without already reading the current one.
export function localeChoices() {
  return [{ label: describeLocale('system'), value: 'system' }, ...LOCALES.map((entry) => ({ label: entry.native, value: entry.id }))]
}

// The language row's display label for the stored preference.
export function describeLocale(preference) {
  const systemId = resolveLocale('system')
  if (!preference || preference === 'system' || !isLocaleId(preference)) {
    return t('settings.languageSystem', { language: localeInfo(systemId).native })
  }
  return localeInfo(preference).native
}

// A stored value that is not a usable locale id means "follow the system", not
// "render an empty row".
function normalizePreference(value) {
  return typeof value === 'string' && value !== '' ? value : 'system'
}

function describeAll(settings) {
  try {
    return new Map((settings?.describe?.({ redactSecrets: true }) ?? []).map((entry) => [String(entry.ns), entry]))
  } catch {
    return new Map()
  }
}

// This plugin's own Config entry on a host that derives settings from Config
// forms. `describe()` keys rows by the entry's raw `options.id` (not the
// namespaced `Entry.id`), so that is what identifies the row here. A host that
// composes the plugin without a loader row (a test harness, or the zero-install
// bootstrap naming its own row id) leaves `entry` undefined, and there the entry
// carrying the whole set of TUI-owned fields is this plugin's by construction.
const TUI_CONFIG_FIELDS = TUI_SETTINGS.map((entry) => entry.configField)

function ownEntryDescriptor(ctx, descriptors) {
  const entryId = ctx?.fiber?.entry?.options?.id
  if (typeof entryId === 'string' && entryId !== '') {
    const own = descriptors.get(entryId)
    if (own) return { ns: entryId, descriptor: own }
  }
  const candidates = [...descriptors].filter(([, descriptor]) => descriptor?.value !== null
    && typeof descriptor?.value === 'object'
    && TUI_CONFIG_FIELDS.every((field) => Object.hasOwn(descriptor.value, field)))
  return candidates.length === 1
    ? { ns: candidates[0][0], descriptor: candidates[0][1] }
    : undefined
}

// Where one TUI-owned setting actually lives on this host: the registered
// namespace a 0.1.x provider stores, or the volatile Config field a 0.2.0 host
// projects into its page. Undefined means the host exposes neither, and the
// caller omits the row rather than rendering one that cannot be read or written.
export function resolveTuiSetting(ctx, descriptors, namespace, field) {
  const declared = TUI_SETTINGS.find((entry) => entry.namespace === namespace && entry.field === field)
  const legacy = descriptors.get(namespace)
  if (legacy && typeof legacy.value === 'object' && legacy.value !== null) {
    return { ns: namespace, field, configField: declared?.configField, legacy: true, descriptor: legacy, value: legacy.value[field] }
  }
  if (!declared) return undefined
  const own = ownEntryDescriptor(ctx, descriptors)
  if (!own || typeof own.descriptor.value !== 'object' || own.descriptor.value === null) return undefined
  if (!Object.hasOwn(own.descriptor.value, declared.configField)) return undefined
  return {
    ns: own.ns,
    field: declared.configField,
    configField: declared.configField,
    legacy: false,
    descriptor: own.descriptor,
    value: own.descriptor.value[declared.configField],
  }
}

// Read one TUI-owned setting without requiring a settings service. The stored
// descriptor wins; failing that (a host whose forms have not settled yet, or a
// host with no form service at all) the running Config reference is the honest
// source, because a volatile field is kept current by the loader.
export function readTuiSetting(ctx, config, namespace, field) {
  const settings = ctx?.get?.('settings')
  const target = resolveTuiSetting(ctx, describeAll(settings), namespace, field)
  if (target) return target.value
  const declared = TUI_SETTINGS.find((entry) => entry.namespace === namespace && entry.field === field)
  const raw = declared ? config?.[declared.configField] : undefined
  return typeof raw?.get === 'function' ? raw.get() : raw
}

// The stored language preference (a locale id or `system`), read live from the
// settings service so the Language row and the boot path agree.
export function readLocalePreference(ctx, config) {
  return normalizePreference(readTuiSetting(ctx, config, 'tui-locale', 'preference'))
}

// Apply the stored language preference to the active catalog. Called at boot
// and again whenever the Language row is committed.
export function applyLocalePreference(ctx, config) {
  return setLocale(resolveLocale(readLocalePreference(ctx, config)))
}
// Model menu tab: the merged provider + model settings. Per provider:
// Provider URL, Provider API key, Models (the saved selection, listed below
// the row; Enter auto-fetches the catalog and opens the selection window).
export async function loadModelSettings(ctx) {
  installWebSettingSchemas(ctx)
  const settings = ctx.get('settings')
  if (!settings) {
    return { settings: null, items: [{ label: t('model.title'), value: t('common.unavailable'), disabled: true }], title: t('model.title'), menu: SETTINGS_MENU, menuIndex: 1 }
  }
  const descriptors = new Map(settings.describe({ redactSecrets: true }).map((entry) => [String(entry.ns), entry]))
  const items = []
  const add = (ns, field, label, options, extra = {}) => {
    const descriptor = descriptors.get(ns)
    if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) return
    const value = descriptor.value[field]
    items.push({ kind: options?.length ? 'choice' : 'text', ns, field, label, value: value === undefined ? 'system' : String(value), options, revision: descriptor.revision, disabled: !settings.writable, ...extra })
  }
  const llm = ctx.get('llm')
  const credentials = ctx.get('credentials')

  // Only providers the user has actually added are listed. A provider counts
  // as added when its profile is present in the user settings layer; a
  // built-in namespace provider (empty settings path) counts only when the
  // user configured something in that namespace. Preset providers that were
  // never added stay hidden.
  const configurable = (llm?.listConfigurableProviders?.() ?? []).filter((entry) => {
    const descriptor = descriptors.get(entry.settingsNs)
    if (!descriptor) return false
    if (entry.settingsPath.length === 0) {
      return descriptor.user && typeof descriptor.user === 'object'
        && Object.keys(descriptor.user).length > 0
    }
    return hasPath(descriptor.user, entry.settingsPath)
  })

  // ---- default route ----------------------------------------------------
  items.push({ kind: 'header', label: t('model.defaultSection'), value: '', disabled: true })
  const providers = descriptors.get('llm-pi-ai')?.value?.providers
  const providerEntries = providers && typeof providers === 'object' ? Object.entries(providers) : []
  const defaultModel = descriptors.get('agent-default-model')?.value
  const selectedProvider = defaultModel && typeof defaultModel === 'object' ? defaultModel.provider : undefined
  const selectedModel = defaultModel && typeof defaultModel === 'object' ? defaultModel.model : undefined
  const liveProviders = llm?.listProviders?.() ?? []
  const providerOptions = liveProviders.length > 0 ? liveProviders.map((provider) => provider.id) : providerEntries.map(([id]) => id)
  // The default-model options are exactly the models the user has saved under
  // the selected provider (its `models` list). Do not auto-fetch the provider
  // catalog here: that catalog can include models the user never added, and it
  // would diverge from the saved selection shown in the provider block below.
  // The auto-fetched catalog stays available behind the Models row (Enter →
  // loadProviderModels).
  const selectedEntry = configurable.find((entry) => entry.provider === selectedProvider)
  let models = []
  if (selectedEntry) {
    const selectedDescriptor = descriptors.get(selectedEntry.settingsNs)
    const selectedProfile = selectedDescriptor ? valueAt(selectedDescriptor.value, selectedEntry.settingsPath) : undefined
    const selectedRecord = typeof selectedProfile === 'object' && selectedProfile !== null ? selectedProfile : {}
    models = normalizeModels(selectedRecord.models)
  } else {
    models = normalizeModels(providerEntries.find(([id]) => id === selectedProvider)?.[1]?.models)
  }
  add('agent-default-model', 'provider', t('model.defaultProvider'), providerOptions, { kind: 'default-provider' })
  // The picker annotates each candidate with its capabilities, so a user can
  // tell at a glance which models take image input and which can adjust their
  // thinking strength instead of discovering the refusal after sending.
  const modelOptions = models.map((model) => {
    const suffix = capabilitySuffix(model)
    return suffix ? { label: model.id + suffix, value: model.id } : model.id
  })
  add('agent-default-model', 'model', t('model.defaultModel'), modelOptions, { kind: 'default-model' })
  let reasoningOptions = effortOptions(models, selectedModel)
  let reasoningDefault
  if (llm?.resolveModelInfo && selectedProvider && selectedModel) {
    try {
      const info = await llm.resolveModelInfo(selectedProvider, selectedModel)
      reasoningOptions = info.reasoning?.efforts.map((effort) => String(effort.id))
      reasoningDefault = info.reasoning?.defaultEffort === undefined ? undefined : String(info.reasoning.defaultEffort)
    } catch { /* keep catalog fallback */ }
  }
  const configuredEffort = defaultModel?.reasoningEffort === undefined ? undefined : String(defaultModel.reasoningEffort)
  const reasoningValue = reasoningOptions?.includes(configuredEffort)
    ? configuredEffort
    : reasoningOptions?.includes(reasoningDefault) ? reasoningDefault : undefined
  const reasoningExtra = reasoningOptions?.length
    ? { kind: 'effort', ...reasoningValue === undefined ? {} : { value: reasoningValue } }
    : undefined
  add('agent-default-model', 'reasoningEffort', t('model.reasoning'), reasoningOptions, reasoningExtra)

  // ---- merged provider blocks --------------------------------------------
  for (const entry of configurable) {
    const descriptor = descriptors.get(entry.settingsNs)
    if (!descriptor) continue
    items.push({ kind: 'header', label: entry.displayName, value: '', disabled: true })
    const profile = valueAt(descriptor.value, entry.settingsPath)
    const removable = entry.settingsPath.length > 0 && hasPath(descriptor.user, entry.settingsPath) && !hasPath(descriptor.base, entry.settingsPath)
    const record = typeof profile === 'object' && profile !== null ? profile : {}
    const ref = typeof record.apiKeyEnv === 'string' && record.apiKeyEnv ? record.apiKeyEnv : keyRef(entry.provider)
    let credential
    try { credential = credentials ? await credentials.describe(ref) : undefined } catch { credential = undefined }
    if (entry.settingsNs === 'llm-deepseek' || entry.settingsNs === 'llm-pi-ai') items.push({ kind: 'path', label: t('model.providerUrl'), value: typeof record.baseURL === 'string' ? record.baseURL : 'default', ns: entry.settingsNs, path: [...entry.settingsPath, 'baseURL'], revision: descriptor.revision, disabled: !settings.writable })
    items.push({ kind: 'secret', label: t('model.providerApiKey'), value: credential?.configured ? t('model.credentialConfigured', { source: credential.source ?? 'stored' }) : t('model.credentialMissing'), credentialRef: ref, disabled: !credentials || credential?.writable === false })
    if (entry.settingsNs === 'llm-pi-ai' && entry.declared === true) {
      items.push({ kind: 'path', label: t('model.displayName'), value: typeof record.displayName === 'string' ? record.displayName : entry.displayName, ns: entry.settingsNs, path: [...entry.settingsPath, 'displayName'], revision: descriptor.revision, disabled: !settings.writable })
      const choices = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
      items.push({ kind: 'path-choice', label: t('model.wireProtocol'), value: typeof record.api === 'string' ? record.api : choices[0], options: choices, ns: entry.settingsNs, path: [...entry.settingsPath, 'api'], revision: descriptor.revision, disabled: !settings.writable })
    }
    // Route-level request modalities. This is what makes a hand-declared vision
    // model usable: pi-ai under-claims text by default (refusing the image before
    // it is attached is the safe answer when nothing is declared), so a gateway
    // serving vision models declares `[text, image]` once here instead of on
    // every entry. Catalog models keep the modalities the catalog records for
    // them; this value never narrows one.
    if (entry.settingsNs === 'llm-pi-ai') {
      const declaredInput = Array.isArray(record.defaultInput) ? record.defaultInput : undefined
      items.push({
        kind: 'input-modalities',
        label: t('model.defaultImageInput'),
        value: declaredInput?.includes('image') ? 'text + image' : 'text only',
        options: ['text only', 'text + image'].map((id) => ({ label: tv(id), value: id })),
        ns: entry.settingsNs,
        path: [...entry.settingsPath, 'defaultInput'],
        revision: descriptor.revision,
        disabled: !settings.writable,
      })
    }
    // Models: Enter auto-fetches the provider catalog and opens the selection
    // window; the saved selection is listed right below, one row per model.
    const stored = normalizeModels(record.models)
    items.push({ kind: 'provider-models', label: t('model.models'), value: stored.length > 0 ? t('model.selectedCount', { count: stored.length }) : t('model.fetch'), providerId: entry.provider, disabled: false })
    for (const model of stored) {
      const isDefault = entry.provider === selectedProvider && model.id === selectedModel
      items.push({
        kind: 'provider-model',
        label: model.id,
        value: isDefault ? t('model.defaultTag') : '',
        indent: 1,
        modelId: model.id,
        providerId: entry.provider,
        ns: 'agent-default-model',
        revision: descriptors.get('agent-default-model')?.revision,
        disabled: false,
      })
    }
    if (removable) items.push({ kind: 'remove-provider', label: t('model.removeProvider'), value: 'Enter', ns: entry.settingsNs, path: entry.settingsPath, revision: descriptor.revision, credentialRef: credential?.configured && credential?.writable ? ref : undefined, confirmText: t('model.removeProviderConfirm', { name: entry.displayName }), disabled: !settings.writable })
  }
  return { settings, items, title: t('model.title'), subtitle: t('model.subtitle'), menu: SETTINGS_MENU, menuIndex: 1 }
}

// The auto-fetched model selection window for one provider: the provider's
// discovered catalog (`ctx.llm.discoverModels`, with a registered-adapter
// `listModels` fallback) as checkbox rows marking the saved selection. Enter
// toggles a model in or out of the provider's saved models list. A failed
// fetch falls back to the saved selection so stored models stay manageable.
export async function loadProviderModels(ctx, providerId) {
  const settings = ctx.get('settings')
  const entry = ctx.get('llm')?.listConfigurableProviders?.().find((candidate) => candidate.provider === providerId)
  if (!settings || !entry) throw new Error(t('model.providerUnavailable'))
  const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === entry.settingsNs)
  if (!descriptor) throw new Error(t('model.namespaceUnavailable'))
  const profile = valueAt(descriptor.value, entry.settingsPath)
  const record = typeof profile === 'object' && profile !== null ? profile : {}
  const stored = normalizeModels(record.models)
  const storedIds = new Set(stored.map((model) => model.id))
  const discovered = await fetchProviderModels(ctx, entry, record)
  const fetched = discovered.models
  const fetchFailed = discovered.failed
  const items = []
  const seen = new Set()
  const pushRow = (model) => {
    if (!model?.id || seen.has(model.id)) return
    seen.add(model.id)
    const checked = storedIds.has(model.id)
    items.push({
      kind: 'model-toggle',
      label: model.id + capabilitySuffix(model),
      value: checked ? '[x]' : '[ ]',
      modelId: model.id,
      checked,
      selectedIds: [...storedIds],
      storedModels: stored,
      providerId,
      settingsNs: entry.settingsNs,
      providerPath: entry.settingsPath,
      revision: descriptor.revision,
      disabled: !settings.writable,
    })
  }
  for (const model of fetched) pushRow(model)
  // Saved models that the catalog no longer returns stay toggleable.
  for (const model of stored) pushRow(model)
  if (items.length === 0) {
    items.push({ label: fetchFailed ? t('model.noModels') : t('model.noModelsReturned'), value: '', disabled: true })
  }
  return {
    settings,
    items,
    title: entry.displayName + ' · ' + t('model.models').toLowerCase(),
    subtitle: fetchFailed
      ? t('model.fetchUnavailable')
      : t('model.fetchOk'),
  }
}

export async function saveWebSetting(ctx, settings, item, value) {
  if (!item || item.disabled) return
  if (item.kind === 'secret') {
    if (!value.trim()) throw new Error(t('model.apiKeyEmpty'))
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error(t('model.credentialsUnavailable'))
    await credentials.set(item.credentialRef, value.trim())
    return
  }
  if (item.kind === 'path' || item.kind === 'path-choice') {
    const trimmed = value.trim()
    const op = trimmed === '' || trimmed === 'default' ? { op: 'unset', path: item.path } : { op: 'set', path: item.path, value: trimmed }
    await settings.mutate(item.ns, [op], item.revision)
    return
  }
  if (item.kind === 'input-modalities') {
    const modalities = value.trim() === tv('text + image') || value.trim() === 'text + image' ? ['text', 'image'] : ['text']
    await settings.mutate(item.ns, [{ op: 'set', path: item.path, value: modalities }], item.revision)
    return
  }
  if (item.kind === 'enable-provider') return settings.mutate(item.ns, [{ op: 'set', path: item.path, value: {} }], item.revision)
  if (item.kind === 'remove-provider') {
    const credentials = ctx.get('credentials')
    if (item.credentialRef && credentials) await credentials.unset(item.credentialRef)
    return settings.mutate(item.ns, [{ op: 'unset', path: item.path }], item.revision)
  }
  if (item.kind === 'default-provider') {
    // Resolve the new provider's first advertised model through the same
    // discovery seam as the model pickers, so a user-added (dormant) provider
    // answers its full catalog instead of failing on `listModels`.
    const llm = ctx.get('llm')
    let model
    const entry = llm?.listConfigurableProviders?.().find((candidate) => candidate.provider === value)
    if (entry) {
      const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === entry.settingsNs)
      const profile = descriptor ? valueAt(descriptor.value, entry.settingsPath) : undefined
      const record = typeof profile === 'object' && profile !== null ? profile : {}
      const discovered = await fetchProviderModels(ctx, entry, record)
      model = discovered.models[0]?.id
    } else {
      const models = await llm?.listModels?.(value)
      model = models?.[0]?.id
    }
    if (!model) throw new Error(t('model.noProviderModels'))
    return settings.mutate(item.ns, [
      { op: 'set', path: ['provider'], value },
      { op: 'set', path: ['model'], value: model },
      { op: 'unset', path: ['reasoningEffort'] },
    ], item.revision)
  }
  if (item.kind === 'default-model') {
    return settings.mutate(item.ns, [
      { op: 'set', path: ['model'], value },
      { op: 'unset', path: ['reasoningEffort'] },
    ], item.revision)
  }
  // A model listed under its provider becomes the default route.
  if (item.kind === 'provider-model') {
    return settings.mutate(item.ns, [
      { op: 'set', path: ['provider'], value: item.providerId },
      { op: 'set', path: ['model'], value: item.modelId },
      { op: 'unset', path: ['reasoningEffort'] },
    ], item.revision)
  }
  // The auto-fetched selection window: toggle one model in or out of the
  // provider's saved models list. Existing stored entries keep their shape;
  // additions are plain `{ id }` records.
  if (item.kind === 'model-toggle') {
    const ids = new Set(item.selectedIds ?? [])
    if (item.checked) ids.delete(item.modelId)
    else ids.add(item.modelId)
    const next = []
    for (const entry of item.storedModels ?? []) {
      if (ids.has(modelEntryId(entry))) next.push(entry)
    }
    for (const id of ids) {
      if (!next.some((entry) => modelEntryId(entry) === id)) next.push({ id })
    }
    return settings.mutate(item.settingsNs, [{ op: 'set', path: [...item.providerPath, 'models'], value: next }], item.revision)
  }
  if (!item.ns || !item.field) return
  if (item.ns === 'locale' && item.field === 'preference' && value === 'system') return settings.replace(item.ns, {}, item.revision)
  // A TUI-owned field set back to the value it defaults to is cleared rather
  // than written: the profile patch then carries no literal that a later
  // default change would have to fight, and `system` keeps following the OS.
  // The legacy namespace clears as a whole; a Config field unsets alone.
  if (item.legacySetting === true && value === 'system') return settings.replace(item.ns, {}, item.revision)
  if (item.kind === 'locale' && value === 'system') {
    return settings.mutate(item.ns, [{ op: 'unset', path: [item.field] }], item.revision)
  }
  return settings.update(item.ns, { [item.field]: value }, item.revision)
}

// MCP menu tab: the servers the TUI would mount for the current session, read
// from the `mcp.json` config files themselves (lib/mcp.js owns that format).
// Each row carries the live connection state and the tools the server put on
// the session's agent; the file list underneath answers "where does this come
// from", which is the whole diagnostic when a server is missing. Enter opens
// the add/edit form, Del removes. Reading is filesystem-only, so a broken or
// unreadable file degrades to an error row here and never to a failed tab.
export async function loadMcpSettings(ctx, manager, { cwd } = {}) {
  const collected = await collectServers(cwd ?? process.cwd())
  manager?.setConfigured?.(collected.servers)
  const statuses = manager?.status?.() ?? []
  const items = [{ kind: 'header', label: t('mcp.servers'), value: '', disabled: true }]
  if (statuses.length === 0) {
    items.push({ kind: 'mcp-empty', label: t('mcp.empty'), value: '', disabled: true, selectable: false })
  }
  for (const status of statuses) {
    items.push({
      kind: 'mcp-server',
      label: status.name,
      value: describeState(status),
      tone: status.state === 'error' ? 'warning' : status.state === 'connected' ? 'success' : undefined,
      serverName: status.name,
      record: status.record,
      disabled: false,
    })
    // The type, target, scope and tool names are information rows: navigation
    // steps over them so the selection never rests on a row with no action.
    items.push({
      kind: 'mcp-target',
      label: typeLabel(status.type),
      value: status.target,
      indent: 1,
      disabled: true,
      selectable: false,
    })
    items.push({
      kind: 'mcp-scope',
      label: t('mcp.scope'),
      value: describeScope(status),
      indent: 1,
      disabled: true,
      selectable: false,
    })
    for (const tool of status.tools ?? []) {
      items.push({ kind: 'mcp-tool', label: tool, value: '', indent: 1, disabled: true, selectable: false })
    }
  }
  items.push({ kind: 'mcp-add', label: t('mcp.add'), value: 'Enter', disabled: false })
  items.push({ kind: 'header', label: t('mcp.configFiles'), value: '', disabled: true })
  for (const file of collected.files) {
    items.push({
      kind: 'mcp-file',
      label: file.scope === 'user' ? t('mcp.userScope') : shorten(file.directory ?? dirname(file.path), 40),
      value: describeFile(file),
      indent: 1,
      disabled: true,
      selectable: false,
    })
  }
  // The deliberate simplification behind no credential vault: env values and
  // headers are written into these files as plain text.
  items.push({ kind: 'mcp-secrets', label: t('mcp.secrets'), value: t('mcp.secretsPlain'), disabled: true, selectable: false })
  return {
    settings: null,
    items,
    title: t('mcp.title'),
    subtitle: t('mcp.subtitle'),
    menu: SETTINGS_MENU,
    menuIndex: MCP_MENU_INDEX,
    servers: collected.servers,
    files: collected.files,
  }
}

const MCP_TYPE_KEYS = { stdio: 'mcp.type.stdio', http: 'mcp.type.http', sse: 'mcp.type.sse' }

function typeLabel(type) {
  const key = MCP_TYPE_KEYS[type]
  return key ? t(key) : String(type ?? '')
}

function describeFile(file) {
  if (file.error) return '⚠ ' + shorten(file.error, 32)
  return file.exists ? t('mcp.loaded') : t('mcp.notCreated')
}

// Where a row's config lives, for the "why is this server here" question: the
// user file applies everywhere, a path file applies to sessions under its
// directory.
function describeScope(status) {
  const source = String(status.sourcePath ?? '')
  if (status.scope !== 'path') return t('mcp.scopeUserPrefix', { path: shorten(source, 48) })
  return t('mcp.scopePathPrefix', { path: shorten(source.replace(/[\\/]\.dsh[\\/]mcp\.json$/, ''), 48) })
}

export function describeState(status) {
  switch (status.state) {
    case 'connected':
      return status.tools === null
        ? '● ' + t('mcp.state.connected')
        : '● ' + (status.tools.length === 1
          ? t('mcp.state.tools.one', { count: 1 })
          : t('mcp.state.tools.other', { count: status.tools.length }))
    case 'pending':
      return '… ' + t('mcp.state.pending')
    case 'error':
      return '⚠ ' + shorten(status.error, 32)
    case 'disabled':
      return '○ ' + t('mcp.state.disabled')
    default:
      return '○ ' + t('mcp.state.idle')
  }
}

function shorten(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

// The add/edit form. `type` decides which connection fields exist and `scope`
// whether the path row exists, so switching either rebuilds the list instead of
// showing fields that would be ignored.
export function buildMcpFormItems(draft, { isEdit = false } = {}) {
  const items = [{ kind: 'header', label: isEdit ? t('mcp.form.edit', { name: draft.originalName || draft.name }) : t('mcp.form.add'), value: '', disabled: true }]
  // A stored server's name is its identity: it is the config key and the tool
  // namespace, so it stays fixed while editing and is only typed when adding.
  items.push({ kind: 'mcp-field', field: 'name', label: t('mcp.field.name'), value: draft.name, mcpText: true, disabled: isEdit })
  items.push({ kind: 'mcp-field', field: 'type', label: t('mcp.field.type'), value: draft.type, options: mcpTypeChoices() })
  items.push({ kind: 'mcp-field', field: 'timeoutMs', label: t('mcp.field.timeout'), value: draft.timeoutMs, mcpText: true })
  if (draft.type === 'stdio') {
    mcpField(items, draft, 'command', t('mcp.field.command'))
    mcpField(items, draft, 'args', t('mcp.field.args'))
    mcpField(items, draft, 'env', t('mcp.field.env'))
  } else {
    mcpField(items, draft, 'url', t('mcp.field.url'))
    mcpField(items, draft, 'headers', t('mcp.field.headers'))
  }
  items.push({ kind: 'mcp-field', field: 'scope', label: t('mcp.field.scope'), value: draft.scope, options: mcpScopeChoices() })
  if (draft.scope === 'path') mcpField(items, draft, 'path', t('mcp.field.path'))
  items.push({ kind: 'mcp-field', field: 'enabled', label: t('mcp.field.enabled'), value: draft.enabled === false ? 'off' : 'on', options: valueChoices(['on', 'off']) })
  items.push({ kind: 'mcp-save', label: t('mcp.field.save'), value: 'Enter' })
  if (isEdit) {
    items.push({
      kind: 'mcp-remove',
      label: t('mcp.field.remove'),
      value: 'Enter',
      serverName: draft.originalName || draft.name,
      confirmText: t('mcp.removeConfirm'),
    })
  }
  return items
}

// The choice rows carry their label separately from the committed value so the
// value in the config file stays the short id (`stdio`, `user`, `path`).
// Functions, not constants: the labels are resolved per call, so a language
// switch while the form is open renames them.
export function mcpTypeChoices() {
  return [
    { label: t('mcp.choice.stdio'), value: 'stdio' },
    { label: t('mcp.choice.http'), value: 'http' },
    { label: t('mcp.choice.sse'), value: 'sse' },
  ]
}

export function mcpScopeChoices() {
  return [
    { label: t('mcp.choice.scopeUser'), value: 'user' },
    { label: t('mcp.choice.scopePath'), value: 'path' },
  ]
}

function mcpField(items, draft, field, label) {
  items.push({
    kind: 'mcp-field',
    field,
    label,
    value: String(draft[field] ?? ''),
    mcpText: true,
    disabled: false,
  })
}

