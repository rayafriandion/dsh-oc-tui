import z from '@deepseek-ai/schemastery'

const WEB_SETTING_SCHEMAS = [
  ['ui-theme', z.object({ preference: z.union(['light', 'dark', 'system']).default('system') })],
  ['locale', z.object({ preference: z.union(['zh', 'en']).required(false) })],
  ['ui-conversation', z.object({ busyEnter: z.union(['queue', 'steer']).default('queue') })],
  ['agent-presets', z.object({ default: z.string().required(false) })],
]

// The settings dialog's left menu: Main keeps the general settings, Model
// carries the merged provider + model settings. Tab switches the entries.
export const SETTINGS_MENU = [
  { id: 'main', label: 'Main' },
  { id: 'model', label: 'Model' },
]

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
  const registered = new Set(settings.describe().map((entry) => String(entry.ns)))
  for (const [namespace, schema] of WEB_SETTING_SCHEMAS) {
    if (!registered.has(namespace)) settings.register(namespace, schema)
  }
}

// Main menu tab: the general settings (the models section moved to the Model
// tab together with the provider settings).
export async function loadWebSettings(ctx) {
  installWebSettingSchemas(ctx)
  const settings = ctx.get('settings')
  if (!settings) {
    return { settings: null, items: [{ label: 'DSH settings', value: 'unavailable', disabled: true }], title: 'Settings', menu: SETTINGS_MENU, menuIndex: 0 }
  }
  const descriptors = new Map(settings.describe({ redactSecrets: true }).map((entry) => [String(entry.ns), entry]))
  const items = []
  const add = (ns, field, label, options, extra = {}) => {
    const descriptor = descriptors.get(ns)
    if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) return
    const value = descriptor.value[field]
    items.push({ kind: options?.length ? 'choice' : 'text', ns, field, label, value: value === undefined ? 'system' : String(value), options, revision: descriptor.revision, disabled: !settings.writable, ...extra })
  }
  // `ui-theme` (General · Appearance) and `locale` (General · Language) are
  // WebUI-only settings; they have no effect inside the TUI, so they are not
  // projected here.
  items.push({ kind: 'header', label: 'General', value: '', disabled: true })
  add('ui-conversation', 'busyEnter', 'Busy Enter', ['queue', 'steer'])
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
  add('agent-presets', 'default', 'Default preset', presetOptions, presetOptions?.length ? { kind: 'agent-preset', value: agentPresets.defaultId } : undefined)
  const permissionPresets = ctx.get('permissionPresets')
  add('permission', 'defaultPreset', 'Permission preset', permissionPresets ? [...permissionPresets.names] : undefined, { confirmValue: 'danger-full-access', confirmText: 'Enable unrestricted tool and file access?' })

  items.push({ kind: 'header', label: 'Sessions', value: '', disabled: true })
  items.push({ kind: 'new-session', label: 'New session', value: 'Enter', disabled: false })
  items.push({ kind: 'manage-sessions', label: 'Manage sessions', value: 'Enter', disabled: false })
  items.push({ kind: 'header', label: 'System', value: '', disabled: true })
  items.push({ kind: 'provider-config-info', label: 'Provider API config', value: 'Model tab', disabled: true })
  if (settings.documentPath) items.push({ label: 'Settings file', value: settings.documentPath, disabled: true })
  return { settings, items, title: 'Settings', menu: SETTINGS_MENU, menuIndex: 0 }
}

// Model menu tab: the merged provider + model settings. Per provider:
// Provider URL, Provider API key, Models (the saved selection, listed below
// the row; Enter auto-fetches the catalog and opens the selection window).
export async function loadModelSettings(ctx) {
  installWebSettingSchemas(ctx)
  const settings = ctx.get('settings')
  if (!settings) {
    return { settings: null, items: [{ label: 'Model settings', value: 'unavailable', disabled: true }], title: 'Model', menu: SETTINGS_MENU, menuIndex: 1 }
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
  items.push({ kind: 'header', label: 'Default', value: '', disabled: true })
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
  add('agent-default-model', 'provider', 'Default provider', providerOptions, { kind: 'default-provider' })
  // The picker annotates each candidate with its capabilities, so a user can
  // tell at a glance which models take image input and which can adjust their
  // thinking strength instead of discovering the refusal after sending.
  const modelOptions = models.map((model) => {
    const suffix = capabilitySuffix(model)
    return suffix ? { label: model.id + suffix, value: model.id } : model.id
  })
  add('agent-default-model', 'model', 'Default model', modelOptions, { kind: 'default-model' })
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
  add('agent-default-model', 'reasoningEffort', 'Reasoning', reasoningOptions, reasoningExtra)

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
    if (entry.settingsNs === 'llm-deepseek' || entry.settingsNs === 'llm-pi-ai') items.push({ kind: 'path', label: 'Provider URL', value: typeof record.baseURL === 'string' ? record.baseURL : 'default', ns: entry.settingsNs, path: [...entry.settingsPath, 'baseURL'], revision: descriptor.revision, disabled: !settings.writable })
    items.push({ kind: 'secret', label: 'Provider API key', value: credential?.configured ? 'configured (' + (credential.source ?? 'stored') + ')' : 'not configured', credentialRef: ref, disabled: !credentials || credential?.writable === false })
    if (entry.settingsNs === 'llm-pi-ai' && entry.declared === true) {
      items.push({ kind: 'path', label: 'Display name', value: typeof record.displayName === 'string' ? record.displayName : entry.displayName, ns: entry.settingsNs, path: [...entry.settingsPath, 'displayName'], revision: descriptor.revision, disabled: !settings.writable })
      const choices = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
      items.push({ kind: 'path-choice', label: 'Wire protocol', value: typeof record.api === 'string' ? record.api : choices[0], options: choices, ns: entry.settingsNs, path: [...entry.settingsPath, 'api'], revision: descriptor.revision, disabled: !settings.writable })
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
        label: 'Default image input',
        value: declaredInput?.includes('image') ? 'text + image' : 'text only',
        options: ['text only', 'text + image'],
        ns: entry.settingsNs,
        path: [...entry.settingsPath, 'defaultInput'],
        revision: descriptor.revision,
        disabled: !settings.writable,
      })
    }
    // Models: Enter auto-fetches the provider catalog and opens the selection
    // window; the saved selection is listed right below, one row per model.
    const stored = normalizeModels(record.models)
    items.push({ kind: 'provider-models', label: 'Models', value: stored.length > 0 ? stored.length + ' selected' : 'fetch…', providerId: entry.provider, disabled: false })
    for (const model of stored) {
      const isDefault = entry.provider === selectedProvider && model.id === selectedModel
      items.push({
        kind: 'provider-model',
        label: model.id,
        value: isDefault ? 'default' : '',
        indent: 1,
        modelId: model.id,
        providerId: entry.provider,
        ns: 'agent-default-model',
        revision: descriptors.get('agent-default-model')?.revision,
        disabled: false,
      })
    }
    if (removable) items.push({ kind: 'remove-provider', label: 'Remove provider', value: 'Enter', ns: entry.settingsNs, path: entry.settingsPath, revision: descriptor.revision, credentialRef: credential?.configured && credential?.writable ? ref : undefined, confirmText: 'Remove ' + entry.displayName + ' and its managed credential?', disabled: !settings.writable })
  }
  return { settings, items, title: 'Model', subtitle: 'Enter selects a listed model as default', menu: SETTINGS_MENU, menuIndex: 1 }
}

// The auto-fetched model selection window for one provider: the provider's
// discovered catalog (`ctx.llm.discoverModels`, with a registered-adapter
// `listModels` fallback) as checkbox rows marking the saved selection. Enter
// toggles a model in or out of the provider's saved models list. A failed
// fetch falls back to the saved selection so stored models stay manageable.
export async function loadProviderModels(ctx, providerId) {
  const settings = ctx.get('settings')
  const entry = ctx.get('llm')?.listConfigurableProviders?.().find((candidate) => candidate.provider === providerId)
  if (!settings || !entry) throw new Error('provider is no longer available')
  const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === entry.settingsNs)
  if (!descriptor) throw new Error('provider settings namespace is unavailable')
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
    items.push({ label: fetchFailed ? 'no models available' : 'provider returned no models', value: '', disabled: true })
  }
  return {
    settings,
    items,
    title: entry.displayName + ' · models',
    subtitle: fetchFailed
      ? 'auto-fetch unavailable — saved models · Enter toggle'
      : 'auto-fetched · Enter toggle · Esc back',
  }
}

export async function saveWebSetting(ctx, settings, item, value) {
  if (!item || item.disabled) return
  if (item.kind === 'secret') {
    if (!value.trim()) throw new Error('API key cannot be empty')
    const credentials = ctx.get('credentials')
    if (!credentials) throw new Error('credentials service is unavailable')
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
    const modalities = value.trim() === 'text + image' ? ['text', 'image'] : ['text']
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
    if (!model) throw new Error('selected provider has no available models')
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
  return settings.update(item.ns, { [item.field]: value }, item.revision)
}
